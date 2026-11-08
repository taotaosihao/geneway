import { isDeepStrictEqual } from 'node:util'
import { assertManualJobAdmission } from './manual-control.mjs'
import { attachmentRefs, digest, error, exact, sameBinding } from '../packages/agent-contracts/index.mjs'
import { collaborationRows, spreadsheetManifestRows, spreadsheetInputEncoding } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { assertSpreadsheetDeliverySize } from '../packages/agent-contracts/spreadsheet.mjs'
import { COLLABORATION_TEMPLATE, collaborationTemplateReference } from './spreadsheet-template.mjs'
import { assertOutputProducer, buildSpreadsheetManifest } from './spreadsheet-sources.mjs'
export function createSpreadsheetCollaborationService({ store, attachments, evidence }) {
  function normalizedHistoryRows(manifest, sources, rows) {
    const expected = sources.filter(source => manifest.sources.find(row => row.ref.id === source.ref.id).kind === 'history').flatMap(source => source.payload.entries.map((_, entryIndex) => ({ sourceRef: source.ref, entryIndex }))), entryKey = row => `${row.sourceRef.id}:${row.sourceRef.version}:${row.sourceRef.sha256}:${row.entryIndex}`, supplied = new Map(rows.map(row => [entryKey(row), row]))
    if (rows.length !== expected.length || supplied.size !== expected.length || expected.some(row => !supplied.has(entryKey(row)))) throw error('INVALID_REQUEST', '必须逐条完整覆盖全部获准历史来源')
    return expected.map(row => ({ ...row, dueDate: manifest.dueDate, photoRefs: attachmentRefs(supplied.get(entryKey(row)).photoRefs) }))
  }
  async function prepare(execution, parameters, { completed = false, inputEncodingVersion = 2, job } = {}) {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'template', 'sourceResultIds', 'rows'])
    if (typeof parameters.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(parameters.clientRequestId) || !isDeepStrictEqual(parameters.template, collaborationTemplateReference())) throw error('INVALID_REQUEST')
    collaborationRows(parameters.rows)
    let state = await store.read(), access = assertOutputProducer(state, execution, { completed })
    assertManualJobAdmission(state, execution, job)
    if (parameters.instructionRevision !== access.work.instructionRevision || !access.work.spreadsheetRequest.dueDate) throw error('REVISION_CONFLICT', '当前整改期限未明确')
    let manifest = buildSpreadsheetManifest(state, execution, parameters.sourceResultIds, parameters.rows, { completed, inputEncodingVersion })
    if (!evidence) throw error('FORBIDDEN')
    const sources = []
    for (const source of manifest.sources) sources.push({ ref: source.ref, payload: await evidence.readForSpreadsheet(execution, source.ref, { completed }) })
    const normalizedRows = normalizedHistoryRows(manifest, sources, parameters.rows)
    state = await store.read(); access = assertOutputProducer(state, execution, { completed }); manifest = buildSpreadsheetManifest(state, execution, parameters.sourceResultIds, normalizedRows, { completed, inputEncodingVersion })
    await attachments.verifyReferences(state, manifest.photoRefs)
    const latest = await store.read(), latestAccess = assertOutputProducer(latest, execution, { completed })
    assertManualJobAdmission(latest, execution, job)
    if (latestAccess.work.instructionRevision !== parameters.instructionRevision || !isDeepStrictEqual(manifest, buildSpreadsheetManifest(latest, execution, parameters.sourceResultIds, normalizedRows, { completed, inputEncodingVersion }))) throw error('REVISION_CONFLICT', '来源核验期间要求或授权已变化')
    const analysis = latest.multisite.results.find(row => row.id === manifest.analysis.resultId)
    const value = { ...(inputEncodingVersion === 2 ? { inputEncodingVersion: 2 } : {}), inputId: manifest.inputId, instructionRevision: manifest.instructionRevision, template: collaborationTemplateReference(), calculationVersion: COLLABORATION_TEMPLATE.calculationVersion, dueDate: manifest.dueDate, historyRefs: [], evidence: [], sourceManifest: manifest, sourceManifestDigest: digest(manifest), sources, analysis: structuredClone(analysis.payload), ...(inputEncodingVersion === 2 ? {} : { rows: normalizedRows }) }
    const prepared = { clientRequestId: parameters.clientRequestId, input: value, inputDigest: digest(value) }
    if (inputEncodingVersion === 2) assertSpreadsheetDeliverySize(execution, parameters, prepared, access.work.workspaceId)
    return prepared
  }
  return { prepare, async revalidate(execution, input, { job } = {}) {
    const state = await store.read(), access = assertOutputProducer(state, execution), encoding = spreadsheetInputEncoding(input)
    assertManualJobAdmission(state, execution, job)
    if (input.instructionRevision !== access.work.instructionRevision || input.dueDate !== access.work.spreadsheetRequest.dueDate) throw error('REVISION_CONFLICT')
    if (input.sourceManifest) {
      const rows = spreadsheetManifestRows(input.sourceManifest)
      if (encoding === 1) { const job = state.multisite.jobs.find(row => row.id === (input.jobId ?? execution.id) && row.inputDigest === (input.inputDigest ?? execution.inputDigest) && sameBinding(row, execution) && spreadsheetInputEncoding(row) === 1 && row.instructionRevision === input.instructionRevision && row.sourceManifestDigest === input.sourceManifestDigest); if (!job || !isDeepStrictEqual(job.sourceManifest, input.sourceManifest) || !isDeepStrictEqual(job.rows, input.rows)) throw error('FORBIDDEN', '旧编码仅用于已持久的原 Job') }
      else if (Object.hasOwn(input, 'rows') || Object.hasOwn(input, 'jobId') || Object.hasOwn(input, 'inputDigest') || input.sourceManifest.version !== 2) throw error('INVALID_REQUEST')
      const manifest = buildSpreadsheetManifest(state, execution, input.sourceManifest.sourceResultIds, rows, { inputEncodingVersion: encoding })
      if (!isDeepStrictEqual(manifest, input.sourceManifest) || digest(manifest) !== input.sourceManifestDigest) throw error('REVISION_CONFLICT')
      const sources = []; for (const source of manifest.sources) sources.push({ ref: source.ref, payload: await evidence.readForSpreadsheet(execution, source.ref) })
      if (!isDeepStrictEqual(rows, normalizedHistoryRows(manifest, sources, rows))) throw error('INVALID_REQUEST', '来源条目映射顺序无效')
      await evidence.verifySealedReferences(state, manifest.sources.map(row => row.ref))
      await attachments.verifyReferences(state, manifest.photoRefs)
      const latest = await store.read(), access = assertOutputProducer(latest, execution)
      assertManualJobAdmission(latest, execution, job)
      if (access.work.instructionRevision !== input.instructionRevision || !isDeepStrictEqual(input.sourceManifest, buildSpreadsheetManifest(latest, execution, input.sourceManifest.sourceResultIds, rows, { inputEncodingVersion: encoding }))) throw error('REVISION_CONFLICT', '生成启动前要求或授权已变化')
    }
    return true
  } }
}
