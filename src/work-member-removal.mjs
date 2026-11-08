import { isDeepStrictEqual } from 'node:util'
import { binding, error, key } from '../packages/agent-contracts/index.mjs'

export const emptyWorkMemberRemovalState = () => ({ workMemberRemovals: [] })
export function workMemberRemoval(state, workId, employeeId) {
  const work = state.works.find(row => row.id === workId)
  return state.workMemberRemovals?.find(row => row.workspaceId === work?.workspaceId && row.workId === workId && row.employeeId === employeeId)
}
export function assertWorkMemberAccess(state, workId, employeeId) {
  if (workMemberRemoval(state, workId, employeeId)) throw error('FORBIDDEN', '本工作成员资格已撤销')
}
// Only the current grant ancestry affects execution. Historical producers do not
// confer, or revoke, another reader's independent data authority.
export function workMemberAffected(state, execution, employeeId) {
  let current = execution
  const seen = new Set()
  while (current && !seen.has(current.delegation_id)) {
    if ((!employeeId || current.agent_id === employeeId) && workMemberRemoval(state, current.work_id, current.agent_id)) return true
    seen.add(current.delegation_id)
    if (!current.parent_delegation_id) break
    const parent = state.multisite.delegations.find(row => row.id === current.parent_delegation_id && row.workId === current.work_id)
    current = state.multisite.attempts.find(row => row.attempt_id === parent?.currentAttemptId)
  }
  return false
}
export function validateWorkMemberRemovalState(state) {
  if (!Array.isArray(state.workMemberRemovals)) throw new Error('工作成员撤销事实不是数组')
  const subjects = new Set()
  for (const row of state.workMemberRemovals) {
    if (!row || Object.keys(row).sort().join(',') !== 'acceptedAt,actorId,commandId,employeeId,workId,workspaceId' || !Object.values(row).every(value => typeof value === 'string' && value.length > 0) || !Number.isFinite(Date.parse(row.acceptedAt))) throw new Error('工作成员撤销事实无效')
    const work = state.works.find(work => work.id === row.workId && work.workType === 'multisite' && work.workspaceId === row.workspaceId)
    if (!work || work.ownerMemberId !== row.actorId || !state.members.some(member => member.id === row.actorId) || !state.employees.some(employee => employee.id === row.employeeId) || !state.multisite.attempts.some(attempt => attempt.work_id === work.id && attempt.agent_id === row.employeeId)) throw new Error('工作成员撤销主体无效')
    const subject = JSON.stringify([row.workspaceId, row.workId, row.employeeId])
    if (subjects.has(subject)) throw new Error('工作成员撤销事实重复')
    subjects.add(subject)
  }
  return state
}
export function assertWorkMemberRemovalImmutable(before, after) {
  if (!isDeepStrictEqual(after.workMemberRemovals.slice(0, before.workMemberRemovals.length), before.workMemberRemovals)) throw new Error('工作成员撤销事实不可删除或修改')
}
export function workMembersProjection(state, work, actor) {
  return [...new Set(state.multisite.attempts.filter(row => row.work_id === work.id).map(row => row.agent_id))].map(employeeId => {
    const removal = workMemberRemoval(state, work.id, employeeId)
    const attempts = state.multisite.attempts.filter(row => row.work_id === work.id && (row.agent_id === employeeId || removal && workMemberAffected(state, row, employeeId)))
    const pending = !!removal && attempts.some(row => !(row.status === 'cancelled' && row.stoppedAt || row.status === 'completed' && row.settledAt))
    return { employeeId, name: state.employees.find(row => row.id === employeeId)?.name ?? employeeId, canRemove: actor?.id === work.ownerMemberId && !removal, access: removal ? 'removed' : 'active', removedAt: removal?.acceptedAt ?? null, cleanup: removal ? pending ? 'stopping' : 'stopped' : 'not_applicable', unknownEffects: attempts.some(row => state.modelRequests.some(request => request.attempt_id === row.attempt_id && request.outcome === 'unknown')), protocolGroup: 'not_applicable' }
  })
}
export function removeWorkMember(state, work, actor, employeeId, commandId, { queue, closeQuestions, at }) {
  if (actor.id !== work.ownerMemberId || !state.multisite.attempts.some(row => row.work_id === work.id && row.agent_id === employeeId)) throw error('FORBIDDEN', '只能移除本工作的实际参与员工')
  if (workMemberRemoval(state, work.id, employeeId)) return
  state.workMemberRemovals.push({ workspaceId: work.workspaceId, workId: work.id, employeeId, actorId: actor.id, commandId, acceptedAt: at })
  const affected = state.multisite.attempts.filter(row => row.work_id === work.id && workMemberAffected(state, row, employeeId)), ids = new Set(affected.map(row => row.attempt_id))
  for (const attempt of affected) {
    if (attempt.status === 'cancelled' || attempt.status === 'completed' && attempt.settledAt) continue
    if (attempt.status === 'completed') queue(state, attempt, 'settle', null, at)
    else { attempt.status = 'stopping'; queue(state, attempt, 'cancel', null, at) }
  }
  closeQuestions(state, question => question.workId === work.id && (ids.has(question.senderBinding.attempt_id) || ids.has(question.responsibleAttemptId)), 'WORK_MEMBER_REMOVED', { queue, at })
  for (const question of state.userQuestions.filter(row => row.workId === work.id && row.state === 'open' && ids.has(row.askingBinding.attempt_id))) { question.state = 'cancelled'; question.closedAt = at }
  if (ids.has(work.pendingQuestion?.responsibleAttemptId) || affected.some(row => row.delegation_id === work.pendingQuestion?.delegationId)) delete work.pendingQuestion
  for (const wait of state.multisite.dependencyWaits.filter(row => row.workId === work.id && !row.wokenAt && row.dependencyIds.some(id => affected.some(attempt => attempt.delegation_id === id)))) {
    const parent = state.multisite.attempts.find(row => row.attempt_id === wait.parentAttemptId)
    if (!parent || ids.has(parent.attempt_id) || parent.status !== 'waiting_dependency' || wait.instructionRevision !== work.instructionRevision) continue
    const id = key('dependency-unavailable', wait.id), message = { id, workId: work.id, senderBinding: binding(parent), kind: 'dependency_unavailable', targetAttemptId: parent.attempt_id, replyTo: wait.id, sourceDelegationId: parent.delegation_id, instructionRevision: wait.instructionRevision, resultRef: null, text: '依赖员工的本工作资格已撤销，原依赖结果不可用。请等待工作负责人处理，不得自行替换员工。', evidenceRefs: [], createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null }
    state.multisite.messages.push(message); wait.wokenAt = at; parent.status = 'running'
    queue(state, parent, 'wake', { id: key('message-delivery', id), revision: work.instructionRevision, text: message.text, messages: [structuredClone(message)], waitRelease: { kind: 'dependency', id: wait.id } }, at)
  }
  // This is a local loss of a required role, not cancellation of the Work.
  if (!['completed', 'cancelled', 'stopping', 'failed', 'interrupted', 'waiting_budget'].includes(work.status)) work.status = 'waiting_input'
}
