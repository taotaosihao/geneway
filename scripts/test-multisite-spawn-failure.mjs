import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { createProcessRuntime } from '../packages/agent-host/process-runtime.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/multisite-spawn-failure-')
const execution = { work_id: 'spawn-work', delegation_id: 'spawn-delegation', parent_delegation_id: null, attempt_id: 'spawn-attempt', execution_epoch: 1, agent_id: 'coordinator', node_id: 'local', launch_id: 'spawn-launch', session_id: 'geneway-spawn-launch', runtimeStarted: false }
const gateway = { async issue() { return { token: 'synthetic-no-request', modelSnapshot: { provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', parameters: { maxOutputTokens: 4096 } } } } }
const config = readRuntimeConfig({ GENEWAY_STATE: directory + '/state.json' }, process.cwd()), runtime = createProcessRuntime({ root: process.cwd(), config, gateway, gatewayOrigin: () => 'http://127.0.0.1:1' })
const originalFork = childProcess.fork, events = [], failedChildren = []; let forks = 0
try {
  // A real failed spawn emits error+close and has no exit event or process identity.
  childProcess.fork = (path, args, options) => {
    forks++; const child = originalFork(path, args, { ...options, execPath: directory + '/missing-node' })
    child.on('error', cause => events.push({ type: 'error', code: cause.code })); child.on('exit', () => events.push({ type: 'exit' })); child.on('close', () => events.push({ type: 'close' }))
    child.closed = new Promise(resolve => child.once('close', resolve)); failedChildren.push(child)
    return child
  }
  syncBuiltinESMExports()
  await assert.rejects(runtime.start(execution), { code: 'RUNTIME_PROCESS_DIED' })
  const stopped = await runtime.stop(execution)
  assert.equal(stopped.evidence, 'never_started'); assert.equal(forks, 1)
  assert(events.some(row => row.type === 'error' && row.code === 'ENOENT')); assert(events.some(row => row.type === 'close')); assert(!events.some(row => row.type === 'exit'))
  await runtime.close()
  const stopOnly = createProcessRuntime({ root: process.cwd(), config, gateway, gatewayOrigin: () => 'http://127.0.0.1:1' })
  await assert.rejects(stopOnly.stop({ ...execution, runtimeStarted: true }), { code: 'RUNTIME_PROCESS_DIED' })
  await Promise.all(failedChildren.map(child => child.closed)); await stopOnly.close()
  assert.equal(forks, 2); assert.equal(events.filter(row => row.type === 'error').length, 2); assert.equal(events.filter(row => row.type === 'close').length, 2)
  console.log(JSON.stringify({ result: 'passed', directory, events, forks, neverStarted: true, stopOnlyFailureRejected: true, noReplacementLoop: true }, null, 2))
} finally { childProcess.fork = originalFork; syncBuiltinESMExports() }
