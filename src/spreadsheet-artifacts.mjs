import { spreadsheetManifestRows, spreadsheetInputEncoding } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { assertRequiredMessagesConsumed } from '../packages/agent-orchestration/conversations.mjs'
import { createSpreadsheetCandidateReader, spreadsheetCells } from './spreadsheet-candidate-read.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { createSpreadsheetCollaborationService } from './spreadsheet-collaboration-service.mjs'
import { assertManualExecution, manualFence } from './manual-control.mjs'
import { assertOutputProducer, validateSpreadsheetCandidate, assertCoordinatorCandidate } from './spreadsheet-sources.mjs'
import { isCollaborationSpreadsheet, collaborationTemplateReference } from './spreadsheet-template.mjs'
import { budgetTokenExpiry, assertWorkBudget } from './work-budget.mjs'
import { assertSpreadsheetAuthority } from '../packages/agent-contracts/tools.mjs'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createArtifactFiles } from './artifact-files.mjs'
import { inspectSpreadsheetArchive, verifyIncidentSpreadsheet } from './spreadsheet-verification.mjs'
import { templateReference } from './spreadsheet-template.mjs'
import { authorizeMultisiteExecution, authorizeReadyArtifactRead, authorizeOwnedReadyArtifactRead } from './multisite-authorization.mjs'
import { attachmentRefs, binding, digest, error, exact, key, sameBinding, SCHEMA, seal } from '../packages/agent-contracts/index.mjs'

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const fail = (code, message = code, status) => Object.assign(error(code, message), { status })
const safeArtifact = row => ({ id: row.id, version: row.version, workId: row.workId, jobId: row.jobId, name: row.name, mediaType: row.mediaType, sizeBytes: row.sizeBytes, sha256: row.sha256, status: row.status, instructionRevision: row.instructionRevision, verification: row.verification, ...(row.candidateVerification ? { candidateVerification: row.candidateVerification, manifestDigest: row.manifestDigest } : {}), rejectionReason: row.rejectionReason })
export function createSpreadsheetArtifacts({ store, attachments, gateway, evidence, root, clock = () => Date.now(), tokenTtlMs = 5 * 60_000, fsOps = {}, verification = verifyIncidentSpreadsheet }) {
  const files = createArtifactFiles({ root, fsOps, validate: bytes => inspectSpreadsheetArchive(bytes, { allowCollaboration: true }) }), tokens = new Map(), pending = new Map()
  const reader = createSpreadsheetCandidateReader({ store, readBytes: row => files.read(row, { sync: true }), clock })
  const collaboration = createSpreadsheetCollaborationService({ store, attachments, evidence })
  function authorizeReady(state, source, artifact) {
    const { current, work } = authorizeMultisiteExecution(state, source, { allowCompleted: true })
    assertSpreadsheetAuthority(current)
    if (artifact.status !== 'ready' || !sameBinding(artifact, source) || current.status !== 'completed' || work.status !== 'completed' || artifact.instructionRevision !== work.instructionRevision || !work.artifactRefs?.some(ref => ref.artifactId === artifact.id && ref.sha256 === artifact.sha256 && ref.version === artifact.version)) throw fail('FORBIDDEN', '成果回执当前不可读取', 403)
    return safeArtifact(artifact)
  }
  async function readyReceipt(source, id) {
    // Call after body/file I/O: ready is an immutable receipt, not an authority bypass.
    const state = await store.read(), artifact = state.artifacts.find(row => row.id === id)
    if (source.purpose === 'artifact_upload') assertManualExecution(state, source, source.manualFence)
    if (!artifact) throw fail('NOT_FOUND', '成果不存在', 404)
    return authorizeReady(state, source, artifact)
  }
  function candidate(state, id) {
    const job = state.multisite.jobs.find(row => row.id === id)
    if (!job || !job.output) throw fail('JOB_PROJECTION_PENDING', '等待已封存的 Job 候选回执', 409)
    return job
  }
  function eligibility(state, source, { consumed = false } = {}) {
    if (source.purpose === 'artifact_upload') assertManualExecution(state, source, source.manualFence)
    const { current, work, owner, refs } = authorizeMultisiteExecution(state, source)
    assertSpreadsheetAuthority(current)
    if (isCollaborationSpreadsheet(work.spreadsheetRequest)) assertOutputProducer(state, source)
    const job = candidate(state, source.jobId ?? source.id)
    if (!sameBinding(job, source) || job.state !== 'candidate' || work.instructionRevision !== job.instructionRevision || current.instruction_revision !== job.instructionRevision) throw fail('REVISION_CONFLICT', '候选已不属于当前资料版本', 409)
    const input = state.multisite.inputs.find(row => row.id === job.inputId && row.workId === work.id && row.revision === job.instructionRevision), request = input?.spreadsheetRequest
    if (!request?.dueDate || !isDeepStrictEqual(request, work.spreadsheetRequest) || !isDeepStrictEqual(job.template, isCollaborationSpreadsheet(work.spreadsheetRequest) ? collaborationTemplateReference() : templateReference()) || job.template.sha256 !== request.templateSha256 || !(isCollaborationSpreadsheet(work.spreadsheetRequest) ? Array.isArray(spreadsheetManifestRows(job.sourceManifest)) : Array.isArray(job.rows))) throw fail('INVALID_STATE', '候选缺少可信用户要求', 409)
    if (work.modelRequestBudget.exhaustedAt || work.status === 'failed') throw fail('BUDGET_EXHAUSTED', '本工作已不能继续交付', 409)
    if (consumed && state.modelRequests.some(row => sameBinding(row, source) && row.outcome === 'unknown')) throw fail('RUNTIME_REQUEST_UNKNOWN', '模型请求结果待核对', 409)
    if (consumed && (current.observed_revision < input.revision || (isCollaborationSpreadsheet(work.spreadsheetRequest) ? !input.deliveries.some(row => row.attemptId === current.attempt_id && row.ingestedAt && row.sessionId === current.session_id) : !input.deliveries.every(row => row.ingestedAt && row.sessionId === current.session_id)))) throw fail('INPUT_CONSUMPTION_PENDING', '等待用户输入消费回执', 409)
    if (consumed && work.pendingQuestion) throw fail('QUESTION_PENDING', '等待用户补充问题', 409)
    if (consumed && state.multisite.jobs.some(row => row.work_id === work.id && row.instructionRevision === job.instructionRevision && row.state === 'failed')) throw fail('JOB_FAILED', '生成请求存在未解决的失败', 409)
    if (consumed && state.multisite.jobs.some(row => row.work_id === work.id && ['accepted', 'running', 'stopping', 'unknown'].includes(row.state))) throw fail('JOBS_PENDING', '等待本工作生成进程结束或核对', 409)
    return { current, work, owner, refs, input, request, job }
  }
  async function requirements(state, source) {
    if (isCollaborationSpreadsheet(state.works.find(work => work.id === source.work_id)?.spreadsheetRequest)) { const access = eligibility(state, source), prepared = await collaboration.prepare(source, { clientRequestId: access.job.clientRequestId, instructionRevision: access.job.instructionRevision, template: access.job.template, sourceResultIds: access.job.sourceManifest.sourceResultIds, rows: spreadsheetManifestRows(access.job.sourceManifest) }, { inputEncodingVersion: spreadsheetInputEncoding(access.job), job: { id: access.job.id, inputDigest: access.job.inputDigest } }); if (prepared.inputDigest !== access.job.inputDigest || prepared.input.sourceManifestDigest !== access.job.sourceManifestDigest) throw error('SPREADSHEET_VERIFICATION_FAILED', '云端来源重建摘要不一致'); return { value: prepared.input, access } }
    const access = eligibility(state, source), expected = access.refs.filter(ref => state.attachments.find(file => file.id === ref.attachmentId)?.mediaType === 'application/json')
    if (!isDeepStrictEqual(expected, access.job.historyRefs)) throw error('SPREADSHEET_VERIFICATION_FAILED', '历史资料范围不完整')
    const evidence = []
    for (const sourceRef of expected) { const file = await attachments.download(access.owner, sourceRef.attachmentId); evidence.push({ sourceRef, entries: JSON.parse(file.bytes.toString('utf8')).entries }) }
    for (const row of access.job.rows) {
      if (row.dueDate !== access.request.dueDate) throw error('SPREADSHEET_VERIFICATION_FAILED', '期限不是当前用户要求')
      for (const ref of attachmentRefs(row.photoRefs)) if (!access.refs.some(item => isDeepStrictEqual(item, ref)) || !['image/png', 'image/jpeg'].includes(state.attachments.find(file => file.id === ref.attachmentId)?.mediaType)) throw error('SPREADSHEET_VERIFICATION_FAILED', '照片范围不匹配')
    }
    await attachments.verifyReferences(state, access.refs)
    const value = { inputId: access.input.id, instructionRevision: access.input.revision, template: access.job.template, calculationVersion: access.request.calculationVersion, dueDate: access.request.dueDate, historyRefs: expected, evidence, rows: access.job.rows }
    if (digest(value) !== access.job.inputDigest) throw error('SPREADSHEET_VERIFICATION_FAILED', '受控输入摘要不符')
    return { value, access }
  }
  function token(request) {
    const raw = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1], value = tokens.get(raw)
    if (!value || value.purpose !== 'artifact_upload' || clock() >= value.expiresAt) throw fail('UNAUTHORIZED', '成果上传令牌无效或已过期', 401)
    return value
  }
  async function init(record, parameters) {
    exact(parameters, ['jobId', 'version', 'sha256', 'sizeBytes'])
    if (parameters.jobId !== record.jobId || parameters.version !== 1) throw fail('FORBIDDEN', '成果上传绑定不符', 403)
    let result
    await store.update(state => {
      assertManualExecution(state, record, record.manualFence)
      const ready = state.artifacts.find(row => row.jobId === record.jobId && row.status === 'ready')
      if (ready) {
        authorizeReady(state, record, ready)
        if (ready.sha256 !== parameters.sha256 || ready.sizeBytes !== parameters.sizeBytes) throw fail('INVALID_REQUEST', '成果声明与已封存候选不符', 400)
        result = ready; return state
      }
      const access = eligibility(state, record)
      if (clock() >= record.expiresAt || access.job.output.sha256 !== parameters.sha256 || access.job.output.sizeBytes !== parameters.sizeBytes) throw fail('INVALID_REQUEST', '成果声明与已封存候选不符', 400)
      const id = 'artifact-' + key('spreadsheet-artifact', record.jobId, 1), old = state.artifacts.find(row => row.id === id)
      if (old) { result = old; return state }
      result = { id, ...binding(record), workspaceId: access.work.workspaceId, ownerMemberId: access.owner.id, workId: access.work.id, jobId: record.jobId, instructionRevision: access.job.instructionRevision, template: access.job.template, historyRefs: access.job.historyRefs, inputDigest: access.job.inputDigest, name: '异常整改台账.xlsx', mediaType: MIME, sizeBytes: parameters.sizeBytes, sha256: parameters.sha256, version: 1, status: 'pending', initializedAt: new Date(clock()).toISOString(), candidateAt: null, verification: null, rejectionReason: null, ...(access.job.sourceManifest ? { manifestDigest: access.job.sourceManifestDigest } : {}) }
      state.artifacts.push(result); return state
    })
    return safeArtifact(result)
  }
  async function upload(record, id, source) {
    const previous = pending.get(id) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const state = await store.read(), artifact = state.artifacts.find(row => row.id === id && row.jobId === record.jobId)
      if (!artifact || !sameBinding(record, artifact)) throw fail('NOT_FOUND', '成果不存在', 404)
      if (artifact.status === 'ready') { await files.read(artifact, { sync: true }); return readyReceipt(record, id) }
      eligibility(state, artifact)
      await files.write(artifact, source)
      await store.update(state => { assertManualExecution(state, record, record.manualFence); eligibility(state, artifact); const row = state.artifacts.find(row => row.id === id); if (row.status === 'rejected') throw fail('INVALID_STATE', '候选已被拒绝', 409); row.status = 'candidate'; row.candidateAt ??= new Date(clock()).toISOString(); return state })
      return verifyAndComplete(id, record)
    })
    pending.set(id, operation)
    try { return await operation } finally { if (pending.get(id) === operation) pending.delete(id) }
  }
  async function verifyAndComplete(id, record) {
    const state = await store.read(), artifact = state.artifacts.find(row => row.id === id)
    if (!artifact) throw fail('NOT_FOUND', '成果不存在', 404)
    if (record) assertManualExecution(state, record, record.manualFence)
    if (artifact.status === 'ready') return readyReceipt(record ?? artifact, id)
    const controlFence = record?.manualFence ?? manualFence(state, artifact)
    const bytes = await files.read(artifact, { sync: true })
    let result, trusted
    try { trusted = await requirements(state, artifact); result = await verification(bytes, trusted.value) }
    catch (cause) {
      if (cause.code === 'SPREADSHEET_VERIFICATION_FAILED') await store.update(state => { const row = state.artifacts.find(row => row.id === id); if (row.status !== 'ready') { row.status = 'rejected'; row.rejectionReason = cause.code } return state })
      throw cause
    }
    let completed, finalState
    await store.update(state => {
      assertManualExecution(state, artifact, controlFence)
      const access = eligibility(state, artifact, { consumed: true }), row = state.artifacts.find(row => row.id === id)
      if (row.status !== 'candidate' || result.sha256 !== row.sha256 || result.sizeBytes !== row.sizeBytes || !isDeepStrictEqual(access.job.sourceManifest ? spreadsheetManifestRows(access.job.sourceManifest) : access.job.rows, trusted.value.sourceManifest ? spreadsheetManifestRows(trusted.value.sourceManifest) : trusted.value.rows)) throw fail('REVISION_CONFLICT', '核验绑定已变化', 409)
      if (isCollaborationSpreadsheet(access.work.spreadsheetRequest)) { if (row.manifestDigest !== result.manifestDigest) throw error('SPREADSHEET_VERIFICATION_FAILED'); row.candidateVerification ??= { version: result.verificationVersion, at: new Date(clock()).toISOString(), rowCount: result.rowCount, summary: result.summary, manifestDigest: result.manifestDigest }; completed = safeArtifact(row); finalState = state; return state }
      row.status = 'ready'; row.verification = { version: result.verificationVersion, at: new Date(clock()).toISOString(), rowCount: result.rowCount, summary: result.summary }
      const ref = { artifactId: row.id, version: row.version, sha256: row.sha256 }
      access.work.status = 'completed'; access.work.completedAt = row.verification.at; access.work.artifactRefs = [ref]
      access.current.status = 'completed'; state.multisite.delegations.find(item => item.currentAttemptId === access.current.attempt_id).status = 'completed'
      const commandId = key('settle', access.current.attempt_id, row.id)
      const command = seal({ schema: SCHEMA, command_id: commandId, operation: 'settle', workspace_id: access.work.workspaceId, ...binding(access.current), input_id: access.input.id, instruction_revision: access.input.revision, observed_revision: access.current.observed_revision, resource_refs: access.current.resource_refs, parameters: { artifactRefs: [ref] }, employee_revision: access.current.employeeRevision })
      state.multisite.outbox.push({ id: commandId, command, createdAt: row.verification.at, acceptedAt: null })
      completed = safeArtifact(row); finalState = state; return state
    }, { beforeCommit: async () => { await files.read(artifact, { sync: true }); await attachments.verifyReferences(finalState, trusted.access.refs); assertWorkBudget(finalState, finalState.works.find(work => work.id === artifact.workId), clock()) } })
    return completed
  }
  async function reviewCandidate(execution, parameters, nodeAuth, capturedFence) {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'candidateId', 'version', 'sha256', 'manifestDigest', 'decision'])
    if (parameters.decision !== 'approve' || typeof parameters.clientRequestId !== 'string' || !parameters.clientRequestId || parameters.clientRequestId.length > 128) throw error('INVALID_REQUEST')
    let state = await store.read(); if (nodeAuth) assertNodeCaller(state, nodeAuth, execution)
    if (capturedFence === undefined) capturedFence = manualFence(state, execution)
    assertManualExecution(state, execution, capturedFence)
    let access = assertCoordinatorCandidate(state, execution, parameters.candidateId)
    if (parameters.instructionRevision !== access.work.instructionRevision || parameters.version !== access.artifact.version || parameters.sha256 !== access.artifact.sha256 || parameters.manifestDigest !== access.artifact.manifestDigest) throw error('REVISION_CONFLICT')
    const bytes = await files.read(access.artifact, { sync: true }), rebuilt = await collaboration.prepare(binding(access.producer), { clientRequestId: access.job.clientRequestId, instructionRevision: access.job.instructionRevision, template: access.job.template, sourceResultIds: access.job.sourceManifest.sourceResultIds, rows: spreadsheetManifestRows(access.job.sourceManifest) }, { completed: true, inputEncodingVersion: spreadsheetInputEncoding(access.job), job: { id: access.job.id, inputDigest: access.job.inputDigest } })
    if (rebuilt.inputDigest !== access.job.inputDigest) throw error('SPREADSHEET_VERIFICATION_FAILED', '最终来源manifest重建不一致')
    const verified = await verification(bytes, rebuilt.input), cells = await spreadsheetCells(bytes), namespace = key(access.work.workspaceId, execution.attempt_id, parameters.clientRequestId), commandDigest = digest({ operation: 'review_spreadsheet_candidate', parameters }), id = key('spreadsheet-review', namespace)
    let reply, finalState
    await store.update(draft => {
      if (nodeAuth) assertNodeCaller(draft, nodeAuth, execution)
      assertManualExecution(draft, execution, capturedFence)
      access = assertCoordinatorCandidate(draft, execution, parameters.candidateId)
      assertRequiredMessagesConsumed(draft, access.current, access.work.instructionRevision)
      if (access.work.instructionRevision !== parameters.instructionRevision || access.artifact.sha256 !== verified.sha256 || access.artifact.manifestDigest !== verified.manifestDigest) throw error('REVISION_CONFLICT')
      const consumed = new Set(draft.modelRequests.filter(row => sameBinding(row, execution) && row.instructionRevision === parameters.instructionRevision && row.outcome === 'completed').flatMap(row => row.spreadsheetReadReceiptIds ?? [])), reads = draft.spreadsheetReads.filter(row => sameBinding(row, execution) && row.instructionRevision === parameters.instructionRevision && row.candidateId === access.artifact.id && row.sha256 === access.artifact.sha256 && row.manifestDigest === access.artifact.manifestDigest && consumed.has(row.id))
      for (const [section, values] of Object.entries(cells)) {
        let through = 0
        for (const read of reads.filter(row => row.section === section).sort((left, right) => left.fromIndex - right.fromIndex)) { if (read.fromIndex > through) break; through = Math.max(through, read.toIndex) }
        if (through !== values.length) throw error('INPUT_CONSUMPTION_PENDING', '协调员工尚未在模型输入中实际读取完整候选内容')
      }
      const at = new Date(clock()).toISOString(), ref = { artifactId: access.artifact.id, version: access.artifact.version, sha256: access.artifact.sha256 }
      draft.spreadsheetReviews.push({ id, ...binding(execution), instructionRevision: parameters.instructionRevision, candidateId: access.artifact.id, version: access.artifact.version, sha256: access.artifact.sha256, manifestDigest: access.artifact.manifestDigest, readReceiptIds: reads.map(row => row.id).sort(), sourceCommandKey: namespace, decision: 'approve', reviewedAt: at })
      access.artifact.status = 'ready'; access.artifact.verification = { version: verified.verificationVersion, at, rowCount: verified.rowCount, summary: verified.summary, manifestDigest: verified.manifestDigest, reviewId: id }
      access.work.status = 'completed'; access.work.completedAt = at; access.work.artifactRefs = [ref]; access.current.status = 'completed'; draft.multisite.delegations.find(row => row.id === access.current.delegation_id).status = 'completed'
      const commandId = key('settle', access.current.attempt_id, access.artifact.id), input = draft.multisite.inputs.find(row => row.workId === access.work.id && row.revision === parameters.instructionRevision)
      draft.multisite.outbox.push({ id: commandId, command: seal({ schema: SCHEMA, command_id: commandId, operation: 'settle', workspace_id: access.work.workspaceId, ...binding(access.current), input_id: input.id, instruction_revision: input.revision, observed_revision: access.current.observed_revision, resource_refs: access.current.resource_refs, parameters: { artifactRefs: [ref] }, employee_revision: access.current.employeeRevision }), createdAt: at, acceptedAt: null })
      reply = { workId: access.work.id, reviewId: id, status: 'completed', artifactRefs: [ref] }
      draft.multisite.commands.push({ key: namespace, workspaceId: access.work.workspaceId, issuerId: execution.attempt_id, issuerKind: 'agent', senderBinding: binding(execution), commandId: parameters.clientRequestId, digest: commandDigest, reply, acceptedAt: at }); finalState = draft; return draft
    }, { beforeCommit: async () => { await files.read(access.artifact, { sync: true }); await evidence.verifySealedReferences(finalState, access.manifest.sources.map(row => row.ref)); await attachments.verifyReferences(finalState, access.manifest.photoRefs); assertWorkBudget(finalState, access.work, clock()) } })
    return reply
  }
  return {
    readCandidate: reader.read,
    reviewCandidate,
    async validateCandidateResult(execution, payload) { const state = await store.read(), access = validateSpreadsheetCandidate(state, execution, payload); await files.read(access.artifact, { sync: true }); const latest = await store.read(); validateSpreadsheetCandidate(latest, execution, payload); return { payloadDigest: digest(payload), candidateId: access.artifact.id, instructionRevision: access.artifact.instructionRevision } },
    async verifyCandidateBytes(state, id) { const row = state.artifacts.find(row => row.id === id && row.candidateVerification); if (!row) throw error('FORBIDDEN'); await files.read(row, { sync: true }); assertWorkBudget(state, state.works.find(work => work.id === row.workId), clock()) },
    async candidateReceipt(execution, jobId) { const state = await store.read(); assertOutputProducer(state, execution); const row = state.artifacts.find(row => row.jobId === jobId && sameBinding(row, execution) && row.status === 'candidate' && row.candidateVerification); return row ? safeArtifact(row) : null },
    async issueUploadToken(source) {
      const state = await store.read(), existing = state.artifacts.find(row => row.jobId === source.id && row.status === 'ready')
      if (existing && sameBinding(existing, source)) return { artifact: await readyReceipt(source, existing.id) }
      const record = { ...binding(source), jobId: source.id, purpose: 'artifact_upload', expiresAt: clock() + tokenTtlMs, manualFence: manualFence(state, source) }
      const access = eligibility(state, record); record.expiresAt = budgetTokenExpiry(access.work, record.expiresAt, clock())
      for (const [raw, value] of tokens) if (clock() >= value.expiresAt) tokens.delete(raw)
      const raw = randomBytes(32).toString('base64url'); tokens.set(raw, record)
      return { token: raw, expiresAt: record.expiresAt }
    },
    async budgetChanged(workId) { const state = await store.read(), work = state.works.find(row => row.id === workId); if (work?.modelRequestBudget?.version === 2) for (const record of tokens.values()) if (record.work_id === workId) record.expiresAt = Math.min(record.expiresAt, Date.parse(work.modelRequestBudget.executionDeadlineAt)) },
    verifyAndComplete,
    async readReadyContextBytes(state, actor, workId, artifactId) { const row = authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId); const bytes = await files.read(row, { sync: true }); authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId); return { metadata: safeArtifact(row), bytes } },
    async verifyReadyBytes(state, actor, workId, artifactId) { const row = authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId); await files.read(row, { sync: true }); authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId) },
    async download(actor, workId, artifactId) {
      const state = await store.read(), row = authorizeOwnedReadyArtifactRead(state, actor, workId, artifactId)
      const bytes = await files.read(row, { sync: true })
      const current = await store.read()
      authorizeReadyArtifactRead(current, row)
      return { metadata: safeArtifact(row), bytes }
    },
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/internal/artifacts/')) return false
      try {
        const record = token(request)
        if (request.method === 'POST' && url.pathname === '/internal/artifacts/candidates/init' && !url.search) {
          let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 64 * 1024) throw fail('INVALID_REQUEST', '元数据过大', 400) }
          let body; try { body = JSON.parse(raw) } catch { throw fail('INVALID_REQUEST', '无效元数据', 400) }
          const result = await init(record, body); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); return true
        }
        const verify = url.pathname.match(/^\/internal\/artifacts\/candidates\/(artifact-[a-f0-9]{32})\/verify$/)
        if (request.method === 'POST' && verify && !url.search) {
          const state = await store.read(), row = state.artifacts.find(row => row.id === verify[1] && row.jobId === record.jobId && sameBinding(row, record))
          if (!row) throw fail('NOT_FOUND', '成果不存在', 404)
          if (row.status !== 'ready') eligibility(state, record)
          const result = await verifyAndComplete(row.id, record); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); return true
        }
        const match = url.pathname.match(/^\/internal\/artifacts\/candidates\/(artifact-[a-f0-9]{32})\/content$/)
        if (request.method === 'PUT' && match && !url.search && request.headers['content-type'] === 'application/octet-stream') {
          const result = await upload(record, match[1], request); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); return true
        }
        throw fail('NOT_FOUND', '成果接口不存在', 404)
      } catch (cause) {
        const status = cause.status ?? ({ FORBIDDEN: 403, UNAUTHORIZED: 401, INVALID_REQUEST: 400, REVISION_CONFLICT: 409, INVALID_STATE: 409, SPREADSHEET_VERIFICATION_FAILED: 422, INPUT_CONSUMPTION_PENDING: 409, QUESTION_PENDING: 409, JOBS_PENDING: 409, RUNTIME_REQUEST_UNKNOWN: 409, WAITING_BUDGET: 409, EXECUTION_DEADLINE: 409 }[cause.code] ?? 503)
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: { code: cause.code ?? 'ARTIFACT_UNAVAILABLE', message: status >= 500 ? '成果暂不可用' : cause.message } })); return true
      }
    },
  }
}
