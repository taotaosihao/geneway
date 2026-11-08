import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Agent as HTTPAgent, createServer, request as httpRequest } from 'node:http'
import { Agent as HTTPSAgent, request as httpsRequest } from 'node:https'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function fixedOrigin(value) {
  const url = new URL(value)
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Proxy targets must be fixed HTTP(S) origins without credentials')
  return url
}
const at = () => new Date().toISOString()

export async function startRoleEgressProxy({ root, backendOrigin, protocol = null, label }) {
  assert(root && typeof label === 'string' && label, 'Provide the isolated evidence root and proxy label')
  root = resolve(root); await mkdir(root, { recursive: true, mode: 0o700 })
  const backend = fixedOrigin(backendOrigin), candidate = protocol ? fixedOrigin(protocol.origin) : null
  if (protocol?.caFile) assert.equal(candidate.protocol, 'https:', 'An explicit CA requires the HTTPS candidate target')
  const ca = protocol?.caFile ? await readFile(protocol.caFile) : undefined
  const agents = { backend: backend.protocol === 'https:' ? new HTTPSAgent({ keepAlive: true }) : new HTTPAgent({ keepAlive: true }), protocol: candidate?.protocol === 'https:' ? new HTTPSAgent({ keepAlive: true, ...(ca ? { ca } : {}) }) : new HTTPAgent({ keepAlive: true }) }
  const identity = { id: randomUUID(), label, pid: process.pid, role: 'measurement-egress-proxy', root }
  const requests = [], connections = [], events = [], incoming = new Set(), outgoing = new Set(), sockets = new Set(), socketRows = new WeakMap()
  let disconnected = false, closed = false, closing, origin, writes = Promise.resolve(), writeError
  function record(file, value) {
    writes = writes.then(() => appendFile(join(root, file + '.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 })).catch(error => { writeError ??= error })
  }
  function event(value) { const row = { at: at(), label, ...value }; events.push(row); record('events', row) }
  function socketValues(socket) { return { localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null, remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten, destroyed: socket.destroyed } }
  function trackSocket(socket, direction, channel) {
    if (socketRows.has(socket)) return socketRows.get(socket)
    const row = { id: randomUUID(), direction, channel, startedAt: at(), connectedAt: socket.connecting ? null : at(), endedAt: null, tlsAuthorized: null, ...socketValues(socket) }
    socketRows.set(socket, row); sockets.add(socket); connections.push(row); record('connections', { event: 'socket-observed', ...row })
    socket.once('connect', () => { Object.assign(row, socketValues(socket), { connectedAt: at() }); record('connections', { event: 'socket-connected', ...row }) })
    socket.once('secureConnect', () => { Object.assign(row, socketValues(socket), { tlsAuthorized: socket.authorized, tlsErrorCode: typeof socket.authorizationError === 'string' ? socket.authorizationError : null }); record('connections', { event: 'tls-established', ...row }) })
    socket.once('close', hadError => { Object.assign(row, socketValues(socket), { endedAt: at(), hadError }); sockets.delete(socket); record('connections', { event: 'socket-closed', ...row }) })
    return row
  }
  const server = createServer((request, response) => {
    const parsed = new URL(request.url, 'http://measurement.invalid'), isProtocol = parsed.pathname === '/protocol' || parsed.pathname.startsWith('/protocol/')
    const channel = isProtocol ? 'protocol' : 'backend', configured = isProtocol ? candidate : backend
    const socket = trackSocket(request.socket, 'incoming', null)
    const row = { id: randomUUID(), label, channel, method: request.method, path: parsed.pathname, queryKeys: [...parsed.searchParams.keys()], targetOrigin: configured?.origin ?? null, startedAt: at(), requestEndedAt: null, endedAt: null, status: null, requestBytes: 0, responseBytes: 0, requestChunks: 0, responseChunks: 0, incomingConnectionId: socket.id, outgoingConnectionId: null, errorCode: null }
    requests.push(row); incoming.add(response)
    record('wire', { event: 'request-started', ...row })
    let requestEnded = false, responseEnded = false, finished = false
    const finish = () => { if (!finished && requestEnded && responseEnded) { finished = true; row.endedAt = at(); incoming.delete(response); record('wire', { event: 'request-ended', ...row }) } }
    request.on('data', bytes => { row.requestBytes += bytes.length; row.requestChunks++ })
    request.once('end', () => { requestEnded = true; row.requestEndedAt = at(); finish() })
    request.once('close', () => { requestEnded = true; row.requestEndedAt ??= at(); finish() })
    request.once('error', error => { row.errorCode = error.code ?? 'INCOMING_REQUEST_ERROR' })
    response.once('finish', () => { responseEnded = true; row.endedBy = 'finish'; finish() })
    response.once('close', () => { responseEnded = true; row.endedBy ??= 'close'; finish() })
    const reject = (status, code) => {
      row.status = status; row.errorCode = code
      const bytes = Buffer.from(JSON.stringify({ error: { code } }))
      row.responseBytes += bytes.length; row.responseChunks++
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(bytes); request.resume()
    }
    if (closed || disconnected) { reject(503, 'EGRESS_DISCONNECTED'); return }
    if (!configured) { reject(503, 'PROTOCOL_TARGET_UNAVAILABLE'); return }
    const target = new URL(configured.origin)
    target.pathname = isProtocol ? parsed.pathname.slice('/protocol'.length) || '/' : parsed.pathname; target.search = parsed.search
    // Only path/search come from the request. Even //host or absolute-form
    // inputs cannot replace the fixed target origin or expose auth in logs.
    assert.equal(target.origin, configured.origin)
    let upstreamResponse
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: request.method, headers: { ...request.headers, host: target.host }, agent: agents[channel] }, received => {
      upstreamResponse = received; row.status = received.statusCode
      response.writeHead(received.statusCode, received.rawHeaders)
      received.on('data', bytes => { row.responseBytes += bytes.length; row.responseChunks++ })
      received.once('error', error => { row.errorCode = error.code ?? 'UPSTREAM_RESPONSE_ERROR'; response.destroy() })
      received.once('aborted', () => { row.errorCode ??= 'UPSTREAM_RESPONSE_ABORTED'; response.destroy() })
      // Node pipe preserves chunk streaming and applies backpressure; SSE is
      // never buffered as a whole response or parsed into replacement events.
      received.pipe(response)
    })
    outgoing.add(upstream)
    upstream.once('socket', socket => { row.outgoingConnectionId = trackSocket(socket, 'outgoing', channel).id })
    upstream.once('close', () => outgoing.delete(upstream))
    upstream.once('error', error => { row.errorCode = error.code ?? 'UPSTREAM_REQUEST_ERROR'; if (!response.headersSent && !response.destroyed) reject(502, row.errorCode); else response.destroy() })
    response.once('close', () => { upstreamResponse?.destroy(); upstream.destroy() })
    request.pipe(upstream)
  })
  server.on('connection', socket => trackSocket(socket, 'incoming', null))
  server.on('clientError', (error, socket) => { event({ event: 'client-error', code: error.code ?? 'HTTP_PARSE_ERROR' }); socket.destroy() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  event({ event: 'listening', origin, identity, backendOrigin: backend.origin, protocolOrigin: candidate?.origin ?? null })
  function snapshot() {
    for (const socket of sockets) Object.assign(socketRows.get(socket), socketValues(socket))
    return structuredClone({ label, origin, identity, disconnected, closed, requests, connections, events, totals: { requests: requests.length, requestBytes: requests.reduce((sum, row) => sum + row.requestBytes, 0), responseBytes: requests.reduce((sum, row) => sum + row.responseBytes, 0) }, logError: writeError?.code ?? null, byteBoundary: 'actual HTTP payload chunks; excludes HTTP header framing, TLS and IP overhead; socket counters are separate observations; proxy runs in the driver role and is not edge RSS' })
  }
  function setDisconnected(value) {
    assert.equal(typeof value, 'boolean')
    if (closed || value === disconnected) return
    event({ event: 'disconnect-policy-before', requested: value, incomingRequestIds: requests.filter(row => !row.endedAt).map(row => row.id), outgoingRequests: outgoing.size, sockets: [...sockets].map(socket => ({ id: socketRows.get(socket).id, ...socketValues(socket) })) })
    disconnected = value
    if (value) { for (const response of incoming) response.destroy(); for (const request of outgoing) request.destroy(); for (const socket of sockets) socket.destroy(); for (const agent of Object.values(agents)) agent.destroy() }
    event({ event: 'disconnect-policy-after', disconnected, origin, identityId: identity.id, sockets: [...sockets].map(socket => ({ id: socketRows.get(socket).id, ...socketValues(socket) })) })
  }
  return { origin, identity, setDisconnected, snapshot,
    close() { return closing ??= (async () => { closed = true; disconnected = true; event({ event: 'closing' }); const stopped = new Promise(resolve => server.close(resolve)); for (const response of incoming) response.destroy(); for (const request of outgoing) request.destroy(); for (const socket of sockets) socket.destroy(); for (const agent of Object.values(agents)) agent.destroy(); server.closeAllConnections(); await stopped; event({ event: 'closed' }); await writes; if (writeError) throw writeError })() },
  }
}
