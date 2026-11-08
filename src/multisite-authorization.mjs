import { assertCurrentSiteRule } from './site-rule-state.mjs'
import { workMemberAffected } from './work-member-removal.mjs'
import { assertManualExecution, assertManualConsumption, currentManualCommand } from './manual-control.mjs'
import { assertWorkBudget, budgetControlProof, budgetReceiptProof } from './work-budget.mjs'
import { questionClosure } from '../packages/agent-contracts/conversation.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertNodeExecution } from '../packages/agent-contracts/nodes.mjs'
import { assertDelegationAuthority } from '../packages/agent-orchestration/dependencies.mjs'
import { assertModelRoute } from './model-route.mjs'
import { error, sameBinding, attachmentRefs, binding, assertSealed, key } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

export function authorizeMultisiteExecution(state, execution, options) { return executionAuthority(state, execution, options) }
// A paused budget is not a revocation. This lifecycle check never authorizes execution.
export function authorizeQuestionParticipant(state, execution) { return executionAuthority(state, execution, {}, false, false, false, false, true) }
// Subscription history distinguishes loss of authority from an execution ending. It cannot authorize a turn.
export function authorizeContextSubscription(state, execution) { return executionAuthority(state, execution, { allowCompleted: true }, false, false, false, false, true, false, true) }
// Completed producers retain data provenance, never permission to execute another turn.
export function authorizeSpreadsheetSource(state, execution) { return executionAuthority(state, execution, { allowCompleted: true }, false, false, false, false, false, true) }
// Only the Evidence service's exact pre-admitted declaration path calls this gate.
export function authorizeSealedEvidenceTransport(state, execution) { return executionAuthority(state, execution, {}, true) }
function executionAuthority(state, execution, { nodeId = execution.node_id, workspaceId = 'local', inputMessageId, allowCompleted = false } = {}, sealedTransport = false, closureControl = false, budgetControl = false, readyData = false, questionLifecycle = false, sourceData = false, subscriptionLifecycle = false) {
  const current = state.multisite.attempts.find(item => item.attempt_id === execution.attempt_id)
  const delegation = state.multisite.delegations.find(item => item.id === execution.delegation_id)
  const work = state.works.find(item => item.id === execution.work_id), owner = state.members.find(item => item.id === work?.ownerMemberId && item.enabled)
  const coordinator = state.employees.find(item => item.id === work?.employeeId && item.enabled)
  const employee = state.employees.find(item => item.id === execution.agent_id && item.enabled)
  if (!current || delegation?.currentAttemptId !== current.attempt_id || !sameBinding(current, execution, { firstSession: current.session_id === null })
    || current.node_id !== nodeId || work.workspaceId !== workspaceId || !subscriptionLifecycle && ['stopping', 'cancelled'].includes(current.status) || !sealedTransport && !questionLifecycle && current.status === 'unknown'
    || !subscriptionLifecycle && ['stopping', 'cancelled'].includes(work.status) || !sealedTransport && !closureControl && !questionLifecycle && work.status === 'interrupted' || sealedTransport && (work.status === 'failed' || work.modelRequestBudget.exhaustedAt) || !allowCompleted && (current.status === 'completed' || work.status === 'completed')
    || !coordinator || !owner?.employeeIds.includes(coordinator.id) || (coordinator.revision ?? 1) !== work.coordinatorRevision
    || !owner?.employeeIds.includes(employee?.id) || employee.revision !== current.employeeRevision || employee.placement?.nodeId !== nodeId) throw error('FORBIDDEN')
  if (workMemberAffected(state, current)) throw error('FORBIDDEN', '本工作成员资格或当前委派链已撤销')
  if (!closureControl && !budgetControl && !readyData && !questionLifecycle && !sourceData && !subscriptionLifecycle) assertCurrentSiteRule(state, work, current)
  assertNodeExecution(state, current, execution)
  assertDelegationAuthority(state, current, { sealedTransport, questionLifecycle, sourceData: sourceData || readyData, replay: subscriptionLifecycle })
  assertModelRoute(state, employee, current.modelSnapshot)
  if (!closureControl && !budgetControl && !readyData && !questionLifecycle && !sourceData) assertManualExecution(state, current)
  if (!closureControl && !budgetControl && !readyData && !questionLifecycle && current.status === 'waiting_budget') throw error('WAITING_BUDGET', '本执行仍等待安全预算续行')
  if (!closureControl && !budgetControl && !readyData && !questionLifecycle) assertWorkBudget(state, work)
  const inputs = state.multisite.inputs.filter(input => input.workId === work.id && input.deliveries.some(delivery => delivery.attemptId === current.attempt_id))
  if (inputMessageId !== undefined) {
    const awaitingResume = state.budgetHolds.find(row => row.attempt_id === current.attempt_id && row.state === 'resume_queued')
    if (awaitingResume) {
      const source = state.multisite.outbox.find(row => row.id === awaitingResume.resumeCommandId)?.command
      if (!source || inputMessageId !== messageId(source.input_id, current.attempt_id, execution.session_id)) throw error('REVISION_CONFLICT', '首次续行必须消费精确预算恢复消息')
    }
  }
  if (inputMessageId !== undefined && !hasConsumedExecutionMessage(state, execution, inputMessageId)) throw error('REVISION_CONFLICT', '模型请求尚未消费当前输入')
  if (inputMessageId !== undefined && !closureControl && !budgetControl && !questionLifecycle && !readyData && !sourceData) assertManualConsumption(state, current)
  const refs = [...new Map(inputs.flatMap(input => attachmentRefs(input.attachmentRefs)).map(ref => [ref.attachmentId, ref])).values()]
  for (const ref of refs) {
    const row = state.attachments.find(item => item.id === ref.attachmentId)
    if (!row || row.workId !== work.id || row.workspaceId !== workspaceId || row.ownerMemberId !== owner.id || row.status !== 'ready' || row.version !== ref.version || row.sha256 !== ref.sha256) throw error('FORBIDDEN', '历史附件授权已失效')
  }
  return { current, work, owner, refs }
}

// Only a server-committed terminal-question notification can use this delivery gate.
// It never grants model/tool authorization and does not admit an unknown Attempt.
export function authorizeQuestionClosureCommand(state, command) {
  questionClosure(command)
  const original = state.multisite.outbox.find(row => row.id === command.command_id)?.command
  const messages = command.parameters.messages, release = command.parameters.waitRelease
  if (!original || !isDeepStrictEqual(original, command) || command.operation !== 'wake' || !Array.isArray(messages) || messages.length !== 1 || release?.kind !== 'question') throw error('FORBIDDEN')
  const projected = messages[0], question = state.multisite.questions.find(row => row.id === release.id), stored = state.multisite.messages.find(row => row.id === projected.id), work = state.works.find(row => row.id === command.work_id)
  if (!question || !['cancelled', 'superseded'].includes(question.state) || !stored || projected.kind !== 'question_closed' || stored.kind !== 'question_closed' || stored.id !== key('question-closed', question.id) || stored.replyTo !== question.id || stored.reason !== question.closedReason || stored.workId !== work?.id || question.workId !== work.id || stored.targetAttemptId !== command.attempt_id || question.senderBinding.attempt_id !== command.attempt_id || stored.instructionRevision !== command.instruction_revision || command.instruction_revision !== work.instructionRevision || command.input_id !== key('message-delivery', stored.id) || !isDeepStrictEqual({ ...Object.fromEntries(Object.entries(stored).filter(([field]) => field !== 'controlConsumedAt')), deliveredAt: null, ingestedAt: null, sessionId: null }, projected)) throw error('FORBIDDEN')
  return executionAuthority(state, binding(command), {}, false, true)
}

export function hasConsumedExecutionMessage(state, execution, inputMessageId) {
  const current = state.multisite.attempts.find(row => row.attempt_id === execution.attempt_id)
  if (!current) return false
  const input = state.multisite.inputs.find(row => row.workId === current.work_id && row.revision === current.instruction_revision && row.deliveries.some(delivery => delivery.attemptId === current.attempt_id && delivery.sessionId === execution.session_id && delivery.ingestedAt))
  if (!input) return false
  if (messageId(input.id, current.attempt_id, execution.session_id) === inputMessageId) return true
  return state.multisite.outbox.some(entry => entry.command.operation === 'wake' && entry.command.attempt_id === current.attempt_id && entry.command.instruction_revision === current.instruction_revision && messageId(entry.command.input_id, current.attempt_id, execution.session_id) === inputMessageId && entry.command.parameters.messages.length > 0 && entry.command.parameters.messages.every(message => state.multisite.messages.some(row => row.id === message.id && row.targetAttemptId === current.attempt_id && row.sessionId === execution.session_id && row.ingestedAt)))
}

export function authorizeBudgetControlCommand(state, command) { budgetControlProof(state, command); if (command.parameters.messages?.[0]?.kind === 'budget_resume') assertManualExecution(state, command); return executionAuthority(state, binding(command), {}, false, false, true) }

export function authorizeBudgetControlReceipt(state, command) { budgetReceiptProof(state, command); return executionAuthority(state, binding(command), {}, false, false, true) }

export function authorizeManualControlCommand(state, command) { currentManualCommand(state, command); return executionAuthority(state, binding(command), {}, false, false, true) }

// These callers first verify their immutable event/closure producer. Recording a
// fact or closing a superseded question is not a new model, tool or Job admission.
export function authorizeSpreadsheetJobReceipt(state, event) { return executionAuthority(state, binding(event), {}, false, false, true) }
export function authorizeIntentClosureExecution(state, command) { return executionAuthority(state, binding(command), {}, false, true) }

export function authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId) {
  const row = state.artifacts.find(row => row.id === artifactId && row.workId === workId && row.ownerMemberId === actor?.id), work = state.works.find(row => row.id === workId)
  if (!row || row.status !== 'ready' || work?.status !== 'completed' || row.instructionRevision !== work.instructionRevision || !work.artifactRefs?.some(ref => ref.artifactId === row.id && ref.version === row.version && ref.sha256 === row.sha256)) throw error('NOT_FOUND', '成果当前不可读取')
  authorizeReadyArtifactRead(state, row)
  return row
}

export function authorizeReadyArtifactRead(state, artifact) {
  const row = state.artifacts.find(row => row.id === artifact.id && row.status === 'ready'), work = state.works.find(row => row.id === artifact.workId)
  if (!row || !isDeepStrictEqual(row, artifact) || work?.status !== 'completed' || row.instructionRevision !== work.instructionRevision || !work.artifactRefs?.some(ref => ref.artifactId === row.id && ref.version === row.version && ref.sha256 === row.sha256)) throw error('FORBIDDEN')
  const access = executionAuthority(state, row, { allowCompleted: true }, false, false, false, true)
  // Published output keeps its own current data authority; upstream source ACLs govern pre-publication reads.

  return access
}
