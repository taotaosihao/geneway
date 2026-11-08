import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { bootDshHost } from '../src/dsh-host.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createDshRuntime } from '../packages/agent-host/dsh-runtime.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { seedMultisite } from './fixtures/multisite/runtime.mjs'

const root = process.cwd(), temp = await mkdtemp(join(tmpdir(), 'geneway-multisite-native-'))
const saved = Object.fromEntries(['HOME', 'DSH_HOME'].map(field => [field, process.env[field]]))
const requests = [], model = 'deepseek/deepseek-v4.1-flash', fakeKey = 'synthetic-local-multisite-capture'
let service, native, server
try {
  process.env.HOME = temp; process.env.DSH_HOME = join(temp, 'dsh')
  const store = createFileStore(join(temp, 'state.json')); await store.update(seedMultisite)
  server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(raw.includes(fakeKey), false)
      const tools = (body.tools ?? []).map(tool => tool.function?.name)
      assert.deepEqual(tools, ['geneway_multisite_report'])
      requests.push(body)
      const lastUser = body.messages.findLastIndex(message => message.role === 'user')
      const hasTool = body.messages.slice(lastUser + 1).some(message => message.role === 'tool')
      const content = JSON.stringify(body.messages[lastUser]?.content)
      const report = content.includes('ANSWER:') ? { state: 'ready', summary: '已收到补充，模拟推理结果仅为候选' } : { state: 'waiting', summary: '需要日期', question: '异常日期是什么？' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'capture-' + requests.length, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (!hasTool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `report-${requests.length}`, type: 'function', function: { name: 'geneway_multisite_report', arguments: JSON.stringify(report) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '本地模型替身已处理。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { response.writeHead(500); response.end(JSON.stringify({ error: { message: cause.message } })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const patch = join(temp, 'capture.patch.yml')
  await writeFile(patch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${server.address().port}/v1\n        compat:\n          supportsUsageInStreaming: true\n          supportsFinishReason: true\n          maxTokensField: max_tokens\n        models:\n          - id: ${model}\n            contextWindow: 200000\n            maxTokens: 4096\n`)
  const values = { PATH: process.env.PATH, HOME: temp, DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: fakeKey }
  const environment = { get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' }, getFrom: (name, sources) => sources.includes('process') && values[name] !== undefined ? { value: values[name], source: 'process' } : undefined }
  const runtime = createDshRuntime({ workspaceRoot: temp,
    boot: async () => native = await bootDshHost({ environment, profile: 'sdk', patchFiles: [join(root, 'config/p3-runtime.patch.yml'), patch], args: [] }),
    authorize: async execution => {
      const state = await store.read(), attempt = state.multisite.attempts.find(item => item.attempt_id === execution.attempt_id)
      assert(attempt && attempt.launch_id === execution.launch_id && !['stopping', 'cancelled'].includes(attempt.status))
    }, optionsFor: async () => ({ provider: 'zenmux', model, maxTokens: 4096 }),
  })
  const host = createAgentHost({ nodeId: 'local', journal: createHostJournal(join(temp, 'host.json')), runtime })
  service = createWorkService({ store, multisiteOptions: { hosts: [host], onError: cause => console.error('native probe dispatcher:', cause) } })
  const accepted = await service.createMultisite({ id: 'owner' }, { workType: 'multisite', employeeId: 'coordinator', goal: 'NATIVE_REQUEST:请整理异常资料，缺少日期先提问', clientRequestId: 'native-create' })
  service.multisite.start()
  await until(async () => (await store.read()).works[0].status === 'waiting_input')
  const first = await store.read()
  assert.equal(first.multisite.inputs[0].deliveries[0].ingestedAt !== null, true)
  const sessionId = first.multisite.attempts[0].session_id
  assert.equal(first.works[0].pendingQuestion.question, '异常日期是什么？')
  await service.multisite.apply({ id: 'owner' }, 'input', { workId: accepted.value.id, text: 'ANSWER:2026-11-05', clientRequestId: 'native-answer' })
  await until(async () => (await store.read()).multisite.attempts[0].report?.state === 'ready')
  assert.equal((await store.read()).works[0].status, 'running', 'ready report is not artifact acceptance')
  await service.multisite.apply({ id: 'owner' }, 'cancel', { workId: accepted.value.id, clientRequestId: 'native-stop' })
  await until(async () => (await store.read()).works[0].status === 'cancelled')
  await native.ctx.sessionPersistence.flush()
  const history = await native.ctx.sessionPersistence.open(sessionId, 'read')
  const events = (await history.read()).events; await history.close()
  assert.equal(events.filter(event => event.type === 'user/message').length, 2)
  assert(requests.length >= 4)
  console.log(JSON.stringify({ result: 'passed', boundary: 'one machine; real DSH 0.2.0-rc.2 Agent/Session/persistence; loopback synthetic model responses; no real model inference/image understanding', nativeSessions: 1, userMessages: 2, modelRequests: requests.length, reportQuestion: true, inputConsumedRevision: (await store.read()).multisite.attempts[0].observed_revision, durableStop: true, extraTools: [], hostSessionId: sessionId }, null, 2))
} finally {
  await service?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const [field, value] of Object.entries(saved)) if (value === undefined) delete process.env[field]; else process.env[field] = value
  await writeFile(join(temp, 'capture-requests.json'), JSON.stringify(requests, null, 2))
  console.log('Native probe evidence:', temp)
}
async function until(predicate) { const deadline = Date.now() + 45_000; while (!await predicate()) { assert(Date.now() < deadline, 'native journey timed out'); await new Promise(resolve => setTimeout(resolve, 100)) } }
