import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { assertSealed, digest } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { startReofferProxy } from './fixtures/multisite/supervision-reoffer-proxy.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/supervision-reoffer-')
const children = [], captures = [], errors = [], shutdown = [], sourceHashes = {}
let api, remote, watchdog, provider, proxy, apiReady, hostReady
const observeToken = randomBytes(32).toString('hex'), recoverToken = randomBytes(32).toString('hex')
const apiRoot = join(directory, 'api'), remoteRoot = join(directory, 'remote'), watchRoot = join(directory, 'watchdog')
const sourceFiles = ['src/server.mjs', 'src/node-bridge.mjs', 'src/supervision-service.mjs', 'src/supervision-watchdog.mjs', 'src/supervision-state.mjs', 'packages/agent-host/remote.mjs', 'scripts/probe-supervision-reoffer.mjs', 'scripts/fixtures/multisite/supervision-reoffer-service.mjs', 'scripts/fixtures/multisite/supervision-reoffer-proxy.mjs']
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert(!errors.length, JSON.stringify(errors)); assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 30)) }
}
function spawn(relative, args = []) {
  const child = fork(fileURLToPath(new URL(relative, import.meta.url)), args, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.label = relative; child.stdoutParts = []; child.stderrParts = []; children.push(child)
  child.stdout.on('data', bytes => child.stdoutParts.push(bytes)); child.stderr.on('data', bytes => child.stderrParts.push(bytes))
  child.on('message', message => { if (message.kind === 'host-error' || message.kind === 'error') errors.push({ process: relative, code: message.code, ...(message.stack ? { stack: message.stack } : {}) }) })
  return child
}
function ready(child) { return new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); else if (message.kind === 'error' || message.kind === 'host-error') reject(new Error(message.code)) }); child.once('error', reject); child.once('exit', code => reject(new Error('Child exited before ready: ' + code))) }) }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited
}
async function cloud() { return JSON.parse(await readFile(apiReady.stateFile, 'utf8')) }
async function local() { return JSON.parse(await readFile(join(remoteRoot, 'host-journal.json'), 'utf8')) }
async function observe() { const response = await fetch(apiReady.origin + '/internal/supervision/snapshot', { headers: { authorization: 'Bearer ' + observeToken } }); assert.equal(response.status, 200); return response.json() }
async function recover(body) { const response = await fetch(apiReady.origin + '/internal/supervision/reoffer', { method: 'POST', headers: { authorization: 'Bearer ' + recoverToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json() }
async function nativeEvents(sessionId) {
  for (const entry of await readdir(join(remoteRoot, 'multisite-executions'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const root = join(remoteRoot, 'multisite-executions', entry.name, 'dsh', 'sessions')
    let scopes; try { scopes = await readdir(root) } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause }
    for (const scope of scopes) {
      let bytes; try { bytes = await readFile(join(root, scope, sessionId, 'session.v4.jsonl.zstd')) } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause }
      const events = []
      for (let offset = 0; offset < bytes.length;) {
        const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true }); assert(decoded.engine.bytesWritten > 0)
        offset += decoded.engine.bytesWritten
        events.push(...decoded.buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
      }
      return events
    }
  }
  return []
}
console.log(JSON.stringify({ stage: 'starting', directory, pid: process.pid }))
try {
  await mkdir(join(directory, 'sources'), { recursive: true })
  for (const path of sourceFiles) { const bytes = await readFile(path); sourceHashes[path] = digest(bytes.toString('utf8')); await writeFile(join(directory, 'sources', path.replaceAll('/', '__')), bytes) }
  await writeFile(join(directory, 'source-hashes.json'), JSON.stringify(sourceHashes, null, 2))
  provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); captures.push({ at: new Date().toISOString(), body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ id: 'supervision-local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '已收到这次受控监督验收输入。' }, finish_reason: null }] }) + '\n\n')
      response.end('data: ' + JSON.stringify({ id: 'supervision-local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } catch (cause) { errors.push({ stage: 'provider', code: cause.code, message: cause.message }); response.destroy() }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  api = spawn('./fixtures/multisite/supervision-reoffer-service.mjs'); const apiStarted = ready(api)
  api.send({ directory: apiRoot, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, supervisionIdentities: [{ id: 'reoffer-observe', token: observeToken, role: 'observe', workspaceId: 'local', nodeIds: ['cloud'] }, { id: 'reoffer-recover', token: recoverToken, role: 'recover', workspaceId: 'local', nodeIds: ['cloud'] }] })
  apiReady = await apiStarted
  let heldAck; const firstAckHeld = new Promise(resolve => { heldAck = resolve })
  proxy = await startReofferProxy({ upstreamOrigin: apiReady.origin, holdTokensUntilReoffer: true, onHeldAck: heldAck, onError: cause => errors.push({ stage: 'proxy', code: cause.code, message: cause.message }) })
  const login = await fetch(apiReady.origin + '/api/session', { method: 'POST', headers: { origin: apiReady.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  assert.equal(login.status, 200); const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function user(path, body) { const response = await fetch(apiReady.origin + path, { method: 'POST', headers: { origin: apiReady.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result }
  const pairing = await user('/api/admin/nodes/pairings', { clientRequestId: 'supervision-pair', nodeId: 'cloud', siteId: 'synthetic-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  await mkdir(remoteRoot, { recursive: true, mode: 0o700 }); const profile = join(remoteRoot, 'profile.json')
  await writeFile(profile, JSON.stringify({ root: remoteRoot, origin: proxy.origin, pairing: { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode }, maxActiveLoops: 1 }), { mode: 0o600 })
  remote = spawn('../packages/agent-host/remote.mjs', [profile]); hostReady = await ready(remote)
  await until(() => proxy.traffic.some(row => row.path === '/internal/bridge/events' && row.method === 'GET' && row.status === 200), 'Production remote must open a live SSE')
  const baselineResyncs = proxy.traffic.filter(row => row.path === '/internal/bridge/resync').length
  console.log(JSON.stringify({ stage: 'live', directory, apiPid: api.pid, remotePid: remote.pid, origin: apiReady.origin, proxyOrigin: proxy.origin }))
  const work = await user('/api/works', { clientRequestId: 'supervision-work', workType: 'multisite', employeeId: 'coordinator', goal: '受控监督验收：同一合法命令重供不重复消费原输入。' })
  const ack = await firstAckHeld, before = await cloud(), inboxBefore = await local(), original = before.multisite.outbox.find(row => row.id === ack.commandId)
  assert(original); assertSealed(original.command); assert.equal(original.acceptedAt, null)
  assert.equal(inboxBefore.inbox.filter(row => row.command.command_id === ack.commandId).length, 1)
  assert.equal(before.modelRequests.length, 0)
  const pendingSnapshot = await observe(), pending = pendingSnapshot.pendingCommands.find(row => row.commandId === ack.commandId)
  assert(pending?.sent && pending.generation && pending.nodeInstanceId); assert.equal(pending.payloadDigest, original.command.payload_digest)
  await writeFile(join(directory, 'held-before-api.json'), JSON.stringify({ cloud: before, local: inboxBefore, snapshot: pendingSnapshot, traffic: proxy.traffic, frames: proxy.frames }, null, 2))
  const credentials = join(directory, 'credentials'); await mkdir(credentials, { mode: 0o700 })
  const credentialFile = join(credentials, 'observe'), recoveryCredentialFile = join(credentials, 'recover')
  await writeFile(credentialFile, observeToken, { mode: 0o600 }); await writeFile(recoveryCredentialFile, recoverToken, { mode: 0o600 })
  const watchConfig = join(directory, 'watchdog-config.json')
  await writeFile(watchConfig, JSON.stringify({ origin: apiReady.origin, credentialFile, recoveryCredentialFile, root: watchRoot, intervalMs: 50, timeoutMs: 1200, stageDeadlineMs: 120000, commandDeadlineMs: 1, scope: { workId: work.id, attemptId: pending.binding.attempt_id, nodeId: 'cloud', nodeInstanceId: hostReady.nodeInstanceId }, processes: [] }), { mode: 0o600 })
  watchdog = spawn('../src/supervision-watchdog.mjs', [watchConfig])
  console.log(JSON.stringify({ stage: 'watchdog-live-ack-held', directory, watchdogPid: watchdog.pid, commandId: ack.commandId }))
  await until(async () => { const state = await cloud(); return proxy.frames.filter(row => row.commandId === ack.commandId).length === 2 && state.multisite.outbox.find(row => row.id === ack.commandId)?.acceptedAt && captures.length === 1 && state.modelRequests.length === 1 && state.modelRequests[0].outcome === 'completed' }, 'Same-stream reoffer and the original native model turn must finish')
  await until(() => proxy.traffic.filter(row => row.path === '/internal/bridge/acks' && row.ack.commandId === ack.commandId && row.status === 200).length === 2, 'Both transport ACKs must return exact production acknowledgments')
  const after = await cloud(), journal = await local(), attempt = after.multisite.attempts.find(row => row.work_id === work.id), input = after.multisite.inputs.find(row => row.workId === work.id)
  const expectedMessageId = messageId(input.id, attempt.attempt_id, attempt.session_id)
  let native; await until(async () => { native = await nativeEvents(attempt.session_id); return native.some(row => row.type === 'user/message' && row.data.id === expectedMessageId) }, 'Native SDK must flush the original stable user message')
  assert.equal(native.filter(row => row.type === 'user/message' && row.data.id === expectedMessageId).length, 1)
  assert.equal(native.filter(row => row.type === 'user/message').length, 1)
  assert.equal(captures[0].body.messages.filter(row => row.role === 'user').length, 1)
  assert.equal(journal.inbox.filter(row => row.command.command_id === ack.commandId).length, 1)
  assert.deepEqual(journal.inbox.find(row => row.command.command_id === ack.commandId).command, original.command)
  assert.equal(after.multisite.attempts.length, 1); assert.equal(after.supervisionActions.length, 1)
  const frames = proxy.frames.filter(row => row.commandId === ack.commandId)
  assert.equal(new Set(frames.map(row => row.stream)).size, 1); assert(frames.every(row => row.payloadDigest === original.command.payload_digest))
  assert.equal(proxy.traffic.filter(row => row.path === '/internal/bridge/events' && row.method === 'GET').length, 1)
  assert.equal(proxy.traffic.filter(row => row.path === '/internal/bridge/resync').length, baselineResyncs)
  assert(proxy.events.some(row => row.kind === 'ack-released' && row.reason === 'second-same-stream-wire-frame'))
  const held = proxy.events.find(row => row.kind === 'ack-held-before-api'), released = proxy.events.find(row => row.reason === 'second-same-stream-wire-frame')
  assert(Date.parse(released.at) - Date.parse(held.at) < 8000)
  const ackRows = proxy.traffic.filter(row => row.path === '/internal/bridge/acks' && row.ack.commandId === ack.commandId)
  assert.deepEqual(ackRows[0].ack, ackRows[1].ack)
  const acceptedAt = after.multisite.outbox.find(row => row.id === ack.commandId).acceptedAt
  await until(async () => { try { const state = JSON.parse(await readFile(join(watchRoot, 'watchdog-state.json'), 'utf8')); return state.episodes.some(row => row.finding.classification === 'COMMAND_UNACKNOWLEDGED' && row.actionAttemptedAt && row.action) } catch (cause) { if (cause.code === 'ENOENT') return false; throw cause } }, 'Watchdog must persist its actual recovery receipt')
  await stop(watchdog)
  const watchBeforeRestart = JSON.parse(await readFile(join(watchRoot, 'watchdog-state.json'), 'utf8')), episode = watchBeforeRestart.episodes.find(row => row.finding.factRefs.includes(ack.commandId)), sampleAt = watchBeforeRestart.sampledAt
  watchdog = spawn('../src/supervision-watchdog.mjs', [watchConfig])
  await until(async () => JSON.parse(await readFile(join(watchRoot, 'watchdog-state.json'), 'utf8')).sampledAt !== sampleAt, 'Restarted independent watchdog must really sample')
  await stop(watchdog)
  const watchAfterRestart = JSON.parse(await readFile(join(watchRoot, 'watchdog-state.json'), 'utf8'))
  assert.equal(watchAfterRestart.episodes.filter(row => row.finding.factRefs.includes(ack.commandId)).length, 1)
  assert.equal(watchAfterRestart.episodes.find(row => row.id === episode.id).actionAttemptedAt, episode.actionAttemptedAt)
  const repeatBody = { episodeId: episode.id, commandId: ack.commandId, payloadDigest: pending.payloadDigest, generation: pending.generation, nodeInstanceId: pending.nodeInstanceId }
  const acknowledgedNoop = await recover(repeatBody), generationNoop = await recover({ ...repeatBody, generation: randomUUID() })
  assert.equal(acknowledgedNoop.offered, false); assert.equal(generationNoop.offered, false)
  const final = await cloud()
  assert.equal(final.supervisionActions.length, 1); assert.equal(final.supervisionFindings.filter(row => row.classification === 'COMMAND_UNACKNOWLEDGED').length, 1)
  assert.equal(final.multisite.outbox.find(row => row.id === ack.commandId).acceptedAt, acceptedAt)
  assert.equal(proxy.frames.filter(row => row.commandId === ack.commandId).length, 2); assert.equal(captures.length, 1)
  await writeFile(join(directory, 'after-reoffer.json'), JSON.stringify({ cloud: final, local: journal, nativeUserMessages: native.filter(row => row.type === 'user/message'), watchBeforeRestart, watchAfterRestart, acknowledgedNoop, generationNoop, traffic: proxy.traffic, frames: proxy.frames, events: proxy.events }, null, 2))
  await user('/api/works/' + work.id + '/multisite/cancel', { clientRequestId: 'supervision-cleanup' })
  await until(async () => (await cloud()).works.find(row => row.id === work.id).status === 'cancelled', 'Own native execution must close through real cancellation')
  assert.equal(captures.length, 1); assert.deepEqual(errors, [])
  const result = { result: 'passed', directory, workId: work.id, commandId: ack.commandId, generation: pending.generation, nodeInstanceId: pending.nodeInstanceId, sameStreamFrames: 2, durableInboxRows: 1, nativeSDKUserMessages: 1, actualModelRequests: 1, transportACKs: 2, acceptedAtStable: true, watchdogRestarts: 1, boundedActions: 1, noReconnectDuringReoffer: true, sourceHashes, boundary: 'isolated actual API/remote Node/native DSH/watchdog OS processes; synthetic local provider; initialization token transport held until second same-stream frame so the recovery covers an unconsumed ordinary pending command, never an unknown model retry; mismatching-generation and already-ACKed no-ops only, other admission exclusions covered by the separate contract lane; no installation/deployment or physical multi-machine claim' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack, errors, frames: proxy?.frames, events: proxy?.events, traffic: proxy?.traffic }, null, 2)); throw cause
} finally {
  proxy?.releaseHeldAck()
  for (const child of [...children].reverse()) { await stop(child); shutdown.push({ label: child.label, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }); await writeFile(join(directory, 'process-' + child.pid + '.stdout.txt'), Buffer.concat(child.stdoutParts)); await writeFile(join(directory, 'process-' + child.pid + '.stderr.txt'), Buffer.concat(child.stderrParts)) }
  await proxy?.close()
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  const finalHashes = {}; for (const path of sourceFiles) finalHashes[path] = digest(await readFile(path, 'utf8'))
  await writeFile(join(directory, 'source-final-hashes.json'), JSON.stringify(finalHashes, null, 2))
  await writeFile(join(directory, 'provider-requests.json'), JSON.stringify(captures, null, 2)); await writeFile(join(directory, 'errors.json'), JSON.stringify(errors, null, 2)); await writeFile(join(directory, 'shutdown.json'), JSON.stringify(shutdown, null, 2))
  console.log(JSON.stringify({ stage: 'closed', directory, children: shutdown }))
}
