import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedCommandFetch, commandNodeId, commandHelperIds } from './fixtures/multisite/command-fetch.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/command-fetch-native-'), brokenFetch = process.argv.includes('--fetch-failure'), bodies = [], errors = [], children = []
let provider, proxy, fixture, fetchAttempts = 0, fullFetchResponses = 0
const text = row => typeof row.content === 'string' ? row.content : (row.content ?? []).filter(value => value.type === 'text').map(value => value.text).join('')
try {
  provider = createServer(async (request, response) => {
    try {
      const requestChunks = []; for await (const chunk of request) requestChunks.push(chunk)
      const body = JSON.parse(Buffer.concat(requestChunks).toString('utf8')), index = body.messages.findLastIndex(row => row.role === 'user'), latest = text(body.messages[index]), context = JSON.parse(latest.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0]), root = context.grant.execution.capabilityIds.includes('collaboration.coordinate.v1'), tools = body.messages.slice(index + 1).filter(row => row.role === 'tool'), calls = []
      bodies.push(body)
      if (!root) calls.push({ name: 'geneway_complete_delegation', parameters: { clientRequestId: 'complete', instructionRevision: 1, result: { summary: '已回报', evidenceRefs: [], findings: [{ category: 'insufficient_evidence', statement: '仅传输helper，没有业务资料', basis: [], certainty: 'unknown' }], limitations: ['不能视作业务分析'] } } })
      else if (latest.includes('Agent来源消息')) { assert.equal(latest.split('已回报').length - 1, 8); if (!tools.length) calls.push({ name: 'geneway_multisite_report', parameters: { state: 'ready', summary: '已在原生协调 Session 消费八个子回报。' } }) }
      else if (!tools.length) for (const id of commandHelperIds) calls.push({ name: 'geneway_delegate', parameters: { clientRequestId: `delegate-${id}`, targetAgentId: id, goal: '返回结构化结果', requestedCapabilityId: 'analysis.classify.v1', resourceRefs: [], resultSchema: 'geneway.analysis-result/1', instructionRevision: 1 } })
      else { const results = tools.map(value => JSON.parse(text(value))); calls.push({ name: 'geneway_wait_dependencies', parameters: { clientRequestId: 'wait', instructionRevision: 1, dependencyIds: results.map(value => (value.result ?? value).delegationId) } }) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `native-${bodies.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (calls.length) { send({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call-${bodies.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.parameters) } })) }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '受控取回与依赖消费已结束。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end(JSON.stringify({ error: { message: cause.message } })) }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), seedState: seedCommandFetch, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` })
  await mkdir(join(directory, 'api/secrets')); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
  proxy = createServer(async (request, response) => {
    const abort = new AbortController(); response.once('close', () => abort.abort())
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      if (request.url === '/internal/bridge/command') {
        fetchAttempts++
        if (brokenFetch) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'REMOTE_UNAVAILABLE' } })); return }
      }
      const forwarded = await fetch(new URL(request.url, fixture.origin), { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'transfer-encoding', 'content-length'].includes(name))), ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: abort.signal })
      response.writeHead(forwarded.status, Object.fromEntries([...forwarded.headers].filter(([name]) => !['transfer-encoding', 'connection'].includes(name))))
      if (request.url === '/internal/bridge/command' && forwarded.ok) fullFetchResponses++
      for await (const chunk of forwarded.body ?? []) if (!response.write(chunk)) await once(response, 'drain', { signal: abort.signal })
      response.end()
    } catch { response.destroy() }
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, value) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) }); const body = await response.json(); assert(response.ok, JSON.stringify(body)); return body }
  for (const [name, nodeId, agents, origin] of [['cloud', 'cloud', ['coordinator'], proxyOrigin], ['helpers', commandNodeId, commandHelperIds, fixture.origin]]) {
    const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: `pair-${name}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: agents, expiresAt: new Date(Date.now() + 120_000).toISOString() }), root = join(directory, name), profile = join(root, 'profile.json')
    await mkdir(root); await writeFile(profile, JSON.stringify({ root, origin, pairing, maxActiveLoops: 1 }), { mode: 0o600 })
    const child = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); child.stderr.resume(); child.on('message', value => { if (value.kind === 'host-error') errors.push(value.code) }); await new Promise((resolve, reject) => { child.on('message', value => { if (value.kind === 'ready') resolve() }); child.once('exit', code => reject(new Error(`Host exited ${code}`))) })
  }
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '合法八个直接依赖的原生结果回流', clientRequestId: 'create' })
  await until(async () => { const state = await fixture.store.read(); return state.multisite.results.length === 8 && fetchAttempts > 0 && (brokenFetch || state.multisite.messages.every(row => row.ingestedAt) && state.modelRequests.length === 12 && state.modelRequests.every(row => row.outcome === 'completed')) })
  const state = await fixture.store.read(), wake = state.multisite.outbox.find(row => row.command.operation === 'wake'), sessionId = state.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id
  assert(wake); assert.equal(state.works[0].instructionRevision, 1); assert.equal(new Set(state.multisite.attempts.map(row => row.session_id)).size, 9)
  if (brokenFetch) { assert.equal(wake.acceptedAt, null); assert(state.multisite.messages.every(row => row.ingestedAt === null)); assert.equal(bodies.length, 10) }
  else { assert(wake.acceptedAt); assert.equal(fullFetchResponses, 1); assert.equal(bodies.length, 12) }
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  const final = await fixture.store.read(); assert.equal(final.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id, sessionId); assert.equal(final.works[0].modelRequestBudget.reserved, brokenFetch ? 10 : 12); assert.equal(final.multisite.outbox.find(row => row.id === wake.id).acceptedAt === null, brokenFetch)
  const journal = JSON.parse(await readFile(join(directory, 'cloud/host-journal.json'), 'utf8')); assert.equal(journal.executions[0].status, 'stopped')
  const result = { result: 'passed', directory, brokenFetch, wakeJsonBytes: Buffer.byteLength(JSON.stringify(wake.command)), fetchAttempts, fullFetchResponses, actualForwardRequests: bodies.length, nativeSessions: 9, sharedBudgetLimit: 12, sameRootSession: true, exactAckAndConsumed: !brokenFetch, failedFetchNoAck: brokenFetch, actualStopAfterFetchFailure: brokenFetch, boundary: 'actual remote entry/SSE/ref/HTTP fetch/Host journals and per-Attempt native DSH; long Node ID and 8 helpers; synthetic provider; proxy failure is controlled transport negative, not business evidence' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally {
  await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); await writeFile(join(directory, 'errors.json'), JSON.stringify(errors, null, 2))
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended }
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }; await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  console.log('Native command fetch evidence:', directory)
}
async function until(predicate) { const deadline = Date.now() + 60_000; while (!await predicate()) { assert(Date.now() < deadline, `native command fetch timed out: ${errors.slice(-8).join(';')}`); await new Promise(resolve => setTimeout(resolve, 80)) } }
