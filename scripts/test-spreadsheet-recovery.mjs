import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSpreadsheetJobs } from '../packages/agent-host/spreadsheet-jobs.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-recovery-'), results = []
for (const mode of ['candidate', 'running', 'proc-exit', 'proc-still-live']) {
  const root = join(directory, mode), child = fork(fileURLToPath(new URL('./fixtures/multisite/spreadsheet-recovery-producer.mjs', import.meta.url)), [], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] })
  const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message) }); child.once('exit', code => reject(new Error(`producer died ${code}`))) })
  child.send({ directory: root, mode: mode === 'candidate' ? 'candidate' : 'running' })
  const produced = await ready, exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
  const store = createFileStore(join(root, 'state.json')), attachments = createArtifactService({ store, root: join(root, 'attachments') }), gateway = createModelGateway({ store, attachments, config: {} }), evidenceService = createSpreadsheetService({ store, attachments, gateway }), journal = createHostJournal(join(root, 'host.json'))
  let forks = 0, procWindowHits = 0
  const jobs = createSpreadsheetJobs({ journal, root: join(root, 'jobs'), evidenceService, fsOps: { async readlink(path) {
    if (mode.startsWith('proc-') && procWindowHits++ === 0) {
      if (mode === 'proc-exit') {
        process.kill(produced.worker.pid, 'SIGKILL')
        while (true) { const stat = await readFile(`/proc/${produced.worker.pid}/stat`, 'utf8').catch(cause => { if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause; return '' }); if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break; await new Promise(resolve => setTimeout(resolve, 5)) }
      }
      throw Object.assign(new Error('controlled proc identity window'), { code: 'ENOENT' })
    }
    return (await import('node:fs/promises')).readlink(path)
  } }, forkImpl() { forks++; throw new Error('recovery must not rerun') } })
  await jobs.process()
  const recovered = await jobs.get(produced.execution, { jobId: produced.jobId })
  assert.equal(forks, 0)
  if (mode === 'candidate') {
    assert.equal(recovered.state, 'candidate'); assert.deepEqual(recovered.output, produced.output); await jobs.readCandidate(produced.jobId)
  } else {
    assert.equal(recovered.state, 'unknown'); assert.equal(recovered.reason, mode === 'proc-still-live' ? 'ENOENT' : 'SPREADSHEET_EXECUTION_UNCONFIRMED'); assert.equal(recovered.output, null)
    const stat = await readFile(`/proc/${produced.worker.pid}/stat`, 'utf8').catch(cause => { if (cause.code !== 'ENOENT') throw cause; return '' }); if (mode !== 'proc-still-live') assert(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '))
    assert.equal((await jobs.start(produced.execution, produced.parameters)).id, produced.jobId)
    await assert.rejects(jobs.start(produced.execution, { ...produced.parameters, clientRequestId: 'new-key' }), { code: 'IDEMPOTENCY_CONFLICT' })
    await jobs.stopExecution(produced.execution); assert.equal((await journal.read()).jobs[0].state, 'stopped')
  }
  if (mode.startsWith('proc-')) assert(procWindowHits > 0)
  results.push({ mode, procWindowHits, recoveredState: recovered.state, newGeneratorWorkers: forks, originalWorkerQuiesced: true }); await jobs.close()
}
const source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/images-native-3bkjaJ'
const oldState = JSON.parse(await readFile(join(source, 'state.json'), 'utf8')); assert.equal(oldState.version, 15)
const migrated = migrateState(oldState); assert.equal(migrated.version, STATE_VERSION); assert.deepEqual(migrated.modelRequests, oldState.modelRequests); assert.deepEqual(migrated.modelImageVariants, oldState.modelImageVariants); assert.deepEqual(migrated.attachments, oldState.attachments); assert.deepEqual(migrated.multisite.receipts, oldState.multisite.receipts); assert.deepEqual(migrated.works, oldState.works)
const oldJournal = JSON.parse(await readFile(join(source, 'multisite-host-local.json'), 'utf8')); assert.equal(oldJournal.version, 1)
await writeFile(join(directory, 'host-v1-copy.json'), JSON.stringify(oldJournal)); const upgraded = await createHostJournal(join(directory, 'host-v1-copy.json')).read(); assert.equal(upgraded.version, 3); assert.deepEqual(upgraded.jobs, []); assert.deepEqual(upgraded.captures, []); for (const field of ['inbox','executions','outbox']) assert.deepEqual(upgraded[field], oldJournal[field])
console.log(JSON.stringify({ result: 'passed', directory, results, actualGv15ProducerMigration: true, actualHostV1ProducerMigration: true }, null, 2))
