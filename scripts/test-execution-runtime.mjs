import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelRouteSnapshot, modelAgentOptions, assertModelRoute } from '../src/model-route.mjs'
import { activeTopLevelCount, nativeUsage, nativeRequestCount, unknownUsage } from '../src/execution-runtime.mjs'
import { createExecutionRequestGuard } from '../plugins/execution-request-guard.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'

const route = { id: 'route', provider: 'zenmux', model: 'z-ai/glm-5.3-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }
const snapshot = modelRouteSnapshot(route)
assert.deepEqual(modelAgentOptions(snapshot), { provider: 'zenmux', model: 'z-ai/glm-5.3-flash', maxTokens: 4096 })
for (const parameters of [null, [], { temperature: 1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 4097 }, { maxOutputTokens: 1.5 }]) assert.throws(() => modelRouteSnapshot({ ...route, parameters }), { code: 'MODEL_NOT_CONFIGURED' })
assert.throws(() => modelRouteSnapshot({ ...route, model: 'unapproved/model' }), { code: 'MODEL_NOT_CONFIGURED' })
assert.throws(() => assertModelRoute({ modelRoutes: [{ ...route, parameters: { maxOutputTokens: 70 } }] }, { modelRouteId: route.id }, snapshot), { code: 'MODEL_NOT_CONFIGURED' })

const native = JSON.parse(await readFile(new URL('./fixtures/native-model-events.json', import.meta.url), 'utf8'))
const successful = native.events.filter(event => event.type === 'assistant/message')
assert.equal(nativeRequestCount([...native.events, ...native.events]), 2)
assert.deepEqual(nativeUsage([...successful, ...successful], native.sessionId), { inputTokens: 9, outputTokens: 7, totalTokens: 18, cacheReadTokens: 2, cacheWriteTokens: null, reasoningTokens: null })
assert.deepEqual(nativeUsage(native.events, native.sessionId), unknownUsage(), 'an unreported failed attempt makes the execution total unknown')
assert.deepEqual(nativeUsage(native.events.toReversed(), native.sessionId), unknownUsage(), 'unknown does not depend on event order')

let request, created, executionId = 'one'
const ctx = { on(name, listener) { if (name === 'agent/created') created = listener } }
createExecutionRequestGuard({ authorize: async () => ({ grant: { executionId, modelSnapshot: snapshot }, authorization: { route } }) })(ctx)
created({ agent: { ctx: { on(_name, listener) { request = listener } } } })
for (let attempt = 0; attempt < 4; attempt += 1) await request({}, async () => modelAgentOptions(snapshot))
await assert.rejects(request({}, async () => modelAgentOptions(snapshot)), { code: 'BUDGET_EXHAUSTED' })
executionId = 'two'
await request({}, async () => modelAgentOptions(snapshot))
await assert.rejects(request({}, async () => ({ ...modelAgentOptions(snapshot), model: 'other' })), { code: 'FORBIDDEN' })

await admissionChecks()
await harnessCloseFailureCheck()
console.log('Execution checks passed: trusted two-route snapshot and cap, native event usage/unknown/deduplication, per-execution request budget, shared atomic four-entry capacity, full idempotency, waiting input, auto capacity, cancellation drain, fail-closed ownership and private admin metadata (injected runners; no native/model/network starts)')

async function admissionChecks() {
  const temp = await mkdtemp(join(tmpdir(), 'geneway-execution-check-'))
  const store = createFileStore(join(temp, 'state.json')), actor = { id: 'owner' }
  const pending = new Map(), chats = new Map(), closed = gate()
  const connection = { id: 'kivo', name: 'Controlled Kivo declaration only', kind: 'kivo-mcp', targetIdentity: 'controlled', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: '00000000-0000-4000-8000-000000000003', credentialRef: 'controlled.pem', allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'controlled', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, status: 'ready', revision: 1, skillIds: ['skill-kivo-tpm-record-read'] }
  const runner = { configured: true,
    run(options) { const entry = gate(); pending.set(options.executionId, entry); return entry.promise },
    async cancel(id) { await closed.promise; pending.get(id)?.reject(Object.assign(new Error('controlled cancelled'), { code: 'CANCELLED' })) },
    async close() { closed.resolve(); for (const entry of pending.values()) entry.reject(Object.assign(new Error('controlled cancelled'), { code: 'CANCELLED' })) },
  }
  const shared = { run() { return Promise.resolve() }, async close() {},
    runChatTurn(options) { const entry = gate(); chats.set(options.turnId, entry); return entry.promise },
    async cancelChatTurn(_id, turnId) { chats.get(turnId)?.resolve({ stopReason: 'aborted' }); return true },
    async readChatHistory() { return [] },
  }
  let work, chat
  try {
    const now = new Date().toISOString()
    await store.update(state => ({ ...state,
      members: [{ id: 'owner', loginName: 'owner', displayName: 'Owner', enabled: true, role: 'member', authRef: 'owner', sessionVersion: 1, employeeIds: ['agent'], createdAt: now, updatedAt: now }, { id: 'admin', loginName: 'admin', displayName: 'Admin', enabled: true, role: 'admin', authRef: 'admin', sessionVersion: 1, employeeIds: [], createdAt: now, updatedAt: now }],
      modelRoutes: [route], employees: [{ id: 'agent', name: 'Controlled', enabled: true, modelRouteId: 'route', skillIds: ['skill-cycle-time-calculate', 'skill-kivo-tpm-record-read'], connectionIds: ['kivo'] }],
      skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', name: 'Cycle', enabled: true }, { id: 'skill-kivo-tpm-record-read', capabilityId: 'kivo-tpm-record-read', name: 'Read', enabled: true }], connections: [connection],
    }))
    work = createWorkService({ store, runner, collaborationRunner: shared, connectionCatalog: [connection] })
    chat = createConversationService({ store, runner: shared })
    await work.ensureReady(); await chat.ensureReady()
    const conversation = await chat.createConversation(actor, { employeeId: 'agent' })
    const body = id => ({ employeeId: 'agent', skillId: 'skill-cycle-time-calculate', goal: 'PRIVATE_WORK_CANARY', input: { availableSeconds: 60, quantity: 2 }, clientRequestId: id })
    const [one, two, turn, root] = await Promise.all([
      work.createWork(actor, body('one')), work.createWork(actor, body('two')),
      chat.sendTurn(actor, conversation.id, { text: 'PRIVATE_CHAT_CANARY', clientRequestId: 'turn' }),
      work.createCollaboration(actor, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', goal: 'PRIVATE_ROOT_CANARY', clientRequestId: 'root', items: [{ id: 'item', employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60, quantity: 2 } }] }),
    ])
    assert(one.ok && two.ok && root.ok)
    await until(() => pending.size === 2 && chats.size === 1)
    assert.equal(activeTopLevelCount(await store.read()), 4, 'collaboration child must not consume a fifth top-level slot')
    assert.equal((await work.createWork(actor, body('fifth'))).error.code, 'BUSY')
    const another = await chat.createConversation(actor, { employeeId: 'agent' })
    await assert.rejects(chat.sendTurn(actor, another.id, { text: 'fifth', clientRequestId: 'fifth-turn' }), { code: 'BUSY' })
    assert.equal((await work.createWork(actor, body('one'))).deduplicated, true)
    assert.equal((await work.continueWork(actor, one.value.id, {})).deduplicated, true)
    assert.equal((await chat.sendTurn(actor, conversation.id, { text: 'PRIVATE_CHAT_CANARY', clientRequestId: 'turn' })).deduplicated, true)
    const waiting = await work.createWork(actor, { ...body('waiting'), input: { availableSeconds: 60 } })
    assert.equal(waiting.value.status, 'waiting_input')
    assert.equal((await work.continueWork(actor, waiting.value.id, { input: { quantity: 2 } })).error.code, 'BUSY')
    const auto = work.prepareAutomationWork(await store.read(), { id: 'rule', status: 'active', ownerMemberId: actor.id, employeeId: 'agent', skillId: 'skill-kivo-tpm-record-read', connectionId: 'kivo', capabilityId: 'kivo-tpm-record-read', input: { recordType: 'repair', reference: 'R-1' } }, { occurrenceKey: 'occurrence' })
    assert.equal(auto.error.code, 'BUSY', 'auto admission uses the same global capacity')
    await assert.rejects(store.update(state => ({ ...state, works: state.works.map(item => item.id === one.value.id ? { ...item, executions: item.executions.map(execution => ({ ...execution, modelSnapshot: { ...execution.modelSnapshot, model: 'deepseek/deepseek-v4.1-flash' }, runtime: { ...execution.runtime, model: 'deepseek/deepseek-v4.1-flash' } })) } : item) })), /执行冻结模型不可改写/)
    const metadata = await work.runtimeMetadata({ id: 'admin' })
    assert.equal(metadata.capacity.active, 4)
    assert.equal(JSON.stringify(metadata).includes('PRIVATE_'), false)
    assert.equal(JSON.stringify(metadata).includes('userText'), false)
    await assert.rejects(work.runtimeMetadata(actor), { code: 'FORBIDDEN' })
    const cancelling = work.cancel(actor, one.value.id)
    await until(async () => (await store.read()).works.find(item => item.id === one.value.id).status === 'cancel_requested')
    assert.equal((await work.createWork(actor, body('during-close'))).error.code, 'BUSY', 'cancellation retains its slot until the runner closes')
    closed.resolve(); await cancelling
    await until(async () => activeTopLevelCount(await store.read()) === 3)
    const afterClose = await work.createWork(actor, body('after-close'))
    assert.equal(afterClose.ok, true)
    await until(() => pending.has(afterClose.value.executions.at(-1).id))
    pending.get(afterClose.value.executions.at(-1).id).reject(Object.assign(new Error('controlled close failure'), { code: 'UPSTREAM_ERROR', closeFailed: true }))
    await until(async () => (await store.read()).works.find(item => item.id === afterClose.value.id).status === 'cancel_requested')
    assert.equal(activeTopLevelCount(await store.read()), 4, 'an unconfirmed work close still consumes its slot')
    chats.get(turn.turn.id).reject(Object.assign(new Error('controlled chat dispose failure'), { code: 'UPSTREAM_ERROR', closeFailed: true }))
    await until(async () => (await store.read()).conversations.find(item => item.id === conversation.id).turns[0].runtime.terminationReason === 'UPSTREAM_ERROR')
    assert.equal(activeTopLevelCount(await store.read()), 4, 'an unconfirmed chat dispose remains active')
    assert.equal((await work.createWork(actor, body('after-close-failure'))).error.code, 'BUSY')
    await assert.rejects(chat.close(), /会话回复关闭失败/)
    chat = undefined
  } finally {
    closed.resolve()
    await chat?.close(); await work?.close()
    await rm(temp, { recursive: true, force: true })
  }
}
async function harnessCloseFailureCheck() {
  const temp = await mkdtemp(join(tmpdir(), 'geneway-harness-close-check-'))
  let closeFails = true, closes = 0
  const runner = createDshRunner({
    config: { model: { configured: true, provider: 'controlled', model: 'controlled' }, source: {}, dshHome: join(temp, 'dsh'), stateFile: join(temp, 'state.json'), dataRoot: temp, secretRoot: join(temp, 'secrets') },
    harnessFactory: () => ({ async run() { throw new Error('controlled run failure') }, async close() { closes += 1; if (closeFails) throw new Error('controlled close failure') } }),
  })
  try {
    await assert.rejects(runner.run({ executionId: 'owned-until-closed', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 60, quantity: 2 },
      sessionMetadata: { ownerMemberId: 'owner', workId: 'work', employeeId: 'agent', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', connectionId: null, connectionRevision: null, modelRouteId: 'route', confirmationFingerprint: 'none', confirmationRefs: [] },
      grant: { policyFile: join(temp, 'state.json'), policyRoot: temp, secretRoot: join(temp, 'secrets') },
    }), error => error.closeFailed === true)
    await assert.rejects(runner.close(), /执行资源尚未确认关闭/)
    assert.equal(closes, 2, 'a failed close must retain the owned harness for shutdown')
    closeFails = false
    await runner.close()
    assert.equal(closes, 3)
  } finally { closeFails = false; await runner.close(); await rm(temp, { recursive: true, force: true }) }
}
function gate() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => undefined); return { promise, resolve, reject } }
async function until(fn) { for (let index = 0; index < 1000; index += 1) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('controlled execution check timed out') }
