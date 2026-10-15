import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testKivoTpmConnection } from '../plugins/kivo-tpm.mjs'
import { getCapability, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { readConnectionCatalog } from '../src/connection-catalog.mjs'
import { normalizeTpmObservation, tpmSourcePath, tpmToolRequest } from '../src/domain/tpm.mjs'
import { createObservation } from '../src/domain/work-order.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p2-service-'))
const stateFile = join(root, 'state.json')
const store = createFileStore(stateFile)
const catalogFile = join(root, 'private', 'connections.json')
await mkdir(join(root, 'private'), { mode: 0o700 })
await writeFile(catalogFile, JSON.stringify({ version: 1, targets: catalogTargets() }), { mode: 0o600 })
const connectionCatalog = await readConnectionCatalog(catalogFile, process.cwd())
const conflictingCatalogFile = join(root, 'private', 'conflicting-connections.json')
await writeFile(conflictingCatalogFile, JSON.stringify({ version: 1, targets: [target('connection-a', 'A'), { ...target('connection-b', 'B'), credentialRef: 'connection-a.pem' }] }), { mode: 0o600 })
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
      result: tpmResult(args),
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
  const runtimeModel = readRuntimeConfig({}).model
  const configuredRoute = await service.updateConfig(admin, 'modelRoutes', 'model-zenmux', { provider: runtimeModel.provider, model: runtimeModel.model, displayName: 'ZenMux · DeepSeek V4.1 Flash' })
  assert.equal(configuredRoute.model, 'deepseek/deepseek-v4.1-flash')
  await assert.rejects(service.createConfig(admin, 'modelRoutes', { ...configuredRoute, id: 'legacy-model', model: 'deepseek/deepseek-v4-pro' }), error => error.code === 'INVALID_REQUEST')
  await assert.rejects(service.updateConfig(admin, 'modelRoutes', configuredRoute.id, { model: 'deepseek/deepseek-v4-pro' }), error => error.code === 'INVALID_REQUEST')
  assert.equal((await store.read()).modelRoutes.find(route => route.id === configuredRoute.id).model, runtimeModel.model)

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
  assert.equal(calls[0].sessionMetadata.modelRouteId, configuredRoute.id)
  const callsAfterContinue = calls.length
  const continuedReplay = await service.continueWork(alice, waiting.value.id, { input: { quantity: 999 }, clientRequestId: 'continue' })
  assert.equal(continuedReplay.deduplicated, true)
  assert.equal(continuedReplay.value.status, 'completed')
  assert.equal(continuedReplay.value.executions[0].id, completedCycle.executions[0].id)
  assert.equal(calls.length, callsAfterContinue)
  assert.equal((await service.continueWork(alice, waiting.value.id, { input: { quantity: 60 }, clientRequestId: 'continue-new-key' })).error.status, 409)

  const callsBeforeTpm = calls.length
  const waitingTpm = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: 'connection-a', input: { recordType: 'repair' }, clientRequestId: 'waiting-tpm' })
  assert.equal(waitingTpm.value.status, 'waiting_input')
  assert.deepEqual(waitingTpm.value.requiredInputs, ['reference'])
  assert.equal(waitingTpm.value.executions.length, 0)
  assert.equal(calls.length, callsBeforeTpm)

  const tpm = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', capabilityId: 'kivo-tpm-record-read', connectionId: 'connection-a', input: { recordType: 'repair', reference: 'WO-1' }, clientRequestId: 'tpm' })
  const completedTpm = await waitFor(service, alice, tpm.value.id, work => work.status === 'completed')
  assert.equal(completedTpm.results.length, 1)
  assert.equal(completedTpm.results[0].kind, 'kivo.tpm.observation')
  assert.equal(completedTpm.results[0].payload.records[0].status, 'reported')
  assert.equal(completedTpm.results[0].payload.source.evidenceMode, 'controlled-domain')
  assert.equal(completedTpm.executions[0].resultId, completedTpm.results[0].id)
  assert.equal(calls.length, callsBeforeTpm + 1)
  const persisted = (await store.read()).works.find(item => item.id === tpm.value.id)
  assert.equal('observations' in persisted, false)
  assert.equal('followUps' in persisted, false)
  assert.equal(calls.at(-1).grant.connection.id, 'connection-a')
  assert.equal(calls.at(-1).grant.connection.clientId, '00000000-0000-4000-8000-000000000003')
  assert.equal(calls.at(-1).grant.connection.revision, 1)
  assert.equal(calls.at(-1).sessionMetadata.connectionRevision, 1)
  assert.equal(calls.at(-1).grant.policyFile, stateFile)
  assert.equal(calls.at(-1).sessionMetadata.ownerMemberId, 'member-alice')

  const legacy = (await store.read()).works.find(work => work.id === 'legacy-history')
  const historical = await service.getWork(alice, legacy.id)
  assert.deepEqual(historical.value.results, legacy.results)
  assert.equal(historical.value.observations[0].completion.ratio, 0.4)
  assert.equal(historical.value.observations[0].evidenceMode, 'real-frappe-rest')
  assert.equal(historical.value.executions[0].resultObservationId, legacy.results[0].id)
  assert.equal((await service.getWork(bob, legacy.id)).error.status, 404)
  assert.equal((await service.getWork(admin, legacy.id)).error.status, 404)
  assert.equal((await service.getWork(bob, tpm.value.id)).error.status, 404)
  assert.equal((await service.getWork(admin, tpm.value.id)).error.status, 404)
  const sameBob = await service.createWork(bob, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: 'tpm' })
  assert.notEqual(sameBob.value.id, tpm.value.id)
  await waitFor(service, bob, sameBob.value.id, work => work.status === 'completed')

  const confirmation1 = await service.createConfirmation(alice, { employeeId: 'employee-a', label: '班次', value: '白班' })
  const confirmation2 = await service.updateConfirmation(alice, confirmation1.id, { value: '夜班' })
  assert.equal(confirmation2.revision, 2)
  const confirmedWork = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 300, quantity: 5 }, clientRequestId: 'confirmed-capability' })
  await waitFor(service, alice, confirmedWork.value.id, work => work.status === 'completed')
  assert.deepEqual(calls.find(item => item.sessionMetadata.workId === confirmedWork.value.id).confirmations, [{ id: confirmation1.id, revision: 2, label: '班次', value: '夜班' }])
  const follow = await service.followUp(alice, tpm.value.id, '当前依据是什么？', { clientRequestId: 'follow' })
  assert.equal(follow.ok, true)
  const followed = await waitFor(service, alice, tpm.value.id, work => work.followUps.length === 1)
  assert.deepEqual(followed.results.at(-1).contextConfirmationRefs, [{ id: confirmation1.id, revision: 2 }])
  assert.deepEqual(followed.executions.at(-1).contextConfirmationRefs, [{ id: confirmation1.id, revision: 2 }])
  assert.match(followed.executions.at(-1).confirmationFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(followed.executions.at(-1).resultFollowUpId, followed.results.at(-1).id)
  const followCall = calls.find(item => item.operation === 'follow-up')
  assert.deepEqual(followCall.followUp.confirmations, [{ id: confirmation1.id, revision: 2, label: '班次', value: '夜班' }])
  assert.equal(JSON.stringify(followCall.followUp.facts).includes('说明 kivo-tpm-record-read'), false)
  assert.deepEqual(followCall.followUp.facts, [{ kind: completedTpm.results[0].kind, payload: completedTpm.results[0].payload, source: completedTpm.results[0].source }])
  assert.equal(followCall.sessionId, completedTpm.results[0].dshSessionRef)
  await service.deleteConfirmation(alice, confirmation1.id)
  assert.equal((await service.listConfirmations(alice))[0].status, 'revoked')
  await assert.rejects(
    () => service.updateConfirmation(alice, confirmation1.id, { value: '不可复活' }),
    error => error.code === 'INVALID_REQUEST',
  )
  const refresh = await service.refreshWork(alice, tpm.value.id, { clientRequestId: 'after-revoke' })
  assert.equal(refresh.ok, true)
  await waitFor(service, alice, tpm.value.id, work => work.results.length === 3)
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
  assert.equal((await service.listConfig(admin, 'modelRoutes'))[0].model, 'deepseek/deepseek-v4.1-flash')
  const renamed = await service.updateConfig(admin, 'employees', 'employee-admin', { description: '管理员配置员工', expectedRevision: (await service.listConfig(admin, 'employees')).find(employee => employee.id === 'employee-admin').revision })
  assert.equal(renamed.description, '管理员配置员工')
  const configuredAgent = await service.updateConfig(admin, 'employees', 'employee-a', { instructions: '本次执行保留原指令。', expectedRevision: (await service.listConfig(admin, 'employees')).find(employee => employee.id === 'employee-a').revision })
  const instructionGate = deferred()
  nextGate = instructionGate
  const frozen = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60, quantity: 2 }, clientRequestId: 'instructions-frozen' })
  const frozenExecutionId = frozen.value.executions.at(-1).id
  await waitFor(service, alice, frozen.value.id, work => work.status === 'running' && calls.some(call => call.executionId === frozenExecutionId))
  await service.updateConfig(admin, 'employees', 'employee-a', { instructions: '后续执行采用新指令。', expectedRevision: configuredAgent.revision })
  assert.equal(calls.find(call => call.executionId === frozenExecutionId).agentInstructions, '本次执行保留原指令。')
  instructionGate.release()
  await waitFor(service, alice, frozen.value.id, work => work.status === 'completed')
  const nextDefinition = await service.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60, quantity: 3 }, clientRequestId: 'instructions-updated' })
  await waitFor(service, alice, nextDefinition.value.id, work => work.status === 'completed')
  assert.equal(calls.at(-1).agentInstructions, '后续执行采用新指令。')
  for (const [field, value] of Object.entries({
    targetIdentity: 'other', baseUrl: 'http://127.0.0.1/other', hostHeader: 'other.localhost',
    issuer: 'http://127.0.0.1:8199', clientId: '00000000-0000-4000-8000-000000000099',
    sourceSystem: 'Other', sourceInstance: 'Other', sourceEnvironment: 'production',
    dataMode: 'live', evidenceMode: 'controlled',
  })) await assert.rejects(service.updateConfig(admin, 'connections', 'connection-a', { [field]: value }), /不可原地更换/)
  const beforeRotation = (await service.listConfig(admin, 'connections')).find(item => item.id === 'connection-a')
  const rotated = await service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a-next.pem' })
  assert.equal(rotated.credentialRef, 'connection-a-next.pem')
  assert.equal(rotated.revision, beforeRotation.revision + 1)
  assert.equal(rotated.status, 'unknown')
  await assert.rejects(service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a-next.pem', baseUrl: 'http://127.0.0.1/other' }), /不可原地更换/)
  await service.updateConfig(admin, 'connections', 'connection-a', { credentialRef: 'connection-a.pem' })
  await assert.rejects(service.updateConfig(admin, 'connections', 'connection-a', { allowedObjectIds: ['WO-1', 'WO-2'] }), error => error.code === 'INVALID_REQUEST')
  const mutableConnection = await service.updateConfig(admin, 'connections', 'connection-a', {
    name: 'connection-a-renamed', allowedObjectIds: [], enabled: false, skillIds: [],
  })
  assert.equal(mutableConnection.name, 'connection-a-renamed')
  assert.deepEqual(mutableConnection.allowedObjectIds, [])
  assert.equal(mutableConnection.enabled, false)
  assert.deepEqual(mutableConnection.skillIds, [])
  await service.updateConfig(admin, 'connections', 'connection-a', { name: 'connection-a', allowedObjectIds: [], enabled: true, skillIds: ['skill-kivo-tpm-record-read'] })
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
    service.createConfig(admin, 'connections', { ...target('browser-ready', 'browser-ready'), id: 'bad-secret', name: 'bad', credentialRef: '../secret', allowedObjectIds: [], enabled: true, skillIds: ['skill-kivo-tpm-record-read'] }),
    error => error.code === 'INVALID_REQUEST',
  )
  await assert.rejects(
    service.createConfig(admin, 'connections', { ...target('browser-ready', 'browser-ready'), id: 'long-secret', name: 'long', credentialRef: `a${'.'.repeat(128)}`, allowedObjectIds: [], enabled: true, skillIds: ['skill-kivo-tpm-record-read'] }),
    error => error.code === 'INVALID_REQUEST',
  )
  const browserReady = await service.createConfig(admin, 'connections', { ...target('browser-ready', 'browser-ready'), id: 'browser-ready', name: 'browser-ready', allowedObjectIds: [], enabled: true, status: 'ready', skillIds: ['skill-kivo-tpm-record-read'] })
  assert.equal(browserReady.status, 'unknown')

  const testStarted = deferred()
  const testRelease = deferred()
  const raceService = createWorkService({ store, runner, connectionCatalog, connectionTester: async () => { testStarted.release(); await testRelease.promise; return 'stale' } })
  const staleTest = raceService.testConnection(admin, 'connection-a')
  await testStarted.promise
  await service.updateConfig(admin, 'connections', 'connection-a', { name: 'connection-a-updated' })
  testRelease.release()
  await assert.rejects(staleTest, error => error.code === 'FORBIDDEN')
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
    ['skill', state => { state.skills.find(item => item.id === 'skill-kivo-tpm-record-read').enabled = false }],
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
  const accepted = await service.createWork(actor, { employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: 'connection-a', input: { recordType: 'repair', reference: 'WO-1' }, clientRequestId: `revoke-${label}` })
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
  const connection = (id, instance) => ({ ...target(id, instance), id, name: id, allowedObjectIds: [], enabled: true, status: 'ready', skillIds: ['skill-kivo-tpm-record-read'], revision: 1 })
  return {
    ...state,
    members: [member('member-admin', 'admin', ['employee-admin']), member('member-alice', 'member', ['employee-a']), member('member-bob', 'member', ['employee-b'])],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [
      { id: 'skill-kivo-tpm-record-read', name: 'TPM 工单查询', capabilityId: 'kivo-tpm-record-read', enabled: true },
      { id: 'skill-gearjob-work-order-read', name: '历史工单', capabilityId: 'gearjob-work-order-read', enabled: false },
      { id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true },
    ],
    connections: [connection('connection-a', 'A'), connection('connection-b', 'B'), {
      id: 'legacy-connection', name: '历史 GearJob', kind: 'gearjob-rest', targetIdentity: 'legacy', baseUrl: 'https://legacy.invalid', credentialRef: 'legacy-unavailable.json',
      allowedObjectIds: ['LEGACY-WO'], sourceSystem: 'GearJob', sourceInstance: 'legacy', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest', enabled: false, status: 'disabled', skillIds: ['skill-gearjob-work-order-read'], revision: 1,
    }],
    employees: [
      { id: 'employee-admin', name: '管理员员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
      { id: 'employee-a', name: '员工 A', enabled: true, modelRouteId: 'model-zenmux', connectionIds: ['connection-a'], skillIds: ['skill-kivo-tpm-record-read', 'skill-cycle-time-calculate'] },
      { id: 'employee-b', name: '员工 B', enabled: true, modelRouteId: 'model-zenmux', connectionIds: ['connection-b'], skillIds: ['skill-cycle-time-calculate'] },
    ],
    works: [historicalWorkFixture()],
  }
}

function tpmResult(call) {
  const queriedAt = '2026-10-15T14:00:00.000Z', deviceId = '00000000-0000-4000-8000-000000000001'
  const source = { system: 'kivo', path: tpmSourcePath(tpmToolRequest('record', call.input)), queriedAt, traceId: call.executionId }
  const observation = normalizeTpmObservation({ mode: 'record', input: call.input, connection: call.grant.connection,
    result: { status: 'ok', source, value: { id: '00000000-0000-4000-8000-000000000002', orderNo: call.input.reference, deviceId, status: 'reported', createdAt: queriedAt, updatedAt: queriedAt } },
    deviceResult: { status: 'ok', source: { ...source, path: tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: deviceId })) }, value: { id: deviceId, code: 'D-1', name: '设备', lifecycleStatus: 'active' } },
  })
  return parseCapabilityToolResult(call.capabilityId, { ok: true, observation }, call.input)
}

function historicalWorkFixture() {
  const capability = getCapability('gearjob-work-order-read'), queriedAt = '2026-09-19T00:00:00.000Z'
  const parsed = parseCapabilityToolResult(capability.id, { ok: true, workOrderId: 'LEGACY-WO', status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', sourceTime: queriedAt, sourceRecordId: 'Work Order:LEGACY-WO', sourceRevision: 'legacy-r1', sourceSystem: 'GearJob', sourceInstance: 'legacy', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' }, { workOrderId: 'LEGACY-WO' })
  const payload = { ...createObservation({ source: parsed.payload, queriedAt }), evidenceMode: parsed.payload.evidenceMode }
  const result = { ...parsed, id: payload.observationId, capabilityId: capability.id, skillId: capability.skillId, schemaVersion: 1, input: { workOrderId: 'LEGACY-WO' }, payload, createdAt: queriedAt, dshSessionRef: 'session-legacy-read-only', contextConfirmationRefs: [] }
  return { id: 'legacy-history', ownerMemberId: 'member-alice', employeeId: 'employee-a', skillId: capability.skillId, capabilityId: capability.id, connectionId: 'legacy-connection', input: result.input, goal: '历史工单观察', status: 'completed', requiredInputs: [], acceptedAt: queriedAt, results: [result], actions: [], executions: [{ id: 'legacy-execution', status: 'completed', dshSessionRef: result.dshSessionRef, resultId: result.id, resultObservationId: result.id }] }
}

function catalogTargets() {
  return [
    target('connection-a', 'A'),
    { ...target('connection-a', 'A'), credentialRef: 'connection-a-next.pem' },
    target('connection-b', 'B'),
    target('browser-ready', 'browser-ready'),
  ]
}

async function checkUnavailableCatalog(alice, admin) {
  const unavailableStore = createFileStore(join(root, 'unavailable-catalog.json'))
  await unavailableStore.update(seedState)
  const unavailableService = createWorkService({ store: unavailableStore, runner, connectionCatalog: [] })
  const bootstrap = await unavailableService.bootstrap(alice)
  assert.equal(bootstrap.connections.find(item => item.id === 'connection-a').status, 'unavailable')
  assert.equal((await unavailableService.listConfig(admin, 'connections')).find(item => item.id === 'connection-a').status, 'unavailable')
  const rejected = await unavailableService.createWork(alice, { employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: 'connection-a', input: { recordType: 'repair', reference: 'WO-1' } })
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
  const origin = `http://127.0.0.1:${id === 'connection-a' ? 8101 : id === 'connection-b' ? 8102 : 8103}`
  return { kind: 'kivo-mcp', targetIdentity: instance, baseUrl: `${origin}/api/v1/mes/mcp`, issuer: origin, clientId: `00000000-0000-4000-8000-00000000000${id === 'connection-a' ? '3' : id === 'connection-b' ? '4' : '5'}`, credentialRef: `${id}.pem`, sourceSystem: 'Kivo', sourceInstance: instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' }
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
    const origin = `http://127.0.0.1:${capture.address().port}`
    const malicious = { ...seedState({ connections: [] }).connections[0], id: 'connection-evil', name: 'evil', targetIdentity: 'attacker', baseUrl: `${origin}/api/v1/mes/mcp`, issuer: origin, hostHeader: 'attacker.invalid' }
    await captureStore.update(state => {
      const seeded = seedState(state)
      seeded.connections[0] = { ...malicious, id: 'connection-a', name: 'connection-a' }
      return seeded
    })
    const secretRoot = join(captureRoot, 'secrets')
    await mkdir(secretRoot, { recursive: true, mode: 0o700 })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    await writeFile(join(secretRoot, 'connection-a.pem'), privateKey, { mode: 0o600 })
    let runs = 0, probes = 0
    const captureService = createWorkService({
      store: captureStore,
      connectionCatalog,
      runner: { configured: true, async run() { runs += 1; throw new Error('must not dispatch') }, async close() {} },
      connectionTester: (connection, { authorize }) => { probes += 1; return testKivoTpmConnection({ connection, secretRoot, authorize }) },
    })
    await assert.rejects(captureService.createConfig(admin, 'connections', malicious), error => error.code === 'FORBIDDEN' && /可信目录/.test(error.message))
    await assert.rejects(captureService.testConnection(admin, 'connection-a'), error => error.code === 'FORBIDDEN' && /可信目录/.test(error.message))
    const work = await captureService.createWork({ id: 'member-alice' }, { employeeId: 'employee-a', skillId: 'skill-kivo-tpm-record-read', connectionId: 'connection-a', input: { recordType: 'repair', reference: 'WO-1' } })
    assert.equal(work.error.status, 403)
    assert.equal(runs, 0)
    assert.equal(probes, 0)
    assert.deepEqual(received, [])
  } finally {
    await new Promise(resolve => capture.close(resolve))
  }
}
