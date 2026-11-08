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

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-budget-'), bodies = [], manualFirst = process.argv.includes('--manual-first'), newInput = process.argv.includes('--new-input')
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
  assert.equal((await send(await client.issue(execution, { request: true, inputMessageId: originalMessageId }), body)).status, 200)
  const refused = await send(await client.issue(execution, { request: true, inputMessageId: originalMessageId }), body); assert.equal(refused.status, 409); assert(refused.text.includes('WAITING_BUDGET')); await pump()
  const held = await fixture.store.read(); assert(held.budgetHolds[0].idleAt); assert.equal(bodies.length, 1)
  await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }); await pump()
  const paused = await fixture.store.read(); assert(paused.manualControls[0].holders[0].idleAt); assert.equal((await journal.read()).executions[0].waitStatus, 'waiting_budget')
  if (newInput) await api(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'new-input-during-both-waits', text: '人工与预算双等待期间保存的最新要求，不复发旧请求。' })
  const adjust = () => api(`/api/admin/works/${work.id}/budget`, { clientRequestId: 'adjust', expectedRevision: 1, reason: '显式模拟测试：同Work额度1调整4，不能解除人工原因', limits: { ...policy.limits, maxModelRequests: 4 }, executionDeadlineAt: held.works.find(row => row.id === work.id).modelRequestBudget.executionDeadlineAt })
  const release = () => api(`/api/works/${work.id}/multisite/resume`, { clientRequestId: 'resume', scope: { kind: 'work' }, expectedControlGeneration: 1 })
  if (manualFirst) {
    await release(); await pump(); const onlyManual = await fixture.store.read(); assert(onlyManual.manualControls[1].holders[0].releasedAt); assert.equal(onlyManual.budgetHolds[0].state, 'waiting'); assert.equal(onlyManual.multisite.messages.filter(row => row.kind === 'manual_resume').length, 0); await assert.rejects(client.issue(execution), { code: 'WAITING_BUDGET' }); await writeFile(join(directory, 'only-manual-released.json'), JSON.stringify(onlyManual, null, 2)); await adjust()
  } else {
    await adjust(); await pump(); const onlyBudget = await fixture.store.read(); assert.equal(onlyBudget.manualControls[0].action, 'pause'); assert.equal(bodies.length, 1); await assert.rejects(client.issueBudgetResume(execution, onlyBudget.budgetHolds[0].resumeCommandId), { code: 'MANUALLY_PAUSED' }); await writeFile(join(directory, 'only-budget-adjusted.json'), JSON.stringify(onlyBudget, null, 2)); await release()
  }
  await until(async () => { await pump(); return !!(await fixture.store.read()).manualControls[1].holders[0].resumeConsumedAt })
  const resumed = await fixture.store.read(), holder = resumed.manualControls[1].holders[0], command = resumed.multisite.outbox.find(row => row.id === holder.resumeCommandId).command
  assert.equal(resumed.multisite.messages.filter(row => row.kind === 'manual_resume').length, 0)
  let token, content
  if (newInput) {
    assert.equal(command.operation, 'deliver'); assert.equal(resumed.budgetHolds[0].state, 'cancelled'); assert.equal(resumed.budgetHolds[0].cancelledReason, 'SUPERSEDED_BY_INPUT'); const latest = resumed.multisite.inputs.find(row => row.workId === work.id && row.revision === 2); assert(latest.deliveries[0].ingestedAt); content = latest.text; token = await client.issue(execution, { request: true, inputMessageId: messageId(latest.id, execution.attempt_id, execution.session_id) })
  } else {
    assert.equal(command.parameters.messages[0].kind, 'budget_resume'); assert.equal(resumed.budgetHolds[0].state, 'resume_queued'); content = command.parameters.text; token = await client.issueBudgetResume(execution, command.command_id, { request: true, inputMessageId: messageId(command.input_id, execution.attempt_id, execution.session_id) })
  }
  assert.equal((await send(token, { ...body, messages: [{ role: 'user', content }] })).status, 200)
  const final = await fixture.store.read(); assert.equal(bodies.length, 2); assert.equal(final.modelRequests.length, 2); assert.deepEqual(final.modelRequests[0], held.modelRequests[0]); assert(!final.modelRequests.some(row => row.id === held.budgetHolds[0].requestId)); assert.equal(final.multisite.attempts[0].session_id, execution.session_id); assert.deepEqual(bodies.map(digest).sort(), final.modelRequests.map(row => row.bodyDigest).sort())
  for (const [name, value] of Object.entries({ held, paused, resumed, final })) await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2))
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop' }); await pump()
  const result = { result: 'passed', directory, order: manualFirst ? 'manual-release-before-budget-adjustment' : 'budget-adjustment-before-manual-release', humanNewInputWhileBothWaiting: newInput ? true : null, noExtraManualWakeOrInputReplay: true, sameSession: execution.session_id, actualProviderForwards: 2, originalHeldRequestNeverReservedOrForwarded: true, boundary: 'real admin/user/Node/gateway/provider HTTP with actual Host/AgentDelivery and durable control/budget facts; simulated idle/runtime and explicitly simulated 3/7 prices, not native SDK or vendor billing' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack, code: cause.code }, null, 2)); throw cause }
finally { await host?.close(); await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); console.log('Manual budget root:', directory) }
async function until(test) { const deadline = Date.now() + 10000; while (!await test()) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 30)) } }
