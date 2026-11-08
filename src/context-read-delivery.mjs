import { isDeepStrictEqual } from 'node:util'
import { binding, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { authorizeMultisiteExecution } from './multisite-authorization.mjs'
import { authorizeIntentDelivery, intentFenceFor } from './interaction-state.mjs'
import { continuationReaderSource } from './context-read-access.mjs'
import { currentContextWindow } from './context-read-state.mjs'
const bound = value => ({ ...binding(value), session_id: value.session_id ?? `geneway-${value.launch_id}` })
export function queueContextReadWindows(state, at, { workId } = {}) {
  for (const instance of (state.contextReadInstances ?? []).filter(row => !workId || row.readerBinding.work_id === workId)) {
    const window = currentContextWindow(state, instance.id)
    if (!window?.parentReadId || window.deliveredAt) continue
    const execution = instance.readerBinding, attempt = state.multisite.attempts.find(row => sameBinding(bound(row), execution)), work = state.works.find(row => row.id === execution.work_id)
    if (attempt?.status !== 'running' || work?.status !== 'running' || state.modelRequests.some(row => sameBinding(row, execution) && row.outcome === 'unknown')) continue
    try { continuationReaderSource(state, execution); authorizeMultisiteExecution(state, execution) } catch (cause) { if (['FORBIDDEN', 'NOT_FOUND', 'CONTEXT_READ_UNAVAILABLE', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MODEL_NOT_CONFIGURED', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'BUDGET_EXHAUSTED'].includes(cause.code)) continue; throw cause }
    const input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === work.instructionRevision)
    if (!input?.deliveries.some(row => row.attemptId === attempt.attempt_id && row.sessionId === attempt.session_id && row.ingestedAt) || state.intentQuestions.some(row => row.state === 'open' && sameBinding(row.handlerBinding, execution)) || state.multisite.questions.some(row => row.state === 'open' && row.senderBinding.attempt_id === attempt.attempt_id) || state.multisite.dependencyWaits.some(row => row.parentAttemptId === attempt.attempt_id && row.instructionRevision === work.instructionRevision && !row.wokenAt)) continue
    if (window.approvalIntent) {
      const approved = state.workIntents.find(row => row.id === window.approvalIntent.intentId && row.routeRevision === window.approvalIntent.routeRevision)
      if (!approved || !['attached', 'accepted'].includes(approved.state) || !state.contextSubscriptions.some(row => row.id === approved.handlerSubscriptionId && sameBinding(row.handlerBinding, execution) && ['active', 'paused'].includes(row.lifecycle))) continue
    }
    const latestId = window.deliveryCommandIds?.at(-1) ?? window.deliveryCommandId
    if (latestId) { const old = state.multisite.outbox.find(row => row.id === latestId)?.command; try { if (old?.operation === 'intent_review') authorizeIntentDelivery(state, old); else authorizeContextReadNotification(state, old); continue } catch (cause) { if (!['FORBIDDEN', 'REVISION_CONFLICT', 'CONTEXT_READ_UNAVAILABLE'].includes(cause.code)) throw cause } }
    const assigned = id => { window.deliveryCommandId ??= id; window.deliveryCommandIds ??= []; if (!window.deliveryCommandIds.includes(id)) window.deliveryCommandIds.push(id) }
    const intent = state.workIntents.find(row => row.state === 'attached' && state.contextSubscriptions.some(subscription => subscription.id === row.handlerSubscriptionId && subscription.mode === 'handle' && subscription.lifecycle === 'active' && sameBinding(subscription.handlerBinding, execution)))
    if (intent) {
      const previous = state.contextSubscriptions.find(row => row.id === intent.handlerSubscriptionId)
      const pending = state.multisite.outbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence?.intentId === intent.id && row.command.parameters.intentFence.subscriptionRevision === previous.revision && row.command.instruction_revision === work.instructionRevision)
      if (!previous.ingestedAt && pending) { try { authorizeIntentDelivery(state, pending.command); assigned(pending.id) } catch (cause) { if (!['FORBIDDEN', 'REVISION_CONFLICT', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) throw cause }; continue }
      if (!previous.ingestedAt) continue
      previous.lifecycle = 'released'; previous.releasedAt = at
      const next = { ...structuredClone(previous), id: key('intent-context-window', previous.id, window.id), revision: previous.revision + 1, lifecycle: 'active', createdAt: at, deliveredAt: null, ingestedAt: null, contextReadWindowId: window.id }; delete next.releasedAt; delete next.manualResume; state.contextSubscriptions.push(next); intent.handlerSubscriptionId = next.id
      const source = state.sourceEvents.find(row => row.id === intent.sourceEventId), parent = state.contextReads.find(row => row.id === window.parentReadId)
      const delivery = { id: key('intent-delivery', next.id), revision: work.instructionRevision, text: source.text + `\n资料读取新窗口已由用户明确批准；请用 geneway_read_context 的 ${window.continuationTarget?.view ?? parent.view} 视图继续原未读位置。这不是新业务要求或普通执行授权。`, intentFence: intentFenceFor(intent, next), sourceEvent: { id: source.id, threadId: source.threadId, version: source.version, text: source.text }, contextReadWindow: { windowId: window.id, sourceEventId: window.sourceEventId, parentReadId: parent.id }, attachmentRefs: [] }
      queueExecutionCommand(state, attempt, 'intent_review', delivery, at, work.workspaceId); assigned(key('intent_review', attempt.attempt_id, delivery.id))
    } else {
      const parent = state.contextReads.find(row => row.id === window.parentReadId), message = { id: key('context-read-available', window.id, work.instructionRevision), workId: work.id, senderBinding: binding(attempt), targetAttemptId: attempt.attempt_id, kind: 'context_read_available', replyTo: window.id, sourceDelegationId: attempt.delegation_id, instructionRevision: work.instructionRevision, resultRef: null, createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null, text: `用户已明确批准继续读取资料。调用 geneway_read_context 的 ${window.continuationTarget?.view ?? parent.view} 视图，从服务端固定的原未读位置继续；不更改工作要求或解除业务等待。`, evidenceRefs: [], contextReadWindowId: window.id }
      state.multisite.messages.push(message); const delivery = { id: key('message-delivery', message.id), revision: work.instructionRevision, text: message.text, messages: [message] }; queueExecutionCommand(state, attempt, 'wake', delivery, at, work.workspaceId); assigned(key('wake', attempt.attempt_id, delivery.id))
    }
  }
}
export function recordContextWindowDelivery(state, event, at) {
  if (!['intent_ingested', 'message_ingested'].includes(event.kind)) return
  for (const window of state.contextReadWindows ?? []) {
    if (!window.deliveryCommandId || window.deliveredAt) continue
    const command = state.multisite.outbox.find(row => (window.deliveryCommandIds ?? [window.deliveryCommandId]).includes(row.id) && row.command.input_id === event.input_id && sameBinding(bound(row.command), event))?.command, instance = state.contextReadInstances.find(row => row.id === window.contextInstanceId), work = state.works.find(row => row.id === instance?.readerBinding.work_id)
    if (command && command.instruction_revision === event.instruction_revision && event.instruction_revision === work.instructionRevision) {
      try { if (command.operation === 'intent_review') authorizeIntentDelivery(state, command, { requireConsumed: true }); else authorizeContextReadNotification(state, command); window.deliveredAt = at; window.deliveredByCommandId = command.command_id } catch (cause) { if (!['FORBIDDEN', 'CONTEXT_READ_UNAVAILABLE', 'REVISION_CONFLICT', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) throw cause }
    }
  }
}
export function assertContextWindowAvailable(state, window, modelRequest) {
  if (!window.parentReadId) return
  if (!window.deliveredAt || state.modelRequests.findIndex(row => row.id === modelRequest.id) < window.modelRequestCountAtApproval) throw error('CONTEXT_READ_WINDOW_PENDING', '新资料窗口等待当前合法通知实际消费')
  if (window.approvalIntent) {
    const intent = state.workIntents.find(row => row.id === window.approvalIntent.intentId && row.routeRevision === window.approvalIntent.routeRevision), subscription = state.contextSubscriptions.find(row => row.id === intent?.handlerSubscriptionId)
    if (!intent || !['attached', 'accepted'].includes(intent.state) || !sameBinding(subscription?.handlerBinding ?? {}, modelRequest)) throw error('CONTEXT_READ_UNAVAILABLE')
  }
}

export function authorizeContextReadNotification(state, command) {
  const message = command?.parameters.messages?.[0], window = state.contextReadWindows.find(row => row.id === message?.contextReadWindowId), original = state.multisite.outbox.find(row => row.id === command?.command_id)?.command, instance = state.contextReadInstances.find(row => row.id === window?.contextInstanceId)
  if (command?.operation !== 'wake' || command.parameters.messages.length !== 1 || message.kind !== 'context_read_available' || !window || !instance || !isDeepStrictEqual(original, command) || !sameBinding(instance.readerBinding, bound(command)) || ![key('context-read-available', window.id), key('context-read-available', window.id, command.instruction_revision)].includes(message.id) || message.replyTo !== window.id || command.instruction_revision !== state.works.find(row => row.id === command.work_id)?.instructionRevision || !state.sourceEvents.some(row => row.id === window.sourceEventId && row.payload.continueContextRead?.readId === window.parentReadId)) throw error('FORBIDDEN')
  if (state.workIntents.some(row => row.state === 'attached' && state.contextSubscriptions.some(subscription => subscription.id === row.handlerSubscriptionId && ['active', 'paused'].includes(subscription.lifecycle) && sameBinding(subscription.handlerBinding, instance.readerBinding)))) throw error('FORBIDDEN')
  continuationReaderSource(state, instance.readerBinding)
  return authorizeMultisiteExecution(state, instance.readerBinding)
}
