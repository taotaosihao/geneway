import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { CYCLE_TIME_TOOL, GEARJOB_TOOL, getCapability } from './capabilities.mjs'
import { parseRunResult } from './dsh-runner.mjs'
import { connectionSnapshot } from './execution-grant.mjs'
import { readRuntimeConfig, readSettings } from './runtime-config.mjs'
import { createCycleTimeTool } from '../plugins/cycle-time.mjs'
import { createGearJobWorkOrderTool } from '../plugins/gearjob-work-order.mjs'
import { COLLABORATION_TOOLS, createCollaborationTools } from '../plugins/collaboration.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { createUserMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const ACTIVE = new Set(['accepted', 'running'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const DEFAULT_AGENT = Object.freeze({ provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', maxTokens: 4096 })

export function createCollaborationRunner({
  store,
  root: workspaceRoot = process.cwd(),
  dshHome = readRuntimeConfig(process.env, workspaceRoot).dshHome,
  patchPath = resolve(workspaceRoot, 'config', 'p3-runtime.patch.yml'),
  runProfileImpl = runProfile,
  agentOptions = DEFAULT_AGENT,
  environment = {},
  secretRoot = readRuntimeConfig(process.env, workspaceRoot).secretRoot,
  clock = () => new Date().toISOString(),
  onError = () => undefined,
} = {}) {
  if (!store) throw new Error('store is required')
  if (!Number.isSafeInteger(agentOptions.maxTokens) || agentOptions.maxTokens < 1 || agentOptions.maxTokens > 4096) throw new Error('collaboration maxTokens must be between 1 and 4096')
  let runtime
  let booting
  const bindings = new WeakMap()
  const summarySubmissions = new WeakMap()
  const requestFailures = new WeakMap()
  const gates = new Map()
  const activeRoots = new Map()

  return {
    async run(rootWorkId) {
      const state = await store.read()
      const rootWork = state.works.find(work => work.id === rootWorkId && work.collaboration)
      if (!rootWork) throw runtimeError('NOT_FOUND', '协作工作不存在')
      const existing = activeRoots.get(rootWorkId)
      if (existing) {
        if (existing.generation === rootWork.collaboration.generation) return existing.promise
        await existing.promise.catch(() => undefined)
      }
      const controller = new AbortController()
      const entry = { controller, generation: rootWork.collaboration.generation, handles: new Set(), runs: new Set(), promise: undefined }
      entry.promise = executeRoot(rootWorkId, rootWork.collaboration.generation, entry)
        .catch(async error => { await failRoot(rootWorkId, rootWork.collaboration.generation, error); onError(error); throw error })
        .finally(async () => { await disposeEntry(entry); activeRoots.delete(rootWorkId) })
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

    async close() {
      const ids = [...activeRoots.keys()]
      await Promise.all(ids.map(async id => {
        await interrupt(id)
        const entry = activeRoots.get(id)
        entry?.controller.abort(runtimeError('PROCESS_SHUTDOWN', '进程关闭时未完成'))
        if (entry) await disposeEntry(entry)
      }))
      await Promise.all([...activeRoots.values()].map(entry => entry.promise.catch(() => undefined)))
      activeRoots.clear()
      if (runtime) await runtime.shutdown.shutdown(0)
      runtime = undefined
      booting = undefined
    },
  }

  async function context() {
    if (runtime) return runtime.ctx
    if (!booting) booting = boot()
    runtime = await booting
    return runtime.ctx
  }

  async function boot() {
    const settingsKey = readSettings()?.env?.ANTHROPIC_AUTH_TOKEN
    const values = {
      ...process.env,
      ...environment,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      ...(typeof settingsKey === 'string' && settingsKey.trim() ? { ZENMUX_API_KEY: settingsKey } : {}),
    }
    delete values.GENEWAY_DSH_GRANT_FILE
    const started = await runProfileImpl({ environment: launchEnvironment(values), profile: 'sdk', patchFiles: [patchPath], args: [], resolutionMode: 'runtime' })
    install(started.ctx)
    return started
  }

  function install(ctx) {
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin !== 'subagent') return
      const gate = deferred()
      gates.set(agent.id, { agent, gate })
      agent.ctx.on('agent/request', async ({ agent: current, signal }, next) => {
        const decision = await untilAbort(gate.promise, signal)
        if (!decision.ok) throw decision.error
        const binding = bindings.get(current)
        try { await authorize(binding, { reserveRequest: true }) }
        catch (error) { requestFailures.set(current, error); throw error }
        return next()
      })
    })
    ctx.on('agent/disposed', ({ agent }) => gates.delete(agent.id))
    const toolAuthorize = request => authorizeTool(request)
    ctx.tools.register(createGearJobWorkOrderTool({ authorize: toolAuthorize }))
    ctx.tools.register(createCycleTimeTool({ authorize: toolAuthorize }))
    for (const tool of createCollaborationTools({ invoke: invokeCollaboration })) ctx.tools.register(tool)
    ctx.tools.guard(execution => {
      if (![GEARJOB_TOOL, CYCLE_TIME_TOOL, ...Object.values(COLLABORATION_TOOLS)].includes(execution.name)) return undefined
      const binding = execution.agent && bindings.get(execution.agent)
      if (!binding) return 'Agent identity is not bound to a collaboration execution'
      if (!binding.allowedTools.includes(execution.name)) return 'Tool is outside the employee collaboration scope'
      return undefined
    })
  }

  async function executeRoot(rootWorkId, generation, entry) {
    const ctx = await context()
    const rootSnapshot = await startRoot(rootWorkId, generation)
    const rootExecution = rootSnapshot.executions.find(execution => execution.generation === generation && ACTIVE.has(execution.status))
    if (!rootExecution) throw runtimeError('BUSY', '协作根执行不可运行')
    const rootHandle = await ctx.agents.create({ sessionId: `collaboration-root-${randomUUID()}`, meta: { cwd: workspaceRoot }, agentOptions })
    entry.handles.add(rootHandle)
    const rootBinding = Object.freeze({ kind: 'root', rootWorkId, workId: rootWorkId, executionId: rootExecution.id, employeeId: rootSnapshot.employeeId, generation, cancelGeneration: rootSnapshot.collaboration.cancelGeneration, planRevision: rootSnapshot.plan.revision, allowedTools: Object.freeze(Object.values(COLLABORATION_TOOLS)) })
    bindings.set(rootHandle.agent, rootBinding)
    rootHandle.agent.ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (bindings.get(agent) !== rootBinding || signal.aborted) throw runtimeError('CANCELLED', '协作根执行已停止')
      try { await authorize(rootBinding, { reserveRequest: true }) }
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
    const projection = await summaryProjection(rootBinding)
    rootHandle.agent.ctx.tools.restrict({ allow: [COLLABORATION_TOOLS.summarize] })
    rootHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `SCENARIO:root-summary Review only this persisted child result and handoff projection, call ${COLLABORATION_TOOLS.summarize} once with the exact resultRefs, then provide a concise factual summary: ${JSON.stringify(projection)}` }],
      source: { kind: 'user' },
    }))
    await untilAbort(rootHandle.agent.whenIdle(), rootSignal)
    const rootRequestFailure = requestFailures.get(rootHandle.agent)
    if (rootRequestFailure) throw rootRequestFailure
    const submittedRefs = summarySubmissions.get(rootHandle.agent)
    if (!isDeepStrictEqual(submittedRefs, projection.resultRefs)) throw runtimeError('TOOL_CHAIN_INVALID', '负责人未提交当前持久结果引用')
    const explanation = lastAssistantText(rootHandle.agent.session.snapshotEvents())
    if (!explanation) throw runtimeError('TOOL_CHAIN_INVALID', '负责人未生成后置事实汇总')
    return finishRoot(rootBinding, rootHandle.agent.id, explanation, rootHandle.agent.session.snapshotEvents(), submittedRefs)
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
    const signal = AbortSignal.any([rootSignal, AbortSignal.timeout(rootSnapshot.collaboration.childTimeoutMs)])
    let run
    try {
      run = await ctx.subagents.start('spawn', {
        label: item.id,
        prompt: [{ type: 'text', text: childPrompt(child, capability.toolName) }],
        parent: [...entry.handles][0].agent,
        signal,
        agentOptions,
        outputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', const: 'done' }, explanation: { type: 'string' } }, required: ['status', 'explanation'] },
        maxDepth: 1,
        toolFilter: { allow: [capability.toolName] },
        persona: `You are ${child.employeeId}. Complete only the registered child work and use the only visible business tool once.`,
      })
      entry.runs.add(run)
      const connection = child.connectionId ? state.connections.find(candidate => candidate.id === child.connectionId) : null
      const binding = Object.freeze({
        kind: 'child', rootWorkId: rootSnapshot.id, workId: child.id, executionId: execution.id,
        employeeId: child.employeeId, generation, planRevision: currentRoot.plan.revision,
        cancelGeneration: rootSnapshot.collaboration.cancelGeneration,
        allowedTools: Object.freeze([capability.toolName]), capabilityId: child.capabilityId,
        toolName: capability.toolName, input: structuredClone(child.input), connectionId: child.connectionId ?? null,
        connection: connection ? Object.freeze(connectionSnapshot(connection)) : null,
      })
      const gate = gates.get(run.id)
      if (!gate || gate.agent !== run.localAgent || !ctx.agents.isOwnedBy(run.id, [...entry.handles][0].agent)) throw runtimeError('FORBIDDEN', '原生子 Agent 身份无法绑定')
      bindings.set(run.localAgent, binding)
      await bindSession(binding, run.id, 'running')
      gate.gate.resolve({ ok: true })
      const result = await run.result
      const events = run.localAgent.session.snapshotEvents()
      const requestFailure = requestFailures.get(run.localAgent)
      if (requestFailure) throw requestFailure
      if (signal.aborted && signal.reason?.name === 'TimeoutError') throw runtimeError('UPSTREAM_TIMEOUT', '协作子工作超时')
      const failure = toolFailure(events)
      if (failure) throw runtimeError(failure.code, failure.message)
      if (result.stopReason !== 'completed') throw runtimeError('UPSTREAM_ERROR', '子工作模型执行未完成')
      const parsed = parseRunResult({ ...result, finalResponse: result.structured?.explanation, events: businessEvents(events), sessionId: run.id }, { capabilityId: child.capabilityId, input: child.input })
      await finishChild(binding, parsed, events)
      return true
    } catch (error) {
      const gate = run && gates.get(run.id)
      if (gate && !gate.gate.settled()) gate.gate.resolve({ ok: false, error })
      await failChild(child.id, execution.id, generation, error)
      throw error
    } finally {
      if (run) {
        entry.runs.delete(run)
        await run.dispose().catch(() => undefined)
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
    if (!binding) throw runtimeError('FORBIDDEN', 'Agent identity 未绑定')
    let context
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === binding.rootWorkId && work.collaboration)
      const work = state.works.find(candidate => candidate.id === binding.workId)
      const execution = work?.executions.find(candidate => candidate.id === binding.executionId)
      const member = state.members.find(candidate => candidate.id === rootWork?.ownerMemberId && candidate.enabled === true)
      const employee = state.employees.find(candidate => candidate.id === binding.employeeId && candidate.enabled === true)
      const skill = state.skills.find(candidate => candidate.id === work?.skillId && candidate.enabled === true)
      const route = state.modelRoutes.find(candidate => candidate.id === employee?.modelRouteId && candidate.enabled === true)
      if (!rootWork || !member || !member.employeeIds.includes(employee?.id) || !employee?.skillIds?.includes(skill?.id) || !route || route.provider !== 'zenmux' || route.model !== 'deepseek/deepseek-v4-pro' || route.credentialRef !== 'ZENMUX_API_KEY') throw runtimeError('FORBIDDEN', '当前成员、员工或模型路由授权已撤销')
      if (rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running') throw runtimeError('CANCELLED', '协作 generation 已关闭')
      if (!execution || execution.generation !== binding.generation || execution.cancelGeneration !== binding.cancelGeneration || !ACTIVE.has(execution.status)) throw runtimeError('CANCELLED', '当前执行已关闭')
      let connection = null
      const capability = getCapability(work.capabilityId)
      if (!capability || skill.capabilityId !== capability.id) throw runtimeError('FORBIDDEN', '当前 Skill 授权已撤销')
      if (binding.kind === 'child') {
        const item = rootWork.plan.items.find(candidate => candidate.childWorkId === work.id)
        if (!item || item.employeeId !== binding.employeeId || item.status !== 'running') throw runtimeError('FORBIDDEN', '当前计划项授权已失效')
      }
      if (capability.requiresConnection && binding.kind === 'child') {
        connection = state.connections.find(candidate => candidate.id === work.connectionId && candidate.enabled === true && candidate.status === 'ready')
        if (!connection || !employee.connectionIds?.includes(connection.id) || !connection.skillIds?.includes(skill.id) || !connection.allowedObjectIds?.includes(work.input.workOrderId) || !isDeepStrictEqual(connectionSnapshot(connection), binding.connection)) throw runtimeError('FORBIDDEN', '当前连接 revision、目标或业务对象授权已撤销')
      }
      if (reserveRequest) {
        if (rootWork.collaboration.requestCount >= rootWork.collaboration.requestLimit) throw runtimeError('BUDGET_EXHAUSTED', '协作模型请求预算已耗尽')
        rootWork.collaboration = { ...rootWork.collaboration, requestCount: rootWork.collaboration.requestCount + 1 }
        return { ...state, works: state.works.map(candidate => candidate.id === rootWork.id ? rootWork : candidate) }
      }
      context = { rootWork, work, execution, member, employee, skill, route, connection }
      return state
    })
    return context
  }

  async function startRoot(rootWorkId, generation) {
    let snapshot
    await store.update(state => {
      const work = state.works.find(candidate => candidate.id === rootWorkId && candidate.collaboration)
      if (!work || work.collaboration.generation !== generation || work.collaboration.status !== 'accepted') throw runtimeError('BUSY', '协作工作不可启动')
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

  async function finishChild(binding, parsed, events) {
    const now = clock()
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === binding.rootWorkId)
      const child = state.works.find(work => work.id === binding.workId)
      const execution = child?.executions.find(candidate => candidate.id === binding.executionId)
      if (!rootWork || rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running' || !execution || execution.status !== 'running') return state
      const resultId = `result-${randomUUID()}`
      const result = collaborationResult(resultId, child, parsed, execution.dshSessionRef, usageFromEvents(events), now, binding.generation)
      const handoff = { id: `handoff-${randomUUID()}`, childWorkId: child.id, fromEmployeeId: child.employeeId, toEmployeeId: rootWork.employeeId, resultRefs: [resultId], knowledgeRefs: result.knowledgeDependencyRefs ?? [], revision: 1, generation: binding.generation, status: 'current', createdAt: now }
      result.handoffRefs = [handoff.id]
      const nextChild = { ...child, status: 'completed', results: [...child.results, result], executions: child.executions.map(candidate => candidate.id === execution.id ? { ...candidate, status: 'completed', completedAt: now, resultId, usage: result.usage } : candidate) }
      const handoffs = rootWork.handoffs.map(item => item.childWorkId === child.id && item.status === 'current' ? { ...item, status: 'superseded' } : item)
      const nextRoot = { ...rootWork, handoffs: [...handoffs, handoff], plan: { ...rootWork.plan, items: rootWork.plan.items.map(item => item.childWorkId === child.id ? { ...item, status: 'completed' } : item) } }
      return { ...state, works: state.works.map(work => work.id === child.id ? nextChild : work.id === rootWork.id ? nextRoot : work) }
    })
  }

  async function finishRoot(binding, sessionId, explanation, events, submittedRefs) {
    let result
    await store.update(state => {
      const rootWork = state.works.find(work => work.id === binding.rootWorkId)
      const execution = rootWork?.executions.find(candidate => candidate.id === binding.executionId)
      if (!rootWork || rootWork.collaboration.generation !== binding.generation || rootWork.collaboration.cancelGeneration !== binding.cancelGeneration || rootWork.collaboration.status !== 'running' || execution?.status !== 'running') return state
      const currentHandoffs = rootWork.plan.items.map(item => rootWork.handoffs.find(handoff => handoff.childWorkId === item.childWorkId && handoff.status === 'current'))
      if (currentHandoffs.some(item => !item)) throw runtimeError('TOOL_CHAIN_INVALID', '协作汇总缺少当前交接')
      const refs = currentHandoffs.flatMap(handoff => handoff.resultRefs)
      if (!isDeepStrictEqual(refs, submittedRefs) || refs.some(ref => !state.works.some(work => work.results.some(item => item.id === ref && item.generation <= binding.generation)))) throw runtimeError('TOOL_CHAIN_INVALID', '协作汇总只能引用当前持久化子结果')
      result = { id: `summary-${randomUUID()}`, kind: 'assistant.collaboration-summary', capabilityId: rootWork.capabilityId, skillId: rootWork.skillId, schemaVersion: 1, input: {}, payload: { resultRefs: refs }, explanation, createdAt: clock(), dshSessionRef: sessionId, contextConfirmationRefs: [], employeeId: rootWork.employeeId, handoffRefs: currentHandoffs.map(item => item.id), usage: usageFromEvents(events), generation: binding.generation }
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
    const rootWork = state.works.find(work => work.id === binding.rootWorkId)
    const entries = rootWork.plan.items.map(item => {
      const handoff = rootWork.handoffs.find(candidate => candidate.childWorkId === item.childWorkId && candidate.status === 'current')
      const child = state.works.find(work => work.id === item.childWorkId)
      const result = handoff && child.results.find(candidate => candidate.id === handoff.resultRefs[0])
      if (!handoff || !result) throw runtimeError('TOOL_CHAIN_INVALID', '后置汇总投影缺少当前持久结果')
      return { itemId: item.id, employeeId: child.employeeId, resultId: result.id, handoffId: handoff.id, kind: result.kind, payload: result.payload, source: result.source }
    })
    return { rootWorkId: rootWork.id, generation: binding.generation, resultRefs: entries.map(item => item.resultId), entries }
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

function collaborationResult(id, work, parsed, sessionId, usage, now, generation) {
  const base = parsed.result
  return {
    id, kind: base.kind, capabilityId: work.capabilityId, skillId: work.skillId, schemaVersion: 1,
    input: structuredClone(work.input), payload: base.payload, explanation: parsed.explanation, source: base.source,
    createdAt: now, toolName: base.toolName, pluginId: base.pluginId, pluginVersion: base.pluginVersion,
    dshSessionRef: sessionId, contextConfirmationRefs: [], employeeId: work.employeeId, handoffRefs: [], usage,
    knowledgeDependencyRefs: [], generation,
  }
}

function childPrompt(work, toolName) {
  return `SCENARIO:${work.planItemId} Complete this registered work: ${work.goal}. Call ${toolName} exactly once with ${JSON.stringify(work.input)}. Then call structured_output with {"status":"done","explanation":"your concise factual explanation"}.`
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
  const structuredCalls = new Set(events.filter(event => event.type === 'tool/call' && event.data?.name === 'structured_output').map(event => event.data.callId))
  return events.filter(event => !(event.type === 'tool/call' && structuredCalls.has(event.data?.callId)) && !(event.type === 'tool/result' && structuredCalls.has(event.data?.message?.source?.callId)))
}
function toolFailure(events) {
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data?.message?.content?.find(item => item.type === 'tool-result')?.content?.find(item => item.type === 'text')
    try {
      const value = JSON.parse(block?.text)
      if (value?.ok === false && ['BUDGET_EXHAUSTED', 'FORBIDDEN', 'CANCELLED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR'].includes(value.error?.code)) return value.error
    } catch {}
  }
  return undefined
}
function unknownUsage() { return Object.fromEntries(USAGE_KEYS.map(key => [key, null])) }
function lastAssistantText(events) {
  for (const event of [...events].reverse()) if (event.type === 'assistant/message') {
    const text = event.data.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').trim()
    if (text) return text
  }
  return undefined
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
function safeRuntimeCause(error) {
  if (error?.code === 'BUDGET_EXHAUSTED') return { code: 'BUDGET_EXHAUSTED', message: '协作模型请求预算已耗尽' }
  if (error?.code === 'FORBIDDEN') return { code: 'FORBIDDEN', message: '当前执行授权已失效' }
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') return { code: 'CANCELLED', message: '本次执行已停止' }
  if (error?.code === 'UPSTREAM_TIMEOUT' || error?.name === 'TimeoutError') return { code: 'UPSTREAM_TIMEOUT', message: '协作执行超时' }
  return { code: 'UPSTREAM_ERROR', message: '协作执行失败' }
}
