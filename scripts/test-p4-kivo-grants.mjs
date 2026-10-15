import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCapability, KIVO_TPM_RECORD_LIST_CAPABILITY, KIVO_TPM_RECORD_READ_CAPABILITY, validateCapabilityInput, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from '../src/capabilities.mjs'
import { authorizeExecutionGrant, authorizeExecutionRequestFile, connectionInputAllowed, connectionSnapshot, consumeExecutionGrant } from '../src/execution-grant.mjs'

const read = KIVO_TPM_RECORD_READ_CAPABILITY, list = KIVO_TPM_RECORD_LIST_CAPABILITY
const clientId = '00000000-0000-4000-8000-000000000001'
const deviceId = '00000000-0000-4000-8000-000000000002'
const root = await mkdtemp(join(tmpdir(), 'geneway-kivo-grants-'))
let fileIndex = 0
try {
  for (const [capabilityId, input] of [
    [read, { recordType: 'repair', reference: 'R-1' }],
    [read, { recordType: 'plan', reference: deviceId }],
    [list, { recordType: 'repair', filters: {} }],
    [list, { recordType: 'inspection', filters: { deviceId, page: 2, pageSize: 10, status: 'pending' } }],
  ]) {
    const { state, grant } = fixture(capabilityId, input)
    assert.equal(connectionInputAllowed(state.connections[0], capabilityId, input), true)
    assert.equal((await authorize(grant, state)).connection.clientId, clientId)
    const filePath = await grantFile(grant)
    assert.deepEqual(await consumeExecutionGrant({ filePath, toolName: grant.expectedTool, input }), grant)
    await assert.rejects(() => consumeExecutionGrant({ filePath, toolName: grant.expectedTool, input }), { code: 'FORBIDDEN' })
    const requestFile = await grantFile(grant)
    assert.equal((await authorizeExecutionRequestFile({ filePath: requestFile, readState: async () => state })).authorization.connection.baseUrl, grant.connection.baseUrl)
  }

  for (const [input, invocation] of [
    [{ recordType: 'repair', reference: 'R-1' }, { recordType: 'repair', reference: 'R-2' }],
    [{ recordType: 'repair', reference: 'R-1' }, { recordType: 'maintenance', reference: 'R-1' }],
    [{ recordType: 'repair', filters: { page: 1 } }, { recordType: 'repair', filters: { page: 2 } }],
    [{ recordType: 'repair', filters: {} }, { recordType: 'repair', filters: { deviceId } }],
  ]) {
    const capabilityId = 'reference' in input ? read : list
    const { grant } = fixture(capabilityId, input)
    const filePath = await grantFile(grant)
    await assert.rejects(() => consumeExecutionGrant({ filePath, toolName: grant.expectedTool, input: invocation }), { code: 'FORBIDDEN' })
  }
  const base = fixture()
  const wrongToolGrantFile = await grantFile(base.grant)
  await assert.rejects(() => consumeExecutionGrant({ filePath: wrongToolGrantFile, toolName: 'tpm.repair.get', input: base.grant.input }), { code: 'FORBIDDEN' })
  for (const mutate of [
    grant => { grant.expectedTool = getCapability(list).toolName },
    grant => { grant.input = { recordType: 'repair' } },
    grant => { grant.input = { recordType: 'repair', reference: 'R-1', toolName: 'tpm.repair.create' } },
    grant => { grant.capabilityId = 'unknown-capability' },
    grant => { grant.connection.kind = 'gearjob-rest' },
    grant => { grant.connection.allowedObjectIds = ['R-1'] },
    grant => { grant.connection.baseUrl = grant.connection.issuer },
    grant => { grant.connection.clientId = 'unknown-client' },
    grant => { delete grant.connection.issuer },
  ]) {
    const grant = structuredClone(base.grant)
    mutate(grant)
    await assert.rejects(() => authorize(grant, base.state), { code: 'FORBIDDEN' })
  }

  for (const mutate of [
    state => { state.members[0].enabled = false },
    state => { state.members[0].employeeIds = [] },
    state => { state.employees[0].enabled = false },
    state => { state.employees[0].skillIds = [] },
    state => { state.employees[0].connectionIds = [] },
    state => { state.employees[0].modelRouteId = 'other-route' },
    state => { state.skills[0].enabled = false },
    state => { state.skills[0].capabilityId = list },
    state => { state.modelRoutes[0].enabled = false },
    state => { state.works[0].ownerMemberId = 'other-member' },
    state => { state.works[0].status = 'waiting_input' },
    state => { state.works[0].connectionId = 'other-connection' },
    state => { state.works[0].input.reference = 'R-2' },
    state => { delete state.works[0].input.reference },
    state => { state.works[0].executions[0].input.reference = 'R-2' },
    state => { delete state.works[0].executions[0].input },
    state => { state.works[0].executions[0].operation = 'refresh' },
    state => { state.connections[0].enabled = false },
    state => { state.connections[0].status = 'error' },
    state => { state.connections[0].skillIds = [] },
    state => { state.connections[0].revision += 1 },
    state => { state.connections[0].clientId = deviceId },
    state => { state.connections[0].credentialRef = 'rotated-key.pem' },
    state => { state.connections[0].targetIdentity = 'other-instance' },
    state => { state.connections[0].issuer = 'http://127.0.0.1:34382' },
    state => { state.connections[0].baseUrl = 'http://127.0.0.1:34382/api/v1/mes/mcp'; state.connections[0].issuer = 'http://127.0.0.1:34382' },
    state => { state.connections[0].allowedObjectIds = ['R-1'] },
    state => { state.confirmations.push({ id: 'confirmation', ownerMemberId: 'member', employeeId: 'employee', status: 'active', revision: 1 }) },
  ]) {
    const { state, grant } = fixture()
    mutate(state)
    await assert.rejects(() => authorize(grant, state), { code: 'FORBIDDEN' })
  }
  for (const status of ['cancel_requested', 'cancelled']) {
    const { state, grant } = fixture()
    state.works[0].executions[0].status = status
    await assert.rejects(() => authorize(grant, state), { code: 'CANCELLED' })
  }
  for (const operation of ['continue', 'refresh', 'follow-up']) {
    const { state, grant } = fixture()
    grant.operation = state.works[0].executions[0].operation = operation
    assert.equal((await authorize(grant, state)).execution.operation, operation)
  }
  const bound = fixture()
  await authorize(bound.grant, bound.state)
  bound.state.members[0].employeeIds = []
  await assert.rejects(() => authorize(bound.grant, bound.state), { code: 'FORBIDDEN' })
  const changedList = fixture(list, { recordType: 'repair', filters: {} })
  changedList.state.works[0].executions[0].input.filters.page = 2
  await assert.rejects(() => authorize(changedList.grant, changedList.state), { code: 'FORBIDDEN' })
  const incompleteList = fixture(list, { recordType: 'repair', filters: {} })
  delete incompleteList.grant.input.filters
  await assert.rejects(() => authorize(incompleteList.grant, incompleteList.state), { code: 'FORBIDDEN' })

  const { state, grant } = fixture()
  assert.equal(connectionSnapshot(state.connections[0]).issuer, 'http://127.0.0.1:34381')
  assert.equal(connectionSnapshot(state.connections[0]).clientId, clientId)
  for (const change of [
    { kind: 'unknown-kind' }, { allowedObjectIds: ['R-1'] }, { allowedObjectIds: undefined },
    { baseUrl: 'http://127.0.0.1:34381' }, { baseUrl: 'http://127.0.0.1:34381/api/v1/mes' },
    { baseUrl: 'http://127.0.0.1:34381/api/v1/mes/mcp/' }, { baseUrl: 'http://127.0.0.1:34381/api/v1/mes/mcp?resource=other' },
    { issuer: 'http://127.0.0.1:34381/' }, { issuer: 'http://127.0.0.1:34382' }, { clientId: '' },
  ]) assert.throws(() => connectionSnapshot({ ...state.connections[0], ...change }), { code: 'FORBIDDEN' })
  for (const [capabilityId, input] of [[read, {}], [read, { recordType: 'repair' }], [list, { recordType: 'repair' }], [list, { recordType: 'device', filters: {} }], ['unknown', {}], ['toString', {}], ['cycle-time-calculate', { availableSeconds: 3600, quantity: 60 }]]) {
    assert.equal(connectionInputAllowed(state.connections[0], capabilityId, input), false)
  }
  assert.equal(connectionInputAllowed({ ...state.connections[0], kind: 'unknown' }, read, grant.input), false)
  assert.equal(connectionInputAllowed({ ...state.connections[0], allowedObjectIds: ['R-1'] }, read, grant.input), false)
  assert.equal(connectionInputAllowed(state.connections[0], 'gearjob-work-order-read', { workOrderId: 'R-1' }), false)

  const wrongTarget = fixture()
  const b = { ...wrongTarget.state.connections[0], id: 'connection-b', targetIdentity: 'kivo-b', baseUrl: 'http://127.0.0.1:34382/api/v1/mes/mcp', issuer: 'http://127.0.0.1:34382', clientId: deviceId }
  wrongTarget.state.connections.push(b)
  wrongTarget.state.employees[0].connectionIds.push(b.id)
  wrongTarget.grant.connection = connectionSnapshot(b)
  await assert.rejects(() => authorize(wrongTarget.grant, wrongTarget.state), { code: 'FORBIDDEN' })

  const legacy = fixture('gearjob-work-order-read', { workOrderId: 'WO-1' }, legacyConnection())
  assert.equal((await authorize(legacy.grant, legacy.state)).connection.kind, 'gearjob-rest')
  assert.equal(Object.hasOwn(connectionSnapshot(legacy.state.connections[0]), 'issuer'), false)
  assert.equal(connectionInputAllowed(legacy.state.connections[0], legacy.grant.capabilityId, legacy.grant.input), true)
  assert.equal(connectionInputAllowed({ ...legacy.state.connections[0], allowedObjectIds: [] }, legacy.grant.capabilityId, legacy.grant.input), false)
  const emptyLegacy = fixture('gearjob-work-order-read', { workOrderId: 'WO-1' }, legacyConnection([]))
  await assert.rejects(() => authorize(emptyLegacy.grant, emptyLegacy.state), { code: 'FORBIDDEN' })
  legacy.state.automationOccurrences = [{ workId: 'work', ruleId: 'rule' }]
  legacy.state.automationRules = [{ id: 'rule', status: 'active', ownerMemberId: 'member', employeeId: 'employee', skillId: legacy.grant.skillId, connectionId: 'connection', workOrderId: 'WO-1' }]
  assert.equal((await authorize(legacy.grant, legacy.state)).work.id, 'work')
  legacy.state.automationRules[0].status = 'paused'
  await assert.rejects(() => authorize(legacy.grant, legacy.state), { code: 'FORBIDDEN' })
  const autoTpm = fixture()
  autoTpm.state.automationOccurrences = [{ workId: 'work', ruleId: 'rule' }]
  autoTpm.state.automationRules = [{ id: 'rule', status: 'active', ownerMemberId: 'member', employeeId: 'employee', skillId: autoTpm.grant.skillId, connectionId: 'connection' }]
  await assert.rejects(() => authorize(autoTpm.grant, autoTpm.state), { code: 'FORBIDDEN' })

  const cycle = fixture('cycle-time-calculate', { availableSeconds: 3600, quantity: 60 })
  delete cycle.state.works[0].connectionId
  cycle.grant.connection = null
  assert.equal((await authorize(cycle.grant, cycle.state)).execution.id, 'execution')
  cycle.grant.connection = connectionSnapshot(cycle.state.connections[0])
  await assert.rejects(() => authorize(cycle.grant, cycle.state), { code: 'FORBIDDEN' })

  const correlation = fixture(WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, { workOrderId: 'WO-1' }, legacyConnection())
  const hive = { ...legacyConnection(['DEVICE-A']), id: 'hive', kind: 'hive-tenant-records', targetIdentity: deviceId, skillIds: [correlation.grant.skillId] }
  correlation.state.connections.push(hive)
  correlation.state.employees[0].connectionIds.push('hive')
  delete correlation.state.works[0].connectionId
  correlation.state.works[0].connectionIds = { gearJob: 'connection', hive: 'hive' }
  delete correlation.grant.connection
  correlation.grant.connections = { gearJob: connectionSnapshot(correlation.state.connections[0]), hive: connectionSnapshot(hive) }
  correlation.grant.mappingRevision = null
  correlation.grant.mappingIdentity = null
  assert.equal((await authorize(correlation.grant, correlation.state)).connections.hive.id, 'hive')
  for (const ids of [[], ['DEVICE-A', 'DEVICE-B']]) {
    const changed = structuredClone(correlation)
    changed.state.connections[1].allowedObjectIds = ids
    changed.grant.connections.hive = connectionSnapshot(changed.state.connections[1])
    await assert.rejects(() => authorize(changed.grant, changed.state), { code: 'FORBIDDEN' })
  }
  console.log('Kivo TPM grants, current binding/input fences, cancellation and legacy object scopes passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

function fixture(capabilityId = read, input = { recordType: 'repair', reference: 'R-1' }, connection = kivoConnection()) {
  const capability = getCapability(capabilityId)
  const value = { ...connection, skillIds: [capability.skillId] }
  const normalized = validateCapabilityInput(capabilityId, input)
  assert.equal(normalized.ok, true)
  const state = {
    members: [{ id: 'member', enabled: true, employeeIds: ['employee'] }],
    employees: [{ id: 'employee', enabled: true, skillIds: [capability.skillId], modelRouteId: 'route', connectionIds: [value.id] }],
    skills: [{ id: capability.skillId, enabled: true, capabilityId }], modelRoutes: [{ id: 'route', enabled: true }],
    connections: [value], confirmations: [],
    works: [{ id: 'work', ownerMemberId: 'member', employeeId: 'employee', skillId: capability.skillId, capabilityId, connectionId: value.id, status: 'running', input: structuredClone(normalized.input), results: [], executions: [{ id: 'execution', operation: 'create', status: 'running', input: structuredClone(normalized.input) }] }],
  }
  const grant = {
    version: 2, executionId: 'execution', memberId: 'member', employeeId: 'employee', skillId: capability.skillId,
    capabilityId, workId: 'work', modelRouteId: 'route', operation: 'create', expectedTool: capability.toolName,
    input: structuredClone(normalized.input), confirmationFingerprint: 'empty', confirmationRefs: [], connection: connectionSnapshot(value),
    policyRoot: root, policyFile: join(root, 'state.json'), secretRoot: join(root, 'secrets'),
  }
  return { state, grant }
}
function kivoConnection() {
  return { id: 'connection', revision: 1, kind: 'kivo-mcp', targetIdentity: 'kivo-a', baseUrl: 'http://127.0.0.1:34381/api/v1/mes/mcp', issuer: 'http://127.0.0.1:34381', clientId, credentialRef: 'private-key-ref.pem', allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'controlled-a', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain', enabled: true, status: 'ready' }
}
function legacyConnection(allowedObjectIds = ['WO-1']) {
  const value = { ...kivoConnection(), kind: 'gearjob-rest', baseUrl: 'http://127.0.0.1:1', targetIdentity: 'legacy-a', allowedObjectIds, sourceSystem: 'GearJob' }
  delete value.issuer; delete value.clientId
  return value
}
function authorize(grant, state) { return authorizeExecutionGrant(grant, { readState: async () => structuredClone(state) }) }
async function grantFile(grant) { const file = join(root, `grant-${++fileIndex}.json`); await writeFile(file, JSON.stringify(grant), { mode: 0o600 }); return file }
