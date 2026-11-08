import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { startRemoteAgentHost } from '../packages/agent-host/remote.mjs'
import { assertSealed, digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/t11-resync-gap-'), events = [], traffic = [], errors = []
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }
const rejectedHint = deferred(), allowSnapshot = deferred(), frozenSnapshot = deferred(), releaseSnapshot = deferred()
let fixture, proxy, remote, injected = false, hintRejected = false, capturedSnapshot = false
const mark = (kind, value = {}) => events.push({ kind, at: new Date().toISOString(), ...value })
async function until(predicate, label) { const end = Date.now() + 20000; while (!await predicate()) { assert(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 20)) } }
console.log(JSON.stringify({ stage: 'starting', directory, pid: process.pid }))
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  proxy = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks), path = request.url, isStream = request.method === 'GET' && path === '/internal/bridge/events', snapshot = path === '/internal/bridge/resync' && hintRejected && !capturedSnapshot
    if (snapshot) { capturedSnapshot = true; await allowSnapshot.promise }
    const headers = { ...request.headers, host: new URL(fixture.origin).host }
    if (isStream && !injected) { injected = true; headers['last-event-id'] = 'stale-event-from-another-scope' }
    traffic.push({ path, method: request.method, lastEventId: headers['last-event-id'] ?? null, ...(path === '/internal/bridge/acks' ? { body: JSON.parse(body) } : {}) })
    if (path === '/internal/executions/tokens') {
      // This window proves transport acceptance, independently of SDK startup.
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'T11_PROTOCOL_ONLY' } })); return
    }
    const upstream = httpRequest(new URL(path, fixture.origin), { method: request.method, headers }, incoming => {
      const collected = []
      if (snapshot || isStream && headers['last-event-id']) {
        incoming.on('data', bytes => collected.push(bytes))
        incoming.on('end', async () => {
          const bytes = Buffer.concat(collected), value = JSON.parse(bytes)
          if (snapshot) { mark('resync-snapshot-frozen', { status: incoming.statusCode, value }); frozenSnapshot.resolve(value); await releaseSnapshot.promise }
          else { assert.equal(incoming.statusCode, 409); assert.equal(value.error.code, 'RESYNC_REQUIRED'); mark('hint-rejected', { status: incoming.statusCode, value }); hintRejected = true; rejectedHint.resolve() }
          response.writeHead(incoming.statusCode, incoming.headers); response.end(bytes)
        })
      } else {
        if (isStream) mark('unhinted-stream-open', { status: incoming.statusCode })
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response)
      }
    })
    upstream.on('error', cause => { errors.push({ code: cause.code, path }); response.destroy() }); response.on('close', () => upstream.destroy()); upstream.end(body)
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const pairing = await fixture.nodes.createPairing({ id: 'owner' }, { clientRequestId: 't11-resync-node', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator', 'analysis'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  remote = await startRemoteAgentHost({ root: join(directory, 'remote'), origin: `http://127.0.0.1:${proxy.address().port}`, pairing, onError: cause => { errors.push({ code: cause.code }); mark('remote-error', { code: cause.code }) } })
  await rejectedHint.promise
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function user(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value }
  const first = await user('/api/works', { workType: 'multisite', employeeId: 'coordinator', clientRequestId: 'before-resync-snapshot', goal: '只核重同步前的原合法命令。' }), firstId = first.id ?? first.workId
  allowSnapshot.resolve(); const snapshot = await frozenSnapshot.promise
  const second = await user('/api/works', { workType: 'multisite', employeeId: 'analysis', clientRequestId: 'after-snapshot-before-stream', goal: '只核快照返回至订阅前间隙的第二个合法命令。' }), secondId = second.id ?? second.workId, beforeStream = await fixture.store.read()
  const commands = beforeStream.multisite.outbox.filter(row => [firstId, secondId].includes(row.command.work_id)).map(row => row.command)
  assert.equal(commands.length, 2); assert(snapshot.pending.some(row => row.work_id === firstId)); assert(!snapshot.pending.some(row => row.work_id === secondId)); mark('second-command-created-in-gap', { commandId: commands.find(row => row.work_id === secondId).command_id })
  await writeFile(join(directory, 'before-unhinted-stream.json'), JSON.stringify({ cloud: beforeStream, snapshot, events }, null, 2)); releaseSnapshot.resolve()
  await until(async () => { const local = await remote.journal.read(), cloud = await fixture.store.read(); return commands.every(command => local.inbox.some(row => row.command.command_id === command.command_id) && cloud.multisite.outbox.find(row => row.id === command.command_id).acceptedAt) }, 'Both original and snapshot-gap commands must be durably received and exact-ACKed')
  const received = await remote.journal.read(), cloud = await fixture.store.read()
  for (const command of commands) { assertSealed(command); assert.equal(received.inbox.filter(row => row.command.command_id === command.command_id).length, 1); assert.deepEqual(received.inbox.find(row => row.command.command_id === command.command_id).command, command); const ack = traffic.filter(row => row.path === '/internal/bridge/acks' && row.body.commandId === command.command_id); assert.equal(ack.length, 1); assert.equal(ack[0].body.payloadDigest, command.payload_digest) }
  assert(events.some(row => row.kind === 'remote-error' && row.code === 'RESYNC_REQUIRED')); assert(events.some(row => row.kind === 'unhinted-stream-open' && row.status === 200)); assert.equal(traffic.filter(row => row.lastEventId).length, 1); assert.equal(cloud.modelRequests.length, 0)
  const invalid = await fetch(fixture.origin + '/internal/bridge/events', { headers: { 'last-event-id': 'old', 'x-geneway-node-instance': 'invalid', 'x-geneway-host-run': 'unauthenticated' } }); assert.equal(invalid.status, 401); assert.equal((await invalid.json()).error.code, 'UNAUTHORIZED')
  await writeFile(join(directory, 'after-exact-acks.json'), JSON.stringify({ local: received, cloud, commands, events, traffic }, null, 2))
  for (const workId of [firstId, secondId]) await user(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'finish-' + workId })
  await until(async () => (await fixture.store.read()).works.every(row => row.status === 'cancelled'), 'Protocol-only executions must close through real cancellation')
  const result = { result: 'passed', directory, originalCommandId: commands[0].command_id, gapCommandId: commands[1].command_id, hintStatus: 409, hintCode: 'RESYNC_REQUIRED', authenticatedBeforeHint: true, actualProductionRemoteReconnect: true, pendingAndSnapshotGapExactAckOnce: true, sealedDigests: commands.map(digest), actualModelForwards: 0, boundary: 'actual production remote connector/resync/SSE/parser/Host Journal over an isolated one-shot hint proxy; runtime initialization tokens intentionally refused by this test proxy, no SDK/model execution claim or cursor-expiry classification' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, events, traffic, errors }, null, 2)); throw cause }
finally { allowSnapshot.resolve(); releaseSnapshot.resolve(); await remote?.close(); await fixture?.close(); if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }; await writeFile(join(directory, 'traffic.json'), JSON.stringify(traffic, null, 2)); await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2)); await writeFile(join(directory, 'errors.json'), JSON.stringify(errors, null, 2)); console.log('T11 resync evidence:', directory) }
