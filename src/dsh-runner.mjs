import { existsSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { readRuntimeConfig, readSettings } from './runtime-config.mjs'

export const GEARJOB_TOOL = 'geneway_gearjob_read_work_order'

export function createDshRunner({ root = process.cwd(), config = readRuntimeConfig(process.env, root), harnessFactory = options => new DeepSeekHarness(options) } = {}) {
  const active = new Map()
  const sessions = new Map()
  const grants = new WeakMap()
  const patch = resolve(root, 'config', 'p1-runtime.patch.yml')

  return {
    configured: config.model.configured && existsSync(patch),
    sourceConfigured: config.source.configured && existsSync(patch),

    async run({ executionId, sessionId, workOrderId, observation, question, operation = 'create' } = {}) {
      const id = String(executionId || `run-${Date.now()}`)
      const requestedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : undefined
      let harness = requestedSessionId ? sessions.get(requestedSessionId) : undefined
      const sameSession = Boolean(harness && requestedSessionId)
      const successorFrom = !sameSession ? requestedSessionId : undefined
      const createdHarness = !harness
      if (!harness) {
        const grantDirectory = join(config.dshHome, 'grants')
        await mkdir(grantDirectory, { recursive: true, mode: 0o700 })
        const grantFile = join(grantDirectory, `grant-${randomUUID()}.json`)
        await writeGrant(grantFile, { operation: 'initializing', workOrderId, allowRead: false })
        harness = harnessFactory({
          profile: 'sdk',
          patches: [patch],
          dshHome: config.dshHome,
          processCwd: root,
          cwd: root,
          provider: config.model.provider,
          model: config.model.model,
          env: childEnvironment(config, grantFile),
          initializeTimeoutMs: 15_000,
          requestTimeoutMs: 120_000,
        })
        grants.set(harness, grantFile)
      }
      const grantFile = grants.get(harness)
      await writeGrant(grantFile, { operation, workOrderId, allowRead: operation !== 'follow-up' })
      active.set(id, { harness, sessionId: requestedSessionId, closed: false })
      try {
        const result = await harness.run(buildPrompt({ operation, workOrderId, observation, question }), sameSession ? { sessionId: requestedSessionId } : undefined)
        const parsed = parseRunResult(result, { operation, workOrderId })
        const actualSessionId = result.sessionId
        sessions.set(actualSessionId, harness)
        if (requestedSessionId && requestedSessionId !== actualSessionId) sessions.delete(requestedSessionId)
        return {
          ...parsed,
          dshSessionRef: actualSessionId,
          continuedFromDshSessionRef: successorFrom,
          contextObservationId: observation?.observationId,
          continuity: sameSession ? 'same-session' : successorFrom ? 'successor' : 'new',
          eventCount: result.events?.length ?? 0,
        }
      } catch (error) {
        if (createdHarness && !active.get(id)?.closed) {
          await harness.close().catch(() => undefined)
          await removeHarness(harness)
        }
        throw error
      } finally {
        active.delete(id)
      }
    },

    async cancel(executionId) {
      const activeRun = active.get(executionId)
      if (!activeRun) return false
      activeRun.closed = true
      await activeRun.harness.close().catch(() => undefined)
      await removeHarness(activeRun.harness)
      return true
    },

    async close() {
      const harnesses = [...new Set([...sessions.values(), ...[...active.values()].map(item => item.harness)])]
      await Promise.all(harnesses.map(harness => harness.close().catch(() => undefined)))
      await Promise.all(harnesses.map(removeHarness))
      active.clear()
      sessions.clear()
    },
  }

  async function removeHarness(harness) {
    for (const [sessionId, candidate] of sessions) if (candidate === harness) sessions.delete(sessionId)
    const grantFile = grants.get(harness)
    grants.delete(harness)
    if (grantFile) await unlink(grantFile).catch(() => undefined)
  }
}

export function parseRunResult(result, { operation, workOrderId } = {}) {
  const calls = (result?.events ?? []).filter(event => event.type === 'tool/call')
  const results = (result?.events ?? []).filter(event => event.type === 'tool/result')
  if (operation === 'follow-up') {
    if (calls.length || results.length) throw runnerError('TOOL_CHAIN_INVALID', '追问执行禁止调用工具')
    const explanation = nonEmpty(result?.finalResponse)
    if (!explanation) throw runnerError('TOOL_CHAIN_INVALID', '追问执行没有模型说明')
    return { explanation }
  }
  if (calls.length !== 1 || results.length !== 1) throw runnerError('TOOL_CHAIN_INVALID', '工单执行必须恰好有一次工具调用和一次工具结果')
  const call = calls[0]?.data
  const toolResult = results[0]?.data
  if (call?.name !== GEARJOB_TOOL) throw runnerError('TOOL_CHAIN_INVALID', '调用了非 GearJob 只读工具')
  if (typeof call.callId !== 'string' || !call.callId.trim()) throw runnerError('TOOL_CHAIN_INVALID', '工具调用缺少 callId')
  let argumentsValue
  try { argumentsValue = JSON.parse(call.arguments) } catch { throw runnerError('TOOL_CHAIN_INVALID', '工具参数不是 JSON') }
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue) || argumentsValue.workOrderId !== workOrderId || Object.keys(argumentsValue).length !== 1) throw runnerError('TOOL_CHAIN_INVALID', '工具参数工单号不匹配')
  const message = toolResult?.message
  if (!message || message.source?.kind !== 'tool' || message.source.callId !== call.callId) throw runnerError('TOOL_CHAIN_INVALID', '工具结果缺失或标记为错误')
  const content = message.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'tool-result' || content[0].isError !== false || content[0].toolCallId !== call.callId || !Array.isArray(content[0].content) || content[0].content.length !== 1 || content[0].content[0]?.type !== 'text') throw runnerError('TOOL_CHAIN_INVALID', '工具结果结构不符合合同')
  let observation
  try { observation = JSON.parse(content[0].content[0].text) } catch { throw runnerError('TOOL_CHAIN_INVALID', '工具结果不是 JSON') }
  if (observation?.ok === false) {
    const code = observation.error?.code
    const message = observation.error?.message
    const allowed = new Set(['INVALID_REQUEST', 'SOURCE_NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'INVALID_SOURCE'])
    if (!allowed.has(code) || typeof message !== 'string' || !message.trim()) throw runnerError('TOOL_CHAIN_INVALID', '工具错误结果结构不符合合同')
    throw runnerError(code, message.trim())
  }
  if (observation?.ok !== true) throw runnerError('TOOL_CHAIN_INVALID', '工具结果缺少成功标记')
  delete observation.ok
  validateObservation(observation, workOrderId)
  const explanation = nonEmpty(result?.finalResponse)
  if (!explanation) throw runnerError('TOOL_CHAIN_INVALID', '同一 DSH interval 未产生说明')
  return { observation, explanation }
}

function validateObservation(value, workOrderId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw runnerError('TOOL_CHAIN_INVALID', '工具结果不是对象')
  const required = ['workOrderId', 'status', 'sourceRecordId', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode']
  for (const key of required) if (typeof value[key] !== 'string' || !value[key].trim()) throw runnerError('TOOL_CHAIN_INVALID', `工具结果缺少 ${key}`)
  if (value.workOrderId !== workOrderId) throw runnerError('TOOL_CHAIN_INVALID', '工具结果工单号不匹配')
  for (const key of ['sourceTime', 'sourceRevision', 'unit']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) throw runnerError('TOOL_CHAIN_INVALID', `工具结果 ${key} 无效`)
  for (const key of ['plannedQuantity', 'completedQuantity']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw runnerError('TOOL_CHAIN_INVALID', `工具结果 ${key} 无效`)
  const allowed = new Set([...required, 'sourceTime', 'sourceRevision', 'unit', 'plannedQuantity', 'completedQuantity'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw runnerError('TOOL_CHAIN_INVALID', `工具结果包含未声明字段 ${key}`)
}

function buildPrompt({ operation, workOrderId, observation, question }) {
  if (operation === 'follow-up') {
    return [
      '你是 Geneway 工单只读说明员工。这个追问严禁调用任何工具。',
      '只能依据服务端注入的唯一历史观察和操作者问题回答；不能猜测、补查或执行写入。',
      `历史观察：${JSON.stringify(observation ?? {})}`,
      `操作者问题：${String(question ?? '').trim()}`,
      '用简短中文说明依据；事实不足时明确说未知。',
    ].join('\n')
  }
  return [
    '你是 Geneway 工单只读说明员工。',
    `必须且只能调用一次 ${GEARJOB_TOOL}，参数必须是 JSON 且精确为 {"workOrderId":${JSON.stringify(workOrderId)}}。`,
    '只读工具返回后，禁止再次调用任何工具；只能依据这一结果给出简短中文状态、数量、单位、来源时间和依据说明。',
    '不要猜测缺失字段，不要执行写入。',
    observation ? `上一条观察仅供对照，不得替代本次工具结果：${JSON.stringify(observation)}` : '',
  ].filter(Boolean).join('\n')
}

function childEnvironment(config, grantFile) {
  const settings = readSettings()
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {}
  const keys = [
    'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR',
    'GENEWAY_GEARJOB_BASE_URL', 'GENEWAY_GEARJOB_CREDENTIAL_FILE',
    'GENEWAY_GEARJOB_HOST_HEADER', 'GENEWAY_GEARJOB_ALLOWED_WORK_ORDER',
  ]
  const env = { DSH_TELEMETRY_MODE: 'DISABLED' }
  for (const key of keys) if (typeof process.env[key] === 'string') env[key] = process.env[key]
  env.GENEWAY_DSH_GRANT_FILE = grantFile
  if (typeof settingsEnv.ANTHROPIC_AUTH_TOKEN === 'string' && settingsEnv.ANTHROPIC_AUTH_TOKEN.trim()) env.ZENMUX_API_KEY = settingsEnv.ANTHROPIC_AUTH_TOKEN
  return env
}

async function writeGrant(path, grant) {
  await writeFile(path, JSON.stringify(grant), { mode: 0o600 })
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function runnerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
