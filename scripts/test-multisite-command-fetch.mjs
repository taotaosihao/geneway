import { createServer } from 'node:http'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createNodeBridge } from '../src/node-bridge.mjs'
import { buildExecutionCommand, queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { waitEnvelopeBytes } from '../packages/agent-orchestration/dependencies.mjs'
import { createDelegationTools } from '../packages/agent-host/delegation-tools.mjs'
import { delegationResult } from '../packages/agent-contracts/delegation.mjs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { createRemoteClient, readLimitedJson } from '../packages/agent-host/remote-client.mjs'
import { binding, assertSealed, key, seal } from '../packages/agent-contracts/index.mjs'
import { BRIDGE_LIMIT, COMMAND_FETCH_LIMIT, RESULT_PAYLOAD_LIMIT, jsonBytes, assertCommandBytes } from '../packages/agent-contracts/command-bytes.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/command-fetch-'), longNode = '节'.repeat(16000), helperIds = Array.from({ length: 8 }, (_, index) => `helper-${index}`), scenarios = []
function seed(state) {
  seedDelegation(state)
  const root = structuredClone(state.employees.find(row => row.id === 'coordinator')), analysis = state.employees.find(row => row.id === 'analysis')
  root.placement = { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }; root.multisitePolicy = { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs: [] }, delegation: { agentIds: helperIds, capabilityIds: ['analysis.classify.v1'], resourceRefs: [] } }
  state.employees = [root, ...helperIds.map(id => ({ ...structuredClone(analysis), id, name: id, placement: { nodeId: longNode, mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['analysis.classify.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }))]
  state.members = [{ ...state.members[0], employeeIds: ['coordinator', ...helperIds] }]; return state
}
for (const order of ['wait-before-result', 'result-before-wait']) {
  const root = join(directory, order); let fixture, cloudClient, helperClient, session
  const identities = {}, hosts = {}, runtimes = {}, journals = {}
  try {
    fixture = await startBridgeService({ directory: join(root, 'api'), seedState: seed })
    async function login() { const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert(response.ok); session = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
    async function api(path, value) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) }); const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body }
    await login()
    async function pair(name, nodeId, allowedAgentIds) {
      const request = { clientRequestId: `pair-${name}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(Date.now() + 120_000).toISOString() }; assert(jsonBytes(request) < 64 * 1024)
      const pairing = await api('/api/admin/nodes/pairings', request), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID(), registrationRevision: 1 }
      identities[name] = identity
      const client = createRemoteClient({ origin: fixture.origin, identity }); await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: `redeem-${name}`, credential: identity.credential, nodeInstanceId: identity.nodeInstanceId }); return client
    }
    cloudClient = await pair('cloud', 'cloud', ['coordinator']); helperClient = await pair('helpers', longNode, helperIds)
    for (const [name, nodeId] of [['cloud', 'cloud'], ['helpers', longNode]]) {
      const runtime = createSimulatedRuntime({ path: join(root, `${name}-sessions.json`) }), journal = createHostJournal(join(root, `${name}-host.json`)), host = createAgentHost({ nodeId, journal, runtime, maxActiveLoops: name === 'helpers' ? 8 : 1 })
      host.setOrchestrationHandler({ call: (execution, operation, parameters) => (name === 'cloud' ? cloudClient : helperClient).command(execution, operation, parameters), event: event => (name === 'cloud' ? cloudClient : helperClient).event(event) }); runtimes[name] = runtime; hosts[name] = host; journals[name] = journal
    }
    const current = async id => (await fixture.store.read()).multisite.attempts.find(row => row.agent_id === id)
    const call = async (name, id, operation, parameters) => runtimes[name].orchestration(await current(id), operation, parameters)
    async function deliver(name, client) {
      const view = await client.resync()
      for (const delivery of view.pending) { const command = await client.resolveCommand(delivery); await hosts[name].accept({ workspaceId: 'local', nodeId: command.node_id }, command); await client.ack(command) }
      await hosts[name].process(); await hosts[name].flushEvents(event => client.event(event))
    }
    const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '合法八个直接依赖的结果回流', clientRequestId: 'create' }); await deliver('cloud', cloudClient)
    const children = []
    for (const id of helperIds) children.push(await call('cloud', 'coordinator', 'delegate', { clientRequestId: `delegate-${id}`, targetAgentId: id, goal: '返回结构化结果', requestedCapabilityId: 'analysis.classify.v1', resourceRefs: [], resultSchema: 'geneway.analysis-result/1', instructionRevision: 1 }))
    const beforeWait = await fixture.store.read()
    const wait = { clientRequestId: 'wait', instructionRevision: 1, dependencyIds: children.map(row => row.delegationId) }
    if (order === 'wait-before-result') await call('cloud', 'coordinator', 'wait_dependencies', wait)
    await deliver('helpers', helperClient)
    for (const id of helperIds) await call('helpers', id, 'complete_delegation', { clientRequestId: `complete-${id}`, instructionRevision: 1, result: { summary: '已回报', evidenceRefs: [], findings: [{ category: 'insufficient_evidence', statement: '本helper仅验证传输，未读取业务资料', basis: [], certainty: 'unknown' }], limitations: ['空引用不证明任何业务分析'] } })
    if (order === 'result-before-wait') await call('cloud', 'coordinator', 'wait_dependencies', wait)
    const state = await fixture.store.read(), wake = state.multisite.outbox.find(row => row.command.operation === 'wake'), admitted = state.multisite.dependencyWaits[0]
    assert(wake && jsonBytes(wake.command) > BRIDGE_LIMIT && jsonBytes(wake.command) <= COMMAND_FETCH_LIMIT); assert.equal(state.multisite.results.length, 8); assert.equal(admitted.envelopeVersion, 1); assert(admitted.upperBytes >= jsonBytes(wake.command)); assert(admitted.upperBytes <= COMMAND_FETCH_LIMIT)
    const replay = await cloudClient.command(binding(await current('coordinator')), 'wait_dependencies', wait); assert.equal(replay.waitId, admitted.id); assert.equal((await fixture.store.read()).multisite.dependencyWaits.length, 1)
    await assert.rejects(cloudClient.command(binding(await current('coordinator')), 'wait_dependencies', { ...wait, dependencyIds: [wait.dependencyIds[0]] }), { code: 'IDEMPOTENCY_CONFLICT' })
    const notice = (await cloudClient.resync()).pending.find(row => row.commandId === wake.id); assert.equal(notice.kind, 'command_ref')
    await assert.rejects(helperClient.resolveCommand(notice), { code: 'FORBIDDEN' })
    await assert.rejects(cloudClient.resolveCommand({ ...notice, payloadDigest: '0'.repeat(64) }), { code: 'IDEMPOTENCY_CONFLICT' })
    let fetchAttempts = 0
    const failing = createRemoteClient({ origin: fixture.origin, identity: identities.cloud, fetchImpl: async (url, options) => { if (url.pathname === '/internal/bridge/command') { fetchAttempts++; throw new TypeError('synthetic lost command fetch') }; return fetch(url, options) } })
    await assert.rejects(failing.resolveCommand(notice)); assert.equal(fetchAttempts, 3); assert.equal((await fixture.store.read()).multisite.outbox.find(row => row.id === wake.id).acceptedAt, null)
    await fixture.close(); fixture = await startBridgeService({ directory: join(root, 'api') }); cloudClient = createRemoteClient({ origin: fixture.origin, identity: identities.cloud }); helperClient = createRemoteClient({ origin: fixture.origin, identity: identities.helpers }); await login()
    const persisted = (await fixture.store.read()).multisite.outbox.find(row => row.id === wake.id).command; assert.deepEqual(persisted, wake.command)
    const controller = new AbortController(), stream = await cloudClient.stream(controller.signal), streamedNotice = (await stream.next()).value; assert.deepEqual(streamedNotice, notice); controller.abort()
    const original = await cloudClient.resolveCommand(streamedNotice); assertSealed(original); assert.deepEqual(original, wake.command)
    const { payload_digest, ...unsigned } = original
    for (const [name, returned, expected] of [['bad-seal', { ...original, payload_digest: '0'.repeat(64) }, 'IDEMPOTENCY_CONFLICT'], ['wrong-command', seal({ ...unsigned, command_id: key('different-command') }), 'IDEMPOTENCY_CONFLICT']]) {
      const badClient = createRemoteClient({ origin: fixture.origin, identity: identities.cloud, fetchImpl: async () => new Response(JSON.stringify(returned), { headers: { 'content-type': 'application/json' } }) })
      await assert.rejects(badClient.resolveCommand(notice), { code: expected })
    }
    await assert.rejects(readLimitedJson(new Response(' '.repeat(COMMAND_FETCH_LIMIT + 1)), COMMAND_FETCH_LIMIT), { code: 'INVALID_RESPONSE' })
    assert.equal((await fixture.store.read()).multisite.outbox.find(row => row.id === wake.id).acceptedAt, null)
    await hosts.cloud.accept({ workspaceId: 'local', nodeId: 'cloud' }, original); await cloudClient.ack(original); await hosts.cloud.process(); await hosts.cloud.flushEvents(event => cloudClient.event(event))
    await deliver('helpers', helperClient)
    const received = JSON.parse(await readFile(join(root, 'cloud-sessions.json'), 'utf8'))
    const consumedPayload = Object.values(received).flatMap(row => row.events).find(row => row.type === 'user/message' && row.data.source?.kind === 'geneway-agent-message')
    assert(consumedPayload); assert.equal(JSON.stringify(consumedPayload.data.content).split('已回报').length - 1, 8)
    const final = await fixture.store.read(); assert(final.multisite.messages.every(row => row.ingestedAt)); assert.equal(final.multisite.messages.length, 8); assert.equal(final.works[0].instructionRevision, 1); assert.equal(final.works[0].modelRequestBudget.reserved, 0); assert.equal(final.multisite.outbox.find(row => row.id === wake.id).acceptedAt !== null, true)
    if (order === 'wait-before-result') await negativeLimitsAndLegacy(beforeWait, identities.cloud, fixture.nodes, join(root, 'negative-limits'))
    await api('/api/admin/nodes/cloud/revoke', { clientRequestId: 'revoke', expectedRevision: 1 }); await assert.rejects(cloudClient.resolveCommand(notice), { code: 'FORBIDDEN' }); await deliver('cloud', cloudClient)
    assert.equal((await fixture.store.read()).multisite.attempts.find(row => row.agent_id === 'coordinator').status, 'cancelled')
    scenarios.push({ order, wakeJsonBytes: jsonBytes(wake.command), upperBytes: admitted.upperBytes, originalDigest: wake.command.payload_digest, exactAckedAndConsumedMessages: 8, restartPreservesOriginalCommand: true, failedFetchNotAcked: true, crossNodeAndDigestAndRevocationRejected: true })
  } finally { for (const host of Object.values(hosts)) await host.close(); await fixture?.close() }
}
const result = { result: 'passed', directory, scenarios, boundary: 'actual FileStore/full current validators/admin pair HTTP/Bridge fetch+SSE/Host journal/AgentDelivery producer, simulated runtime; no native/model/business evidence' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))

async function negativeLimitsAndLegacy(produced, identity, nodes, path) {
  // These deliberately oversized metadata/legacy records are negative fixtures, not legal producer outputs.
  const state = structuredClone(produced), parent = state.multisite.attempts.find(row => row.agent_id === 'coordinator'), dependencyIds = state.multisite.delegations.filter(row => row.parentDelegationId === parent.delegation_id).map(row => row.id)
  state.multisite.delegations.find(row => row.id === parent.delegation_id).goal = 'x'.repeat(3 * 1024 * 1024)
  const store = createFileStore(join(path, 'state.json')); await store.update(() => state)
  const service = createMultisiteService({ store, requireRemoteNodes: true }), wait = { clientRequestId: 'too-wide', instructionRevision: 1, dependencyIds }, before = await readFile(join(path, 'state.json'), 'utf8')
  let parks = 0
  const tool = createDelegationTools((operation, parameters) => service.agentCommand(binding(parent), operation, parameters), () => { parks++ }).find(row => row.name === 'geneway_wait_dependencies')
  await assert.rejects(tool.execute(wait), { code: 'COMMAND_TOO_LARGE' }); assert.equal(parks, 0); assert.equal(await readFile(join(path, 'state.json'), 'utf8'), before)
  const smaller = await service.agentCommand(binding(parent), 'wait_dependencies', { ...wait, clientRequestId: 'smaller-batch', dependencyIds: dependencyIds.slice(0, 1) }); assert.equal(smaller.status, 'waiting_dependency')
  assert.equal((await store.read()).multisite.dependencyWaits[0].waitGeneration, 1)
  const saved = await readFile(join(path, 'state.json'), 'utf8')
  await assert.rejects(store.update(draft => { draft.works[0].status = 'waiting_input'; queueExecutionCommand(draft, parent, 'wake', { id: key('oversize-admission'), revision: 1, text: 'x'.repeat(COMMAND_FETCH_LIMIT), messages: [] }, new Date().toISOString(), 'local'); return draft }), { code: 'COMMAND_TOO_LARGE' })
  assert.equal(await readFile(join(path, 'state.json'), 'utf8'), saved)
  const payload = { summary: 'x', evidenceRefs: [{ kind: 'artifact', id: 'x', version: 1, sha256: '0'.repeat(64) }] }
  payload.evidenceRefs[0].id = 'x'.repeat(1 + RESULT_PAYLOAD_LIMIT - jsonBytes(payload)); assert.equal(jsonBytes(payload), RESULT_PAYLOAD_LIMIT); delegationResult(payload, { admission: true })
  await assert.rejects(async () => delegationResult({ ...payload, evidenceRefs: [{ ...payload.evidenceRefs[0], id: payload.evidenceRefs[0].id + 'x' }] }, { admission: true }), { code: 'COMMAND_TOO_LARGE' })
  const legacy = structuredClone(state), legacyParent = legacy.multisite.attempts.find(row => row.attempt_id === parent.attempt_id), legacyWait = { id: key('legacy-wait'), workId: parent.work_id, parentAttemptId: parent.attempt_id, instructionRevision: 1, dependencyIds, waitGeneration: 1, createdAt: new Date().toISOString(), wokenAt: null }
  legacy.multisite.dependencyWaits.push(legacyWait); legacyParent.status = 'waiting_dependency'; assert(waitEnvelopeBytes(legacy, legacyParent, legacyWait, 'local') > COMMAND_FETCH_LIMIT)
  const tooLargeText = 'x'.repeat(COMMAND_FETCH_LIMIT)
  for (let index = 0; index < 33; index++) { const command = buildExecutionCommand(legacy, legacyParent, 'wake', { id: key('legacy-command', index), revision: 1, text: tooLargeText, messages: [] }, 'local'); legacy.multisite.outbox.push({ id: command.command_id, command, createdAt: new Date().toISOString(), acceptedAt: null }) }
  queueExecutionCommand(legacy, legacyParent, 'cancel', null, new Date().toISOString(), 'local')
  migrateState(legacy)
  const memory = { async read() { return legacy }, async update(fn) { return fn(legacy) } }, bridge = createNodeBridge({ store: memory, nodes, getMultisite: () => service, gateway: {}, scanIntervalMs: 5000 })
  const server = createServer((request, response) => bridge.handle(request, response, new URL(request.url, 'http://localhost'))); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); bridge.start()
  const client = createRemoteClient({ origin: `http://127.0.0.1:${server.address().port}`, identity }), abort = new AbortController()
  try {
    const resync = await client.resync(); assert(jsonBytes(resync) <= BRIDGE_LIMIT); assert.equal(resync.unavailable.filter(row => row.kind === 'command_unavailable').length, 33); assert(resync.unavailable.some(row => row.kind === 'wait_unavailable'))
    const first = resync.unavailable.find(row => row.kind === 'command_unavailable'); await assert.rejects(client.resolveCommand({ kind: 'command_ref', commandId: first.commandId, payloadDigest: first.payloadDigest }), { code: 'COMMAND_UNAVAILABLE' })
    const stream = await client.stream(abort.signal); let diagnostics = 0, cancel
    for await (const item of stream) { if (item.kind === 'command_unavailable') { diagnostics++; continue }; cancel = item; break }
    assert.equal(diagnostics, 32); assert.equal(cancel.operation, 'cancel'); assert(legacy.multisite.outbox.filter(row => row.command.operation === 'wake').every(row => row.acceptedAt === null))
    await client.ack(cancel); assert(legacy.multisite.outbox.find(row => row.id === cancel.command_id).acceptedAt)
    await writeFile(join(path, 'result.json'), JSON.stringify({ result: 'passed', boundary: 'explicit unsupported oversize metadata and legacy compatibility negative fixtures; production-derived base, actual FileStore transaction and HTTP handler; not business acceptance', waitRejectedBeforeReceiptAndGeneration: true, rejectedToolNoPark: true, smallerBatchSameSessionGenerationOne: true, queueRollback: true, payloadByteBoundary: RESULT_PAYLOAD_LIMIT, oldUnavailableRetainedWithoutAck: 33, diagnosticsDoNotConsumeInflight: true, cancelStillDeliveredAndExactAcked: true, legacyWaitDiagnostic: true }, null, 2))
  } finally { abort.abort(); bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close() }
}
