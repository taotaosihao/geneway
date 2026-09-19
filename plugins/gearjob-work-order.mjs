import { readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readRuntimeConfig } from '../src/runtime-config.mjs'

export const name = 'geneway-gearjob-work-order'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'geneway_gearjob_read_work_order',
    description: 'Read one explicitly allowed GearJob Work Order through the standard read-only REST endpoint.',
    parameters: {
      workOrderId: { type: 'string', description: 'The exact allowed work order identifier.' },
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, invocation = {}) {
      try {
        return { ok: true, ...await readGearJobWorkOrder({ workOrderId: args?.workOrderId, signal: invocation.signal }) }
      } catch (error) {
        return { ok: false, error: { code: safeCode(error?.code), message: error?.message || 'GearJob 查询失败' } }
      }
    },
  }))
}

export async function readGearJobWorkOrder({ workOrderId, config = readRuntimeConfig(), signal } = {}) {
  if (!config.source.configured) throw sourceError('SOURCE_NOT_CONFIGURED', config.source.error ?? 'GearJob source is not configured')
  const id = exactId(workOrderId)
  if (!config.source.allowedWorkOrders.includes(id)) throw sourceError('FORBIDDEN', '工单不在当前连接的允许范围内')
  const authorization = await readAuthorization(config.source.credentialFile)
  const url = resourceUrl(config.source.baseUrl, id)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization,
        ...(config.source.hostHeader ? { host: config.source.hostHeader } : {}),
      },
      signal: signal ?? AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw sourceError('UPSTREAM_TIMEOUT', 'GearJob 查询超时')
    throw sourceError('UPSTREAM_ERROR', 'GearJob 查询连接失败')
  }
  if (response.status === 404) throw sourceError('NOT_FOUND', 'GearJob 中不存在该工单')
  if (response.status === 401 || response.status === 403) throw sourceError('FORBIDDEN', 'GearJob 拒绝了只读查询')
  if (!response.ok) throw sourceError('UPSTREAM_ERROR', `GearJob 查询失败（HTTP ${response.status}）`)
  let body
  try {
    body = await response.json()
  } catch {
    throw sourceError('INVALID_SOURCE', 'GearJob 返回的内容不是 JSON')
  }
  return normalizeGearJobRecord(body?.data ?? body, { id, baseUrl: config.source.baseUrl })
}

export function normalizeGearJobRecord(record, { id, baseUrl } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw sourceError('INVALID_SOURCE', 'GearJob 工单记录格式无效')
  const workOrderId = text(record.name ?? record.work_order_id ?? record.workOrderId ?? record.id ?? id)
  if (!workOrderId) throw sourceError('INVALID_SOURCE', 'GearJob 工单缺少稳定标识')
  const sourceRecordId = `Work Order:${workOrderId}`
  return {
    workOrderId,
    status: text(record.status ?? record.workflow_state ?? 'unknown') ?? 'unknown',
    plannedQuantity: number(record.qty ?? record.planned_qty ?? record.plannedQuantity ?? record.planned_quantity),
    completedQuantity: number(record.produced_qty ?? record.completed_qty ?? record.completedQuantity ?? record.completed_quantity),
    unit: text(record.stock_uom ?? record.uom ?? record.unit),
    sourceTime: text(record.source_time ?? record.sourceTime ?? record.modified ?? record.observed_at),
    sourceRecordId,
    sourceRevision: text(record.modified ?? record.revision ?? record.version),
    sourceSystem: 'GearJob',
    sourceInstance: safeInstance(baseUrl),
    sourceEnvironment: 'external-test',
    dataMode: 'synthetic',
  }
}

async function readAuthorization(filePath) {
  try {
    const metadata = await stat(filePath)
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file permissions must be 0600')
    const raw = (await readFile(filePath, 'utf8')).trim()
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
    if (error?.code && ['SOURCE_NOT_CONFIGURED', 'FORBIDDEN'].includes(error.code)) throw error
    throw sourceError('SOURCE_NOT_CONFIGURED', 'GearJob credential file is unavailable')
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

function safeInstance(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return url.host
  } catch {
    return 'configured'
  }
}

function exactId(value) {
  const id = text(value)
  if (!id || id.length > 140 || /[\u0000-\u001f\u007f]/.test(id)) throw sourceError('INVALID_REQUEST', '工单号无效')
  return id
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function sourceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeCode(code) {
  const allowed = new Set(['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE'])
  return allowed.has(code) ? code : 'UPSTREAM_ERROR'
}
