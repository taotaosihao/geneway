import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-recovery-'), mode = process.argv.includes('--running') ? 'running' : 'candidate', captures = [], errors = [], children = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let fixture, provider, proxy, blockUpload = true, remote, root, heldWorker, workersBeforeCancel = []
try {
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); captures.push(body)
      const index = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[index].content), tail = body.messages.slice(index + 1).filter(row => row.role === 'tool'), last = tail.length ? JSON.parse(flatten(tail.at(-1).content)) : null
      const refs = JSON.parse(/受控资料引用：(\[[\s\S]*?\])/.exec(input)[1])
      let tool, parameters
      if (!tail.length) { tool = 'geneway_read_evidence'; parameters = { ref: refs[0] } }
      else if (last?.entries) { tool = 'geneway_start_spreadsheet'; parameters = { clientRequestId: 'recovery-job', instructionRevision: last.instructionRevision, template: templateReference(), historyRefs: [last.ref], rows: last.entries.map(entry => ({ sourceRef: last.ref, entryIndex: entry.entryIndex, dueDate: '2026-11-20', photoRefs: [] })) } }
      else if (tail.length === 2 && last?.id) { tool = 'geneway_get_spreadsheet_job'; parameters = { jobId: last.id } }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `recovery-${captures.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${captures.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '生成进程由父进程核对。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` })
  await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-key', { mode: 0o600 })
  proxy = createServer((request, response) => {
    if (blockUpload && request.url === '/internal/spreadsheets/upload-token') { request.resume(); response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'JOB_PROJECTION_PENDING' } })); return }
    const upstream = httpRequest(new URL(request.url, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host } }, reply => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response) }); upstream.on('error', () => response.destroy()); response.on('close', () => upstream.destroy()); request.pipe(upstream)
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const owner = { id: 'owner' }, pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  root = join(directory, 'pc-b'); await mkdir(root); const profile = join(root, 'profile.json'); await writeFile(profile, JSON.stringify({ root, origin: `http://127.0.0.1:${proxy.address().port}`, officeEnabled: true, pairing }), { mode: 0o600 })
  remote = await launch(profile)
  const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护栏松动', owner: '张工' }] })), { ref } = await fixture.attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: history.length, sha256: hash(history) }); await fixture.attachments.upload(owner, ref.attachmentId, Readable.from([history]))
  const journal = async () => JSON.parse(await readFile(join(root, 'host-journal.json'), 'utf8'))
  const holding = mode === 'running' ? (async () => { await until(async () => { const job = (await journal()).jobs.find(row => row.worker && row.state === 'running'); if (!job) return false; heldWorker = job.worker; process.kill(job.worker.pid, 'SIGSTOP'); return true }) })() : null
  const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-office', goal: '远端父进程恢复原Job', clientRequestId: 'create', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } })
  await holding
  await until(async () => { const local = await journal(), state = await fixture.store.read(); return (mode === 'candidate' ? local.jobs[0]?.state === 'candidate' : !!heldWorker) && state.multisite.jobs[0] && state.modelRequests.length >= 3 && state.modelRequests.every(row => row.outcome === 'completed') && captures.length === state.modelRequests.length })
  // Confirm the model turn is idle before the parent death; this probe isolates Job recovery.
  await new Promise(resolve => setTimeout(resolve, 300))
  const before = await journal(), stateBefore = await fixture.store.read(), originalJob = before.jobs[0], instance = remote.ready.nodeInstanceId, callsBefore = captures.length
  const path = join(root, 'spreadsheet-jobs', originalJob.id, 'incident-register.xlsx'), original = mode === 'candidate' ? { bytes: await readFile(path), stat: await stat(path) } : null
  await writeFile(join(directory, 'before-parent-death.json'), JSON.stringify({ host: before, cloud: stateBefore }, null, 2))
  await terminate(remote.child, 'SIGKILL'); blockUpload = false; remote = await launch(profile); assert.equal(remote.ready.nodeInstanceId, instance)
  if (mode === 'candidate') {
    await until(async () => (await fixture.store.read()).works[0].status === 'completed' && (await journal()).executions[0].status === 'settled')
    const final = await fixture.store.read(), recovered = await journal(); assert.equal(final.artifacts[0].jobId, originalJob.id); assert.equal(final.artifacts[0].sha256, hash(original.bytes)); assert.equal((await stat(path)).ino, original.stat.ino); assert.deepEqual(await readFile(path), original.bytes); assert.deepEqual(recovered.jobs[0].worker, originalJob.worker)
  } else {
    await until(async () => (await journal()).jobs[0].state === 'unknown')
    const recovered = await journal(); assert.equal(recovered.jobs[0].output, null); assert.equal((await fixture.store.read()).artifacts.length, 0)
    workersBeforeCancel = await workerFacts(remote.child.pid); await writeFile(join(directory, 'workers-before-cancel.json'), JSON.stringify(workersBeforeCancel, null, 2))
    const current = await readFile(`/proc/${heldWorker.pid}/stat`, 'utf8').catch(cause => { if (cause.code !== 'ENOENT') throw cause; return '' }); assert(!current || current.slice(current.lastIndexOf(')') + 2).startsWith('Z '))
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'cancel-recovered' }); await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  }
  assert.equal(captures.length, callsBefore); assert.equal((await fixture.store.read()).modelRequests.length, stateBefore.modelRequests.length)
  const workersAfterCancel = await workerFacts(remote.child.pid); await writeFile(join(directory, 'workers-after-cancel.json'), JSON.stringify(workersAfterCancel, null, 2))
  assert(workersAfterCancel.every(row => !row.generator && (mode !== 'candidate' || !row.runtime)))
  const result = { result: 'passed', directory, mode, actualRemoteEntryParentSigkill: true, stableNodeInstanceAndSession: (await journal()).executions[0].session_id === before.executions[0].session_id, originalJobId: originalJob.id, forwardsBefore: callsBefore, forwardsAfter: captures.length, workersBeforeCancel, workersAfterCancel, noNewGenerator: true, noNewModelForward: true, ...(mode === 'candidate' ? { originalBytesSameInodeCloudReady: true, noRecoveryInferenceWorker: true } : { originalWorkerQuiescedUnknownNoRecompute: true, actualCancelConverged: true }) }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, errors }, null, 2)); throw cause }
finally {
  for (const child of children.reverse()) await terminate(child, 'SIGTERM').catch(() => terminate(child, 'SIGKILL'))
  await fixture?.close(); for (const server of [proxy, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await writeFile(join(directory, 'capture.json'), JSON.stringify({ captures, errors }, null, 2)); console.log('Remote Job recovery evidence:', directory)
}
async function launch(profile) { const child = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child); const ready = await new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); if (message.kind === 'host-error') errors.push(message.code) }); child.once('exit', code => reject(new Error(`remote exited ${code}`))) }); return { child, ready } }
async function terminate(child, signal) { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), 10000); child.once('exit', () => { clearTimeout(timeout); resolve() }); child.kill(signal) }) }
async function until(predicate) { const end = Date.now() + 30000; while (!await predicate()) { assert(Date.now() < end, `recovery timed out: ${errors.slice(-4)}`); await new Promise(resolve => setTimeout(resolve, 15)) } }
async function workerFacts(pid) { const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean), rows = []; for (const child of children) { try { const command = await readFile(`/proc/${child}/cmdline`, 'utf8'), environment = await readFile(`/proc/${child}/environ`, 'utf8'); rows.push({ pid: child, runtime: command.includes('runtime-worker.mjs'), generator: command.includes('spreadsheet-worker.mjs'), modelTokenPresent: environment.split('\0').some(value => value.startsWith('GENEWAY_EXECUTION_TOKEN=')) }) } catch (cause) { if (cause.code !== 'ENOENT') throw cause } }; return rows }
