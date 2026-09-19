import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
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
  const runner = createCollaborationRunner({
    store,
    root: process.cwd(),
    dshHome: join(temp, 'dsh'),
    environment: { GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`, GENEWAY_P3_CAPTURE_KEY: 'local-only' },
    agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 4096 },
    secretRoot: join(temp, 'secrets'),
    onError: error => { runtimeFailure = error },
  })
  const service = createWorkService({ store, collaborationRunner: runner, connectionCatalog: [gearConnection] })
  const actor = { id: 'member-owner' }
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
  assert.match(completed.results.at(-1).explanation, /后置事实汇总/)
  assert.equal(capture.maxActiveChildren <= 2, true)
  assertClosedGraphRejects(persisted, completed.id)

  const waiting = await create(service, actor, 'waiting', [
    item('item-wait-a', 'employee-a', 600, 2),
    { id: 'item-wait-b', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', goal: '等待剩余数量', input: { availableSeconds: 3600 } },
  ])
  const waitingReadback = await waitFor(service, actor, waiting.value.id, work => work.status === 'waiting_input')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-a').status, 'completed')
  assert.equal(waitingReadback.plan.items.find(entry => entry.id === 'item-wait-b').status, 'waiting_input')
  const waitingChildren = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-a').results.length, 1)
  assert.equal(waitingChildren.find(work => work.planItemId === 'item-wait-b').executions.length, 0)
  const waitContinued = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { quantity: 6 } } })
  assert.equal(waitContinued.ok, true)
  const waitingDone = await waitFor(service, actor, waiting.value.id, work => work.status === 'completed')
  const waitingChildrenDone = (await store.read()).works.filter(work => work.rootWorkId === waiting.value.id)
  assert.equal(waitingDone.collaboration.generation, 2)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-a').executions.length, 1)
  assert.equal(waitingChildrenDone.find(work => work.planItemId === 'item-wait-b').executions.length, 1)
  const waitingReplay = await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'waiting-successor', inputs: { 'item-wait-b': { quantity: 99 } } })
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
    id: 'item-tool-cancel', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: gearConnection.id,
    goal: '读取后取消', input: { workOrderId: 'WO-CANCEL' },
  }])
  const toolIndependent = await create(service, actor, 'tool-independent', [item('item-tool-independent', 'employee-b', 60, 2)])
  await capture.waitForTool()
  assert.equal((await service.cancel(actor, toolCancelling.value.id)).accepted, true)
  assert.equal((await waitFor(service, actor, toolIndependent.value.id, work => work.status === 'completed')).status, 'completed')
  await capture.waitForToolAbort()
  assert.equal((await service.getWork(actor, toolCancelling.value.id)).value.status, 'cancelled')

  await store.update(state => ({ ...state, works: state.works.map(work => work.id === independent.value.id
    ? { ...work, status: 'completed', collaboration: { ...work.collaboration, status: 'stale', summaryResultRefs: [], staleKnowledgeRefs: ['knowledge-r1'], staleItemIds: ['item-independent'] } }
    : work) }))
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
  await store.update(state => ({ ...state, employees: state.employees.map(employee => employee.id === 'employee-a' ? { ...employee, enabled: false } : employee) }))
  capture.release('item-revoke')
  const revokedDone = await waitFor(service, actor, revoked.value.id, work => work.status === 'failed')
  assert.equal(revokedDone.executions.at(-1).error.code, 'FORBIDDEN', runtimeFailure?.stack)
  const revokedChildren = (await store.read()).works.filter(work => work.rootWorkId === revoked.value.id)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').status, 'completed')
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke-safe').results.length, 1)
  assert.equal(revokedChildren.find(work => work.planItemId === 'item-revoke').executions.at(-1).error.code, 'FORBIDDEN')
  await store.update(state => ({ ...state, employees: state.employees.map(employee => employee.id === 'employee-a' ? { ...employee, enabled: true } : employee) }))
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
    members: [{ id: 'member-owner', loginName: 'owner', displayName: 'Owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now }],
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
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.includes('/api/resource/Work%20Order/')) {
      if (holdToolRequest) {
        toolPending = response
        response.on('close', () => { if (!response.writableEnded) toolAborted = true; toolPending = undefined })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { name: 'WO-CANCEL', status: 'In Process', qty: 10, produced_qty: 4 } }))
      return
    }
    const body = await readJson(request)
    requests += 1
    const serialized = JSON.stringify(body)
    const scenario = /SCENARIO:([a-z0-9-]+)/i.exec(serialized)?.[1] ?? 'unknown'
    const hasToolResult = body.messages?.some(message => message.role === 'tool')
    if (scenario !== 'root-summary' && !hasToolResult) { activeChildren += 1; maxActiveChildren = Math.max(maxActiveChildren, activeChildren) }
    const visibleTools = (body.tools ?? []).map(entry => entry.function?.name ?? entry.name)
    scenarioTools.set(scenario, visibleTools)
    const businessTool = visibleTools.find(name => ['geneway_calculate_cycle_time', 'geneway_gearjob_read_work_order'].includes(name))
    const summaryRefs = [...new Set(serialized.match(/result-[a-f0-9-]+/g) ?? [])]
    const tool = scenario === 'root-summary' ? (hasToolResult ? undefined : 'geneway_collaboration_submit_summary') : hasToolResult ? 'structured_output' : businessTool
    const inputMatch = serialized.match(/\\?"availableSeconds\\?":(\d+),\\?"quantity\\?":(\d+)/)
    const complete = () => sendCompletion(response, body.model, tool, tool === 'structured_output'
      ? { status: 'done', explanation: `${scenario} 已完成` }
      : tool === 'geneway_collaboration_submit_summary' ? { resultRefs: summaryRefs }
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
