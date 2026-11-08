import { isDeepStrictEqual } from 'node:util'
import { sameBinding, error, key } from '../packages/agent-contracts/index.mjs'
import { evidenceRef, evidenceReaders, evidenceDeclaration, evidenceDeclarationDigest, hashValue, timestamp } from '../packages/agent-contracts/evidence.mjs'

export const emptyEvidenceState = () => ({ evidence: [], evidenceAccessReceipts: [] })
const check = condition => { if (!condition) throw error('INVALID_STATE', 'Evidence 持久事实无效') }
const fixed = row => Object.fromEntries(Object.entries(row).filter(([field]) => !['status', 'receivedAt', 'quality'].includes(field)))
export function validateEvidenceState(state) {
  for (const name of Object.keys(emptyEvidenceState())) check(Array.isArray(state[name]) && state[name].length <= 10000 && new Set(state[name].map(row => row.id)).size === state[name].length)
  for (const row of state.evidence) {
    evidenceRef({ kind: 'evidence', id: row.id, version: row.version, sha256: row.sha256 }); evidenceReaders(row.exportToAgentIds)
    check(['pending', 'ready'].includes(row.status) && ['history', 'site_snapshot'].includes(row.kind) && row.mediaType === 'application/json' && row.dataMode === 'fixture' && hashValue(row.sourceSha256) && row.sizeBytes > 0 && row.sizeBytes <= 65536 && Number.isSafeInteger(row.instructionRevision) && Number.isSafeInteger(row.profileVersion) && timestamp(row.observedAt) && (row.sourceTimestamp === null || timestamp(row.sourceTimestamp)))
    check(state.works.some(work => work.id === row.workId && work.ownerMemberId === row.ownerMemberId) && row.producerBinding.work_id === row.workId && state.multisite.attempts.some(attempt => sameBinding(attempt, row.producerBinding, { firstSession: attempt.session_id === null })))
    if (row.status === 'ready') check(timestamp(row.receivedAt))
    if (row.captureFormatVersion !== undefined) check(row.captureFormatVersion === 2 && hashValue(row.profileDigest) && row.declarationDigest === evidenceDeclarationDigest(evidenceDeclaration({ ...row, id: row.id.slice('evidence-'.length), snapshotSha256: row.sha256 })))
  }
  for (const row of state.evidenceAccessReceipts) {
    evidenceRef(row.evidenceRef)
    check(Number.isSafeInteger(row.receiverInstructionRevision) && row.receiverInstructionRevision > 0 && timestamp(row.issuedAt))
    const evidence = state.evidence.find(item => item.status === 'ready' && item.id === row.evidenceRef.id && item.sha256 === row.evidenceRef.sha256)
    const receiver = state.multisite.attempts.find(item => sameBinding(item, row.receiverBinding, { firstSession: item.session_id === null }) && item.work_id === evidence?.workId)
    check(evidence && receiver)
    if (row.reason === 'publisher_self') check(sameBinding(row.issuerBinding, row.receiverBinding) && sameBinding(evidence.producerBinding, row.issuerBinding))
    else {
      const source = state.evidenceAccessReceipts.find(item => item.id === row.sourceReceiptId)
      check(['delegate', 'result', 'share', 'adoption'].includes(row.reason) && source && isDeepStrictEqual(source.evidenceRef, row.evidenceRef) && sameBinding(source.receiverBinding, row.issuerBinding))
      check(state.multisite.commands.some(command => command.key === row.sourceCommandKey && command.issuerKind === 'agent' && sameBinding(command.senderBinding, row.issuerBinding)))
      if (row.reason === 'adoption') check(state.sourceAdoptions.some(adoption => adoption.id === row.adoptionId && adoption.sourceCommandKey === row.sourceCommandKey && sameBinding(adoption.receiverBinding, row.receiverBinding) && adoption.instructionRevision === row.receiverInstructionRevision && adoption.sources.some(item => item.oldReceiptId === row.sourceReceiptId && isDeepStrictEqual(item.ref, row.evidenceRef))))
      check(row.id === key('evidence-access', row.evidenceRef, row.receiverBinding, row.receiverInstructionRevision, row.sourceCommandKey))
    }
  }
  return state
}
export function assertEvidenceImmutable(before, after) {
  for (const row of before.evidence) {
    const next = after.evidence.find(item => item.id === row.id)
    check(next && isDeepStrictEqual(fixed(row), fixed(next)))
    if (row.status === 'ready') check(isDeepStrictEqual(row, next))
  }
  check(isDeepStrictEqual(before.evidenceAccessReceipts, after.evidenceAccessReceipts.slice(0, before.evidenceAccessReceipts.length)))
}
