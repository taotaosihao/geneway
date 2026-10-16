import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getCapability, KIVO_TPM_DEVICE_CORRELATION_CAPABILITY, parseCapabilityToolResult, validateCapabilityInput } from '../src/capabilities.mjs'
import { assertTpmDeviceCorrelation, correlationAssessment, correlationBusinessFacts, KIVO_TPM_DEVICE_CORRELATION_KIND } from '../src/domain/tpm-device-correlation.mjs'
import { assertKivoTpmTools, correlateKivoTpmDevice, createKivoTpmTools, KIVO_MCP_SCOPE, schemaFingerprint } from '../plugins/kivo-tpm.mjs'
import { authorizeExecutionGrant, connectionInputAllowed, connectionSnapshot } from '../src/execution-grant.mjs'
import { createActionService } from '../src/action-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { authorizeWorkBinding, createWorkService } from '../src/work-service.mjs'
import { connection, correlationFixture, deviceId, recordId, now } from './fixtures/kivo-device-correlation.mjs'

const capability = getCapability(KIVO_TPM_DEVICE_CORRELATION_CAPABILITY)
const payload = correlationFixture()
assert.equal(assertTpmDeviceCorrelation(payload).actionEligible, true)
assert.equal(payload.monitoring.sourceReceivedAt, null)
assert.equal(payload.monitoring.sourceQuality, null)
assert.equal(payload.monitoring.receivedAtMeaning, 'projection')
assert.equal(JSON.stringify(payload).includes('facts'), false)
assert.equal(connectionInputAllowed(connection, capability.id, payload.input), true)
assert.equal(connectionInputAllowed(connection, capability.id, { recordType: 'repair' }), false)
assert.equal(validateCapabilityInput(capability.id, { recordType: 'device', reference: connection.clientId }).ok, false)
assert.deepEqual(validateCapabilityInput(capability.id, { recordType: 'repair' }, { allowMissing: true }).missing, ['reference'])
assert.equal(parseCapabilityToolResult(capability.id, { ok: true, observation: payload }, payload.input).kind, KIVO_TPM_DEVICE_CORRELATION_KIND)
for (const mutate of [p => p.mapping.monitorDeviceId = connection.clientId, p => p.device.code = 'OTHER', p => p.source.sourceInstance = 'OTHER', p => p.tpm.id = 'ambiguous', p => p.freshness.ageSeconds = 42, p => p.actionEligible = false, p => p.monitoring.sourceReceivedAt = now, p => p.monitoring.raw = 'RAW-CANARY', p => p.queriedAt = '2026-02-30T10:00:00.000Z', p => p.tpm.updatedAt = '2026-10-16T24:00:00.000Z']) {
  const p = structuredClone(payload); mutate(p)
  assert.throws(() => parseCapabilityToolResult(capability.id, { ok: true, observation: p }, payload.input), { code: 'TOOL_CHAIN_INVALID' })
}
for (const [sampleAt, expected] of [['2026-10-16T09:58:00.000Z', 'fresh'], ['2026-10-16T09:57:59.999Z', 'stale'], ['2026-10-16T10:00:05.000Z', 'fresh'], ['2026-10-16T10:00:05.001Z', 'future'], [null, 'missing']]) {
  const p = correlationFixture({ sampleAt })
  assert.equal(p.freshness.status, expected)
  assert.equal(p.actionEligible, expected === 'fresh')
}
assert.equal(correlationAssessment(payload, '2026-10-16T10:02:00.001Z').actionEligible, false)
for (const mutate of [p => p.monitoring.connection.status = 'unknown', p => p.monitoring.runtime.status = 'unknown', p => p.monitoring.deviceAlarm.activeCount = null]) {
  const p = structuredClone(payload); mutate(p); Object.assign(p, correlationAssessment(p, p.queriedAt))
  assert.equal(assertTpmDeviceCorrelation(p).actionEligible, false, 'missing machine facts must remain visible but cannot support approval')
}
const later = correlationFixture({ at: '2026-10-16T10:00:01.000Z' })
assert.deepEqual(correlationBusinessFacts(later), correlationBusinessFacts(payload), 'query and projection clock must not create business conflicts')
const changed = correlationFixture({ record: { revision: 2 } })
assert.equal(isDeepStrictEqual(correlationBusinessFacts(changed), correlationBusinessFacts(payload)), false)

const tools = createKivoTpmTools()
assert.equal(tools.length, 3)
assert.equal(tools.some(tool => /create|report/.test(tool.name)), false)
assert.equal(KIVO_MCP_SCOPE.includes('report'), false)
assert.equal(KIVO_MCP_SCOPE.includes('monitor'), false)
const wirePath = process.argv[2]
if (wirePath) {
  const wire = JSON.parse(await readFile(wirePath, 'utf8')), list = Array.isArray(wire) ? wire : wire.tools
  assert.equal(assertKivoTpmTools(list).size, 13)
  assert.equal(schemaFingerprint(list.find(t => t.name === 'tpm.repair.create')), '2d439dd6775e0725289d8f015ecfaac2ec9ff7f1e481f5bcc9914fcf2646750f')
  assert.throws(() => assertKivoTpmTools(list.filter(t => t.name !== 'mes.monitor.current')), { code: 'INVALID_SOURCE' })
  await unmappedMonitoringChecks(list)
}

const input = payload.input
const state = { members: [{ id: 'owner', enabled: true, employeeIds: ['agent'] }], employees: [{ id: 'agent', enabled: true, skillIds: [capability.skillId], connectionIds: ['kivo'], modelRouteId: 'model' }], skills: [{ id: capability.skillId, enabled: true, capabilityId: capability.id }], modelRoutes: [{ id: 'model', enabled: true }], confirmations: [], connections: [connection], automationOccurrences: [], works: [{ id: 'work', ownerMemberId: 'owner', employeeId: 'agent', skillId: capability.skillId, capabilityId: capability.id, connectionId: 'kivo', status: 'running', input, executions: [{ id: 'run', status: 'running', operation: 'create', input }] }] }
const grant = { version: 2, policyFile: '/synthetic/state.json', policyRoot: '/synthetic', secretRoot: '/synthetic/secrets', workId: 'work', executionId: 'run', memberId: 'owner', employeeId: 'agent', skillId: capability.skillId, capabilityId: capability.id, modelRouteId: 'model', operation: 'create', input, expectedTool: capability.toolName, confirmationFingerprint: 'synthetic-empty', confirmationRefs: [], connection: connectionSnapshot(connection) }
await authorizeExecutionGrant(grant, { readState: async () => state })
state.members[0].employeeIds = []
await assert.rejects(authorizeExecutionGrant(grant, { readState: async () => state }), { code: 'FORBIDDEN' })
console.log(JSON.stringify({ ok: true, checks: ['fixed-read-capability', 'minimal-projection', 'same-uuid', 'source-and-time', '120s-5s-boundaries', 'query-clock-excluded', 'model-read-only', 'current-grant'], officialSdkUnmappedStoreAndPreviewChecked: Boolean(wirePath), networkCalls: 0, modelCalls: 0 }))

async function unmappedMonitoringChecks(wire) {
  const root = await mkdtemp(join(tmpdir(), 'geneway-unmapped-pure-')), store = createFileStore(join(root, 'state.json'))
  const actor = { id: 'owner' }, catalog = [connection], traceId = 'synthetic-unmapped', calls = []
  let monitorError, writeCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => assert.fail('unmapped checks may use only the injected in-memory SDK transport')
  try {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
    await writeFile(join(root, connection.credentialRef), key, { mode: 0o600 })
    await store.update(state => ({ ...state,
      members: [{ id: actor.id, loginName: actor.id, displayName: '成员', authRef: actor.id, role: 'member', enabled: true, sessionVersion: 1, employeeIds: ['agent'] }],
      employees: [{ id: 'agent', name: '关联员工', enabled: true, revision: 1, instructions: '', connectionIds: [connection.id], skillIds: [capability.skillId], modelRouteId: 'model' }],
      skills: [{ id: capability.skillId, name: '关联', enabled: true, capabilityId: capability.id }],
      connections: [connection], modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    }))
    const read = authorize => correlateKivoTpmDevice({ input: payload.input, connection, secretRoot: root, traceId, authorize, fetchImpl: fakeFetch })
    const service = createWorkService({ store, connectionCatalog: catalog, clock: () => now, runner: { configured: true, async run({ sessionMetadata }) {
      const observation = await read(async () => authorizeWorkBinding(await store.read(), actor, sessionMetadata.workId, catalog))
      return { explanation: '单据与设备台账已读取；监控尚未映射，采样及运行事实未知。', dshSessionRef: 'synthetic-unmapped-not-native', result: parseCapabilityToolResult(capability.id, { ok: true, observation }, payload.input) }
    } } })
    const accepted = await service.createWork(actor, { employeeId: 'agent', skillId: capability.skillId, capabilityId: capability.id, connectionId: connection.id, goal: '缺监控时保留已授权事实', input: payload.input, clientRequestId: 'unmapped-work' })
    assert.equal(accepted.ok, true)
    let work
    for (let index = 0; index < 400; index += 1) {
      work = (await store.read()).works.find(item => item.id === accepted.value.id)
      if (!['accepted', 'running'].includes(work.status)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(work.status, 'completed', 'legitimate unmapped monitoring must retain the completed partial result')
    const result = work.results.at(-1)
    assert.equal(result.payload.tpm.id, recordId); assert.equal(result.payload.device.id, deviceId)
    assert.deepEqual(result.payload.coverage, { tpm: true, ledger: true, monitoring: false })
    assert.equal(result.payload.monitoring.status, 'unmapped'); assert.equal(result.payload.monitoring.trusted, false)
    assert.equal(result.payload.freshness.status, 'missing'); assert.equal(result.payload.monitoring.sourceQuality, null)
    assert.equal(result.payload.monitoring.sourceReceivedAt, null); assert.equal(result.payload.actionEligible, false)
    assert.deepEqual(calls, ['tpm.repair.get', 'devices.device.get', 'mes.monitor.current'])
    const actions = createActionService({ store, connectionCatalog: catalog, clock: () => now, adapter: { async dispatch() { writeCalls += 1; assert.fail('unmapped facts cannot dispatch a repair') } } })
    await assert.rejects(actions.createPreview(actor, work.id, { reason: '缺少监控证据', description: '不能据未知采样创建维修', clientRequestId: 'unmapped-preview' }), { code: 'REVISION_CONFLICT' })
    assert.equal((await store.read()).works[0].actions.length, 0); assert.equal(writeCalls, 0)
    for (const [code, expected] of [['unauthorized', 'FORBIDDEN'], ['permission_denied', 'FORBIDDEN'], ['not_found', 'NOT_FOUND'], ['upstream_unavailable', 'UPSTREAM_ERROR'], ['invalid_upstream_response', 'INVALID_SOURCE']]) {
      monitorError = code
      await assert.rejects(read(async () => undefined), { code: expected }, 'other upstream failures must not become partial successes')
    }
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }

  async function fakeFetch(request) {
    const url = new URL(request.url), send = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: connection.baseUrl, authorization_servers: [connection.issuer], scopes_supported: [...KIVO_MCP_SCOPE.split(' '), 'mes.monitor.read', 'tpm.repair.report'], bearer_methods_supported: ['header'] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return send({ issuer: connection.issuer, authorization_endpoint: connection.issuer + '/api/v1/oauth/authorize', token_endpoint: connection.issuer + '/api/v1/oauth/token', grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] })
    if (url.pathname === '/api/v1/oauth/token') return send({ access_token: 'synthetic-unmapped-token', token_type: 'Bearer', expires_in: 300, scope: (new URLSearchParams(await request.text())).get('scope') })
    assert.equal(url.href, connection.baseUrl)
    const rpc = await request.json(), reply = value => send({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...value } })
    if (request.headers.get('authorization') !== 'Bearer synthetic-unmapped-token') return send({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${connection.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"` })
    if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
    if (rpc.method === 'tools/list') return reply({ tools: wire, ttlMs: 0, cacheScope: 'private' })
    assert.equal(rpc.method, 'tools/call'); calls.push(rpc.params.name)
    let path, value
    if (rpc.params.name === 'tpm.repair.get') {
      path = '/api/v1/mes/tpm/repairs/R-1'
      value = { id: recordId, deviceId, status: 'reported', revision: 1, createdAt: now, orderNo: 'R-1', reporterId: null, executorId: null, acceptedById: null, updatedAt: now, reopenedFrom: null, detail: { reason: '合成原因' } }
    } else if (rpc.params.name === 'devices.device.get') {
      path = `/api/v1/mes/equipment/ledger/devices/${deviceId}`
      value = { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: recordId, organizationName: '合成组织' }
    } else {
      assert.equal(rpc.params.name, 'mes.monitor.current')
      if (monitorError) return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: monitorError }) }] })
      path = '/api/v1/mes/equipment/monitor/D-1/current'
      value = { deviceId, deviceCode: 'D-1', snapshotAt: now, current: { status: 'unmapped', source: 'external', recordTs: null, freshnessMs: null, trusted: false, snapshot: null, message: 'MES_MONITORING_HIVE_BINDING_REQUIRED' }, receivedAtMeaning: 'projection', sourceReceivedAt: null, sourceQuality: null }
    }
    const result = { status: 'ok', source: { system: 'kivo', path, queriedAt: now, traceId }, value }
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
  }
}
