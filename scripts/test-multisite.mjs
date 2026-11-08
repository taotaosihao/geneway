import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, open as fsOpen, rename as fsRename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { seal } from '../packages/agent-contracts/index.mjs'
import { createSimulatedRuntime, seedMultisite } from './fixtures/multisite/runtime.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-multisite-'))
const owner = { id: 'owner' }, create = id => ({ workType: 'multisite', employeeId: 'coordinator', goal: '整理模拟现场异常，缺资料时提问', targets: ['coordinator', 'worker'], clientRequestId: id })
try {
  const store = createFileStore(join(root, 'state.json'))
  await store.update(seedMultisite)
  const journal = createHostJournal(join(root, 'host.json')), controls = {}
  const runtime = createSimulatedRuntime({ path: join(root, 'sessions.json'), controls })
  const host = createAgentHost({ nodeId: 'local', journal, runtime })
  const service = createWorkService({ store, multisiteOptions: { hosts: [host], kick() { throw new Error('lost kick') } } })
  await service.ensureReady()
  const accepted = await service.createMultisite(owner, create('create-one')), workId = accepted.value.id
  const committed = await store.read()
  assert.equal(committed.multisite.outbox.length, 2)
  assert.equal(runtime.starts(), 0, 'creation must not dispatch before commit')
  assert.equal(committed.multisite.commands.length, 1)
  const replay = await service.createMultisite(owner, create('create-one'))
  assert.equal(replay.value.id, workId)
  await assert.rejects(service.createMultisite(owner, { ...create('create-one'), goal: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(service.createMultisite({ id: 'peer' }, create('create-one')), { code: 'FORBIDDEN' })
  await service.multisite.drain()
  assert.equal(runtime.starts(), 2)
  assert.equal(runtime.messageCount(), 2)
  const running = await store.read()
  assert.equal(running.works[0].status, 'running')
  assert(running.multisite.inputs[0].deliveries.every(row => row.deliveredAt && row.ingestedAt))
  assert.equal(running.multisite.receipts.length, 6)
  assert(running.multisite.attempts.every(row => row.observed_revision === 1))
  await service.multisite.drain()
  assert.equal(runtime.messageCount(), 2)
  const first = running.multisite.attempts[0]
  await runtime.report(first.launch_id, { state: 'waiting', summary: '缺少异常日期', question: '异常发生在哪一天？' })
  await host.flushEvents(event => service.multisite.acceptHostEvent({ workspaceId: 'local', nodeId: 'local' }, event))
  assert.equal((await store.read()).works[0].status, 'waiting_input')
  await service.multisite.apply(owner, 'input', { workId, text: '2026-11-05', clientRequestId: 'answer-one' })
  await service.multisite.drain()
  assert.equal(runtime.messageCount(), 4)
  assert((await store.read()).multisite.attempts.every(row => row.observed_revision === 2))
  const current = await store.read()
  const event = current.multisite.receipts.find(row => row.event.kind === 'started').event
  const oldEvent = seal({ ...Object.fromEntries(Object.entries(event).filter(([field]) => field !== 'payload_digest')), event_id: 'stale-launch', launch_id: 'old-launch' })
  await service.multisite.acceptHostEvent({ workspaceId: 'local', nodeId: 'local' }, oldEvent)
  assert.deepEqual((await store.read()).multisite.attempts, current.multisite.attempts)
  assert.equal((await store.read()).multisite.receipts.at(-1).historical, true)
  await assert.rejects(service.multisite.acceptHostEvent({ workspaceId: 'local', nodeId: 'forged' }, event), { code: 'FORBIDDEN' })
  const legacy = createWorkService({ store })
  await legacy.ensureReady()
  assert.equal((await store.read()).works[0].status, 'running', 'legacy recovery cannot interrupt remote Work')
  await legacy.close()
  assert.equal((await store.read()).works[0].status, 'running')
  await service.multisite.apply(owner, 'cancel', { workId, clientRequestId: 'cancel-one' })
  assert.equal((await store.read()).works[0].status, 'stopping')
  await service.multisite.drain()
  assert.equal((await store.read()).works[0].status, 'cancelled')
  await assert.rejects(service.multisite.apply(owner, 'input', { workId, text: 'restart', clientRequestId: 'after-stop' }), { code: 'INVALID_STATE' })
  await service.close()

  await cloudFailures()
  await hostFailures()
  console.log('Multisite checks passed: producer-backed commit/outbox, replay/conflict, independent targets, delivered/ingested, structured question/input, old launch isolation, recovery, durable stop, cloud write/fsync/rename/dirSync faults, Host flush/history calibration and exact event ACK (local simulator only)')
} finally { await rm(root, { recursive: true, force: true }) }

async function cloudFailures() {
  for (const stage of ['transition', 'write', 'fileSync', 'rename', 'dirSync']) {
    const path = join(root, `fault-${stage}.json`), seed = createFileStore(path)
    await seed.update(seedMultisite)
    const original = await readFile(path, 'utf8')
    let armed = false, kicks = 0
    const failing = createFileStore(path, {
      async rename(...args) { if (armed && stage === 'rename') throw new Error(stage); return fsRename(...args) },
      async open(target, flags, mode) {
        const handle = await fsOpen(target, flags, mode)
        return new Proxy(handle, { get(value, field) {
          if (field === 'writeFile') return async (...args) => { if (armed && stage === 'write') throw new Error(stage); return value.writeFile(...args) }
          if (field === 'sync') return async () => { if (armed && (stage === 'fileSync' && flags === 'w' || stage === 'dirSync' && target === dirname(path))) throw new Error(stage); return value.sync() }
          const property = Reflect.get(value, field); return typeof property === 'function' ? property.bind(value) : property
        } })
      },
    })
    await failing.read(); armed = true
    const service = createMultisiteService({ store: failing, kick() { kicks++ } })
    const command = create(`fault-${stage}`)
    if (stage === 'transition') command.goal = ''
    await assert.rejects(service.apply(owner, 'create', command))
    assert.equal(kicks, 0)
    if (stage !== 'dirSync') assert.equal(await readFile(path, 'utf8'), original)
    else { await assert.rejects(failing.read(), { code: 'STORE_UNAVAILABLE' }); assert.equal(migrateState(JSON.parse(await readFile(path, 'utf8'))).multisite.commands.length, 1) }
  }
}
async function hostFailures() {
  const store = createFileStore(join(root, 'host-fault-cloud.json')); await store.update(seedMultisite)
  const controls = {}, journal = createHostJournal(join(root, 'host-fault.json')), runtime = createSimulatedRuntime({ path: join(root, 'host-fault-sessions.json'), controls, consume: false })
  let host = createAgentHost({ nodeId: 'local', journal, runtime }), service = createMultisiteService({ store, hosts: [host] })
  await service.apply(owner, 'create', create('host-fault'))
  controls.failHistory = true
  await assert.rejects(service.drain(), /history unavailable/)
  assert.equal((await store.read()).multisite.receipts.some(row => ['session_delivered', 'session_ingested'].includes(row.event.kind)), false)
  controls.failHistory = false; controls.failFlush = true
  await assert.rejects(service.drain(), /synthetic flush/)
  controls.failFlush = false
  await service.drain()
  assert.equal(runtime.messageCount(), 2)
  assert((await store.read()).multisite.inputs[0].deliveries.every(row => row.deliveredAt && !row.ingestedAt))
  await runtime.consumeAll(); await service.drain()
  assert((await store.read()).multisite.inputs[0].deliveries.every(row => row.ingestedAt))
  for (const attempt of (await store.read()).multisite.attempts) await host.report(attempt.launch_id, { state: 'ready', summary: '模拟候选已报告' })
  await service.drain()
  const outboxBefore = (await journal.read()).outbox.map(row => row.event)
  const restarted = createSimulatedRuntime({ path: join(root, 'host-fault-sessions.json'), controls })
  host = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(root, 'host-fault.json')), runtime: restarted })
  service = createMultisiteService({ store, hosts: [host] })
  await service.drain()
  assert.deepEqual((await journal.read()).outbox.map(row => row.event), outboxBefore)
  const command = (await store.read()).multisite.outbox[0].command
  await host.accept({ nodeId: 'local', workspaceId: 'local' }, command)
  await assert.rejects(host.accept({ nodeId: 'local', workspaceId: 'local' }, seal({ ...Object.fromEntries(Object.entries(command).filter(([field]) => field !== 'payload_digest')), parameters: { text: 'different' } })), { code: 'IDEMPOTENCY_CONFLICT' })
  await host.report(command.launch_id, { state: 'waiting', summary: '再次追问', question: '确认？' })
  await assert.rejects(host.flushEvents(async event => ({ ...event, node_id: 'wrong' })), { code: 'FORBIDDEN' })
  assert((await journal.read()).outbox.some(row => !row.acknowledged))
  await service.drain()
}
