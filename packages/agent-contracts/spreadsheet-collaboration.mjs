import { isDeepStrictEqual } from 'node:util'
import { exact, text, error, attachmentRefs } from './index.mjs'
import { assertResultBytes } from './command-bytes.mjs'
import { evidenceRef } from './evidence.mjs'
export const SPREADSHEET_CANDIDATE_SCHEMA = 'geneway.spreadsheet-candidate/1'
export const SOURCE_MANIFEST_SCHEMA_V2 = 'geneway.spreadsheet-source-manifest/2'
export const SOURCE_MANIFEST_SCHEMA = 'geneway.spreadsheet-source-manifest/1'
export const COLLABORATION_TEMPLATE_ID = 'incident-collaboration-v1'
export function sourceResultIds(value) { if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) || new Set(value).size !== value.length) throw error('INVALID_REQUEST', '来源回报 ID 无效'); return [...value] }
export function collaborationRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 6400) throw error('INVALID_REQUEST', '多来源明细范围无效')
  for (const row of rows) { exact(row, ['sourceRef', 'entryIndex', 'dueDate', 'photoRefs']); evidenceRef(row.sourceRef); if (!Number.isSafeInteger(row.entryIndex) || row.entryIndex < 0 || row.entryIndex >= 200 || typeof row.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) throw error('INVALID_REQUEST') }
  return rows
}
export function spreadsheetCandidateResult(value, { admission = false } = {}) {
  exact(value, ['summary', 'evidenceRefs', 'jobId', 'candidateId', 'version', 'sha256', 'inputDigest', 'manifestDigest', 'sourceResultIds'])
  text(value.summary); if (value.summary.length > 4000 || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32 || !/^[a-f0-9]{32}$/.test(value.jobId) || !/^artifact-[a-f0-9]{32}$/.test(value.candidateId) || value.version !== 1 || ['sha256', 'inputDigest', 'manifestDigest'].some(field => !/^[a-f0-9]{64}$/.test(value[field]))) throw error('INVALID_REQUEST', '候选回报格式无效')
  for (const ref of value.evidenceRefs) evidenceRef(ref)
  sourceResultIds(value.sourceResultIds)
  return admission ? assertResultBytes(structuredClone(value)) : structuredClone(value)
}

// The persisted wire format keeps one mapping and ordered reference dictionaries.
// Expansion is transient for generation/oracle checks, never a second Job authority.
export function spreadsheetInputEncoding(input) {
  if (input.inputEncodingVersion === undefined) return 1
  if (input.inputEncodingVersion !== 2) throw error('INVALID_REQUEST', '表格输入编码无效')
  return 2
}
export function spreadsheetManifestRows(manifest) {
  if (manifest.schema === SOURCE_MANIFEST_SCHEMA && manifest.version === 1) {
    if (Object.hasOwn(manifest, 'rowMap')) throw error('INVALID_REQUEST', '不能混用来源映射编码')
    return structuredClone(collaborationRows(manifest.rows))
  }
  if (manifest.schema !== SOURCE_MANIFEST_SCHEMA_V2 || manifest.version !== 2 || Object.hasOwn(manifest, 'rows') || !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 32) throw error('INVALID_REQUEST', '来源映射编码无效')
  const photos = attachmentRefs(manifest.photoRefs), sourceIds = new Set()
  for (const source of manifest.sources) { evidenceRef(source.ref); if (!['history', 'site_snapshot'].includes(source.kind) || sourceIds.has(source.ref.id)) throw error('INVALID_REQUEST'); sourceIds.add(source.ref.id) }
  if (!Array.isArray(manifest.rowMap) || !manifest.rowMap.length || manifest.rowMap.length > 6400) throw error('INVALID_REQUEST')
  const pairs = new Set(), usedPhotos = new Set(), rows = []
  for (const item of manifest.rowMap) {
    exact(item, ['sourceIndex', 'entryIndex', 'photoIndices'])
    if (!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < 0 || item.sourceIndex >= manifest.sources.length || manifest.sources[item.sourceIndex].kind !== 'history' || !Number.isSafeInteger(item.entryIndex) || item.entryIndex < 0 || item.entryIndex >= 200 || !Array.isArray(item.photoIndices) || item.photoIndices.length > photos.length || new Set(item.photoIndices).size !== item.photoIndices.length) throw error('INVALID_REQUEST', '来源或照片索引无效')
    const pair = item.sourceIndex + ':' + item.entryIndex
    if (pairs.has(pair)) throw error('INVALID_REQUEST', '来源条目映射重复')
    pairs.add(pair)
    const photoRefs = item.photoIndices.map(index => { if (!Number.isSafeInteger(index) || index < 0 || index >= photos.length) throw error('INVALID_REQUEST', '照片索引无效'); usedPhotos.add(index); return photos[index] })
    rows.push({ sourceRef: manifest.sources[item.sourceIndex].ref, entryIndex: item.entryIndex, dueDate: manifest.dueDate, photoRefs })
  }
  if (usedPhotos.size !== photos.length) throw error('INVALID_REQUEST', '照片字典范围未完整映射')
  return collaborationRows(rows)
}
export function compactSpreadsheetManifest(value) {
  const { rows, ...manifest } = value
  const rowMap = collaborationRows(rows).map(row => ({ sourceIndex: manifest.sources.findIndex(source => isDeepStrictEqual(source.ref, row.sourceRef)), entryIndex: row.entryIndex, photoIndices: attachmentRefs(row.photoRefs).map(ref => manifest.photoRefs.findIndex(photo => isDeepStrictEqual(photo, ref))) }))
  const compact = { ...manifest, schema: SOURCE_MANIFEST_SCHEMA_V2, version: 2, rowMap }
  if (!isDeepStrictEqual(spreadsheetManifestRows(compact), rows)) throw error('INVALID_REQUEST', '来源映射不能无损编码')
  return compact
}
export function expandedSpreadsheetInput(input) {
  const encoding = spreadsheetInputEncoding(input), rows = spreadsheetManifestRows(input.sourceManifest)
  if (encoding === 2) {
    if (input.sourceManifest.version !== 2 || Object.hasOwn(input, 'rows')) throw error('INVALID_REQUEST', '不能混用表格输入编码')
    return { ...input, rows }
  }
  if (input.sourceManifest.version !== 1 || !isDeepStrictEqual(rows, input.rows)) throw error('INVALID_REQUEST', '旧表格输入映射不一致')
  return input
}
