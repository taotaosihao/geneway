import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import {
  buildCapabilityPrompt,
  buildFollowUpPrompt,
  GEARJOB_TOOL,
  getCapability,
  parseCapabilityToolResult,
  validateCapabilityInput,
} from './capabilities.mjs'
import { connectionSnapshot } from './execution-grant.mjs'
import { readRuntimeConfig, readSettings } from './runtime-config.mjs'

export { GEARJOB_TOOL }

export function createDshRunner({ root = process.cwd(), config = readRuntimeConfig(process.env, root), harnessFactory = options => new DeepSeekHarness(options) } = {}) {
  const active = new Map()
  const sessions = new Map()
  const grants = new WeakMap()
  const patch = resolve(root, 'config', 'p1-runtime.patch.yml')

  return {
    configured: config.model.configured && existsSync(patch),
    sourceConfigured: Boolean(config.source?.configured),

    async run(options = {}) {
      const executionId = text(options.executionId) ?? `run-${Date.now()}`
      const operation = text(options.operation) ?? 'create'
      const capabilityId = text(options.capabilityId) ?? 'gearjob-work-order-read'
      const capability = getCapability(capabilityId)
      if (!capability) throw runnerError('CAPABILITY_NOT_FOUND', '能力不存在')
      const isFollowUp = operation === 'follow-up'
      const input = isFollowUp ? undefined : normalizedInput(capabilityId, options)
      const requestInput = isFollowUp ? normalizedInput(capabilityId, options) : input
      const metadata = sessionMetadata(options.sessionMetadata, { capability, input, options })
      const requestedSessionId = text(options.sessionId)
      let record = requestedSessionId ? sessions.get(requestedSessionId) : undefined
      const runState = { harness: record?.harness, sessionId: requestedSessionId, closed: false, cancelled: false }
      active.set(executionId, runState)
      if (record && !isDeepStrictEqual(record.metadata, metadata)) {
        await record.harness.close().catch(() => undefined)
        await removeHarness(record.harness)
        record = undefined
        runState.harness = undefined
      }
      let harness = record?.harness
      const sameSession = Boolean(harness && requestedSessionId)
      const successorFrom = !sameSession ? requestedSessionId : undefined
      let grantFiles = harness ? grants.get(harness) : undefined

      try {
        if (!harness) {
          const grantDirectory = join(config.dshHome, 'grants')
          await mkdir(grantDirectory, { recursive: true, mode: 0o700 })
          if (runState.cancelled) throw cancelledError()
          grantFiles = {
            tool: join(grantDirectory, `grant-${randomUUID()}.json`),
            request: join(grantDirectory, `request-${randomUUID()}.json`),
          }
          harness = harnessFactory({
            profile: 'sdk',
            patches: [patch],
            dshHome: config.dshHome,
            processCwd: root,
            cwd: root,
            provider: config.model.provider,
            model: config.model.model,
            env: childEnvironment(config, grantFiles.tool, grantFiles.request),
            initializeTimeoutMs: 15_000,
            requestTimeoutMs: 120_000,
          })
          runState.harness = harness
          grants.set(harness, grantFiles)
        }
        if (runState.cancelled) throw cancelledError()
        const requestGrant = executionGrant({ executionId, operation, capability, input: requestInput, metadata, supplied: options.grant, config })
        const toolGrant = isFollowUp ? deniedGrant(capability, operation, metadata, options, config) : requestGrant
        await writeGrant(grantFiles.request, requestGrant)
        await writeGrant(grantFiles.tool, toolGrant)
        if (runState.cancelled) throw cancelledError()
        const prompt = isFollowUp ? followUpPrompt(options) : buildCapabilityPrompt(capabilityId, input, previousFact(options), options.confirmations)
        const result = await harness.run(prompt, sameSession ? { sessionId: requestedSessionId } : undefined)
        if (runState.cancelled) throw cancelledError()
        if (requestAuthorizationFailed(result)) throw runnerError('FORBIDDEN', '执行授权已失效')
        const parsed = parseRunResult(result, { operation, capabilityId, input })
        const actualSessionId = text(result?.sessionId)
        if (!actualSessionId) throw runnerError('TOOL_CHAIN_INVALID', 'DSH 未返回有效 Session ID')
        sessions.set(actualSessionId, { harness, metadata })
        if (requestedSessionId && requestedSessionId !== actualSessionId) sessions.delete(requestedSessionId)
        return {
          ...parsed,
          dshSessionRef: actualSessionId,
          continuedFromDshSessionRef: successorFrom,
          contextResultId: text(options.contextResultId),
          contextConfirmationRefs: metadata.confirmationRefs,
          continuity: sameSession ? 'same-session' : successorFrom ? 'successor' : 'new',
          eventCount: result.events?.length ?? 0,
        }
      } catch (error) {
        if (harness && !runState.closed) {
          runState.closed = true
          await harness.close().catch(() => undefined)
          await removeHarness(harness)
        }
        throw runState.cancelled && error?.code !== 'CANCELLED' ? cancelledError() : error
      } finally {
        if (grantFiles) await removeGrantFiles(grantFiles)
        active.delete(executionId)
      }
    },

    async cancel(executionId) {
      const activeRun = active.get(executionId)
      if (!activeRun) return false
      activeRun.cancelled = true
      if (!activeRun.harness) return true
      const grantFiles = grants.get(activeRun.harness)
      if (grantFiles) await removeGrantFiles(grantFiles)
      activeRun.closed = true
      await activeRun.harness.close().catch(() => undefined)
      await removeHarness(activeRun.harness)
      return true
    },

    async close() {
      const harnesses = [...new Set([...sessions.values()].map(item => item.harness).concat([...active.values()].map(item => item.harness).filter(Boolean)))]
      await Promise.all(harnesses.map(harness => harness.close().catch(() => undefined)))
      await Promise.all(harnesses.map(removeHarness))
      active.clear()
      sessions.clear()
    },
  }

  async function removeHarness(harness) {
    for (const [sessionId, item] of sessions) if (item.harness === harness) sessions.delete(sessionId)
    const grantFiles = grants.get(harness)
    grants.delete(harness)
    if (grantFiles) await removeGrantFiles(grantFiles)
  }
}

export function parseRunResult(result, options = {}) {
  const operation = text(options.operation) ?? 'create'
  const capabilityId = text(options.capabilityId) ?? 'gearjob-work-order-read'
  const input = options.input ?? (options.workOrderId !== undefined ? { workOrderId: options.workOrderId } : undefined)
  const calls = (result?.events ?? []).filter(event => event.type === 'tool/call')
  const results = (result?.events ?? []).filter(event => event.type === 'tool/result')
  if (operation === 'follow-up') {
    if (calls.length || results.length) throw runnerError('TOOL_CHAIN_INVALID', '追问执行禁止调用工具')
    const explanation = text(result?.finalResponse)
    if (!explanation) throw runnerError('TOOL_CHAIN_INVALID', '追问执行没有模型说明')
    return { explanation }
  }

  const capability = getCapability(capabilityId)
  if (!capability) throw runnerError('CAPABILITY_NOT_FOUND', '能力不存在')
  const validated = validateCapabilityInput(capabilityId, input)
  if (!validated.ok) throw runnerError('TOOL_CHAIN_INVALID', '能力输入无效')
  if (calls.length !== 1 || results.length !== 1) throw runnerError('TOOL_CHAIN_INVALID', '能力执行必须恰好有一次工具调用和一次工具结果')
  const call = calls[0]?.data
  const toolResult = results[0]?.data
  if (call?.name !== capability.toolName) throw runnerError('TOOL_CHAIN_INVALID', '调用了非预期工具')
  if (!text(call.callId)) throw runnerError('TOOL_CHAIN_INVALID', '工具调用缺少 callId')
  let argumentsValue
  try { argumentsValue = JSON.parse(call.arguments) } catch { throw runnerError('TOOL_CHAIN_INVALID', '工具参数不是 JSON') }
  const parsedInput = validateCapabilityInput(capabilityId, argumentsValue)
  if (!parsedInput.ok || !isDeepStrictEqual(parsedInput.input, validated.input)) throw runnerError('TOOL_CHAIN_INVALID', '工具参数与能力输入不匹配')
  const message = toolResult?.message
  if (!message || message.source?.kind !== 'tool' || message.source.callId !== call.callId) throw runnerError('TOOL_CHAIN_INVALID', '工具结果缺失或 callId 不匹配')
  const content = message.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'tool-result' || content[0].isError !== false || content[0].toolCallId !== call.callId || !Array.isArray(content[0].content) || content[0].content.length !== 1 || content[0].content[0]?.type !== 'text') throw runnerError('TOOL_CHAIN_INVALID', '工具结果结构不符合合同')
  let value
  try { value = JSON.parse(content[0].content[0].text) } catch { throw runnerError('TOOL_CHAIN_INVALID', '工具结果不是 JSON') }
  const parsed = parseCapabilityToolResult(capabilityId, value, validated.input)
  const explanation = text(result?.finalResponse)
  if (!explanation) throw runnerError('TOOL_CHAIN_INVALID', '同一 DSH interval 未产生说明')
  return {
    result: parsed,
    ...(capabilityId === 'gearjob-work-order-read' ? { observation: parsed.payload } : {}),
    explanation,
  }
}

function normalizedInput(capabilityId, options) {
  const input = options.input ?? (capabilityId === 'gearjob-work-order-read' ? { workOrderId: options.workOrderId } : undefined)
  const validated = validateCapabilityInput(capabilityId, input)
  if (!validated.ok) throw runnerError(validated.error.code, validated.error.message)
  return validated.input
}

function sessionMetadata(value, { capability }) {
  const metadata = value
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw runnerError('INVALID_REQUEST', 'Session metadata 无效')
  const result = {}
  for (const key of ['ownerMemberId', 'workId', 'employeeId', 'skillId', 'capabilityId', 'modelRouteId', 'confirmationFingerprint']) {
    result[key] = text(metadata[key])
    if (!result[key]) throw runnerError('INVALID_REQUEST', `Session metadata 缺少 ${key}`)
  }
  if (result.skillId !== capability.skillId || result.capabilityId !== capability.id) throw runnerError('INVALID_REQUEST', 'Session metadata 与能力不匹配')
  result.connectionId = metadata.connectionId === null ? null : text(metadata.connectionId)
  result.connectionRevision = metadata.connectionRevision ?? null
  if (capability.requiresConnection && (!result.connectionId || !Number.isSafeInteger(result.connectionRevision) || result.connectionRevision < 1)) throw runnerError('INVALID_REQUEST', 'Session metadata 连接版本无效')
  if (!capability.requiresConnection && (result.connectionId !== null || result.connectionRevision !== null)) throw runnerError('INVALID_REQUEST', '无连接能力的 Session metadata 无效')
  if (!Array.isArray(metadata.confirmationRefs)) throw runnerError('INVALID_REQUEST', 'Session metadata confirmationRefs 无效')
  result.confirmationRefs = metadata.confirmationRefs.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !text(item.id) || !Number.isInteger(item.revision) || item.revision < 1) throw runnerError('INVALID_REQUEST', 'Session metadata confirmationRef 无效')
    return { id: item.id.trim(), revision: item.revision }
  })
  return result
}

function executionGrant({ executionId, operation, capability, input, metadata, supplied = {}, config }) {
  const connection = capability.requiresConnection ? connectionSnapshot(supplied.connection) : null
  if (connection && (connection.id !== metadata.connectionId || connection.revision !== metadata.connectionRevision)) throw runnerError('INVALID_REQUEST', 'Session metadata 与连接快照不匹配')
  return {
    ...supplied,
    version: 2,
    executionId,
    memberId: metadata.ownerMemberId,
    employeeId: metadata.employeeId,
    skillId: metadata.skillId,
    capabilityId: capability.id,
    workId: metadata.workId,
    modelRouteId: metadata.modelRouteId,
    operation,
    expectedTool: capability.toolName,
    input,
    connection,
    confirmationFingerprint: metadata.confirmationFingerprint,
    confirmationRefs: metadata.confirmationRefs,
    policyFile: supplied.policyFile ?? config.stateFile,
    policyRoot: supplied.policyRoot ?? config.dataRoot,
    secretRoot: supplied.secretRoot ?? config.secretRoot,
  }
}

function deniedGrant(capability, operation, metadata, options, config) {
  return {
    version: 2,
    executionId: text(options.executionId) ?? `run-${Date.now()}`,
    memberId: metadata.ownerMemberId,
    employeeId: metadata.employeeId,
    skillId: metadata.skillId,
    capabilityId: capability.id,
    workId: metadata.workId,
    modelRouteId: metadata.modelRouteId,
    operation,
    expectedTool: '__no_tool_allowed__',
    input: capability.id === 'gearjob-work-order-read' ? { workOrderId: 'NO-TOOL' } : { availableSeconds: 0, quantity: 1 },
    connection: capability.requiresConnection ? null : null,
    confirmationFingerprint: metadata.confirmationFingerprint,
    confirmationRefs: metadata.confirmationRefs,
    policyFile: options.grant?.policyFile ?? config.stateFile,
    policyRoot: options.grant?.policyRoot ?? config.dataRoot,
    secretRoot: options.grant?.secretRoot ?? config.secretRoot,
  }
}

function followUpPrompt(options) {
  if (options.followUp) return buildFollowUpPrompt(options.followUp)
  const observation = options.observation
  if (!observation) throw runnerError('INVALID_REQUEST', '追问缺少结构化事实')
  return buildFollowUpPrompt({
    question: options.question,
    facts: [{ kind: 'gearjob.work-order.observation', payload: observation }],
    confirmations: [],
  })
}

function previousFact(options) {
  if (options.previousFact) return options.previousFact
  if (!options.observation) return undefined
  return { kind: 'gearjob.work-order.observation', payload: options.observation }
}

function requestAuthorizationFailed(result) {
  return (result?.events ?? []).some(event => event.type === 'turn/end'
    && event.data?.reason?.kind === 'error'
    && event.data.reason.error?.message === '执行授权已失效')
}

function childEnvironment(config, grantFile, requestGrantFile) {
  const settings = readSettings()
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {}
  const env = {
    DSH_TELEMETRY_MODE: 'DISABLED',
    GENEWAY_DSH_GRANT_FILE: grantFile,
    GENEWAY_DSH_REQUEST_GRANT_FILE: requestGrantFile,
  }
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key]
  if (typeof settingsEnv.ANTHROPIC_AUTH_TOKEN === 'string' && settingsEnv.ANTHROPIC_AUTH_TOKEN.trim()) env.ZENMUX_API_KEY = settingsEnv.ANTHROPIC_AUTH_TOKEN
  return env
}

async function writeGrant(path, grant) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(grant), { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function removeGrantFiles(files) {
  await Promise.all([unlink(files?.tool).catch(() => undefined), unlink(files?.request).catch(() => undefined)])
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function runnerError(code, message) {
  return Object.assign(new Error(message), { code })
}

function cancelledError() {
  return Object.assign(new Error('本次执行已停止'), { name: 'AbortError', code: 'CANCELLED' })
}
