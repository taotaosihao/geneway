import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedDelegation, childRequest } from './fixtures/multisite/delegation.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createEvidenceCaptures } from '../packages/agent-host/evidence-captures.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { seal } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { applyAgentCommand } from '../packages/agent-orchestration/dependencies.mjs'
import { evidenceToolNames } from '../packages/agent-contracts/tools.mjs'
import { createBudgetService } from '../src/budget-service.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-sharing-'), owner = { id: 'owner' }, peers = new Map()
const nodeFor = id => ({ coordinator: 'cloud', 'desktop-office': 'pc-b', 'desktop-data': 'pc-a', gateway: 'gateway', analysis: 'analysis' })[id]
const fixture = await startBridgeService({ directory: join(directory, 'api'), seedState(state) { seedDelegation(state); for (const row of state.employees) { row.placement.nodeId = nodeFor(row.id); row.placement.resourceRefs = row.id === 'desktop-data' ? ['fixture:history'] : row.id === 'gateway' ? ['fixture:site'] : [] }; return state } })
const execution = async id => (await peers.get(id).journal.read()).executions.findLast(row => row.agent_id === id)
async function pump() {
  for (let i = 0; i < 3; i++) for (const peer of peers.values()) {
    for (const command of (await peer.client.resync()).pending) { await peer.host.accept({ workspaceId: 'local', nodeId: peer.nodeId }, command); await peer.client.ack(command) }
    await peer.host.process(); await peer.host.flushEvents(event => peer.client.event(event))
  }
}
const call = async (id, operation, parameters) => peers.get(id).runtime.orchestration(await execution(id), operation, { instructionRevision: 1, ...parameters })
const read = async (id, ref) => peers.get(id).runtime.evidence(await execution(id), 'read_shared_evidence', { ref })

async function replayProofGuards(peer, binding, parameters, waitId) {
  const original = await peer.journal.read(), sessions = JSON.parse(await readFile(join(directory, 'desktop-office/sessions.json')))
  for (const mode of ['unconsumed', 'wrong-binding', 'wrong-kind', 'wrong-id', 'bad-seal']) {
    let local = structuredClone(original), copy = structuredClone(sessions), proof = local.inbox.find(row => row.command.parameters.waitRelease?.id === waitId)
    assert(proof && proof.status === 'ingested')
    if (mode === 'unconsumed') { proof.status = 'delivered'; copy[binding.session_id].events = copy[binding.session_id].events.filter(event => event.type !== 'user/message' || event.data.id !== messageId(proof.command.input_id, binding.attempt_id, binding.session_id)) }
    else {
      if (mode === 'wrong-binding') proof.command.node_id = 'other-node'
      if (mode === 'wrong-kind') proof.command.parameters.waitRelease.kind = 'dependency'
      if (mode === 'wrong-id') proof.command.parameters.waitRelease.id = 'not-this-question'
      const { payload_digest, ...body } = proof.command; proof.command = mode === 'bad-seal' ? { ...body, payload_digest: '0'.repeat(64) } : seal(body)
    }
    const path = join(directory, `negative-replay-${mode}.json`); await writeFile(path, JSON.stringify(copy))
    const journal = { read: async () => structuredClone(local), update: async callback => callback(local) }, runtime = createSimulatedRuntime({ path }), host = createAgentHost({ nodeId: peer.nodeId, journal, runtime })
    host.setOrchestrationHandler({ call: (execution, operation, parameters) => peer.client.command(execution, operation, parameters), event: event => peer.client.event(event) }); await runtime.start(binding)
    const reply = await runtime.orchestration(binding, 'ask_agent', { instructionRevision: 1, ...parameters })
    assert.equal(reply.status, 'waiting_question'); assert.equal(await runtime.orchestration(binding, 'confirmPark', {}), true); await host.close()
  }
}

try {
  const readerIds = ['desktop-office', 'desktop-data', 'gateway', 'analysis']
  for (const agentId of readerIds) {
    const nodeId = nodeFor(agentId), root = join(directory, agentId); await mkdir(root, { recursive: true })
    const pair = await fixture.nodes.createPairing(owner, { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agentId], expiresAt: new Date(Date.now() + 120000).toISOString() })
    const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'redeem', ...identity }); Object.assign(identity, { nodeId, registrationRevision: paired.node.registrationRevision })
    const resources = []
    if (agentId === 'desktop-data' || agentId === 'gateway') {
      const history = agentId === 'desktop-data', resourceId = history ? 'fixture:history' : 'fixture:site', cap = history ? 'evidence.history.read.v1' : 'evidence.site.inspect.v1', sourceRoot = join(root, 'source'); await mkdir(sourceRoot)
      const source = history ? { format: 'geneway.incident-history', version: 1, entries: Array.from({ length: 20 }, (_, i) => ({ date: '2026-11-01', description: `独立历史${i}`, owner: '测试员' })) } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events: Array.from({ length: 20 }, (_, i) => ({ sourceEventId: `event-${i}`, sourceTimestamp: null, code: 'ALARM', severity: 'unknown', message: `独立事件${i}` })) }
      await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(source))
      await fixture.nodes.putResource(owner, resourceId, { clientRequestId: `resource-${nodeId}`, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [cap], evidenceReaderAgentIds: readerIds, enabled: true })
      resources.push({ resourceId, capabilityIds: [cap], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: process.argv.includes('--denied-export') ? readerIds.filter(id => id !== 'analysis') : readerIds, clockTrust: 'fixture' })
    }
    const journal = createHostJournal(join(root, 'host.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }), evidence = createEvidenceCaptures({ journal, root: join(root, 'sealed'), profile: { profileVersion: 1, resources }, client })
    const host = createAgentHost({ nodeId, journal, runtime, evidence }); host.setOrchestrationHandler({ call: (execution, operation, parameters) => client.command(execution, operation, parameters), event: event => client.event(event) }); peers.set(agentId, { journal, runtime, client, host, nodeId, identity })
  }
  const deadlineMode = process.argv.includes('--question-deadline'), limits = { maxModelRequests: 20, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }
  const budgets = createBudgetService({ store: fixture.store })
  if (deadlineMode) { const state = await fixture.store.read(), employee = state.employees.find(row => row.id === 'desktop-office'), route = state.modelRoutes.find(row => row.id === employee.modelRouteId); await budgets.putPolicy(owner, 'closure-deadline', { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'desktop-office', enabled: true, accountingMode: 'conservative_estimate', limits, executionTimeoutMs: 60000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }) }
  const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-office', goal: '受控证据转交与独立分析', clientRequestId: 'create', ...(deadlineMode ? { budgetPolicyId: 'closure-deadline' } : {}) }); await pump()
  const b = await execution('desktop-office')
  assert.deepEqual((await fixture.store.read()).multisite.attempts.find(row => row.attempt_id === b.attempt_id).resource_refs, [])
  assert.deepEqual(evidenceToolNames((await fixture.store.read()).multisite.attempts.find(row => row.attempt_id === b.attempt_id).grant), ['geneway_read_shared_evidence'])
  await assert.rejects(peers.get('desktop-office').runtime.evidence(b, 'read_history', { clientRequestId: 'forbidden', instructionRevision: 1, resourceId: 'fixture:history', datasetId: 'history' }), { code: 'FORBIDDEN' })
  const a = await call('desktop-office', 'delegate', childRequest('delegate-a', 'desktop-data')), g = await call('desktop-office', 'delegate', childRequest('delegate-g', 'gateway')); await pump()
  const specialMode = process.argv.includes('--question-revision') ? 'revision' : process.argv.includes('--question-cancel') || deadlineMode ? 'cancel' : null
  if (specialMode) {
    const question = await call(specialMode === 'revision' ? 'desktop-data' : 'desktop-office', 'ask_agent', { clientRequestId: 'special-ask', targetAgentId: specialMode === 'revision' ? 'gateway' : 'desktop-data', text: '明确责任问题', evidenceRefs: [] }); await pump()
    if (specialMode === 'revision') {
      await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: 'revision-2', text: '明确新要求，旧问题失效' }); await pump()
      const beforeAnswer = await fixture.store.read(), reply = await call('gateway', 'answer_agent', { clientRequestId: 'late-answer', instructionRevision: 2, questionId: question.questionId, text: '旧问题只保留历史', evidenceRefs: [] })
      assert.equal(reply.status, 'historical'); const afterAnswer = await fixture.store.read(); assert.equal(afterAnswer.multisite.outbox.length, beforeAnswer.multisite.outbox.length); assert.equal(afterAnswer.evidenceAccessReceipts.length, beforeAnswer.evidenceAccessReceipts.length); assert.equal(afterAnswer.multisite.questions[0].state, 'superseded'); assert.equal(afterAnswer.works[0].instructionRevision, 2); const noControl = structuredClone(afterAnswer); delete noControl.multisite.messages.find(row => row.kind === 'question_closed').controlConsumedAt; assert.throws(() => applyAgentCommand(noControl, afterAnswer.multisite.attempts.find(row => row.agent_id === 'desktop-data'), 'complete_delegation', { instructionRevision: 2, clientRequestId: 'negative-no-control-receipt', result: { summary: '仅负向完成门检查', evidenceRefs: [] } }, { queue() { throw new Error('must not queue') }, workspaceId: 'local', requireRemoteNodes: true, at: new Date().toISOString() }), { code: 'INPUT_CONSUMPTION_PENDING' }); const done = await call('desktop-data', 'complete_delegation', { instructionRevision: 2, clientRequestId: 'complete-after-control', result: { summary: '旧问题已由系统关闭；未声明业务读取', evidenceRefs: [] } }); assert.equal(done.status, 'completed')
    } else {
      if (deadlineMode) { const deadline = new Date(Date.now() + 100).toISOString(); await budgets.adjustWork(owner, work.workId, { clientRequestId: 'expire-closure', expectedRevision: 1, reason: '期限到期后精确系统关闭仍须可达', limits, executionDeadlineAt: deadline }); await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 20)); await assert.rejects(call('desktop-office', 'publish_observation', { clientRequestId: 'expired-business', text: '不应发布' }), { code: 'EXECUTION_DEADLINE' }) }
      await fixture.nodes.revoke(owner, 'pc-a', { clientRequestId: 'revoke-responsible', expectedRevision: 1 }); await pump()
      const after = await fixture.store.read(); assert.equal(after.multisite.questions[0].state, 'cancelled'); assert.equal(after.multisite.questions[0].closedReason, 'NODE_REVOKED'); assert(after.multisite.messages.some(row => row.kind === 'question_closed' && row.controlConsumedAt && !row.ingestedAt)); assert.notEqual((await peers.get('desktop-office').journal.read()).executions[0].waitStatus, 'waiting_question')
      const closureCommand = after.multisite.outbox.find(row => row.command.parameters.messages?.[0]?.kind === 'question_closed').command, bPeer = peers.get('desktop-office')
      assert.deepEqual(await bPeer.client.post('/internal/bridge/command', { commandId: closureCommand.command_id, payloadDigest: closureCommand.payload_digest }), closureCommand)
      await bPeer.client.ack(closureCommand)
      const replay = await call('desktop-office', 'ask_agent', { clientRequestId: 'special-ask', targetAgentId: 'desktop-data', text: '明确责任问题', evidenceRefs: [] }); assert.equal(replay.status, 'closed'); assert.equal(await bPeer.runtime.orchestration(await execution('desktop-office'), 'confirmPark', {}), false)
    }
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'stop-special' }); await pump()
    const state = await fixture.store.read(); assert.equal(state.works[0].status, 'cancelled'); await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2)); const summary = { result: 'passed', directory, mode: specialMode, boundary: 'actual FileStore/Node HTTP/AgentDelivery; controlled admin/user service calls, simulated model', deadlineMode, expiredBusinessDeniedButExactClosureConsumedAndReplayable: deadlineMode, oldQuestionNoNewReceiptOrWakeOnLateAnswer: specialMode === 'revision', responsibleRevokeClosesQuestionAndReleasesWait: specialMode === 'cancel', actualStop: true }; await writeFile(join(directory, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2))
  } else {
  const refs = []; let queuedQuestion
  for (const id of ['desktop-data', 'gateway']) {
    const history = id === 'desktop-data', peer = peers.get(id), captured = await peer.runtime.evidence(await execution(id), history ? 'read_history' : 'inspect_site', { clientRequestId: 'capture', instructionRevision: 1, resourceId: history ? 'fixture:history' : 'fixture:site', ...(history ? { datasetId: 'history' } : { sections: ['collector_health', 'recent_events'] }) }); refs.push(captured.ref)
    await assert.rejects(read('desktop-office', captured.ref), { code: 'FORBIDDEN' })
    if (process.argv.includes('--questions') && history) {
      const before = await fixture.store.read()
      for (const agent of ['desktop-data', 'gateway', 'desktop-office']) await call(agent, 'publish_observation', { clientRequestId: `observe-${agent}`, text: `${agent} 记录有限协作观察`, evidenceRefs: agent === 'desktop-data' ? [captured.ref] : [] })
      const after = await fixture.store.read(); assert.equal(after.multisite.outbox.length, before.multisite.outbox.length); assert.equal(after.evidenceAccessReceipts.length, before.evidenceAccessReceipts.length)
      const askParameters = { clientRequestId: 'ask-a', targetAgentId: 'desktop-data', text: '请确认历史条目范围', evidenceRefs: [] }; const question = await call('desktop-office', 'ask_agent', askParameters); assert.equal((await call('desktop-office', 'ask_agent', askParameters)).status, 'waiting_question'); await assert.rejects(call('desktop-data', 'complete_delegation', { clientRequestId: 'complete-unread-question', result: { summary: '不能越过未读责任消息', evidenceRefs: [] } }), { code: 'INPUT_CONSUMPTION_PENDING' }); await pump()
      await assert.rejects(call('gateway', 'answer_agent', { clientRequestId: 'steal-answer', questionId: question.questionId, text: '冒答', evidenceRefs: [] }), { code: 'FORBIDDEN' })
      const answerParameters = { clientRequestId: 'answer-b', questionId: question.questionId, text: '仅封存的模拟历史可引用', evidenceRefs: [captured.ref] }
      const answered = await call('desktop-data', 'answer_agent', answerParameters); assert.deepEqual(await call('desktop-data', 'answer_agent', answerParameters), answered); const historicalAnswer = await call('desktop-data', 'answer_agent', { ...answerParameters, clientRequestId: 'second-answer-history' }); assert.equal(historicalAnswer.status, 'historical'); await pump(); assert(!(await fixture.store.read()).multisite.messages.find(row => row.id === historicalAnswer.messageId).ingestedAt); const replay = await call('desktop-office', 'ask_agent', askParameters); assert.equal(replay.status, 'already_satisfied'); assert.equal(await peers.get('desktop-office').runtime.orchestration(await execution('desktop-office'), 'confirmPark', {}), false)
      await replayProofGuards(peers.get('desktop-office'), await execution('desktop-office'), askParameters, question.questionId)
      const bPeer = peers.get('desktop-office'), lostParameters = { instructionRevision: 1, clientRequestId: 'lost-first-ack', targetAgentId: 'desktop-data', text: '原ACK丢失重试', evidenceRefs: [] }
      const lossClient = createRemoteClient({ origin: fixture.origin, identity: bPeer.identity, fetchImpl: async (url, options) => { const response = await fetch(url, options); await response.arrayBuffer(); throw new Error('synthetic committed response loss') } })
      bPeer.host.setOrchestrationHandler({ call: (execution, operation, parameters) => lossClient.command(execution, operation, parameters), event: event => bPeer.client.event(event) })
      await assert.rejects(call('desktop-office', 'ask_agent', lostParameters), /synthetic committed response loss/)
      bPeer.host.setOrchestrationHandler({ call: (execution, operation, parameters) => bPeer.client.command(execution, operation, parameters), event: event => bPeer.client.event(event) })
      const lostReply = await call('desktop-office', 'ask_agent', lostParameters); assert.equal(lostReply.status, 'waiting_question'); await pump()
      await call('desktop-data', 'answer_agent', { clientRequestId: 'answer-lost', questionId: lostReply.questionId, text: '原问题只回答一次', evidenceRefs: [] }); await pump(); assert.equal((await call('desktop-office', 'ask_agent', lostParameters)).status, 'already_satisfied')

      const qAG = await call('desktop-data', 'ask_agent', { clientRequestId: 'ask-g', targetAgentId: 'gateway', text: '时钟可信吗', evidenceRefs: [] }); await pump()
      const qGB = await call('gateway', 'ask_agent', { clientRequestId: 'ask-b', targetAgentId: 'desktop-office', text: '请核对范围', evidenceRefs: [] }); await pump()
      await assert.rejects(call('desktop-office', 'wait_dependencies', { clientRequestId: 'cycle-wait', dependencyIds: [a.delegationId] }), { code: 'DEPENDENCY_CYCLE' })
      await call('desktop-office', 'answer_agent', { clientRequestId: 'answer-g', questionId: qGB.questionId, text: '只核对封存资料', evidenceRefs: [] }); await pump()
      await call('gateway', 'answer_agent', { clientRequestId: 'answer-a', questionId: qAG.questionId, text: '未知时钟不判断当前正常', evidenceRefs: [] }); await pump()
      await call('desktop-office', 'wait_dependencies', { clientRequestId: 'wait-a-only', dependencyIds: [a.delegationId] }); await pump()
      queuedQuestion = await call('gateway', 'ask_agent', { clientRequestId: 'ask-b-during-dependency', targetAgentId: 'desktop-office', text: '请待依赖回报后核对', evidenceRefs: [] }); await pump()
      assert.equal((await peers.get('desktop-office').journal.read()).executions[0].waitStatus, 'waiting_dependency')
      assert(!(await fixture.store.read()).multisite.messages.find(row => row.replyTo === queuedQuestion.questionId).ingestedAt)
    }
    const parameters = { clientRequestId: 'complete', result: { summary: history ? '历史已封存' : '模拟站点数据时钟未知', evidenceRefs: [captured.ref] } }
    const reply = await call(id, 'complete_delegation', parameters); assert.equal(reply.status, 'completed'); assert.deepEqual(await call(id, 'complete_delegation', parameters), reply)
    if (queuedQuestion && history) { await pump(); assert((await fixture.store.read()).multisite.messages.find(row => row.replyTo === queuedQuestion.questionId).ingestedAt); await call('desktop-office', 'answer_agent', { clientRequestId: 'answer-queued-g', questionId: queuedQuestion.questionId, text: '已收到历史回报', evidenceRefs: [] }); await pump() }
  }
  await call('desktop-office', 'wait_dependencies', { clientRequestId: 'wait-sources', dependencyIds: [a.delegationId, g.delegationId] }); await pump()
  for (const ref of refs) { const page = await read('desktop-office', ref); assert.equal(page.entries.length, 16); assert(page.nextCursor) }
  if (process.argv.includes('--permissions')) {
    const other = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'analysis', goal: '独立Work，不接受跨Work权限', clientRequestId: 'other-work' }); await pump()
    await assert.rejects(call('desktop-office', 'share_evidence', { clientRequestId: 'cross-work-share', targetAttemptId: (await execution('analysis')).attempt_id, evidenceRefs: refs }), { code: 'FORBIDDEN' })
    await fixture.service.multisite.apply(owner, 'cancel', { workId: other.workId, clientRequestId: 'stop-other-work' }); await pump()
    await assert.rejects(call('desktop-office', 'share_evidence', { clientRequestId: 'completed-target', targetAttemptId: (await execution('desktop-data')).attempt_id, evidenceRefs: refs }), { code: 'FORBIDDEN' })
    await assert.rejects(read('desktop-office', { ...refs[0], sha256: '0'.repeat(64) }), { code: 'FORBIDDEN' })
  }
  if (process.argv.includes('--denied-export')) {
    const before = await fixture.store.read()
    await assert.rejects(call('desktop-office', 'delegate', { ...childRequest('denied-analysis', 'analysis'), resultSchema: 'geneway.analysis-result/1', evidenceRefs: refs }), { code: 'FORBIDDEN' })
    const after = await fixture.store.read(); assert.deepEqual(after.multisite.attempts, before.multisite.attempts); assert.deepEqual(after.multisite.outbox, before.multisite.outbox); assert.deepEqual(after.evidenceAccessReceipts, before.evidenceAccessReceipts); assert.deepEqual(after.multisite.commands, before.multisite.commands)
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'stop-denied' }); await pump()
    const summary = { result: 'passed', directory, boundary: 'real source/production immutable sealed export/FileStore/HTTP; simulated model', receiverInResourceButNotSealedExportDenied: true, failedDelegateRollsBackChildReceiptOutboxAndCommand: true }; await writeFile(join(directory, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2))
  } else {
  await assert.rejects(call('desktop-office', 'delegate', { ...childRequest('old-analysis-schema', 'analysis'), resultSchema: 'geneway.delegation-result/1', evidenceRefs: [] }), { code: 'INVALID_REQUEST' })
  const defaultAnalysis = { ...childRequest('delegate-analysis', 'analysis'), evidenceRefs: refs }; delete defaultAnalysis.resultSchema
  const analysis = await call('desktop-office', 'delegate', defaultAnalysis); await pump(); assert.equal((await fixture.store.read()).multisite.delegations.find(row => row.id === analysis.delegationId).resultSchema, 'geneway.analysis-result/1')
  const beforeShare = await fixture.store.read(), shareParameters = { clientRequestId: 'explicit-share', targetAttemptId: (await execution('analysis')).attempt_id, evidenceRefs: [refs[0]] }, shared = await call('desktop-office', 'share_evidence', shareParameters); assert.deepEqual(await call('desktop-office', 'share_evidence', shareParameters), shared); assert.equal((await fixture.store.read()).multisite.outbox.length, beforeShare.multisite.outbox.length)
  await assert.rejects(call('desktop-office', 'share_evidence', { ...shareParameters, evidenceRefs: [refs[1]] }), { code: 'IDEMPOTENCY_CONFLICT' })

  for (const ref of refs) assert.equal((await read('analysis', ref)).entries.length, 16)
  const payload = { summary: '历史条目可引用；站点时间未知，不判断当前健康', evidenceRefs: refs, findings: [{ category: 'history_match', statement: '独立历史0存在', basis: [{ evidenceRef: refs[0], entryIndexes: [0] }], certainty: 'supported' }, { category: 'insufficient_evidence', statement: '模拟站点时钟未知', basis: [{ evidenceRef: refs[1], sourceEventIds: ['event-0'] }], certainty: 'unknown' }], limitations: ['来源为fixture；未读后续页；不能推断当前正常'] }
  const oversizedStatement = structuredClone(payload); oversizedStatement.findings[0].statement = ' '.repeat(4001) + 'x'; await assert.rejects(call('analysis', 'complete_delegation', { clientRequestId: 'oversized-statement', result: oversizedStatement }), { code: 'INVALID_REQUEST' })
  const badEvent = structuredClone(payload); badEvent.findings[1].basis[0].sourceEventIds = ['not-captured-event']; await assert.rejects(call('analysis', 'complete_delegation', { clientRequestId: 'bad-event', result: badEvent }), { code: 'INVALID_REQUEST' })
  const bad = structuredClone(payload); bad.findings[0].basis[0].entryIndexes = [200]
  await assert.rejects(call('analysis', 'complete_delegation', { clientRequestId: 'bad-index', result: bad }), { code: 'INVALID_REQUEST' })
  const reorderedDuplicate = structuredClone(payload); reorderedDuplicate.evidenceRefs.push(Object.fromEntries(Object.entries(refs[0]).reverse()))
  await assert.rejects(call('analysis', 'complete_delegation', { clientRequestId: 'duplicate-ref', result: reorderedDuplicate }), { code: 'INVALID_REQUEST' })
  payload.findings[0].basis[0].evidenceRef = Object.fromEntries(Object.entries(refs[0]).reverse())
  const completed = await call('analysis', 'complete_delegation', { clientRequestId: 'complete-analysis', result: payload }); await call('desktop-office', 'wait_dependencies', { clientRequestId: 'wait-analysis', dependencyIds: [analysis.delegationId] }); await pump()
  const state = await fixture.store.read(), result = state.multisite.results.find(row => row.id === completed.resultId)
  assert.equal(result.schema, 'geneway.analysis-result/1'); assert.deepEqual(result.payload, payload)
  assert(state.multisite.messages.some(row => row.resultRef === result.id && row.targetAttemptId === b.attempt_id && row.ingestedAt))
  assert.equal(state.evidence.length, 2); assert(state.evidenceAccessReceipts.some(row => row.reason === 'delegate')); assert(state.evidenceAccessReceipts.some(row => row.reason === 'result'))
  if (process.argv.includes('--permissions')) {
    const peer = peers.get('desktop-office'), current = await execution('desktop-office'), token = await peer.client.post('/internal/evidence/read-token', { binding: current, instructionRevision: 1, ref: refs[0] })
    await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: 'permissions-new-rev', text: '新要求不自动升级旧读取receipt' }); await pump()
    await assert.rejects(read('desktop-office', refs[0]), { code: 'FORBIDDEN' })
    const response = await fetch(fixture.origin + `/internal/evidence/${refs[0].id}/content`, { headers: { authorization: `Bearer ${peer.identity.credential}`, 'x-geneway-node-instance': peer.identity.nodeInstanceId, 'x-geneway-evidence-token': token.token } }); assert.equal(response.status, 409)
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'stop-permissions' }); await pump()
  }
  await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2))
  const resultSummary = { result: 'passed', directory, workId: work.workId, boundary: 'real FileStore/HTTP/source/capture/production receipts/AgentDelivery with simulated model; no native provider claim', bExecutionNoSourceResources: true, bCaptureDenied: true, nakedRefDeniedBeforeResult: true, aGActualPublicationAndResultShares: true, bActualPageReads: true, independentAnalysisDelegationReceiptsAndReads: true, analysisImmutableSchemaAndIndexGuard: true, reorderedEquivalentRefAcceptedAndDuplicateRejected: true, bActuallyConsumedAnalysisResult: true, explicitShareNoWakeAndExactReplay: true, wrongEventRejected: true, permissionsMode: process.argv.includes('--permissions'), questionMode: process.argv.includes('--questions'), exactReplayProofGuardsAndLostAck: process.argv.includes('--questions'), questionCount: state.multisite.questions.length, observationCount: state.multisite.messages.filter(row => row.kind === 'observation').length, evidenceCount: state.evidence.length, receipts: state.evidenceAccessReceipts.length }
  await writeFile(join(directory, 'result.json'), JSON.stringify(resultSummary, null, 2)); console.log(JSON.stringify(resultSummary, null, 2))
  }
  }
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack }, null, 2)); console.error(directory); throw cause } finally { for (const peer of peers.values()) await peer.host.close(); await fixture.close() }
