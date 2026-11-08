import { error } from '../agent-contracts/index.mjs'
import { createSpreadsheetJobs } from './spreadsheet-jobs.mjs'
import { join } from 'node:path'
import { createAgentHost } from './host.mjs'
import { createHostJournal } from './journal.mjs'
import { createProcessRuntime } from './process-runtime.mjs'

export function createLocalAgentHost({ root, config, gateway, gatewayOrigin, spreadsheetService, spreadsheetArtifacts, nodeId = 'local', workspaceId = 'local' }) {
  const journal = createHostJournal(join(config.dataRoot, `multisite-host-${nodeId}.json`))
  const jobs = spreadsheetService ? createSpreadsheetJobs({ journal, root: join(config.dataRoot, 'spreadsheet-jobs'), evidenceService: spreadsheetService, workspaceId, nodeId }) : undefined
  const runtime = createProcessRuntime({ root, config, gateway, gatewayOrigin })
  async function uploadCandidates() {
    if (!jobs || !spreadsheetArtifacts) return
    const state = await journal.read()
    for (const job of state.jobs.filter(row => row.state === 'candidate' && state.executions.some(execution => execution.launch_id === row.launch_id && execution.status === 'running'))) {
      try {
        const issued = await spreadsheetArtifacts.issueUploadToken(job)
        if (issued.artifact) continue
        const candidate = await jobs.readCandidate(job.id), headers = { authorization: `Bearer ${issued.token}` }
        const init = await fetch(new URL('/internal/artifacts/candidates/init', gatewayOrigin()), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, redirect: 'error', body: JSON.stringify({ jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.job.output.sizeBytes }) })
        const metadata = await init.json()
        if (!init.ok) throw error(metadata.error?.code ?? 'ARTIFACT_UPLOAD_UNAVAILABLE')
        const uploaded = await fetch(new URL(`/internal/artifacts/candidates/${metadata.id}/${metadata.status === 'candidate' ? 'verify' : 'content'}`, gatewayOrigin()), { method: metadata.status === 'candidate' ? 'POST' : 'PUT', headers: { ...headers, 'content-type': metadata.status === 'candidate' ? 'application/json' : 'application/octet-stream' }, redirect: 'error', body: metadata.status === 'candidate' ? '{}' : candidate.bytes })
        const result = await uploaded.json()
        if (!uploaded.ok) throw error(result.error?.code ?? 'ARTIFACT_UPLOAD_UNAVAILABLE')
      } catch (cause) {
        // Projection and input receipts may lag the parent's sealed candidate; retry this Job.
        if (!['JOB_PROJECTION_PENDING', 'INPUT_CONSUMPTION_PENDING', 'QUESTION_PENDING', 'JOBS_PENDING', 'FORBIDDEN', 'REVISION_CONFLICT', 'SPREADSHEET_VERIFICATION_FAILED', 'RUNTIME_REQUEST_UNKNOWN'].includes(cause.code)) throw cause
      }
    }
  }
  return createAgentHost({ nodeId, workspaceId, runtime, jobs, journal, uploadCandidates })
}
