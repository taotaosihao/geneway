import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTpmObservation, KIVO_TPM_TOOLS, normalizeTpmInput, normalizeTpmObservation, tpmToolRequest, tpmSourcePath } from '../src/domain/tpm.mjs'
import { assertKivoTpmTools, createKivoTpmTools, KIVO_MCP_SCOPE, KIVO_TPM_SCHEMA_FINGERPRINTS, listKivoTpmRecords, readKivoTpmRecord, schemaFingerprint, testKivoTpmConnection } from '../plugins/kivo-tpm.mjs'

const fixturePath = process.argv[2]
assert.ok(fixturePath, '请显式传入脱敏 tpm-wire-tools.json；本测试不寻找或读取运行凭据')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.sourceCommit, 'c54d38af47c735b039a45bf40eb63b94bf30e337')
const tools = fixture.tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }))
assert.deepEqual([...assertKivoTpmTools(tools).keys()].sort(), Object.keys(KIVO_TPM_SCHEMA_FINGERPRINTS).sort())
for (const tool of fixture.tools) assert.equal(schemaFingerprint(tool), tool.sha256)
for (const variant of [tools.slice(1), [...tools, { ...tools[0], name: 'tpm.repair.create' }], [...tools.slice(1), tools[1]]]) {
  assert.throws(() => assertKivoTpmTools(variant), { code: 'INVALID_SOURCE' })
}
for (const schema of ['inputSchema', 'outputSchema']) {
  const changed = structuredClone(tools)
  changed[0][schema].properties.surprise = { type: 'string' }
  assert.throws(() => assertKivoTpmTools(changed), { code: 'INVALID_SOURCE' })
}

const deviceId = '00000000-0000-4000-8000-000000000001'
const recordId = '00000000-0000-4000-8000-000000000002'
const clientId = '00000000-0000-4000-8000-000000000003'
const now = '2026-10-15T12:00:00.000Z'
const earlier = '2026-10-15T11:00:00.000Z'
const unknownZone = '2026-10-15T11:00:00'
const source = { system: 'kivo', path: '/api/v1/mes/tpm/inspections/I-1', queriedAt: now, traceId: 'test-trace' }
const sourceMetadata = { sourceSystem: 'Kivo', sourceInstance: 'controlled-a', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-mcp' }
const base = { id: recordId, deviceId, status: 'pending', revision: 1, createdAt: earlier }
const values = {
  repair: { ...base, status: 'reported', orderNo: 'R-1', reporterId: null, executorId: null, acceptedById: null, updatedAt: earlier, reopenedFrom: null, detail: { reason: 'synthetic' } },
  maintenance: { ...base, orderNo: 'M-1', device: null, assigneeId: null, assigneeDisplayName: null, acceptedById: null, updatedAt: earlier, detail: {} },
  inspection: { ...base, inspectionNo: 'I-1', occurrenceId: null, blockingExceptionId: null, scheduledAt: earlier },
  exception: { id: recordId, deviceId, exceptionNo: 'E-1', sourceType: 'inspection', sourceId: recordId, severity: 'general', status: 'open', immediateMeasure: null, responsibleId: null, createdAt: earlier },
  plan: { id: recordId, code: 'P-1', name: 'synthetic maintenance', purpose: 'maintenance', deviceId, organizationUnitId: recordId, organizationCode: 'synthetic', active: true, revision: 1, createdAt: earlier, updatedAt: earlier, versions: [], occurrences: [], occurrenceTotal: 0 },
  device: { id: deviceId, code: 'D-1', name: 'synthetic device', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: recordId, organizationName: 'synthetic' },
}
for (const input of [
  { recordType: 'repair', reference: '../x' }, { recordType: 'device', reference: 'x' }, { recordType: 'repair', reference: 'R-1', toolName: 'tpm.repair.create' },
]) assert.equal(normalizeTpmInput('record', input).ok, false)
for (const filters of [{ page: 0 }, { pageSize: 101 }, { page: '1' }, { url: 'http://untrusted' }, { organizationUnitId: recordId }, { status: 'unknown' }]) {
  assert.equal(normalizeTpmInput('list', { recordType: 'repair', filters }).ok, false)
}
assert.deepEqual(normalizeTpmInput('record', { recordType: 'repair' }, { allowMissing: true }), { ok: true, input: { recordType: 'repair' }, missing: ['reference'] })
assert.equal(normalizeTpmInput('list', { recordType: 'plan', filters: { deviceId } }).ok, false)
assert.deepEqual(tpmToolRequest('record', { recordType: 'inspection', reference: 'I-1' }), { name: 'tpm.inspection.get', arguments: { inspectionNo: 'I-1' } })

function observation(record = values.inspection) {
  return normalizeTpmObservation({ mode: 'record', input: { recordType: 'inspection', reference: 'I-1' }, result: { status: 'ok', source, value: record }, deviceResult: { status: 'ok', source, value: values.device }, connection: sourceMetadata })
}
assert.equal(assertTpmObservation(observation()).records[0].schedule.overdue, true)
assert.equal(observation({ ...values.inspection, scheduledAt: null }).records[0].schedule.overdue, null)
assert.equal(observation({ ...values.inspection, scheduledAt: unknownZone }).records[0].schedule.overdue, null)
assert.equal(observation({ ...values.inspection, scheduledAt: '2026-02-30T11:00:00Z' }).records[0].schedule.overdue, null)
assert.equal(observation({ ...values.inspection, status: 'future_status' }).records[0].rawStatus, 'future_status')
assert.equal(observation({ ...values.inspection, status: 'future_status' }).records[0].schedule.overdue, null)
assert.equal(observation({ ...values.inspection, status: 'completed' }).records[0].schedule.overdue, false)
assert.equal(observation({ ...values.inspection, startedAt: unknownZone }).records[0].times.startedAt, unknownZone)
const changedObservation = observation()
changedObservation.records[0].schedule.overdue = false
assert.throws(() => assertTpmObservation(changedObservation), { code: 'INVALID_SOURCE' })
const empty = normalizeTpmObservation({ mode: 'list', input: { recordType: 'repair', filters: {} }, result: { status: 'scope_empty', source, value: null }, connection: sourceMetadata })
assert.equal(assertTpmObservation(empty).status, 'scope_empty')
assert.deepEqual(empty.records, [])
assert.equal(empty.pagination, null)

const secrets = await mkdtemp(join(tmpdir(), 'geneway-kivo-test-'))
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyFile = join(secrets, 'machine.pem')
await writeFile(keyFile, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
const servers = []
try {
  const a = await serve('controlled-a'), b = await serve('controlled-b')
  const options = (server, extra = {}) => ({ connection: server.connection, secretRoot: secrets, traceId: 'test-trace', authorize: async () => { if (!server.authorized) throw Object.assign(new Error('do-not-log-secret'), { code: 'FORBIDDEN' }) }, ...extra })
  assert.equal((await testKivoTpmConnection(options(a))).toolNames.length, 11)
  assert.ok(a.events.some(event => event.path === '/.well-known/oauth-protected-resource/api/v1/mes/mcp'))
  assert.ok(a.events.some(event => event.path === '/.well-known/oauth-authorization-server'))
  assert.ok(a.events.some(event => event.method === 'server/discover'))
  assert.equal(a.events.some(event => event.method === 'initialize' || event.path === '/api/v1/oauth/authorize'), false)

  for (const type of Object.keys(values)) {
    a.reset()
    const reference = type === 'device' ? deviceId : type === 'plan' ? recordId : values[type].orderNo ?? values[type].inspectionNo ?? values[type].exceptionNo
    const result = await readKivoTpmRecord(options(a, { input: { recordType: type, reference } }))
    assert.equal(assertTpmObservation(result).recordType, type)
    assert.equal(result.records[0].reference, reference)
    assert.equal(result.linkedDevice?.id ?? deviceId, deviceId)
    assert.equal(a.calls.length, ['repair', 'maintenance', 'inspection'].includes(type) ? 2 : 1)
  }
  for (const type of ['repair', 'maintenance', 'inspection', 'exception', 'plan']) {
    a.reset()
    const result = await listKivoTpmRecords(options(a, { input: { recordType: type, filters: { pageSize: 20 } } }))
    assert.equal(assertTpmObservation(result).records.length, 1)
    assert.equal(result.pagination.total, 1)
    assert.equal(a.calls[0].name, `tpm.${type}.list`)
  }
  const input = { recordType: 'repair', reference: 'R-1' }
  a.reset(); b.reset(); b.status = 'repairing'
  const [ra, rb] = await Promise.all([readKivoTpmRecord(options(a, { input })), readKivoTpmRecord(options(b, { input }))])
  assert.equal(ra.records[0].rawStatus, 'reported')
  assert.equal(rb.records[0].rawStatus, 'repairing')
  assert.equal(ra.source.sourceInstance, 'controlled-a')
  assert.equal(rb.source.sourceInstance, 'controlled-b')

  a.reset(); a.empty = true
  const emptyResult = await readKivoTpmRecord(options(a, { input }))
  assert.equal(emptyResult.status, 'scope_empty')
  assert.equal(emptyResult.records.length, 0)
  assert.equal(a.calls.length, 1)
  a.reset(); a.noRecords = true
  const noRecords = await listKivoTpmRecords(options(a, { input: { recordType: 'repair', filters: {} } }))
  assert.equal(noRecords.status, 'ok')
  assert.equal(noRecords.pagination.total, 0)

  for (const directory of ['extra', 'missing', 'duplicate', 'input-drift', 'output-drift']) {
    a.reset(); a.directory = directory
    await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
    assert.equal(a.calls.length, 0)
  }
  a.reset(); a.badOutput = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
  a.reset(); a.mismatchedDevice = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
  a.reset(); a.badPath = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
  a.reset(); a.badTrace = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
  a.reset(); a.extraOutput = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'INVALID_SOURCE' })
  a.reset(); a.notFound = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'NOT_FOUND' })
  a.reset(); a.afterCall = () => { a.authorized = false }
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'FORBIDDEN' })
  assert.equal(a.calls.length, 1)
  a.reset(); a.afterCall = () => { a.empty = true }
  const shrunk = await readKivoTpmRecord(options(a, { input }))
  assert.equal(shrunk.status, 'scope_empty')
  assert.equal(shrunk.records.length, 0)
  assert.equal(shrunk.linkedDevice, null)

  a.reset(); a.authorized = false
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'FORBIDDEN' })
  assert.equal(a.events.length, 0)
  a.reset()
  await assert.rejects(() => readKivoTpmRecord(options(a, { input, connection: { ...a.connection, allowedObjectIds: ['R-1'] } })), { code: 'SOURCE_NOT_CONFIGURED' })
  assert.equal(a.events.length, 0)
  await assert.rejects(() => readKivoTpmRecord(options(a, { input, connection: { ...a.connection, kind: 'gearjob-rest' } })), { code: 'SOURCE_NOT_CONFIGURED' })
  assert.equal(a.events.length, 0)
  a.reset(); a.otherIssuer = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })))
  assert.equal(a.events.some(event => event.path === '/api/v1/oauth/token'), false)
  a.reset(); a.parentResource = true
  await assert.rejects(() => testKivoTpmConnection(options(a)), { code: 'FORBIDDEN' })
  assert.equal(a.events.some(event => event.path === '/api/v1/oauth/token'), false)
  for (const changedScope of ['challenge', 'metadata']) {
    a.reset()
    if (changedScope === 'challenge') a.challengeScope = 'tpm.repair.report'
    else a.metadataWriteScope = true
    await assert.rejects(() => testKivoTpmConnection(options(a)), { code: 'FORBIDDEN' })
    assert.equal(a.events.some(event => event.path === '/api/v1/oauth/token'), false)
  }
  a.reset(); a.retryUnauthorized = true; a.retryWriteScope = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'FORBIDDEN' })
  assert.equal(a.events.filter(event => event.path === '/api/v1/oauth/token').length, 1)
  assert.equal(a.calls.length, 0)
  a.reset(); a.extraPermission = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'FORBIDDEN' })
  assert.equal(a.calls.length, 0)
  a.reset(); a.retryUnauthorized = true
  a.afterUnauthorized = () => { a.authorized = false }
  await assert.rejects(() => readKivoTpmRecord(options(a, { input })), { code: 'FORBIDDEN' })
  assert.equal(a.calls.length, 0)

  a.reset(); a.stall = true
  const cancel = new AbortController()
  const cancelled = readKivoTpmRecord(options(a, { input, signal: cancel.signal }))
  await a.stalled
  cancel.abort()
  await assert.rejects(() => cancelled, { code: 'CANCELLED' })
  a.reset(); a.stall = true
  await assert.rejects(() => readKivoTpmRecord(options(a, { input, timeoutMs: 100 })), { code: 'UPSTREAM_TIMEOUT' })

  a.reset()
  const dshTools = createKivoTpmTools({ authorize: async () => ({ connection: a.connection, secretRoot: secrets, executionId: 'test-trace' }) })
  assert.deepEqual(dshTools.map(tool => tool.name), Object.values(KIVO_TPM_TOOLS))
  const response = await dshTools[0].execute(input)
  assert.equal(response.ok, true)
  assert.equal(response.observation.records[0].reference, 'R-1')
  const failed = await createKivoTpmTools({ authorize: async () => { throw Object.assign(new Error('do-not-log-secret'), { code: 'FORBIDDEN' }) } })[0].execute(input)
  assert.equal(failed.error.code, 'FORBIDDEN')
  assert.equal(JSON.stringify(failed).includes('do-not-log-secret'), false)
  assert.equal(JSON.stringify(response).includes('PRIVATE KEY'), false)
  assert.equal(JSON.stringify(response).includes('synthetic-access-token'), false)
  console.log('Kivo TPM normalizer, eleven frozen wire schemas and official SDK controlled HTTP checks passed')
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  await rm(secrets, { recursive: true, force: true })
}

async function serve(instance) {
  let state, stalledResolve
  const reset = () => {
    state.events = []; state.calls = []; state.authorized = true; state.empty = false; state.noRecords = false
    state.directory = null; state.status = null; state.badOutput = false; state.mismatchedDevice = false; state.notFound = false
    state.badPath = false; state.badTrace = false; state.extraOutput = false; state.otherIssuer = false; state.extraPermission = false
    state.parentResource = false; state.challengeScope = null; state.metadataWriteScope = false; state.retryWriteScope = false
    state.afterCall = null; state.retryUnauthorized = false; state.afterUnauthorized = null; state.stall = false
    state.stalled = new Promise(resolve => { stalledResolve = resolve })
  }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, state.issuer).pathname
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const rpc = path === '/api/v1/mes/mcp' ? JSON.parse(raw) : undefined
      state.events.push({ path, method: rpc?.method ?? request.method })
      const send = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)) }
      if (path.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: state.parentResource ? state.issuer : state.connection.baseUrl, authorization_servers: [state.issuer], scopes_supported: [...KIVO_MCP_SCOPE.split(' '), ...(state.metadataWriteScope ? ['tpm.repair.report'] : [])], bearer_methods_supported: ['header'] })
      if (path === '/.well-known/oauth-authorization-server') return send(200, {
        issuer: state.otherIssuer ? 'http://127.0.0.1:1' : state.issuer, authorization_endpoint: `${state.issuer}/api/v1/oauth/authorize`, token_endpoint: `${state.issuer}/api/v1/oauth/token`,
        grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'],
      })
      if (path === '/api/v1/oauth/token') {
        const form = new URLSearchParams(raw), jwt = form.get('client_assertion').split('.')
        const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'))
        assert.equal(form.get('grant_type'), 'client_credentials')
        assert.equal(form.get('resource'), state.connection.baseUrl)
        assert.equal(form.get('scope'), KIVO_MCP_SCOPE)
        assert.equal(claims.sub, clientId)
        assert.equal(claims.aud, state.issuer)
        assert.ok(claims.jti)
        assert.ok(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), keyPair.publicKey, Buffer.from(jwt[2], 'base64url')))
        return send(200, { access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 300, scope: KIVO_MCP_SCOPE })
      }
      assert.equal(path, '/api/v1/mes/mcp')
      assert.equal(request.method, 'POST')
      assert.equal(request.headers['mcp-protocol-version'], '2026-07-28')
      assert.equal(request.headers['mcp-method'], rpc.method)
      assert.equal(request.headers['x-trace-id'], 'test-trace')
      if (request.headers.authorization !== 'Bearer synthetic-access-token' || (state.retryUnauthorized && rpc.method === 'tools/call')) {
        state.afterUnauthorized?.()
        const scope = state.challengeScope ?? (state.retryWriteScope && rpc.method === 'tools/call' ? 'tpm.repair.report' : null)
        return send(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${state.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"${scope ? `, scope="${scope}"` : ''}` })
      }
      const reply = value => send(200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...value } })
      if (state.extraPermission && rpc.method === 'tools/call') return send(403, { error: 'insufficient_scope' }, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="tpm.repair.report"' })
      if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
      if (rpc.method === 'tools/list') {
        const listing = structuredClone(tools)
        if (state.directory === 'extra') listing.push({ ...listing[0], name: 'tpm.repair.create' })
        if (state.directory === 'missing') listing.pop()
        if (state.directory === 'duplicate') listing[0] = listing[1]
        if (state.directory === 'input-drift' || state.directory === 'output-drift') listing[0][state.directory === 'input-drift' ? 'inputSchema' : 'outputSchema'].properties.surprise = { type: 'string' }
        return reply({ tools: listing, ttlMs: 0, cacheScope: 'private' })
      }
      assert.equal(rpc.method, 'tools/call')
      assert.equal(request.headers['mcp-name'], rpc.params.name)
      state.calls.push(rpc.params)
      if (state.stall) { stalledResolve(); return }
      if (state.notFound) return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'not_found', traceId: 'test-trace' }) }] })
      const type = rpc.params.name === 'devices.device.get' ? 'device' : rpc.params.name.split('.')[1]
      const value = structuredClone(values[type])
      if (type === 'repair' && state.status) value.status = state.status
      if (type === 'device' && state.mismatchedDevice) value.id = recordId
      const result = {
        status: state.empty ? 'scope_empty' : 'ok',
        source: { system: 'kivo', path: tpmSourcePath(rpc.params), queriedAt: now, traceId: 'test-trace' },
        value: state.empty ? null : rpc.params.name.endsWith('.list') ? { items: state.noRecords ? [] : [value], page: 1, pageSize: rpc.params.arguments.pageSize ?? 20, total: state.noRecords ? 0 : 1 } : value,
      }
      if (state.badOutput) delete result.value.id
      if (state.badPath) result.source.path = '/api/v1/mes/tpm/repairs/other'
      if (state.badTrace) result.source.traceId = 'other-trace'
      if (state.extraOutput) result.value.privateNewField = 'must-not-reach-model'
      state.afterCall?.()
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }))
    }
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const issuer = `http://127.0.0.1:${server.address().port}`
  state = { issuer, connection: { ...sourceMetadata, sourceInstance: instance, id: instance, revision: 1, kind: 'kivo-mcp', baseUrl: `${issuer}/api/v1/mes/mcp`, issuer, clientId, credentialRef: 'machine.pem', allowedObjectIds: [] }, reset }
  reset()
  return state
}
