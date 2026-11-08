import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { bootDshHost } from '../src/dsh-host.mjs'
import { createDshRuntime } from '../packages/agent-host/dsh-runtime.mjs'
import { createDelegationTools } from '../packages/agent-host/delegation-tools.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-wait-race-')
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { freezeMessage } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-llm')).href)
const execution = { session_id: 'native-wait-race-session', launch_id: 'wait-race-launch' }, raceId = 'native-claimed-input-stable-id', firstId = 'initial-input'
const journal = createHostJournal(join(directory, 'host.json'))
let runtime, native, provider, calls = 0, parkedClaims = 0, proof
const saved = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME }
try {
  process.env.HOME = directory; process.env.DSH_HOME = join(directory, 'dsh')
  provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `wait-race-${calls}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (calls === 1) { send({ role: 'assistant', tool_calls: [{ index: 0, id: 'wait-race-tool', type: 'function', function: { name: 'geneway_wait_dependencies', arguments: JSON.stringify({ clientRequestId: 'durable-wait', instructionRevision: 1, dependencyIds: ['fixture-child'] }) } }] }); send({}, 'tool_calls') }
    else { send({ role: 'assistant', content: '已消费停车后重新唤醒的原始输入。' }); send({}, 'stop') }
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const patch = join(directory, 'provider.patch.yml')
  await writeFile(patch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        api: openai-completions\n        apiKeyEnv: TEST_KEY\n        baseURL: http://127.0.0.1:${provider.address().port}/v1\n        compat:\n          maxTokensField: max_tokens\n        models:\n          - id: deepseek/deepseek-v4.1-flash\n            contextWindow: 200000\n            maxTokens: 4096\n`)
  const values = { PATH: process.env.PATH, HOME: directory, DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: 'DISABLED', TEST_KEY: 'synthetic-only' }
  const environment = { get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' }, getFrom: (name, sources) => sources.includes('process') ? environment.get(name) : undefined }
  runtime = createDshRuntime({ workspaceRoot: directory, authorize: async () => {}, optionsFor: async () => ({ provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 4096 }),
    confirmPark: async () => { const pending = native.ctx.agents.get(execution.session_id).inbox; assert.equal(pending.nextStep.length, 0, 'official pre-step has actually claimed the raced input'); parkedClaims++; return (await journal.read()).executions.some(row => row.waitStatus === 'waiting_dependency') },
    toolsFor: () => createDelegationTools(async operation => {
      assert.equal(operation, 'wait_dependencies')
      await journal.update(state => { state.executions.push({ ...execution, waitStatus: 'waiting_dependency' }) })
      // Producer barrier: input arrives while the wait tool is running, so next pre-step claims it.
      native.ctx.agents.get(execution.session_id).inject(freezeMessage({ id: raceId, role: 'user', content: [{ type: 'text', text: '等待工具进行中到达的有效补充，保留原消息 ID。' }], source: { kind: 'geneway-multisite', form: 'relay' } }))
      return { status: 'waiting_dependency' }
    }, () => runtime.park(execution)),
    boot: async () => native = await bootDshHost({ environment, profile: 'sdk', patchFiles: [join(process.cwd(), 'config/multisite-runtime.patch.yml'), patch], args: [] }),
  })
  await runtime.deliver(execution, { id: firstId, text: '先登记依赖等待。' })
  await until(async () => calls === 1 && parkedClaims === 1 && (await runtime.inspectState(execution)).idle)
  const agent = native.ctx.agents.get(execution.session_id)
  assert.equal(agent.inbox.nextTurn.filter(row => row.id === raceId).length, 1)
  assert.equal(agent.session.snapshotEvents().filter(row => row.type === 'user/message' && row.data.id === raceId).length, 0)
  await writeFile(join(directory, 'parked-events.json'), JSON.stringify(agent.session.snapshotEvents(), null, 2))
  await runtime.deliver(execution, { id: raceId, text: '等待工具进行中到达的有效补充，保留原消息 ID。' })
  await until(async () => calls === 2 && (await runtime.inspectState(execution)).idle)
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(row => row.type === 'user/message' && row.data.id === raceId).length, 1)
  await runtime.deliver(execution, { id: raceId, text: '等待工具进行中到达的有效补充，保留原消息 ID。' })
  assert.equal(calls, 2, 'replay of an ingested message cannot wake a new turn')
  assert.equal(events.some(row => row.type.includes('cancel')), false)
  proof = { result: 'passed', directory, boundary: 'actual installed DSH pre-step/inbox/persistence; controlled native wait tool callback, main production IPC/Store flow covered separately', parkedNonEmptyClaim: true, stableId: raceId, userMessageCount: 1, actualProviderRequests: calls, noCancel: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(proof, null, 2)); await writeFile(join(directory, 'resumed-events.json'), JSON.stringify(events, null, 2)); console.log(JSON.stringify(proof, null, 2))
} finally { await runtime?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; console.log('Wait race evidence:', directory) }
async function until(predicate) { const deadline = Date.now() + 12_000; while (!await predicate()) { assert(Date.now() < deadline, 'native wait/claim/resume race timed out'); await new Promise(resolve => setTimeout(resolve, 40)) } }
