import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCapability, parseCapabilityToolResult, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, WORK_ORDER_DEVICE_CORRELATION_TOOL } from '../src/capabilities.mjs'
import { createDshRunner, parseRunResult } from '../src/dsh-runner.mjs'
import { authorizeExecutionGrant, connectionSnapshot, correlationMappingContext } from '../src/execution-grant.mjs'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { readWorkOrderDeviceCorrelation } from '../plugins/work-order-device-correlation.mjs'

const queriedAt = '2026-09-21T10:00:00.000Z'
const tenantId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const secret = 's'.repeat(48)
const root = await mkdtemp(join(tmpdir(), 'geneway-p6-correlation-'))
const secretRoot = join(root, 'secrets')

try {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(secretRoot, { mode: 0o700 }))
  await writeFile(join(secretRoot, 'gear.json'), JSON.stringify({ apiKey: 'gear-key', apiSecret: 'gear-secret', invocationSecret: secret }), { mode: 0o600 })
  await writeFile(join(secretRoot, 'hive.json'), JSON.stringify({ apiKey: 'hive-key', ignoredCanary: 'RAW-CREDENTIAL-CANARY' }), { mode: 0o600 })
  await capabilityAndSourceChecks()
  await authorizationChecks()
  await serviceAndStoreChecks()
  await runnerChecks()
  console.log('Retained correlation checks passed; injected source, dual authorization, strict typed history, retired dispatch blocked')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function capabilityAndSourceChecks() {
  const capability = getCapability(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY)
  assert.equal(capability.skillId, 'skill-manufacturing-work-order-device-correlate')
  assert.equal(capability.toolName, WORK_ORDER_DEVICE_CORRELATION_TOOL)
  assert.equal(capability.pluginId, 'geneway-work-order-device-correlation')
  assert.equal(capability.resultKind, 'manufacturing.work-order-device-correlation')
  assert.deepEqual(capability.requiredInputs, ['workOrderId'])
  assert.equal(capability.retired, true)

  const calls = [], auth = []
  const result = await correlate({ calls, auth })
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'GET'])
  assert.equal(calls.every(call => call.redirect === 'error' && call.body === undefined), true)
  assert.deepEqual(auth, [1, 2, 3])
  assert.match(calls[0].url, /resolve_work_order_mapping\?work_order_ref=WO-1$/)
  assert.match(calls[1].url, new RegExp(`/tenant-integrations/devices\\?tenant_id=${tenantId}$`))
  assert.match(calls[2].url, new RegExp(`/devices/${deviceId}/latest\\?tenant_id=${tenantId}$`))
  assert.equal(calls[0].headers.authorization, 'token gear-key:gear-secret')
  const [encodedClaims, encodedSignature] = calls[0].headers['x-geneway-connector-token'].split('.')
  assert.equal(encodedSignature, createHmac('sha256', secret).update(encodedClaims).digest('base64url'))
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url'))
  assert.equal(claims.aud, 'gearjob-work-order-mapping-connector')
  assert.equal(claims.stepId, 'resolve_work_order_mes_unit')
  assert.equal(claims.connectorQuerySpecHash, createHash('sha256').update('{"operation":"resolve_work_order_mapping","parameters":{"workOrderRef":"WO-1"},"schemaVersion":"gearjob-p6-request/1"}').digest('hex'))
  assert.equal(calls[1].headers['x-api-key'], 'hive-key')
  assert.equal(calls[2].headers['x-api-key'], 'hive-key')
  assert.equal(result.mapping.mesUnitId, 'MES-UNIT-A')
  assert.equal(result.mapping.hiveUnitId, 'DEVICE-CODE-A')
  assert.deepEqual(result.machineFacts, { mode: 'AUTO', machine_state: 'RUNNING', is_alive: true, is_online: true, alarm: false, alarm_code: 0 })
  assert.deepEqual(result.unknowns, ['QUALITY_NOT_PROVIDED', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'])
  assert.deepEqual(result.sample, { ts: '2026-09-21T09:58:00.000Z', platformReceivedAt: null, quality: null })
  assert.equal(result.freshness.ageSeconds, 120)
  assert.equal(JSON.stringify(result).includes('RAW-CANARY'), false)
  assert.equal(JSON.stringify(result).includes('RAW-CREDENTIAL-CANARY'), false)
  assert.equal(JSON.stringify(result).includes('https://'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  const parsed = parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, { ok: true, ...result }, { workOrderId: 'WO-1' })
  assert.equal(parsed.kind, 'manufacturing.work-order-device-correlation')

  for (const mapping of [
    { ...mappingBody(), mappingStatus: 'zero', mappings: [], operationCount: 1 },
    { ...mappingBody(), mappingStatus: 'multiple', mappings: [mappingBody().mappings[0], mappingBody().mappings[0]], operationCount: 1 },
    { ...mappingBody(), workOrderRef: 'WO-OTHER' },
    { ...mappingBody(), sourceRevision: '' },
    { ...mappingBody(), operationCount: 2 },
    { ...mappingBody(), mappings: [{ ...mappingBody().mappings[0], mesUnitId: '' }] },
    { ...mappingBody(), mappings: [{ ...mappingBody().mappings[0], hiveUnitId: '' }] },
  ]) await assert.rejects(correlate({ responses: [mapping] }), error => error.code === 'INVALID_SOURCE')

  for (const devices of [
    { rows: [], count: 0 },
    { rows: [deviceRow(), { ...deviceRow(), device_id: '33333333-3333-4333-8333-333333333333' }], count: 2 },
    { rows: [deviceRow()], count: 2 },
  ]) await assert.rejects(correlate({ responses: [mappingBody(), devices] }), error => error.code === 'INVALID_SOURCE')

  for (const latest of [
    { ...latestBody(), device_id: '33333333-3333-4333-8333-333333333333' },
    { ...latestBody(), tenant_id: '33333333-3333-4333-8333-333333333333' },
    { ...latestBody(), device_code: 'OTHER' },
    { ...latestBody(), record: null },
    { ...latestBody(), record: { ...latestBody().record, ts: '' } },
    { ...latestBody(), record: { ...latestBody().record, status: null } },
    { ...latestBody(), record: { ...latestBody().record, data: [] } },
    { ...latestBody(), record: { ...latestBody().record, record_id: '' } },
    { ...latestBody(), record: { ...latestBody().record, event_id: '' } },
  ]) await assert.rejects(correlate({ responses: [mappingBody(), devicesBody(), latest] }), error => error.code === 'INVALID_SOURCE')

  const futureBoundary = await correlate({ latest: latestBody('2026-09-21T10:00:05.000Z') })
  assert.equal(futureBoundary.freshness.ageSeconds, -5)
  await assert.rejects(correlate({ latest: latestBody('2026-09-21T10:00:05.001Z') }), error => error.code === 'INVALID_SOURCE')
  await assert.rejects(correlate({ latest: latestBody('2026-09-21T09:57:59.999Z') }), error => error.code === 'INVALID_SOURCE')
  const previousTz = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    assert.equal(new Date('2026-09-21 10:54:30.497').toISOString(), '2026-09-21T02:54:30.497Z', 'native parsing demonstrates the eight-hour ambiguity')
    const clock = '2026-09-21T10:54:38.000Z'
    const naiveUtc = await correlate({ clock, latest: latestBody('2026-09-21 10:54:30.497') })
    const explicitUtc = await correlate({ clock, latest: latestBody('2026-09-21T10:54:30.497Z') })
    const explicitOffset = await correlate({ clock, latest: latestBody('2026-09-21T18:54:30.497+08:00') })
    assert.equal(naiveUtc.sample.ts, '2026-09-21T10:54:30.497Z')
    assert.equal(explicitUtc.sample.ts, naiveUtc.sample.ts)
    assert.equal(explicitOffset.sample.ts, naiveUtc.sample.ts)
    assert.equal((await correlate({ clock, latest: latestBody('2026-09-21 10:54:30.4') })).sample.ts, '2026-09-21T10:54:30.400Z')
    assert.equal((await correlate({ clock, latest: latestBody('2026-09-21 10:54:30.497123') })).sample.ts, '2026-09-21T10:54:30.497Z')
    assert.equal((await correlate({ clock, latest: latestBody('2026-09-21 10:52:38.000') })).freshness.ageSeconds, 120)
    assert.equal((await correlate({ clock, latest: latestBody('2026-09-21 10:54:43.000') })).freshness.ageSeconds, -5)
    for (const ts of ['2026-09-21T10:54:30.497', '2026/09/21 10:54:30.497', '2026-09-21 10:54:30', '2026-09-21 10:54:30.497Z', '2026-02-30 10:54:30.497', '2026-09-21T10:54:30.497+24:00']) {
      await assert.rejects(correlate({ clock, latest: latestBody(ts) }), error => error.code === 'INVALID_SOURCE')
    }
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
  const quality = await correlate({ latest: { ...latestBody(), record: { ...latestBody().record, quality: 'good', platform_received_at: '2026-09-21T09:58:01.000Z', platformReceivedAt: 'not-an-instant' } } })
  assert.deepEqual(quality.sample, { ts: '2026-09-21T09:58:00.000Z', platformReceivedAt: null, quality: null })
  assert.deepEqual(quality.unknowns, ['QUALITY_NOT_PROVIDED', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'])
  await assert.rejects(correlate({ latest: { ...latestBody(), record: { ...latestBody().record, quality: 'bad' } } }), error => error.code === 'INVALID_SOURCE')
  const emptyAlarmCode = await correlate({ latest: { ...latestBody(), record: { ...latestBody().record, data: { ...latestBody().record.data, alarm_code: '' } } } })
  assert.equal(emptyAlarmCode.machineFacts.alarm_code, '')
  for (const data of [
    { ...latestBody().record.data, alarm_code: '\u0000' },
    { ...latestBody().record.data, mode: '' },
    { ...latestBody().record.data, mode: 'AUTO\n' },
    { ...latestBody().record.data, alarm_code: [] },
    { ...latestBody().record.data, alarm_code: Number.POSITIVE_INFINITY },
  ]) await assert.rejects(correlate({ latest: { ...latestBody(), record: { ...latestBody().record, data } } }), error => error.code === 'INVALID_SOURCE')
  await assert.rejects(correlate({ latest: { ...latestBody(), record: { ...latestBody().record, data: { mode: { raw: 'RAW-CANARY' } } } } }), error => error.code === 'INVALID_SOURCE' && !error.message.includes('RAW-CANARY'))

  for (const revokeAt of [2, 3]) {
    const raceCalls = []
    await assert.rejects(correlate({ calls: raceCalls, authorize: async count => { if (count === revokeAt) throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }) } }), error => error.code === 'FORBIDDEN')
    assert.equal(raceCalls.length, revokeAt - 1, 'revocation must prevent the next source I/O')
  }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(correlate({ signal: cancelled.signal, calls: [] }), error => error.code === 'CANCELLED')
  await assert.rejects(correlate({ fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) } }), error => error.code === 'UPSTREAM_TIMEOUT')
}

async function authorizationChecks() {
  const state = fixtureState()
  const correlation = correlationGrant(state)
  assert.deepEqual({ mappingRevision: correlation.mappingRevision, mappingIdentity: correlation.mappingIdentity }, { mappingRevision: null, mappingIdentity: null })
  const authorized = await authorizeExecutionGrant(correlation, { readState: async () => structuredClone(state) })
  assert.deepEqual(Object.keys(authorized.connections), ['gearJob', 'hive'])
  assert.equal(Object.hasOwn(correlation, 'connection'), false)
  assert.deepEqual(Object.keys(correlation.connections), ['gearJob', 'hive'])
  const changedGear = structuredClone(state); changedGear.connections[0].revision += 1
  await assert.rejects(authorizeExecutionGrant(correlation, { readState: async () => changedGear }), error => error.code === 'FORBIDDEN')
  const changedHive = structuredClone(state); changedHive.connections[1].revision += 1
  await assert.rejects(authorizeExecutionGrant(correlation, { readState: async () => changedHive }), error => error.code === 'FORBIDDEN')
  const overbroad = structuredClone(state); overbroad.connections[1].allowedObjectIds.push('DEVICE-CODE-B')
  const overbroadGrant = correlationGrant(overbroad)
  await assert.rejects(authorizeExecutionGrant(overbroadGrant, { readState: async () => overbroad }), error => error.code === 'FORBIDDEN')

  const mapped = structuredClone(state)
  mapped.works.find(item => item.id === 'work-correlation').results.push({ kind: 'manufacturing.work-order-device-correlation', payload: successfulResult() })
  const currentGrant = correlationGrant(mapped)
  assert.equal(currentGrant.mappingRevision, successfulResult().gearJob.sourceRevision)
  const staleRevision = { ...currentGrant, mappingRevision: 'modified:2026-09-21T09:56:00.000000Z' }
  await assert.rejects(authorizeExecutionGrant(staleRevision, { readState: async () => mapped }), error => error.code === 'FORBIDDEN' && /mapping/.test(error.message))
  const staleIdentity = { ...currentGrant, mappingIdentity: { ...currentGrant.mappingIdentity, mesUnitId: 'MES-UNIT-CHANGED' } }
  await assert.rejects(authorizeExecutionGrant(staleIdentity, { readState: async () => mapped }), error => error.code === 'FORBIDDEN' && /mapping/.test(error.message))
  for (const stale of [staleRevision, staleIdentity]) {
    const calls = []
    await assert.rejects(correlate({ calls, authorize: () => authorizeExecutionGrant(stale, { readState: async () => mapped }) }), error => error.code === 'FORBIDDEN')
    assert.equal(calls.length, 0, 'stale persisted mapping must block before the first source I/O')
  }

  const old = oldGrant(state)
  const oldAuthorized = await authorizeExecutionGrant(old, { readState: async () => structuredClone(state) })
  assert.equal(oldAuthorized.connection.id, 'connection-gear')
  assert.equal(Object.hasOwn(old, 'connections'), false)
  assert.equal(old.connection.id, 'connection-gear')
}

async function serviceAndStoreChecks() {
  const statePath = join(root, 'state.json')
  const store = createFileStore(statePath)
  const state = fixtureState()
  const historicalWork = state.works.find(work => work.id === 'work-correlation')
  historicalWork.results = [{
    ...parseCapabilityToolResult(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, { ok: true, ...successfulResult() }, historicalWork.input),
    id: 'result-correlation', capabilityId: historicalWork.capabilityId, skillId: historicalWork.skillId, schemaVersion: 1,
    input: historicalWork.input, explanation: '已核对唯一工单设备关联。', createdAt: queriedAt,
    dshSessionRef: 'session-correlation', continuity: 'new', contextConfirmationRefs: [],
  }]
  for (const work of state.works) {
    work.status = 'completed'
    for (const execution of work.executions) Object.assign(execution, { status: 'completed', completedAt: queriedAt })
  }
  Object.assign(historicalWork.executions[0], { resultId: 'result-correlation', dshSessionRef: 'session-correlation', mappingRevision: null, mappingIdentity: null })
  await store.update(() => state)
  const captures = []
  const runner = {
    configured: true,
    async run(options) {
      captures.push(structuredClone(options))
      throw new Error('退休能力不得派发到 runner')
    },
    async close() {},
  }
  const service = createWorkService({ store, runner, clock: () => queriedAt, connectionCatalog: catalog(), policyPaths: { stateFile: statePath, dataRoot: root, secretRoot } })
  const historical = await service.getWork({ id: 'member-a' }, historicalWork.id)
  assert.equal(historical.ok, true)
  assert.deepEqual(historical.value.results, historicalWork.results)
  assert.deepEqual(historical.value.executions, historicalWork.executions)
  assert.deepEqual(historical.value.connectionIds, { gearJob: 'connection-gear', hive: 'connection-hive' })
  assert.equal(Object.hasOwn(historical.value, 'connectionId'), false)
  assert.deepEqual(historical.value.actions, [])
  assert.equal(JSON.stringify(historical.value).includes('RAW-CANARY'), false)
  const before = await store.read()
  const created = await service.createWork({ id: 'member-a' }, { employeeId: 'employee-a', skillId: 'skill-manufacturing-work-order-device-correlate', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive' }, input: { workOrderId: 'WO-1' }, clientRequestId: 'p6-correlation' })
  assert.equal(created.ok, false)
  assert.equal(created.error.code, 'CAPABILITY_RETIRED')
  await assert.rejects(service.refreshWork({ id: 'member-a' }, historicalWork.id, { clientRequestId: 'p6-refresh' }), { code: 'CAPABILITY_RETIRED' })
  await assert.rejects(service.continueWork({ id: 'member-a' }, historicalWork.id, { clientRequestId: 'p6-continue' }), { code: 'CAPABILITY_RETIRED' })
  await assert.rejects(service.followUp({ id: 'member-a' }, historicalWork.id, '解释已有事实', { clientRequestId: 'p6-follow-up' }), { code: 'CAPABILITY_RETIRED' })
  await service.close()

  const saved = await store.read()
  assert.deepEqual(saved, before, '退休拒绝不得新增 work、execution、结果或修改历史')
  assert.deepEqual(captures, [], '退休拒绝必须发生在 runner、模型及来源请求前')
  const savedWork = saved.works.find(work => work.id === historicalWork.id)
  assert.equal(saved.version, STATE_VERSION)
  const replaceSavedWork = candidate => saved.works.map(work => work.id === savedWork.id ? candidate : work)
  assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive', extra: 'x' } }) }), /connectionIds/)
  assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: [{ ...savedWork.results[0], payload: { ...savedWork.results[0].payload, raw: 'RAW-CANARY' } }] }) }), /未声明字段 raw/)
  assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: [{ ...savedWork.results[0], payload: { ...savedWork.results[0].payload, machineFacts: { axes: 'RAW-CANARY' } } }] }) }), /machineFacts/)
  assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: savedWork.results.map((result, index) => index ? result : { ...result, payload: { ...result.payload, sample: { ...result.payload.sample, quality: 'good' }, unknowns: [] } }) }) }), /必须保持 unknown/)
  const withEmptyAlarmCode = { ...savedWork.results[0], payload: { ...savedWork.results[0].payload, machineFacts: { ...savedWork.results[0].payload.machineFacts, alarm_code: '' } } }
  assert.doesNotThrow(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: savedWork.results.map((result, index) => index ? result : withEmptyAlarmCode) }) }))
  const unknownEnum = { ...savedWork.results[0], payload: { ...savedWork.results[0].payload, unknowns: ['UNKNOWN_ENUM', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'] } }
  assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: [unknownEnum] }) }), /unknowns/)
  for (const [key, value] of [['alarm_code', '\u0000'], ['alarm_code', []], ['alarm_code', Number.POSITIVE_INFINITY], ['mode', ''], ['mode', 'AUTO\n']]) {
    const invalid = { ...withEmptyAlarmCode, payload: { ...withEmptyAlarmCode.payload, machineFacts: { ...withEmptyAlarmCode.payload.machineFacts, [key]: value } } }
    assert.throws(() => migrateState({ ...saved, works: replaceSavedWork({ ...savedWork, results: savedWork.results.map((result, index) => index ? result : invalid) }) }), /machineFacts/)
  }
}

async function runnerChecks() {
  const events = runEvents(successfulResult())
  const parsed = parseRunResult({ events, finalResponse: '关联完成' }, { capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, input: { workOrderId: 'WO-1' } })
  assert.equal(parsed.result.kind, 'manufacturing.work-order-device-correlation')
  await assert.rejects(async () => parseRunResult({ events: [...events, events[0]], finalResponse: 'bad' }, { capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, input: { workOrderId: 'WO-1' } }), /恰好有一次/)

  const dshHome = join(root, 'dsh-home'), harnesses = []
  await writeFile(join(secretRoot, 'model.key'), 'synthetic-correlation-model-key', { mode: 0o600 })
  const runner = createDshRunner({
    root: process.cwd(),
    config: { model: { configured: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'model.key', credentialEnv: 'ZENMUX_API_KEY' }, source: { configured: true }, dshHome, stateFile: join(root, 'state.json'), dataRoot: root, secretRoot },
    harnessFactory() {
      harnesses.push('unexpected-harness')
      throw new Error('退休能力不得创建 Harness')
    },
  })
  const base = { executionId: 'exec-runner-1', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, input: { workOrderId: 'WO-1' }, operation: 'create', sessionMetadata: correlationMetadata(1), grant: correlationRunnerGrant(1) }
  await assert.rejects(runner.run(base), { code: 'CAPABILITY_RETIRED' })
  assert.equal(base.sessionMetadata.mappingRevision, null)
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-2', sessionId: 'session-correlation' }), { code: 'CAPABILITY_RETIRED' })
  const mappingA = successfulResult().mapping, revisionA = successfulResult().gearJob.sourceRevision
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-3', sessionId: 'session-correlation', sessionMetadata: correlationMetadata(1, revisionA, mappingA), grant: correlationRunnerGrant(1, revisionA, mappingA) }), { code: 'CAPABILITY_RETIRED' })
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-4', sessionId: 'session-correlation', sessionMetadata: correlationMetadata(1, revisionA, mappingA), grant: correlationRunnerGrant(1, revisionA, mappingA) }), { code: 'CAPABILITY_RETIRED' })
  const mappingB = { ...mappingA, hiveUnitId: 'DEVICE-CODE-B' }
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-5', sessionId: 'session-correlation', sessionMetadata: correlationMetadata(1, revisionA, mappingB), grant: correlationRunnerGrant(1, revisionA, mappingB) }), { code: 'CAPABILITY_RETIRED' })
  const revisionB = 'modified:2026-09-21T09:59:00.000000Z'
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-6', sessionId: 'session-correlation', sessionMetadata: correlationMetadata(1, revisionB, mappingB), grant: correlationRunnerGrant(1, revisionB, mappingB) }), { code: 'CAPABILITY_RETIRED' })
  await assert.rejects(runner.run({ ...base, executionId: 'exec-runner-follow-up', operation: 'follow-up', sessionId: 'session-correlation', question: '解释已有事实' }), { code: 'CAPABILITY_RETIRED' })
  await writeFile(join(secretRoot, 'model.key'), 'synthetic-rotated-correlation-key', { mode: 0o600 })
  const resumed = { ...base, executionId: 'exec-runner-revoked-key', sessionId: 'session-correlation', sessionMetadata: correlationMetadata(1, revisionB, mappingB), grant: correlationRunnerGrant(1, revisionB, mappingB) }
  await assert.rejects(runner.run(resumed), { code: 'CAPABILITY_RETIRED' })
  await rm(join(secretRoot, 'model.key'))
  await assert.rejects(runner.run({ ...resumed, executionId: 'exec-runner-missing-key' }), { code: 'CAPABILITY_RETIRED' })
  await runner.close()
  assert.deepEqual(harnesses, [])
  await assert.rejects(access(dshHome), { code: 'ENOENT' })
}

async function correlate(options = {}) {
  const calls = options.calls ?? []
  let authorizationCount = 0
  const responses = options.responses ?? [mappingBody(), devicesBody(), options.latest ?? latestBody()]
  let index = 0
  const fetchImpl = options.fetchImpl ?? (async (url, init) => {
    calls.push({ url: String(url), ...init })
    const body = responses[index++]
    return { ok: true, status: 200, async json() { return structuredClone(body) } }
  })
  return readWorkOrderDeviceCorrelation({
    workOrderId: 'WO-1', connections: correlationConnections(1), secretRoot, signal: options.signal,
    clock: () => new Date(options.clock ?? queriedAt), fetchImpl,
    authorize: async () => { authorizationCount += 1; (options.auth ?? []).push(authorizationCount); await options.authorize?.(authorizationCount) },
  })
}

function mappingBody() { return { workOrderRef: 'WO-1', sourceRevision: 'modified:2026-09-21T09:57:00.000000Z', mappingStatus: 'unique', operationCount: 1, workstationCount: 1, mappings: [{ operation: 'OP-A', workstation: 'WS-A', mesUnitId: 'MES-UNIT-A', hiveUnitId: 'DEVICE-CODE-A' }], unmapped: [] } }
function deviceRow() { return { device_id: deviceId, device_code: 'DEVICE-CODE-A', device_name: 'Device A', is_online: true } }
function devicesBody() { return { rows: [deviceRow()], count: 1 } }
function latestBody(ts = '2026-09-21T09:58:00.000Z') { return { tenant_id: tenantId, device_id: deviceId, device_code: 'DEVICE-CODE-A', device_name: 'Device A', record: { ts, status: 1, data: { mode: 'AUTO', machine_state: 'RUNNING', is_alive: true, is_online: true, alarm: false, alarm_code: 0, axes: ['RAW-CANARY'], program: 'RAW-CANARY', count: 99, feed: 100, raw: { secret: 'RAW-CANARY' }, nested: { raw: 'RAW-CANARY' } }, record_id: 'record-a', event_id: 'event-a' } } }

function gearConnection(revision = 1) { return { id: 'connection-gear', name: 'GearJob', revision, kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', credentialRef: 'gear.json', allowedObjectIds: ['WO-1'], sourceSystem: 'GearJob', sourceInstance: 'gearjob-test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', enabled: true, status: 'ready', skillIds: ['skill-manufacturing-work-order-device-correlate', 'skill-gearjob-work-order-read'], updatedAt: queriedAt } }
function hiveConnection(revision = 1) { return { id: 'connection-hive', name: 'Hive', revision, kind: 'hive-tenant-records', targetIdentity: tenantId, baseUrl: 'https://hive.test', credentialRef: 'hive.json', allowedObjectIds: ['DEVICE-CODE-A'], sourceSystem: 'Hive', sourceInstance: 'hive-test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', enabled: true, status: 'ready', skillIds: ['skill-manufacturing-work-order-device-correlate'], updatedAt: queriedAt } }
function correlationConnections(revision) { return { gearJob: connectionSnapshot(gearConnection(revision)), hive: connectionSnapshot(hiveConnection(revision)) } }
function catalog() { return [gearConnection(), hiveConnection()].map(({ name, revision, allowedObjectIds, enabled, status, skillIds, updatedAt, ...item }) => item) }

function successfulResult() {
  return {
    workOrderId: 'WO-1', queriedAt,
    connections: { gearJob: { id: 'connection-gear', revision: 1 }, hive: { id: 'connection-hive', revision: 1 } },
    gearJob: { sourceSystem: 'GearJob', sourceInstance: 'gearjob-test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', sourceRevision: 'modified:2026-09-21T09:57:00.000000Z', queriedAt },
    hive: { sourceSystem: 'Hive', sourceInstance: 'hive-test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-api', sourceRevision: 'record-a', queriedAt },
    mapping: { operation: 'OP-A', workstation: 'WS-A', mesUnitId: 'MES-UNIT-A', hiveUnitId: 'DEVICE-CODE-A' }, tenant: { id: tenantId }, device: { id: deviceId, code: 'DEVICE-CODE-A' },
    sample: { ts: '2026-09-21T09:58:00.000Z', platformReceivedAt: null, quality: null }, status: 1, recordId: 'record-a', eventId: 'event-a', freshness: { ageSeconds: 120, maxAgeSeconds: 120, maxFutureSkewSeconds: 5 }, machineFacts: { mode: 'AUTO' }, unknowns: ['QUALITY_NOT_PROVIDED', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'],
  }
}

function fixtureState() {
  return migrateState({
    version: 8,
    members: [{ id: 'member-a', loginName: 'member', displayName: 'Member', role: 'member', enabled: true, authRef: 'member-a', sessionVersion: 1, employeeIds: ['employee-a'], createdAt: queriedAt, updatedAt: queriedAt }],
    modelRoutes: [{ id: 'route-a', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-a', name: 'Employee', description: '', enabled: true, modelRouteId: 'route-a', connectionIds: ['connection-gear', 'connection-hive'], skillIds: ['skill-manufacturing-work-order-device-correlate', 'skill-gearjob-work-order-read'] }],
    connections: [gearConnection(), hiveConnection()],
    skills: [{ id: 'skill-manufacturing-work-order-device-correlate', name: '关联', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, enabled: true }, { id: 'skill-gearjob-work-order-read', name: '工单', capabilityId: 'gearjob-work-order-read', enabled: true }],
    confirmations: [], knowledgeMaterials: [], channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [], automationRules: [], automationOccurrences: [],
    works: [correlationWork(), oldWork()], reservations: {},
  })
}
function correlationWork() { return { id: 'work-correlation', ownerMemberId: 'member-a', employeeId: 'employee-a', skillId: 'skill-manufacturing-work-order-device-correlate', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive' }, goal: 'correlate', input: { workOrderId: 'WO-1' }, requiredInputs: [], status: 'running', acceptedAt: queriedAt, results: [], actions: [], executions: [{ id: 'exec-correlation', operation: 'create', clientRequestId: 'request-correlation', input: { workOrderId: 'WO-1' }, status: 'running', acceptedAt: queriedAt }] } }
function oldWork() { return { id: 'work-old', ownerMemberId: 'member-a', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-gear', goal: 'read', input: { workOrderId: 'WO-1' }, requiredInputs: [], status: 'running', acceptedAt: queriedAt, results: [], actions: [], executions: [{ id: 'exec-old', operation: 'create', clientRequestId: 'request-old', input: { workOrderId: 'WO-1' }, status: 'running', acceptedAt: queriedAt }] } }
function grantBase(work, execution) { return { version: 2, executionId: execution.id, memberId: 'member-a', employeeId: 'employee-a', skillId: work.skillId, capabilityId: work.capabilityId, workId: work.id, modelRouteId: 'route-a', operation: execution.operation, expectedTool: getCapability(work.capabilityId).toolName, input: work.input, confirmationFingerprint: 'empty', confirmationRefs: [], policyFile: join(root, 'state.json'), policyRoot: root, secretRoot } }
function correlationGrant(state) { const work = state.works.find(item => item.id === 'work-correlation'); return { ...grantBase(work, work.executions[0]), connections: { gearJob: connectionSnapshot(state.connections[0]), hive: connectionSnapshot(state.connections[1]) }, ...correlationMappingContext(work) } }
function oldGrant(state) { const work = state.works.find(item => item.id === 'work-old'); return { ...grantBase(work, work.executions[0]), connection: connectionSnapshot(state.connections[0]) } }
function correlationMetadata(revision, mappingRevision = null, mappingIdentity = null) { return { ownerMemberId: 'member-a', workId: 'work-correlation', employeeId: 'employee-a', skillId: 'skill-manufacturing-work-order-device-correlate', capabilityId: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, modelRouteId: 'route-a', confirmationFingerprint: 'empty', confirmationRefs: [], connectionIds: { gearJob: 'connection-gear', hive: 'connection-hive' }, connectionRevisions: { gearJob: revision, hive: revision }, mappingRevision, mappingIdentity } }
function correlationRunnerGrant(revision, mappingRevision = null, mappingIdentity = null) { return { connections: correlationConnections(revision), mappingRevision, mappingIdentity, policyFile: join(root, 'state.json'), policyRoot: root, secretRoot } }
function runEvents(result) { const callId = 'call-correlation'; return [{ type: 'tool/call', data: { name: WORK_ORDER_DEVICE_CORRELATION_TOOL, callId, arguments: JSON.stringify({ workOrderId: 'WO-1' }) } }, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, isError: false, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }) }] } } }] }
