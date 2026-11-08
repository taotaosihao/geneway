import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { binding, key, seal } from '../packages/agent-contracts/index.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-artifacts-')
const owner = { id: 'owner' }, hash = bytes => createHash('sha256').update(bytes).digest('hex')
const store = createFileStore(join(directory, 'state.json')); await store.update(seedMultisite)
const attachments = createArtifactService({ store, root: join(directory, 'attachments') })
const gateway = createModelGateway({ store, attachments, config: {} })
const evidenceService = createSpreadsheetService({ store, attachments, gateway })
const artifacts = createSpreadsheetArtifacts({ store, attachments, gateway, root: join(directory, 'artifacts') })
const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
runtime.supportsAttachments = true
const jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService })
const host = createAgentHost({ nodeId: 'local', runtime, journal, jobs })
const service = createWorkService({ store, multisiteOptions: { hosts: [host], attachments } })
const authPath = join(directory, 'auth.json')
await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
const server = createGenewayServer({ service, store, attachments, modelGateway: gateway, spreadsheetArtifacts: artifacts, auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: 'http://localhost' })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function request(path, { method = 'GET', body, bytes, token, session, expected = 200 } = {}) {
  const response = await fetch(origin + path, { method, headers: { origin: 'http://localhost', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...(bytes ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) }, body: bytes ?? (body ? JSON.stringify(body) : undefined) })
  const value = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, expected, JSON.stringify(value))
  return { value, headers: response.headers }
}
async function login(name) { const response = await request('/api/session', { method: 'POST', body: { loginName: name, password: `synthetic ${name} password` } }); return { ...response.value, cookie: response.headers.get('set-cookie').split(';')[0] } }
try {
  const session = await login('owner'), peer = await login('peer')
  const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }, { date: '2026-11-02', description: '护罩松动', owner: '李工' }, { date: '2026-11-03', description: '漏油', owner: '张工' }] }))
  const ref = (await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: history.length, sha256: hash(history) })).ref
  await attachments.upload(owner, ref.attachmentId, Readable.from([history]))
  const work = (await request('/api/works', { method: 'POST', session, body: { workType: 'multisite', employeeId: 'coordinator', goal: '生成整改表', clientRequestId: 'sheet-work', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' } } })).value
  await service.multisite.drain()
  const execution = (await journal.read()).executions[0]
  const job = await runtime.spreadsheet(execution, 'start_spreadsheet', { clientRequestId: 'sheet-job', instructionRevision: 1, template: templateReference(), historyRefs: [ref], rows: [0, 1, 2].map(entryIndex => ({ sourceRef: ref, entryIndex, dueDate: '2026-11-20', photoRefs: [] })) })
  await until(async () => (await jobs.get(execution, { jobId: job.id })).state === 'candidate')
  const candidate = await jobs.readCandidate(job.id)
  // Host bytes are real, but the cloud cannot accept them until the sealed receipt is projected.
  await assert.rejects(artifacts.issueUploadToken(candidate.job), { code: 'JOB_PROJECTION_PENDING' })
  await service.multisite.drain()
  const issued = await artifacts.issueUploadToken(candidate.job), token = issued.token
  const declaration = { jobId: job.id, version: 1, sha256: candidate.job.output.sha256, sizeBytes: candidate.bytes.length }
  await request('/internal/artifacts/candidates/init', { method: 'POST', body: declaration, expected: 401 })
  const executionToken = await gateway.issue(execution)
  await request('/internal/artifacts/candidates/init', { method: 'POST', token: executionToken.token, body: declaration, expected: 401 })
  const metadata = (await request('/internal/artifacts/candidates/init', { method: 'POST', token, body: declaration })).value
  assert.equal((await request('/internal/artifacts/candidates/init', { method: 'POST', token, body: declaration })).value.id, metadata.id)
  const path = `/internal/artifacts/candidates/${metadata.id}/content`
  const broken = Buffer.from(candidate.bytes); broken[20] ^= 1
  await request(path, { method: 'PUT', token, bytes: broken, expected: 400 })
  assert.equal((await store.read()).artifacts[0].status, 'pending')
  const ready = (await request(path, { method: 'PUT', token, bytes: candidate.bytes })).value
  assert.equal(ready.status, 'ready')
  assert.equal((await request(path, { method: 'PUT', token, bytes: candidate.bytes })).value.sha256, ready.sha256)
  let state = await store.read(), currentWork = state.works.find(row => row.id === work.id)
  assert.equal(currentWork.status, 'completed'); assert.equal(state.multisite.attempts[0].status, 'completed')
  assert.equal(state.multisite.delegations[0].status, 'completed'); assert.equal(currentWork.artifactRefs[0].sha256, ready.sha256)
  assert(state.multisite.outbox.some(row => row.command.operation === 'settle'))
  await assert.rejects(gateway.issue(execution), { code: 'FORBIDDEN' })
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session, body: { text: 'late', clientRequestId: 'late-input' }, expected: 409 })
  await request(`/api/works/${work.id}/multisite/cancel`, { method: 'POST', session, body: { clientRequestId: 'late-cancel' }, expected: 409 })
  for (const [kind, extra] of [['started', {}], ['runtime_unavailable', { reason: 'late' }], ['report', { report: { state: 'waiting', summary: 'late', question: 'late?' } }]]) {
    const source = state.multisite.receipts.find(row => row.event.kind === 'started').event
    const { payload_digest, ...body } = source
    await service.multisite.acceptHostEvent({ workspaceId: 'local', nodeId: 'local' }, seal({ ...body, event_id: key('late', kind), kind, ...extra }))
  }
  assert.equal((await store.read()).works[0].status, 'completed')
  // Settlement retains completed business state even when execution authority is revoked.
  await store.update(state => { state.members[0].employeeIds = []; return state })
  await service.multisite.drain()
  assert.equal((await journal.read()).executions[0].status, 'settled')
  assert((await store.read()).multisite.attempts[0].settledAt)
  await request(`/api/works/${work.id}/artifacts/${ready.id}/content`, { session, expected: 403 })
  await store.update(state => { state.members[0].employeeIds = ['coordinator', 'worker']; return state })
  await request(`/api/works/${work.id}/artifacts/${ready.id}/content`, { session: peer, expected: 404 })
  const download = await request(`/api/works/${work.id}/artifacts/${ready.id}/content`, { session })
  assert.equal(hash(download.value), ready.sha256); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.match(download.headers.get('cache-control'), /no-store/)
  const book = new ExcelJS.Workbook(); await book.xlsx.load(download.value); const sheet = book.worksheets[0]
  assert.equal(sheet.rowCount, 6); assert.equal(sheet.getCell('D3').value, '张工'); assert.equal(sheet.getCell('E3').value, '2026-11-20'); assert.equal(sheet.getCell('F3').value, 2); assert.equal(sheet.getCell('F5').value, 1); assert.equal(sheet.getCell('B6').value, 3)
  const reopened = createSpreadsheetArtifacts({ store: createFileStore(join(directory, 'state.json')), attachments, gateway, root: join(directory, 'artifacts') })
  assert.equal(hash((await reopened.download(owner, work.id, ready.id)).bytes), ready.sha256)
  console.log(JSON.stringify({ result: 'passed', directory, realWorkerHttpCandidate: true, independentOriginalBytesVerification: true, atomicReadyCompletedSettle: true, completedTerminalLateEvents: true, settlementAfterRevocation: true, downloadHashBusinessOracle: true, crossUserDenied: true }, null, 2))
} finally { await service.close(); await new Promise(resolve => server.close(resolve)) }
async function until(predicate) { const deadline = Date.now() + 15_000; while (!await predicate()) { assert(Date.now() < deadline, 'candidate timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }
