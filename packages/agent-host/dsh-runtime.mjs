import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AgentDelivery } from './delivery.mjs'
import { error } from '../agent-contracts/index.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { freezeMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const { SessionPersistenceNotFoundError } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence')).href)

// The official embedded Agent API accepts stable UserMessage IDs; SDK prompt does not.
export function createDshRuntime({ boot, authorize, optionsFor, workspaceRoot, contentFor, toolsFor, confirmPark, reportEnabled = true, systemPrompt, operationsGuide }) {
  let context, delivery, starting, reporter
  const parked = new Set()
  const loaded = new Map(), refreshers = new Map()
  async function ready() {
    if (!starting) starting = Promise.resolve().then(boot).then(value => { context = value; delivery = new AgentDelivery(value.ctx, freezeMessage); return value })
    return starting
  }
  async function start(execution, { budgetResumeCommandId, intentReviewCommandId } = {}) {
    await authorize(execution, intentReviewCommandId ? { intentReviewCommandId } : budgetResumeCommandId ? { budgetResumeCommandId } : {})
    if (loaded.has(execution.session_id)) { refreshers.get(execution.session_id)?.(); return execution.session_id }
    const { ctx } = await ready(), selectedOptions = await optionsFor(execution)
    const setup = (agentCtx, agent) => {
      agentCtx.tools.restrict({ allow: [] })
      const registered = new Set(reportEnabled ? ['geneway_multisite_report'] : [])
      agentCtx.tools.guard(call => registered.has(call.name) ? undefined : 'Tool is outside this Agent scope')
      const refresh = () => { for (const tool of toolsFor?.(execution) ?? []) if (!registered.has(tool.name)) { agentCtx.tools.register(tool); registered.add(tool.name) } }
      refreshers.set(execution.session_id, refresh); refresh()
      if (reportEnabled) agentCtx.tools.register(defineTool({ name: 'geneway_multisite_report', description: 'Report current progress or ask the user a specific question. Ready is only a candidate, never business completion.',
        parameters: { state: { type: 'string', enum: ['waiting', 'ready', 'blocked', 'failed'], required: true }, summary: { type: 'string', required: true }, question: { type: 'string' } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, invocation) {
          if (invocation.agent !== agent) throw error('FORBIDDEN')
          await authorize(execution)
          await reporter(execution.launch_id, args)
          return { accepted: true }
        },
      }))
      const prompt = systemPrompt ?? '你是受授权的 Geneway 协作 Agent。处理当前工作与用户补充；需要资料时调用 geneway_multisite_report 提交 waiting 和具体 question。已形成结果可提交 ready 候选，但不能宣称文件或外部动作已完成。仅使用已注册工具。'
      agentCtx.systemPrompt.section({ name: 'geneway-multisite', order: 0, complete: true, interpolate: false,
        text: operationsGuide === undefined ? prompt : `${prompt}\n\n${operationsGuide}` })
      agentCtx.on('agent/pre-step', async (payload, next) => {
        if (confirmPark && await confirmPark(execution, { manualOnly: true })) parked.add(execution.session_id)
        if (!parked.has(execution.session_id)) return next()
        if (confirmPark && !await confirmPark(execution)) throw error('REVISION_CONFLICT', '等待许可缺失')
        // pre-step has already claimed messages; preserve their original IDs without waking.
        for (const message of [...payload.messages].reverse()) agent.inbox.prepend('next-turn', message)
        await ctx.sessionPersistence.flush()
        return { kind: 'reject' }
      })
      agentCtx.on('agent/request', async (request, next) => {
        if (request.agent !== agent) throw error('FORBIDDEN', '模型请求与执行 Agent 不匹配')
        request.signal?.throwIfAborted()
        await authorize(execution, { signal: request.signal, phase: 'request_metadata' })
        request.signal?.throwIfAborted()
        const resolved = await next()
        if (['provider', 'model', 'maxTokens'].some(field => resolved[field] !== selectedOptions[field])) throw error('MODEL_NOT_CONFIGURED')
        return resolved
      })
    }
    // Never catch resume failure and create a new context: unknown history requires calibration.
    let handle, exists = true
    try {
      const history = await ctx.sessionPersistence.open(execution.session_id, 'read')
      await history.close()
    } catch (cause) {
      if (!(cause instanceof SessionPersistenceNotFoundError) || cause.sessionId !== execution.session_id) throw cause
      exists = false
    }
    if (!exists && execution.runtimeStarted) throw error('HISTORY_UNAVAILABLE', '已消费执行的历史缺失，不能创建替代会话')
    handle = exists ? await ctx.agents.resume({ resumeSessionId: execution.session_id, agentOptions: selectedOptions, setup })
      : await ctx.agents.create({ sessionId: execution.session_id, meta: { cwd: workspaceRoot }, agentOptions: selectedOptions, setup })
    loaded.set(execution.session_id, handle)
    await ctx.sessionPersistence.flush()
    return handle.agent.id
  }
  return {
    supportsAttachments: typeof contentFor === 'function',
    setReporter(value) { reporter = value },
    park(execution) { parked.add(execution.session_id) },
    async inspectState(execution) {
      const handle = loaded.get(execution.session_id)
      if (!handle) throw error('HISTORY_UNAVAILABLE')
      if (handle.agent.status !== 'idle') return { idle: false }
      await handle.agent.whenIdle(); await context.ctx.sessionPersistence.flush()
      return { idle: handle.agent.status === 'idle' }
    },
    start,
    async deliver(execution, input) {
      await start(execution, { budgetResumeCommandId: input.budgetResumeCommandId, intentReviewCommandId: input.intentReviewCommandId })
      if (confirmPark && await confirmPark(execution, { manualOnly: true })) throw error('MANUALLY_PAUSED')
      parked.delete(execution.session_id)
      const agent = loaded.get(execution.session_id).agent
      const held = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message => message.id === input.id)
      if (agent.status === 'idle' && held && agent.inbox.remove(input.id)) {
        agent.followup(held)
        const [fact] = await delivery.inspectInputs(agent, [input.id])
        return { delivered: true, ingested: fact.ingested }
      }
      return delivery.send(loaded.get(execution.session_id).agent, input.id, input.text, input.budgetResumeCommandId || input.intentReviewCommandId ? async () => {} : () => authorize(execution), contentFor ? () => contentFor(context.ctx, execution, input) : undefined, input.sourceKind)
    },
    async inspectInputs(execution, ids) {
      const handle = loaded.get(execution.session_id)
      if (!handle || handle.agent.id !== execution.session_id) throw error('HISTORY_UNAVAILABLE')
      return delivery.inspectInputs(handle.agent, ids)
    },
    async stop(execution) {
      // Cancellation is authorized by the persisted command, even after ordinary run permission is revoked.
      if (!loaded.has(execution.session_id)) {
        const { ctx } = await ready()
        let handle
        try { handle = await ctx.agents.resume({ resumeSessionId: execution.session_id, setup(agentCtx) { agentCtx.tools.restrict({ allow: [] }); agentCtx.on('agent/request', () => { throw error('CANCELLED') }) } }) }
        catch (cause) { if (cause instanceof SessionPersistenceNotFoundError && cause.sessionId === execution.session_id) return { evidence: 'never_started' }; throw cause }
        loaded.set(execution.session_id, handle)
      }
      const agent = loaded.get(execution.session_id).agent
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      await context.ctx.sessionPersistence.flush()
      return { evidence: 'idle_after_cancel' }
    },
    async close() {
      // API shutdown is not a remote manual-stop fact. Preserve queued inputs when stopping this local runtime.
      for (const handle of loaded.values()) handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.all([...loaded.values()].map(handle => handle.agent.whenIdle()))
      if (context) { await context.ctx.sessionPersistence.flush(); await context.shutdown.shutdown(0) }
    },
  }
}
