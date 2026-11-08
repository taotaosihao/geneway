import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { verifyIncidentSpreadsheet } from '../src/spreadsheet-verification.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'

const directory = await fs.mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-completion-races-')
const owner = { id: 'owner' }, results = [], hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const mode of ['revision', 'stop', 'revoke', 'question', 'unknown', 'pending-model', 'write', 'fsync', 'rename', 'dirSync'].filter(mode => !process.argv[2] || mode === process.argv[2])) {
  const root = join(directory, mode), statePath = join(root, 'state.json')
  let commitEntered, releaseCommit, providerResponse, modelDone
  const commitEntry = new Promise(resolve => { commitEntered = resolve }), commitBarrier = new Promise(resolve => { releaseCommit = resolve })
  let armed = false, finalWrite = false, renamed = false, failureHit = false, entered, release
  const barrierEntered = new Promise(resolve => { entered = resolve }), barrier = new Promise(resolve => { release = resolve })
  const fault = () => { failureHit = true; armed = false; throw Object.assign(new Error(`synthetic final ${mode}`), { code: 'EIO' }) }
  const store = createFileStore(statePath, {
    async open(path, ...args) {
      const handle = await fs.open(path, ...args), originalWrite = handle.writeFile.bind(handle), originalSync = handle.sync.bind(handle)
      handle.writeFile = async (...values) => { if (mode === 'unknown' && JSON.parse(String(values[0])).artifacts.some(row => row.status === 'ready')) { commitEntered(); await commitBarrier } if (armed && JSON.parse(String(values[0])).artifacts.some(row => row.status === 'ready')) { finalWrite = true; if (mode === 'write') fault() }; return originalWrite(...values) }
      handle.sync = async () => { if (armed && mode === 'fsync' && finalWrite && path !== dirname(statePath)) fault(); if (armed && mode === 'dirSync' && renamed && path === dirname(statePath)) fault(); return originalSync() }
      return handle
    },
    async rename(from, to) { if (armed && finalWrite && mode === 'rename') fault(); await fs.rename(from, to); if (armed && finalWrite) renamed = true },
  })
  await store.update(seedMultisite)
  await fs.mkdir(join(root, 'secrets')); await fs.writeFile(join(root, 'secrets/model.key'), 'synthetic-race-provider', { mode: 0o600 })
  const config = readRuntimeConfig({ GENEWAY_STATE: statePath, GENEWAY_SECRET_ROOT: join(root, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key' }, process.cwd())
  let upstreamEntered
  const upstreamEntry = new Promise(resolve => { upstreamEntered = resolve })
  const provider = createServer(async (request, response) => { for await (const chunk of request) {} providerResponse = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"flying"},"finish_reason":null}]}\n\n'); upstreamEntered() }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const attachments = createArtifactService({ store, root: join(root, 'attachments') }), gateway = createModelGateway({ store, attachments, config, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }), evidenceService = createSpreadsheetService({ store, attachments, gateway })
  const artifacts = createSpreadsheetArtifacts({ store, attachments, gateway, root: join(root, 'artifacts'), verification: async (bytes, requirements) => { const result = await verifyIncidentSpreadsheet(bytes, requirements); entered(); await barrier; return result } })
  const journal = createHostJournal(join(root, 'host.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }); runtime.supportsAttachments = true
  const jobs = createSpreadsheetJobs({ journal, root: join(root, 'jobs'), evidenceService }), host = createAgentHost({ nodeId: 'local', runtime, journal, jobs }), service = createMultisiteService({ store, attachments, hosts: [host] })
  const server = createServer(async (request, response) => { if (await gateway.handle(request, response, new URL(request.url, 'http://localhost'))) return; if (!await artifacts.handle(request, response, new URL(request.url, 'http://localhost'))) { response.writeHead(404); response.end() } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-02', description: '安全门松动', owner: '赵工' }] }))
    const ref = (await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: history.length, sha256: hash(history) })).ref; await attachments.upload(owner, ref.attachmentId, Readable.from([history]))
    const created = await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '核验并交付整改表', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-18' }, clientRequestId: 'create' }); await service.drain()
    const execution = (await journal.read()).executions[0], job = await runtime.spreadsheet(execution, 'start_spreadsheet', { clientRequestId: 'job', instructionRevision: 1, template: templateReference(), historyRefs: [ref], rows: [{ sourceRef: ref, entryIndex: 0, dueDate: '2026-11-18', photoRefs: [] }] })
    await until(async () => (await jobs.get(execution, { jobId: job.id })).state === 'candidate'); await service.drain()
    const candidate = await jobs.readCandidate(job.id), issued = await artifacts.issueUploadToken(candidate.job), headers = { authorization: `Bearer ${issued.token}` }
    const init = await fetch(origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, version: 1, sha256: hash(candidate.bytes), sizeBytes: candidate.bytes.length }) }); assert.equal(init.status, 200); const metadata = await init.json()
    if (['unknown', 'pending-model'].includes(mode)) {
      const issuedModel = await gateway.issue(execution, { request: true, inputMessageId: messageId((await store.read()).multisite.inputs[0].id, execution.attempt_id, execution.session_id) })
      modelDone = fetch(origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${issuedModel.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'flying stream' }] }) }).then(response => response.text()).catch(() => {})
      await upstreamEntry
    }
    const uploading = fetch(origin + `/internal/artifacts/candidates/${metadata.id}/content`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: candidate.bytes })
    await barrierEntered
    if (mode === 'revision') await service.apply(owner, 'input', { workId: created.workId, text: '修订期限', spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-25' }, clientRequestId: 'revision' })
    else if (mode === 'stop') await service.apply(owner, 'cancel', { workId: created.workId, clientRequestId: 'cancel' })
    else if (mode === 'revoke') await store.update(state => { state.members[0].employeeIds = []; return state })
    else if (mode === 'question') { await runtime.report(execution.launch_id, { state: 'waiting', summary: '还需核对', question: '请确认现场范围' }); await service.drain() }
    else if (!['unknown', 'pending-model'].includes(mode)) armed = true
    release()
    if (mode === 'unknown') {
      // The old active-map exemption enters final metadata I/O; the persistent gate denies first.
      const boundary = await Promise.race([commitEntry.then(() => 'final-write'), uploading.then(() => 'denied')])
      providerResponse.destroy(); await modelDone; releaseCommit()
      assert.equal(boundary, 'denied', 'unknown request must not enter final ready metadata write')
    }
    const response = await uploading, payload = await response.json()
    assert.equal(response.status, ['write', 'fsync', 'rename', 'dirSync'].includes(mode) ? 503 : ['revoke', 'stop'].includes(mode) ? 403 : 409, JSON.stringify(payload))
    if (mode === 'pending-model') {
      assert.equal((await store.read()).artifacts[0].status, 'candidate')
      const published = await fs.stat(join(root, 'artifacts', metadata.id))
      providerResponse.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); await modelDone
      assert.equal((await store.read()).modelRequests[0].outcome, 'completed')
      const repeatedInit = await fetch(origin + '/internal/artifacts/candidates/init', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, version: 1, sha256: hash(candidate.bytes), sizeBytes: candidate.bytes.length }) })
      const existing = await repeatedInit.json(); assert.equal(existing.id, metadata.id); assert.equal(existing.status, 'candidate')
      const verified = await fetch(origin + `/internal/artifacts/candidates/${metadata.id}/verify`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(verified.status, 200); assert.equal((await verified.json()).status, 'ready')
      assert.equal((await fs.stat(join(root, 'artifacts', metadata.id))).ino, published.ino, 'verification resumes the original candidate without another PUT')
    }
    const reopened = await createFileStore(statePath).read(), artifact = reopened.artifacts.find(row => row.id === metadata.id), work = reopened.works.find(row => row.id === created.workId)
    if (mode === 'unknown') { assert.equal(reopened.modelRequests[0].outcome, 'unknown'); await assert.rejects(artifacts.verifyAndComplete(metadata.id), { code: 'RUNTIME_REQUEST_UNKNOWN' }) }
    if (['dirSync', 'pending-model'].includes(mode)) { if (mode === 'dirSync') assert(failureHit); assert.equal(artifact.status, 'ready'); assert.equal(work.status, 'completed'); assert(reopened.multisite.outbox.some(row => row.command.operation === 'settle')) }
    else { assert.equal(artifact.status, 'candidate'); assert.notEqual(work.status, 'completed'); assert.equal(work.artifactRefs, undefined); assert(!reopened.multisite.outbox.some(row => row.command.operation === 'settle')); if (armed || ['write', 'fsync', 'rename'].includes(mode)) assert(failureHit) }
    results.push({ mode, httpStatus: response.status, ready: artifact.status === 'ready', workStatus: work.status, failureHit })
  } finally { release(); releaseCommit(); providerResponse?.destroy(); await modelDone; provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await service.close().catch(() => {}); await new Promise(resolve => server.close(resolve)) }
}
console.log(JSON.stringify({ result: 'passed', directory, results, preRenameNoReadyOrSettle: true, postRenameNoSuccessAckAndAtomicReadback: true }, null, 2))
async function until(predicate) { const deadline = Date.now() + 15_000; while (!await predicate()) { assert(Date.now() < deadline, 'worker candidate timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }
