import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startProcessService } from './fixtures/multisite/process-service.mjs'
import { seedDelegation, childRequest } from './fixtures/multisite/delegation.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-revision-wake-'), requests = [], failures = []
let fixture, provider
const flatten = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('')
try {
  provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), user = body.messages.findLastIndex(row => row.role === 'user'), latest = flatten(body.messages[user]), lastTool = body.messages.slice(user + 1).findLast(row => row.role === 'tool')
      const context = JSON.parse(latest.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0]), agent = context.grant.execution.capabilityIds.includes('collaboration.coordinate.v1') ? 'coordinator' : 'desktop-data'
      assert(!latest.includes('Agent来源消息'), 'a stale revision-1 wake must not reach the provider after revision 2')
      const entry = { agent, latest, body }; requests.push(entry)
      let tool, args
      if (agent === 'desktop-data') { tool = 'geneway_complete_delegation'; args = { clientRequestId: 'a-result', instructionRevision: 1, result: { summary: '旧要求一的结构化子回报。', evidenceRefs: [] } } }
      else if (latest.includes('REVISION_TWO')) { if (!lastTool) { tool = 'geneway_multisite_report'; args = { state: 'ready', summary: '当前要求二已在原 Session 正常消费并形成候选。' } } }
      else if (!lastTool) { tool = 'geneway_delegate'; args = childRequest('delegate-a', 'desktop-data') }
      else { const result = JSON.parse(flatten(lastTool)); tool = 'geneway_wait_dependencies'; args = { clientRequestId: 'wait-a', instructionRevision: 1, dependencyIds: [(result.result ?? result).delegationId] } }
      entry.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `revision-wake-${requests.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '当前要求二处理结束。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { failures.push(cause.stack); response.writeHead(500); response.end(JSON.stringify({ error: { message: cause.message } })) }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startProcessService({ directory, seedState: seedDelegation, maxActiveLoops: 1, manualDrain: true, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, notify: message => { if (message.kind === 'runtime-error') failures.push(message.code) } })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: 'REVISION_ONE 原生旧结果唤醒竞态。', clientRequestId: 'create' })
  await pump(async () => (await fixture.store.read()).multisite.outbox.some(row => row.command.operation === 'wake' && !row.acceptedAt))
  const before = await fixture.store.read(), parent = before.multisite.attempts.find(row => row.agent_id === 'coordinator'), oldWake = before.multisite.outbox.find(row => row.command.operation === 'wake')
  assert.equal(oldWake.acceptedAt, null); assert.equal(before.multisite.messages[0].ingestedAt, null); assert.equal(before.works[0].instructionRevision, 1); assert.equal(requests.length, 3)
  await writeFile(join(directory, 'wake-queued-before-revision.json'), JSON.stringify(before, null, 2))
  await api(`/api/works/${work.id}/multisite/inputs`, { text: 'REVISION_TWO 用户通过真实 HTTP 修改为当前要求二。', clientRequestId: 'revision2' })
  const afterPost = await fixture.store.read(); assert.equal(afterPost.works[0].instructionRevision, 2); assert.equal(afterPost.multisite.outbox.find(row => row.id === oldWake.id).acceptedAt, null)
  await pump(async () => { const state = await fixture.store.read(); const root = state.multisite.attempts.find(row => row.agent_id === 'coordinator'); return root.observed_revision === 2 && root.report?.summary.includes('当前要求二') })
  await pump(async () => requests.length === 5)
  const final = await fixture.store.read(), journal = JSON.parse(await readFile(join(directory, 'multisite-host-local.json'), 'utf8')), current = final.multisite.attempts.find(row => row.agent_id === 'coordinator')
  assert.equal(current.session_id, parent.session_id); assert.equal(current.instruction_revision, 2); assert.equal(current.observed_revision, 2); assert.equal(current.status, 'running'); assert.equal(final.works[0].status, 'running')
  assert.equal(final.modelRequests.length, 5); assert.equal(final.works[0].modelRequestBudget.reserved, 5); assert.equal(new Set(final.modelRequests.map(row => row.id)).size, 5)
  assert.equal(requests.filter(row => row.latest.includes('REVISION_TWO')).length, 2); assert.equal(final.multisite.results[0].instructionRevision, 1); assert.equal(final.multisite.messages[0].instructionRevision, 1)
  assert.equal(journal.executions.find(row => row.agent_id === 'coordinator').waitStatus, undefined); assert.deepEqual(failures, [])
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel-revision2' }); await pump(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  const result = { result: 'passed', directory, oldWakeQueuedBeforeActualHttpRevision: true, userRevision: 2, sameParentSession: true, currentInputConsumed: true, oldWakeForwardRequests: 0, currentRevisionForwardRequests: 2, actualTotalForwardRequests: 5, durableReservations: 5, noDuplicateReservation: true, noStuckWaiting: true, actualStop: true, boundary: 'actual production HTTP/gateway/Host and native per-Attempt DSH; manual fixture drain barrier, synthetic provider; no business evidence' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await writeFile(join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(directory, 'failures.json'), JSON.stringify(failures, null, 2)); await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; console.log('Revision wake evidence:', directory) }
async function pump(predicate) { const deadline = Date.now() + 25_000; while (!await predicate()) { assert(Date.now() < deadline, 'revision wake native boundary timed out'); await fixture.service.multisite.drain(); await new Promise(resolve => setTimeout(resolve, 40)) } }
