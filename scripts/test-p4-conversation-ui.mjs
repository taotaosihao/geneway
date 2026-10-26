import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer as createNodeServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Script, createContext, runInContext } from 'node:vm'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createChannelRuntime, createGenewayServer, shutdownServer } from '../src/server.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-conversation-http-'))
const store = createFileStore(join(temp, 'state.json')), authPath = join(temp, 'auth.json')
const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
const script = index.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const calls = [], lifecycle = [], now = '2026-10-15T00:00:00.000Z'
const summary = { id: 'conversation/a', title: '本人对话', employeeId: 'agent', employeeName: '测试员工', source: 'web', createdAt: now, updatedAt: now, archivedAt: null, readOnlyReason: null, activeTurnId: null }
const turn = { id: 'turn/one', userText: '测试消息', assistantText: null, status: 'accepted', createdAt: now, startedAt: null, completedAt: null, error: null }
const detail = { ...summary, turns: [], historyStatus: 'empty', relatedWorks: [] }
let server, origin, injectedError = null, replay = false
const conversationService = {
  async listConversations(actor, options) { record('listConversations', actor, options); return actor.id === 'a' ? [detail] : [] },
  async createConversation(actor, body) { record('createConversation', actor, body); return structuredClone(detail) },
  async getConversation(actor, id) { record('getConversation', actor, id); own(actor); return structuredClone(detail) },
  async updateConversation(actor, id, body) { record('updateConversation', actor, id, body); own(actor); return { ...detail, ...(body.title ? { title: body.title } : { archivedAt: now }) } },
  async sendTurn(actor, id, body) { record('sendTurn', actor, id, body); own(actor); return { conversation: { ...summary, activeTurnId: turn.id }, turn, deduplicated: replay } },
  async cancelTurn(actor, id, turnId) { record('cancelTurn', actor, id, turnId); own(actor); return { accepted: false, conversation: { ...summary, activeTurnId: 'newer-turn' }, turn: { ...turn, status: 'completed' } } },
  async close() { lifecycle.push('conversation') },
}
const service = {
  async createWork(actor, body) { record('createWork', actor, body); return { ok: true, value: { id: 'work-one', conversationId: body.conversationId ?? null } } },
  async createCollaboration(actor, body) { record('createCollaboration', actor, body); return { ok: true, value: { id: 'work-two', conversationId: body.conversationId ?? null } } },
  async close() { lifecycle.push('work') },
}

try {
  await checkUnownedStoreWrite()
  await checkStartupOwnership()
  await checkUiRaces()
  await store.update(state => ({ ...state, members: ['admin', 'a', 'b'].map(id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, employeeIds: ['agent'], sessionVersion: 1, createdAt: now, updatedAt: now })) }))
  await initializeAuthFile(authPath, { admin: 'admin test password', a: 'a test password', b: 'b test password' })
  const probe = createNodeServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, conversationService, store, auth: createAuthRuntime({ filePath: authPath }), index, trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const a = await login('a'), b = await login('b'), admin = await login('admin')
  const path = '/api/conversations/' + encodeURIComponent(summary.id)
  assert.equal((await request('/')).body, index)
  assert.equal((await request('/api/conversations')).status, 401)
  assert.equal((await request('/api/conversations', { session: a })).body.conversations[0].id, summary.id)
  assert.deepEqual(calls.at(-1), { method: 'listConversations', memberId: 'a', args: [{ includeArchived: false }] })
  assert.equal((await request('/api/conversations?includeArchived=true', { session: a })).status, 200)
  assert.deepEqual(calls.at(-1).args, [{ includeArchived: true }])
  assert.equal((await request('/api/conversations?includeArchived=false', { session: a })).status, 200)
  assert.deepEqual(calls.at(-1).args, [{ includeArchived: false }])
  for (const query of ['includeArchived=1', 'includeArchived=', 'includeArchived=true&includeArchived=false', 'ownerMemberId=a']) assert.equal((await request('/api/conversations?' + query, { session: a })).status, 400)
  for (const session of [admin, b]) {
    assert.deepEqual((await request('/api/conversations', { session })).body.conversations, [])
    for (const [suffix, method, json] of [['', 'GET'], ['', 'PATCH', { title: '越权' }], ['/turns', 'POST', { text: '越权', clientRequestId: 'forbidden' }], ['/turns/turn-one/cancel', 'POST', {}]]) assert.equal((await request(path + suffix, { method, session, json })).status, 404)
  }
  for (const body of [{ employeeId: 'agent', ownerMemberId: 'b' }, { employeeId: 'agent', nativeSessionId: 'native-id' }, { employeeId: 'agent', dshSessionRef: 'native-id' }, { employeeId: 'agent', source: 'web' }]) {
    const count = calls.length
    assert.equal((await request('/api/conversations', { method: 'POST', session: a, json: body })).status, 400)
    assert.equal(calls.length, count)
  }
  assert.equal((await request('/api/conversations', { method: 'POST', session: a, csrf: '', json: { employeeId: 'agent' } })).status, 403)
  assert.equal((await request('/api/conversations', { method: 'POST', session: a, originHeader: 'http://evil.invalid', json: { employeeId: 'agent' } })).status, 403)
  assert.equal((await request('/api/conversations?title=x', { method: 'POST', session: a, json: { employeeId: 'agent' } })).status, 400)
  const created = await request('/api/conversations', { method: 'POST', session: a, json: { employeeId: 'agent', title: '新对话' } })
  assert.equal(created.status, 201)
  assert.deepEqual(calls.at(-1), { method: 'createConversation', memberId: 'a', args: [{ employeeId: 'agent', title: '新对话' }] })
  assert.equal((await request(path, { session: a })).body.historyStatus, 'empty')
  assert.deepEqual(calls.at(-1).args, [summary.id])
  assert.equal((await request(path + '?employeeId=agent', { session: a })).status, 400)
  assert.equal((await request(path, { method: 'PATCH', session: a, json: { title: '改名' } })).body.title, '改名')
  assert.equal((await request(path, { method: 'PATCH', session: a, json: { archived: true } })).body.archivedAt, now)
  assert.equal((await request(path, { method: 'PATCH', session: a, json: { archivedAt: now } })).status, 400)
  const sendBody = { text: '测试消息', clientRequestId: 'request-one' }
  assert.equal((await request(path + '/turns', { method: 'POST', session: a, json: sendBody })).status, 202)
  assert.deepEqual(calls.at(-1), { method: 'sendTurn', memberId: 'a', args: [summary.id, sendBody] })
  replay = true
  assert.equal((await request(path + '/turns', { method: 'POST', session: a, json: sendBody })).status, 200)
  for (const json of [{ ...sendBody, nativeSessionId: 'native-id' }, { ...sendBody, ownerMemberId: 'b' }, { ...sendBody, turnId: 'client-turn' }]) assert.equal((await request(path + '/turns', { method: 'POST', session: a, json })).status, 400)
  const cancelPath = path + '/turns/' + encodeURIComponent(turn.id) + '/cancel'
  const cancelled = await request(cancelPath, { method: 'POST', session: a, json: {} })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.accepted, false)
  assert.equal(cancelled.body.conversation.activeTurnId, 'newer-turn')
  assert.deepEqual(calls.at(-1), { method: 'cancelTurn', memberId: 'a', args: [summary.id, turn.id] })
  assert.equal((await request(cancelPath, { method: 'POST', session: a, json: { turnId: 'newer-turn' } })).status, 400)
  for (const [url, method] of [[path + '/turns', 'GET'], [cancelPath, 'PATCH'], [path, 'DELETE']]) assert.equal((await request(url, { method, session: a, json: method === 'GET' ? undefined : {} })).status, 404)
  for (const [code, expected] of Object.entries({ INVALID_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, HISTORY_UNAVAILABLE: 409, MODEL_NOT_CONFIGURED: 503 })) {
    injectedError = Object.assign(new Error('可公开的业务错误'), { code })
    const result = await request(path, { session: a })
    assert.equal(result.status, expected, code)
    assert.equal(result.body.error.code, code)
  }
  injectedError = new Error('/private/secret detail')
  assert.deepEqual((await request(path, { session: a })).body.error, { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求', status: 500 })
  injectedError = null
  const work = { employeeId: 'agent', skillId: 'skill', capabilityId: 'cycle-time-calculate', conversationId: summary.id, clientRequestId: 'work-one' }
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: work })).body.conversationId, summary.id)
  assert.deepEqual(calls.at(-1), { method: 'createWork', memberId: 'a', args: [work] })
  const collaboration = { ...work, workType: 'collaboration', items: [{ id: 'step-one', employeeId: 'agent', skillId: 'skill', capabilityId: 'cycle-time-calculate', input: {} }] }
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: collaboration })).body.conversationId, summary.id)
  assert.equal(calls.at(-1).method, 'createCollaboration')
  assert.equal(calls.at(-1).args[0].conversationId, summary.id)
  assert.equal(Object.hasOwn(calls.at(-1).args[0], 'workType'), false)
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...collaboration, items: [{ ...collaboration.items[0], conversationId: summary.id }] } })).status, 400)
  for (const key of ['ownerMemberId', 'nativeSessionId', 'dshSessionRef']) assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...work, [key]: 'forbidden' } })).status, 400)
  await shutdownServer(server, service, undefined, undefined, undefined, conversationService)
  assert.deepEqual(lifecycle, ['conversation', 'work'])
  console.log('Conversation HTTP boundary checks passed (synthetic auth/store, injected service; no native/model/browser acceptance)')
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}

function record(method, actor, ...args) { calls.push({ method, memberId: actor.id, args: structuredClone(args) }); if (injectedError) throw injectedError }
function own(actor) { if (actor.id !== 'a') throw Object.assign(new Error('对话不存在'), { code: 'NOT_FOUND' }) }
async function login(name) {
  const result = await request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password: name + ' test password' } })
  assert.equal(result.status, 200)
  return { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken }
}
async function request(path, { method = 'GET', session, json, csrf, originHeader } = {}) {
  const headers = {}
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = csrf ?? session.csrf }
  if (originHeader || session) headers.origin = originHeader ?? origin
  if (json !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(origin + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) })
  const body = await response.text()
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : body }
}

function sourceBetween(start, end) {
  const first = script.indexOf(start), last = script.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, 'Web function boundaries must exist')
  return script.slice(first, last)
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function checkStartupOwnership() {
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  const start = source.slice(source.indexOf('export async function start('), source.indexOf('export function createGenewayServer(')).replace(/^export /, '')
  for (const mode of ['blocked', 'started', 'channel-failure']) {
    const blocked = mode === 'blocked'
    const events = [], original = { conversations: [{ id: 'first-owner', turns: [{ id: 'turn-first', status: 'running', completedAt: null, error: null }, { id: 'turn-accepted', status: 'accepted', completedAt: null, error: null }, { id: 'turn-completed', status: 'completed', completedAt: now, error: null }] }] }
    let snapshot = structuredClone(original), conversation, owned = false
    const memoryStore = { async read() { return structuredClone(snapshot) }, async update(updater) { events.push('store-update'); snapshot = updater(structuredClone(snapshot)); return structuredClone(snapshot) } }
    const work = { async close() { events.push('work-close') } }
    const runner = { async close() { events.push('runner-close') } }, collaborationRunner = { getKnowledgeService: () => ({}), async close() { events.push('host-close') } }
    const automation = { async start() { events.push('owner-lock-attempt'); if (blocked) throw Object.assign(new Error('already running'), { code: 'OWNER_ALREADY_RUNNING' }); owned = true }, async stop() { owned = false }, async close() { events.push('owner-close') }, ownsLock: () => owned }
    const channel = { async start() { events.push('channel-start'); if (mode === 'channel-failure') throw Object.assign(new Error('channel failed'), { code: 'CHANNEL_START_FAILED' }) }, async close() {} }
    const config = { dshHome: '/outside/data/dsh', dataRoot: '/outside/data', secretRoot: '/outside/data/secrets', stateFile: '/outside/data/state.json', connectionCatalogFile: '/outside/connections.json' }
    const box = createContext({ root: '/repository', URL, resolve, relative, sep, join, positivePort: Number, process: { env: { GENEWAY_AUTH_FILE: '/outside/auth.json' }, once() {}, exit() { assert.fail('controlled startup must not exit') } }, console: { log() {} }, readRuntimeConfig: () => config, readGearJobEventRuntimeConfig: async () => null, createFileStore: () => memoryStore, readConnectionCatalog: async () => [], createDshRunner: () => runner, createCollaborationRunner: () => collaborationRunner, createWorkService: () => work, createAuthRuntime: () => ({}), readFile: async () => '<html>', createAutomationService: () => ({}), createAutomationRuntime: () => automation, createChannelRuntime, createChannelSecretStore: () => ({}), createWeixinChannelRuntime: () => ({ async start() {}, async close() {}, async sync() {}, isAvailable: () => false }), createChannelService: () => ({ async recover() {}, async ensureAutomationDeliveries() { return { deliveries: [] } } }), createFeishuRuntime: () => channel, createConversationService(options) {
      conversation = createConversationService({ ...options, clock: () => now })
      const close = conversation.close.bind(conversation)
      conversation.close = async () => { events.push('conversation-close'); await close() }
      return conversation
    }, createGenewayServer(options) {
      assert.equal(options.conversationService, conversation)
      return { listen() { events.push('listen'); assert.equal(owned, true) }, close(callback) { callback() } }
    }, shutdownServer })
    runInContext(start, box)
    if (blocked) {
      await assert.rejects(runInContext('start()', box), error => error.code === 'OWNER_ALREADY_RUNNING')
      assert.deepEqual(snapshot, original, 'failed owner lock and cleanup must preserve the first owner turns')
      assert.equal(events.includes('store-update'), false, 'failed owner lock must not run conversation recovery')
      assert.equal(events.includes('listen'), false)
      assert.equal(events.includes('work-close'), false, 'an unowned instance must not write the shared store during cleanup')
      assert.equal(events.filter(event => event === 'runner-close').length, 1)
      assert.equal(events.filter(event => event === 'host-close').length, 1)
    } else if (mode === 'channel-failure') {
      await assert.rejects(runInContext('start()', box), error => error.code === 'CHANNEL_START_FAILED')
      assert.ok(events.indexOf('conversation-close') < events.indexOf('work-close'))
      assert.ok(events.indexOf('work-close') < events.indexOf('owner-close'), 'owned startup cleanup must finish before releasing the lock')
      assert.equal(events.includes('listen'), false)
    } else {
      const server = await runInContext('start()', box)
      assert.ok(events.indexOf('owner-lock-attempt') < events.indexOf('store-update'), 'conversation recovery must follow the owner lock')
      assert.ok(events.indexOf('store-update') < events.indexOf('listen'), 'recovery must finish before listening')
      assert.deepEqual(snapshot.conversations[0].turns.map(turn => turn.status), ['interrupted', 'interrupted', 'completed'])
      await shutdownServer(server, work, channel, automation, undefined, conversation)
      assert.ok(events.indexOf('conversation-close') < events.indexOf('work-close'), 'conversation tasks close before the shared Host')
      assert.ok(events.indexOf('work-close') < events.indexOf('owner-close'))
    }
  }
  console.log('Startup owner/recovery checks passed (actual start function and conversation service; controlled I/O, no native startup)')
}
async function checkUnownedStoreWrite() {
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  const start = source.slice(source.indexOf('export async function start('), source.indexOf('export function createGenewayServer(')).replace(/^export /, '')
  const definition = { employeeRevision: 1, instructions: '', modelRouteId: 'route' }, fingerprint = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  const turn = { id: 'first-turn', clientRequestId: 'first-request', userText: 'first owner input', status: 'running', createdAt: now, startedAt: now, completedAt: null, error: null, definition, definitionFingerprint: fingerprint, sessionId: 'native-first', userMessageId: 'user-first', assistantMessageIds: [] }
  const conversation = { id: 'first-conversation', ownerMemberId: 'member-admin', employeeId: 'agent', employeeName: 'Agent', title: 'first owner', source: 'web', channelIdentityId: null, createdAt: now, updatedAt: now, archivedAt: null, sessions: [{ id: 'native-first', definitionFingerprint: fingerprint, createdAt: now }], turns: [turn] }
  const file = '/outside/data/state.json', events = [], writeReached = deferred(), releaseWrite = deferred()
  let bytes = JSON.stringify(migrateState({ ...migrateState({ version: 3 }), conversations: [conversation] })), losingWrites = 0
  function memoryFs(instance) {
    // Separate temporary buffers model two processes sharing one committed state file.
    const temporary = new Map()
    return {
      async readFile(path) { assert.equal(path, file); return bytes }, async mkdir() {}, async unlink(path) { temporary.delete(path) },
      async open(path, mode) {
        return { async writeFile(data) { temporary.set(path, String(data)); if (instance === 'loser') { losingWrites++; writeReached.resolve(); await releaseWrite.promise } }, async sync() {}, async close() {} }
      },
      async rename(from, to) { assert.equal(to, file); assert.ok(temporary.has(from)); bytes = temporary.get(from); temporary.delete(from); events.push(instance + '-commit') },
    }
  }
  const firstStore = createFileStore(file, memoryFs('first')), losingStore = createFileStore(file, memoryFs('loser'))
  const runner = { async close() { events.push('runner-close') } }, collaborationRunner = { getKnowledgeService: () => ({}), async close() { events.push('host-close') } }
  const automation = { async start() { throw Object.assign(new Error('already running'), { code: 'OWNER_ALREADY_RUNNING' }) }, async stop() {}, async close() {}, ownsLock: () => false }
  const box = createContext({ root: '/repository', URL, resolve, relative, sep, join, positivePort: Number, process: { env: { GENEWAY_AUTH_FILE: '/outside/auth.json' }, once() {} }, console: { log() {} }, readRuntimeConfig: () => ({ dshHome: '/outside/data/dsh', dataRoot: '/outside/data', secretRoot: '/outside/data/secrets', stateFile: file }), readGearJobEventRuntimeConfig: async () => null, createFileStore: () => losingStore, readConnectionCatalog: async () => [], createDshRunner: () => runner, createCollaborationRunner: () => collaborationRunner, createWorkService: options => createWorkService({ ...options, clock: () => now }), createConversationService: options => createConversationService({ ...options, clock: () => now }), createAuthRuntime: () => ({}), readFile: async () => '<html>', createAutomationService: () => ({}), createAutomationRuntime: () => automation, createChannelRuntime, createChannelSecretStore: () => ({}), createWeixinChannelRuntime: () => ({ async start() {}, async close() {}, async sync() {}, isAvailable: () => false }), createChannelService: () => ({ async recover() {}, async ensureAutomationDeliveries() { return { deliveries: [] } } }), createFeishuRuntime: () => ({ async start() {}, async close() {} }), createGenewayServer() { assert.fail('a losing instance must not listen') } })
  runInContext(start, box)
  const rejectedStartup = runInContext('start()', box).then(() => assert.fail('second instance must fail its owner lock'), error => error)
  // If cleanup starts a stale file-store write, let the first owner commit before its rename.
  await Promise.race([writeReached.promise, rejectedStartup])
  await firstStore.update(state => ({ ...state, conversations: state.conversations.map(item => ({ ...item, turns: item.turns.map(value => ({ ...value, status: 'completed', completedAt: now, assistantMessageIds: ['assistant-first'] })) })) }))
  releaseWrite.resolve()
  assert.equal((await rejectedStartup).code, 'OWNER_ALREADY_RUNNING')
  assert.equal((await firstStore.read()).conversations[0].turns[0].status, 'completed', 'unowned cleanup must not roll back the first owner completion')
  assert.equal(losingWrites, 0, 'failed owner lock must perform zero product file writes')
  assert.deepEqual(events, ['runner-close', 'host-close', 'first-commit'])
  console.log('Unowned cleanup interleaving passed (real work.close and file-store path; in-memory fsOps, no native startup)')
}
async function checkUiRaces() {
  const checks = [checkLateMetadata, () => checkLateRestore(false), () => checkLateRestore(true), checkRestoreDuringLogin]
  const results = await Promise.allSettled(checks.map(check => check()))
  const failed = results.filter(result => result.status === 'rejected')
  for (const result of failed) console.error('UI interleaving check failed:', result.reason.message)
  assert.equal(failed.length, 0, 'UI interleaving checks must pass')
  console.log('Conversation/login UI interleaving checks passed (actual Web functions in a controlled VM; no browser acceptance)')
}
async function checkLateMetadata() {
  const rename = deferred(), timers = new Set(), cancels = []
  const idle = { id: 'A', title: 'saved title', employeeId: 'agent', updatedAt: now, readOnlyReason: null, activeTurnId: null, turns: [], historyStatus: 'empty', relatedWorks: [] }
  const running = { ...idle, activeTurnId: 'turn-new', historyStatus: 'available', turns: [{ id: 'turn-new', status: 'running', userText: 'hello', assistantText: null }] }
  let latest = running
  const state = { authEpoch: 1, view: 'conversations', currentConversation: structuredClone(idle), conversations: [structuredClone(idle)], selectedConversationId: 'A', conversationReadRequest: 0, conversationSelection: 1, poll: null }
  const draft = { text: 'hello', request: null, renaming: false, archiving: false, sending: false }
  const box = createContext({ state, el: () => ({ scrollTop: 0, scrollHeight: 0 }), conversationDraft: () => draft, requestId: () => 'request-one', renderConversation() {}, setMessage() {}, byId: (items, id) => items?.find(item => item.id === id), rememberConversation: item => { state.conversations = [item] }, stopPolling() { timers.clear(); state.poll = null }, setInterval() { timers.add(1); return 1 }, api: async (path, options = {}) => {
    if (options.method === 'PATCH') return rename.promise
    if (path.endsWith('/cancel')) {
      cancels.push(path)
      const turn = { ...running.turns[0], status: 'cancelled' }
      latest = { ...running, activeTurnId: null, turns: [turn] }
      return { accepted: true, conversation: latest, turn }
    }
    if (options.method === 'POST') return { conversation: running, turn: running.turns[0], deduplicated: false }
    return structuredClone(latest)
  } })
  runInContext(sourceBetween('async function updateConversation(', 'function startConversationWork('), box)
  runInContext(sourceBetween('async function refreshConversation(', 'const conversationReadOnlyMessages='), box)
  const pendingRename = runInContext('updateConversation({title:"saved title"})', box)
  await runInContext('sendConversationTurn()', box)
  assert.equal(state.currentConversation.activeTurnId, 'turn-new')
  assert.equal(timers.size, 1)
  draft.text = 'next message draft'
  rename.resolve(structuredClone(idle))
  await pendingRename
  assert.equal(state.currentConversation.activeTurnId, 'turn-new', 'late title PATCH must retain the running turn')
  assert.equal(state.currentConversation.turns.map(item => item.id).join(','), 'turn-new')
  assert.equal(timers.size, 1, 'late title PATCH must retain polling')
  assert.equal(draft.text, 'next message draft')
  await runInContext('stopConversationTurn("A",state.currentConversation.activeTurnId)', box)
  assert.deepEqual(cancels, ['/api/conversations/A/turns/turn-new/cancel'])
  assert.equal(state.currentConversation.turns[0].status, 'cancelled')
  assert.equal(draft.text, 'next message draft')
}
function loginVm(restore, post = deferred()) {
  const state = { authEpoch: 0, session: null, csrf: null }, loginErrors = [], nodes = new Map()
  const a = { member: { id: 'A' }, csrfToken: 'csrf-A' }, b = { member: { id: 'B' }, csrfToken: 'csrf-B' }
  const box = createContext({ state, a, b, clearConversationState() {}, routeFromUrl() {}, showLogin: note => loginErrors.push(note), setMessage() {}, el(id) { if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, classList: { add() {}, remove() {} } }); return nodes.get(id) }, api: async (_path, options = {}) => options.method === 'POST' ? post.promise : restore.promise, reloadAll: async () => { state.session = b.member } })
  runInContext(sourceBetween('async function enterApp(', 'function show('), box)
  return { box, state, a, b, nodes, loginErrors }
}
async function checkLateRestore(reject) {
  const restore = deferred(), { box, state, a, loginErrors } = loginVm(restore)
  const pending = runInContext('restoreSession()', box)
  await runInContext('enterApp(b)', box)
  if (reject) restore.reject(Object.assign(new Error('old restore failed'), { status: 503 })); else restore.resolve(a)
  await pending
  assert.equal(state.session.id, 'B')
  assert.equal(state.csrf, 'csrf-B', 'late session restore must not replace the new login CSRF')
  assert.equal(loginErrors.length, 0, 'late restore failure must not log out the new member')
}
async function checkRestoreDuringLogin() {
  const restore = deferred(), post = deferred(), { box, state, a, b, nodes } = loginVm(restore, post)
  runInContext(sourceBetween("el('login-form').onsubmit=", "el('logout').onclick="), box)
  const pendingRestore = runInContext('restoreSession()', box)
  const pendingLogin = nodes.get('login-form').onsubmit({ preventDefault() {} })
  restore.resolve(a)
  await pendingRestore
  assert.equal(state.session, null, 'starting explicit login must invalidate the old session restore')
  assert.equal(state.csrf, null)
  post.resolve(b)
  await pendingLogin
  assert.equal(state.session.id, 'B')
  assert.equal(state.csrf, 'csrf-B')
}
