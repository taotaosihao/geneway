import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionService } from '../src/action-service.mjs'
import { WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from '../src/capabilities.mjs'
import { createGearJobCommentAdapter, gearJobReadbackConnectionSnapshot } from '../src/gearjob-comment-adapter.mjs'
import { createWorkService } from '../src/work-service.mjs'

const now = '2026-09-21T10:00:00.000Z'
const owner = { id: 'member-owner' }
const root = await mkdtemp(join(tmpdir(), 'geneway-p6-action-'))
const secretRoot = join(root, 'secrets')

try {
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'gear.json'), JSON.stringify({ apiKey: 'gear-key', apiSecret: 'gear-secret', invocationSecret: 's'.repeat(48) }), { mode: 0o600 })
  await bodyAndDigestChecks()
  await actionServiceChecks()
  await employeeAuthorizationChecks()
  await adapterChecks()
  console.log('P6 action checks passed; preview/action/dispatch/readback/recovery boundaries verified')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function employeeAuthorizationChecks() {
  for (const source of ['member', 'employee', 'agent-members']) {
    const sample = fixture({ mutate: state => { state.employees[0].name = '助手' }, adapter: { async dispatch({ action }) { return { kind: 'not-claimed', action } } } })
    const workService = createWorkService({ store: sample.store })
    const preview = await sample.service.createPreview(owner, 'work-1', { body: '撤权后旧批准不能恢复。', clientRequestId: `authorization-${source}` })
    const approved = await sample.service.approve(owner, 'work-1', preview.id, approval(preview))
    assert.equal(approved.decision.kind, 'approved')
    assert.equal(approved.attempt, null)
    const admin = { id: 'member-admin' }
    const employee = () => workService.listConfig(admin, 'employees').then(items => items[0])
    const oldVersion = (await sample.store.read()).members[0].sessionVersion
    if (source === 'member') {
      await workService.updateMember(admin, owner.id, { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
      await workService.updateMember(admin, owner.id, { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
    } else if (source === 'employee') {
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, enabled: false })
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, enabled: true })
    } else {
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, memberIds: ['member-admin'] })
      await workService.updateConfig(admin, 'employees', 'employee-1', { expectedRevision: (await employee()).revision, memberIds: [owner.id, 'member-admin'] })
    }
    const state = await sample.store.read()
    assert.equal(state.members[0].sessionVersion, oldVersion)
    assert.equal(state.works[0].actions[0].decision.invalidationReason, 'OWNER_REVOKED')
    await assert.rejects(sample.service.approve(owner, 'work-1', preview.id, approval(preview)), error => error.code === 'REVISION_CONFLICT')
  }

  const effects = []
  const unknown = fixture({ adapter: fakeAdapter(effects, 0, { kind: 'unknown', reason: 'UPSTREAM_TIMEOUT' }) })
  const preview = await unknown.service.createPreview(owner, 'work-1', { body: '已有请求只保留核对。', clientRequestId: 'authorization-unknown' })
  const attempt = await unknown.service.approve(owner, 'work-1', preview.id, approval(preview))
  const workService = createWorkService({ store: unknown.store })
  await workService.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
  await workService.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
  const preserved = (await unknown.store.read()).works[0].actions[0]
  assert.deepEqual(preserved.attempt, attempt.attempt)
  assert.equal(preserved.decision.invalidatedAt, undefined)
  await unknown.service.approve(owner, 'work-1', preview.id, approval(preview))
  assert.deepEqual(effects, ['post'])

  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const dispatchEffects = []
  const delayed = fixture({ adapter: {
    async dispatch({ claimAttempt }) {
      entered()
      await gate
      const claim = await claimAttempt()
      if (!claim.claimed) return { kind: 'not-claimed', action: claim.action }
      dispatchEffects.push('post')
      return { kind: 'unknown', reason: 'UPSTREAM_TIMEOUT' }
    },
  } })
  const delayedPreview = await delayed.service.createPreview(owner, 'work-1', { body: '派发前撤销再加回也不发送。', clientRequestId: 'authorization-dispatch' })
  const approving = delayed.service.approve(owner, 'work-1', delayedPreview.id, approval(delayedPreview))
  await started
  const authority = createWorkService({ store: delayed.store })
  await authority.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
  await authority.updateMember({ id: 'member-admin' }, owner.id, { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
  release()
  assert.equal((await approving).decision.invalidationReason, 'OWNER_REVOKED')
  assert.deepEqual(dispatchEffects, [])
}

async function bodyAndDigestChecks() {
  for (const body of ['', ' padded', 'padded ', 'line\nfeed', '@member', 'http://x', 'HTTPS://x', 'www.x', 'mailto:x', 'data:x', '/files/x', '[x](relative)', '![x]', `${'界'.repeat(667)}`]) {
    const { service } = fixture()
    await assert.rejects(service.createPreview(owner, 'work-1', { body, clientRequestId: 'request-1' }), error => error.code === 'INVALID_INPUT')
  }
  assert.equal(Buffer.byteLength('界'.repeat(666)), 1998)
  let previewClock = now
  const base = fixture({ clockFn: () => previewClock })
  const preview = await base.service.createPreview(owner, 'work-1', { body: '工单需要人工核对。', clientRequestId: 'request-1' })
  previewClock = '2026-09-21T10:00:01.000Z'
  const replay = await base.service.createPreview(owner, 'work-1', { body: '工单需要人工核对。', clientRequestId: 'request-1' })
  assert.equal(replay.id, preview.id)
  await assert.rejects(base.service.createPreview(owner, 'work-1', { body: '正文已编辑。', clientRequestId: 'request-1' }), error => error.code === 'REVISION_CONFLICT')
  const sameProposal = await base.service.createPreview(owner, 'work-1', { body: '工单需要人工核对。', clientRequestId: 'request-2' })
  assert.equal(sameProposal.id, preview.id)
  assert.equal(sameProposal.proposalKey, preview.proposalKey)
  assert.equal(sameProposal.requestKeys.length, 2)
  await assert.rejects(base.service.createPreview(owner, 'work-1', { body: 'request-2 改正文必须冲突。', clientRequestId: 'request-2' }), error => error.code === 'REVISION_CONFLICT')
  assert.equal((await base.store.read()).works[0].actions.length, 1)

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
  const digests = new Set([preview.preview.digest])
  for (let index = 0; index < mutations.length; index += 1) {
    const sample = fixture({ mutate: mutations[index] })
    const candidate = await sample.service.createPreview(owner, 'work-1', { body: '工单需要人工核对。', clientRequestId: `request-${index + 10}` })
    assert.equal(digests.has(candidate.preview.digest), false, `frozen field ${index} must alter digest`)
    digests.add(candidate.preview.digest)
  }
}

async function actionServiceChecks() {
  const effects = []
  const successful = fixture({ adapter: fakeAdapter(effects) })
  const preview = await successful.service.createPreview(owner, 'work-1', { body: '批准后的安全备注。', clientRequestId: 'approve-1' })
  await assert.rejects(successful.service.approve({ id: 'member-admin' }, 'work-1', preview.id, approval(preview)), error => error.code === 'NOT_FOUND')
  const result = await successful.service.approve(owner, 'work-1', preview.id, approval(preview))
  assert.equal(result.receipt.upstreamRecordId, `geneway-p6-${preview.id}`)
  assert.deepEqual(effects, ['post'])
  assert.equal(successful.authCount(), 3)
  const duplicate = await successful.service.approve(owner, 'work-1', preview.id, approval(preview))
  assert.equal(duplicate.receipt.upstreamRecordId, result.receipt.upstreamRecordId)
  assert.deepEqual(effects, ['post'])

  const queryOnly = fixture({ adapter: fakeAdapter([]), refresh: payload => {
    payload.queriedAt = '2026-09-21T10:00:01.000Z'
    payload.gearJob.queriedAt = payload.hive.queriedAt = payload.queriedAt
    payload.freshness.ageSeconds = 31
  } })
  const queryPreview = await queryOnly.service.createPreview(owner, 'work-1', { body: '查询时间变化不改变业务事实。', clientRequestId: 'query-only' })
  assert.ok((await queryOnly.service.approve(owner, 'work-1', queryPreview.id, approval(queryPreview))).receipt)

  const changedEffects = []
  const changed = fixture({ adapter: fakeAdapter(changedEffects), refresh: payload => { payload.machineFacts.mode = 'MANUAL' } })
  const changedPreview = await changed.service.createPreview(owner, 'work-1', { body: '业务字段变化阻止写入。', clientRequestId: 'changed' })
  await assert.rejects(changed.service.approve(owner, 'work-1', changedPreview.id, approval(changedPreview)), error => error.code === 'REVISION_CONFLICT')
  assert.deepEqual(changedEffects, [])
  assert.equal((await changed.store.read()).works[0].actions[0].decision.invalidationReason, 'SOURCE_FACTS_CHANGED')

  const expiredEffects = []
  const expiredPreviewService = fixture({ adapter: fakeAdapter(expiredEffects), clockFn: valueClock([now, '2026-09-21T10:10:00.000Z']) })
  const expiring = await expiredPreviewService.service.createPreview(owner, 'work-1', { body: '十分钟边界失效。', clientRequestId: 'preview-expiry' })
  const expiredPreview = await expiredPreviewService.service.approve(owner, 'work-1', expiring.id, approval(expiring))
  assert.equal(expiredPreview.decision.kind, 'expired')
  assert.deepEqual(expiredEffects, [])

  const staleDispatchEffects = []
  const staleDispatch = fixture({ adapter: fakeAdapter(staleDispatchEffects), clockFn: valueClock([now, now, '2026-09-21T10:01:31.000Z']) })
  const staleCandidate = await staleDispatch.service.createPreview(owner, 'work-1', { body: '派发时重新计算采样新鲜度。', clientRequestId: 'stale-dispatch' })
  const staleResult = await staleDispatch.service.approve(owner, 'work-1', staleCandidate.id, approval(staleCandidate))
  assert.equal(staleResult.decision.invalidationReason, 'SOURCE_FACTS_CHANGED')
  assert.deepEqual(staleDispatchEffects, [])

  const rejected = fixture({ adapter: fakeAdapter([]) })
  const rejectPreview = await rejected.service.createPreview(owner, 'work-1', { body: '拒绝不写。', clientRequestId: 'reject' })
  assert.equal((await rejected.service.reject(owner, 'work-1', rejectPreview.id, { previewDigest: rejectPreview.preview.digest })).decision.kind, 'rejected')
  await assert.rejects(rejected.service.approve(owner, 'work-1', rejectPreview.id, approval(rejectPreview)), error => error.code === 'REVISION_CONFLICT')

  const concurrentEffects = []
  const concurrent = fixture({ adapter: fakeAdapter(concurrentEffects, 5) })
  const concurrentPreview = await concurrent.service.createPreview(owner, 'work-1', { body: '并发只写一次。', clientRequestId: 'concurrent' })
  const approvals = await Promise.all([1, 2].map(() => concurrent.service.approve(owner, 'work-1', concurrentPreview.id, approval(concurrentPreview))))
  assert.equal(concurrentEffects.length, 1)
  assert.equal(approvals.some(item => item.receipt), true)

  const decisionRaceEffects = []
  const decisionRace = fixture({ adapter: fakeAdapter(decisionRaceEffects, 5) })
  const decisionPreview = await decisionRace.service.createPreview(owner, 'work-1', { body: '批准与拒绝竞争。', clientRequestId: 'decision-race' })
  const [approvedRace, rejectedRace] = await Promise.allSettled([
    decisionRace.service.approve(owner, 'work-1', decisionPreview.id, approval(decisionPreview)),
    decisionRace.service.reject(owner, 'work-1', decisionPreview.id, { previewDigest: decisionPreview.preview.digest }),
  ])
  assert.equal(approvedRace.status, 'fulfilled')
  assert.equal(rejectedRace.status, 'rejected')
  assert.equal(decisionRaceEffects.length, 1)

  let releaseClaim, dispatchStarted
  const started = new Promise(resolve => { dispatchStarted = resolve })
  const claimGate = new Promise(resolve => { releaseClaim = resolve })
  let revokeRacePosts = 0
  const revokeRace = fixture({ adapter: {
    async dispatch({ action, claimAttempt }) {
      dispatchStarted()
      await claimGate
      const claimed = await claimAttempt()
      if (!claimed.claimed) return { kind: 'not-claimed', action: claimed.action }
      revokeRacePosts += 1
      return { kind: 'receipt', upstreamRecordId: `geneway-p6-${action.id}` }
    },
    async reconcile() { throw new Error('not used') },
  } })
  const revokePreview = await revokeRace.service.createPreview(owner, 'work-1', { body: '撤销与 claim 竞争。', clientRequestId: 'revoke-race' })
  const approving = revokeRace.service.approve(owner, 'work-1', revokePreview.id, approval(revokePreview))
  await started
  const revoked = await revokeRace.service.revoke(owner, 'work-1', revokePreview.id, { previewDigest: revokePreview.preview.digest })
  releaseClaim()
  assert.equal(revoked.decision.invalidationReason, 'OWNER_REVOKED')
  assert.equal((await approving).attempt, null)
  assert.equal(revokeRacePosts, 0)

  for (const outcome of [
    { kind: 'no-effect', reason: 'SOURCE_REVISION_CONFLICT' },
    { kind: 'unknown', reason: 'UPSTREAM_TIMEOUT' },
    { kind: 'unknown', reason: 'ACTION_ID_CONFLICT' },
    { kind: 'unknown', reason: 'UPSTREAM_5XX' },
    { kind: 'unknown', reason: 'READBACK_MISMATCH' },
  ]) {
    const sample = fixture({ adapter: fakeAdapter([], 0, outcome) })
    const candidate = await sample.service.createPreview(owner, 'work-1', { body: `结果 ${outcome.reason}`, clientRequestId: outcome.reason })
    const settled = await sample.service.approve(owner, 'work-1', candidate.id, approval(candidate))
    assert.equal(outcome.kind === 'no-effect' ? settled.attempt.noEffectReason : settled.attempt.unknownReason, outcome.reason)
  }

  const unresolved = fixture({ adapter: fakeAdapter([], 0, { kind: 'unknown', reason: 'UPSTREAM_DISCONNECTED' }) })
  const unknown = await unresolved.service.createPreview(owner, 'work-1', { body: '未知结果。', clientRequestId: 'unknown' })
  await unresolved.service.approve(owner, 'work-1', unknown.id, approval(unknown))
  await assert.rejects(unresolved.service.createPreview(owner, 'work-1', { body: '换 ID 也不允许。', clientRequestId: 'bypass' }), error => error.code === 'BUSY')

  let reconcilePosts = 0, reconcileGets = 0
  const reconcileAdapter = {
    async dispatch({ claimAttempt }) { const claimed = await claimAttempt(); if (claimed.claimed) reconcilePosts += 1; return { kind: 'unknown', reason: 'UPSTREAM_DISCONNECTED' } },
    async reconcile({ action }) { reconcileGets += 1; return { kind: 'receipt', upstreamRecordId: `geneway-p6-${action.id}` } },
  }
  const reconciliation = fixture({ adapter: reconcileAdapter })
  const reconcilePreview = await reconciliation.service.createPreview(owner, 'work-1', { body: '只读核对。', clientRequestId: 'reconcile' })
  await reconciliation.service.approve(owner, 'work-1', reconcilePreview.id, approval(reconcilePreview))
  const reconciled = await reconciliation.service.reconcile(owner, 'work-1', reconcilePreview.id)
  assert.ok(reconciled.receipt)
  assert.deepEqual({ reconcilePosts, reconcileGets }, { reconcilePosts: 1, reconcileGets: 1 })

  const claimFaultEffects = []
  const claimFault = fixture({ adapter: fakeAdapter(claimFaultEffects), storeFault: 'attempt' })
  const claimFaultPreview = await claimFault.service.createPreview(owner, 'work-1', { body: 'attempt 持久化失败不写。', clientRequestId: 'claim-fault' })
  await assert.rejects(claimFault.service.approve(owner, 'work-1', claimFaultPreview.id, approval(claimFaultPreview)), /attempt persistence failed/)
  assert.deepEqual(claimFaultEffects, [])

  const receiptFaultEffects = []
  const receiptFault = fixture({ adapter: fakeAdapter(receiptFaultEffects), storeFault: 'receipt' })
  const receiptFaultPreview = await receiptFault.service.createPreview(owner, 'work-1', { body: 'receipt 持久化失败保持未知。', clientRequestId: 'receipt-fault' })
  await assert.rejects(receiptFault.service.approve(owner, 'work-1', receiptFaultPreview.id, approval(receiptFaultPreview)), /receipt persistence failed/)
  const receiptFaultAction = (await receiptFault.store.read()).works[0].actions[0]
  assert.equal(receiptFaultAction.attempt.unknownReason, 'RECEIPT_PERSIST_FAILED')
  assert.equal(receiptFaultAction.receipt, null)
  assert.deepEqual(receiptFaultEffects, ['post'])

  let dispatchRaceStore, dispatchRacePost = 0, dispatchRaceGet = 0
  const dispatchRaceAdapter = createGearJobCommentAdapter({
    clock: () => new Date(now), idFactory: uuidSequence(),
    async fetchImpl(_url, init) {
      if (init.method === 'GET') { dispatchRaceGet += 1; return response(200, {}) }
      dispatchRacePost += 1
      const request = JSON.parse(init.body)
      await dispatchRaceStore.update(state => { state.connections[0].status = 'unavailable'; return state })
      return response(201, commentResponse({ id: request.action_id, preview: { payload: { body: request.content }, expectedRevision: request.expected_revision } }, 'created'))
    },
  })
  const dispatchRace = fixture({ adapter: dispatchRaceAdapter })
  dispatchRaceStore = dispatchRace.store
  const dispatchRacePreview = await dispatchRace.service.createPreview(owner, 'work-1', { body: 'POST 后撤权禁止 GET。', clientRequestId: 'dispatch-readback-race' })
  const dispatchRaceResult = await dispatchRace.service.approve(owner, 'work-1', dispatchRacePreview.id, approval(dispatchRacePreview))
  assert.equal(dispatchRaceResult.attempt.unknownReason, 'READBACK_AUTHORIZATION_FAILED')
  assert.deepEqual({ dispatchRacePost, dispatchRaceGet }, { dispatchRacePost: 1, dispatchRaceGet: 0 })

  let reconcileRaceStore, reconcileRaceGet = 0
  const reconcileRaceAdapter = {
    async dispatch({ claimAttempt }) { const claimed = await claimAttempt(); return claimed.claimed ? { kind: 'unknown', reason: 'UPSTREAM_DISCONNECTED' } : { kind: 'not-claimed', action: claimed.action } },
    async reconcile({ connection, authorizeReadback }) {
      const prepared = gearJobReadbackConnectionSnapshot(connection)
      await reconcileRaceStore.update(state => { state.connections[0].revision += 1; return state })
      try { await authorizeReadback(prepared) } catch { return { kind: 'unknown', reason: 'READBACK_AUTHORIZATION_FAILED' } }
      reconcileRaceGet += 1
      return { kind: 'unknown', reason: 'READBACK_NOT_FOUND' }
    },
  }
  const reconcileRace = fixture({ adapter: reconcileRaceAdapter })
  reconcileRaceStore = reconcileRace.store
  const reconcileRacePreview = await reconcileRace.service.createPreview(owner, 'work-1', { body: 'reconcile 临近 GET 再复权。', clientRequestId: 'reconcile-readback-race' })
  await reconcileRace.service.approve(owner, 'work-1', reconcileRacePreview.id, approval(reconcileRacePreview))
  await reconcileRace.service.reconcile(owner, 'work-1', reconcileRacePreview.id)
  assert.equal(reconcileRaceGet, 0)

  let rotatedAction, rotatedGet = 0
  const rotatedAdapter = createGearJobCommentAdapter({
    clock: () => new Date(now), idFactory: uuidSequence(),
    async fetchImpl(_url, init) {
      if (init.method === 'POST') throw new Error('controlled disconnect')
      rotatedGet += 1
      return response(200, commentResponse(rotatedAction, 'found'))
    },
  })
  const rotated = fixture({ adapter: rotatedAdapter })
  const rotatedPreview = await rotated.service.createPreview(owner, 'work-1', { body: '凭据轮换后允许重新核对。', clientRequestId: 'rotated-reconcile' })
  rotatedAction = rotatedPreview
  assert.equal((await rotated.service.approve(owner, 'work-1', rotatedPreview.id, approval(rotatedPreview))).attempt.unknownReason, 'UPSTREAM_DISCONNECTED')
  await writeFile(join(secretRoot, 'gear-next.json'), JSON.stringify({ apiKey: 'gear-key-next', apiSecret: 'gear-secret-next', invocationSecret: 'n'.repeat(48) }), { mode: 0o600 })
  await rotated.store.update(state => {
    state.connections[0].revision += 1
    state.connections[0].credentialRef = 'gear-next.json'
    return state
  })
  rotated.connectionCatalog[0].credentialRef = 'gear-next.json'
  const rotatedReceipt = await rotated.service.reconcile(owner, 'work-1', rotatedPreview.id)
  assert.equal(rotatedGet, 1)
  assert.equal(rotatedReceipt.receipt.upstreamRecordId, `geneway-p6-${rotatedPreview.id}`)
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

function fixture({ adapter, mutate, refresh, storeFault, clockFn = () => now } = {}) {
  const state = fixtureState()
  mutate?.(state)
  const store = memoryStore(state, storeFault)
  const connectionCatalog = catalog(state)
  let authorizationCount = 0
  const service = createActionService({
    store, adapter: adapter ?? fakeAdapter([]), secretRoot, connectionCatalog, clock: clockFn,
    idFactory: uuidSequence(),
    readCorrelation: async ({ authorize }) => {
      await authorize(); authorizationCount += 1
      await authorize(); authorizationCount += 1
      await authorize(); authorizationCount += 1
      const payload = structuredClone((await store.read()).works[0].results[0].payload)
      refresh?.(payload)
      return payload
    },
  })
  return { service, store, connectionCatalog, authCount: () => authorizationCount }
}

function fakeAdapter(effects, delay = 0, outcome = null) {
  return {
    async dispatch({ action, claimAttempt }) {
      const claimed = await claimAttempt()
      if (!claimed.claimed) return { kind: 'not-claimed', action: claimed.action }
      effects.push('post')
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      return outcome ?? { kind: 'receipt', upstreamRecordId: `geneway-p6-${action.id}` }
    },
    async reconcile() { return { kind: 'unknown', reason: 'READBACK_NOT_FOUND' } },
  }
}

function fixtureState() {
  const payload = correlationPayload()
  return {
    version: 8,
    members: [
      { id: 'member-owner', role: 'member', enabled: true, sessionVersion: 1, employeeIds: ['employee-1'] },
      { id: 'member-admin', role: 'admin', enabled: true, sessionVersion: 1, employeeIds: ['employee-1'] },
    ],
    modelRoutes: [{ id: 'route-1', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-1', enabled: true, modelRouteId: 'route-1', connectionIds: ['connection-gear', 'connection-hive'], skillIds: ['skill-manufacturing-work-order-device-correlate'] }],
    connections: [gearConnection(), hiveConnection()],
    skills: [{ id: 'skill-manufacturing-work-order-device-correlate', enabled: true, capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY }],
    works: [{
      id: 'work-1', ownerMemberId: 'member-owner', employeeId: 'employee-1', skillId: 'skill-manufacturing-work-order-device-correlate', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
      connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive' }, input: { workOrderId: 'WO-26-00096' }, results: [{ id: 'result-1', kind: 'manufacturing.work-order-device-correlation', input: { workOrderId: 'WO-26-00096' }, payload }], actions: [],
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

function memoryStore(initial, fault) {
  let state = structuredClone(initial), pending = Promise.resolve()
  let faulted = false
  return {
    async read() { await pending; return structuredClone(state) },
    async update(mutator) {
      const operation = pending.then(async () => {
        const next = structuredClone(await mutator(structuredClone(state)))
        const before = state.works?.[0]?.actions?.[0], after = next.works?.[0]?.actions?.[0]
        if (!faulted && fault === 'attempt' && !before?.attempt && after?.attempt) { faulted = true; throw new Error('attempt persistence failed') }
        if (!faulted && fault === 'receipt' && !before?.receipt && after?.receipt) { faulted = true; throw new Error('receipt persistence failed') }
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
function valueClock(values) { let index = 0; return () => values[Math.min(index++, values.length - 1)] }
function uuidSequence() { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}` }
