import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CYCLE_TIME_TOOL, getCapability, sanitizeFollowUpContext } from './capabilities.mjs'
import { buildAgentPrompt, parseRunResult } from './dsh-runner.mjs'
import { createObservation } from './domain/work-order.mjs'
import { connectionInputAllowed, connectionSnapshot } from './execution-grant.mjs'
import { assertTrustedConnection } from './connection-catalog.mjs'
import { KIVO_TPM_RESULT_KIND, KIVO_TPM_TOOLS } from './domain/tpm.mjs'
import { isRetiredWork } from './work-service.mjs'
import { conversationSessionDependencies, currentConversationDependencies } from './conversation-dependencies.mjs'
import { assertDshHome, readModelCredential, readRuntimeConfig } from './runtime-config.mjs'
import { bootDshHost } from './dsh-host.mjs'
import { createCycleTimeTool } from '../plugins/cycle-time.mjs'
import { createKivoTpmTools } from '../plugins/kivo-tpm.mjs'
import { COLLABORATION_TOOLS, createCollaborationTools } from '../plugins/collaboration.mjs'
import { KNOWLEDGE_TOOLS, createKnowledgePlugin } from '../plugins/knowledge.mjs'
import { createKnowledgeService, currentKnowledgeReference, knowledgeRefKey, stableKnowledgeRefs } from './knowledge-service.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { createUserMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const ACTIVE = new Set(['accepted', 'running'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const DEFAULT_AGENT = Object.freeze({ provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 4096 })
export const CONVERSATION_WORK_TOOLS = Object.freeze({
  create: 'geneway_work_create', continue: 'geneway_work_continue', followUp: 'geneway_work_follow_up', status: 'geneway_work_status', stop: 'geneway_work_stop',
})

export function createCollaborationRunner({
  store,
  root: workspaceRoot = process.cwd(),
  dshHome = readRuntimeConfig(process.env, workspaceRoot).dshHome,
  patchPath = resolve(workspaceRoot, 'config', 'p3-runtime.patch.yml'),
  runProfileImpl = bootDshHost,
  agentOptions = DEFAULT_AGENT,
  environment = {},
  secretRoot = readRuntimeConfig(process.env, workspaceRoot).secretRoot,
  connectionCatalog = [],
  getWorkService,
  clock = () => new Date().toISOString(),
  onError = () => undefined,
  testHooks = {},
} = {}) {
  if (!store) throw new Error('store is required')
  if (!Number.isSafeInteger(agentOptions.maxTokens) || agentOptions.maxTokens < 1 || agentOptions.maxTokens > 4096) throw new Error('collaboration maxTokens must be between 1 and 4096')
  let runtime
  let booting
  let modelCredential
  let kivoFiber
  let knowledgeFiber
  let knowledgeMounting
  let knowledgeLifecycle = Promise.resolve()
  let knowledgeEnabled = true
  let closing = false
  let closeTask
  let nativeCloseTask
  const bindings = new WeakMap()
  const knowledgeSelections = new WeakMap()
  const summaryContexts = new WeakMap()
  const summarySubmissions = new WeakMap()
  const requestFailures = new WeakMap()
  const gates = new Map()
  const activeRoots = new Map()
  const activeChats = new Map()
  const historyReads = new Set()
  const knowledgeService = createKnowledgeService({ store, clock })

  return {
    isKnowledgeEnabled() { return knowledgeEnabled },
    getKnowledgeService() { return knowledgeService },

    async runChatTurn(options) {
      if (!options || typeof options.conversationId !== 'string' || !options.conversationId || typeof options.turnId !== 'string' || !options.turnId
        || typeof options.text !== 'string' || !options.text.trim() || typeof options.instructions !== 'string'
        || typeof options.authorize !== 'function' || typeof options.onSession !== 'function'
        || options.sessionId !== null && (typeof options.sessionId !== 'string' || !options.sessionId)) throw runtimeError('INVALID_REQUEST', '对话执行参数无效')
      if (closing) throw runtimeError('PROCESS_SHUTDOWN', '进程正在关闭')
      if (activeChats.has(options.conversationId)) throw runtimeError('BUSY', '当前对话回复尚未结束')
      const entry = { turnId: options.turnId, controller: new AbortController(), handle: undefined, promise: undefined, failure: undefined }
      activeChats.set(options.conversationId, entry)
      entry.promise = executeChatTurn(options, entry).finally(() => { if (activeChats.get(options.conversationId) === entry) activeChats.delete(options.conversationId) })
      return entry.promise
    },

    async cancelChatTurn(conversationId, turnId) {
      const entry = activeChats.get(conversationId)
      if (!entry || entry.turnId !== turnId) return false
      entry.controller.abort(runtimeError('CANCELLED', '本次回复已停止'))
      entry.handle?.agent.cancel({ kind: 'user' })
      await entry.promise.catch(() => undefined)
      return true
    },

    async readChatHistory(sessionIds) {
      if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string' || !id)) throw runtimeError('INVALID_REQUEST', '历史引用无效')
      if (!sessionIds.length) return []
      const operation = readChatHistory([...new Set(sessionIds)])
      historyReads.add(operation)
      try { return await operation } finally { historyReads.delete(operation) }
    },

    async run(rootWorkId) {
      const state = await store.read()
      const rootWork = state.works.find(work => work.id === rootWorkId && work.collaboration)
      if (!rootWork) throw runtimeError('NOT_FOUND', '协作工作不存在')
      if (isRetiredWork(state, rootWork)) throw runtimeError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
      const existing = activeRoots.get(rootWorkId)
      if (existing) {
        if (existing.generation === rootWork.collaboration.generation) return existing.promise
        await existing.promise.catch(() => undefined)
      }
      const controller = new AbortController()
      const entry = { controller, generation: rootWork.collaboration.generation, handles: new Set(), runs: new Set(), promise: undefined }
      entry.promise = executeRoot(rootWorkId, rootWork.collaboration.generation, entry)
        .catch(async error => { await failRoot(rootWorkId, rootWork.collaboration.generation, error); onError(error); throw error })
        .finally(async () => {
          await disposeEntry(entry)
          activeRoots.delete(rootWorkId)
          testHooks.afterRootDispose?.({ rootWorkId, active: activeRoots.has(rootWorkId) })
        })
      activeRoots.set(rootWorkId, entry)
      return entry.promise
    },

    async cancel(rootWorkId, reason = 'user') {
      let accepted = false
      await store.update(state => {
        const rootWork = state.works.find(work => work.id === rootWorkId && work.collaboration)
        if (!rootWork || TERMINAL.has(rootWork.collaboration.status)) return state
        accepted = true
        const now = clock()
        const oldGeneration = rootWork.collaboration.generation
        const works = state.works.map(work => {
          if (work.id !== rootWorkId && work.rootWorkId !== rootWorkId) return work
          const executions = work.executions.map(execution => execution.generation === oldGeneration && ACTIVE.has(execution.status)
            ? { ...execution, status: 'cancelled', completedAt: now, error: { code: 'CANCELLED', message: '本次执行已停止' } }
            : execution)
          if (work.id !== rootWorkId) return { ...work, status: ['accepted', 'running', 'waiting_input'].includes(work.status) ? 'cancelled' : work.status, executions }
          return {
            ...work,
            status: 'cancelled',
            executions,
            collaboration: { ...work.collaboration, cancelGeneration: work.collaboration.cancelGeneration + 1, status: 'cancelled' },
            plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running', 'waiting_input'].includes(item.status) ? { ...item, status: 'cancelled' } : item) },
          }
        })
        return { ...state, works }
      })
      const entry = activeRoots.get(rootWorkId)
      if (accepted && entry) {
        entry.controller.abort(runtimeError('CANCELLED', reason))
        await disposeEntry(entry)
      }
      return accepted
    },

    async enableKnowledge() {
      const operation = knowledgeLifecycle.then(async () => {
        knowledgeEnabled = true
        await mountKnowledge(await context())
      })
      knowledgeLifecycle = operation.catch(() => undefined)
      return operation
    },

    async disableKnowledge() {
      const operation = knowledgeLifecycle.then(async () => {
        knowledgeEnabled = false
        await knowledgeMounting
        await knowledgeFiber?.dispose()
        knowledgeFiber = undefined
        testHooks.onKnowledgeSchemas?.(runtime?.ctx.tools.schemas().map(schema => schema.name))
      })
      knowledgeLifecycle = operation.catch(() => undefined)
      return operation
    },

    close() {
      closing = true
      closeTask ??= closeRunner()
      return closeTask
    },
  }

  async function closeRunner() {
    let failure
    try {
      await Promise.all([...activeChats.values()].map(async entry => {
        entry.controller.abort(runtimeError('PROCESS_SHUTDOWN', '进程关闭时未完成'))
        entry.handle?.agent.cancel({ kind: 'user' })
        await entry.promise.catch(() => undefined)
      }))
      const ids = [...activeRoots.keys()]
      await Promise.all(ids.map(async id => {
        await interrupt(id)
        const entry = activeRoots.get(id)
        entry?.controller.abort(runtimeError('PROCESS_SHUTDOWN', '进程关闭时未完成'))
        if (entry) await disposeEntry(entry)
      }))
      await Promise.all([...activeRoots.values()].map(entry => entry.promise.catch(() => undefined)))
      activeRoots.clear()
      await Promise.allSettled([...historyReads])
      await knowledgeLifecycle
      await knowledgeFiber?.dispose()
      knowledgeFiber = undefined
      await kivoFiber?.dispose()
      kivoFiber = undefined
    } catch (error) { failure = error }
    let started = runtime
    if (!started && booting) {
      try { started = await booting }
      catch (error) {
        if (error?.code === 'HOST_CLEANUP_FAILED') failure = failure ? new AggregateError([failure, error], '协作 Host 清理失败', { cause: failure }) : error
      }
    }
    try {
      if (started) await closeNative(started)
      else await nativeCloseTask
    } catch (error) { failure = failure ? new AggregateError([failure, error], '协作 Host 清理失败', { cause: failure }) : error }
    finally {
      runtime = undefined
      booting = undefined
      modelCredential = undefined
      knowledgeFiber = undefined
      kivoFiber = undefined
    }
    if (failure) throw failure
  }

  function closeNative(started) {
    nativeCloseTask ??= Promise.resolve().then(() => started.shutdown.shutdown(0))
    return nativeCloseTask
  }

  function assertOpen() {
    if (closing) throw runtimeError('PROCESS_SHUTDOWN', '进程正在关闭')
  }

  async function context() {
    assertOpen()
    if (runtime) return runtime.ctx
    if (!booting) booting = boot()
    const started = await booting
    assertOpen()
    runtime = started
    return runtime.ctx
  }

  async function executeChatTurn(options, entry) {
    let result, failure
    try {
      await options.authorize()
      const initial = typeof getWorkService === 'function' ? await store.read() : null
      const conversation = initial?.conversations.find(item => item.id === options.conversationId)
      const workTools = conversation?.channelIdentityId ? Object.values(CONVERSATION_WORK_TOOLS) : []
      entry.toolCalls = new Map()
      const assertChatAuthorized = async () => {
        entry.controller.signal.throwIfAborted()
        await options.authorize()
        if (!conversation) return
        const state = await store.read(), current = state.conversations.find(item => item.id === conversation.id)
        const turn = current?.turns.find(item => item.id === options.turnId)
        if (!turn || !currentConversationDependencies(state, current, conversationSessionDependencies(current, turn), connectionCatalog)) throw runtimeError('FORBIDDEN', '本对话使用的工作或知识授权已失效，请开启新会话')
      }
      await assertChatAuthorized()
      const ctx = await context(), signal = entry.controller.signal
      signal.throwIfAborted()
      const setup = (agentCtx, agent) => {
        // This mask covers global tools; the five registrations below belong only to this agent.
        agentCtx.tools.restrict({ allow: [] })
        agentCtx.tools.guard(execution => workTools.includes(execution.name) ? undefined : 'Tool is outside this conversation scope')
        for (const tool of createConversationWorkTools(async request => {
          if (request.invocation.agent !== agent || !workTools.includes(request.name)) throw runtimeError('FORBIDDEN', '工具与当前对话不匹配')
          await assertChatAuthorized()
          return invokeConversationWork(options, entry, request, assertChatAuthorized)
        }, workTools)) agentCtx.tools.register(tool)
        agentCtx.systemPrompt.section({ name: 'geneway-conversation', order: 0, interpolate: false, complete: true,
          text: buildAgentPrompt(`你是该成员的 Geneway 对话助手。请根据本对话可见内容回答。${workTools.length ? conversationWorkPrompt(initial, conversation, connectionCatalog) : ''}`, options.instructions),
        })
        agentCtx.on('agent/request', async ({ signal }, next) => {
          entry.controller.signal.throwIfAborted()
          await untilAbort(assertChatAuthorized(), signal)
          return next()
        })
        agentCtx.on('agent/error', event => { entry.failure ??= event.error })
      }
      if (options.sessionId) {
        try { entry.handle = await ctx.agents.resume({ resumeSessionId: options.sessionId, agentOptions, setup, signal }) }
        catch (error) {
          if (signal.aborted) throw signal.reason
          throw runtimeError('HISTORY_UNAVAILABLE', '历史记录暂时不可用')
        }
        // A resumed inbox may contain input from an interrupted process; never replay it.
        entry.handle.agent.cancel({ kind: 'user' })
        await entry.handle.agent.whenIdle()
      } else {
        entry.handle = await ctx.agents.create({ sessionId: `conversation-${randomUUID()}`, meta: { cwd: workspaceRoot }, agentOptions, setup, signal })
      }
      signal.throwIfAborted()
      const agent = entry.handle.agent
      if (agent.session.header.origin === 'subagent') throw runtimeError('HISTORY_UNAVAILABLE', '对话历史类型不匹配')
      const message = createUserMessage({ content: [{ type: 'text', text: options.text }], source: { kind: 'user' } })
      await options.onSession({ sessionId: agent.id, userMessageId: message.id })
      signal.throwIfAborted()
      await assertChatAuthorized()
      signal.throwIfAborted()
      const offset = agent.session.snapshotEvents().length
      agent.followup(message)
      await agent.whenIdle()
      const events = agent.session.snapshotEvents().slice(offset)
      const reason = events.filter(event => event.type === 'turn/end').at(-1)?.data.reason
      const requestFailure = requestFailures.get(agent) ?? entry.failure
      if (events.some(event => event.type === 'tool/call' && !workTools.includes(event.data?.name))) throw runtimeError('TOOL_CHAIN_INVALID', '对话调用了未获准工具')
      const assistantMessageIds = events.filter(event => event.type === 'assistant/message').map(event => event.data.message.id)
      if (reason?.kind === 'completed' && !assistantMessageIds.length) throw runtimeError('UPSTREAM_ERROR', '本次回复未能完成')
      await ctx.sessionPersistence.flush()
      if (reason?.kind === 'completed') await assertChatAuthorized()
      result = { sessionId: agent.id, userMessageId: message.id,
        assistantMessageIds,
        stopReason: reason?.kind ?? 'error',
        ...(requestFailure || reason?.kind === 'error' ? { error: safeRuntimeCause(requestFailure ?? reason.error) } : {}),
      }
    } catch (error) { failure = error }
    finally {
      try { await entry.handle?.dispose() }
      catch (error) { failure = failure ? new AggregateError([failure, error], '对话执行和清理失败', { cause: failure }) : error }
    }
    if (failure) throw failure
    return result
  }

  async function invokeConversationWork(options, entry, { name, args, invocation }, authorize) {
    if (typeof invocation.callId !== 'string' || !invocation.callId || invocation.signal?.aborted) throw runtimeError('FORBIDDEN', '工具缺少当前调用标识')
    const requestId = `chat-${createHash('sha256').update(`${options.conversationId}\0${options.turnId}\0${name}\0${invocation.callId}`).digest('hex')}`
    const previous = entry.toolCalls.get(requestId)
    if (previous) {
      if (!isDeepStrictEqual(previous.args, args)) throw runtimeError('INVALID_REQUEST', '同一工具请求的输入不可变更')
      return previous.promise
    }
    const promise = dispatch()
    entry.toolCalls.set(requestId, { args: structuredClone(args), promise })
    return promise

    async function dispatch() {
      const state = await store.read(), conversation = state.conversations.find(item => item.id === options.conversationId)
      const member = state.members.find(item => item.id === conversation?.ownerMemberId && item.enabled === true)
      const employee = state.employees.find(item => item.id === conversation?.employeeId && item.enabled === true && member?.employeeIds.includes(item.id))
      const turn = conversation?.turns.find(item => item.id === options.turnId && ACTIVE.has(item.status))
      if (!conversation || !member || !employee || !turn || !conversation.channelIdentityId) throw runtimeError('FORBIDDEN', '当前对话或 Agent 未获准')
      const service = getWorkService?.()
      if (!service) throw runtimeError('MODEL_NOT_CONFIGURED', '工作服务当前不可用')
      if (name === CONVERSATION_WORK_TOOLS.status && args.workId === undefined) {
        return { ok: true, requiresSelection: true, candidates: state.works.filter(work => work.ownerMemberId === member.id && work.employeeId === employee.id && work.conversationId === conversation.id)
          .map(work => ({ workId: work.id, goal: work.goal, status: work.status })), instruction: '请明确选择 workId；不会按最近工作自动执行。' }
      }
      let selected
      if (name !== CONVERSATION_WORK_TOOLS.create) {
        selected = state.works.find(work => work.id === args.workId && work.ownerMemberId === member.id && work.employeeId === employee.id && work.conversationId === conversation.id)
        if (!selected) throw runtimeError('FORBIDDEN', '工作必须属于本人当前对话；其他对话请到 Web 继续')
      }
      await authorize()
      invocation.signal?.throwIfAborted()
      let result
      if (name === CONVERSATION_WORK_TOOLS.create) {
        result = await service.createWork(member, { employeeId: employee.id, conversationId: conversation.id, skillId: args.skillId, ...(args.connectionId === undefined ? {} : { connectionId: args.connectionId }), goal: args.goal, input: args.input ?? {}, clientRequestId: requestId })
      } else if (name === CONVERSATION_WORK_TOOLS.continue) {
        result = await service.continueWork(member, selected.id, { input: args.input ?? {}, clientRequestId: requestId })
      } else if (name === CONVERSATION_WORK_TOOLS.followUp) {
        result = await service.followUp(member, selected.id, args.text, { clientRequestId: requestId })
      } else if (name === CONVERSATION_WORK_TOOLS.stop) result = await service.cancel(member, selected.id)
      else if (name === CONVERSATION_WORK_TOOLS.status) result = await service.getWork(member, selected.id)
      else throw runtimeError('FORBIDDEN', '对话工具未获准')
      if (result?.ok !== true) return { ok: false, error: result?.error ?? { code: 'UPSTREAM_ERROR', message: '工作操作未完成，请到 Web 核对' } }
      await authorize()
      invocation.signal?.throwIfAborted()
      let output
      await store.update(current => {
        entry.controller.signal.throwIfAborted()
        const conversation = current.conversations.find(item => item.id === options.conversationId)
        const turn = conversation?.turns.find(item => item.id === options.turnId && ACTIVE.has(item.status))
        const work = current.works.find(item => item.id === result.value?.id && item.ownerMemberId === conversation?.ownerMemberId && item.employeeId === conversation.employeeId && item.conversationId === conversation.id)
        if (!turn || !work) throw runtimeError('FORBIDDEN', '工作或当前回复归属已变化')
        // Operations accept asynchronously. Read status explicitly later; never wait or poll here.
        const visible = result.value.results ?? [], connection = current.connections.find(item => item.id === work.connectionId)
        const workRefs = visible.map(item => ({ workId: work.id, resultId: item.id, connectionRevision: connection?.revision ?? null }))
        const knowledgeRefs = stableKnowledgeRefs(visible.flatMap(item => item.knowledgeDependencyRefs ?? []))
        const dependencies = { workDependencyRefs: workRefs, knowledgeDependencyRefs: knowledgeRefs }
        if (visible.some(item => item.knowledgeUnavailable) || !currentConversationDependencies(current, conversation, dependencies, connectionCatalog)) throw runtimeError('FORBIDDEN', '工作或知识事实当前不可用，请到 Web 核对')
        const next = { ...turn,
          workDependencyRefs: [...(turn.workDependencyRefs ?? []), ...workRefs.filter(ref => !(turn.workDependencyRefs ?? []).some(item => isDeepStrictEqual(item, ref)))],
          knowledgeDependencyRefs: [...(turn.knowledgeDependencyRefs ?? []), ...knowledgeRefs.filter(ref => !(turn.knowledgeDependencyRefs ?? []).some(item => knowledgeRefKey(item) === knowledgeRefKey(ref)))],
        }
        output = { ok: true, work: { workId: work.id, conversationId: conversation.id, goal: work.goal, status: work.status, input: work.input, requiredInputs: work.requiredInputs ?? [],
          results: visible.map(item => ({ resultId: item.id, kind: item.kind, payload: item.payload, ...(item.source === undefined ? {} : { source: item.source }), createdAt: item.createdAt, explanation: item.explanation })),
        }, ...(result.active ? { active: true, inputApplied: false } : {}), ...(result.accepted === undefined ? {} : { accepted: result.accepted }), deduplicated: result.deduplicated === true }
        return { ...current, conversations: current.conversations.map(item => item.id === conversation.id ? { ...item, turns: item.turns.map(item => item.id === turn.id ? next : item) } : item) }
      })
      await authorize()
      invocation.signal?.throwIfAborted()
      return output
    }
  }

  async function readChatHistory(sessionIds) {
    let ctx
    try { ctx = await context(); await ctx.sessionPersistence.flush() }
    catch { return sessionIds.map(sessionId => ({ sessionId, status: 'unavailable', error: { code: 'HISTORY_UNAVAILABLE', message: '历史记录暂时不可用' } })) }
    return Promise.all(sessionIds.map(async sessionId => {
      let handle
      try {
        handle = await ctx.sessionPersistence.open(sessionId, 'read')
        const { events } = await handle.read()
        await handle.close(); handle = undefined
        return { sessionId, status: 'available', events }
      } catch {
        return { sessionId, status: 'unavailable', error: { code: 'HISTORY_UNAVAILABLE', message: '历史记录暂时不可用' } }
      } finally { await handle?.close().catch(() => undefined) }
    }))
  }

  async function boot() {
    assertDshHome(dshHome)
    const config = readRuntimeConfig(process.env, workspaceRoot)
    // Knowledge maintenance and native history can boot without a usable model; requests are gated separately.
    try { modelCredential = config.model.credentialRef ? await readModelCredential(config) : undefined }
    catch (error) {
      if (error?.code !== 'MODEL_NOT_CONFIGURED') throw error
      modelCredential = undefined
    }
    const values = {
      ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
      ...environment,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      ...(modelCredential ? { [config.model.credentialEnv]: modelCredential } : {}),
    }
    delete values.GENEWAY_DSH_GRANT_FILE
    assertOpen()
    const started = await runProfileImpl({ environment: launchEnvironment(values), profile: 'sdk', patchFiles: [patchPath], args: [], resolutionMode: 'runtime' })
    try {
      assertOpen()
      await install(started.ctx)
      assertOpen()
      return started
    } catch (error) {
      try { await closeNative(started) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], '协作 Host 启动及清理失败', { cause: error }) }
      throw error
    }
  }

  async function install(ctx) {
    ctx.on('agent/request', async ({ agent }, next) => {
      try {
        await authorizeModelRequest()
        const proposed = await next()
        if (proposed.provider !== agentOptions.provider || proposed.model !== agentOptions.model) throw runtimeError('MODEL_NOT_CONFIGURED', '模型路由不可用')
        return proposed
      } catch (error) { requestFailures.set(agent, error); throw error }
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      const gate = deferred()
      gates.set(agent.id, { agent, gate })
      agent.ctx.on('agent/request', async ({ agent: current, signal }, next) => {
        const decision = await untilAbort(gate.promise, signal)
        if (!decision.ok) throw decision.error
        const binding = bindings.get(current)
        try {
          await untilAbort(Promise.resolve(testHooks.beforeAgentRequest?.({ binding, agent: current })), signal)
          await authorize(binding, { reserveRequest: true })
          await validateRequestContext(binding, current)
        }
        catch (error) { requestFailures.set(current, error); throw error }
        return next()
      })
    })
    ctx.on('agent/disposed', ({ agent }) => gates.delete(agent.id))
    const toolAuthorize = request => authorizeTool(request)
    const kivoPlugin = { name: 'geneway-kivo-tpm', inject: ['tools'], apply(scope) {
      const lifetime = new AbortController()
      for (const tool of createKivoTpmTools({ authorize: toolAuthorize, signal: lifetime.signal })) scope.tools.register(tool)
      return () => lifetime.abort(runtimeError('CANCELLED', '本次执行已停止'))
    } }
    kivoFiber = ctx.plugin(kivoPlugin)
    await kivoFiber
    assertOpen()
    await testHooks.onKivoMounted?.({ ctx, fiber: kivoFiber, plugin: kivoPlugin })
    assertOpen()
    ctx.tools.register(createCycleTimeTool({ authorize: toolAuthorize }))
    for (const tool of createCollaborationTools({ invoke: invokeCollaboration })) ctx.tools.register(tool)
    if (knowledgeEnabled) await mountKnowledge(ctx)
    assertOpen()
    ctx.tools.guard(execution => {
      if (![CYCLE_TIME_TOOL, ...Object.values(KIVO_TPM_TOOLS), ...Object.values(COLLABORATION_TOOLS), ...Object.values(KNOWLEDGE_TOOLS)].includes(execution.name)) return undefined
      const binding = execution.agent && bindings.get(execution.agent)
      if (!binding) return 'Agent identity is not bound to a collaboration execution'
      if (!binding.allowedTools.includes(execution.name)) return 'Tool is outside the employee collaboration scope'
      return undefined
    })
  }

  async function authorizeModelRequest() {
    if (localCapture(agentOptions, environment)) return
    const config = readRuntimeConfig(process.env, workspaceRoot)
    if (agentOptions.provider !== config.model.provider || agentOptions.model !== config.model.model) throw runtimeError('MODEL_NOT_CONFIGURED', '模型路由不可用')
    const current = await readModelCredential(config)
    if (!modelCredential || current !== modelCredential) throw runtimeError('MODEL_NOT_CONFIGURED', '模型路由不可用')
  }

  async function mountKnowledge(ctx) {
    if (knowledgeFiber) return knowledgeFiber
    if (!knowledgeMounting) knowledgeMounting = (async () => {
      const fiber = ctx.plugin(createKnowledgePlugin(invokeKnowledge))
      await fiber
      if (knowledgeEnabled) knowledgeFiber = fiber
      else await fiber.dispose()
      testHooks.onKnowledgeSchemas?.(ctx.tools.schemas().map(schema => schema.name))
      return knowledgeFiber
    })().finally(() => { knowledgeMounting = undefined })
    return knowledgeMounting
  }

  async function executeRoot(rootWorkId, generation, entry) {
    const ctx = await context()
    const rootSnapshot = await startRoot(rootWorkId, generation)
    const rootState = await store.read()
    const rootInstructions = rootState.employees.find(employee => employee.id === rootSnapshot.employeeId)?.instructions ?? ''
    const rootExecution = rootSnapshot.executions.find(execution => execution.generation === generation && ACTIVE.has(execution.status))
    if (!rootExecution) throw runtimeError('BUSY', '协作根执行不可运行')
    const rootHandle = await ctx.agents.create({ sessionId: `collaboration-root-${randomUUID()}`, meta: { cwd: workspaceRoot }, agentOptions })
    entry.handles.add(rootHandle)
    const rootConnection = rootSnapshot.connectionId ? rootState.connections.find(item => item.id === rootSnapshot.connectionId) : null
    const rootBinding = Object.freeze({ kind: 'root', rootWorkId, workId: rootWorkId, executionId: rootExecution.id, employeeId: rootSnapshot.employeeId, generation, cancelGeneration: rootSnapshot.collaboration.cancelGeneration, planRevision: rootSnapshot.plan.revision, connection: rootConnection ? Object.freeze(connectionSnapshot(rootConnection)) : null, allowedTools: Object.freeze(Object.values(COLLABORATION_TOOLS)) })
    bindings.set(rootHandle.agent, rootBinding)
    rootHandle.agent.ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (bindings.get(agent) !== rootBinding || signal.aborted) throw runtimeError('CANCELLED', '协作根执行已停止')
      try {
        await untilAbort(Promise.resolve(testHooks.beforeAgentRequest?.({ binding: rootBinding, agent })), signal)
        await authorize(rootBinding, { reserveRequest: true })
        await validateRequestContext(rootBinding, agent)
      }
      catch (error) { requestFailures.set(agent, error); throw error }
      return next()
    })
    await bindSession(rootBinding, rootHandle.agent.id, 'running')
    const rootSignal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(rootSnapshot.collaboration.rootTimeoutMs)])
    const pending = new Map(rootSnapshot.plan.items.map(item => [item.id, item]))
    const completed = new Set(rootSnapshot.plan.items.filter(item => item.status === 'completed').map(item => item.id))
    let waiting = false
    while (pending.size) {
      const ready = [...pending.values()].filter(item => (item.dependsOn ?? []).every(id => completed.has(id))).slice(0, rootSnapshot.collaboration.maxConcurrentChildren)
      if (!ready.length && waiting) break
      if (!ready.length) throw runtimeError('INVALID_REQUEST', '协作计划依赖无法推进')
      const outcomes = await Promise.all(ready.map(item => executeChild(ctx, rootSnapshot, item, generation, entry, rootSignal)))
      for (let index = 0; index < ready.length; index += 1) {
        pending.delete(ready[index].id)
        if (outcomes[index]) completed.add(ready[index].id)
        else waiting = true
      }
    }
    if (waiting) return waitRoot(rootBinding)
    await testHooks.beforeSummaryProjection?.(rootBinding)
    const projection = await summaryProjection(rootBinding)
    summaryContexts.set(rootHandle.agent, structuredClone(projection))
    rootHandle.agent.ctx.tools.restrict({ allow: [COLLABORATION_TOOLS.summarize] })
    rootHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildAgentPrompt(`SCENARIO:root-summary Review only these persisted business results. Submit resultRefs only to ${COLLABORATION_TOOLS.summarize}; do not repeat identifiers in prose. Then provide a concise factual summary: ${JSON.stringify(modelSummaryProjection(projection))}`, rootInstructions) }],
      source: { kind: 'user' },
    }))
    await untilAbort(rootHandle.agent.whenIdle(), rootSignal)
    const rootRequestFailure = requestFailures.get(rootHandle.agent)
    if (rootRequestFailure) throw rootRequestFailure
    const submittedRefs = summarySubmissions.get(rootHandle.agent)
    if (!isDeepStrictEqual(submittedRefs, projection.resultRefs)) throw runtimeError('TOOL_CHAIN_INVALID', '负责人未提交当前持久结果引用')
    const explanation = lastAssistantText(rootHandle.agent.session.snapshotEvents())
    if (!explanation) throw runtimeError('TOOL_CHAIN_INVALID', '负责人未生成后置事实汇总')
    return finishRoot(rootBinding, rootHandle.agent.id, explanation, rootHandle.agent.session.snapshotEvents(), submittedRefs, projection.confirmationRefs, projection)
  }

  async function executeChild(ctx, rootSnapshot, item, generation, entry, rootSignal) {
    const state = await store.read()
    const child = state.works.find(work => work.id === item.childWorkId)
    const currentRoot = state.works.find(work => work.id === rootSnapshot.id)
    const execution = child?.executions.find(candidate => candidate.generation === generation && ACTIVE.has(candidate.status))
    if (!child || !execution) {
      if (child?.status === 'waiting_input') return false
      if (child?.status === 'completed') return true
      throw runtimeError('BUSY', '子工作不可运行')
    }
    const capability = getCapability(child.capabilityId)
    const knowledgeDependent = Boolean(child.knowledgeQuery)
    if (knowledgeDependent && !knowledgeEnabled) throw runtimeError('KNOWLEDGE_PLUGIN_DISABLED', '知识能力已停用')
    const confirmations = state.confirmations.filter(item => item.ownerMemberId === rootSnapshot.ownerMemberId && item.employeeId === child.employeeId && item.status === 'active').sort((left, right) => left.id.localeCompare(right.id))
    const dependencies = dependencyProjection(state, currentRoot, item, child.employeeId)
    const signal = AbortSignal.any([rootSignal, AbortSignal.timeout(rootSnapshot.collaboration.childTimeoutMs)])
    let run
    try {
      run = await ctx.subagents.start('spawn', {
        label: item.id,
        prompt: [{ type: 'text', text: buildAgentPrompt(childPrompt(child, capability.toolName, confirmations, dependencies.map(item => item.fact)), state.employees.find(employee => employee.id === child.employeeId)?.instructions) }],
        parent: [...entry.handles][0].agent,
        signal,
        agentOptions,
        outputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', const: 'done' }, explanation: { type: 'string' } }, required: ['status', 'explanation'] },
        maxDepth: 1,
        toolFilter: { allow: [capability.toolName, ...(knowledgeDependent ? Object.values(KNOWLEDGE_TOOLS) : [])] },
        persona: `You are ${child.employeeId}. Complete only the registered child work and use only the visible tools required by the prompt.`,
      })
      entry.runs.add(run)
      const connection = child.connectionId ? state.connections.find(candidate => candidate.id === child.connectionId) : null
      const binding = Object.freeze({
        kind: 'child', rootWorkId: rootSnapshot.id, workId: child.id, executionId: execution.id,
        employeeId: child.employeeId, generation, planRevision: currentRoot.plan.revision,
        cancelGeneration: rootSnapshot.collaboration.cancelGeneration,
        allowedTools: Object.freeze([capability.toolName, ...(knowledgeDependent ? Object.values(KNOWLEDGE_TOOLS) : [])]), capabilityId: child.capabilityId,
        toolName: capability.toolName, input: structuredClone(child.input), connectionId: child.connectionId ?? null,
        connection: connection ? Object.freeze(connectionSnapshot(connection)) : null,
        knowledgeQuery: child.knowledgeQuery,
        confirmationRefs: Object.freeze(confirmations.map(item => Object.freeze({ id: item.id, revision: item.revision }))),
        dependencies: Object.freeze(dependencies),
      })
      const gate = gates.get(run.id)
      if (!gate || gate.agent !== run.localAgent || !ctx.agents.isOwnedBy(run.id, [...entry.handles][0].agent)) throw runtimeError('FORBIDDEN', '原生子 Agent 身份无法绑定')
      bindings.set(run.localAgent, binding)
      if (knowledgeDependent) knowledgeSelections.set(run.localAgent, { allowlist: new Map(), selected: [] })
      await bindSession(binding, run.id, 'running')
      gate.gate.resolve({ ok: true })
      const result = await untilAbort(testHooks.childResult?.({ binding, run, signal }) ?? run.result, signal)
      const events = run.localAgent.session.snapshotEvents()
      const requestFailure = requestFailures.get(run.localAgent)
      if (requestFailure) throw requestFailure
      if (signal.aborted && signal.reason?.name === 'TimeoutError') throw runtimeError('UPSTREAM_TIMEOUT', '协作子工作超时')
      const failure = toolFailure(events)
      if (failure) throw runtimeError(failure.code, failure.message)
      if (result.stopReason !== 'completed') throw runtimeError('UPSTREAM_ERROR', '子工作模型执行未完成')
      const parsed = parseRunResult({ ...result, finalResponse: result.structured?.explanation, events: businessEvents(events), sessionId: run.id }, { capabilityId: child.capabilityId, input: child.input })
      await finishChild(binding, parsed, events, knowledgeSelections.get(run.localAgent)?.selected ?? [])
      return true
    } catch (error) {
      const failure = signal.aborted && signal.reason?.name === 'TimeoutError'
        ? runtimeError('UPSTREAM_TIMEOUT', '协作子工作超时')
        : error
      const gate = run && gates.get(run.id)
      if (gate && !gate.gate.settled()) gate.gate.resolve({ ok: false, error: failure })
      await failChild(child.id, execution.id, generation, failure)
      throw failure
    } finally {
      if (run) {
        entry.runs.delete(run)
        await run.dispose().catch(() => undefined)
        testHooks.afterChildDispose?.({ workId: child.id, runId: run.id })
      }
    }
  }

  async function authorizeTool({ toolName, input, invocation, grant }) {
    const binding = invocation.agent && bindings.get(invocation.agent)
    if (!binding || binding.kind !== 'child' || !binding.allowedTools.includes(toolName) || binding.toolName !== toolName || !isDeepStrictEqual(binding.input, input)) throw runtimeError('FORBIDDEN', '工具调用与 Agent 执行授权不匹配')
    const context = await authorize(binding)
    if (grant && grant.executionId !== binding.executionId) throw runtimeError('FORBIDDEN', '工具授权已失效')
    return Object.freeze({ executionId: binding.executionId, connection: context.connection ? connectionSnapshot(context.connection) : null, secretRoot })
  }

  async function invokeKnowledge({ name, args, invocation }) {
    if (!knowledgeEnabled) throw runtimeError('KNOWLEDGE_PLUGIN_DISABLED', '知识能力已停用')
    const agent = invocation.agent
    const binding = agent && bindings.get(agent)
    const selection = agent && knowledgeSelections.get(agent)
    if (!binding || binding.kind !== 'child' || !binding.knowledgeQuery || !selection || !binding.allowedTools.includes(name)) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用无效')
    const context = await authorize(binding)
    if (name === KNOWLEDGE_TOOLS.search) {
      if (args.query !== binding.knowledgeQuery) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识检索参数无效')
      await testHooks.beforeKnowledgeSearch?.(binding)
      const results = await knowledgeService.search({ id: context.rootWork.ownerMemberId }, { employeeId: binding.employeeId, query: args.query })
      for (const result of results) selection.allowlist.set(knowledgeRefKey(result), { knowledgeId: result.knowledgeId, revision: result.revision, segmentId: result.segmentId })
      return { ok: true, results }
    }
    if (name !== KNOWLEDGE_TOOLS.submitReferences || !Array.isArray(args.references) || !args.references.length) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用不能为空')
    const refs = stableKnowledgeRefs(args.references)
    if (refs.length !== args.references.length || refs.some(ref => !selection.allowlist.has(knowledgeRefKey(ref)))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用不属于当前检索')
    const state = await store.read()
    if (refs.some(ref => !currentKnowledgeReference(state, ref, context.rootWork.ownerMemberId, binding.employeeId)
      || !currentKnowledgeReference(state, ref, context.rootWork.ownerMemberId, context.rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用已失效')
    selection.selected = refs
    return { ok: true, references: refs }
  }

  async function invokeCollaboration({ name, args, invocation }) {
    const binding = invocation.agent && bindings.get(invocation.agent)
    if (!binding || binding.kind !== 'root') throw runtimeError('FORBIDDEN', '只有协作负责人可执行协作操作')
    await authorize(binding)
    if (name !== COLLABORATION_TOOLS.summarize) throw runtimeError('FORBIDDEN', '协作工具未获准')
    const refs = await validateSummaryRefs(binding, args.resultRefs)
    summarySubmissions.set(invocation.agent, Object.freeze(refs))
    return { ok: true, resultRefs: refs }
  }

  async function authorize(binding, { reserveRequest = false } = {}) {
    let context
    await store.update(state => {
      context = executionAuthorization(state, binding)
      const { rootWork } = context
      if (reserveRequest) {
        if (rootWork.collaboration.requestCount >= rootWork.collaboration.requestLimit) throw runtimeError('BUDGET_EXHAUSTED', '协作模型请求预算已耗尽')
        rootWork.collaboration = { ...rootWork.collaboration, requestCount: rootWork.collaboration.requestCount + 1 }
        return { ...state, works: state.works.map(candidate => candidate.id === rootWork.id ? rootWork : candidate) }
      }
      return state
    })
    return context
  }

  function executionAuthorization(state, binding) {
    if (!binding) throw runtimeError('FORBIDDEN', 'Agent identity 未绑定')
    const rootWork = state.works.find(work => work.id === binding.rootWorkId && work.collaboration)
    const work = state.works.find(candidate => candidate.id === binding.workId)
    const execution = work?.executions.find(candidate => candidate.id === binding.executionId)
    const member = state.members.find(candidate => candidate.id === rootWork?.ownerMemberId && candidate.enabled === true)
    const employee = state.employees.find(candidate => candidate.id === binding.employeeId && candidate.enabled === true)
    const skill = state.skills.find(candidate => candidate.id === work?.skillId && candidate.enabled === true)
    const route = state.modelRoutes.find(candidate => candidate.id === employee?.modelRouteId && candidate.enabled === true)
    if (!rootWork || !member || !member.employeeIds.includes(employee?.id) || !employee?.skillIds?.includes(skill?.id) || !route || route.provider !== 'zenmux' || route.model !== 'deepseek/deepseek-v4.1-flash' || route.credentialRef !== 'ZENMUX_API_KEY') throw runtimeError('FORBIDDEN', '当前成员、员工或模型路由授权已撤销')
    if (isRetiredWork(state, rootWork)) throw runtimeError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
    if (rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running') throw runtimeError('CANCELLED', '协作 generation 已关闭')
    if (work.ownerMemberId !== member.id || work.status !== 'running' || !execution || execution.generation !== binding.generation || execution.cancelGeneration !== binding.cancelGeneration || !ACTIVE.has(execution.status)) throw runtimeError('CANCELLED', '当前执行已关闭')
    const capability = getCapability(work.capabilityId)
    if (!capability || skill.capabilityId !== capability.id) throw runtimeError('FORBIDDEN', '当前 Skill 授权已撤销')
    if (binding.kind === 'child') {
      const item = rootWork.plan.items.find(candidate => candidate.childWorkId === work.id)
      if (!item || item.employeeId !== binding.employeeId || item.status !== 'running' || work.rootWorkId !== rootWork.id || binding.capabilityId !== work.capabilityId
        || !isDeepStrictEqual(binding.input, work.input) || !isDeepStrictEqual(execution.input, work.input)) throw runtimeError('FORBIDDEN', '当前计划项或执行参数已变化')
      if (!isDeepStrictEqual(dependencyProjection(state, rootWork, item, employee.id), binding.dependencies)) throw runtimeError('FORBIDDEN', '交接事实或接收授权已变化')
    }
    let connection = null
    if (capability.requiresConnection) {
      connection = state.connections.find(candidate => candidate.id === work.connectionId && candidate.enabled === true && candidate.status === 'ready')
      if (!connection || connection.kind !== capability.connectionKind || !employee.connectionIds?.includes(connection.id) || !connection.skillIds?.includes(skill.id)
        || !isDeepStrictEqual(connectionSnapshot(connection), binding.connection)) throw runtimeError('FORBIDDEN', '当前连接 revision 或目标已撤销')
      assertTrustedConnection(connectionCatalog, connection)
      if (binding.kind === 'child' && !connectionInputAllowed(connection, capability.id, work.input)) throw runtimeError('FORBIDDEN', '当前业务对象授权已撤销')
    }
    return { rootWork, work, execution, member, employee, skill, route, connection }
  }

  function handoffProjection(state, rootWork, child, handoff, recipientEmployeeId) {
    const member = state.members.find(item => item.id === rootWork.ownerMemberId && item.enabled === true)
    const sourceEmployee = state.employees.find(item => item.id === child?.employeeId && item.enabled === true)
    const recipient = state.employees.find(item => item.id === recipientEmployeeId && item.enabled === true)
    const skill = state.skills.find(item => item.id === child?.skillId && item.enabled === true)
    const capability = skill && getCapability(skill.capabilityId)
    const result = handoff?.resultRefs.length === 1 && child?.results.find(item => item.id === handoff.resultRefs[0])
    if (!member || !sourceEmployee || !recipient || !member.employeeIds.includes(sourceEmployee.id) || !member.employeeIds.includes(recipient.id)
      || !sourceEmployee.skillIds?.includes(skill?.id) || !capability || capability.retired || child.ownerMemberId !== member.id || child.rootWorkId !== rootWork.id
      || child.status !== 'completed' || handoff?.status !== 'current' || !result || result.capabilityId !== child.capabilityId) throw runtimeError('FORBIDDEN', '交接事实或接收员工未获准')
    let connection = null
    if (capability.requiresConnection) {
      const current = state.connections.find(item => item.id === child.connectionId && item.enabled === true && item.status === 'ready')
      if (!current || current.kind !== capability.connectionKind || !sourceEmployee.connectionIds?.includes(current.id) || !current.skillIds?.includes(skill.id)
        || !recipient.connectionIds?.includes(current.id) || !recipient.skillIds?.includes(skill.id)
        || !connectionInputAllowed(current, capability.id, child.input)) throw runtimeError('FORBIDDEN', '交接事实连接授权已撤销')
      assertTrustedConnection(connectionCatalog, current)
      connection = connectionSnapshot(current)
      if (['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].some(key => result.source?.[key] !== current[key])) throw runtimeError('FORBIDDEN', '交接事实来源与当前连接不匹配')
    }
    if (handoff.knowledgeRefs.some(ref => !currentKnowledgeReference(state, ref, member.id, sourceEmployee.id)
      || !currentKnowledgeReference(state, ref, member.id, recipient.id) || !currentKnowledgeReference(state, ref, member.id, rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '交接知识接收范围已失效')
    const fact = sanitizeFollowUpContext({ question: '核对当前交接事实', facts: [{ kind: result.kind, payload: result.payload, ...(result.source ? { source: result.source } : {}) }], confirmations: [] }).facts[0]
    return { workId: child.id, resultId: result.id, handoffId: handoff.id, connection, knowledgeRefs: handoff.knowledgeRefs, fact }
  }

  function dependencyProjection(state, rootWork, item, recipientEmployeeId) {
    return (item.dependsOn ?? []).map(id => {
      const dependency = rootWork.plan.items.find(candidate => candidate.id === id)
      const child = dependency && state.works.find(work => work.id === dependency.childWorkId)
      const handoff = child && rootWork.handoffs.find(candidate => candidate.childWorkId === child.id && candidate.status === 'current')
      if (dependency?.status !== 'completed') throw runtimeError('FORBIDDEN', '前序事实尚未完成交接')
      return handoffProjection(state, rootWork, child, handoff, recipientEmployeeId)
    })
  }

  async function validateRequestContext(binding, agent) {
    const state = await store.read()
    const rootWork = state.works.find(work => work.id === binding.rootWorkId)
    if (!rootWork) throw runtimeError('FORBIDDEN', '当前执行授权已失效')
    if (binding.kind === 'child') {
      if (binding.confirmationRefs.some(ref => !activeConfirmation(state, ref, rootWork.ownerMemberId, binding.employeeId))) throw runtimeError('FORBIDDEN', '确认信息授权已失效')
      const refs = [...(knowledgeSelections.get(agent)?.allowlist.values() ?? [])]
      if (refs.some(ref => !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, binding.employeeId)
        || !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用已失效')
      return
    }
    const expected = summaryContexts.get(agent)
    if (!expected) return
    if (expected.confirmationRefs.some(ref => !activeConfirmation(state, ref, rootWork.ownerMemberId, rootWork.employeeId))) throw runtimeError('FORBIDDEN', '确认信息授权已失效')
    const current = await summaryProjection(binding)
    if (!isDeepStrictEqual(current, expected)) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '汇总上下文已失效')
  }

  async function startRoot(rootWorkId, generation) {
    let snapshot
    await store.update(state => {
      const work = state.works.find(candidate => candidate.id === rootWorkId && candidate.collaboration)
      if (!work || work.collaboration.generation !== generation || work.collaboration.status !== 'accepted') throw runtimeError('BUSY', '协作工作不可启动')
      if (isRetiredWork(state, work)) throw runtimeError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
      const execution = work.executions.find(candidate => candidate.generation === generation && candidate.status === 'accepted')
      if (!execution) throw runtimeError('BUSY', '协作根执行不可启动')
      const next = { ...work, status: 'running', collaboration: { ...work.collaboration, status: 'running' }, executions: work.executions.map(candidate => candidate.id === execution.id ? { ...candidate, status: 'running', startedAt: clock() } : candidate) }
      snapshot = structuredClone(next)
      return { ...state, works: state.works.map(candidate => candidate.id === work.id ? next : candidate) }
    })
    return snapshot
  }

  async function bindSession(binding, sessionId, status) {
    await store.update(state => {
      const work = state.works.find(candidate => candidate.id === binding.workId)
      const execution = work?.executions.find(candidate => candidate.id === binding.executionId)
      if (!work || !execution || execution.generation !== binding.generation || execution.cancelGeneration !== binding.cancelGeneration || !ACTIVE.has(execution.status)) throw runtimeError('CANCELLED', 'Session 绑定晚于执行关闭')
      const nextExecution = { ...execution, status, dshSessionRef: sessionId, startedAt: execution.startedAt ?? clock() }
      let nextWork = { ...work, status, executions: work.executions.map(candidate => candidate.id === execution.id ? nextExecution : candidate) }
      if (work.rootWorkId) {
        const rootWork = state.works.find(candidate => candidate.id === work.rootWorkId)
        const plan = { ...rootWork.plan, items: rootWork.plan.items.map(item => item.childWorkId === work.id ? { ...item, status: 'running' } : item) }
        return { ...state, works: state.works.map(candidate => candidate.id === work.id ? nextWork : candidate.id === rootWork.id ? { ...rootWork, plan } : candidate) }
      }
      return { ...state, works: state.works.map(candidate => candidate.id === work.id ? nextWork : candidate) }
    })
  }

  async function finishChild(binding, parsed, events, selectedRefs) {
    const now = clock()
    await testHooks.beforeFinishChild?.(binding)
    await store.update(state => {
      executionAuthorization(state, binding)
      const rootWork = state.works.find(work => work.id === binding.rootWorkId)
      const child = state.works.find(work => work.id === binding.workId)
      const execution = child?.executions.find(candidate => candidate.id === binding.executionId)
      if (!rootWork || rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running' || !execution || execution.status !== 'running') return state
      const refs = stableKnowledgeRefs(selectedRefs)
      if (binding.knowledgeQuery && !refs.length) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识依赖工作缺少有效引用')
      if (refs.some(ref => !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, child.employeeId)
        || !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '知识引用已失效')
      const resultId = `result-${randomUUID()}`
      const handoffId = `handoff-${randomUUID()}`
      if (binding.confirmationRefs.some(ref => !state.confirmations.some(item => item.id === ref.id && item.revision === ref.revision && item.ownerMemberId === rootWork.ownerMemberId && item.employeeId === child.employeeId && item.status === 'active'))) throw runtimeError('FORBIDDEN', '确认信息授权已失效')
      const safeParsed = { ...parsed, explanation: redactInternalReferences(parsed.explanation, state, rootWork, refs) }
      const result = collaborationResult(resultId, child, safeParsed, execution.dshSessionRef, usageFromEvents(events), now, binding.generation, refs, binding.confirmationRefs)
      const handoff = { id: handoffId, childWorkId: child.id, fromEmployeeId: child.employeeId, toEmployeeId: rootWork.employeeId, resultRefs: [resultId], knowledgeRefs: result.knowledgeDependencyRefs ?? [], revision: 1, generation: binding.generation, status: 'current', createdAt: now }
      result.handoffRefs = [handoff.id]
      const nextChild = { ...child, status: 'completed', results: [...child.results, result], executions: child.executions.map(candidate => candidate.id === execution.id ? { ...candidate, status: 'completed', completedAt: now, resultId, usage: result.usage } : candidate) }
      const handoffs = rootWork.handoffs.map(item => item.childWorkId === child.id && item.status === 'current' ? { ...item, status: 'superseded' } : item)
      const nextRoot = { ...rootWork, handoffs: [...handoffs, handoff], plan: { ...rootWork.plan, items: rootWork.plan.items.map(item => item.childWorkId === child.id ? { ...item, status: 'completed' } : item) } }
      return { ...state, works: state.works.map(work => work.id === child.id ? nextChild : work.id === rootWork.id ? nextRoot : work) }
    })
  }

  async function finishRoot(binding, sessionId, explanation, events, submittedRefs, confirmationRefs, projection) {
    let result
    await store.update(state => {
      executionAuthorization(state, binding)
      if (!isDeepStrictEqual(summaryProjectionFromState(state, binding), projection)) throw runtimeError('FORBIDDEN', '汇总事实或接收授权已变化')
      const rootWork = state.works.find(work => work.id === binding.rootWorkId)
      const execution = rootWork?.executions.find(candidate => candidate.id === binding.executionId)
      if (!rootWork || rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running' || execution?.status !== 'running') return state
      const currentHandoffs = rootWork.plan.items.map(item => rootWork.handoffs.find(handoff => handoff.childWorkId === item.childWorkId && handoff.status === 'current'))
      if (currentHandoffs.some(item => !item)) throw runtimeError('TOOL_CHAIN_INVALID', '协作汇总缺少当前交接')
      const refs = currentHandoffs.flatMap(handoff => handoff.resultRefs)
      if (!isDeepStrictEqual(refs, submittedRefs) || refs.some(ref => !state.works.some(work => work.results.some(item => item.id === ref && item.generation <= binding.generation)))) throw runtimeError('TOOL_CHAIN_INVALID', '协作汇总只能引用当前持久化子结果')
      const knowledgeDependencyRefs = stableKnowledgeRefs(currentHandoffs.flatMap(handoff => handoff.knowledgeRefs))
      for (const handoff of currentHandoffs) {
        const child = state.works.find(work => work.id === handoff.childWorkId)
        if (handoff.knowledgeRefs.some(ref => !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, child.employeeId)
          || !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '汇总知识引用已失效')
      }
      if (confirmationRefs.some(ref => !state.confirmations.some(item => item.id === ref.id && item.revision === ref.revision && item.ownerMemberId === rootWork.ownerMemberId && item.employeeId === rootWork.employeeId && item.status === 'active'))) throw runtimeError('FORBIDDEN', '确认信息授权已失效')
      result = { id: `summary-${randomUUID()}`, kind: 'assistant.collaboration-summary', capabilityId: rootWork.capabilityId, skillId: rootWork.skillId, schemaVersion: 1, input: {}, payload: { resultRefs: refs }, explanation: redactInternalReferences(explanation, state, rootWork), createdAt: clock(), dshSessionRef: sessionId, contextConfirmationRefs: confirmationRefs, employeeId: rootWork.employeeId, handoffRefs: currentHandoffs.map(item => item.id), usage: usageFromEvents(events), knowledgeDependencyRefs, generation: binding.generation }
      const nextExecution = { ...execution, status: 'completed', completedAt: clock(), resultId: result.id, dshSessionRef: sessionId, usage: result.usage }
      const nextRoot = { ...rootWork, status: 'completed', results: [...rootWork.results, result], executions: rootWork.executions.map(candidate => candidate.id === execution.id ? nextExecution : candidate), collaboration: { ...rootWork.collaboration, status: 'completed', summaryResultRefs: refs } }
      return { ...state, works: state.works.map(work => work.id === rootWork.id ? nextRoot : work) }
    })
    return result
  }

  async function waitRoot(binding) {
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === binding.rootWorkId)
      const execution = rootWork?.executions.find(candidate => candidate.id === binding.executionId)
      if (!rootWork || rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running' || execution?.status !== 'running') return state
      const nextExecution = { ...execution, status: 'completed', completedAt: clock(), dshSessionRef: execution.dshSessionRef, usage: unknownUsage() }
      const nextRoot = { ...rootWork, status: 'waiting_input', executions: rootWork.executions.map(candidate => candidate.id === execution.id ? nextExecution : candidate), collaboration: { ...rootWork.collaboration, status: 'waiting_input' } }
      return { ...state, works: state.works.map(work => work.id === rootWork.id ? nextRoot : work) }
    })
    return undefined
  }

  async function failChild(workId, executionId, generation, error) {
    await store.update(state => {
      const child = state.works.find(work => work.id === workId)
      const execution = child?.executions.find(candidate => candidate.id === executionId)
      const rootWork = child && state.works.find(work => work.id === child.rootWorkId)
      if (!child || !execution || execution.generation !== generation || TERMINAL.has(execution.status) || rootWork?.collaboration.generation !== generation) return state
      const cause = safeRuntimeCause(error), cancelled = cause.code === 'CANCELLED'
      const status = cancelled ? 'cancelled' : 'failed'
      const now = clock()
      return { ...state, works: state.works.map(work => {
        if (work.id !== rootWork.id && work.rootWorkId !== rootWork.id) return work
        const executions = work.executions.map(candidate => candidate.generation === generation && ACTIVE.has(candidate.status) ? { ...candidate, status, completedAt: now, error: cause } : candidate)
        if (work.id === rootWork.id) return { ...work, status, executions, collaboration: { ...work.collaboration, status }, plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running'].includes(item.status) ? { ...item, status } : item) } }
        return { ...work, status: ACTIVE.has(work.status) ? status : work.status, executions }
      }) }
    })
  }

  async function failRoot(rootWorkId, generation, error) {
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === rootWorkId && work.collaboration)
      if (!rootWork || rootWork.collaboration.generation !== generation || TERMINAL.has(rootWork.collaboration.status)) return state
      const cause = safeRuntimeCause(error), cancelled = cause.code === 'CANCELLED'
      const status = cancelled ? 'cancelled' : 'failed', now = clock()
      return { ...state, works: state.works.map(work => {
        if (work.id !== rootWorkId && work.rootWorkId !== rootWorkId) return work
        const executions = work.executions.map(execution => execution.generation === generation && ACTIVE.has(execution.status) ? { ...execution, status, completedAt: now, error: cause } : execution)
        if (work.id === rootWorkId) return { ...work, status, executions, collaboration: { ...work.collaboration, status }, plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running'].includes(item.status) ? { ...item, status } : item) } }
        return { ...work, status: ACTIVE.has(work.status) ? status : work.status, executions }
      }) }
    })
  }

  async function validateSummaryRefs(binding, refs) {
    if (!Array.isArray(refs) || !refs.length) throw runtimeError('INVALID_REQUEST', '汇总引用不能为空')
    const state = await store.read()
    const rootWork = state.works.find(work => work.id === binding.rootWorkId)
    const expected = rootWork.plan.items.flatMap(item => rootWork.handoffs.filter(handoff => handoff.childWorkId === item.childWorkId && handoff.status === 'current').flatMap(handoff => handoff.resultRefs))
    if (!isDeepStrictEqual(refs, expected)) throw runtimeError('FORBIDDEN', '汇总未提交每个计划项的当前结果')
    return [...refs]
  }

  async function summaryProjection(binding) {
    const state = await store.read()
    return summaryProjectionFromState(state, binding)
  }

  function summaryProjectionFromState(state, binding) {
    const rootWork = state.works.find(work => work.id === binding.rootWorkId)
    const entries = rootWork.plan.items.map(item => {
      const handoff = rootWork.handoffs.find(candidate => candidate.childWorkId === item.childWorkId && candidate.status === 'current')
      const child = state.works.find(work => work.id === item.childWorkId)
      const result = handoff && child.results.find(candidate => candidate.id === handoff.resultRefs[0])
      if (!handoff || !result) throw runtimeError('TOOL_CHAIN_INVALID', '后置汇总投影缺少当前持久结果')
      const authorization = handoffProjection(state, rootWork, child, handoff, rootWork.employeeId)
      if (handoff.knowledgeRefs.some(ref => !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, child.employeeId)
        || !currentKnowledgeReference(state, ref, rootWork.ownerMemberId, rootWork.employeeId))) throw runtimeError('KNOWLEDGE_REFERENCE_INVALID', '汇总知识引用已失效')
      const payload = structuredClone(result.payload)
      if (typeof payload?.explanation === 'string') payload.explanation = redactInternalReferences(payload.explanation, state, rootWork)
      return { itemId: item.id, goal: item.goal, employeeId: child.employeeId, employeeName: employeeLabel(state, child.employeeId, '协作员工'), resultId: result.id, handoffId: handoff.id, kind: result.kind, payload, source: result.source, explanation: redactInternalReferences(result.explanation, state, rootWork), knowledgeRefs: handoff.knowledgeRefs, authorization }
    })
    const confirmations = state.confirmations.filter(item => item.ownerMemberId === rootWork.ownerMemberId && item.employeeId === rootWork.employeeId && item.status === 'active').sort((left, right) => left.id.localeCompare(right.id))
    return { rootWorkId: rootWork.id, generation: binding.generation, resultRefs: entries.map(item => item.resultId), entries, confirmations: confirmations.map(item => ({ id: item.id, revision: item.revision, value: item.value })), confirmationRefs: confirmations.map(item => ({ id: item.id, revision: item.revision })) }
  }

  async function interrupt(rootWorkId) {
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === rootWorkId && work.collaboration)
      if (!rootWork || TERMINAL.has(rootWork.collaboration.status)) return state
      const now = clock()
      const generation = rootWork.collaboration.generation
      return { ...state, works: state.works.map(work => {
        if (work.id !== rootWorkId && work.rootWorkId !== rootWorkId) return work
        const executions = work.executions.map(execution => execution.generation === generation && ACTIVE.has(execution.status) ? { ...execution, status: 'interrupted', interruptedAt: now, error: { code: 'PROCESS_SHUTDOWN', message: '进程关闭时未完成' } } : execution)
        if (work.id === rootWorkId) return { ...work, status: 'interrupted', executions, collaboration: { ...work.collaboration, status: 'interrupted' }, plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running'].includes(item.status) ? { ...item, status: 'interrupted' } : item) } }
        return { ...work, status: ACTIVE.has(work.status) ? 'interrupted' : work.status, executions }
      }) }
    })
  }

  async function disposeEntry(entry) {
    await Promise.all([...entry.runs].map(run => run.dispose().catch(() => undefined)))
    await Promise.all([...entry.handles].map(handle => handle.dispose().catch(() => undefined)))
  }
}

function collaborationResult(id, work, parsed, sessionId, usage, now, generation, knowledgeDependencyRefs, contextConfirmationRefs) {
  const base = parsed.result
  const payload = base.kind === 'gearjob.work-order.observation'
    ? { ...createObservation({ source: base.payload, queriedAt: now }), observationId: id, evidenceMode: base.payload.evidenceMode, explanation: parsed.explanation, dshSessionRef: sessionId }
    : base.payload
  return {
    id, kind: base.kind, capabilityId: work.capabilityId, skillId: work.skillId, schemaVersion: 1,
    input: structuredClone(work.input), payload, explanation: work.inputProvenance ? `用户提供的计算条件下平均分摊：${parsed.explanation}` : parsed.explanation, source: base.source,
    createdAt: base.kind === KIVO_TPM_RESULT_KIND ? payload.queriedAt : now, toolName: base.toolName, pluginId: base.pluginId, pluginVersion: base.pluginVersion,
    dshSessionRef: sessionId, contextConfirmationRefs, employeeId: work.employeeId, handoffRefs: [], usage,
    knowledgeDependencyRefs, generation, ...(work.inputProvenance ? { inputProvenance: structuredClone(work.inputProvenance) } : {}),
  }
}

function modelSummaryProjection(projection) {
  return {
    resultRefs: projection.resultRefs,
    results: projection.entries.map(item => ({
      goal: item.goal,
      employee: item.employeeName,
      kind: item.kind,
      payload: publicModelPayload(item.payload),
      source: item.source,
      explanation: item.explanation,
      usedAuthorizedKnowledge: item.knowledgeRefs.length > 0,
    })),
    confirmedFacts: projection.confirmations.map(item => item.value),
  }
}

function publicModelPayload(payload) {
  const value = structuredClone(payload)
  if (value && typeof value === 'object') {
    delete value.observationId
    delete value.dshSessionRef
    delete value.explanation
  }
  return value
}

function redactInternalReferences(text, state, rootWork, selectedKnowledgeRefs = []) {
  if (typeof text !== 'string' || !text) return text
  const children = state.works.filter(work => work.rootWorkId === rootWork.id)
  const replacements = new Map([
    [rootWork.id, '当前协作工作'],
    [rootWork.employeeId, employeeLabel(state, rootWork.employeeId, '负责人')],
  ])
  for (const item of rootWork.plan.items) replacements.set(item.id, '当前计划步骤')
  for (const ref of selectedKnowledgeRefs) replacements.set(ref.knowledgeId, '当前获准知识')
  for (const work of children) {
    replacements.set(work.id, '当前协作步骤')
    replacements.set(work.employeeId, employeeLabel(state, work.employeeId, '协作员工'))
    for (const execution of work.executions) {
      replacements.set(execution.id, '当前执行记录')
      replacements.set(execution.operation, '协作执行')
    }
    for (const result of work.results) {
      replacements.set(result.id, resultLabel(result.kind))
      for (const ref of result.knowledgeDependencyRefs ?? []) replacements.set(ref.knowledgeId, '当前获准知识')
    }
  }
  for (const execution of rootWork.executions) {
    replacements.set(execution.id, '当前执行记录')
    replacements.set(execution.operation, '协作执行')
  }
  for (const result of rootWork.results) {
    replacements.set(result.id, resultLabel(result.kind))
    for (const ref of result.knowledgeDependencyRefs ?? []) replacements.set(ref.knowledgeId, '当前获准知识')
  }
  for (const handoff of rootWork.handoffs) {
    replacements.set(handoff.id, '当前交接记录')
    for (const ref of handoff.knowledgeRefs ?? []) replacements.set(ref.knowledgeId, '当前获准知识')
  }
  let safe = text
  for (const [internal, label] of [...replacements].filter(([value]) => value).sort((left, right) => right[0].length - left[0].length)) safe = safe.split(internal).join(label)
  return safe
}

function resultLabel(kind) {
  if (kind === 'gearjob.work-order.observation') return '工单事实结果'
  if (kind === 'manufacturing.takt') return '节拍核对结果'
  return '协作结果'
}

function employeeLabel(state, employeeId, fallback) {
  const name = state.employees.find(item => item.id === employeeId)?.name
  return name && name !== employeeId ? name : fallback
}

function childPrompt(work, toolName, confirmations, dependencies) {
  const knowledge = work.knowledgeQuery
    ? ` Call ${KNOWLEDGE_TOOLS.search} with {"query":${JSON.stringify(work.knowledgeQuery)}}, use only returned segments, then call ${KNOWLEDGE_TOOLS.submitReferences} with at least one exact returned reference.`
    : ''
  const confirmed = confirmations.length ? ` Current confirmed facts: ${JSON.stringify(confirmations.map(item => ({ id: item.id, revision: item.revision, value: item.value })))}.` : ''
  const facts = dependencies.length ? ` Current authorized facts handed off by the explicit prerequisite steps: ${JSON.stringify(dependencies)}. Use these facts for the requested comparison; do not replace them by an earlier explanation or a repeated source read.` : ''
  return `SCENARIO:${work.planItemId} Complete this registered work: ${work.goal}.${confirmed}${facts} Call ${toolName} exactly once with ${JSON.stringify(work.input)}.${knowledge} Then call structured_output with {"status":"done","explanation":"your concise factual explanation"}.`
}

function usageFromEvents(events) {
  const total = {}, seen = new Set()
  for (const event of events) {
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue
    const values = event.data.usage ? [event.data.usage] : (event.data.stream ?? []).filter(item => item.type === 'usage').map(item => item.usage)
    for (const usage of values) for (const key of USAGE_KEYS) if (Number.isFinite(usage?.[key])) { total[key] = (total[key] ?? 0) + usage[key]; seen.add(key) }
  }
  return Object.fromEntries(USAGE_KEYS.map(key => [key, seen.has(key) && total[key] !== 0 ? total[key] : null]))
}
function businessEvents(events) {
  const omittedCalls = new Set(events.filter(event => event.type === 'tool/call' && ['structured_output', ...Object.values(KNOWLEDGE_TOOLS)].includes(event.data?.name)).map(event => event.data.callId))
  return events.filter(event => !(event.type === 'tool/call' && omittedCalls.has(event.data?.callId)) && !(event.type === 'tool/result' && omittedCalls.has(event.data?.message?.source?.callId)))
}
function toolFailure(events) {
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data?.message?.content?.find(item => item.type === 'text')
    try {
      const value = JSON.parse(block?.text)
      if (value?.ok === false && ['BUDGET_EXHAUSTED', 'FORBIDDEN', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'KNOWLEDGE_PLUGIN_DISABLED', 'KNOWLEDGE_REFERENCE_INVALID'].includes(value.error?.code)) return value.error
    } catch {}
  }
  return undefined
}
function unknownUsage() { return Object.fromEntries(USAGE_KEYS.map(key => [key, null])) }
function activeConfirmation(state, ref, ownerMemberId, employeeId) {
  return state.confirmations.some(item => item.id === ref.id && item.revision === ref.revision && item.ownerMemberId === ownerMemberId && item.employeeId === employeeId && item.status === 'active')
}
function lastAssistantText(events) {
  for (const event of [...events].reverse()) if (event.type === 'assistant/message') {
    const text = event.data.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').trim()
    if (text) return text
  }
  return undefined
}
function createConversationWorkTools(invoke, allowed) {
  const input = { type: 'object', additionalProperties: false, properties: {
    recordType: { type: 'string' }, reference: { type: 'string' },
    filters: { type: 'object', additionalProperties: false, properties: {
      page: { type: 'integer' }, pageSize: { type: 'integer' }, keyword: { type: 'string' }, deviceId: { type: 'string' },
      archive: { type: 'string' }, status: { type: 'string' }, severity: { type: 'string' }, tab: { type: 'string' },
    } }, availableSeconds: { type: 'number' }, quantity: { type: 'number' },
  } }
  const specs = [
    [CONVERSATION_WORK_TOOLS.create, 'Create one work only when the owner explicitly requests a new business query. Use an explicitly selected authorized skill and connection; ask when ambiguous. Missing business inputs are allowed and produce waiting_input, not a guessed query.', {
      skillId: { type: 'string', required: true }, connectionId: { type: 'string' }, goal: { type: 'string' }, input,
    }],
    [CONVERSATION_WORK_TOOLS.continue, 'Supply missing inputs or continue the exact work selected by the owner in this conversation. An active execution does not apply new inputs; ask the owner to resubmit after it ends.', { workId: { type: 'string', required: true }, input }],
    [CONVERSATION_WORK_TOOLS.followUp, 'Ask a factual follow-up on the exact completed work selected by the owner. This does not refresh business data. Work completion is asynchronous; do not poll or wait in a loop.', { workId: { type: 'string', required: true }, text: { type: 'string', required: true } }],
    [CONVERSATION_WORK_TOOLS.status, 'Read the current status and authorized persisted facts of an exact work in this conversation. Without workId, list candidates and ask the owner to choose; never choose the most recent work. Do not poll in a loop.', { workId: { type: 'string' } }],
    [CONVERSATION_WORK_TOOLS.stop, 'Stop only the exact work explicitly selected by the owner. Does not stop this reply or another work.', { workId: { type: 'string', required: true } }],
  ]
  return specs.filter(([name]) => allowed.includes(name)).map(([name, description, parameters]) => defineTool({
    name, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, invocation) {
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(parameters, key))) throw runtimeError('INVALID_REQUEST', '工具输入含未声明字段')
        for (const [key, rule] of Object.entries(parameters)) if (rule.required && (typeof args[key] !== 'string' || !args[key].trim())) throw runtimeError('INVALID_REQUEST', '工具缺少明确的工作或技能')
        return await invoke({ name, args, invocation })
      } catch (error) {
        const code = ['FORBIDDEN', 'INVALID_REQUEST', 'MODEL_NOT_CONFIGURED', 'CANCELLED', 'CAPABILITY_RETIRED'].includes(error?.code) ? error.code : 'UPSTREAM_ERROR'
        return { ok: false, error: { code, message: '工作操作未完成，请核对当前会话的明确工作、技能、连接和输入；其他工作请到 Web 继续。' } }
      }
    },
  }))
}
function conversationWorkPrompt(state, conversation, connectionCatalog) {
  const employee = state.employees.find(item => item.id === conversation.employeeId)
  const choices = state.skills.filter(skill => skill.enabled && employee?.skillIds.includes(skill.id) && getCapability(skill.capabilityId)?.retired === false).map(skill => {
    const capability = getCapability(skill.capabilityId)
    return { skillId: skill.id, capabilityId: capability.id, requiredInputs: capability.requiredInputs,
      connections: capability.requiresConnection ? state.connections.filter(connection => {
        if (!connection.enabled || connection.status !== 'ready' || connection.kind !== capability.connectionKind || !employee.connectionIds.includes(connection.id) || !connection.skillIds.includes(skill.id)) return false
        try { assertTrustedConnection(connectionCatalog, connection); return true } catch { return false }
      }).map(connection => ({ connectionId: connection.id, name: connection.name, sourceSystem: connection.sourceSystem, sourceInstance: connection.sourceInstance })) : [],
    }
  })
  return `\n只有本人明确交办业务或引用工作时才使用工作工具，普通问答不创建工作。工具只操作本人当前对话和当前Agent；不要要求或提交owner、employee、原生Session、秘密或URL。技能或连接有多个候选时询问本人，不猜第一个或最近工作。缺必要信息使用waiting_input并提示补充。工作独立异步执行；不等待或循环查询。返回事实必须保留来源、时间和状态，不把受理说成完成。TPM维修/保养/点检/异常/维护计划/设备分别用recordType repair/maintenance/inspection/exception/plan/device；读取reference为文本，计划/设备用明确UUID；列表使用recordType和filters。当前候选：${JSON.stringify(choices)}`
}
function launchEnvironment(values) {
  return {
    get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' },
    getFrom: (name, sources) => sources.includes('process') && values[name] !== undefined ? { value: values[name], source: 'process' } : undefined,
  }
}
function deferred() {
  let complete, done = false
  const promise = new Promise(resolve => { complete = resolve })
  return { promise, resolve(value) { if (!done) { done = true; complete(value) } }, settled: () => done }
}
function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? runtimeError('CANCELLED', '本次执行已停止'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? runtimeError('CANCELLED', '本次执行已停止'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function runtimeError(code, message) { return Object.assign(new Error(message), { code }) }
function localCapture(options, environment) {
  if (options.provider !== 'geneway-p3-capture' || options.model !== 'p3-runtime-test'
    || typeof environment.GENEWAY_P3_CAPTURE_KEY !== 'string' || !environment.GENEWAY_P3_CAPTURE_KEY.trim()) return false
  try {
    const url = new URL(environment.GENEWAY_P3_CAPTURE_BASE_URL)
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function safeRuntimeCause(error) {
  if (error?.code === 'CAPABILITY_RETIRED') return { code: 'CAPABILITY_RETIRED', message: '旧来源已停止新执行，可查看历史记录' }
  if (error?.code === 'MODEL_NOT_CONFIGURED') return { code: 'MODEL_NOT_CONFIGURED', message: '模型路由不可用' }
  if (error?.code === 'BUDGET_EXHAUSTED') return { code: 'BUDGET_EXHAUSTED', message: '协作模型请求预算已耗尽' }
  if (error?.code === 'FORBIDDEN') return { code: 'FORBIDDEN', message: '当前执行授权已失效' }
  if (error?.code === 'KNOWLEDGE_PLUGIN_DISABLED') return { code: 'KNOWLEDGE_PLUGIN_DISABLED', message: '知识能力已停用' }
  if (error?.code === 'KNOWLEDGE_REFERENCE_INVALID') return { code: 'KNOWLEDGE_REFERENCE_INVALID', message: '知识引用无效或已失效' }
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') return { code: 'CANCELLED', message: '本次执行已停止' }
  if (error?.code === 'UPSTREAM_TIMEOUT' || error?.name === 'TimeoutError') return { code: 'UPSTREAM_TIMEOUT', message: '协作执行超时' }
  return { code: 'UPSTREAM_ERROR', message: '协作执行失败' }
}
