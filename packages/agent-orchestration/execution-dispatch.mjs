import { authorizeContextReadNotification } from '../../src/context-read-delivery.mjs'
import { binding } from '../agent-contracts/index.mjs'
import { authorizeBudgetControlCommand, authorizeManualControlCommand, authorizeMultisiteExecution, authorizeQuestionClosureCommand } from '../../src/multisite-authorization.mjs'
import { authorizeIntentDelivery, authorizeIntentQuestionClosure } from '../../src/interaction-state.mjs'
import { authorizeManualResume } from '../../src/manual-resume.mjs'

// One current command gate is shared by remote/local dispatch and wake projection.
// Node transport identity and exact receipt replay remain their callers' concern.
export function authorizeExecutionCommand(state, command) {
  if (['cancel', 'settle'].includes(command.operation)) return
  if (state.manualControls.some(control => control.holders.some(holder => holder.resumeCommandId === command.command_id))) authorizeManualResume(state, command)
  if (['manual_pause', 'manual_release'].includes(command.operation)) return authorizeManualControlCommand(state, command)
  if (command.operation === 'intent_question_closed') return authorizeIntentQuestionClosure(state, command)
  if (command.operation === 'intent_review') return authorizeIntentDelivery(state, command)
  if (command.operation === 'budget_wait' || command.operation === 'wake' && command.parameters.messages?.[0]?.kind === 'budget_resume') return authorizeBudgetControlCommand(state, command)
  if (command.operation === 'wake' && command.parameters.messages?.some(message => message.kind === 'context_read_available')) return authorizeContextReadNotification(state, command)
  if (command.operation === 'wake' && command.parameters.messages?.some(message => message.kind === 'question_closed')) return authorizeQuestionClosureCommand(state, command)
  return authorizeMultisiteExecution(state, { ...binding(command), session_id: command.session_id ?? `geneway-${command.launch_id}` })
}
