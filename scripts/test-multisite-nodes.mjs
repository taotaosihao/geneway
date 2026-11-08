import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { childRequest } from './fixtures/multisite/delegation.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { binding, digest, seal } from '../packages/agent-contracts/index.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/nodes-focused-')
let now = Date.now(), fixture
const actorHeaders = session => ({ origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken })
try {
  let actualForwardRequests = 0
  fixture = await startBridgeService({ directory, clock: () => now, fetchImpl: async () => { actualForwardRequests++; return new Response('data: {"choices":[{"index":0,"delta":{"content":"synthetic bounded response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) } })
  await mkdir(join(directory, 'secrets')); await writeFile(join(directory, 'secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
  async function login(loginName) { const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName, password: `synthetic ${loginName} password` }) }); assert(response.ok); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
  const owner = await login('owner'), peer = await login('peer')
  async function api(path, body, { session = owner, method = 'POST', headers = actorHeaders(session) } = {}) { const response = await fetch(fixture.origin + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, value: await response.json() } }
  const config = (nodeId, allowedAgentIds, clientRequestId = nodeId) => ({ nodeId, clientRequestId, siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(now + 60_000).toISOString() })
  assert.equal((await api('/api/admin/nodes/pairings', config('bad', ['coordinator']), { session: peer })).status, 403)
  assert.equal((await api('/api/admin/nodes/pairings', config('bad', ['coordinator']), { headers: { origin: fixture.origin, cookie: owner.cookie } })).status, 403)
  async function pair(nodeId, agents) {
    const created = await api('/api/admin/nodes/pairings', config(nodeId, agents)); assert.equal(created.status, 200)
    const credential = randomBytes(32).toString('base64url'), nodeInstanceId = randomUUID(), parameters = { pairingId: created.value.pairingId, pairingCode: created.value.pairingCode, clientRequestId: randomUUID(), nodeInstanceId, credential }
    const first = await api('/internal/nodes/pair', parameters, { headers: {} }); assert.equal(first.status, 200)
    const replay = await api('/internal/nodes/pair', parameters, { headers: {} }); assert.deepEqual(replay, first)
    assert.equal((await api('/internal/nodes/pair', { ...parameters, credential: randomBytes(32).toString('base64url') }, { headers: {} })).status, 409)
    return { node: first.value.node, parameters, headers: { authorization: `Bearer ${credential}`, 'x-geneway-node-instance': nodeInstanceId, 'x-geneway-host-run': randomUUID() } }
  }
  const cloud = await pair('cloud', ['coordinator', 'analysis']), pcA = await pair('pc-a', ['desktop-data']), pcB = await pair('pc-b', ['desktop-office'])
  const expired = await api('/api/admin/nodes/pairings', config('expired', ['gateway'])); now += 61_000
  assert.equal((await api('/internal/nodes/pair', { pairingId: expired.value.pairingId, pairingCode: expired.value.pairingCode, clientRequestId: randomUUID(), nodeInstanceId: randomUUID(), credential: randomBytes(32).toString('base64url') }, { headers: {} })).status, 401)
  const resource = { clientRequestId: 'history-resource', expectedRevision: null, workspaceId: 'local', siteId: 'simulated-site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], enabled: true }
  assert.equal((await api('/api/admin/resources/fixture%3Ahistory', resource, { method: 'PUT' })).status, 200)
  assert.equal((await api('/api/admin/resources/fixture%3Ahistory', { ...resource, clientRequestId: 'stale', expectedRevision: 999 }, { method: 'PUT' })).status, 409)
  const serialized = await readFile(join(directory, 'state.json'), 'utf8')
  for (const node of [cloud, pcA, pcB]) { assert(!serialized.includes(node.parameters.credential)); assert(!serialized.includes(node.parameters.pairingCode)) }
  const directoryReply = await api('/api/admin/nodes', undefined, { method: 'GET' }); assert.equal(directoryReply.status, 200); assert(!JSON.stringify(directoryReply.value).includes('credentialHash'))
  const created = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '受控远端目录与权限验证。', clientRequestId: 'create' }); assert.equal(created.status, 200)
  const state = await fixture.store.read(), root = state.multisite.attempts[0], launch = state.multisite.outbox[0].command
  assert.equal(root.nodeSnapshot.nodeInstanceId, cloud.node.nodeInstanceId)
  const forged = { ...binding(root), session_id: 'arbitrary-session' }, prebound = { ...binding(root), session_id: `geneway-${root.launch_id}` }
  assert.equal((await api('/internal/executions/authorize', { binding: forged }, { headers: cloud.headers })).status, 403)
  assert.equal((await api('/internal/executions/authorize', { binding: prebound }, { headers: pcB.headers })).status, 403)
  const authorized = await api('/internal/executions/authorize', { binding: prebound }, { headers: cloud.headers }); assert.equal(authorized.status, 200); assert(!authorized.value.state); assert(!authorized.value.members)
  const host = createAgentHost({ nodeId: 'cloud', journal: createHostJournal(join(directory, 'cloud-host.json')), runtime: createSimulatedRuntime({ path: join(directory, 'cloud-sessions.json') }) })
  const accept = await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, launch)
  const ackBody = { commandId: launch.command_id, payloadDigest: launch.payload_digest, binding: binding(launch), nodeInstanceId: cloud.node.nodeInstanceId, registrationRevision: cloud.node.registrationRevision }
  assert.equal((await api('/internal/bridge/acks', { ...ackBody, payloadDigest: '0'.repeat(64) }, { headers: cloud.headers })).status, 409)
  assert.equal((await api('/internal/bridge/acks', ackBody, { headers: cloud.headers })).status, 200)
  await host.process()
  await host.flushEvents(async event => { const reply = await api('/internal/bridge/events', { event }, { headers: cloud.headers }); assert.equal(reply.status, 200); return reply.value })
  const current = (await fixture.store.read()).multisite.attempts[0]
  const parameters = childRequest('delegate-a', 'desktop-data')
  const delegated = await api('/internal/agent/commands', { binding: binding(current), operation: 'delegate', parameters }, { headers: cloud.headers }); assert.equal(delegated.status, 200)
  assert.deepEqual(await api('/internal/agent/commands', { binding: binding(current), operation: 'delegate', parameters }, { headers: cloud.headers }), delegated)
  assert.equal((await api('/internal/agent/commands', { binding: binding(current), operation: 'delegate', parameters: { ...childRequest('cross-node'), resourceRefs: ['fixture:unregistered'] } }, { headers: cloud.headers })).status, 403)
  assert.equal((await api('/internal/agent/commands', { binding: binding(current), operation: 'delegate', parameters: childRequest('forged-node') }, { headers: pcB.headers })).status, 403)
  const tokenBody = { binding: binding(current), options: { clientRequestId: 'stable-initial-issue' } }, token1 = await api('/internal/executions/tokens', tokenBody, { headers: cloud.headers }), token2 = await api('/internal/executions/tokens', tokenBody, { headers: cloud.headers })
  assert.equal(token1.status, 200); assert.equal(token2.status, 200); assert.notEqual(token1.value.token, token2.value.token); assert.equal((await fixture.store.read()).executionIssuances.length, 1)
  assert.equal((await api('/internal/executions/tokens', { binding: binding(current), options: { clientRequestId: 'stable-initial-issue', request: true } }, { headers: cloud.headers })).status, 409)
  const input = (await fixture.store.read()).multisite.inputs.find(row => row.workId === current.work_id), inputMessageId = messageId(input.id, current.attempt_id, current.session_id)
  for (let index = 0; index < 13; index++) {
    const issued = await api('/internal/executions/tokens', { binding: binding(current), options: { clientRequestId: `budget-request-${index}`, request: true, inputMessageId } }, { headers: cloud.headers }); assert.equal(issued.status, 200)
    const forwarded = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.value.token}` }, body: JSON.stringify({ model: current.modelSnapshot.model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: '真实 gateway 预算 producer' }] }) }); await forwarded.text(); assert.equal(forwarded.status, index < 12 ? 200 : 409)
  }
  const exhausted = await fixture.store.read(); assert.equal(actualForwardRequests, 12); assert.equal(exhausted.works[0].error.code, 'BUDGET_EXHAUSTED'); assert(exhausted.works[0].modelRequestBudget.exhaustedAt)
  assert.equal((await api('/api/admin/nodes/cloud/revoke', { clientRequestId: 'revoke-bad', expectedRevision: 999 })).status, 409)
  const revoked = await api('/api/admin/nodes/cloud/revoke', { clientRequestId: 'revoke', expectedRevision: cloud.node.revision }); assert.equal(revoked.status, 200)
  assert.equal((await api('/internal/executions/authorize', { binding: binding(current) }, { headers: cloud.headers })).status, 403)
  assert.equal((await api('/internal/agent/commands', { binding: binding(current), operation: 'delegate', parameters: childRequest('post-revoke') }, { headers: cloud.headers })).status, 403)
  const cleanup = await api('/internal/bridge/resync', { hostRunId: 'cleanup-run' }, { headers: cloud.headers }); assert.equal(cleanup.status, 200); assert(cleanup.value.pending.every(row => ['cancel', 'settle'].includes(row.operation))); assert(!JSON.stringify(cleanup.value).includes('受控远端目录'))
  const cancel = cleanup.value.pending.find(row => row.operation === 'cancel'); assert(cancel)
  await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, cancel); await host.process()
  await host.flushEvents(async event => { const reply = await api('/internal/bridge/events', { event }, { headers: cloud.headers }); assert.equal(reply.status, 200); return reply.value })
  assert.equal((await fixture.store.read()).multisite.attempts[0].status, 'cancelled')
  assert.equal((await fixture.store.read()).works[0].error.code, 'BUDGET_EXHAUSTED'); assert.equal((await fixture.store.read()).works[0].modelRequestBudget.reserved, 12)
  await host.close()
  const firstSessionWork = await api('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '首次 Session 上报前撤权。', clientRequestId: 'first-session-work' }); assert.equal(firstSessionWork.status, 200)
  const firstState = await fixture.store.read(), firstLaunch = firstState.multisite.outbox.find(row => row.command.work_id === firstSessionWork.value.id).command
  const firstJournal = createHostJournal(join(directory, 'first-session-host.json')), firstHost = createAgentHost({ nodeId: 'pc-b', journal: firstJournal, runtime: createSimulatedRuntime({ path: join(directory, 'first-session-sessions.json') }) })
  await firstHost.accept({ workspaceId: 'local', nodeId: 'pc-b' }, firstLaunch); await firstHost.process()
  assert.equal((await fixture.store.read()).multisite.attempts.find(row => row.work_id === firstSessionWork.value.id).session_id, null)
  assert((await firstJournal.read()).outbox.some(row => row.event.kind === 'started'))
  assert.equal((await api('/api/admin/nodes/pc-b/revoke', { clientRequestId: 'revoke-first-session', expectedRevision: pcB.node.revision })).status, 200)
  const firstCleanup = await api('/internal/bridge/resync', { hostRunId: 'first-session-cleanup' }, { headers: pcB.headers }), firstCancel = firstCleanup.value.pending.find(row => row.command_id && row.operation === 'cancel')
  await firstHost.accept({ workspaceId: 'local', nodeId: 'pc-b' }, firstCancel); await firstHost.process()
  const stopped = (await firstJournal.read()).outbox.find(row => row.event.kind === 'stopped').event
  assert.equal(stopped.stop_evidence, 'idle_after_cancel')
  const { payload_digest, ...unsigned } = stopped, forgedStop = seal({ ...unsigned, session_id: 'arbitrary-session' })
  assert.equal((await api('/internal/bridge/events', { event: forgedStop }, { headers: pcB.headers })).status, 403)
  await firstHost.flushEvents(async event => { const reply = await api('/internal/bridge/events', { event }, { headers: pcB.headers }); if (reply.status !== 200) throw Object.assign(new Error('node event rejected'), { code: reply.value.error.code }); return reply.value }, { cleanupOnly: true })
  const firstFinal = await fixture.store.read(), firstAttempt = firstFinal.multisite.attempts.find(row => row.work_id === firstSessionWork.value.id)
  assert.equal(firstAttempt.status, 'cancelled'); assert.equal(firstAttempt.session_id, `geneway-${firstLaunch.launch_id}`)
  assert.equal(firstFinal.multisite.receipts.find(row => row.event.event_id === stopped.event_id).historical, false)
  const firstHostFinal = await firstJournal.read(); assert(firstHostFinal.outbox.find(row => row.event.kind === 'stopped').acknowledged); assert(firstHostFinal.outbox.filter(row => row.event.kind !== 'stopped').every(row => !row.acknowledged))
  assert.equal((await api('/internal/bridge/events', { event: stopped }, { headers: pcB.headers })).status, 200)
  await firstHost.close()
  const result = { result: 'passed', directory, boundary: 'actual HTTP auth/CSRF/FileStore/Node service/Bridge and Host journal producers; simulated Host runtime, no remote process/native business proof', hashOnlyPairing: true, redemptionLostAckReplay: true, forbiddenSessionAndNode: true, resourceCas: true, stableIssuanceId: true, revokeCleanupBindingOnly: true, actualStoppedEvent: true, firstSessionRevocationStop: true, rejectedOrdinaryEventsRemainUnacked: true, forgedFirstSessionRejected: true, actualGatewayForwards: actualForwardRequests, exhaustedRevocationPreservesBudget: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await fixture?.close() }
