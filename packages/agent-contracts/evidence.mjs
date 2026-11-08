import { binding, digest, error, exact } from './index.mjs'
import { ids } from './delegation.mjs'

export const EVIDENCE_LIMITS = Object.freeze({ sourceBytes: 65536, items: 200, pageBytes: 16384, pageItems: 16, overheadBytes: 2048, cursorBytes: 1024, chainPages: 32, chainBytes: 131072 })
export const EVIDENCE_CAPABILITIES = Object.freeze({ history: 'evidence.history.read.v1', site_snapshot: 'evidence.site.inspect.v1' })
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value))
export const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const timestamp = value => typeof value === 'string' && value.length <= 27 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
export function evidenceCheck(condition, label = '证据格式无效') { if (!condition) throw error('INVALID_REQUEST', label) }
export function evidenceRef(value) {
  exact(value, ['kind', 'id', 'version', 'sha256'])
  evidenceCheck(value.kind === 'evidence' && typeof value.id === 'string' && /^evidence-[a-f0-9]{32}$/.test(value.id) && value.version === 1 && hashValue(value.sha256))
  return structuredClone(value)
}
export function evidenceReaders(value = []) { return ids(value, '证据读取员工') }
export function evidenceDeclaration(row) {
  const value = { binding: binding(row.producerBinding), captureId: row.id, instructionRevision: row.instructionRevision, kind: row.kind, resourceId: row.resourceId, resourceRevision: row.resourceRevision, profileVersion: row.profileVersion, exportToAgentIds: row.exportToAgentIds, sourceId: row.sourceId, sourceSha256: row.sourceSha256, sha256: row.snapshotSha256, sizeBytes: row.sizeBytes, observedAt: row.observedAt, sourceTimestamp: row.sourceTimestamp, clockTrust: row.clockTrust }
  if (row.captureFormatVersion === 2) Object.assign(value, { captureFormatVersion: 2, profileDigest: row.profileDigest })
  return value
}
export const evidenceDeclarationDigest = declaration => digest(declaration)
export function validateHistory(value) {
  exact(value, ['format', 'version', 'entries'])
  evidenceCheck(value.format === 'geneway.incident-history' && value.version === 1 && Array.isArray(value.entries) && value.entries.length <= 200)
  for (const entry of value.entries) {
    exact(entry, ['date', 'description', 'owner'])
    evidenceCheck(typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && Number.isFinite(Date.parse(entry.date)) && new Date(entry.date).toISOString().slice(0, 10) === entry.date && typeof entry.description === 'string' && entry.description.length <= 2000 && !!entry.description.trim() && typeof entry.owner === 'string' && entry.owner.length <= 200 && !!entry.owner.trim())
  }
  return value
}
export function validateSite(value) {
  exact(value, ['format', 'version', 'resourceId', 'sourceId', 'sourceTime', 'captureTime', 'window', 'cacheMode', 'quality', 'sections', 'health', 'events'])
  evidenceCheck(value.format === 'geneway.site-snapshot' && value.version === 1 && typeof value.resourceId === 'string' && value.resourceId.length <= 16000 && typeof value.sourceId === 'string' && value.sourceId.length <= 128 && (value.sourceTime === null || timestamp(value.sourceTime)) && timestamp(value.captureTime) && value.cacheMode === 'fixture' && ['unknown', 'stale', 'current'].includes(value.quality))
  if (value.window !== null) { exact(value.window, ['from', 'to']); evidenceCheck(timestamp(value.window.from) && timestamp(value.window.to) && Date.parse(value.window.from) <= Date.parse(value.window.to)) }
  evidenceCheck(Array.isArray(value.sections) && value.sections.length > 0 && value.sections.length <= 2 && new Set(value.sections).size === value.sections.length && value.sections.every(section => ['collector_health', 'recent_events'].includes(section)))
  if (value.sections.includes('collector_health')) {
    exact(value.health, ['connection', 'lastSuccessAt', 'queueDepth'])
    evidenceCheck(['connected', 'disconnected', 'unknown'].includes(value.health.connection) && (value.health.lastSuccessAt === null || timestamp(value.health.lastSuccessAt)) && (value.health.queueDepth === null || Number.isSafeInteger(value.health.queueDepth) && value.health.queueDepth >= 0))
  } else evidenceCheck(!Object.hasOwn(value, 'health'))
  if (value.sections.includes('recent_events')) validateSiteEvents(value.events)
  else evidenceCheck(!Object.hasOwn(value, 'events'))
  return value
}
export function validateSiteEvents(events) {
  evidenceCheck(Array.isArray(events) && events.length <= 200 && new Set(events.map(event => event.sourceEventId)).size === events.length)
  for (const event of events) {
    exact(event, ['sourceEventId', 'sourceTimestamp', 'code', 'severity', 'message'])
    evidenceCheck(typeof event.sourceEventId === 'string' && event.sourceEventId.length > 0 && event.sourceEventId.length <= 128 && (event.sourceTimestamp === null || timestamp(event.sourceTimestamp)) && typeof event.code === 'string' && event.code.length <= 128 && ['info', 'warning', 'error', 'unknown'].includes(event.severity) && typeof event.message === 'string' && event.message.length <= 2000)
  }
  return events
}
export function validateEvidenceBytes(bytes, kind) {
  evidenceCheck(bytes.length <= EVIDENCE_LIMITS.sourceBytes)
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw error('INVALID_REQUEST', '证据 JSON 无效') }
  return kind === 'history' ? validateHistory(value) : kind === 'site_snapshot' ? validateSite(value) : (() => { throw error('INVALID_REQUEST') })()
}
