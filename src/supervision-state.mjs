import { isDeepStrictEqual } from 'node:util'
import { error, exact, sameBinding } from '../packages/agent-contracts/index.mjs'

export const emptySupervisionState = () => ({ supervisionFindings: [], supervisionActions: [] })
export const SUPERVISION_CLASSES = ['COMMAND_UNACKNOWLEDGED', 'STAGE_STALLED', 'REPEATED_ERROR', 'BUDGET_WITHOUT_PROGRESS', 'API_UNREACHABLE', 'PROCESS_STOPPED', 'PROCESS_EXITED', 'PROCESS_IDENTITY_CHANGED', 'HOST_UNREACHABLE', 'STORAGE_UNRELIABLE']
export function supervisionUserQuestion(state, attempt) {
  const work = state.works.find(row => row.id === attempt.work_id), pending = work?.pendingQuestion
  if (!pending || work.instructionRevision !== attempt.instruction_revision) return false
  if (pending.responsibleAttemptId !== undefined) return pending.responsibleAttemptId === attempt.attempt_id && pending.instructionRevision === attempt.instruction_revision
    && (state.userQuestions ?? []).some(row => row.id === pending.id && row.workId === work.id && row.state === 'open' && row.instructionRevision === attempt.instruction_revision && sameBinding(row.askingBinding, attempt))
  const delegation = state.multisite.delegations.find(row => row.id === pending.delegationId), input = state.multisite.inputs.find(row => row.id === pending.inputId)
  return delegation?.currentAttemptId === attempt.attempt_id && input?.workId === work.id && input.revision === attempt.instruction_revision
    && state.multisite.receipts.some(row => !row.historical && row.event.kind === 'report' && sameBinding(row.event, attempt) && row.event.input_id === input.id && row.event.instruction_revision === input.revision && row.event.report?.question === pending.question)
}
const valid = value => { if (!value) throw error('INVALID_STATE', '监督事实无效') }
export function validateSupervisionState(state) {
  for (const name of Object.keys(emptySupervisionState())) {
    valid(Array.isArray(state[name])); valid(new Set(state[name].map(row => row.id)).size === state[name].length)
  }
  for (const row of state.supervisionFindings) {
    exact(row, ['id', 'identityId', 'workspaceId', 'episodeId', 'scope', 'classification', 'firstObservedAt', 'lastObservedAt', 'checkpointAt', 'factRefs', 'code', 'acceptedAt'])
    valid(typeof row.id === 'string' && typeof row.identityId === 'string' && SUPERVISION_CLASSES.includes(row.classification))
    valid(Number.isFinite(Date.parse(row.firstObservedAt)) && Date.parse(row.lastObservedAt) >= Date.parse(row.firstObservedAt))
    valid(row.scope && typeof row.scope.nodeId === 'string' && Array.isArray(row.factRefs) && row.factRefs.length <= 16)
  }
  for (const row of state.supervisionActions) {
    exact(row, ['id', 'findingId', 'identityId', 'commandId', 'payloadDigest', 'binding', 'generation', 'nodeInstanceId', 'claimedAt', 'outcome', 'reason', 'finishedAt'])
    valid(state.supervisionFindings.some(finding => finding.id === row.findingId))
    valid(['claimed', 'offered', 'not_offered'].includes(row.outcome) && typeof row.commandId === 'string' && typeof row.generation === 'string')
    valid(row.outcome === 'claimed' ? row.finishedAt === null : Number.isFinite(Date.parse(row.finishedAt)))
  }
  valid(new Set(state.supervisionActions.map(row => row.commandId)).size === state.supervisionActions.length)
  return state
}
export function assertSupervisionImmutable(before, after) {
  for (const row of before.supervisionFindings ?? []) {
    const next = after.supervisionFindings.find(item => item.id === row.id)
    valid(next && isDeepStrictEqual({ ...row, lastObservedAt: undefined }, { ...next, lastObservedAt: undefined }) && Date.parse(next.lastObservedAt) >= Date.parse(row.lastObservedAt))
  }
  for (const row of before.supervisionActions ?? []) {
    const next = after.supervisionActions.find(item => item.id === row.id)
    valid(next && isDeepStrictEqual({ ...row, outcome: undefined, reason: undefined, finishedAt: undefined }, { ...next, outcome: undefined, reason: undefined, finishedAt: undefined }))
    if (row.outcome !== 'claimed') valid(isDeepStrictEqual(row, next))
  }
}
