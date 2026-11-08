import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, open, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as reservePort, connect } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createNodeService } from '../src/node-service.mjs'
import { createNodeBridge } from '../src/node-bridge.mjs'
import { createEvidenceService } from '../src/evidence-service.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { cloudCapacityStatus } from '../src/cloud-capacity.mjs'
import { CLOUD_CAPACITY_LIMITS } from '../src/cloud-capacity-measure.mjs'
import { binding, key, seal, sameBinding } from '../packages/agent-contracts/index.mjs'
import { assignmentEvent } from '../packages/agent-orchestration/assignments.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { processIdentity, startChild, signalOwned } from './fixtures/multisite/supervision-process-lifecycle.mjs'

assert.equal(process.argv.length, 2, 'This probe has one bounded normal capacity scenario; no modes')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/cloud-capacity-')
const apiRoot = join(directory, 'api'), hostRoot = join(directory, 'host'), stateFile = join(apiRoot, 'state.json')
const nodeId = 'capacity-office-node', owner = { id: 'owner' }, children = [], facts = [], errors = [], ownerWire = [], apiLifecycles = []
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), jsonBytes = value => Buffer.byteLength(JSON.stringify(value))
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let server, service, bridge, store, attachments, origin, actor, host, worker, sourceStart, apiGeneration = 0
async function stage(name, details = {}) { console.log(JSON.stringify({ stage: name, directory, pid: process.pid, origin, apiGeneration, hostPid: host?.child.pid, workerPid: worker?.pid, ...details })) }
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  for (;;) { const value = await predicate(); if (value) return value; assert(Date.now() < deadline, label + ' timed out'); await delay(500) }
}
async function files(root) { const result = []; for (const item of await readdir(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) result.push(...await files(path)); else if (item.name.endsWith('.mjs')) result.push(path) }; return result }
const sourcePaths = [...new Set(['scripts/probe-cloud-capacity.mjs', 'scripts/fixtures/multisite/cloud-capacity-host.mjs', 'scripts/fixtures/multisite/delegation.mjs', 'scripts/fixtures/multisite/runtime.mjs', 'scripts/fixtures/multisite/supervision-process-lifecycle.mjs', 'config/multisite-runtime.patch.yml', 'package.json', 'pnpm-lock.yaml', ...await files('src'), ...await files('packages/agent-contracts'), ...await files('packages/agent-host'), ...await files('packages/agent-orchestration')])].sort()
async function source(phase) {
  const entries = []
  for (const path of sourcePaths) { const bytes = await readFile(path), target = join(directory, 'source-' + phase, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); entries.push({ path, bytes: bytes.length, sha256: sha(bytes) }) }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), owner: await processIdentity(process.pid), argv: process.argv, entries }); return entries
}
function rpc(operation, parameters = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), listener = message => { if (message.id !== id) return; clearTimeout(timer); host.child.off('message', listener); message.failure ? reject(Object.assign(Error(message.failure.message), message.failure)) : resolve(message.value) }
    const timer = setTimeout(() => { host.child.off('message', listener); reject(Error('Fixture RPC timed out: ' + operation)) }, 20000)
    host.child.on('message', listener); host.child.send({ id, operation, ...parameters })
  })
}
const snapshot = () => rpc('snapshot')
async function user(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { origin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json(); ownerWire.push({ at: new Date().toISOString(), path, method, request: body, status: response.status, response: path === '/api/admin/nodes/pairings' ? { ...value, pairingCode: '[redacted]' } : value })
  assert.equal(response.status, 200, JSON.stringify(value)); return value
}
async function startApi() {
  store = createFileStore(stateFile)
  const config = readRuntimeConfig({ GENEWAY_STATE: stateFile, GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key' }, process.cwd())
  attachments = createArtifactService({ store, root: join(apiRoot, 'attachments') })
  const gateway = createModelGateway({ store, config, attachments }), nodes = createNodeService({ store, onRevoke: id => bridge?.revoke(id) })
  const evidence = createEvidenceService({ store, nodes, root: join(apiRoot, 'evidence') })
  const spreadsheetService = createSpreadsheetService({ store, attachments, gateway, evidence }), spreadsheetArtifacts = createSpreadsheetArtifacts({ store, attachments, gateway, evidence, root: join(apiRoot, 'artifacts') })
  service = createWorkService({ store, multisiteOptions: { hosts: [], attachments, evidence, spreadsheetArtifacts, requireRemoteNodes: true } })
  bridge = createNodeBridge({ store, nodes, gateway, spreadsheetService, spreadsheetArtifacts, getMultisite: () => service.multisite, scanIntervalMs: 100 })
  server = createGenewayServer({ store, service, nodeService: nodes, nodeBridge: bridge, evidence, attachments, modelGateway: gateway, spreadsheetArtifacts, auth: createAuthRuntime({ filePath: join(apiRoot, 'auth.json') }), trustedOrigin: origin, interactionRuntimeEnabled: false })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(origin).port), '127.0.0.1', resolve) }); bridge.start()
  apiGeneration++; apiLifecycles.push({ kind: 'start', at: new Date().toISOString(), generation: apiGeneration, origin, owner: await processIdentity(process.pid), boundary: 'Production API factory remounted in the same probe OS process; no API child-process restart claimed' })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic capacity owner password' }) })
  assert.equal(login.status, 200); actor = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  await stage('api-ready')
}
async function stopApi() {
  if (!server) return
  bridge.close(); await service.close(); await server.closeInteractions()
  server.closeAllConnections(); await new Promise((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve()))
  // Flush the old Store serial queue before any offline fixture preparation.
  await store.read(); apiLifecycles.push({ kind: 'closed', at: new Date().toISOString(), generation: apiGeneration, origin, owner: await processIdentity(process.pid) }); server = undefined
}
async function durableReplace(bytes) {
  const temp = stateFile + '.fixture-new', file = await open(temp, 'w', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  await rename(temp, stateFile); const parent = await open(apiRoot, 'r'); try { await parent.sync() } finally { await parent.close() }
}
async function prepareSyntheticHistory(baseline, template) {
  const candidate = structuredClone(baseline), initial = cloudCapacityStatus(candidate)
  assert.equal(initial.state, 'available'); assert.equal(Object.keys(initial.tables).length, 14)
  const filler = [], targetHeadroom = 4096, ceiling = CLOUD_CAPACITY_LIMITS.historyBytes - targetHeadroom
  let projected = initial.remaining.historyBytes
  const createRow = (index, size) => {
    const report = { state: 'blocked', summary: ('synthetic-near-cap-' + index + ':').padEnd(size, '\0') }
    const commandId = key('report', template.event.launch_id, template.event.input_id, JSON.stringify(report))
    // Offline synthetic input, never described as a Host-produced report: real
    // Host.report would set observed_revision=1. The stale synthetic revision
    // keeps assignmentEvent historical without replacing actual Attempt.report.
    const { payload_digest, ...body } = template.event
    const event = seal({ ...body, event_id: key('event', nodeId, commandId, 'report'), observed_revision: 0, report })
    return { nodeId, event, historical: true, ack: { event_id: event.event_id, node_id: nodeId, payload_digest: event.payload_digest, ...binding(event) } }
  }
  while (true) {
    const row = createRow(filler.length, 4000), bytes = jsonBytes(row)
    if (projected + bytes > ceiling) break
    candidate.multisite.receipts.push(row); filler.push({ eventId: row.event.event_id, payloadDigest: row.event.payload_digest, bytes }); projected += bytes
  }
  let low = 80, high = 4000, tail
  while (low <= high) { const size = Math.floor((low + high) / 2), row = createRow(filler.length, size); if (projected + jsonBytes(row) <= ceiling) { tail = row; low = size + 1 } else high = size - 1 }
  if (tail) { candidate.multisite.receipts.push(tail); filler.push({ eventId: tail.event.event_id, payloadDigest: tail.event.payload_digest, bytes: jsonBytes(tail) }); projected += jsonBytes(tail) }
  // Production transition confirms stale classification; no synthetic projection
  // changes persist. The entire tree then crosses the production schema once.
  const scratch = structuredClone(baseline), originalAttempt = structuredClone(scratch.multisite.attempts)
  for (const row of candidate.multisite.receipts.slice(baseline.multisite.receipts.length)) assert.equal(assignmentEvent(scratch, row.event, new Date().toISOString()).historical, true)
  assert.deepEqual(scratch.multisite.attempts, originalAttempt)
  const validated = migrateState(candidate), status = cloudCapacityStatus(validated)
  assert.equal(status.state, 'available'); assert.equal(status.remaining.historyBytes, projected)
  const headroom = CLOUD_CAPACITY_LIMITS.historyBytes - status.remaining.historyBytes
  assert(headroom >= 1 && headroom <= 20000)
  const stripped = structuredClone(validated); stripped.multisite.receipts.splice(baseline.multisite.receipts.length); assert.deepEqual(stripped, baseline)
  const bytes = Buffer.from(JSON.stringify(validated, null, 2) + '\n')
  await save('synthetic-precondition.json', { qualification: 'Isolated offline near-cap fixture, not natural business history and not actual Host-produced reports', filler, initial, status, headroom, compactRowBytes: filler.reduce((sum, row) => sum + row.bytes, 0), persistedFileBytes: bytes.length, persistedFileSha256: sha(bytes), realBaselinePrefixPreserved: true })
  await durableReplace(bytes); return { filler, status }
}

await stage('prepare', { argv: process.argv, owner: await processIdentity(process.pid) })
try {
  sourceStart = await source('start')
  await mkdir(join(apiRoot, 'secrets'), { recursive: true, mode: 0o700 }); await mkdir(hostRoot, { mode: 0o700 })
  await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-unused-capacity-model-credential', { mode: 0o600 })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic capacity owner password', peer: 'synthetic capacity peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  store = createFileStore(stateFile)
  await store.update(state => { seedDelegation(state); state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; for (const employee of state.employees) { employee.skillIds = ['cycle']; employee.placement.nodeId = employee.id === 'desktop-office' ? nodeId : 'unused-' + employee.id; employee.placement.resourceRefs = [] }; return state })
  const port = reservePort(); await new Promise(resolve => port.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + port.address().port; await new Promise(resolve => port.close(resolve))
  await startApi()
  const pairing = await user('/api/admin/nodes/pairings', { clientRequestId: 'capacity-pair-b', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const configFile = join(hostRoot, 'profile.json'); await writeFile(configFile, JSON.stringify({ root: hostRoot, origin, pairing }), { mode: 0o600 })
  host = await startChild({ path: fileURLToPath(new URL('./fixtures/multisite/cloud-capacity-host.mjs', import.meta.url)), args: [configFile], env: { PATH: process.env.PATH, HOME: hostRoot }, directory, name: 'office-host', facts }); children.push(host)
  host.exit = new Promise(resolve => host.child.once('exit', (code, signal) => resolve({ code, signal }))); host.closed = new Promise(resolve => host.child.once('close', resolve)); const messages = []
  host.child.on('message', message => { messages.push(message); if (['host-error', 'pump-error'].includes(message.kind)) errors.push({ at: new Date().toISOString(), ...message }) })
  const ready = await until(() => messages.find(row => row.kind === 'ready'), 'paired Host ready')
  const bytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '容量验收原历史', owner: '张工' }] }))
  const ref = (await attachments.init(owner, { clientRequestId: 'capacity-history', name: 'history.json', mediaType: 'application/json', sizeBytes: bytes.length, sha256: sha(bytes) })).ref
  await attachments.upload(owner, ref.attachmentId, Readable.from([bytes]))
  const created = await user('/api/works', { workType: 'multisite', employeeId: 'desktop-office', clientRequestId: 'capacity-real-b', goal: '云普通回报容量被拒时，真实停止一个已准备的整改表 worker。', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } }), workId = created.id
  assert(workId)
  const execution = await until(async () => (await snapshot()).executions.find(row => row.work_id === workId && row.runtimeStarted && row.status === 'running' && row.observed_revision === 1), 'actual started and Input consumed')
  await rpc('report', { workId, report: { state: 'blocked', summary: '真实 baseline：等待受控容量验收。' } }); await rpc('pump')
  const template = await until(async () => (await store.read()).multisite.receipts.find(row => row.event.kind === 'report' && row.event.work_id === workId), 'real baseline report ACK')
  assert.equal(template.historical, false)
  const job = await rpc('spreadsheet', { workId, parameters: { clientRequestId: 'capacity-one-row-job', instructionRevision: 1, template: templateReference(), historyRefs: [ref], rows: [{ sourceRef: ref, entryIndex: 0, dueDate: '2026-11-20', photoRefs: [] }] } })
  await until(async () => { const local = await snapshot(), row = local.jobs.find(item => item.id === job.id); if (row?.state !== 'running' || !row.worker) return false; worker = await processIdentity(row.worker.pid); return worker && ['T', 't'].includes(worker.state) }, 'real worker SIGSTOP barrier')
  await rpc('pump'); await rpc('pausePump')
  const localBefore = await snapshot(), before = await store.read()
  assert(before.multisite.jobs.some(row => row.id === job.id && row.state === 'running')); assert.equal(before.modelRequests.length, 0)
  await save('baseline.json', { cloud: before, local: localBefore, template, execution, job, host: await processIdentity(host.child.pid), worker, ready, capacity: cloudCapacityStatus(before) })
  await stage('baseline-live-worker')
  await rpc('report', { workId, report: { state: 'blocked', summary: '\0'.repeat(4000) } })
  const queued = await snapshot(), ordinary = queued.outbox.find(row => !row.acknowledged && row.event.kind === 'report' && row.event.report.summary === '\0'.repeat(4000))
  assert(ordinary)
  // Owner REST has a 64KiB whole-body limit. Establish the real short-key cancel
  // before the offline near-cap fixture; do not claim real near-cap admission of
  // an owner command or bypass REST with an unreachable maximum-size key.
  const cancelled = await user('/api/works/' + workId + '/multisite/cancel', { clientRequestId: 'capacity-effective-owner-cancel' }), stopping = await store.read()
  assert.equal(stopping.works.find(row => row.id === workId).status, 'stopping'); assert(!stopping.multisite.receipts.some(row => row.event.kind === 'stopped'))
  const cancelRow = stopping.multisite.outbox.find(row => row.command.operation === 'cancel' && row.command.work_id === workId); assert(cancelRow)
  assert.equal((await processIdentity(worker.pid)).startTicks, worker.startTicks)
  await save('cancel-stopping.json', { qualification: 'Real owner cancel accepted before the synthetic capacity precondition; Host transport paused and worker still live', cancelled, cloud: stopping, local: await snapshot(), worker: await processIdentity(worker.pid), capacity: cloudCapacityStatus(stopping) })
  await stopApi(); const originalBytes = await readFile(stateFile); await writeFile(join(directory, 'original-precondition-state.json'), originalBytes, { mode: 0o600 })
  const baseline = migrateState(JSON.parse(originalBytes)), prepared = await prepareSyntheticHistory(baseline, template)
  assert.equal(baseline.version, 31)
  assert.equal((await processIdentity(host.child.pid)).startTicks, host.identity.startTicks); assert.equal((await processIdentity(worker.pid)).startTicks, worker.startTicks)
  await startApi()
  const reopened = await store.read(); assert.deepEqual(reopened.nodes, baseline.nodes); assert.deepEqual(reopened.multisite.attempts, baseline.multisite.attempts)
  await stage('near-cap-api-reopened', { fillerRows: prepared.filler.length, remaining: CLOUD_CAPACITY_LIMITS.historyBytes - prepared.status.remaining.historyBytes })
  await assert.rejects(rpc('flush'), cause => cause.status === 409 && cause.code === 'CAPACITY_EXCEEDED' && cause.capacity?.domain === 'cloud' && cause.capacity.queue === 'ordinary' && cause.capacity.reason === 'history_bytes')
  const rejected = await store.read(); assert.deepEqual(rejected, reopened); assert(!(await snapshot()).outbox.find(row => row.event.event_id === ordinary.event.event_id).acknowledged)
  await save('ordinary-rejected.json', { event: ordinary.event, cloud: rejected, local: await snapshot(), capacity: cloudCapacityStatus(rejected), parent: await processIdentity(host.child.pid), worker: await processIdentity(worker.pid) })
  // Keep the timer paused: one real pump must preserve the ordinary FIFO head
  // while sending its newly sealed stop proof through the production priority.
  const stopPump = await rpc('pump'), localStopped = await snapshot(), cloudStopped = await store.read()
  assert.equal(stopPump.error?.code, 'CAPACITY_EXCEEDED'); assert.equal(stopPump.error?.capacity?.domain, 'cloud'); assert.equal(stopPump.error?.capacity?.reason, 'history_bytes')
  const proof = localStopped.outbox.find(row => row.event.kind === 'stopped' && row.event.work_id === workId), receipt = proof && cloudStopped.multisite.receipts.find(row => row.event.event_id === proof.event.event_id)
  assert(proof?.acknowledged && receipt); assert.deepEqual(receipt.event, proof.event); assert.deepEqual(receipt.ack, { event_id: proof.event.event_id, node_id: nodeId, payload_digest: proof.event.payload_digest, ...binding(proof.event) }); assert.equal(receipt.historical, false)
  assert.equal(cloudStopped.works.find(row => row.id === workId).status, 'cancelled'); assert.equal(localStopped.executions.find(row => sameBinding(row, execution)).slotHeld, false)
  const stoppedJob = localStopped.jobs.find(row => row.id === job.id); assert.equal(stoppedJob.state, 'stopped'); assert.equal(stoppedJob.stopEvidence.workerExit, 'exit_confirmed'); assert.equal(stoppedJob.stopEvidence.output, 'no_published_output')
  const workerAfter = await processIdentity(worker.pid); assert(!workerAfter || workerAfter.startTicks !== worker.startTicks || workerAfter.state === 'Z')
  assert.equal(localStopped.outbox.find(row => row.event.event_id === ordinary.event.event_id).acknowledged, false); assert(!cloudStopped.multisite.receipts.some(row => row.event.event_id === ordinary.event.event_id))
  const unacknowledgedJobs = localStopped.outbox.filter(row => !row.acknowledged && row.event.kind === 'spreadsheet_job'); assert(unacknowledgedJobs.length > 0)
  await save('proof-priority.json', { cloud: cloudStopped, local: localStopped, stopPump, proof, receipt, unacknowledgedJobEventIds: unacknowledgedJobs.map(row => row.event.event_id), workerAfter, capacity: cloudCapacityStatus(cloudStopped), distinction: 'Execution truly stopped and terminal proof ACKed; ordinary and Job sequence history still pending at this cut' })
  const beforeReplayCount = cloudStopped.multisite.receipts.length, repeated = await rpc('sendEvent', { event: proof.event }); assert.deepEqual(repeated, receipt.ack); assert.equal((await store.read()).multisite.receipts.length, beforeReplayCount)
  // No filler deletion or cap reset. Released closing obligations may naturally
  // permit the original FIFO to drain; otherwise pending history is retained.
  const fifoPump = await rpc('pump'), finalLocal = await snapshot(), final = await store.read()
  const oldPending = localStopped.outbox.filter(row => !row.acknowledged), remaining = oldPending.filter(row => !finalLocal.outbox.find(current => current.event.event_id === row.event.event_id)?.acknowledged)
  for (const row of oldPending) {
    const localRow = finalLocal.outbox.find(current => current.event.event_id === row.event.event_id); assert.deepEqual(localRow.event, row.event)
    const receipts = final.multisite.receipts.filter(current => current.event.event_id === row.event.event_id); assert(receipts.length <= 1)
    if (localRow.acknowledged) { assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].event, row.event) }
  }
  assert.equal(final.works.length, 1); assert.equal(final.artifacts.length, 0); assert.equal(final.modelRequests.length, 0)
  const fillerIds = new Set(prepared.filler.map(row => row.eventId))
  assert.equal(final.multisite.receipts.filter(row => fillerIds.has(row.event.event_id)).length, prepared.filler.length)
  const wireRows = (await readFile(join(hostRoot, 'node-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const rejectedWire = wireRows.find(row => row.request?.event?.event_id === ordinary.event.event_id && row.status === 409)
  const proofWire = wireRows.find(row => row.request?.event?.event_id === proof.event.event_id && row.status === 200)
  assert(rejectedWire && proofWire); assert(wireRows.indexOf(rejectedWire) < wireRows.indexOf(proofWire))
  await save('final.json', { cloud: final, local: finalLocal, fifoPump, remainingHistoryEventIds: remaining.map(row => row.event.event_id), capacity: cloudCapacityStatus(final), cloudJobState: final.multisite.jobs.find(row => row.id === job.id)?.state ?? 'not_registered', workerAfter: await processIdentity(worker.pid) })
  await save('result.json', { result: 'passed', directory, workId, jobId: job.id, syntheticFillerRows: prepared.filler.length, actualOrdinaryHttp409: true, ownerCancelAcceptedBeforeSyntheticPressure: true, ownerCancelUnderSyntheticPressure: 'Not exercised by this real HTTP window; existing closing obligation only', actualWorkerExitAndTerminalProofACK: true, originalOrdinaryAndJobRowsRetainedAtProofCut: true, exactProofReplayNoGrowth: true, naturalFifoRecovery: remaining.length === 0, stillPendingHistoryRows: remaining.length, boundary: 'Real production API factories / FileStore gate / NodeHTTP / paired Host and OS Office worker; Agent inference is HostSim and near-cap receipts are explicit offline synthetic precondition, not natural history. No model, DSH, billing, multi-day or cold-store claim.' })
  await stage('passed', { pendingHistory: remaining.length })
} catch (cause) { process.exitCode = 1; await save('failure.json', { message: cause.message, stack: cause.stack, code: cause.code, capacity: cause.capacity, errors }); process.stderr.write(cause.stack + '\n') }
finally {
  if (host && host.child.exitCode === null && host.child.signalCode === null) {
    await rpc('pausePump').catch(cause => errors.push({ stage: 'cleanup-pause', message: cause.message }))
    await signalOwned(host, 'SIGTERM', facts).catch(cause => errors.push({ stage: 'cleanup-term', message: cause.message }))
    let timer; try { await Promise.race([host.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned Host TERM grace expired')), 15000) })]) }
    catch (cause) { facts.push({ kind: 'cleanup-fallback', reason: cause.message }); await signalOwned(host, 'SIGKILL', facts); await host.exit }
    finally { clearTimeout(timer) }; await host.closed
  }
  if (worker) { const actual = await processIdentity(worker.pid); if (actual && actual.startTicks === worker.startTicks && actual.state !== 'Z') { facts.push({ kind: 'failed-run-owned-worker-cleanup', identity: actual }); process.kill(actual.pid, 'SIGKILL'); await until(async () => { const current = await processIdentity(actual.pid); return !current || current.startTicks !== actual.startTicks || current.state === 'Z' }, 'owned worker OS cleanup', 10000) } }
  await stopApi()
  for (const item of children) facts.push({ kind: 'final-os', name: item.name, original: item.identity, actual: await processIdentity(item.identity.pid) })
  if (worker) facts.push({ kind: 'worker-final-os', original: worker, actual: await processIdentity(worker.pid) })
  if (origin) { const result = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) }); socket.once('connect', () => { socket.destroy(); resolve('LISTENING') }); socket.once('error', cause => resolve(cause.code)) }); await save('port-readback.json', { at: new Date().toISOString(), origin, result }); assert.notEqual(result, 'LISTENING') }
  await save('processes.json', facts); await save('api-lifecycles.json', apiLifecycles); await save('owner-http.json', ownerWire); await save('errors.json', errors)
  if (sourceStart) assert.deepEqual(await source('end'), sourceStart, 'Captured source changed during run')
  await stage('closed', { exitCode: process.exitCode ?? 0 })
}
