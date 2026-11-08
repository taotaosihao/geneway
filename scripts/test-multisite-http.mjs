import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as portServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { seedMultisite, createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-multisite-http-'))
let server, service
try {
  const store = createFileStore(join(root, 'state.json')); await store.update(seedMultisite)
  const runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') })
  const host = createAgentHost({ nodeId: 'local', runtime, journal: createHostJournal(join(root, 'host.json')) })
  service = createWorkService({ store, multisiteOptions: { hosts: [host] } })
  const authPath = join(root, 'auth.json')
  await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, store, auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: origin })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const request = async (path, { session, method = 'GET', body, expected = 200 } = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...(body ? { 'content-type': 'application/json', origin, 'x-csrf-token': session?.csrfToken ?? '' } : {}), ...(session ? { cookie: session.cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const issuedCookie = response.headers.get('set-cookie'); if (issuedCookie) { assert.match(issuedCookie, /Path=\/; HttpOnly; SameSite=Strict/); assert(!issuedCookie.includes('; Secure')) }
    const value = await response.json()
    assert.equal(response.status, expected, JSON.stringify(value))
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async name => { const result = await request('/api/session', { method: 'POST', body: { loginName: name, password: `synthetic ${name} password` } }); return { ...result.value, cookie: result.cookie } }
  const owner = await login('owner'), peer = await login('peer')
  const body = { workType: 'multisite', employeeId: 'coordinator', targets: ['coordinator', 'worker'], goal: '模拟现场资料整理与整改表；缺少日期时追问', clientRequestId: 'http-create' }
  await request('/api/works', { method: 'POST', body, expected: 401 })
  await request('/api/works', { method: 'POST', session: peer, body, expected: 403 })
  await request('/api/works', { method: 'POST', session: owner, body: { ...body, issuerId: 'owner' }, expected: 400 })
  const { value: work } = await request('/api/works', { method: 'POST', session: owner, body })
  assert.equal(work.workType, 'multisite')
  assert.equal(runtime.starts(), 0)
  const before = await store.read()
  assert.equal(before.multisite.inputs.length, 1)
  assert.equal(before.multisite.outbox.length, 2)
  service.multisite.start()
  await until(async () => (await store.read()).multisite.receipts.filter(row => row.event.kind === 'session_ingested').length === 2)
  assert.equal(runtime.starts(), 2)
  assert.equal((await request(`/api/works/${work.id}`, { session: owner })).value.status, 'running')
  await request(`/api/works/${work.id}`, { session: peer, expected: 404 })
  const replay = await request('/api/works', { method: 'POST', session: owner, body })
  assert.equal(replay.value.id, work.id)
  await request('/api/works', { method: 'POST', session: owner, body: { ...body, goal: 'different' }, expected: 409 })
  const attempt = (await store.read()).multisite.attempts[0]
  await runtime.report(attempt.launch_id, { state: 'waiting', summary: '缺少日期', question: '请补充异常日期' })
  await until(async () => (await store.read()).works[0].status === 'waiting_input')
  assert.equal((await request(`/api/works/${work.id}`, { session: owner })).value.pendingQuestion.question, '请补充异常日期')
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session: peer, body: { text: '非法补充', clientRequestId: 'peer-input' }, expected: 404 })
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session: owner, body: { text: '2026-11-05', clientRequestId: 'http-answer' } })
  await until(async () => (await store.read()).multisite.attempts.every(row => row.observed_revision === 2))
  await request(`/api/works/${work.id}/multisite/cancel`, { method: 'POST', session: owner, body: { clientRequestId: 'http-stop' } })
  await until(async () => (await store.read()).works[0].status === 'cancelled')
  await request(`/api/works/${work.id}/multisite/inputs`, { method: 'POST', session: owner, body: { text: '不会自行恢复', clientRequestId: 'stopped-followup' }, expected: 409 })
  const configured = await request('/api/admin/employees/coordinator', { method: 'PATCH', session: owner, body: { expectedRevision: 1, placement: { nodeId: 'simulated-pc-a', mode: 'agent_host', resourceRefs: ['fixture:incident'] } } })
  assert.equal(configured.value.revision, 2)
  assert.equal((await store.read()).employees[0].placement.nodeId, 'simulated-pc-a')
  await request('/api/session', { method: 'DELETE', session: owner, body: {} }); await request('/api/session', { session: owner, expected: 401 })
  console.log('Multisite HTTP checks passed: authenticated POST /api/works → imported intake/assignment → one FileStore commit → recovery-scanned outbox → Host producer → durable per-target receipts; question/input/cancel/readback and placement revision passed (one loopback machine, simulated runtime, no model)')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await service?.close()
  await rm(root, { recursive: true, force: true })
}
async function freePort() { const server = portServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
async function until(predicate) { const deadline = Date.now() + 12_000; while (!await predicate()) { assert(Date.now() < deadline, 'bounded local HTTP journey timed out'); await new Promise(resolve => setTimeout(resolve, 30)) } }
