import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { startProcessService } from './fixtures/multisite/process-service.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/budget-gateway-native-')
let provider, fixture, calls = 0
try {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['geneway_multisite_report'])
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `budget-${calls}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `report-${calls}`, type: 'function', function: { name: 'geneway_multisite_report', arguments: JSON.stringify({ state: 'waiting', summary: '继续核对本地模拟资料', question: '请确认异常日期。' }) } }] }); send({}, 'tool_calls'); response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startProcessService({ directory, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '在受控工具轮次中校验共享请求预算', clientRequestId: 'native-budget' })
  await until(async () => (await fixture.store.read()).works[0].modelRequestBudget.exhaustedAt !== null)
  assert.equal(calls, 12)
  const exhausted = await fixture.store.read(); assert.equal(exhausted.works[0].modelRequestBudget.reserved, 12); assert.equal(exhausted.multisite.attempts[0].modelRequestsReserved, 12); assert.equal(exhausted.modelRequests.length, 12)
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'native-budget-stop' })
  await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  assert.equal(calls, 12); assert.equal((await fixture.store.read()).works[0].error.code, 'BUDGET_EXHAUSTED')
  const result = { result: 'passed', directory, boundary: 'real HTTP, isolated DSH subprocess, production gateway, local synthetic provider; reservations are not billing usage', actualForwardRequests: calls, reserved: 12, hookDoesNotDoubleCharge: true, exhaustedReasonRetainedAfterActualStop: true }
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) } }
async function until(predicate) { const deadline = Date.now() + 30_000; while (!await predicate()) { assert(Date.now() < deadline, 'native gateway budget timed out'); await new Promise(resolve => setTimeout(resolve, 50)) } }
