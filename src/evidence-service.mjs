import { assertSiteCapture, recordSiteRuleRead } from './site-rule-state.mjs'
import { adoptSpreadsheetSources, assertOutputProducer, assertSpreadsheetEvidence } from './spreadsheet-sources.mjs'
import { assertManualExecution, assertManualConsumption, manualFence } from './manual-control.mjs'
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Readable } from 'node:stream'
import { createArtifactFiles } from './artifact-files.mjs'
import { budgetTokenExpiry } from './work-budget.mjs'
import { assertEvidenceReader } from './evidence-access.mjs'
import { analysisResult } from '../packages/agent-contracts/delegation.mjs'
import { authorizeMultisiteExecution, authorizeSealedEvidenceTransport } from './multisite-authorization.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { binding, digest, error, exact, key, sameBinding, text } from '../packages/agent-contracts/index.mjs'
import { EVIDENCE_LIMITS as L, EVIDENCE_CAPABILITIES, evidenceCheck as check, evidenceReaders, evidenceRef, evidenceDeclarationDigest, hashValue, jsonBytes, timestamp, validateEvidenceBytes } from '../packages/agent-contracts/evidence.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const refFor = row => ({ kind: 'evidence', id: row.id, version: 1, sha256: row.sha256 })
export function createEvidenceService({ store, nodes, root, clock = () => Date.now(), fsOps = {} }) {
  const files = createArtifactFiles({ root, fsOps, maxBytes: L.sourceBytes, validate: bytes => { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validateEvidenceBytes(bytes, value.format === 'geneway.incident-history' ? 'history' : 'site_snapshot') } })
  const tokens = new Map(), cursorKey = randomBytes(32)
  const authenticated = (state, request) => nodes.authenticate(state, request.headers.authorization, request.headers['x-geneway-node-instance'])
  function current(state, auth, execution, revision, transport = false) {
    assertNodeCaller(state, auth, execution)
    const access = transport ? authorizeSealedEvidenceTransport(state, execution) : authorizeMultisiteExecution(state, execution)
    if (revision !== access.current.instruction_revision || !transport && state.modelRequests.some(row => row.attempt_id === execution.attempt_id && row.outcome === 'unknown')) throw error('REVISION_CONFLICT')
    const input = state.multisite.inputs.find(row => row.workId === access.work.id && row.revision === revision)
    if (!input?.deliveries.some(row => row.attemptId === execution.attempt_id && row.sessionId === execution.session_id && row.ingestedAt)) throw error('REVISION_CONFLICT', '尚未消费当前输入')
    return access
  }
  function resourceAccess(state, auth, execution, revision, resourceId, kind, transport = false) {
    const access = current(state, auth, execution, revision, transport), resource = state.resources.find(row => row.id === resourceId && row.enabled)
    if (!resource || resource.kind !== (kind === 'history' ? 'history_directory' : 'site_diagnostics') || resource.ownerNodeId !== execution.node_id || !access.current.grant?.execution.resourceRefs.includes(resourceId) || !access.current.grant.execution.capabilityIds.includes(EVIDENCE_CAPABILITIES[kind]) || !resource.capabilityIds.includes(EVIDENCE_CAPABILITIES[kind])) throw error('FORBIDDEN')
    return { ...access, resource }
  }
  function uploadAccess(state, auth, record, row) {
    assertManualExecution(state, record.binding, record.manualFence)
    if (record.transport && (row.captureFormatVersion !== 2 || row.declarationDigest !== record.declarationDigest || !sameBinding(row.producerBinding, record.binding))) throw error('CAPTURE_RECOVERY_UNAVAILABLE')
    const access = resourceAccess(state, auth, record.binding, record.instructionRevision, row.resourceId, row.kind, record.transport === true)
    assertSiteCapture(state, access.work, row)
    return access
  }
  function readerAccess(state, auth, record) {
    assertManualExecution(state, record.binding, record.manualFence); assertManualConsumption(state, record.binding)
    current(state, auth, record.binding, record.instructionRevision)
    const access = assertEvidenceReader(state, record.binding, record.instructionRevision, record.ref)
    if (access.receipt.id !== record.receiptId) {
      const receipt = state.evidenceAccessReceipts.find(row => row.id === record.receiptId)
      if (!receipt || !isDeepStrictEqual(receipt.evidenceRef, record.ref) || !sameBinding(receipt.receiverBinding, record.binding) || receipt.receiverInstructionRevision !== record.instructionRevision) throw error('FORBIDDEN')
    }
    assertSiteCapture(state, state.works.find(row => row.id === record.binding.work_id), access.row)
    return access.row
  }
  async function issue(record, request) {
    const state = await store.read(), auth = authenticated(state, request)
    record = { ...record, manualFence: manualFence(state, record.binding) }
    if (record.purpose === 'evidence_read') readerAccess(state, auth, record)
    else uploadAccess(state, auth, record, state.evidence.find(row => row.id === record.evidenceId))
    const work = state.works.find(row => row.id === record.binding.work_id), expiresAt = budgetTokenExpiry(work, clock() + 300000, clock()), token = randomBytes(32).toString('base64url')
    for (const [raw, row] of tokens) if (row.expiresAt <= clock()) tokens.delete(raw)
    tokens.set(token, { ...record, expiresAt }); return { token, expiresAt }
  }
  function token(request, purpose) { const row = tokens.get(request.headers['x-geneway-evidence-token']); if (!row || row.purpose !== purpose || row.expiresAt <= clock()) throw error('UNAUTHORIZED'); return row }
  function cursor(payload) { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'), signature = createHmac('sha256', cursorKey).update(encoded).digest('base64url'); const result = `${encoded}.${signature}`; check(Buffer.byteLength(result) <= L.cursorBytes); return result }
  function decode(raw) {
    try { check(typeof raw === 'string' && Buffer.byteLength(raw) <= L.cursorBytes); const [encoded, signature, extra] = raw.split('.'), actual = Buffer.from(signature ?? '', 'base64url'), expected = createHmac('sha256', cursorKey).update(encoded ?? '').digest(); check(!extra && actual.length === expected.length && timingSafeEqual(actual, expected)); return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { throw error('INVALID_CURSOR') }
  }
  function page(record, row, payload, rawCursor) {
    let start = { ref: record.ref, receiptId: record.receiptId, receiverInstructionRevision: record.instructionRevision, nextIndex: 0, pagesUsed: 0, bytesUsed: 0, expiresAt: record.expiresAt }
    if (rawCursor !== null) {
      const old = decode(rawCursor)
      if (!isDeepStrictEqual(old.ref, record.ref) || old.receiptId !== record.receiptId || old.receiverInstructionRevision !== record.instructionRevision || old.expiresAt <= clock() || !['nextIndex', 'pagesUsed', 'bytesUsed'].every(field => Number.isSafeInteger(old[field]) && old[field] >= 0)) throw error('INVALID_CURSOR')
      start = old
    }
    if (start.pagesUsed >= L.chainPages || start.bytesUsed >= L.chainBytes) throw error('EVIDENCE_READ_LIMIT')
    const entries = row.kind === 'history' ? payload.entries.map((entry, entryIndex) => ({ entryIndex, ...entry })) : payload.events ?? []
    if (start.nextIndex > entries.length) throw error('INVALID_CURSOR')
    function envelope(items) {
      const nextIndex = start.nextIndex + items.length, partial = nextIndex < entries.length
      let result, size = 0
      for (let count = 0; count < 10; count++) {
        result = { schema: row.schema, ref: record.ref, quality: row.quality, dataMode: row.dataMode, clockTrust: row.clockTrust, sourceTimestamp: row.sourceTimestamp, observedAt: row.observedAt, ...(row.kind === 'site_snapshot' ? { sections: payload.sections, ...(payload.sections.includes('collector_health') ? { health: payload.health } : {}) } : {}), entries: items, partial, nextCursor: partial ? cursor({ ...start, nextIndex, pagesUsed: start.pagesUsed + 1, bytesUsed: start.bytesUsed + size }) : null, bytes: size, tokenEstimate: size, estimateOnly: true }
        const actual = jsonBytes(result); if (actual === size) return result; size = actual
      }
      throw error('INVALID_STATE')
    }
    let items = [], result = envelope(items)
    while (items.length < L.pageItems && start.nextIndex + items.length < entries.length) {
      const next = [...items, entries[start.nextIndex + items.length]], candidate = envelope(next)
      if (jsonBytes(candidate) > L.pageBytes) break
      items = next; result = candidate
    }
    check(items.length > 0 || start.nextIndex === entries.length, '单条证据无法分页')
    check(jsonBytes({ ...result, entries: [] }) <= L.overheadBytes)
    if (result.bytes + start.bytesUsed > L.chainBytes) throw error('EVIDENCE_READ_LIMIT')
    return result
  }
  async function jsonBody(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; check(size <= 262144); chunks.push(chunk) }; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('INVALID_REQUEST') } }
  const json = (response, result, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)) }
  return { async readContextSnapshot(row) { return validateEvidenceBytes(await files.read(row, { sync: true }), row.kind) }, async readForSpreadsheet(execution, ref, { completed = false } = {}) {
    let state = await store.read(); const access = assertOutputProducer(state, execution, { completed }), revision = access.work.instructionRevision, reader = completed ? assertSpreadsheetEvidence : assertEvidenceReader, source = reader(state, execution, revision, ref), bytes = await files.read(source.row, { sync: true }), payload = validateEvidenceBytes(bytes, source.row.kind)
    state = await store.read(); reader(state, execution, revision, ref); return payload
  }, async verifySealedReferences(state, refs) { for (const ref of refs) { const row = state.evidence.find(row => row.id === ref.id && row.status === 'ready' && row.version === ref.version && row.sha256 === ref.sha256); if (!row) throw error('FORBIDDEN'); validateEvidenceBytes(await files.read(row, { sync: true }), row.kind) } }, async validateAdoption(execution, parameters) {
    const preview = await store.read(), namespace = key('local', execution.attempt_id, parameters.clientRequestId); adoptSpreadsheetSources(preview, execution, parameters, namespace, new Date(clock()).toISOString()); const refs = [...new Map(preview.sourceAdoptions.at(-1).sources.map(row => [row.ref.id, row.ref])).values()]
    for (const ref of refs) { const row = preview.evidence.find(row => row.id === ref.id); validateEvidenceBytes(await files.read(row, { sync: true }), row.kind) }; return refs
  }, async budgetChanged(workId) { const state = await store.read(), work = state.works.find(row => row.id === workId); if (work?.modelRequestBudget?.version === 2) for (const record of tokens.values()) if (record.binding.work_id === workId) record.expiresAt = Math.min(record.expiresAt, Date.parse(work.modelRequestBudget.executionDeadlineAt)) }, async validateAnalysis(execution, value) {
    const payload = analysisResult(value, { admission: true }), initial = await store.read(), snapshots = new Map()
    const revision = initial.works.find(row => row.id === execution.work_id)?.instructionRevision
    for (const ref of payload.evidenceRefs) {
      const access = assertEvidenceReader(initial, execution, revision, ref)
      const bytes = await files.read(access.row, { sync: true })
      snapshots.set(ref.id, { row: access.row, payload: validateEvidenceBytes(bytes, access.row.kind) })
    }
    for (const finding of payload.findings) for (const basis of finding.basis) {
      const source = snapshots.get(basis.evidenceRef.id)
      if (!source) throw error('FORBIDDEN')
      if (basis.entryIndexes && (source.row.kind !== 'history' || basis.entryIndexes.some(index => index >= source.payload.entries.length))) throw error('INVALID_REQUEST', '分析引用条目越界')
      if (basis.sourceEventIds && (source.row.kind !== 'site_snapshot' || !source.payload.sections.includes('recent_events') || basis.sourceEventIds.some(id => !source.payload.events.some(event => event.sourceEventId === id)))) throw error('INVALID_REQUEST', '分析引用事件未采集')
      if (finding.category === 'history_match' && source.row.kind !== 'history' || finding.category === 'stale_data' && !['stale', 'unknown'].includes(source.row.quality) || source.row.kind === 'site_snapshot' && source.row.quality !== 'current' && finding.category !== 'stale_data' && finding.certainty === 'supported') throw error('INVALID_REQUEST', '分析确定性与来源限制不符')
    }
    const latest = await store.read()
    for (const ref of payload.evidenceRefs) assertEvidenceReader(latest, execution, revision, ref)
    return { payloadDigest: digest(payload), instructionRevision: revision, refs: structuredClone(payload.evidenceRefs) }
  }, async handle(request, response, url) {
    if (!url.pathname.startsWith('/internal/evidence/')) return false
    try {
      let state = await store.read(), auth = authenticated(state, request)
      if (request.method === 'POST') {
        check(!url.search); const value = await jsonBody(request); state = await store.read(); auth = authenticated(state, request)
        if (url.pathname === '/internal/evidence/authorize') {
          exact(value, ['binding', 'instructionRevision', 'resourceId', 'window']); const resource = state.resources.find(row => row.id === value.resourceId), kind = resource?.kind === 'history_directory' ? 'history' : 'site_snapshot'
          const access = resourceAccess(state, auth, value.binding, value.instructionRevision, value.resourceId, kind)
          assertManualConsumption(state, value.binding)
          if (access.work.origin === 'rule' && !isDeepStrictEqual(access.work.siteRule.window, value.window)) throw error('FORBIDDEN')
          json(response, { resource: { id: access.resource.id, revision: access.resource.revision }, kind }); return true
        }
        if (url.pathname === '/internal/evidence/init') {
          exact(value, ['binding', 'captureId', 'instructionRevision', 'kind', 'resourceId', 'resourceRevision', 'profileVersion', 'exportToAgentIds', 'sourceId', 'sourceSha256', 'sha256', 'sizeBytes', 'observedAt', 'sourceTimestamp', 'clockTrust', 'captureFormatVersion', 'profileDigest', 'legacyRetry'])
          if (value.legacyRetry !== undefined) check(value.legacyRetry === true && value.captureFormatVersion === undefined)
          if (value.captureFormatVersion !== undefined) check(value.captureFormatVersion === 2 && hashValue(value.profileDigest)); else check(value.profileDigest === undefined)
          check(typeof value.captureId === 'string' && /^[a-f0-9]{32}$/.test(value.captureId) && hashValue(value.sourceSha256) && hashValue(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= L.sourceBytes && Number.isSafeInteger(value.profileVersion) && value.profileVersion > 0 && timestamp(value.observedAt) && (value.sourceTimestamp === null || timestamp(value.sourceTimestamp)) && ['fixture', 'verified', 'unknown'].includes(value.clockTrust)); text(value.sourceId); evidenceReaders(value.exportToAgentIds)
          const id = `evidence-${value.captureId}`; let result
          await store.update(draft => {
            const currentAuth = authenticated(draft, request), access = resourceAccess(draft, currentAuth, value.binding, value.instructionRevision, value.resourceId, value.kind)
            if (access.resource.revision !== value.resourceRevision) throw error('REVISION_CONFLICT')
            const declaration = { id, version: 1, workspaceId: access.work.workspaceId, workId: access.work.id, ownerMemberId: access.owner.id, producerBinding: binding(value.binding), instructionRevision: value.instructionRevision, kind: value.kind, schema: value.kind === 'history' ? 'geneway.incident-history/1' : 'geneway.site-snapshot/1', resourceId: value.resourceId, resourceRevision: value.resourceRevision, profileVersion: value.profileVersion, exportToAgentIds: evidenceReaders(value.exportToAgentIds), sourceId: value.sourceId, sourceSha256: value.sourceSha256, sha256: value.sha256, sizeBytes: value.sizeBytes, mediaType: 'application/json', observedAt: value.observedAt, sourceTimestamp: value.sourceTimestamp, clockTrust: value.clockTrust, dataMode: 'fixture' }
            assertSiteCapture(draft, access.work, declaration)
            if (value.captureFormatVersion === 2) Object.assign(declaration, { captureFormatVersion: 2, profileDigest: value.profileDigest, declarationDigest: evidenceDeclarationDigest(value) })
            const old = draft.evidence.find(row => row.id === id)
            if (!old) assertManualConsumption(draft, value.binding)
            if (!old && value.captureFormatVersion !== 2 && !value.legacyRetry) throw error('CAPTURE_RECOVERY_UNAVAILABLE', '新证据必须使用当前封存协议')
            if (old && !isDeepStrictEqual(Object.fromEntries(Object.entries(old).filter(([key]) => !['status', 'receivedAt', 'quality'].includes(key))), declaration)) throw error('IDEMPOTENCY_CONFLICT')
            result = old ?? { ...declaration, status: 'pending', receivedAt: null, quality: 'unknown' }; if (!old) draft.evidence.push(result); return draft
          })
          json(response, result.status === 'ready' ? { ref: refFor(result), status: 'ready', quality: result.quality, observedAt: result.observedAt, sourceTimestamp: result.sourceTimestamp } : { id, ...await issue({ purpose: 'evidence_upload', binding: binding(value.binding), instructionRevision: value.instructionRevision, evidenceId: id }, request) }); return true
        }
        if (url.pathname === '/internal/evidence/resume-upload') {
          exact(value, ['binding', 'captureId', 'declarationDigest']); check(typeof value.captureId === 'string' && /^[a-f0-9]{32}$/.test(value.captureId) && hashValue(value.declarationDigest))
          const row = state.evidence.find(row => row.id === `evidence-${value.captureId}`)
          if (!row || row.captureFormatVersion !== 2 || row.declarationDigest !== value.declarationDigest || !sameBinding(row.producerBinding, value.binding)) throw error('CAPTURE_RECOVERY_UNAVAILABLE')
          const record = { purpose: 'evidence_upload', binding: binding(value.binding), instructionRevision: row.instructionRevision, evidenceId: row.id, transport: true, declarationDigest: row.declarationDigest }
          const access = uploadAccess(state, auth, record, row); if (access.resource.revision !== row.resourceRevision) throw error('REVISION_CONFLICT')
          json(response, row.status === 'ready' ? { ref: refFor(row), status: 'ready', quality: row.quality, observedAt: row.observedAt, sourceTimestamp: row.sourceTimestamp } : { id: row.id, ...await issue(record, request) }); return true
        }
        if (url.pathname === '/internal/evidence/read-token') {
          exact(value, ['binding', 'instructionRevision', 'ref']); evidenceRef(value.ref)
          const receipt = state.evidenceAccessReceipts.find(row => isDeepStrictEqual(row.evidenceRef, value.ref) && sameBinding(row.receiverBinding, value.binding) && row.receiverInstructionRevision === value.instructionRevision)
          if (!receipt) throw error('FORBIDDEN')
          const record = { purpose: 'evidence_read', binding: binding(value.binding), instructionRevision: value.instructionRevision, ref: value.ref, receiptId: receipt.id }; readerAccess(state, auth, record); json(response, await issue(record, request)); return true
        }
        throw error('NOT_FOUND')
      }
      const match = url.pathname.match(/^\/internal\/evidence\/(evidence-[a-f0-9]{32})(\/content)?$/)
      if (!match) throw error('NOT_FOUND')
      if (request.method === 'PUT' && match[2]) {
        check(!url.search && request.headers['content-type'] === 'application/json'); const record = token(request, 'evidence_upload'); check(record.evidenceId === match[1])
        let row = state.evidence.find(row => row.id === match[1]); if (!row) throw error('NOT_FOUND'); uploadAccess(state, auth, record, row)
        const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; check(size <= L.sourceBytes); chunks.push(chunk) }; const bytes = Buffer.concat(chunks)
        check(bytes.length === row.sizeBytes && hash(bytes) === row.sha256); const payload = validateEvidenceBytes(bytes, row.kind)
        if (row.kind === 'site_snapshot') check(payload.resourceId === row.resourceId && payload.sourceId === row.sourceId && payload.sourceTime === row.sourceTimestamp && payload.captureTime === row.observedAt)
        await files.write(row, Readable.from([bytes]))
        await store.update(draft => {
          const currentAuth = authenticated(draft, request); if (record.expiresAt <= clock()) throw error('UNAUTHORIZED')
          const access = uploadAccess(draft, currentAuth, record, row), currentRow = draft.evidence.find(item => item.id === row.id)
          if (access.resource.revision !== row.resourceRevision) throw error('REVISION_CONFLICT')
          assertSiteCapture(draft, access.work, row, payload)
          if (currentRow.status !== 'ready') {
            currentRow.status = 'ready'; currentRow.receivedAt = new Date(clock()).toISOString()
            const age = row.sourceTimestamp === null ? null : Date.parse(row.observedAt) - Date.parse(row.sourceTimestamp)
            currentRow.quality = row.kind === 'history' ? 'historical' : row.clockTrust === 'unknown' || age === null || age < 0 ? 'unknown' : age > 120000 ? 'stale' : 'current'
            if ((access.resource.evidenceReaderAgentIds ?? []).includes(record.binding.agent_id) && row.exportToAgentIds.includes(record.binding.agent_id)) {
              const ref = refFor(row), receipt = { id: key('evidence-access', ref, binding(record.binding), record.instructionRevision, 'publisher_self'), evidenceRef: ref, issuerBinding: binding(record.binding), receiverBinding: binding(record.binding), receiverInstructionRevision: record.instructionRevision, reason: 'publisher_self', issuedAt: currentRow.receivedAt }
              if (!draft.evidenceAccessReceipts.some(item => item.id === receipt.id)) draft.evidenceAccessReceipts.push(receipt)
            }
          }
          row = currentRow; return draft
        })
        json(response, { ref: refFor(row), status: 'ready', quality: row.quality, observedAt: row.observedAt, sourceTimestamp: row.sourceTimestamp }); return true
      }
      if (request.method === 'GET') {
        const record = token(request, 'evidence_read'); check(record.ref.id === match[1]); let row = readerAccess(state, auth, record)
        if (!match[2]) { check(!url.search); json(response, row); return true }
        check([...url.searchParams.keys()].every(key => key === 'cursor') && url.searchParams.getAll('cursor').length <= 1)
        const bytes = await files.read(row, { sync: true }), payload = validateEvidenceBytes(bytes, row.kind)
        state = await store.read(); auth = authenticated(state, request); if (record.expiresAt <= clock()) throw error('UNAUTHORIZED'); row = readerAccess(state, auth, record)
        const pageValue = page(record, row, payload, url.searchParams.get('cursor'))
        let result = pageValue
        if (state.works.some(work => work.id === row.workId && work.origin === 'rule')) {
          await store.update(draft => {
            if (record.expiresAt <= clock()) throw error('UNAUTHORIZED')
            const current = readerAccess(draft, authenticated(draft, request), record), work = draft.works.find(work => work.id === current.workId)
            assertSiteCapture(draft, work, current, payload)
            result = recordSiteRuleRead(draft, work, record.binding, record.instructionRevision, pageValue, payload, clock())
            if (jsonBytes(result) > L.pageBytes) throw error('EVIDENCE_READ_LIMIT')
            return draft
          })
          const latest = await store.read()
          if (record.expiresAt <= clock()) throw error('UNAUTHORIZED')
          readerAccess(latest, authenticated(latest, request), record)
        }
        json(response, result); return true
      }
      throw error('NOT_FOUND')
    } catch (cause) { json(response, { error: { code: cause.code ?? 'STORE_UNAVAILABLE', message: '证据请求无法完成' } }, ({ INVALID_REQUEST: 400, INVALID_CURSOR: 409, EVIDENCE_READ_LIMIT: 409, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, REVISION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, WAITING_BUDGET: 409, EXECUTION_DEADLINE: 409, MANUALLY_PAUSED: 409, MANUAL_RELEASE_PENDING: 409, MANUAL_RESUME_PENDING: 409 })[cause.code] ?? 503); return true }
  } }
}
