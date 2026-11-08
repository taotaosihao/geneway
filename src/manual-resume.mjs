import { isDeepStrictEqual } from 'node:util'
import { binding, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { currentManualControl, assertManualExecution, assertManualConsumption, manualFence } from './manual-control.mjs'
import { authorizeBudgetControlCommand, authorizeMultisiteExecution } from './multisite-authorization.mjs'
import { authorizeIntent, authorizeIntentDelivery, intentFenceFor } from './interaction-state.mjs'

const bound = value => ({ ...binding(value), session_id: value.session_id ?? `geneway-${value.launch_id}` })
function assignResume(state, execution, commandId) {
  for (const control of state.manualControls.filter(row => row.action === 'resume' && currentManualControl(state, row.workId, row.scope)?.id === row.id)) for (const holder of control.holders) if (holder.releasedAt && !holder.resumeCommandId && sameBinding(holder.binding, execution)) { holder.resumeCommandId = commandId; holder.resumeFence = manualFence(state, execution) }
}
function unconsumedDelivery(state, attempt, command) {
  if (!sameBinding(bound(command), bound(attempt)) || command.instruction_revision !== attempt.instruction_revision) return false
  if (state.manualControls.some(control => control.holders.some(holder => holder.resumeCommandId === command.command_id))) {
    try { authorizeManualResume(state, command) } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) return false; throw cause }
  }
  if (['launch', 'deliver'].includes(command.operation)) return !state.multisite.inputs.find(row => row.id === command.input_id)?.deliveries.some(row => row.attemptId === attempt.attempt_id && row.sessionId === attempt.session_id && row.ingestedAt)
  if (command.operation === 'intent_review') {
    try { authorizeIntentDelivery(state, command) } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) return false; throw cause }
    return !state.contextSubscriptions.some(row => row.id === state.workIntents.find(row => row.id === command.parameters.intentFence.intentId)?.handlerSubscriptionId && row.revision === command.parameters.intentFence.subscriptionRevision && row.ingestedAt)
  }
  if (command.operation === 'wake' && !command.parameters.messages?.some(row => row.kind === 'question_closed')) return command.parameters.messages.some(message => !state.multisite.messages.find(row => row.id === message.id)?.ingestedAt)
  return false
}

// An explicit release may need a fresh turn after the previous turn was parked.
// Existing durable work always has priority; a release never replays an old Input.
export function queueManualResumes(state, at, { workId } = {}) {
  for (const control of (state.manualControls ?? []).filter(row => (!workId || row.workId === workId) && row.action === 'resume' && currentManualControl(state, row.workId, row.scope)?.id === row.id)) for (const holder of control.holders) {
    if (!holder.releasedAt || holder.resumeCommandId) continue
    const attempt = state.multisite.attempts.find(row => sameBinding(bound(row), holder.binding)), work = state.works.find(row => row.id === control.workId)
    if (attempt?.status === 'waiting_budget') {
      const pendingBudget = state.multisite.outbox.find(row => row.command.operation === 'wake' && row.command.parameters.messages?.[0]?.kind === 'budget_resume' && unconsumedDelivery(state, attempt, row.command))
      if (pendingBudget) {
        try { authorizeBudgetControlCommand(state, pendingBudget.command); assignResume(state, holder.binding, pendingBudget.id) } catch (cause) { if (!['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) throw cause }
      }
      continue
    }
    if (!attempt || attempt.status !== 'running' || work?.status !== 'running' || state.modelRequests.some(row => row.attempt_id === attempt.attempt_id && row.outcome === 'unknown')) continue
    try { authorizeMultisiteExecution(state, holder.binding) } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MODEL_NOT_CONFIGURED', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'BUDGET_EXHAUSTED'].includes(cause.code)) continue; throw cause }
    const input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === work.instructionRevision)
    const pending = state.multisite.outbox.find(row => unconsumedDelivery(state, attempt, row.command))
    if (pending) { assignResume(state, holder.binding, pending.id); continue }
    if (!input?.deliveries.some(row => row.attemptId === attempt.attempt_id && row.sessionId === attempt.session_id && row.ingestedAt)) continue
    if (state.multisite.questions.some(row => row.state === 'open' && row.senderBinding.attempt_id === attempt.attempt_id)) continue
    if (state.intentQuestions.some(row => row.state === 'open' && row.handlerBinding.attempt_id === attempt.attempt_id)) continue
    const intent = state.workIntents.find(row => row.state === 'attached' && state.contextSubscriptions.some(subscription => subscription.id === row.handlerSubscriptionId && subscription.lifecycle === 'active' && subscription.ingestedAt && sameBinding(subscription.handlerBinding, holder.binding)))
    const marker = { controlId: control.id, holderId: holder.id }
    if (intent) {
      const previous = state.contextSubscriptions.find(row => row.id === intent.handlerSubscriptionId), source = state.sourceEvents.find(row => row.id === intent.sourceEventId)
      previous.lifecycle = 'released'; previous.releasedAt = at
      const subscription = { ...structuredClone(previous), id: key('intent-manual-resume', previous.id, control.id, holder.id), revision: previous.revision + 1, lifecycle: 'active', createdAt: at, deliveredAt: null, ingestedAt: null, manualResume: marker }
      delete subscription.releasedAt; state.contextSubscriptions.push(subscription); intent.handlerSubscriptionId = subscription.id
      const delivery = { id: key('intent-delivery', subscription.id), revision: work.instructionRevision, text: source.text, attachmentRefs: [], intentFence: intentFenceFor(intent, subscription), sourceEvent: { id: source.id, threadId: source.threadId, version: source.version, text: source.text } }
      queueExecutionCommand(state, attempt, 'intent_review', delivery, at, work.workspaceId)
      holder.resumeCommandId = key('intent_review', attempt.attempt_id, delivery.id)
    } else {
      const message = { id: key('manual-resume-message', control.id, holder.id), workId: work.id, senderBinding: binding(attempt), kind: 'manual_resume', targetAttemptId: attempt.attempt_id, replyTo: holder.id, sourceDelegationId: attempt.delegation_id, instructionRevision: work.instructionRevision, resultRef: null, createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null, text: '用户已明确解除本次人工暂停，请沿当前工作要求与已消费上下文继续；不得重放已完成操作或结果未知的请求。', evidenceRefs: [], manualResume: marker }
      state.multisite.messages.push(message)
      const delivery = { id: key('manual-resume-delivery', control.id, holder.id), revision: work.instructionRevision, text: message.text, messages: [message] }
      queueExecutionCommand(state, attempt, 'wake', delivery, at, work.workspaceId)
      holder.resumeCommandId = key('wake', attempt.attempt_id, delivery.id)
    }
    holder.resumeFence = manualFence(state, holder.binding)
    assignResume(state, holder.binding, holder.resumeCommandId)
  }
  // A formal Input can supersede an undelivered review's business revision while
  // paused. Only after that Input really arrives may the same pending source be
  // offered again for restricted review; its original command remains history.
  for (const intent of state.workIntents.filter(row => (!workId || row.workId === workId) && row.state === 'attached')) {
    const previous = state.contextSubscriptions.find(row => row.id === intent.handlerSubscriptionId)
    if (!previous || previous.lifecycle !== 'active' || previous.ingestedAt) continue
    const execution = previous.handlerBinding, attempt = state.multisite.attempts.find(row => sameBinding(bound(row), execution)), work = state.works.find(row => row.id === execution.work_id)
    if (attempt?.status !== 'running' || work?.status !== 'running' || !state.manualControls.some(control => currentManualControl(state, control.workId, control.scope)?.id === control.id && control.action === 'resume' && control.holders.some(holder => holder.releasedAt && holder.resumeConsumedAt && sameBinding(holder.binding, execution)))) continue
    const original = state.multisite.outbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence?.intentId === intent.id && row.command.parameters.intentFence.subscriptionRevision === previous.revision)?.command
    if (!original || original.instruction_revision >= work.instructionRevision) continue
    if (state.intentQuestions.some(row => row.state === 'open' && sameBinding(row.handlerBinding, execution)) || state.multisite.questions.some(row => row.state === 'open' && row.senderBinding.attempt_id === attempt.attempt_id) || state.multisite.dependencyWaits.some(row => row.parentAttemptId === attempt.attempt_id && row.instructionRevision === work.instructionRevision && !row.wokenAt)) continue
    try { assertManualConsumption(state, execution); authorizeIntent(state, execution, intentFenceFor(intent, previous), { requireConsumed: false }) } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MODEL_NOT_CONFIGURED', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'BUDGET_EXHAUSTED'].includes(cause.code)) continue; throw cause }
    const input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === work.instructionRevision)
    if (!input?.deliveries.some(row => row.attemptId === attempt.attempt_id && row.sessionId === attempt.session_id && row.ingestedAt)) continue
    previous.lifecycle = 'released'; previous.releasedAt = at
    const subscription = { ...structuredClone(previous), id: key('intent-current-input', previous.id, input.id), revision: previous.revision + 1, lifecycle: 'active', createdAt: at, deliveredAt: null, ingestedAt: null }
    delete subscription.releasedAt; delete subscription.manualResume
    state.contextSubscriptions.push(subscription); intent.handlerSubscriptionId = subscription.id
    const source = state.sourceEvents.find(row => row.id === intent.sourceEventId)
    queueExecutionCommand(state, attempt, 'intent_review', { id: key('intent-delivery', subscription.id), revision: work.instructionRevision, text: source.text, attachmentRefs: [], intentFence: intentFenceFor(intent, subscription), sourceEvent: { id: source.id, threadId: source.threadId, version: source.version, text: source.text } }, at, work.workspaceId)
  }
}

export function manualResumeProof(state, command) {
  const holder = state.manualControls.flatMap(control => control.holders.map(holder => ({ control, holder }))).find(row => row.holder.resumeCommandId === command?.command_id)
  const original = state.multisite.outbox.find(row => row.id === command?.command_id)?.command
  if (!holder || !original || !isDeepStrictEqual(original, command) || !sameBinding(bound(command), holder.holder.binding) || !holder.holder.releasedAt) throw error('FORBIDDEN')
  return holder
}
export function authorizeManualResume(state, command) {
  const { control, holder } = manualResumeProof(state, command), work = state.works.find(row => row.id === control.workId)
  if (currentManualControl(state, control.workId, control.scope)?.id !== control.id || command.instruction_revision !== work.instructionRevision) throw error('REVISION_CONFLICT', '人工续行已换代')
  if (!isDeepStrictEqual(holder.resumeFence, manualFence(state, holder.binding))) throw error('REVISION_CONFLICT', '人工续行范围已换代')
  assertManualExecution(state, holder.binding)
  if (command.parameters.messages?.[0]?.kind === 'budget_resume') return authorizeBudgetControlCommand(state, command)
  return authorizeMultisiteExecution(state, holder.binding)
}
export function consumeManualResume(state, command, at) {
  manualResumeProof(state, command)
  for (const control of state.manualControls) for (const holder of control.holders) if (holder.resumeCommandId === command.command_id) holder.resumeConsumedAt ??= at
}

export function recordManualResumeConsumption(state, event, at) {
  if (!['session_ingested', 'message_ingested', 'intent_ingested'].includes(event.kind)) return
  const candidates = state.multisite.outbox.filter(row => row.command.input_id === event.input_id && row.command.instruction_revision === event.instruction_revision && sameBinding(bound(row.command), event))
  for (const row of candidates) if (state.manualControls.some(control => control.holders.some(holder => holder.resumeCommandId === row.id))) consumeManualResume(state, row.command, at)
}

export function consumedManualResumeForMessage(state, execution, inputMessageId) {
  return state.multisite.outbox.find(row => sameBinding(bound(row.command), execution) && row.command.instruction_revision === state.multisite.attempts.find(attempt => attempt.attempt_id === execution.attempt_id)?.instruction_revision && inputMessageId === messageId(row.command.input_id, execution.attempt_id, execution.session_id) && state.manualControls.some(control => control.holders.some(holder => holder.resumeCommandId === row.id && holder.resumeConsumedAt)))?.id
}
