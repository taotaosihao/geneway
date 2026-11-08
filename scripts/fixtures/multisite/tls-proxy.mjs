import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { request as backendRequest } from 'node:http'

const execute = promisify(execFile)
// Test-only trust store and transparent streaming proxy; no system trust changes.
export async function createTlsProxy(directory, { target, idleTimeoutMs = 30000, idleControlPath } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const ca = join(directory, 'ca.crt'), key = join(directory, 'server.key'), cert = join(directory, 'server.crt')
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'ca.key'), '-out', ca, '-days', '1', '-subj', '/CN=Geneway local fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  await execute('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'server.csr'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'basicConstraints=critical,CA:FALSE'])
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', ca, '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-out', cert, '-days', '1', '-copy_extensions', 'copy'])
  for (const path of [key, join(directory, 'ca.key')]) await chmod(path, 0o600)
  const browserHome = join(directory, 'browser-home'), nss = join(browserHome, '.local/share/pki/nssdb')
  await mkdir(nss, { recursive: true, mode: 0o700 })
  await execute('/usr/bin/certutil', ['-N', '-d', `sql:${nss}`, '--empty-password'])
  await execute('/usr/bin/certutil', ['-A', '-d', `sql:${nss}`, '-n', 'geneway-local-fixture', '-t', 'C,,', '-i', ca])
  const streams = new Set(), observations = []
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, response) => {
    if (idleControlPath && incoming.url === idleControlPath) { response.writeHead(200, {'content-type':'text/event-stream'});response.flushHeaders();return }
    if (!target) { response.writeHead(503); response.end(); return }
    const upstream = backendRequest(new URL(incoming.url, target), { method: incoming.method, headers: incoming.headers }, received => {
      response.writeHead(received.statusCode, received.headers); response.flushHeaders()
      const stream = { response, upstream, path: incoming.url }; streams.add(stream)
      received.on('data', chunk => observations.push({ path: incoming.url, bytes: chunk.length, comment: chunk.toString('utf8').includes(': keepalive'), at: Date.now() }))
      received.once('aborted', () => response.destroy())
      received.once('error', () => response.destroy())
      received.pipe(response)
      response.once('close', () => { streams.delete(stream); upstream.destroy(); received.destroy() })
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    incoming.pipe(upstream)
    incoming.once('aborted', () => upstream.destroy())
  })
  server.setTimeout(idleTimeoutMs, socket => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  return { origin: `https://localhost:${port}`, ca, browserHome, observations, setTarget(value) { target = value }, disconnect(path) { for (const stream of streams) if (!path || stream.path === path) stream.response.destroy() }, async close() { for (const stream of streams) stream.response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
