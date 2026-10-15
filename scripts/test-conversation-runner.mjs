import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

const home = await mkdtemp(join(tmpdir(), 'geneway-conversation-runner-')), previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
try {
  const failed = fixture()
  const commitFailure = new Error('synthetic onSession persistence failure')
  await assert.rejects(failed.runner.runChatTurn(options('failed', 'one', { onSession: async () => { throw commitFailure } })), error => error === commitFailure)
  assert.equal(failed.followups, 0, 'a failed native binding must never reach followup')
  assert.equal(failed.disposals, 1)
  assert.deepEqual(failed.scopes[0], [])
  assert.equal(failed.prompts[0].interpolate, false)
  assert.equal(failed.prompts[0].complete, true)
  assert(failed.prompts[0].text.includes('FROZEN_INSTRUCTIONS'))
  await failed.runner.close()

  const rejected = fixture()
  await assert.rejects(rejected.runner.runChatTurn(options('forbidden', 'one', { authorize: async () => { throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }) } })), { code: 'FORBIDDEN' })
  assert.equal(rejected.boots, 0)
  await rejected.runner.close()

  const exact = fixture({ held: true })
  const first = exact.runner.runChatTurn(options('conversation-a', 'old'))
  const independent = exact.runner.runChatTurn(options('conversation-b', 'one'))
  await waitFor(() => exact.followups === 2)
  assert.equal(await exact.runner.cancelChatTurn('conversation-a', 'different'), false)
  assert.equal(exact.cancellations, 0)
  assert.equal(await exact.runner.cancelChatTurn('conversation-a', 'old'), true)
  assert.equal((await first).stopReason, 'aborted')
  assert.equal(exact.handles[1].idle, false)
  const later = exact.runner.runChatTurn(options('conversation-a', 'new'))
  await waitFor(() => exact.followups === 3)
  assert.equal(await exact.runner.cancelChatTurn('conversation-a', 'old'), false)
  assert.equal(exact.handles[2].idle, false)
  exact.handles[1].finish()
  exact.handles[2].finish()
  assert.equal((await independent).stopReason, 'completed')
  assert.equal((await later).stopReason, 'completed')
  assert.equal(exact.boots, 1)
  await exact.runner.close()
  assert.equal(exact.shutdowns, 1)

  const pending = fixture({ holdCreate: true })
  const creating = pending.runner.runChatTurn(options('creating', 'one'))
  await waitFor(() => pending.handles.length === 1)
  const cancelling = pending.runner.cancelChatTurn('creating', 'one')
  pending.releaseCreate()
  await assert.rejects(creating, { code: 'CANCELLED' })
  assert.equal(await cancelling, true)
  assert.equal(pending.followups, 0)
  assert.equal(pending.disposals, 1)
  await pending.runner.close()

  const history = fixture()
  const native = await history.runner.runChatTurn(options('history', 'one'))
  const decoded = await history.runner.readChatHistory([native.sessionId, 'missing-native', native.sessionId])
  assert.equal(decoded.length, 2)
  assert.equal(decoded[0].status, 'available')
  assert.equal(decoded[0].events.at(-1).type, 'turn/end')
  assert.equal(decoded[1].status, 'unavailable')
  assert.deepEqual(history.opened, [native.sessionId, 'missing-native'])
  assert.equal(history.readCloses, 1)
  const resumed = await history.runner.runChatTurn(options('history', 'two', { sessionId: native.sessionId }))
  assert.equal(resumed.sessionId, native.sessionId)
  assert.equal(history.cancellations, 1, 'resuming must discard a prior pending inbox before accepting current input')
  await history.runner.close()

  const toolViolation = fixture({ unexpectedTool: true })
  await assert.rejects(toolViolation.runner.runChatTurn(options('tool', 'one')), { code: 'TOOL_CHAIN_INVALID' })
  assert.equal(toolViolation.disposals, 1)
  await toolViolation.runner.close()
  const empty = fixture({ emptyReply: true })
  await assert.rejects(empty.runner.runChatTurn(options('empty', 'one')), { code: 'UPSTREAM_ERROR' })
  assert.equal(empty.disposals, 1)
  const store = createFileStore(join(home, 'state.json')), actor = { id: 'member' }
  await store.update(state => ({ ...state,
    members: [{ id: actor.id, loginName: actor.id, displayName: actor.id, role: 'member', enabled: true, authRef: actor.id, sessionVersion: 1, employeeIds: ['agent'] }],
    employees: [{ id: 'agent', name: 'Agent', enabled: true, modelRouteId: 'model', revision: 1, instructions: '', skillIds: [], connectionIds: [] }],
    modelRoutes: [{ ...readRuntimeConfig({}).model, id: 'model', enabled: true }],
  }))
  const service = createConversationService({ store, runner: empty.runner })
  const conversation = await service.createConversation(actor, { employeeId: 'agent' })
  const admitted = await service.sendTurn(actor, conversation.id, { text: 'empty native reply', clientRequestId: 'one' })
  let persisted
  await waitFor(async () => { persisted = (await store.read()).conversations[0].turns[0]; return persisted.status === 'failed' })
  assert.equal(persisted.id, admitted.turn.id)
  assert.equal(persisted.error.code, 'UPSTREAM_ERROR')
  assert(persisted.completedAt)
  assert.equal((await service.getConversation(actor, conversation.id)).activeTurnId, null)
  await service.close()
  await empty.runner.close()
  console.log('Conversation runner checks passed: binding failure precedes followup/dispose, deny-all tools, precise cancellation, pending creation cancellation, shared Host, native decoder/history and resume inbox discard (injected runtime; native/model/network starts=0)')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}

function options(conversationId, turnId, overrides = {}) { return { conversationId, turnId, sessionId: null, text: 'SYNTHETIC_INPUT', instructions: 'FROZEN_INSTRUCTIONS', authorize: async () => undefined, onSession: async () => undefined, ...overrides } }
function fixture({ held = false, holdCreate = false, unexpectedTool = false, emptyReply = false } = {}) {
  const sessions = new Map(), handles = [], scopes = [], prompts = [], opened = []
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const state = { handles, scopes, prompts, opened, releaseCreate, boots: 0, followups: 0, disposals: 0, cancellations: 0, shutdowns: 0, readCloses: 0 }
  async function handle(options) {
    const id = options.resumeSessionId ?? options.sessionId, events = sessions.get(id) ?? []
    sessions.set(id, events)
    const agentCtx = { tools: { restrict(scope) { scopes.push(scope.allow) }, guard() {} }, systemPrompt: { section(value) { prompts.push(value) } }, on() {} }
    let releaseIdle, idlePromise = Promise.resolve(), pending = false
    const value = { idle: true, finish(reason = 'completed') {
      if (!pending) return
      if (reason === 'completed' && !emptyReply) events.push({ type: 'assistant/message', data: { turn: 1, message: { id: `assistant-${state.followups}`, content: [{ type: 'text', text: 'SYNTHETIC_REPLY' }] } } })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: reason } } })
      pending = false; value.idle = true; releaseIdle()
    } }
    const agent = { id, ctx: agentCtx, session: { header: { origin: 'root' }, snapshotEvents: () => events },
      followup(message) {
        state.followups += 1; pending = true; value.idle = false
        idlePromise = new Promise(resolve => { releaseIdle = resolve })
        events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: message })
        if (unexpectedTool) events.push({ type: 'tool/call', data: { name: 'forbidden' } })
        if (!held) value.finish()
      },
      whenIdle: () => idlePromise,
      cancel() { state.cancellations += 1; value.finish('aborted') },
    }
    value.agent = agent
    value.dispose = async () => { state.disposals += 1 }
    options.setup(agentCtx, agent)
    handles.push(value)
    if (holdCreate) await createGate
    return value
  }
  const ctx = {
    on() {}, tools: { register() {}, guard() {}, schemas: () => [] }, plugin: () => ({ async dispose() {} }),
    agents: { create: handle, resume: handle },
    sessionPersistence: { async flush() {}, async open(id, mode) {
      assert.equal(mode, 'read'); opened.push(id)
      if (!sessions.has(id)) throw new Error('missing native history')
      return { async read() { return { events: sessions.get(id) } }, async close() { state.readCloses += 1 } }
    } },
  }
  state.runner = createCollaborationRunner({ store: {}, dshHome: home, runProfileImpl: async () => { state.boots += 1; return { ctx, shutdown: { async shutdown() { state.shutdowns += 1 } } } } })
  return state
}
async function waitFor(check) { for (let count = 0; count < 200; count += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('injected conversation runner condition timed out') }
