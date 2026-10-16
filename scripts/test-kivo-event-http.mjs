import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createGenewayServer } from '../src/server.mjs'
import { createAutomationRuntime, createAutomationService } from '../src/automation-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { readKivoEventSources } from '../src/kivo-events.mjs'

// Exercise the real request handler without listen(), a socket, or a model.
const root = await fs.mkdtemp(join(tmpdir(), 'geneway-kivo-handler-')), secretRoot = join(root, 'secrets')
await fs.mkdir(secretRoot, { mode: 0o700 })
const key = Buffer.from('synthetic-handler-key'), subscription = randomUUID(), now = new Date().toISOString()
const connection = { id: 'kivo', name: 'pure', kind: 'kivo-mcp', targetIdentity: 'pure', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: randomUUID(), credentialRef: 'unused.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: [], sourceSystem: 'Kivo', sourceInstance: 'pure', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
const source = { id: 'pure-a', connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance, signingSecretRef: 'signing.key', subscriptionIds: [subscription], enabled: true }
let failRename = false, directoryGate, enteredDirectory, directorySynced = false, authCalls = 0, modelCalls = 0, owned = true, rotateOnAccept = false
const store = createFileStore(join(root, 'state.json'), {
  async rename(...args) { if (failRename) throw Object.assign(new Error('synthetic storage failure'), { code: 'EIO' }); return fs.rename(...args) },
  async open(path, ...args) {
    const handle = await fs.open(path, ...args)
    return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), async sync() {
      if (path === root) { enteredDirectory?.(); if (directoryGate) await directoryGate }
      await handle.sync()
      if (path === root) directorySynced = true
    } }
  },
})
await store.update(state => ({ ...state, connections: [connection] }))
await fs.writeFile(join(secretRoot, source.signingSecretRef), 'whsec_' + key.toString('base64'), { mode: 0o600 })
await fs.writeFile(join(root, 'event-sources.json'), JSON.stringify({ version: 1, sources: [source] }), { mode: 0o600 })
const readEventSources = () => readKivoEventSources(root)
const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
const workService = { async ensureReady() {}, async automationOwnerLost() {} }
const automation = createAutomationService({ store, workService, connectionCatalog: catalog, secretRoot, readEventSources, eventSourceReady: () => owned,
  readCurrentRecord: async () => { modelCalls += 1; assert.fail('no active target may call MCP') } })
const actualRuntime = createAutomationRuntime({ store, automationService: automation, workService, dataRoot: root, lockFactory: async () => ({ lost: new Promise(() => undefined), async release() {} }) })
await actualRuntime.start()
const runtime = { ...actualRuntime, ownsLock: () => owned && actualRuntime.ownsLock(), async acceptKivoEvent(verified) {
  if (rotateOnAccept) await fs.writeFile(join(root, 'event-sources.json'), JSON.stringify({ version: 1, sources: [{ ...source, signingSecretRef: 'rotated-signing.key' }] }), { mode: 0o600 })
  return actualRuntime.acceptKivoEvent(verified)
} }
const server = createGenewayServer({ service: workService, store, auth: { async validateSession() { authCalls += 1; assert.fail('event route must not authenticate cookies') } }, automation, automationRuntime: runtime, readEventSources, secretRoot, trustedOrigin: 'http://127.0.0.1:41002' })
try {
  let enter, release
  const reached = new Promise(resolve => { enter = resolve })
  directoryGate = new Promise(resolve => { release = resolve }); enteredDirectory = enter; directorySynced = false
  let acked = false
  const value = body(), accepting = request(value).then(result => { acked = true; return result })
  await reached
  assert.equal(acked, false, 'response must wait for directory fsync')
  release()
  const accepted = await accepting
  directoryGate = undefined; enteredDirectory = undefined
  assert.equal(accepted.status, 202)
  assert.equal(directorySynced, true)
  assert.equal((await store.read()).automationInbox.length, 1)
  assert.equal((await request(value)).body.deduplicated, true)
  assert.equal(authCalls, 0)
  assert.equal(modelCalls, 0)
  const changed = structuredClone(value); changed.data.message.body = 'same delivery changed bytes'
  assert.equal((await request(changed)).status, 409)
  const display = structuredClone(value); display.deliveryId = randomUUID(); display.data.message.body = 'another signed display'
  assert.equal((await request(display)).status, 202)
  assert.equal((await store.read()).automationInbox[0].deliveries.length, 2)
  assert.equal((await request(value, { signature: 'v1,' + 'a'.repeat(43) + '=' })).status, 401)
  assert.equal((await request(value, { duplicate: true })).status, 401)
  const wrong = body(); wrong.data.rule.id = randomUUID()
  assert.equal((await request(wrong)).status, 403)
  assert.equal((await request(body(), { raw: Buffer.alloc(64 * 1024 + 1) })).status, 413)
  const before = (await store.read()).automationInbox.length
  failRename = true
  const failure = await request(body())
  assert.equal(failure.status, 503)
  assert.equal(failure.body.error.code, 'STORAGE_UNAVAILABLE')
  assert.equal((await store.read()).automationInbox.length, before)
  failRename = false
  const beforeRotation = (await store.read()).automationInbox.length
  rotateOnAccept = true
  assert.equal((await request(body())).status, 503, 'a verification from an old source config must not be admitted under the new signing ref')
  assert.equal((await store.read()).automationInbox.length, beforeRotation)
  rotateOnAccept = false
  await fs.writeFile(join(root, 'event-sources.json'), JSON.stringify({ version: 1, sources: [source] }), { mode: 0o600 })
  owned = false
  assert.equal((await request(body())).status, 503)
  owned = true
  await fs.writeFile(join(root, 'event-sources.json'), JSON.stringify({ version: 1, sources: [{ ...source, enabled: false }] }), { mode: 0o600 })
  assert.equal((await request(body())).status, 503)
  console.log(JSON.stringify({ ok: true, checks: ['actual-handler', 'cookie-independent', 'durable-before-ack', 'signature', 'subscription', 'delivery-conflict', 'store-failure', 'owner-source-disabled'], listenCalls: 0, networkCalls: 0, nativeStarts: 0, modelCalls, realSecretReads: 0 }))
} finally { await actualRuntime.close(); server.close(); await fs.rm(root, { recursive: true, force: true }) }

function body() {
  const id = randomUUID(), organizationId = randomUUID(), subject = { id, type: 'repair', label: 'pure', deviceId: randomUUID(), deviceName: 'pure', organizationId, organizationAncestorIds: [organizationId] }
  return { version: 2, deliveryId: randomUUID(), type: 'notification.business_event', timestamp: now, data: {
    source: { authority: 'mes.native.repair', adapter: 'mes.native', revision: '1' }, object: subject,
    message: { templateVersion: 1, title: 'pure', body: 'display must never reach the model' }, rule: { id: subscription, revision: 1, name: 'pure' },
    businessEvent: { version: 1, eventId: randomUUID(), sourceKind: 'native_audit', objectType: 'repair', objectId: id, sourceRevision: '1', occurredAt: now, timezone: 'Asia/Shanghai', actorId: null, traceId: randomUUID(), action: null, before: { status: 'reported' }, after: { status: 'dispatched' }, subject, businessLink: {}, displayBefore: {}, displayAfter: {} }, basis: {}, businessLink: {},
  } }
}
function request(value, { signature, duplicate = false, raw = Buffer.from(JSON.stringify(value)) } = {}) {
  const stamp = String(Math.floor(Date.now() / 1000)), signed = signature ?? 'v1,' + createHmac('sha256', key).update(`${value.deliveryId}.${stamp}.`).update(raw).digest('base64')
  const request = Readable.from([raw]); request.method = 'POST'; request.url = '/api/events/kivo/' + source.id
  request.rawHeaders = ['webhook-id', value.deliveryId, 'webhook-timestamp', stamp, 'webhook-signature', signed, ...(duplicate ? ['Webhook-Id', value.deliveryId] : [])]
  return new Promise(resolve => {
    const response = { writeHead(status) { this.status = status }, end(raw) { resolve({ status: this.status, body: JSON.parse(raw) }) } }
    server.emit('request', request, response)
  })
}
