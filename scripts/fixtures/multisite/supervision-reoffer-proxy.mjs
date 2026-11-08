import { createServer, request as httpRequest } from 'node:http'
import { StringDecoder } from 'node:string_decoder'

// Hold transport ACK before the API sees it; release on the second wire frame,
// since the remote connector awaits the first ACK before parsing that frame.
export async function startReofferProxy({ upstreamOrigin, holdTokensUntilReoffer = false, onHeldAck = () => {}, onError = () => {} }) {
  const traffic = [], frames = [], events = []
  let streamCount = 0, targetCommandId = null, held = false, release, holdTimer
  let allowTokens, tokensReleased = !holdTokensUntilReoffer
  const tokenGate = new Promise(resolve => { allowTokens = resolve })
  function releaseHeldAck(reason = 'cleanup') {
    if (release) { events.push({ kind: 'ack-released', reason, at: new Date().toISOString() }); clearTimeout(holdTimer); const resolve = release; release = null; resolve() }
    if (!tokensReleased) { tokensReleased = true; allowTokens() }
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks), path = new URL(request.url, upstreamOrigin).pathname
      const isStream = request.method === 'GET' && path === '/internal/bridge/events', stream = isStream ? ++streamCount : null
      const ack = path === '/internal/bridge/acks' ? JSON.parse(body) : null
      const row = { path, method: request.method, at: new Date().toISOString(), ...(stream ? { stream } : {}), ...(ack ? { ack } : {}) }; traffic.push(row)
      if (!tokensReleased && path === '/internal/executions/tokens') { events.push({ kind: 'runtime-token-request-held-before-api', at: new Date().toISOString() }); await tokenGate }
      if (ack?.commandId === targetCommandId && !held) {
        held = true
        await new Promise(resolve => {
          release = resolve
          holdTimer = setTimeout(() => { onError(new Error('Second same-stream frame did not arrive within the ACK hold window')); releaseHeldAck('hold-timeout') }, 6500)
          events.push({ kind: 'ack-held-before-api', commandId: ack.commandId, at: new Date().toISOString() })
          Promise.resolve(onHeldAck(ack)).catch(onError)
        })
      }
      const upstream = httpRequest(new URL(request.url, upstreamOrigin), { method: request.method, headers: { ...request.headers, host: new URL(upstreamOrigin).host } }, incoming => {
        row.status = incoming.statusCode; response.writeHead(incoming.statusCode, incoming.headers)
        const decoder = new StringDecoder('utf8'); let buffered = ''
        incoming.on('data', bytes => {
          if (isStream) {
            buffered += decoder.write(bytes)
            if (Buffer.byteLength(buffered) > 512 * 1024) { onError(new Error('Unbounded supervision fixture SSE frame')); incoming.destroy(); response.destroy(); return }
            let end
            while ((end = buffered.indexOf('\n\n')) >= 0) {
              const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2)
              if (!frame.split('\n').some(line => line === 'event: command')) continue
              try {
                const value = JSON.parse(frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'))
                const commandId = value.command_id ?? value.commandId, payloadDigest = value.payload_digest ?? value.payloadDigest
                frames.push({ stream, commandId, payloadDigest, at: new Date().toISOString() })
                targetCommandId ??= commandId
                if (held && commandId === targetCommandId && frames.filter(row => row.commandId === commandId && row.stream === stream).length === 2) releaseHeldAck('second-same-stream-wire-frame')
              } catch (cause) { onError(cause); incoming.destroy(); response.destroy(); return }
            }
          }
          response.write(bytes)
        })
        incoming.on('end', () => response.end())
        incoming.on('error', cause => { onError(cause); response.destroy() })
      })
      upstream.on('error', cause => { if (!response.destroyed) { onError(cause); response.destroy() } })
      response.once('close', () => upstream.destroy()); upstream.end(body)
    } catch (cause) { onError(cause); response.destroy() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`, traffic, frames, events,
    get targetCommandId() { return targetCommandId }, releaseHeldAck,
    async close() { releaseHeldAck(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
