import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { createSpreadsheetTools } from '../packages/agent-host/spreadsheet-tools.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-jobs-'), owner = { id: 'owner' }
const store = createFileStore(join(directory, 'state.json')); await store.update(seedMultisite)
const attachments = createArtifactService({ store, root: join(directory, 'attachments') })
const gateway = createModelGateway({ store, attachments, config: {} }), evidenceService = createSpreadsheetService({ store, attachments, gateway })
const journal = createHostJournal(join(directory, 'host.json')), children = []
let holdNext = false, host, service
const jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService, forkImpl(...args) { const child = fork(...args); children.push(child); if (holdNext) { holdNext = false; child.kill('SIGSTOP') } return child } })
try {
  const history = { format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }, { date: '2026-11-02', description: '护罩松动', owner: '李工' }] }, bytes = Buffer.from(JSON.stringify(history))
  const ref = (await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })).ref
  await attachments.upload(owner, ref.attachmentId, Readable.from([bytes]))
  // This simulator produces only input-consumption facts. Evidence reads and XLSX workers are real.
  const runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
  host = createAgentHost({ nodeId: 'local', runtime, journal, jobs })
  service = createMultisiteService({ store, attachments, hosts: [host] })
  await assert.rejects(service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', targets: ['coordinator', 'worker'], goal: '显式拒多执行员工', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: null }, clientRequestId: 'multi-not-supported' }), { code: 'INVALID_REQUEST' })
  const accepted = await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '按历史记录生成整改表', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: null }, clientRequestId: 'create-sheet' })
  await service.drain()
  let execution = (await journal.read()).executions[0]
  const tools = createSpreadsheetTools((operation, parameters) => runtime.spreadsheet(execution, operation, parameters)), byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  const read = (await byName.geneway_read_evidence.execute({ ref })).result
  assert.equal(read.entries.length, 2); assert.equal(read.spreadsheetRequest.dueDate, null); assert.deepEqual(read.template, templateReference())
  const parameters = { clientRequestId: 'spreadsheet-1', instructionRevision: 1, template: read.template, historyRefs: [ref], rows: history.entries.map((_, entryIndex) => ({ sourceRef: ref, entryIndex, dueDate: '2026-11-15', photoRefs: [] })) }
  await assert.rejects(byName.geneway_start_spreadsheet.execute(parameters), { code: 'MISSING_INPUT' })
  await service.apply(owner, 'input', { workId: accepted.workId, text: '整改期限为11月15日', spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-15' }, clientRequestId: 'deadline' })
  await service.drain(); parameters.instructionRevision = 2
  const started = (await byName.geneway_start_spreadsheet.execute(parameters)).result
  assert.equal(started.state, 'accepted'); assert.equal(started.output, null)
  const replay = (await byName.geneway_start_spreadsheet.execute(parameters)).result; assert.equal(replay.id, started.id)
  await assert.rejects(byName.geneway_start_spreadsheet.execute({ ...parameters, clientRequestId: 'different-id' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(byName.geneway_start_spreadsheet.execute({ ...parameters, rows: parameters.rows.map(row => ({ ...row, dueDate: '2026-11-16' })) }), { code: 'IDEMPOTENCY_CONFLICT' })
  await until(async () => (await jobs.get(execution, { jobId: started.id })).state === 'candidate')
  await service.drain()
  const candidate = (await byName.geneway_get_spreadsheet_job.execute({ jobId: started.id })).result
  assert(candidate.output.sha256); assert.equal(children.length, 1)
  const cloud = await store.read(); assert.equal(cloud.multisite.jobs[0].state, 'candidate'); assert(cloud.multisite.receipts.some(row => row.event.kind === 'spreadsheet_job'))
  assert(cloud.multisite.inputs.find(input => input.revision === 2).deliveries[0].ingestedAt)
  const originalBytes = await readFile((await jobs.readCandidate(started.id)).path)
  await service.apply(owner, 'input', { workId: accepted.workId, text: '将期限修订为11月20日', spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' }, clientRequestId: 'revised-deadline' })
  await service.drain()
  assert.equal((await byName.geneway_start_spreadsheet.execute(parameters)).result.id, started.id, 'old exact request remains idempotent history after revision')
  holdNext = true
  const second = (await byName.geneway_start_spreadsheet.execute({ ...parameters, clientRequestId: 'spreadsheet-2', instructionRevision: 3, rows: parameters.rows.map(row => ({ ...row, dueDate: '2026-11-20' })) })).result
  await until(async () => (await journal.read()).jobs.find(row => row.id === second.id).worker !== null)
  assert.equal(children.length, 2)
  await service.apply(owner, 'cancel', { workId: accepted.workId, clientRequestId: 'stop-generation' }); await service.drain()
  const stopped = await store.read(), local = await journal.read()
  assert.equal(stopped.works[0].status, 'cancelled'); assert.equal(local.jobs.find(row => row.id === second.id).state, 'stopped')
  assert(local.jobs.every(row => row.stopEvidence.workerExit === 'exit_confirmed'))
  assert.equal(children[1].exitCode === null && children[1].signalCode === null, false)
  assert.equal(stopped.works[0].modelRequestBudget.reserved, 0, 'tools do not consume model budget')
  assert.deepEqual(await readFile((await jobs.readCandidate(started.id)).path), originalBytes)
  await assert.rejects(store.update(state => { state.multisite.inputs[0].spreadsheetRequest.dueDate = '2026-11-30'; return state }))
  console.log(JSON.stringify({ result: 'passed', directory, realWorkers: children.length, realXlsxCandidate: true, journalVersion: local.version, nullDeadlineRejected: true, completeScopeAndServerDeadline: true, idempotencyAndSemanticOccupancy: true, inputConsumptionAndJobAtomic: true, oldRevisionHistory: true, runningWorkerStopAndOutputInspection: true, toolsDoNotChargeBudget: true }, null, 2))
} finally { await service?.close(); await jobs.close() }
async function until(predicate) { const deadline = Date.now() + 15_000; while (!await predicate()) { assert(Date.now() < deadline, 'spreadsheet Job journey timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }
