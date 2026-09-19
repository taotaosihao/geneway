import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p2-http-'))
const statePath = join(root, 'state.json')
const authPath = join(root, 'private', 'auth.json')
const store = createFileStore(statePath)
let server
let service

try {
  await store.update(seedState)
  await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-user': 'member password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-user'] })
  const auth = createAuthRuntime({ filePath: authPath })
  service = createWorkService({ store, runner: { configured: true, async run() { throw new Error('waiting work must not dispatch') }, async close() {} } })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, store, auth, index: '<!doctype html>', trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

  assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 401)
  assert.equal((await request(origin, '/api/session', { method: 'POST', origin, json: { loginName: 'missing', password: 'wrong password' } })).status, 401)
  assert.equal((await request(origin, '/api/session', { method: 'POST', origin: 'http://evil.invalid', json: { loginName: 'admin', password: 'admin password' } })).status, 403)
  assert.equal((await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' })).status, 400)
  assert.equal((await request(origin, '/api/session', { method: 'POST', origin, json: { loginName: 'admin', password: 'wrong password' } })).status, 401)

  const adminLogin = await request(origin, '/api/session', { method: 'POST', origin, json: { loginName: 'admin', password: 'admin password' } })
  const memberLogin = await request(origin, '/api/session', { method: 'POST', origin, json: { loginName: 'member', password: 'member password' } })
  assert.equal(adminLogin.status, 200)
  assert.equal(memberLogin.status, 200)
  assert.match(adminLogin.cookie, /HttpOnly/)
  assert.match(adminLogin.cookie, /SameSite=Strict/)

  assert.equal((await request(origin, '/api/works', { method: 'POST', origin, cookie: memberLogin.cookie, json: {}, csrf: '' })).status, 403)
  assert.equal((await request(origin, '/api/works', { method: 'POST', origin: 'http://evil.invalid', cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken, json: {} })).status, 403)
  assert.equal((await request(origin, '/api/works', { method: 'POST', origin, cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken, json: { employeeId: 'employee-user', skillId: 'skill-cycle-time-calculate', input: {}, unexpected: true } })).status, 400)

  const waiting = await request(origin, '/api/works', {
    method: 'POST', origin, cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken,
    json: { employeeId: 'employee-user', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600 }, clientRequestId: 'waiting-http' },
  })
  assert.equal(waiting.status, 200)
  assert.equal(waiting.body.status, 'waiting_input')
  assert.equal(waiting.body.executions.length, 0)
  assert.equal((await request(origin, `/api/works/${waiting.body.id}`, { cookie: memberLogin.cookie })).status, 200)
  assert.equal((await request(origin, `/api/works/${waiting.body.id}`, { cookie: adminLogin.cookie })).status, 404)
  assert.equal((await request(origin, '/api/admin/members', { cookie: memberLogin.cookie })).status, 403)
  const confirmation = await request(origin, '/api/confirmations', { method: 'POST', origin, cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken, json: { employeeId: 'employee-user', label: '班次', value: '白班' } })
  assert.equal(confirmation.status, 200)
  assert.equal((await request(origin, `/api/confirmations/${confirmation.body.id}`, { method: 'PATCH', origin, cookie: adminLogin.cookie, csrf: adminLogin.body.csrfToken, json: { value: '越权' } })).status, 404)
  assert.equal((await request(origin, `/api/confirmations/${confirmation.body.id}`, { method: 'DELETE', origin, cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken, json: {} })).status, 200)
  assert.equal((await request(origin, `/api/confirmations/${confirmation.body.id}`, { method: 'PATCH', origin, cookie: memberLogin.cookie, csrf: memberLogin.body.csrfToken, json: { value: '不可复活' } })).status, 400)

  const lastAdmin = await request(origin, '/api/admin/members/member-admin', { method: 'PATCH', origin, cookie: adminLogin.cookie, csrf: adminLogin.body.csrfToken, json: { enabled: false } })
  assert.equal(lastAdmin.status, 400)
  assert.match(lastAdmin.body.error.message, /最后一个/)

  const disabled = await request(origin, '/api/admin/members/member-user', { method: 'PATCH', origin, cookie: adminLogin.cookie, csrf: adminLogin.body.csrfToken, json: { enabled: false } })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.sessionVersion, 2)
  assert.equal((await request(origin, '/api/bootstrap', { cookie: memberLogin.cookie })).status, 401)

  const logout = await request(origin, '/api/session', { method: 'DELETE', origin, cookie: adminLogin.cookie, csrf: adminLogin.body.csrfToken, json: {} })
  assert.equal(logout.status, 200)
  assert.equal(logout.body.invalidatedAllSessions, true)
  assert.equal((await request(origin, '/api/admin/members', { cookie: adminLogin.cookie })).status, 401)

  console.log('P2 HTTP session checks passed')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await service?.close()
  await rm(root, { recursive: true, force: true })
}

async function request(origin, path, options = {}) {
  const headers = {}
  if (options.origin) headers.origin = options.origin
  if (options.cookie) headers.cookie = cookiePair(options.cookie)
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf
  let body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${origin}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') }
}

function cookiePair(value) { return String(value).split(';', 1)[0] }

async function freePort() {
  const probe = createNodeServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

function seedState(state) {
  const now = '2026-09-19T00:00:00.000Z'
  return {
    ...state,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: '管理员', role: 'admin', enabled: true, authRef: 'member-admin', sessionVersion: 1, employeeIds: ['employee-admin'], createdAt: now, updatedAt: now },
      { id: 'member-user', loginName: 'member', displayName: '成员', role: 'member', enabled: true, authRef: 'member-user', sessionVersion: 1, employeeIds: ['employee-user'], createdAt: now, updatedAt: now },
    ],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [{ id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
    employees: [
      { id: 'employee-admin', name: '管理员员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
      { id: 'employee-user', name: '成员员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
    ],
  }
}
