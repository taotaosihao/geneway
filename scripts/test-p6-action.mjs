import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionService } from '../src/action-service.mjs'
import { parseCapabilityToolResult, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from '../src/capabilities.mjs'
import { createGearJobCommentAdapter } from '../src/gearjob-comment-adapter.mjs'
import { createWorkService, recoverActionFacts } from '../src/work-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

const now = '2026-09-21T10:00:00.000Z'
const owner = { id: 'member-owner' }
let networkCalls = 0, modelCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { networkCalls += 1; assert.fail('retained action tests must not use the network') }
const inertRunner = { configured: true, async run() { modelCalls += 1; assert.fail('retained action tests must not invoke a model') }, async cancel() {}, async close() {} }
const root = await mkdtemp(join(tmpdir(), 'geneway-p6-action-'))
const secretRoot = join(root, 'secrets')

try {
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'gear.json'), JSON.stringify({ apiKey: 'gear-key', apiSecret: 'gear-secret', invocationSecret: 's'.repeat(48) }), { mode: 0o600 })
  await bodyAndDigestChecks()
  await actionServiceChecks()
  await employeeAuthorizationChecks()
  await historicalPersistenceChecks()
  await adapterChecks()
  assert.equal(networkCalls, 0)
  assert.equal(modelCalls, 0)
  console.log('P6 retained action checks passed; retired admission I/O=0; history/revocation/recovery and raw adapter boundaries verified')
} finally {
  globalThis.fetch = originalFetch
  await rm(root, { recursive: true, force: true })
}

async function employeeAuthorizationChecks() {
  for (const source of ['member', 'employee', 'agent-members']) {
    const action = historicalAction('authorization', { decision: historicalDecision('approved') })
    const sample = fixture({ actions: [action] })
    const workService = createWorkService({ store: sample.store, runner: inertRunner })
    const admin = { id: 'member-admin' }
    const employee = () => workService.listConfig(admin, 'employees').then(items => items[0])
    const oldVersion = (await sample.store.read()).members[0].sessionVersion
    if (source === 'member') {
      await workService.updateMember(admin, owner.id, { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
      await assert.rejects(sample.service.approve(owner, 'work-1', action.id, approval(action)), { code: 'FORBIDDEN' })
      await workService.updateMember(admin, owner.id, { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
    } else if (source === 'employee') {
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, enabled: false })
      await assert.rejects(sample.service.approve(owner, 'work-1', action.id, approval(action)), { code: 'FORBIDDEN' })
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, enabled: true })
    } else {
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, memberIds: ['member-admin'] })
      await assert.rejects(sample.service.approve(owner, 'work-1', action.id, approval(action)), { code: 'FORBIDDEN' })
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, memberIds: [owner.id, 'member-admin'] })
    }
    const state = await sample.store.read()
    assert.equal(state.members[0].sessionVersion, oldVersion)
    assert.equal(state.works[0].actions[0].decision.invalidationReason, 'OWNER_REVOKED')
    assert.equal(state.works[0].actions[0].attempt, null)
    await expectRetired(sample, () => sample.service.approve(owner, 'work-1', action.id, approval(action)))
    assertNoIo(sample)
  }

  const action = historicalAction('authorization-unknown', {
    decision: historicalDecision('approved'), attempt: historicalAttempt({ unknownAt: now, unknownReason: 'UPSTREAM_TIMEOUT' }),
  })
  const unknown = fixture({ actions: [action] })
  const authority = createWorkService({ store: unknown.store, runner: inertRunner })
  await authority.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
  await authority.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
  assert.deepEqual((await unknown.store.read()).works[0].actions[0], action, 'revocation must preserve an already attempted unknown effect')
  await expectRetired(unknown, () => unknown.service.approve(owner, 'work-1', action.id, approval(action)))
  await expectRetired(unknown, () => unknown.service.reconcile(owner, 'work-1', action.id))
  await assert.rejects(unknown.service.revoke(owner, 'work-1', action.id, approval(action)), { code: 'BUSY' })
  assertNoIo(unknown)
}

async function bodyAndDigestChecks() {
  for (const body of ['', ' padded', 'padded ', 'line\nfeed', '@member', 'http://x', 'HTTPS://x', 'www.x', 'mailto:x', 'data:x', '/files/x', '[x](relative)', '![x]', `${'界'.repeat(667)}`]) {
    const { service } = fixture()
    await assert.rejects(service.createPreview(owner, 'work-1', { body, clientRequestId: 'request-1' }), { code: 'INVALID_INPUT' })
  }
  assert.equal(Buffer.byteLength('界'.repeat(666)), 1998)
  for (const clientRequestId of ['', 'contains spaces', 'x'.repeat(129)]) {
    const sample = fixture()
    await assert.rejects(sample.service.createPreview(owner, 'work-1', { body: '安全备注。', clientRequestId }), { code: 'INVALID_REQUEST' })
    assertNoIo(sample)
  }
  const parsed = parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
    { ok: true, ...correlationPayload() }, { workOrderId: 'WO-26-00096' })
  assert.equal(parsed.kind, 'manufacturing.work-order-device-correlation')
  assert.deepEqual(parsed.payload, correlationPayload())
  assert.deepEqual(parsed.source, { gearJob: correlationPayload().gearJob, hive: correlationPayload().hive })
  for (const bad of [{ ...correlationPayload(), workOrderId: 'WO-OTHER' }, { ...correlationPayload(), extra: true }]) {
    assert.throws(() => parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
      { ok: true, ...bad }, { workOrderId: 'WO-26-00096' }), { code: 'TOOL_CHAIN_INVALID' })
  }
  const action = historicalAction('digest')
  const base = fixture({ actions: [action] })
  for (const request of [
    { body: action.preview.payload.body, clientRequestId: 'request-1' },
    { body: action.preview.payload.body, clientRequestId: 'request-2' },
    { body: '正文已编辑。', clientRequestId: 'request-1' },
    { body: '界'.repeat(666), clientRequestId: 'utf8-boundary' },
  ]) await expectRetired(base, () => base.service.createPreview(owner, 'work-1', request))

  const mutations = [
    state => { state.members[0].sessionVersion += 1 },
    state => { state.connections[0].revision += 1 },
    state => { state.connections[1].revision += 1 },
    state => { state.connections[0].targetIdentity = 'gearjob-other' },
    state => { state.works[0].results[0].id = 'result-other' },
    state => { state.works[0].results[0].payload.gearJob.sourceRevision = 'modified:2026-09-21T09:59:01.000000Z' },
    state => { state.works[0].results[0].payload.mapping.operation = 'OP-OTHER' },
    state => { state.works[0].results[0].payload.mapping.workstation = 'WS-OTHER' },
    state => { state.works[0].results[0].payload.mapping.mesUnitId = 'MES-OTHER' },
    state => { state.works[0].results[0].payload.mapping.hiveUnitId = 'GW-P6-CNC-02'; state.works[0].results[0].payload.device.code = 'GW-P6-CNC-02' },
    state => { state.works[0].results[0].payload.tenant.id = '33333333-3333-4333-8333-333333333333' },
    state => { state.works[0].results[0].payload.device.id = '44444444-4444-4444-8444-444444444444' },
    state => { state.works[0].results[0].payload.sample.ts = '2026-09-21T09:59:31.000Z' },
    state => { state.works[0].results[0].payload.sample.quality = 'good' },
    state => { state.works[0].results[0].payload.sample.platformReceivedAt = '2026-09-21T09:59:31.000Z' },
    state => { state.works[0].results[0].payload.status = 2 },
    state => { state.works[0].results[0].payload.recordId = 'record-b' },
    state => { state.works[0].results[0].payload.eventId = 'event-b' },
    state => { state.works[0].results[0].payload.machineFacts.mode = 'MANUAL' },
    state => { state.works[0].results[0].payload.unknowns = ['QUALITY_NOT_PROVIDED'] },
  ]
  for (const mutate of mutations) {
    const sample = fixture({ actions: [action], mutate })
    const before = await sample.store.read()
    await expectRetired(sample, () => sample.service.createPreview(owner, 'work-1', { body: action.preview.payload.body, clientRequestId: 'changed-facts' }))
    await expectRetired(sample, () => sample.service.approve(owner, 'work-1', action.id, approval(action)))
    const after = await sample.store.read()
    assert.deepEqual(after.works[0].actions[0], action, 'retirement must not recompute historical preview/digest')
    assert.deepEqual(after.works[0].results, before.works[0].results, 'legacy typed/source facts must not be rewritten')
  }
}

async function actionServiceChecks() {
  for (const action of historicalActions()) {
    const sample = fixture({ actions: [action] })
    await assert.rejects(sample.service.approve({ id: 'member-admin' }, 'work-1', action.id, approval(action)), { code: 'NOT_FOUND' })
    await assert.rejects(sample.service.reconcile({ id: 'member-admin' }, 'work-1', action.id), { code: 'NOT_FOUND' })
    await expectRetired(sample, () => sample.service.createPreview(owner, 'work-1', { body: '不能新建旧来源动作。', clientRequestId: action.id }))
    await expectRetired(sample, () => sample.service.approve(owner, 'work-1', action.id, approval(action)))
    await expectRetired(sample, () => sample.service.reconcile(owner, 'work-1', action.id))
    const approvals = await Promise.allSettled([1, 2].map(() => sample.service.approve(owner, 'work-1', action.id, approval(action))))
    assert.equal(approvals.every(item => item.status === 'rejected' && item.reason.code === 'CAPABILITY_RETIRED'), true)
    assert.deepEqual((await sample.store.read()).works[0].actions, [action])
    assertNoIo(sample)
  }

  for (const mutate of [
    state => { state.members[0].employeeIds = [] },
    state => { state.employees[0].enabled = false },
    state => { state.skills[0].enabled = false },
    state => { state.modelRoutes[0].enabled = false },
    state => { state.connections[0].enabled = false },
    state => { state.connections[0].allowedObjectIds = [] },
  ]) {
    const action = historicalAction('unauthorized', { decision: historicalDecision('approved') })
    const sample = fixture({ actions: [action], mutate })
    for (const operation of ['approve', 'revoke', 'reject']) {
      await assert.rejects(sample.service[operation](owner, 'work-1', action.id, approval(action)), { code: 'FORBIDDEN' })
    }
    assertNoIo(sample)
  }

  for (const operation of ['reject', 'revoke']) {
    const action = historicalAction(operation)
    const sample = fixture({ actions: [action] })
    await assert.rejects(sample.service[operation]({ id: 'member-admin' }, 'work-1', action.id, approval(action)), { code: 'NOT_FOUND' })
    await assert.rejects(sample.service[operation](owner, 'work-1', action.id, { previewDigest: 'b'.repeat(64) }), { code: 'REVISION_CONFLICT' })
    const result = await sample.service[operation](owner, 'work-1', action.id, approval(action))
    assert.equal(result.decision.kind, operation === 'reject' ? 'rejected' : 'revoked')
    assert.deepEqual(result.preview, action.preview)
    assert.equal(result.attempt, null)
    assert.deepEqual(await sample.service[operation](owner, 'work-1', action.id, approval(action)), result)
    await expectRetired(sample, () => sample.service.approve(owner, 'work-1', action.id, approval(action)))
  }

  const pending = historicalAction('revoke-race', { decision: historicalDecision('approved') })
  const revokeRace = fixture({ actions: [pending] })
  const [approvedRace, revokedRace] = await Promise.allSettled([
    revokeRace.service.approve(owner, 'work-1', pending.id, approval(pending)),
    revokeRace.service.revoke(owner, 'work-1', pending.id, approval(pending)),
  ])
  assert.equal(approvedRace.status, 'rejected')
  assert.equal(approvedRace.reason.code, 'CAPABILITY_RETIRED')
  assert.equal(revokedRace.status, 'fulfilled')
  assert.equal(revokedRace.value.decision.invalidationReason, 'OWNER_REVOKED')
  assert.equal(revokedRace.value.attempt, null)
  assertNoIo(revokeRace)

  const draft = historicalAction('reject-race')
  const rejectRace = fixture({ actions: [draft] })
  const [approvalRace, rejectedRace] = await Promise.allSettled([
    rejectRace.service.approve(owner, 'work-1', draft.id, approval(draft)),
    rejectRace.service.reject(owner, 'work-1', draft.id, approval(draft)),
  ])
  assert.equal(approvalRace.status, 'rejected')
  assert.equal(approvalRace.reason.code, 'CAPABILITY_RETIRED')
  assert.equal(rejectedRace.status, 'fulfilled')
  assert.equal(rejectedRace.value.decision.kind, 'rejected')
  assertNoIo(rejectRace)

  for (const action of historicalActions().filter(value => value.attempt)) {
    const sample = fixture({ actions: [action] })
    for (const operation of ['reject', 'revoke']) {
      await assert.rejects(sample.service[operation](owner, 'work-1', action.id, approval(action)), { code: 'BUSY' })
    }
    assert.deepEqual((await sample.store.read()).works[0].actions, [action], 'an existing effect must not be erased or reported as revoked')
    assertNoIo(sample)
  }

  const rotatedAction = historicalAction('rotated', {
    decision: historicalDecision('approved'), attempt: historicalAttempt({ unknownAt: now, unknownReason: 'UPSTREAM_DISCONNECTED' }),
  })
  const rotated = fixture({ actions: [rotatedAction] })
  await rotated.store.update(state => {
    state.connections[0].revision += 1
    state.connections[0].credentialRef = 'must-not-read.json'
    return state
  })
  rotated.connectionCatalog[0].credentialRef = 'must-not-read.json'
  await expectRetired(rotated, () => rotated.service.reconcile(owner, 'work-1', rotatedAction.id))
}

async function historicalPersistenceChecks() {
  const path = join(root, 'retained-history.json')
  const store = createFileStore(path)
  const seed = fixtureState()
  seed.works[0].actions = historicalActions()
  await store.update(() => seed)
  const before = await store.read()
  const service = createWorkService({ store: createFileStore(path), runner: inertRunner, clock: () => now })
  await service.ensureReady()
  const recovered = await createFileStore(path).read()
  assert.deepEqual(recovered, recoverActionFacts(before, now))
  assert.equal(recovered.works[0].actions.find(action => action.id === 'action-pending').decision.invalidationReason, 'RECOVERY_INVALIDATED')
  assert.equal(recovered.works[0].actions.find(action => action.id === 'action-prepared').attempt.unknownReason, 'RECOVERY_UNKNOWN')
  for (const action of before.works[0].actions.filter(value => value.receipt || value.attempt?.unknownAt || value.attempt?.noEffectAt)) {
    assert.deepEqual(recovered.works[0].actions.find(value => value.id === action.id), action)
  }
  assert.deepEqual(recovered.works[0].results, before.works[0].results)
  assert.deepEqual(recovered.works[0].executions, before.works[0].executions)
  await service.ensureReady()
  assert.deepEqual(await createFileStore(path).read(), recovered, 'restart recovery must be idempotent and never replay an action')

  const draft = recovered.works[0].actions.find(action => action.id === 'action-draft')
  const durable = await readFile(path, 'utf8')
  const failing = createActionService({
    store: createFileStore(path, { async rename() { throw new Error('action decision persistence failed') } }),
    adapter: fakeAdapter([]), connectionCatalog: catalog(seed), clock: () => now,
  })
  await assert.rejects(failing.revoke(owner, 'work-1', draft.id, approval(draft)), /action decision persistence failed/)
  assert.equal(await readFile(path, 'utf8'), durable, 'failed administrative decision must not change durable historical facts')

  await store.update(state => {
    state.connections.forEach(connection => { connection.enabled = false })
    state.skills[0].enabled = false
    return state
  })
  const visible = await service.getWork(owner, 'work-1')
  assert.equal(visible.ok, true)
  assert.equal(visible.value.retired, true)
  assert.deepEqual(visible.value.results, before.works[0].results, 'disabled legacy execution bindings must not hide historical typed/source facts')
  assert.deepEqual(visible.value.actions, recovered.works[0].actions)
  assert.equal((await service.getWork({ id: 'member-admin' }, 'work-1')).error.code, 'NOT_FOUND')
  const stopped = await service.cancel(owner, 'work-1')
  assert.equal(stopped.ok, true)
  assert.equal(stopped.accepted, false)
  assert.deepEqual(stopped.value.actions, recovered.works[0].actions, 'stop must not erase unknown effects or receipts')
  await service.close()
  assert.equal(modelCalls, 0)
}

async function expectRetired(sample, operation) {
  const before = await sample.store.read()
  await assert.rejects(operation, { code: 'CAPABILITY_RETIRED' })
  assert.deepEqual(await sample.store.read(), before, 'retired admission must not create actions/executions or rewrite facts')
  assertNoIo(sample)
}
function assertNoIo(sample) {
  assert.deepEqual(sample.io, { correlation: 0, dispatch: 0, reconcile: 0 })
  assert.equal(modelCalls, 0)
  assert.equal(networkCalls, 0)
}

function historicalDecision(kind) { return { kind, memberId: owner.id, previewDigest: 'a'.repeat(64), decidedAt: now } }
function historicalAttempt(extra = {}) { return { previewDigest: 'a'.repeat(64), preparedAt: now, ...extra } }
function historicalAction(suffix, changes = {}) {
  const action = {
    id: `action-${suffix}`, requestKeys: [`request-${suffix}`], proposalKey: `proposal-${suffix}`,
    intent: { kind: 'gearjob.work-order.comment', targetKey: 'gearjob:gearjob-dev:Work Order:WO-26-00096' },
    preview: {
      digest: 'a'.repeat(64), resultId: 'result-1',
      target: { system: 'gearjob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', objectType: 'Work Order', workOrderId: 'WO-26-00096' },
      payload: { body: '已保存的安全备注。' }, expectedRevision: 'modified:2026-09-21T09:59:00.000000Z',
      createdAt: now, expiresAt: '2026-09-21T10:10:00.000Z',
    },
    decision: null, attempt: null, receipt: null,
  }
  return { ...action, ...changes, preview: { ...action.preview, ...changes.preview } }
}
function historicalActions() {
  return [
    historicalAction('draft'), historicalAction('pending', { decision: historicalDecision('approved') }),
    historicalAction('prepared', { decision: historicalDecision('approved'), attempt: historicalAttempt() }),
    historicalAction('receipt', { decision: historicalDecision('approved'), attempt: historicalAttempt(),
      receipt: { previewDigest: 'a'.repeat(64), upstreamRecordId: 'saved-synthetic-comment', recordedAt: now } }),
    historicalAction('no-effect', { decision: historicalDecision('approved'),
      attempt: historicalAttempt({ noEffectAt: now, noEffectReason: 'SOURCE_REVISION_CONFLICT' }) }),
    ...['rejected', 'revoked', 'expired'].map(kind => historicalAction(kind, { decision: historicalDecision(kind) })),
    ...['UPSTREAM_TIMEOUT', 'ACTION_ID_CONFLICT', 'UPSTREAM_5XX', 'READBACK_MISMATCH', 'UPSTREAM_DISCONNECTED',
      'READBACK_AUTHORIZATION_FAILED', 'RECEIPT_PERSIST_FAILED', 'RECOVERY_UNKNOWN'].map(reason => historicalAction(reason, {
      decision: historicalDecision('approved'), attempt: historicalAttempt({ unknownAt: now, unknownReason: reason }),
    })),
  ]
}

async function adapterChecks() {
  const action = adapterAction()
  const calls = [], order = []
  const adapter = createGearJobCommentAdapter({
    clock: sequenceClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:01.000Z']),
    idFactory: uuidSequence(),
    fetchImpl(url, init) {
      order.push('fetch')
      calls.push({ url: String(url), init })
      return Promise.resolve(response(calls.length === 1 ? 201 : 200, commentResponse(action, calls.length === 1 ? 'created' : 'found')))
    },
  })
  const outcome = await adapter.dispatch({
    action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z',
    claimAttempt: () => ({ then(resolve) { order.push('claim'); resolve({ claimed: true }) } }),
    markNoEffect: async reason => ({ reason }),
    authorizeReadback: async () => undefined,
  })
  assert.equal(outcome.kind, 'receipt')
  assert.deepEqual(calls.map(item => item.init.method), ['POST', 'GET'])
  assert.equal(calls.every(item => item.init.redirect === 'error'), true)
  assert.deepEqual(order.slice(0, 2), ['claim', 'fetch'], 'claim completion must be adjacent to POST fetch')
  const writeClaims = tokenClaims(calls[0].init.headers['x-geneway-connector-token'])
  const readClaims = tokenClaims(calls[1].init.headers['x-geneway-connector-token'])
  assert.deepEqual([writeClaims.aud, writeClaims.stepId], ['gearjob-work-order-comment-writer', 'create_work_order_comment'])
  assert.deepEqual([readClaims.aud, readClaims.stepId], ['gearjob-work-order-comment-reader', 'read_work_order_comment'])
  assert.equal(writeClaims.effectId, action.id)
  assert.equal(readClaims.effectId, action.id)
  assert.notEqual(writeClaims.connectorQuerySpecHash, readClaims.connectorQuerySpecHash)
  const expectedWriteSpec = '{"operation":"create_work_order_comment","parameters":{"actionId":"action-11111111-1111-4111-8111-111111111111","content":"\\u5b89\\u5168\\u5907\\u6ce8\\u3002","expectedRevision":"modified:2026-09-21T09:59:00.000000Z","workOrderRef":"WO-26-00096"},"schemaVersion":"gearjob-p6-request/1"}'
  assert.equal(writeClaims.connectorQuerySpecHash, createHash('sha256').update(expectedWriteSpec).digest('hex'))
  for (const call of calls) {
    const [encoded, signature] = call.init.headers['x-geneway-connector-token'].split('.')
    assert.equal(signature, createHmac('sha256', 's'.repeat(48)).update(encoded).digest('base64url'))
  }

  let expiredFetches = 0, marked
  const expired = createGearJobCommentAdapter({
    clock: sequenceClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:15.000Z']), idFactory: uuidSequence(),
    fetchImpl() { expiredFetches += 1 },
  })
  const expiredResult = await expired.dispatch({
    action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z',
    claimAttempt: async () => ({ claimed: true }), markNoEffect: async reason => { marked = reason; return { attempt: { noEffectReason: reason } } }, authorizeReadback: async () => undefined,
  })
  assert.equal(expiredResult.kind, 'no-effect')
  assert.equal(marked, 'DISPATCH_DEADLINE_EXPIRED')
  assert.equal(expiredFetches, 0)

  let claimFailureFetches = 0
  const claimFailure = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl() { claimFailureFetches += 1 } })
  await assert.rejects(claimFailure.dispatch({
    action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z',
    claimAttempt: async () => { throw new Error('durable claim failed') }, markNoEffect: async () => ({}), authorizeReadback: async () => undefined,
  }), /durable claim failed/)
  assert.equal(claimFailureFetches, 0)

  await chmod(join(secretRoot, 'gear.json'), 0o644)
  await assert.rejects(adapter.reconcile({ action, connection: gearConnection(), secretRoot, authorizeReadback: async () => undefined }), error => error.code === 'SOURCE_NOT_CONFIGURED' && !JSON.stringify(error).includes('gear-secret'))
  await chmod(join(secretRoot, 'gear.json'), 0o600)

  for (const [post, get, expected] of [
    [response(409, { code: 'SOURCE_REVISION_CONFLICT' }), null, ['no-effect', 'SOURCE_REVISION_CONFLICT']],
    [response(409, { code: 'ACTION_ID_CONFLICT' }), null, ['unknown', 'ACTION_ID_CONFLICT']],
    [response(503, { code: 'ACTION_RESULT_UNKNOWN' }), null, ['unknown', 'UPSTREAM_RESULT_UNKNOWN']],
    [response(500, { code: 'FAILED' }), null, ['unknown', 'UPSTREAM_5XX']],
    [response(200, { status: 'created' }), null, ['unknown', 'INVALID_SUCCESS_RESPONSE']],
    [response(201, commentResponse(action, 'created')), response(404, { code: 'COMMENT_NOT_FOUND' }), ['unknown', 'READBACK_NOT_FOUND']],
    [response(201, commentResponse(action, 'created')), response(200, { ...commentResponse(action, 'found'), content: 'mismatch' }), ['unknown', 'READBACK_MISMATCH']],
  ]) {
    const queue = [post, ...(get ? [get] : [])]
    const candidate = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => queue.shift() })
    const value = await candidate.dispatch({ action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z', claimAttempt: async () => ({ claimed: true }), markNoEffect: async () => ({}), authorizeReadback: async () => undefined })
    assert.deepEqual([value.kind, value.reason], expected)
  }

  for (const [error, reason] of [[Object.assign(new Error('secret canary'), { name: 'TimeoutError' }), 'UPSTREAM_TIMEOUT'], [new Error('secret canary'), 'UPSTREAM_DISCONNECTED']]) {
    const failing = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => { throw error } })
    const value = await failing.dispatch({ action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z', claimAttempt: async () => ({ claimed: true }), markNoEffect: async () => ({}), authorizeReadback: async () => undefined })
    assert.deepEqual([value.kind, value.reason], ['unknown', reason])
    assert.equal(JSON.stringify(value).includes('secret canary'), false)
  }

  const replayQueue = [response(200, commentResponse(action, 'replayed')), response(200, commentResponse(action, 'found'))]
  const replayAdapter = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => replayQueue.shift() })
  assert.equal((await replayAdapter.dispatch({ action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z', claimAttempt: async () => ({ claimed: true }), markNoEffect: async () => ({}), authorizeReadback: async () => undefined })).kind, 'receipt')

  let dispatchAuthorizedGets = 0
  const dispatchAuthorizationQueue = [response(201, commentResponse(action, 'created'))]
  const dispatchAuthorization = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => { dispatchAuthorizedGets += 1; return dispatchAuthorizationQueue.shift() } })
  const deniedDispatchReadback = await dispatchAuthorization.dispatch({
    action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z', claimAttempt: async () => ({ claimed: true }), markNoEffect: async () => ({}),
    authorizeReadback: async () => { throw new Error('secret readback denial') },
  })
  assert.deepEqual(deniedDispatchReadback, { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' })
  assert.equal(dispatchAuthorizedGets, 1, 'only POST may reach fetch when readback authorization fails')
  assert.equal(JSON.stringify(deniedDispatchReadback).includes('secret readback denial'), false)

  let reconcileAuthorizedGets = 0
  const deniedReconcile = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => { reconcileAuthorizedGets += 1; return response(200, {}) } })
  assert.deepEqual(await deniedReconcile.reconcile({
    action, connection: gearConnection(), secretRoot, authorizeReadback: async () => { throw new Error('secret reconcile denial') },
  }), { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' })
  assert.equal(reconcileAuthorizedGets, 0)

  let missingCallbackFetches = 0
  const missingCallback = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async () => { missingCallbackFetches += 1; return response(201, commentResponse(action, 'created')) } })
  assert.deepEqual(await missingCallback.dispatch({
    action, connection: gearConnection(), secretRoot, deadlineAt: '2026-09-21T10:00:15.000Z', claimAttempt: async () => ({ claimed: true }), markNoEffect: async () => ({}),
  }), { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' })
  assert.equal(missingCallbackFetches, 1, 'missing callback permits POST but no readback GET')
  assert.deepEqual(await missingCallback.reconcile({ action, connection: gearConnection(), secretRoot, authorizeReadback: 'invalid' }), { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' })
  assert.equal(missingCallbackFetches, 1, 'missing/non-function callback must stop reconcile before GET')

  let reconcileMethod
  const onlyGet = createGearJobCommentAdapter({ clock: () => new Date(now), idFactory: uuidSequence(), fetchImpl: async (_url, init) => { reconcileMethod = init.method; return response(404, {}) } })
  assert.equal((await onlyGet.reconcile({ action, connection: gearConnection(), secretRoot, authorizeReadback: async () => undefined })).kind, 'unknown')
  assert.equal(reconcileMethod, 'GET')
  assert.equal(JSON.stringify(calls).includes('gear-secret'), true, 'authorization header is present only in the in-memory transport probe')
  assert.equal(JSON.stringify(outcome).includes('gear-secret'), false)
}

function fixture({ mutate, actions = [] } = {}) {
  const state = fixtureState()
  state.works[0].actions = structuredClone(actions)
  mutate?.(state)
  const store = memoryStore(state)
  const connectionCatalog = catalog(state)
  const io = { correlation: 0, dispatch: 0, reconcile: 0 }
  const upstream = fakeAdapter([])
  const service = createActionService({
    store, adapter: {
      async dispatch(value) { io.dispatch += 1; return upstream.dispatch(value) },
      async reconcile(value) { io.reconcile += 1; return upstream.reconcile(value) },
    }, secretRoot, connectionCatalog, clock: () => now,
    idFactory: uuidSequence(),
    async readCorrelation() { io.correlation += 1; assert.fail('retired actions must not re-read legacy sources') },
  })
  return { service, store, connectionCatalog, io }
}

function fakeAdapter(effects) {
  return {
    async dispatch() { effects.push('post'); assert.fail('retired action must not dispatch') },
    async reconcile() { effects.push('get'); assert.fail('retired action must not reconcile') },
  }
}

function fixtureState() {
  const payload = correlationPayload()
  const input = { workOrderId: 'WO-26-00096' }
  const result = parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, { ok: true, ...payload }, input)
  return {
    version: 8,
    members: [
      { id: 'member-owner', loginName: 'owner', authRef: 'member-owner', role: 'member', enabled: true, sessionVersion: 1, employeeIds: ['employee-1'] },
      { id: 'member-admin', loginName: 'admin', authRef: 'member-admin', role: 'admin', enabled: true, sessionVersion: 1, employeeIds: ['employee-1'] },
    ],
    modelRoutes: [{ id: 'route-1', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-1', name: '助手', enabled: true, modelRouteId: 'route-1', connectionIds: ['connection-gear', 'connection-hive'], skillIds: ['skill-manufacturing-work-order-device-correlate'] }],
    connections: [gearConnection(), hiveConnection()],
    skills: [{ id: 'skill-manufacturing-work-order-device-correlate', enabled: true, capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY }],
    confirmations: [], knowledgeMaterials: [], reservations: {},
    channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [],
    automationRules: [], automationOccurrences: [],
    works: [{
      id: 'work-1', ownerMemberId: 'member-owner', employeeId: 'employee-1', skillId: 'skill-manufacturing-work-order-device-correlate', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
      connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive' }, input, status: 'completed', acceptedAt: now,
      results: [{ id: 'result-1', ...result, input, capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, skillId: 'skill-manufacturing-work-order-device-correlate',
        schemaVersion: 1, createdAt: now, dshSessionRef: 'session-fixture', contextConfirmationRefs: [] }],
      executions: [{ id: 'exec-1', status: 'completed', resultId: 'result-1' }], actions: [],
    }],
  }
}

function correlationPayload() {
  return {
    workOrderId: 'WO-26-00096', queriedAt: now,
    connections: { gearJob: { id: 'connection-gear', revision: 1 }, hive: { id: 'connection-hive', revision: 1 } },
    gearJob: { sourceSystem: 'GearJob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', sourceRevision: 'modified:2026-09-21T09:59:00.000000Z', queriedAt: now },
    hive: { sourceSystem: 'Hive', sourceInstance: 'geneway-p6', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', sourceRevision: 'record-a', queriedAt: now },
    mapping: { operation: 'GW-P6-OP-01', workstation: 'GW-P6-WS-01', mesUnitId: 'GW-P6-CNC-01', hiveUnitId: 'GW-P6-CNC-01' },
    tenant: { id: '11111111-1111-4111-8111-111111111111' }, device: { id: '22222222-2222-4222-8222-222222222222', code: 'GW-P6-CNC-01' },
    sample: { ts: '2026-09-21T09:59:30.000Z', platformReceivedAt: null, quality: null }, status: 1, recordId: 'record-a', eventId: 'event-a',
    freshness: { ageSeconds: 30, maxAgeSeconds: 120, maxFutureSkewSeconds: 5 }, machineFacts: { mode: 'AUTO', is_online: true }, unknowns: ['QUALITY_NOT_PROVIDED', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'],
  }
}

function gearConnection() {
  return { id: 'connection-gear', kind: 'gearjob-rest', targetIdentity: 'gearjob-dev', baseUrl: 'https://gearjob.test', credentialRef: 'gear.json', allowedObjectIds: ['WO-26-00096'], sourceSystem: 'GearJob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', enabled: true, status: 'ready', skillIds: ['skill-manufacturing-work-order-device-correlate'], revision: 1 }
}
function hiveConnection() {
  return { id: 'connection-hive', kind: 'hive-tenant-records', targetIdentity: '11111111-1111-4111-8111-111111111111', baseUrl: 'https://hive.test', credentialRef: 'hive.json', allowedObjectIds: ['GW-P6-CNC-01'], sourceSystem: 'Hive', sourceInstance: 'geneway-p6', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', enabled: true, status: 'ready', skillIds: ['skill-manufacturing-work-order-device-correlate'], revision: 1 }
}

function catalog(state) {
  return state.connections.map(({ allowedObjectIds, enabled, status, skillIds, revision, ...connection }) => connection)
}

function memoryStore(initial) {
  let state = structuredClone(initial), pending = Promise.resolve()
  return {
    async read() { await pending; return structuredClone(state) },
    async update(mutator) {
      const operation = pending.then(async () => {
        const next = structuredClone(await mutator(structuredClone(state)))
        state = next
        return structuredClone(state)
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
}

function approval(action) { return { previewDigest: action.preview.digest, expectedRevision: action.preview.expectedRevision } }
function adapterAction() {
  return { id: 'action-11111111-1111-4111-8111-111111111111', intent: { kind: 'gearjob.work-order.comment' }, preview: { target: { workOrderId: 'WO-26-00096' }, payload: { body: '安全备注。' }, expectedRevision: 'modified:2026-09-21T09:59:00.000000Z' } }
}
function commentResponse(action, status) {
  const content = action.preview.payload.body
  return { status, actionId: action.id, commentName: `geneway-p6-${action.id}`, workOrderRef: 'WO-26-00096', content, contentSha256: createHash('sha256').update(content).digest('hex'), expectedRevision: action.preview.expectedRevision, published: false }
}
function response(status, body) { return { status, async json() { return structuredClone(body) } } }
function tokenClaims(token) { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')) }
function sequenceClock(values) { let index = 0; return () => new Date(values[Math.min(index++, values.length - 1)]) }
function uuidSequence() { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}` }
