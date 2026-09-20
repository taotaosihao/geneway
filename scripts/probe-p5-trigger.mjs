import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs'
import { mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = '172.20.0.1'
const PORT = 39471
const PATH = '/p5/gearjob/work-order'
const SOURCE_ADDRESS = '172.20.0.5'
const SOURCE_ID = 'gearjob:dev.localhost'
const EVENT = 'on_update'
const DOCTYPE = 'Work Order'
const SIGNATURE_HEADER = 'x-frappe-webhook-signature'
const MAX_BODY_BYTES = 16 * 1024
const READ_TIMEOUT_MS = 5_000
const SECRET_READ_TIMEOUT_MS = 30_000
const MAX_EVIDENCE_BYTES = 1024 * 1024
const OUTPUT_TIMEOUT_MS = 1_000
const DEFAULT_DURATION_MS = 5 * 60_000
const DEFAULT_MAX_REQUESTS = 200
const SHUTDOWN_GRACE_MS = 1_000
const LOCK_PATH = join(tmpdir(), `geneway-p5-trigger-${process.getuid?.() ?? 'user'}.lock`)

class ProbeError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--self-check') return { selfCheck: true }
  if (argv.length === 1 && argv[0] === '--self-check-output-failure') return { outputFailureSelfCheck: true }
  const values = new Map()
  const booleanOptions = new Set(['fail-first-after-persist'])
  const valueOptions = new Set(['evidence-ref', 'work-order', 'duration-ms', 'max-requests'])
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index])
    if (!match || values.has(match[1]) || (!booleanOptions.has(match[1]) && !valueOptions.has(match[1]))) throw new ProbeError('invalid_args')
    if (booleanOptions.has(match[1])) {
      if (match[2] !== undefined) throw new ProbeError('invalid_args')
      values.set(match[1], true)
      continue
    }
    const value = match[2] ?? argv[++index]
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new ProbeError('invalid_args')
    values.set(match[1], value)
  }
  if (!values.has('evidence-ref')) throw new ProbeError('evidence_ref_required')
  const workOrder = values.get('work-order')
  if (!boundedText(workOrder, 255)) throw new ProbeError('work_order_required')
  const durationMs = boundedInteger(values.get('duration-ms') ?? DEFAULT_DURATION_MS, 1_000, 15 * 60_000, 'invalid_duration')
  const maxRequests = boundedInteger(values.get('max-requests') ?? DEFAULT_MAX_REQUESTS, 1, 1_000, 'invalid_max_requests')
  return {
    evidenceRef: values.get('evidence-ref'),
    workOrder,
    failFirstAfterPersist: values.has('fail-first-after-persist'),
    durationMs,
    maxRequests,
  }
}

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ProbeError(code)
  return number
}

async function readSecret({ signal, stdin = process.stdin, timeoutMs = SECRET_READ_TIMEOUT_MS } = {}) {
  const raw = await readSecretStdin(stdin, signal, timeoutMs)
  const end = raw.length >= 2 && raw.subarray(-2).equals(Buffer.from('\r\n')) ? raw.length - 2
    : raw.length >= 1 && raw.at(-1) === 0x0a ? raw.length - 1 : raw.length
  const secret = Buffer.from(raw.subarray(0, end))
  raw.fill(0)
  if (!secret.length || secret.length > 4096) { secret.fill(0); throw new ProbeError('invalid_secret') }
  try { new TextDecoder('utf-8', { fatal: true }).decode(secret) } catch { secret.fill(0); throw new ProbeError('invalid_secret') }
  return secret
}

function readSecretStdin(stdin, signal, timeoutMs) {
  return new Promise((resolveSecret, rejectSecret) => {
    const chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => finish(new ProbeError('secret_read_timeout')), timeoutMs)
    const onAbort = () => finish(new ProbeError('secret_read_aborted'))
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 4096) { bytes.fill(0); return finish(new ProbeError('secret_too_large')) }
      chunks.push(bytes)
    }
    const onEnd = () => finish()
    const onError = () => finish(new ProbeError('secret_read_failed'))
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      stdin.pause?.()
      if (error) {
        for (const chunk of chunks) chunk.fill(0)
        stdin.destroy?.()
        rejectSecret(error)
      } else {
        const value = Buffer.concat(chunks, size)
        for (const chunk of chunks) chunk.fill(0)
        resolveSecret(value)
      }
    }
    if (signal?.aborted) return finish(new ProbeError('secret_read_aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
    stdin.resume?.()
  })
}

function createEmitter(stream) {
  let pending = Promise.resolve()
  return value => {
    const line = `${JSON.stringify(value)}\n`
    const operation = pending.then(() => new Promise((resolveWrite, rejectWrite) => {
      stream.write(line, error => error ? rejectWrite(error) : resolveWrite())
    }))
    pending = operation.catch(() => undefined)
    return operation
  }
}

async function openEvidenceLog(filePath, workOrder, sourceAddress = SOURCE_ADDRESS) {
  if (!isAbsolute(filePath)) throw new ProbeError('evidence_ref_must_be_absolute')
  const path = resolve(filePath)
  const [root, parent] = await Promise.all([
    realpath(ROOT),
    realpath(dirname(path)).catch(() => { throw new ProbeError('evidence_ref_parent_unavailable') }),
  ])
  if (isWithin(root, path) || isWithin(root, parent)) throw new ProbeError('evidence_ref_must_be_outside_repo')
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    .catch(() => { throw new ProbeError('evidence_ref_unavailable') })
  try {
    const metadata = await handle.stat()
    const target = await realpath(`/proc/self/fd/${handle.fd}`)
    if (isWithin(root, target)) throw new ProbeError('evidence_ref_must_be_outside_repo')
    if (!metadata.isFile() || metadata.size > MAX_EVIDENCE_BYTES || (metadata.mode & 0o777) !== 0o600 || (process.getuid && metadata.uid !== process.getuid())) throw new ProbeError('evidence_ref_permissions')
    const raw = await handle.readFile('utf8')
    if (raw && !raw.endsWith('\n')) throw new ProbeError('evidence_log_incomplete')
    const occurrences = new Map()
    for (const line of raw.split('\n').filter(Boolean)) {
      let record
      try { record = JSON.parse(line) } catch { throw new ProbeError('evidence_log_invalid') }
      if (!validEvidenceRecord(record, workOrder, sourceAddress)) throw new ProbeError('evidence_log_invalid')
      const previous = occurrences.get(record.identityDigest)
      if (previous && previous.digest !== record.digest) throw new ProbeError('evidence_log_conflict')
      occurrences.set(record.identityDigest, evidenceSummary(record))
    }
    let closed = false
    return {
      occurrences,
      async append(summary) {
        const record = { ...summary, persistedAt: new Date().toISOString() }
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
        const current = await handle.stat()
        if (current.size + bytes.length > MAX_EVIDENCE_BYTES) throw new ProbeError('evidence_log_full')
        let offset = 0
        while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten
        await handle.sync()
      },
      async close() {
        if (closed) return
        await handle.close()
        closed = true
      },
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function validEvidenceRecord(value, workOrder, sourceAddress) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).sort().join(',') !== 'digest,doctype,event,identityDigest,modified,persistedAt,recordDigest,sourceAddress') return false
  return value.sourceAddress === sourceAddress
    && value.event === EVENT && value.doctype === DOCTYPE && value.recordDigest === sha256(workOrder).slice(0, 16)
    && /^[a-f0-9]{64}$/.test(value.identityDigest) && /^[a-f0-9]{64}$/.test(value.digest)
    && validModified(value.modified) && Number.isFinite(Date.parse(value.persistedAt))
}

function evidenceSummary(value) {
  return Object.fromEntries(['sourceAddress', 'event', 'doctype', 'recordDigest', 'modified', 'identityDigest', 'digest'].map(key => [key, value[key]]))
}

function createReceiver({
  secret,
  emit,
  host = HOST,
  port = PORT,
  expectedSource = SOURCE_ADDRESS,
  readTimeoutMs = READ_TIMEOUT_MS,
  maxRequests = DEFAULT_MAX_REQUESTS,
  workOrder,
  evidence,
  failFirstAfterPersist = false,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  onLimit = () => {},
} = {}) {
  if (!Buffer.isBuffer(secret) || !secret.length || typeof emit !== 'function' || !boundedText(workOrder, 255) || !evidence?.occurrences || typeof evidence.append !== 'function') throw new ProbeError('invalid_receiver_config')
  const occurrences = evidence.occurrences
  const counts = { requests: 0, accepted: 0, replayed: 0, conflicts: 0, rejected: {} }
  const sockets = new Set()
  const headerTimers = new Map()
  const active = new Set()
  let eventWrites = Promise.resolve()
  let listening = false
  let failureInjected = false

  const server = createServer((request, response) => {
    const headerTimer = headerTimers.get(request.socket)
    if (headerTimer) clearTimeout(headerTimer)
    headerTimers.delete(request.socket)
    const admitted = ++counts.requests
    const operation = handle(request, response).catch(async () => {
      counts.rejected.internal = (counts.rejected.internal ?? 0) + 1
      if (!response.headersSent && !response.destroyed) send(response, 500, { status: 'rejected', reason: 'internal' })
    }).finally(() => {
      active.delete(operation)
      if (admitted >= maxRequests) onLimit()
    })
    active.add(operation)
  })
  server.headersTimeout = readTimeoutMs
  server.requestTimeout = readTimeoutMs
  server.keepAliveTimeout = Math.min(1_000, readTimeoutMs)
  server.maxHeadersCount = 32
  server.on('connection', socket => {
    sockets.add(socket)
    const timer = setTimeout(() => socket.destroy(), readTimeoutMs)
    timer.unref?.()
    headerTimers.set(socket, timer)
    socket.once('close', () => {
      clearTimeout(headerTimers.get(socket))
      headerTimers.delete(socket)
      sockets.delete(socket)
    })
  })

  async function handle(request, response) {
    const sourceAddress = normalizeAddress(request.socket.remoteAddress)
    if (counts.requests > maxRequests) return reject(request, response, 503, 'run-limit', sourceAddress)
    if (request.method !== 'POST') return reject(request, response, 405, 'method', sourceAddress, { allow: 'POST' })
    if (request.url !== PATH) return reject(request, response, 404, 'path', sourceAddress)
    if (sourceAddress !== expectedSource) return reject(request, response, 403, 'source', sourceAddress)
    if (!validContentType(request.headers['content-type']) || !validContentEncoding(request.headers['content-encoding'])) return reject(request, response, 415, 'content', sourceAddress)
    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return reject(request, response, 413, 'body-too-large', sourceAddress)

    let raw
    try {
      raw = await readRawBody(request, MAX_BODY_BYTES, readTimeoutMs)
    } catch (error) {
      const reason = error instanceof ProbeError ? error.code : 'body-read-failed'
      const status = reason === 'body-too-large' ? 413 : reason === 'read-timeout' ? 408 : 400
      return reject(request, response, status, reason, sourceAddress)
    }
    const supplied = signatureBytes(request.headers[SIGNATURE_HEADER])
    const expected = createHmac('sha256', secret).update(raw).digest()
    if (!supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(request, response, 401, 'signature', sourceAddress)

    let payload
    try {
      payload = parsePayload(raw, workOrder)
    } catch (error) {
      return reject(request, response, 400, error instanceof ProbeError ? error.code : 'payload', sourceAddress)
    }
    const digest = sha256(raw)
    const identityDigest = sha256([payload.source, payload.event, payload.doctype, payload.name, payload.modified].join('\0'))
    const summary = {
      sourceAddress,
      event: payload.event,
      doctype: payload.doctype,
      recordDigest: sha256(payload.name).slice(0, 16),
      modified: payload.modified,
      identityDigest,
      digest,
    }
    const committed = eventWrites.then(async () => {
      const previous = occurrences.get(identityDigest)
      if (previous) {
        if (previous.digest === digest) {
          counts.replayed += 1
          await emit({ kind: 'event', outcome: 'replayed', ...summary })
          return { status: 200, outcome: 'replayed' }
        }
        counts.conflicts += 1
        await emit({ kind: 'event', outcome: 'conflict', ...summary, firstDigest: previous.digest })
        return { status: 409, outcome: 'conflict' }
      }
      await evidence.append(summary)
      occurrences.set(identityDigest, summary)
      counts.accepted += 1
      await emit({ kind: 'event', outcome: 'accepted', ...summary })
      if (failFirstAfterPersist && !failureInjected) {
        failureInjected = true
        await emit({ kind: 'fault', outcome: 'injected-after-persist', identityDigest })
        return { status: 503, outcome: 'persisted-retry' }
      }
      return { status: 202, outcome: 'accepted' }
    })
    eventWrites = committed.catch(() => undefined)
    const result = await committed
    send(response, result.status, { status: result.outcome, identityDigest })
  }

  async function reject(request, response, status, reason, sourceAddress, headers = {}) {
    counts.rejected[reason] = (counts.rejected[reason] ?? 0) + 1
    await emit({ kind: 'request', outcome: 'rejected', reason, sourceAddress })
    request.resume()
    send(response, status, { status: 'rejected', reason }, headers)
  }

  return {
    counts,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        const onError = error => { server.off('listening', onListening); rejectListen(error) }
        const onListening = () => { server.off('error', onError); listening = true; resolveListen() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return server.address()
    },
    async close() {
      if (!listening) return closeResult()
      listening = false
      const deadline = Date.now() + shutdownGraceMs
      const remaining = () => Math.max(0, deadline - Date.now())
      const closed = new Promise(resolveClose => server.close(() => resolveClose(true)))
      server.closeIdleConnections?.()
      const force = setTimeout(() => {
        server.closeAllConnections?.()
        for (const socket of sockets) socket.destroy()
      }, shutdownGraceMs)
      force.unref?.()
      await within(closed, remaining(), false)
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
      clearTimeout(force)
      await within(Promise.allSettled([...active]), remaining(), false)
      await within(eventWrites, remaining(), false)
      for (const timer of headerTimers.values()) clearTimeout(timer)
      headerTimers.clear()
      await waitFor(() => sockets.size === 0 && active.size === 0, remaining()).catch(() => undefined)
      return closeResult()
    },
  }

  function closeResult() {
    const residual = { sockets: sockets.size, requests: active.size, headerTimers: headerTimers.size, listening: server.listening ? 1 : 0 }
    if (Object.values(residual).some(Boolean)) {
      const failure = new ProbeError('shutdown_incomplete')
      failure.residual = residual
      throw failure
    }
    return residual
  }
}

function readRawBody(request, limit, timeoutMs) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => finish(new ProbeError('read-timeout')), timeoutMs)
    timer.unref?.()
    const onData = chunk => {
      size += chunk.length
      if (size > limit) return finish(new ProbeError('body-too-large'))
      chunks.push(chunk)
    }
    const onEnd = () => finish(request.complete && !request.aborted ? undefined : new ProbeError('aborted'))
    const onAborted = () => finish(new ProbeError('aborted'))
    const onError = () => finish(new ProbeError('body-read-failed'))
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
      if (error) { request.resume(); rejectBody(error) }
      else resolveBody(Buffer.concat(chunks, size))
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('aborted', onAborted)
    request.on('error', onError)
  })
}

function signatureBytes(value) {
  if (typeof value !== 'string' || value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 32 && bytes.toString('base64') === value ? bytes : undefined
}

function parsePayload(raw, workOrder) {
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { throw new ProbeError('payload-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProbeError('payload-shape')
  if (Object.keys(value).sort().join(',') !== 'doctype,event,modified,name,source') throw new ProbeError('payload-fields')
  if (value.source !== SOURCE_ID || value.event !== EVENT || value.doctype !== DOCTYPE) throw new ProbeError('payload-source')
  if (value.name !== workOrder || !validModified(value.modified)) throw new ProbeError('payload-identity')
  return value
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= maximum
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validModified(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
}

function validContentType(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(value)
}

function validContentEncoding(value) {
  return value === undefined || typeof value === 'string' && value.trim().toLowerCase() === 'identity'
}

function normalizeAddress(value) {
  const address = String(value ?? '')
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function send(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
    ...headers,
  })
  response.end(JSON.stringify(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function acquireLock(path = LOCK_PATH) {
  let fd
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600)
    const metadata = fstatSync(fd)
    if (!metadata.isFile() || (process.getuid && metadata.uid !== process.getuid())) throw new ProbeError('lock_path_invalid')
    fchmodSync(fd, 0o600)
    const holder = spawn('/bin/sh', [
      '-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _',
    ], { stdio: ['pipe', 'pipe', 'ignore', fd] })
    closeSync(fd)
    fd = undefined
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => { holder.kill('SIGKILL'); rejectReady(new ProbeError('lock_timeout')) }, 1_000)
      const onData = chunk => {
        if (!String(chunk).includes('ready')) return
        clearTimeout(timer)
        holder.stdout.off('data', onData)
        holder.off('exit', onExit)
        resolveReady()
      }
      const onExit = code => {
        clearTimeout(timer)
        holder.stdout.off('data', onData)
        rejectReady(new ProbeError(code === 73 ? 'already_running' : 'lock_failed'))
      }
      holder.stdout.on('data', onData)
      holder.once('exit', onExit)
    })
    let releasing = false
    let resolveLost
    const lost = new Promise(resolveLockLost => { resolveLost = resolveLockLost })
    holder.once('exit', (code, signal) => { if (!releasing) resolveLost({ code, signal }) })
    return {
      lost,
      async release() {
        releasing = true
        if (holder.exitCode !== null || holder.signalCode !== null) return
        holder.stdin.end('\n')
        await new Promise(resolveExit => {
          const timer = setTimeout(() => { holder.kill('SIGKILL'); resolveExit() }, 1_000)
          holder.once('exit', () => { clearTimeout(timer); resolveExit() })
        })
      },
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
  }
}

async function run(options) {
  const emit = createEmitter(process.stdout)
  const lock = await acquireLock()
  const lifecycle = new AbortController()
  const totalDeadline = Date.now() + options.durationMs
  let secret
  let evidence
  let receiver
  let durationTimer
  let completed = false
  let resolveStop
  const stopped = new Promise(resolveStopped => { resolveStop = resolveStopped })
  const requestStop = reason => {
    if (lifecycle.signal.aborted) return
    lifecycle.abort(reason)
    resolveStop(reason)
  }
  const onSigint = () => requestStop('SIGINT')
  const onSigterm = () => requestStop('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  void lock.lost.then(() => requestStop('lock-lost'))
  durationTimer = setTimeout(() => requestStop('duration'), options.durationMs)
  try {
    secret = await readSecret({ signal: lifecycle.signal, timeoutMs: Math.min(SECRET_READ_TIMEOUT_MS, options.durationMs) })
    if (lifecycle.signal.aborted) throw new ProbeError('startup_aborted')
    evidence = await openEvidenceLog(options.evidenceRef, options.workOrder)
    receiver = createReceiver({
      secret, emit, maxRequests: options.maxRequests, workOrder: options.workOrder,
      evidence, failFirstAfterPersist: options.failFirstAfterPersist, onLimit: () => requestStop('max-requests'),
    })
    const address = await receiver.listen()
    await emitBounded(emit, {
      kind: 'ready', bind: HOST, port: address.port, path: PATH, expectedSource: SOURCE_ADDRESS,
      workOrderDigest: sha256(options.workOrder).slice(0, 16), failFirstAfterPersist: options.failFirstAfterPersist,
      limits: { bodyBytes: MAX_BODY_BYTES, readMs: READ_TIMEOUT_MS, durationMs: options.durationMs, requests: options.maxRequests },
    }, totalDeadline, process.stdout)
    const reason = await stopped
    clearTimeout(durationTimer)
    const shutdownDeadline = Date.now() + SHUTDOWN_GRACE_MS
    const residual = await receiver.close()
    const counts = structuredClone(receiver.counts)
    receiver = undefined
    const evidenceClosed = await within(evidence.close().then(() => true), Math.max(0, shutdownDeadline - Date.now()), false)
    if (!evidenceClosed) throw new ProbeError('shutdown_incomplete')
    evidence = undefined
    const lockReleased = await within(lock.release().then(() => true), Math.max(0, shutdownDeadline - Date.now()), false)
    if (!lockReleased) throw new ProbeError('shutdown_incomplete')
    await emitBounded(emit, { kind: 'summary', reason, counts, residual: { ...residual, timers: 0, lockHeld: false } }, shutdownDeadline, process.stdout)
    completed = true
  } finally {
    if (durationTimer) clearTimeout(durationTimer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (receiver) await within(receiver.close().catch(() => undefined), SHUTDOWN_GRACE_MS, undefined)
    if (evidence) await within(evidence.close(), SHUTDOWN_GRACE_MS, false)
    await within(lock.release().catch(() => undefined), SHUTDOWN_GRACE_MS, undefined)
    secret?.fill(0)
    settleOutput(completed, process.stdout)
  }
}

async function selfCheck() {
  const secretText = 'P5-SELF-CHECK-SECRET-0123456789'
  const secret = Buffer.from(secretText)
  const workOrder = 'P5-SYNTHETIC-001'
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-p5-trigger-check-'))
  const records = []
  let receiver
  let evidence
  try {
    evidence = await openEvidenceLog(join(scratch, 'main.jsonl'), workOrder, '127.0.0.1')
    let limitStop = false
    receiver = createReceiver({
      secret, emit: async value => { records.push(structuredClone(value)) }, evidence, workOrder,
      host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1', readTimeoutMs: 80,
      maxRequests: 50, onLimit: () => { limitStop = true },
    })
    const address = await receiver.listen()
    const target = { host: '127.0.0.1', port: address.port }
    const payload = { source: SOURCE_ID, event: EVENT, doctype: DOCTYPE, name: workOrder, modified: '2026-09-20 18:01:02.123456' }
    const body = Buffer.from(JSON.stringify(payload))
    const headers = signedHeaders(secret, body)

    assert.equal((await sendRequest(target, { method: 'GET', path: PATH })).status, 405)
    assert.equal((await sendRequest(target, { method: 'POST', path: `${PATH}/wrong`, body, headers })).status, 404)
    assert.equal((await sendRequest(target, { method: 'POST', path: `${PATH}?query=forbidden`, body, headers })).status, 404)
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body, headers: { ...headers, 'content-encoding': 'gzip' } })).status, 415)
    const large = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body: large, headers: signedHeaders(secret, large) })).status, 413)
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body: Buffer.from('{'), headers: signedHeaders(Buffer.from('wrong-secret'), Buffer.from('{')) })).status, 401)
    const badSignature = `${headers[SIGNATURE_HEADER][0] === 'A' ? 'B' : 'A'}${headers[SIGNATURE_HEADER].slice(1)}`
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body, headers: { ...headers, [SIGNATURE_HEADER]: badSignature } })).status, 401)
    const wrongName = Buffer.from(JSON.stringify({ ...payload, name: 'P5-SYNTHETIC-WRONG' }))
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body: wrongName, headers: signedHeaders(secret, wrongName) })).status, 400)
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body, headers })).status, 202)
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body, headers })).status, 200)
    const conflictingBody = Buffer.from(JSON.stringify(payload).replace(',"event"', ', "event"'))
    assert.equal((await sendRequest(target, { method: 'POST', path: PATH, body: conflictingBody, headers: signedHeaders(secret, conflictingBody) })).status, 409)
    assert.equal(await slowRequest(target, headers[SIGNATURE_HEADER]), 408)
    assert.equal(await incompleteHeaders(target), true)
    await abortedRequest(target, headers[SIGNATURE_HEADER])
    await waitFor(() => receiver.counts.rejected.aborted === 1)

    const sourceEvidence = await openEvidenceLog(join(scratch, 'source.jsonl'), workOrder, '192.0.2.10')
    const sourceReceiver = createReceiver({ secret, evidence: sourceEvidence, workOrder, emit: async () => {}, host: '127.0.0.1', port: 0, expectedSource: '192.0.2.10', maxRequests: 2 })
    const sourceAddress = await sourceReceiver.listen()
    assert.equal((await sendRequest({ host: '127.0.0.1', port: sourceAddress.port }, { method: 'POST', path: PATH, body, headers: { ...headers, 'x-forwarded-for': '192.0.2.10' } })).status, 403)
    assert.deepEqual(await sourceReceiver.close(), { sockets: 0, requests: 0, headerTimers: 0, listening: 0 })
    await sourceEvidence.close()

    let abortLimit = false
    const limitEvidence = await openEvidenceLog(join(scratch, 'limit.jsonl'), workOrder, '127.0.0.1')
    const limitReceiver = createReceiver({ secret, evidence: limitEvidence, workOrder, emit: async () => {}, host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1', maxRequests: 1, onLimit: () => { abortLimit = true } })
    const limitAddress = await limitReceiver.listen()
    await abortedRequest({ host: '127.0.0.1', port: limitAddress.port }, headers[SIGNATURE_HEADER])
    await waitFor(() => abortLimit)
    await limitReceiver.close()
    await limitEvidence.close()

    const failWorkOrder = 'P5-SYNTHETIC-FAIL-FIRST'
    const failPayload = { ...payload, name: failWorkOrder, modified: '2026-09-20 18:02:03.654321' }
    const failBody = Buffer.from(JSON.stringify(failPayload))
    const failHeaders = signedHeaders(secret, failBody)
    let failEvidence = await openEvidenceLog(join(scratch, 'fail.jsonl'), failWorkOrder, '127.0.0.1')
    let failReceiver = createReceiver({ secret, evidence: failEvidence, workOrder: failWorkOrder, failFirstAfterPersist: true, emit: async () => {}, host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1' })
    let failAddress = await failReceiver.listen()
    assert.equal((await sendRequest({ host: '127.0.0.1', port: failAddress.port }, { method: 'POST', path: PATH, body: failBody, headers: failHeaders })).status, 503)
    assert.equal((await sendRequest({ host: '127.0.0.1', port: failAddress.port }, { method: 'POST', path: PATH, body: failBody, headers: failHeaders })).status, 200)
    await failReceiver.close()
    await failEvidence.close()
    failEvidence = await openEvidenceLog(join(scratch, 'fail.jsonl'), failWorkOrder, '127.0.0.1')
    failReceiver = createReceiver({ secret, evidence: failEvidence, workOrder: failWorkOrder, failFirstAfterPersist: true, emit: async () => {}, host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1' })
    failAddress = await failReceiver.listen()
    assert.equal((await sendRequest({ host: '127.0.0.1', port: failAddress.port }, { method: 'POST', path: PATH, body: failBody, headers: failHeaders })).status, 200)
    await failReceiver.close()
    await failEvidence.close()
    const durable = await readFile(join(scratch, 'fail.jsonl'), 'utf8')
    assert.equal(durable.trim().split('\n').length, 1)
    assert(!durable.includes(secretText) && !durable.includes(failWorkOrder) && !durable.includes(failBody.toString('utf8')))

    const closingEvidence = await openEvidenceLog(join(scratch, 'closing.jsonl'), failWorkOrder, '127.0.0.1')
    const closingReceiver = createReceiver({
      secret,
      evidence: { occurrences: closingEvidence.occurrences, append: async summary => { await new Promise(resolveDelay => setTimeout(resolveDelay, 20)); await closingEvidence.append(summary) } },
      workOrder: failWorkOrder, emit: async () => {}, host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1',
    })
    const closingAddress = await closingReceiver.listen()
    const closingRequest = sendRequest({ host: '127.0.0.1', port: closingAddress.port }, { method: 'POST', path: PATH, body: failBody, headers: failHeaders })
    await waitFor(() => closingReceiver.counts.requests === 1)
    await closingReceiver.close()
    assert.equal(closingReceiver.counts.accepted, 1)
    assert.equal((await closingRequest).status, 202)
    await closingEvidence.close()

    const pendingEvidence = await openEvidenceLog(join(scratch, 'pending.jsonl'), failWorkOrder, '127.0.0.1')
    const pendingReceiver = createReceiver({ secret, evidence: pendingEvidence, workOrder: failWorkOrder, emit: () => new Promise(() => {}), host: '127.0.0.1', port: 0, expectedSource: '127.0.0.1', shutdownGraceMs: 40 })
    const pendingAddress = await pendingReceiver.listen()
    const pendingRequest = sendRequest({ host: '127.0.0.1', port: pendingAddress.port }, { method: 'POST', path: PATH, body: failBody, headers: failHeaders }).catch(() => undefined)
    await waitFor(() => pendingReceiver.counts.accepted === 1)
    const closeStarted = Date.now()
    await assert.rejects(pendingReceiver.close(), error => error.code === 'shutdown_incomplete' && error.residual.requests === 1)
    assert(Date.now() - closeStarted < 250)
    let failedOutputDestroyed = false
    settleOutput(false, { destroy: () => { failedOutputDestroyed = true } })
    assert.equal(failedOutputDestroyed, true)
    await pendingEvidence.close()
    await within(pendingRequest, 250, undefined)

    const supplied = new PassThrough()
    supplied.end(`${secretText}\n`)
    const fromStdin = await readSecret({ stdin: supplied, timeoutMs: 1_000 })
    assert.equal(fromStdin.toString(), secretText)
    fromStdin.fill(0)
    const oversized = new PassThrough()
    oversized.end(Buffer.alloc(4097))
    await assert.rejects(readSecret({ stdin: oversized, timeoutMs: 1_000 }), error => error.code === 'secret_too_large')
    const stalled = new PassThrough()
    await assert.rejects(readSecret({ stdin: stalled, timeoutMs: 20 }), error => error.code === 'secret_read_timeout')
    const cancelled = new PassThrough(), controller = new AbortController()
    const cancelledRead = readSecret({ stdin: cancelled, signal: controller.signal, timeoutMs: 1_000 })
    controller.abort()
    await assert.rejects(cancelledRead, error => error.code === 'secret_read_aborted')

    for (const kind of ['ready', 'summary']) {
      let destroyed = false
      const outputStarted = Date.now()
      await assert.rejects(
        emitBounded(() => new Promise(() => {}), { kind }, Date.now() + 20, { destroy: () => { destroyed = true } }),
        error => error.code === 'output_timeout',
      )
      assert(destroyed && Date.now() - outputStarted < 250)
    }
    assert.equal(isWithin(ROOT, join(ROOT, '..secret')), true)

    const lockPath = join(scratch, 'probe.lock')
    const firstLock = await acquireLock(lockPath)
    await assert.rejects(acquireLock(lockPath), error => error.code === 'already_running')
    await firstLock.release()
    const releasedLock = await acquireLock(lockPath)
    await releasedLock.release()

    const childArgs = [`--evidence-ref=${join(scratch, 'child.jsonl')}`, '--work-order=P5-SYNTHETIC-CHILD', '--duration-ms=1000']
    const durationChild = await stdinChild(childArgs)
    assert.equal(durationChild.code, 1)
    assert(durationChild.elapsedMs < 2_500)
    const signalChild = await stdinChild(childArgs, 'SIGTERM')
    assert.equal(signalChild.code, 1)
    assert(signalChild.elapsedMs < 1_500)
    const outputFailureChild = await stdinChild(['--self-check-output-failure'])
    assert.equal(outputFailureChild.code, 1)
    assert(outputFailureChild.elapsedMs < 1_000)
    assert.match(outputFailureChild.stderr, /"error":"self_check_output_failure"/)
    const postExitLock = await acquireLock()
    await postExitLock.release()

    const finalCounts = structuredClone(receiver.counts)
    assert.equal(finalCounts.accepted, 1)
    assert.equal(finalCounts.replayed, 1)
    assert.equal(finalCounts.conflicts, 1)
    assert.equal(finalCounts.rejected.method, 1)
    assert.equal(finalCounts.rejected.path, 2)
    assert.equal(finalCounts.rejected.content, 1)
    assert.equal(finalCounts.rejected['body-too-large'], 1)
    assert.equal(finalCounts.rejected.signature, 2)
    assert.equal(finalCounts.rejected['payload-identity'], 1)
    assert.equal(finalCounts.rejected['read-timeout'], 1)
    assert.equal(finalCounts.rejected.aborted, 1)
    const residual = await receiver.close()
    receiver = undefined
    assert.deepEqual(residual, { sockets: 0, requests: 0, headerTimers: 0, listening: 0 })
    await evidence.close()
    evidence = undefined
    assert.equal(records.find(item => item.outcome === 'accepted')?.modified, payload.modified)
    assert.equal(limitStop, false)
    assert(!JSON.stringify(records).includes(secretText))
    assert.equal((await stat(join(scratch, 'main.jsonl'))).mode & 0o777, 0o600)
    secret.fill(0)
    console.log(JSON.stringify({ status: 'passed', mode: 'self-check', counts: finalCounts, durableReplay: true, failFirstAfterPersist: true, residual }))
  } finally {
    await receiver?.close().catch(() => undefined)
    await evidence?.close().catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  }
}

function signedHeaders(secret, body) {
  return {
    'content-type': 'application/json; charset=utf-8',
    [SIGNATURE_HEADER]: createHmac('sha256', secret).update(body).digest('base64'),
  }
}

function sendRequest(target, { method, path, body, headers = {} }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ ...target, method, path, headers }, response => {
      response.resume()
      response.on('end', () => resolveRequest({ status: response.statusCode }))
    })
    request.once('error', rejectRequest)
    if (body) request.end(body)
    else request.end()
  })
}

function slowRequest(target, signature) {
  return new Promise((resolveSlow, rejectSlow) => {
    const socket = netConnect(target.port, target.host)
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', rejectSlow)
    socket.on('data', chunk => { response += chunk })
    socket.once('connect', () => socket.write([
      `POST ${PATH} HTTP/1.1`, `Host: ${target.host}:${target.port}`, 'Content-Type: application/json',
      `X-Frappe-Webhook-Signature: ${signature}`, 'Content-Length: 10', 'Connection: close', '', '',
    ].join('\r\n')))
    socket.once('close', () => resolveSlow(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1])))
  })
}

function abortedRequest(target, signature) {
  return new Promise((resolveAbort, rejectAbort) => {
    const socket = netConnect(target.port, target.host)
    socket.once('error', rejectAbort)
    socket.once('connect', () => {
      socket.write([
        `POST ${PATH} HTTP/1.1`, `Host: ${target.host}:${target.port}`, 'Content-Type: application/json',
        `X-Frappe-Webhook-Signature: ${signature}`, 'Content-Length: 10', 'Connection: close', '', 'xx',
      ].join('\r\n'))
      socket.destroy()
      resolveAbort()
    })
  })
}

function incompleteHeaders(target) {
  return new Promise((resolveIncomplete, rejectIncomplete) => {
    const socket = netConnect(target.port, target.host)
    const timer = setTimeout(() => { socket.destroy(); rejectIncomplete(new ProbeError('header_timeout_failed')) }, 1_000)
    socket.once('error', error => { clearTimeout(timer); rejectIncomplete(error) })
    socket.once('connect', () => socket.write(`POST ${PATH} HTTP/1.1\r\nHost:`))
    socket.once('close', () => { clearTimeout(timer); resolveIncomplete(true) })
  })
}

function stdinChild(args, signal) {
  return new Promise((resolveChild, rejectChild) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectChild)
    const signalTimer = signal ? setTimeout(() => child.kill(signal), 100) : undefined
    const force = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('exit', code => {
      if (signalTimer) clearTimeout(signalTimer)
      clearTimeout(force)
      resolveChild({ code, stderr, elapsedMs: Date.now() - startedAt })
    })
  })
}

async function within(promise, timeoutMs, fallback) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(fallback), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function emitBounded(emit, value, deadline, stream) {
  const completed = await within(
    Promise.resolve().then(() => emit(value)).then(() => true),
    Math.min(OUTPUT_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
    false,
  )
  if (completed) return
  settleOutput(false, stream)
  throw new ProbeError('output_timeout')
}

function settleOutput(completed, stream) {
  if (!completed) stream?.destroy?.()
}

function isWithin(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (predicate()) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(10, remaining)))
  }
  throw new ProbeError('self_check_timeout')
}

function selfCheckOutputFailure() {
  process.stdout.write(Buffer.alloc(1024 * 1024, 0x78))
  throw new ProbeError('self_check_output_failure')
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfCheck) await selfCheck()
  else if (options.outputFailureSelfCheck) selfCheckOutputFailure()
  else await run(options)
} catch (error) {
  const code = error instanceof ProbeError && /^[a-z0-9_-]+$/i.test(error.code) ? error.code
    : error?.code === 'EADDRINUSE' ? 'port_in_use'
      : error?.code === 'EADDRNOTAVAIL' ? 'bridge_address_unavailable' : 'probe_failed'
  const selfCheckFailure = process.argv.includes('--self-check')
  const detail = selfCheckFailure ? String(error?.stack ?? error).replaceAll('P5-SELF-CHECK-SECRET-0123456789', '[redacted]') : undefined
  try { writeSync(2, `${JSON.stringify({ status: 'failed', error: code, ...(detail ? { detail, residual: error?.residual } : {}) })}\n`) } catch {}
  process.exit(1)
}
