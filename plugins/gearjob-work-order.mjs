import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GEARJOB_TOOL } from '../src/capabilities.mjs'
import { authorizeExecutionGrant, consumeExecutionGrant, resolveCredentialFile } from '../src/execution-grant.mjs'

export const name = 'geneway-gearjob-work-order'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(createGearJobWorkOrderTool())
}

export function createGearJobWorkOrderTool({ authorize = defaultAuthorize } = {}) {
  return defineTool({
    name: GEARJOB_TOOL,
    description: 'Read one explicitly authorized GearJob-compatible Work Order through its standard read-only REST endpoint.',
    parameters: {
      workOrderId: { type: 'string', description: 'The exact authorized work order identifier.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
          workOrderId: { type: 'string' },
          status: { type: 'string' },
          plannedQuantity: { type: 'number' },
          completedQuantity: { type: 'number' },
          unit: { type: 'string' },
          sourceTime: { type: 'string' },
          sourceRecordId: { type: 'string' },
          sourceRevision: { type: 'string' },
          sourceSystem: { type: 'string' },
          sourceInstance: { type: 'string' },
          sourceEnvironment: { type: 'string' },
          dataMode: { type: 'string' },
          evidenceMode: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try {
        const grant = await authorize({ toolName: GEARJOB_TOOL, input: args, invocation })
        if (invocation.signal?.aborted) throw sourceError('CANCELLED', '本次执行已停止')
        return {
          ok: true,
          ...await readGearJobWorkOrder({
            workOrderId: args?.workOrderId,
            connection: grant.connection,
            secretRoot: grant.secretRoot,
            signal: invocation.signal,
            authorize: () => authorize({ toolName: GEARJOB_TOOL, input: args, invocation, grant }),
          }),
        }
      } catch (error) {
        return { ok: false, error: { code: safeCode(error?.code), message: error?.message || 'GearJob 查询失败' } }
      }
    },
  })
}

async function defaultAuthorize({ toolName, input, grant }) {
  const value = grant ?? await consumeExecutionGrant({ toolName, input })
  await authorizeExecutionGrant(value)
  return value
}

export async function assertExecutionGrant(workOrderId, filePath = process.env.GENEWAY_DSH_GRANT_FILE) {
  return consumeExecutionGrant({ filePath, toolName: GEARJOB_TOOL, input: { workOrderId } })
}

export async function readGearJobWorkOrder({ workOrderId, connection, secretRoot, config, signal, timeoutMs = 15_000, fetchImpl = fetch, authorize = async () => undefined } = {}) {
  const source = connection ?? legacyConnection(config?.source)
  const root = secretRoot ?? config?.source?.secretRoot
  if (!source || !root) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob source is not configured')
  const id = exactId(workOrderId)
  if (!source.allowedObjectIds?.includes(id)) throw sourceError('FORBIDDEN', '工单不在当前连接的允许范围内')
  const credentialFile = await resolveCredentialFile(root, source.credentialRef)
  const authorization = await readAuthorization(credentialFile)
  if (signal?.aborted) throw sourceError('CANCELLED', '本次执行已停止')
  await authorize()
  const url = resourceUrl(source.baseUrl, id)
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization,
        ...(source.hostHeader ? { host: source.hostHeader } : {}),
      },
      signal: requestSignal,
    })
  } catch (error) {
    throw requestError(error, signal, timeout)
  }
  if (response.status === 404) throw sourceError('NOT_FOUND', 'GearJob 中不存在该工单')
  if (response.status === 401 || response.status === 403) throw sourceError('FORBIDDEN', 'GearJob 拒绝了只读查询')
  if (!response.ok) throw sourceError('UPSTREAM_ERROR', `GearJob 查询失败（HTTP ${response.status}）`)
  let body
  try {
    body = await response.json()
  } catch (error) {
    if (requestSignal.aborted) throw requestError(error, signal, timeout)
    throw sourceError('INVALID_SOURCE', 'GearJob 返回的内容不是 JSON')
  }
  return normalizeGearJobRecord(body?.data ?? body, { id, source })
}

export function normalizeGearJobRecord(record, { id, source, baseUrl } = {}) {
  const trusted = source ?? legacyConnection({ baseUrl })
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw sourceError('INVALID_SOURCE', 'GearJob 工单记录格式无效')
  if (!trusted) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob source metadata is not configured')
  const workOrderId = text(record.name ?? record.work_order_id ?? record.workOrderId ?? record.id ?? id)
  if (!workOrderId) throw sourceError('INVALID_SOURCE', 'GearJob 工单缺少稳定标识')
  return compact({
    workOrderId,
    status: text(record.status ?? record.workflow_state ?? 'unknown') ?? 'unknown',
    plannedQuantity: number(record.qty ?? record.planned_qty ?? record.plannedQuantity ?? record.planned_quantity),
    completedQuantity: number(record.produced_qty ?? record.completed_qty ?? record.completedQuantity ?? record.completed_quantity),
    unit: text(record.stock_uom ?? record.uom ?? record.unit),
    sourceTime: text(record.source_time ?? record.sourceTime ?? record.modified ?? record.observed_at),
    sourceRecordId: `Work Order:${workOrderId}`,
    sourceRevision: text(record.modified ?? record.revision ?? record.version),
    sourceSystem: requiredMetadata(trusted.sourceSystem, 'sourceSystem'),
    sourceInstance: requiredMetadata(trusted.sourceInstance, 'sourceInstance'),
    sourceEnvironment: requiredMetadata(trusted.sourceEnvironment, 'sourceEnvironment'),
    dataMode: requiredMetadata(trusted.dataMode, 'dataMode'),
    evidenceMode: requiredMetadata(trusted.evidenceMode, 'evidenceMode'),
  })
}

async function readAuthorization(filePath) {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const metadata = await handle.stat()
    if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file permissions must be 0600')
    const raw = (await handle.readFile('utf8')).trim()
    if (!raw) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file is empty')
    let value = raw
    try {
      const parsed = JSON.parse(raw)
      value = parsed.authorization ?? parsed.token ?? parsed.apiToken ?? parsed.api_key ?? (parsed.apiKey && parsed.apiSecret ? `${parsed.apiKey}:${parsed.apiSecret}` : undefined)
    } catch {
      const match = raw.match(/^(?:token|authorization|api[_-]?token)\s*:\s*(.+)$/i)
      if (match) value = match[1].trim()
    }
    if (typeof value !== 'string' || !value.trim()) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file has no usable token')
    const token = value.trim()
    return /^(?:token|bearer)\s+/i.test(token) ? token : `token ${token}`
  } catch (error) {
    if (error?.code === 'SOURCE_NOT_CONFIGURED') throw error
    throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file is unavailable')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function resourceUrl(baseUrl, id) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const prefix = base.pathname.replace(/\/+$/, '')
  base.pathname = `${prefix.endsWith('/api') ? prefix : `${prefix}/api`}/resource/Work%20Order/${encodeURIComponent(id)}`
  base.search = ''
  base.hash = ''
  return base
}

function legacyConnection(source) {
  if (!source?.baseUrl) return undefined
  return {
    id: 'legacy-source',
    revision: 1,
    kind: 'gearjob-rest',
    targetIdentity: safeInstance(source.baseUrl),
    baseUrl: source.baseUrl,
    hostHeader: source.hostHeader,
    credentialRef: source.credentialRef,
    allowedObjectIds: source.allowedObjectIds ?? source.allowedWorkOrders ?? [],
    sourceSystem: source.sourceSystem ?? 'GearJob',
    sourceInstance: source.sourceInstance ?? safeInstance(source.baseUrl),
    sourceEnvironment: source.sourceEnvironment ?? 'external-test',
    dataMode: source.dataMode ?? 'synthetic',
    evidenceMode: source.evidenceMode ?? 'real-frappe-rest',
  }
}

function requestError(error, signal, timeout) {
  if (signal?.aborted) return sourceError('CANCELLED', '本次执行已停止')
  if (timeout.aborted || error?.name === 'TimeoutError') return sourceError('UPSTREAM_TIMEOUT', 'GearJob 查询超时')
  return sourceError('UPSTREAM_ERROR', 'GearJob 查询连接失败')
}

function safeInstance(baseUrl) {
  try { return new URL(baseUrl).host } catch { return 'configured' }
}

function exactId(value) {
  const id = text(value)
  if (!id || id.length > 140 || /[\u0000-\u001f\u007f]/.test(id)) throw sourceError('INVALID_REQUEST', '工单号无效')
  return id
}

function requiredMetadata(value, key) {
  const result = text(value)
  if (!result) throw sourceError('SOURCE_NOT_CONFIGURED', `连接快照缺少 ${key}`)
  return result
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function sourceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function safeCode(code) {
  const allowed = new Set(['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE'])
  return allowed.has(code) ? code : 'UPSTREAM_ERROR'
}
