import { createHash, createHmac, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WORK_ORDER_DEVICE_CORRELATION_TOOL } from '../src/capabilities.mjs'
import { authorizeExecutionGrant, consumeExecutionGrant, resolveCredentialFile } from '../src/execution-grant.mjs'

export const name = 'geneway-work-order-device-correlation'
export const inject = ['tools']

const MAPPING_PATH = '/api/method/gearjob.api.work_order_p6.resolve_work_order_mapping'
const DEVICES_PATH = '/api/v1/tenant-integrations/devices'
const MAPPING_AUDIENCE = 'gearjob-work-order-mapping-connector'
const MAPPING_STEP = 'resolve_work_order_mes_unit'
const PROFILE_VERSION = 'gearjob-work-order-status-dev/1'
const FIELD_MASK_VERSION = 'gearjob-work-order-status-nine-fields/1'
const UNKNOWN_QUALITY = 'QUALITY_NOT_PROVIDED'
const UNKNOWN_PLATFORM_TIME = 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'
const MACHINE_FACT_KEYS = ['mode', 'machine_state', 'is_alive', 'is_online', 'alarm', 'alarm_code']

export function apply(ctx) {
  ctx.tools.register(createWorkOrderDeviceCorrelationTool())
}

export function createWorkOrderDeviceCorrelationTool({ authorize = defaultAuthorize } = {}) {
  return defineTool({
    name: WORK_ORDER_DEVICE_CORRELATION_TOOL,
    description: 'Read one authorized GearJob Work Order mapping and its authorized Hive device latest record without writing either source.',
    parameters: { workOrderId: { type: 'string', description: 'The exact authorized GearJob Work Order identifier.' } },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries([
              ['ok', { type: 'boolean', const: true, required: true }],
              ['workOrderId', { type: 'string', required: true }],
              ['queriedAt', { type: 'string', required: true }],
              ...['connections', 'gearJob', 'hive', 'mapping', 'tenant', 'device', 'sample', 'freshness', 'machineFacts'].map(key => [key, { type: 'object', additionalProperties: true, properties: {}, required: true }]),
              ['status', { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }], required: true }],
              ['recordId', { type: 'string', required: true }],
              ['eventId', { type: 'string', required: true }],
              ['unknowns', { type: 'array', items: { type: 'string' }, required: true }],
            ]),
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              error: { type: 'object', required: true, additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try {
        const grant = await authorize({ toolName: WORK_ORDER_DEVICE_CORRELATION_TOOL, input: args, invocation })
        return { ok: true, ...await readWorkOrderDeviceCorrelation({
          workOrderId: args?.workOrderId,
          connections: grant.connections,
          secretRoot: grant.secretRoot,
          signal: invocation.signal,
          authorize: () => authorize({ toolName: WORK_ORDER_DEVICE_CORRELATION_TOOL, input: args, invocation, grant }),
        }) }
      } catch (error) {
        return { ok: false, error: { code: safeCode(error?.code), message: safeMessage(error) } }
      }
    },
  })
}

async function defaultAuthorize({ toolName, input, grant }) {
  if (!grant) return consumeExecutionGrant({ toolName, input })
  await authorizeExecutionGrant(grant)
  return grant
}

export async function readWorkOrderDeviceCorrelation({ workOrderId, connections, secretRoot, signal, timeoutMs = 15_000, fetchImpl = fetch, authorize = async () => undefined, clock = () => new Date() } = {}) {
  const id = exactText(workOrderId, 'INVALID_REQUEST', '工单号无效')
  const gearJob = connections?.gearJob
  const hive = connections?.hive
  if (gearJob?.kind !== 'gearjob-rest' || hive?.kind !== 'hive-tenant-records' || !uuid(hive.targetIdentity)) throw sourceError('FORBIDDEN', '双来源连接授权无效')
  if (!gearJob.allowedObjectIds?.includes(id)) throw sourceError('FORBIDDEN', '工单不在 GearJob 连接允许范围内')
  if (!Array.isArray(hive.allowedObjectIds) || hive.allowedObjectIds.length !== 1) throw sourceError('FORBIDDEN', 'Hive 连接对象范围无效')

  const [gearCredential, hiveCredential] = await Promise.all([
    readCredential(await resolveCredentialFile(secretRoot, gearJob.credentialRef), 'gearjob'),
    readCredential(await resolveCredentialFile(secretRoot, hive.credentialRef), 'hive'),
  ])
  const mapping = normalizeMapping(await getJson({
    connection: gearJob,
    path: MAPPING_PATH,
    query: { work_order_ref: id },
    headers: {
      authorization: `token ${gearCredential.apiKey}:${gearCredential.apiSecret}`,
      'x-geneway-connector-token': mappingToken(id, gearCredential.invocationSecret),
    },
    signal, timeoutMs, fetchImpl, authorize,
  }), id)
  const gearJobQueriedAt = instant(clock(), 'INVALID_SOURCE', 'GearJob 查询时间无效')
  if (!hive.allowedObjectIds.includes(mapping.hiveUnitId)) throw sourceError('FORBIDDEN', '映射设备不在 Hive 连接允许范围内')

  const tenantId = hive.targetIdentity
  const devices = normalizeDevices(await getJson({
    connection: hive,
    path: DEVICES_PATH,
    query: { tenant_id: tenantId },
    headers: { 'x-api-key': hiveCredential.apiKey },
    signal, timeoutMs, fetchImpl, authorize,
  }), mapping.hiveUnitId)
  const latest = normalizeLatest(await getJson({
    connection: hive,
    path: `${DEVICES_PATH}/${encodeURIComponent(devices.deviceId)}/latest`,
    query: { tenant_id: tenantId },
    headers: { 'x-api-key': hiveCredential.apiKey },
    signal, timeoutMs, fetchImpl, authorize,
  }), { tenantId, deviceId: devices.deviceId, deviceCode: mapping.hiveUnitId })

  const queried = clock()
  const queriedAt = instant(queried, 'INVALID_SOURCE', '查询时间无效')
  const ageSeconds = (queried.getTime() - latest.sampleTime.getTime()) / 1000
  if (ageSeconds > 120) throw sourceError('INVALID_SOURCE', 'Hive 最新采样已过期')
  if (ageSeconds < -5) throw sourceError('INVALID_SOURCE', 'Hive 最新采样时间超出允许的未来偏差')
  const unknowns = []
  if (latest.quality === null) unknowns.push(UNKNOWN_QUALITY)
  if (latest.platformReceivedAt === null) unknowns.push(UNKNOWN_PLATFORM_TIME)

  return {
    workOrderId: id,
    queriedAt,
    connections: {
      gearJob: { id: exactText(gearJob.id, 'FORBIDDEN', 'GearJob 连接无效'), revision: positiveRevision(gearJob.revision) },
      hive: { id: exactText(hive.id, 'FORBIDDEN', 'Hive 连接无效'), revision: positiveRevision(hive.revision) },
    },
    gearJob: sourceSnapshot(gearJob, mapping.sourceRevision, gearJobQueriedAt),
    hive: sourceSnapshot(hive, latest.recordId, queriedAt),
    mapping: { operation: mapping.operation, workstation: mapping.workstation, mesUnitId: mapping.mesUnitId, hiveUnitId: mapping.hiveUnitId },
    tenant: { id: tenantId },
    device: { id: devices.deviceId, code: mapping.hiveUnitId },
    sample: { ts: latest.sampleTime.toISOString(), platformReceivedAt: latest.platformReceivedAt, quality: latest.quality },
    status: latest.status,
    recordId: latest.recordId,
    eventId: latest.eventId,
    freshness: { ageSeconds, maxAgeSeconds: 120, maxFutureSkewSeconds: 5 },
    machineFacts: latest.machineFacts,
    unknowns,
  }
}

function normalizeMapping(value, workOrderId) {
  if (!plainObject(value) || value.workOrderRef !== workOrderId || value.mappingStatus !== 'unique'
    || value.operationCount !== 1 || !Array.isArray(value.mappings) || value.mappings.length !== 1) throw sourceError('INVALID_SOURCE', 'GearJob 未返回唯一有效映射')
  const sourceRevision = exactText(value.sourceRevision, 'INVALID_SOURCE', 'GearJob mapping sourceRevision 无效')
  if (!/^modified:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sourceRevision)
    || !Number.isFinite(Date.parse(sourceRevision.slice('modified:'.length)))) throw sourceError('INVALID_SOURCE', 'GearJob mapping sourceRevision 无效')
  const row = value.mappings[0]
  if (!plainObject(row)) throw sourceError('INVALID_SOURCE', 'GearJob mapping 行无效')
  return {
    sourceRevision,
    operation: exactText(row.operation, 'INVALID_SOURCE', 'GearJob mapping operation 无效'),
    workstation: exactText(row.workstation, 'INVALID_SOURCE', 'GearJob mapping workstation 无效'),
    mesUnitId: exactText(row.mesUnitId, 'INVALID_SOURCE', 'GearJob mapping mesUnitId 无效'),
    hiveUnitId: exactText(row.hiveUnitId, 'INVALID_SOURCE', 'GearJob mapping hiveUnitId 无效'),
  }
}

function normalizeDevices(value, deviceCode) {
  if (!plainObject(value) || !Array.isArray(value.rows) || !Number.isSafeInteger(value.count) || value.count !== value.rows.length) throw sourceError('INVALID_SOURCE', 'Hive 设备清单 count 不闭合')
  const rows = value.rows.map(row => {
    if (!plainObject(row) || !uuid(row.device_id) || typeof row.device_code !== 'string' || !row.device_code.trim()) throw sourceError('INVALID_SOURCE', 'Hive 设备清单 identity 无效')
    return { deviceId: row.device_id, deviceCode: row.device_code }
  })
  const matches = rows.filter(row => row.deviceCode === deviceCode)
  if (matches.length !== 1) throw sourceError('INVALID_SOURCE', 'Hive 设备映射不是唯一结果')
  return matches[0]
}

function normalizeLatest(value, identity) {
  if (!plainObject(value) || value.device_id !== identity.deviceId || value.device_code !== identity.deviceCode
    || value.tenant_id !== undefined && value.tenant_id !== identity.tenantId
    || value.tenantId !== undefined && value.tenantId !== identity.tenantId) throw sourceError('INVALID_SOURCE', 'Hive latest identity 不匹配')
  const record = value.record
  if (!plainObject(record)) throw sourceError('INVALID_SOURCE', 'Hive latest 没有遥测记录')
  const sampleTime = parsedInstant(record.ts, 'Hive latest ts 无效')
  if (!plainObject(record.data)) throw sourceError('INVALID_SOURCE', 'Hive latest data 无效')
  if (!scalar(record.status)) throw sourceError('INVALID_SOURCE', 'Hive latest status 无效')
  normalizeQuality(record.quality)
  return {
    sampleTime,
    platformReceivedAt: null,
    quality: null,
    status: record.status,
    recordId: exactText(record.record_id, 'INVALID_SOURCE', 'Hive latest record_id 无效'),
    eventId: exactText(record.event_id, 'INVALID_SOURCE', 'Hive latest event_id 无效'),
    machineFacts: machineFacts(record.data),
  }
}

function normalizeQuality(value) {
  if (value === undefined || value === null) return null
  if (!scalar(value)) throw sourceError('INVALID_SOURCE', 'Hive quality 无效')
  if (value === false || value === 0 || typeof value === 'string' && ['bad', 'invalid', 'error', 'poor', 'unusable', 'stale'].includes(value.trim().toLowerCase())) throw sourceError('INVALID_SOURCE', 'Hive 明确返回坏质量')
  return null
}

function machineFacts(data) {
  const result = {}
  for (const key of MACHINE_FACT_KEYS) {
    if (data[key] === undefined || data[key] === null) continue
    if (!machineFactScalar(key, data[key])) throw sourceError('INVALID_SOURCE', `Hive machineFacts ${key} 无效`)
    result[key] = data[key]
  }
  return result
}

async function getJson({ connection, path, query, headers, signal, timeoutMs, fetchImpl, authorize }) {
  if (signal?.aborted) throw abortError(signal)
  await authorize()
  if (signal?.aborted) throw abortError(signal)
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(requestUrl(connection.baseUrl, path, query), {
      method: 'GET', redirect: 'error', signal: requestSignal,
      headers: { accept: 'application/json', ...headers, ...(connection.hostHeader ? { host: connection.hostHeader } : {}) },
    })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    if (timeout.aborted || error?.name === 'TimeoutError') throw sourceError('UPSTREAM_TIMEOUT', '来源查询超时')
    throw sourceError('UPSTREAM_ERROR', '来源查询连接失败')
  }
  if (response.status === 401 || response.status === 403) throw sourceError('FORBIDDEN', '来源拒绝了只读查询')
  if (response.status === 404) throw sourceError('NOT_FOUND', '来源中不存在获准对象')
  if (!response.ok) throw sourceError('UPSTREAM_ERROR', `来源查询失败（HTTP ${response.status}）`)
  try { return await response.json() } catch { throw sourceError('INVALID_SOURCE', '来源返回的内容不是 JSON') }
}

async function readCredential(filePath, kind) {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const value = JSON.parse(await handle.readFile('utf8'))
    if (!plainObject(value)) throw new Error('shape')
    if (kind === 'hive') return { apiKey: secretText(value.apiKey) }
    const apiKey = secretText(value.apiKey), apiSecret = secretText(value.apiSecret), invocationSecret = secretText(value.invocationSecret)
    if (/[:\s]/.test(apiKey) || /[:\s]/.test(apiSecret) || Buffer.byteLength(invocationSecret) < 32) throw new Error('shape')
    return { apiKey, apiSecret, invocationSecret }
  } catch {
    throw sourceError('SOURCE_NOT_CONFIGURED', `${kind === 'hive' ? 'Hive' : 'GearJob'} credential 无效`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function mappingToken(workOrderId, secret) {
  const now = Math.floor(Date.now() / 1000)
  const invocationId = randomUUID()
  const queryHash = createHash('sha256').update(canonicalJson({ operation: 'resolve_work_order_mapping', parameters: { workOrderRef: workOrderId }, schemaVersion: 'gearjob-p6-request/1' })).digest('hex')
  const claims = {
    schemaVersion: 'connector-invocation-token/1', iss: 'geneway-control-plane', aud: MAPPING_AUDIENCE,
    tenantId: 'geneway-p6', principal: 'geneway-p6-correlation', taskId: 'geneway-p6-correlation',
    workflowVersionId: 'manufacturing-work-order-device-correlate/1', workflowHash: sha256('manufacturing-work-order-device-correlate/1'),
    stepId: MAPPING_STEP, attemptId: `attempt-${invocationId}`, effectId: 'effect-p6-correlation-read', connectorInvocationId: invocationId,
    connectorQuerySpecHash: queryHash, connectorProfileVersion: PROFILE_VERSION, workOrderRefHash: sha256(workOrderId),
    fieldMaskVersion: FIELD_MASK_VERSION, resourceContextDigest: sha256(`gearjob:${workOrderId}`),
    deadline: new Date((now + 60) * 1000).toISOString(), fence: 1, jti: randomUUID(), iat: now, exp: now + 60,
  }
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`
}

function requestUrl(baseUrl, path, query) {
  let url
  try { url = new URL(baseUrl) } catch { throw sourceError('SOURCE_NOT_CONFIGURED', '连接地址无效') }
  url.pathname = path
  url.search = new URLSearchParams(query).toString()
  url.hash = ''
  return url
}

function sourceSnapshot(connection, sourceRevision, queriedAt) {
  return Object.fromEntries(['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, exactText(connection[key], 'FORBIDDEN', `连接 ${key} 无效`)]).concat([['sourceRevision', sourceRevision], ['queriedAt', queriedAt]]))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function secretText(value) { if (typeof value !== 'string' || !value.trim()) throw new Error('secret'); return value.trim() }
function exactText(value, code, message) { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw sourceError(code, message); return value.trim() }
function positiveRevision(value) { if (!Number.isSafeInteger(value) || value < 1) throw sourceError('FORBIDDEN', '连接 revision 无效'); return value }
function parsedInstant(value, message) {
  if (typeof value !== 'string') throw sourceError('INVALID_SOURCE', message)
  const naive = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,6})$/)
  const explicit = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/)
  const match = naive ?? explicit
  if (!match) throw sourceError('INVALID_SOURCE', message)
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (!validDateTime(year, month, day, hour, minute, second)) throw sourceError('INVALID_SOURCE', message)
  const millisecond = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3))
  let offsetMinutes = 0
  if (explicit && match[8] !== 'Z') {
    const offsetHour = Number(match[10]), offsetMinute = Number(match[11])
    if (offsetHour > 23 || offsetMinute > 59) throw sourceError('INVALID_SOURCE', message)
    offsetMinutes = (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute)
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000)
}
function validDateTime(year, month, day, hour, minute, second) {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}
function instant(value, code, message) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw sourceError(code, message); return date.toISOString() }
function plainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function scalar(value) { return typeof value === 'string' && Boolean(value.trim()) || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' }
function machineFactScalar(key, value) {
  if (typeof value === 'string') return !/[\u0000-\u001f\u007f]/.test(value) && (Boolean(value.trim()) || key === 'alarm_code' && value === '')
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function sourceError(code, message) { return Object.assign(new Error(message), { code }) }
function abortError(signal) { return signal?.reason?.code === 'UPSTREAM_TIMEOUT' ? sourceError('UPSTREAM_TIMEOUT', '来源查询超时') : sourceError('CANCELLED', '本次执行已停止') }
function safeCode(code) { return ['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE'].includes(code) ? code : 'UPSTREAM_ERROR' }
function safeMessage(error) { return typeof error?.message === 'string' && error.message && !/apiKey|apiSecret|invocationSecret|credentialRef|raw/i.test(error.message) ? error.message : '双来源关联失败' }
