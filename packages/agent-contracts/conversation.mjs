import { assertSealed, error, key, exact, sameBinding } from './index.mjs'

// A server closure is a control receipt, never an Agent answer or model input.
export function questionClosure(command) {
  assertSealed(command)
  const messages = command.parameters.messages, release = command.parameters.waitRelease
  if (command.operation !== 'wake' || !Array.isArray(messages) || messages.length !== 1 || messages[0].kind !== 'question_closed' || release?.kind !== 'question' || typeof release.id !== 'string') throw error('FORBIDDEN')
  const row = messages[0]
  if (row.id !== key('question-closed', release.id) || row.replyTo !== release.id || row.targetAttemptId !== command.attempt_id || row.workId !== command.work_id || row.instructionRevision !== command.instruction_revision || command.input_id !== key('message-delivery', row.id)) throw error('FORBIDDEN')
  return row
}

export function intentQuestionClosure(command) {
  assertSealed(command)
  const value=command.parameters.intentQuestionClosure
  exact(value,['kind','questionId','intentId','routeRevision','subscriptionRevision','handlerBinding','sourceEventId','supersededByEventId'])
  if(command.operation!=='intent_question_closed'||value.kind!=='intent_question_closed'||!sameBinding(command,value.handlerBinding)||command.input_id!==key('intent-question-closure',value.questionId,value.supersededByEventId)||!Number.isSafeInteger(value.routeRevision)||!Number.isSafeInteger(value.subscriptionRevision))throw error('FORBIDDEN')
  return value
}
