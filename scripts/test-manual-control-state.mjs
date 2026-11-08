import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { authorizeMultisiteExecution } from '../src/multisite-authorization.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  emptyManualControlState, manualScope, applyManualControl, manualFence,
  assertManualExecution, currentManualControl, manualCommandProof,
  manualControlsProjection, validateManualControlState, assertManualControlImmutable,
  manualWakeQualification, assertManualConsumption, currentManualCommand,
} from '../src/manual-control.mjs'

const at = '2026-11-06T03:00:00.000Z'
const workScope = { kind: 'work' }
const agentScope = { kind: 'agent', agentId: 'agent-a' }
function fixture() {
  const work = { id: 'work-a', workspaceId: 'workspace-a', ownerMemberId: 'owner', status: 'active' }
  const actor = { id: 'owner', employeeIds: ['agent-a', 'agent-b'] }
  const attempts = [['work-a', 'agent-a'], ['work-a', 'agent-b'], ['work-b', 'agent-a']].map(([workId, agentId], index) => ({
    work_id: workId, agent_id: agentId, delegation_id: `delegation-${index}`, parent_delegation_id: null,
    attempt_id: `attempt-${index}`, execution_epoch: 1, node_id: 'node-a', launch_id: `launch-${index}`,
    session_id: `session-${index}`, status: 'running', instruction_revision: 1, observed_revision: 1,
    resource_refs: [], employeeRevision: 1,
  }))
  const state = { ...emptyManualControlState(), works: [work], members: [actor], multisite: {
    attempts, outbox: [], delegations: attempts.map(a => ({ id: a.delegation_id, currentAttemptId: a.attempt_id })),
  } }
  const apply = (operation, scope = workScope, generation = currentManualControl(state, work.id, scope)?.generation ?? 0) =>
    applyManualControl(state, work, actor, operation, { scope, expectedControlGeneration: generation }, at)
  return { state, work, actor, attempts, apply }
}
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)

test('重叠Work与Agent暂停分别解除；同Agent其它Work保持独立', () => {
  for (const first of [workScope, agentScope]) {
    const { state, attempts: [a, b, otherWork], apply } = fixture()
    const second = first.kind === 'work' ? agentScope : workScope
    apply('pause', first); apply('pause', second); apply('resume', first)
    rejects(() => assertManualExecution(state, a), 'MANUALLY_PAUSED')
    assertManualExecution(state, otherWork)
    if (second.kind === 'work') rejects(() => assertManualExecution(state, b), 'MANUALLY_PAUSED')
    else rejects(() => assertManualExecution(state, b), 'MANUAL_RELEASE_PENDING')
    apply('resume', second)
    rejects(() => assertManualExecution(state, a), 'MANUAL_RELEASE_PENDING')
    assert.equal(currentManualControl(state, 'work-a', workScope).action, 'resume')
    assert.equal(currentManualControl(state, 'work-a', agentScope).action, 'resume')
    validateManualControlState(state)
  }
})

test('暂停/释放后的generation单调；暂停前token及旧release不能作用于新代', () => {
  const { state, attempts: [a], apply } = fixture()
  const initial = manualFence(state, a)
  apply('pause'); apply('resume')
  const released = manualFence(state, a)
  assert.equal(released.workGeneration, 2)
  rejects(() => assertManualExecution(state, a, initial), 'REVISION_CONFLICT')
  apply('pause')
  const before = structuredClone(state)
  rejects(() => apply('resume', workScope, 1), 'REVISION_CONFLICT')
  rejects(() => apply('resume', workScope, 2), 'REVISION_CONFLICT')
  rejects(() => assertManualExecution(state, a, released), 'REVISION_CONFLICT')
  assert.deepEqual(state, before)
  assert.equal(currentManualControl(state, 'work-a', workScope).generation, 3)
})

test('用户release独立于安全证明和可唤醒；不会写入假idle或假resume消费', () => {
  const { state, work, actor, apply } = fixture()
  apply('pause')
  const accepted = apply('resume')
  assert.equal(accepted.released, true)
  assert.equal(accepted.canWake, false)
  const projection = manualControlsProjection(state, work, actor).find(row => row.scope.kind === 'work')
  assert.equal(projection.stage, 'released')
  assert.equal(projection.canWake, false)
  assert.ok(projection.holders.every(holder => !holder.idleConfirmed && !holder.resumeConsumed))
  assert.ok(state.manualControls[0].holders.every(holder => holder.idleAt === null))
})

test('旧控制可供精确历史核验，但不能改变新代；篡改binding或generation被拒', () => {
  const { state, attempts: [a], apply } = fixture()
  apply('pause')
  const command = structuredClone(state.multisite.outbox[0].command)
  apply('resume'); apply('pause')
  const before = structuredClone(state)
  assert.equal(manualCommandProof(state, command).control.generation, 1)
  rejects(() => manualCommandProof(state, { ...command, session_id: 'other-session' }), 'FORBIDDEN')
  const changed = structuredClone(command); changed.parameters.manualControl.generation = 3
  rejects(() => manualCommandProof(state, changed), 'FORBIDDEN')
  assert.deepEqual(state, before)
  rejects(() => assertManualExecution(state, a), 'MANUALLY_PAUSED')
})

test('非法scope、重复transition、旧代及终态拒绝且保持事实不变', () => {
  for (const scope of [{ kind: 'global' }, { kind: 'work', agentId: 'agent-a' }, { kind: 'agent' }, { kind: 'agent', agentId: 'agent-a', extra: true }]) rejects(() => manualScope(scope), 'INVALID_REQUEST')
  const { state, work, apply } = fixture()
  rejects(() => apply('resume'), 'INVALID_STATE')
  apply('pause')
  const before = structuredClone(state)
  rejects(() => apply('pause'), 'INVALID_STATE')
  rejects(() => apply('resume', workScope, -1), 'INVALID_REQUEST')
  rejects(() => apply('pause', { kind: 'agent', agentId: 'not-owned' }), 'FORBIDDEN')
  assert.deepEqual(state, before)
  work.status = 'completed'
  rejects(() => apply('resume'), 'INVALID_STATE')
})

test('支持的resume入口缺失scope时拒绝且不能解除现有pause', () => {
  const { state, work, actor, apply } = fixture()
  apply('pause')
  const before = structuredClone(state)
  rejects(() => applyManualControl(state, work, actor, 'resume', { expectedControlGeneration: 1 }, at), 'INVALID_REQUEST')
  assert.deepEqual(state, before)
})

// operation由公开路由和applyTransition静态限定为pause/resume。
// 初轮unknown operation直接内部调用观察为TypeError，保存在外Git初轮日志；
// 未支持的直接调用不作为公开拒绝合同，也不据此要求产品增加防御分支。

test('历史控制身份、原holder绑定与已记录证明不可重写或删除', () => {
  const { state, apply } = fixture()
  apply('pause')
  // 负向不可变性夹具；这里不声称生成了官方idle/flush事实。
  state.manualControls[0].holders[0].idleAt = at
  state.manualControls[0].holders[0].idleEvidence = { source: 'negative-test-only' }
  const before = structuredClone(state)
  apply('resume')
  assertManualControlImmutable(before, state)
  for (const mutate of [
    s => { s.manualControls = s.manualControls.slice(1) },
    s => { s.manualControls[0].actorId = 'other-owner' },
    s => { s.manualControls[0].holders[0].binding.session_id = 'replacement' },
    s => { s.manualControls[0].holders[0].idleAt = null },
    s => { s.manualControls[0].holders[0].idleEvidence.source = 'rewritten' },
  ]) {
    const changed = structuredClone(state); mutate(changed)
    rejects(() => assertManualControlImmutable(before, changed), 'INVALID_STATE')
  }
})

// 可选读取主writer既有生产路径快照；这只是离线consumer复核，不是新HTTP/Host/native运行。
const evidenceRoot = process.env.GENEWAY_MANUAL_STATE_EVIDENCE_ROOT
if (evidenceRoot) {
  const load = async relative => JSON.parse(await readFile(join(evidenceRoot, relative), 'utf8'))
  test('既有HTTP/Hostsim release快照：实际consume前拒绝，已consume后才解除消费门', async () => {
    const before = await load('manual-control-integration-9pGGMi/release-before-consume.json')
    const after = await load('manual-control-integration-9pGGMi/released.json')
    const released = before.manualControls.find(row => row.action === 'resume')
    assert.ok(released.holders.length)
    for (const holder of released.holders) {
      assert.ok(holder.releasedAt)
      assert.equal(holder.resumeConsumedAt, null)
      rejects(() => assertManualConsumption(before, holder.binding), 'MANUAL_RESUME_PENDING')
      assertManualConsumption(after, holder.binding)
    }
  })
  test('既有native快照：已release/consume不绕过新Agent pause或当前授权', async () => {
    const state = await load('manual-control-native-2RvRxX/after-resume.json')
    const released = state.manualControls.findLast(row => row.action === 'resume')
    const execution = released.holders[0].binding
    assert.ok(released.holders[0].resumeConsumedAt)
    assertManualConsumption(state, execution)
    const work = state.works.find(row => row.id === execution.work_id)
    const actor = state.members.find(row => row.id === work.ownerMemberId)
    const unchecked = manualWakeQualification(state, execution)
    assert.equal(unchecked.canWake, false)
    assert.ok(unchecked.blockedReasons.includes('CURRENT_AUTHORITY_UNCHECKED'))
    // 只在离线负向视图请求新pause，不生成任何idle/flush/consume正事实。
    const scope = { kind: 'agent', agentId: execution.agent_id }
    applyManualControl(state, work, actor, 'pause', { scope, expectedControlGeneration: currentManualControl(state, work.id, scope)?.generation ?? 0 }, at)
    const qualification = manualWakeQualification(state, execution, authorizeMultisiteExecution)
    assert.equal(qualification.canWake, false)
    assert.ok(qualification.blockedReasons.includes('MANUALLY_PAUSED'))
    const projection = manualControlsProjection(state, work, actor, authorizeMultisiteExecution).find(row => row.scope.kind === 'work')
    assert.equal(projection.released, true)
    assert.equal(projection.canWake, false)
    assert.ok(projection.blockedReasons.includes('MANUALLY_PAUSED'))
  })
  test('既有native快照：同scope新pause代拒绝旧控制proof而保历史事实', async () => {
    const state = await load('manual-control-native-2RvRxX/after-resume.json')
    const released = state.manualControls.findLast(row => row.action === 'resume')
    const oldPause = state.manualControls.find(row => row.id === released.pauseId)
    const command = state.multisite.outbox.find(row => row.id === oldPause.holders[0].commandId).command
    const before = structuredClone(state)
    const work = state.works.find(row => row.id === released.workId)
    const actor = state.members.find(row => row.id === work.ownerMemberId)
    applyManualControl(state, work, actor, 'pause', { scope: released.scope, expectedControlGeneration: released.generation }, at)
    rejects(() => currentManualCommand(state, command), 'REVISION_CONFLICT')
    assertManualControlImmutable(before, state)
  })
}
