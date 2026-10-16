import { randomUUID } from 'node:crypto'
import { modelAgentOptions } from './model-route.mjs'
import { nativeRequestCount, nativeUsage } from './execution-runtime.mjs'
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
  WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
  WORK_ORDER_DEVICE_CORRELATION_TOOL,
} from './capabilities.mjs'
import { connectionSnapshot, correlationConnectionSnapshots, correlationMappingBinding } from './execution-grant.mjs'
import { readModelCredential, readRuntimeConfig } from './runtime-config.mjs'

export { GEARJOB_TOOL, WORK_ORDER_DEVICE_CORRELATION_TOOL }

export function createDshRunner({ root = process.cwd(), config = readRuntimeConfig(process.env, root), harnessFactory = options => new DeepSeekHarness(options) } = {}) {
  const active = new Map()
  const sessions = new Map()
  const grants = new WeakMap()
  const modelCredentials = new WeakMap()
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
      if (capability.retired) throw runnerError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
      const isFollowUp = operation === 'follow-up'
      const input = isFollowUp ? undefined : normalizedInput(capabilityId, options)
      const requestInput = isFollowUp ? normalizedInput(capabilityId, options) : input
      const metadata = sessionMetadata(options.sessionMetadata, { capability, input, options })
      const requestedSessionId = text(options.sessionId)
      let record = requestedSessionId ? sessions.get(requestedSessionId) : undefined
      const runState = { harness: record?.harness, sessionId: requestedSessionId, closed: false, cancelled: false }
      active.set(executionId, runState)
      let observedEvents = []
      let harness = record?.harness
      let sameSession = Boolean(harness && requestedSessionId)
      let successorFrom = !sameSession ? requestedSessionId : undefined
      let grantFiles = harness ? grants.get(harness) : undefined

      try {
        if (record && !isDeepStrictEqual(record.metadata, metadata)) {
          try { await harness.close(); runState.closed = true; await removeHarness(harness) }
          catch (error) { runState.closeFailed = true; throw Object.assign(error, { closeFailed: true }) }
          record = undefined
          harness = undefined
          grantFiles = undefined
          runState.harness = undefined
          runState.closed = false
          sameSession = false
          successorFrom = requestedSessionId
        }
        const modelCredential = config.model.provider === 'zenmux' || config.model.credentialRef ? await readModelCredential(config) : undefined
        if (harness && modelCredential !== modelCredentials.get(harness)) throw runnerError('MODEL_NOT_CONFIGURED', '模型路由不可用')
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
            ...(metadata.modelSnapshot ? modelAgentOptions(metadata.modelSnapshot) : { provider: config.model.provider, model: config.model.model, maxTokens: 4096 }),
            env: childEnvironment(config, grantFiles.tool, grantFiles.request, modelCredential),
            initializeTimeoutMs: 15_000,
            requestTimeoutMs: 120_000,
          })
          runState.harness = harness
          grants.set(harness, grantFiles)
          modelCredentials.set(harness, modelCredential)
        }
        if (runState.cancelled) throw cancelledError()
        const requestGrant = executionGrant({ executionId, operation, capability, input: requestInput, metadata, supplied: options.grant, config })
        const toolGrant = isFollowUp ? deniedGrant(capability, operation, metadata, options, config) : requestGrant
        await writeGrant(grantFiles.request, requestGrant)
        await writeGrant(grantFiles.tool, toolGrant)
        if (runState.cancelled) throw cancelledError()
        const prompt = buildAgentPrompt(isFollowUp ? followUpPrompt(options) : buildCapabilityPrompt(capabilityId, input, previousFact(options), options.confirmations), metadata.agentInstructions)
        const result = await harness.run(prompt, { ...(sameSession ? { sessionId: requestedSessionId } : {}), onNotification(notification) { if (notification.method === 'session.event') observedEvents.push(notification.params.event) } })
        observedEvents = result.events ?? observedEvents
        const budgetFailure = observedEvents.some(event => event.type === 'turn/end' && event.data?.reason?.error?.message?.includes('本次模型请求预算已耗尽'))
        if (budgetFailure) throw runnerError('BUDGET_EXHAUSTED', '本次模型请求预算已耗尽')
        if (runState.cancelled) throw cancelledError()
        if (requestAuthorizationFailed(result)) throw runnerError('FORBIDDEN', '执行授权已失效')
        const parsed = parseRunResult(result, { operation, capabilityId, input })
        const actualSessionId = text(result?.sessionId)
        if (!actualSessionId) throw runnerError('TOOL_CHAIN_INVALID', 'DSH 未返回有效 Session ID')
        sessions.delete(actualSessionId)
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
          runtime: { requestCount: nativeRequestCount(observedEvents), usage: nativeUsage(observedEvents) },
        }
      } catch (error) {
        let failure = runState.cancelled && error?.code !== 'CANCELLED' && !error?.closeFailed ? cancelledError() : error
        if (harness && !runState.closed && !runState.closeFailed) {
          try { await harness.close(); runState.closed = true; await removeHarness(harness) }
          catch (closeError) {
            runState.closeFailed = true
            failure = Object.assign(new AggregateError([error, closeError], '执行资源尚未确认关闭'), { code: 'UPSTREAM_ERROR', closeFailed: true })
          }
        }
        failure.runtime = { requestCount: nativeRequestCount(observedEvents), usage: nativeUsage(observedEvents) }
        throw failure
      } finally {
        if (grantFiles) await removeGrantFiles(grantFiles)
        if (!runState.closeFailed) active.delete(executionId)
        const busy = new Set([...active.values()].map(item => item.harness))
        const idle = [...new Set([...sessions.values()].map(item => item.harness))].filter(item => !busy.has(item))
        for (const retired of idle.slice(0, Math.max(0, idle.length - 4))) {
          await removeHarness(retired)
          try { await retired.close() }
          catch (error) { active.set(executionId, { harness: retired, closeFailed: true }); throw Object.assign(error, { closeFailed: true }) }
        }
      }
    },

    async cancel(executionId) {
      const activeRun = active.get(executionId)
      if (!activeRun) return false
      activeRun.cancelled = true
      if (!activeRun.harness) return true
      const grantFiles = grants.get(activeRun.harness)
      if (grantFiles) await removeGrantFiles(grantFiles)
      try { await activeRun.harness.close(); activeRun.closed = true }
      catch (error) { activeRun.closeFailed = true; throw Object.assign(error, { closeFailed: true }) }
      await removeHarness(activeRun.harness)
      return true
    },

    async close() {
      const harnesses = [...new Set([...sessions.values()].map(item => item.harness).concat([...active.values()].map(item => item.harness).filter(Boolean)))]
      const results = await Promise.allSettled(harnesses.map(harness => harness.close()))
      for (let index = 0; index < harnesses.length; index += 1) if (results[index].status === 'fulfilled') {
        await removeHarness(harnesses[index])
        for (const [id, record] of active) if (record.harness === harnesses[index]) active.delete(id)
      }
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, '执行资源尚未确认关闭')
      active.clear()
      sessions.clear()
    },
  }

  async function removeHarness(harness) {
    for (const [sessionId, item] of sessions) if (item.harness === harness) sessions.delete(sessionId)
    const grantFiles = grants.get(harness)
    grants.delete(harness)
    modelCredentials.delete(harness)
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
  if (!message || message.role !== 'tool' || message.source?.kind !== 'tool' || message.source.callId !== call.callId || message.toolCallId !== call.callId) throw runnerError('TOOL_CHAIN_INVALID', '工具结果缺失或 callId 不匹配')
  const content = message.content
  if (message.isError !== false || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') throw runnerError('TOOL_CHAIN_INVALID', '工具结果结构不符合合同')
  let value
  try { value = JSON.parse(content[0].text) } catch { throw runnerError('TOOL_CHAIN_INVALID', '工具结果不是 JSON') }
  const parsed = parseCapabilityToolResult(capabilityId, value, validated.input)
  const explanation = text(result?.finalResponse)
  if (!explanation) throw runnerError('TOOL_CHAIN_INVALID', '同一 DSH interval 未产生说明')
  return {
    result: parsed,
    ...(capabilityId === 'gearjob-work-order-read' ? { observation: parsed.payload } : {}),
    explanation,
  }
}

export function buildAgentPrompt(prompt, instructions) {
  return instructions ? `本次 Agent 执行指令：\n${instructions}\n\n${prompt}` : prompt
}

function normalizedInput(capabilityId, options) {
  const input = options.input ?? (['gearjob-work-order-read', WORK_ORDER_DEVICE_CORRELATION_CAPABILITY].includes(capabilityId) ? { workOrderId: options.workOrderId } : undefined)
  const validated = validateCapabilityInput(capabilityId, input)
  if (!validated.ok) throw runnerError(validated.error.code, validated.error.message)
  return validated.input
}

function sessionMetadata(value, { capability, options }) {
  const metadata = value
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw runnerError('INVALID_REQUEST', 'Session metadata 无效')
  const result = {}
  if (options.modelSnapshot ?? metadata.modelSnapshot) result.modelSnapshot = options.modelSnapshot ?? metadata.modelSnapshot
  result.agentInstructions = text(options.agentInstructions) ?? ''
  for (const key of ['ownerMemberId', 'workId', 'employeeId', 'skillId', 'capabilityId', 'modelRouteId', 'confirmationFingerprint']) {
    result[key] = text(metadata[key])
    if (!result[key]) throw runnerError('INVALID_REQUEST', `Session metadata 缺少 ${key}`)
  }
  if (result.skillId !== capability.skillId || result.capabilityId !== capability.id) throw runnerError('INVALID_REQUEST', 'Session metadata 与能力不匹配')
  if (capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY) {
    result.connectionIds = correlationMetadataMap(metadata.connectionIds, 'Session metadata 连接 identity 无效', text, true)
    result.connectionRevisions = correlationMetadataMap(metadata.connectionRevisions, 'Session metadata 连接版本无效', value => Number.isSafeInteger(value) && value >= 1 ? value : undefined)
    try { Object.assign(result, correlationMappingBinding(metadata.mappingRevision, metadata.mappingIdentity)) }
    catch { throw runnerError('INVALID_REQUEST', 'Session metadata mapping 绑定无效') }
  } else {
    result.connectionId = metadata.connectionId === null ? null : text(metadata.connectionId)
    result.connectionRevision = metadata.connectionRevision ?? null
    if (capability.requiresConnection && (!result.connectionId || !Number.isSafeInteger(result.connectionRevision) || result.connectionRevision < 1)) throw runnerError('INVALID_REQUEST', 'Session metadata 连接版本无效')
    if (!capability.requiresConnection && (result.connectionId !== null || result.connectionRevision !== null)) throw runnerError('INVALID_REQUEST', '无连接能力的 Session metadata 无效')
  }
  if (!Array.isArray(metadata.confirmationRefs)) throw runnerError('INVALID_REQUEST', 'Session metadata confirmationRefs 无效')
  result.confirmationRefs = metadata.confirmationRefs.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !text(item.id) || !Number.isInteger(item.revision) || item.revision < 1) throw runnerError('INVALID_REQUEST', 'Session metadata confirmationRef 无效')
    return { id: item.id.trim(), revision: item.revision }
  })
  return result
}

function executionGrant({ executionId, operation, capability, input, metadata, supplied = {}, config }) {
  const correlation = capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY
  const connections = correlation ? correlationConnectionSnapshots(supplied.connections) : undefined
  const connection = !correlation && capability.requiresConnection ? connectionSnapshot(supplied.connection) : null
  if (connections && (connections.gearJob.id !== metadata.connectionIds.gearJob || connections.gearJob.revision !== metadata.connectionRevisions.gearJob
    || connections.hive.id !== metadata.connectionIds.hive || connections.hive.revision !== metadata.connectionRevisions.hive)) throw runnerError('INVALID_REQUEST', 'Session metadata 与双来源连接快照不匹配')
  if (connection && (connection.id !== metadata.connectionId || connection.revision !== metadata.connectionRevision)) throw runnerError('INVALID_REQUEST', 'Session metadata 与连接快照不匹配')
  const { connection: _connection, connections: _connections, ...rest } = supplied
  return {
    ...rest,
    version: 2,
    executionId,
    memberId: metadata.ownerMemberId,
    employeeId: metadata.employeeId,
    skillId: metadata.skillId,
    capabilityId: capability.id,
    workId: metadata.workId,
    modelRouteId: metadata.modelRouteId,
    ...(metadata.modelSnapshot ? { modelSnapshot: metadata.modelSnapshot } : {}),
    operation,
    expectedTool: capability.toolName,
    input,
    ...(correlation ? { connections, mappingRevision: metadata.mappingRevision, mappingIdentity: metadata.mappingIdentity } : { connection }),
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
    ...(metadata.modelSnapshot ? { modelSnapshot: metadata.modelSnapshot } : {}),
    operation,
    expectedTool: '__no_tool_allowed__',
    input: ['gearjob-work-order-read', WORK_ORDER_DEVICE_CORRELATION_CAPABILITY].includes(capability.id) ? { workOrderId: 'NO-TOOL' } : { availableSeconds: 0, quantity: 1 },
    ...(capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY
      ? { connections: options.grant?.connections, mappingRevision: metadata.mappingRevision, mappingIdentity: metadata.mappingIdentity }
      : { connection: null }),
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
    && event.data.reason.error?.message?.includes('执行授权已失效'))
}

function childEnvironment(config, grantFile, requestGrantFile, modelCredential) {
  const env = {
    DSH_HOME: config.dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    GENEWAY_DSH_GRANT_FILE: grantFile,
    GENEWAY_DSH_REQUEST_GRANT_FILE: requestGrantFile,
  }
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key]
  if (modelCredential) env[config.model.credentialEnv ?? 'ZENMUX_API_KEY'] = modelCredential
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

function correlationMetadataMap(value, message, normalize, distinct = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'gearJob') || !Object.hasOwn(value, 'hive')) throw runnerError('INVALID_REQUEST', message)
  const gearJob = normalize(value.gearJob), hive = normalize(value.hive)
  if (gearJob === undefined || hive === undefined || distinct && gearJob === hive) throw runnerError('INVALID_REQUEST', message)
  return { gearJob, hive }
}

function cancelledError() {
  return Object.assign(new Error('本次执行已停止'), { name: 'AbortError', code: 'CANCELLED' })
}
