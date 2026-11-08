import { isDeepStrictEqual } from 'node:util'
import { authorizeMultisiteExecution } from './multisite-authorization.mjs'
import { binding, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { evidenceRef } from '../packages/agent-contracts/evidence.mjs'

export const evidenceBinding = attempt => binding({ ...attempt, session_id: attempt.session_id ?? `geneway-${attempt.launch_id}` })
export function assertEvidenceReader(state, execution, revision, ref, { requireInput = true } = {}) {
  evidenceRef(ref)
  const access = authorizeMultisiteExecution(state, execution), row = state.evidence.find(item => item.id === ref.id && item.status === 'ready' && item.version === ref.version && item.sha256 === ref.sha256)
  if (access.work.instructionRevision !== revision || access.current.instruction_revision !== revision) throw error('REVISION_CONFLICT')
  if (requireInput && !state.multisite.inputs.some(input => input.workId === access.work.id && input.revision === revision && input.deliveries.some(delivery => delivery.attemptId === execution.attempt_id && delivery.sessionId === execution.session_id && delivery.ingestedAt))) throw error('REVISION_CONFLICT', '尚未消费当前输入')
  const resource = row && state.resources.find(item => item.id === row.resourceId && item.enabled && item.revision === row.resourceRevision)
  const receipt = row && state.evidenceAccessReceipts.find(item => isDeepStrictEqual(item.evidenceRef, ref) && sameBinding(item.receiverBinding, execution) && item.receiverInstructionRevision === revision)
  if (!row || row.workId !== access.work.id || row.ownerMemberId !== access.owner.id || !resource || !receipt || !resource.evidenceReaderAgentIds.includes(execution.agent_id) || !row.exportToAgentIds.includes(execution.agent_id)) throw error('FORBIDDEN', '证据未向本执行授读')
  return { ...access, row, resource, receipt }
}
export function shareEvidence(state, issuer, receiver, refs, { reason, sourceCommandKey, at }) {
  if (!['delegate', 'result', 'share'].includes(reason) || !Array.isArray(refs) || refs.length > 32) throw error('INVALID_REQUEST')
  const target = evidenceBinding(receiver), work = state.works.find(item => item.id === issuer.work_id)
  if (issuer.work_id !== receiver.work_id) throw error('FORBIDDEN')
  const targetAccess = authorizeMultisiteExecution(state, target)
  if (targetAccess.current.instruction_revision !== work.instructionRevision) throw error('REVISION_CONFLICT')
  for (const ref of refs) {
    const { row, resource, receipt } = assertEvidenceReader(state, issuer, work.instructionRevision, ref)
    if (!resource.evidenceReaderAgentIds.includes(target.agent_id) || !row.exportToAgentIds.includes(target.agent_id)) throw error('FORBIDDEN', '证据转交超出显式导出名单')
    const id = key('evidence-access', ref, target, work.instructionRevision, sourceCommandKey)
    if (!state.evidenceAccessReceipts.some(item => item.id === id)) state.evidenceAccessReceipts.push({ id, evidenceRef: structuredClone(ref), issuerBinding: binding(issuer), receiverBinding: target, receiverInstructionRevision: work.instructionRevision, reason, sourceCommandKey, sourceReceiptId: receipt.id, issuedAt: at })
  }
}
