import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createCollaborationRunner, CONVERSATION_WORK_TOOLS as TOOLS } from '../src/collaboration-runner.mjs'
import { createConversationService, newConversationRecord } from '../src/conversation-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { segmentKnowledgeBody } from '../src/knowledge-search.mjs'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'
import { parseCapabilityToolResult } from '../src/capabilities.mjs'
import { normalizeTpmObservation, tpmSourcePath, tpmToolRequest } from '../src/domain/tpm.mjs'
import { conversationSessionDependencies, currentConversationDependencies } from '../src/conversation-dependencies.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-chat-tools-')), previous = process.env.DSH_HOME
process.env.DSH_HOME = root
const store = createFileStore(join(root, 'state.json')), actor = { id: 'owner' }, now = '2026-10-15T00:00:00.000Z'
const scenarios = [], sessions = new Map(), scopes = [], toolResponses = []
const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const requireFromTools = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
const { createScope } = await import(pathToFileURL(requireFromTools.resolve('@deepseek-ai/dsh-scope')).href)
const toolHost = new Context(), runtimeFailures = []
const tpm = 'kivo-tpm-record-read', connection = { id: 'kivo', name: 'Synthetic Kivo', revision: 1, kind: 'kivo-mcp', targetIdentity: 'synthetic-instance', baseUrl: 'http://127.0.0.1:41099/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41099', clientId: '00000000-0000-4000-8000-000000000010', credentialRef: 'synthetic-machine.pem', allowedObjectIds: [], enabled: true, status: 'ready', skillIds: [`skill-${tpm}`], sourceSystem: 'Kivo', sourceInstance: 'synthetic-instance', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' }
const catalog = [connection]
let runner, service, conversations, executionCount = 0, workBeforeCommit
try {
  await toolHost.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await toolHost.plugin(ToolRuntime, { mode: 'native' })
  toolHost.tools.register(defineTool({ name: 'synthetic_global_forbidden', description: 'Must never be visible in a conversation', parameters: {}, output: { schema: { type: 'boolean' }, render: () => [] }, execute: async () => false }))
  await store.update(state => ({ ...state,
    members: ['owner', 'peer'].map(id => ({ id, loginName: id, displayName: id, role: 'member', enabled: true, authRef: id, sessionVersion: 1, employeeIds: ['agent'] })),
    employees: [{ id: 'agent', name: 'Agent', enabled: true, revision: 1, instructions: '', modelRouteId: 'model', skillIds: ['skill-cycle-time-calculate', `skill-${tpm}`], connectionIds: [connection.id] }],
    skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true }, { id: `skill-${tpm}`, capabilityId: tpm, enabled: true }], connections: [connection],
    modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    channelApps: [{ id: 'app', provider: 'feishu', providerAppId: 'synthetic-app', providerTenantId: 'synthetic-tenant', credentialRef: 'synthetic-ref', enabled: true, status: 'active', revision: 1, allowedScopes: ['result'], createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity', channelAppId: 'app', providerUserId: 'synthetic-user', memberId: 'owner', verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: now, updatedAt: now }],
  }))
  runner = createCollaborationRunner({ store, dshHome: root, connectionCatalog: catalog, getWorkService: () => ({ ...service, async getWork(...args) { const result = await service.getWork(...args); await workBeforeCommit?.(); return result } }), runProfileImpl: async () => ({ ctx: nativeFixture(), shutdown: { async shutdown() {} } }) })
  const runChatTurn = runner.runChatTurn
  runner.runChatTurn = options => runChatTurn(options).catch(error => { runtimeFailures.push(error); throw error })
  service = createWorkService({ store, connectionCatalog: catalog, runner: { configured: true, async run(options) {
    executionCount += 1
    return { result: parseCapabilityToolResult(options.capabilityId, options.capabilityId === tpm ? { ok: true, observation: observation(options.input) } : calculateCycleTime(options.input), options.input), explanation: 'SYNTHETIC_CYCLE_FACT', dshSessionRef: `synthetic-work-native-${executionCount}`, contextConfirmationRefs: [] }
  }, async close() {} }, collaborationRunner: runner })
  conversations = createConversationService({ store, runner, connectionCatalog: catalog })
  await conversations.ensureReady()
  await store.update(state => ({ ...state, conversations: [...state.conversations, newConversationRecord(state, actor, { id: 'channel-chat', employeeId: 'agent', source: 'feishu', channelIdentityId: 'identity' }, now)] }))
  const plain = await conversations.createConversation(actor, { employeeId: 'agent' })
  await turn(plain.id, async ({ tools }) => assert.equal(tools.size, 0))
  assert.equal((await store.read()).works.length, 0)

  let workId
  await turn('channel-chat', async ({ invoke, tools }) => {
    assert.deepEqual([...tools.keys()].sort(), Object.values(TOOLS).sort())
    const args = { skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60 } }
    const first = await invoke(TOOLS.create, args, 'stable-call')
    assert.equal(first.work.status, 'waiting_input'); assert.deepEqual(first.work.requiredInputs, ['quantity'])
    workId = first.work.workId
    assert.equal((await invoke(TOOLS.create, args, 'stable-call')).work.workId, workId)
    assert.equal((await invoke(TOOLS.create, { ...args, input: {} }, 'stable-call')).error.code, 'INVALID_REQUEST')
    assert.equal((await invoke(TOOLS.create, { ...args, ownerMemberId: 'peer' }, 'forged-owner')).error.code, 'INVALID_REQUEST')
  })
  assert.equal((await store.read()).works.length, 1)
  assert.equal(executionCount, 0)
  await turn('channel-chat', async ({ invoke }) => assert.equal((await invoke(TOOLS.continue, { workId, input: { quantity: 2 } })).ok, true))
  await until(async () => (await service.getWork(actor, workId)).value.status === 'completed')
  await turn('channel-chat', async ({ invoke, tools }) => {
    const value = await invoke(TOOLS.status, { workId })
    assert.equal(value.work.results[0].payload.secondsPerUnit, 30)
    assert.equal(Object.hasOwn(value.work.results[0], 'source'), false)
    const invalid = { ...value, work: { ...value.work, results: value.work.results.map(item => ({ ...item, source: undefined })) } }
    assert.throws(() => toolHost.tools.createSuccessResult({ token: Symbol('invalid-output'), arguments: { workId } }, tools.get(TOOLS.status), invalid), { code: 'INVALID_TOOL_OUTPUT' })
    assert.equal(JSON.stringify(value).includes('synthetic-work-native'), false, 'native refs must stay server-side')
    const current = (await store.read()).conversations.find(item => item.id === 'channel-chat').turns.at(-1)
    assert.deepEqual(current.workDependencyRefs, [{ workId, resultId: value.work.results[0].resultId, connectionRevision: null }], 'references must commit before facts reach the model')
  })
  const other = await conversations.createConversation(actor, { employeeId: 'agent' })
  const otherWork = await service.createWork(actor, { conversationId: other.id, employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 40, quantity: 2 }, clientRequestId: 'outside-conversation' })
  await turn('channel-chat', async ({ invoke }) => {
    assert.equal((await invoke(TOOLS.status, { workId: otherWork.value.id })).error.code, 'FORBIDDEN')
    const candidates = await invoke(TOOLS.status, {})
    assert.equal(candidates.requiresSelection, true)
    assert.deepEqual(candidates.candidates.map(item => item.workId), [workId])
  })
  let tpmWorkId
  await turn('channel-chat', async ({ invoke }) => {
    const value = await invoke(TOOLS.create, { skillId: `skill-${tpm}`, connectionId: connection.id, input: { recordType: 'repair' } })
    assert.equal(value.work.status, 'waiting_input'); assert.deepEqual(value.work.requiredInputs, ['reference'])
    tpmWorkId = value.work.workId
  })
  await turn('channel-chat', async ({ invoke }) => assert.equal((await invoke(TOOLS.continue, { workId: tpmWorkId, input: { reference: 'SYNTHETIC-R-1' } })).ok, true))
  await until(async () => (await service.getWork(actor, tpmWorkId)).value.status === 'completed')
  const tpmExpected = (await service.getWork(actor, tpmWorkId)).value.results[0]
  await turn('channel-chat', async ({ invoke }) => {
    const value = await invoke(TOOLS.status, { workId: tpmWorkId })
    assert.equal(value.ok, true)
    assert.deepEqual(value.work.results[0].source, tpmExpected.source)
    assert.deepEqual(value.work.results[0].payload, tpmExpected.payload)
    assert.equal(value.work.results[0].createdAt, tpmExpected.createdAt)
  })
  const policyState = await store.read(), policyConversation = policyState.conversations.find(item => item.id === 'channel-chat'), policyTurn = policyConversation.turns.at(-1)
  const dependencies = conversationSessionDependencies(policyConversation, policyTurn)
  assert.equal(currentConversationDependencies(policyState, policyConversation, dependencies, catalog), true)
  const refusals = [
    state => { state.members.find(item => item.id === actor.id).enabled = false },
    state => { state.employees[0].enabled = false },
    state => { state.skills.find(item => item.capabilityId === tpm).enabled = false },
    state => { state.connections[0].enabled = false },
    state => { state.connections[0].revision += 1 },
    state => { state.connections[0].clientId = '00000000-0000-4000-8000-000000000099' },
    state => { state.works.find(item => item.id === tpmWorkId).results[0].source.sourceInstance = 'different-instance' },
    state => { state.works.find(item => item.id === tpmWorkId).conversationId = plain.id },
  ]
  for (const change of refusals) { const denied = structuredClone(policyState); change(denied); assert.equal(currentConversationDependencies(denied, policyConversation, dependencies, catalog), false) }
  assert.equal(currentConversationDependencies(policyState, policyConversation, dependencies, []), false, 'current host catalog is authoritative')

  const knowledge = createKnowledgeService({ store })
  const material = await knowledge.createMaterial({ id: 'peer' }, { employeeIds: ['agent'], sharedMemberIds: ['owner'], sharedEmployeeIds: ['agent'], title: 'Synthetic standard', body: 'SHARED_STANDARD_CANARY', sourceLabel: 'synthetic fixture', authorizationBasis: 'local test' })
  const ref = { knowledgeId: material.id, revision: material.revision, segmentId: segmentKnowledgeBody('SHARED_STANDARD_CANARY')[0].segmentId }
  await store.update(state => ({ ...state, works: state.works.map(work => work.id === workId ? { ...work, results: work.results.map(result => ({ ...result, knowledgeDependencyRefs: [ref] })) } : work) }))
  await turn('channel-chat', async ({ invoke }) => assert.equal((await invoke(TOOLS.status, { workId })).ok, true))
  const borrowed = (await store.read()).conversations.find(item => item.id === 'channel-chat').turns.at(-1)
  assert.deepEqual(borrowed.knowledgeDependencyRefs, [ref])
  // No tool on this next turn: inherited native context must still carry exact references.
  await turn('channel-chat', async () => undefined)
  const beforeRevoke = await store.read(), current = beforeRevoke.conversations.find(item => item.id === 'channel-chat')
  assert.equal(currentConversationDependencies(beforeRevoke, current, conversationSessionDependencies(current, current.turns.at(-1)), catalog), true)
  await knowledge.deleteMaterial({ id: 'peer' }, material.id, { expectedRevision: material.revision })
  const revoked = await conversations.getConversation(actor, 'channel-chat')
  assert.equal(revoked.readOnlyReason, 'CONTEXT_ACCESS_REVOKED')
  assert.equal(revoked.turns.at(-1).assistantText, null)
  await assert.rejects(conversations.sendTurn(actor, 'channel-chat', { text: 'must not replay revoked native context', clientRequestId: 'revoked' }), { code: 'FORBIDDEN' })
  assert.equal((await conversations.getConversation({ id: 'peer' }, plain.id).catch(error => error)).code, 'NOT_FOUND')

  await store.update(state => ({ ...state, channelIdentities: state.channelIdentities.map(item => ({ ...item, status: 'unlinked', activeConversationId: null, unlinkedAt: now })) }))
  const fresh = await conversations.createConversation(actor, { employeeId: 'agent' })
  await turn(fresh.id, async ({ tools }) => assert.equal(tools.size, 0))
  // The owner can continue a different clean channel history from Web after unlink.
  await store.update(state => ({ ...state, conversations: [...state.conversations, newConversationRecord(state, actor, { id: 'clean-channel-history', employeeId: 'agent', source: 'feishu', channelIdentityId: 'identity' }, now)] }))
  await turn('clean-channel-history', async ({ tools }) => assert.equal(tools.size, 5))
  const late = await service.createWork(actor, { conversationId: 'clean-channel-history', employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 80, quantity: 2 }, clientRequestId: 'late-fact' })
  await until(async () => (await service.getWork(actor, late.value.id)).value.status === 'completed')
  let revokedBeforeCommit = false
  workBeforeCommit = async () => { revokedBeforeCommit = true; await store.update(state => ({ ...state, members: state.members.map(item => item.id === actor.id ? { ...item, employeeIds: [] } : item) })) }
  const failed = await turn('clean-channel-history', async ({ invoke }) => {
    const result = await invoke(TOOLS.status, { workId: late.value.id })
    assert.equal(result.error.code, 'FORBIDDEN')
    assert.equal(Object.hasOwn(result, 'work'), false)
  }, 'failed')
  assert.equal(revokedBeforeCommit, true)
  assert.equal(failed.error.code, 'FORBIDDEN')
  assert.deepEqual(failed.workDependencyRefs ?? [], [])
  console.log('Conversation work tools checks passed: actual ToolRuntime scoped five tools/global masking/Web zero and strict result normalization, partial input/call deduplication, same-conversation owner binding, pre-return reference commit, TPM/current catalog/connection revision refusals, inherited context/shared-knowledge revocation, late fact commit refusal and owner history after unlink (injected Agent; DSH Host/model/network starts=0)')
} finally {
  await conversations?.close(); await service?.close()
  await toolHost.fiber.dispose()
  if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  await rm(root, { recursive: true, force: true })
}

async function turn(id, scenario, expected = 'completed') {
  scenarios.push(scenario)
  const admitted = await conversations.sendTurn(actor, id, { text: 'SYNTHETIC_CURRENT_TURN', clientRequestId: `request-${scenarios.length}-${Date.now()}` })
  let value
  await until(async () => { value = (await store.read()).conversations.find(item => item.id === id).turns.find(item => item.id === admitted.turn.id); return !['accepted', 'running'].includes(value.status) })
  if (value.status !== expected && runtimeFailures.length) throw runtimeFailures.at(-1)
  assert.equal(value.status, expected, JSON.stringify(value.error))
  return value
}
async function until(check) { for (let count = 0; count < 1000; count += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('controlled fixture did not settle') }
function observation(input) {
  const deviceId = '00000000-0000-4000-8000-000000000011', recordId = '00000000-0000-4000-8000-000000000012'
  const source = { system: 'kivo', path: tpmSourcePath(tpmToolRequest('record', input)), queriedAt: now, traceId: 'synthetic-trace' }
  return normalizeTpmObservation({ mode: 'record', input, connection,
    result: { status: 'ok', source, value: { id: recordId, orderNo: input.reference, deviceId, status: 'reported', revision: 1, createdAt: now, updatedAt: now } },
    deviceResult: { status: 'ok', source: { ...source, path: tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: deviceId })) }, value: { id: deviceId, code: 'SYNTHETIC-D-1', name: 'synthetic device', lifecycleStatus: 'active' } },
  })
}
function nativeFixture() {
  async function handle(options) {
    const id = options.resumeSessionId ?? options.sessionId, events = sessions.get(id) ?? []
    sessions.set(id, events)
    const tools = new Map(), requests = []
    let scoped
    let pending = Promise.resolve(), number = events.filter(item => item.type === 'turn/start').length
    const ctx = { tools: { register(tool) { scoped.ctx.tools.register(tool); tools.set(tool.name, tool) }, restrict(value) { scoped.ctx.tools.restrict(value); scopes.push(value.allow) }, guard(callback) { scoped.ctx.tools.guard(callback) } }, systemPrompt: { section() {} }, on(name, callback) { if (name === 'agent/request') requests.push(callback) } }
    const agent = { id, session: { header: { origin: 'root' }, snapshotEvents: () => events }, ctx,
      followup(message) {
        number += 1
        events.push({ type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: message })
        pending = (async () => {
          for (const request of requests) await request({ signal: options.signal }, async () => ({}))
          const scenario = scenarios.shift()
          await scenario({ tools, async invoke(name, args, callId = `call-${toolResponses.length}`) {
            const definition = tools.get(name)
            const returned = await definition.execute(args, { callId, agent, signal: options.signal })
            const value = toolHost.tools.createSuccessResult({ token: Symbol(callId), arguments: args }, definition, returned).value
            toolResponses.push(value)
            events.push({ type: 'tool/call', data: { name, callId } })
            return value
          } })
          events.push({ type: 'assistant/message', data: { turn: number, message: { id: `assistant-${id}-${number}`, content: [{ type: 'text', text: 'SYNTHETIC_REPLY' }] } } }, { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } })
        })()
      }, whenIdle: () => pending, cancel() {},
    }
    const scopeFiber = toolHost.plugin(Object.assign(ctx => { scoped = createScope(ctx, agent) }, { inject: ['tools'] }))
    await scopeFiber
    try {
      options.setup(ctx, agent)
      assert.deepEqual(scoped.ctx.tools.schemas(agent).map(item => item.name).sort(), [...tools.keys()].sort(), 'local tools stay visible while every global tool is masked')
    } catch (error) { await scoped.dispose(); await scopeFiber.dispose(); throw error }
    return { agent, async dispose() { await scoped.dispose(); await scopeFiber.dispose() } }
  }
  return { on() {}, tools: { register() {}, guard() {}, schemas: () => [] }, plugin: () => ({ async dispose() {} }), agents: { create: handle, resume: handle }, sessionPersistence: { async flush() {}, async open(id) { return { async read() { return { events: sessions.get(id) } }, async close() {} } } } }
}
