import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { createFileStore } from '../src/store/file-store.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-office-native-')
console.log('Evidence:', directory)
const captures = [], traffic = [], children = [], errors = [], processFacts = []
let provider, proxy, api, remote, origin, holdLaunch = true, holdUpload = true, releaseInitialProvider
const providerGate = new Promise(resolve => { releaseInitialProvider = resolve })
const text = value => typeof value === 'string' ? value : (value ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let stage = 'setup', result, session
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
async function until(predicate, label, timeout = 60000) { const deadline = Date.now() + timeout; while (true) { const value = await predicate(); if (value) return value; assert(Date.now() < deadline, `${label} timed out at ${stage}`); await new Promise(resolve => setTimeout(resolve, 50)) } }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
function child(path, args, env, name) {
  const proc = fork(fileURLToPath(new URL(path, import.meta.url)), args, { cwd: process.cwd(), env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(proc); processFacts.push({ name, pid: proc.pid, startedAt: new Date().toISOString() })
  for (const stream of ['stdout', 'stderr']) proc[stream].on('data', bytes => { void appendFile(join(directory, `${name}.${stream}.log`), bytes) })
  proc.once('exit', (code, signal) => processFacts.push({ name, pid: proc.pid, exitedAt: new Date().toISOString(), code, signal }))
  return proc
}
async function apiJson(path, body, expected = 200, method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + path, { method, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json(); traffic.push({ kind: 'user', path, status: response.status, value }); assert.equal(response.status, expected, JSON.stringify(value)); return value
}
try {
  const statePath = join(directory, 'state.json'), store = createFileStore(statePath)
  await store.update(state => { seedDelegation(state); for (const employee of state.employees) { employee.placement.nodeId = employee.id === 'desktop-office' ? 'pc-b' : 'unused'; employee.skillIds = ['cycle'] }; state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; return state })
  await mkdir(join(directory, 'secrets')); await writeFile(join(directory, 'secrets/model.key'), 'synthetic-manual-office-provider', { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()), capture = { at: new Date().toISOString(), body }; captures.push(capture); await save('provider.json', captures)
      const lastUser = body.messages.findLastIndex(message => message.role === 'user'), results = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool'), toolResult = results.length ? JSON.parse(text(results.at(-1).content)) : null
      const refs = body.messages.filter(message => message.role === 'user').flatMap(message => [...text(message.content).matchAll(/受控资料引用：(\[[^\n]+?\])/g)].flatMap(match => JSON.parse(match[1])))
      const freshResume = text(body.messages[lastUser].content).includes('用户已明确解除本次人工暂停')
      let tool, parameters
      if (freshResume && !results.length) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: '人工恢复新消息已实际消费，沿当前原工作继续，原生成请求保留。' } }
      else if (!results.length && !freshResume) { tool = 'geneway_read_evidence'; parameters = { ref: refs.at(-1) } }
      else if (toolResult?.entries) { tool = 'geneway_start_spreadsheet'; parameters = { clientRequestId: 'manual-office-original-job', instructionRevision: toolResult.instructionRevision, template: toolResult.template, historyRefs: [toolResult.ref], rows: toolResult.entries.map(entry => ({ sourceRef: toolResult.ref, entryIndex: entry.entryIndex, dueDate: toolResult.spreadsheetRequest.dueDate, photoRefs: [] })) } }
      else if (toolResult?.id && toolResult?.state === 'accepted') { capture.originalAcceptedJobId = toolResult.id; await save('provider.json', captures); await providerGate }
      capture.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'manual-office-' + captures.length, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-' + captures.length, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '当前处理事实已保留。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push({ stage, provider: cause.stack }); response.writeHead(500); response.end('fixture provider failed') }
  })
  const providerOrigin = await listen(provider)
  const authPath = join(directory, 'auth.json'); await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await writeFile(join(directory, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  const reserve = createServer(); const reservedOrigin = await listen(reserve), port = new URL(reservedOrigin).port; await new Promise(resolve => reserve.close(resolve)); origin = reservedOrigin
  api = child('./fixtures/multisite/production-service.mjs', [], { PATH: process.env.PATH, HOME: directory, GENEWAY_STATE: statePath, GENEWAY_AUTH_FILE: authPath, GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key', GENEWAY_CONNECTION_CATALOG: join(directory, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(directory, 'unused-cloud-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: providerOrigin + '/v1' }, 'api')
  await until(async () => { if (api.exitCode !== null) throw new Error('API exited '+api.exitCode); try { return [200, 401].includes((await fetch(origin + '/api/session')).status) } catch { return false } }, 'API ready')
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }; assert.equal(login.status, 200)
  proxy = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes.toString()) : null
    const blocked = request.url === '/internal/spreadsheets/revalidate' && body?.job && holdLaunch || request.url === '/internal/spreadsheets/upload-token' && holdUpload
    if (blocked) { traffic.push({ kind: 'node', path: request.url, at: new Date().toISOString(), status: 503, request: body }); response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'REMOTE_UNAVAILABLE' } })); return }
    const upstream = httpRequest(new URL(request.url, origin), { method: request.method, headers: { ...request.headers, host: new URL(origin).host } }, incoming => { traffic.push({ kind: 'node', path: request.url, at: new Date().toISOString(), status: incoming.statusCode, request: body }); response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response) }); upstream.on('error', cause => { errors.push({ proxy: cause.message }); response.destroy() }); response.on('close', () => upstream.destroy()); upstream.end(bytes)
  })
  const nodeOrigin = await listen(proxy)
  const pairing = await apiJson('/api/admin/nodes/pairings', { clientRequestId: 'pair-office', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const remoteRoot = join(directory, 'pc-b'); await mkdir(remoteRoot); const profile = join(remoteRoot, 'profile.json'); await writeFile(profile, JSON.stringify({ root: remoteRoot, origin: nodeOrigin, officeEnabled: true, pairing: { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode } }), { mode: 0o600 })
  remote = child('../packages/agent-host/remote.mjs', [profile], { PATH: process.env.PATH, HOME: remoteRoot }, 'remote')
  await new Promise((resolve, reject) => { remote.on('message', message => { if (message.kind === 'ready') resolve(); if (message.kind === 'host-error') errors.push({ at: new Date().toISOString(), ...message }) }); remote.once('exit', code => reject(new Error('remote exited '+code))) })
  const local = async () => JSON.parse(await readFile(join(remoteRoot, 'host-journal.json'), 'utf8'))
  const historyBytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '人工暂停验收护罩松动', owner: '张工' }] }))
  const initialized = await apiJson('/api/attachments/init', { clientRequestId: 'history', name: '历史异常.json', mediaType: 'application/json', sizeBytes: historyBytes.length, sha256: hash(historyBytes) })
  const upload = await fetch(origin + `/api/attachments/${initialized.ref.attachmentId}/content`, { method: 'PUT', headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/octet-stream' }, body: historyBytes }); assert.equal(upload.status, 200, await upload.text())
  const created = await apiJson('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '按历史资料生成整改表，人工暂停后继续原生成请求。', clientRequestId: 'manual-office-work', attachmentRefs: [initialized.ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } }); const workId = created.id ?? created.workId
  stage = 'accepted-not-started'
  const accepted = await until(async () => { const state = await local(); return state.jobs.find(job => job.state === 'accepted' && job.launchState === 'not_started' && !job.worker) }, 'actual accepted Job')
  await until(() => captures.some(row => row.originalAcceptedJobId === accepted.id), 'SDK received accepted result')
  await until(() => traffic.some(row => row.path === '/internal/spreadsheets/revalidate' && row.status === 503), 'HTTP revalidation gate')
  await save('accepted-local.json', await local()); await save('accepted-cloud.json', await store.read())
  stage = 'pause'
  await apiJson(`/api/works/${workId}/multisite/pause`, { clientRequestId: 'pause', scope: { kind: 'work' }, expectedControlGeneration: 0 }); releaseInitialProvider()
  await until(async () => (await store.read()).manualControls.find(row => row.action === 'pause')?.holders.every(holder => holder.idleAt), 'official idle receipt')
  const pausedCloud = await store.read(), pausedLocal = await local(); await save('paused-cloud.json', pausedCloud); await save('paused-local.json', pausedLocal)
  const holder = pausedCloud.manualControls[0].holders[0]; assert.equal(holder.idleEvidence, 'idle_and_flushed'); assert.deepEqual(holder.jobEvidence, [{ jobId: accepted.id, workerState: 'not_started' }]); assert.equal(pausedLocal.jobs[0].state, 'accepted'); assert.equal(pausedLocal.jobs[0].worker, null)
  const execution = pausedLocal.executions[0]; assert.equal(execution.slotHeld, false)
  stage = 'release'
  await apiJson(`/api/works/${workId}/multisite/resume`, { clientRequestId: 'resume', scope: { kind: 'work' }, expectedControlGeneration: 1 }); holdLaunch = false
  await until(async () => (await store.read()).manualControls.find(row => row.action === 'resume')?.holders.every(row => row.resumeConsumedAt), 'actual fresh resume consume')
  await until(async () => (await local()).jobs[0]?.state === 'candidate', 'actual OS worker candidate')
  const resumedCloud = await store.read(), resumedLocal = await local(); await save('resumed-cloud.json', resumedCloud); await save('resumed-local.json', resumedLocal)
  const resumeHolder = resumedCloud.manualControls.find(row => row.action === 'resume').holders[0], freshCommand = resumedCloud.multisite.outbox.find(row => row.id === resumeHolder.resumeCommandId).command
  assert.equal(freshCommand.operation, 'wake'); assert.equal(freshCommand.parameters.messages[0].kind, 'manual_resume'); assert.notEqual(freshCommand.input_id, resumedCloud.multisite.inputs[0].id)
  assert.equal(resumedLocal.executions[0].session_id, execution.session_id); assert.equal(resumedCloud.works[0].instructionRevision, 1); assert.equal(resumedLocal.jobs.length, 1); assert.equal(resumedLocal.jobs[0].id, accepted.id); assert(resumedLocal.jobs[0].worker); assert(resumedLocal.jobs[0].workerExitConfirmedAt)
  assert(resumedLocal.jobs[0].startedAt < resumeHolder.resumeConsumedAt, 'existing sealed Job must launch without waiting for a new model turn')
  const outputPath = join(remoteRoot, 'spreadsheet-jobs', accepted.id, 'incident-register.xlsx'), output = await readFile(outputPath); await writeFile(join(directory, 'candidate.xlsx'), output); assert.equal(hash(output), resumedLocal.jobs[0].output.sha256)
  const book = new ExcelJS.Workbook(); await book.xlsx.load(output); assert.equal(book.worksheets[0].getCell('C3').value, '人工暂停验收护罩松动')
  await until(() => captures.some(row => row.tool === 'geneway_multisite_report'), 'fresh resume actual provider request')
  await until(async () => (await store.read()).modelRequests.every(row => row.outcome !== 'inflight'), 'model settlement')
  const accounted = await store.read(); assert.deepEqual(captures.map(row => digest(row.body)).sort(), accounted.modelRequests.map(row => row.bodyDigest).sort())
  await until(async () => (await local()).outbox.some(row => row.event.kind === 'report' && row.acknowledged), 'fresh resume report receipt')
  stage = 'cleanup-stop'
  await apiJson(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'finish-fixture' }); await until(async () => (await local()).executions[0].status === 'stopped', 'real stop')
  await save('final-cloud.json', await store.read()); await save('final-local.json', await local())
  result = { result: 'passed', directory, workId, jobId: accepted.id, sessionId: execution.session_id, providerRequests: captures.length, realOfficialIdle: true, actualJobAcceptedNotStartedViaHttp503: true, exactSharedUnstartedJobProof: true, sameOriginalJobRealWorkerCandidate: true, freshResumeSdkConsumed: true, sameInputRevision: 1, candidateBytes: output.length, candidateSha256: hash(output), boundary: 'production API + paired remote parent + official DSH + real OS XLSX worker; synthetic provider and history; no browser or business field acceptance; upload intentionally held, candidate only' }
  await save('result.json', result); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await save('failure.json', { stage, code: cause.code, stack: cause.stack }); console.error(cause.stack); process.exitCode = 1 }
finally {
  releaseInitialProvider(); holdLaunch = false
  for (const proc of children.reverse()) if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); await new Promise(resolve => proc.once('exit', resolve)) }
  for (const server of [proxy, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await save('provider.json', captures); await save('traffic.json', traffic); await save('errors.json', errors); await save('processes.json', processFacts)
  console.log('Terminal evidence:', directory)
}
