import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { digest } from '../../packages/agent-contracts/index.mjs'
import { scenario } from './fixture.mjs'

const tool = (name, args) => ({ tool_calls: [{ index: 0, id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const usage = { prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 }

function route(input) {
  return input.events.map(event => {
    const known = /继续核对(事件历史|维护台账)/u.exec(event.text)?.[1]
    const target = !input.truncated && known && input.candidates.find(row => row.title.includes(known))
    const ignore = event.text.includes('无需处理或答复')
    return { sourceEventId: event.sourceEventId, eventVersion: event.eventVersion, targetWorkId: target ? target.workId : null,
      action: target ? 'attach' : ignore ? 'ignore' : 'clarify',
      reason: target ? '与获准工作主题相符。' : ignore ? '用户说明无需处理。' : '缺少可唯一定位的工作范围。',
      question: target || ignore ? null : '请明确要处理的工作或现场。' }
  })
}

function worker(body, input) {
  if (input.phase === 'review') {
    const scope = /核对(周二上午的维护台账|事件历史|维护台账)/u.exec(input.text)?.[1]
    return { content: scope ? '本次核对范围为' + scope + '。' : '已审阅并确认由当前工作处理。' }
  }
  if (!input.text.includes('现场交接码')) return { content: '已按当前要求核对范围。' }
  const prior = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
  const last = prior.at(-1)
  if (!last) return tool('geneway_read_history', { clientRequestId: 'history-' + input.sourceEventId, instructionRevision: input.instructionRevision, resourceId: 'fixture:history', datasetId: 'history' })
  if (!last.entries) return tool('geneway_read_shared_evidence', { ref: last.ref })
  if (last.partial) {
    assert(last.nextCursor)
    return tool('geneway_read_shared_evidence', { ref: last.ref, cursor: last.nextCursor })
  }
  const description = last.entries.at(-1)?.description
  assert(description)
  return { content: description }
}

export async function startProvider(record) {
  const responses = new Set(), failures = []
  let sequence = 0
  const server = createServer(async (request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response))
    const arrivedAt = new Date().toISOString()
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes)
      const input = JSON.parse(body.messages.findLast(message => message.role === 'user').content)
      const routing = input.schema === 'geneway.routing-batch/1'
      const current = ++sequence
      const priorTool = body.messages.some(message => message.role === 'tool')
      const delay = routing ? input.events.some(event => event.text.startsWith('请核对之前提到的表')) ? scenario.firstBurstRouterHoldMs : scenario.routerDelayMs
        : input.phase === 'execution' && input.text.includes('现场交接码') && !priorTool ? scenario.firstTailWorkerHoldMs : scenario.workerDelayMs
      const delta = routing ? { content: JSON.stringify({ decisions: route(input) }) } : worker(body, input)
      if (delta.tool_calls) delta.tool_calls[0].id += '-' + current
      await record({ type: 'provider', sequence: current, arrivedAt, body, bodyDigest: digest(body), bodyBytes: bytes.length, delay })
      await setTimeout(delay)
      const terminal = delta.tool_calls ? 'tool_calls' : 'stop'
      const includeUsage = !(routing && input.events.every(event => event.text.includes('无需处理或答复')))
      const chunk = (fragment, finish_reason, extra) => ({ id: 't25-' + current, model: body.model, choices: [{ index: 0, delta: fragment, finish_reason }], ...extra })
      const stream = [chunk(delta, null), chunk({}, terminal, includeUsage ? { usage } : {})]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(stream.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n')
      await record({ type: 'provider-response', sequence: current, finishedAt: new Date().toISOString(), stream })
    } catch (error) {
      failures.push(error.message)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{}')
      await record({ type: 'provider-failure', message: error.message })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: 'http://127.0.0.1:' + server.address().port, failures, async close() {
    for (const response of responses) response.destroy()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  } }
}
