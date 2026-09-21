import { createHmac, timingSafeEqual, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const SIGNATURE_HEADER = 'x-frappe-webhook-signature'
export const GEARJOB_EVENT_PATH = '/p5/gearjob/work-order'
const MAX_BODY_BYTES = 16 * 1024

export async function readGearJobEventRuntimeConfig(env, repositoryRoot) {
  if (String(env.GENEWAY_GEARJOB_EVENT_PATH ?? '').trim()) throw new Error('GearJob event callback path 不允许环境覆盖')
  const names = ['GENEWAY_GEARJOB_EVENT_SECRET_FILE', 'GENEWAY_GEARJOB_EVENT_SOURCE_ID', 'GENEWAY_GEARJOB_EVENT_SOURCE_ADDRESS', 'GENEWAY_GEARJOB_EVENT_HOST', 'GENEWAY_GEARJOB_EVENT_PORT']
  const values = names.map(name => String(env[name] ?? '').trim())
  if (values.every(value => !value)) return null
  if (values.some(value => !value)) throw new Error('GearJob event receiver 配置必须全有或全无')
  const [secretFile, sourceId, sourceAddress, host, rawPort] = values
  const secretPath = resolve(secretFile)
  const secretRelative = relative(resolve(repositoryRoot), secretPath)
  if (!isAbsolute(secretFile) || (secretRelative !== '..' && !secretRelative.startsWith(`..${sep}`))) throw new Error('GearJob event secret file 必须位于仓库外')
  if (!isIP(sourceAddress)) throw new Error('GearJob event source address 无效')
  if (!isIP(host) || ['0.0.0.0', '::'].includes(host)) throw new Error('GearJob event host 必须是非 wildcard IP')
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GearJob event port 无效')
  return { secret: await readGearJobEventSecret(secretPath), sourceId, expectedSourceAddress: sourceAddress, host, port }
}

export async function readGearJobEventSecret(path) {
  const metadata = await stat(path)
  if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw new Error('GearJob event secret file must be 0600')
  const secret = await readFile(path)
  const normalized = secret.subarray(-1)[0] === 0x0a ? secret.subarray(0, secret.subarray(-2, -1)[0] === 0x0d ? -2 : -1) : secret
  if (!normalized.length || normalized.length > 4096) throw new Error('GearJob event secret is invalid')
  return normalized
}

export function createGearJobEventReceiver({ automationRuntime, secret, sourceId, expectedSourceAddress, host, port, readTimeoutMs = 5_000 } = {}) {
  if (!automationRuntime?.acceptGearJobEvent || !Buffer.isBuffer(secret) || !secret.length || !text(sourceId) || !isIP(expectedSourceAddress) || !isIP(host) || ['0.0.0.0', '::'].includes(host) || !Number.isSafeInteger(port)) throw new TypeError('GearJob event receiver config invalid')
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return send(response, 405, { error: 'method' }, { allow: 'POST' })
      if (request.url !== GEARJOB_EVENT_PATH) return send(response, 404, { error: 'path' })
      const sourceAddress = normalizeAddress(request.socket.remoteAddress)
      if (sourceAddress !== expectedSourceAddress) return send(response, 403, { error: 'source' })
      if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(response, 415, { error: 'content' })
      if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return send(response, 413, { error: 'body-too-large' })
      const raw = await readRaw(request, readTimeoutMs)
      const supplied = signatureBytes(request.headers[SIGNATURE_HEADER])
      const expected = createHmac('sha256', secret).update(raw).digest()
      if (!supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(response, 401, { error: 'signature' })
      const payload = parsePayload(raw, sourceId)
      const result = await automationRuntime.acceptGearJobEvent({
        sourceId,
        workOrderId: payload.name,
        sourceRevision: payload.modified,
        digest: sha256(raw),
      })
      return send(response, result.accepted ? 202 : 200, { status: result.accepted ? 'accepted' : 'ignored', matched: result.matched, accepted: result.accepted })
    } catch (error) {
      const status = error?.code === 'CONFLICT' ? 409 : error?.status ?? (error?.code === 'INVALID_REQUEST' ? 400 : 503)
      return send(response, status, { error: status >= 500 ? 'unavailable' : error?.code ?? 'invalid' })
    }
  })
  server.headersTimeout = readTimeoutMs
  server.requestTimeout = readTimeoutMs
  server.keepAliveTimeout = Math.min(1_000, readTimeoutMs)
  return {
    async start() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) }); return server.address() },
    async close() { await new Promise(resolve => server.close(() => resolve())) },
    isListening() { return server.listening },
  }
}

function parsePayload(raw, sourceId) {
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { throw Object.assign(new Error('payload-json'), { code: 'INVALID_REQUEST' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('payload-shape'), { code: 'INVALID_REQUEST' })
  if (Object.keys(value).sort().join(',') !== 'doctype,event,modified,name,source') throw Object.assign(new Error('payload-fields'), { code: 'INVALID_REQUEST' })
  if (value.source !== sourceId || value.event !== 'on_update' || value.doctype !== 'Work Order') throw Object.assign(new Error('payload-source'), { code: 'INVALID_REQUEST' })
  if (!text(value.name) || !validModified(value.modified)) throw Object.assign(new Error('payload-identity'), { code: 'INVALID_REQUEST' })
  return value
}

function readRaw(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const timer = setTimeout(() => { request.resume(); reject(Object.assign(new Error('read-timeout'), { code: 'INVALID_REQUEST', status: 408 })) }, timeoutMs)
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { request.resume(); reject(Object.assign(new Error('body-too-large'), { code: 'INVALID_REQUEST', status: 413 })) }
      else chunks.push(chunk)
    })
    request.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks, size)) })
    request.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) return undefined
  try { const decoded = Buffer.from(value, 'base64'); return decoded.toString('base64') === value ? decoded : undefined } catch { return undefined }
}

function validModified(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(value) }
function normalizeAddress(value) { return String(value ?? '').replace(/^::ffff:/, '') }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function send(response, status, body, headers = {}) { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)) }
