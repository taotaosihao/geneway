import { isDeepStrictEqual } from 'node:util'
import { normalizeTpmInput, parseTpmInstant, tpmError, tpmSourcePath, tpmToolRequest } from './tpm.mjs'

export const KIVO_TPM_DEVICE_CORRELATION_KIND = 'kivo.tpm.device-correlation'
export const KIVO_TPM_DEVICE_CORRELATION_TOOL = 'geneway_kivo_tpm_correlate_device'
export const CORRELATION_RECORD_TYPES = Object.freeze(['repair', 'maintenance', 'inspection'])
const SOURCE_FIELDS = ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
const RECORD_FIELDS = ['id', 'reference', 'recordType', 'deviceId', 'revision', 'status', 'createdAt', 'updatedAt', 'scheduledAt', 'startedAt', 'completedAt', 'closedAt']

export function normalizeTpmCorrelationInput(value, options) {
  const result = normalizeTpmInput('record', value, options)
  if (result.ok && result.input.recordType && !CORRELATION_RECORD_TYPES.includes(result.input.recordType)) return { ok: false, missing: [], error: { code: 'INVALID_REQUEST', message: '设备关联只支持维修、保养或点检单据' } }
  return result
}

// Keep only the facts used by the explanation and approval. Raw history, people and
// upstream extension objects never become a second model context.
export function normalizeTpmDeviceCorrelation({ input, result, deviceResult, monitorResult, connection }) {
  const parsed = normalizeTpmCorrelationInput(input)
  if (!parsed.ok || !isDeepStrictEqual(parsed.input, input)) invalid()
  if (result?.status !== 'ok' || deviceResult?.status !== 'ok' || monitorResult?.status !== 'ok') invalid('当前组织范围缺少关联来源')
  const record = result.value, device = deviceResult.value, monitor = monitorResult.value
  if (!record || !device || !monitor || !uuid(record.id) || !uuid(record.deviceId) || device.id !== record.deviceId || monitor.deviceId !== device.id
    || monitor.deviceCode !== device.code || monitor.receivedAtMeaning !== 'projection' || monitor.sourceReceivedAt !== null || monitor.sourceQuality !== null) invalid()
  const reference = input.recordType === 'inspection' ? record.inspectionNo : record.orderNo
  if (reference !== input.reference && record.id !== input.reference) invalid()
  const tpm = {
    id: record.id, reference, recordType: input.recordType, deviceId: record.deviceId, revision: revision(record.revision), status: text(record.status),
    ...Object.fromEntries(RECORD_FIELDS.slice(6).map(key => [key, optionalTime(record[key])])),
  }
  const source = Object.fromEntries(SOURCE_FIELDS.map(key => [key, text(connection?.[key])]))
  const binding = { resource: text(connection?.baseUrl), sourceInstance: source.sourceInstance, connectionId: text(connection?.id), connectionRevision: connection.revision, clientId: text(connection?.clientId) }
  const sources = {
    tpm: checkedSource(result.source, tpmSourcePath(tpmToolRequest('record', input))),
    ledger: checkedSource(deviceResult.source, tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: device.id }))),
    monitoring: checkedSource(monitorResult.source, `/api/v1/mes/equipment/monitor/${encodeURIComponent(device.code)}/current`),
  }
  if (new Set(Object.values(sources).map(item => item.traceId)).size !== 1) invalid()
  const current = monitor.current, snapshot = current?.snapshot
  if (!current || (snapshot && current.recordTs !== snapshot.observedAt)) invalid()
  const monitoring = {
    status: current.status, trusted: current.trusted, recordTs: current.recordTs,
    snapshotAt: monitor.snapshotAt, receivedAtMeaning: 'projection', sourceReceivedAt: null, sourceQuality: null,
    observedAt: snapshot?.observedAt ?? null, receivedAt: snapshot?.receivedAt ?? null,
    availability: snapshot ? structuredClone(snapshot.availability) : null,
    connection: snapshot ? structuredClone(snapshot.connection) : null,
    runtime: snapshot ? structuredClone(snapshot.runtime) : null,
    deviceAlarm: snapshot ? structuredClone(snapshot.deviceAlarm) : null,
  }
  const value = {
    input: structuredClone(input), queriedAt: sources.monitoring.queriedAt, source, binding, tpm,
    device: { id: device.id, code: device.code, name: device.name, lifecycleStatus: device.lifecycleStatus },
    mapping: { recordDeviceId: record.deviceId, ledgerDeviceId: device.id, monitorDeviceId: monitor.deviceId, deviceCode: device.code },
    sources, monitoring,
  }
  return assertTpmDeviceCorrelation({ ...value, ...correlationAssessment(value, value.queriedAt) })
}

export function assertTpmDeviceCorrelation(value, input = value?.input) {
  exact(value, ['input', 'queriedAt', 'source', 'binding', 'tpm', 'device', 'mapping', 'sources', 'monitoring', 'freshness', 'coverage', 'unknowns', 'actionEligible'])
  const parsed = normalizeTpmCorrelationInput(input)
  if (!parsed.ok || !isDeepStrictEqual(parsed.input, value.input) || !isDeepStrictEqual(value.input, input)) invalid()
  instant(value.queriedAt)
  exact(value.source, SOURCE_FIELDS); SOURCE_FIELDS.forEach(key => text(value.source[key]))
  exact(value.binding, ['resource', 'sourceInstance', 'connectionId', 'connectionRevision', 'clientId'])
  const url = new URL(value.binding.resource)
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== value.binding.resource || url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/mes/mcp'
    || value.binding.sourceInstance !== value.source.sourceInstance || !uuid(value.binding.clientId) || !Number.isSafeInteger(value.binding.connectionRevision) || value.binding.connectionRevision < 1) invalid()
  text(value.binding.connectionId)
  exact(value.tpm, RECORD_FIELDS)
  if (!uuid(value.tpm.id) || !uuid(value.tpm.deviceId) || value.tpm.recordType !== input.recordType || (value.tpm.reference !== input.reference && value.tpm.id !== input.reference)) invalid()
  if (revision(value.tpm.revision) !== value.tpm.revision) invalid()
  text(value.tpm.reference); text(value.tpm.status); RECORD_FIELDS.slice(6).forEach(key => optionalTime(value.tpm[key]))
  exact(value.device, ['id', 'code', 'name', 'lifecycleStatus'])
  if (value.device.id !== value.tpm.deviceId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.device.code) || uuid(value.device.code)) invalid()
  text(value.device.name); text(value.device.lifecycleStatus)
  if (!isDeepStrictEqual(value.mapping, { recordDeviceId: value.tpm.deviceId, ledgerDeviceId: value.device.id, monitorDeviceId: value.device.id, deviceCode: value.device.code })) invalid()
  exact(value.sources, ['tpm', 'ledger', 'monitoring'])
  checkedSource(value.sources.tpm, tpmSourcePath(tpmToolRequest('record', input)))
  checkedSource(value.sources.ledger, tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: value.device.id })))
  checkedSource(value.sources.monitoring, `/api/v1/mes/equipment/monitor/${encodeURIComponent(value.device.code)}/current`)
  if (value.queriedAt !== value.sources.monitoring.queriedAt || new Set(Object.values(value.sources).map(item => item.traceId)).size !== 1) invalid()
  const m = value.monitoring
  exact(m, ['status', 'trusted', 'recordTs', 'snapshotAt', 'receivedAtMeaning', 'sourceReceivedAt', 'sourceQuality', 'observedAt', 'receivedAt', 'availability', 'connection', 'runtime', 'deviceAlarm'])
  if (!['success', 'empty', 'partial', 'stale', 'unavailable', 'unmapped'].includes(m.status) || typeof m.trusted !== 'boolean'
    || m.receivedAtMeaning !== 'projection' || m.sourceReceivedAt !== null || m.sourceQuality !== null) invalid()
  instant(m.snapshotAt); [m.recordTs, m.observedAt, m.receivedAt].forEach(optionalTime)
  if (m.recordTs !== m.observedAt) invalid()
  if (m.availability !== null) {
    exact(m.availability, ['status', 'reasonCode']); text(m.availability.reasonCode)
    if (!['success', 'empty', 'partial', 'stale', 'unavailable', 'unmapped'].includes(m.availability.status)) invalid()
    exact(m.connection, ['status', 'missingReason']); nullableText(m.connection.missingReason)
    if (!['online', 'offline', 'disconnected', 'degraded', 'unknown'].includes(m.connection.status)) invalid()
    exact(m.runtime, ['status', 'missingReason']); nullableText(m.runtime.missingReason)
    if (!['processing', 'idle', 'stopped', 'fault', 'disconnected', 'offline', 'unknown'].includes(m.runtime.status)) invalid()
    exact(m.deviceAlarm, ['activeCount', 'summaries', 'missingReason']); nullableText(m.deviceAlarm.missingReason)
    if (m.deviceAlarm.activeCount !== null && (!Number.isSafeInteger(m.deviceAlarm.activeCount) || m.deviceAlarm.activeCount < 0)) invalid()
    if (!Array.isArray(m.deviceAlarm.summaries) || m.deviceAlarm.summaries.length > 100) invalid()
    for (const alarm of m.deviceAlarm.summaries) {
      exact(alarm, ['code', 'title', 'level', 'occurredAt']); nullableText(alarm.code); nullableText(alarm.title); optionalTime(alarm.occurredAt)
      if (alarm.level !== null && !['info', 'warning', 'error', 'critical'].includes(alarm.level)) invalid()
    }
  } else if ([m.connection, m.runtime, m.deviceAlarm].some(item => item !== null)) invalid()
  const assessment = correlationAssessment(value, value.queriedAt)
  if (Object.keys(assessment).some(key => !isDeepStrictEqual(value[key], assessment[key]))) invalid()
  return value
}

export function correlationAssessment(value, at) {
  const m = value.monitoring, sampleAt = m.observedAt, ageSeconds = sampleAt === null ? null : (instant(at) - instant(sampleAt)) / 1000
  const status = ageSeconds === null ? 'missing' : ageSeconds < -5 ? 'future' : ageSeconds > 120 ? 'stale' : 'fresh'
  const coverage = { tpm: true, ledger: true, monitoring: m.status === 'success' && m.trusted === true && m.availability?.status === 'success'
    && m.connection?.status !== 'unknown' && m.connection?.missingReason === null && m.runtime?.status !== 'unknown' && m.runtime?.missingReason === null
    && m.deviceAlarm?.activeCount !== null && m.deviceAlarm?.missingReason === null }
  const unknowns = ['SOURCE_QUALITY_NOT_PROVIDED', 'SOURCE_RECEIVED_AT_NOT_PROVIDED']
  if (status !== 'fresh') unknowns.push(`SAMPLE_${status.toUpperCase()}`)
  if (!coverage.monitoring) unknowns.push('MONITORING_INCOMPLETE')
  if (m.connection?.status === 'unknown' || !m.connection) unknowns.push('CONNECTION_UNKNOWN')
  if (m.runtime?.status === 'unknown' || !m.runtime) unknowns.push('RUNTIME_UNKNOWN')
  if (!m.deviceAlarm || m.deviceAlarm.activeCount === null) unknowns.push('ALARM_UNKNOWN')
  return { freshness: { sampleAt, ageSeconds, status, maxAgeSeconds: 120, maxFutureSeconds: 5 }, coverage, unknowns, actionEligible: status === 'fresh' && coverage.monitoring }
}

export function correlationBusinessFacts(value) {
  assertTpmDeviceCorrelation(value)
  // Sample times gate freshness separately from changes to the approved conditions.
  const { snapshotAt, receivedAt, recordTs, observedAt, ...monitoring } = value.monitoring
  return { source: value.source, binding: value.binding, tpm: value.tpm, device: value.device, mapping: value.mapping, monitoring }
}

function checkedSource(value, path) {
  exact(value, ['system', 'path', 'queriedAt', 'traceId'])
  if (value.system !== 'kivo' || value.path !== path || !/^[\x21-\x7e]{1,128}$/.test(value.traceId)) invalid()
  instant(value.queriedAt)
  return structuredClone(value)
}
function optionalTime(value) { if (value !== null && value !== undefined) instant(value); return value ?? null }
function nullableText(value) { if (value !== null) text(value) }
function text(value) { if (typeof value !== 'string' || !value.trim()) invalid(); return value }
function revision(value) { if (Number.isSafeInteger(value) && value >= 0) return String(value); if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) return value; invalid() }
function instant(value) { const at = parseTpmInstant(value); if (at === undefined) invalid(); return at }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid() }
function invalid(message = 'Kivo TPM 与设备监控关联不符合固定契约') { throw tpmError('INVALID_SOURCE', message) }
