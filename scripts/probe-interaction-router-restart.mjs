import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { fork } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-router-restart-'), apiRoot = join(directory, 'api'), captures = [], children = [], logs = []
let provider, origin, session, store, upstreamClosed = false, received
const upstreamReceived = new Promise(resolve => { received = resolve })
try {
  await mkdir(apiRoot); store = createFileStore(join(apiRoot, 'state.json'))
  const original = JSON.parse(await readFile('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-CWwNtz/state.json', 'utf8'))
  await store.update(() => structuredClone(original)); await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-routing-restart', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.headers.authorization, 'Bearer synthetic-routing-restart'); assert.deepEqual(body.tools, []); captures.push(body)
    response.once('close', () => { upstreamClosed = true }); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"{\\\"action\\\":"},"finish_reason":null}]}\n\n'); received()
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = reservePort(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const env = { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }
  async function startApi() {
    const child = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child)
    child.completed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); child.stdout.on('data', bytes => logs.push({ pid: child.pid, stream: 'stdout', text: bytes.toString('utf8') })); child.stderr.on('data', bytes => logs.push({ pid: child.pid, stream: 'stderr', text: bytes.toString('utf8') }))
    await until(async () => { try { return (await fetch(origin)).ok } catch { return false } }); return child
  }
  const first = await startApi(), login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  await command('/api/admin/employees/analysis', { expectedRevision: 1, placement: { nodeId: 'router', mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['analysis.classify.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }, 'PATCH')
  const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: 'pair-restart-router', nodeId: 'router', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['analysis'], expiresAt: new Date(Date.now() + 120000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin, identity })
  await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem-restart-router', ...identity })
  const budget = { workspaceId: 'local', coordinatorAgentId: 'analysis', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await command('/api/admin/routing-policies/restart-router', { clientRequestId: 'restart-router-policy', expectedRevision: null, workspaceId: 'local', routerAgentId: 'analysis', routerNodeId: 'router', enabled: true, maxOutputTokens: 1024, budget }, 'PUT')
  const thread = await command('/api/interaction/threads', { clientRequestId: 'restart-thread' }); await command(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'restart-source', sourceEventId: 'restart-source', version: 1, expectedThreadRevision: 1, routingPolicyId: 'restart-router', text: '继续昨天那份整改表，先明确目标工作。' })
  await upstreamReceived; const before = await store.read(); assert.equal(before.modelRequests.length, original.modelRequests.length + 1); assert.equal(before.modelRequests.at(-1).outcome, 'unknown'); assert.equal(before.modelRequests.at(-1).completedAt, null); await writeFile(join(directory, 'before-sigterm.json'), JSON.stringify(before, null, 2))
  console.log(JSON.stringify({ stage: 'production Router actually forwarded; SIGTERM while upstream stream open', directory, apiPid: first.pid, origin }))
  first.kill('SIGTERM'); const exit = await Promise.race([first.completed, new Promise((_, reject) => setTimeout(() => reject(Error('production SIGTERM did not finish')), 10000))]); assert.deepEqual(exit, { code: 0, signal: null }); assert(upstreamClosed)
  const stopped = await store.read(); assert.equal(stopped.modelRequests.at(-1).outcome, 'unknown'); assert(stopped.modelRequests.at(-1).completedAt); assert.equal(stopped.routingRequests.at(-1).state, 'unknown'); await writeFile(join(directory, 'after-exit.json'), JSON.stringify(stopped, null, 2))
  const second = await startApi(); assert.notEqual(second.pid, first.pid); await new Promise(resolve => setTimeout(resolve, 1300)); const restarted = await store.read(); assert.equal(captures.length, 1); assert.deepEqual(restarted.modelRequests, stopped.modelRequests); assert.deepEqual(restarted.routingRequests, stopped.routingRequests); assert.deepEqual(restarted.sourceEvents, stopped.sourceEvents); assert.deepEqual(restarted.works, original.works); assert.equal(digest(captures[0]), restarted.modelRequests.at(-1).bodyDigest)
  await writeFile(join(directory, 'after-new-pid.json'), JSON.stringify(restarted, null, 2)); second.kill('SIGTERM'); assert.deepEqual(await second.completed, { code: 0, signal: null })
  const result = { result: 'passed', directory, productionApiPids: [first.pid, second.pid], actualSigtermExit: exit, forwardedStreamAborted: true, actualProviderForwards: 1, unknownReservationRetained: true, newPidRestartNoResend: true, originalWorksUnchanged: true, boundary: 'actual production API OS processes and in-flight HTTP Router stream; real SIGTERM/restart, synthetic provider; no Host/DSH started and no physical OS reboot' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await child.completed }; if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(captures, null, 2)); await writeFile(join(directory, 'process-logs.json'), JSON.stringify(logs, null, 2)); console.log('Interaction restart root:', directory) }
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function until(test) { const deadline = Date.now() + 10000; while (!await test()) { assert(Date.now() < deadline, 'API startup timeout'); await new Promise(resolve => setTimeout(resolve, 50)) } }
