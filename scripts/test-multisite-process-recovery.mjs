import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/process-recovery-')
let provider, first, recovered, calls = 0, held = false
try {
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    JSON.parse(raw); calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"choices":[{"index":0,"delta":{"content":"未确认的计算"},"finish_reason":null}]}\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const upstreamBaseUrl = `http://127.0.0.1:${provider.address().port}/v1`
  first = await launch(true)
  const session = await login(first.origin)
  const work = await api(first.origin, '/api/works', { method: 'POST', session, body: { workType: 'multisite', employeeId: 'coordinator', goal: '校验结果未知时不会自动重推', clientRequestId: 'unknown-step' } })
  await until(async () => calls === 1 && held)
  const before = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  const journal = JSON.parse(await readFile(join(directory, 'multisite-host-local.json'), 'utf8'))
  assert.equal(before.modelRequests.length, 1); assert.equal(before.modelRequests[0].outcome, 'unknown')
  assert(['accepted', 'delivered'].includes(journal.inbox[0].status), 'positive ingestion journal commit is held before kill')
  assert.equal(before.multisite.inputs[0].deliveries[0].ingestedAt, null)
  await terminate(first.child, 'SIGKILL')
  recovered = await launch(false)
  await until(async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).works[0].status === 'interrupted')
  const after = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.equal(calls, 1, 'restart must not mint a new token and forward an unknown step again')
  assert.equal(after.modelRequests.length, 1); assert.equal(after.modelRequests[0].outcome, 'unknown'); assert.equal(after.modelRequests[0].usage, null)
  assert.equal(after.multisite.attempts[0].unavailableReason, 'RUNTIME_REQUEST_UNKNOWN')
  assert.equal((await readFile(`/proc/${recovered.child.pid}/task/${recovered.child.pid}/children`, 'utf8')).trim(), '', 'unknown recovery is rejected before spawning a new execution worker')
  const newSession = await login(recovered.origin)
  await api(recovered.origin, `/api/works/${work.id}/multisite/cancel`, { method: 'POST', session: newSession, body: { clientRequestId: 'stop-unknown' } })
  await until(async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).works[0].status === 'cancelled')
  assert.equal(calls, 1)
  const final = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.equal(final.multisite.receipts.find(row => row.event.kind === 'stopped').event.stop_evidence, 'idle_after_cancel')
  const result = { result: 'passed', directory, providerAccepted: 1, heldBeforeHostIngestionFlush: true, parentKilled: true, recoveredProviderRequests: calls, unknownReason: 'RUNTIME_REQUEST_UNKNOWN', unknownUsage: null, sameSessionStopOnlyFlush: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally {
  for (const item of [first, recovered]) if (item?.child && item.child.exitCode === null && item.child.signalCode === null) await terminate(item.child, 'SIGTERM')
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
}
async function launch(holdHostIngestion) {
  const child = fork(fileURLToPath(new URL('./fixtures/multisite/process-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  child.stderr.on('data', bytes => process.stderr.write(bytes))
  const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'host-ingestion-held') held = true; if (message.kind === 'ready') resolve({ child, origin: message.origin }) }); child.once('exit', code => reject(new Error(`fixture exited before ready: ${code}`))) })
  child.send({ directory, upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, holdHostIngestion })
  return ready
}
async function terminate(child, signal) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await exited }
async function api(origin, path, { method = 'GET', session, body } = {}) {
  const response = await fetch(origin + path, { method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value
}
async function login(origin) {
  const response = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  assert(response.ok); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] }
}
async function until(predicate) { const deadline = Date.now() + 30_000; while (!await predicate()) { assert(Date.now() < deadline, 'bounded process recovery journey timed out'); await new Promise(resolve => setTimeout(resolve, 50)) } }
