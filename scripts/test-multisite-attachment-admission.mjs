import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createFileStore } from '../src/store/file-store.mjs'
import { createArtifactService } from '../src/artifact-service.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { seedMultisite } from './fixtures/multisite/runtime.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/attachment-admission-'), beforeFix = process.argv.includes('--before-fix')
const store = createFileStore(join(directory, 'state.json')); await store.update(seedMultisite)
const attachments = createArtifactService({ store, root: join(directory, 'attachments') }), gateway = createModelGateway({ store, attachments, config: {} })
const service = createWorkService({ store, multisiteOptions: { hosts: [], attachments } }), owner = { id: 'owner' }, refs = []
try {
  for (let index = 0; index < 9; index++) {
    const bytes = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: `记录${index}`, owner: '张工' }] }))
    const { ref } = await attachments.init(owner, { clientRequestId: `file-${index}`, name: `${index}.json`, mediaType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    await attachments.upload(owner, ref.attachmentId, Readable.from([bytes])); refs.push(ref)
  }
  const work = await service.multisite.apply(owner, 'create', { clientRequestId: 'create', employeeId: 'coordinator', goal: '多次补充资料', attachmentRefs: refs.slice(0, 8) })
  const command = { workId: work.workId, clientRequestId: 'ninth', text: '补第九份资料', attachmentRefs: [refs[8]] }, snapshot = await store.read()
  if (beforeFix) {
    await service.multisite.apply(owner, 'input', command)
    const state = await store.read(), attempt = state.multisite.attempts[0]
    assert.equal(state.multisite.inputs.flatMap(row => row.attachmentRefs).length, 9)
    await assert.rejects(gateway.authorize({ ...attempt, session_id: `geneway-${attempt.launch_id}` }), { code: 'INVALID_REQUEST' })
  } else {
    await assert.rejects(service.multisite.apply(owner, 'input', command), { code: 'INVALID_REQUEST' })
    assert.deepEqual(await store.read(), snapshot)
    await assert.rejects(service.multisite.apply(owner, 'input', command), { code: 'INVALID_REQUEST' })
    const accepted = { ...command, attachmentRefs: [refs[0]] }, receipt = await service.multisite.apply(owner, 'input', accepted)
    assert.deepEqual(await service.multisite.apply(owner, 'input', accepted), receipt)
    assert.equal((await store.read()).works[0].instructionRevision, 2)
    assert.equal((await store.read()).attachments.find(row => row.id === refs[8].attachmentId).workId, null)
    await service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'cancel' })
  }
  const result = { result: 'passed', directory, beforeFix, ...(beforeFix ? { observedAdmission9ThenExecutionRejected: true } : { union8Admission: true, rejectBeforeBindRevisionReceipt: true, sameKeyRollbackThenValidReplay: true, cancelAvailable: true }) }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await service.close() }
