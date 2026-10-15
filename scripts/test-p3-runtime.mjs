import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { assertKivoTpmTools, KIVO_MCP_SCOPE } from '../plugins/kivo-tpm.mjs'
import { KIVO_TPM_TOOLS, tpmSourcePath } from '../src/domain/tpm.mjs'

const fixturePath = process.argv[2]
assert.ok(fixturePath, '请显式传入脱敏 tpm-wire-tools.json；本测试不寻找或读取运行凭据')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.sourceCommit, 'c54d38af47c735b039a45bf40eb63b94bf30e337')
const tools = fixture.tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }))
assert.equal(assertKivoTpmTools(tools).size, 11)
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const recordId = '00000000-0000-4000-8000-000000000002', deviceId = '00000000-0000-4000-8000-000000000001'
const fixtureTime = '2026-10-15T14:00:00.000Z'
assertHistoricalQuantityChecks()
const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-runtime-'))
process.env.DSH_HOME = join(temp, 'dsh')
const capture = await startCapture()
const previousUrl = process.env.GENEWAY_P3_CAPTURE_BASE_URL
let runtimeFailure, runner, service, failure
process.env.GENEWAY_P3_CAPTURE_BASE_URL = `${capture.address}/v1`
try {
  const store = createFileStore(join(temp, 'state.json'))
  const tpmConnection = connection(capture.address)
  await store.update(state => seed(state, tpmConnection))
  await mkdir(join(temp, 'secrets'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'secrets', tpmConnection.credentialRef), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const schemaSnapshots = []
  const runtimeHooks = { onKnowledgeSchemas: names => schemaSnapshots.push(names) }
  runner = createCollaborationRunner({
    store,
    root: process.cwd(),
    dshHome: join(temp, 'dsh'),
    environment: { GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`, GENEWAY_P3_CAPTURE_KEY: 'local-only' },
    agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 4096 },
    secretRoot: join(temp, 'secrets'),
    connectionCatalog: [tpmConnection],
    onError: error => { runtimeFailure = error },
    testHooks: runtimeHooks,
  })
  service = createWorkService({ store, collaborationRunner: runner, connectionCatalog: [tpmConnection] })
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
  assert.equal(knowledgeChild.results[0].explanation.includes(material.id), false)
  assert.equal(knowledgeChild.results[0].explanation.includes('item-knowledge'), false)
  assert.equal(knowledgeChild.results[0].explanation.includes('employee-b'), false)
  assert.equal(knowledgeChild.results[0].explanation.includes('collaboration-child'), false)
  assert.match(knowledgeChild.results[0].explanation, /当前获准知识/)
  assert.deepEqual(knowledgeChild.results[0].knowledgeDependencyRefs, [{ knowledgeId: material.id, revision: 1, segmentId: 'p1-c1' }])
  assert.deepEqual(knowledgeDone.results.at(-1).payload.resultRefs, knowledgeDone.collaboration.summaryResultRefs)
  for (const internal of [...knowledgeDone.collaboration.summaryResultRefs, material.id, 'item-knowledge', 'employee-lead', 'collaboration-root']) assert.equal(knowledgeDone.results.at(-1).explanation.includes(internal), false)
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
  await service.updateMember(adminForShared, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
  const sharedStale = (await service.getWork(actor, sharedRefWork.value.id)).value
  assert.deepEqual(sharedStale.collaboration.staleItemIds, ['item-knowledge-shared-a'])
  assert.deepEqual(sharedStale.collaboration.staleKnowledgeRefs, [`${material.id}@3#p1-c1`])
  await service.updateMember(adminForShared, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })

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

  const revokeB = async () => service.updateMember(adminForShared, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-a', 'employee-revoked', 'employee-incompatible'] })
  const restoreB = async () => service.updateMember(adminForShared, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
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

  const tpmCompleted = await create(service, actor, 'tpm-complete', [{
    id: 'item-tpm-complete', employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: tpmConnection.id,
    goal: '完成并持久化维修观察', input: { recordType: 'repair', reference: 'R-1' },
  }])
  await waitFor(service, actor, tpmCompleted.value.id, work => work.status === 'completed')
  const tpmChild = (await store.read()).works.find(work => work.rootWorkId === tpmCompleted.value.id)
  const tpmResult = tpmChild.results.at(-1)
  assert.equal(tpmResult.kind, 'kivo.tpm.observation')
  assert.equal(tpmResult.payload.queriedAt, tpmResult.createdAt)
  assert.equal(tpmResult.payload.records[0].id, recordId)
  assert.equal(tpmResult.payload.records[0].rawStatus, 'reported')
  assert.equal(tpmResult.payload.linkedDevice.id, deviceId)
  assert.deepEqual(tpmResult.source, tpmResult.payload.source)
  assert.equal(tpmResult.dshSessionRef, tpmChild.executions[0].dshSessionRef)
  assert.deepEqual(capture.tpmCalls.map(call => call.name), ['tpm.repair.get', 'devices.device.get'])
  assert.match(completed.results.at(-1).explanation, /后置事实汇总/)
  assert.equal(capture.maxActiveChildren <= 2, true)
  assertClosedGraphRejects(persisted, completed.id)

  // Both cycle inputs are explicit user conditions; TPM never supplies a derived quantity.
  const clientItems = [item('item-client-a', 'employee-a', 600, 6), { ...item('item-client-b', 'employee-b', 600, 6), dependsOn: ['item-client-a'] }]
  const invalidField = structuredClone(clientItems); invalidField[1].input.url = 'https://invalid.example'
  const invalidQuantity = structuredClone(clientItems); invalidQuantity[1].input.quantity = '6'
  const beforeInvalid = await store.read(), invalidRequests = capture.requests
  for (const items of [invalidField, invalidQuantity]) assert.equal((await create(service, actor, `client-invalid-${items === invalidField ? 'field' : 'type'}`, items)).error.status, 400)
  const afterInvalid = await store.read()
  assert.deepEqual([afterInvalid.works.length, Object.keys(afterInvalid.reservations).length], [beforeInvalid.works.length, Object.keys(beforeInvalid.reservations).length])
  assert.equal(capture.requests, invalidRequests)

  const waiting = await create(service, actor, 'waiting', [
    item('item-wait-a', 'employee-a', 600, 6),
    { id: 'item-wait-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '等待可用时间', input: { quantity: 6 }, dependsOn: ['item-wait-a'] },
  ])
  const waitingReadback = await waitFor(service, actor, waiting.value.id, work => work.status === 'waiting_input')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-a').status, 'completed')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-b').status, 'waiting_input')
  const waitingChildren = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-a').results.length, 1)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').executions.length, 0)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').input.quantity, 6)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').inputProvenance, undefined)
  assert.deepEqual(waitingChildren.find(work => work.planItemId === 'item-wait-b').requiredInputs, ['availableSeconds'])
  const waitingEdited = await service.updateCollaborationPlan(actor, waiting.value.id, { expectedRevision: 1, items: [{ id: 'item-wait-b', goal: '更新后的等待目标', employeeId: 'employee-lead' }] })
  assert.equal(waitingEdited.value.plan.revision, 2)
  await assert.rejects(service.updateCollaborationPlan(actor, waiting.value.id, { expectedRevision: 1, items: [{ id: 'item-wait-b', goal: '过期草稿' }] }), error => error.code === 'BUSY')
  assert.equal((await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-invalid-input', inputs: { 'item-wait-b': { availableSeconds: 3600, url: 'https://invalid.example' } } })).error.status, 400)
  const waitContinued = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { availableSeconds: 3600 } } })
  assert.equal(waitContinued.ok, true)
  const waitingDone = await waitFor(service, actor, waiting.value.id, work => work.status === 'completed')
  const waitingChildrenDone = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingDone.collaboration.generation, 2)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-a').executions.length, 1)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-b').executions.length, 1)
  const cycleResult = waitingChildrenDone.find(work => work.planItemId === 'item-wait-b').results.at(-1)
  assert.equal(cycleResult.payload.quantity, 6)
  assert.equal(cycleResult.inputProvenance, undefined)
  const waitingReplay = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { availableSeconds: 99 } } })
  assert.equal(waitingReplay.deduplicated, true)
  assert.equal((await store.read()).works.find(work => work.planItemId === 'item-wait-b' && work.rootWorkId === waiting.value.id).executions.length, 1)

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
    id: 'item-tool-cancel', employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: tpmConnection.id,
    goal: '读取后取消', input: { recordType: 'repair', reference: 'R-1' },
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
  await service.updateConfig(adminForShared, 'employees', 'employee-a', { enabled: false, expectedRevision: (await service.listConfig(adminForShared, 'employees')).find(employee => employee.id === 'employee-a').revision })
  capture.release('item-revoke')
  const revokedDone = await waitFor(service, actor, revoked.value.id, work => work.status === 'failed')
  assert.equal(revokedDone.executions.at(-1).error.code, 'FORBIDDEN', runtimeFailure?.stack)
  const revokedChildren = (await store.read()).works.filter(work => work.rootWorkId === revoked.value.id)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').status, 'completed')
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').results.length, 1)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke').executions.at(-1).error.code, 'FORBIDDEN')
  await service.updateConfig(adminForShared, 'employees', 'employee-a', { enabled: true, expectedRevision: (await service.listConfig(adminForShared, 'employees')).find(employee => employee.id === 'employee-a').revision })
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
    connectionCatalog: [tpmConnection],
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

  capture.hold('item-native-timeout')
  const nativeTimeout = await create(deferredService, actor, 'native-timeout', [item('item-native-timeout', 'employee-b', 90, 3)])
  const nativeTimeoutState = await store.read()
  const nativeTimeoutChild = nativeTimeoutState.works.find(work => work.rootWorkId === nativeTimeout.value.id)
  await store.update(state => ({ ...state, works: state.works.map(work => work.id === nativeTimeout.value.id ? { ...work, collaboration: { ...work.collaboration, childTimeoutMs: 100 } } : work) }))
  let nativeTimeoutDisposals = 0
  const cleanedRoots = []
  runtimeHooks.childResult = ({ binding }) => binding.workId === nativeTimeoutChild.id ? new Promise(() => undefined) : undefined
  runtimeHooks.afterChildDispose = ({ workId }) => { if (workId === nativeTimeoutChild.id) nativeTimeoutDisposals += 1 }
  runtimeHooks.afterRootDispose = snapshot => { cleanedRoots.push(snapshot) }
  const nativeTimeoutRun = runner.run(nativeTimeout.value.id).catch(() => undefined)
  await capture.waitFor('item-native-timeout')
  const timeoutIndependent = await create(service, actor, 'timeout-independent', [item('item-timeout-independent', 'employee-b', 60, 1)])
  assert.equal((await waitFor(service, actor, timeoutIndependent.value.id, work => work.status === 'completed')).status, 'completed')
  await nativeTimeoutRun
  const nativeTimeoutFailed = (await deferredService.getWork(actor, nativeTimeout.value.id)).value
  const nativeTimeoutFailedChild = (await store.read()).works.find(work => work.id === nativeTimeoutChild.id)
  assert.equal(nativeTimeoutFailed.status, 'failed')
  assert.equal(nativeTimeoutFailed.executions.at(-1).error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(nativeTimeoutFailedChild.executions.at(-1).error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(nativeTimeoutDisposals, 1)
  assert.equal(cleanedRoots.some(entry => entry.rootWorkId === nativeTimeout.value.id && entry.active === false), true)
  delete runtimeHooks.childResult
  delete runtimeHooks.afterChildDispose
  delete runtimeHooks.afterRootDispose
  capture.release('item-native-timeout')

  const requestHookTimeout = await create(deferredService, actor, 'request-hook-timeout', [item('item-request-hook-timeout', 'employee-b', 90, 3)])
  const requestHookTimeoutChild = (await store.read()).works.find(work => work.rootWorkId === requestHookTimeout.value.id)
  await store.update(state => ({ ...state, works: state.works.map(work => work.id === requestHookTimeout.value.id ? { ...work, collaboration: { ...work.collaboration, childTimeoutMs: 100 } } : work) }))
  let requestHookEnteredResolve
  const requestHookEntered = new Promise(resolve => { requestHookEnteredResolve = resolve })
  let requestHookDisposals = 0
  const requestHookCleanups = []
  runtimeHooks.beforeAgentRequest = ({ binding }) => {
    if (binding.kind !== 'child' || binding.workId !== requestHookTimeoutChild.id) return undefined
    requestHookEnteredResolve()
    return new Promise(() => undefined)
  }
  runtimeHooks.afterChildDispose = ({ workId }) => { if (workId === requestHookTimeoutChild.id) requestHookDisposals += 1 }
  runtimeHooks.afterRootDispose = snapshot => { requestHookCleanups.push(snapshot) }
  const requestHookTimeoutRun = runner.run(requestHookTimeout.value.id).catch(() => undefined)
  await requestHookEntered
  const requestHookIndependent = await create(service, actor, 'request-hook-independent', [item('item-request-hook-independent', 'employee-b', 60, 1)])
  assert.equal((await waitFor(service, actor, requestHookIndependent.value.id, work => work.status === 'completed')).status, 'completed')
  await requestHookTimeoutRun
  const requestHookTimeoutFailed = (await deferredService.getWork(actor, requestHookTimeout.value.id)).value
  const requestHookTimeoutFailedChild = (await store.read()).works.find(work => work.id === requestHookTimeoutChild.id)
  assert.equal(requestHookTimeoutFailed.executions.at(-1).error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(requestHookTimeoutFailedChild.executions.at(-1).error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(requestHookDisposals, 1)
  assert.equal(requestHookCleanups.some(entry => entry.rootWorkId === requestHookTimeout.value.id && entry.active === false), true)
  delete runtimeHooks.beforeAgentRequest
  delete runtimeHooks.afterChildDispose
  delete runtimeHooks.afterRootDispose

  const rootHookCancellation = await create(deferredService, actor, 'root-hook-cancellation', [item('item-root-hook-cancellation', 'employee-b', 60, 1)])
  let rootHookEnteredResolve
  const rootHookEntered = new Promise(resolve => { rootHookEnteredResolve = resolve })
  const rootHookCleanups = []
  runtimeHooks.beforeAgentRequest = ({ binding }) => {
    if (binding.kind !== 'root' || binding.rootWorkId !== rootHookCancellation.value.id) return undefined
    rootHookEnteredResolve()
    return new Promise(() => undefined)
  }
  runtimeHooks.afterRootDispose = snapshot => { rootHookCleanups.push(snapshot) }
  const rootHookRun = runner.run(rootHookCancellation.value.id).catch(() => undefined)
  await rootHookEntered
  const rootHookIndependent = await create(service, actor, 'root-hook-independent', [item('item-root-hook-independent', 'employee-b', 60, 1)])
  assert.equal((await waitFor(service, actor, rootHookIndependent.value.id, work => work.status === 'completed')).status, 'completed')
  assert.equal((await deferredService.cancel(actor, rootHookCancellation.value.id)).accepted, true)
  await rootHookRun
  const rootHookCancelled = (await deferredService.getWork(actor, rootHookCancellation.value.id)).value
  assert.equal(rootHookCancelled.status, 'cancelled')
  assert.equal(rootHookCancelled.executions.at(-1).error.code, 'CANCELLED')
  assert.equal(rootHookCleanups.some(entry => entry.rootWorkId === rootHookCancellation.value.id && entry.active === false), true)
  delete runtimeHooks.beforeAgentRequest
  delete runtimeHooks.afterRootDispose

  const admin = { id: 'member-admin' }
  await service.updateMember(admin, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-a', 'employee-revoked', 'employee-incompatible'] })
  assert.equal((await service.getWork(actor, remountedKnowledge.value.id)).value.collaboration.status, 'stale')
  await service.updateMember(admin, actor.id, { expectedEmployeeIds: (await store.read()).members.find(member => member.id === actor.id).employeeIds, employeeIds: ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible'] })
  await service.updateConfig(admin, 'employees', 'employee-b', { enabled: false, expectedRevision: (await service.listConfig(admin, 'employees')).find(employee => employee.id === 'employee-b').revision })
  assert.equal((await service.getWork(actor, remountedKnowledge.value.id)).value.collaboration.status, 'stale')
  await service.updateConfig(admin, 'employees', 'employee-b', { enabled: true, expectedRevision: (await service.listConfig(admin, 'employees')).find(employee => employee.id === 'employee-b').revision })

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

} catch (error) {
  failure = error
} finally {
  for (const cleanup of [() => service?.close(), () => runner?.close(), () => capture.close(), () => rm(temp, { recursive: true, force: true })]) {
    try { await cleanup() }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'P3 runtime failed and cleanup also failed', { cause: failure }) : error }
  }
  if (previousUrl === undefined) delete process.env.GENEWAY_P3_CAPTURE_BASE_URL
  else process.env.GENEWAY_P3_CAPTURE_BASE_URL = previousUrl
}
if (failure) throw failure
console.log('P3 collaboration runtime checks passed')

function seed(state, tpmConnection) {
  const now = '2026-09-19T00:00:00.000Z'
  const employeeIds = ['employee-lead', 'employee-a', 'employee-b', 'employee-revoked', 'employee-incompatible']
  return {
    ...state,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: 'Admin', role: 'admin', enabled: true, authRef: 'admin', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
      { id: 'member-owner', loginName: 'owner', displayName: 'Owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
    ],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [
      { id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true },
      { id: 'skill-kivo-tpm-record-read', name: 'TPM 读取', capabilityId: 'kivo-tpm-record-read', enabled: true },
    ],
    connections: [tpmConnection],
    employees: employeeIds.map(id => ({
      id, name: id, enabled: id !== 'employee-revoked', modelRouteId: 'model-zenmux',
      connectionIds: ['employee-lead', 'employee-a', 'employee-incompatible'].includes(id) ? [tpmConnection.id] : [],
      skillIds: ['employee-lead', 'employee-a'].includes(id) ? ['skill-cycle-time-calculate', 'skill-kivo-tpm-record-read'] : id === 'employee-incompatible' ? ['skill-kivo-tpm-record-read'] : ['skill-cycle-time-calculate'],
    })),
  }
}

function connection(issuer) {
  return { id: 'connection-tpm', name: 'Kivo TPM test', kind: 'kivo-mcp', targetIdentity: 'local-capture', baseUrl: `${issuer}/api/v1/mes/mcp`, issuer, clientId: '00000000-0000-4000-8000-000000000003', credentialRef: 'kivo.pem', allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'local-capture', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled-mcp', enabled: true, status: 'ready', skillIds: ['skill-kivo-tpm-record-read'], revision: 1 }
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

function assertHistoricalQuantityChecks() {
  // These are existing facts, never new GearJob work or TPM quantity derivation.
  for (const [planned, completed] of [[10, 4], [12, 5]]) {
    const fixture = historicalQuantityState(planned, completed), state = migrateState(fixture)
    assert.deepEqual(state.works, fixture.works)
    const observation = state.works[1].results[0]
    assert.equal(observation.kind, 'gearjob.work-order.observation')
    assert.equal(observation.payload.observationId, observation.id)
    assert.equal(observation.payload.queriedAt, observation.createdAt)
    assert.equal(observation.payload.dshSessionRef, observation.dshSessionRef)
    assert.deepEqual(observation.source, Object.fromEntries(['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime'].map(key => [key, observation.payload[key]])))
    assert.equal(state.works.at(-1).results[0].payload.quantity, planned - completed)
    assertProvenanceRejects(state, 'history-root')
    const zero = structuredClone(fixture)
    zero.works.at(-1).inputProvenance.quantity.completedQuantity = planned
    assert.throws(() => migrateState(zero), /派生数量/)
  }
  assert.throws(() => migrateState(historicalQuantityState(10, 4, 2)), /唯一当前 GearJob 交接/)
}

function historicalQuantityState(planned, completed, sourceCount = 1) {
  const at = '2026-09-19T00:00:00.000Z', quantity = planned - completed
  const resultBase = { schemaVersion: 1, createdAt: at, dshSessionRef: 'history-session', contextConfirmationRefs: [], generation: 1, employeeId: 'history-agent' }
  const workBase = { ownerMemberId: 'history-owner', employeeId: 'history-agent', conversationId: null, requiredInputs: [], status: 'completed', acceptedAt: at, actions: [] }
  const sourceChildren = Array.from({ length: sourceCount }, (_, index) => {
    const id = `history-source-${index}`, resultId = `history-observation-${index}`
    const source = { sourceSystem: 'GearJob', sourceInstance: 'historical-fixture', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', sourceRecordId: 'Work Order:WO-HISTORY', sourceRevision: 'revision-1', sourceTime: at }
    const result = { ...resultBase, id: resultId, kind: 'gearjob.work-order.observation', capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', input: { workOrderId: 'WO-HISTORY' },
      payload: { ...source, observationId: resultId, workOrderId: 'WO-HISTORY', status: 'In Process', plannedQuantity: planned, completedQuantity: completed, completion: { ratio: completed / planned, overPlan: false }, queriedAt: at, dshSessionRef: resultBase.dshSessionRef },
      source, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', handoffRefs: [`handoff-${id}`] }
    return { ...workBase, id, parentWorkId: 'history-root', rootWorkId: 'history-root', workType: 'collaboration-child', planItemId: id, collaborationGeneration: 1, skillId: result.skillId, capabilityId: result.capabilityId, connectionId: 'history-connection', input: result.input, results: [result], executions: [{ id: `execution-${id}`, status: 'completed', generation: 1, resultId }] }
  })
  const input = { availableSeconds: 3600, quantity }, inputProvenance = { quantity: { kind: 'gearjob.remaining-quantity', sourcePlanItemId: sourceChildren[0].id, sourceResultId: sourceChildren[0].results[0].id, plannedQuantity: planned, completedQuantity: completed } }
  const cycle = { ...workBase, id: 'history-cycle', parentWorkId: 'history-root', rootWorkId: 'history-root', workType: 'collaboration-child', planItemId: 'history-cycle', collaborationGeneration: 1, skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input, inputProvenance,
    results: [{ ...resultBase, id: 'history-takt', kind: 'manufacturing.takt', capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', input, inputProvenance, payload: { ...input, secondsPerUnit: 3600 / quantity, unit: 'seconds/unit' }, toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '1', handoffRefs: ['handoff-history-cycle'] }],
    executions: [{ id: 'execution-history-cycle', status: 'completed', generation: 1, resultId: 'history-takt' }] }
  const children = [...sourceChildren, cycle], resultRefs = children.map(child => child.results[0].id), handoffRefs = children.map(child => `handoff-${child.id}`)
  const root = { ...workBase, id: 'history-root', workType: 'collaboration', skillId: cycle.skillId, capabilityId: cycle.capabilityId, input: {},
    collaboration: { generation: 1, cancelGeneration: 0, status: 'completed', requestLimit: 12, requestCount: 6, childLimit: 4, maxConcurrentChildren: 2, rootTimeoutMs: 360000, childTimeoutMs: 120000, outputMaxTokens: 4096, childWorkIds: children.map(child => child.id), summaryResultRefs: resultRefs, staleKnowledgeRefs: [], staleItemIds: [] },
    plan: { revision: 1, items: children.map(child => ({ id: child.id, childWorkId: child.id, goal: '历史事实', employeeId: child.employeeId, status: 'completed', dependsOn: child === cycle ? sourceChildren.map(source => source.id) : [] })) },
    handoffs: children.map(child => ({ id: `handoff-${child.id}`, childWorkId: child.id, fromEmployeeId: child.employeeId, toEmployeeId: 'history-agent', resultRefs: [child.results[0].id], knowledgeRefs: [], revision: 1, generation: 1, status: 'current', createdAt: at })),
    results: [{ ...resultBase, id: 'history-summary', kind: 'assistant.collaboration-summary', capabilityId: cycle.capabilityId, skillId: cycle.skillId, input: {}, payload: { resultRefs }, handoffRefs }],
    executions: [{ id: 'execution-history-root', generation: 1, status: 'completed', resultId: 'history-summary' }] }
  return { version: 8, members: [{ id: 'history-owner', loginName: 'history', authRef: 'history', role: 'member', enabled: true, sessionVersion: 1, employeeIds: ['history-agent'] }], modelRoutes: [], employees: [{ id: 'history-agent' }], connections: [], skills: [], confirmations: [], knowledgeMaterials: [], channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [], automationRules: [], automationOccurrences: [], works: [root, ...children], reservations: {} }
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
  let holdToolRequest = false, toolPending, toolAborted = false
  const tpmCalls = []
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      try {
        await serveKivo(request, response, connection(`http://127.0.0.1:${server.address().port}`), rpc => {
          tpmCalls.push(rpc.params)
          if (!holdToolRequest) return false
          toolPending = response
          response.on('close', () => { if (!response.writableEnded) toolAborted = true; toolPending = undefined })
          return true
        })
      } catch (error) { runtimeFailure = error; response.writeHead(500); response.end('synthetic MCP fixture failed') }
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
    const businessTool = visibleTools.find(name => ['geneway_calculate_cycle_time', KIVO_TPM_TOOLS.readRecord].includes(name))
    const summaryRefs = [...new Set(serialized.match(/result-[a-f0-9-]+/g) ?? [])]
    const knowledgeScenario = scenario.includes('knowledge') && visibleTools.includes('geneway_knowledge_search')
    const skipSearch = scenario.includes('negative-unsearched')
    const tool = scenario === 'root-summary' ? (hasToolResult ? undefined : 'geneway_collaboration_submit_summary')
      : knowledgeScenario && toolResultCount === 1 && !skipSearch ? 'geneway_knowledge_search'
        : knowledgeScenario && toolResultCount === 1 && skipSearch ? 'geneway_knowledge_submit_references'
        : knowledgeScenario && toolResultCount === 2 && !skipSearch ? 'geneway_knowledge_submit_references'
          : hasToolResult ? 'structured_output' : businessTool
    const complete = () => sendCompletion(response, body.model, tool, tool === 'structured_output'
      ? { status: 'done', explanation: knowledgeScenario ? `${scenario} KNOWLEDGE-CANARY knowledge-runtime employee-b collaboration-child 已完成` : `${scenario} 已完成` }
      : tool === 'geneway_collaboration_submit_summary' ? { resultRefs: summaryRefs }
      : tool === 'geneway_knowledge_search' ? { query: scenario === 'item-knowledge' ? 'KNOWLEDGE-CANARY' : scenario.includes('sibling-b') ? 'SIBLING-ONLY' : '替换后的当前依据' }
      : tool === 'geneway_knowledge_submit_references' ? { references: [{
        knowledgeId: scenario.includes('forged') ? 'knowledge-forged' : scenario.includes('sibling') ? 'knowledge-sibling' : 'knowledge-runtime',
        revision: scenario === 'item-knowledge' ? 1 : scenario.includes('sibling') ? 1 : scenario.includes('bad-revision') ? 2 : (scenario.includes('shared') || scenario.includes('gate') || scenario.includes('negative') || scenario.includes('old-generation')) ? 3 : 2,
        segmentId: scenario.includes('bad-segment') ? 'p9-c9' : 'p1-c1',
      }] }
      : tool === KIVO_TPM_TOOLS.readRecord || tool === 'geneway_calculate_cycle_time' ? canonicalBusinessInput(body) : undefined,
    scenario === 'root-summary' && !tool ? `后置事实汇总已完成 ${summaryRefs.join(' ')} employee-lead item-knowledge collaboration-root` : undefined)
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
    get tpmCalls() { return tpmCalls },
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

function sendCompletion(response, model, tool, args, content = '后置事实汇总已完成') {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const id = `chatcmpl-${randomUUID()}`
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  if (tool) {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  response.end('data: [DONE]\n\n')
}

async function readJson(request) {
  return JSON.parse(await readBody(request) || '{}')
}

async function readBody(request) { let raw = ''; for await (const chunk of request) raw += chunk; return raw }

function canonicalBusinessInput(body) {
  const text = body.messages.map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n')).join('\n')
  const marker = text.includes(' exactly once with ') ? ' exactly once with ' : '参数必须精确为 '
  assert(text.includes(marker), 'canonical business input missing')
  const start = text.indexOf('{', text.indexOf(marker) + marker.length)
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
    else if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1))
  }
  assert.fail('canonical business input JSON missing')
}

async function serveKivo(request, response, target, onCall) {
  const path = new URL(request.url, target.issuer).pathname
  const send = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)) }
  if (path === '/.well-known/oauth-protected-resource/api/v1/mes/mcp') return send(200, { resource: target.baseUrl, authorization_servers: [target.issuer], scopes_supported: KIVO_MCP_SCOPE.split(' '), bearer_methods_supported: ['header'] })
  if (path === '/.well-known/oauth-authorization-server') return send(200, { issuer: target.issuer, authorization_endpoint: `${target.issuer}/api/v1/oauth/authorize`, token_endpoint: `${target.issuer}/api/v1/oauth/token`, grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] })
  if (path === '/api/v1/oauth/token') {
    assert.equal(request.method, 'POST')
    const form = new URLSearchParams(await readBody(request)), jwt = form.get('client_assertion').split('.'), claims = JSON.parse(Buffer.from(jwt[1], 'base64url'))
    assert.equal(form.get('resource'), target.baseUrl); assert.equal(form.get('scope'), KIVO_MCP_SCOPE)
    assert.equal(claims.sub, target.clientId); assert.equal(claims.aud, target.issuer)
    assert(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), keys.publicKey, Buffer.from(jwt[2], 'base64url')))
    return send(200, { access_token: 'synthetic-kivo-token', token_type: 'Bearer', expires_in: 300, scope: KIVO_MCP_SCOPE })
  }
  assert.equal(path, '/api/v1/mes/mcp'); assert.equal(request.method, 'POST')
  const rpc = await readJson(request)
  if (request.headers.authorization !== 'Bearer synthetic-kivo-token') return send(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${target.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"` })
  const reply = value => send(200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...value } })
  if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
  if (rpc.method === 'tools/list') return reply({ tools, ttlMs: 0, cacheScope: 'private' })
  assert.equal(rpc.method, 'tools/call')
  const expected = { 'tpm.repair.get': { orderNo: 'R-1' }, 'devices.device.get': { deviceId } }[rpc.params.name]
  assert(expected, 'unexpected synthetic MCP tool'); assert.deepEqual(rpc.params.arguments, expected)
  if (onCall?.(rpc)) return
  const value = rpc.params.name === 'devices.device.get' ? { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: recordId, organizationName: 'synthetic' }
    : { id: recordId, deviceId, orderNo: 'R-1', status: 'reported', reporterId: null, executorId: null, acceptedById: null, revision: 1, createdAt: fixtureTime, updatedAt: fixtureTime, reopenedFrom: null, detail: { reason: 'TPM-FACT-CANARY' } }
  const result = { status: 'ok', source: { system: 'kivo', path: tpmSourcePath(rpc.params), queriedAt: fixtureTime, traceId: request.headers['x-trace-id'] }, value }
  return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
}
