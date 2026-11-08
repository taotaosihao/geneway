import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileStore } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createDshRuntime } from '../packages/agent-host/dsh-runtime.mjs'
import { seedMultisite } from './fixtures/multisite/runtime.mjs'
const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { SessionPersistenceNotFoundError } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence')).href)
const root = await mkdtemp(join(tmpdir(), 'geneway-report-concurrency-'))
const actor = { id: 'owner' }, report = { state: 'waiting', summary: '缺日期', question: '日期？' }
try {
  const h = await harness('report-barrier')
  h.consume()
  const gate = h.blockNextFlush(), pending = h.invoke(report)
  await gate.entered
  assert.equal((await h.journal.read()).outbox.some(row => row.event.kind === 'session_ingested'), false)
  gate.release(); await pending; await h.service.drain()
  assert.equal((await h.store.read()).works[0].status, 'waiting_input')
  const original = (await h.journal.read()).outbox.map(row => row.event)
  await h.invoke(report)
  assert.deepEqual((await h.journal.read()).outbox.map(row => row.event), original)

  const f = await harness('flush-failure'); f.consume(); f.failNextFlush()
  await assert.rejects(f.invoke(report), /synthetic barrier/)
  assert.equal((await f.journal.read()).outbox.some(row => row.event.kind === 'report' || row.event.kind === 'session_ingested'), false)
  await f.invoke(report); await f.service.drain()
  assert.equal((await f.store.read()).works[0].status, 'waiting_input')

  const race = await harness('old-delivery')
  const oldGate = race.blockNextFlush(), oldDelivery = race.host.process()
  await oldGate.entered
  race.consume()
  await race.invoke(report) // Must finish while process is still waiting for its older flush.
  const beforeOld = (await race.journal.read()).outbox.map(row => row.event)
  oldGate.release(); await oldDelivery
  assert.deepEqual((await race.journal.read()).outbox.map(row => row.event), beforeOld)
  assert.equal((await race.journal.read()).inbox[0].status, 'ingested')

  const newer = await harness('pending-newer'); newer.consume(); await newer.invoke(report); await newer.service.drain()
  await newer.service.apply(actor, 'input', { workId: newer.workId, text: '尚未进入模型的新输入', clientRequestId: 'revision-two' }); await newer.service.drain()
  await newer.invoke({ ...report, summary: '旧上下文的迟到报告' }); await newer.service.drain()
  const revision = await newer.store.read()
  assert.equal(revision.multisite.attempts[0].observed_revision, 1)
  assert.equal(revision.multisite.inputs[1].deliveries[0].ingestedAt, null)
  assert.equal(revision.multisite.receipts.at(-1).historical, true)
  assert.equal(revision.multisite.receipts.at(-1).event.observed_revision, 1)

  const stopped = await harness('stop-during-inspect'); stopped.consume()
  const stopGate = stopped.blockNextFlush(), late = stopped.invoke(report)
  const rejection = assert.rejects(late, { code: 'REVISION_CONFLICT' })
  await stopGate.entered
  await stopped.service.apply(actor, 'cancel', { workId: stopped.workId, clientRequestId: 'stop-race' })
  await stopped.service.drain()
  stopGate.release(); await rejection
  assert.equal((await stopped.store.read()).works[0].status, 'cancelled')
  assert.equal((await stopped.journal.read()).outbox.some(row => row.event.kind === 'report'), false)
  console.log('Multisite report concurrency passed through real createDshRuntime/defineTool/AgentDelivery/Host: positive history→flush→atomic receipts/report; barrier failure/block, old process result, stable replay, pending newer input, stop CAS; reporting never waits for idle')
} finally { await rm(root, { recursive: true, force: true }) }

async function harness(name) {
  const store = createFileStore(join(root, name + '-cloud.json')); await store.update(seedMultisite)
  const journal = createHostJournal(join(root, name + '-host.json')), agents = new Map(), listeners = new Map()
  let nextBarrier, failNext = false
  const reportContext = new AsyncLocalStorage()
  const ctx = {
    on(name, fn) { listeners.set(name, fn) },
    sessionPersistence: {
      async flush() {
        if (failNext) { failNext = false; throw new Error('synthetic barrier failure') }
        if (nextBarrier) { const current = nextBarrier; nextBarrier = undefined; current.enter(); await current.promise }
      },
      async open(id) { const agent = agents.get(id); if (!agent) throw new SessionPersistenceNotFoundError(id); return { async read(offset = 0, limit = 512) { return { events: agent.events.slice(offset, offset + limit) } }, async close() {} } },
    },
    agents: {
      get: id => agents.get(id),
      async create({ sessionId, setup }) {
        const tools = new Map(), events = [], inbox = { nextTurn: [], nextStep: [] }, session = { snapshotEvents: () => [...events] }
        const agent = { id: sessionId, events, inbox, session, followup(message) { inbox.nextTurn.push(message) }, cancel() { inbox.nextTurn.length = 0 }, async whenIdle() { assert.notEqual(reportContext.getStore(), true, 'report path must not wait for its own idle') } }
        agents.set(sessionId, agent)
        setup({ tools: { restrict() {}, guard() {}, register(tool) { tools.set(tool.name, tool) } }, systemPrompt: { section() {} }, on() {} }, agent)
        agent.tools = tools
        return { agent }
      },
      async resume() { throw new Error('this focused check never resumes') },
    },
  }
  const runtime = createDshRuntime({ boot: async () => ({ ctx, shutdown: { async shutdown() {} } }), authorize: async () => {}, workspaceRoot: root,
    optionsFor: async () => ({ provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 4096 }) })
  const host = createAgentHost({ nodeId: 'local', runtime, journal }), service = createMultisiteService({ store, hosts: [host] })
  const accepted = await service.apply(actor, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: name, clientRequestId: name }); await service.drain()
  const selected = () => [...agents.values()][0]
  return { store, journal, service, host, workId: accepted.workId,
    consume() { const agent = selected(); for (const message of agent.inbox.nextTurn.splice(0)) { const event = { type: 'user/message', data: message }; agent.events.push(event); listeners.get('session/event')?.(agent.session, event) } },
    async invoke(args) { return reportContext.run(true, () => selected().tools.get('geneway_multisite_report').execute(args, { agent: selected() })) },
    failNextFlush() { failNext = true },
    blockNextFlush() { let enter, release; const entered = new Promise(resolve => { enter = resolve }), promise = new Promise(resolve => { release = resolve }); nextBarrier = { enter, promise }; return { entered, release } },
  }
}
