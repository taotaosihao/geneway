import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createNodeBridge } from '../src/node-bridge.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createEvidenceService } from '../src/evidence-service.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createNodeService } from '../src/node-service.mjs'
import { createAuthRuntime } from '../src/auth.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { readHostIdentity } from '../packages/agent-host/identity.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { assertSealed, binding, sameBinding } from '../packages/agent-contracts/index.mjs'
import { processIdentity } from './fixtures/multisite/supervision-process-lifecycle.mjs'

assert.equal(process.argv.length, 2, 'This probe replays only the original OMZHUz Job tail')
const original = '/home/gewu/.codex/task-checkpoints/geneway-evidence/cloud-capacity-OMZHUz'
const directory = await mkdtemp(join(dirname(original), 'cloud-job-history-'))
const apiRoot = join(directory, 'api'), hostRoot = join(directory, 'host')
const owner = await processIdentity(process.pid), actualArgv = (await readFile(`/proc/${process.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
const wire = [], steps = []
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const stage = (name, details = {}) => console.log(JSON.stringify({ stage: name, directory, original, pid: owner.pid, ...details }))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function tree(root, folder = root) {
  const rows = []
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name)
    if (item.isDirectory()) { rows.push(...await tree(root, path)); continue }
    assert(item.isFile(), 'Evidence tree must contain only regular files and directories: ' + path)
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
    rows.push({ path: relative(root, path), bytes, sha256: hash.digest('hex') })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
const previousSources = JSON.parse(await readFile(join(original, 'source-end.json'), 'utf8')).entries.map(row => row.path)
const sourcePaths = [...new Set([...previousSources, 'scripts/probe-cloud-job-history.mjs', 'src/spreadsheet-job-history.mjs'])].sort()
async function source(phase) {
  const entries = []
  for (const path of sourcePaths) { const bytes = await readFile(path), destination = join(directory, 'source-' + phase, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes); entries.push({ path, bytes: bytes.length, sha256: sha(bytes) }) }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), owner, actualArgv, entries }); return entries
}
const workJob = (state, id) => state.multisite.jobs.find(row => row.id === id)
const ackFor = event => ({ event_id: event.event_id, node_id: event.node_id, payload_digest: event.payload_digest, ...binding(event) })
const jsonEvent = event => JSON.stringify(event)
let sourceStart, originalStart, bridge, service, server, origin, result
stage('prepare', { actualArgv, owner })
try {
  sourceStart = await source('start')
  originalStart = await tree(original); await save('original-start.json', originalStart)
  const previous = JSON.parse(await readFile(join(original, 'result.json'), 'utf8'))
  assert.equal(previous.naturalFifoRecovery, false); assert.equal(previous.stillPendingHistoryRows, 2)
  for (const name of ['api', 'host']) {
    await cp(join(original, name), join(directory, name), { recursive: true, force: false, errorOnExist: true })
    assert.deepEqual(await tree(directory, join(directory, name)), originalStart.filter(row => row.path.startsWith(name + '/')))
  }
  const store = createFileStore(join(apiRoot, 'state.json')), journal = createHostJournal(join(hostRoot, 'host-journal.json'))
  const before = await store.read(), hostBefore = await journal.read(), identity = await readHostIdentity(hostRoot)
  const jobId = previous.jobId, cloudJob = workJob(before, jobId)
  assert.equal(cloudJob.sequence, 3); assert.equal(cloudJob.state, 'running')
  assert.equal(before.works.length, 1); assert.equal(before.multisite.jobs.length, 1); assert.equal(before.modelRequests.length, 0); assert.equal(before.artifacts.length, 0)
  const cloudNode = before.nodes.find(row => row.id === identity.nodeId)
  assert(cloudNode); assert.equal(identity.nodeInstanceId, cloudNode.nodeInstanceId); assert.equal(identity.credentialVersion, cloudNode.credentialVersion); assert.equal(identity.registrationRevision, cloudNode.registrationRevision)
  const pending = hostBefore.outbox.filter(row => !row.acknowledged)
  assert.deepEqual(pending.map(row => [row.event.kind, row.event.job?.id, row.event.job?.sequence, row.event.job?.state]), [['spreadsheet_job', jobId, 4, 'stopping'], ['spreadsheet_job', jobId, 5, 'stopped']])
  const originalEvents = pending.map(row => { assertSealed(row.event); assert(sameBinding(row.event, cloudJob)); return row.event })
  const stopped = hostBefore.outbox.find(row => row.acknowledged && row.event.kind === 'stopped' && sameBinding(row.event, cloudJob))
  assert(stopped?.event.job_stop_evidence.some(row => row.jobId === jobId && row.workerExit === 'exit_confirmed'))
  const terminal = before.multisite.receipts.find(row => row.event.event_id === stopped.event.event_id)
  assert(terminal); assert.deepEqual(terminal.event, stopped.event); assert.deepEqual(terminal.ack, ackFor(stopped.event))
  await save('original-tail.json', { cloudJob, pending, terminal, node: { nodeId: identity.nodeId, nodeInstanceId: identity.nodeInstanceId, credentialVersion: identity.credentialVersion, registrationRevision: identity.registrationRevision } })

  const config = readRuntimeConfig({ GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key' }, process.cwd())
  const attachments = createArtifactService({ store, root: join(apiRoot, 'attachments') })
  const gateway = createModelGateway({ store, config, attachments }), nodes = createNodeService({ store })
  const evidence = createEvidenceService({ store, nodes, root: join(apiRoot, 'evidence') })
  const spreadsheetService = createSpreadsheetService({ store, attachments, gateway, evidence })
  const spreadsheetArtifacts = createSpreadsheetArtifacts({ store, attachments, gateway, evidence, root: join(apiRoot, 'artifacts') })
  service = createWorkService({ store, multisiteOptions: { hosts: [], requireRemoteNodes: true, attachments, evidence, spreadsheetArtifacts } })
  bridge = createNodeBridge({ store, nodes, gateway, spreadsheetService, spreadsheetArtifacts, getMultisite: () => service.multisite })
  // Determine the trusted loopback origin before attaching the real server.
  const { createServer } = await import('node:net'), reservation = createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ store, service, nodeBridge: bridge, auth: createAuthRuntime({ filePath: join(apiRoot, 'auth.json') }), trustedOrigin: origin, interactionRuntimeEnabled: false })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  stage('api-ready', { origin, apiPid: process.pid, workId: previous.workId, jobId })
  const client = createRemoteClient({ origin, identity, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname; assert.equal(path, '/internal/spreadsheets/job-events'); assert.equal(options.method, 'POST')
    const response = await fetch(url, options), body = await response.clone().text()
    wire.push({ at: new Date().toISOString(), path, method: options.method, request: options.body, status: response.status, response: body })
    assert(!body.includes(identity.credential)); return response
  } })
  let current = before
  for (const event of originalEvents) {
    const oldSequence = workJob(current, jobId).sequence, expected = ackFor(event)
    const ack = await client.event(event); assert.deepEqual(ack, expected)
    assert.equal(wire.at(-1).status, 200); assert.equal(wire.at(-1).request, JSON.stringify({ event }))
    const next = await store.read(), job = workJob(next, jobId)
    assert.equal(job.sequence, oldSequence + 1); assert.equal(job.sequence, event.job.sequence); assert.equal(job.state, event.job.state)
    assert.equal(next.multisite.receipts.length, current.multisite.receipts.length + 1)
    const receipt = next.multisite.receipts.at(-1); assert.deepEqual(receipt.event, event); assert.deepEqual(receipt.ack, ack)
    await journal.update(state => {
      const row = state.outbox.find(row => row.event.event_id === ack.event_id)
      assert(row && !row.acknowledged); assert.equal(jsonEvent(row.event), jsonEvent(event)); assert.deepEqual(ack, ackFor(row.event)); row.acknowledged = true
    })
    const afterAck = (await journal.read()).outbox.find(row => row.event.event_id === event.event_id)
    assert(afterAck.acknowledged); assert.equal(jsonEvent(afterAck.event), jsonEvent(event))
    steps.push({ eventId: event.event_id, payloadDigest: event.payload_digest, sequenceBefore: oldSequence, job, receipt, acknowledged: afterAck.acknowledged }); current = next
    stage('job-sequence-acked', { sequence: job.sequence, eventId: event.event_id })
  }
  for (const event of originalEvents) { assert.deepEqual(await client.event(event), ackFor(event)); assert.equal(wire.at(-1).request, JSON.stringify({ event })); assert.equal(wire.at(-1).status, 200) }
  assert.deepEqual(await store.read(), current, 'Exact replay changed cloud facts')
  const hostAfter = await journal.read(), expectedHost = structuredClone(hostBefore)
  for (const row of expectedHost.outbox) if (originalEvents.some(event => row.event.event_id === event.event_id)) row.acknowledged = true
  assert.deepEqual(hostAfter, expectedHost, 'Copy Host journal changed beyond the two exact ACK flags')
  const untouchedCloud = structuredClone(current); untouchedCloud.multisite.jobs = before.multisite.jobs; untouchedCloud.multisite.receipts = untouchedCloud.multisite.receipts.slice(0, before.multisite.receipts.length)
  assert.deepEqual(untouchedCloud, before, 'Copy cloud state changed beyond original Job metadata and the two new receipts')
  assert.equal(wire.length, 4)
  result = { result: 'passed', original, directory, origin, workId: previous.workId, jobId, actualSequences: [3, ...steps.map(row => row.job.sequence)], exactReplayNoGrowth: true, originalResultStillPending: previous.stillPendingHistoryRows, effectBoundary: 'Only existing Job metadata and two receipts changed on isolated copy; no new Work, Job, model, Artifact, Host runtime or worker' }
} catch (cause) {
  process.exitCode = 1; await save('failure.json', { code: cause.code, status: cause.status, message: cause.message, stack: cause.stack }); process.stderr.write(cause.stack + '\n')
} finally {
  try {
    bridge?.close(); await service?.multisite.close()
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); await server.closeInteractions() }
    const portReadback = origin && await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) }); socket.once('connect', () => { socket.destroy(); resolve('LISTENING') }); socket.once('error', cause => resolve(cause.code)) })
    await save('cleanup.json', { at: new Date().toISOString(), owner, observed: await processIdentity(process.pid), actualArgv, origin, portReadback, noChildrenSpawned: true }); if (origin) assert.equal(portReadback, 'ECONNREFUSED')
    if (originalStart) { const end = await tree(original); await save('original-end.json', end); assert.deepEqual(end, originalStart, 'Original OMZHUz bytes changed') }
    if (sourceStart) assert.deepEqual(await source('end'), sourceStart, 'Current candidate source changed during probe')
  } catch (cause) { process.exitCode = 1; await save('cleanup-failure.json', { message: cause.message, stack: cause.stack }); process.stderr.write(cause.stack + '\n') }
  await save('node-http.json', wire); await save('sequence-readbacks.json', steps)
  if (result && !process.exitCode) await save('result.json', { ...result, originalBytesUnchanged: true, apiPortClosed: true })
  stage('closed', { origin, exitCode: process.exitCode ?? 0 })
}
