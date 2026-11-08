import { assertTerminalEventEnvelope } from '../packages/agent-contracts/terminal-proof.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertSealed, binding, key, sameBinding } from '../packages/agent-contracts/index.mjs'

// This gate only admits the original late stopping/stopped Job metadata. A
// committed terminal proof cannot grant another execution, output or upload.
export function stoppedJobHistory(state, authenticated, event) {
  if (event.kind !== 'spreadsheet_job' || !['stopping','stopped'].includes(event.job?.state)) return false
  const attempt = state.multisite.attempts.find(row => row.attempt_id === event.attempt_id)
  if (!attempt || !['cancelled','completed'].includes(attempt.status) || !sameBinding(attempt, event)) return false
  const job = state.multisite.jobs.find(row => row.id === event.job.id && sameBinding(row, event))
  if (!job || job.state === 'stopped' || event.job.sequence !== job.sequence + 1 || job.inputDigest !== event.job.inputDigest || job.requestDigest !== event.job.requestDigest
    || !isDeepStrictEqual(event.job.output, job.output) || event.job.state === 'stopped' && job.state !== 'stopping'
    || event.job.state === 'stopping' && !isDeepStrictEqual(event.job.stopEvidence, job.stopEvidence)) return false
  for (const receipt of state.multisite.receipts) {
    const proof = receipt.event
    if (receipt.historical || receipt.nodeId !== authenticated.nodeId || proof.node_id !== authenticated.nodeId || !['stopped','settled'].includes(proof.kind) || !sameBinding(proof, event)) continue
    const command = state.multisite.outbox.find(row => row.acceptedAt && ['cancel','settle'].includes(row.command.operation)
      && row.command.command_id && key('event', authenticated.nodeId, row.command.command_id, proof.kind) === proof.event_id
      && (row.command.operation === 'cancel' ? proof.kind === 'stopped' : proof.kind === 'settled')
      && sameBinding(row.command, proof, { firstSession: row.command.session_id === null }))
    if (!command || !['idle_after_cancel','never_started'].includes(proof.stop_evidence ?? proof.settle_evidence)) continue
    const expectedAck = { event_id: proof.event_id, node_id: proof.node_id, payload_digest: proof.payload_digest, ...binding(proof) }
    if (!isDeepStrictEqual(receipt.ack, expectedAck)) continue
    const item = (proof.job_stop_evidence ?? proof.job_settle_evidence ?? []).find(item => item.jobId === job.id)
    if (!item) continue
    try { assertTerminalEventEnvelope(proof); assertSealed(command.command) } catch { continue }
    const { jobId, ...stopEvidence } = item
    if (event.job.state === 'stopped' && !isDeepStrictEqual(event.job.stopEvidence, stopEvidence)) continue
    return true
  }
  return false
}
