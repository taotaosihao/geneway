import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileStore } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'geneway-multisite-recovery-'))
const actor = { id: 'owner' }
const command = (id, targets) => ({ workType: 'multisite', employeeId: 'coordinator', goal: id, targets, clientRequestId: id })
try {
  for (const consume of [true, false]) {
    const path = join(root, `cancel-${consume}`), store = createFileStore(path + '-cloud.json'); await store.update(seedMultisite)
    const runtime = createSimulatedRuntime({ path: path + '-sessions.json', consume })
    const host = createAgentHost({ nodeId: 'local', journal: createHostJournal(path + '-host.json'), runtime })
    const service = createMultisiteService({ store, hosts: [host] })
    const created = await service.apply(actor, 'create', command('cancel-' + consume))
    if (!consume) await service.drain()
    const startsBefore = runtime.starts()
    await service.apply(actor, 'cancel', { workId: created.workId, clientRequestId: 'stop' })
    await service.drain()
    assert.equal((await store.read()).works[0].status, 'cancelled', 'stop before start / pending delivery must finish')
    assert.equal(runtime.starts(), startsBefore, 'cancel may never create a new Loop')
    await service.apply(actor, 'cancel', { workId: created.workId, clientRequestId: 'stop-again' }); await service.drain()
    assert.equal((await store.read()).works[0].status, 'cancelled', 'a new cancel ID cannot reopen terminal state')
  }
  const store = createFileStore(join(root, 'resume-cloud.json')); await store.update(seedMultisite)
  const sessionPath = join(root, 'resume-sessions.json'), journalPath = join(root, 'resume-host.json')
  const initial = createSimulatedRuntime({ path: sessionPath })
  const first = createAgentHost({ nodeId: 'local', journal: createHostJournal(journalPath), runtime: initial })
  const service = createMultisiteService({ store, hosts: [first] })
  await service.apply(actor, 'create', command('resume'))
  await service.drain()
  const resumed = createSimulatedRuntime({ path: sessionPath })
  const second = createAgentHost({ nodeId: 'local', journal: createHostJournal(journalPath), runtime: resumed })
  await createMultisiteService({ store, hosts: [second] }).drain()
  assert.equal(resumed.resumes(), 1, 'all ingested inputs must not prevent resuming the active Session')
  assert.equal(resumed.messageCount(), 1, 'resume does not redeliver consumed input')
  assert.equal((await store.read()).works[0].status, 'interrupted', 'loaded Session is not proof that an unsettled Loop resumed')
  assert.equal((await store.read()).multisite.attempts[0].unavailableReason, 'RECOVERY_EXECUTION_UNCONFIRMED')

  const isolated = createFileStore(join(root, 'isolated-cloud.json')); await isolated.update(seedMultisite)
  const active = createSimulatedRuntime({ path: join(root, 'isolated-sessions.json') })
  const isolatedHost = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(root, 'isolated-host.json')), runtime: active })
  const dispatch = createMultisiteService({ store: isolated, hosts: [isolatedHost] })
  await dispatch.apply(actor, 'create', command('blocked-target', ['coordinator']))
  await dispatch.apply(actor, 'create', { ...command('allowed-target', ['worker']), employeeId: 'worker' })
  await isolated.update(state => { state.employees[0].enabled = false; return state })
  await dispatch.drain()
  assert.equal(active.starts(), 1, 'one revoked item cannot starve another authorized Work')
  const observed = await isolated.read()
  assert.equal(observed.multisite.outbox[0].blockedReason, 'FORBIDDEN')
  assert.equal(observed.multisite.inputs[1].deliveries[0].ingestedAt !== null, true)

  const rootStore = createFileStore(join(root, 'root-cloud.json')); await rootStore.update(seedMultisite)
  const rootRuntime = createSimulatedRuntime({ path: join(root, 'root-sessions.json') })
  const rootHost = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(root, 'root-host.json')), runtime: rootRuntime })
  const rootService = createMultisiteService({ store: rootStore, hosts: [rootHost] })
  await rootService.apply(actor, 'create', command('root-revoked', ['worker']))
  await rootStore.update(state => { state.members[0].employeeIds = ['worker']; return state })
  await rootService.drain()
  assert.equal(rootRuntime.starts(), 0, 'target permission cannot replace root coordinator permission')
  await isolated.update(state => { state.members[0].employeeIds = []; return state })
  await dispatch.apply(actor, 'cancel', { workId: observed.works[1].id, clientRequestId: 'stop-revoked' }); await dispatch.drain()
  assert.equal((await isolated.read()).works[1].status, 'cancelled', 'owner may stop after root/target revocation')
  console.log('Multisite recovery passed: cancel before start and before pending delivery; same-Session load without reinjection and unsettled Loop explicitly unknown; target/root revocation and per-item dispatch isolation')
} finally { await rm(root, { recursive: true, force: true }) }
