import { workMemberAffected } from '../../src/work-member-removal.mjs'
import { applyManualControlEvent } from '../../src/manual-control.mjs'
import { acceptIntentDeliveryEvent, authorizeIntentQuestionClosure } from '../../src/interaction-state.mjs'
import { currentOutput } from '../../src/spreadsheet-sources.mjs'
import { isCollaborationSpreadsheet } from '../../src/spreadsheet-template.mjs'
import { budgetIdleEvent } from './budgets.mjs'
import { authorizeManualControlCommand, authorizeQuestionClosureCommand, authorizeBudgetControlCommand, authorizeBudgetControlReceipt } from '../../src/multisite-authorization.mjs'
import { applySpreadsheetJobEvent } from '../../src/spreadsheet-state.mjs'
// Adapted from dsh-superagent-prototype@6337fc8 core/assignments.ts (MIT).
// Input delivery and consumption belong to a specific Attempt/Session; stale reports stay historical.
import { binding, key, sameBinding, error } from '../agent-contracts/index.mjs'

export function assignmentEvent(state, event, at) {
  const attempt = state.multisite.attempts.find(item => item.attempt_id === event.attempt_id)
  const delegation = state.multisite.delegations.find(item => item.id === event.delegation_id)
  if (!attempt || !delegation) throw error('NOT_FOUND', '执行绑定不存在')
  if (workMemberAffected(state, attempt) && !['stopped', 'settled', 'spreadsheet_job'].includes(event.kind)) return { historical: true }
  if (['manual_idle', 'manual_released'].includes(event.kind)) return applyManualControlEvent(state, event, at, authorizeManualControlCommand)
  const current = attempt && delegation?.currentAttemptId === attempt.attempt_id
    && sameBinding(attempt, event, { firstSession: event.kind === 'started' || event.kind === 'stopped' && attempt.session_id === null && event.session_id === `geneway-${attempt.launch_id}` })
  if (event.kind === 'spreadsheet_job') {
    applySpreadsheetJobEvent(state, event)
    return { historical: !current || state.works.find(work => work.id === attempt.work_id)?.instructionRevision !== event.instruction_revision }
  }
  if (!current) return { historical: true }
  const work = state.works.find(item => item.id === attempt.work_id)
  if(event.kind==='intent_control_consumed'){const command=state.multisite.outbox.find(row=>row.id===event.source_command_id)?.command;if(!command||!sameBinding(command,event)||command.input_id!==event.input_id||command.instruction_revision!==event.instruction_revision||command.parameters.intentQuestionClosure?.questionId!==event.control_question_id)throw error('FORBIDDEN');const{question}=authorizeIntentQuestionClosure(state,command);question.controlConsumedAt??=at;return{historical:false}}
  if (['intent_delivered','intent_ingested'].includes(event.kind)) return acceptIntentDeliveryEvent(state,event,at)
  if (event.kind === 'settled') {
    if (attempt.status !== 'completed' || !['idle_after_cancel', 'never_started'].includes(event.settle_evidence)) return { historical: true }
    attempt.settledAt ??= at
    return { historical: false }
  }
  if (event.kind === 'budget_idle') { budgetIdleEvent(state, event, at); return { historical: event.instruction_revision !== work.instructionRevision } }
  if (event.kind === 'control_consumed') {
    const command = state.multisite.outbox.find(row => row.id === event.source_command_id)?.command
    if (!command || command.input_id !== event.input_id || command.instruction_revision !== event.instruction_revision || !sameBinding(command, event) || command.parameters.messages[0]?.id !== event.control_message_id) throw error('FORBIDDEN')
    authorizeQuestionClosureCommand(state, command)
    const message = state.multisite.messages.find(row => row.id === event.control_message_id)
    message.controlConsumedAt ??= at
    return { historical: false }
  }
  if (['message_delivered', 'message_ingested'].includes(event.kind)) {
    if (['stopping', 'cancelled'].includes(attempt.status)) return { historical: true }
    const source = state.multisite.outbox.find(row => row.command.operation === 'wake' && row.command.input_id === event.input_id && row.command.attempt_id === event.attempt_id && row.command.instruction_revision === event.instruction_revision)
    const ids = new Set(source?.command.parameters.messages.map(row => row.id) ?? [])
    const messages = state.multisite.messages.filter(row => ids.has(row.id) && row.targetAttemptId === attempt.attempt_id && row.instructionRevision === event.instruction_revision)
    if (!messages.length) throw error('INVALID_REQUEST', '来源消息不存在')
    if (messages.some(message => message.kind === 'budget_resume')) authorizeBudgetControlReceipt(state, source.command)
    for (const message of messages) {
      message.sessionId = attempt.session_id
      if (event.kind === 'message_delivered') message.deliveredAt ??= at
      else { if (!message.deliveredAt) throw error('REVISION_CONFLICT'); message.ingestedAt ??= at; if (message.kind === 'budget_resume' && message.instructionRevision === work.instructionRevision && state.budgetHolds.some(hold => hold.resumeMessageId === message.id && hold.state === 'resume_queued')) attempt.status = 'running' }
    }
    return { historical: event.instruction_revision !== work.instructionRevision }
  }
  if (work.status === 'completed' || attempt.status === 'completed') return { historical: true }
  if (event.kind === 'started') {
    if (attempt.status === 'cancelled') return { historical: true }
    attempt.session_id ??= event.session_id
    if (attempt.status === 'stopping') return { historical: false }
    attempt.status = 'running'; attempt.startedAt ??= at
    if (!work.modelRequestBudget.exhaustedAt) work.status = 'running'
  } else if (['session_delivered', 'session_ingested'].includes(event.kind)) {
    const input = state.multisite.inputs.find(item => item.id === event.input_id && item.workId === work.id)
    const delivery = input?.deliveries.find(item => item.attemptId === attempt.attempt_id)
    if (!delivery || event.instruction_revision !== input.revision) throw error('INVALID_REQUEST', '输入回执引用不闭合')
    if (['cancelled', 'stopping'].includes(attempt.status)) return { historical: true }
    delivery.sessionId = attempt.session_id
    for (const subscription of state.contextSubscriptions.filter(row => row.sourceInputId === input.id && row.mode === 'handle' && sameBinding(row.handlerBinding, event))) { if (event.kind === 'session_delivered') subscription.deliveredAt ??= at; else if (subscription.deliveredAt) subscription.ingestedAt ??= at }
    if (event.kind === 'session_delivered') delivery.deliveredAt ??= at
    else {
      if (!delivery.deliveredAt) throw error('REVISION_CONFLICT', '输入尚未持久送达')
      delivery.ingestedAt ??= at
      attempt.observed_revision = Math.max(attempt.observed_revision, input.revision)
    }
  } else if (event.kind === 'report') {
    if (attempt.status !== 'running' || event.observed_revision !== work.instructionRevision || attempt.observed_revision < work.instructionRevision) return { historical: true }
    if (!['waiting', 'ready', 'blocked', 'failed'].includes(event.report?.state) || typeof event.report.summary !== 'string' || event.report.summary.length > 4000
      || event.report.question !== undefined && (typeof event.report.question !== 'string' || event.report.question.length > 2000 || event.report.state === 'ready')) throw error('INVALID_REQUEST', '结构化报告无效')
    attempt.report = { ...event.report, at }; delegation.status = event.report.state === 'waiting' ? 'waiting_input' : event.report.state
    if (event.report.question && isCollaborationSpreadsheet(work.spreadsheetRequest)) {
      if (!sameBinding(currentOutput(state, work).outputBinding, attempt)) throw error('FORBIDDEN', '仅当前产出员工可提出此工作用户问题')
      const id = key('user-question', event.event_id), open = state.userQuestions.find(row => row.workId === work.id && row.state === 'open')
      if (open && open.id !== id) throw error('QUESTION_PENDING', '已有尚未回答的用户问题')
      if (!open) state.userQuestions.push({ id, workId: work.id, sourceEventId: event.event_id, askingBinding: binding(attempt), instructionRevision: work.instructionRevision, inputId: event.input_id, kind: 'spreadsheet_due_date', question: event.report.question, state: 'open', createdAt: at, answeredByInputId: null })
      work.pendingQuestion = { id, delegationId: delegation.id, responsibleAttemptId: attempt.attempt_id, instructionRevision: work.instructionRevision, question: event.report.question, inputId: event.input_id }
    } else if (event.report.question) work.pendingQuestion = { delegationId: delegation.id, question: event.report.question, inputId: event.input_id }
    // A ready report is a candidate, never proof that a business artifact exists.
    if (event.report.state === 'waiting' && !work.modelRequestBudget.exhaustedAt) work.status = 'waiting_input'
  } else if (event.kind === 'runtime_unavailable') {
    if (['stopping', 'cancelled'].includes(attempt.status)) return { historical: true }
    attempt.status = 'unknown'; attempt.unavailableReason = event.reason; delegation.status = 'unknown'; if (!work.modelRequestBudget.exhaustedAt) work.status = 'interrupted'
  } else if (event.kind === 'stopped') {
    if (attempt.status !== 'stopping' || !['idle_after_cancel', 'never_started'].includes(event.stop_evidence)) return { historical: true }
    if (attempt.session_id === null && event.session_id === `geneway-${attempt.launch_id}`) attempt.session_id = event.session_id
    attempt.status = 'cancelled'; attempt.stoppedAt = at; delegation.status = 'cancelled'
    if (!workMemberAffected(state, attempt) || work.status === 'stopping') { if (state.multisite.attempts.filter(item => item.work_id === work.id).every(item => ['cancelled', 'completed'].includes(item.status))) work.status = 'cancelled' }
  } else throw error('INVALID_REQUEST', '回执类型无效')
  return { historical: false }
}
