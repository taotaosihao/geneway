import { binding, error, key, sameBinding } from '../agent-contracts/index.mjs'
import { committedBudget } from '../../src/work-budget.mjs'
import { authorizeBudgetControlCommand, authorizeBudgetControlReceipt } from '../../src/multisite-authorization.mjs'

export function queueBudgetWait(state, attempt, hold, queue, at) {
  queue(state, attempt, 'budget_wait', { id: hold.id, revision: hold.instructionRevision, text: '预算不足，等待管理员调整。', budgetHold: { id: hold.id, requestId: hold.requestId, bodyDigest: hold.bodyDigest, budgetRevision: hold.budgetRevision } }, at)
}
export function queueBudgetResumes(state, queue, at, { workId } = {}) {
  for (const hold of state.budgetHolds.filter(row => (!workId || row.work_id === workId) && ['waiting', 'resume_queued'].includes(row.state) && row.idleAt)) {
    const work = state.works.find(row => row.id === hold.work_id), attempt = state.multisite.attempts.find(row => row.attempt_id === hold.attempt_id), budget = work.modelRequestBudget
    if (['cancelled', 'stopping', 'completed', 'failed', 'interrupted'].includes(work.status) || ['unknown', 'completed', 'cancelled', 'stopping'].includes(attempt.status) || Date.parse(at) >= Date.parse(budget.executionDeadlineAt) || state.modelRequests.some(row => row.work_id === work.id && row.outcome === 'unknown')) continue
    if (hold.state === 'resume_queued' && hold.instructionRevision === work.instructionRevision) continue
    if (hold.state === 'resume_queued' && (hold.resumeRequestId || state.modelRequests.some(row => row.resumedFromHoldId === hold.id))) continue
    const adjustment = state.budgetAdjustments.findLast(row => row.workId === work.id && row.budgetRevision > hold.budgetRevision)
    if (!adjustment || budget.overReservationBudgetRevision !== null && budget.budgetRevision <= budget.overReservationBudgetRevision) continue
    const used = committedBudget(state, work)
    if (used.requests >= budget.limits.maxModelRequests || used.tokens >= BigInt(budget.limits.maxReservedTokens) || used.costMicros >= BigInt(budget.limits.maxReservedCostMicros)) continue
    // A busy user revision keeps its original durable delivery. It never retries the old body.
    if (hold.instructionRevision !== work.instructionRevision) {
      if (hold.resumeCommandId) { const command = state.multisite.outbox.find(row => row.id === hold.resumeCommandId)?.command; try { authorizeBudgetControlReceipt(state, command) } catch { continue } }
      hold.state = 'cancelled'; hold.cancelledAt = at; hold.cancelledReason = 'SUPERSEDED_BY_INPUT'; hold.resumeAdjustmentId ??= adjustment.id
      attempt.status = 'running'
      continue
    }
    hold.state = 'resume_queued'; hold.resumeAdjustmentId = adjustment.id; hold.resumeBudgetRevision = budget.budgetRevision; hold.resumeMessageId = key('budget-resume-message', hold.id, adjustment.id)
    const message = { id: hold.resumeMessageId, workId: work.id, senderBinding: binding(attempt), kind: 'budget_resume', targetAttemptId: attempt.attempt_id, replyTo: hold.id, sourceDelegationId: attempt.delegation_id, instructionRevision: work.instructionRevision, resultRef: null, createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null, text: '管理员已调整本工作预算，按原上下文继续；之前被拒请求未转发。', evidenceRefs: [] }
    state.multisite.messages.push(message)
    const input = { id: key('budget-resume-delivery', message.id), revision: work.instructionRevision, text: message.text, messages: [message], waitRelease: { kind: 'budget', id: hold.id } }
    queue(state, attempt, 'wake', input, at)
    hold.resumeCommandId = key('wake', attempt.attempt_id, input.id)
  }
  for (const work of state.works.filter(row => (!workId || row.id === workId) && row.status === 'waiting_budget')) {
    const holds = state.budgetHolds.filter(row => row.work_id === work.id), budget = work.modelRequestBudget
    const resolvedExcess = budget.overReservationBudgetRevision !== null && budget.budgetRevision > budget.overReservationBudgetRevision
    if (!holds.some(row => row.state === 'waiting') && (resolvedExcess || holds.some(row => ['resume_queued', 'resumed', 'cancelled'].includes(row.state)))) work.status = 'running'
  }
}
export function budgetIdleEvent(state, event, at) {
  const hold = state.budgetHolds.find(row => row.id === event.budget_hold_id), command = state.multisite.outbox.find(row => row.id === event.source_command_id)?.command
  if (!hold || !command || !sameBinding(event, command) || !sameBinding(event, hold) || event.workspace_id !== command.workspace_id || command.operation !== 'budget_wait' || command.parameters.budgetHold.id !== hold.id || event.idle_evidence !== 'idle_and_flushed' || event.instruction_revision !== hold.instructionRevision || event.input_id !== hold.id) throw error('FORBIDDEN')
  authorizeBudgetControlCommand(state, command)
  hold.idleAt ??= at
}
