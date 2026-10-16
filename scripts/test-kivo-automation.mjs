import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomationRuntime, createAutomationService } from '../src/automation-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { getCapability, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { normalizeTpmObservation } from '../src/domain/tpm.mjs'
import { authorizeExecutionGrant, connectionSnapshot } from '../src/execution-grant.mjs'
import { canonical, digest, normalizeKivoEventSources } from '../src/kivo-events.mjs'

const now = '2026-10-16T01:00:00.000Z', objectId = '00000000-0000-4000-8000-000000000001', deviceId = '00000000-0000-4000-8000-000000000002'
const cap = getCapability('kivo-tpm-record-read'), actor = { id: 'owner' }
const roots = []
try {
  await rulesAndCas()
  await durableAndClaims()
  await versionsAndRecovery()
  await permissionsAndFailure()
  await grantChecks()
  await echoChecks()
  await runtimeChecks()
  await persistenceFailureChecks()
  await dailyManualRevocationChecks()
  await replayWaitsForReconcile()
  await singleTimerAndCloseRace()
  await reconcileCadenceChecks()
  console.log(JSON.stringify({ ok: true, checks: ['draft-identity', 'baseline-cas', 'durable-inbox', 'typed-conflicts', 'atomic-current-claim', 'versions', 'activation', 'current-authorization'], modelCalls: 0, networkCalls: 0, secretReads: 0 }))
} finally { for (const root of roots) await rm(root, { recursive: true, force: true }) }

async function fixture({ fsOps } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'geneway-kivo-automation-')); roots.push(root)
  const store = createFileStore(join(root, 'state.json'), fsOps)
  const connection = { id: 'kivo', name: '合成实例', kind: 'kivo-mcp', targetIdentity: 'test-a', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: randomUUID(), credentialRef: 'synthetic.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: [cap.skillId], sourceSystem: 'Kivo', sourceInstance: 'synthetic-a', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
  const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
  await store.update(state => ({ ...state, members: ['owner', 'peer', 'admin'].map(id => ({ id, loginName: id, displayName: id, authRef: id, enabled: true, role: id === 'admin' ? 'admin' : 'member', sessionVersion: 1, employeeIds: id === 'owner' ? ['agent'] : [] })), employees: [{ id: 'agent', name: '核对员工', enabled: true, revision: 1, instructions: '', skillIds: [cap.skillId], connectionIds: [connection.id], modelRouteId: 'model' }], skills: [{ id: cap.skillId, name: '单据查询', enabled: true, capabilityId: cap.id }], modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }], connections: [connection] }))
  let revision = 0, deviceRevision = 0, readCalls = 0, gate, failure, dispatched = 0, lastObservation
  const config = { ...normalizeKivoEventSources({ version: 1, sources: [{ id: 'source-a', connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance, signingSecretRef: 'event.key', subscriptionIds: [randomUUID()], enabled: true }] }), sha256: 'a'.repeat(64) }
  const actualWorkService = createWorkService({ store, runner: { configured: true, async run() { assert.fail('pure test must not call model') } }, clock: () => now, connectionCatalog: catalog })
  const service = createAutomationService({ store, clock: () => now, connectionCatalog: catalog, readEventSources: async () => structuredClone(config),
    workService: { ...actualWorkService, async ensureReady() {}, async dispatchAutomationWork() { dispatched += 1 } },
    async readCurrentRecord(options) {
      readCalls += 1
      await options.authorize()
      if (gate) await gate(options)
      if (failure) throw Object.assign(new Error('synthetic read failure'), { code: failure })
      await options.authorize()
      const source = { system: 'kivo', path: '/api/v1/mes/tpm/repairs/R-1', queriedAt: now, traceId: 'synthetic-read' }
      return lastObservation = normalizeTpmObservation({ mode: 'record', input: options.input, connection: options.connection,
        result: { status: 'ok', source, value: { id: objectId, orderNo: options.input.reference, deviceId, status: 'reported', revision, updatedAt: now } },
        deviceResult: { status: 'ok', source: { ...source, path: '/api/v1/mes/equipment/ledger/devices/' + deviceId }, value: { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', revision: deviceRevision } } })
    } })
  return { store, service, config, connection, get lastObservation() { return lastObservation }, get readCalls() { return readCalls }, get dispatched() { return dispatched }, set revision(value) { revision = value }, set deviceRevision(value) { deviceRevision = value }, set gate(value) { gate = value }, set failure(value) { failure = value },
    async draft(overrides = {}) { return service.createRule(actor, { employeeId: 'agent', skillId: cap.skillId, connectionId: connection.id, input: { recordType: 'repair', reference: 'R-1' }, trigger: { kind: 'kivo-record-update', sourceId: 'source-a' }, ...overrides }) },
    async activate(overrides) { const draft = await this.draft(overrides); return service.enableRule(actor, draft.id, { expectedRevision: draft.revision }) },
    event(rev, overrides = {}) {
      const event = { sourceId: 'source-a', resource: connection.baseUrl, sourceInstance: connection.sourceInstance, adapter: 'mes.native', kind: 'notification.business_event', version: 1, eventId: randomUUID(), recordType: 'repair', objectId, sourceRevision: String(rev), occurredAt: now, traceId: randomUUID(), actorId: null, action: null,
        before: { status: 'reported' }, after: { status: 'dispatched' }, subject: { id: objectId, type: 'repair', deviceId, organizationId: randomUUID(), organizationAncestorIds: [] }, ...overrides }
      return { deliveryId: randomUUID(), rawDigest: digest(JSON.stringify(event)), event, fingerprint: digest(JSON.stringify(canonical(event))), sourceConfigSha256: config.sha256 }
    },
    async finishWorks() { await store.update(state => ({ ...state, works: state.works.map(work => ({ ...work, status: 'cancelled', executions: work.executions.map(execution => ({ ...execution, status: 'cancelled', completedAt: now })) })) })) },
  }
}

async function rulesAndCas() {
  const f = await fixture(), draft = await f.draft()
  for (const key of ['objectId', 'activationId', 'baselineRevision', 'handledRevision']) assert.equal(draft[key], null)
  assert.equal(draft.retired, false)
  assert.equal((await f.service.eventSourceCapability(actor)).sources.length, 1)
  assert.deepEqual((await f.service.eventSourceCapability({ id: 'admin' })).sources, [])
  for (const id of ['peer', 'admin']) await assert.rejects(f.service.getRule({ id }, draft.id), { code: 'NOT_FOUND' })
  f.failure = 'UPSTREAM_TIMEOUT'
  await assert.rejects(f.service.enableRule(actor, draft.id, { expectedRevision: draft.revision }), { code: 'UPSTREAM_TIMEOUT' })
  assert.equal((await f.service.getRule(actor, draft.id)).status, 'draft')
  f.failure = undefined
  let entered, resume
  const reached = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { resume = resolve })
  f.gate = async () => { entered(); await blocked }
  const enabling = f.service.enableRule(actor, draft.id, { expectedRevision: draft.revision })
  await reached
  const edited = await f.service.updateRule(actor, draft.id, { expectedRevision: draft.revision, input: { recordType: 'repair', reference: 'R-2' } })
  resume()
  await assert.rejects(enabling, { code: 'REVISION_CONFLICT' })
  assert.equal((await f.service.getRule(actor, draft.id)).baselineRevision, null)
  f.gate = undefined
  const active = await f.service.enableRule(actor, draft.id, { expectedRevision: edited.revision })
  assert.equal(active.baselineRevision, '0')
  assert.equal(active.activationId, active.revision)
  const before = await f.store.read()
  await assert.rejects(f.service.updateRule(actor, active.id, { expectedRevision: active.revision, input: { recordType: 'repair', reference: 'R-3' } }), { code: 'INVALID_STATE' })
  assert.deepEqual(await f.store.read(), before)
  const paused = await f.service.pauseRule(actor, active.id, { expectedRevision: active.revision })
  await assert.rejects(f.service.updateRule(actor, paused.id, { expectedRevision: paused.revision, connectionId: 'other' }))
  assert.equal((await f.service.getRule(actor, paused.id)).status, 'paused')
}

async function durableAndClaims() {
  const f = await fixture(), active = await f.activate(), event = f.event(1)
  const reads = f.readCalls
  await f.service.acceptKivoEvent(event)
  assert.equal(f.readCalls, reads, 'durable ACK must not perform MCP')
  assert.equal((await f.store.read()).automationInbox[0].targets[0].status, 'pending')
  assert.equal((await f.service.acceptKivoEvent(event)).deduplicated, true)
  await assert.rejects(f.service.acceptKivoEvent({ ...event, rawDigest: 'f'.repeat(64) }), { code: 'CONFLICT' })
  const alternate = { ...event, deliveryId: randomUUID(), rawDigest: 'b'.repeat(64) }
  await f.service.acceptKivoEvent(alternate)
  assert.equal((await f.store.read()).automationInbox[0].deliveries.length, 2)
  const badEvent = { ...event.event, action: 'changed' }
  await assert.rejects(f.service.acceptKivoEvent({ ...event, deliveryId: randomUUID(), event: badEvent, fingerprint: digest(JSON.stringify(canonical(badEvent))) }), { code: 'CONFLICT' })
  const edited = await f.service.updateRule(actor, active.id, { expectedRevision: active.revision, maxRuns: 9 })
  assert.equal(edited.activationId, active.activationId)
  assert.equal(edited.eventTargets[0].status, 'pending')
  f.revision = 2
  await Promise.all([f.service.processPending(), f.service.processPending({ reconcile: true })])
  const state = await f.store.read(), occurrence = state.automationOccurrences[0]
  assert.equal(state.works.length, 1)
  assert.equal(f.dispatched, 1)
  assert.equal(occurrence.ruleRevision, edited.revision)
  assert.equal(occurrence.query.sourceRevision, '2')
  assert.equal(occurrence.event.sourceRevision, '1')
  assert.equal(state.automationRules[0].handledRevision, '2')
  assert.equal(state.automationInbox[0].targets[0].occurrenceId, occurrence.id)
  await assert.rejects(f.store.update(current => ({ ...current, automationOccurrences: current.automationOccurrences.map(item => ({ ...item, query: { ...item.query, queriedAt: '2026-10-16T01:00:01.000Z' } })) })), /已认领发生不可改写/)
  await assert.rejects(f.store.update(current => ({ ...current, automationRules: current.automationRules.map(item => ({ ...item, handledRevision: '1' })) })), /已处理版本不可倒退/)
  await f.service.processPending({ reconcile: true })
  assert.equal((await f.store.read()).works.length, 1)
  const later = await f.activate()
  await f.service.acceptKivoEvent({ ...event, deliveryId: randomUUID(), rawDigest: 'c'.repeat(64) })
  assert.equal((await f.store.read()).automationInbox[0].targets.length, 1, 'replay must not expand later active targets')
  assert.equal(later.baselineRevision, '2')
  const orphan = f.event(5, { objectId: '00000000-0000-4000-8000-000000000099', subject: { ...event.event.subject, id: '00000000-0000-4000-8000-000000000099' } })
  await f.service.acceptKivoEvent(orphan)
  assert.equal((await f.store.read()).automationInbox[1].ignoredReason, 'no-active-target')
}

async function versionsAndRecovery() {
  const f = await fixture(), active = await f.activate()
  f.revision = 1
  await f.service.acceptKivoEvent(f.event(2))
  await f.service.processPending({ reconcile: true })
  assert.equal((await f.store.read()).automationInbox[0].targets[0].reason, 'source-lag')
  assert.equal((await f.store.read()).works.length, 0)
  f.revision = 3
  await f.service.processPending({ reconcile: true })
  await f.finishWorks()
  const used = (await f.service.getRule(actor, active.id)).usedRuns
  f.deviceRevision = 99
  await f.service.processPending({ reconcile: true })
  assert.equal((await f.service.getRule(actor, active.id)).usedRuns, used, 'related device revision must not trigger a work')
  const pending = f.event(5)
  await f.service.acceptKivoEvent(pending)
  f.revision = 2
  await f.service.processPending()
  assert.equal((await f.store.read()).automationInbox.at(-1).targets[0].reason, 'revision-regressed')
  assert.equal((await f.service.getRule(actor, active.id)).handledRevision, '3')
  const paused = await f.service.pauseRule(actor, active.id, { expectedRevision: active.revision })
  assert.equal((await f.store.read()).automationInbox.at(-1).targets[0].status, 'ignored')
  f.revision = 6
  const resumed = await f.service.resumeRule(actor, active.id, { expectedRevision: paused.revision })
  assert.notEqual(resumed.activationId, active.activationId)
  assert.equal(resumed.handledRevision, '6')
  await f.service.processPending({ reconcile: true })
  assert.equal((await f.service.getRule(actor, active.id)).usedRuns, used)
}

async function permissionsAndFailure() {
  const f = await fixture(), active = await f.activate()
  await f.service.acceptKivoEvent(f.event(1))
  f.failure = 'UPSTREAM_TIMEOUT'
  await f.service.processPending({ reconcile: true })
  assert.equal((await f.service.getRule(actor, active.id)).status, 'active')
  assert.equal((await f.service.getRule(actor, active.id)).usedRuns, 0)
  f.failure = undefined
  await f.store.update(state => ({ ...state, members: state.members.map(member => member.id === actor.id ? { ...member, employeeIds: [] } : member) }))
  const readCalls = f.readCalls
  await f.service.processPending({ reconcile: true })
  assert.equal(f.readCalls, readCalls, 'current member revocation must stop before any MCP call')
  const rule = await f.service.getRule(actor, active.id)
  assert.equal(rule.status, 'paused')
  assert.equal(rule.pauseReason.code, 'FORBIDDEN')
  assert.equal(rule.eventTargets[0].status, 'ignored')
}

async function grantChecks() {
  const f = await fixture(), active = await f.activate()
  f.revision = 1
  await f.service.acceptKivoEvent(f.event(1))
  await f.service.processPending()
  const state = await f.store.read(), work = state.works[0], execution = work.executions[0]
  const grant = { version: 2, confirmationFingerprint: digest('[]'), memberId: actor.id, employeeId: 'agent', skillId: cap.skillId, capabilityId: cap.id, modelRouteId: 'model',
    workId: work.id, executionId: execution.id, operation: 'automation', input: work.input, confirmationRefs: [], expectedTool: cap.toolName,
    connection: connectionSnapshot(f.connection), secretRoot: '/tmp/synthetic-never-read', policyFile: '/tmp/synthetic-never-read/state.json', policyRoot: '/tmp/synthetic-never-read' }
  assert.equal((await authorizeExecutionGrant(grant, { readState: async () => f.store.read() })).work.id, work.id)
  await f.service.pauseRule(actor, active.id, { expectedRevision: active.revision })
  await assert.rejects(authorizeExecutionGrant(grant, { readState: async () => f.store.read() }), { code: 'FORBIDDEN' })
  const paused = await f.service.getRule(actor, active.id)
  await f.service.resumeRule(actor, active.id, { expectedRevision: paused.revision })
  await assert.rejects(authorizeExecutionGrant(grant, { readState: async () => f.store.read() }), { code: 'FORBIDDEN' }, 'resume must not revive an old activation execution')
}

async function echoChecks() {
  for (const variant of ['exact', 'higher-current', 'no-effect', 'other-source', 'read-trace', 'approximate-order', 'receipt-mismatch', 'missing-attempt']) {
    const f = await fixture(), active = await f.activate(), actionId = randomUUID(), previewDigest = 'a'.repeat(64)
    const target = { resource: f.connection.baseUrl, sourceInstance: f.connection.sourceInstance, recordType: 'repair', orderNo: variant === 'approximate-order' ? 'R-' : 'R-1' }
    if (variant === 'other-source') target.sourceInstance = 'other-instance'
    const result = { ...parseCapabilityToolResult(cap.id, { ok: true, observation: f.lastObservation }, active.input), id: 'fixture-result', schemaVersion: 1, capabilityId: cap.id, skillId: cap.skillId, input: active.input, dshSessionRef: 'explicit-synthetic-fixture-not-native', contextConfirmationRefs: [], createdAt: now }
    const action = { id: actionId, requestKeys: ['fixture-request'], proposalKey: 'fixture-proposal', intent: { kind: variant === 'read-trace' ? 'kivo.tpm.record.read' : 'kivo.tpm.repair.create', targetKey: 'fixture-target' },
      preview: { digest: previewDigest, resultId: result.id, target, payload: {}, expectedRevision: '0', createdAt: now, expiresAt: '2026-10-16T02:00:00.000Z' },
      decision: { kind: 'approved', memberId: actor.id, previewDigest, decidedAt: now },
      attempt: variant === 'missing-attempt' ? null : { previewDigest, preparedAt: now, ...(variant === 'no-effect' ? { noEffectAt: now, noEffectReason: 'SOURCE_REVISION_CONFLICT' } : {}) },
      receipt: variant === 'receipt-mismatch' ? { previewDigest, upstreamRecordId: randomUUID(), recordedAt: now } : null }
    await f.store.update(state => ({ ...state, works: [...state.works, { id: 'fixture-history', ownerMemberId: actor.id, employeeId: 'agent', skillId: cap.skillId, capabilityId: cap.id, connectionId: 'kivo', input: active.input, goal: 'explicit P5 action consumer fixture only', status: 'completed', acceptedAt: now, results: [result], actions: [action], executions: [] }] }))
    f.revision = variant === 'higher-current' ? 2 : 1
    await f.service.acceptKivoEvent(f.event(1, { traceId: actionId }))
    await f.service.processPending()
    const state = await f.store.read(), suppressed = ['exact', 'higher-current'].includes(variant)
    assert.equal(state.automationInbox[0].targets[0].reason === 'echo', suppressed, variant)
    assert.equal(state.automationOccurrences.length, variant === 'exact' ? 0 : 1, variant)
    assert.equal(state.automationRules[0].handledRevision, variant === 'higher-current' ? '2' : '1', variant)
    if (variant === 'exact') { await f.service.processPending({ reconcile: true }); assert.equal((await f.store.read()).automationOccurrences.length, 0) }
  }
}

async function runtimeChecks() {
  const f = await fixture(), rule = await f.activate(), timers = [], errors = []
  const runtime = createAutomationRuntime({ store: f.store, automationService: f.service, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: roots.at(-1), clock: () => now,
    lockFactory: async () => ({ lost: new Promise(() => undefined), async release() {} }), timerFactory(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer }, clearTimer(timer) { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1) }, onError: error => errors.push(error) })
  await runtime.start()
  assert.equal(timers[0].delay, 0, 'startup current reconcile must not delay listen')
  timers.shift().callback()
  await waitFor(() => timers.length === 1)
  assert.equal(timers[0].delay, 60_000)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { entered = resolve })
  f.gate = async () => { entered(); await blocked }
  f.revision = 1
  const ack = await runtime.acceptKivoEvent(f.event(1))
  assert.equal(ack.accepted, true)
  await reached
  assert.equal((await f.store.read()).automationInbox[0].targets[0].status, 'pending', 'ACK has completed while GET is blocked')
  release()
  await waitFor(async () => (await f.store.read()).works.length === 1)
  await runtime.close()
  assert.equal(timers.length, 0)
  assert.deepEqual(errors, [])
  assert.equal((await f.service.getRule(actor, rule.id)).usedRuns, 1)
}
async function waitFor(check) { for (let i = 0; i < 200; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('pure runtime did not settle') }

async function persistenceFailureChecks() {
  let failRename = false
  const f = await fixture({ fsOps: { async rename(...args) { if (failRename) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); return fs.rename(...args) } } })
  const active = await f.activate(), event = f.event(1)
  failRename = true
  await assert.rejects(f.service.acceptKivoEvent(event), { code: 'EIO' })
  assert.equal((await f.store.read()).automationInbox.length, 0, 'failed durable write must not ACK')
  failRename = false
  await f.service.acceptKivoEvent(event)
  f.revision = 1
  failRename = true
  await assert.rejects(f.service.processPending(), { code: 'EIO' })
  const before = await f.store.read()
  assert.equal(before.works.length, 0)
  assert.equal(before.automationRules[0].handledRevision, active.handledRevision)
  assert.equal(before.automationInbox[0].targets[0].status, 'pending')
  failRename = false
  await f.service.processPending()
  const committed = await f.store.read()
  assert.equal(committed.works.length, 1)
  await f.store.update(state => ({ ...state, works: state.works.map(work => ({ ...work, status: 'failed', executions: work.executions.map(execution => ({ ...execution, status: 'failed', completedAt: now, error: { code: 'FORBIDDEN', message: 'synthetic permission revoked' } })) })) }))
  await f.service.handleWorkTerminal({ workId: committed.works[0].id })
  assert.equal((await f.service.getRule(actor, active.id)).status, 'paused', 'confirmed execution revocation must pause its rule')
}

async function dailyManualRevocationChecks() {
  for (const mode of ['daily', 'manual']) for (const code of ['FORBIDDEN', 'UPSTREAM_TIMEOUT', 'OWNER_LOCK_LOST']) {
    const f = await fixture(), active = await f.activate({ trigger: { kind: 'daily-time', time: '09:00', timeZone: 'Asia/Shanghai' } })
    f.failure = code
    const operation = mode === 'daily'
      ? f.service.acceptDailyOccurrence({ ruleId: active.id, scheduledDate: '2026-10-16', scheduledAt: now })
      : f.service.acceptManualOccurrence(actor, active.id, { expectedRevision: active.revision, clientRequestId: 'current-auth-test' })
    await assert.rejects(operation, { code })
    const rule = await f.service.getRule(actor, active.id)
    assert.equal(rule.status, code === 'FORBIDDEN' ? 'paused' : 'active', mode + ' ' + code)
    assert.equal(rule.pauseReason?.code ?? null, code === 'FORBIDDEN' ? 'FORBIDDEN' : null)
    assert.equal(rule.usedRuns, 0)
  }
}

async function replayWaitsForReconcile() {
  const f = await fixture(); await f.activate()
  const timers = [], errors = []
  const runtime = createAutomationRuntime({ store: f.store, automationService: f.service, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: roots.at(-1), clock: () => now,
    lockFactory: async () => ({ lost: new Promise(() => undefined), async release() {} }), timerFactory(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer }, clearTimer(timer) { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1) }, onError: error => errors.push(error) })
  try {
    await runtime.start(); timers.shift().callback(); await waitFor(() => timers.length === 1)
    f.failure = 'UPSTREAM_TIMEOUT'
    const event = f.event(1), before = f.readCalls
    await runtime.acceptKivoEvent(event)
    await waitFor(() => timers.length === 1 && f.readCalls === before + 1)
    assert.equal(timers[0].delay, 60_000)
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await runtime.acceptKivoEvent(event)).deduplicated, true)
      await new Promise(resolve => setImmediate(resolve))
      await waitFor(() => timers.length === 1)
      assert.equal(f.readCalls, before + 1, 'same delivery must not retry MCP before the 60 second tick')
      assert.equal(timers.length, 1)
    }
    assert.deepEqual(errors, [])
  } finally { await runtime.close() }
}

async function singleTimerAndCloseRace() {
  let currentTime = now, nextRead, readEntered, nextProcess, processEntered, calls = 0
  const timers = [], active = new Set(), releases = new Map(), errors = []
  const state = { automationRules: [{ id: 'rule', capabilityId: cap.id, status: 'active', trigger: { kind: 'kivo-record-update', sourceId: 'source' } }], automationInbox: [], automationOccurrences: [] }
  const store = { async read() { if (nextRead) { const gate = nextRead; nextRead = undefined; readEntered(); await gate } return structuredClone(state) } }
  const runtime = createAutomationRuntime({ store, automationService: {
    async acceptDailyOccurrence() {}, async acceptKivoEvent() { return { accepted: true, deduplicated: false } },
    async processPending() { const n = ++calls; active.add(n); try { if (nextProcess) { const gate = nextProcess; nextProcess = undefined; processEntered(); await gate } else if (n >= 3) await new Promise(resolve => releases.set(n, resolve)) } finally { active.delete(n) } },
  }, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: '/tmp/synthetic-no-created-files', clock: () => currentTime,
  lockFactory: async () => ({ lost: new Promise(() => undefined), async release() {} }), timerFactory(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer }, clearTimer(timer) { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1) }, onError: error => errors.push(error) })
  let releaseRead, releaseProcess
  try {
    await runtime.start(); timers.shift().callback(); await waitFor(() => timers.length === 1)
    nextRead = new Promise(resolve => { releaseRead = resolve }); const reading = new Promise(resolve => { readEntered = resolve })
    const refreshing = runtime.refresh(); await reading
    nextProcess = new Promise(resolve => { releaseProcess = resolve }); const processing = new Promise(resolve => { processEntered = resolve })
    await runtime.acceptKivoEvent({}); await processing
    releaseRead(); await refreshing
    assert.equal(timers.length, 0, 'stale arm must not schedule while another tick is active')
    releaseProcess(); await waitFor(() => timers.length === 1)
    currentTime = '2026-10-16T01:01:00.000Z'
    timers.shift().callback(); await waitFor(() => releases.has(3))
    assert.deepEqual([...active], [3])
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false, 'close must await the only active tick')
    releases.get(3)(); await closing
    assert.equal(active.size, 0); assert.equal(timers.length, 0); assert.deepEqual(errors, [])
  } finally { releaseRead?.(); releaseProcess?.(); for (const release of releases.values()) release(); await runtime.close() }
}

async function reconcileCadenceChecks() {
  let currentMs = Date.parse(now)
  const durations = [15_000, 65_000], timers = []
  const runtime = createAutomationRuntime({ store: { async read() { return { automationRules: [{ id: 'rule', capabilityId: cap.id, status: 'active', trigger: { kind: 'kivo-record-update', sourceId: 'source' } }], automationInbox: [], automationOccurrences: [] } } },
    automationService: { async acceptDailyOccurrence() {}, async processPending() { currentMs += durations.shift() ?? 0 } }, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: '/tmp/synthetic-no-created-files', clock: () => new Date(currentMs).toISOString(),
    lockFactory: async () => ({ lost: new Promise(() => undefined), async release() {} }), timerFactory(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer }, clearTimer(timer) { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1) } })
  try {
    await runtime.start(); timers.shift().callback(); await waitFor(() => timers.length === 1)
    assert.equal(timers[0].delay, 45_000, 'a 15 second read must preserve the 60 second start cadence')
    const next = timers.shift(); currentMs += next.delay; next.callback(); await waitFor(() => timers.length === 1)
    assert.equal(timers[0].delay, 60_000, 'an overrun waits a full next interval without catch-up or busy retry')
  } finally { await runtime.close() }
}
