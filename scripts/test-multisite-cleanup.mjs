import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { error } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/cleanup-focused-'), owner = { id: 'owner' }, fixture = await startBridgeService({ directory: join(directory, 'api') })
let host
try {
  const pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair', nodeId: 'pc-a', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-data'], expiresAt: new Date(Date.now() + 60000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
  const reply = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', nodeInstanceId: identity.nodeInstanceId, credential: identity.credential }); Object.assign(identity, { nodeId: 'pc-a', registrationRevision: reply.node.registrationRevision })
  const resource = { clientRequestId: 'resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], enabled: true }
  await fixture.nodes.putResource(owner, 'fixture:history', resource)
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); host = createAgentHost({ nodeId: 'pc-a', journal, runtime })
  async function deliver() { for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId: 'pc-a' }, command); await client.ack(command) }; await host.process() }
  const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-data', clientRequestId: 'work', goal: '资源撤权后的严格清理' }); await deliver(); await host.flushEvents(event => client.event(event))
  const execution = (await journal.read()).executions[0]
  await runtime.report(execution.launch_id, { state: 'ready', summary: '撤权前已产生但未提交的普通报告' })
  await fixture.nodes.putResource(owner, 'fixture:history', { ...resource, clientRequestId: 'disable', expectedRevision: 1, enabled: false })
  const state = await fixture.store.read(), auth = fixture.nodes.authenticate(state, `Bearer ${identity.credential}`, identity.nodeInstanceId)
  assertNodeCaller(state, auth, execution, { cleanup: true }); assert.throws(() => assertNodeCaller(state, auth, execution), { code: 'FORBIDDEN' })
  for (const field of ['work_id', 'delegation_id', 'attempt_id', 'agent_id', 'node_id', 'launch_id', 'session_id']) assert.throws(() => assertNodeCaller(state, auth, { ...execution, [field]: 'forged' }, { cleanup: true }), { code: 'FORBIDDEN' })
  for (const change of [{ nodeInstanceId: randomUUID() }, { credentialVersion: auth.credentialVersion + 1 }, { workspaceId: 'other' }]) assert.throws(() => assertNodeCaller(state, { ...auth, ...change }, execution, { cleanup: true }), { code: 'FORBIDDEN' })
  await assert.rejects(host.flushEvents(event => client.event(event)), { code: 'FORBIDDEN' }); assert.equal((await journal.read()).executions[0].status, 'running')
  await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'cancel' }); await deliver()
  assert.equal((await journal.read()).executions[0].status, 'stopped')
  const read = journal.read
  for (const invalidProof of ['missing', 'binding', 'unverified']) {
    journal.read = async () => { const snapshot = await read(); if (invalidProof === 'missing') snapshot.outbox = snapshot.outbox.filter(row => row.event.kind !== 'stopped'); else { const event = snapshot.outbox.find(row => row.event.kind === 'stopped').event; if (invalidProof === 'binding') event.launch_id = 'other-binding'; else event.stop_evidence = 'unverified' }; return snapshot }
    let reachedStop = false
    try { await assert.rejects(host.flushEvents(async event => { if (event.kind === 'stopped') { reachedStop = true; throw error('TEST_STOP_REACHED') }; throw error('FORBIDDEN') }), { code: 'FORBIDDEN' }); assert.equal(reachedStop, false) } finally { journal.read = read }
  }
  await assert.rejects(host.flushEvents(async event => { if (event.kind === 'stopped') throw error('FORBIDDEN'); return client.event(event) }), { code: 'FORBIDDEN' })
  await host.flushEvents(event => client.event(event))
  const final = await fixture.store.read(), local = await journal.read(); assert.equal(final.works[0].status, 'cancelled'); assert(local.outbox.some(row => row.event.kind === 'report' && !row.acknowledged)); assert(local.outbox.find(row => row.event.kind === 'stopped').acknowledged)
  const result = { result: 'passed', directory, ordinaryExecutionStillDenied: true, cleanupRequiresCurrentIdentityAndFullBinding: true, activeWithoutProofCannotSkip: true, missingWrongBindingUnverifiedProofCannotSkip: true, stoppedReceiptForbiddenCannotSkip: true, actualIdleStopAfterResourceRevoke: true, ordinaryUnackedAndStoppedExactAck: true, boundary: 'real HTTP producer/AgentDelivery/cancel/stop; negative proof views only clone and remove/corrupt actual proof, never seed positive receipts' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await host?.close(); await fixture.close() }
