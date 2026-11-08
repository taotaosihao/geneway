import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding, seal } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-control-integration-'), observations = []
const mode = process.argv.includes('--unanswered-question') ? 'unanswered-question' : process.argv.includes('--obsolete-intent') ? 'obsolete-intent' : process.argv.includes('--idle-intent') ? 'idle-intent' : process.argv.includes('--idle-ordinary') ? 'idle-ordinary' : 'pending-source'
let fixture, host
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0]
  async function api(path, body, method = 'POST', status = 200) {
    const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json()
    observations.push({ path, method, status: response.status, value }); assert.equal(response.status, status, JSON.stringify(value)); return value
  }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair-cloud', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 60000).toISOString() })
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity }), paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem-cloud', ...identity }); identity.registrationRevision = paired.node.registrationRevision
  const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
  let idle = true
  runtime.inspectState = async () => ({ idle }) // Controlled simulator only; no SDK idle claim.
  host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
  async function pump() { for (const delivery of (await client.resync()).pending) { const command = await client.resolveCommand(delivery); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  const created = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '人工暂停保留同一Session及当前责任人', clientRequestId: 'create' }); await pump()
  const before = await fixture.store.read(), original = before.multisite.attempts.find(row => row.work_id === created.id), execution = binding(original)
  const thread = await api('/api/interaction/threads', { clientRequestId: 'thread' })
  let source, oldToken
  if (!['idle-ordinary', 'obsolete-intent'].includes(mode)) {
    source = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'source-1', sourceEventId: 'source-1', version: 1, expectedThreadRevision: 1, text: '请原处理者判断这个请求。', routingPolicyId: null })
    const catalog = await api('/api/interaction/directory', undefined, 'GET')
    await api(`/api/interaction/threads/${thread.id}/selection`, { clientRequestId: 'choose-work', intentId: source.intentId, expectedRouteRevision: 1, targetWorkId: created.id, candidateVersion: catalog.candidateVersion, offset: 0 }); await pump()
    const ingested = await fixture.store.read(); assert(ingested.contextSubscriptions.find(row => row.intentId === source.intentId)?.ingestedAt)
    const command = ingested.multisite.outbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence.intentId === source.intentId).command
    oldToken = await client.issueIntentReview(execution, command.command_id, { request: true, inputMessageId: messageId(command.input_id, execution.attempt_id, execution.session_id) })
  } else {
    const input = before.multisite.inputs.find(row => row.workId === created.id)
    oldToken = await client.issue(execution, { request: true, inputMessageId: messageId(input.id, execution.attempt_id, execution.session_id) })
  }
  const baselineMessages = runtime.messageCount()
  await api(`/api/works/${created.id}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }); await pump()
  const independent = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'paused-independent', sourceEventId: 'paused-independent', version: 1, expectedThreadRevision: 2, text: '独立请求S仍须由当前处理者判断，不替代正式要求。', routingPolicyId: null })
  const attached = await fixture.store.read(), intent = attached.workIntents.find(row => row.id === independent.intentId), oldSubscription = attached.contextSubscriptions.find(row => row.id === intent.handlerSubscriptionId), oldCommand = attached.multisite.outbox.find(row => row.command.parameters.intentFence?.intentId === intent.id).command
  assert.equal(intent.state, 'attached'); assert.equal(oldSubscription.ingestedAt, null); assert.equal(oldCommand.instruction_revision, 1)
  await api(`/api/works/${created.id}/multisite/inputs`, { clientRequestId: 'formal-input-2', text: '正式当前要求第二版，须先真实消费再判断独立请求S。' })
  await pump(); const paused = await fixture.store.read(); assert.equal(paused.works[0].instructionRevision, 2); assert.equal(runtime.messageCount(), baselineMessages)
  await writeFile(join(directory, 'paused-input2.json'), JSON.stringify(paused, null, 2))
  await api(`/api/works/${created.id}/multisite/resume`, { clientRequestId: 'resume', scope: { kind: 'work' }, expectedControlGeneration: 1 })
  for (let count = 0; count < 5; count++) await pump()
  const final = await fixture.store.read(), currentIntent = final.workIntents.find(row => row.id === intent.id), currentSubscription = final.contextSubscriptions.find(row => row.id === currentIntent.handlerSubscriptionId), currentInput = final.multisite.inputs.find(row => row.workId === created.id && row.revision === 2)
  await writeFile(join(directory, 'after-pumps.json'), JSON.stringify(final, null, 2))
  assert.equal(currentIntent.state, 'attached'); assert(currentInput.deliveries.every(row => row.ingestedAt)); assert.equal(final.multisite.inputs.length, 2); assert.equal(final.modelRequests.length, 0)
  await assert.rejects(client.issueIntentReview(execution, oldCommand.command_id, { request: true, inputMessageId: messageId(oldCommand.input_id, execution.attempt_id, execution.session_id) }), { code: 'FORBIDDEN' })
  if (process.argv.includes('--expect-before')) { assert.equal(currentSubscription.id, oldSubscription.id); assert.equal(currentSubscription.ingestedAt, null); console.log('Observed: Input2 consumed but S remains attached to unusable rev1 command') }
  else {
    assert.notEqual(currentSubscription.id, oldSubscription.id); assert(currentSubscription.ingestedAt); assert.equal(currentSubscription.revision, oldSubscription.revision + 1)
    const fresh = final.multisite.outbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence?.intentId === intent.id && row.command.parameters.intentFence.subscriptionRevision === currentSubscription.revision).command
    assert.equal(fresh.instruction_revision, 2); assert.equal(fresh.parameters.sourceEvent.text, oldCommand.parameters.sourceEvent.text)
    const token = await client.issueIntentReview(execution, fresh.command_id, { request: true, inputMessageId: messageId(fresh.input_id, execution.attempt_id, execution.session_id) }); assert.equal(token.intentReviewCommandId, fresh.command_id); assert.deepEqual(token.intentFence, fresh.parameters.intentFence)
    assert.equal(final.contextSubscriptions.find(row => row.id === oldSubscription.id).lifecycle, 'released'); assert.equal(final.contextSubscriptions.find(row => row.id === oldSubscription.id).ingestedAt, null)
    const events = (await journal.read()).outbox.filter(row => row.event.kind === 'session_ingested' && row.event.instruction_revision === 2); assert.equal(events.length, 1)
  }
  await api(`/api/works/${created.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  const result = { result: 'passed', directory, baseline: process.argv.includes('--expect-before'), currentInput2Consumed: true, independentIntentRemainsAttached: true, sourceTextPreserved: true, actualModelForwards: 0, boundary: 'real HTTP/Node/Host/AgentDelivery simulator; no official SDK idle or native model claim' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { await host?.close(); await fixture?.close(); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Manual Input2 root:', directory) }
