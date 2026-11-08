import { createServer } from 'node:http'
import { createModelGateway } from '../src/model-gateway.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { createDelegationTools } from '../packages/agent-host/delegation-tools.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, open as fsOpen, rename as fsRename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { childRequest, seedDelegation } from './fixtures/multisite/delegation.mjs'
import { multisiteToolNames } from '../packages/agent-contracts/tools.mjs'
import { createSpreadsheetService } from '../src/spreadsheet-service.mjs'
import { authorizeMultisiteExecution } from '../src/multisite-authorization.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-edges-'), completed = []
const owner = { id: 'owner' }, done = (id, revision = 1) => ({ clientRequestId: id, instructionRevision: revision, result: { summary: '受控模拟回报。', evidenceRefs: [] } })
const wait = (id, dependencyIds, instructionRevision = 1) => ({ clientRequestId: id, dependencyIds, instructionRevision })
async function fixture(name, operations) {
  const path = join(directory, name, 'state.json'), store = createFileStore(path, operations); await store.update(seedDelegation)
  const journal = createHostJournal(join(directory, name, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, name, 'sessions.json') }), host = createAgentHost({ nodeId: 'local', runtime, journal, maxActiveLoops: 2 }), service = createMultisiteService({ store, hosts: [host] })
  const work = await service.apply(owner, 'create', { employeeId: 'coordinator', goal: name, clientRequestId: name }); await service.drain()
  const current = async id => (await store.read()).multisite.attempts.find(row => row.agent_id === id)
  const call = async (id, operation, params) => runtime.orchestration(await current(id), operation, params)
  return { path, store, runtime, host, journal, service, current, call, work }
}
async function scenario(name, run) { const f = await fixture(name); try { await run(f); completed.push(name) } finally { await f.service.close() } }
await scenario('result-before-wait', async f => {
  const child = await f.call('coordinator', 'delegate', childRequest('delegate', 'desktop-data')); await f.service.drain()
  const result = await f.call('desktop-data', 'complete_delegation', done('complete')); await f.service.drain()
  assert.equal((await f.store.read()).multisite.messages.length, 0)
  const params = wait('wait', [child.delegationId]); await f.call('coordinator', 'wait_dependencies', params); await f.service.drain(); await f.service.drain()
  await f.service.agentCommand(await f.current('coordinator'), 'wait_dependencies', params)
  await assert.rejects(f.service.agentCommand(await f.current('coordinator'), 'wait_dependencies', wait('duplicate-wait-new-key', [child.delegationId])), { code: 'INVALID_STATE' })
  const state = await f.store.read(); assert.equal(state.multisite.messages.length, 1); assert(state.multisite.messages[0].ingestedAt); assert.equal(state.multisite.outbox.filter(row => row.command.operation === 'wake').length, 1)
})
await scenario('completed-replay-and-revoke', async f => {
  const b = await f.call('coordinator', 'delegate', childRequest('b')); await f.call('coordinator', 'wait_dependencies', wait('waitb', [b.delegationId])); await f.service.drain()
  const a = await f.call('desktop-office', 'delegate', childRequest('a', 'desktop-data')); await f.call('desktop-office', 'wait_dependencies', wait('waita', [a.delegationId])); await f.service.drain()
  const aBinding = await f.current('desktop-data'), aReply = await f.call('desktop-data', 'complete_delegation', done('a-result')); await f.service.drain(); await f.service.drain()
  await f.call('desktop-office', 'complete_delegation', done('b-result')); await f.service.drain(); await f.service.drain()
  assert.deepEqual(await f.service.agentCommand(aBinding, 'complete_delegation', done('a-result')), aReply)
  await assert.rejects(f.service.agentCommand(aBinding, 'complete_delegation', done('second-key-result')), { code: 'FORBIDDEN' })
  const canonical = (await f.store.read()).multisite.results.filter(row => row.delegationId === a.delegationId); assert.equal(canonical.length, 1); assert.equal((await f.current('desktop-data')).resultId, aReply.resultId)
  await assert.rejects(f.service.agentCommand(aBinding, 'complete_delegation', { ...done('a-result'), result: { summary: '改写', evidenceRefs: [] } }), { code: 'IDEMPOTENCY_CONFLICT' })
  await f.store.update(state => { state.members[0].employeeIds = state.members[0].employeeIds.filter(id => id !== 'desktop-data'); return state })
  await assert.rejects(f.service.agentCommand(aBinding, 'complete_delegation', done('a-result')), { code: 'FORBIDDEN' })
})
await scenario('new-input-retains-completed-child', async f => {
  const a = await f.call('coordinator', 'delegate', childRequest('a', 'desktop-data')); await f.service.drain(); await f.call('desktop-data', 'complete_delegation', done('a-result')); await f.service.drain()
  const before = await f.current('desktop-data'), outboxBefore = (await f.store.read()).multisite.outbox.filter(row => row.command.agent_id === 'desktop-data').length
  await f.service.apply(owner, 'input', { workId: f.work.workId, text: '只变更当前用户要求，已完成子执行不能复活。', clientRequestId: 'revision2' }); await f.service.drain()
  assert.deepEqual(await f.current('desktop-data'), before); assert.equal((await f.store.read()).multisite.outbox.filter(row => row.command.agent_id === 'desktop-data').length, outboxBefore)
})
await scenario('old-revision-result-is-history', async f => {
  const b = await f.call('coordinator', 'delegate', childRequest('b')); await f.call('coordinator', 'wait_dependencies', wait('waitb', [b.delegationId])); await f.service.drain()
  const oldBinding = await f.current('desktop-office')
  await f.service.apply(owner, 'input', { workId: f.work.workId, text: '新要求版本二', clientRequestId: 'revision2' })
  await f.service.drain()
  assert.equal((await f.current('desktop-office')).observed_revision, 2)
  const reply = await f.call('desktop-office', 'complete_delegation', done('late-rev1'))
  assert.equal((await f.journal.read()).executions.find(row => row.agent_id === 'desktop-office').waitStatus, undefined)
  let parks = 0
  const tool = createDelegationTools(async () => reply, () => { parks++ }).find(row => row.name === 'geneway_complete_delegation')
  await tool.execute(done('late-rev1')); assert.equal(parks, 0)
  assert.equal(reply.status, 'historical')
  const state = await f.store.read(); assert.equal(state.multisite.results.length, 1); assert.equal(state.multisite.results[0].instructionRevision, 1); assert.equal(state.multisite.messages.length, 0); assert.equal(state.multisite.attempts.find(row => row.agent_id === 'desktop-office').status, 'running'); assert.equal(state.works[0].instructionRevision, 2)
  assert.deepEqual(await f.service.agentCommand(oldBinding, 'complete_delegation', done('late-rev1')), reply)
  await assert.rejects(f.service.agentCommand(oldBinding, 'complete_delegation', done('fake-rev', 0)), { code: 'REVISION_CONFLICT' })
})
await scenario('revocation-stops-dispatch-and-cancel-wins', async f => {
  const parent = await f.current('coordinator'); await f.call('coordinator', 'delegate', childRequest('b'))
  await f.store.update(state => { state.employees.find(row => row.id === 'coordinator').revision++; return state })
  await f.service.drain(); assert.equal(f.runtime.starts(), 1)
  await assert.rejects(f.service.agentCommand(parent, 'delegate', childRequest('no-extra', 'desktop-data')), { code: 'FORBIDDEN' })
  await f.service.apply(owner, 'cancel', { workId: f.work.workId, clientRequestId: 'cancel' }); await f.service.drain(); assert.equal((await f.store.read()).works[0].status, 'cancelled')
})
await scenario('capability-gates-office', async f => {
  const current = await f.current('coordinator'); assert.equal(multisiteToolNames({ dueDate: null }, current.grant).includes('geneway_start_spreadsheet'), false)
  const spreadsheet = createSpreadsheetService({ store: f.store, gateway: { authorize: async execution => ({ state: await f.store.read(), ...authorizeMultisiteExecution(await f.store.read(), execution) }) } })
  await assert.rejects(spreadsheet.authorize(current), { code: 'FORBIDDEN' })
})

await scenario('wait-subset-and-permutation', async f => {
  const a = await f.call('coordinator', 'delegate', childRequest('a', 'desktop-data')), g = await f.call('coordinator', 'delegate', childRequest('g', 'gateway'))
  await f.call('coordinator', 'wait_dependencies', wait('waitboth', [a.delegationId, g.delegationId])); await f.service.drain()
  await f.call('desktop-data', 'complete_delegation', done('a-result')); await f.call('gateway', 'complete_delegation', done('g-result')); await f.service.drain(); await f.service.drain()
  const before = await f.store.read()
  await assert.rejects(f.call('coordinator', 'wait_dependencies', wait('subset', [a.delegationId])), { code: 'INVALID_STATE' })
  await assert.rejects(f.call('coordinator', 'wait_dependencies', wait('permutation', [g.delegationId, a.delegationId])), { code: 'INVALID_STATE' })
  const after = await f.store.read(); assert.equal(after.multisite.dependencyWaits.length, before.multisite.dependencyWaits.length); assert.equal(after.multisite.outbox.length, before.multisite.outbox.length); assert(after.multisite.messages.every(row => row.ingestedAt))
})

await scenario('unconsumed-prior-wake-rejects-new-wait', async f => {
  const a = await f.call('coordinator', 'delegate', childRequest('a', 'desktop-data')), g = await f.call('coordinator', 'delegate', childRequest('g', 'gateway'))
  await f.service.drain(); await f.call('desktop-data', 'complete_delegation', done('a-result'))
  const first = wait('wait-a', [a.delegationId]); await f.call('coordinator', 'wait_dependencies', first)
  const queued = await f.store.read(); assert.equal(queued.multisite.outbox.filter(row => row.command.operation === 'wake' && !row.acceptedAt).length, 1)
  await assert.rejects(f.call('coordinator', 'wait_dependencies', wait('wait-g-too-early', [g.delegationId])), { code: 'INVALID_STATE' })
  assert.deepEqual(await f.service.agentCommand(await f.current('coordinator'), 'wait_dependencies', first), { workId: f.work.workId, waitId: queued.multisite.dependencyWaits[0].id, status: 'waiting_dependency' })
  await f.service.drain(); await f.service.drain(); assert((await f.store.read()).multisite.messages[0].ingestedAt)
  await f.call('coordinator', 'wait_dependencies', wait('wait-g-after-ingestion', [g.delegationId])); await f.call('gateway', 'complete_delegation', done('g-result')); await f.service.drain(); await f.service.drain()
  const final = await f.store.read(); assert.equal(final.multisite.dependencyWaits.length, 2); assert(final.multisite.messages.every(row => row.ingestedAt))
})
await scenario('unknown-model-blocks-child-result', async f => {
  await f.call('coordinator', 'delegate', childRequest('a', 'desktop-data')); await f.service.drain()
  const child = await f.current('desktop-data'), secretRoot = join(dirname(f.path), 'secrets'); await mkdir(secretRoot); await writeFile(join(secretRoot, 'key'), 'synthetic-only-key', { mode: 0o600 })
  const config = readRuntimeConfig({ GENEWAY_STATE: f.path, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'key' })
  const gateway = createModelGateway({ store: f.store, config, fetchImpl: async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"truncated"},"finish_reason":null}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }) })
  const server = createServer((request, response) => gateway.handle(request, response, new URL(request.url, 'http://localhost')))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const input = (await f.store.read()).multisite.inputs[0], issued = await gateway.issue(child, { request: true, inputMessageId: messageId(input.id, child.attempt_id, child.session_id) })
    await fetch(`http://127.0.0.1:${server.address().port}/internal/model/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ model: child.modelSnapshot.model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'unknown child producer' }] }) }).then(response => response.text()).catch(() => {})
    assert.equal((await f.store.read()).modelRequests[0].outcome, 'unknown')
    await assert.rejects(f.call('desktop-data', 'complete_delegation', done('cannot-complete')), { code: 'RUNTIME_REQUEST_UNKNOWN' })
    assert.equal((await f.store.read()).multisite.results.length, 0); assert.equal((await f.current('desktop-data')).status, 'running')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
for (const stage of ['write', 'fileSync', 'rename', 'dirSync']) {
  let armed = false
  const operations = { async rename(...args) { if (armed && stage === 'rename') throw new Error(stage); return fsRename(...args) }, async open(path, flags, mode) {
    const handle = await fsOpen(path, flags, mode)
    return new Proxy(handle, { get(target, field) {
      if (field === 'writeFile') return async (...args) => { if (armed && stage === 'write') throw new Error(stage); return target.writeFile(...args) }
      if (field === 'sync') return async () => { if (armed && (stage === 'fileSync' && flags === 'w' || stage === 'dirSync' && !String(path).endsWith('.tmp') && flags === 'r' && path === dirname(f.path))) throw new Error(stage); return target.sync() }
      const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const f = await fixture(`fault-${stage}`, operations)
  try {
    const before = await readFile(f.path, 'utf8'), parent = await f.current('coordinator'); armed = true
    await assert.rejects(f.service.agentCommand(parent, 'delegate', childRequest(`fault-${stage}`)), new RegExp(stage))
    assert.equal(f.runtime.starts(), 1)
    if (stage !== 'dirSync') assert.equal(await readFile(f.path, 'utf8'), before)
    else { await assert.rejects(f.store.read(), { code: 'STORE_UNAVAILABLE' }); const committed = migrateState(JSON.parse(await readFile(f.path, 'utf8'))); assert.equal(committed.multisite.attempts.length, 2); assert.equal(committed.multisite.commands.filter(row => row.issuerKind === 'agent').length, 1); assert.equal(committed.multisite.outbox.filter(row => row.command.agent_id === 'desktop-office').length, 1) }
    completed.push(`fault-${stage}`)
  } finally { armed = false; await f.service.close() }
}
const result = { result: 'passed', directory, completed, boundary: 'producer-backed FileStore/Host/AgentDelivery; local runtime simulator; no real business evidence' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
