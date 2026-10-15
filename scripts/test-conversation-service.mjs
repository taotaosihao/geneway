import assert from 'node:assert/strict'
import { createConversationService } from '../src/conversation-service.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'

const a = { id: 'member-a' }, b = { id: 'member-b' }, admin = { id: 'admin' }
const now = '2026-10-15T00:00:00.000Z'
await checkOwnershipAndTurns()
await checkFrozenDefinition()
await checkRevocationAndMissingHistory()
await checkRecoveryAndBindingFailure()
await checkShutdown()
await checkAdmissionDuringClose()
await checkConcurrentIdempotency()
console.log('Conversation service checks passed: owner-only history, strict idempotency, exact cancellation, frozen definitions, clean successors, recovery and shutdown (injected store/runner; native/model/network starts=0)')

async function checkOwnershipAndTurns() {
  const { service, runner, store } = fixture()
  const privateChat = await service.createConversation(a, { employeeId: 'private' })
  assert.equal(privateChat.historyStatus, 'empty')
  assert.equal(privateChat.activeTurnId, null)
  assert.deepEqual(privateChat.turns, [])
  for (const actor of [b, admin]) {
    assert.deepEqual(await service.listConversations(actor), [])
    await assert.rejects(service.getConversation(actor, privateChat.id), { code: 'NOT_FOUND' })
    await assert.rejects(service.createConversation(actor, { employeeId: 'private' }), { code: 'FORBIDDEN' })
  }
  for (const body of [{ employeeId: 'private', ownerMemberId: b.id }, { employeeId: 'private', sessionId: 'native' }]) await assert.rejects(service.createConversation(a, body), { code: 'INVALID_REQUEST' })
  const sent = await service.sendTurn(a, privateChat.id, { text: 'CANARY_A', clientRequestId: 'one' })
  const completed = await waitTurn(service, a, privateChat.id, sent.turn.id, 'completed')
  assert.equal(completed.historyStatus, 'available')
  assert.equal(completed.turns[0].assistantText, 'reply:CANARY_A')
  const replay = await service.sendTurn(a, privateChat.id, { text: 'CANARY_A', clientRequestId: 'one' })
  assert.equal(replay.deduplicated, true)
  assert.equal(replay.turn.assistantText, 'reply:CANARY_A')
  assert.equal(runner.calls.length, 1)
  await assert.rejects(service.sendTurn(a, privateChat.id, { text: ' CANARY_A', clientRequestId: 'one' }), { code: 'IDEMPOTENCY_CONFLICT' })

  const held = await service.sendTurn(a, privateChat.id, { text: 'hold:one', clientRequestId: 'two' })
  await runner.waitFor(held.turn.id)
  await assert.rejects(service.sendTurn(a, privateChat.id, { text: 'other', clientRequestId: 'three' }), { code: 'CONFLICT' })
  await assert.rejects(service.updateConversation(a, privateChat.id, { archived: true }), { code: 'CONFLICT' })
  const oldCancel = await service.cancelTurn(a, privateChat.id, sent.turn.id)
  assert.equal(oldCancel.accepted, false)
  assert.equal(oldCancel.conversation.activeTurnId, held.turn.id)
  assert.equal(runner.cancellations.length, 0)
  const stopped = await service.cancelTurn(a, privateChat.id, held.turn.id)
  assert.equal(stopped.accepted, true)
  assert.equal(stopped.turn.status, 'cancelled')
  assert.equal(stopped.conversation.activeTurnId, null)
  const second = await service.createConversation(a, { employeeId: 'shared', title: 'second' })
  const otherMember = await service.createConversation(b, { employeeId: 'shared' })
  await service.sendTurn(a, second.id, { text: 'CANARY_A_SECOND', clientRequestId: 'one' })
  await service.sendTurn(b, otherMember.id, { text: 'CANARY_B', clientRequestId: 'one' })
  await waitFor(() => runner.calls.length === 4)
  assert.notEqual(runner.calls[2].actualSessionId, runner.calls[3].actualSessionId)
  assert.equal(runner.calls[2].sessionId, null)
  assert.equal(runner.calls[3].sessionId, null)
  assert.equal(JSON.stringify(await service.getConversation(b, otherMember.id)).includes('CANARY_A'), false)
  await store.update(state => ({ ...state, works: [
    { id: 'owned-work', ownerMemberId: a.id, conversationId: privateChat.id, goal: 'same conversation', status: 'running', employeeId: 'private' },
    { id: 'wrong-owner', ownerMemberId: b.id, conversationId: privateChat.id, goal: 'hidden', status: 'running', employeeId: 'private' },
    { id: 'child-work', ownerMemberId: a.id, conversationId: privateChat.id, rootWorkId: 'owned-work', goal: 'child', status: 'running', employeeId: 'private' },
  ] }))
  assert.deepEqual((await service.getConversation(a, privateChat.id)).relatedWorks.map(work => work.id), ['owned-work'])
  await service.updateConversation(a, privateChat.id, { archived: true })
  assert.equal((await service.listConversations(a)).some(item => item.id === privateChat.id), false)
  assert.equal((await service.listConversations(a, { includeArchived: true })).some(item => item.id === privateChat.id), true)
  assert.equal((await service.updateConversation(a, privateChat.id, { title: 'renamed archive' })).title, 'renamed archive')
  await assert.rejects(service.updateConversation(a, privateChat.id, { archived: false }), { code: 'INVALID_REQUEST' })
  const dto = JSON.stringify(await service.getConversation(a, privateChat.id))
  assert.equal(dto.includes('private reasoning must not render'), false)
  for (const hidden of ['ownerMemberId', 'sessionId', 'userMessageId', 'assistantMessageIds', 'definitionFingerprint', 'frozen-instruction']) assert.equal(dto.includes(hidden), false, hidden)
  await service.close()
}

async function checkFrozenDefinition() {
  const { service, runner, store } = fixture()
  const chat = await service.createConversation(a, { employeeId: 'shared' })
  const first = await service.sendTurn(a, chat.id, { text: 'hold:old-definition', clientRequestId: 'one' })
  await runner.waitFor(first.turn.id)
  await store.update(state => ({ ...state, employees: state.employees.map(item => item.id === 'shared' ? { ...item, instructions: 'new-instruction', revision: 2 } : item) }))
  assert.equal(runner.calls[0].instructions, 'frozen-instruction')
  runner.release(first.turn.id)
  await waitTurn(service, a, chat.id, first.turn.id, 'completed')
  const second = await service.sendTurn(a, chat.id, { text: 'new-definition', clientRequestId: 'two' })
  await waitTurn(service, a, chat.id, second.turn.id, 'completed')
  assert.equal(runner.calls[1].instructions, 'new-instruction')
  assert.equal(runner.calls[1].sessionId, null)
  assert.notEqual(runner.calls[1].actualSessionId, runner.calls[0].actualSessionId)
  const third = await service.sendTurn(a, chat.id, { text: 'same-definition', clientRequestId: 'three' })
  await waitTurn(service, a, chat.id, third.turn.id, 'completed')
  assert.equal(runner.calls[2].sessionId, runner.calls[1].actualSessionId)
  assert.equal(JSON.stringify(runner.sessions.get(runner.calls[2].sessionId)).includes('old-definition'), false)
  runner.sessions.delete(runner.calls[0].actualSessionId)
  const partial = await service.getConversation(a, chat.id)
  assert.equal(partial.historyStatus, 'partial')
  assert.deepEqual(partial.turns.map(turn => turn.status), ['completed', 'completed', 'completed'])
  assert.equal(partial.turns[0].assistantText, null)
  assert.equal(partial.turns[2].assistantText, 'reply:same-definition')
  await assert.rejects(service.sendTurn(a, chat.id, { text: 'partial must not become fresh', clientRequestId: 'four' }), { code: 'HISTORY_UNAVAILABLE' })
  await service.close()
}

async function checkRevocationAndMissingHistory() {
  const { service, runner, store } = fixture()
  const chat = await service.createConversation(a, { employeeId: 'shared' })
  const sent = await service.sendTurn(a, chat.id, { text: 'hold:revoke', clientRequestId: 'one' })
  await runner.waitFor(sent.turn.id)
  await store.update(state => ({ ...state, members: state.members.map(item => item.id === a.id ? { ...item, employeeIds: [] } : item) }))
  runner.release(sent.turn.id)
  await waitTurn(service, a, chat.id, sent.turn.id, 'failed')
  const revoked = await service.getConversation(a, chat.id)
  assert.equal(revoked.readOnlyReason, 'AGENT_ACCESS_REVOKED')
  assert.equal(revoked.turns[0].error.code, 'FORBIDDEN')
  await assert.rejects(service.sendTurn(a, chat.id, { text: 'must not send', clientRequestId: 'two' }), { code: 'FORBIDDEN' })
  assert.equal(runner.calls.length, 1)
  assert.equal((await service.updateConversation(a, chat.id, { title: 'owner keeps history' })).title, 'owner keeps history')
  await store.update(state => ({ ...state, members: state.members.map(item => item.id === a.id ? { ...item, employeeIds: ['shared'] } : item), employees: state.employees.map(item => item.id === 'shared' ? { ...item, enabled: false } : item) }))
  assert.equal((await service.getConversation(a, chat.id)).readOnlyReason, 'AGENT_DISABLED')
  await service.close()

  const second = fixture()
  const completeChat = await second.service.createConversation(a, { employeeId: 'shared' })
  const completeTurn = await second.service.sendTurn(a, completeChat.id, { text: 'history', clientRequestId: 'one' })
  await waitTurn(second.service, a, completeChat.id, completeTurn.turn.id, 'completed')
  second.runner.sessions.clear()
  const missing = await second.service.getConversation(a, completeChat.id)
  assert.equal(missing.historyStatus, 'unavailable')
  assert.equal(missing.readOnlyReason, 'HISTORY_UNAVAILABLE')
  assert.equal(missing.turns[0].status, 'completed')
  assert.equal(missing.turns[0].userText, null)
  assert.equal(missing.turns[0].assistantText, null)
  await assert.rejects(second.service.sendTurn(a, completeChat.id, { text: 'no fresh fallback', clientRequestId: 'two' }), { code: 'HISTORY_UNAVAILABLE' })
  assert.equal((await second.service.updateConversation(a, completeChat.id, { archived: true })).archivedAt, now)
  await second.service.close()
}

async function checkRecoveryAndBindingFailure() {
  const { service, runner, store } = fixture()
  const chat = await service.createConversation(a, { employeeId: 'shared' })
  const sent = await service.sendTurn(a, chat.id, { text: 'completed history', clientRequestId: 'one' })
  await waitTurn(service, a, chat.id, sent.turn.id, 'completed')
  await store.update(state => ({ ...state, conversations: state.conversations.map(item => ({ ...item, turns: [...item.turns, { ...item.turns[0], id: 'old-running', clientRequestId: 'old-request', status: 'running', completedAt: null }] })) }))
  const recovered = createConversationService({ store, runner, clock: () => now })
  await recovered.ensureReady()
  assert.equal(runner.calls.length, 1)
  const detail = await recovered.getConversation(a, chat.id)
  assert.deepEqual(detail.turns.map(turn => turn.status), ['completed', 'interrupted'])
  const replay = await recovered.sendTurn(a, chat.id, { text: 'completed history', clientRequestId: 'old-request' })
  assert.equal(replay.deduplicated, true)
  assert.equal(replay.turn.status, 'interrupted')
  const next = await recovered.sendTurn(a, chat.id, { text: 'after restart', clientRequestId: 'next' })
  await waitTurn(recovered, a, chat.id, next.turn.id, 'completed')
  assert.equal(runner.calls[1].sessionId, null)
  await recovered.close()
  await service.close()

  const failure = fixture()
  const failedChat = await failure.service.createConversation(a, { employeeId: 'shared' })
  failure.store.rejectBinding = true
  const failedTurn = await failure.service.sendTurn(a, failedChat.id, { text: 'must not reach followup', clientRequestId: 'binding-fails' })
  const failed = await waitTurn(failure.service, a, failedChat.id, failedTurn.turn.id, 'failed')
  assert.equal(failure.runner.followups, 0)
  assert.equal(failed.turns[0].error.code, 'UPSTREAM_ERROR')
  assert.equal(failure.runner.disposed, 1)
  assert.deepEqual((await failure.store.read()).conversations[0].sessions, [])
  await failure.service.close()
}

async function checkShutdown() {
  const { service, runner } = fixture()
  const chats = await Promise.all([service.createConversation(a, { employeeId: 'shared' }), service.createConversation(a, { employeeId: 'shared' })])
  const turns = await Promise.all(chats.map((chat, index) => service.sendTurn(a, chat.id, { text: `hold:${index}`, clientRequestId: 'one' })))
  await Promise.all(turns.map(item => runner.waitFor(item.turn.id)))
  await service.close()
  for (const [index, chat] of chats.entries()) assert.equal((await service.getConversation(a, chat.id)).turns.find(item => item.id === turns[index].turn.id).status, 'interrupted')
  assert.equal(runner.hostCloses, 0)
  assert.equal(runner.running.size, 0)
  await assert.rejects(service.sendTurn(a, chats[0].id, { text: 'closed', clientRequestId: 'two' }), { code: 'CONFLICT' })
}

async function checkAdmissionDuringClose() {
  const { service, runner } = fixture()
  const chat = await service.createConversation(a, { employeeId: 'shared' })
  const sent = await service.sendTurn(a, chat.id, { text: 'before close', clientRequestId: 'one' })
  await waitTurn(service, a, chat.id, sent.turn.id, 'completed')
  const read = runner.readChatHistory
  let release, arrived
  const held = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { arrived = resolve })
  runner.readChatHistory = async ids => { arrived(); await held; return read(ids) }
  const admission = service.sendTurn(a, chat.id, { text: 'races with close', clientRequestId: 'two' })
  await entered
  const closing = service.close()
  release()
  await assert.rejects(admission, { code: 'CONFLICT' })
  await closing
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.running.size, 0)
  assert.equal(runner.hostCloses, 0)
}

async function checkConcurrentIdempotency() {
  const { service, runner } = fixture()
  const chat = await service.createConversation(a, { employeeId: 'shared' })
  const body = { text: 'one admitted turn', clientRequestId: 'same-request' }
  const results = await Promise.all([service.sendTurn(a, chat.id, body), service.sendTurn(a, chat.id, body)])
  assert.deepEqual(results.map(item => item.deduplicated).sort(), [false, true])
  assert.equal(results[0].turn.id, results[1].turn.id)
  await waitTurn(service, a, chat.id, results[0].turn.id, 'completed')
  assert.equal(runner.calls.length, 1)
  await service.close()
}

function fixture() {
  let state = { members: [
    { id: a.id, enabled: true, employeeIds: ['shared', 'private'] },
    { id: b.id, enabled: true, employeeIds: ['shared'] },
    { id: admin.id, enabled: true, employeeIds: ['shared'] },
  ], employees: ['shared', 'private'].map(id => ({ id, name: id, enabled: true, modelRouteId: 'model', revision: 1, instructions: 'frozen-instruction' })),
  modelRoutes: [{ id: 'model', enabled: true, ...readRuntimeConfig({}).model }], conversations: [], works: [] }
  let pending = Promise.resolve()
  const store = {
    rejectBinding: false,
    async read() { await pending; return structuredClone(state) },
    update(mutator) {
      const operation = pending.then(async () => {
        const next = await mutator(structuredClone(state))
        if (store.rejectBinding && next.conversations.some(item => item.turns.some(turn => turn.userMessageId))) { store.rejectBinding = false; throw new Error('synthetic binding commit failed') }
        state = structuredClone(next)
        return structuredClone(state)
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
  const runner = fakeRunner()
  return { store, runner, service: createConversationService({ store, runner, clock: () => now }) }
}

function fakeRunner() {
  const calls = [], cancellations = [], sessions = new Map(), running = new Map()
  const runner = {
    calls, cancellations, sessions, running, followups: 0, disposed: 0, hostCloses: 0,
    async runChatTurn(options) {
      const actualSessionId = options.sessionId ?? `native-${calls.length + 1}`
      const userMessageId = `user-${options.turnId}`, assistantId = `assistant-${options.turnId}`
      const call = { ...options, actualSessionId, cancelled: false }
      calls.push(call)
      sessions.set(actualSessionId, sessions.get(actualSessionId) ?? [])
      const events = sessions.get(actualSessionId), number = events.filter(event => event.type === 'turn/start').length + 1
      let release
      const gate = new Promise(resolve => { release = resolve })
      running.set(options.turnId, { call, release })
      try {
        await options.authorize()
        await options.onSession({ sessionId: actualSessionId, userMessageId })
        runner.followups += 1
        events.push({ type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: { id: userMessageId, content: [{ type: 'text', text: options.text }], source: { kind: 'user' } } })
        if (options.text.startsWith('hold:')) await gate
        if (call.cancelled) return { sessionId: actualSessionId, userMessageId, assistantMessageIds: [], stopReason: 'aborted' }
        await options.authorize()
        events.push({ type: 'assistant/message', data: { turn: number, message: { id: assistantId, content: [{ type: 'text', text: `reply:${options.text}` }, { type: 'reasoning', text: 'private reasoning must not render' }] } } })
        return { sessionId: actualSessionId, userMessageId, assistantMessageIds: [assistantId], stopReason: 'completed' }
      } finally { running.delete(options.turnId); runner.disposed += 1 }
    },
    async cancelChatTurn(conversationId, turnId) {
      cancellations.push({ conversationId, turnId })
      const entry = running.get(turnId)
      if (!entry || entry.call.conversationId !== conversationId) return false
      entry.call.cancelled = true
      entry.release()
      return true
    },
    async readChatHistory(ids) { return ids.map(sessionId => sessions.has(sessionId) ? { sessionId, status: 'available', events: structuredClone(sessions.get(sessionId)) } : { sessionId, status: 'unavailable' }) },
    async waitFor(turnId) { await waitFor(() => running.has(turnId) && runner.followups >= calls.findIndex(item => item.turnId === turnId) + 1) },
    release(turnId) { running.get(turnId).release() },
    async close() { runner.hostCloses += 1 },
  }
  return runner
}
async function waitTurn(service, actor, id, turnId, status) {
  let detail
  await waitFor(async () => { detail = await service.getConversation(actor, id); return detail.turns.find(item => item.id === turnId)?.status === status })
  return detail
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  throw new Error('synthetic conversation condition timed out')
}
