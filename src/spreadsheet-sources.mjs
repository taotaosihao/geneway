import { isDeepStrictEqual } from 'node:util'
import { binding, error, exact, key, digest, sameBinding, attachmentRefs } from '../packages/agent-contracts/index.mjs'
import { sourceResultIds, SOURCE_MANIFEST_SCHEMA, SPREADSHEET_CANDIDATE_SCHEMA, compactSpreadsheetManifest, spreadsheetManifestRows, spreadsheetInputEncoding } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { ANALYSIS_RESULT_SCHEMA } from '../packages/agent-contracts/delegation.mjs'
import { authorizeMultisiteExecution, authorizeSpreadsheetSource } from './multisite-authorization.mjs'
import { assertEvidenceReader, evidenceBinding } from './evidence-access.mjs'
import { isCollaborationSpreadsheet, collaborationTemplateReference } from './spreadsheet-template.mjs'
export const emptySpreadsheetCollaborationState = () => ({ spreadsheetOutputBindings: [], sourceAdoptions: [], spreadsheetReads: [], spreadsheetReviews: [], userQuestions: [] })
const check = (condition, code = 'FORBIDDEN', message = '多来源表格来源尚未获准') => { if (!condition) throw error(code, message) }
export function currentOutput(state, work) {
  const value = state.spreadsheetOutputBindings.filter(row => row.workId === work.id).at(-1)
  check(value && value.instructionRevision <= work.instructionRevision)
  return value
}
export function bindSpreadsheetOutput(state, issuer, child, schema, namespace, at) {
  const work = state.works.find(row => row.id === issuer.work_id)
  if (!isCollaborationSpreadsheet(work.spreadsheetRequest) || schema !== SPREADSHEET_CANDIDATE_SCHEMA) return
  check(issuer.parent_delegation_id === null && issuer.agent_id === work.employeeId && child.grant.execution.capabilityIds.includes('office.xlsx.render.v1') && !child.grant.execution.capabilityIds.some(cap => cap.startsWith('evidence.')))
  const previous = state.spreadsheetOutputBindings.filter(row => row.workId === work.id).at(-1)
  if (previous) { const old = state.multisite.attempts.find(row => row.attempt_id === previous.outputBinding.attempt_id); check(previous.outputBinding.agent_id === child.agent_id && previous.instructionRevision < work.instructionRevision && ['completed', 'cancelled'].includes(old.status), 'INVALID_STATE', '已有当前产出职责') }
  state.spreadsheetOutputBindings.push({ id: key('spreadsheet-output', namespace), workId: work.id, instructionRevision: work.instructionRevision, coordinatorBinding: binding(issuer), outputBinding: evidenceBinding(child), sourceCommandKey: namespace, createdAt: at })
}
export function assertOutputProducer(state, execution, { completed = false } = {}) {
  const access = completed ? authorizeSpreadsheetSource(state, execution) : authorizeMultisiteExecution(state, execution)
  check(isCollaborationSpreadsheet(access.work.spreadsheetRequest) && sameBinding(currentOutput(state, access.work).outputBinding, execution))
  check(access.current.grant.execution.capabilityIds.includes('office.xlsx.render.v1'))
  return access
}
export function assertProducerInput(state, result) {
  const producer = state.multisite.attempts.find(row => sameBinding(row, result.senderBinding))
  check(producer && producer.status === 'completed' && producer.resultId === result.id && !result.historical)
  authorizeSpreadsheetSource(state, result.senderBinding)
  check(state.multisite.inputs.some(input => input.workId === result.workId && input.revision === result.instructionRevision && input.deliveries.some(delivery => delivery.attemptId === producer.attempt_id && delivery.sessionId === producer.session_id && delivery.ingestedAt)))
  check(!state.modelRequests.some(row => row.attempt_id === producer.attempt_id && row.outcome === 'unknown'), 'RUNTIME_REQUEST_UNKNOWN')
  return producer
}
function assertEvidenceSource(state, result, ref) {
  const producer = assertProducerInput(state, result), work = state.works.find(row => row.id === result.workId), row = state.evidence.find(row => row.id === ref.id && row.version === ref.version && row.sha256 === ref.sha256 && row.status === 'ready')
  check(row && row.workId === work.id && row.ownerMemberId === work.ownerMemberId && sameBinding(row.producerBinding, result.senderBinding) && row.instructionRevision === result.instructionRevision)
  const resource = state.resources.find(value => value.id === row.resourceId && value.enabled && value.revision === row.resourceRevision)
  check(resource && producer.resourceSnapshots.some(snapshot => snapshot.id === resource.id && snapshot.revision === resource.revision))
  return { row, resource }
}
function receivedResult(state, execution, result) {
  check(state.multisite.messages.some(row => row.kind === 'dependency_result' && row.resultRef === result.id && row.targetAttemptId === execution.attempt_id && row.sessionId === execution.session_id && row.ingestedAt && row.instructionRevision === result.instructionRevision), 'INPUT_CONSUMPTION_PENDING', '尚未实际消费来源回报')
}
function dueDateScopePreserved(state, work, fromRevision) {
  const revisions = state.multisite.inputs.filter(input => input.workId === work.id && input.revision > fromRevision && input.revision <= work.instructionRevision)
  return revisions.length === work.instructionRevision - fromRevision && revisions.every(input => input.revisionScope === 'due_date_only' && input.spreadsheetRequest?.templateId === work.spreadsheetRequest.templateId && !input.attachmentRefs.length)
}
export function adoptSpreadsheetSources(state, execution, parameters, namespace, at) {
  exact(parameters, ['clientRequestId', 'instructionRevision', 'sourceResultIds'])
  const { work, current } = assertOutputProducer(state, execution), ids = sourceResultIds(parameters.sourceResultIds)
  check(parameters.instructionRevision === work.instructionRevision && state.multisite.inputs.some(input => input.workId === work.id && input.revision === work.instructionRevision && input.deliveries.some(delivery => delivery.attemptId === current.attempt_id && delivery.sessionId === current.session_id && delivery.ingestedAt)), 'REVISION_CONFLICT')
  const sources = []
  for (const id of ids) {
    const result = state.multisite.results.find(row => row.id === id && row.workId === work.id), producer = result && assertProducerInput(state, result)
    check(producer && producer.parent_delegation_id === current.delegation_id && result.instructionRevision < work.instructionRevision && dueDateScopePreserved(state, work, result.instructionRevision), 'REVISION_CONFLICT', '仅明确的期限修订可采纳原来源；其它变化须重新委派')
    receivedResult(state, execution, result)
    for (const ref of result.payload.evidenceRefs) {
      check(ref.kind === 'evidence')
      const origin = result.schema === ANALYSIS_RESULT_SCHEMA ? state.multisite.results.find(row => row.workId === work.id && row.payload.evidenceRefs.some(item => isDeepStrictEqual(item, ref)) && row.schema !== ANALYSIS_RESULT_SCHEMA && sameBinding(row.senderBinding, state.evidence.find(item => item.id === ref.id)?.producerBinding)) : result
      check(origin && ids.includes(origin.id))
      const { row, resource } = assertEvidenceSource(state, origin, ref)
      const oldReceipt = state.evidenceAccessReceipts.find(item => isDeepStrictEqual(item.evidenceRef, ref) && sameBinding(item.receiverBinding, execution) && item.receiverInstructionRevision === result.instructionRevision)
      check(oldReceipt && resource.evidenceReaderAgentIds.includes(execution.agent_id) && row.exportToAgentIds.includes(execution.agent_id))
      sources.push({ resultId: id, ref, oldReceiptId: oldReceipt.id })
    }
  }
  const id = key('source-adoption', namespace), adoption = { id, workId: work.id, receiverBinding: binding(execution), instructionRevision: work.instructionRevision, sourceResultIds: ids, sourceCommandKey: namespace, sources: structuredClone(sources), createdAt: at }
  state.sourceAdoptions.push(adoption)
  for (const source of sources) {
    const receiptId = key('evidence-access', source.ref, binding(execution), work.instructionRevision, namespace)
    if (!state.evidenceAccessReceipts.some(row => row.id === receiptId)) state.evidenceAccessReceipts.push({ id: receiptId, evidenceRef: source.ref, issuerBinding: binding(execution), receiverBinding: binding(execution), receiverInstructionRevision: work.instructionRevision, reason: 'adoption', sourceCommandKey: namespace, sourceReceiptId: source.oldReceiptId, adoptionId: id, issuedAt: at })
  }
  return { workId: work.id, adoptionId: id, instructionRevision: work.instructionRevision, sourceResultIds: ids, status: 'adopted' }
}
export function buildSpreadsheetManifest(state, execution, resultIds, rows, { completed = false, inputEncodingVersion = 2 } = {}) {
  const { work, current, refs } = assertOutputProducer(state, execution, { completed }), ids = sourceResultIds(resultIds), input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === work.instructionRevision)
  check(input?.deliveries.some(row => row.attemptId === current.attempt_id && row.sessionId === current.session_id && row.ingestedAt), 'INPUT_CONSUMPTION_PENDING')
  const selected = ids.map(id => state.multisite.results.find(row => row.id === id && row.workId === work.id)), analysis = selected.filter(row => row?.schema === ANALYSIS_RESULT_SCHEMA)
  check(selected.every(Boolean) && analysis.length === 1, 'INVALID_REQUEST', '必须明确选择完整来源与一个独立分析回报')
  const sources = [], receiptIds = new Set(), adoptionIds = new Set()
  for (const result of selected) {
    const producer = assertProducerInput(state, result)
    check(producer.parent_delegation_id === current.delegation_id)
    receivedResult(state, execution, result)
    if (result.instructionRevision !== work.instructionRevision) {
      const adoption = state.sourceAdoptions.find(row => sameBinding(row.receiverBinding, execution) && row.instructionRevision === work.instructionRevision && row.sourceResultIds.includes(result.id))
      check(adoption && dueDateScopePreserved(state, work, result.instructionRevision), 'REVISION_CONFLICT'); adoptionIds.add(adoption.id)
    }
    if (result.schema === ANALYSIS_RESULT_SCHEMA) continue
    for (const ref of result.payload.evidenceRefs) {
      const { row } = assertEvidenceSource(state, result, ref), access = completed ? assertSpreadsheetEvidence(state, execution, work.instructionRevision, ref) : assertEvidenceReader(state, execution, work.instructionRevision, ref)
      receiptIds.add(access.receipt.id)
      check(!sources.some(source => source.ref.id === ref.id), 'INVALID_REQUEST', '来源重复')
      sources.push({ ref, resultId: result.id, producerBinding: binding(producer), producerRevision: result.instructionRevision, kind: row.kind, resourceId: row.resourceId, resourceRevision: row.resourceRevision, quality: row.quality, observedAt: row.observedAt, sourceTimestamp: row.sourceTimestamp, clockTrust: row.clockTrust, dataMode: row.dataMode })
    }
  }
  check(sources.some(row => row.kind === 'history') && sources.some(row => row.kind === 'site_snapshot'), 'INVALID_REQUEST', '历史与现场来源缺一不可')
  check(analysis[0].payload.evidenceRefs.length === sources.length && sources.every(row => analysis[0].payload.evidenceRefs.some(ref => isDeepStrictEqual(ref, row.ref))), 'INVALID_REQUEST', '分析来源范围必须与表格一致')
  for (const ref of analysis[0].payload.evidenceRefs) receiptIds.add((completed ? assertSpreadsheetEvidence(state, execution, work.instructionRevision, ref) : assertEvidenceReader(state, execution, work.instructionRevision, ref)).receipt.id)
  const photoRefs = refs.filter(ref => ['image/png', 'image/jpeg'].includes(state.attachments.find(row => row.id === ref.attachmentId)?.mediaType))
  for (const row of rows) { check(sources.some(source => source.kind === 'history' && isDeepStrictEqual(source.ref, row.sourceRef)) && row.dueDate === work.spreadsheetRequest.dueDate, 'INVALID_REQUEST'); for (const photo of attachmentRefs(row.photoRefs)) check(photoRefs.some(ref => isDeepStrictEqual(ref, photo)), 'INVALID_REQUEST') }
  check(photoRefs.every(ref => rows.some(row => row.photoRefs.some(photo => isDeepStrictEqual(ref, photo)))), 'INVALID_REQUEST', '照片引用范围不完整')
  const manifest = { schema: SOURCE_MANIFEST_SCHEMA, version: 1, workId: work.id, inputId: input.id, instructionRevision: work.instructionRevision, outputBinding: binding(execution), template: collaborationTemplateReference(), calculationVersion: 1, dueDate: work.spreadsheetRequest.dueDate, photoRefs, sources, analysis: { resultId: analysis[0].id, payloadDigest: analysis[0].payloadDigest, senderBinding: analysis[0].senderBinding, producerRevision: analysis[0].instructionRevision }, currentReceiptIds: [...receiptIds].sort(), adoptionIds: [...adoptionIds].sort(), sourceResultIds: ids, rows: structuredClone(rows) }
  if (![1, 2].includes(inputEncodingVersion)) throw error('INVALID_REQUEST')
  return inputEncodingVersion === 2 ? compactSpreadsheetManifest(manifest) : manifest
}
export function assertSpreadsheetEvidence(state, execution, revision, ref) {
  const access = authorizeSpreadsheetSource(state, execution), row = state.evidence.find(row => row.id === ref.id && row.version === ref.version && row.sha256 === ref.sha256 && row.status === 'ready'), resource = row && state.resources.find(item => item.id === row.resourceId && item.revision === row.resourceRevision && item.enabled), receipt = state.evidenceAccessReceipts.find(row => isDeepStrictEqual(row.evidenceRef, ref) && sameBinding(row.receiverBinding, execution) && row.receiverInstructionRevision === revision)
  check(row?.workId === access.work.id && row.ownerMemberId === access.owner.id && revision === access.work.instructionRevision && resource && receipt && resource.evidenceReaderAgentIds.includes(execution.agent_id) && row.exportToAgentIds.includes(execution.agent_id))
  return { ...access, row, resource, receipt }
}
export function validateSpreadsheetCandidate(state, execution, payload) {
  const { work } = assertOutputProducer(state, execution), artifact = state.artifacts.find(row => row.id === payload.candidateId), job = state.multisite.jobs.find(row => row.id === payload.jobId)
  check(artifact && job && sameBinding(artifact, execution) && sameBinding(job, execution) && artifact.jobId === job.id && artifact.status === 'candidate' && job.state === 'candidate' && artifact.instructionRevision === work.instructionRevision && artifact.candidateVerification?.manifestDigest === payload.manifestDigest && artifact.sha256 === payload.sha256 && artifact.version === payload.version && artifact.inputDigest === payload.inputDigest && job.sourceManifestDigest === payload.manifestDigest && isDeepStrictEqual(payload.sourceResultIds, job.sourceManifest.sourceResultIds), 'INVALID_REQUEST', '候选回报必须引用已经云核验的当前原Job与manifest')
  const manifest = buildSpreadsheetManifest(state, execution, payload.sourceResultIds, spreadsheetManifestRows(job.sourceManifest), { inputEncodingVersion: spreadsheetInputEncoding(job) })
  check(digest(manifest) === payload.manifestDigest && payload.evidenceRefs.length === manifest.sources.length && manifest.sources.every(row => payload.evidenceRefs.some(ref => isDeepStrictEqual(ref, row.ref))), 'INVALID_REQUEST')
  return { artifact, job, manifest }
}
export function assertCoordinatorCandidate(state, execution, candidateId) {
  const access = authorizeMultisiteExecution(state, execution), { work, current } = access
  check(isCollaborationSpreadsheet(work.spreadsheetRequest) && current.parent_delegation_id === null && current.agent_id === work.employeeId && current.grant.execution.capabilityIds.includes('collaboration.coordinate.v1'))
  const output = currentOutput(state, work), producer = state.multisite.attempts.find(row => sameBinding(row, output.outputBinding)), artifact = state.artifacts.find(row => row.id === candidateId && row.workId === work.id), job = artifact && state.multisite.jobs.find(row => row.id === artifact.jobId), result = producer && state.multisite.results.find(row => row.id === producer.resultId)
  check(artifact?.status === 'candidate' && artifact.candidateVerification && producer.status === 'completed' && result?.schema === SPREADSHEET_CANDIDATE_SCHEMA && result.instructionRevision === work.instructionRevision && result.payload.candidateId === artifact.id && result.payload.sha256 === artifact.sha256 && result.payload.manifestDigest === job?.sourceManifestDigest && sameBinding(artifact, producer) && artifact.instructionRevision === work.instructionRevision && job.state === 'candidate')
  receivedResult(state, execution, result)
  for (const attempt of [current, producer]) check(attempt.instruction_revision === work.instructionRevision && attempt.observed_revision >= work.instructionRevision && state.multisite.inputs.some(input => input.workId === work.id && input.revision === work.instructionRevision && input.deliveries.some(delivery => delivery.attemptId === attempt.attempt_id && delivery.sessionId === attempt.session_id && delivery.ingestedAt)), 'INPUT_CONSUMPTION_PENDING')
  const manifest = buildSpreadsheetManifest(state, binding(producer), job.sourceManifest.sourceResultIds, spreadsheetManifestRows(job.sourceManifest), { completed: true, inputEncodingVersion: spreadsheetInputEncoding(job) })
  check(digest(manifest) === job.sourceManifestDigest && isDeepStrictEqual(manifest, job.sourceManifest))
  for (const source of manifest.sources) assertEvidenceReader(state, execution, work.instructionRevision, source.ref)
  check(!state.multisite.questions.some(row => row.workId === work.id && row.state === 'open') && !state.userQuestions.some(row => row.workId === work.id && row.state === 'open') && !work.pendingQuestion, 'QUESTION_PENDING')
  check(!state.multisite.jobs.some(row => row.work_id === work.id && ['accepted', 'running', 'stopping', 'unknown'].includes(row.state)), 'JOBS_PENDING')
  check(!state.modelRequests.some(row => row.work_id === work.id && row.outcome === 'unknown'), 'RUNTIME_REQUEST_UNKNOWN')
  check(state.multisite.attempts.filter(row => row.work_id === work.id && row.attempt_id !== current.attempt_id).every(row => ['completed', 'cancelled'].includes(row.status)), 'DEPENDENCIES_PENDING')
  return { ...access, artifact, job, producer, result, manifest }
}
export function validateSpreadsheetCollaborationState(state) {
  for (const field of Object.keys(emptySpreadsheetCollaborationState())) check(Array.isArray(state[field]) && state[field].length <= 10000 && new Set(state[field].map(row => row.id)).size === state[field].length, 'INVALID_STATE')
  for (const row of state.spreadsheetOutputBindings) check(state.works.some(work => work.id === row.workId && isCollaborationSpreadsheet(work.spreadsheetRequest)) && state.multisite.attempts.some(attempt => sameBinding(evidenceBinding(attempt), row.outputBinding)) && state.multisite.commands.some(command => command.key === row.sourceCommandKey), 'INVALID_STATE')
  for (const row of state.sourceAdoptions) check(state.spreadsheetOutputBindings.some(output => output.workId === row.workId && sameBinding(output.outputBinding, row.receiverBinding)) && state.multisite.commands.some(command => command.key === row.sourceCommandKey) && row.sourceResultIds.every(id => state.multisite.results.some(result => result.id === id)), 'INVALID_STATE')
  for (const row of state.spreadsheetReads) {
    const artifact = state.artifacts.find(item => item.id === row.candidateId && item.sha256 === row.sha256 && item.manifestDigest === row.manifestDigest), command = state.multisite.commands.find(item => item.key === row.sourceCommandKey)
    check(artifact && row.work_id === artifact.workId && state.multisite.attempts.some(attempt => sameBinding(attempt, row)) && ['history', 'site', 'analysis', 'manifest'].includes(row.section) && Number.isSafeInteger(row.fromIndex) && Number.isSafeInteger(row.toIndex) && row.fromIndex >= 0 && row.toIndex >= row.fromIndex && row.toIndex <= row.totalCells && command?.reply.readReceiptId === row.id && digest(command.reply) === row.pageDigest && sameBinding(command.senderBinding, row), 'INVALID_STATE')
  }
  for (const row of state.spreadsheetReviews) {
    const artifact = state.artifacts.find(item => item.id === row.candidateId && item.sha256 === row.sha256 && item.manifestDigest === row.manifestDigest), command = state.multisite.commands.find(item => item.key === row.sourceCommandKey)
    check(artifact?.status === 'ready' && command?.reply.reviewId === row.id && sameBinding(command.senderBinding, row) && row.readReceiptIds.length > 0 && row.readReceiptIds.every(id => state.spreadsheetReads.some(read => read.id === id && sameBinding(read, row) && read.candidateId === row.candidateId && read.instructionRevision === row.instructionRevision)), 'INVALID_STATE')
  }
  for (const row of state.userQuestions) {
    check(['open', 'answered', 'superseded', 'cancelled'].includes(row.state) && state.multisite.receipts.some(receipt => receipt.event.event_id === row.sourceEventId && receipt.event.kind === 'report' && sameBinding(receipt.event, row.askingBinding)) && state.multisite.inputs.some(input => input.id === row.inputId && input.workId === row.workId && input.revision === row.instructionRevision), 'INVALID_STATE')
    if (row.state === 'answered') check(state.multisite.inputs.some(input => input.id === row.answeredByInputId && input.workId === row.workId && input.revision === row.instructionRevision + 1), 'INVALID_STATE')
  }
  return state
}
export function assertSpreadsheetCollaborationImmutable(before, after) { for (const name of ['spreadsheetOutputBindings', 'sourceAdoptions', 'spreadsheetReads', 'spreadsheetReviews']) check(isDeepStrictEqual(before[name], after[name].slice(0, before[name].length)), 'INVALID_STATE'); for (const row of before.userQuestions) { const next = after.userQuestions.find(item => item.id === row.id), fixed = value => value && { ...value, state: undefined, closedAt: undefined, answeredByInputId: undefined }; check(isDeepStrictEqual(fixed(row), fixed(next)), 'INVALID_STATE'); if (row.state !== 'open') check(isDeepStrictEqual(row, next), 'INVALID_STATE') } }

export function assertCandidatePageContext(state, execution, read) {
  const access = authorizeMultisiteExecution(state, execution), artifact = state.artifacts.find(row => row.id === read.candidateId && row.workId === access.work.id && row.sha256 === read.sha256 && row.manifestDigest === read.manifestDigest && row.candidateVerification), job = artifact && state.multisite.jobs.find(row => row.id === artifact.jobId)
  check(job && sameBinding(read, execution))
  for (const source of job.sourceManifest.sources) {
    const result = state.multisite.results.find(row => row.id === source.resultId); const { row, resource } = assertEvidenceSource(state, result, source.ref)
    check(resource.evidenceReaderAgentIds.includes(execution.agent_id) && row.exportToAgentIds.includes(execution.agent_id) && state.evidenceAccessReceipts.some(receipt => isDeepStrictEqual(receipt.evidenceRef, source.ref) && sameBinding(receipt.receiverBinding, execution) && receipt.receiverInstructionRevision === read.instructionRevision))
  }
  assertProducerInput(state, state.multisite.results.find(row => row.id === job.sourceManifest.analysis.resultId))
  return true
}
