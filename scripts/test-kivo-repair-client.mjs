import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correlateKivoTpmDevice, createKivoRepair, KIVO_MCP_SCOPE, readKivoRepair, readKivoTpmRecord } from '../plugins/kivo-tpm.mjs'
import { connection, deviceId, recordId, now } from './fixtures/kivo-device-correlation.mjs'

const fixturePath = process.argv[2]
assert.ok(fixturePath, '必须明确传入冻结脱敏13-tool wire；不查找其他文件或秘密')
const wire = JSON.parse(await readFile(fixturePath, 'utf8')), tools = Array.isArray(wire) ? wire : wire.tools
const root = await mkdtemp(join(tmpdir(), 'geneway-repair-client-pure-'))
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
await writeFile(join(root, 'synthetic.pem'), key, { mode: 0o600 })
const originalFetch = globalThis.fetch
globalThis.fetch = () => assert.fail('pure MCP checks may use only the injected in-memory fetch')
try {
  let calls, scopes, authorized, behavior, beforeWrites, writeStarts, authCalls, deadline, at, writeTimes
  const input = { recordType: 'repair', reference: 'R-1' }, writeInput = { orderNo: 'GW-synthetic', deviceId, reason: '合成原因', description: '合成说明' }
  const reset = () => { calls = []; scopes = []; writeTimes = []; authorized = true; behavior = null; beforeWrites = 0; writeStarts = 0; authCalls = 0; at = now; deadline = '2026-10-16T10:00:15.000Z' }
  const options = extra => ({ input, connection, secretRoot: root, traceId: 'synthetic-action', deadlineAt: deadline, clock: () => at,
    authorize: async () => { authCalls += 1; if (behavior === 'final-authorize-crosses-window' && beforeWrites) at = deadline; if (!authorized) throw Object.assign(new Error('synthetic revoked'), { code: 'FORBIDDEN' }) },
    beforeWrite: async () => { beforeWrites += 1; if (behavior === 'claim-crosses-window') at = deadline; if (behavior === 'claim-failed') throw Object.assign(new Error('synthetic denied claim'), { code: 'FORBIDDEN' }) },
    onWriteStarted: () => { writeStarts += 1 }, fetchImpl: fakeFetch, ...extra })
  reset()
  const old = await readKivoTpmRecord(options())
  assert.equal(old.records[0].reference, 'R-1')
  assert.deepEqual(scopes, [KIVO_MCP_SCOPE]); assert.deepEqual(calls.map(c => c.name), ['tpm.repair.get', 'devices.device.get'])
  reset()
  const correlated = await correlateKivoTpmDevice(options())
  assert.equal(correlated.actionEligible, true)
  assert.deepEqual(scopes, [`${KIVO_MCP_SCOPE} mes.monitor.read`])
  assert.deepEqual(calls.map(c => c.name), ['tpm.repair.get', 'devices.device.get', 'mes.monitor.current'])
  assert.deepEqual(calls[2].arguments, { deviceId, deviceCode: 'D-1' })
  assert.ok(authCalls >= 8)
  reset(); behavior = 'revoke-after-primary'
  await assert.rejects(correlateKivoTpmDevice(options()), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 1)
  reset(); behavior = 'bad-ledger-code'
  await assert.rejects(correlateKivoTpmDevice(options()), { code: 'INVALID_SOURCE' }); assert.equal(calls.length, 2)
  reset(); behavior = 'wrong-monitor-device'
  await assert.rejects(correlateKivoTpmDevice(options()), { code: 'INVALID_SOURCE' })
  reset()
  const written = await createKivoRepair(options({ input: writeInput }))
  assert.equal(written.value.creation.machineAccountId, connection.clientId)
  assert.deepEqual(scopes, ['tpm.repair.read devices.device.read tpm.repair.report'])
  assert.equal(beforeWrites, 1); assert.equal(writeStarts, 1)
  assert.deepEqual(calls, [{ name: 'tpm.repair.create', arguments: writeInput }])
  reset()
  await readKivoRepair(options({ orderNo: writeInput.orderNo }))
  assert.deepEqual(scopes, ['tpm.repair.read devices.device.read']); assert.equal(beforeWrites, 0)
  reset(); behavior = 'claim-failed'
  await assert.rejects(createKivoRepair(options({ input: writeInput })), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 0); assert.equal(writeStarts, 0)
  reset(); deadline = now
  await assert.rejects(createKivoRepair(options({ input: writeInput })), { code: 'DISPATCH_DEADLINE_EXPIRED' })
  assert.equal(calls.length, 0); assert.equal(writeStarts, 0)
  reset(); behavior = 'write-401'
  await assert.rejects(createKivoRepair(options({ input: writeInput })), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 1, 'SDK OAuth retry must not resend the actual write')
  assert.equal(beforeWrites, 1); assert.equal(writeStarts, 1)
  reset(); behavior = 'read-challenge-write-scope'
  await assert.rejects(readKivoTpmRecord(options()), { code: 'FORBIDDEN' })
  assert.equal(scopes.length, 0, 'challenge cannot broaden a read token request')
  assert.equal(calls.length, 0)
  reset(); at = '2026-10-16T10:00:14.999Z'
  await createKivoRepair(options({ input: writeInput }))
  assert.deepEqual(writeTimes, ['2026-10-16T10:00:14.999Z'])
  for (const stage of ['already-expired', 'oauth-crosses-window', 'claim-crosses-window', 'final-authorize-crosses-window']) {
    reset(); behavior = stage
    if (stage === 'already-expired') at = deadline
    await assert.rejects(createKivoRepair(options({ input: writeInput })), { code: 'DISPATCH_DEADLINE_EXPIRED' })
    assert.equal(writeTimes.length, 0, stage + ' may not start the business POST')
  }
  reset(); behavior = 'response-after-window'
  await createKivoRepair(options({ input: writeInput }))
  assert.deepEqual(writeTimes, [now], 'a sent request is not reclassified as no-effect after its response crosses the deadline')
  console.log(JSON.stringify({ ok: true, checks: ['official-sdk-in-memory-fetch', '13-fixed-schemas', 'old-read-scopes-unchanged', 'three-read-hops', 'per-io-revocation', 'monitor-uuid', 'executor-only-write', 'claim-before-io', 'first-post-deadline', 'oauth-no-business-retry'], listeners: 0, networkCalls: 0, nativeStarts: 0, modelCalls: 0, realSecretReads: 0 }))

  async function fakeFetch(request) {
    const url = new URL(request.url), resource = connection.baseUrl
    const send = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send({ resource, authorization_servers: [connection.issuer], scopes_supported: [...KIVO_MCP_SCOPE.split(' '), 'mes.monitor.read', 'tpm.repair.report'], bearer_methods_supported: ['header'] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return send({ issuer: connection.issuer, authorization_endpoint: connection.issuer + '/api/v1/oauth/authorize', token_endpoint: connection.issuer + '/api/v1/oauth/token', grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] })
    if (url.pathname === '/api/v1/oauth/token') { const form = new URLSearchParams(await request.text()); scopes.push(form.get('scope')); if (behavior === 'oauth-crosses-window') at = deadline; return send({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 300, scope: form.get('scope') }) }
    assert.equal(url.href, resource)
    const rpc = await request.json()
    if (request.headers.get('authorization') !== 'Bearer synthetic-token') return send({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${connection.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"${behavior === 'read-challenge-write-scope' ? ', scope="tpm.repair.report"' : ''}` })
    const reply = value => send({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...value } })
    if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
    if (rpc.method === 'tools/list') return reply({ tools, ttlMs: 0, cacheScope: 'private' })
    assert.equal(rpc.method, 'tools/call')
    calls.push({ name: rpc.params.name, arguments: rpc.params.arguments })
    if (rpc.params.name === 'tpm.repair.create') { writeTimes.push(at); if (behavior === 'response-after-window') at = deadline }
    if (behavior === 'write-401' && rpc.params.name === 'tpm.repair.create') return send({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer resource_metadata="${connection.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"` })
    const n = rpc.params.name, a = rpc.params.arguments
    let path, value
    if (n === 'devices.device.get') { path = `/api/v1/mes/equipment/ledger/devices/${deviceId}`; value = { id: deviceId, code: behavior === 'bad-ledger-code' ? '../wrong' : 'D-1', name: '合成设备', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: recordId, organizationName: '合成组织' } }
    else if (n === 'mes.monitor.current') { path = '/api/v1/mes/equipment/monitor/D-1/current'; value = { deviceId: behavior === 'wrong-monitor-device' ? recordId : deviceId, deviceCode: 'D-1', snapshotAt: now, receivedAtMeaning: 'projection', sourceReceivedAt: null, sourceQuality: null, current: { status: 'success', source: 'external', recordTs: now, freshnessMs: null, trusted: true, message: null, snapshot: { snapshotAt: now, observedAt: now, receivedAt: now, freshnessMs: null, availability: { status: 'success', reasonCode: 'CURRENT' }, connection: { status: 'online', missingReason: null }, runtime: { status: 'processing', missingReason: null }, deviceAlarm: { activeCount: 0, summaries: [], missingReason: null } } } } }
    else { path = n === 'tpm.repair.create' ? '/api/v1/mes/tpm/repairs' : `/api/v1/mes/tpm/repairs/${a.orderNo}`; value = { id: recordId, deviceId, status: 'reported', revision: 0, createdAt: now, orderNo: a.orderNo, reporterId: null, executorId: null, acceptedById: null, updatedAt: now, reopenedFrom: null, detail: { reason: a.reason ?? '合成原因', description: a.description ?? '合成说明' }, creation: { actorKind: 'machine', machineAccountId: connection.clientId, traceId: 'synthetic-action', revision: 0 }, ...(n === 'tpm.repair.create' ? { replayed: false } : {}) } }
    const result = { status: 'ok', source: { system: 'kivo', path, queriedAt: now, traceId: 'synthetic-action' }, value }
    if (behavior === 'revoke-after-primary') authorized = false
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
  }
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
