import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { createWorkService } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-runtime-'))
const capture = await startCapture()
const previousUrl = process.env.GENEWAY_P3_CAPTURE_BASE_URL
let runtimeFailure
process.env.GENEWAY_P3_CAPTURE_BASE_URL = `${capture.address}/v1`
try {
  const store = createFileStore(join(temp, 'state.json'))
  const gearConnection = connection(capture.address)
  await store.update(state => seed(state, gearConnection))
  await mkdir(join(temp, 'secrets'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'secrets', gearConnection.credentialRef), 'local-test-only', { mode: 0o600 })
  const schemaSnapshots = []
  const runtimeHooks = { onKnowledgeSchemas: names => schemaSnapshots.push(names) }
  const runner = createCollaborationRunner({
    store,
    root: process.cwd(),
    dshHome: join(temp, 'dsh'),
    environment: { GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`, GENEWAY_P3_CAPTURE_KEY: 'local-only' },
    agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 4096 },
    secretRoot: join(temp, 'secrets'),
    onError: error => { runtimeFailure = error },
    testHooks: runtimeHooks,
  })
  const service = createWorkService({ store, collaborationRunner: runner, connectionCatalog: [gearConnection] })
  const actor = { id: 'member-owner' }
  const knowledgeIds = ['runtime', 'disposable', 'sibling']
  const knowledge = createKnowledgeService({ store, idFactory: () => knowledgeIds.shift() })
  const material = await knowledge.createMaterial(actor, {
    employeeIds: ['employee-lead', 'employee-b'], title: '节拍依据', body: 'KNOWLEDGE-CANARY 每件需按剩余时间复核。',
    format: 'text', sourceLabel: '测试知识', authorizationBasis: '成员明确导入',
  })
  const knowledgeWork = await create(service, actor, 'knowledge', [{ ...item('item-knowledge', 'employee-b', 3600, 6), knowledgeQuery: 'KNOWLEDGE-CANARY' }])
  const knowledgeDone = await waitFor(service, actor, knowledgeWork.value.id, work => work.status === 'completed')
  const knowledgeState = await store.read()
  const knowledgeChild = knowledgeState.works.find(work => work.rootWorkId === knowledgeDone.id)
  assert.deepEqual(capture.tools('item-knowledge').filter(name => name !== 'structured_output').sort(), ['geneway_calculate_cycle_time', 'geneway_knowledge_search', 'geneway_knowledge_submit_references'].sort())
  assert.deepEqual(knowledgeChild.results[0].knowledgeDependencyRefs, [{ knowledgeId: material.id, revision: 1, segmentId: 'p1-c1' }])
  assert.deepEqual(knowledgeDone.handoffs[0].knowledgeRefs, knowledgeChild.results[0].knowledgeDependencyRefs)
  assert.deepEqual(knowledgeDone.results.at(-1).knowledgeDependencyRefs, knowledgeChild.results[0].knowledgeDependencyRefs)
  const invalidCompleted = structuredClone(knowledgeState)
  invalidCompleted.knowledgeMaterials.find(entry => entry.id === material.id).revision += 1
  assert.throws(() => migrateState(invalidCompleted), /completed 知识依赖无效/)
  await knowledge.updateMaterial(actor, material.id, { expectedRevision: 1, body: '替换后的当前依据。' })
  const redacted = (await service.getWork(actor, knowledgeDone.id)).value
  assert.equal(redacted.collaboration.status, 'stale')
  assert.deepEqual(redacted.collaboration.staleItemIds, ['item-knowledge'])
  assert.equal(JSON.stringify(redacted).includes('KNOWLEDGE-CANARY'), false)
  assert.equal(JSON.stringify(await service.bootstrap(actor)).includes('KNOWLEDGE-CANARY'), false)

  const forgedKnowledge = await create(service, actor, 'knowledge-forged', [{ ...item('item-knowledge-forged', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  const forgedReadback = await waitFor(service, actor, forgedKnowledge.value.id, work => work.status === 'failed')
  assert.equal(forgedReadback.executions.at(-1).error.code, 'KNOWLEDGE_REFERENCE_INVALID')

  const disposable = await knowledge.createMaterial(actor, { employeeIds: ['employee-b'], title: '停用维护', body: '可删除', format: 'text', sourceLabel: '测试', authorizationBasis: '成员导入' })
  await runner.disableKnowledge()
  assert.equal(schemaSnapshots.at(-1).some(name => name.startsWith('geneway_knowledge_')), false)
  assert.equal((await knowledge.deleteMaterial(actor, disposable.id, { expectedRevision: 1 })).status, 'deleted')
  const disabledKnowledge = await create(service, actor, 'knowledge-disabled', [{ ...item('item-knowledge-disabled', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  const disabledReadback = await waitFor(service, actor, disabledKnowledge.value.id, work => work.status === 'failed')
  assert.equal(disabledReadback.executions.at(-1).error.code, 'KNOWLEDGE_PLUGIN_DISABLED')
  assert.equal((await waitFor(service, actor, (await create(service, actor, 'without-knowledge', [item('item-without-knowledge', 'employee-a', 60, 1)])).value.id, work => work.status === 'completed')).status, 'completed')
  await Promise.all([runner.enableKnowledge(), runner.enableKnowledge()])
  assert.deepEqual(schemaSnapshots.at(-1).filter(name => name.startsWith('geneway_knowledge_')).sort(), ['geneway_knowledge_search', 'geneway_knowledge_submit_references'])
  const remountedKnowledge = await create(service, actor, 'knowledge-remount', [{ ...item('item-knowledge-remount', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  assert.equal((await waitFor(service, actor, remountedKnowledge.value.id, work => work.status === 'completed')).status, 'completed')
  await knowledge.updateMaterial(actor, material.id, { expectedRevision: 2, employeeIds: ['employee-lead', 'employee-a', 'employee-b'] })
  const sharedRefWork = await create(service, actor, 'knowledge-shared', [
    { ...item('item-knowledge-shared-a', 'employee-a', 60, 1), knowledgeQuery: '替换后的当前依据' },
    { ...item('item-knowledge-shared-b', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' },
  ])
  await waitFor(service, actor, sharedRefWork.value.id, work => work.status === 'completed')
  const adminForShared = { id: 'member-admin' }
  await service.updateMember(adminForShared, actor.id, { employeeIds: ['employee-lead', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
  const sharedStale = (await service.getWork(actor, sharedRefWork.value.id)).value
  assert.deepEqual(sharedStale.collaboration.staleItemIds, ['item-knowledge-shared-a'])
  assert.deepEqual(sharedStale.collaboration.staleKnowledgeRefs, [`${material.id}@3#p1-c1`])
  await service.updateMember(adminForShared, actor.id, { employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })

  for (const scenario of ['knowledge-negative-unsearched', 'knowledge-negative-bad-revision', 'knowledge-negative-bad-segment']) {
    const negative = await create(service, actor, scenario, [{ ...item(`item-${scenario}`, 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
    assert.equal((await waitFor(service, actor, negative.value.id, work => work.status === 'failed')).executions.at(-1).error.code, 'KNOWLEDGE_REFERENCE_INVALID')
  }
  const siblingMaterial = await knowledge.createMaterial(actor, { employeeIds: ['employee-lead', 'employee-a', 'employee-b'], title: 'Sibling', body: 'SIBLING-ONLY', format: 'text', sourceLabel: '测试', authorizationBasis: '成员导入' })
  const siblingNegative = await create(service, actor, 'knowledge-negative-sibling', [
    { ...item('item-knowledge-negative-sibling-a', 'employee-a', 60, 1), knowledgeQuery: '替换后的当前依据' },
    { ...item('item-knowledge-negative-sibling-b', 'employee-b', 60, 1), knowledgeQuery: 'SIBLING-ONLY' },
  ])
  assert.equal((await waitFor(service, actor, siblingNegative.value.id, work => work.status === 'failed')).executions.at(-1).error.code, 'KNOWLEDGE_REFERENCE_INVALID')
  assert.equal(siblingMaterial.id, 'knowledge-sibling')

  const revokeB = () => service.updateMember(adminForShared, actor.id, { employeeIds: ['employee-lead', 'employee-a', 'employee-revoked', 'employee-incompatible'] })
  const restoreB = () => service.updateMember(adminForShared, actor.id, { employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
  let knowledgeIo = 0, childRequests = 0, armed = true
  runtimeHooks.beforeKnowledgeSearch = () => { knowledgeIo += 1 }
  runtimeHooks.beforeAgentRequest = async ({ binding }) => { if (armed && binding.kind === 'child') { armed = false; await revokeB() } }
  const preSearch = await create(service, actor, 'knowledge-gate-pre-search', [{ ...item('item-knowledge-gate-pre-search', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  await waitFor(service, actor, preSearch.value.id, work => work.status === 'failed')
  assert.equal(knowledgeIo, 0)
  await restoreB()

  armed = true; childRequests = 0
  runtimeHooks.beforeAgentRequest = async ({ binding }) => {
    if (binding.kind === 'child' && ++childRequests === 3 && armed) { armed = false; await revokeB() }
  }
  const requestsBeforeSearchGate = capture.requests
  const postSearch = await create(service, actor, 'knowledge-gate-post-search', [{ ...item('item-knowledge-gate-post-search', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  await waitFor(service, actor, postSearch.value.id, work => work.status === 'failed')
  assert.equal(capture.requests - requestsBeforeSearchGate, 2)
  const postSearchProjection = (await service.bootstrap(actor)).works.filter(work => work.id === postSearch.value.id || work.rootWorkId === postSearch.value.id)
  assert.equal(JSON.stringify(postSearchProjection).includes('KNOWLEDGE-CANARY'), false)
  await restoreB()

  delete runtimeHooks.beforeAgentRequest
  runtimeHooks.beforeFinishChild = async () => { if (armed) { armed = false; await revokeB() } }
  armed = true
  const finishGate = await create(service, actor, 'knowledge-gate-finish', [{ ...item('item-knowledge-gate-finish', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  await waitFor(service, actor, finishGate.value.id, work => work.status === 'failed')
  const finishGateState = await store.read()
  assert.equal(finishGateState.works.find(work => work.rootWorkId === finishGate.value.id).results.length, 0)
  assert.equal(finishGateState.works.find(work => work.id === finishGate.value.id).handoffs.length, 0)
  await restoreB()

  delete runtimeHooks.beforeFinishChild
  runtimeHooks.beforeSummaryProjection = async () => { if (armed) { armed = false; await revokeB() } }
  armed = true
  const rootRequestsBefore = capture.scenarioCount('root-summary')
  const summaryGate = await create(service, actor, 'knowledge-gate-summary', [{ ...item('item-knowledge-gate-summary', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  await waitFor(service, actor, summaryGate.value.id, work => work.status === 'failed')
  assert.equal(capture.scenarioCount('root-summary'), rootRequestsBefore)
  const summaryGateState = await store.read()
  assert.equal(summaryGateState.works.find(work => work.rootWorkId === summaryGate.value.id).results.length, 1)
  assert.equal(summaryGateState.works.find(work => work.id === summaryGate.value.id).results.length, 0)
  await restoreB()
  delete runtimeHooks.beforeSummaryProjection
  delete runtimeHooks.beforeKnowledgeSearch
  await new Promise(resolve => setTimeout(resolve, 200))

  const oldGeneration = await create(service, actor, 'knowledge-old-generation', [{ ...item('item-knowledge-old-generation', 'employee-b', 60, 1), knowledgeQuery: '替换后的当前依据' }])
  await waitFor(service, actor, oldGeneration.value.id, work => work.status === 'completed')
  await knowledge.updateMaterial(actor, material.id, { expectedRevision: 3, body: '替换后的当前依据，revision 4。' })
  assert.equal((await service.recheckCollaboration(actor, oldGeneration.value.id, { clientRequestId: 'knowledge-old-generation-r2' })).ok, true)
  assert.equal((await waitFor(service, actor, oldGeneration.value.id, work => work.status === 'failed')).executions.at(-1).error.code, 'KNOWLEDGE_REFERENCE_INVALID')

  const created = await service.createCollaboration(actor, {
    employeeId: 'employee-lead', skillId: 'skill-cycle-time-calculate', goal: '复核工单剩余节拍', clientRequestId: 'p3-root',
    items: [
      { id: 'item-a', employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', goal: '换算 A', input: { availableSeconds: 3600, quantity: 6 } },
      { id: 'item-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '换算 B', input: { availableSeconds: 1800, quantity: 3 } },
    ],
  })
  assert.equal(created.ok, true)
  const completed = await waitFor(service, actor, created.value.id, work => work.status === 'completed')
  assert.equal(completed.collaboration.status, 'completed')
  assert.equal(completed.plan.items.every(item => item.status === 'completed'), true)
  assert.equal(completed.handoffs.length, 2)
  assert.equal(completed.collaboration.summaryResultRefs.length, 2)
  assert.deepEqual(completed.results.at(-1).payload.resultRefs, completed.collaboration.summaryResultRefs)
  assert.equal(completed.results.at(-1).usage.inputTokens, null)
  const persisted = await store.read()
  const children = persisted.works.filter(work => work.rootWorkId === completed.id)
  assert.equal(children.length, 2)
  assert.equal(children.every(work => work.status === 'completed' && work.results.length === 1), true)
  assert.equal(children.every(work => work.executions[0].dshSessionRef && work.results[0].dshSessionRef), true)
  assert.equal(new Set(children.map(work => work.executions[0].dshSessionRef)).size, 2)
  assert.equal(JSON.stringify(persisted).includes('GENEWAY_DSH_GRANT_FILE'), false)
  assert.equal(completed.collaboration.requestCount, 6)
  assert.equal(capture.sequence('root-summary') > Math.max(capture.sequence('item-a'), capture.sequence('item-b')), true)
  assert.deepEqual(capture.tools('root-summary'), ['geneway_collaboration_submit_summary'])
  assert.deepEqual(completed.results.at(-1).payload.resultRefs, childrenResultRefs(children))

  const gearCompleted = await create(service, actor, 'gear-complete', [{
    id: 'item-gear-complete', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id,
    goal: '完成并持久化工单观察', input: { workOrderId: 'WO-CANCEL' },
  }])
  await waitFor(service, actor, gearCompleted.value.id, work => work.status === 'completed')
  const gearChild = (await store.read()).works.find(work => work.rootWorkId === gearCompleted.value.id)
  const gearResult = gearChild.results.at(-1)
  assert.equal(gearResult.kind, 'gearjob.work-order.observation')
  assert.equal(gearResult.payload.observationId, gearResult.id)
  assert.equal(gearResult.payload.queriedAt, gearResult.createdAt)
  assert.equal(gearResult.payload.dshSessionRef, gearResult.dshSessionRef)
  assert.deepEqual(gearResult.source, Object.fromEntries(['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime'].filter(key => gearResult.payload[key] !== undefined).map(key => [key, gearResult.payload[key]])))
  assert.match(completed.results.at(-1).explanation, /后置事实汇总/)
  assert.equal(capture.maxActiveChildren <= 2, true)
  assertClosedGraphRejects(persisted, completed.id)

  const clientQuantityItems = [
    { id: 'item-client-gear', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取工单', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-client-cycle', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '不得接收客户端数量', input: { availableSeconds: 600 }, dependsOn: ['item-client-gear'] },
  ]
  const directQuantity = structuredClone(clientQuantityItems); directQuantity[1].quantity = 6
  const inputQuantity = structuredClone(clientQuantityItems); inputQuantity[1].input.quantity = 6
  assert.equal((await create(service, actor, 'client-direct-quantity', directQuantity)).error.status, 400)
  assert.equal((await create(service, actor, 'client-input-quantity', inputQuantity)).error.status, 400)

  const waiting = await create(service, actor, 'waiting', [
    { id: 'item-wait-a', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取当前工单事实', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-wait-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '等待可用时间', input: {}, dependsOn: ['item-wait-a'] },
  ])
  const waitingReadback = await waitFor(service, actor, waiting.value.id, work => work.status === 'waiting_input')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-a').status, 'completed')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-b').status, 'waiting_input')
  const waitingChildren = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-a').results.length, 1)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').executions.length, 0)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').input.quantity, 6)
  assert.deepEqual(waitingChildren.find(work => work.planItemId === 'item-wait-b').requiredInputs, ['availableSeconds'])
  const waitingEdited = await service.updateCollaborationPlan(actor, waiting.value.id, { expectedRevision: 1, items: [{ id: 'item-wait-b', goal: '更新后的等待目标', employeeId: 'employee-lead' }] })
  assert.equal(waitingEdited.value.plan.revision, 2)
  await assert.rejects(service.updateCollaborationPlan(actor, waiting.value.id, { expectedRevision: 1, items: [{ id: 'item-wait-b', goal: '过期草稿' }] }), error => error.code === 'BUSY')
  assert.equal((await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-client-quantity', inputs: { 'item-wait-b': { availableSeconds: 3600, quantity: 99 } } })).error.status, 400)
  const waitContinued = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { availableSeconds: 3600 } } })
  assert.equal(waitContinued.ok, true)
  const waitingDone = await waitFor(service, actor, waiting.value.id, work => work.status === 'completed')
  const waitingChildrenDone = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingDone.collaboration.generation, 2)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-a').executions.length, 1)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-b').executions.length, 1)
  const derivedResult = waitingChildrenDone.find(work => work.planItemId === 'item-wait-b').results.at(-1)
  assert.equal(derivedResult.payload.quantity, 6)
  assert.deepEqual(derivedResult.inputProvenance.quantity, { kind: 'gearjob.remaining-quantity', sourcePlanItemId: 'item-wait-a', sourceResultId: waitingChildrenDone.find(work => work.planItemId === 'item-wait-a').results.at(-1).id, plannedQuantity: 10, completedQuantity: 4 })
  assertProvenanceRejects(await store.read(), waiting.value.id)
  const waitingReplay = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { availableSeconds: 99 } } })
  assert.equal(waitingReplay.deduplicated, true)
  assert.equal((await store.read()).works.find(work => work.planItemId === 'item-wait-b' && work.rootWorkId === waiting.value.id).executions.length, 1)

  capture.setWorkOrder(12, 5)
  const changedFacts = await create(service, actor, 'changed-facts', [
    { id: 'item-changed-a', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取变化后的当前工单事实', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-changed-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '按变化后的事实计算', input: { availableSeconds: 3500 }, dependsOn: ['item-changed-a'] },
  ])
  await waitFor(service, actor, changedFacts.value.id, work => work.status === 'completed')
  const changedChild = (await store.read()).works.find(work => work.rootWorkId === changedFacts.value.id && work.planItemId === 'item-changed-b')
  assert.equal(changedChild.results.at(-1).payload.quantity, 7)
  assert.deepEqual([changedChild.results.at(-1).inputProvenance.quantity.plannedQuantity, changedChild.results.at(-1).inputProvenance.quantity.completedQuantity], [12, 5])
  capture.setWorkOrder(4, 4)
  const noRemaining = await create(service, actor, 'no-remaining', [
    { id: 'item-zero-a', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取无剩余工单', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-zero-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '等待正数剩余数量', input: { availableSeconds: 600 }, dependsOn: ['item-zero-a'] },
  ])
  await waitFor(service, actor, noRemaining.value.id, work => work.status === 'waiting_input')
  const noRemainingChild = (await store.read()).works.find(work => work.rootWorkId === noRemaining.value.id && work.planItemId === 'item-zero-b')
  assert.equal(noRemainingChild.input.quantity, undefined)
  assert.deepEqual(noRemainingChild.requiredInputs, ['quantity'])
  assert.equal(noRemainingChild.executions.length, 0)
  assert.equal((await service.continueCollaboration(actor, noRemaining.value.id, { clientRequestId: 'zero-client-quantity', inputs: { 'item-zero-b': { quantity: 1 } } })).error.status, 400)

  const ambiguous = await create(service, actor, 'ambiguous-source', [
    { id: 'item-ambiguous-a', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取来源 A', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-ambiguous-b', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id, goal: '读取来源 B', input: { workOrderId: 'WO-CANCEL' } },
    { id: 'item-ambiguous-cycle', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '不得猜测来源', input: { availableSeconds: 600 }, dependsOn: ['item-ambiguous-a', 'item-ambiguous-b'] },
  ])
  await waitFor(service, actor, ambiguous.value.id, work => work.status === 'waiting_input')
  const ambiguousState = await store.read(), ambiguousRoot = ambiguousState.works.find(work => work.id === ambiguous.value.id), ambiguousChild = ambiguousState.works.find(work => work.rootWorkId === ambiguous.value.id && work.planItemId === 'item-ambiguous-cycle')
  const ambiguousSource = ambiguousState.works.find(work => work.id === ambiguousRoot.plan.items[0].childWorkId).results.at(-1)
  ambiguousChild.input.quantity = 0.5
  ambiguousChild.inputProvenance = { quantity: { kind: 'gearjob.remaining-quantity', sourcePlanItemId: 'item-ambiguous-a', sourceResultId: ambiguousSource.id, plannedQuantity: 4, completedQuantity: 3.5 } }
  assert.throws(() => migrateState(ambiguousState), /唯一当前 GearJob 交接/)
  capture.setWorkOrder(10, 4)

  await assert.rejects(service.updateCollaborationPlan(actor, completed.id, { expectedRevision: 1, items: [{ id: 'item-a', goal: '不可改已完成' }] }), error => error.code === 'BUSY')
  assert.equal((await service.continueCollaboration(actor, completed.id, { clientRequestId: 'normal-completed' })).error.status, 409)

  capture.hold('item-plan-a')
  const editable = await create(service, actor, 'plan', [
    item('item-plan-a', 'employee-a', 1200, 2),
    { ...item('item-plan-b', 'employee-b', 600, 2), dependsOn: ['item-plan-a'] },
  ])
  await capture.waitFor('item-plan-a')
  await assert.rejects(service.updateCollaborationPlan(actor, editable.value.id, { expectedRevision: 1, items: [{ id: 'item-plan-a', employeeId: 'employee-lead' }] }), error => error.code === 'BUSY')
  await assert.rejects(service.updateCollaborationPlan(actor, editable.value.id, { expectedRevision: 1, items: [{ id: 'item-plan-b', employeeId: 'employee-revoked' }] }), error => error.code === 'FORBIDDEN')
  await assert.rejects(service.updateCollaborationPlan(actor, editable.value.id, { expectedRevision: 1, items: [{ id: 'item-plan-b', employeeId: 'employee-incompatible' }] }), error => error.code === 'FORBIDDEN')
  const changed = await service.updateCollaborationPlan(actor, editable.value.id, { expectedRevision: 1, items: [{ id: 'item-plan-b', goal: '更新后的 B 目标', employeeId: 'employee-lead' }] })
  assert.equal(changed.value.plan.revision, 2)
  await assert.rejects(service.updateCollaborationPlan(actor, editable.value.id, { expectedRevision: 1, items: [{ id: 'item-plan-b', goal: '旧 revision' }] }), error => error.code === 'BUSY')
  capture.release('item-plan-a')
  const edited = await waitFor(service, actor, editable.value.id, work => work.status === 'completed')
  assert.equal(edited.plan.items.find(entry => entry.id === 'item-plan-b').goal, '更新后的 B 目标')
  assert.equal(edited.plan.items.find(entry => entry.id === 'item-plan-b').employeeId, 'employee-lead')
  const reassignedChild = (await store.read()).works.find(work => work.rootWorkId === editable.value.id && work.planItemId === 'item-plan-b')
  assert.equal(reassignedChild.employeeId, 'employee-lead')
  assert.equal(reassignedChild.executions[0].employeeId, 'employee-lead')
  assert.equal(reassignedChild.executions[0].planRevision, 2)

  capture.hold('item-cancel')
  const cancelling = await create(service, actor, 'cancel', [item('item-cancel', 'employee-a', 120, 2)])
  const independent = await create(service, actor, 'independent', [item('item-independent', 'employee-b', 240, 4)])
  await capture.waitFor('item-cancel')
  const cancelled = await service.cancel(actor, cancelling.value.id)
  assert.equal(cancelled.accepted, true)
  assert.equal(cancelled.value.collaboration.generation, 1)
  assert.equal(cancelled.value.collaboration.cancelGeneration, 1)
  assert.equal((await waitFor(service, actor, independent.value.id, work => work.status === 'completed')).status, 'completed')
  capture.release('item-cancel')
  const cancelledReadback = (await service.getWork(actor, cancelling.value.id)).value
  assert.equal(cancelledReadback.status, 'cancelled')
  assert.equal(cancelledReadback.plan.items[0].status, 'cancelled')
  const oldChildSession = (await store.read()).works.find(work => work.rootWorkId === cancelling.value.id).executions[0].dshSessionRef
  const continued = await service.continueCollaboration(actor, cancelling.value.id, { clientRequestId: 'cancel-successor' })
  assert.equal(continued.ok, true)
  const continuedDone = await waitFor(service, actor, cancelling.value.id, work => work.status === 'completed')
  const continuedChild = (await store.read()).works.find(work => work.rootWorkId === cancelling.value.id)
  assert.equal(continuedDone.collaboration.generation, 2)
  assert.notEqual(continuedChild.executions.at(-1).dshSessionRef, oldChildSession)

  capture.holdTool()
  const toolCancelling = await create(service, actor, 'tool-cancel', [{
    id: 'item-tool-cancel', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id,
    goal: '读取后取消', input: { workOrderId: 'WO-CANCEL' },
  }])
  const toolIndependent = await create(service, actor, 'tool-independent', [item('item-tool-independent', 'employee-b', 60, 2)])
  await capture.waitForTool()
  assert.equal((await service.cancel(actor, toolCancelling.value.id)).accepted, true)
  assert.equal((await waitFor(service, actor, toolIndependent.value.id, work => work.status === 'completed')).status, 'completed')
  await capture.waitForToolAbort()
  assert.equal((await service.getWork(actor, toolCancelling.value.id)).value.status, 'cancelled')

  const staleRef = { knowledgeId: 'knowledge-r1', revision: 1, segmentId: 'p1-c1' }
  await store.update(state => ({
    ...state,
    knowledgeMaterials: [...state.knowledgeMaterials, { id: 'knowledge-r1', ownerMemberId: actor.id, revision: 2, status: 'deleted', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:01.000Z', deletedAt: '2026-09-19T00:00:01.000Z' }],
    works: state.works.map(work => {
      if (work.id === independent.value.id) return {
        ...work, status: 'completed',
        results: work.results.map(result => result.kind === 'assistant.collaboration-summary' ? { ...result, knowledgeDependencyRefs: [staleRef] } : result),
        handoffs: work.handoffs.map(handoff => ({ ...handoff, knowledgeRefs: [staleRef] })),
        collaboration: { ...work.collaboration, status: 'stale', staleKnowledgeRefs: ['knowledge-r1@1#p1-c1'], staleItemIds: ['item-independent'] },
      }
      if (work.rootWorkId === independent.value.id) return { ...work, results: work.results.map(result => ({ ...result, knowledgeDependencyRefs: [staleRef] })) }
      return work
    }),
  }))
  const oldRecheckSession = (await store.read()).works.find(work => work.rootWorkId === independent.value.id).executions.at(-1).dshSessionRef
  const arbitrary = await service.recheckCollaboration(actor, independent.value.id, { itemIds: ['item-tool-independent'], clientRequestId: 'arbitrary-recheck' })
  assert.equal(arbitrary.error.code, 'INVALID_REQUEST')
  const oldIndependent = (await store.read()).works.find(work => work.rootWorkId === independent.value.id)
  const oldIndependentResult = oldIndependent.results.at(-1).id
  const oldIndependentHandoff = (await store.read()).works.find(work => work.id === independent.value.id).handoffs.find(handoff => handoff.childWorkId === oldIndependent.id && handoff.status === 'current').id
  const recheck = await service.recheckCollaboration(actor, independent.value.id, { clientRequestId: 'recheck-r2' })
  assert.equal(recheck.ok, true)
  const rechecked = await waitFor(service, actor, independent.value.id, work => work.status === 'completed' && work.collaboration.generation === 2)
  const recheckedChild = (await store.read()).works.find(work => work.rootWorkId === independent.value.id)
  assert.notEqual(recheckedChild.executions.at(-1).dshSessionRef, oldRecheckSession)
  assert.equal(rechecked.results.length, 2)
  assert.equal(rechecked.results.at(-1).payload.resultRefs.includes(oldIndependentResult), false)
  assert.equal(rechecked.results.at(-1).handoffRefs.includes(oldIndependentHandoff), false)
  assert.equal(rechecked.handoffs.find(handoff => handoff.id === oldIndependentHandoff).status, 'superseded')

  capture.hold('item-revoke')
  const revoked = await create(service, actor, 'revoke', [
    item('item-revoke-safe', 'employee-b', 120, 2),
    { ...item('item-revoke', 'employee-a', 300, 5), dependsOn: ['item-revoke-safe'] },
  ])
  await capture.waitFor('item-revoke')
  await service.updateConfig(adminForShared, 'employees', 'employee-a', { enabled: false })
  capture.release('item-revoke')
  const revokedDone = await waitFor(service, actor, revoked.value.id, work => work.status === 'failed')
  assert.equal(revokedDone.executions.at(-1).error.code, 'FORBIDDEN', runtimeFailure?.stack)
  const revokedChildren = (await store.read()).works.filter(work => work.rootWorkId === revoked.value.id)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').status, 'completed')
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').results.length, 1)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke').executions.at(-1).error.code, 'FORBIDDEN')
  await service.updateConfig(adminForShared, 'employees', 'employee-a', { enabled: true })
  assert.equal((await service.continueCollaboration(actor, revoked.value.id, { clientRequestId: 'revoke-recovery' })).ok, true)
  await waitFor(service, actor, revoked.value.id, work => work.status === 'completed')
  const recoveredChildren = (await store.read()).works.filter(work => work.rootWorkId === revoked.value.id)
  assert.equal(recoveredChildren.find(work => work.planItemId === 'item-revoke-safe').executions.length, 1)
  assert.equal(recoveredChildren.find(work => work.planItemId === 'item-revoke').executions.length, 2)

  capture.hold('item-budget')
  const budgeted = await create(service, actor, 'budget', [item('item-budget', 'employee-b', 100, 2)])
  await capture.waitForPending('item-budget')
  await store.update(state => ({ ...state, works: state.works.map(work => work.id === budgeted.value.id ? { ...work, collaboration: { ...work.collaboration, requestLimit: 1 } } : work) }))
  capture.release('item-budget')
  const budgetFailed = await waitFor(service, actor, budgeted.value.id, work => work.status === 'failed')
  assert.equal(budgetFailed.executions.at(-1).error.code, 'BUDGET_EXHAUSTED')
  assert.equal(capture.scenarioCount('item-budget'), 1)

  let deferredWorkId
  const deferredService = createWorkService({
    store,
    connectionCatalog: [gearConnection],
    collaborationRunner: {
      run(id) { deferredWorkId = id; return Promise.resolve() },
      cancel: (...args) => runner.cancel(...args),
      close() {},
    },
  })
  capture.hold('item-timeout')
  const timingOut = await create(deferredService, actor, 'timeout', [item('item-timeout', 'employee-b', 90, 3)])
  assert.equal(deferredWorkId, timingOut.value.id)
  await store.update(state => ({ ...state, works: state.works.map(work => work.id === timingOut.value.id ? { ...work, collaboration: { ...work.collaboration, childTimeoutMs: 30 } } : work) }))
  await runner.run(timingOut.value.id).catch(() => undefined)
  const timeoutFailed = (await deferredService.getWork(actor, timingOut.value.id)).value
  assert.equal(timeoutFailed.status, 'failed')
  assert.equal(timeoutFailed.executions.at(-1).error.code, 'UPSTREAM_TIMEOUT')
  capture.release('item-timeout')

  const admin = { id: 'member-admin' }
  await service.updateMember(admin, actor.id, { employeeIds: ['employee-lead', 'employee-a', 'employee-revoked', 'employee-incompatible'] })
  assert.equal((await service.getWork(actor, remountedKnowledge.value.id)).value.collaboration.status, 'stale')
  await service.updateMember(admin, actor.id, { employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
  await service.updateConfig(admin, 'employees', 'employee-b', { enabled: false })
  assert.equal((await service.getWork(actor, remountedKnowledge.value.id)).value.collaboration.status, 'stale')
  await service.updateConfig(admin, 'employees', 'employee-b', { enabled: true })

  capture.hold('item-restart')
  const restarting = await create(service, actor, 'restart', [item('item-restart', 'employee-b', 100, 2)])
  await capture.waitFor('item-restart')
  const requestsBeforeRestart = capture.requests
  await service.close()
  capture.release('item-restart')
  const interrupted = (await store.read()).works.find(work => work.id === restarting.value.id)
  assert.equal(interrupted.status, 'interrupted')
  const reopened = createFileStore(join(temp, 'state.json'))
  await reopened.read()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(capture.requests, requestsBeforeRestart)

  console.log('P3 collaboration runtime checks passed')
} finally {
  if (previousUrl === undefined) delete process.env.GENEWAY_P3_CAPTURE_BASE_URL
  else process.env.GENEWAY_P3_CAPTURE_BASE_URL = previousUrl
  await capture.close()
  await rm(temp, { recursive: true, force: true })
}

function seed(state, gearConnection) {
  const now = '2026-09-19T00:00:00.000Z'
  const employeeIds = ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible']
  return {
    ...state,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: 'Admin', role: 'admin', enabled: true, authRef: 'admin', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
      { id: 'member-owner', loginName: 'owner', displayName: 'Owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
    ],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [
      { id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true },
      { id: 'skill-gearjob-work-order-read', name: '工单读取', capabilityId: 'gearjob-work-order-read', enabled: true },
    ],
    connections: [gearConnection],
    employees: employeeIds.map(id => ({
      id, name: id, enabled: id !== 'employee-revoked', modelRouteId: 'model-zenmux',
      connectionIds: ['employee-a', 'employee-incompatible'].includes(id) ? [gearConnection.id] : [],
      skillIds: id === 'employee-a' ? ['skill-cycle-time-calculate', 'skill-gearjob-work-order-read'] : id === 'employee-incompatible' ? ['skill-gearjob-work-order-read'] : ['skill-cycle-time-calculate'],
    })),
  }
}

function connection(baseUrl) {
  return { id: 'connection-gear', name: 'GearJob test', kind: 'gearjob-rest', targetIdentity: 'local-capture', baseUrl, credentialRef: 'gearjob.json', allowedObjectIds: ['WO-CANCEL'], sourceSystem: 'GearJob', sourceInstance: 'local-capture', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }
}

function item(id, employeeId, availableSeconds, quantity) {
  return { id, employeeId, skillId: 'skill-cycle-time-calculate', goal: id, input: { availableSeconds, quantity } }
}

function create(service, actor, suffix, items) {
  return service.createCollaboration(actor, { employeeId: 'employee-lead', skillId: 'skill-cycle-time-calculate', goal: suffix, clientRequestId: `root-${suffix}`, items })
}

function childrenResultRefs(children) {
  return children.map(work => work.results.at(-1).id)
}

function assertClosedGraphRejects(state, rootWorkId) {
  const root = state.works.find(work => work.id === rootWorkId)
  const childIds = root.collaboration.childWorkIds
  const damaged = mutate => { const value = structuredClone(state); mutate(value.works.find(work => work.id === rootWorkId), value); assert.throws(() => migrateState(value)) }
  damaged((_root, value) => { value.works.find(work => work.id === childIds[0]).ownerMemberId = 'member-foreign' })
  damaged(current => { current.plan.items[1].childWorkId = current.plan.items[0].childWorkId })
  damaged(current => { current.plan.items[0].dependsOn = [current.plan.items[1].id]; current.plan.items[1].dependsOn = [current.plan.items[0].id] })
  damaged((current, value) => {
    const foreignResult = value.works.find(work => work.id === childIds[1]).results[0].id
    current.handoffs.find(handoff => handoff.childWorkId === childIds[0]).resultRefs = [foreignResult]
  })
}

function assertProvenanceRejects(state, rootWorkId) {
  const root = state.works.find(work => work.id === rootWorkId), cycle = state.works.find(work => work.rootWorkId === rootWorkId && work.inputProvenance)
  const source = cycle.inputProvenance.quantity, sourceItem = root.plan.items.find(item => item.id === source.sourcePlanItemId), sourceChild = state.works.find(work => work.id === sourceItem.childWorkId)
  const damaged = mutate => { const value = structuredClone(state); mutate(value.works.find(work => work.id === rootWorkId), value); assert.throws(() => migrateState(value), /输入来源|数量来源/) }
  damaged((_current, value) => { delete value.works.find(work => work.id === cycle.id).inputProvenance })
  damaged((_current, value) => { delete value.works.find(work => work.id === cycle.id).results.find(result => result.kind === 'manufacturing.takt').inputProvenance })
  damaged((_current, value) => { const target = value.works.find(work => work.id === cycle.id); delete target.inputProvenance; delete target.results.find(result => result.kind === 'manufacturing.takt').inputProvenance })
  damaged(current => { current.handoffs = current.handoffs.filter(handoff => handoff.childWorkId !== sourceChild.id || handoff.status !== 'current') })
  damaged(current => { current.handoffs.find(handoff => handoff.childWorkId === sourceChild.id && handoff.status === 'current').status = 'superseded' })
  damaged((current, value) => {
    const child = value.works.find(work => work.id === sourceChild.id), original = child.results.find(result => result.id === source.sourceResultId), replacement = { ...structuredClone(original), id: `replacement-${original.id}`, payload: { ...original.payload, observationId: `replacement-${original.id}` } }
    child.results.push(replacement)
    current.handoffs.find(handoff => handoff.childWorkId === sourceChild.id && handoff.status === 'current').resultRefs = [replacement.id]
  })
}

async function waitFor(service, actor, id, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await service.getWork(actor, id)
    if (result.ok && predicate(result.value)) return result.value
    if (result.value?.status === 'failed') assert.fail(`${runtimeFailure?.stack ?? runtimeFailure}\n${JSON.stringify(result.value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const current = await service.getWork(actor, id)
  assert.fail(`timed out waiting for collaboration: ${runtimeFailure?.stack ?? runtimeFailure}\n${JSON.stringify(current)}`)
}

async function startCapture() {
  let requests = 0, activeChildren = 0, maxActiveChildren = 0
  const holds = new Set(), pending = new Map(), seen = new Set(), counts = new Map(), sequences = new Map(), scenarioTools = new Map()
  let sequence = 0
  let holdToolRequest = false, toolPending, toolAborted = false, plannedQuantity = 10, completedQuantity = 4
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.includes('/api/resource/Work%20Order/')) {
      if (holdToolRequest) {
        toolPending = response
        response.on('close', () => { if (!response.writableEnded) toolAborted = true; toolPending = undefined })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { name: 'WO-CANCEL', status: 'In Process', qty: plannedQuantity, produced_qty: completedQuantity } }))
      return
    }
    const body = await readJson(request)
    requests += 1
    const serialized = JSON.stringify(body)
    const scenario = /SCENARIO:([a-z0-9-]+)/i.exec(serialized)?.[1] ?? 'unknown'
    const toolResultCount = body.messages?.filter(message => message.role === 'tool').length ?? 0
    const hasToolResult = toolResultCount > 0
    if (scenario !== 'root-summary' && !hasToolResult) { activeChildren += 1; maxActiveChildren = Math.max(maxActiveChildren, activeChildren) }
    const visibleTools = (body.tools ?? []).map(entry => entry.function?.name ?? entry.name)
    scenarioTools.set(scenario, visibleTools)
    const businessTool = visibleTools.find(name => ['geneway_calculate_cycle_time', 'geneway_gearjob_read_work_order'].includes(name))
    const summaryRefs = [...new Set(serialized.match(/result-[a-f0-9-]+/g) ?? [])]
    const knowledgeScenario = scenario.includes('knowledge') && visibleTools.includes('geneway_knowledge_search')
    const skipSearch = scenario.includes('negative-unsearched')
    const tool = scenario === 'root-summary' ? (hasToolResult ? undefined : 'geneway_collaboration_submit_summary')
      : knowledgeScenario && toolResultCount === 1 && !skipSearch ? 'geneway_knowledge_search'
        : knowledgeScenario && toolResultCount === 1 && skipSearch ? 'geneway_knowledge_submit_references'
        : knowledgeScenario && toolResultCount === 2 && !skipSearch ? 'geneway_knowledge_submit_references'
          : hasToolResult ? 'structured_output' : businessTool
    const inputMatch = serialized.match(/\\?"availableSeconds\\?":(\d+),\\?"quantity\\?":(\d+)/)
    const complete = () => sendCompletion(response, body.model, tool, tool === 'structured_output'
      ? { status: 'done', explanation: knowledgeScenario ? `${scenario} KNOWLEDGE-CANARY 已完成` : `${scenario} 已完成` }
      : tool === 'geneway_collaboration_submit_summary' ? { resultRefs: summaryRefs }
      : tool === 'geneway_knowledge_search' ? { query: scenario === 'item-knowledge' ? 'KNOWLEDGE-CANARY' : scenario.includes('sibling-b') ? 'SIBLING-ONLY' : '替换后的当前依据' }
      : tool === 'geneway_knowledge_submit_references' ? { references: [{
        knowledgeId: scenario.includes('forged') ? 'knowledge-forged' : scenario.includes('sibling') ? 'knowledge-sibling' : 'knowledge-runtime',
        revision: scenario === 'item-knowledge' ? 1 : scenario.includes('sibling') ? 1 : scenario.includes('bad-revision') ? 2 : (scenario.includes('shared') || scenario.includes('gate') || scenario.includes('negative') || scenario.includes('old-generation')) ? 3 : 2,
        segmentId: scenario.includes('bad-segment') ? 'p9-c9' : 'p1-c1',
      }] }
      : tool === 'geneway_gearjob_read_work_order' ? { workOrderId: 'WO-CANCEL' }
        : { availableSeconds: Number(inputMatch?.[1] ?? 3600), quantity: Number(inputMatch?.[2] ?? 6) })
    seen.add(scenario)
    sequences.set(scenario, ++sequence)
    counts.set(scenario, (counts.get(scenario) ?? 0) + 1)
    if (holds.has(scenario) && !hasToolResult) {
      pending.set(scenario, { response, complete })
      response.on('close', () => pending.delete(scenario))
      return
    }
    complete()
    if (scenario !== 'root-summary' && hasToolResult) activeChildren -= 1
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    address: `http://127.0.0.1:${server.address().port}`,
    get requests() { return requests },
    get maxActiveChildren() { return maxActiveChildren },
    hold(scenario) { holds.add(scenario) },
    async waitFor(scenario) {
      const deadline = Date.now() + 5000
      while (!seen.has(scenario)) { if (Date.now() > deadline) assert.fail(`capture timeout: ${scenario}`); await new Promise(resolve => setTimeout(resolve, 10)) }
    },
    async waitForPending(scenario) {
      const deadline = Date.now() + 5000
      while (!pending.has(scenario)) { if (Date.now() > deadline) assert.fail(`pending capture timeout: ${scenario}`); await new Promise(resolve => setTimeout(resolve, 10)) }
    },
    scenarioCount: scenario => counts.get(scenario) ?? 0,
    sequence: scenario => sequences.get(scenario) ?? 0,
    tools: scenario => scenarioTools.get(scenario) ?? [],
    setWorkOrder(planned, completed) { plannedQuantity = planned; completedQuantity = completed },
    holdTool() { holdToolRequest = true },
    async waitForTool() {
      const deadline = Date.now() + 5000
      while (!toolPending) { if (Date.now() > deadline) assert.fail('tool I/O capture timeout'); await new Promise(resolve => setTimeout(resolve, 10)) }
    },
    async waitForToolAbort() {
      const deadline = Date.now() + 5000
      while (!toolAborted) { if (Date.now() > deadline) assert.fail('tool I/O abort timeout'); await new Promise(resolve => setTimeout(resolve, 10)) }
      holdToolRequest = false
    },
    release(scenario) {
      holds.delete(scenario)
      const entry = pending.get(scenario)
      if (entry && !entry.response.destroyed) entry.complete()
      pending.delete(scenario)
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function sendCompletion(response, model, tool, args) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const id = `chatcmpl-${randomUUID()}`
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  if (tool) {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content: '后置事实汇总已完成' }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  response.end('data: [DONE]\n\n')
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw || '{}')
}
