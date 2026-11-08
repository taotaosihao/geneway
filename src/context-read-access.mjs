import { workMemberRemoval } from './work-member-removal.mjs'
import { isDeepStrictEqual } from 'node:util'
import { binding, error, sameBinding } from '../packages/agent-contracts/index.mjs'
import { interactionWork, currentThread } from './interaction-state.mjs'
import { authorizeOwnedReadyArtifactRead } from './multisite-authorization.mjs'
const unavailable = () => error('CONTEXT_READ_UNAVAILABLE', '此资料当前不可读取')
export function continuationReaderSource(state, execution) {
  const work = state.works.find(row => row.id === execution.work_id), links = state.workContinuations.filter(row => row.workId === work?.id)
  if (links.length !== 1 || execution.parent_delegation_id !== null || execution.agent_id !== work.employeeId) throw unavailable()
  const link = links[0], actor = { id: work.ownerMemberId }, input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === 1), event = state.sourceEvents.find(row => row.id === link.sourceEventId), intent = state.workIntents.find(row => row.id === link.intentId), attempt = state.multisite.attempts.find(row => sameBinding({ ...row, session_id: row.session_id ?? `geneway-${row.launch_id}` }, execution)), delegation = state.multisite.delegations.find(row => row.id === execution.delegation_id)
  const original = state.contextSubscriptions.filter(row => row.intentId === link.intentId && row.sourceInputId === input?.id && sameBinding(row.handlerBinding, execution))
  if (!input || !isDeepStrictEqual(input.continuationContext, link.context) || !event || event.id !== link.context.sourceEventId || link.context.sourceWorkId !== link.sourceWorkId || link.decisionId !== link.context.routingDecisionId || !state.routingDecisions.some(row => row.id === link.decisionId && row.intentId === link.intentId) || !intent || !attempt || delegation?.currentAttemptId !== execution.attempt_id || original.length !== 1) throw unavailable()
  interactionWork(state, actor, work.id); const source = interactionWork(state, actor, link.sourceWorkId).work
  if (workMemberRemoval(state, source.id, execution.agent_id)) throw unavailable()
  currentThread(state, actor, event.threadId)
  const read = link.artifactReadId && state.interactionArtifactReads.find(row => row.id === link.artifactReadId && row.intentId === link.intentId && row.actorId === actor.id && row.sourceWorkId === source.id)
  if (link.artifactReadId && (!read || read.artifactId !== link.context.artifact?.artifactId || read.version !== link.context.artifact?.version || read.sha256 !== link.context.artifact?.sha256)) throw unavailable()
  return { link, actor, input, source, work, threadId: event.threadId, readerBinding: binding(execution), artifactRead: read }
}
export function continuationArtifact(state, source) {
  const read = source.artifactRead
  if (!read) throw unavailable()
  const artifact = authorizeOwnedReadyArtifactRead(state, source.actor, source.source.id, read.artifactId)
  if (artifact.version !== read.version || artifact.sha256 !== read.sha256) throw unavailable()
  return artifact
}
export function continuationEvidence(state, source, ref, execution) {
  const row = state.evidence.find(row => row.id === ref.id && row.version === ref.version && row.sha256 === ref.sha256 && row.status === 'ready' && row.workId === source.source.id && row.ownerMemberId === source.actor.id), resource = row && state.resources.find(resource => resource.id === row.resourceId && resource.enabled && resource.revision === row.resourceRevision && resource.workspaceId === source.work.workspaceId && resource.ownerNodeId === row.producerBinding.node_id)
  if (!row || !resource || !resource.evidenceReaderAgentIds.includes(execution.agent_id) || !row.exportToAgentIds.includes(execution.agent_id) || !state.multisite.results.some(result => result.workId === row.workId && sameBinding(result.senderBinding, row.producerBinding) && result.instructionRevision === row.instructionRevision && result.payload.evidenceRefs?.some(value => isDeepStrictEqual(value, ref)))) throw unavailable()
  return row
}
