import { acquireHostOwner } from '../packages/agent-host/ownership.mjs'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRequest } from './fixtures/multisite/delegation.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-native-'), requests = [], errors = [], children = [], hostReady = []
let provider, apiOrigin
const productionRestart = process.argv.includes('--production-restart')
const flatten = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('')
try {
  provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), index = body.messages.findLastIndex(row => row.role === 'user'), latest = flatten(body.messages[index]), tail = body.messages.slice(index + 1), lastTool = tail.findLast(row => row.role === 'tool')
      const context = JSON.parse(latest.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0]), capability = context.grant.execution.capabilityIds[0], agent = capability === 'collaboration.coordinate.v1' ? 'coordinator' : capability === 'office.xlsx.render.v1' ? 'desktop-office' : 'desktop-data'
      const entry = { index: requests.length + 1, agent, body }; requests.push(entry)
      let tool, parameters
      if (latest.includes('Agent来源消息')) {
        if (agent === 'desktop-office') { tool = 'geneway_complete_delegation'; parameters = { clientRequestId: 'b-result', instructionRevision: 1, result: { summary: '远端 B 已消费远端 A 的结构化空证据回报。', evidenceRefs: [] } } }
        else if (!lastTool) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: '云端独立 Host 的协调 Session 已收到跨节点 B/A 回报。' } }
      } else if (agent === 'desktop-data') { tool = 'geneway_complete_delegation'; parameters = { clientRequestId: 'a-result', instructionRevision: 1, result: { summary: '远端 A 独立原生 Session 的空证据回报。', evidenceRefs: [] } } }
      else if (!lastTool) { tool = 'geneway_delegate'; parameters = childRequest(`${agent}-delegate`, agent === 'coordinator' ? 'desktop-office' : 'desktop-data') }
      else { const result = JSON.parse(flatten(lastTool)); assert((result.result ?? result).delegationId, 'unexpected provider step after parked wait'); tool = 'geneway_wait_dependencies'; parameters = { clientRequestId: `${agent}-wait`, instructionRevision: 1, dependencyIds: [(result.result ?? result).delegationId] } }
      entry.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `bridge-${requests.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '本地模拟跨节点委派控制链已结束。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end(JSON.stringify({ error: { message: cause.message } })) }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const apiRoot = join(directory, 'cloud-api'), api = spawn('../scripts/fixtures/multisite/bridge-service.mjs', [])
  const apiReady = waitReady(api); api.send({ directory: apiRoot, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); apiOrigin = (await apiReady).origin
  const login = await fetch(apiOrigin + '/api/session', { method: 'POST', headers: { origin: apiOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function command(path, body, method = 'POST') { const response = await fetch(apiOrigin + path, { method, headers: { origin: apiOrigin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result }
  for (const [nodeId, allowedAgentIds] of [['cloud', ['coordinator', 'analysis']], ['pc-a', ['desktop-data']], ['pc-b', ['desktop-office']], ['gateway', ['gateway']]]) {
    const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(Date.now() + 120_000).toISOString() })
    const root = join(directory, nodeId); await mkdir(root, { recursive: true, mode: 0o700 }); const profile = join(root, 'profile.json')
    await writeFile(profile, JSON.stringify({ root, origin: apiOrigin, pairing: { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode }, maxActiveLoops: 1 }), { mode: 0o600 })
    const child = spawn('../packages/agent-host/remote.mjs', [profile]), ready = await waitReady(child); hostReady.push(ready)
  }
  await command('/api/admin/resources/fixture%3Ahistory', { clientRequestId: 'history-resource', expectedRevision: null, workspaceId: 'local', siteId: 'simulated-site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], enabled: true }, 'PUT')
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '五个独立父进程的真实 HTTP Bridge：协调→B 主动委派 A→结果回流。', clientRequestId: 'bridge-work' })
  const state = async () => JSON.parse(await readFile(join(apiRoot, 'state.json'), 'utf8'))
  await until(async () => { const current = await state(); return current.multisite.attempts.find(row => row.agent_id === 'coordinator')?.report?.state === 'ready' && current.multisite.messages.every(row => row.ingestedAt) })
  await until(async () => { const current = await state(); return requests.length === 8 && current.modelRequests.length === 8 && current.modelRequests.every(row => row.outcome === 'completed') && current.multisite.attempts.filter(row => row.parent_delegation_id !== null).every(row => row.settledAt) })
  const final = await state(), journals = {}
  assert.equal(new Set(children.map(child => child.pid)).size, 5); assert.equal(hostReady.length, 4); assert.equal(final.nodes.length, 4); assert.equal(final.multisite.attempts.length, 3); assert.equal(final.multisite.results.length, 2); assert.equal(final.works[0].instructionRevision, 1)
  assert.equal(final.modelRequests.length, 8); assert.equal(final.works[0].modelRequestBudget.reserved, 8); assert.equal(requests.length, 8)
  assert(final.multisite.outbox.filter(row => !['cancel', 'settle'].includes(row.command.operation)).every(row => row.acceptedAt))
  assert.equal((await readFile(`/proc/${api.pid}/task/${api.pid}/children`, 'utf8')).trim(), '', 'cloud API has no LocalHost/native worker children')
  for (const ready of hostReady) {
    journals[ready.nodeId] = JSON.parse(await readFile(join(ready.root, 'host-journal.json'), 'utf8'))
    const identity = JSON.parse(await readFile(join(ready.root, 'node-identity.json'), 'utf8')); assert.equal((await stat(join(ready.root, 'node-identity.json'))).mode & 0o777, 0o600)
    assert(!JSON.stringify(final).includes(identity.credential))
    assert(journals[ready.nodeId].executions.filter(row => row.slotHeld).length <= 1)
  }
  assert.equal(new Set(final.multisite.attempts.map(row => row.session_id)).size, 3)
  let productionEvidence, ownershipEvidence
  if (productionRestart) {
    const originalSessions = final.multisite.attempts.map(row => ({ attemptId: row.attempt_id, sessionId: row.session_id, status: row.status })), workerPids = {}
    for (const ready of hostReady) workerPids[ready.nodeId] = (await readFile(`/proc/${ready.pid}/task/${ready.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
    await terminate(api, 'SIGTERM')
    for (let restart = 0; restart < 2; restart++) {
      const production = await launchProduction(apiRoot, apiOrigin)
      await until(async () => { try { const response = await fetch(apiOrigin + '/api/session', { method: 'POST', headers: { origin: apiOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); if (!response.ok) return false; const value = await response.json(); session.cookie = response.headers.get('set-cookie').split(';')[0]; session.csrfToken = value.csrfToken; return true } catch { return false } })
      const readback = await state(); assert.deepEqual(readback.multisite.attempts.map(row => ({ attemptId: row.attempt_id, sessionId: row.session_id, status: row.status })), originalSessions)
      const descendants = (await readFile(`/proc/${production.pid}/task/${production.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
      for (const pid of descendants) { const args = await readFile(`/proc/${pid}/cmdline`, 'utf8'); assert(!args.includes('runtime-worker.mjs'), 'production remote mode must not construct a LocalHost worker') }
      for (const ready of hostReady) assert.deepEqual((await readFile(`/proc/${ready.pid}/task/${ready.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean), workerPids[ready.nodeId])
      if (restart === 0) await terminate(production, 'SIGTERM')
    }
    assert.equal(requests.length, 8); productionEvidence = { actualStartFunction: true, explicitRemoteMode: true, apiRestarts: 2, remoteWorkerPidsUnchanged: true, workAttemptsNotMisrecovered: true, noExtraModelRequests: true }
  }
  if (process.argv.includes('--owner-loss')) {
    const ready = hostReady.find(row => row.nodeId === 'cloud'), parent = children.find(row => row.pid === ready.pid), descendants = (await readFile(`/proc/${ready.pid}/task/${ready.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
    let helperPid, workerPid
    for (const candidate of descendants) { const args = await readFile(`/proc/${candidate}/cmdline`, 'utf8'); if (args.includes('runtime-worker.mjs')) workerPid = Number(candidate); else if (args.includes('flock --nonblock')) helperPid = Number(candidate) }
    assert(workerPid && helperPid)
    const longCredential = JSON.parse(await readFile(join(ready.root, 'node-identity.json'), 'utf8')).credential
    assert(!(await readFile(`/proc/${workerPid}/environ`, 'utf8')).includes(longCredential))
    process.kill(workerPid, 'SIGSTOP')
    try {
      process.kill(helperPid, 'SIGKILL')
      await until(async () => errors.some(value => value.includes(`${ready.pid}:HOST_OWNER_LOST`)))
      parent.kill('SIGTERM')
      await assert.rejects(acquireHostOwner(ready.root), { code: 'HOST_ALREADY_RUNNING' })
      assert.equal(parent.exitCode, null); assert.equal(parent.signalCode, null)
      assert((await stat(`/proc/${workerPid}`)).isDirectory())
    } finally { process.kill(workerPid, 'SIGCONT') }
    await until(async () => { try { await stat(`/proc/${workerPid}`); return false } catch (cause) { if (cause.code === 'ENOENT') return true; throw cause } })
    let replacementLock
    await until(async () => { try { replacementLock = await acquireHostOwner(ready.root); return true } catch (cause) { if (cause.code === 'HOST_ALREADY_RUNNING') return false; throw cause } }); await replacementLock.release()
    await terminate(parent, 'SIGTERM')
    const replacement = spawn('../packages/agent-host/remote.mjs', [join(ready.root, 'profile.json')]), newReady = await waitReady(replacement); assert.equal(newReady.nodeInstanceId, ready.nodeInstanceId); assert.notEqual(newReady.hostRunId, ready.hostRunId)
    hostReady[hostReady.indexOf(ready)] = newReady
    await until(async () => { const journal = JSON.parse(await readFile(join(newReady.root, 'host-journal.json'), 'utf8')); return journal.executions.some(row => row.agent_id === 'coordinator' && row.status === 'running') })
    assert.equal(requests.length, 8)
    ownershipEvidence = { oldHostPid: ready.pid, replacementHostPid: newReady.pid, helperPid, workerPid, actualHelperKilled: true, actualWorkerParkedDuringClose: true, secondOwnerRejectedUntilWorkerExit: true, repeatedCloseWaitsForQuiescence: true, lockReleasedAfterQuiescence: true, sameInstanceAfterRestart: true, nodeLongCredentialAbsentFromWorker: true }
  }
  await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'bridge-stop' }); await until(async () => (await state()).works[0].status === 'cancelled')
  assert.equal(requests.length, 8)
  const result = { result: 'passed', directory, workId: work.id, boundary: 'five isolated parent processes on one loopback machine; real HTTP/SSE/POST and native per-Attempt DSH; synthetic provider, no business resource reads, real network egress or D2b Office', apiPid: api.pid, hostReady, independentParentCount: 5, totalParentStarts: children.length, nativeSessions: 3, actualForwardRequests: requests.length, maxActiveLoopsPerHost: 1, exactCommandAcks: true, resultsConsumed: 2, actualStop: true, productionEvidence, ownershipEvidence }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally {
  await writeFile(join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(directory, 'errors.json'), JSON.stringify(errors, null, 2))
  for (const child of [...children].reverse()) if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  console.log('Bridge native evidence:', directory)
}
function spawn(relative, args) { const child = fork(fileURLToPath(new URL(relative, import.meta.url)), args, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); child.stderr.on('data', bytes => errors.push(bytes.toString())); child.on('message', message => { if (message.kind === 'host-error') errors.push(`${child.pid}:${message.code}`) }); return child }
function waitReady(child) { return new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); if (message.kind === 'error') reject(new Error(message.code)) }); child.once('exit', code => reject(new Error(`parent exited before ready: ${code}`))) }) }
async function until(predicate) { const deadline = Date.now() + 45_000; while (!await predicate()) { assert(Date.now() < deadline, `Bridge native timed out: ${errors.slice(-10).join(';')}`); await new Promise(resolve => setTimeout(resolve, 80)) } }

async function terminate(child, signal) { if (child.exitCode !== null || child.signalCode !== null) return; const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await ended }
async function launchProduction(apiRoot, origin) {
  await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  const port = new URL(origin).port, outputPath = join(directory, `production-${children.length}.log`), output = []
  const child = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'production-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child)
  const ready = new Promise((resolve, reject) => { child.stdout.on('data', bytes => { output.push(bytes.toString()); if (bytes.toString().includes('Geneway listening on')) resolve() }); child.stderr.on('data', bytes => { output.push(bytes.toString()); errors.push(bytes.toString()) }); child.once('exit', code => reject(new Error(`production API exited before ready ${code}: ${output.join('')}`))) })
  await ready; await writeFile(outputPath, output.join('')); return child
}
