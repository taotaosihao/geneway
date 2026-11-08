import { createServer } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from '../../../packages/agent-contracts/index.mjs'

// The test owns only model decisions and transport barriers. Ledger outcomes,
// finding IDs and Session events must come from the production API and SDK.
export async function startDiagnosisProvider({ directory, decide, onError }) {
  const captures = [], held = new Map(), responses = new Set()
  let closed = false
  const record = value => appendFile(join(directory, 'provider-wire.jsonl'), JSON.stringify(value) + '\n')
  function send(response, capture, decision) {
    const calls = decision.calls ?? []
    const emit = (delta, finish_reason) => {
      const chunk = { id: 'diagnosis-fixture-' + capture.sequence, object: 'chat.completion.chunk', model: capture.body.model, choices: [{ index: 0, delta, finish_reason }] }
      response.write('data: ' + JSON.stringify(chunk) + '\n\n')
      return chunk
    }
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' })
    const wire = []
    if (calls.length) {
      wire.push(emit({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: 'tool-' + capture.sequence + '-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.parameters) } })) }, null))
      wire.push(emit({}, 'tool_calls'))
    } else {
      wire.push(emit({ role: 'assistant', content: decision.text }, null))
      wire.push(emit({}, 'stop'))
    }
    response.end('data: [DONE]\n\n')
    capture.responseEndedAt = new Date().toISOString()
    return record({ kind: 'completed-response', sequence: capture.sequence, at: capture.responseEndedAt, chunks: wire, done: true })
  }
  const server = createServer(async (request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response))
    try {
      const parts = []; for await (const part of request) parts.push(part)
      const raw = Buffer.concat(parts), body = JSON.parse(raw)
      const capture = { sequence: captures.length + 1, arrivedAt: new Date().toISOString(), path: request.url, method: request.method, bodyBytes: raw.length, bodyDigest: digest(body), body }
      captures.push(capture)
      await record({ kind: 'request', ...capture })
      const decision = await decide(capture, captures)
      if (decision.hold) {
        if (held.has(decision.hold)) throw Error('Duplicate provider hold key')
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
        held.set(decision.hold, { response, capture, decision })
        await record({ kind: 'held-response', sequence: capture.sequence, hold: decision.hold, at: new Date().toISOString() })
      } else await send(response, capture, decision)
    } catch (cause) {
      onError(cause)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SYNTHETIC_PROVIDER_FAILURE' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: 'http://127.0.0.1:' + server.address().port, captures,
    isHeld: key => held.has(key),
    async release(key, decision) {
      const item = held.get(key); if (!item) throw Error('Provider hold missing')
      held.delete(key)
      await record({ kind: 'released-response', sequence: item.capture.sequence, hold: key, at: new Date().toISOString() })
      await send(item.response, item.capture, decision)
    },
    async truncate(key) {
      const item = held.get(key); if (!item) throw Error('Provider hold missing')
      held.delete(key)
      const chunk = { id: 'diagnosis-fixture-' + item.capture.sequence, object: 'chat.completion.chunk', model: item.capture.body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '这是一段未完成的模型响应，不是完成结论。' }, finish_reason: null }] }
      await new Promise((resolve, reject) => item.response.write('data: ' + JSON.stringify(chunk) + '\n\n', cause => cause ? reject(cause) : resolve()))
      await record({ kind: 'partial-response', sequence: item.capture.sequence, at: new Date().toISOString(), chunk, done: false })
      item.response.destroy(); item.capture.responseTruncatedAt = new Date().toISOString()
      await record({ kind: 'truncated-response', sequence: item.capture.sequence, hold: key, at: item.capture.responseTruncatedAt, done: false })
    },
    async close() {
      if (closed) return; closed = true
      for (const response of responses) response.destroy()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    },
  }
}
