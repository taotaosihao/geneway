import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRequest } from './fixtures/multisite/delegation.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-recovery-')
let provider, first, second, calls = 0
const errors = []
try {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls >= 3) { response.write('data: {"choices":[{"index":0,"delta":{"content":"子执行未完成的模型流"},"finish_reason":null}]}\n\n'); return }
    const tool = calls === 1 ? 'geneway_delegate' : 'geneway_wait_dependencies'
    let args
    if (calls === 1) args = childRequest('recovery-b')
    else { const message = body.messages.findLast(row => row.role === 'tool'), content = typeof message.content === 'string' ? message.content : message.content.filter(row => row.type === 'text').map(row => row.text).join(''); const result = JSON.parse(content); args = { clientRequestId: 'wait-recovery-b', instructionRevision: 1, dependencyIds: [(result.result ?? result).delegationId] } }
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `recovery-${calls}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `recovery-call-${calls}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  first = await launch()
  const session = await login(first.origin), work = await api(first.origin, '/api/works', session, { workType: 'multisite', employeeId: 'coordinator', goal: '父已等待而子模型结果未知时重启，禁止自动重发。', clientRequestId: 'delegation-unknown' })
  await until(async () => { const current = await state(); const child = current.multisite.attempts.find(row => row.agent_id === 'desktop-office'); return calls === 3 && current.modelRequests.find(row => row.attempt_id === child?.attempt_id)?.outcome === 'unknown' })
  const before = await state(), journalBefore = JSON.parse(await readFile(join(directory, 'multisite-host-local.json'), 'utf8'))
  assert(journalBefore.executions.find(row => row.agent_id === 'coordinator').yieldedAt)
  assert.equal(before.multisite.attempts.find(row => row.agent_id === 'coordinator').status, 'waiting_dependency')
  await terminate(first.child, 'SIGKILL')
  second = await launch()
  await until(async () => (await state()).works[0].status === 'interrupted')
  const after = await state(), unknown = after.multisite.attempts.find(row => row.agent_id === 'desktop-office')
  assert.equal(unknown.unavailableReason, 'RUNTIME_REQUEST_UNKNOWN'); assert.equal(calls, 3)
  assert.equal((await readFile(`/proc/${second.child.pid}/task/${second.child.pid}/children`, 'utf8')).trim(), '', 'parked parent stays parked; unknown child rejected before runtime fork')
  assert.equal(after.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id, before.multisite.attempts.find(row => row.agent_id === 'coordinator').session_id)
  assert.equal(after.multisite.results.length, 0)
  const nextSession = await login(second.origin)
  await api(second.origin, `/api/works/${work.id}/multisite/cancel`, nextSession, { clientRequestId: 'cancel-unknown-chain' })
  await until(async () => (await state()).works[0].status === 'cancelled')
  assert.equal(calls, 3)
  const final = await state(); assert(final.multisite.attempts.every(row => row.status === 'cancelled')); assert.equal(final.works[0].modelRequestBudget.reserved, 3)
  const result = { result: 'passed', directory, parentParkedBeforeKill: true, actualForwardRequests: 3, recoveredForwardRequests: calls, noRecoveredInferenceForks: true, sameParentSession: true, childUnknownReason: unknown.unavailableReason, durableCancelAfterRecovery: true, boundary: 'actual production HTTP/gateway, per-Attempt DSH, parent SIGKILL/restart; synthetic provider; no business evidence' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { for (const item of [first, second]) if (item?.child && item.child.exitCode === null && item.child.signalCode === null) await terminate(item.child, 'SIGTERM'); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'runtime-errors.json'), JSON.stringify(errors, null, 2)) }
async function state() { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) }
async function launch() {
  const child = fork(fileURLToPath(new URL('./fixtures/multisite/process-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.stderr.resume()
  const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve({ child, origin: message.origin }); else if (message.kind === 'runtime-error') errors.push(message.code) }); child.once('exit', code => reject(new Error(`fixture exited ${code}`))) })
  child.send({ directory, seedProfile: 'delegation', maxActiveLoops: 1, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); return ready
}
async function terminate(child, signal) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await exited }
async function login(origin) { const response = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert(response.ok); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
async function api(origin, path, session, body) { const response = await fetch(origin + path, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function until(predicate) { const deadline = Date.now() + 40_000; while (!await predicate()) { assert(Date.now() < deadline, 'native child unknown recovery timed out'); await new Promise(resolve => setTimeout(resolve, 60)) } }
