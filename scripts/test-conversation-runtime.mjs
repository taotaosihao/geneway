import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createCollaborationRunner, CONVERSATION_WORK_TOOLS } from '../src/collaboration-runner.mjs'
import { createConversationService, newConversationRecord } from '../src/conversation-service.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const execFile = promisify(execFileCallback), root = process.cwd(), temp = await mkdtemp(join(tmpdir(), 'geneway-conversation-runtime-'))
const dshHome = join(temp, 'dsh'), secretRoot = join(temp, 'secrets'), stateFile = join(temp, 'state.json')
const saved = Object.fromEntries(['HOME', 'DSH_HOME', 'GENEWAY_DSH_HOME', 'GENEWAY_SECRET_ROOT', 'GENEWAY_MODEL_CREDENTIAL_REF'].map(key => [key, process.env[key]]))
const modelKey = 'synthetic-conversation-model-key', model = readRuntimeConfig({}).model.model, secondModel = 'z-ai/glm-5.3-flash'
const actor = { id: 'member-a' }, peer = { id: 'member-b' }, admin = { id: 'admin' }
const store = createFileStore(stateFile), capture = await startCapture()
let chat, work, collaborationRunner, sdkRunner, hosts = 0, harnesses = 0, failure, report
let revokeOnRead
try {
  process.env.HOME = temp
  process.env.DSH_HOME = dshHome
  process.env.GENEWAY_DSH_HOME = dshHome
  process.env.GENEWAY_SECRET_ROOT = secretRoot
  process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'model.key'), modelKey, { mode: 0o600 })
  const patch = join(temp, 'capture.patch.yml')
  const providerPatch = `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local conversation capture\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: ${capture.address}/v1\n        compat:\n          supportsUsageInStreaming: true\n          supportsFinishReason: true\n          maxTokensField: max_tokens\n        retryPolicy:\n          mode: normal\n          maxRetries: 8\n          backoff:\n            initialDelayMs: 5\n            maxDelayMs: 10\n            jitterRatio: 0\n        models:\n          - id: ${model}\n            contextWindow: 200000\n            maxTokens: 4096\n          - id: ${secondModel}\n            contextWindow: 1000000\n            maxTokens: 4096\n`
  await writeFile(patch, `- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n${providerPatch}`, { mode: 0o600 })
  await writeFile(join(temp, 'sdk-capture.patch.yml'), providerPatch, { mode: 0o600 })
  await writeFile(join(temp, 'host.patch.yml'), `${await readFile(join(root, 'config/p3-runtime.patch.yml'), 'utf8')}\n${await readFile(patch, 'utf8')}`, { mode: 0o600 })
  await store.update(state => ({ ...state,
    members: [member(actor.id, ['public', 'private']), member(peer.id, ['public']), { ...member(admin.id, ['public']), role: 'admin' }],
    employees: ['public', 'private'].map(id => ({ id, name: id, enabled: true, modelRouteId: id === 'private' ? 'route-glm' : 'route', revision: 1, instructions: 'INSTRUCTION_V1', skillIds: ['skill-cycle-time-calculate'], connectionIds: [] })),
    modelRoutes: [{ id: 'route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', enabled: true }, { id: 'route-glm', provider: 'zenmux', model: secondModel, credentialRef: 'ZENMUX_API_KEY', enabled: true, parameters: { maxOutputTokens: 64 } }],
    skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true }],
  }))
  createServices()
  await chat.ensureReady()
  if (process.argv.includes('--shutdown-probe')) await shutdownProbe()
  else if (process.argv.includes('--channel-work-only')) await channelWorkChecks()
  else {
  const a = await chat.createConversation(actor, { employeeId: 'public' }), b = await chat.createConversation(peer, { employeeId: 'public' })
  const a2 = await chat.createConversation(actor, { employeeId: 'public' })
  assert.equal(a.historyStatus, 'empty')
  assert.equal(hosts, 0, 'empty conversations must not boot a native Host')
  await modelAndBudgetChecks()
  await turn(a.id, 'CANARY_MEMBER_A', 'a-one')
  const firstSession = (await store.read()).conversations.find(item => item.id === a.id).sessions[0].id
  await turn(b.id, 'CANARY_MEMBER_B', 'b-one', peer)
  assert.equal(capture.requests.at(-1).serialized.includes('CANARY_MEMBER_A'), false)
  await turn(a2.id, 'CANARY_SECOND_A', 'a2-one')
  assert.equal(capture.requests.at(-1).serialized.includes('CANARY_MEMBER_A'), false)
  await turn(a.id, 'continue A', 'a-two')
  assert.equal(capture.requests.at(-1).serialized.includes('CANARY_MEMBER_A'), true)
  assert.equal((await store.read()).conversations.find(item => item.id === a.id).sessions.length, 1)
  const count = capture.requests.length
  const replay = await chat.sendTurn(actor, a.id, { text: 'continue A', clientRequestId: 'a-two' })
  assert.equal(replay.deduplicated, true)
  assert.equal(capture.requests.length, count)
  await assert.rejects(chat.sendTurn(actor, a.id, { text: 'different', clientRequestId: 'a-two' }), { code: 'IDEMPOTENCY_CONFLICT' })
  for (const stranger of [peer, admin]) {
    await assert.rejects(chat.getConversation(stranger, a.id), { code: 'NOT_FOUND' })
    await assert.rejects(chat.sendTurn(stranger, a.id, { text: 'forbidden', clientRequestId: 'guess' }), { code: 'NOT_FOUND' })
  }

  const held = await chat.sendTurn(actor, a.id, { text: 'HOLD:DEFINITION', clientRequestId: 'a-three' })
  await capture.waitFor('HOLD:DEFINITION')
  await changeInstructions(2)
  assert.equal(capture.requests.at(-1).serialized.includes('INSTRUCTION_V1'), true)
  assert.equal(capture.requests.at(-1).serialized.includes('INSTRUCTION_V2'), false)
  capture.release('HOLD:DEFINITION')
  await waitTurn(a.id, held.turn.id, 'completed')
  await turn(a.id, 'AFTER_EDIT_CANARY', 'a-four')
  const afterEdit = capture.requests.at(-1)
  assert.equal(afterEdit.serialized.includes('INSTRUCTION_V2'), true)
  assert.equal(afterEdit.serialized.includes('CANARY_MEMBER_A'), false)
  assert.equal(afterEdit.serialized.includes('HOLD:DEFINITION'), false)
  assert.equal((await store.read()).conversations.find(item => item.id === a.id).sessions.length, 2)
  assert.equal(hosts, 1, 'chat and work collaboration share a single in-process Host')

  const stopped = await chat.sendTurn(actor, a.id, { text: 'HOLD:STOP_A', clientRequestId: 'a-stop' })
  const independent = await chat.sendTurn(actor, a2.id, { text: 'HOLD:INDEPENDENT', clientRequestId: 'a2-hold' })
  await Promise.all([capture.waitFor('HOLD:STOP_A'), capture.waitFor('HOLD:INDEPENDENT')])
  assert.equal((await chat.cancelTurn(actor, a.id, stopped.turn.id)).turn.status, 'cancelled')
  assert(capture.pending.has('HOLD:INDEPENDENT'))
  capture.release('HOLD:INDEPENDENT')
  await waitTurn(a2.id, independent.turn.id, 'completed')
  const later = await chat.sendTurn(actor, a.id, { text: 'HOLD:LATER', clientRequestId: 'a-later' })
  await capture.waitFor('HOLD:LATER')
  assert.equal((await chat.cancelTurn(actor, a.id, stopped.turn.id)).accepted, false)
  assert(capture.pending.has('HOLD:LATER'))

  const w1 = await work.createWork(actor, workBody(a.id, 64, 2, 'work-one'))
  const w2 = await work.createWork(actor, workBody(a.id, 66, 3, 'work-two'))
  assert.equal(w1.ok, true); assert.equal(w2.ok, true)
  assert.equal(w1.value.conversationId, a.id)
  await Promise.all([capture.waitFor('WORK:64'), capture.waitFor('WORK:66')])
  await work.cancel(actor, w1.value.id)
  assert(capture.pending.has('WORK:66'))
  assert(capture.pending.has('HOLD:LATER'), 'stopping a work must not stop its conversation reply')
  capture.release('WORK:66')
  const completedWork = await waitWork(w2.value.id, 'completed')
  assert.equal(completedWork.results[0].payload.secondsPerUnit, 22)
  capture.release('HOLD:LATER')
  await waitTurn(a.id, later.turn.id, 'completed')
  const related = await chat.getConversation(actor, a.id)
  assert.deepEqual(new Set(related.relatedWorks.map(item => item.id)), new Set([w1.value.id, w2.value.id]))
  await assert.rejects(work.createWork(peer, workBody(a.id, 60, 2, 'wrong-owner')), { code: 'NOT_FOUND' })
  await assert.rejects(work.createWork(actor, { ...workBody(a.id, 60, 2, 'wrong-agent'), employeeId: 'private' }), { code: 'FORBIDDEN' })
  assert.equal(JSON.stringify(related).includes(firstSession), false)
  assert(capture.requests.filter(request => request.chat).every(request => request.tools.length === 0))

  const privateChat = await chat.createConversation(actor, { employeeId: 'private' })
  await turn(privateChat.id, 'PRIVATE_OWNER_HISTORY', 'private-one')
  await store.update(state => ({ ...state, members: state.members.map(item => item.id === actor.id ? { ...item, employeeIds: ['public'] } : item) }))
  assert.equal((await chat.getConversation(actor, privateChat.id)).readOnlyReason, 'AGENT_ACCESS_REVOKED')
  await assert.rejects(chat.sendTurn(actor, privateChat.id, { text: 'blocked', clientRequestId: 'private-two' }), { code: 'FORBIDDEN' })

  await chat.close(); await work.close()
  createServices()
  await chat.ensureReady()
  assert.equal((await chat.getConversation(actor, a.id)).historyStatus, 'available')
  await turn(a.id, 'AFTER_HOST_RESTART', 'a-restart')
  assert.equal(capture.requests.at(-1).serialized.includes('AFTER_EDIT_CANARY'), true)
  assert.equal(capture.requests.at(-1).serialized.includes('CANARY_MEMBER_B'), false)
  await store.update(state => ({ ...state, conversations: state.conversations.map(item => item.id === a.id ? { ...item, turns: [...item.turns, {
    ...item.turns.at(-1), id: 'interrupted-fixture', clientRequestId: 'never-replay', userText: 'DO_NOT_REPLAY', status: 'accepted', startedAt: null, completedAt: null, error: null, userMessageId: null, assistantMessageIds: [],
  }] } : item) }))
  await chat.close(); await work.close()
  createServices()
  const beforeRecovery = capture.requests.length
  await chat.ensureReady()
  assert.equal(capture.requests.length, beforeRecovery)
  const history = await chat.getConversation(actor, a.id)
  assert.equal(history.turns.find(item => item.id === 'interrupted-fixture').status, 'interrupted')
  await turn(a.id, 'AFTER_INTERRUPTION', 'a-after-interrupted')
  assert.equal(capture.requests.at(-1).serialized.includes('DO_NOT_REPLAY'), false)
  assert.equal(capture.requests.at(-1).serialized.includes('AFTER_HOST_RESTART'), false)
  assert.equal((await store.read()).version, STATE_VERSION)

  const backup = join(temp, 'backup')
  await execFile(process.execPath, ['scripts/state-transfer.mjs', 'backup', '--output', backup], { cwd: root, env: { ...process.env, GENEWAY_STATE: stateFile } })
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema.stateVersion, STATE_VERSION)
  assert.equal(manifest.schema.conversations, (await store.read()).conversations.length)
  for (const conversation of (await store.read()).conversations) for (const session of conversation.sessions) assert(manifest.schema.sessionRefs.includes(session.id))
  assert(manifest.entries.every(entry => entry.path === 'state.json' || entry.path.startsWith('dsh/sessions/')))
  assert.equal((await readFile(join(backup, 'state.json'), 'utf8')).includes(modelKey), false)
  await chat.close(); await work.close()
  createServices()
  await chat.ensureReady()
  await rename(join(dshHome, 'sessions'), join(temp, 'hidden-sessions'))
  const unavailable = await chat.getConversation(actor, a.id)
  assert.equal(unavailable.historyStatus, 'unavailable')
  assert.equal(unavailable.turns.find(item => item.id === later.turn.id).status, 'completed')
  await assert.rejects(chat.sendTurn(actor, a.id, { text: 'no silent fresh', clientRequestId: 'missing-history' }), { code: 'HISTORY_UNAVAILABLE' })
  await rename(join(temp, 'hidden-sessions'), join(dshHome, 'sessions'))
  assert.equal(capture.requests.every(request => [model, secondModel].includes(request.model) && !request.credentialLeak && !request.sessionLog), true)
  report = { ok: true, mode: 'native-controlled-loopback', actualProvider: 'local capture', requestedModel: model, requestedModels: [...new Set(capture.requests.map(request => request.model))], routingAndBudget: capture.routingAndBudget ?? null, nativeHosts: hosts, nativeSdkHarnesses: harnesses, modelRequests: capture.requests.length,
    emptyConversation: true, ownerAndSessionIsolation: true, frozenInstructions: true, cleanSuccessor: true, nativeRestartHistory: true, interruptedNotReplayed: true, exactTurnCancellation: true, workCancellationIndependent: true, relatedWorks: 2, conversationBackup: true, completedWithMissingHistory: true, chatBusinessTools: [], credentialCanaryLeaks: 0, sessionLogAttachments: 0 }
  }
} catch (error) { failure = error }
finally {
  for (const cleanup of [() => chat?.close(), () => work ? work.close() : collaborationRunner?.close(), () => capture.close(), () => rm(temp, { recursive: true, force: true })]) {
    try { await cleanup() } catch (error) { failure = failure ? new AggregateError([failure, error], 'conversation runtime and cleanup failed', { cause: failure }) : error }
  }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))

async function modelAndBudgetChecks() {
  const glm = await chat.createConversation(actor, { employeeId: 'private' })
  await turn(glm.id, 'GLM_CHAT_FIRST_CANARY', 'glm-first')
  assert.equal(capture.requests.at(-1).model, secondModel)
  assert.equal(capture.requests.at(-1).maxTokens, 64)
  const created = await work.createWork(actor, { employeeId: 'private', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: 'glm-work' })
  assert.equal(created.ok, true)
  const completed = await waitWork(created.value.id, 'completed')
  assert.equal(completed.executions.at(-1).runtime.model, secondModel)
  assert.equal(completed.executions.at(-1).runtime.requestCount, 2)
  assert.equal(capture.requests.at(-1).maxTokens, 64)
  await store.update(state => ({ ...state, modelRoutes: state.modelRoutes.map(route => route.id === 'route-glm' ? { ...route, parameters: { maxOutputTokens: 128 } } : route) }))
  await turn(glm.id, 'GLM_CHAT_AFTER_CAP_CHANGE', 'glm-after-cap')
  assert.equal(capture.requests.at(-1).maxTokens, 128)
  assert.equal(capture.requests.at(-1).serialized.includes('GLM_CHAT_FIRST_CANARY'), false)
  assert.equal((await store.read()).conversations.find(item => item.id === glm.id).sessions.length, 2)
  const mixed = await work.createCollaboration(actor, { employeeId: 'public', skillId: 'skill-cycle-time-calculate', goal: '跨模型节拍核对', clientRequestId: 'mixed-model', items: [{ id: 'item-mixed-model', employeeId: 'private', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 180, quantity: 3 } }] })
  assert.equal(mixed.ok, true)
  await waitWork(mixed.value.id, 'completed')
  const child = (await store.read()).works.find(item => item.rootWorkId === mixed.value.id)
  assert.equal(child.executions.at(-1).runtime.model, secondModel)
  assert.equal((await store.read()).works.find(item => item.id === mixed.value.id).executions.at(-1).runtime.model, model)
  const beforeWork = capture.requests.length
  const limitedWork = await work.createWork(actor, { employeeId: 'public', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 777, quantity: 2 }, clientRequestId: 'budget-work' })
  let failedWork
  await waitFor(async () => { failedWork = (await store.read()).works.find(item => item.id === limitedWork.value.id); return failedWork.status === 'failed' })
  assert.equal(capture.requests.length - beforeWork, 4)
  assert.equal(failedWork.executions.at(-1).error.code, 'BUDGET_EXHAUSTED')
  assert.equal(failedWork.executions.at(-1).runtime.requestCount, 4)
  assert(Object.values(failedWork.executions.at(-1).runtime.usage).every(value => value === null))
  const beforeChat = capture.requests.length
  const budgetChat = await chat.createConversation(actor, { employeeId: 'public' })
  const admitted = await chat.sendTurn(actor, budgetChat.id, { text: 'BUDGET_CHAT_CANARY', clientRequestId: 'budget-chat' })
  let failedTurn
  await waitFor(async () => { failedTurn = (await store.read()).conversations.find(item => item.id === budgetChat.id).turns.find(item => item.id === admitted.turn.id); return failedTurn.status === 'failed' })
  assert.equal(capture.requests.length - beforeChat, 6)
  assert.equal(failedTurn.error.code, 'BUDGET_EXHAUSTED')
  assert.equal(failedTurn.runtime.requestCount, 6)
  assert.equal(failedTurn.runtime.terminationReason, 'BUDGET_EXHAUSTED')
  assert(capture.requests.every(request => request.maxTokens <= 4096))
  capture.routingAndBudget = { twoApprovedRoutes: true, sdkAndChatGlm: true, mixedCollaboration: true, capChangeCleanSuccessor: true, ordinaryWireRequestsAtBudget: 4, chatWireRequestsAtBudget: 6, budgetFailureUsageUnknown: true, requestCapsExplicit: true }
}

function createServices() {
  const config = readRuntimeConfig({ ...process.env, GENEWAY_STATE: stateFile }, root)
  collaborationRunner = createCollaborationRunner({ store, root, dshHome, getWorkService: () => ({ ...work, async getWork(...args) {
    const value = await work.getWork(...args)
    if (args[1] === revokeOnRead) await store.update(state => ({ ...state, members: state.members.map(item => item.id === actor.id ? { ...item, employeeIds: [] } : item) }))
    return value
  } }), patchPath: join(temp, 'host.patch.yml'), testHooks: { onKivoMounted() { hosts += 1 } } })
  sdkRunner = createDshRunner({ root, config, harnessFactory: options => {
    harnesses += 1
    return new DeepSeekHarness({ ...options, patches: [...options.patches, join(temp, 'sdk-capture.patch.yml')], env: { ...options.env, ...auditEnvironment() } })
  } })
  chat = createConversationService({ store, runner: collaborationRunner })
  work = createWorkService({ store, runner: sdkRunner, collaborationRunner, policyPaths: { stateFile, dataRoot: temp, secretRoot } })
}
function auditEnvironment() {
  // The current audit injects --import and its binding only at the verified SDK spawn.
  if (process.env.GENEWAY_NETWORK_AUDIT_ROLE === 'host') return {}
  return Object.fromEntries(['NODE_OPTIONS', 'GENEWAY_NETWORK_AUDIT_LOG', 'GENEWAY_NETWORK_SECRET_CANARY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
}
async function shutdownProbe() {
  assert.equal(typeof process.send, 'function', '--shutdown-probe requires its isolated IPC launcher')
  let finish, reject, stopping = false
  const stopped = new Promise((resolve, fail) => { finish = resolve; reject = fail })
  // This test handler mirrors Geneway's service-close order; it is not server.start() acceptance.
  const stop = () => {
    if (stopping) return
    stopping = true
    Promise.resolve().then(async () => { await chat.close(); await work.close() }).then(finish, reject)
  }
  process.once('SIGTERM', stop)
  try {
    const conversation = await chat.createConversation(actor, { employeeId: 'public' })
    await turn(conversation.id, 'SHUTDOWN_PROBE_BOOT', 'shutdown-chat')
    const works = await Promise.all([60, 62].map((seconds, index) => work.createWork(actor, workBody(conversation.id, seconds, 2, `shutdown-work-${index}`))))
    assert(works.every(result => result.ok))
    await Promise.all(works.map(result => waitWork(result.value.id, 'completed')))
    assert.equal(hosts, 1); assert.equal(harnesses, 2)
    assert.equal(capture.requests.filter(request => request.chat).length, 1)
    assert(capture.requests.every(request => !request.credentialLeak && !request.sessionLog))
    const fixturePatchHashes = await Promise.all(['host.patch.yml', 'sdk-capture.patch.yml'].map(async name => ({ name, sha256: createHash('sha256').update(await readFile(join(temp, name))).digest('hex') })))
    process.send({ kind: 'shutdown-probe-ready', pid: process.pid, temp, nativeHosts: hosts, nativeSdkHarnesses: harnesses, modelRequests: capture.requests.length, fixturePatchHashes })
    await stopped
    report = { ok: true, mode: 'native-controlled-loopback-shutdown', signal: 'SIGTERM', shutdownHandler: 'test-service-order-equivalent', serverStartAcceptance: false,
      actualProvider: 'local capture', nativeHosts: hosts, nativeSdkHarnesses: harnesses, modelRequests: capture.requests.length, servicesClosed: true }
  } finally { process.off('SIGTERM', stop); if (process.connected) process.disconnect() }
}
async function channelWorkChecks() {
  const now = new Date().toISOString(), tools = CONVERSATION_WORK_TOOLS
  rejectedToolTurnChecks()
  await store.update(state => {
    const bound = { ...state,
      channelApps: [{ id: 'synthetic-app', provider: 'feishu', providerAppId: 'synthetic-app', providerTenantId: 'synthetic-tenant', credentialRef: 'synthetic-no-platform-secret', enabled: true, status: 'active', revision: 1, allowedScopes: ['result'], createdAt: now, updatedAt: now }],
      channelIdentities: [{ id: 'synthetic-identity', channelAppId: 'synthetic-app', providerUserId: 'synthetic-user', memberId: actor.id, verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: now, updatedAt: now }],
    }
    return { ...bound, conversations: [newConversationRecord(bound, actor, { id: 'synthetic-channel-conversation', employeeId: 'public', source: 'feishu', channelIdentityId: 'synthetic-identity' }, now)] }
  })
  const id = 'synthetic-channel-conversation', plain = await chat.createConversation(actor, { employeeId: 'public' })
  await turn(plain.id, 'PLAIN_WEB_NO_WORK', 'plain-web')
  assert.deepEqual(capture.requests.at(-1).tools, [])
  assert.equal((await store.read()).works.length, 0)
  await turn(id, 'PLAIN_CHANNEL_NO_WORK', 'plain-channel')
  assert.deepEqual(capture.requests.at(-1).tools.sort(), Object.values(tools).sort())
  assert.equal((await store.read()).works.length, 0)

  const partial = { skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60 } }
  await operation('create-partial', tools.create, partial)
  const first = (await store.read()).works[0]
  assert.equal(first.status, 'waiting_input'); assert.deepEqual(first.requiredInputs, ['quantity'])
  assert.equal(first.conversationId, id); assert.equal(first.ownerMemberId, actor.id)
  const beforeReplay = capture.requests.length
  assert.equal((await chat.sendTurn(actor, id, { text: command(tools.create, partial), clientRequestId: 'create-partial' })).deduplicated, true)
  assert.equal(capture.requests.length, beforeReplay)
  await operation('owner-injection', tools.create, { ...partial, ownerMemberId: peer.id })
  assert.equal((await store.read()).works.length, 1)
  await operation('complete-input', tools.continue, { workId: first.id, input: { quantity: 2 } })
  const completed = await waitWork(first.id, 'completed')
  assert.equal(completed.results[0].payload.secondsPerUnit, 30)
  const beforeFacts = capture.requests.length
  await operation('read-facts', tools.status, { workId: first.id })
  const factsTurn = (await store.read()).conversations.find(item => item.id === id).turns.at(-1)
  assert.deepEqual(factsTurn.workDependencyRefs, [{ workId: first.id, resultId: completed.results[0].id, connectionRevision: null }])
  const factRequest = capture.requests.slice(beforeFacts).find(item => item.hasToolResult)
  assert(factRequest?.serialized.includes('secondsPerUnit'))
  assert.equal(factRequest.serialized.includes(completed.results[0].dshSessionRef), false)
  await operation('fact-follow-up', tools.followUp, { workId: first.id, text: '这份节拍依据是什么？' })
  const followed = await waitWork(first.id, 'completed')
  assert.equal(followed.results.length, 2)
  assert.equal(followed.results.at(-1).kind, 'assistant.follow-up')
  const outside = await work.createWork(actor, { ...workBody(plain.id, 60, 2, 'outside-fixture'), input: {} })
  await operation('wrong-conversation', tools.status, { workId: outside.value.id })
  assert(capture.requests.at(-1).serialized.includes('FORBIDDEN'))
  await operation('selection', tools.status, {})
  assert(capture.requests.at(-1).serialized.includes('requiresSelection'))

  await operation('held-w1', tools.create, { skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 64, quantity: 2 } })
  await capture.waitFor('WORK:64')
  await operation('held-w2', tools.create, { skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 66, quantity: 3 } })
  await capture.waitFor('WORK:66')
  const held = (await store.read()).works.filter(item => [64, 66].includes(item.input.availableSeconds))
  const w1 = held.find(item => item.input.availableSeconds === 64), w2 = held.find(item => item.input.availableSeconds === 66)
  await operation('stop-w1', tools.stop, { workId: w1.id })
  await waitWork(w1.id, 'cancelled')
  assert(capture.pending.has('WORK:66'))
  capture.release('WORK:66'); await waitWork(w2.id, 'completed')
  assert.equal(hosts, 1)

  // Revoke between the existing service read and the product tool's fact commit.
  const beforeLate = capture.requests.length
  revokeOnRead = first.id
  const admitted = await chat.sendTurn(actor, id, { text: command(tools.status, { workId: first.id }), clientRequestId: 'late-revocation' })
  let late
  await waitFor(async () => { late = (await store.read()).conversations.find(item => item.id === id).turns.find(item => item.id === admitted.turn.id); return !['accepted', 'running'].includes(late.status) })
  assert.equal(late.status, 'failed'); assert.equal(late.error.code, 'FORBIDDEN')
  assert.equal(capture.requests.length - beforeLate, 1, 'revocation must block the model continuation after a rejected tool result')
  const [lateHistory] = await collaborationRunner.readChatHistory([late.sessionId])
  const latePublic = (await chat.getConversation(actor, id)).turns.find(item => item.id === late.id)
  const rejectedToolTurn = assertRejectedToolTurn({ turn: late, history: lateHistory, publicTurn: latePublic, toolName: tools.status, workId: first.id }, evidence => console.log(JSON.stringify({ kind: 'rejected-tool-turn-evidence', ...evidence })))
  assert(capture.requests.every(item => [model, secondModel].includes(item.model) && !item.credentialLeak && !item.sessionLog))
  report = { ok: true, mode: 'native-controlled-loopback-channel-work', actualProvider: 'local capture', requestedModel: model, requestedModels: [...new Set(capture.requests.map(request => request.model))], routingAndBudget: capture.routingAndBudget ?? null, nativeHosts: hosts, nativeSdkHarnesses: harnesses, modelRequests: capture.requests.length,
    fixedProductTools: Object.values(tools), webTools: [], plainChatWorks: 0, partialInputWithoutExecution: true, continuationSameWork: true, replayWithoutRequest: true, ownerInjectionRejected: true, sameConversationOnly: true,
    factsCommittedBeforeModel: true, nativeIdsExcludedFromToolOutput: true, factualFollowUpWithoutRefresh: true, explicitSelection: true, independentWorkStop: true, lateRevocationBlocksContinuation: true, failedTurnPersisted: true, rejectedToolTurn, credentialCanaryLeaks: 0, sessionLogAttachments: 0,
  }
  function command(name, args) { return `CHANNEL_WORK:${JSON.stringify({ name, args })}` }
  async function operation(request, name, args) { return turn(id, command(name, args), request) }
}
function assertRejectedToolTurn({ turn, history, publicTurn, toolName, workId }, onEvidence) {
  assert.equal(history.status, 'available'); assert.equal(history.sessionId, turn.sessionId)
  const user = history.events.findIndex(event => event.type === 'user/message' && event.data?.id === turn.userMessageId)
  assert(user >= 0)
  const number = history.events.slice(0, user + 1).findLast(event => event.type === 'turn/start')?.data.turn
  assert(Number.isSafeInteger(number))
  const next = history.events.findIndex((event, index) => index > user && event.type === 'turn/start')
  const events = history.events.slice(user, next < 0 ? undefined : next)
  const assistants = events.filter(event => event.type === 'assistant/message')
  const calls = events.filter(event => event.type === 'tool/call'), results = events.filter(event => event.type === 'tool/result')
  onEvidence?.({ eventTypes: events.map(event => event.type), assistantContentTypes: assistants.map(event => event.data.message.content.map(block => block.type)), storedIdsMatch: JSON.stringify(assistants.map(event => event.data.message.id)) === JSON.stringify(turn.assistantMessageIds), publicAssistantTextNull: publicTurn.assistantText === null })
  assert.equal(assistants.length, 1); assert.equal(assistants[0].data.turn, number)
  assert.deepEqual(assistants.map(event => event.data.message.id), turn.assistantMessageIds)
  const content = assistants[0].data.message.content
  assert.equal(content.length, 1); assert.equal(content[0].type, 'tool-call')
  assert.equal(content[0].name, toolName); assert.deepEqual(JSON.parse(content[0].arguments), { workId })
  assert.equal(calls.length, 1); assert.equal(calls[0].data.callId, content[0].id)
  assert.equal(calls[0].data.name, toolName); assert.deepEqual(JSON.parse(calls[0].data.arguments), { workId })
  assert.equal(results.length, 1)
  const message = results[0].data.message
  assert.equal(message.role, 'tool'); assert.equal(message.source.kind, 'tool')
  assert.equal(message.source.callId, content[0].id); assert.equal(message.toolCallId, content[0].id)
  assert.equal(message.content.length, 1); assert.equal(message.content[0].type, 'text')
  const value = JSON.parse(message.content[0].text)
  assert.deepEqual(Object.keys(value).sort(), ['error', 'ok']); assert.equal(value.ok, false)
  assert.deepEqual(Object.keys(value.error).sort(), ['code', 'message'])
  assert.equal(value.error.code, 'FORBIDDEN')
  assert.equal(value.error.message, '工作操作未完成，请核对当前会话的明确工作、技能、连接和输入；其他工作请到 Web 继续。')
  assert.equal(publicTurn.id, turn.id); assert.equal(publicTurn.status, 'failed')
  assert.equal(publicTurn.error.code, 'FORBIDDEN'); assert.equal(publicTurn.assistantText, null)
  return { exactNativeTurn: true, storedIdsMatched: true, toolCallOnly: true, noAssistantText: true, forbiddenResultWithoutFacts: true, publicAssistantTextNull: true }
}
function rejectedToolTurnChecks() {
  const toolName = 'geneway_work_status', workId = 'synthetic-work', callId = 'synthetic-call', args = JSON.stringify({ workId })
  const fixture = { turn: { id: 'turn', sessionId: 'session', userMessageId: 'user', assistantMessageIds: ['assistant'] }, publicTurn: { id: 'turn', status: 'failed', error: { code: 'FORBIDDEN' }, assistantText: null }, toolName, workId,
    history: { status: 'available', sessionId: 'session', events: [
      { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: 'old-user' } }, { type: 'assistant/message', data: { turn: 1, message: { id: 'old-assistant', content: [{ type: 'text', text: 'OLD_FACT' }] } } },
      { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { id: 'user' } },
      { type: 'assistant/message', data: { turn: 2, message: { id: 'assistant', content: [{ type: 'tool-call', id: callId, name: toolName, arguments: args }] } } },
      { type: 'tool/call', data: { callId, name: toolName, arguments: args } },
      { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '工作操作未完成，请核对当前会话的明确工作、技能、连接和输入；其他工作请到 Web 继续。' } }) }] } } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } },
      { type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', data: { id: 'next-user' } }, { type: 'assistant/message', data: { turn: 3, message: { id: 'next-assistant', content: [{ type: 'text', text: 'LATER_FACT' }] } } },
    ] },
  }
  assert.equal(assertRejectedToolTurn(fixture).exactNativeTurn, true)
  for (const change of [
    value => { value.history.sessionId = 'other-session' },
    value => { value.turn.assistantMessageIds = ['old-assistant'] },
    value => { value.history.events[5].data.message.content.push({ type: 'text', text: 'UNAUTHORIZED_FACT' }) },
    value => { value.history.events[6].data.callId = 'other-call' },
    value => { value.history.events[7].data.message.content[0].text = JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' }, work: { results: ['UNAUTHORIZED_FACT'] } }) },
    value => { value.publicTurn.assistantText = 'UNAUTHORIZED_FACT' },
  ]) { const invalid = structuredClone(fixture); change(invalid); assert.throws(() => assertRejectedToolTurn(invalid)) }
}
async function turn(id, text, clientRequestId, owner = actor) { const result = await chat.sendTurn(owner, id, { text, clientRequestId }); return waitTurn(id, result.turn.id, 'completed', owner) }
async function waitTurn(id, turnId, status, owner = actor) {
  let detail
  await waitFor(async () => { detail = await chat.getConversation(owner, id); const turn = detail.turns.find(item => item.id === turnId); if (turn?.status === 'failed') throw new Error(`conversation turn failed: ${JSON.stringify(turn.error)}`); return turn?.status === status })
  return detail
}
async function waitWork(id, status) { let value; await waitFor(async () => { value = (await work.getWork(actor, id)).value; if (value.status === 'failed') throw new Error(`work failed: ${JSON.stringify(value.executions.at(-1)?.error)}`); return value.status === status }); return value }
async function changeInstructions(revision) { await store.update(state => ({ ...state, employees: state.employees.map(item => item.id === 'public' ? { ...item, revision, instructions: `INSTRUCTION_V${revision}` } : item) })) }
function member(id, employeeIds) { return { id, loginName: id, displayName: id, role: 'member', enabled: true, authRef: id, sessionVersion: 1, employeeIds } }
function workBody(conversationId, availableSeconds, quantity, clientRequestId) { return { conversationId, employeeId: 'public', skillId: 'skill-cycle-time-calculate', input: { availableSeconds, quantity }, clientRequestId } }
async function waitFor(check) { for (let attempt = 0; attempt < 1000; attempt += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('controlled conversation condition timed out') }
async function startCapture() {
  const requests = [], pending = new Map()
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), serialized = JSON.stringify(body), tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
    const cycleSchema = (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === 'geneway_calculate_cycle_time')?.function?.parameters
    if (cycleSchema) { assert.equal(cycleSchema.properties.availableSeconds.type, 'number'); assert.equal(cycleSchema.properties.quantity.type, 'number'); assert.deepEqual([...cycleSchema.required].sort(), ['availableSeconds', 'quantity']) }
    const text = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n')
    const last = body.messages.filter(message => message.role === 'user').at(-1), lastText = typeof last?.content === 'string' ? last.content : last?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    const cycle = tools.includes('geneway_calculate_cycle_time') && !body.messages.some(message => message.role === 'tool') && text.includes('参数必须精确为 ')
    const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user')
    const hasToolResult = body.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')
    const channelWork = lastText.startsWith('CHANNEL_WORK:') && !hasToolResult ? JSON.parse(lastText.slice('CHANNEL_WORK:'.length)) : null
    const input = cycle ? JSON.parse(text.match(/参数必须精确为 (\{[^}\n]*\})/)?.[1] ?? '{}') : undefined
    const label = lastText.startsWith('HOLD:') ? lastText : cycle && [64, 66].includes(input.availableSeconds) ? `WORK:${input.availableSeconds}` : null
    requests.push({ model: body.model, maxTokens: body.max_tokens ?? body.max_completion_tokens, serialized, tools, chat: tools.length === 0, hasToolResult, credentialLeak: raw.includes(modelKey), sessionLog: Object.hasOwn(body, 'dsh_session_log') })
    if (lastText.includes('BUDGET_CHAT_CANARY') || input?.availableSeconds === 777) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'controlled budget retry', type: 'server_error' } })); return }
    const scenario = /SCENARIO:([a-z0-9-]+)/i.exec(lastText)?.[1]
    const summaryRefs = [...new Set(serialized.match(/result-[a-f0-9-]+/g) ?? [])]
    const collaborationCall = scenario === 'root-summary' ? hasToolResult ? null : { name: 'geneway_collaboration_submit_summary', args: { resultRefs: summaryRefs } }
      : scenario ? hasToolResult ? { name: 'structured_output', args: { status: 'done', explanation: '受控跨模型协作结果' } } : { name: 'geneway_calculate_cycle_time', args: JSON.parse(lastText.match(/ exactly once with (\{[^}\n]*\})/)?.[1] ?? '{}') } : null
    const send = () => {
      if (response.destroyed) return
      const id = `capture-${randomUUID()}`, chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const call = collaborationCall ?? channelWork ?? (cycle ? { name: 'geneway_calculate_cycle_time', args: input } : null)
      chunk(call ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: `LOCAL_REPLY:${lastText}` }, null)
      chunk({}, call ? 'tool_calls' : 'stop')
      response.end('data: [DONE]\n\n')
    }
    if (label) { pending.set(label, send); response.once('close', () => { if (pending.get(label) === send) pending.delete(label) }) }
    else send()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { address: `http://127.0.0.1:${server.address().port}`, requests, pending,
    waitFor: label => waitFor(() => pending.has(label)),
    release(label) { const send = pending.get(label); assert(send, `no held response: ${label}`); pending.delete(label); send() },
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) },
  }
}
