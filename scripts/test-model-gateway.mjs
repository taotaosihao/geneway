import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createModelGateway } from '../src/model-gateway.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
const root = await mkdtemp(join(tmpdir(), 'geneway-gateway-')), calls = []
let upstream, server, host, responseMode = 'normal'
const controls = {}
try {
  const path = join(root, 'state.json'), store = createFileStore(path, {
    async rename(...args) { if (controls.stage === 'rename') throw new Error('synthetic reservation rename'); await rename(...args) },
    async open(file, flags, mode) {
      const handle = await open(file, flags, mode)
      return new Proxy(handle, { get(target, field) {
        if (field === 'writeFile') return async (...args) => { if (controls.stage === 'write' || controls.completionWrite) { controls.completionWrite = false; throw new Error('synthetic metadata write') } return target.writeFile(...args) }
        if (field === 'sync') return async () => { if (controls.stage === 'sync' && flags === 'w' || controls.stage === 'dirSync' && file === root) throw new Error('synthetic reservation sync'); return target.sync() }
        const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  }); await store.update(seedMultisite)
  await mkdir(join(root, 'secrets')); await writeFile(join(root, 'secrets/key'), 'synthetic-long-provider-key', { mode: 0o600 })
  const config = readRuntimeConfig({ GENEWAY_STATE: path, GENEWAY_SECRET_ROOT: join(root, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key' })
  upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks).toString('utf8')
    assert.equal(request.headers.authorization, 'Bearer synthetic-long-provider-key'); calls.push(JSON.parse(raw))
    if (responseMode === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); return }
    if (responseMode === 'upstream-error') { response.writeHead(500); response.end(); return }
    if (responseMode === 'completion-failure') controls.completionWrite = true
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (responseMode === 'no-finish') response.end('data: {"choices":[{"index":0,"delta":{"content":"未结束"},"finish_reason":null}]}\n\ndata: [DONE]\n\n')
    else if (responseMode === 'no-done') response.end('data: {"choices":[{"index":0,"delta":{"content":"缺完成帧"},"finish_reason":"stop"}]}\n\n')
    else if (responseMode === 'broken') { response.flushHeaders(); response.write('data: {"choices":[]}\n\n'); setImmediate(() => response.destroy()) }
    else response.end('data: {"choices":[{"index":0,"delta":{"content":"受控回答"},"finish_reason":"stop"}]}\n\n'+(responseMode === 'usage' ? 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n' : '')+'data: [DONE]\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  let now = Date.now()
  const gateway = createModelGateway({ store, config, clock: () => now, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })
  server = createServer(async (request, response) => { if (!await gateway.handle(request, response, new URL(request.url, 'http://localhost'))) { response.writeHead(404); response.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  host = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(root, 'host.json')), runtime: createSimulatedRuntime({ path: join(root, 'sessions.json') }) })
  const origin = `http://127.0.0.1:${server.address().port}`, service = createMultisiteService({ store, hosts: [host] })
  await service.apply({ id: 'owner' }, 'create', { workType: 'multisite', employeeId: 'coordinator', targets: ['coordinator', 'worker'], goal: '共享预算', clientRequestId: 'gateway-budget' })
  await service.drain()
  const state = await store.read(), input = state.multisite.inputs[0]
  const executions = state.multisite.attempts.map(attempt => ({ ...attempt, session_id: `geneway-${attempt.launch_id}` }))
  const issue = execution => gateway.issue(execution, { request: true, inputMessageId: messageId(input.id, execution.attempt_id, execution.session_id) })
  const body = { model: state.multisite.attempts[0].modelSnapshot.model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: '共享预算测试' }] }
  async function request(token, value = body) {
    const response = await fetch(origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(value) }); const raw = await response.text(); return { status: response.status, raw }
  }
  assert.equal((await request('unknown')).status, 401)
  const attachmentOnly = await gateway.issue(executions[0]); assert.equal((await request(attachmentOnly.token)).status, 401)
  await assert.rejects(gateway.issue(executions[0], { request: true, inputMessageId: 'wrong' }), { code: 'REVISION_CONFLICT' })
  const expired = await issue(executions[0]); now += 5 * 60_000 + 1; assert.equal((await request(expired.token)).status, 401)
  const invalid = await issue(executions[0]); assert.equal((await request(invalid.token, { ...body, max_tokens: 4097 })).status, 400)
  const initial = await issue(executions[0]); assert.equal((await request(initial.token)).status, 200)
  assert.equal((await request(initial.token)).status, 409); assert.equal(calls.length, 1, 'same token/request cannot forward twice')
  const issued = await Promise.all(Array.from({ length: 19 }, (_, index) => issue(executions[index % 2])))
  const results = await Promise.all(issued.map(value => request(value.token)))
  assert.equal(results.filter(result => result.status === 200).length, 11); assert.equal(results.filter(result => result.status === 409).length, 8)
  const after = await store.read(); assert.equal(calls.length, 12); assert.equal(after.works[0].modelRequestBudget.reserved, 12); assert.equal(after.modelRequests.length, 12)
  assert(after.modelRequests.every(row => row.outcome === 'completed' && row.usage === null))
  assert.throws(() => migrateState({ ...structuredClone(after), version: 14 }), /旧版本/, 'downgrade cannot erase durable unknown/reservation facts')
  // Explicit external compatibility fixture: v14 has the old counters but no gateway ledger domain.
  const prior = { ...structuredClone(after), version: 14 }; delete prior.modelRequests; delete prior.modelImageVariants
  const migrated = migrateState(prior)
  assert.deepEqual(migrated.works[0].modelRequestBudget, after.works[0].modelRequestBudget)
  assert.deepEqual(migrated.multisite.attempts.map(row => row.modelRequestsReserved), after.multisite.attempts.map(row => row.modelRequestsReserved))
  assert.deepEqual(migrated.modelRequests, []); assert.deepEqual(migrated.modelImageVariants, [])
  assert.throws(() => migrateState({ ...after, modelRequests: undefined }), /事务域缺失/)
  await assert.rejects(store.update(state => { state.modelRequests = []; return state }), /请求预留不可改写/)

  const serialized = await readFile(path, 'utf8'); assert(!serialized.includes('synthetic-long-provider-key')); assert(!serialized.includes(initial.token)); assert(!serialized.includes('共享预算测试'))
  await service.apply({ id: 'owner' }, 'cancel', { workId: state.works[0].id, clientRequestId: 'gateway-stop' })
  await assert.rejects(issue(executions[0]), { code: 'FORBIDDEN' })
  assert.equal((await createFileStore(path).read()).modelRequests.length, 12)
  async function newExecution(id) {
    // Finish each isolated fault case through the real stop producer before taking another Host slot.
    for (const work of (await store.read()).works.filter(row => !['completed', 'cancelled', 'stopping'].includes(row.status))) await service.apply({ id: 'owner' }, 'cancel', { workId: work.id, clientRequestId: 'stop-before-' + id + '-' + work.id })
    await service.drain()
    const reply = await service.apply({ id: 'owner' }, 'create', { workType: 'multisite', employeeId: 'coordinator', goal: '故障边界', clientRequestId: id })
    await service.drain()
    const state = await store.read(), attempt = state.multisite.attempts.find(row => row.work_id === reply.workId), execution = { ...attempt, session_id: `geneway-${attempt.launch_id}` }, input = state.multisite.inputs.find(row => row.workId === reply.workId)
    const issued = await gateway.issue(execution, { request: true, inputMessageId: messageId(input.id, execution.attempt_id, execution.session_id) })
    return { execution, issued }
  }
  for (const mode of ['no-finish', 'no-done', 'broken', 'redirect', 'completion-failure', 'upstream-error', 'usage']) {
    const { execution, issued } = await newExecution(mode), before = calls.length
    responseMode = mode
    await request(issued.token).catch(() => {})
    const state = await store.read(), row = state.modelRequests.find(row => row.attempt_id === execution.attempt_id)
    assert.equal(calls.length, before + 1)
    assert.equal(row.outcome, mode === 'usage' ? 'completed' : mode === 'upstream-error' ? 'failed' : 'unknown', mode)
    assert.deepEqual(row.usage, mode === 'usage' ? { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } : null)
    if (row.outcome === 'unknown') {
      const restartedGateway = createModelGateway({ store: createFileStore(path), config, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })
      await assert.rejects(restartedGateway.issue(execution), { code: 'RUNTIME_REQUEST_UNKNOWN' })
      assert.equal(calls.length, before + 1)
    }
  }
  responseMode = 'normal'
  for (const stage of ['write', 'sync', 'rename', 'dirSync']) {
    const { execution, issued } = await newExecution('reservation-' + stage), before = calls.length
    controls.stage = stage
    assert.equal((await request(issued.token)).status, 503)
    assert.equal(calls.length, before, 'reservation commit failure cannot forward')
    controls.stage = undefined
    await store.confirmDurability()
    const state = await createFileStore(path).read()
    assert.equal(state.works.find(row => row.id === execution.work_id).modelRequestBudget.reserved, stage === 'dirSync' ? 1 : 0)
  }
  const revoked = await newExecution('revocation')
  await store.update(state => { state.members[0].employeeIds = []; return state })
  assert.equal((await request(revoked.issued.token)).status, 403)
  assert.equal((await store.read()).works.find(row => row.id === revoked.execution.work_id).modelRequestBudget.reserved, 0)
  console.log('Model gateway passed: independent opaque token auth, purpose/expiry/input/model gates, two Attempts share exactly 12 forward-time reservations, same request no resend, unknown usage retained, no body/key/token persisted, stop/revocation gates, SSE terminal and DONE, truncation/disconnect/redirect/failed-completion unknown recovery, actual usage, reservation write/fsync/rename/dirSync faults and reopen.')
} finally {
  await host?.close()
  for (const instance of [server, upstream]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)) }
  await rm(root, { recursive: true, force: true })
}
