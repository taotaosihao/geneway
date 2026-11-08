import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { startRoutingBatchProvider, ROUTING_MOCK_USAGE } from './fixtures/multisite/routing-batch-provider.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { ROUTING_BATCH_LIMITS, routingCompatibility, routingMemberCharge } from '../src/routing-batch.mjs'
import { chargedModelTokens } from '../src/work-budget.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/routing-batch-')
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
const errors = [], events = [], http = [], nodeId = 'routing-batch-node', query = 'ROUTER_BATCH_CANDIDATE'
let fixture, provider, client, host, journal, runtime, pumping, candidate, control
const sessions = {}, submitted = new Map()
const cloud = () => fixture.store.read()
const pause = () => new Promise(resolve => setTimeout(resolve, 250))
async function pump() {
  if (!host) return
  return pumping ??= (async () => {
    for (const delivery of (await client.resync()).pending) {
      const command = await client.resolveCommand(delivery)
      await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command)
    }
    await host.process(); await host.flushEvents(event => client.event(event))
  })().finally(() => { pumping = undefined })
}
async function until(predicate, label) {
  const deadline = Date.now() + 90000
  for (;;) { await pump(); const value = await predicate(); if (value) return value; assert(Date.now() < deadline, label + ' timed out'); await pause() }
}
async function api(actor, path, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const session = sessions[actor], response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  http.push({ actor, path, method, at: new Date().toISOString(), status: response.status, request: body, response: path === '/api/admin/nodes/pairings' ? { ...value, pairingCode: '[redacted]' } : value })
  assert.equal(response.status, expected, JSON.stringify(value)); return value
}
async function stage(name) { events.push({ name, at: new Date().toISOString() }); await save('events.json', events); console.log(JSON.stringify({ stage: name, directory, pid: process.pid, api: fixture?.origin, provider: provider?.origin, runtime: 'HostSim; no native DSH or business model requests' })) }
async function sourceEvent(actor, thread, sourceEventId, text, extra = {}) {
  const view = await api(actor, '/api/interaction/threads/' + thread.id)
  const body = { clientRequestId: sourceEventId + '-' + (extra.version ?? 1), sourceEventId, version: 1, expectedThreadRevision: view.thread.revision, text, routingPolicyId: 'batch-policy', directoryQuery: query, ...extra }
  const reply = await api(actor, '/api/interaction/threads/' + thread.id + '/events', body)
  submitted.set(sourceEventId + ':' + body.version, { actor, threadId: thread.id, body, reply }); return reply
}
const decision = (event, action = 'clarify', targetWorkId = null) => ({ sourceEventId: event.sourceEventId, eventVersion: event.eventVersion, action, targetWorkId, reason: action === 'attach' ? '将本事件交给明确获准的当前工作处理者判断，不自动接受为正式要求。' : '本事件仍需当前用户明确定位；保留逐项决定。', question: action === 'clarify' ? '请明确这项请求的处理范围。' : null })
function captureRequests(capture, state) {
  return capture.input.events.map(event => {
    const request = state.routingRequests.find(row => row.id === event.requestId), source = request && state.sourceEvents.find(row => row.id === request.sourceEventId)
    assert(request && source); assert.equal(event.sourceEventId, request.sourceEventId); assert.equal(event.eventVersion, source.version)
    assert.equal(request.actorId, source.actorId); assert.equal(request.threadId, source.threadId)
    return { request, source }
  })
}
function verifyAccounting(capture, state) {
  const rows = state.modelRequests.filter(row => row.purpose === 'routing' && row.bodyDigest === capture.bodyDigest)
  assert.equal(rows.length, 1, 'One actual batch body must have one global model ledger')
  const row = rows[0], batch = state.routingBatches.find(batch => batch.id === row.batchId), members = captureRequests(capture, state)
  assert.equal(row.routingVersion, 2); assert.equal(batch.modelRequestId, row.id)
  assert.deepEqual(batch.members.map(member => member.requestId), capture.input.events.map(event => event.requestId))
  assert.equal(new Set(members.map(member => member.request.actorId)).size, 1)
  assert.equal(new Set(members.map(member => member.request.threadId)).size, 1)
  assert.equal(new Set(members.map(member => routingCompatibility(member.request))).size, 1)
  assert.equal(row.forwardedBodyBytes, Buffer.byteLength(JSON.stringify(capture.body)))
  assert.equal(row.forwardedBodyBytes, capture.bodyBytes)
  assert.equal(row.bodyDigest, digest(capture.body)); assert(row.estimate.inputTokens <= ROUTING_BATCH_LIMITS.maxInputTokens)
  for (let index = 0; index < row.members.length; index++) assert.equal(row.members[index].weight, Buffer.byteLength(JSON.stringify(capture.input.events[index])))
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'costMicros']) assert.equal(row.members.reduce((sum, member) => sum + member.estimate[field], 0), row.estimate[field])
  if (row.outcome === 'completed') assert.deepEqual(row.usage, ROUTING_MOCK_USAGE)
  const charges = row.members.map(member => routingMemberCharge(row, member.intentId))
  assert.equal(charges.reduce((sum, charge) => sum + charge.tokens, 0n), chargedModelTokens(row))
  assert.equal(charges.reduce((sum, charge) => sum + charge.costMicros, 0n), BigInt(Math.max(row.estimate.costMicros, row.usageCostMicros ?? 0)))
  return { modelRequestId: row.id, batchId: batch.id, members: row.members, estimate: row.estimate, usage: row.usage, chargedTokens: String(chargedModelTokens(row)), chargedCostMicros: String(charges.reduce((sum, charge) => sum + charge.costMicros, 0n)) }
}
const sourcePaths = [...new Set(['scripts/probe-routing-batch.mjs', 'scripts/fixtures/multisite/routing-batch-provider.mjs', 'scripts/fixtures/multisite/bridge-service.mjs', 'scripts/fixtures/multisite/runtime.mjs', 'scripts/fixtures/multisite/delegation.mjs', ...(await readdir('src')).filter(name => /^(routing|interaction|supervision)-/.test(name)).map(name => 'src/' + name), 'config/supervision-diagnosis-runtime.patch.yml', 'src/model-gateway.mjs', 'src/store/file-store.mjs', 'src/server.mjs', 'src/node-bridge.mjs', 'src/work-budget.mjs', 'packages/agent-host/host.mjs', 'packages/agent-host/journal.mjs', 'packages/agent-host/journal-archive.mjs', 'packages/agent-host/remote-client.mjs', 'packages/agent-host/delivery.mjs', 'packages/agent-orchestration/service.mjs', 'packages/agent-orchestration/commands.mjs', 'package.json', 'pnpm-lock.yaml'])].sort()
async function sources(phase) {
  await mkdir(join(directory, 'source-' + phase)); const entries = []
  for (const path of sourcePaths) { const bytes = await readFile(path); await writeFile(join(directory, 'source-' + phase, path.replaceAll('/', '__')), bytes); entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), pid: process.pid, argv: process.argv, entries }); return entries
}
const sourceStart = await sources('start')
await stage('source-start')
try {
  assert.deepEqual(ROUTING_BATCH_LIMITS, { maxEvents: 4, maxInputTokens: 8192, maxPending: 8, maxAttempts: 2, globalActive: 2, scopeActive: 1, extraWaitMs: 0 })
  provider = await startRoutingBatchProvider({ directory, onError: cause => errors.push({ message: cause.message, stack: cause.stack }), async decide(capture) {
    const members = captureRequests(capture, await cloud()), labels = members.map(member => member.source.sourceEventId)
    capture.labels = labels; capture.actors = members.map(member => member.request.actorId); capture.threads = members.map(member => member.request.threadId)
    assert.equal(new Set(capture.actors).size, 1); assert.equal(new Set(capture.threads).size, 1)
    if (labels.includes('owner-first')) { assert.deepEqual(labels, ['owner-first']); return { hold: 'first' } }
    if (labels.some(label => /^owner-[234]$/.test(label))) {
      if (labels.length === 3) { assert.deepEqual([...labels].sort(), ['owner-2', 'owner-3', 'owner-4']); return { hold: 'backlog-batch' } }
      assert.deepEqual(labels, ['owner-4']); return { hold: 'omitted-retry' }
    }
    if (labels.includes('late-version') && capture.input.events[0].eventVersion === 1) return { hold: 'late-version' }
    if (labels.includes('unknown-route')) return { hold: 'unknown-route' }
    return { decisions: capture.input.events.map(event => decision(event)) }
  } })
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: provider.origin + '/v1', seedState(state) {
    seedDelegation(state); state.members.find(row => row.id === 'peer').employeeIds = ['analysis']
    for (const employee of state.employees) { employee.placement = { nodeId, mode: 'agent_host', resourceRefs: [] }; employee.multisitePolicy.execution.resourceRefs = []; employee.multisitePolicy.delegation.resourceRefs = [] }
    return state
  } })
  await mkdir(join(directory, 'api/secrets'), { recursive: true, mode: 0o700 }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-routing-provider-only', { mode: 0o600 })
  for (const actor of ['owner', 'peer']) {
    const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: actor, password: 'synthetic ' + actor + ' password' }) })
    assert.equal(response.status, 200); sessions[actor] = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] }
  }
  const pairing = await api('owner', '/api/admin/nodes/pairings', { clientRequestId: 'routing-batch-pair', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator', 'desktop-office', 'analysis'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }; client = createRemoteClient({ origin: fixture.origin, identity })
  const registered = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'routing-batch-redeem', ...identity })
  identity.registrationRevision = registered.node.registrationRevision
  await mkdir(join(directory, 'host'), { mode: 0o700 }); await writeFile(join(directory, 'host/node-private.json'), JSON.stringify(identity), { mode: 0o600 })
  journal = createHostJournal(join(directory, 'host/host-journal.json')); runtime = createSimulatedRuntime({ path: join(directory, 'host/sessions.json') })
  host = createAgentHost({ nodeId, journal, runtime, maxActiveLoops: 2 })
  host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
  const initial = await cloud()
  await api('owner', '/api/admin/routing-policies/batch-policy', { clientRequestId: 'routing-batch-policy', expectedRevision: null, workspaceId: 'local', routerAgentId: 'analysis', routerNodeId: nodeId, enabled: true, maxOutputTokens: 512, budget: { workspaceId: 'local', coordinatorAgentId: 'analysis', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: initial.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) } }, 'PUT')
  candidate = await api('owner', '/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: query + ' 继续核对明确范围内的任务，不读来源、不发布成果。', clientRequestId: 'batch-candidate', attachmentRefs: [] })
  control = await api('owner', '/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: 'CONTROL_LANE 仅验证明确Input与取消受理，不属于路由候选目录。', clientRequestId: 'batch-control', attachmentRefs: [] })
  await until(async () => (await cloud()).multisite.inputs.every(input => input.deliveries.length && input.deliveries.every(delivery => delivery.ingestedAt)), 'actual HostSim consumes both original Inputs')
  const beforeDirectory = await api('owner', '/api/interaction/directory?query=' + query)
  assert.deepEqual(beforeDirectory.candidates.map(row => row.workId), [candidate.id])
  const thread = await api('owner', '/api/interaction/threads', { clientRequestId: 'main-thread', title: '同授权域批量判断' })
  await sourceEvent('owner', thread, 'owner-first', '第一项请先明确范围，独立判断。')
  await until(() => provider.isHeld('first'), 'first event immediately reaches a single real provider request')
  assert.equal(provider.capture('first').input.events.length, 1)
  for (const index of [2, 3, 4]) await sourceEvent('owner', thread, 'owner-' + index, '第' + index + '项请独立判断，保留逐事件责任。')
  const otherThread = await api('owner', '/api/interaction/threads', { clientRequestId: 'other-thread', title: '不同Thread隔离' })
  const peerThread = await api('peer', '/api/interaction/threads', { clientRequestId: 'peer-thread', title: '另一actor隔离' })
  await sourceEvent('owner', otherThread, 'foreign-thread', '另一Thread的合法请求，不得混入原批。')
  await sourceEvent('peer', peerThread, 'foreign-actor', '另一成员自己的请求，不能读取他人候选工作。')
  const direct = await sourceEvent('owner', thread, 'direct-control', 'CONTROL_LANE 这是明确指定工作的正式Input，必须先受理。', { workId: control.id, expectedInstructionRevision: 1 })
  const directIntent = (await cloud()).workIntents.find(row => row.id === direct.intentId)
  assert.equal(directIntent.workId, control.id); assert(directIntent.acceptedInputId)
  await until(async () => (await cloud()).works.find(row => row.id === control.id).instructionRevision === 2, 'direct Work Input commits while router inference is held')
  const stopReceipt = await api('owner', '/api/works/' + control.id + '/multisite/cancel', { clientRequestId: 'control-stop-inflight' })
  await until(async () => (await cloud()).works.find(row => row.id === control.id).status === 'cancelled', 'control Work actual stop and HostSim proof while Router remains held')
  assert(provider.isHeld('first')); assert.equal((await api('owner', '/api/interaction/directory?query=' + query)).candidateVersion, beforeDirectory.candidateVersion)
  const inflight = await cloud(); assert(!inflight.routingRequests.some(row => row.sourceEventId === direct.eventId))
  await save('inflight-control-direct.json', { cloud: inflight, direct, stopReceipt, directory: beforeDirectory, heldFirst: provider.capture('first'), boundary: 'real HTTP direct Input and cancellation; control Work excluded by actual directoryQuery so the selected candidate version stays unchanged' })
  await provider.release('first', provider.capture('first').input.events.map(event => decision(event)))
  await until(() => provider.isHeld('backlog-batch'), 'three accumulated same-domain events form one actual batch')
  const batchCapture = provider.capture('backlog-batch'), prepared = await cloud()
  assert.deepEqual([...batchCapture.labels].sort(), ['owner-2', 'owner-3', 'owner-4']); verifyAccounting(batchCapture, prepared)
  const firstBatch = prepared.routingBatches.find(batch => batch.members.some(member => member.requestId === batchCapture.input.events[0].requestId))
  await save('prepared-real-batch.json', { capture: batchCapture, batch: firstBatch, cloud: prepared })
  await provider.release('backlog-batch', batchCapture.input.events.flatMap((event, index) => batchCapture.labels[index] === 'owner-4' ? [] : [decision(event, batchCapture.labels[index] === 'owner-2' ? 'attach' : 'clarify', batchCapture.labels[index] === 'owner-2' ? candidate.id : null)]))
  await until(() => provider.isHeld('omitted-retry'), 'only the omitted event joins a bounded second real evaluation')
  const omittedCapture = provider.capture('omitted-retry'), incomplete = await cloud()
  assert.deepEqual(omittedCapture.labels, ['owner-4'])
  assert(!incomplete.routingDecisions.some(row => row.sourceEventId === omittedCapture.input.events[0].sourceEventId))
  assert.equal(incomplete.modelRequests.filter(row => row.purpose === 'routing' && row.members?.some(member => member.requestId === omittedCapture.input.events[0].requestId)).length, 2)
  await save('omitted-member-undecided.json', { capture: omittedCapture, firstCapture: batchCapture, cloud: incomplete })
  await provider.release('omitted-retry', omittedCapture.input.events.map(event => decision(event)))
  await until(async () => {
    const state = await cloud()
    return ['owner-first', 'owner-2', 'owner-3', 'owner-4', 'foreign-thread', 'foreign-actor'].every(label => { const source = state.sourceEvents.find(row => row.sourceEventId === label); return source && state.routingDecisions.some(row => row.sourceEventId === source.id && row.method === 'semantic') })
  }, 'each legitimate event receives its own current decision')
  const accounted = await cloud(), positiveCaptures = provider.captures.slice()
  const accounting = positiveCaptures.map(capture => verifyAccounting(capture, accounted))
  const foreign = positiveCaptures.filter(capture => capture.labels.some(label => label.startsWith('foreign-')))
  assert.equal(foreign.length, 2); assert(foreign.every(capture => capture.input.events.length === 1))
  assert.equal(foreign.find(capture => capture.labels[0] === 'foreign-actor').input.candidates.length, 0)
  await save('normal-batch-accounting.json', { captures: positiveCaptures, accounting, cloud: accounted, query, boundary: 'one global usage ledger per actual forward; per-member estimates and charges are derived allocations, not per-event measured usage' })
  await stage('normal-batch-completed')

  const lateThread = await api('owner', '/api/interaction/threads', { clientRequestId: 'late-thread', title: '真实版本竞态' })
  const late1 = await sourceEvent('owner', lateThread, 'late-version', '旧版本仅供定位，稍后会明确修订。')
  await until(() => provider.isHeld('late-version'), 'old source version has an actual held model request')
  const late2 = await sourceEvent('owner', lateThread, 'late-version', '这是明确修订后的当前版本，请重新定位。', { version: 2 })
  const lateCapture = provider.capture('late-version')
  await provider.release('late-version', lateCapture.input.events.map(event => decision(event, 'attach', candidate.id)))
  await until(async () => (await cloud()).routingDecisions.some(row => row.intentId === late2.intentId && row.method === 'semantic'), 'new source version receives its own real routing decision')
  const late = await cloud()
  assert.equal(late.workIntents.find(row => row.id === late1.intentId).state, 'closed')
  assert(!late.contextSubscriptions.some(row => row.intentId === late1.intentId))
  assert(!late.multisite.outbox.some(row => row.command.parameters.sourceEvent?.id === late1.eventId))
  assert(!late.routingDecisions.some(row => row.intentId === late1.intentId && row.action === 'attach'))
  await save('late-version-no-dispatch.json', { late1, late2, capture: lateCapture, cloud: late })

  const unknownThread = await api('owner', '/api/interaction/threads', { clientRequestId: 'unknown-thread', title: '未知路由不重发' })
  const unknownReply = await sourceEvent('owner', unknownThread, 'unknown-route', '保留这条合法自由请求，未知模型结果不能自动重发。')
  await until(() => provider.isHeld('unknown-route'), 'unknown control has one actual provider forward')
  const unknownCapture = provider.capture('unknown-route'); await provider.truncate('unknown-route')
  const unknownRow = await until(async () => {
    const state = await cloud(), row = state.modelRequests.find(row => row.bodyDigest === unknownCapture.bodyDigest)
    return row?.outcome === 'unknown' && state.routingBatches.find(batch => batch.id === row.batchId)?.state === 'unknown' ? row : false
  }, 'truncated routing batch reaches an actual unknown terminal boundary')
  for (const repeat of [1, 2]) {
    const original = submitted.get('unknown-route:1')
    assert.deepEqual(await api('owner', '/api/interaction/threads/' + unknownThread.id + '/events', { ...original.body, clientRequestId: 'unknown-exact-replay-' + repeat, expectedThreadRevision: 0 }), unknownReply)
  }
  await until(async () => { const request = (await cloud()).routingRequests.find(row => row.id === unknownCapture.input.events[0].requestId); return request && request.state !== 'pending' }, 'same unknown request remains outside automatic pending retry')
  const afterUnknown = await cloud()
  assert.equal(provider.captures.filter(capture => capture.labels.includes('unknown-route')).length, 1)
  assert.deepEqual(afterUnknown.modelRequests.find(row => row.id === unknownRow.id), unknownRow)
  assert(!afterUnknown.contextSubscriptions.some(row => row.intentId === unknownReply.intentId))
  verifyAccounting(unknownCapture, afterUnknown)
  await save('actual-unknown-no-retry.json', { unknownReply, capture: unknownCapture, originalUnknown: unknownRow, cloud: afterUnknown, boundary: 'actual incomplete provider SSE without DONE and two legitimate exact-source HTTP replays; unknown reservation retained, no new forward or dispatch' })

  await pump()
  const attached = submitted.get('owner-2:1'), pending = (await journal.read()).inbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence?.intentId === attached.reply.intentId)
  assert(pending)
  const execution = (await journal.read()).executions.find(row => row.work_id === candidate.id)
  const accepted = await runtime.orchestration(execution, 'accept_intent', { clientRequestId: 'accept-batch-member-2', intentFence: pending.command.parameters.intentFence, expectedInstructionRevision: 1 })
  assert.equal(accepted.instructionRevision, 2)
  await until(async () => (await cloud()).multisite.inputs.filter(row => row.workId === candidate.id).every(input => input.deliveries.length && input.deliveries.every(delivery => delivery.ingestedAt)), 'actual attached batch member accepted as formal Input and consumed')
  const acceptedState = await cloud(), acceptedIntent = acceptedState.workIntents.find(row => row.id === attached.reply.intentId)
  assert(acceptedIntent.acceptedInputId)
  const simulated = JSON.parse(await readFile(join(directory, 'host/sessions.json'), 'utf8')), expectedMessage = messageId(acceptedIntent.acceptedInputId, execution.attempt_id, execution.session_id)
  assert.equal(Object.values(simulated).flatMap(row => row.events).filter(row => row.type === 'user/message' && row.data.id === expectedMessage).length, 1)
  await save('batch-member-actual-input.json', { accepted, acceptedIntent, expectedMessage, sessions: simulated, cloud: acceptedState, boundary: 'real handler accept_intent API and HostSim user/message; routing attach itself is not formal Work Input' })
  await api('owner', '/api/works/' + candidate.id + '/multisite/cancel', { clientRequestId: 'candidate-final-stop' })
  await until(async () => (await cloud()).works.find(row => row.id === candidate.id).status === 'cancelled', 'own candidate Work real cancellation')
  await save('terminal-cloud.json', await cloud()); await save('terminal-host.json', await journal.read())
  assert.equal((await cloud()).modelRequests.filter(row => row.purpose === undefined).length, 0)
  await save('result.json', { result: 'passed', directory, candidateWorkId: candidate.id, controlWorkId: control.id, firstImmediateSingle: true, accumulatedMembers: 3, oneActualForwardPerBatch: true, omittedMemberSecondEvaluationOnly: true, crossActorThreadSeparated: true, directInputAndStopBeforeFirstRouterRelease: true, lateVersionNotDispatched: true, originalUnknownNotRetried: true, batchMemberActuallyAcceptedAndConsumedOnce: true, modelForwards: provider.captures.length, runtime: 'HostSim', boundary: 'T24a only; real HTTP/Node registration/Host and controlled routing model transport. No native DSH, no T24b rules, no T25 gain claim.' })
} catch (cause) {
  await save('failure.json', { message: cause.message, code: cause.code, stack: cause.stack, errors }); console.error(cause); process.exitCode = 1
} finally {
  const cleanupErrors = [], ports = [fixture ? Number(new URL(fixture.origin).port) : null, provider ? Number(new URL(provider.origin).port) : null].filter(Boolean)
  try { await pumping; await host?.close() } catch (cause) { cleanupErrors.push({ phase: 'host-close', message: cause.message }) }
  try { await fixture?.close() } catch (cause) { cleanupErrors.push({ phase: 'api-close', message: cause.message }) }
  try { await provider?.close() } catch (cause) { cleanupErrors.push({ phase: 'provider-close', message: cause.message }) }
  const portStates = []
  for (const port of ports) { const listening = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) }); portStates.push({ port, listening }); if (listening) cleanupErrors.push({ port, message: 'Owned port still listening' }) }
  await save('http-wire.json', http); await save('provider-bodies.json', provider?.captures ?? []); await save('errors.json', errors)
  await save('cleanup.json', { ownerPid: process.pid, errors: cleanupErrors, ports: portStates, childProcessesStarted: 0 })
  const sourceEnd = await sources('end'), sourceChanged = JSON.stringify(sourceStart) !== JSON.stringify(sourceEnd)
  await save('source-comparison.json', { sourceChanged }); if (sourceChanged || cleanupErrors.length) process.exitCode = 1
  console.log(JSON.stringify({ stage: 'closed', directory, pid: process.pid, sourceChanged, exitCode: process.exitCode ?? 0 }))
}
