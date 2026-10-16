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

  const disposeFailure = fixture({ disposeError: new Error('synthetic dispose failure') })
  await assert.rejects(disposeFailure.runner.runChatTurn(options('dispose-failed', 'one')), error => error.closeFailed === true)
  await assert.rejects(disposeFailure.runner.runChatTurn(options('dispose-failed', 'two')), { code: 'BUSY' })
  await assert.rejects(disposeFailure.runner.cancelChatTurn('dispose-failed', 'one'), error => error.closeFailed === true)
  await disposeFailure.runner.close()
  assert.equal(disposeFailure.shutdowns, 1, 'Host shutdown retains ownership after a failed handle dispose')

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
  const bootPending = fixture({ holdBoot: true })
  const bootTurn = bootPending.runner.runChatTurn(options('late-boot', 'one'))
  void bootTurn.catch(() => undefined)
  const bootHistory = bootPending.runner.readChatHistory(['late-native'])
  const bootKnowledge = bootPending.runner.enableKnowledge()
  void bootKnowledge.catch(() => undefined)
  await waitFor(() => bootPending.boots === 1)
  const bootClose = bootPending.runner.close()
  assert.equal(bootPending.runner.close(), bootClose)
  let bootClosed = false
  void bootClose.then(() => { bootClosed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bootClosed, false)
  bootPending.releaseBoot()
  await assert.rejects(bootTurn, { code: 'PROCESS_SHUTDOWN' })
  await assert.rejects(bootKnowledge, { code: 'PROCESS_SHUTDOWN' })
  assert.equal((await bootHistory)[0].status, 'unavailable')
  await bootClose
  assert.equal(bootPending.boots, 1); assert.equal(bootPending.shutdowns, 1)
  assert.equal(bootPending.pluginCalls, 0); assert.equal(bootPending.handles.length, 0); assert.equal(bootPending.opened.length, 0)

  const installPending = fixture({ holdInstall: true })
  const installing = installPending.runner.enableKnowledge()
  void installing.catch(() => undefined)
  await waitFor(() => installPending.installHooks === 1)
  const installClose = installPending.runner.close()
  installPending.releaseInstall()
  await assert.rejects(installing, { code: 'PROCESS_SHUTDOWN' })
  await installClose
  assert.equal(installPending.toolRegistrations, 0); assert.equal(installPending.pluginCalls, 1); assert.equal(installPending.shutdowns, 1)

  for (const phase of ['bootError', 'installError']) {
    const original = new Error(`synthetic ${phase}`), failed = fixture({ [phase]: original })
    await assert.rejects(failed.runner.enableKnowledge(), error => error === original)
    await failed.runner.close()
    assert.equal(failed.shutdowns, phase === 'bootError' ? 0 : 1)
  }
  const originalInstall = new Error('synthetic install failure'), originalCleanup = new Error('synthetic Host cleanup failure')
  const failedCleanup = fixture({ installError: originalInstall, shutdownError: originalCleanup })
  await assert.rejects(failedCleanup.runner.enableKnowledge(), error => error instanceof AggregateError && error.cause === originalInstall && error.errors[0] === originalInstall && error.errors[1] === originalCleanup)
  await assert.rejects(failedCleanup.runner.close(), error => error === originalCleanup)
  assert.equal(failedCleanup.shutdowns, 1)

  const publication = fixture({ closeAtPublication: true })
  assert.equal((await publication.runner.readChatHistory(['never-open-after-close']))[0].status, 'unavailable')
  await publication.runner.close()
  assert.equal(publication.opened.length, 0); assert.equal(publication.shutdowns, 1)

  const closing = fixture({ holdShutdown: true })
  await closing.runner.runChatTurn(options('close-once', 'one'))
  const firstClose = closing.runner.close()
  assert.equal(closing.runner.close(), firstClose)
  await waitFor(() => closing.shutdowns === 1)
  await assert.rejects(closing.runner.runChatTurn(options('closed', 'one')), { code: 'PROCESS_SHUTDOWN' })
  closing.releaseShutdown(); await firstClose
  assert.equal(closing.shutdowns, 1)
  console.log('Conversation runner checks passed: binding failure precedes followup/dispose, deny-all tools, precise cancellation, pending creation cancellation, shared Host, native decoder/history and resume inbox discard (injected runtime; native/model/network starts=0)')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}

function options(conversationId, turnId, overrides = {}) { return { conversationId, turnId, sessionId: null, text: 'SYNTHETIC_INPUT', instructions: 'FROZEN_INSTRUCTIONS', authorize: async () => undefined, onSession: async () => undefined, ...overrides } }
function fixture({ held = false, holdCreate = false, unexpectedTool = false, emptyReply = false, holdBoot = false, holdInstall = false, holdShutdown = false, closeAtPublication = false, bootError, installError, shutdownError, disposeError } = {}) {
  const sessions = new Map(), handles = [], scopes = [], prompts = [], opened = []
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const state = { handles, scopes, prompts, opened, releaseCreate, boots: 0, followups: 0, disposals: 0, cancellations: 0, shutdowns: 0, readCloses: 0 }
  const bootGate = new Promise(resolve => { state.releaseBoot = resolve })
  const installGate = new Promise(resolve => { state.releaseInstall = resolve })
  const shutdownGate = new Promise(resolve => { state.releaseShutdown = resolve })
  state.pluginCalls = 0; state.installHooks = 0; state.toolRegistrations = 0
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
    value.dispose = async () => { state.disposals += 1; if (disposeError) throw disposeError }
    options.setup(agentCtx, agent)
    handles.push(value)
    if (holdCreate) await createGate
    return value
  }
  const ctx = {
    on() {}, tools: { register() { state.toolRegistrations += 1 }, guard() { if (closeAtPublication) queueMicrotask(() => queueMicrotask(() => { void state.runner.close() })) }, schemas: () => [] }, plugin: () => { state.pluginCalls += 1; return { async dispose() {} } },
    agents: { create: handle, resume: handle },
    sessionPersistence: { async flush() {}, async open(id, mode) {
      assert.equal(mode, 'read'); opened.push(id)
      if (!sessions.has(id)) throw new Error('missing native history')
      return { async read() { return { events: sessions.get(id) } }, async close() { state.readCloses += 1 } }
    } },
  }
  state.runner = createCollaborationRunner({ store: {}, dshHome: home,
    testHooks: { async onKivoMounted() { state.installHooks += 1; if (holdInstall) await installGate; if (installError) throw installError } },
    runProfileImpl: async () => { state.boots += 1; if (holdBoot) await bootGate; if (bootError) throw bootError; return { ctx, shutdown: { async shutdown() { state.shutdowns += 1; if (holdShutdown) await shutdownGate; if (shutdownError) throw shutdownError } } } },
  })
  return state
}
async function waitFor(check) { for (let count = 0; count < 200; count += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('injected conversation runner condition timed out') }
