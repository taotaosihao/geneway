import { COLLABORATION_TEMPLATE_ID, SOURCE_MANIFEST_SCHEMA, SOURCE_MANIFEST_SCHEMA_V2, spreadsheetManifestRows, spreadsheetInputEncoding } from './spreadsheet-collaboration.mjs'
import { digest, sameBinding, binding, key, seal, SCHEMA } from './index.mjs'
import { attachmentRefs, BINDING_FIELDS, error, exact, text } from './index.mjs'

// Office payloads have a separate transport bound; the ordinary Bridge stays small.
export const SPREADSHEET_JSON_LIMIT = 4 * 1024 * 1024
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const check = condition => { if (!condition) throw error('INVALID_REQUEST', '表格 Job 投影无效') }
const date = value => typeof value === 'string' && value.length <= 27 && Number.isFinite(Date.parse(value))
export function assertSpreadsheetRows(rows) {
  check(Array.isArray(rows) && rows.length <= 1600)
  for (const row of rows) {
    exact(row, ['sourceRef', 'entryIndex', 'dueDate', 'photoRefs'])
    attachmentRefs([row.sourceRef]); attachmentRefs(row.photoRefs)
    check(Number.isSafeInteger(row.entryIndex) && row.entryIndex >= 0 && row.entryIndex < 200 && typeof row.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.dueDate))
  }
}
export function assertSpreadsheetJobProjection(job) {
  exact(job, [...BINDING_FIELDS, 'id', 'clientRequestId', 'requestDigest', 'instructionRevision', 'template', 'historyRefs', 'inputDigest', 'outputKind', 'state', 'sequence', 'acceptedAt', 'updatedAt', 'startedAt', 'output', 'reason', 'stopEvidence', 'launchState', 'rows', ...(job.template?.id === COLLABORATION_TEMPLATE_ID ? ['sourceManifest', 'sourceManifestDigest', 'inputEncodingVersion'] : [])])
  for (const field of BINDING_FIELDS.filter(field => !['parent_delegation_id', 'execution_epoch'].includes(field))) text(job[field])
  check(job.parent_delegation_id === null || typeof job.parent_delegation_id === 'string' && job.parent_delegation_id.length <= 16000)
  check(Number.isSafeInteger(job.execution_epoch) && job.execution_epoch > 0 && /^[a-f0-9]{32}$/.test(job.id) && /^[A-Za-z0-9._:-]{1,128}$/.test(job.clientRequestId) && hash(job.requestDigest) && hash(job.inputDigest))
  exact(job.template, ['id', 'version', 'sha256'])
  check(['incident-register-v1', COLLABORATION_TEMPLATE_ID].includes(job.template.id) && job.template.version === 1 && hash(job.template.sha256))
  attachmentRefs(job.historyRefs); if (job.template.id === COLLABORATION_TEMPLATE_ID) { const rows = spreadsheetManifestRows(job.sourceManifest), encoding = spreadsheetInputEncoding(job); check(encoding === 2 ? job.sourceManifest.schema === SOURCE_MANIFEST_SCHEMA_V2 && !Object.hasOwn(job, 'rows') : job.sourceManifest.schema === SOURCE_MANIFEST_SCHEMA && digest(job.rows) === digest(rows)); check(digest(job.sourceManifest) === job.sourceManifestDigest && sameBinding(job.sourceManifest.outputBinding, job) && job.sourceManifest.instructionRevision === job.instructionRevision) } else assertSpreadsheetRows(job.rows)
  check(Number.isSafeInteger(job.instructionRevision) && job.instructionRevision > 0 && Number.isSafeInteger(job.sequence) && job.sequence > 0 && job.outputKind === job.template.id)
  check(['accepted', 'running', 'candidate', 'stopping', 'stopped', 'unknown', 'failed'].includes(job.state) && ['not_started', 'reserved', 'worker_identified', 'never_started'].includes(job.launchState))
  check(date(job.acceptedAt) && date(job.updatedAt) && (job.startedAt === null || date(job.startedAt)) && (job.reason === null || typeof job.reason === 'string' && job.reason.length <= 16000))
  if (job.output !== null) {
    exact(job.output, ['name', 'mediaType', 'sizeBytes', 'sha256'])
    check(job.output.name === 'incident-register.xlsx' && job.output.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && hash(job.output.sha256) && Number.isSafeInteger(job.output.sizeBytes) && job.output.sizeBytes > 0 && job.output.sizeBytes <= 10 * 1024 * 1024)
  }
  if (job.stopEvidence !== null) {
    exact(job.stopEvidence, ['workerExit', 'output', 'temporaryFiles'])
    check(['exit_confirmed', 'never_started'].includes(job.stopEvidence.workerExit) && ['verified_candidate', 'no_published_output'].includes(job.stopEvidence.output) && Array.isArray(job.stopEvidence.temporaryFiles) && job.stopEvidence.temporaryFiles.length <= 32)
    for (const file of job.stopEvidence.temporaryFiles) { exact(file, ['name', 'sizeBytes']); check(typeof file.name === 'string' && file.name.length <= 255 && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0) }
  }
  return job
}

export function spreadsheetJobProjection(job) {
  const { input, worker, workerExitConfirmedAt, ...value } = job
  return { ...structuredClone(value), ...(input.inputEncodingVersion === 2 ? {} : { rows: structuredClone(input.rows) }), ...(input.sourceManifest ? { sourceManifest: structuredClone(input.sourceManifest), sourceManifestDigest: input.sourceManifestDigest } : {}) }
}
export function spreadsheetJobEvent(job, workspaceId) {
  return seal({ schema: SCHEMA, event_id: key('spreadsheet-job-event', job.node_id, job.id, job.sequence), workspace_id: workspaceId, kind: 'spreadsheet_job', ...binding(job), input_id: job.input.inputId, instruction_revision: job.instructionRevision, observed_revision: 0, job: spreadsheetJobProjection(job) })
}
export function assertSpreadsheetDeliverySize(execution, parameters, prepared, workspaceId) {
  const bytes = value => Buffer.byteLength(JSON.stringify(value))
  if (bytes({ binding: binding(execution), parameters }) > SPREADSHEET_JSON_LIMIT || bytes(prepared) > SPREADSHEET_JSON_LIMIT) throw error('COMMAND_TOO_LARGE', '完整表格请求或响应超过 Office 传输上限，资料未截断')
  const at = '+275760-09-13T00:00:00.000Z', input = prepared.input
  const preview = { id: key('spreadsheet-job', binding(execution), parameters.clientRequestId), ...binding(execution), clientRequestId: parameters.clientRequestId, requestDigest: digest(parameters), instructionRevision: input.instructionRevision, template: input.template, historyRefs: input.historyRefs, inputDigest: prepared.inputDigest, inputEncodingVersion: 2, input, outputKind: input.template.id, state: 'candidate', sequence: Number.MAX_SAFE_INTEGER, acceptedAt: at, updatedAt: at, startedAt: at, worker: null, output: { name: 'incident-register.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 10 * 1024 * 1024, sha256: 'f'.repeat(64) }, reason: '\u0000'.repeat(16000), stopEvidence: { workerExit: 'exit_confirmed', output: 'no_published_output', temporaryFiles: Array.from({ length: 32 }, () => ({ name: '\u0000'.repeat(255), sizeBytes: Number.MAX_SAFE_INTEGER })) }, launchState: 'worker_identified' }
  const event = spreadsheetJobEvent(preview, workspaceId)
  assertSpreadsheetJobProjection(event.job)
  if (bytes({ event }) > SPREADSHEET_JSON_LIMIT) throw error('COMMAND_TOO_LARGE', '后续完整 Job 回执超过 Office 传输上限，未受理生成任务')
  return { requestBytes: bytes({ binding: binding(execution), parameters }), responseBytes: bytes(prepared), jobEventUpperBytes: bytes({ event }) }
}
