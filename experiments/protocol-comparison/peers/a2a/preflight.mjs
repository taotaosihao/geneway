import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Role, TaskState } from '@a2a-js/sdk'
import { createA2aClient } from './client.mjs'
import { ProcessExecutor, processObservation } from './executor.mjs'
import { executionDirectory, readJSON } from './storage.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-a2a-peer-'), root = join(directory, 'peer')
const children = [], events = [], shutdown = []
let server, readyValue
const message = (text, execution) => ({ tenant: '', message: { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: {} }], metadata: execution ? { peerExecution: execution } : {}, extensions: [], referenceTaskIds: [] } })
async function until(check, label) { const end = Date.now() + 10000; while (!await check()) { assert(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 20)) } }
async function start() {
  const child = fork(fileURLToPath(new URL('./run.mjs', import.meta.url)), ['--config', join(directory, 'config.json')], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdoutParts = []; child.stderrParts = []; children.push(child)
  const value = await new Promise((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', bytes => { child.stdoutParts.push(bytes); buffered += bytes; let index; while ((index = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); try { const value = JSON.parse(line); if (value.event === 'ready') resolve(value) } catch (error) { reject(new Error('Non-JSON peer stdout: ' + line)) } } })
    child.stderr.on('data', bytes => child.stderrParts.push(bytes)); child.once('error', reject); child.once('exit', code => reject(new Error('Peer exited before ready: ' + code + ' ' + Buffer.concat(child.stderrParts).toString())))
  })
  events.push({ event: 'peer-ready', ...value }); return { child, value }
}
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done }
console.log(JSON.stringify({ event: 'starting', directory, pid: process.pid }))
try {
  await mkdir(root, { recursive: true }); await writeFile(join(directory, 'config.json'), JSON.stringify({ root, host: '127.0.0.1', port: 0, preserveExecutorsOnClose: true }), { mode: 0o600 })
  const first = await start(); server = first.child; readyValue = first.value
  console.log(JSON.stringify({ event: 'live', directory, origin: readyValue.origin, pid: server.pid }))
  const firstClient = await createA2aClient({ origin: readyValue.origin, tokenFile: readyValue.tokenFile }), client = firstClient.client
  assert.equal(firstClient.card.supportedInterfaces.length, 1); assert.equal(firstClient.card.supportedInterfaces[0].protocolBinding, 'JSONRPC')
  assert.equal(firstClient.card.supportedInterfaces[0].protocolVersion, '1.0'); assert.equal(firstClient.card.capabilities.pushNotifications, false)
  const text = '独立官方 SDK 对端的真实执行进程回声。', finite = await client.sendMessage(message(text), { signal: AbortSignal.timeout(10000) })
  assert.equal(finite.status.state, TaskState.TASK_STATE_COMPLETED)
  const output = finite.artifacts.flatMap(artifact => artifact.parts).filter(part => part.content?.$case === 'text').map(part => part.content.value).join('\n')
  assert.equal(output, text)
  const finiteResult = await readJSON(join(executionDirectory(root, finite.id), 'result.json'))
  assert.equal(finiteResult.outcome, 'completed'); assert.equal(finiteResult.effects, 3)
  const finiteEffects = (await readFile(join(executionDirectory(root, finite.id), 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(finiteEffects.map(row => row.sequence), [1, 2, 3]); assert.equal(new Set(finiteEffects.map(row => row.pid)).size, 1)
  assert.deepEqual(await client.getTask({ id: finite.id }), finite)
  const stream = []
  for await (const event of client.sendMessageStream(message('真实 SSE 回声。'), { signal: AbortSignal.timeout(10000) })) stream.push(event)
  assert.equal(stream[0].payload.$case, 'task'); assert(stream.some(row => row.payload.$case === 'artifactUpdate')); assert(stream.some(row => row.payload.$case === 'statusUpdate' && row.payload.value.status.state === TaskState.TASK_STATE_COMPLETED))
  const busyRequest = message('server 重启后仍须停止真实 executor。', { mode: 'busy', intervalMs: 20 })
  busyRequest.configuration = { returnImmediately: true }
  const busy = await client.sendMessage(busyRequest, { signal: AbortSignal.timeout(10000) })
  const busyDirectory = executionDirectory(root, busy.id)
  await until(async () => { const identity = await readJSON(join(busyDirectory, 'identity.json'), null); return identity && (await processObservation(identity)).alive && (await client.getTask({ id: busy.id })).status.state === TaskState.TASK_STATE_WORKING }, 'Busy task must be live before server restart')
  const identity = await readJSON(join(busyDirectory, 'identity.json')), beforeRestartBytes = (await stat(join(busyDirectory, 'effects.jsonl'))).size
  await writeFile(join(directory, 'before-restart.json'), JSON.stringify({ busy: await client.getTask({ id: busy.id }), identity, effectsBytes: beforeRestartBytes }, null, 2))
  await stop(server); assert.equal(server.exitCode, 0); assert((await processObservation(identity)).alive, 'Server restart must not impersonate executor cancellation')
  const second = await start(); server = second.child; readyValue = second.value
  const secondClient = await createA2aClient({ origin: readyValue.origin, tokenFile: readyValue.tokenFile }), current = secondClient.client
  const recovered = await current.getTask({ id: busy.id }); assert.equal(recovered.id, busy.id); assert.equal(recovered.status.state, TaskState.TASK_STATE_WORKING)
  await until(async () => (await stat(join(busyDirectory, 'effects.jsonl'))).size > beforeRestartBytes, 'The same executor must really continue producing side effects across API restart')
  assert((await processObservation(identity)).alive)
  const anonymous = await createA2aClient({ origin: readyValue.origin }); await assert.rejects(anonymous.client.getTask({ id: busy.id }))
  const unsupportedFollowup = message('This peer does not advertise follow-up execution'); unsupportedFollowup.message.taskId = busy.id
  await assert.rejects(current.sendMessage(unsupportedFollowup))
  assert.equal((await current.getTask({ id: busy.id })).status.state, TaskState.TASK_STATE_WORKING)
  assert((await processObservation(identity)).alive)
  const canceled = await current.cancelTask({ id: busy.id }, { signal: AbortSignal.timeout(10000) })
  assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED)
  const proof = await readJSON(join(busyDirectory, 'cancel-proof.json')); assert.equal(proof.exitObserved, true); assert.equal(proof.identity.pid, identity.pid)
  assert.equal((await processObservation(identity)).alive, false)
  const stoppedSize = (await stat(join(busyDirectory, 'effects.jsonl'))).size
  assert.equal((await current.getTask({ id: busy.id })).status.state, TaskState.TASK_STATE_CANCELED)
  assert.equal((await stat(join(busyDirectory, 'effects.jsonl'))).size, stoppedSize)
  const listed = await current.listTasks({ status: TaskState.TASK_STATE_UNSPECIFIED, includeArtifacts: true }); assert(listed.tasks.some(task => task.id === finite.id)); assert(listed.tasks.some(task => task.id === busy.id))
  await writeFile(join(directory, 'wire-results.json'), JSON.stringify({ card: secondClient.card, finite, finiteResult, finiteEffects, stream, recovered, canceled, proof, listed }, null, 2))
  const result = { result: 'passed', directory, protocol: 'a2a', sdk: '1.3.0', wire: '1.0', independentOfficialClientAndServer: true, finiteProcessEffects: 3, actualSSE: true, durableTaskQueryAcrossServerRestart: true, sameWorkerAcrossServerRestart: true, realPostRestartCancel: true, unauthorizedTaskQueryRejected: true, serverPids: children.map(child => child.pid), workerPid: identity.pid, boundary: 'isolated official SDK/Express JSON-RPC loopback HTTP with independent file TaskStore and real OS executor; explicit executor-exit guard is peer custom code, not an unmodified-SDK cancellation claim; no Geneway adapter/facts, TLS or full X01-X10 claim' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (error) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, events }, null, 2)); throw error }
finally {
  await new ProcessExecutor(root).close()
  for (const child of [...children].reverse()) { await stop(child); shutdown.push({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }); await writeFile(join(directory, 'peer-' + child.pid + '.stdout.jsonl'), Buffer.concat(child.stdoutParts)); await writeFile(join(directory, 'peer-' + child.pid + '.stderr.log'), Buffer.concat(child.stderrParts)) }
  await writeFile(join(directory, 'shutdown.json'), JSON.stringify(shutdown, null, 2)); await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2)); console.log(JSON.stringify({ event: 'closed', directory, shutdown }))
}
