import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const CONTROLLED_WORK_ORDER_ID = 'GENEWAY-P2-SAME-001'
const INITIAL_TIME = '2026-09-19T00:00:00.000Z'

export async function startControlledGearJob({ env = process.env, port = Number(env.GENEWAY_P2_CONTROLLED_PORT ?? 0) } = {}) {
  const sourceAuthorization = normalizeAuthorization(await readCredential(
    env.GENEWAY_P2_CONTROLLED_SOURCE_AUTHORIZATION,
    env.GENEWAY_P2_CONTROLLED_SOURCE_CREDENTIAL_FILE,
    'source credential',
  ))
  const controlAuthorization = env.GENEWAY_P2_CONTROLLED_ENABLE === 'true'
    ? normalizeAuthorization(await readCredential(
        env.GENEWAY_P2_CONTROLLED_CONTROL_AUTHORIZATION,
        env.GENEWAY_P2_CONTROLLED_CONTROL_CREDENTIAL_FILE,
        'control credential',
      ))
    : undefined
  const expectedHost = nonEmpty(env.GENEWAY_P2_CONTROLLED_HOST_HEADER)
  let state = initialState()

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://controlled.invalid')
      if (url.pathname === `/api/resource/Work%20Order/${CONTROLLED_WORK_ORDER_ID}` && request.method === 'GET') {
        authorize(request, sourceAuthorization, expectedHost)
        state.callCount += 1
        if (state.delayMs) await delay(state.delayMs)
        return json(response, 200, { data: workOrder(state) })
      }
      if (url.pathname.startsWith('/api/resource/Work%20Order/') && request.method === 'GET') {
        authorize(request, sourceAuthorization, expectedHost)
        return json(response, 404, { exc_type: 'DoesNotExistError', message: 'Controlled work order not found' })
      }
      if (url.pathname === '/__control/state' && request.method === 'GET') {
        authorize(request, controlAuthorization)
        return json(response, 200, publicState(state))
      }
      if (url.pathname === '/__control/update' && request.method === 'POST') {
        authorize(request, controlAuthorization)
        const input = await readJson(request)
        if (input.completedQuantity !== undefined) state.completedQuantity = quantity(input.completedQuantity, 'completedQuantity')
        if (input.plannedQuantity !== undefined) state.plannedQuantity = quantity(input.plannedQuantity, 'plannedQuantity')
        if (input.delayMs !== undefined) state.delayMs = integer(input.delayMs, 0, 30_000, 'delayMs')
        state.revision += 1
        state.sourceTime = revisionTime(state.revision)
        return json(response, 200, publicState(state))
      }
      if (url.pathname === '/__control/reset' && request.method === 'POST') {
        authorize(request, controlAuthorization)
        state = initialState()
        return json(response, 200, publicState(state))
      }
      return json(response, 404, { message: 'Not found' })
    } catch (error) {
      return json(response, error.statusCode ?? 500, { message: error.statusCode ? error.message : 'Controlled source error' })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    address: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function initialState() {
  return { plannedQuantity: 10, completedQuantity: 7, delayMs: 0, callCount: 0, revision: 1, sourceTime: INITIAL_TIME }
}

function workOrder(state) {
  return {
    name: CONTROLLED_WORK_ORDER_ID,
    status: 'In Process',
    qty: state.plannedQuantity,
    produced_qty: state.completedQuantity,
    stock_uom: 'Nos',
    source_time: state.sourceTime,
    modified: state.sourceTime,
    revision: `controlled-b-r${state.revision}`,
    source_system: 'Frappe-compatible controlled source',
    source_environment: 'controlled-test',
    data_mode: 'synthetic-controlled',
    _geneway_controlled_source: true,
  }
}

function publicState(state) {
  return { ...state, workOrderId: CONTROLLED_WORK_ORDER_ID, controlled: true, sourceKind: 'Frappe-compatible controlled source' }
}

function authorize(request, expected, expectedHost) {
  if (!expected) throw httpError(404, 'Control endpoint disabled')
  if (!request.headers.authorization) throw httpError(401, 'Authorization required')
  if (expectedHost && request.headers.host !== expectedHost) throw httpError(403, 'Host is not allowed')
  if (request.headers.authorization !== expected) throw httpError(403, 'Authorization rejected')
}

async function readCredential(value, filePath, label) {
  if (nonEmpty(value)) return value.trim()
  if (!nonEmpty(filePath)) throw new Error(`${label} is not configured`)
  const metadata = await stat(filePath)
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error(`${label} file permissions must be 0600`)
  const raw = (await readFile(filePath, 'utf8')).trim()
  if (!raw) throw new Error(`${label} file is empty`)
  try {
    const parsed = JSON.parse(raw)
    const credential = parsed.authorization ?? parsed.token ?? parsed.apiToken
    if (nonEmpty(credential)) return credential.trim()
  } catch {}
  return raw
}

function normalizeAuthorization(value) {
  return /^(?:Bearer|token)\s+/i.test(value) ? value : `Bearer ${value}`
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 16_384) throw httpError(413, 'Request body too large')
  }
  try {
    const value = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw httpError(400, 'JSON object required')
  }
}

function quantity(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw httpError(400, `${name} must be a non-negative number`)
  return value
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, `${name} must be an integer from ${min} to ${max}`)
  return value
}

function revisionTime(revision) {
  return new Date(Date.parse(INITIAL_TIME) + (revision - 1) * 1000).toISOString()
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim()
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await startControlledGearJob()
  console.log(`P2 controlled Frappe-compatible source listening on ${instance.address}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await instance.close()
    process.exit(0)
  })
}
