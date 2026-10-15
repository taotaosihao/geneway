import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createConversationService } from '../src/conversation-service.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const execFile = promisify(execFileCallback), root = process.cwd(), temp = await mkdtemp(join(tmpdir(), 'geneway-conversation-runtime-'))
const dshHome = join(temp, 'dsh'), secretRoot = join(temp, 'secrets'), stateFile = join(temp, 'state.json')
const saved = Object.fromEntries(['HOME', 'DSH_HOME', 'GENEWAY_DSH_HOME', 'GENEWAY_SECRET_ROOT', 'GENEWAY_MODEL_CREDENTIAL_REF'].map(key => [key, process.env[key]]))
const modelKey = 'synthetic-conversation-model-key', model = readRuntimeConfig({}).model.model
const actor = { id: 'member-a' }, peer = { id: 'member-b' }, admin = { id: 'admin' }
const store = createFileStore(stateFile), capture = await startCapture()
let chat, work, collaborationRunner, sdkRunner, hosts = 0, harnesses = 0, failure, report
try {
  process.env.HOME = temp
  process.env.DSH_HOME = dshHome
  process.env.GENEWAY_DSH_HOME = dshHome
  process.env.GENEWAY_SECRET_ROOT = secretRoot
  process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'model.key'), modelKey, { mode: 0o600 })
  const patch = join(temp, 'capture.patch.yml')
  const providerPatch = `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local conversation capture\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: ${capture.address}/v1\n        models:\n          - id: ${model}\n            contextWindow: 200000\n            maxOutputTokens: 4096\n`
  await writeFile(patch, `- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n${providerPatch}`, { mode: 0o600 })
  await writeFile(join(temp, 'sdk-capture.patch.yml'), providerPatch, { mode: 0o600 })
  await store.update(state => ({ ...state,
    members: [member(actor.id, ['public', 'private']), member(peer.id, ['public']), { ...member(admin.id, ['public']), role: 'admin' }],
    employees: ['public', 'private'].map(id => ({ id, name: id, enabled: true, modelRouteId: 'route', revision: 1, instructions: 'INSTRUCTION_V1', skillIds: ['skill-cycle-time-calculate'], connectionIds: [] })),
    modelRoutes: [{ id: 'route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true }],
  }))
  createServices()
  await chat.ensureReady()
  const a = await chat.createConversation(actor, { employeeId: 'public' }), b = await chat.createConversation(peer, { employeeId: 'public' })
  const a2 = await chat.createConversation(actor, { employeeId: 'public' })
  assert.equal(a.historyStatus, 'empty')
  assert.equal(hosts, 0, 'empty conversations must not boot a native Host')
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
  assert.equal(manifest.schema.stateVersion, 9)
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
  assert.equal(capture.requests.every(request => request.model === model && !request.credentialLeak && !request.sessionLog), true)
  report = { ok: true, mode: 'native-controlled-loopback', actualProvider: 'local capture', requestedModel: model, nativeHosts: hosts, nativeSdkHarnesses: harnesses, modelRequests: capture.requests.length,
    emptyConversation: true, ownerAndSessionIsolation: true, frozenInstructions: true, cleanSuccessor: true, nativeRestartHistory: true, interruptedNotReplayed: true, exactTurnCancellation: true, workCancellationIndependent: true, relatedWorks: 2, conversationBackup: true, completedWithMissingHistory: true, chatBusinessTools: [], credentialCanaryLeaks: 0, sessionLogAttachments: 0 }
} catch (error) { failure = error }
finally {
  for (const cleanup of [() => chat?.close(), () => work ? work.close() : collaborationRunner?.close(), () => capture.close(), () => rm(temp, { recursive: true, force: true })]) {
    try { await cleanup() } catch (error) { failure = failure ? new AggregateError([failure, error], 'conversation runtime and cleanup failed', { cause: failure }) : error }
  }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))

function createServices() {
  const patch = join(temp, 'capture.patch.yml'), config = readRuntimeConfig({ ...process.env, GENEWAY_STATE: stateFile }, root)
  collaborationRunner = createCollaborationRunner({ store, root, dshHome, runProfileImpl: async options => { hosts += 1; return runProfile({ ...options, patchFiles: [...options.patchFiles, patch] }) } })
  sdkRunner = createDshRunner({ root, config, harnessFactory: options => {
    harnesses += 1
    return new DeepSeekHarness({ ...options, patches: [...options.patches, join(temp, 'sdk-capture.patch.yml')], env: { ...options.env, ...Object.fromEntries(['NODE_OPTIONS', 'GENEWAY_NETWORK_AUDIT_LOG', 'GENEWAY_NETWORK_SECRET_CANARY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) } })
  } })
  chat = createConversationService({ store, runner: collaborationRunner })
  work = createWorkService({ store, runner: sdkRunner, collaborationRunner, policyPaths: { stateFile, dataRoot: temp, secretRoot } })
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
    const text = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n')
    const last = body.messages.filter(message => message.role === 'user').at(-1), lastText = typeof last?.content === 'string' ? last.content : last?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    const cycle = tools.includes('geneway_calculate_cycle_time') && !body.messages.some(message => message.role === 'tool')
    const input = cycle ? JSON.parse(text.match(/参数必须精确为 (\{[^}\n]*\})/)?.[1] ?? '{}') : undefined
    const label = lastText.startsWith('HOLD:') ? lastText : cycle && [64, 66].includes(input.availableSeconds) ? `WORK:${input.availableSeconds}` : null
    requests.push({ model: body.model, serialized, tools, chat: tools.length === 0, credentialLeak: raw.includes(modelKey), sessionLog: Object.hasOwn(body, 'dsh_session_log') })
    const send = () => {
      if (response.destroyed) return
      const id = `capture-${randomUUID()}`, chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      chunk(cycle ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${randomUUID()}`, type: 'function', function: { name: 'geneway_calculate_cycle_time', arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: `LOCAL_REPLY:${lastText}` }, null)
      chunk({}, cycle ? 'tool_calls' : 'stop')
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
