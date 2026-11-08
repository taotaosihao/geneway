import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { seedDelegation, childRequest } from './fixtures/multisite/delegation.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-recovery-'), apiRoot = join(directory, 'api'), processes = [], errors = [], providerBodies = []
let provider, api, nodeB, origin, calls = 0, session
try {
  await mkdir(apiRoot, { recursive: true, mode: 0o700 }); const store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(state => { seedDelegation(state); state.members = state.members.filter(row => row.id === 'owner'); state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; for (const employee of state.employees) { employee.skillIds = ['cycle']; employee.placement.nodeId = employee.id === 'desktop-office' ? 'pc-b' : 'cloud' }; return state })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password' }, { mode: 'create', allowedMemberIds: ['owner'] })
  await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 }); await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); providerBodies.push(body); calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls >= 3) { response.write('data: {"choices":[{"index":0,"delta":{"content":"活跃流尚无terminal"},"finish_reason":null}]}\n\n'); return }
    const tool = calls === 1 ? 'geneway_delegate' : 'geneway_wait_dependencies'
    const previous = calls === 1 ? null : JSON.parse(body.messages.findLast(row => row.role === 'tool').content)
    const parameters = calls === 1 ? childRequest('recovery-b') : { clientRequestId: 'wait-b', instructionRevision: 1, dependencyIds: [(previous.result ?? previous).delegationId] }
    const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `recovery-${calls}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${calls}`, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); frame({}, 'tool_calls'); response.end('data: [DONE]\n\n')
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const ports = createPortServer(); await new Promise(resolve => ports.listen(0, '127.0.0.1', resolve)); const port = ports.address().port; await new Promise(resolve => ports.close(resolve)); origin = `http://127.0.0.1:${port}`
  api = await launchApi(); await login()
  const hosts = []
  for (const [nodeId, allowedAgentIds] of [['cloud', ['coordinator', 'analysis']], ['pc-b', ['desktop-office']]]) {
    const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(Date.now() + 60_000).toISOString() }), root = join(directory, nodeId); await mkdir(root, { mode: 0o700 }); const profile = join(root, 'profile.json')
    await writeFile(profile, JSON.stringify({ root, origin, pairing, maxActiveLoops: 1 }), { mode: 0o600 }); const item = await launchHost(profile); hosts.push(item); if (nodeId === 'pc-b') nodeB = item
  }
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '真实活模型流 API 重启与远端父进程恢复。', clientRequestId: 'recovery-work' })
  await until(async () => calls === 3 && (await store.read()).modelRequests.some(row => row.outcome === 'unknown'))
  const before = await store.read(), parentSession = before.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id, child = before.multisite.attempts.find(row => row.agent_id === 'desktop-office')
  await writeFile(join(directory, 'before-api-shutdown.json'), JSON.stringify(before, null, 2))
  await terminate(api, 'SIGTERM', 10_000)
  api = await launchApi(); await login()
  const identity = JSON.parse(await readFile(join(directory, 'pc-b/node-identity.json'), 'utf8')), client = createRemoteClient({ origin, identity })
  await assert.rejects(client.authorize(child), { code: 'RUNTIME_REQUEST_UNKNOWN' })
  assert.equal(calls, 3); const restarted = await store.read(); assert.equal(restarted.modelRequests.length, 3); assert.equal(restarted.modelRequests[2].outcome, 'unknown'); assert.equal(restarted.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id, parentSession)
  const originalInstance = nodeB.ready.nodeInstanceId
  await terminate(nodeB.child, 'SIGKILL'); nodeB = await launchHost(join(directory, 'pc-b/profile.json')); assert.equal(nodeB.ready.nodeInstanceId, originalInstance)
  await until(async () => (await store.read()).multisite.attempts.find(row => row.agent_id === 'desktop-office').status === 'unknown')
  const descendants = (await readFile(`/proc/${nodeB.child.pid}/task/${nodeB.child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  for (const pid of descendants) assert(!(await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('runtime-worker.mjs'))
  assert.equal(calls, 3)
  await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel-recovered' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
  const final = await store.read(); assert.equal(final.works[0].modelRequestBudget.reserved, 3); assert.equal(final.modelRequests[2].outcome, 'unknown'); assert(final.multisite.attempts.every(row => row.status === 'cancelled')); assert.equal(calls, 3)
  const result = { result: 'passed', directory, workId: work.id, activeModelApiGracefulShutdownAndRestart: true, unknownLedgerRetained: true, exactForwardRequests: 3, apiRestartNoReplay: true, remoteParentSigkillSameInstance: true, noRecoveryInferenceWorker: true, actualStopOnlyConverged: true, sameRootSession: true, boundary: 'actual production start, HTTP Bridge and remote DSH parents; local synthetic held model stream; no business side effects' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally {
  await writeFile(join(directory, 'errors.json'), JSON.stringify(errors, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(providerBodies, null, 2))
  for (const child of [...processes].reverse()) if (child.exitCode === null && child.signalCode === null) { try { await terminate(child, 'SIGTERM', 2000) } catch { await terminate(child, 'SIGKILL') } }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  console.log('Bridge recovery evidence:', directory)
}
async function login() { const response = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert(response.ok); session = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
async function command(path, body) { const response = await fetch(origin + path, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result }
function start(relative, args, env) { const child = fork(fileURLToPath(new URL(relative, import.meta.url)), args, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory, ...env }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); processes.push(child); child.stderr.on('data', bytes => errors.push(bytes.toString())); child.on('message', value => { if (value.kind === 'host-error') errors.push(`${child.pid}:${value.code}`) }); return child }
async function launchApi() { const child = start('./fixtures/multisite/production-service.mjs', [], { GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: new URL(origin).port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }); await new Promise((resolve, reject) => { child.stdout.on('data', bytes => { if (bytes.toString().includes('Geneway listening on')) resolve() }); child.once('exit', code => reject(new Error(`API exited ${code}`))) }); return child }
async function launchHost(profile) { const child = start('../packages/agent-host/remote.mjs', [profile]); const ready = await new Promise((resolve, reject) => { child.on('message', value => { if (value.kind === 'ready') resolve(value) }); child.once('exit', code => reject(new Error(`Host exited ${code}`))) }); return { child, ready } }
async function terminate(child, signal, timeoutMs = 10_000) { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`process ${child.pid} did not exit after ${signal}; active API model stream may still be open`)), timeoutMs); child.once('exit', () => { clearTimeout(timeout); resolve() }); child.kill(signal) }) }
async function until(predicate) { const deadline = Date.now() + 30_000; while (!await predicate()) { assert(Date.now() < deadline, `Bridge recovery timed out: ${errors.slice(-5).join(';')}`); await new Promise(resolve => setTimeout(resolve, 70)) } }
