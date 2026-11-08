import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { templateReference } from '../src/spreadsheet-template.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-candidate-recovery-'), owner = { id: 'owner' }
const store = createFileStore(join(directory, 'state.json')); await store.update(seedMultisite)
const attachments = createArtifactService({ store, root: join(directory, 'attachments') }), gateway = createModelGateway({ store, attachments, config: {} }), evidenceService = createSpreadsheetService({ store, attachments, gateway })
const journal = createHostJournal(join(directory, 'host.json')), jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService }), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
const host = createAgentHost({ nodeId: 'local', runtime, jobs, journal }), service = createMultisiteService({ store, attachments, hosts: [host] })
const history = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-04', description: '护栏松动', owner: '陈工' }] }))
const ref = (await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: history.length, sha256: createHash('sha256').update(history).digest('hex') })).ref; await attachments.upload(owner, ref.attachmentId, Readable.from([history]))
await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '恢复同一候选', attachmentRefs: [ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-20' }, clientRequestId: 'work' }); await service.drain()
const execution = (await journal.read()).executions[0], job = await runtime.spreadsheet(execution, 'start_spreadsheet', { clientRequestId: 'job', instructionRevision: 1, template: templateReference(), historyRefs: [ref], rows: [{ sourceRef: ref, entryIndex: 0, dueDate: '2026-11-20', photoRefs: [] }] })
await until(async () => (await jobs.get(execution, { jobId: job.id })).state === 'candidate'); await service.drain()
const original = await jobs.readCandidate(job.id); await service.close()
let forks = 0, runtimeStarts = 0
const recoveredJournal = createHostJournal(join(directory, 'host.json')), recoveredJobs = createSpreadsheetJobs({ journal: recoveredJournal, root: join(directory, 'jobs'), evidenceService, forkImpl() { forks++; throw new Error('must not regenerate') } })
const recoveredRuntime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); recoveredRuntime.supportsAttachments = true
const start = recoveredRuntime.start; recoveredRuntime.start = async execution => { runtimeStarts++; return start(execution) }
const recoveredHost = createAgentHost({ nodeId: 'local', runtime: recoveredRuntime, journal: recoveredJournal, jobs: recoveredJobs }), recoveredService = createMultisiteService({ store, attachments, hosts: [recoveredHost] })
try {
  await recoveredService.drain()
  const state = await store.read(), local = await recoveredJournal.read()
  assert.equal(state.works[0].status, 'running'); assert.equal(local.executions[0].status, 'running')
  assert.equal(local.jobs[0].state, 'candidate'); assert.equal(forks, 0); assert.equal(runtimeStarts, 0, 'existing candidate recovery must not resume inference')
  assert.deepEqual((await recoveredJobs.readCandidate(job.id)).bytes, original.bytes)
  await gateway.authorize(execution)
  console.log(JSON.stringify({ result: 'passed', directory, candidateReused: true, noGeneratorForks: forks, noRuntimeResumes: runtimeStarts, workStatus: state.works[0].status }, null, 2))
} finally { await recoveredService.close() }
async function until(predicate) { const deadline = Date.now() + 15_000; while (!await predicate()) { assert(Date.now() < deadline, 'candidate timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }
