import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
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
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-launch-stop-'), results = []
for (const scenario of ['cancel-during-directory-io', 'revoke-before-fork']) {
  const root = join(directory, scenario), store = createFileStore(join(root, 'state.json')); await store.update(seedMultisite)
  const attachments = createArtifactService({ store, root: join(root, 'attachments') }), gateway = createModelGateway({ store, attachments, config: {} }), evidenceService = createSpreadsheetService({ store, attachments, gateway }), journal = createHostJournal(join(root, 'host.json')), jobRoot = join(root, 'jobs')
  let release, reached, paused = false, forks = 0
  const barrier = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { reached = resolve })
  const jobs = createSpreadsheetJobs({ journal, root: jobRoot, evidenceService, fsOps: { async lstat(path) {
    try { return await lstat(path) } catch (cause) {
      if (!paused && cause.code === 'ENOENT' && dirname(path) === jobRoot) { paused = true; reached(); await barrier }
      throw cause
    }
  } }, forkImpl(...args) { forks++; return fork(...args) } })
  const runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }); runtime.supportsAttachments = true
  const host = createAgentHost({ nodeId: 'local', runtime, journal, jobs }), service = createMultisiteService({ store, attachments, hosts: [host] }), owner = { id: 'owner' }
  try {
    const bytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }] }))
    const file = await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); await attachments.upload(owner, file.id, Readable.from([bytes]))
    const accepted = await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '启动边界', attachmentRefs: [file.ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-15' }, clientRequestId: 'create' }); await service.drain()
    const execution = (await journal.read()).executions[0]
    const job = await runtime.spreadsheet(execution, 'start_spreadsheet', { clientRequestId: 'job', instructionRevision: 1, template: templateReference(), historyRefs: [file.ref], rows: [{ sourceRef: file.ref, entryIndex: 0, dueDate: '2026-11-15', photoRefs: [] }] })
    await entered
    if (scenario === 'revoke-before-fork') {
      await store.update(state => { state.members[0].employeeIds = []; return state }); release()
      await until(async () => (await journal.read()).jobs[0].state === 'failed')
      const denied = (await journal.read()).jobs[0]; assert.equal(denied.launchState, 'never_started'); assert.equal(denied.reason, 'FORBIDDEN'); assert.equal(forks, 0)
      await service.apply(owner, 'cancel', { workId: accepted.workId, clientRequestId: 'cancel' }); await service.drain()
    } else {
      await service.apply(owner, 'cancel', { workId: accepted.workId, clientRequestId: 'cancel' })
      const cancelling = service.drain()
      await until(async () => (await journal.read()).executions[0].status === 'stopping')
      assert.equal(forks, 0); release(); await cancelling
    }
    const state = await store.read(), local = await journal.read()
    assert.equal(forks, 0); assert.equal(state.works[0].status, 'cancelled'); assert.equal(local.jobs[0].state, 'stopped'); assert.equal(local.jobs[0].stopEvidence.workerExit, 'never_started'); assert.equal(local.jobs[0].output, null)
    assert.equal(local.jobs[0].id, job.id)
    results.push({ scenario, forks, workStatus: state.works[0].status, jobStatus: local.jobs[0].state, startEvidence: local.jobs[0].stopEvidence.workerExit })
  } finally { release(); await service.close() }
}
console.log(JSON.stringify({ result: 'passed', directory, results, scheduling: 'real ensureDirectory ENOENT I/O barrier; no sleeps choose the ordering' }, null, 2))
async function until(predicate) { const deadline = Date.now() + 10_000; while (!await predicate()) { assert(Date.now() < deadline, 'launch-stop barrier timed out'); await new Promise(resolve => setTimeout(resolve, 10)) } }
