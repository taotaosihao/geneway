import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCapability, parseCapabilityToolResult, sanitizeFollowUpContext } from '../src/capabilities.mjs'
import { readConnectionCatalog } from '../src/connection-catalog.mjs'
import { normalizeTpmObservation, tpmSourcePath, tpmToolRequest } from '../src/domain/tpm.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-kivo-work-')), actor = { id: 'owner' }, admin = { id: 'admin' }
const read = 'kivo-tpm-record-read', list = 'kivo-tpm-record-list'
const now = '2026-10-15T14:00:00.000Z', queriedAt = '2026-10-15T13:59:00.000Z'
const deviceId = '00000000-0000-4000-8000-000000000001', recordId = '00000000-0000-4000-8000-000000000002'
const connectionA = connection('a', 41001), connectionB = connection('b', 41002)
const targets = [target(connectionA), target(connectionB), { ...target(connectionA), credentialRef: 'machine-a-rotated.pem' }]
const catalogFile = join(temp, 'targets.json'), stateFile = join(temp, 'state.json')
const calls = [], store = createFileStore(stateFile)
let service, tester, beforeReply, revision = 1, scopeEmpty = false, noRecords = false
try {
  await writeFile(catalogFile, JSON.stringify({ version: 1, targets }), { mode: 0o600 })
  const catalog = await readConnectionCatalog(catalogFile, process.cwd())
  for (const change of [{ clientId: 'bad' }, { issuer: 'http://127.0.0.1:41002' }, { baseUrl: `${connectionA.baseUrl}/` }, { baseUrl: connectionA.issuer }, { baseUrl: `${connectionA.baseUrl}?extra=1` }]) {
    const path = join(temp, 'bad.json')
    await writeFile(path, JSON.stringify({ version: 1, targets: [{ ...target(connectionA), ...change }] }), { mode: 0o600 })
    await assert.rejects(readConnectionCatalog(path, process.cwd()))
  }
  await store.update(state => ({ ...state,
    members: [member('owner', 'member'), member('admin', 'admin'), { ...member('peer', 'member'), employeeIds: ['agent-b'] }],
    employees: ['a', 'b'].map(id => ({ id: `agent-${id}`, name: id, enabled: true, modelRouteId: 'model', revision: 1, instructions: '', skillIds: [`skill-${read}`, `skill-${list}`], connectionIds: [id] })),
    modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    skills: [read, list].map(id => ({ id: `skill-${id}`, name: id, capabilityId: id, enabled: true })), connections: [connectionA, connectionB],
  }))
  const runner = { configured: true, async run(options) {
    calls.push(structuredClone(options))
    const common = { explanation: '受控 TPM 依据', dshSessionRef: options.sessionId ?? `synthetic-native-${calls.length}`, contextConfirmationRefs: options.sessionMetadata.confirmationRefs, continuity: options.sessionId ? 'same-session' : 'new' }
    if (options.operation === 'follow-up') { sanitizeFollowUpContext(options.followUp); await beforeReply?.(); return common }
    const observation = observe(options.capabilityId, options.input, options.grant.connection)
    await beforeReply?.()
    return { ...common, result: parseCapabilityToolResult(options.capabilityId, { ok: true, observation }, options.input) }
  }, async cancel() { return true }, async close() {} }
  service = createWorkService({ store, runner, connectionCatalog: catalog, clock: () => now, connectionTester: (...args) => tester(...args) })

  const partial = await service.createWork(actor, body('a', read, { recordType: 'repair' }, 'partial'))
  assert.equal(partial.value.status, 'waiting_input')
  assert.deepEqual(partial.value.requiredInputs, ['reference'])
  assert.equal(calls.length, 0)
  const completed = await service.continueWork(actor, partial.value.id, { input: { reference: 'R-1' }, clientRequestId: 'complete-input' })
  const first = await waitWork(completed.value.id)
  assert.equal(first.retired, false)
  assert.equal(first.results[0].kind, 'kivo.tpm.observation')
  assert.equal(first.results[0].createdAt, queriedAt)
  assert.equal(first.results[0].payload.linkedDevice.id, deviceId)
  assert.equal(first.results[0].payload.records[0].schedule.overdue, null)
  assert.equal(first.results[0].payload.records[0].schedule.reason, 'no_plan_baseline')
  const oldResult = structuredClone(first.results[0])
  await service.followUp(actor, first.id, '当前依据是什么？', { clientRequestId: 'follow' })
  await waitWork(first.id, 2)
  assert.deepEqual(calls.at(-1).followUp.facts, [{ kind: oldResult.kind, payload: oldResult.payload, source: oldResult.source }])
  assert.equal(JSON.stringify(calls.at(-1).followUp).includes('受控 TPM 依据'), false)
  revision = 2
  await service.refreshWork(actor, first.id, { clientRequestId: 'latest' })
  const latest = await waitWork(first.id, 3)
  assert.deepEqual(latest.results[0], oldResult)
  assert.equal(latest.results[2].payload.records[0].facts.revision, 2)
  const denied = await service.createWork({ id: 'peer' }, body('a', read, { recordType: 'repair', reference: 'R-1' }, 'forbidden-2'))
  assert.equal(denied.error.code, 'FORBIDDEN')

  const second = await service.createWork(actor, body('b', read, { recordType: 'repair', reference: 'R-1' }, 'instance-b'))
  const b = await waitWork(second.value.id)
  assert.equal(b.results[0].source.sourceInstance, 'b')
  assert.equal(latest.results[2].source.sourceInstance, 'a')
  noRecords = true
  const normalZero = await service.createWork(actor, body('a', list, { recordType: 'repair' }, 'zero'))
  const zero = await waitWork(normalZero.value.id)
  assert.deepEqual(zero.input, { recordType: 'repair', filters: {} })
  assert.equal(zero.results[0].payload.status, 'ok')
  assert.equal(zero.results[0].payload.pagination.total, 0)
  scopeEmpty = true
  const emptyScope = await service.createWork(actor, body('a', list, { recordType: 'repair', filters: {} }, 'scope-empty'))
  const empty = await waitWork(emptyScope.value.id)
  assert.equal(empty.results[0].payload.status, 'scope_empty')
  assert.equal(empty.results[0].payload.pagination, null)
  scopeEmpty = false; noRecords = false

  beforeReply = async () => { await store.update(state => ({ ...state, employees: state.employees.map(item => item.id === 'agent-a' ? { ...item, enabled: false } : item) })) }
  const revokedBeforeCommit = await service.createWork(actor, body('a', read, { recordType: 'repair', reference: 'R-1' }, 'revoked-before-commit'))
  await waitTerminal(revokedBeforeCommit.value.id)
  const rejectedCommit = (await service.getWork(actor, revokedBeforeCommit.value.id)).value
  assert.equal(rejectedCommit.status, 'failed', 'revocation after the source/model reply must still block the atomic result commit')
  assert.equal(rejectedCommit.executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(rejectedCommit.results.length, 0)
  beforeReply = undefined
  await store.update(state => ({ ...state, employees: state.employees.map(item => ({ ...item, enabled: true })) }))
  const previousResults = (await service.getWork(actor, first.id)).value.results.length
  beforeReply = async () => { await store.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'a' ? { ...item, revision: item.revision + 1 } : item) })) }
  await service.followUp(actor, first.id, '迟到追问也不得提交', { clientRequestId: 'follow-revoked-before-commit' })
  await waitTerminal(first.id)
  const rejectedFollowUp = (await service.getWork(actor, first.id)).value
  assert.equal(rejectedFollowUp.status, 'failed')
  assert.equal(rejectedFollowUp.executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(rejectedFollowUp.results.length, previousResults)
  beforeReply = undefined

  const beforeTamper = await readFile(stateFile)
  for (const mutate of [
    state => { state.works[0].results[0].payload.records[0].statusLabel = '模型猜测' },
    state => { state.works[0].results[0].source.sourceInstance = 'b' },
    state => { state.works[0].results[0].createdAt = now },
    state => { state.connections[0].allowedObjectIds = ['R-1'] },
  ]) { await assert.rejects(store.update(state => { mutate(state); return state })); assert.deepEqual(await readFile(stateFile), beforeTamper) }

  const created = await service.createConfig(admin, 'connections', { ...connectionA, id: 'new-a', status: undefined })
  assert.equal(created.status, 'unknown')
  await assert.rejects(service.updateConfig(admin, 'connections', 'new-a', { clientId: '00000000-0000-4000-8000-000000000099' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(service.updateConfig(admin, 'connections', 'new-a', { allowedObjectIds: ['R-1'] }), { code: 'INVALID_REQUEST' })
  const rotated = await service.updateConfig(admin, 'connections', 'new-a', { credentialRef: 'machine-a-rotated.pem' })
  assert.equal(rotated.revision, 2)
  assert.equal(rotated.clientId, connectionA.clientId)
  assert.equal(rotated.status, 'unknown')
  let io = 0
  tester = async (connection, { authorize }) => { assert.equal(connection.status, 'unknown'); await authorize(); io += 1; return 'MCP 2026-07-28 · 11项固定只读工具' }
  assert.equal((await service.testConnection(admin, 'new-a')).ok, true)
  assert.equal(io, 1)
  await service.updateConfig(admin, 'connections', 'new-a', { name: 'test revoked admin' })
  tester = async (_connection, { authorize }) => {
    await authorize(); io += 1
    await store.update(state => ({ ...state, members: state.members.map(item => item.id === admin.id ? { ...item, role: 'member' } : item) }))
    await authorize(); io += 1
    return 'must not become ready'
  }
  await assert.rejects(service.testConnection(admin, 'new-a'), { code: 'FORBIDDEN' })
  assert.equal(io, 2, 'admin revocation must block the next simulated I/O')
  assert.notEqual((await store.read()).connections.find(item => item.id === 'new-a').status, 'ready')
  console.log('Kivo product work checks passed: trusted machine identity, partial admission/full dispatch, typed persistence/follow-up/latest, two instances, zero vs scope_empty and per-I/O admin revocation (injected model; no network/native/secrets)')
} finally { await service?.close(); await rm(temp, { recursive: true, force: true }) }

function member(id, role) { return { id, role, loginName: id, displayName: id, authRef: id, enabled: true, sessionVersion: 1, employeeIds: ['agent-a', 'agent-b'] } }
function connection(id, port) { return { id, name: id, revision: 1, kind: 'kivo-mcp', targetIdentity: `instance-${id}`, baseUrl: `http://127.0.0.1:${port}/api/v1/mes/mcp`, issuer: `http://127.0.0.1:${port}`, clientId: `00000000-0000-4000-8000-00000000000${id === 'a' ? '3' : '4'}`, credentialRef: `machine-${id}.pem`, allowedObjectIds: [], enabled: true, status: 'ready', skillIds: [`skill-${read}`, `skill-${list}`], sourceSystem: 'Kivo', sourceInstance: id, sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' } }
function target(value) { return Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, value[key]])) }
function body(id, capabilityId, input, clientRequestId) { return { employeeId: `agent-${id}`, skillId: getCapability(capabilityId).skillId, connectionId: id, input, clientRequestId } }
function observe(capabilityId, input, connection) {
  const mode = capabilityId === read ? 'record' : 'list', request = tpmToolRequest(mode, input)
  const device = { id: deviceId, code: 'D-1', name: 'synthetic device', lifecycleStatus: 'active' }
  const record = { id: recordId, orderNo: input.reference ?? 'R-1', deviceId, status: 'reported', revision, createdAt: queriedAt, updatedAt: queriedAt }
  const source = { system: 'kivo', path: tpmSourcePath(request), queriedAt, traceId: 'synthetic-trace' }
  return normalizeTpmObservation({ mode, input, connection,
    result: { status: scopeEmpty ? 'scope_empty' : 'ok', source, value: scopeEmpty ? null : mode === 'record' ? record : { page: input.filters.page ?? 1, pageSize: input.filters.pageSize ?? 20, total: noRecords ? 0 : 1, items: noRecords ? [] : [record] } },
    ...(mode === 'record' ? { deviceResult: { status: scopeEmpty ? 'scope_empty' : 'ok', source: { ...source, path: tpmSourcePath(tpmToolRequest('record', { recordType: 'device', reference: deviceId })) }, value: scopeEmpty ? null : device } } : {}),
  })
}
async function waitWork(id, results = 1) {
  for (let count = 0; count < 200; count += 1) { const value = (await service.getWork(actor, id)).value; if (value.status === 'failed') throw new Error(JSON.stringify(value.executions.at(-1).error)); if (value.status === 'completed' && value.results.length === results) return value; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('injected Kivo work did not complete')
}
async function waitTerminal(id) {
  for (let count = 0; count < 200; count += 1) { const value = (await service.getWork(actor, id)).value; if (['completed', 'failed', 'cancelled'].includes(value.status)) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('injected Kivo work did not settle')
}
