import { fork } from 'node:child_process'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createFileStore } from '../../../src/store/file-store.mjs'
import { createArtifactService } from '../../../src/artifact-service.mjs'
import { createModelGateway } from '../../../src/model-gateway.mjs'
import { createSpreadsheetService } from '../../../src/spreadsheet-service.mjs'
import { templateReference } from '../../../src/spreadsheet-template.mjs'
import { createMultisiteService } from '../../../packages/agent-orchestration/service.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { createAgentHost } from '../../../packages/agent-host/host.mjs'
import { createSpreadsheetJobs } from '../../../packages/agent-host/spreadsheet-jobs.mjs'
import { seedMultisite, createSimulatedRuntime } from './runtime.mjs'
process.once('message', async ({ directory, mode }) => {
  const store = createFileStore(join(directory, 'state.json')); await store.update(seedMultisite)
  const attachments = createArtifactService({ store, root: join(directory, 'attachments') }), gateway = createModelGateway({ store, attachments, config: {} }), evidenceService = createSpreadsheetService({ store, attachments, gateway }), journal = createHostJournal(join(directory, 'host.json'))
  const history = { format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }] }, bytes = Buffer.from(JSON.stringify(history)), owner = { id: 'owner' }
  const item = await attachments.init(owner, { clientRequestId: 'history', name: 'history.json', mediaType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); await attachments.upload(owner, item.id, Readable.from([bytes]))
  const jobs = createSpreadsheetJobs({ journal, root: join(directory, 'jobs'), evidenceService, forkImpl(...args) { const child = fork(...args); if (mode === 'running') child.kill('SIGSTOP'); return child } })
  const runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); runtime.supportsAttachments = true
  const host = createAgentHost({ nodeId: 'local', runtime, journal, jobs }), service = createMultisiteService({ store, attachments, hosts: [host] })
  await service.apply(owner, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: 'Job恢复校准', attachmentRefs: [item.ref], spreadsheetRequest: { templateId: 'incident-register-v1', dueDate: '2026-11-15' }, clientRequestId: 'create' }); await service.drain()
  const execution = (await journal.read()).executions[0], parameters = { clientRequestId: 'job', instructionRevision: 1, template: templateReference(), historyRefs: [item.ref], rows: [{ sourceRef: item.ref, entryIndex: 0, dueDate: '2026-11-15', photoRefs: [] }] }
  const job = await runtime.spreadsheet(execution, 'start_spreadsheet', parameters)
  const deadline = Date.now() + 15_000
  while (true) {
    const current = (await journal.read()).jobs.find(row => row.id === job.id)
    if (mode === 'candidate' ? current.state === 'candidate' : current.worker !== null) { process.send({ kind: 'ready', execution, parameters, jobId: current.id, output: current.output, worker: current.worker }); break }
    if (Date.now() > deadline) throw new Error('Job producer timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
})
process.on('disconnect', () => process.exit(1))
