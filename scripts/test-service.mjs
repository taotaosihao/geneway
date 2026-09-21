import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'
import { readConnectionCatalog } from '../src/connection-catalog.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p2-service-'))
const stateFile = join(root, 'state.json')
const store = createFileStore(stateFile)
const catalogFile = join(root, 'private', 'connections.json')
await mkdir(join(root, 'private'), { mode: 0o700 })
await writeFile(catalogFile, JSON.stringify({ version: 1, targets: catalogTargets() }), { mode: 0o600 })
const connectionCatalog = await readConnectionCatalog(catalogFile, process.cwd())
const conflictingCatalogFile = join(root, 'private', 'conflicting-connections.json')
await writeFile(conflictingCatalogFile, JSON.stringify({ version: 1, targets: [target('connection-a', 'A'), { ...target('connection-b', 'B'), credentialRef: 'connection-a.json' }] }), { mode: 0o600 })
await assert.rejects(readConnectionCatalog(conflictingCatalogFile, process.cwd()), /同一 credentialRef/)
const calls = []
const gates = new Map()
let nextGate
const runner = {
  configured: true,
  async run(args) {
    calls.push(structuredClone(args))
    if (nextGate) {
      gates.set(args.executionId, nextGate)
      nextGate = undefined
    }
    if (gates.has(args.executionId)) await gates.get(args.executionId).promise
    const common = {
      explanation: `说明 ${args.capabilityId}`,
      dshSessionRef: args.sessionId ?? `session-${calls.length}`,
      continuedFromDshSessionRef: args.sessionId && args.forceSuccessor ? args.sessionId : undefined,
      contextResultId: args.contextResultId,
      continuity: args.sessionId ? 'same-session' : 'new',
      contextConfirmationRefs: args.sessionMetadata.confirmationRefs,
      eventCount: 3,
    }
    if (args.operation === 'follow-up') return common
    if (args.capabilityId === 'cycle-time-calculate') return {
      ...common,
      result: {
        kind: 'manufacturing.takt',
        payload: { ...args.input, secondsPerUnit: args.input.availableSeconds / args.input.quantity, unit: 'seconds/unit' },
        toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2',
      },
    }
    return {
      ...common,
      result: {
        kind: 'gearjob.work-order.observation',
        payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' },
        source: { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' },
        toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2',
      },
    }
  },
  async cancel(executionId) { gates.get(executionId)?.release() },
  async close() {},
}

try {
  await store.update(seedState)
  const service = createWorkService({ store, runner, connectionCatalog, policyPaths: { stateFile, dataRoot: root, secretRoot: join(root, 'secrets') }, connectionTester: async connection => connection.targetIdentity })
  const alice = { id: 'member-alice' }
  const bob = { id: 'member-bob' }
  const admin = { id: 'member-admin' }

  const waiting = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600 }, clientRequestId: 'waiting' })
  assert.equal(waiting.ok, true)
  assert.equal(waiting.value.status, 'waiting_input')
  assert.deepEqual(waiting.value.requiredInputs, ['quantity'])
  assert.equal(waiting.value.executions.length, 0)
  assert.equal(calls.length, 0)
  const invalid = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: -1 }, clientRequestId: 'invalid' })
  assert.equal(invalid.error.status, 400)
  assert.equal(calls.length, 0)

  const continued = await service.continueWork(alice, waiting.value.id, { input: { quantity: 60 }, clientRequestId: 'continue' })
  assert.equal(continued.ok, true)
  const completedCycle = await waitFor(service, alice, waiting.value.id, work => work.status === 'completed')
  assert.equal(completedCycle.results[0].kind, 'manufacturing.takt')
  assert.equal(completedCycle.results[0].payload.secondsPerUnit, 60)
  assert.equal(completedCycle.executions[0].resultId, completedCycle.results[0].id)
  assert.equal(completedCycle.observations.length, 0)
  const callsAfterContinue = calls.length
  const continuedReplay = await service.continueWork(alice, waiting.value.id, { input: { quantity: 999 }, clientRequestId: 'continue' })
  assert.equal(continuedReplay.deduplicated, true)
  assert.equal(continuedReplay.value.status, 'completed')
  assert.equal(continuedReplay.value.executions[0].id, completedCycle.executions[0].id)
  assert.equal(calls.length, callsAfterContinue)
  assert.equal((await service.continueWork(alice, waiting.value.id, { input: { quantity: 60 }, clientRequestId: 'continue-new-key' })).error.status, 409)

  const waitingGear = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', input: {}, clientRequestId: 'waiting-gear' })
  assert.equal(waitingGear.value.status, 'waiting_input')
  assert.deepEqual(waitingGear.value.requiredInputs, ['workOrderId'])
  assert.equal(waitingGear.value.executions.length, 0)

  const gear = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-a', input: { workOrderId: 'WO-1' }, clientRequestId: 'gear' })
  const completedGear = await waitFor(service, alice, gear.value.id, work => work.status === 'completed')
  assert.equal(completedGear.results.length, 1)
  assert.equal(completedGear.results[0].kind, 'gearjob.work-order.observation')
  assert.equal(completedGear.observations[0].completion.ratio, 0.4)
  assert.equal(completedGear.observations[0].evidenceMode, 'real-frappe-rest')
  assert.equal(completedGear.executions[0].resultObservationId, completedGear.results[0].id)
  const persisted = (await store.read()).works.find(item => item.id === gear.value.id)
  assert.equal('observations' in persisted, false)
  assert.equal('followUps' in persisted, false)
  assert.equal(calls.at(-1).grant.connection.id, 'connection-a')
  assert.equal(calls.at(-1).grant.policyFile, stateFile)
  assert.equal(calls.at(-1).sessionMetadata.ownerMemberId, 'member-alice')

  assert.equal((await service.getWork(bob, gear.value.id)).error.status, 404)
  assert.equal((await service.getWork(admin, gear.value.id)).error.status, 404)
  const sameBob = await service.createWork(bob, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: 'gear' })
  assert.notEqual(sameBob.value.id, gear.value.id)
  await waitFor(service, bob, sameBob.value.id, work => work.status === 'completed')

  const confirmation1 = await service.createConfirmation(alice, { employeeId: 'employee-a', label: '班次', value: '白班' })
  const confirmation2 = await service.updateConfirmation(alice, confirmation1.id, { value: '夜班' })
  assert.equal(confirmation2.revision, 2)
  const confirmedWork = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 300, quantity: 5 }, clientRequestId: 'confirmed-capability' })
  await waitFor(service, alice, confirmedWork.value.id, work => work.status === 'completed')
  assert.deepEqual(calls.find(item => item.sessionMetadata.workId === confirmedWork.value.id).confirmations, [{ id: confirmation1.id, revision: 2, label: '班次', value: '夜班' }])
  const follow = await service.followUp(alice, gear.value.id, '当前依据是什么？', { clientRequestId: 'follow' })
  assert.equal(follow.ok, true)
  const followed = await waitFor(service, alice, gear.value.id, work => work.followUps.length === 1)
  assert.deepEqual(followed.results.at(-1).contextConfirmationRefs, [{ id: confirmation1.id, revision: 2 }])
  assert.deepEqual(followed.executions.at(-1).contextConfirmationRefs, [{ id: confirmation1.id, revision: 2 }])
  assert.match(followed.executions.at(-1).confirmationFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(followed.executions.at(-1).resultFollowUpId, followed.results.at(-1).id)
  const followCall = calls.find(item => item.operation === 'follow-up')
  assert.deepEqual(followCall.followUp.confirmations, [{ id: confirmation1.id, revision: 2, label: '班次', value: '夜班' }])
  assert.equal(JSON.stringify(followCall.followUp.facts).includes('说明 gearjob'), false)
  await service.deleteConfirmation(alice, confirmation1.id)
  assert.equal((await service.listConfirmations(alice))[0].status, 'revoked')
  await assert.rejects(
    () => service.updateConfirmation(alice, confirmation1.id, { value: '不可复活' }),
    error => error.code === 'INVALID_REQUEST',
  )
  const refresh = await service.refreshWork(alice, gear.value.id, { clientRequestId: 'after-revoke' })
  assert.equal(refresh.ok, true)
  await waitFor(service, alice, gear.value.id, work => work.results.length === 3)
  assert.deepEqual(calls.at(-1).sessionMetadata.confirmationRefs, [])

  const busyGate = deferred()
  const busyWaiting = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 600 }, clientRequestId: 'busy-waiting' })
  nextGate = busyGate
  const firstContinue = await service.continueWork(alice, busyWaiting.value.id, { input: { quantity: 10 }, clientRequestId: 'busy-continue' })
  const executionId = firstContinue.value.executions.at(-1).id
  await waitFor(service, alice, busyWaiting.value.id, work => work.status === 'running')
  const activeContinue = await service.continueWork(alice, busyWaiting.value.id, { input: { quantity: 99 }, clientRequestId: 'other' })
  assert.equal(activeContinue.active, true)
  assert.equal(activeContinue.value.executions.at(-1).id, executionId)
  assert.equal(activeContinue.value.input.quantity, 10)
  busyGate.release()
  await waitFor(service, alice, busyWaiting.value.id, work => work.status === 'completed')
  const completedContinue = await service.continueWork(alice, busyWaiting.value.id, { input: { quantity: 10 }, clientRequestId: 'completed-continue' })
  assert.equal(completedContinue.error.status, 409)

  await assert.rejects(service.listMembers(alice), error => error.code === 'FORBIDDEN')
  await assert.rejects(service.listConfig(alice, 'employees'), error => error.code === 'FORBIDDEN')
  assert.equal((await service.listConfig(admin, 'modelRoutes'))[0].model, 'deepseek/deepseek-v4-pro')
  const renamed = await service.updateConfig(admin, 'employees', 'employee-admin', { description: '管理员配置员工' })
  assert.equal(renamed.description, '管理员配置员工')
  for (const [field, value] of Object.entries({
    targetIdentity: 'other', baseUrl: 'http://127.0.0.1/other', hostHeader: 'other.localhost',
    sourceSystem: 'Other', sourceInstance: 'Other', sourceEnvironment: 'production',
    dataMode: 'live', evidenceMode: 'controlled',
  })) await assert.rejects(service.updateConfig(admin, 'connections', 'connection-a', { [field]: value }), /不可原地更换/)
  const beforeRotation = (await service.listConfig(admin, 'connections')).find(item => item.id === 'connection-a')
  const rotated = await service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a-next.json' })
  assert.equal(rotated.credentialRef, 'connection-a-next.json')
  assert.equal(rotated.revision, beforeRotation.revision + 1)
  assert.equal(rotated.status, 'unknown')
  await assert.rejects(service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a-next.json', baseUrl: 'http://127.0.0.1/other' }), /不可原地更换/)
  await service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a.json' })
  const mutableConnection = await service.updateConfig(admin, 'connections', 'connection-a', {
    name: 'connection-a-renamed', allowedObjectIds: ['WO-1', 'WO-2'], enabled: false, skillIds: [],
  })
  assert.equal(mutableConnection.name, 'connection-a-renamed')
  assert.deepEqual(mutableConnection.allowedObjectIds, ['WO-1', 'WO-2'])
  assert.equal(mutableConnection.enabled, false)
  assert.deepEqual(mutableConnection.skillIds, [])
  await service.updateConfig(admin, 'connections', 'connection-a', { name: 'connection-a', allowedObjectIds: ['WO-1'], enabled: true, skillIds: ['skill-gearjob-work-order-read'] })
  const skillOff = await service.updateConfig(admin, 'skills', 'skill-cycle-time-calculate', { enabled: false })
  assert.equal(skillOff.enabled, false)
  await service.updateConfig(admin, 'skills', 'skill-cycle-time-calculate', { enabled: true })
  await assert.rejects(service.updateMember(admin, 'member-admin', { enabled: false }), /最后一个/)
  const oldVersion = (await service.listMembers(admin)).find(item => item.id === 'member-bob').sessionVersion
  const disabled = await service.updateMember(admin, 'member-bob', { enabled: false })
  assert.equal(disabled.sessionVersion, oldVersion + 1)
  await assert.rejects(service.bootstrap(bob), error => error.code === 'UNAUTHORIZED')
  const tested = await service.testConnection(admin, 'connection-a')
  assert.equal(tested.ok, true)
  await assert.rejects(
    service.createConfig(admin, 'connections', { id: 'bad-secret', name: 'bad', kind: 'gearjob-rest', targetIdentity: 'bad', baseUrl: 'http://127.0.0.1', credentialRef: '../secret', allowedObjectIds: [], sourceSystem: 'GearJob', sourceInstance: 'bad', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, skillIds: ['skill-gearjob-work-order-read'] }),
    error => error.code === 'INVALID_REQUEST',
  )
  await assert.rejects(
    service.createConfig(admin, 'connections', { id: 'long-secret', name: 'long', kind: 'gearjob-rest', targetIdentity: 'long', baseUrl: 'http://127.0.0.1', credentialRef: `a${'.'.repeat(128)}`, allowedObjectIds: [], sourceSystem: 'GearJob', sourceInstance: 'long', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, skillIds: ['skill-gearjob-work-order-read'] }),
    error => error.code === 'INVALID_REQUEST',
  )
  const browserReady = await service.createConfig(admin, 'connections', { id: 'browser-ready', name: 'browser-ready', kind: 'gearjob-rest', targetIdentity: 'browser-ready', baseUrl: 'http://127.0.0.1', credentialRef: 'browser-ready.json', allowedObjectIds: [], sourceSystem: 'GearJob', sourceInstance: 'browser-ready', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'] })
  assert.equal(browserReady.status, 'unknown')

  const testStarted = deferred()
  const testRelease = deferred()
  const raceService = createWorkService({ store, runner, connectionCatalog, connectionTester: async () => { testStarted.release(); await testRelease.promise; return 'stale' } })
  const staleTest = raceService.testConnection(admin, 'connection-a')
  await testStarted.promise
  await service.updateConfig(admin, 'connections', 'connection-a', { name: 'connection-a-updated' })
  testRelease.release()
  await assert.rejects(staleTest, error => error.code === 'BUSY')
  assert.equal((await service.listConfig(admin, 'connections')).find(item => item.id === 'connection-a').status, 'unknown')
  await service.testConnection(admin, 'connection-a')
  await checkCredentialTargetCannotBeRedirected(admin)

  const boot = await service.bootstrap(alice)
  assert.ok(boot.works.every(work => work.ownerMemberId === alice.id))
  assert.ok(boot.employees.every(employee => ['employee-a'].includes(employee.id)))
  assert.equal(boot.connections.some(connection => connection.id === 'connection-b'), false)
  assert.equal(boot.connections.some(connection => 'credentialRef' in connection || 'baseUrl' in connection || 'hostHeader' in connection), false)
  await checkUnavailableCatalog(alice, admin)
  await checkSafeExecutionErrors(alice)

  await service.close()
  await checkCloseSettlement(false)
  await checkCloseSettlement(true)
  for (const [label, mutate] of [
    ['member', state => { state.members.find(item => item.id === 'member-alice').enabled = false }],
    ['employee', state => { state.employees.find(item => item.id === 'employee-a').enabled = false }],
    ['skill', state => { state.skills.find(item => item.id === 'skill-gearjob-work-order-read').enabled = false }],
    ['connection', state => { state.connections.find(item => item.id === 'connection-a').enabled = false }],
  ]) await checkRevokedBeforeDispatch(label, mutate)
  console.log('service checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function waitFor(service, actor, id, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await service.getWork(actor, id)
    if (result.ok && predicate(result.value)) return result.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for work')
}

function deferred() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

async function checkRevokedBeforeDispatch(label, mutate) {
  const base = createFileStore(join(root, `revoke-${label}.json`))
  await base.update(seedState)
  const gate = deferred()
  let blockRead = true
  const gatedStore = {
    update: (...args) => base.update(...args),
    async read() { if (blockRead) await gate.promise; return base.read() },
  }
  let runs = 0
  const service = createWorkService({ store: gatedStore, runner: { configured: true, async run() { runs += 1; throw new Error('must not dispatch') }, async close() {} }, connectionCatalog })
  const actor = { id: 'member-alice' }
  const accepted = await service.createWork(actor, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', input: { workOrderId: 'WO-1' }, clientRequestId: `revoke-${label}` })
  await base.update(state => { mutate(state); return state })
  blockRead = false
  gate.release()
  const state = await base.read()
  const work = state.works.find(item => item.id === accepted.value.id)
  for (let attempt = 0; !['failed', 'cancelled'].includes(work.status) && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    Object.assign(work, (await base.read()).works.find(item => item.id === work.id))
  }
  assert.equal(work.status, 'failed', `${label} revocation must fail locally`)
  assert.equal(runs, 0, `${label} revocation must stop before model`)
  await service.close()
}

async function checkCloseSettlement(cancelRequested) {
  const base = createFileStore(join(root, `close-${cancelRequested ? 'cancel' : 'active'}.json`))
  await base.update(seedState)
  const gate = deferred()
  const localRunner = {
    configured: true,
    async run() { await gate.promise; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    async cancel() { gate.release() },
    async close() {},
  }
  const localService = createWorkService({ store: base, runner: localRunner })
  const actor = { id: 'member-alice' }
  const created = await localService.createWork(actor, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60, quantity: 1 }, clientRequestId: `close-${cancelRequested}` })
  const executionId = created.value.executions[0].id
  await waitFor(localService, actor, created.value.id, work => work.status === 'running')
  if (cancelRequested) await localService.cancel(actor, created.value.id)
  await localService.close()
  const work = (await base.read()).works.find(item => item.id === created.value.id)
  const execution = work.executions.find(item => item.id === executionId)
  assert.equal(work.status, cancelRequested ? 'cancelled' : 'interrupted')
  assert.equal(execution.status, cancelRequested ? 'cancelled' : 'interrupted')
  assert.equal(execution.error.code, cancelRequested ? 'CANCELLED' : 'PROCESS_SHUTDOWN')
}

function seedState(state) {
  const now = '2026-09-19T00:00:00.000Z'
  const member = (id, role, employeeIds) => ({ id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  const connection = (id, instance) => ({ id, name: id, kind: 'gearjob-rest', targetIdentity: instance, baseUrl: `http://127.0.0.1/${id}`, credentialRef: `${id}.json`, allowedObjectIds: ['WO-1'], sourceSystem: 'GearJob', sourceInstance: instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 })
  return {
    ...state,
    members: [member('member-admin', 'admin', ['employee-admin']), member('member-alice', 'member', ['employee-a']), member('member-bob', 'member', ['employee-b'])],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [
      { id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true },
      { id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true },
    ],
    connections: [connection('connection-a', 'A'), connection('connection-b', 'B')],
    employees: [
      { id: 'employee-admin', name: '管理员员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
      { id: 'employee-a', name: '员工 A', enabled: true, modelRouteId: 'model-zenmux', connectionIds: ['connection-a'], skillIds: ['skill-gearjob-work-order-read', 'skill-cycle-time-calculate'] },
      { id: 'employee-b', name: '员工 B', enabled: true, modelRouteId: 'model-zenmux', connectionIds: ['connection-b'], skillIds: ['skill-cycle-time-calculate'] },
    ],
  }
}

function catalogTargets() {
  return [
    target('connection-a', 'A'),
    { ...target('connection-a', 'A'), credentialRef: 'connection-a-next.json' },
    target('connection-b', 'B'),
    { ...target('browser-ready', 'browser-ready'), baseUrl: 'http://127.0.0.1', credentialRef: 'browser-ready.json', sourceEnvironment: 'test', evidenceMode: 'controlled' },
  ]
}

async function checkUnavailableCatalog(alice, admin) {
  const unavailableStore = createFileStore(join(root, 'unavailable-catalog.json'))
  await unavailableStore.update(seedState)
  const unavailableService = createWorkService({ store: unavailableStore, runner, connectionCatalog: [] })
  const bootstrap = await unavailableService.bootstrap(alice)
  assert.equal(bootstrap.connections.find(item => item.id === 'connection-a').status, 'unavailable')
  assert.equal((await unavailableService.listConfig(admin, 'connections')).find(item => item.id === 'connection-a').status, 'unavailable')
  const rejected = await unavailableService.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', input: { workOrderId: 'WO-1' } })
  assert.equal(rejected.error.status, 403)
  const cycle = await unavailableService.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 } })
  await waitFor(unavailableService, alice, cycle.value.id, work => work.status === 'completed')
  await unavailableService.close()
}

async function checkSafeExecutionErrors(alice) {
  for (const [code, expected] of [
    ['SOURCE_NOT_CONFIGURED', '连接凭据不可用或连接未配置'],
    ['UPSTREAM_TIMEOUT', '来源读取超时'],
    ['ENOENT', '服务暂时无法完成请求'],
  ]) {
    const errorStore = createFileStore(join(root, `safe-error-${code}.json`))
    await errorStore.update(seedState)
    const errorService = createWorkService({
      store: errorStore,
      runner: { configured: true, async run() { throw Object.assign(new Error(`EACCES /private/${code}`), { code }) }, async close() {} },
    })
    const created = await errorService.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 } })
    const failed = await waitFor(errorService, alice, created.value.id, work => work.status === 'failed')
    assert.deepEqual(failed.executions.at(-1).error, { code: code === 'ENOENT' ? 'INTERNAL_ERROR' : code, message: expected })
    assert.equal(JSON.stringify(failed).includes('/private/'), false)
    await errorService.close()
  }
}

function target(id, instance) {
  return { kind: 'gearjob-rest', targetIdentity: instance, baseUrl: `http://127.0.0.1/${id}`, credentialRef: `${id}.json`, sourceSystem: 'GearJob', sourceInstance: instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' }
}

async function checkCredentialTargetCannotBeRedirected(admin) {
  const received = []
  const capture = createNodeServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: { name: 'WO-1' } }))
  })
  await new Promise(resolve => capture.listen(0, '127.0.0.1', resolve))
  try {
    const captureRoot = join(root, 'capture')
    const captureStore = createFileStore(join(captureRoot, 'state.json'))
    const malicious = { ...seedState({ connections: [] }).connections[0], id: 'connection-evil', name: 'evil', targetIdentity: 'attacker', baseUrl: `http://127.0.0.1:${capture.address().port}`, hostHeader: 'attacker.invalid' }
    await captureStore.update(state => {
      const seeded = seedState(state)
      seeded.connections[0] = { ...malicious, id: 'connection-a', name: 'connection-a' }
      return seeded
    })
    const secretRoot = join(captureRoot, 'secrets')
    await mkdir(secretRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(secretRoot, 'connection-a.json'), JSON.stringify({ authorization: 'token must-not-leak' }), { mode: 0o600 })
    let runs = 0
    const captureService = createWorkService({
      store: captureStore,
      connectionCatalog,
      runner: { configured: true, async run() { runs += 1; throw new Error('must not dispatch') }, async close() {} },
      connectionTester: connection => readGearJobWorkOrder({ workOrderId: 'WO-1', connection, secretRoot }),
    })
    await assert.rejects(captureService.createConfig(admin, 'connections', malicious), error => error.code === 'FORBIDDEN')
    await assert.rejects(captureService.testConnection(admin, 'connection-a'), error => error.code === 'FORBIDDEN')
    const work = await captureService.createWork({ id: 'member-alice' }, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', input: { workOrderId: 'WO-1' } })
    assert.equal(work.error.status, 403)
    assert.equal(runs, 0)
    assert.deepEqual(received, [])
  } finally {
    await new Promise(resolve => capture.close(resolve))
  }
}
