import assert from 'node:assert/strict'
import { open as fsOpen, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService, recoverActionFacts } from '../src/work-service.mjs'
import { prepareRestoredState } from './state-transfer.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p6-state-'))
const recoveredAt = '2026-09-21T08:00:00.000Z'

try {
  migrationAndValidationChecks()
  await immutableChecks()
  await authorizationCommitChecks()
  await durableCommitChecks()
  await recoveryChecks()
  console.log(`P6 state/store checks passed; state=v${STATE_VERSION}; durable faults=5; recovery replay/dispatch=0`)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function authorizationCommitChecks() {
  const path = join(root, 'authorization.json')
  const store = createFileStore(path)
  const state = actionState([
    { ...action('pending'), decision: decision('approved') },
    { ...action('unknown'), decision: decision('approved'), attempt: { ...attempt(), unknownAt: recoveredAt, unknownReason: 'RECOVERY_UNKNOWN' } },
  ])
  state.members = [
    { id: 'member-admin', loginName: 'admin', displayName: '管理员', authRef: 'member-admin', role: 'admin', enabled: true, sessionVersion: 1, employeeIds: [] },
    { id: 'member-owner', loginName: 'owner', displayName: '成员', authRef: 'member-owner', role: 'member', enabled: true, sessionVersion: 1, employeeIds: ['employee-1'] },
  ]
  state.employees = [{ id: 'employee-1' }]
  await store.update(() => state)
  const before = await readFile(path, 'utf8')
  const failed = createWorkService({ store: createFileStore(path, faultOps('rename')) })
  await assert.rejects(failed.updateMember({ id: 'member-admin' }, 'member-owner', { expectedEmployeeIds: ['employee-1'], employeeIds: [] }), /rename/)
  assert.equal(await readFile(path, 'utf8'), before)
  const service = createWorkService({ store, clock: () => recoveredAt })
  await service.updateMember({ id: 'member-admin' }, 'member-owner', { expectedEmployeeIds: ['employee-1'], employeeIds: [] })
  await service.updateMember({ id: 'member-admin' }, 'member-owner', { expectedEmployeeIds: [], employeeIds: ['employee-1'] })
  const reopened = await createFileStore(path).read()
  assert.equal(reopened.members[1].sessionVersion, 1)
  assert.equal(reopened.works[0].actions[0].decision.invalidationReason, 'OWNER_REVOKED')
  assert.deepEqual(reopened.works[0].actions[1], state.works[0].actions[1])
}

function migrationAndValidationChecks() {
  const migrated = migrateState(v7State())
  assert.equal(STATE_VERSION, 10)
  assert.equal(migrated.version, STATE_VERSION)
  assert.deepEqual(migrated.works[0].actions, [])
  assert.throws(() => migrateState({ ...migrated, version: STATE_VERSION + 1 }), /未来/)

  const valid = actionState(action())
  assert.deepEqual(migrateState(structuredClone(valid)), valid)
  const invalid = [
    [value => { value.preview.extra = true }, /未声明字段/],
    [value => { value.preview.digest = 'bad' }, /digest/],
    [value => { delete value.intent }, /intent/],
    [value => { value.decision = decision('rejected'); value.attempt = attempt() }, /attempt 与批准不闭合|不得有 attempt/],
    [value => { value.receipt = receipt() }, /未回链 attempt/],
    [value => { value.decision = { ...decision('approved'), memberId: 'member-other' } }, /不是工作 owner/],
    [value => { value.decision = decision('approved'); value.attempt = { ...attempt(), unknownAt: recoveredAt } }, /unknown 不闭合/],
    [value => { value.decision = decision('approved'); value.attempt = { ...attempt(), unknownAt: recoveredAt, unknownReason: 'RECOVERY_UNKNOWN', noEffectAt: recoveredAt, noEffectReason: 'DISPATCH_DEADLINE_EXPIRED' } }, /互斥/],
    [value => { value.decision = decision('approved'); value.attempt = { ...attempt(), noEffectAt: recoveredAt, noEffectReason: 'NOT_ALLOWED' } }, /noEffectReason/],
    [value => { value.decision = decision('approved'); value.attempt = { ...attempt(), noEffectAt: recoveredAt, noEffectReason: 'DISPATCH_DEADLINE_EXPIRED' }; value.receipt = receipt() }, /receipt 与 noEffect/],
  ]
  for (const [mutate, pattern] of invalid) {
    const candidate = action()
    mutate(candidate)
    assert.throws(() => actionState(candidate), pattern)
  }
  assert.throws(() => actionState([action('duplicate-a'), { ...action('duplicate-b'), proposalKey: 'proposal-duplicate-a' }]), /proposalKey 重复/)
  assert.throws(() => actionState([action('duplicate-a'), { ...action('duplicate-b'), requestKeys: ['request-duplicate-a'] }]), /requestKey 重复/)
}

async function immutableChecks() {
  const path = join(root, 'immutable.json')
  const store = createFileStore(path)
  await store.update(() => actionState({ ...action(), decision: decision('approved'), attempt: attempt() }))
  for (const [mutate, pattern] of [
    [value => { value.works[0].actions[0].preview.payload.body = 'changed' }, /preview 不可改写/],
    [value => { value.works[0].actions[0].requestKeys = ['request-changed'] }, /requestKeys 不可改写/],
    [value => { value.works[0].actions[0].proposalKey = 'proposal-changed' }, /proposalKey 不可改写/],
    [value => { value.works[0].actions[0].intent.targetKey = 'gearjob:changed' }, /intent 不可改写/],
    [value => { value.works[0].actions[0].decision.memberId = 'member-other' }, /decision memberId|approved decision/],
    [value => { value.works[0].actions[0].decision = null }, /attempt 与批准不闭合|approved decision 不可删除/],
    [value => { value.works[0].actions[0].attempt.preparedAt = recoveredAt }, /attempt 不可改写/],
    [value => { value.works[0].actions = [] }, /preview 不可改写/],
  ]) {
    await assert.rejects(store.update(state => { mutate(state); return state }), pattern)
  }
  await store.update(state => {
    state.works[0].actions[0].attempt.unknownAt = recoveredAt
    state.works[0].actions[0].attempt.unknownReason = 'RECOVERY_UNKNOWN'
    return state
  })
  await store.update(state => {
    state.works[0].actions[0].requestKeys.push('request-alias')
    return state
  })
  await assert.rejects(store.update(state => {
    state.works[0].actions[0].requestKeys.reverse()
    return state
  }), /requestKeys 不可改写/)

  const noEffectPath = join(root, 'immutable-no-effect.json')
  const noEffectStore = createFileStore(noEffectPath)
  await noEffectStore.update(() => actionState({ ...action(), decision: decision('approved'), attempt: attempt() }))
  await noEffectStore.update(state => {
    state.works[0].actions[0].attempt.noEffectAt = recoveredAt
    state.works[0].actions[0].attempt.noEffectReason = 'DISPATCH_DEADLINE_EXPIRED'
    return state
  })
  await assert.rejects(noEffectStore.update(state => {
    state.works[0].actions[0].attempt.noEffectReason = 'SOURCE_REVISION_CONFLICT'
    return state
  }), /attempt 不可改写/)

  const rejectedPath = join(root, 'immutable-rejected.json')
  const rejectedStore = createFileStore(rejectedPath)
  await rejectedStore.update(() => actionState({ ...action(), decision: decision('rejected') }))
  await assert.rejects(rejectedStore.update(state => {
    state.works[0].actions[0].decision = decision('approved')
    return state
  }), /decision 不可改写/)
  await assert.rejects(rejectedStore.update(state => {
    state.works[0].actions[0].decision = null
    return state
  }), /decision 不可删除/)
}

async function durableCommitChecks() {
  const path = join(root, 'durable', 'state.json')
  const seed = createFileStore(path)
  await seed.update(state => ({ ...state, reservations: { seed: true } }))
  const original = await readFile(path, 'utf8')

  for (const stage of ['write', 'fileSync', 'rename']) {
    const store = createFileStore(path, faultOps(stage))
    await assert.rejects(store.update(state => ({ ...state, reservations: { stage } })), new RegExp(stage))
    assert.equal(await readFile(path, 'utf8'), original)
    assert.equal((await readdir(dirname(path))).some(name => name.endsWith('.tmp')), false)
  }

  await assert.rejects(createFileStore(path).update(state => ({ ...state, reservations: { stage: 'beforeCommit' } }), {
    beforeCommit() { throw new Error('beforeCommit') },
  }), /beforeCommit/)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await readdir(dirname(path))).some(name => name.endsWith('.tmp')), false)

  const ordered = []
  const orderedStore = createFileStore(path, tracingOps(ordered))
  await orderedStore.update(state => ({ ...state, reservations: { ordered: true } }), { beforeCommit() { ordered.push('beforeCommit') } })
  assert.deepEqual(ordered, ['write', 'fileSync', 'beforeCommit', 'rename', 'dirSync'])

  const dirStore = createFileStore(path, faultOps('dirSync'))
  await assert.rejects(dirStore.update(state => ({ ...state, reservations: { dirSync: true } })), /dirSync/)
  assert.equal(migrateState(JSON.parse(await readFile(path, 'utf8'))).reservations.dirSync, true)

  const pendingPath = join(root, 'pending.json')
  const pendingStore = createFileStore(pendingPath)
  await assert.rejects(pendingStore.update(state => state, { beforeCommit() { throw new Error('first failed') } }), /first failed/)
  await pendingStore.update(state => ({ ...state, reservations: { recovered: true } }))
  assert.equal((await pendingStore.read()).reservations.recovered, true)
}

async function recoveryChecks() {
  const state = recoveryState()
  const direct = recoverActionFacts(state, recoveredAt)
  assert.equal(direct.works[0].actions[0].decision.invalidationReason, 'RECOVERY_INVALIDATED')
  assert.equal(direct.works[0].actions[1].attempt.unknownReason, 'RECOVERY_UNKNOWN')
  assert.deepEqual(direct.works[0].actions[2], state.works[0].actions[2])
  assert.deepEqual(direct.works[0].actions[3], state.works[0].actions[3])
  assert.deepEqual(direct.works[0].actions[4], state.works[0].actions[4])
  assert.deepEqual(recoverActionFacts(direct, '2026-09-21T09:00:00.000Z'), direct)
  assert.deepEqual(prepareRestoredState(state, recoveredAt), migrateState(direct))

  const path = join(root, 'restart.json')
  const store = createFileStore(path)
  await store.update(() => state)
  let dispatches = 0
  const service = createWorkService({
    store,
    clock: () => recoveredAt,
    runner: { configured: true, async run() { dispatches += 1 }, async close() {} },
  })
  await service.ensureReady()
  assert.deepEqual(await store.read(), migrateState(direct))
  assert.equal(dispatches, 0)
  await service.ensureReady()
  assert.equal(dispatches, 0)
  await service.close()
}

function faultOps(stage) {
  return {
    async open(path, flags, mode) {
      const handle = await fsOpen(path, flags, mode)
      const directory = flags === 'r'
      return {
        async writeFile(value) {
          if (stage === 'write') throw new Error('write')
          return handle.writeFile(value)
        },
        async sync() {
          if (stage === 'fileSync' && !directory) throw new Error('fileSync')
          if (stage === 'dirSync' && directory) throw new Error('dirSync')
          return handle.sync()
        },
        async close() { return handle.close() },
      }
    },
    ...(stage === 'rename' ? { async rename() { throw new Error('rename') } } : {}),
  }
}

function tracingOps(events) {
  return {
    async open(path, flags, mode) {
      const handle = await fsOpen(path, flags, mode)
      const directory = flags === 'r'
      return {
        async writeFile(value) { events.push('write'); return handle.writeFile(value) },
        async sync() { events.push(directory ? 'dirSync' : 'fileSync'); return handle.sync() },
        async close() { return handle.close() },
      }
    },
    async rename(from, to) {
      events.push('rename')
      const { rename } = await import('node:fs/promises')
      return rename(from, to)
    },
  }
}

function recoveryState() {
  return actionState([
    { ...action('approval'), decision: decision('approved') },
    { ...action('attempt'), decision: decision('approved'), attempt: attempt() },
    { ...action('receipt'), decision: decision('approved'), attempt: attempt(), receipt: receipt() },
    { ...action('unknown'), decision: decision('approved'), attempt: { ...attempt(), unknownAt: '2026-09-21T07:00:00.000Z', unknownReason: 'ALREADY_UNKNOWN' } },
    { ...action('no-effect'), decision: decision('approved'), attempt: { ...attempt(), noEffectAt: '2026-09-21T07:00:00.000Z', noEffectReason: 'DISPATCH_DEADLINE_EXPIRED' } },
  ])
}

function actionState(actions) {
  const state = migrateState(v7State())
  state.works[0].actions = Array.isArray(actions) ? actions : [actions]
  return migrateState(state)
}

function action(suffix = 'one') {
  const digest = currentDigest()
  return {
    id: `action-${suffix}`,
    requestKeys: [`request-${suffix}`],
    proposalKey: `proposal-${suffix}`,
    intent: { kind: 'gearjob.work-order.comment', targetKey: 'gearjob:external-test:Work Order:WO-26-00096' },
    preview: {
      digest, resultId: 'result-1', target: { system: 'gearjob', workOrderId: 'WO-26-00096' },
      payload: { body: 'synthetic follow-up' }, expectedRevision: '2026-09-21 07:00:00.000000',
      createdAt: '2026-09-21T07:00:00.000Z', expiresAt: '2026-09-21T07:10:00.000Z',
    },
    decision: null,
    attempt: null,
    receipt: null,
  }
}

function decision(kind) {
  return { kind, memberId: 'member-owner', previewDigest: currentDigest(), decidedAt: '2026-09-21T07:01:00.000Z' }
}

function attempt() {
  return { previewDigest: currentDigest(), preparedAt: '2026-09-21T07:01:01.000Z' }
}

function receipt() {
  return { previewDigest: currentDigest(), upstreamRecordId: 'comment-1', recordedAt: '2026-09-21T07:01:02.000Z' }
}

function currentDigest() {
  return 'a'.repeat(64)
}

function v7State() {
  return {
    version: 7,
    members: [], modelRoutes: [], employees: [], connections: [], skills: [], confirmations: [], knowledgeMaterials: [],
    channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [],
    automationRules: [], automationOccurrences: [], reservations: {},
    works: [{
      id: 'work-1', ownerMemberId: 'member-owner', employeeId: 'employee-1', skillId: 'skill-1', capabilityId: 'capability-1',
      status: 'completed', acceptedAt: '2026-09-21T07:00:00.000Z',
      results: [{
        id: 'result-1', kind: 'assistant.follow-up', capabilityId: 'capability-1', skillId: 'skill-1', schemaVersion: 1,
        input: { text: 'x' }, payload: { text: 'x' }, createdAt: '2026-09-21T07:00:00.000Z', dshSessionRef: 'session-1', contextConfirmationRefs: [],
      }],
      executions: [{ id: 'execution-1', status: 'completed', resultId: 'result-1' }],
    }],
  }
}
