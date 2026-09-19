import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createFileStore } from './store/file-store.mjs'
import { createWorkService } from './work-service.mjs'
import { createDshRunner } from './dsh-runner.mjs'
import { readRuntimeConfig } from './runtime-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.env.GENEWAY_PORT ?? 3471)
const host = process.env.GENEWAY_HOST ?? '127.0.0.1'
const statePath = resolve(process.env.GENEWAY_STATE ?? join(root, 'var', 'state.json'))
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.GENEWAY_ALLOW_REMOTE !== 'true') {
  throw new Error('远程监听需要显式配置 GENEWAY_ALLOW_REMOTE=true，并在阶段计划中补齐认证/TLS')
}

const runtimeConfig = readRuntimeConfig(process.env, root)
const source = {
  configured: runtimeConfig.source.configured,
  allows: workOrderId => runtimeConfig.source.allowedWorkOrders.includes(workOrderId),
}
const store = createFileStore(statePath)
const runner = createDshRunner({ root, config: runtimeConfig })
const service = createWorkService({ store, source, runner })
const index = await readFile(join(root, 'web', 'index.html'), 'utf8')

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`)
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, index, 'text/html; charset=utf-8')
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') return sendJson(response, 200, await service.bootstrap())
    const workMatch = url.pathname.match(/^\/api\/works\/([^/]+)(?:\/(refresh|follow-up|cancel))?$/)
    if (workMatch && request.method === 'GET' && !workMatch[2]) return resultResponse(response, await service.getWork(decodeURIComponent(workMatch[1])))
    if (workMatch && request.method === 'POST') {
      const body = await readJson(request)
      const id = decodeURIComponent(workMatch[1])
      const action = workMatch[2]
      const result = action === 'refresh'
        ? await service.refreshWork(id, body)
        : action === 'cancel'
          ? await service.cancel(id, body)
          : await service.followUp(id, body.text, body)
      return resultResponse(response, result)
    }
    if (request.method === 'POST' && url.pathname === '/api/works') {
      const body = await readJson(request)
      return resultResponse(response, await service.createWork(body))
    }
    return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在', status: 404 } })
  } catch (error) {
    const status = error?.code === 'INVALID_JSON' ? 400 : 500
    return sendJson(response, status, { error: { code: error?.code ?? 'INTERNAL_ERROR', message: status === 500 ? '服务暂时无法完成请求' : error.message, status } })
  }
})

server.listen(port, host, () => console.log(`Geneway listening on http://${host}:${port}`))

process.once('SIGTERM', () => shutdown(0))
process.once('SIGINT', () => shutdown(0))

async function shutdown(code) {
  await service.close().catch(() => undefined)
  server.close(() => process.exit(code))
}

function resultResponse(response, result) {
  return result.ok ? sendJson(response, 200, result.value) : sendJson(response, result.error.status, { error: result.error })
}

function sendJson(response, status, value) {
  return send(response, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function send(response, status, body, contentType) {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(body)
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > 64 * 1024) {
      const error = new Error('request body too large')
      error.code = 'INVALID_JSON'
      throw error
    }
  }
  try {
    const parsed = body === '' ? {} : JSON.parse(body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    const error = new Error('请求内容不是有效 JSON')
    error.code = 'INVALID_JSON'
    throw error
  }
}
