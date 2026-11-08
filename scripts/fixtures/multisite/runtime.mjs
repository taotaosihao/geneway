import { continuationBlock } from '../../../packages/agent-host/input-context.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { AgentDelivery } from '../../../packages/agent-host/delivery.mjs'

// Approved local simulator: user/message is produced only when the inbox is consumed.
// Tests never seed cloud receipts or delivered/ingested records by hand.
export function createSimulatedRuntime({ path, consume = true, controls = {} }) {
  const listeners = new Map(), agents = new Map()
  let state, starts = 0, resumes = 0, report, spreadsheetHandler, orchestrationHandler, evidenceHandler
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    agents: { get: id => agents.get(id) },
    sessionPersistence: {
      async flush() { if (controls.failFlush) throw new Error('synthetic flush'); await writeFile(path, JSON.stringify(state)) },
      async open(id) {
        if (controls.failHistory) throw new Error('synthetic history unavailable')
        if (!state[id]) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        return { async read(offset = 0, limit = 512) { return { events: state[id].events.slice(offset, offset + limit) } }, async close() {} }
      },
    },
  }
  const delivery = new AgentDelivery(ctx)
  async function start(binding) {
    if (!state) { try { state = JSON.parse(await readFile(path, 'utf8')) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; state = {} } }
    if (agents.has(binding.session_id)) return binding.session_id
    if (state[binding.session_id]) resumes++
    if (!state[binding.session_id]) { starts++; state[binding.session_id] = { events: [], nextTurn: [], nextStep: [] } }
    const record = state[binding.session_id]
    const session = { snapshotEvents: () => record.events }
    const agent = { id: binding.session_id, session, inbox: record,
      followup(message) { record.nextTurn.push(message); if (consume) this.consume() },
      consume() { for (const message of record.nextTurn.splice(0)) { const event = { type: 'user/message', data: message }; record.events.push(event); listeners.get('session/event')?.(session, event) } },
    }
    agents.set(agent.id, agent)
    return agent.id
  }
  return {
    setOrchestrationHandler(value) { orchestrationHandler = value },
    setEvidenceHandler(value) { evidenceHandler = value },
    evidence: (execution, operation, parameters) => evidenceHandler(execution, operation, parameters),
    orchestration: (execution, operation, parameters) => orchestrationHandler(execution, operation, parameters),
    async inspectState() { return { idle: true } },
    setReporter(value) { report = value },
    setSpreadsheetHandler(value) { spreadsheetHandler = value },
    spreadsheet: (execution, operation, parameters) => spreadsheetHandler(execution, operation, parameters),
    start,
    async deliver(binding, input) { await start(binding); return delivery.send(agents.get(binding.session_id), input.id, input.text, undefined, async () => [{ type: 'text', text: input.text }, ...(input.intentFence ? [{type:'text',text:JSON.stringify({intentFence:input.intentFence,sourceEvent:input.sourceEvent,intentAnswer:input.intentAnswer})}] : []), ...(input.continuationContext ? [continuationBlock(input.continuationContext)] : []), ...(input.messages ? [{ type: 'text', text: `Agent来源消息（不是用户修订）：${JSON.stringify(input.messages)}` }] : [])], input.sourceKind) },
    async inspectInputs(binding, ids) {
      const agent = agents.get(binding.session_id)
      if (!agent) throw new Error('session not loaded')
      return delivery.inspectInputs(agent, ids)
    },
    async stop(binding) {
      if (!state) { try { state = JSON.parse(await readFile(path, 'utf8')) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; state = {} } }
      if (!state[binding.session_id]) return { evidence: 'never_started' }
      state[binding.session_id].nextTurn = []; await ctx.sessionPersistence.flush(); return { evidence: 'idle_after_cancel' }
    },
    async consumeAll() { for (const agent of agents.values()) agent.consume(); await ctx.sessionPersistence.flush() },
    report: (launchId, value) => report(launchId, value),
    starts: () => starts, resumes: () => resumes,
    messageCount: () => Object.values(state ?? {}).reduce((sum, session) => sum + session.events.length + session.nextTurn.length, 0),
    async close() {},
  }
}

export function seedMultisite(state) {
  state.members = [
    { id: 'owner', loginName: 'owner', authRef: 'owner', displayName: '模拟业务成员', enabled: true, role: 'admin', sessionVersion: 1, employeeIds: ['coordinator', 'worker'] },
    { id: 'peer', loginName: 'peer', authRef: 'peer', displayName: '其他成员', enabled: true, role: 'member', sessionVersion: 1, employeeIds: ['worker'] },
  ]
  state.modelRoutes = [{ id: 'route', enabled: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', parameters: { maxOutputTokens: 4096 } }]
  state.employees = ['coordinator', 'worker'].map(id => ({ id, name: id, enabled: true, revision: 1, instructions: '', modelRouteId: 'route', connectionIds: [], skillIds: [],
    placement: { nodeId: 'local', mode: 'agent_host', resourceRefs: ['fixture:incident'] } }))
  return state
}
