import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const wallNow = Date.now
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-deadline-'), bodies = [], manualFirst = process.argv.includes('--manual-first'), newInput = process.argv.includes('--new-input')
let fixture, host, provider
try {
  provider = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"模拟预算响应"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\ndata: [DONE]\n\n') }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); await mkdir(join(directory, 'api/secrets')); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-manual-budget', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body, method = 'POST') { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value }
  const initial = await fixture.store.read(), employee = initial.employees.find(row => row.id === 'coordinator'), route = initial.modelRoutes.find(row => row.id === employee.modelRouteId), policy = { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 1, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }
  await api('/api/admin/budget-policies/manual-budget', policy, 'PUT')
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 60000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity }), paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', ...identity }); identity.registrationRevision = paired.node.registrationRevision
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
  async function pump() { for (const delivery of (await client.resync()).pending) { const command = await client.resolveCommand(delivery); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', budgetPolicyId: 'manual-budget', goal: '独立预算等待与人工暂停，保原Session', clientRequestId: 'create' }); await pump()
  const before = await fixture.store.read(), execution = binding(before.multisite.attempts.find(row => row.work_id === work.id)), input = before.multisite.inputs.find(row => row.workId === work.id), originalMessageId = messageId(input.id, execution.attempt_id, execution.session_id), body = { model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: input.text }], tools: [] }
  async function send(token, value) { const response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json' }, body: JSON.stringify(value) }); return { status: response.status, text: await response.text() } }
  await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }); await pump()
  const paused = await fixture.store.read(); assert(paused.manualControls[0].holders[0].idleAt)
  const deadline = Date.parse(paused.works.find(row => row.id === work.id).modelRequestBudget.executionDeadlineAt)
  Date.now = () => deadline + 1 // Controlled application clock; no claim of real time waiting.
  await api(`/api/works/${work.id}/multisite/resume`, { clientRequestId: 'expired-release', scope: { kind: 'work' }, expectedControlGeneration: 1 }); await pump(); await pump()
  const expired = await fixture.store.read(); assert(expired.manualControls[1].holders[0].releasedAt); assert.equal(expired.manualControls[1].holders[0].resumeConsumedAt, null); assert.equal(expired.manualControls[1].holders[0].resumeCommandId, null); assert.equal(expired.modelRequests.length, 0); assert.equal(bodies.length, 0)
  await assert.rejects(client.issue(execution, { request: true, inputMessageId: originalMessageId }), { code: 'EXECUTION_DEADLINE' })
  await writeFile(join(directory, 'released-but-expired.json'), JSON.stringify(expired, null, 2))
  await api(`/api/admin/works/${work.id}/budget`, { clientRequestId: 'extend-expired-deadline', expectedRevision: 1, reason: '明确调整同Work执行截止，人工原因此前已安全解除', limits: policy.limits, executionDeadlineAt: new Date(deadline + 60000).toISOString() })
  for (let count = 0; count < 4; count++) await pump()
  const resumed = await fixture.store.read(), holder = resumed.manualControls[1].holders[0], resume = resumed.multisite.outbox.find(row => row.id === holder.resumeCommandId).command
  assert(holder.resumeConsumedAt); assert.equal(resume.parameters.messages[0].kind, 'manual_resume'); assert.equal(resumed.multisite.attempts[0].session_id, execution.session_id); assert.equal(resumed.works[0].instructionRevision, 1)
  const inputMessageId = messageId(resume.input_id, execution.attempt_id, execution.session_id)
  assert.equal((await send(await client.issue(execution, { request: true, inputMessageId }), body)).status, 200)
  const after = await fixture.store.read(); assert.equal(bodies.length, 1); assert.equal(after.modelRequests.length, 1); assert.equal(after.modelRequests[0].bodyDigest, digest(bodies[0])); assert.equal(after.modelRequests[0].manualResumeCommandId, resume.command_id)
  await writeFile(join(directory, 'resumed-current.json'), JSON.stringify(after, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2))
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  const result = { result: 'passed', directory, releaseDoesNotBypassExpiredDeadline: true, explicitSameWorkAdjustmentThenFreshResumeConsumed: true, actualModelForwards: 1, boundary: 'real HTTP/Node/Host AgentDelivery simulator/current gateway/upstream HTTP; controlled application Date.now beyond deadline, not wall time wait or official SDK idle' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { Date.now = wallNow; await host?.close(); await fixture?.close(); await new Promise(resolve => provider ? provider.close(resolve) : resolve()); console.log('Manual deadline root:', directory) }
