import assert from 'node:assert/strict'
import { parseRunResult } from '../src/dsh-runner.mjs'

const callId = 'native-call'
const input = { availableSeconds: 3600, quantity: 60 }
const value = { ok: true, ...input, secondsPerUnit: 60, unit: 'seconds/unit' }
const options = { capabilityId: 'cycle-time-calculate', input }
const interval = {
  sessionId: 'native-session', finalResponse: '每件 60 秒。',
  events: [
    { type: 'tool/call', data: { callId, name: 'geneway_calculate_cycle_time', arguments: JSON.stringify(input) } },
    { type: 'tool/result', data: { message: {
      id: 'native-message', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    } } },
  ],
}

assert.equal(parseRunResult(interval, options).result.payload.secondsPerUnit, 60)
for (const mutate of [
  candidate => { candidate.events[1].data.message.role = 'assistant' },
  candidate => { candidate.events[1].data.message.source.kind = 'user' },
  candidate => { candidate.events[1].data.message.source.callId = 'other' },
  candidate => { candidate.events[1].data.message.toolCallId = 'other' },
  candidate => { candidate.events[1].data.message.isError = true },
  candidate => { delete candidate.events[1].data.message.isError },
  candidate => { candidate.events[1].data.message.content = [] },
  candidate => { candidate.events[1].data.message.content.push({ type: 'text', text: '{}' }) },
  candidate => { candidate.events[1].data.message.content[0].type = 'image' },
  candidate => { candidate.events[1].data.message.content[0].text = 'not-json' },
  candidate => { candidate.events[1].data.message.content[0].text = JSON.stringify({ ...value, secondsPerUnit: 61 }) },
  candidate => { candidate.events[1].data.message.content[0].text = JSON.stringify({ ...value, extra: 'undeclared' }) },
  candidate => { candidate.events[0].data.arguments = JSON.stringify({ ...input, quantity: 1 }) },
  candidate => { candidate.events[0].data.name = 'unexpected-tool' },
  candidate => { candidate.events.push(structuredClone(candidate.events[0])) },
  candidate => { candidate.events.splice(1, 1) },
  candidate => { candidate.finalResponse = '' },
]) {
  const candidate = structuredClone(interval)
  mutate(candidate)
  assert.throws(() => parseRunResult(candidate, options), error => error.code === 'TOOL_CHAIN_INVALID')
}
const legacy = structuredClone(interval)
legacy.events[1].data.message.content = [{ type: 'tool-result', toolCallId: callId, isError: false, content: interval.events[1].data.message.content }]
assert.throws(() => parseRunResult(legacy, options), error => error.code === 'TOOL_CHAIN_INVALID')
console.log('Native flat tool results accepted; identity, error, payload, call-count and legacy-envelope rejection checks passed; native starts=0')
