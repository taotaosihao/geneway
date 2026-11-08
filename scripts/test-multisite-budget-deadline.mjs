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
import { messageId } from '../packages/agent-host/delivery.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/budget-deadline-'), bodies = [], responses = new Set()
let fixture, host
const upstream = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  responses.add(response); response.on('close', () => responses.delete(response))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write('data: {"choices":[{"delta":{"content":"期限前已开始，但尚未完成"},"finish_reason":null}]}\n\n')
})
try {
  console.log(JSON.stringify({ stage: 'starting', directory }))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const options = { directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }
  fixture = await startBridgeService(options)
  await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-deadline-provider-only', { mode: 0o600 })
  async function login() {
    const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
    assert(response.ok); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] }
  }
  let actor = await login()
  async function api(path, body, method = 'POST') {
    const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, value: await response.json() }
  }
  const state = await fixture.store.read(), employee = state.employees.find(row => row.id === 'coordinator'), route = state.modelRoutes.find(row => row.id === employee.modelRouteId)
  const limits = { maxModelRequests: 20, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }
  assert.equal((await api('/api/admin/budget-policies/deadline-test', { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits, executionTimeoutMs: 60000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }, 'PUT')).status, 200)
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
  const pair = await fixture.nodes.createPairing({ id: 'owner' }, { clientRequestId: 'pair', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const redeemed = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'redeem', ...identity }); Object.assign(identity, { nodeId: 'cloud', registrationRevision: redeemed.node.registrationRevision })
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
  host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ event: event => client.event(event), call: (execution, operation, parameters) => client.command(execution, operation, parameters) })
  async function pump() { for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  const created = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '真实HTTP在途期限中止与未知不重发', clientRequestId: 'work', budgetPolicyId: 'deadline-test' }); assert.equal(created.status, 200)
  const workId = created.value.id; await pump()
  const current = await fixture.store.read(), execution = current.multisite.attempts.find(row => row.work_id === workId), input = current.multisite.inputs.find(row => row.workId === workId), inputMessageId = messageId(input.id, execution.attempt_id, execution.session_id)
  const issued = await client.issue(execution, { request: true, inputMessageId }); assert(issued.expiresAt <= Date.parse(current.works.find(row => row.id === workId).modelRequestBudget.executionDeadlineAt))
  const body = { model: execution.modelSnapshot.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: '模拟长流，不发送完成标记' }], tools: [] }
  const response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200)
  const reader = response.body.getReader(), first = await reader.read(); assert(!first.done)
  const reserved = structuredClone((await fixture.store.read()).modelRequests[0])
  // Extend and then shorten the active request through the real admin API. Neither adjustment may resend it.
  let streamClosed = false; reader.closed.then(() => { streamClosed = true }, () => { streamClosed = true })
  const oldDeadline = new Date(Date.now() + 1000).toISOString()
  assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'first-short-deadline', expectedRevision: 1, reason: '建立可跨越的旧期限', limits, executionDeadlineAt: oldDeadline })).status, 200)
  const extended = new Date(Date.now() + 2200).toISOString()
  assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'extend-live', expectedRevision: 2, reason: '测试活流延长只重校timer', limits, executionDeadlineAt: extended })).status, 200)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(oldDeadline) - Date.now()) + 50))
  assert.equal(bodies.length, 1); assert.equal(streamClosed, false, 'extension must keep the same stream alive across its old deadline')
  const shortened = new Date(Date.now() + 500).toISOString()
  assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'shorten-live', expectedRevision: 3, reason: '测试活流提前到期', limits, executionDeadlineAt: shortened })).status, 200)
  console.log(JSON.stringify({ stage: 'awaiting-deadline-abort', directory, workId, executionDeadlineAt: shortened }))
  let aborted = false
  try { while (!(await reader.read()).done) {} } catch { aborted = true }
  assert(aborted, 'incomplete SSE must terminate as an error')
  const expired = await fixture.store.read(), row = expired.modelRequests[0]
  assert.deepEqual(row, reserved); assert.equal(row.outcome, 'unknown'); assert.equal(row.usage, null); assert.equal(row.completedAt, null); assert.equal(bodies.length, 1); assert.equal(digest(bodies[0]), row.bodyDigest)
  await assert.rejects(client.authorize(execution), { code: 'EXECUTION_DEADLINE' })
  await assert.rejects(client.issue(execution, { request: true, inputMessageId }), { code: 'EXECUTION_DEADLINE' })
  await assert.rejects(client.command(execution, 'publish_observation', { clientRequestId: 'expired-observation', instructionRevision: 1, text: '到期不得新增业务' }), { code: 'EXECUTION_DEADLINE' })
  await writeFile(join(directory, 'expired-state.json'), JSON.stringify(expired, null, 2))
  // Actual API object restart loses its token map, retaining the same FileStore and unknown request.
  await fixture.close(); fixture = await startBridgeService(options)
  const restartedClient = createRemoteClient({ origin: fixture.origin, identity }); actor = await login()
  assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'extend-after-unknown', expectedRevision: 4, reason: '延长期限不恢复已forward未知请求', limits, executionDeadlineAt: new Date(Date.now() + 60000).toISOString() })).status, 200)
  await assert.rejects(restartedClient.issue(execution, { request: true, inputMessageId }), { code: 'RUNTIME_REQUEST_UNKNOWN' })
  assert.deepEqual((await fixture.store.read()).modelRequests, [reserved]); assert.equal(bodies.length, 1)
  // Expire again so actual stop delivery and its exact old receipt replay are tested after the deadline.
  assert.equal((await api(`/api/admin/works/${workId}/budget`, { clientRequestId: 'expire-before-stop', expectedRevision: 5, reason: '过期后清理仍可达', limits, executionDeadlineAt: new Date(Date.now() + 100).toISOString() })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 150))
  await fixture.service.multisite.apply({ id: 'owner' }, 'cancel', { workId, clientRequestId: 'stop' })
  for (const command of (await restartedClient.resync()).pending) { assert.equal(command.operation, 'cancel'); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await restartedClient.ack(command) }
  await host.process(); await host.flushEvents(event => restartedClient.event(event))
  const stopped = await fixture.store.read(); assert.equal(stopped.works.find(row => row.id === workId).status, 'cancelled'); assert.equal(bodies.length, 1)
  const stopReceipt = stopped.multisite.receipts.find(row => row.event.kind === 'stopped'); assert(stopReceipt); assert.deepEqual(await restartedClient.event(stopReceipt.event), stopReceipt.ack)
  const result = { result: 'passed', directory, boundary: 'real admin/Node/model/upstream HTTP and FileStore reopen; real Host/AgentDelivery with simulated runtime; no native DSH idle proof claim', activeDeadlineAdjustmentOnlyReschedulesAbort: true, extendedStreamSurvivesOriginalDeadline: true, incompleteStreamAbortedAndUnknownUnchanged: true, tokenExpiryNoLaterThanDeadline: true, expiredAuthorizeModelAndObservationRejected: true, restartAndAdminExtensionNeverReforwardUnknown: true, expiredCancelStopAndExactReceiptReplay: true, actualProviderRequests: bodies.length, pricesAreSimulated: true }
  await writeFile(join(directory, 'final-state.json'), JSON.stringify(stopped, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack }, null, 2)); console.error(directory); throw cause } finally { await host?.close(); await fixture?.close(); for (const response of responses) response.destroy(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
