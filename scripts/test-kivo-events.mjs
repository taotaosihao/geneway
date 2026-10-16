import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { normalizeKivoBusinessEvent, normalizeKivoEventSources, readKivoEventBody, readKivoEventSources, verifyKivoEvent, revisionString } from '../src/kivo-events.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-kivo-events-'))
const key = Buffer.from('synthetic-signing-key-no-real-service')
const source = { id: 'synthetic-a', connectionId: 'connection-a', resource: 'http://127.0.0.1:3499/api/v1/mes/mcp', sourceInstance: 'synthetic-a', signingSecretRef: 'synthetic-event.key', subscriptionIds: [randomUUID()], enabled: true }
const now = Date.parse('2026-10-16T00:00:00.000Z')
const uuid = () => randomUUID()
const value = fixture()
const signed = body => {
  const rawBody = Buffer.from(JSON.stringify(body)), stamp = String(now / 1000)
  const signature = createHmac('sha256', key).update(`${body.deliveryId}.${stamp}.`).update(rawBody).digest('base64')
  return { rawBody, rawHeaders: ['webhook-id', body.deliveryId, 'webhook-timestamp', stamp, 'webhook-signature', `v1,${signature}`], source, signingKey: key, now }
}
try {
  assert.deepEqual((await readKivoEventSources(root)).sources, [])
  const config = { version: 1, sources: [source] }
  await writeFile(join(root, 'event-sources.json'), JSON.stringify(config), { mode: 0o600 })
  const loaded = await readKivoEventSources(root)
  assert.deepEqual(loaded.sources, [source]); assert.match(loaded.sha256, /^[a-f0-9]{64}$/)
  assert.throws(() => normalizeKivoEventSources({ ...config, secretRoot: root }))
  assert.throws(() => normalizeKivoEventSources({ ...config, sources: [source, source] }))
  assert.throws(() => normalizeKivoEventSources({ ...config, sources: [{ ...source, resource: 'http://127.0.0.1:3499/other' }] }))
  await rm(join(root, 'event-sources.json'))
  await writeFile(join(root, 'source.json'), JSON.stringify(config))
  await symlink(join(root, 'source.json'), join(root, 'event-sources.json'))
  await assert.rejects(readKivoEventSources(root), { code: 'SOURCE_NOT_CONFIGURED' })

  const accepted = verifyKivoEvent(signed(value))
  assert.equal(accepted.event.sourceRevision, '1')
  assert.equal(accepted.event.objectId, value.data.businessEvent.objectId)
  assert.equal(Object.hasOwn(accepted.event, 'message'), false)
  const display = structuredClone(value)
  display.deliveryId = uuid(); display.data.rule.name = 'different display'; display.data.message.body = 'UNTRUSTED_DISPLAY_CANARY'
  display.data.basis = { display: 'another delivery' }; display.data.object.label = 'different object label'; display.data.businessEvent.subject.label = 'different subject label'
  display.data.businessEvent.displayAfter = { status: 'changed label' }
  assert.equal(verifyKivoEvent(signed(display)).fingerprint, accepted.fingerprint)
  assert.notEqual(verifyKivoEvent(signed(display)).rawDigest, accepted.rawDigest)
  const conflict = structuredClone(value); conflict.data.businessEvent.after.status = 'completed'
  assert.notEqual(verifyKivoEvent(signed(conflict)).fingerprint, accepted.fingerprint)
  for (const change of [
    body => { body.version = 1 },
    body => { body.data.source.adapter = 'another-adapter' },
    body => { body.data.source.revision = '01' },
    body => { body.data.rule.id = uuid() },
    body => { body.data.businessEvent.objectType = 'device' },
    body => { body.data.businessEvent.version = 2 },
    body => { body.data.businessEvent.sourceRevision = '1.0' },
    body => { body.data.businessEvent.subject.id = uuid() },
    body => { body.data.businessEvent.subject.organizationId = uuid() },
    body => { body.timestamp = '2026-10-16T00:00:01.000Z' },
    body => { body.data.businessEvent.after.secret = 'must reject' },
  ]) { const body = structuredClone(value); change(body); assert.throws(() => verifyKivoEvent(signed(body))) }
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const input = signed(value), position = input.rawHeaders.indexOf(name)
    input.rawHeaders.push(name.toUpperCase(), input.rawHeaders[position + 1])
    assert.throws(() => verifyKivoEvent(input), { code: 'EVENT_SIGNATURE_INVALID' })
  }
  assert.throws(() => verifyKivoEvent({ ...signed(value), now: now + 300_001 }), { code: 'EVENT_SIGNATURE_INVALID' })
  assert.throws(() => verifyKivoEvent({ ...signed(value), rawBody: Buffer.from('{}') }), { code: 'EVENT_SIGNATURE_INVALID' })
  assert.throws(() => verifyKivoEvent({ ...signed(value), source: { ...source, enabled: false } }), { code: 'SOURCE_NOT_CONFIGURED' })
  assert.deepEqual(await readKivoEventBody(Readable.from([Buffer.from('a'), Buffer.from('b')])), Buffer.from('ab'))
  await assert.rejects(readKivoEventBody(Readable.from([Buffer.alloc(64 * 1024 + 1)])), { code: 'EVENT_BODY_TOO_LARGE' })
  assert.equal(revisionString(12), '12'); assert.equal(revisionString('12'), '12')
  for (const revision of [1.2, -1, NaN, Infinity, '01', '1.0', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => revisionString(revision))
  let realSamples = 0
  if (process.argv[2] === '--sample-index') {
    const entries = JSON.parse(await readFile(process.argv[3], 'utf8'))
    for (const entry of entries) {
      const sample = JSON.parse(await readFile(entry.file, 'utf8'))
      const event = normalizeKivoBusinessEvent(sample, { ...source, subscriptionIds: [sample.data.rule.id] })
      assert.equal(event.sourceRevision, entry.sourceRevision); realSamples += 1
    }
  }
  console.log(JSON.stringify({ ok: true, checks: 'Kivo v2 HMAC/strict typed fingerprints/source loader/body bounds/revision', indexedProducerSamples: realSamples, httpStarts: 0, nativeStarts: 0, modelRequests: 0, secretReads: 0 }))
} finally { await rm(root, { recursive: true, force: true }) }

function fixture() {
  const id = uuid(), deviceId = uuid(), organizationId = uuid()
  const subject = { id, type: 'repair', label: 'SYNTHETIC-REPAIR', deviceId, deviceName: 'synthetic device', organizationId, organizationAncestorIds: [organizationId] }
  const occurredAt = new Date(now).toISOString()
  return { version: 2, deliveryId: uuid(), type: 'notification.business_event', timestamp: occurredAt, data: {
    source: { authority: 'mes.native.repair', adapter: 'mes.native', revision: '1' }, object: structuredClone(subject),
    message: { templateVersion: 1, title: 'synthetic display', body: 'synthetic display' }, rule: { id: source.subscriptionIds[0], revision: 1, name: 'synthetic' },
    businessEvent: { version: 1, eventId: uuid(), sourceKind: 'native_audit', objectType: 'repair', objectId: id, sourceRevision: '1', occurredAt, timezone: 'Asia/Shanghai', actorId: uuid(), traceId: 'synthetic-human-change', action: null,
      before: { status: 'reported', executorId: null }, after: { status: 'dispatched', executorId: uuid() }, subject: structuredClone(subject), businessLink: {}, displayBefore: {}, displayAfter: {} },
    basis: {}, businessLink: {},
  } }
}
