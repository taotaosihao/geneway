import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export function createSessionCompatibilityProvider({ save, input2 }) {
  const marker = 'OLD_ASSISTANT_ONLY_' + randomBytes(24).toString('hex'), bodies = [], responses = [], failures = []
  let input2Authorized = false
  const includes = (message, text) => JSON.stringify(message).includes(text)
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const bytes of request) chunks.push(bytes)
      const body = JSON.parse(Buffer.concat(chunks)), sequence = bodies.length + 1
      bodies.push({ sequence, observedAt: new Date().toISOString(), body }); await save('provider-bodies.json', bodies)
      assert(sequence <= 4, 'Unexpected additional model forward')
      if (sequence > 2) {
        assert(input2Authorized, 'A new model request preceded explicit owner Input2')
        assert(body.messages.some(row => row.role === 'user' && includes(row, input2)), 'Actual forward lacks owner Input2')
        assert(body.messages.some(row => row.role === 'assistant' && includes(row, marker)), 'Actual forward lacks old assistant-only history')
        assert(!body.messages.some(row => ['system', 'user', 'tool'].includes(row.role) && includes(row, marker)), 'Old marker escaped assistant-only history')
      } else assert(!body.messages.some(row => row.role === 'user' && includes(row, input2)))
      let delta, reason
      if (sequence === 1 || sequence === 3) {
        const old = sequence === 1
        delta = { role: 'assistant', ...(old ? { content: '仅保存在本轮助手历史中的记号：' + marker } : {}), tool_calls: [{ index: 0, id: old ? 'compat-waiting-report' : 'compat-resumed-report', type: 'function', function: { name: 'geneway_multisite_report', arguments: JSON.stringify(old ? { state: 'waiting', summary: '首轮核对已保存，等待原用户补充后继续。', question: '请补充下一步核对要求。' } : { state: 'ready', summary: '已在原会话消费用户补充并提交续办结果。' }) } }] }
        reason = 'tool_calls'
      } else { delta = { role: 'assistant', content: sequence === 2 ? '本轮已结束，等待用户补充。' : '本次续办结果已提交。' }; reason = 'stop' }
      if (sequence !== 1) assert(!JSON.stringify(delta).includes(marker), 'Provider must never reintroduce the old marker')
      responses.push({ sequence, delta, finishReason: reason }); await save('provider-responses.json', responses)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n')
    } catch (cause) {
      failures.push({ observedAt: new Date().toISOString(), message: cause.message, stack: cause.stack }); await save('provider-failures.json', failures)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{}')
    }
  })
  return { server, marker, bodies, responses, failures, authorizeInput2() { input2Authorized = true } }
}
