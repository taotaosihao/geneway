import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/budget-parent-death-'), bodies = [], children = [], diagnostics = []
let api, parent, fixtureOrigin, proxy, provider, actor, allowWait = false
const heldResponse = Promise.withResolvers(), releaseResponse = Promise.withResolvers()
const until = async predicate => { const end = Date.now() + 30000; while (!await predicate()) { assert(Date.now() < end, 'budget parent death timed out'); await new Promise(resolve => setTimeout(resolve, 25)) } }
function spawn(path, args = []) { const child = fork(fileURLToPath(new URL(path, import.meta.url)), args, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child); child.stdout.on('data', bytes => diagnostics.push({ pid: child.pid, stream: 'stdout', text: bytes.toString() })); child.stderr.on('data', bytes => diagnostics.push({ pid: child.pid, stream: 'stderr', text: bytes.toString() })); return child }
async function ready(child) { return new Promise((resolve, reject) => { child.on('message', value => { if (value.kind === 'ready') resolve(value); if (value.kind === 'host-error' || value.kind === 'error') diagnostics.push({ pid: child.pid, value }) }); child.once('exit', (code, signal) => reject(new Error(`fixture exited before ready: ${code}/${signal}`))) }) }
try {
  console.log(JSON.stringify({ stage: 'starting', directory }))
  provider = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"已收到第一条模拟要求"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  api = spawn('./fixtures/multisite/bridge-service.mjs'); const apiReady = ready(api); api.send({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); fixtureOrigin = (await apiReady).origin
  const login = await fetch(fixtureOrigin + '/api/session', { method: 'POST', headers: { origin: fixtureOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); actor = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function command(path, value, method = 'POST', expected = 200) { const response = await fetch(fixtureOrigin + path, { method, headers: { origin: fixtureOrigin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) }); const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result }
  proxy = createServer(async (request, response) => {
    if (!allowWait && request.method === 'GET' && request.url === '/internal/bridge/events') { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"code":"REMOTE_UNAVAILABLE"}}'); return }
    const upstream = httpRequest(new URL(request.url, fixtureOrigin), { method: request.method, headers: { ...request.headers, host: new URL(fixtureOrigin).host } }, incoming => {
      if (!allowWait && (request.url === '/internal/bridge/resync' || request.url === '/internal/model/v1/chat/completions')) {
        const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', async () => {
          let body = Buffer.concat(chunks)
          if (request.url === '/internal/bridge/resync' && incoming.statusCode === 200) { const value = JSON.parse(body); value.pending = value.pending.filter(command => command.operation !== 'budget_wait'); body = Buffer.from(JSON.stringify(value)) }
          if (request.url === '/internal/model/v1/chat/completions' && incoming.statusCode === 409 && body.includes('WAITING_BUDGET')) { heldResponse.resolve(); await releaseResponse.promise }
          if (!response.destroyed) { const headers = { ...incoming.headers }; delete headers['content-length']; response.writeHead(incoming.statusCode, headers); response.end(body) }
        })
      } else { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response) }
    }); upstream.on('error', () => response.destroy()); request.pipe(upstream)
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const store = createFileStore(join(directory, 'api/state.json')), initial = await store.read(), employee = initial.employees.find(row => row.id === 'desktop-office'), route = initial.modelRoutes.find(row => row.id === employee.modelRouteId), limits = { maxModelRequests: 1, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }
  await command('/api/admin/budget-policies/one-before-death', { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'desktop-office', enabled: true, accountingMode: 'conservative_estimate', limits, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }, 'PUT')
  const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: 'pair', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 60000).toISOString() }), root = join(directory, 'node'); await mkdir(root)
  const profile = join(root, 'profile.json'); await writeFile(profile, JSON.stringify({ root, origin: `http://127.0.0.1:${proxy.address().port}`, pairing, maxActiveLoops: 1 }), { mode: 0o600 }); parent = spawn('../packages/agent-host/remote.mjs', [profile]); await ready(parent)
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '只确认收到，不调用工具', clientRequestId: 'work', budgetPolicyId: 'one-before-death' })
  await until(async () => (await store.read()).modelRequests[0]?.outcome === 'completed')
  await command(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'input2', text: '第二条要求触发明确预算不足' })
  await heldResponse.promise
  const before = await store.read(), localBefore = JSON.parse(await readFile(join(root, 'host-journal.json'))), hold = before.budgetHolds[0]
  assert(hold && !hold.idleAt); assert.equal(localBefore.inbox.some(row => row.command.operation === 'budget_wait'), false); assert.equal(before.modelRequests.length, 1); assert.equal(bodies.length, 1)
  console.log(JSON.stringify({ stage: 'kill-before-idle', directory, parentPid: parent.pid, holdId: hold.id }))
  const death = new Promise(resolve => parent.once('exit', (code, signal) => resolve({ code, signal }))); parent.kill('SIGKILL'); assert.equal((await death).signal, 'SIGKILL'); releaseResponse.resolve(); allowWait = true
  await writeFile(join(directory, 'before-death.json'), JSON.stringify({ state: before, local: localBefore, parentPid: parent.pid }, null, 2))
  // IPC disconnection drains the original worker/lock helper; reuse the same durable root and Session.
  await new Promise(resolve => setTimeout(resolve, 500)); parent = spawn('../packages/agent-host/remote.mjs', [profile]); await ready(parent)
  await until(async () => (await store.read()).multisite.attempts[0].status === 'unknown')
  const after = await store.read(), localAfter = JSON.parse(await readFile(join(root, 'host-journal.json')))
  assert.equal(after.budgetHolds[0].idleAt, null); assert.equal(after.budgetHolds[0].state, 'waiting'); assert.deepEqual(after.modelRequests, before.modelRequests); assert.equal(bodies.length, 1); assert.equal(after.multisite.attempts[0].session_id, before.multisite.attempts[0].session_id); assert(!after.multisite.messages.some(row => row.kind === 'budget_resume'))
  const adjustment = await command(`/api/admin/works/${work.id}/budget`, { clientRequestId: 'unsafe-adjust', expectedRevision: 1, reason: '无idleproof不得恢复unknown', limits: { ...limits, maxModelRequests: 20 }, executionDeadlineAt: new Date(Date.now() + 60000).toISOString() }, 'POST', 409); assert.equal(adjustment.error.code, 'INVALID_STATE')
  const identity = JSON.parse(await readFile(join(root, 'node-identity.json'))), client = createRemoteClient({ origin: fixtureOrigin, identity }); await assert.rejects(client.authorize(binding(after.multisite.attempts[0])), { code: 'FORBIDDEN' })
  await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
  const stopped = await store.read(); assert.equal(bodies.length, 1); assert(!stopped.modelRequests.some(row => row.id === hold.requestId)); assert.equal(digest(bodies[0]), stopped.modelRequests[0].bodyDigest)
  const result = { result: 'passed', directory, boundary: 'actual native DSH/Node parent SIGKILL and same root restart, controlled HTTP delay of budget_wait and WAITING_BUDGET response; no fabricated idle/consumption', noOfficialIdleProofBeforeParentDeath: true, restartUnknownAndNoBudgetResume: true, originalSessionAndLedgerPreserved: true, noForwardHoldNeverReserved: true, adminAdjustmentCannotReviveUnknown: true, actualStop: true, actualProviderRequests: bodies.length }
  await writeFile(join(directory, 'after-restart.json'), JSON.stringify({ state: after, local: localAfter }, null, 2)); await writeFile(join(directory, 'final-state.json'), JSON.stringify(stopped, null, 2)); await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack, diagnostics }, null, 2)); console.error(directory); throw cause } finally { releaseResponse.resolve(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited }; for (const server of [proxy, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }; await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); await writeFile(join(directory, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2)) }
