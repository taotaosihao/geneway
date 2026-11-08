import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from '../../../packages/agent-contracts/index.mjs'

export const ROUTING_MOCK_USAGE = Object.freeze({ prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 })

// Model decisions and provider transport only; requests, batches, accounting and
// business effects must be produced by the real API rather than this fixture.
export async function startRoutingBatchProvider({ directory, decide, onError }) {
  const captures = [], held = new Map(), responses = new Set()
  const wire = value => appendFile(join(directory, 'provider-wire.jsonl'), JSON.stringify(value) + '\n')
  async function respond(item, decisions) {
    const { response, capture } = item
    assert(Array.isArray(decisions))
    const chunks = [{ role: 'assistant', content: JSON.stringify({ decisions }) }, {}].map((delta, index) => ({ id: 'routing-fixture-' + capture.sequence, object: 'chat.completion.chunk', model: capture.body.model, choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }], ...(index ? { usage: ROUTING_MOCK_USAGE } : {}) }))
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
    response.end('data: [DONE]\n\n'); capture.responseEndedAt = new Date().toISOString(); capture.decisions = decisions
    await wire({ kind: 'completed-response', sequence: capture.sequence, at: capture.responseEndedAt, chunks, done: true, usageScope: 'synthetic whole-request usage, not per-event measurements or a paid bill' })
  }
  const server = createServer(async (request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response))
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks), body = JSON.parse(raw), input = JSON.parse(body.messages.findLast(message => message.role === 'user').content)
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
      assert.equal(input.schema, 'geneway.routing-batch/1'); assert(Array.isArray(input.events) && input.events.length > 0 && input.events.length <= 4)
      assert.equal(body.tools.length, 0)
      const capture = { sequence: captures.length + 1, arrivedAt: new Date().toISOString(), path: request.url, method: request.method, bodyBytes: raw.length, bodyDigest: digest(body), body, input }
      captures.push(capture); await wire({ kind: 'request', ...capture })
      const decision = await decide(capture)
      if (decision.hold) {
        assert(!held.has(decision.hold)); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
        held.set(decision.hold, { response, capture })
        await wire({ kind: 'held-response', sequence: capture.sequence, hold: decision.hold, at: new Date().toISOString() })
      } else await respond({ response, capture }, decision.decisions)
    } catch (cause) {
      onError(cause)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'ROUTING_FIXTURE_PROVIDER_ERROR' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: 'http://127.0.0.1:' + server.address().port, captures,
    isHeld: name => held.has(name),
    capture: name => held.get(name)?.capture,
    async release(name, decisions) {
      const item = held.get(name); assert(item, 'Expected real held routing response: ' + name); held.delete(name)
      await wire({ kind: 'released-response', sequence: item.capture.sequence, hold: name, at: new Date().toISOString() })
      await respond(item, decisions)
    },
    async truncate(name) {
      const item = held.get(name); assert(item); held.delete(name)
      const chunk = { id: 'routing-fixture-' + item.capture.sequence, choices: [{ index: 0, delta: { role: 'assistant', content: '{"decisions":[' }, finish_reason: null }] }
      await new Promise((resolve, reject) => item.response.write('data: ' + JSON.stringify(chunk) + '\n\n', cause => cause ? reject(cause) : resolve()))
      await wire({ kind: 'partial-response', sequence: item.capture.sequence, at: new Date().toISOString(), chunk, done: false })
      item.response.destroy(); item.capture.truncatedAt = new Date().toISOString()
      await wire({ kind: 'truncated-response', sequence: item.capture.sequence, at: item.capture.truncatedAt, done: false })
    },
    async close() {
      for (const response of responses) response.destroy()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    },
  }
}
