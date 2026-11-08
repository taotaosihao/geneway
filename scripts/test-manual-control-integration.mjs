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
  let question
  if(mode==='unanswered-question'){const snapshot=await fixture.store.read(),intent=snapshot.workIntents.find(row=>row.id===source.intentId),subscription=snapshot.contextSubscriptions.find(row=>row.id===intent.handlerSubscriptionId);await runtime.orchestration(execution,'ask_intent',{clientRequestId:'question-before-pause',intentFence:{intentId:intent.id,routeRevision:intent.routeRevision,handlerBinding:subscription.handlerBinding,subscriptionRevision:subscription.revision},text:'请用户明确恢复后核对哪项记录？'});question=(await fixture.store.read()).intentQuestions.find(row=>row.intentId===intent.id&&row.state==='open');assert(question)}
  const baselineMessages = runtime.messageCount()
  let obsoleteCommand
  if (mode === 'obsolete-intent') {
    const unconsumed = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'obsolete-source', sourceEventId: 'obsolete-source', version: 1, expectedThreadRevision: 1, text: '将被修订的尚未消费请求。', routingPolicyId: null })
    const directoryPage = await api('/api/interaction/directory', undefined, 'GET')
    await api(`/api/interaction/threads/${thread.id}/selection`, { clientRequestId: 'choose-obsolete', intentId: unconsumed.intentId, expectedRouteRevision: 1, targetWorkId: created.id, candidateVersion: directoryPage.candidateVersion, offset: 0 })
    obsoleteCommand = (await fixture.store.read()).multisite.outbox.find(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence.intentId === unconsumed.intentId).command
    await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'obsolete-source-v2', sourceEventId: 'obsolete-source', version: 2, expectedThreadRevision: 2, text: '当前第二版尚未定位，不授旧请求执行。', routingPolicyId: null })
  }
  idle = false
  await api(`/api/works/${created.id}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }); await pump()
  const pausing = await api('/api/works/' + created.id, undefined, 'GET'); assert.equal(pausing.multisite.manualControls[0].stage, 'pausing')
  let queued
  if (mode === 'pending-source') {
    queued = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'source-paused', sourceEventId: 'source-paused', version: 1, expectedThreadRevision: 2, text: '暂停期间的新正文，恢复后仍由原处理者判断。', routingPolicyId: null })
    const view = await api('/api/interaction/threads/' + thread.id, undefined, 'GET'); assert.equal(view.intents.find(row => row.id === queued.intentId).manualWait?.paused, true)
  }
  const queuedState = await fixture.store.read(); assert.equal(queuedState.routingRequests.length, 0); assert.equal(queuedState.modelRequests.length, 0)
  await pump(); assert.equal(runtime.messageCount(), baselineMessages)
  await writeFile(join(directory, 'pausing.json'), JSON.stringify(queuedState, null, 2))
  idle = true; await pump()
  const paused = await fixture.store.read(); assert(paused.manualControls[0].holders[0].idleAt); assert.equal(paused.manualControls[0].holders[0].idleEvidence, 'idle_and_flushed')
  const actualIdle = (await journal.read()).outbox.find(row => row.event.kind === 'manual_idle').event
  for (const changes of [{ manual_control: { ...actualIdle.manual_control, holderId: 'foreign-holder' } }, { input_id: 'foreign-input' }]) {
    const { payload_digest, ...body } = actualIdle
    await assert.rejects(client.event(seal({ ...body, ...changes, event_id: randomUUID() })), { code: 'FORBIDDEN' })
  }
  assert.deepEqual((await fixture.store.read()).manualControls, paused.manualControls)
  const pausedView = await api('/api/works/' + created.id, undefined, 'GET'); assert.equal(pausedView.multisite.manualControls[0].stage, 'paused')
  await api(`/api/works/${created.id}/multisite/resume`, { clientRequestId: 'resume', scope: { kind: 'work' }, expectedControlGeneration: 1 }); await pump()
  if(mode==='unanswered-question'){await pump();const open=await fixture.store.read();assert.equal(open.intentQuestions.find(row=>row.id===question.id).state,'open');assert.equal(open.manualControls[1].holders[0].resumeCommandId,null);assert.equal(open.multisite.messages.filter(row=>row.kind==='manual_resume').length,0);assert.equal(runtime.messageCount(),baselineMessages);const local=await journal.read();assert.equal(local.executions[0].waitStatus,'waiting_intent');assert.equal(local.executions[0].waitId,question.id);await writeFile(join(directory,'released-open-question.json'),JSON.stringify(open,null,2));await api(`/api/interaction/threads/${thread.id}/events`,{clientRequestId:'answer-after-release',sourceEventId:'answer-after-release',version:1,expectedThreadRevision:2,text:'解除人工暂停后明确回答同一问题。',replyToIntentQuestion:{id:question.id,routeRevision:question.routeRevision},routingPolicyId:null})}
  const releaseBeforeConsume = await fixture.store.read(), pendingResume = releaseBeforeConsume.manualControls[1].holders[0]
  assert(pendingResume.releasedAt); assert.equal(pendingResume.resumeConsumedAt, null)
  const metadata = await client.issue(execution); assert.equal(metadata.manualFence.workGeneration, 2)
  const originalInput = before.multisite.inputs.find(row => row.workId === created.id)
  await assert.rejects(client.issue(execution, { request: true, inputMessageId: messageId(originalInput.id, execution.attempt_id, execution.session_id) }), { code: 'MANUAL_RESUME_PENDING' })
  assert.equal((await fixture.store.read()).modelRequests.length, 0)
  await writeFile(join(directory, 'release-before-consume.json'), JSON.stringify(releaseBeforeConsume, null, 2))
  await pump()
  const final = await fixture.store.read(), current = final.multisite.attempts.find(row => row.attempt_id === original.attempt_id)
  assert(final.manualControls[1].holders[0].releasedAt); assert(final.manualControls[1].holders[0].resumeConsumedAt)
  assert.equal(current.session_id, original.session_id); assert.equal(current.instruction_revision, 1); assert.equal(runtime.messageCount(), baselineMessages + 1); assert.equal(final.modelRequests.length, 0); assert.equal(final.routingRequests.length, 0)
  const resumeCommand = final.multisite.outbox.find(row => row.id === final.manualControls[1].holders[0].resumeCommandId).command
  const freshInputMessageId = messageId(resumeCommand.input_id, execution.attempt_id, execution.session_id)
  const consumedToken = resumeCommand.operation === 'intent_review' ? await client.issueIntentReview(execution, resumeCommand.command_id, { request: true, inputMessageId: freshInputMessageId }) : await client.issue(execution, { request: true, inputMessageId: freshInputMessageId })
  assert.equal(consumedToken.manualFence.workGeneration, 2)
  if (mode === 'pending-source') assert(final.contextSubscriptions.find(row => row.intentId === queued.intentId && row.lifecycle === 'active').ingestedAt)
  else if (['idle-intent','unanswered-question'].includes(mode)) { assert.equal(resumeCommand.operation, 'intent_review'); assert.equal(resumeCommand.parameters.intentFence.intentId, source.intentId); assert.equal(resumeCommand.parameters.intentFence.subscriptionRevision, 2); assert.equal(final.contextSubscriptions.find(row => row.intentId === source.intentId && row.revision === 1).lifecycle, 'released') }
  else { assert.equal(resumeCommand.operation, 'wake'); assert.equal(resumeCommand.parameters.messages[0].kind, 'manual_resume'); assert(!final.multisite.inputs.some(row => row.id === resumeCommand.input_id)) }
  if (mode === 'obsolete-intent') { assert.notEqual(resumeCommand.command_id, obsoleteCommand.command_id); assert.equal(final.contextSubscriptions.find(row => row.id === final.workIntents.find(row => row.id === obsoleteCommand.parameters.intentFence.intentId).handlerSubscriptionId).lifecycle, 'released'); assert(!final.multisite.receipts.some(row => row.event.kind === 'intent_ingested' && row.event.source_command_id === obsoleteCommand.command_id)) }
  const stale = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + oldToken.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: original.modelSnapshot.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: '暂停前令牌不得在解除后恢复有效' }], tools: [] }) }), staleBody = await stale.json()
  observations.push({ path: '/internal/model/v1/chat/completions', status: stale.status, value: staleBody }); assert.equal(stale.status, ['idle-intent','unanswered-question'].includes(mode) ? 403 : 409); assert.equal(staleBody.error.code, ['idle-intent','unanswered-question'].includes(mode) ? 'FORBIDDEN' : 'REVISION_CONFLICT'); assert.equal((await fixture.store.read()).modelRequests.length, 0)
  const local = await journal.read(); assert(local.outbox.some(row => row.event.kind === 'manual_idle' && row.acknowledged)); assert(local.outbox.some(row => row.event.kind === 'manual_released' && row.acknowledged)); assert.equal(local.executions[0].waitStatus, undefined)
  if(mode==='unanswered-question'){assert.equal(final.intentQuestions.find(row=>row.id===question.id).state,'answered');assert.equal(resumeCommand.parameters.waitRelease.kind,'intent_question');assert.equal(resumeCommand.parameters.waitRelease.id,question.id);assert.equal(resumeCommand.parameters.intentAnswer.questionId,question.id);assert.equal(local.executions[0].waitStatus,undefined)}
  if (process.argv.includes('--late-generation')) {
    idle = false
    await api(`/api/works/${created.id}/multisite/pause`, { clientRequestId: 'next-pause', scope: { kind: 'work' }, expectedControlGeneration: 2 }); await pump()
    const waiting = await fixture.store.read(); assert.equal(waiting.manualControls[2].holders[0].idleAt, null)
    const history = (await journal.read()).outbox.filter(row => ['manual_idle', 'manual_released'].includes(row.event.kind) && row.acknowledged)
    for (const row of history) await client.event(row.event)
    for (const pending of (await client.resync()).pending) { const command = await client.resolveCommand(pending); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }
    const oldControls = waiting.multisite.outbox.filter(row => ['manual_pause', 'manual_release'].includes(row.command.operation) && row.command.parameters.manualControl.generation < 3)
    for (const row of oldControls) { await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, row.command); await client.ack(row.command) }
    await host.process(); await host.flushEvents(event => client.event(event))
    const afterOld = await fixture.store.read(); assert.deepEqual(afterOld.manualControls, waiting.manualControls); assert.equal(afterOld.manualControls[2].holders[0].idleAt, null); assert.equal(afterOld.modelRequests.length, 0)
    await assert.rejects(client.issue(execution), { code: 'MANUALLY_PAUSED' }); assert.equal(runtime.messageCount(), baselineMessages + 1)
    await writeFile(join(directory, 'old-control-replay-new-generation.json'), JSON.stringify(afterOld, null, 2))
    idle = true; await pump(); const actualNewIdle = await fixture.store.read(); assert(actualNewIdle.manualControls[2].holders[0].idleAt)
  }
  await api(`/api/works/${created.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  await writeFile(join(directory, 'before.json'), JSON.stringify(before, null, 2)); await writeFile(join(directory, 'paused.json'), JSON.stringify(paused, null, 2)); await writeFile(join(directory, 'released.json'), JSON.stringify(final, null, 2)); await writeFile(join(directory, 'final.json'), JSON.stringify(await fixture.store.read(), null, 2))
  const result = { result: 'passed', directory, mode, workId: created.id, threadId: thread.id, exactControlEventsAcknowledged: true, malformedControlProofRejectedWithoutMutation: true, controlledNonIdleDoesNotReportPaused: true, pausedSourceRetainsHandlerNoRouterOrWake: mode === 'pending-source' ? true : null, currentSourceConsumedOnceAfterExplicitRelease: mode === 'pending-source' ? true : null, idleResumeFreshMessageConsumed: mode !== 'pending-source' ? true : null, obsoleteUnconsumedIntentDoesNotCaptureResume: mode === 'obsolete-intent' ? true : null, releaseWhileQuestionOpenDoesNotWakeAndLaterAnswerContinues: mode === 'unanswered-question' ? true : null, releaseMetadataAllowedButOldInputRequestRejectedUntilFreshConsume: true, freshConsumedResumeRequestTokenIssued: true, prePauseTokenRejectedAfterRelease: true, oldExactProofAndInboxReplayCannotReleaseNewGeneration: process.argv.includes('--late-generation') ? true : null, originalSession: execution.session_id, actualModelForwards: 0, boundary: 'real authenticated HTTP, durable Node/Host Journal, original AgentDelivery simulator; controlled inspectState proves protocol classification only, not official DSH idle/flush or native wake' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { await host?.close(); await fixture?.close(); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Manual integration root:', directory) }
