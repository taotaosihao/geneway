import { error } from '../agent-contracts/index.mjs'

// This parent-only adapter uploads original sealed bytes; it never regenerates a Job.
export function createSpreadsheetUploader({ journal, jobs, issueUploadToken, origin, onError = () => {} }) {
  return async function uploadCandidates() {
    const state = await journal.read()
    for (const job of state.jobs.filter(row => row.state === 'candidate' && state.executions.some(execution => execution.launch_id === row.launch_id && execution.status === 'running'))) {
      try {
        const issued = await issueUploadToken(job)
        if (issued.artifact) continue
        const candidate = await jobs.readCandidate(job.id), headers = { authorization: `Bearer ${issued.token}` }
        async function request(path, method, contentType, body) {
          const response = await fetch(new URL(path, origin), { method, headers: { ...headers, 'content-type': contentType }, redirect: 'error', body, signal: AbortSignal.timeout(30_000) })
          const value = await response.json()
          if (!response.ok) throw error(value.error?.code ?? 'ARTIFACT_UPLOAD_UNAVAILABLE')
          return value
        }
        const metadata = await request('/internal/artifacts/candidates/init', 'POST', 'application/json', JSON.stringify({ jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.job.output.sizeBytes }))
        await request(`/internal/artifacts/candidates/${metadata.id}/${metadata.status === 'candidate' ? 'verify' : 'content'}`, metadata.status === 'candidate' ? 'POST' : 'PUT', metadata.status === 'candidate' ? 'application/json' : 'application/octet-stream', metadata.status === 'candidate' ? '{}' : candidate.bytes)
      } catch (cause) {
        // Job and input receipts can arrive after the sealed local candidate.
        if (!['JOB_PROJECTION_PENDING', 'INPUT_CONSUMPTION_PENDING', 'QUESTION_PENDING', 'JOBS_PENDING', 'FORBIDDEN', 'REVISION_CONFLICT', 'SPREADSHEET_VERIFICATION_FAILED', 'RUNTIME_REQUEST_UNKNOWN'].includes(cause.code)) onError(cause)
      }
    }
  }
}
