import { siteRuleRuntime } from '../../src/site-rule-state.mjs'
import { binding, key, SCHEMA, seal } from '../agent-contracts/index.mjs'
import { assertCommandBytes } from '../agent-contracts/command-bytes.mjs'

function executionContext(state, attempt) {
  if (!attempt.grant) return undefined
  const delegation = state.multisite.delegations.find(row => row.id === attempt.delegation_id)
  return { fromAgent: delegation.fromAgent ?? null, parentDelegationId: delegation.parentDelegationId, goal: delegation.goal, requestedCapabilityId: delegation.requestedCapabilityId ?? null,
    resultSchema: delegation.resultSchema ?? 'geneway.delegation-result/1', grant: structuredClone(attempt.grant), policyRevision: attempt.employeeRevision, ...(delegation.evidenceRefs ? { evidenceRefs: structuredClone(delegation.evidenceRefs) } : {}) }
}
export function buildExecutionCommand(state, attempt, operation, input, workspaceId) {
  const siteRule = operation === 'launch' && siteRuleRuntime(state.works.find(work => work.id === attempt.work_id) ?? {})
  return seal({ schema: SCHEMA, command_id: key(operation, attempt.attempt_id, input?.id ?? ''), operation, workspace_id: workspaceId, ...binding(attempt),
    input_id: input?.id ?? null, instruction_revision: input?.revision ?? attempt.instruction_revision,
    observed_revision: attempt.observed_revision, resource_refs: attempt.resource_refs,
    parameters: input ? { ...(siteRule ? { siteRule } : {}), ...(operation === 'intent_question_closed' ? {intentQuestionClosure:input.intentQuestionClosure} : {}), ...(input.continuationContext ? { continuationContext: structuredClone(input.continuationContext) } : {}), ...(input.contextReadWindow ? { contextReadWindow: structuredClone(input.contextReadWindow) } : {}), ...(operation === 'intent_review' ? { intentFence: input.intentFence, sourceEvent: input.sourceEvent, ...(input.intentAnswer ? { intentAnswer: input.intentAnswer } : {}), ...(input.waitRelease ? { waitRelease: input.waitRelease } : {}) } : {}), ...(operation === 'budget_wait' ? { budgetHold: input.budgetHold } : {}), ...(operation === 'wake' ? { messages: input.messages, ...(input.waitRelease ? { waitRelease: input.waitRelease } : {}) } : {}), ...(executionContext(state, attempt) ? { executionContext: executionContext(state, attempt) } : {}), text: input.text, attachmentRefs: input.attachmentRefs ?? [], ...(input.spreadsheetRequest ? { spreadsheetRequest: input.spreadsheetRequest } : {}) } : {}, employee_revision: attempt.employeeRevision })
}
export function queueExecutionCommand(state, attempt, operation, input, at, workspaceId) {
  const command = assertCommandBytes(buildExecutionCommand(state, attempt, operation, input, workspaceId)), id = command.command_id
  if (!state.multisite.outbox.some(item => item.command.command_id === id)) state.multisite.outbox.push({ id, command, createdAt: at, acceptedAt: null })
}
