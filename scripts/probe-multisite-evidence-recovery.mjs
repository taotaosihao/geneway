import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-parent-recovery-'), root = join(directory, 'pc-a'), children = [], captures = [], errors = [], originalWorkers = []
const mode = process.argv[2] ?? 'normal', denied = ['profile', 'missing', 'corrupt', 'revision', 'revoke-node', 'revoke-resource'].includes(mode)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let fixture, provider, proxy, remote, putSeen = false, blockPut = true, responseDropped = false, blockResume = false
try {
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); captures.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'capture-before-parent-death', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'capture-call', type: 'function', function: { name: 'geneway_read_history', arguments: JSON.stringify({ clientRequestId: 'original-capture', instructionRevision: 1, resourceId: 'fixture:history', datasetId: 'history' }) } }] }); send({}, 'tool_calls'); response.end('data: [DONE]\n\n')
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-key', { mode: 0o600 })
  proxy = createServer((request, response) => {
    if (blockPut && request.method === 'PUT' && request.url.startsWith('/internal/evidence/')) { putSeen = true; request.resume(); return }
    if (blockResume && request.url === '/internal/evidence/resume-upload') { request.resume(); return }
    const upstream = httpRequest(new URL(request.url, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host } }, reply => {
      if (mode === 'double-restart' && !responseDropped && request.method === 'PUT' && reply.statusCode === 200) { responseDropped = true; blockResume = true; reply.resume(); reply.once('end', () => response.destroy()); return }
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response)
    }); upstream.on('error', () => response.destroy()); response.on('close', () => upstream.destroy()); request.pipe(upstream)
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  await mkdir(join(root, 'source'), { recursive: true }); const original = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '父进程死亡前封存原条目', owner: '张工' }] })); await writeFile(join(root, 'source/source.json'), original)
  const owner = { id: 'owner' }, pairing = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair', nodeId: 'pc-a', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-data'], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(root, 'profile.json')
  await writeFile(profile, JSON.stringify({ root, origin: `http://127.0.0.1:${proxy.address().port}`, pairing, evidenceProfile: { profileVersion: 1, resources: [{ resourceId: 'fixture:history', capabilityIds: ['evidence.history.read.v1'], adapterKind: 'history_json', root: join(root, 'source'), datasets: { history: 'source.json' }, allowedSections: [], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: ['desktop-data'], clockTrust: 'fixture' }] } }), { mode: 0o600 })
  remote = await launch(profile)
  await fixture.nodes.putResource(owner, 'fixture:history', { clientRequestId: 'resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], evidenceReaderAgentIds: ['desktop-data'], enabled: true })
  const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-data', goal: '封存后父进程死亡恢复', clientRequestId: 'work' }), journal = async () => JSON.parse(await readFile(join(root, 'host-journal.json'), 'utf8'))
  await until(async () => putSeen && (await journal()).captures[0]?.state === 'sealed' && (await fixture.store.read()).modelRequests[0]?.outcome === 'completed')
  const before = await journal(), capture = before.captures[0], sealedPath = join(root, 'evidence-captures', `evidence-${capture.id}`), sealed = await readFile(sealedPath), instance = remote.ready.nodeInstanceId
  const oldChildren = (await readFile(`/proc/${remote.child.pid}/task/${remote.child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  for (const pid of oldChildren) if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('runtime-worker.mjs')) originalWorkers.push(pid)
  assert.deepEqual(sealed, original); await writeFile(join(directory, 'before-sigkill.json'), JSON.stringify({ journal: before, cloud: await fixture.store.read() }, null, 2))
  await terminate(remote.child, 'SIGKILL'); blockPut = false; await (await import('node:fs/promises')).unlink(join(root, 'source/source.json'))
  if (mode === 'profile') { const changed = JSON.parse(await readFile(profile)); changed.evidenceProfile.resources[0].maxEntries = 199; await writeFile(profile, JSON.stringify(changed), { mode: 0o600 }) }
  if (mode === 'missing') await (await import('node:fs/promises')).unlink(sealedPath)
  if (mode === 'corrupt') await writeFile(sealedPath, 'corrupt sealed file')
  if (mode === 'revision') await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: 'new-revision', text: '变更当前要求' })
  if (mode === 'revoke-node') await fixture.nodes.revoke(owner, 'pc-a', { clientRequestId: 'revoke', expectedRevision: 1 })
  if (mode === 'revoke-resource') await fixture.nodes.putResource(owner, 'fixture:history', { clientRequestId: 'disable-resource', expectedRevision: 1, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], evidenceReaderAgentIds: [], enabled: false })
  remote = await launch(profile); assert.equal(remote.ready.nodeInstanceId, instance)
  if (mode === 'double-restart') {
    await until(async () => responseDropped && (await fixture.store.read()).evidence[0]?.status === 'ready' && (await journal()).captures[0].state === 'sealed')
    await writeFile(join(directory, 'before-second-sigkill.json'), JSON.stringify({ journal: await journal(), cloud: await fixture.store.read() }, null, 2)); await terminate(remote.child, 'SIGKILL'); blockResume = false; remote = await launch(profile); assert.equal(remote.ready.nodeInstanceId, instance)
  }
  if (denied) await until(async () => mode === 'revoke-node' ? (await fixture.store.read()).works[0].status === 'cancelled' : errors.some(code => ({ profile: ['CAPTURE_PROFILE_CHANGED'], missing: ['ENOENT'], corrupt: ['INVALID_STATE'], revision: ['REVISION_CONFLICT'], 'revoke-resource': ['FORBIDDEN'] })[mode]?.includes(code)))
  else await until(async () => { const state = await fixture.store.read(), local = await journal(); return state.multisite.attempts[0].status === 'unknown' && state.evidence[0]?.status === 'ready' && local.captures[0].state === 'published' })
  const observed = await fixture.store.read(), recovered = await journal(); assert.equal(captures.length, 1); assert.equal(observed.modelRequests.length, 1); assert.equal(hash(sealed), capture.snapshotSha256); if (!['missing', 'corrupt'].includes(mode)) assert.deepEqual(await readFile(sealedPath), sealed); assert.equal(recovered.captures[0].id, capture.id)
  if (denied) { assert.equal(observed.evidence[0].status, 'pending'); assert.equal(recovered.captures[0].state, 'sealed'); assert.equal(observed.evidenceAccessReceipts.length, 0) }
  else { assert.equal(observed.evidence[0]?.status, 'ready'); assert.equal(observed.evidence[0].sha256, hash(original)); assert.equal(recovered.captures[0].state, 'published') }
  await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'cancel' }); await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  assert.deepEqual(captures.map(body => digest(body)), (await fixture.store.read()).modelRequests.map(row => row.bodyDigest))
  const result = { result: 'passed', directory, mode, boundary: 'actual native remote parent SIGKILL after v2 cloud admission/local durable seal and before PUT; HTTP fixture API, synthetic provider', originalSealedCaptureId: capture.id, captureFormatVersion: capture.captureFormatVersion, declarationDigest: capture.declarationDigest, originalDeclarationPreservedAfterSourceRemoval: true, nodeInstanceUnchanged: true, forwardsBefore: 1, forwardsAfter: captures.length, transportPublished: observed.evidence[0]?.status === 'ready', runtimeStatus: observed.multisite.attempts[0].status, responseDropped, actualStopConverged: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, errors }, null, 2)); throw cause }
finally {
  for (const child of children.reverse()) await terminate(child, 'SIGTERM').catch(() => terminate(child, 'SIGKILL'))
  for (const pid of originalWorkers) { try { if ((await readlink(`/proc/${pid}/cwd`)).startsWith(root)) process.kill(Number(pid), 'SIGTERM') } catch (cause) { if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause } }
  await fixture?.close(); for (const server of [proxy, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }; await writeFile(join(directory, 'capture.json'), JSON.stringify({ captures, errors }, null, 2)); console.log('Evidence parent recovery root:', directory)
}
async function launch(profile) { const child = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child); const ready = await new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); if (message.kind === 'host-error') errors.push(message.code) }); child.once('exit', code => reject(new Error(`remote exited ${code}`))) }); return { child, ready } }
async function terminate(child, signal) { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), 10000); child.once('exit', () => { clearTimeout(timeout); resolve() }); child.kill(signal) }) }
async function until(predicate) { const deadline = Date.now() + 30000; while (!await predicate()) { assert(Date.now() < deadline, `parent recovery timed out: ${errors.slice(-4)}`); await new Promise(resolve => setTimeout(resolve, 30)) } }
