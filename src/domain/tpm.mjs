import { isDeepStrictEqual } from 'node:util'

export const KIVO_TPM_TOOLS = Object.freeze({ readRecord: 'geneway_kivo_tpm_read_record', listRecords: 'geneway_kivo_tpm_list_records', correlateDevice: 'geneway_kivo_tpm_correlate_device' })
export const KIVO_TPM_RESULT_KIND = 'kivo.tpm.observation'
export const TPM_RECORD_TYPES = Object.freeze(['repair', 'maintenance', 'inspection', 'exception', 'plan', 'device'])
export const TPM_LIST_RECORD_TYPES = Object.freeze(TPM_RECORD_TYPES.filter(type => type !== 'device'))
export const TPM_FILTERS = Object.freeze({
  repair: ['page', 'pageSize', 'keyword', 'deviceId', 'archive', 'status'],
  maintenance: ['page', 'pageSize', 'keyword', 'deviceId', 'archive', 'status'],
  inspection: ['page', 'pageSize', 'keyword', 'deviceId', 'archive', 'status', 'tab'],
  exception: ['page', 'pageSize', 'keyword', 'status', 'severity'],
  plan: ['page', 'pageSize', 'keyword', 'status', 'archive'],
})

const STATES = Object.freeze({
  repair: { reported: '已报修', dispatched: '已派工', diagnosing: '诊断中', repairing: '维修中', trial: '试运行', closed: '已关闭', cancelled: '已取消', terminated: '已终止' },
  maintenance: { pending: '待处理', dispatched: '已派工', in_progress: '进行中', paused: '已暂停', pending_acceptance: '待验收', accepted: '已验收', returned: '已退回', closed: '已关闭', cancelled: '已取消', terminated: '已终止' },
  inspection: { pending: '待点检', in_progress: '进行中', completed: '已完成', cancelled: '已取消', terminated: '已终止' },
  exception: { open: '待处置', disposed: '已处置', closed: '已关闭' },
  plan: { active: '启用', paused: '暂停' },
  device: {},
})
const TERMINAL = new Set(['closed', 'completed', 'accepted', 'cancelled', 'terminated'])
const TIME_FIELDS = ['createdAt', 'updatedAt', 'scheduledAt', 'startedAt', 'completedAt', 'closedAt', 'latestOccurredAt', 'lastTrustedAt']
const SOURCE_FIELDS = ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']

export function normalizeTpmInput(mode, value, { allowMissing = false } = {}) {
  try {
    object(value, '能力输入')
    exactKeys(value, mode === 'record' ? ['recordType', 'reference'] : ['recordType', 'filters'], '能力输入')
    const types = mode === 'record' ? TPM_RECORD_TYPES : mode === 'list' ? TPM_LIST_RECORD_TYPES : []
    const input = {}, missing = []
    if (value.recordType === undefined || value.recordType === '') missing.push('recordType')
    else if (!types.includes(value.recordType)) throw tpmError('INVALID_REQUEST', 'TPM 记录类型无效')
    else input.recordType = value.recordType
    if (mode === 'record') {
      if (value.reference === undefined || value.reference === '') missing.push('reference')
      else {
        if (typeof value.reference !== 'string') throw tpmError('INVALID_REQUEST', 'TPM 记录标识必须是文本')
        const reference = value.reference.trim()
        if (!reference || reference.length > 128 || /[/\\?#\u0000-\u001f\u007f]/.test(reference) || ['.', '..'].includes(reference)) throw tpmError('INVALID_REQUEST', 'TPM 记录标识无效')
        if (['plan', 'device'].includes(input.recordType) && !uuid(reference)) throw tpmError('INVALID_REQUEST', '计划和设备必须使用明确 UUID')
        input.reference = reference
      }
    } else if (mode === 'list') {
      input.filters = normalizeFilters(input.recordType, value.filters ?? {})
    } else throw tpmError('INVALID_REQUEST', 'TPM 操作类型无效')
    if (missing.length && !allowMissing) return { ok: false, input, missing, error: { code: 'MISSING_INPUT', message: `缺少能力输入：${missing.join('、')}` } }
    return { ok: true, input, missing }
  } catch (error) {
    return { ok: false, missing: [], error: { code: 'INVALID_REQUEST', message: error.message } }
  }
}

function normalizeFilters(recordType, value) {
  object(value, '列表过滤条件')
  if (!recordType && Object.keys(value).length) throw tpmError('INVALID_REQUEST', '请先选择 TPM 记录类型')
  exactKeys(value, TPM_FILTERS[recordType] ?? [], '列表过滤条件')
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'page' || key === 'pageSize') {
      if (!Number.isInteger(raw) || raw < 1 || raw > (key === 'page' ? 1_000_000 : 100)) throw tpmError('INVALID_REQUEST', '分页参数超出允许范围')
      result[key] = raw
    } else if (key === 'keyword') {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 200) throw tpmError('INVALID_REQUEST', '检索词为空或过长')
      result[key] = raw.trim()
    } else if (key === 'deviceId') {
      if (!uuid(raw)) throw tpmError('INVALID_REQUEST', '设备标识无效')
      result[key] = raw
    } else {
      const allowed = key === 'archive' ? ['active', 'archived', 'all']
        : key === 'severity' ? ['blocking', 'general', 'notice']
          : key === 'tab' ? ['pending', 'overdue', 'blocking'] : Object.keys(STATES[recordType] ?? {})
      if (!allowed.includes(raw)) throw tpmError('INVALID_REQUEST', '列表过滤值未获准')
      result[key] = raw
    }
  }
  return result
}

export function tpmToolRequest(mode, input) {
  const parsed = normalizeTpmInput(mode, input)
  if (!parsed.ok) throw tpmError(parsed.error.code, parsed.error.message)
  const { recordType, reference, filters } = parsed.input
  if (mode === 'list') return { name: `tpm.${recordType}.list`, arguments: filters }
  const key = recordType === 'inspection' ? 'inspectionNo' : recordType === 'exception' ? 'exceptionNo' : recordType === 'plan' ? 'planId' : recordType === 'device' ? 'deviceId' : 'orderNo'
  return { name: recordType === 'device' ? 'devices.device.get' : `tpm.${recordType}.get`, arguments: { [key]: reference } }
}

export function tpmSourcePath(request) {
  if (request.name === 'devices.device.get') return `/api/v1/mes/equipment/ledger/devices/${encodeURIComponent(request.arguments.deviceId)}`
  const [, type, operation] = request.name.split('.')
  if (!TPM_LIST_RECORD_TYPES.includes(type) || !['get', 'list'].includes(operation)) throw tpmError('INVALID_REQUEST', 'TPM 工具未获准')
  const path = `/api/v1/mes/tpm/${{ repair: 'repairs', maintenance: 'maintenance', inspection: 'inspections', exception: 'exceptions', plan: 'plans' }[type]}`
  if (operation === 'get') return `${path}/${encodeURIComponent(Object.values(request.arguments)[0])}`
  const values = { page: 1, pageSize: 20, ...request.arguments, ...(type === 'plan' ? { purpose: 'maintenance' } : {}) }
  return `${path}?${new URLSearchParams(values)}`
}

export function normalizeTpmObservation({ mode, input, result, deviceResult, connection }) {
  const request = tpmToolRequest(mode, input)
  const primary = sourceResult(result)
  const linked = deviceResult ? sourceResult(deviceResult) : undefined
  const scopeEmpty = primary.status === 'scope_empty' || linked?.status === 'scope_empty'
  const values = scopeEmpty ? [] : mode === 'record' ? [object(primary.value, 'TPM 记录')] : collection(primary.value).items
  const records = values.map(value => normalizeRecord(input.recordType, value, primary.source.queriedAt))
  if (!scopeEmpty && mode === 'list') {
    const page = collection(primary.value), filters = input.filters ?? {}
    if (page.page !== (filters.page ?? 1) || page.pageSize !== (filters.pageSize ?? 20)
      || records.some(record => (filters.deviceId && record.deviceId !== filters.deviceId) || (filters.status && record.rawStatus !== filters.status))) throw tpmError('INVALID_SOURCE', 'TPM 列表与固定查询条件不一致')
  }
  if (!scopeEmpty && mode === 'record') {
    const record = records[0]
    if (record.reference !== input.reference && record.id !== input.reference) throw tpmError('INVALID_SOURCE', 'TPM 返回的记录标识不匹配')
    if (['repair', 'maintenance', 'inspection'].includes(input.recordType) && (!linked || linked.value?.id !== record.deviceId)) throw tpmError('INVALID_SOURCE', 'TPM 工单与关联设备不匹配')
  }
  const source = {}
  for (const field of SOURCE_FIELDS) source[field] = requiredText(connection?.[field], `连接缺少 ${field}`)
  source.sourceRecordId = mode === 'record' ? `${input.recordType}:${input.reference}` : request.name
  const sourceTime = mode === 'record' ? values[0]?.updatedAt : undefined
  if (sourceTime !== undefined && sourceTime !== null) source.sourceTime = requiredText(sourceTime, '来源更新时间无效')
  return {
    mode, recordType: input.recordType, status: scopeEmpty ? 'scope_empty' : 'ok',
    records,
    linkedDevice: !scopeEmpty && linked ? normalizeRecord('device', object(linked.value, '设备记录'), linked.source.queriedAt) : null,
    pagination: !scopeEmpty && mode === 'list' ? pick(collection(primary.value), ['page', 'pageSize', 'total']) : null,
    queriedAt: primary.source.queriedAt, source,
    sources: [{ toolName: request.name, ...primary.source }, ...(linked ? [{ toolName: 'devices.device.get', ...linked.source }] : [])],
  }
}

export function assertTpmObservation(value) {
  object(value, 'TPM 观察')
  exactKeys(value, ['mode', 'recordType', 'status', 'records', 'linkedDevice', 'pagination', 'queriedAt', 'source', 'sources'], 'TPM 观察', true)
  if (!['record', 'list'].includes(value.mode) || !(value.mode === 'record' ? TPM_RECORD_TYPES : TPM_LIST_RECORD_TYPES).includes(value.recordType) || !['ok', 'scope_empty'].includes(value.status)) throw tpmError('INVALID_SOURCE', 'TPM 观察类型无效')
  if (!Array.isArray(value.records) || value.records.length > 100 || (value.mode === 'record' && value.status === 'ok' && value.records.length !== 1)) throw tpmError('INVALID_SOURCE', 'TPM 观察记录数无效')
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 2) throw tpmError('INVALID_SOURCE', 'TPM 观察来源无效')
  const expectedTool = value.mode === 'record' && value.recordType === 'device' ? 'devices.device.get' : `tpm.${value.recordType}.${value.mode === 'record' ? 'get' : 'list'}`
  if (value.sources[0].toolName !== expectedTool || (value.sources[1] && (value.sources[1].toolName !== 'devices.device.get' || value.mode !== 'record' || !['repair', 'maintenance', 'inspection'].includes(value.recordType)))) throw tpmError('INVALID_SOURCE', 'TPM 来源工具不匹配')
  for (const item of value.sources) {
    object(item, 'TPM 来源')
    exactKeys(item, ['toolName', 'system', 'path', 'queriedAt', 'traceId'], 'TPM 来源', true)
    sourceResult({ status: 'scope_empty', source: pick(item, ['system', 'path', 'queriedAt', 'traceId']), value: null })
  }
  if (value.queriedAt !== value.sources[0].queriedAt) throw tpmError('INVALID_SOURCE', 'TPM 查询时间不匹配')
  object(value.source, 'TPM 来源元数据')
  exactKeys(value.source, [...SOURCE_FIELDS, 'sourceRecordId', 'sourceTime'], 'TPM 来源元数据')
  for (const key of [...SOURCE_FIELDS, 'sourceRecordId']) requiredText(value.source[key], 'TPM 来源元数据不完整')
  if (value.status === 'scope_empty' && (value.records.length || value.linkedDevice !== null || value.pagination !== null)) throw tpmError('INVALID_SOURCE', '空组织范围不能包含业务数据')
  for (const record of value.records) {
    if (!isDeepStrictEqual(record, normalizeRecord(value.recordType, record.facts, value.queriedAt))) throw tpmError('INVALID_SOURCE', 'TPM 记录与确定性规范化不一致')
  }
  if (value.linkedDevice !== null && (!isDeepStrictEqual(value.linkedDevice, normalizeRecord('device', value.linkedDevice.facts, value.sources[1]?.queriedAt)))) throw tpmError('INVALID_SOURCE', '设备记录规范化不一致')
  if (value.status === 'ok' && value.mode === 'record' && ['repair', 'maintenance', 'inspection'].includes(value.recordType) && value.linkedDevice?.id !== value.records[0].deviceId) throw tpmError('INVALID_SOURCE', '工单必须关联同一设备')
  if ((value.mode !== 'record' || !['repair', 'maintenance', 'inspection'].includes(value.recordType)) && value.linkedDevice !== null) throw tpmError('INVALID_SOURCE', 'TPM 观察含未请求的关联设备')
  if (value.mode === 'list' && value.status === 'ok') collection({ ...value.pagination, items: value.records })
  else if (value.pagination !== null) throw tpmError('INVALID_SOURCE', 'TPM 详情不能包含分页')
  return value
}

function normalizeRecord(type, value, queriedAt) {
  object(value, 'TPM 来源记录')
  const id = requiredText(value.id, 'TPM 来源记录缺少 ID')
  const reference = requiredText(type === 'inspection' ? value.inspectionNo : type === 'exception' ? value.exceptionNo : type === 'plan' || type === 'device' ? value.id : value.orderNo, 'TPM 来源记录缺少标识')
  const rawStatus = requiredText(type === 'plan' ? typeof value.active === 'boolean' && (value.active ? 'active' : 'paused') : type === 'device' ? value.lifecycleStatus : value.status, 'TPM 来源记录缺少状态')
  const status = Object.hasOwn(STATES[type], rawStatus) ? rawStatus : 'unknown'
  const times = Object.fromEntries(TIME_FIELDS.map(field => [field, value[field] ?? null]))
  for (const value of Object.values(times)) if (value !== null && typeof value !== 'string') throw tpmError('INVALID_SOURCE', 'TPM 时间字段无效')
  const unknowns = []
  if (status === 'unknown') unknowns.push('unknown_status')
  for (const [key, value] of Object.entries(times)) if (value !== null && !instant(value)) unknowns.push(`${key}:timezone_or_time_unknown`)
  const baseline = type === 'inspection' ? times.scheduledAt : null
  const baselineTime = instant(baseline), queryTime = instant(queriedAt)
  const reason = !baseline ? 'no_plan_baseline' : baselineTime === undefined || queryTime === undefined ? 'timezone_or_time_unknown' : status === 'unknown' ? 'unknown_status' : null
  const deltaMs = reason ? null : baselineTime - queryTime
  const overdue = reason ? null : !TERMINAL.has(rawStatus) && deltaMs < 0
  if (reason) unknowns.push(reason)
  const deviceId = type === 'device' ? id : requiredText(value.deviceId, 'TPM 来源记录缺少设备')
  const responsibility = pick(value, ['reporterId', 'executorId', 'acceptedById', 'assigneeId', 'assigneeDisplayName', 'executorDisplayName', 'responsibleId'])
  if (Array.isArray(value.detail?.assignees)) responsibility.assignees = structuredClone(value.detail.assignees)
  return { id, reference, rawStatus, status, statusLabel: status === 'unknown' ? '未知状态' : STATES[type][rawStatus], deviceId, responsibility, times, schedule: { baseline, deltaMs, overdue, reason }, facts: structuredClone(value), unknowns }
}

function sourceResult(value) {
  object(value, 'MCP 结构化输出')
  exactKeys(value, ['status', 'source', 'value'], 'MCP 结构化输出', true)
  if (!['ok', 'scope_empty'].includes(value.status) || (value.status === 'scope_empty' ? value.value !== null : value.value === null)) throw tpmError('INVALID_SOURCE', 'MCP 范围状态与数据不匹配')
  const source = object(value.source, 'MCP 来源')
  exactKeys(source, ['system', 'path', 'queriedAt', 'traceId'], 'MCP 来源', true)
  if (source.system !== 'kivo' || !requiredText(source.path, 'MCP 来源缺少路径').startsWith('/api/v1/mes/') || instant(source.queriedAt) === undefined || !/^[\x21-\x7e]{1,128}$/.test(source.traceId)) throw tpmError('INVALID_SOURCE', 'MCP 来源无效')
  return value
}

function collection(value) {
  object(value, 'TPM 列表')
  if (!Array.isArray(value.items) || value.items.length > 100 || !Number.isInteger(value.total) || value.total < value.items.length || !Number.isInteger(value.page) || value.page < 1 || !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100 || value.items.length > value.pageSize) throw tpmError('INVALID_SOURCE', 'TPM 列表分页无效')
  return value
}

function instant(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1] || +hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}
export { instant as parseTpmInstant }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw tpmError('INVALID_SOURCE', `${label}必须是对象`); return value }
function requiredText(value, message) { if (typeof value !== 'string' || !value.trim()) throw tpmError('INVALID_SOURCE', message); return value }
function exactKeys(value, keys, label, required = false) { if (Object.keys(value).some(key => !keys.includes(key)) || (required && keys.some(key => !Object.hasOwn(value, key)))) throw tpmError('INVALID_SOURCE', `${label}字段不符合合同`) }
function pick(value, keys) { return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])])) }
export function tpmError(code, message) { return Object.assign(new Error(message), { code }) }
