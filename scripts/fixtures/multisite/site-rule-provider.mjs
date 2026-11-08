import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { binding, digest } from '../../../packages/agent-contracts/index.mjs'
import { SITE_RULE_TOOLS } from '../../../packages/agent-contracts/site-rule.mjs'

const usage = Object.freeze({ prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 })
const marker = '本次现场规则范围：'
const text = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const oneTool = (name, parameters) => ({ calls: [{ name, parameters }] })

export function siteRuleToolReplies(body) {
  const calls = new Map()
  for (const message of body.messages) if (message.role === 'assistant') for (const call of message.tool_calls ?? []) calls.set(call.id, call.function)
  return body.messages.filter(message => message.role === 'tool' && calls.has(message.tool_call_id)).map(message => {
    const call = calls.get(message.tool_call_id), result = JSON.parse(text(message.content))
    return { name: call.name, parameters: JSON.parse(call.arguments), result: result.result ?? result }
  })
}

// This server supplies finite native model decisions and two transport holds.
// It does not create Work, source receipts, Evidence, reads, or draft records.
export async function startSiteRuleProvider({ directory, readState, onError }) {
  const captures = [], holds = new Map(), responses = new Set(), ordinals = new Map()
  const wire = value => appendFile(join(directory, 'provider-wire.jsonl'), JSON.stringify(value) + '\n')
  async function send({ response, capture, decision }) {
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' })
    const tools = decision.calls?.map((call, index) => ({ index, id: 'site-tool-' + capture.sequence + '-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.parameters) } }))
    const deltas = [{ role: 'assistant', ...(tools ? { tool_calls: tools } : { content: decision.text }) }, {}]
    const chunks = deltas.map((delta, index) => ({ id: 'site-rule-' + capture.sequence, object: 'chat.completion.chunk', model: capture.body.model, choices: [{ index: 0, delta, finish_reason: index ? tools ? 'tool_calls' : 'stop' : null }], ...(index ? { usage } : {}) }))
    for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
    response.end('data: [DONE]\n\n'); capture.responseEndedAt = new Date().toISOString()
    await wire({ kind: 'completed-response', sequence: capture.sequence, at: capture.responseEndedAt, done: true, chunks, usageScope: 'synthetic loopback model usage; not a paid bill' })
  }
  const server = createServer(async (request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response))
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks), body = JSON.parse(raw), bodyDigest = digest(body)
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
      const state = await readState(), row = state.modelRequests.findLast(row => row.purpose === undefined && row.bodyDigest === bodyDigest && row.outcome === 'unknown')
      assert(row, 'Actual ordinary ledger reservation must precede provider request')
      const work = state.works.find(item => item.id === row.work_id); assert(work)
      const ordinal = (ordinals.get(row.attempt_id) ?? 0) + 1; ordinals.set(row.attempt_id, ordinal)
      const capture = { sequence: captures.length + 1, arrivedAt: new Date().toISOString(), path: request.url, method: request.method, bodyBytes: raw.length, bodyDigest, body, modelRequestId: row.id, binding: binding(row), lane: work.origin === 'rule' ? 'background' : 'foreground', ordinal }
      captures.push(capture); await wire({ kind: 'request', ...capture })
      let decision, hold
      if (capture.lane === 'foreground') {
        assert.equal(ordinal, 1); assert(!body.tools.some(tool => tool.function.name === 'geneway_submit_site_diagnosis'))
        hold = 'foreground-first'; decision = { text: '这是前台工作原Session的一次本地模拟推理，不生成业务成果。' }
      } else {
        assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), [...SITE_RULE_TOOLS].sort())
        const user = body.messages.filter(message => message.role === 'user').map(message => text(message.content)).findLast(value => value.includes(marker))
        assert(user)
        const descriptor = JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length))
        assert.equal(descriptor.eventId, work.siteRule.eventId); assert.equal(descriptor.eventAt, work.siteRule.eventAt); assert.equal(descriptor.instructionRevision, 1)
        assert.deepEqual(descriptor.window, work.siteRule.window)
        assert.equal(descriptor.resourceId, 'fixture:site'); capture.descriptor = descriptor
        if (ordinal === 1) {
          hold = 'background-first'; decision = oneTool('geneway_inspect_site', { clientRequestId: 'site-rule-capture', instructionRevision: descriptor.instructionRevision, resourceId: descriptor.resourceId, sections: ['recent_events'], window: descriptor.window })
        } else {
          const replies = siteRuleToolReplies(body), captured = replies.findLast(reply => reply.name === 'geneway_inspect_site')?.result
          assert.equal(captured?.status, 'ready'); assert.equal(captured.ref.kind, 'evidence')
          if (ordinal === 2) decision = oneTool('geneway_read_shared_evidence', { ref: captured.ref })
          else {
            assert.equal(ordinal, 3, 'No fourth background forward is authorized by this bounded native chain')
            const read = replies.findLast(reply => reply.name === 'geneway_read_shared_evidence'), page = read?.result
            assert(page?.siteRuleReadId && !page.partial); assert.deepEqual(page.ref, captured.ref); assert.deepEqual(read.parameters.ref, page.ref)
            assert(page.entries.some(item => item.sourceEventId === descriptor.eventId && item.sourceTimestamp === descriptor.eventAt))
            capture.evidencePage = page
            decision = oneTool('geneway_submit_site_diagnosis', { clientRequestId: 'site-rule-submit', instructionRevision: descriptor.instructionRevision, readId: page.siteRuleReadId })
          }
        }
      }
      capture.calls = decision.calls ?? []
      if (hold) {
        assert(!holds.has(hold)); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
        holds.set(hold, { response, capture, decision }); await wire({ kind: 'held-response', sequence: capture.sequence, hold, at: new Date().toISOString() })
      } else await send({ response, capture, decision })
    } catch (cause) {
      onError(cause)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SITE_RULE_FIXTURE_PROVIDER_ERROR' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + server.address().port, captures, isHeld: name => holds.has(name), capture: name => holds.get(name)?.capture,
    async release(name) {
      const item = holds.get(name); assert(item, 'Missing actual provider hold: ' + name); holds.delete(name)
      await wire({ kind: 'released-response', sequence: item.capture.sequence, hold: name, at: new Date().toISOString() }); await send(item)
    },
    async close() {
      for (const response of responses) response.destroy()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    },
  }
}
