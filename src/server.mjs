import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createAuthRuntime, isSessionCurrent } from './auth.mjs'
import { createFileStore } from './store/file-store.mjs'
import { createWorkService, ERROR_STATUS, serviceFailure } from './work-service.mjs'
import { createDshRunner } from './dsh-runner.mjs'
import { readRuntimeConfig } from './runtime-config.mjs'
import { assertTrustedConnections, readConnectionCatalog } from './connection-catalog.mjs'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const COOKIE = 'geneway_session'
const JSON_TYPE = 'application/json'
const PUBLIC_5XX_MESSAGE = '服务暂时无法完成请求'

export async function start() {
  const port = positivePort(process.env.GENEWAY_PORT ?? 3471)
  const host = process.env.GENEWAY_HOST ?? '127.0.0.1'
  const statePath = resolve(process.env.GENEWAY_STATE ?? join(root, 'var', 'state.json'))
  const authFile = process.env.GENEWAY_AUTH_FILE
  if (!authFile) throw new Error('必须配置仓库外 GENEWAY_AUTH_FILE')
  const authPath = resolve(authFile)
  const authRelative = relative(root, authPath)
  if (authRelative !== '..' && !authRelative.startsWith(`..${sep}`)) throw new Error('GENEWAY_AUTH_FILE 必须位于仓库外')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('P2 仅允许 loopback 监听')
  const trustedOrigin = process.env.GENEWAY_TRUSTED_ORIGIN ?? `http://${host === '::1' ? '[::1]' : host}:${port}`
  const origin = new URL(trustedOrigin)
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('GENEWAY_TRUSTED_ORIGIN 必须匹配 P2 明文 loopback HTTP 服务')

  const runtimeConfig = readRuntimeConfig({ ...process.env, GENEWAY_STATE: statePath }, root)
  const store = createFileStore(statePath)
  const connectionCatalog = await readConnectionCatalog(runtimeConfig.connectionCatalogFile, root)
  assertTrustedConnections(connectionCatalog, (await store.read()).connections)
  const runner = createDshRunner({ root, config: runtimeConfig })
  const service = createWorkService({
    store,
    runner,
    connectionCatalog,
    policyPaths: { stateFile: runtimeConfig.stateFile, dataRoot: runtimeConfig.dataRoot, secretRoot: runtimeConfig.secretRoot },
    connectionTester: async connection => {
      const workOrderId = connection.allowedObjectIds?.[0]
      if (!workOrderId) throw Object.assign(new Error('连接没有可测试的只读对象'), { code: 'INVALID_REQUEST' })
      const result = await readGearJobWorkOrder({ workOrderId, connection, secretRoot: runtimeConfig.secretRoot })
      return result.sourceRecordId
    },
  })
  const auth = createAuthRuntime({ filePath: authPath })
  const index = await readFile(join(root, 'web', 'index.html'), 'utf8')
  const server = createGenewayServer({ service, store, auth, index, trustedOrigin })
  server.listen(port, host, () => console.log(`Geneway listening on ${trustedOrigin}`))

  let shuttingDown = false
  const shutdown = async code => {
    if (shuttingDown) return
    shuttingDown = true
    await shutdownServer(server, service)
    process.exit(code)
  }
  process.once('SIGTERM', () => shutdown(0))
  process.once('SIGINT', () => shutdown(0))
  return server
}

export function createGenewayServer({ service, store, auth, index = '', trustedOrigin }) {
  if (!service || !store || !auth || !trustedOrigin) throw new Error('server dependencies are required')
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', trustedOrigin)
      if (request.method === 'GET' && url.pathname === '/') return send(response, 200, index, 'text/html; charset=utf-8')
      if (request.method === 'GET' && url.pathname === '/favicon.ico') return send(response, 204, '', 'image/x-icon')

      if (url.pathname === '/api/session') {
        if (request.method === 'POST') {
          requireOrigin(request, trustedOrigin)
          const body = await readJson(request, ['loginName', 'password'])
          const state = await store.read()
          const member = state.members.find(item => item.loginName === body.loginName && item.enabled === true)
          const valid = await auth.verifyPassword(member?.authRef ?? 'unknown-login', body.password)
          if (!member || !valid) throw httpError('UNAUTHORIZED', '登录名或密码错误')
          const current = (await store.read()).members.find(item => item.id === member.id && item.enabled === true && item.sessionVersion === member.sessionVersion)
          if (!current) throw httpError('UNAUTHORIZED', '登录名或密码错误')
          const session = await auth.issueSession(current)
          return sendJson(response, 200, { member: safeMember(current), csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) })
        }
        const context = await authenticated(request, store, auth)
        if (request.method === 'GET') {
          return sendJson(response, 200, { member: safeMember(context.member), csrfToken: context.csrfToken, expiresAt: context.session.expiresAt })
        }
        if (request.method === 'DELETE') {
          await protectedWrite(request, context.token, auth, trustedOrigin, [])
          await service.invalidateSession(context.member)
          return sendJson(response, 200, { ok: true, invalidatedAllSessions: true }, { 'set-cookie': clearSessionCookie() })
        }
        return notFound(response)
      }

      const context = await authenticated(request, store, auth)
      const actor = context.member
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') return sendJson(response, 200, await service.bootstrap(actor))
      if (request.method === 'GET' && url.pathname === '/api/confirmations') return sendJson(response, 200, await service.listConfirmations(actor))
      if (request.method === 'POST' && url.pathname === '/api/confirmations') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'label', 'value'])
        return sendJson(response, 200, await service.createConfirmation(actor, body))
      }
      const confirmationMatch = url.pathname.match(/^\/api\/confirmations\/([^/]+)$/)
      if (confirmationMatch && request.method === 'PATCH') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['label', 'value'])
        return sendJson(response, 200, await service.updateConfirmation(actor, decode(confirmationMatch[1]), body))
      }
      if (confirmationMatch && request.method === 'DELETE') {
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await service.deleteConfirmation(actor, decode(confirmationMatch[1])))
      }

      if (request.method === 'POST' && url.pathname === '/api/works') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['employeeId', 'skillId', 'capabilityId', 'connectionId', 'goal', 'input', 'workOrderId', 'availableSeconds', 'quantity', 'clientRequestId'])
        return resultResponse(response, await service.createWork(actor, body))
      }
      const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)(?:\/(continue|refresh|follow-up|cancel))?$/)
      if (workMatch && request.method === 'GET' && !workMatch[2]) return resultResponse(response, await service.getWork(actor, decode(workMatch[1])))
      if (workMatch && request.method === 'POST' && workMatch[2]) {
        const id = decode(workMatch[1])
        const action = workMatch[2]
        const allowed = action === 'continue' ? ['input', 'workOrderId', 'availableSeconds', 'quantity', 'clientRequestId'] : action === 'follow-up' ? ['text', 'clientRequestId'] : action === 'refresh' ? ['clientRequestId'] : []
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, allowed)
        const result = action === 'continue' ? await service.continueWork(actor, id, body)
          : action === 'refresh' ? await service.refreshWork(actor, id, body)
            : action === 'follow-up' ? await service.followUp(actor, id, body.text, body)
              : await service.cancel(actor, id)
        return resultResponse(response, result)
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/members') return sendJson(response, 200, await service.listMembers(actor))
      const memberMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)$/)
      if (memberMatch && request.method === 'PATCH') {
        const body = await protectedWrite(request, context.token, auth, trustedOrigin, ['displayName', 'role', 'enabled', 'employeeIds'])
        return sendJson(response, 200, await service.updateMember(actor, decode(memberMatch[1]), body))
      }

      const connectionTest = url.pathname.match(/^\/api\/admin\/connections\/([^/]+)\/test$/)
      if (connectionTest && request.method === 'POST') {
        await protectedWrite(request, context.token, auth, trustedOrigin, [])
        return sendJson(response, 200, await service.testConnection(actor, decode(connectionTest[1])))
      }
      const configMatch = url.pathname.match(/^\/api\/admin\/(employees|connections|skills|model-routes)(?:\/([^/]+))?$/)
      if (configMatch) {
        const kind = configMatch[1] === 'model-routes' ? 'modelRoutes' : configMatch[1]
        const id = configMatch[2] ? decode(configMatch[2]) : undefined
        if (request.method === 'GET' && !id) return sendJson(response, 200, await service.listConfig(actor, kind))
        if (request.method === 'POST' && !id) {
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, configFields(kind, true))
          return sendJson(response, 200, await service.createConfig(actor, kind, body))
        }
        if (request.method === 'PATCH') {
          const body = await protectedWrite(request, context.token, auth, trustedOrigin, configFields(kind, false, !id))
          const targetId = id ?? body.id
          if (!targetId) throw httpError('INVALID_REQUEST', '配置 ID 不能为空')
          const { id: _id, ...changes } = body
          return sendJson(response, 200, await service.updateConfig(actor, kind, targetId, changes))
        }
      }
      return notFound(response)
    } catch (error) {
      const result = serviceFailure(error)
      return sendJson(response, result.error.status, { error: clientError(result.error) })
    }
  })
}

export async function shutdownServer(server, service) {
  const intakeClosed = new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  await service.close().catch(() => undefined)
  await intakeClosed
}

async function authenticated(request, store, auth) {
  const token = cookieValue(request.headers.cookie, COOKIE)
  const view = token && await auth.sessionView(token)
  const session = view?.session
  const state = await store.read()
  const member = state.members.find(item => item.id === session?.memberId)
  if (!isSessionCurrent(session, member)) throw httpError('UNAUTHORIZED', '会话无效或已过期')
  return { token, session, member, csrfToken: view.csrfToken }
}

async function protectedWrite(request, token, auth, trustedOrigin, allowed) {
  requireOrigin(request, trustedOrigin)
  if (!await auth.verifyCsrf(token, request.headers['x-csrf-token'])) throw httpError('FORBIDDEN', 'CSRF 校验失败')
  return readJson(request, allowed)
}

function requireOrigin(request, trustedOrigin) {
  if (request.headers.origin !== trustedOrigin) throw httpError('FORBIDDEN', '请求 Origin 不受信任')
}

async function readJson(request, allowed) {
  if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== JSON_TYPE) throw httpError('INVALID_REQUEST', '请求必须使用 application/json')
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > 64 * 1024) throw httpError('INVALID_REQUEST', '请求内容过大')
  }
  let parsed
  try { parsed = body === '' ? {} : JSON.parse(body) } catch { throw httpError('INVALID_REQUEST', '请求内容不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError('INVALID_REQUEST', '请求 JSON 必须是对象')
  const unexpected = Object.keys(parsed).find(key => !allowed.includes(key))
  if (unexpected) throw httpError('INVALID_REQUEST', `请求包含未声明字段 ${unexpected}`)
  return parsed
}

function configFields(kind, create, collectionPatch = false) {
  const id = create || collectionPatch ? ['id'] : []
  if (kind === 'employees') return [...id, 'name', 'description', 'enabled', 'modelRouteId', 'connectionIds', 'skillIds']
  if (kind === 'connections') return [...id, 'name', 'kind', 'targetIdentity', 'baseUrl', 'hostHeader', 'credentialRef', 'allowedObjectIds', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'enabled', 'skillIds']
  if (kind === 'skills') return [...id, 'name', 'capabilityId', 'enabled']
  return [...id, 'provider', 'model', 'displayName', 'enabled', 'credentialRef']
}

function resultResponse(response, result) { return result.ok ? sendJson(response, 200, result.value) : sendJson(response, result.error.status, { error: clientError(result.error) }) }
function clientError(error) { return error.status >= 500 ? { code: error.code, message: PUBLIC_5XX_MESSAGE, status: error.status } : error }
function notFound(response) { return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在', status: 404 } }) }
function sendJson(response, status, value, headers = {}) { return send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', headers) }
function send(response, status, body, contentType, headers = {}) { response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); response.end(body) }
function sessionCookie(token, expiresAt) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}` }
function clearSessionCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }
function cookieValue(header, name) { for (const part of String(header ?? '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) { try { return decodeURIComponent(rest.join('=')) } catch { return undefined } } } return undefined }
function safeMember(member) { return Object.fromEntries(['id', 'loginName', 'displayName', 'role', 'enabled', 'sessionVersion', 'employeeIds'].map(key => [key, structuredClone(member[key])])) }
function decode(value) { try { return decodeURIComponent(value) } catch { throw httpError('INVALID_REQUEST', '路径参数无效') } }
function positivePort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GENEWAY_PORT 无效'); return port }
function httpError(code, message) { return Object.assign(new Error(message), { code, status: ERROR_STATUS[code] ?? 500 }) }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start()
