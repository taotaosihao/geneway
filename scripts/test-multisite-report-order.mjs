import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime, seedMultisite } from './fixtures/multisite/runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'geneway-report-order-'))
try {
  const store = createFileStore(join(root, 'cloud.json')); await store.update(seedMultisite)
  const runtime = createSimulatedRuntime({ path: join(root, 'sessions.json'), consume: false })
  const host = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(root, 'host.json')), runtime })
  const service = createMultisiteService({ store, hosts: [host] })
  await service.apply({ id: 'owner' }, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '日期未提供时追问', clientRequestId: 'ordering' })
  await service.drain()
  const attempt = (await store.read()).multisite.attempts[0]
  assert.equal(attempt.observed_revision, 0)
  await runtime.consumeAll() // The real producer formed a user/message, between delivery and the next dispatcher scan.
  await runtime.report(attempt.launch_id, { state: 'waiting', summary: '需要日期', question: '日期是什么？' })
  await service.drain()
  const observed = await store.read()
  assert.equal(observed.works[0].status, 'waiting_input')
  assert.equal(observed.multisite.attempts[0].observed_revision, 1)
  const kinds = observed.multisite.receipts.map(row => row.event.kind)
  assert(kinds.indexOf('session_ingested') < kinds.indexOf('report'))
  console.log('Multisite report ordering passed: real producer history between dispatch scans is calibrated durably before accepting its structured question')
} finally { await rm(root, { recursive: true, force: true }) }
