import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createProcessRuntime } from '../packages/agent-host/process-runtime.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-settle-')
const execution = { work_id: 'settle-work', delegation_id: 'settle-delegation', parent_delegation_id: null, attempt_id: 'settle-attempt', execution_epoch: 1, agent_id: 'coordinator', node_id: 'local', launch_id: 'settle-launch', session_id: 'geneway-settle-launch', runtimeStarted: false }
const modelSnapshot = { routeId: 'route', revision: 1, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', parameters: { maxOutputTokens: 4096 } }
const gateway = { async issue() { return { token: 'synthetic-no-request', modelSnapshot } }, async authorize() { return { current: { modelSnapshot } } } }
const config = readRuntimeConfig({ GENEWAY_STATE: directory + '/state.json' }, process.cwd()), runtime = createProcessRuntime({ root: process.cwd(), config, gateway, gatewayOrigin: () => 'http://127.0.0.1:1' })
assert.equal(await runtime.start(execution), execution.session_id); execution.runtimeStarted = true
const result = await runtime.settle(execution)
assert.equal(result.evidence, 'idle_after_cancel')
await runtime.close()
const recovered = createProcessRuntime({ root: process.cwd(), config, gateway: { async issue() { throw new Error('settlement must not start inference') } }, gatewayOrigin: () => 'http://127.0.0.1:1' })
assert.equal((await recovered.settle(execution)).evidence, 'idle_after_cancel'); await recovered.close()
console.log(JSON.stringify({ result: 'passed', directory, actualDshIdleFlushAndWorkerExit: true, actualRecoveredStopOnlySession: true }))
