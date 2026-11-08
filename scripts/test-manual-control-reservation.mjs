import assert from 'node:assert/strict'
import fs, { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-reservation-'), originalRead = fs.readFile, observations = []
let fixture, host, provider, release, reached, armed = false, providerCalls = 0
const barrier = new Promise(resolve => { release = resolve }), held = new Promise(resolve => { reached = resolve })
try {
  provider = createServer((request, response) => { providerCalls++; request.resume(); response.end('unexpected provider call') }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` })
  const secretPath = join(directory, 'api/secrets/key'); await mkdir(join(directory, 'api/secrets')); await writeFile(secretPath, 'synthetic-manual-reservation', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); observations.push({ path, status: response.status }); return value }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 60000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity }), paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', ...identity }); identity.registrationRevision = paired.node.registrationRevision
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ call: (execution, operation, parameters) => client.command(execution, operation, parameters), event: event => client.event(event) })
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '实际credential读取后、最终reserve前夹人工暂停', clientRequestId: 'create' })
  for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
  const before = await fixture.store.read(), attempt = before.multisite.attempts.find(row => row.work_id === work.id), input = before.multisite.inputs.find(row => row.workId === work.id), token = await client.issue(binding(attempt), { request: true, inputMessageId: messageId(input.id, attempt.attempt_id, attempt.session_id) })
  fs.readFile = async function (path, ...args) { const value = await originalRead(path, ...args); if (armed && path === secretPath) { armed = false; reached(); await barrier }; return value }; syncBuiltinESMExports(); armed = true
  const running = fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: attempt.modelSnapshot.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: input.text }], tools: [] }) })
  await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error('credential read barrier not reached')), 5000))])
  const pause = await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause-during-credential-io', scope: { kind: 'work' }, expectedControlGeneration: 0 }); assert.equal(pause.controlGeneration, 1)
  const paused = await fixture.store.read(); assert.equal(paused.modelRequests.length, 0)
  release(); const response = await running, value = await response.json(); assert.equal(response.status, 409); assert.equal(value.error.code, 'REVISION_CONFLICT')
  const after = await fixture.store.read(); assert.equal(after.modelRequests.length, 0); assert.equal(providerCalls, 0); assert.deepEqual(after.works.find(row => row.id === work.id).modelRequestBudget, before.works.find(row => row.id === work.id).modelRequestBudget)
  await writeFile(join(directory, 'before.json'), JSON.stringify(before, null, 2)); await writeFile(join(directory, 'paused-before-reserve.json'), JSON.stringify(paused, null, 2)); await writeFile(join(directory, 'response.json'), JSON.stringify({ status: response.status, body: value }, null, 2)); await writeFile(join(directory, 'after.json'), JSON.stringify(after, null, 2))
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel' }); for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
  const result = { result: 'passed', directory, actualHttpPauseDuringCredentialRead: true, initialGatewayAuthorityPassedBeforeBarrier: true, finalReservationRejectsChangedControlFence: true, actualProviderCalls: providerCalls, actualModelReservations: 0, boundary: 'real HTTP/paired Node/durable Store/AgentDelivery simulator; fixture barrier after actual synthetic credential file read before final Store mutation; no SDK/physical fault claim and no secret content captured' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { release(); fs.readFile = originalRead; syncBuiltinESMExports(); await host?.close(); await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Manual reservation root:', directory) }
