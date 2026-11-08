import assert from 'node:assert/strict'
import { mkdtemp, rm, open as fsOpen } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileStore } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
const root = await mkdtemp(join(tmpdir(), 'geneway-host-durability-'))
try {
  const store = createFileStore(join(root, 'cloud.json')); await store.update(seedMultisite)
  const path = join(root, 'host.json'), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') })
  let armed = false, sends = 0
  const opened = [], io = { async open(target, flags, mode) {
    opened.push(target)
    const handle = await fsOpen(target, flags, mode)
    return new Proxy(handle, { get(value, field) {
      if (field === 'sync') return async () => { if (armed && target === dirname(path)) throw Object.assign(new Error('synthetic Host dirSync'), { code: 'EIO' }); return value.sync() }
      const property = Reflect.get(value, field); return typeof property === 'function' ? property.bind(value) : property
    } })
  } }
  const journal = createHostJournal(path, io), host = createAgentHost({ nodeId: 'local', journal, runtime }), service = createMultisiteService({ store, hosts: [host] })
  await service.apply({ id: 'owner' }, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '校验Host日志持久性', clientRequestId: 'journal' }); await service.drain()
  const attempt = (await store.read()).multisite.attempts[0]
  armed = true
  await assert.rejects(runtime.report(attempt.launch_id, { state: 'waiting', summary: '缺日期', question: '日期？' }), { code: 'EIO' })
  await assert.rejects(journal.read(), { code: 'STORE_UNAVAILABLE' })
  opened.length = 0
  const reopened = createAgentHost({ nodeId: 'local', journal: createHostJournal(path, io), runtime })
  await assert.rejects(reopened.flushEvents(async () => { sends++; return {} }), { code: 'EIO' })
  assert.deepEqual(opened, [path, dirname(path)])
  assert.equal(sends, 0, 'unconfirmed bytes must never become a cloud report after reopen')
  await assert.rejects(reopened.process(), { code: 'STORE_UNAVAILABLE' })
  assert.equal((await store.read()).works[0].status, 'running')
  armed = false; opened.length = 0
  const reliable = createAgentHost({ nodeId: 'local', journal: createHostJournal(path, io), runtime })
  await reliable.flushEvents(event => { sends++; return service.acceptHostEvent({ nodeId: 'local', workspaceId: 'local' }, event) })
  assert(sends > 0)
  assert.deepEqual(opened.slice(0, 2), [path, dirname(path)])
  assert.equal((await store.read()).works[0].status, 'waiting_input')
  console.log('Host journal durability passed: producer report rename→directory EIO, same-instance block, reopened file+directory confirmation before any send, failed confirmation cannot process/ACK, successful confirmation permits the original sealed event')
} finally { await rm(root, { recursive: true, force: true }) }
