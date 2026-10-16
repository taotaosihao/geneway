import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService, recoverActionFacts } from '../src/work-service.mjs'
import { createActionService } from '../src/action-service.mjs'
import { createKivoRepairAdapter } from '../src/kivo-repair-adapter.mjs'
import { createAutomationService } from '../src/automation-service.mjs'
import { getCapability, KIVO_TPM_DEVICE_CORRELATION_CAPABILITY, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { isRepairCreationEcho, repairIntentKey } from '../src/domain/kivo-repair.mjs'
import { correlationAssessment } from '../src/domain/tpm-device-correlation.mjs'
import { canonical, digest } from '../src/kivo-events.mjs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGenewayServer } from '../src/server.mjs'
import { connection, correlationFixture, deviceId, now } from './fixtures/kivo-device-correlation.mjs'

const roots = [], owner = { id: 'owner' }, cap = getCapability(KIVO_TPM_DEVICE_CORRELATION_CAPABILITY)
const originalFetch = globalThis.fetch
globalThis.fetch = () => assert.fail('pure repair checks must not use the network')
try {
  await successAndOwner()
  await renewedSampleChecks()
  await invalidationAndTime()
  await unresolvedAndConcurrent()
  await authorityAndPinning()
  await creationEchoChecks()
  await httpAdmissionChecks()
  await persistenceAndRecovery()
  console.log(JSON.stringify({ ok: true, checks: ['current-work-entry', 'preview-cas', 'owner-only', 'durable-attempt', 'separate-readback', 'creation-current-versions', 'renewed-sample-conditions', 'edit-expiry-recheck', '15s-window', 'cross-work-account-unresolved', 'atomic-double-approval', 'fsync-zero-write', 'temp-sync-failure-unknown', 'post-rename-fail-closed', 'cold-open-confirmation', 'restart-zero-write', 'off-on-never-revives', 'original-machine-key-rotation-read-only', 'zero-rule-creation-echo', 'authenticated-handler-without-listen'], networkCalls: 0, modelCalls: 0 }))
} finally { globalThis.fetch = originalFetch; for (const root of roots) await fs.rm(root, { recursive: true, force: true }) }

async function fixture({ refresh = value => value } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'geneway-repair-pure-')); roots.push(root)
  let at = now, writes = 0, reads = 0, fault, mode, freshGate
  const io = { async open(path, ...args) {
    const handle = await fs.open(path, ...args)
    return { writeFile: (...a) => handle.writeFile(...a), close: () => handle.close(), async sync() {
      if (String(path).endsWith('.tmp') && fault && !['receipt-dir', 'confirm-dir'].includes(fault) || path === root && ['receipt-dir', 'confirm-dir'].includes(fault)) { if (fault !== 'confirm-dir') fault = null; throw Object.assign(new Error('synthetic durable failure'), { code: 'EIO' }) }
      await handle.sync()
    } }
  } }
  const store = createFileStore(join(root, 'state.json'), io)
  const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
  await store.update(state => ({ ...state, members: ['owner', 'peer', 'admin'].map(id => ({ id, loginName: id, displayName: id, authRef: id, enabled: true, role: id === 'admin' ? 'admin' : 'member', sessionVersion: 1, employeeIds: id === 'owner' ? ['agent'] : [] })), employees: [{ id: 'agent', name: '关联员工', enabled: true, revision: 1, instructions: '', skillIds: [cap.skillId], connectionIds: [connection.id], modelRouteId: 'model' }], skills: [{ id: cap.skillId, name: '设备关联', enabled: true, capabilityId: cap.id }], modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }], connections: [connection] }))
  const workService = createWorkService({ store, clock: () => at, connectionCatalog: catalog, connectionTester: async (_connection, { authorize }) => { await authorize(); return '合成目录已核对' }, runner: { configured: true, async run({ input, grant }) {
    return { explanation: '合成关联结果', dshSessionRef: 'synthetic-session', result: parseCapabilityToolResult(cap.id, { ok: true, observation: correlationFixture({ at, ...input, binding: grant.connection }) }, input) }
  } } })
  const saved = new Map()
  const source = id => ({ system: 'kivo', path: '/api/v1/mes/tpm/repairs', queriedAt: at, traceId: id })
  const adapter = createKivoRepairAdapter({ clock: () => at,
    async createRepair(options) {
      await options.authorize()
      if (mode === 'attempt-fsync') fault = 'attempt'
      await options.beforeWrite()
      if (mode === 'agent-before-first-fetch') {
        await workService.updateConfig({ id: 'admin' }, 'employees', 'agent', { enabled: false, expectedRevision: 1 })
        await workService.updateConfig({ id: 'admin' }, 'employees', 'agent', { enabled: true, expectedRevision: 2 })
      } else if (mode === 'revoke-before-first-fetch') {
        await workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: [], expectedEmployeeIds: ['agent'] })
        await workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: ['agent'], expectedEmployeeIds: [] })
      }
      await options.authorize()
      if (Date.parse(at) >= Date.parse(options.deadlineAt)) throw Object.assign(new Error('synthetic deadline'), { code: 'DISPATCH_DEADLINE_EXPIRED' })
      options.onWriteStarted(); writes += 1
      const record = { id: '00000000-0000-4000-8000-000000000010', ...options.input, detail: { reason: options.input.reason, description: options.input.description }, status: 'repairing', revision: 2, creation: { actorKind: 'machine', machineAccountId: options.connection.clientId, traceId: options.traceId, revision: 0 }, replayed: false }
      saved.set(options.input.orderNo, record)
      if (['committed-after-revoke', 'timeout-after-revoke'].includes(mode)) {
        await workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: [], expectedEmployeeIds: ['agent'] })
        await workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: ['agent'], expectedEmployeeIds: [] })
      }
      if (['timeout', 'timeout-after-revoke'].includes(mode)) throw Object.assign(new Error('synthetic timeout'), { code: 'UPSTREAM_TIMEOUT' })
      return { status: 'ok', source: source(options.traceId), value: record }
    },
    async readRepair(options) {
      reads += 1; await options.authorize()
      if (mode === 'readback-404') throw Object.assign(new Error('synthetic invisible'), { code: 'NOT_FOUND' })
      const record = saved.get(options.orderNo)
      if (mode === 'receipt-fsync') fault = 'receipt'
      if (mode === 'receipt-dir-fsync') fault = 'receipt-dir'
      return { status: 'ok', source: { ...source(options.traceId), path: `/api/v1/mes/tpm/repairs/${options.orderNo}` }, value: record }
    },
  })
  const service = createActionService({ store, adapter, clock: () => at, connectionCatalog: catalog, async readCorrelation(options) {
    await options.authorize(); await freshGate?.()
    return refresh(correlationFixture({ at, ...options.input, ...(mode === 'changed-source' ? { record: { revision: 2 } } : {}) }))
  } })
  return { store, service, workService, catalog, io, statePath: join(root, 'state.json'), get writes() { return writes }, get reads() { return reads }, set time(value) { at = value }, set mode(value) { mode = value }, set gate(value) { freshGate = value }, set fault(value) { fault = value },
    async work(reference = 'R-1', binding = connection) {
      const created = await workService.createWork(owner, { employeeId: 'agent', skillId: cap.skillId, capabilityId: cap.id, connectionId: binding.id, goal: '合成关联', input: { recordType: 'repair', reference }, clientRequestId: `request-${reference}-${(await store.read()).works.length}` })
      assert.equal(created.ok, true)
      const id = created.value.id
      for (let n = 0; n < 100; n += 1) { const w = (await store.read()).works.find(w => w.id === id); if (w.status === 'completed') return w; if (w.status === 'failed') assert.fail(`controlled runner failed: ${w.executions.at(-1).error.code}`); await new Promise(r => setImmediate(r)) }
      assert.fail('controlled work did not finish')
    },
    preview(work, id = 'preview-1', description = '合成诊断说明') { return service.createPreview(owner, work.id, { reason: '合成设备异常', description, clientRequestId: id }) },
  }
}
function approval(action) { return { expectedRevision: action.preview.expectedRevision, previewDigest: action.preview.digest, clientRequestId: 'approve-1' } }

async function successAndOwner() {
  const f = await fixture(), w = await f.work(), action = await f.preview(w)
  assert.equal(f.writes, 0); assert.equal(action.attempt, null)
  assert.match(action.preview.payload.orderNo, /^GW-/)
  assert.equal(action.preview.target.deviceId, deviceId)
  assert.equal((await f.preview(w, 'preview-retry')).id, action.id)
  await assert.rejects(f.preview(w, 'preview-1', '异文'), { code: 'REVISION_CONFLICT' })
  for (const id of ['peer', 'admin']) await assert.rejects(f.service.approve({ id }, w.id, action.id, approval(action)), { code: 'NOT_FOUND' })
  await assert.rejects(f.service.approve(owner, w.id, action.id, { ...approval(action), expectedRevision: '999' }), { code: 'REVISION_CONFLICT' })
  const done = await f.service.approve(owner, w.id, action.id, approval(action))
  assert.equal(f.writes, 1); assert.equal(f.reads, 1)
  assert.equal(done.receipt.creation.revision, '0'); assert.equal(done.receipt.currentRevision, '2')
  assert.equal(done.receipt.creation.traceId, action.id)
  await f.service.approve(owner, w.id, action.id, approval(action))
  assert.equal(f.writes, 1)
  const state = await f.store.read()
  assert.equal(state.version, STATE_VERSION)
  assert.deepEqual(migrateState({ ...state, version: 11 }).works, state.works)
  for (const mutate of [target => { target.clientId = deviceId }, target => { target.resource = 'http://elsewhere.invalid/api/v1/mes/mcp' }, target => { target.recordReference = 'OTHER' }, target => { target.connectionRevision += 1 }]) {
    const corrupted = structuredClone(state); mutate(corrupted.works[0].actions[0].preview.target)
    assert.throws(() => migrateState(corrupted), /维修依据不闭合/)
  }
  await assert.rejects(f.store.update(s => { s.works[0].actions[0].receipt.currentRevision = '3'; return s }), /receipt 不可改写/)
}

async function renewedSampleChecks() {
  const sample = (sampleAt, mutate = () => {}) => value => {
    value.monitoring.recordTs = value.monitoring.observedAt = sampleAt
    mutate(value)
    return Object.assign(value, correlationAssessment(value, value.queriedAt))
  }
  const f = await fixture({ refresh: sample('2026-10-16T10:00:01.000Z') }), work = await f.work(), preview = await f.preview(work)
  const original = structuredClone(work.results.at(-1).payload)
  f.time = '2026-10-16T10:00:01.000Z'
  const done = await f.service.approve(owner, work.id, preview.id, approval(preview))
  assert.equal(f.writes, 1, 'a fresh new sample with unchanged business conditions must allow one creation')
  assert.equal(f.reads, 1); assert.equal(done.receipt.creation.traceId, preview.id)
  assert.deepEqual((await f.store.read()).works[0].results.at(-1).payload, original, 'new sampling must not overwrite the original evidence')

  for (const [name, refresh] of [
    ['stale', sample('2026-10-16T09:57:59.999Z')],
    ['future', sample('2026-10-16T10:00:05.001Z')],
    ['missing', sample(null)],
    ['connection', sample(now, value => { value.monitoring.connection.status = 'offline' })],
    ['runtime', sample(now, value => { value.monitoring.runtime.status = 'fault' })],
    ['alarm', sample(now, value => { value.monitoring.deviceAlarm.activeCount = 1 })],
    ['tpm-status', sample(now, value => { value.tpm.status = 'dispatched' })],
  ]) {
    const denied = await fixture({ refresh }), work = await denied.work(), preview = await denied.preview(work)
    await assert.rejects(denied.service.approve(owner, work.id, preview.id, approval(preview)), { code: 'REVISION_CONFLICT' }, name)
    const action = (await denied.store.read()).works[0].actions[0]
    assert.equal(action.decision.invalidationReason, 'SOURCE_FACTS_CHANGED', name)
    assert.equal(action.attempt, null, name); assert.equal(action.receipt, null, name)
    assert.equal(denied.writes, 0, name); assert.equal(denied.reads, 0, name)
  }
}

async function invalidationAndTime() {
  for (const kind of ['reject', 'revoke', 'expired', 'changed-source', 'deadline']) {
    const f = await fixture(), w = await f.work(), action = await f.preview(w)
    if (['reject', 'revoke'].includes(kind)) {
      await f.service[kind](owner, w.id, action.id, approval(action))
      await assert.rejects(f.service.approve(owner, w.id, action.id, approval(action)), { code: 'REVISION_CONFLICT' })
    } else if (kind === 'expired') {
      f.time = '2026-10-16T10:10:00.000Z'
      assert.equal((await f.service.approve(owner, w.id, action.id, approval(action))).decision.kind, 'expired')
    } else if (kind === 'changed-source') {
      f.mode = kind
      await assert.rejects(f.service.approve(owner, w.id, action.id, approval(action)), { code: 'REVISION_CONFLICT' })
      assert.equal((await f.store.read()).works[0].actions[0].decision.invalidationReason, 'SOURCE_FACTS_CHANGED')
    } else {
      f.gate = () => { f.time = '2026-10-16T10:00:15.000Z' }
      assert.equal((await f.service.approve(owner, w.id, action.id, approval(action))).decision.invalidationReason, 'DISPATCH_DEADLINE_EXPIRED')
    }
    assert.equal(f.writes, 0)
  }
  const f = await fixture(), w = await f.work(), old = await f.preview(w)
  let release, entered
  const gate = new Promise(r => { release = r }), reached = new Promise(r => { entered = r })
  f.gate = () => { entered(); return gate }
  const running = f.service.approve(owner, w.id, old.id, approval(old)).catch(e => e)
  await reached
  const edited = await f.preview(w, 'new-description', '修改后的说明')
  assert.notEqual(edited.id, old.id)
  release(); await running
  assert.equal((await f.store.read()).works[0].actions[0].decision.invalidationReason, 'PREVIEW_SUPERSEDED')
  assert.equal(f.writes, 0)
  f.gate = null
  const again = await f.preview(w, 'back-to-original')
  assert.notEqual(again.id, old.id, 'invalidated proposal must never revive on equal content')
}

async function unresolvedAndConcurrent() {
  const f = await fixture(), a = await f.work(), b = await f.work(), pa = await f.preview(a), pb = await f.preview(b)
  f.mode = 'timeout'
  const results = await Promise.allSettled([f.service.approve(owner, a.id, pa.id, approval(pa)), f.service.approve(owner, b.id, pb.id, approval(pb))])
  assert.equal(f.writes, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'BUSY').length, 1)
  const c = await f.work()
  await assert.rejects(f.preview(c, 'new-work-body', '换工作与正文也不绕过'), { code: 'BUSY' })
  const other = { ...connection, id: 'kivo-other', name: '另一机器账号', targetIdentity: 'other-machine', clientId: deviceId, credentialRef: 'other-machine.pem' }
  f.catalog.push({ ...f.catalog[0], targetIdentity: other.targetIdentity, clientId: other.clientId, credentialRef: other.credentialRef })
  await f.workService.createConfig({ id: 'admin' }, 'connections', other)
  await f.workService.testConnection({ id: 'admin' }, other.id)
  await f.workService.updateConfig({ id: 'admin' }, 'employees', 'agent', { expectedRevision: 1, connectionIds: [connection.id, other.id] })
  await assert.rejects(f.preview(await f.work('R-1', other), 'other-machine-work', '换机器账号也不绕过'), { code: 'BUSY' })
  const attempted = (await f.store.read()).works.flatMap(w => w.actions.map(action => ({ work: w, action }))).find(x => x.action.attempt)
  f.mode = 'readback-404'
  const unknown = await f.service.reconcile(owner, attempted.work.id, attempted.action.id)
  assert.equal(unknown.receipt, null)
  assert.equal(f.writes, 1)
  const key = repairIntentKey(owner.id, pa.preview.target)
  assert.equal(repairIntentKey(owner.id, { ...pa.preview.target, clientId: deviceId, connectionId: 'other', connectionRevision: 2 }), key)
  assert.notEqual(repairIntentKey('peer', pa.preview.target), key)
  assert.notEqual(repairIntentKey(owner.id, { ...pa.preview.target, recordId: deviceId }), key)
  assert.notEqual(repairIntentKey(owner.id, { ...pa.preview.target, sourceInstance: 'other' }), key)
}

async function persistenceAndRecovery() {
  for (const mode of ['attempt-fsync', 'receipt-fsync', 'receipt-dir-fsync']) {
    const f = await fixture(), w = await f.work(), action = await f.preview(w)
    f.mode = mode
    await assert.rejects(f.service.approve(owner, w.id, action.id, approval(action)), { code: 'EIO' })
    assert.equal(f.writes, mode === 'attempt-fsync' ? 0 : 1)
    if (mode === 'receipt-dir-fsync') {
      const unavailable = error => error.code === 'STORE_UNAVAILABLE' && error.cause?.code === 'EIO'
      await assert.rejects(f.store.read(), unavailable)
      const reads = f.reads
      await assert.rejects(f.service.reconcile(owner, w.id, action.id), unavailable)
      let mutations = 0
      await assert.rejects(f.store.update(state => { mutations += 1; return state }), unavailable)
      assert.equal(mutations, 0); assert.equal(f.reads, reads); assert.equal(f.writes, 1)
      f.fault = 'confirm-dir'
      await assert.rejects(f.store.confirmDurability(), { code: 'EIO' })
      await assert.rejects(f.store.read(), unavailable)
      const reopened = createFileStore(f.statePath, f.io)
      await assert.rejects(reopened.read(), { code: 'EIO' }, 'cold read must confirm the surviving file and directory before returning a receipt')
      await assert.rejects(reopened.read(), unavailable)
      const restarting = createWorkService({ store: reopened, runner: { async run() { assert.fail('recovery must not execute a business request') } } })
      await assert.rejects(restarting.ensureReady(), { code: 'EIO' })
      f.fault = null; f.mode = null
      await restarting.ensureReady()
      const saved = (await reopened.read()).works[0].actions[0]
      assert.ok(saved.receipt, 'a surviving real readback is retained after reliable startup confirmation')
      assert.equal(saved.receipt.creation.traceId, action.id)
      await f.store.confirmDurability()
      assert.deepEqual((await f.service.approve(owner, w.id, action.id, approval(action))).receipt, saved.receipt)
      assert.equal(f.writes, 1)
      continue
    }
    const saved = (await f.store.read()).works[0].actions[0]
    if (mode.startsWith('receipt-')) { assert.equal(saved.attempt.unknownReason, 'RECEIPT_PERSIST_FAILED'); assert.equal(saved.receipt, null) }
    else assert.equal(saved.attempt, null)
    const recovered = recoverActionFacts(await f.store.read(), now)
    assert.equal(recovered.works[0].actions[0].decision.invalidatedAt !== undefined || recovered.works[0].actions[0].attempt.unknownAt !== undefined, true)
  }
}

async function authorityAndPinning() {
  for (const mode of ['revoke-before-first-fetch', 'agent-before-first-fetch', 'committed-after-revoke', 'timeout-after-revoke']) {
    const f = await fixture(), work = await f.work(), action = await f.preview(work)
    f.mode = mode
    const settled = await f.service.approve(owner, work.id, action.id, approval(action))
    assert.equal(settled.decision.invalidationReason, 'OWNER_REVOKED')
    const beforeWrite = mode.endsWith('before-first-fetch')
    assert.equal(f.writes, beforeWrite ? 0 : 1)
    if (beforeWrite) assert.equal(settled.attempt.noEffectReason, 'OWNER_REVOKED')
    else if (mode === 'committed-after-revoke') assert.ok(settled.receipt)
    else {
      assert.equal(settled.attempt.unknownReason, 'UPSTREAM_TIMEOUT')
      f.mode = null
      assert.ok((await f.service.reconcile(owner, work.id, action.id)).receipt)
      assert.equal(f.writes, 1)
    }
    await f.service.approve(owner, work.id, action.id, approval(action))
    assert.equal(f.writes, beforeWrite ? 0 : 1, 'off/on may not resurrect the original dispatch')
  }
  const f = await fixture(), w = await f.work(), action = await f.preview(w)
  let release, entered
  const gate = new Promise(r => { release = r }), reached = new Promise(r => { entered = r })
  f.gate = () => { entered(); return gate }
  const running = f.service.approve(owner, w.id, action.id, approval(action)).catch(e => e)
  await reached
  await f.workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: [], expectedEmployeeIds: ['agent'] })
  await f.workService.updateMember({ id: 'admin' }, owner.id, { employeeIds: ['agent'], expectedEmployeeIds: [] })
  release(); await running
  assert.equal(f.writes, 0)
  assert.equal((await f.store.read()).works[0].actions[0].decision.invalidationReason, 'OWNER_REVOKED')
  const g = await fixture(), work = await g.work(), preview = await g.preview(work)
  g.mode = 'timeout'; await g.service.approve(owner, work.id, preview.id, approval(preview))
  g.catalog[0].credentialRef = 'rotated-synthetic.pem'
  await g.workService.updateConfig({ id: 'admin' }, 'connections', connection.id, { credentialRef: 'rotated-synthetic.pem' })
  await g.workService.testConnection({ id: 'admin' }, connection.id)
  g.mode = null
  assert.ok((await g.service.reconcile(owner, work.id, preview.id)).receipt, 'same original machine may use its current authorized key for read-only reconciliation')
  const h = await fixture(), hw = await h.work(), hp = await h.preview(hw)
  h.mode = 'timeout'; await h.service.approve(owner, hw.id, hp.id, approval(hp))
  await h.store.update(state => { state.connections[0].clientId = deviceId; state.connections[0].revision += 1; return state })
  h.catalog[0].clientId = deviceId
  await assert.rejects(h.service.reconcile(owner, hw.id, hp.id), e => ['FORBIDDEN', 'REVISION_CONFLICT'].includes(e.code))
  assert.equal(h.writes, 1)
}

async function creationEchoChecks() {
  for (const beforeReadback of [false, true]) {
    const f = await fixture(), work = await f.work(), preview = await f.preview(work)
    if (beforeReadback) f.mode = 'timeout'
    const attempted = await f.service.approve(owner, work.id, preview.id, approval(preview))
    const event = { sourceId: 'source-p6', resource: connection.baseUrl, sourceInstance: connection.sourceInstance, adapter: 'mes.native', kind: 'notification.business_event', version: 1,
      eventId: randomUUID(), recordType: 'repair', objectId: '00000000-0000-4000-8000-000000000010', sourceRevision: '0', occurredAt: now, traceId: preview.id, actorId: `machine-account:${connection.clientId}`, actorKind: 'machine', action: 'create', before: null, after: { status: 'reported', executorId: null },
      subject: { id: '00000000-0000-4000-8000-000000000010', type: 'repair', deviceId, organizationId: randomUUID(), organizationAncestorIds: [] } }
    const config = { sha256: 'a'.repeat(64), sources: [{ id: 'source-p6', enabled: true, connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance }] }
    const automation = createAutomationService({ store: f.store, actionService: f.service, connectionCatalog: f.catalog, readEventSources: async () => config, clock: () => now })
    const verified = { deliveryId: randomUUID(), rawDigest: 'b'.repeat(64), event, fingerprint: digest(JSON.stringify(canonical(event))), sourceConfigSha256: config.sha256 }
    const reads = f.reads
    await automation.acceptKivoEvent(verified)
    assert.equal(f.reads, reads, 'zero-rule ACK may not await a readback')
    assert.equal((await f.store.read()).automationRules.length, 0)
    f.mode = null
    await automation.processPending()
    const state = await f.store.read(), action = state.works[0].actions[0]
    assert.deepEqual(state.automationInbox[0].actionRef, { workId: work.id, actionId: preview.id })
    assert.equal(state.works.length, 1, 'creation echo must not create an automatic work')
    assert.equal(f.writes, 1)
    assert.equal(action.receipt.creation.revision, '0')
    assert.equal(action.receipt.currentRevision, '2', 'higher readback revision must not replace the creation version')
    assert.equal(isRepairCreationEcho(event, action), true)
    assert.equal(isRepairCreationEcho(event, attempted), !beforeReadback)
    for (const change of [e => e.actorId = `machine-account:${deviceId}`, e => e.resource = 'http://127.0.0.1:9/api/v1/mes/mcp', e => e.sourceInstance = 'other', e => e.objectId = deviceId, e => e.sourceRevision = '2', e => e.traceId = 'other-action', e => e.subject.deviceId = connection.clientId]) {
      const changed = structuredClone(event); change(changed); assert.equal(isRepairCreationEcho(changed, action), false)
    }
    const higher = { ...event, action: 'dispatch', sourceRevision: '3', before: { status: 'reported' }, after: { status: 'dispatched' } }
    assert.equal(isRepairCreationEcho(higher, action), false, 'higher current versions are ordinary changes')
    assert.equal((await automation.acceptKivoEvent(verified)).deduplicated, true)
    await automation.processPending({ reconcile: true })
    assert.equal(f.writes, 1)
    assert.equal((await f.workService.getWork(owner, work.id)).value.actions[0].echoEvents.length, 1)
    assert.deepEqual(recoverActionFacts(state, now).automationInbox, state.automationInbox)
  }
}

async function httpAdmissionChecks() {
  const f = await fixture(), work = await f.work(), origin = 'http://127.0.0.1:41002'
  const auth = { async sessionView(token) { return { session: { memberId: token, sessionVersion: 1 }, csrfToken: 'synthetic-csrf' } }, async verifyCsrf(_token, value) { return value === 'synthetic-csrf' } }
  const server = createGenewayServer({ service: f.workService, actionService: f.service, store: f.store, auth, trustedOrigin: origin })
  const path = `/api/works/${work.id}/actions`, input = { reason: '合成原因', description: '合成说明', clientRequestId: 'http-preview' }
  try {
    assert.equal((await request(path, input, { member: '' })).status, 401)
    assert.equal((await request(path, input, { origin: 'http://elsewhere.invalid' })).status, 403)
    assert.equal((await request(path, input, { csrf: 'wrong' })).status, 403)
    for (const extra of [{ ownerMemberId: 'peer' }, { target: { deviceId } }, { payload: input }, { orderNo: 'GW-forged' }, { approver: owner.id }, { nativeSessionId: 'forged' }]) assert.equal((await request(path, { ...input, ...extra })).status, 400)
    assert.equal((await request(path + '?hidden=1', input)).status, 400)
    assert.equal((await request(path, input, { member: 'admin' })).status, 404)
    const created = await request(path, input)
    assert.equal(created.status, 200)
    const action = created.body, approvePath = `${path}/${action.id}/approve`
    assert.equal(action.preview.payload.deviceId, deviceId)
    assert.equal((await request(approvePath, { ...approval(action), reason: '不能改正文' })).status, 400)
    assert.equal((await request(approvePath, { ...approval(action), expectedRevision: 'other' })).status, 409)
    assert.equal((await request(approvePath, approval(action), { member: 'peer' })).status, 404)
    assert.equal(f.writes, 0)
    const approved = await request(approvePath, approval(action))
    assert.equal(approved.status, 200); assert.equal(approved.body.receipt.orderNo, action.preview.payload.orderNo)
    await request(approvePath, approval(action)); assert.equal(f.writes, 1)
    assert.equal((await request(`${path}/${action.id}/reconcile`, { target: {} })).status, 400)
    assert.equal(server.listening, false)
  } finally { server.close() }

  function request(url, body, { member = owner.id, origin: requestedOrigin = origin, csrf = 'synthetic-csrf' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = url
    req.headers = { cookie: member ? `geneway_session=${member}` : '', origin: requestedOrigin, 'x-csrf-token': csrf, 'content-type': 'application/json' }
    return new Promise(resolve => server.emit('request', req, { writeHead(status) { this.status = status }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }) } }))
  }
}
