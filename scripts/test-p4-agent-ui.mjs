import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-agent-http-'))
const store = createFileStore(join(temp, 'state.json')), authPath = join(temp, 'auth.json')
const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
let server, service, origin

try {
  await store.update(state => {
    const now = '2026-10-15T00:00:00.000Z'
    return { ...state,
      members: ['admin', 'a', 'b'].map(id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, employeeIds: [], sessionVersion: 1, createdAt: now, updatedAt: now })),
      modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: '测试模型', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
      skills: [{ id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
    }
  })
  await initializeAuthFile(authPath, { admin: 'admin test password', a: 'a test password', b: 'b test password' })
  service = createWorkService({ store, runner: { configured: true, async run() { assert.fail('HTTP 配置测试不应执行模型') }, async close() {} } })
  const probe = createNodeServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, store, auth: createAuthRuntime({ filePath: authPath }), index, trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

  const admin = await login('admin'), a = await login('a'), b = await login('b')
  assert.equal((await request('/')).body, index)
  assert.equal((await request('/api/admin/employees')).status, 401)
  assert.equal((await request('/api/admin/employees', { session: a })).status, 403)
  const definition = { id: 'agent', name: '生产助理', description: '核对生产条件', instructions: '先核对用户提供的条件。', enabled: true, modelRouteId: 'model', skillIds: ['skill-cycle-time-calculate'], connectionIds: [], memberIds: ['a'] }
  assert.equal((await request('/api/admin/employees', { method: 'POST', session: a, json: definition })).status, 403)
  assert.equal((await request('/api/admin/employees', { method: 'POST', session: admin, csrf: '', json: definition })).status, 403)
  assert.equal((await request('/api/admin/employees', { method: 'POST', session: admin, originHeader: 'http://evil.invalid', json: definition })).status, 403)
  assert.equal((await request('/api/admin/employees', { method: 'POST', session: admin, json: { ...definition, revision: 10 } })).status, 400)
  assert.equal((await request('/api/admin/employees', { method: 'POST', session: admin, json: { ...definition, memberIds: ['missing'] } })).status, 400)
  const created = await request('/api/admin/employees', { method: 'POST', session: admin, json: definition })
  assert.equal(created.status, 200)
  assert.equal(created.body.instructions, definition.instructions)
  assert.equal(created.body.revision, 1)
  assert.deepEqual(created.body.memberIds, ['a'])
  const originalMember = (await request('/api/admin/members', { session: admin })).body.find(item => item.id === 'a')
  assert.deepEqual((await request('/api/bootstrap', { session: a })).body.employees.map(item => item.id), ['agent'])
  assert.deepEqual((await request('/api/bootstrap', { session: b })).body.employees, [])
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: b, json: { expectedRevision: 1, instructions: '越权' } })).status, 403)

  const workInput = { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600 }, clientRequestId: 'agent-http-work' }
  assert.equal((await request('/api/works', { method: 'POST', session: b, json: workInput })).status, 403)
  const waiting = await request('/api/works', { method: 'POST', session: a, json: workInput })
  assert.equal(waiting.status, 200)
  assert.equal(waiting.body.status, 'waiting_input')
  for (const session of [admin, b]) assert.equal((await request('/api/works/' + waiting.body.id, { session })).status, 404)

  const beforeInvalid = await store.read()
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { instructions: '缺少版本' } })).status, 409)
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 1, instructions: {} } })).status, 400)
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 1, employeeIds: ['b'] } })).status, 400)
  assert.deepEqual(await store.read(), beforeInvalid)
  const updated = await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 1, instructions: '只按明确条件回答。', memberIds: ['b'] } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.revision, 2)
  assert.deepEqual(updated.body.memberIds, ['b'])
  const beforeMemberConflict = await store.read()
  const staleMember = await request('/api/admin/members/a', { method: 'PATCH', session: admin, json: { displayName: '旧成员表单改名', role: originalMember.role, enabled: originalMember.enabled, employeeIds: originalMember.employeeIds, expectedEmployeeIds: originalMember.employeeIds } })
  assert.equal(staleMember.status, 409)
  assert.equal(staleMember.body.error.code, 'REVISION_CONFLICT')
  assert.deepEqual(await store.read(), beforeMemberConflict)
  assert.equal((await request('/api/admin/members/a', { method: 'PATCH', session: admin, json: { employeeIds: [] } })).status, 409)
  assert.equal((await request('/api/admin/members/a', { method: 'PATCH', session: admin, json: { displayName: '成员 A 新名称' } })).status, 200)
  assert.equal((await request('/api/session', { session: a })).status, 200)
  assert.deepEqual((await request('/api/bootstrap', { session: a })).body.employees, [])
  assert.deepEqual((await request('/api/bootstrap', { session: b })).body.employees.map(item => item.id), ['agent'])
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...workInput, clientRequestId: 'after-revoke' } })).status, 403)
  const beforeConflict = await store.read()
  const conflict = await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 1, instructions: '旧内容', memberIds: ['a'] } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT')
  assert.deepEqual(await store.read(), beforeConflict)

  const currentMember = (await request('/api/admin/members', { session: admin })).body.find(item => item.id === 'b')
  assert.equal((await request('/api/admin/members/b', { method: 'PATCH', session: admin, json: { employeeIds: [], expectedEmployeeIds: currentMember.employeeIds } })).status, 200)
  const employees = await request('/api/admin/employees', { session: admin }), current = employees.body.find(item => item.id === 'agent')
  assert.equal(current.revision, 3)
  assert.deepEqual(current.memberIds, [])
  assert.equal(current.instructions, updated.body.instructions)
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 2, memberIds: ['a'] } })).status, 409)
  const refreshed = await request('/api/admin/employees', { method: 'PATCH', session: admin, json: { id: 'agent', expectedRevision: current.revision, memberIds: ['a'], description: '新职责' } })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.revision, 4)
  assert.equal(refreshed.body.description, '新职责')
  assert.equal((await request('/api/session', { session: b })).status, 200)
  assert.equal((await request('/api/bootstrap', { session: a })).body.employees[0].id, 'agent')
  const members = await request('/api/admin/members', { session: admin })
  assert.equal(members.body.some(item => Object.hasOwn(item, 'authRef')), false)
  const disk = await store.read()
  assert.equal(Object.hasOwn(disk.employees[0], 'memberIds'), false)
  assert.deepEqual(disk.members.find(item => item.id === 'a').employeeIds, ['agent'])
  assert.deepEqual(disk.members.find(item => item.id === 'b').employeeIds, [])
  assert.equal((await request('/api/admin/employees/agent', { method: 'PATCH', session: admin, json: { expectedRevision: 4, enabled: false } })).status, 200)
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...workInput, clientRequestId: 'after-disable' } })).status, 403)
  console.log('Agent management HTTP checks passed (synthetic store; no model or browser acceptance)')
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  await service?.close()
  await rm(temp, { recursive: true, force: true })
}

async function login(name) {
  const result = await request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password: name + ' test password' } })
  assert.equal(result.status, 200)
  return { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken }
}
async function request(path, { method = 'GET', session, json, csrf, originHeader } = {}) {
  const headers = {}
  if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = csrf ?? session.csrf }
  if (originHeader || session) headers.origin = originHeader ?? origin
  if (json !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(origin + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) })
  const body = await response.text()
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : body }
}
