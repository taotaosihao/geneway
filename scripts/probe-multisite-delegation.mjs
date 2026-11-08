import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startProcessService } from './fixtures/multisite/process-service.mjs'
import { seedDelegation, childRequest } from './fixtures/multisite/delegation.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-native-')
const requests = [], providerErrors = []
let provider, fixture
const flatten = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
try {
  provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), userIndex = body.messages.findLastIndex(row => row.role === 'user'), userText = flatten(body.messages[userIndex]), tail = body.messages.slice(userIndex + 1), lastTool = tail.findLast(row => row.role === 'tool')
      const context = JSON.parse(userText.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0].trim()), capability = context.grant.execution.capabilityIds[0], agent = capability === 'collaboration.coordinate.v1' ? 'coordinator' : capability === 'office.xlsx.render.v1' ? 'desktop-office' : 'desktop-data'
      const entry = { index: requests.length + 1, agent, latestUser: userText, body }; requests.push(entry)
      await writeFile(join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2))
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['geneway_multisite_report', 'geneway_delegate', 'geneway_wait_dependencies', 'geneway_complete_delegation'].sort())
      let tool, args
      if (userText.includes('Agent来源消息')) {
        if (agent === 'desktop-office') { tool = 'geneway_complete_delegation'; args = { clientRequestId: 'b-result', instructionRevision: 1, result: { summary: 'B 已消费 A 的结构化回报；未执行资料或文件操作。', evidenceRefs: [] } } }
        else if (!lastTool) { tool = 'geneway_multisite_report'; args = { state: 'ready', summary: '协调 Agent 已收到 B 的回报；这是委派链候选，不是业务文件完成。' } }
      } else if (agent === 'desktop-data') { tool = 'geneway_complete_delegation'; args = { clientRequestId: 'a-result', instructionRevision: 1, result: { summary: 'A 的独立 Session 已完成结构化空证据回报。', evidenceRefs: [] } } }
      else if (!lastTool) { tool = 'geneway_delegate'; args = childRequest(`${agent}-delegate`, agent === 'coordinator' ? 'desktop-office' : 'desktop-data') }
      else {
        const returned = JSON.parse(flatten(lastTool)), result = returned.result ?? returned
        assert(result.delegationId, `wait must not ask for another provider step: ${JSON.stringify(lastTool)}`)
        tool = 'geneway_wait_dependencies'; args = { clientRequestId: `${agent}-wait`, instructionRevision: 1, dependencyIds: [result.delegationId] }
      }
      entry.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `delegation-${requests.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '已记录委派结果。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { providerErrors.push(cause.stack); console.error(cause.message); response.writeHead(500); response.end(JSON.stringify({ error: { message: cause.message } })) }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startProcessService({ directory, seedState: seedDelegation, maxActiveLoops: 1, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, notify: message => { if (message.kind === 'runtime-error') console.error('host:', message.code) } })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  assert(login.ok); const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '本地隔离模拟：协调→电脑 B→电脑 A 主动委派，回流后报告候选。', clientRequestId: 'native-delegation-create' })
  await until(async () => { const state = await fixture.store.read(); return state.multisite.attempts.find(row => row.agent_id === 'coordinator')?.report?.state === 'ready' && state.multisite.messages.every(row => row.ingestedAt) })
  assert.deepEqual(providerErrors, [])
  const state = await fixture.store.read(), journal = JSON.parse(await readFile(join(directory, 'multisite-host-local.json'), 'utf8'))
  assert.equal(state.multisite.attempts.length, 3); assert.equal(state.multisite.results.length, 2); assert.equal(state.multisite.messages.length, 2)
  assert.equal(state.works[0].instructionRevision, 1); assert.equal(state.multisite.inputs.length, 1)
  assert.equal(state.works[0].status, 'running'); assert.equal(new Set(state.multisite.attempts.map(row => row.session_id)).size, 3)
  assert.equal(state.works[0].modelRequestBudget.reserved, requests.length); assert(requests.length <= 12)
  const homes = await readdir(join(directory, 'multisite-executions')); assert.equal(homes.length, 3)
  assert(journal.executions.filter(row => row.agent_id !== 'coordinator').every(row => row.yieldedAt && row.status === 'settled'))
  assert.equal(journal.executions.filter(row => row.slotHeld).length, 1)
  assert.deepEqual(requests.filter(row => row.agent === 'desktop-data').map(row => row.tool), ['geneway_complete_delegation'])
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'native-delegation-stop' })
  await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  const result = { result: 'passed', directory, workId: work.id, boundary: 'real HTTP/FileStore, production gateway, actual per-Attempt DSH subprocesses; local synthetic provider; empty evidence reports do not prove business reads or XLSX', maxActiveLoops: 1, independentSessions: 3, independentHomes: homes, durableChildResults: 2, sourceMessagesConsumed: 2, userRevision: 1, actualForwardRequests: requests.length, budgetLimit: 12, actualToolSequence: requests.map(row => ({ agent: row.agent, tool: row.tool })), stopped: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally {
  await writeFile(join(directory, 'provider-errors.json'), JSON.stringify(providerErrors, null, 2)); await writeFile(join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2))
  await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  console.log('Native delegation evidence:', directory)
}
async function until(predicate) { const deadline = Date.now() + 90_000; while (!await predicate()) { assert(Date.now() < deadline, `native delegation timed out; providerErrors=${providerErrors.join('\n')}`); await new Promise(resolve => setTimeout(resolve, 100)) } }
