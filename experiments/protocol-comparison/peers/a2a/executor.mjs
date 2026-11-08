import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentEvent } from '@a2a-js/sdk/server'
import { TaskState } from '@a2a-js/sdk'
import { RequestMalformedError, TaskNotCancelableError } from '@a2a-js/sdk/errors'
import { executionDirectory, readJSON, writeJSON } from './storage.mjs'

export async function processObservation(identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || !/^\d+$/.test(identity.startTicks)) throw new Error('Missing executor process identity')
  try {
    const stat = await readFile('/proc/' + identity.pid + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { alive: fields[19] === identity.startTicks && fields[0] !== 'Z', sameIdentity: fields[19] === identity.startTicks, osState: fields[0] }
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; return { alive: false, sameIdentity: false, osState: null } }
}
async function until(check, label) {
  const deadline = Date.now() + 10000
  while (!await check()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 15)) }
}
const textPart = value => ({ content: { $case: 'text', value }, mediaType: 'text/plain', filename: '', metadata: {} })

export class ProcessExecutor {
  constructor(root) { this.root = root; this.active = new Map() }
  async stopTask(taskId) {
    const directory = executionDirectory(this.root, taskId), identity = await readJSON(join(directory, 'identity.json'), null)
    if (!identity) throw new TaskNotCancelableError('No proven executor identity; cannot claim cancellation')
    await writeJSON(join(directory, 'cancel-request.json'), { taskId, requestedAt: new Date().toISOString() })
    const observed = await processObservation(identity)
    if (observed.alive) {
      // Check the recorded process identity again immediately before signaling.
      const latest = await processObservation(identity)
      if (latest.alive) try { process.kill(identity.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await until(async () => !(await processObservation(identity)).alive, 'Executor did not actually exit')
    }
    const final = await processObservation(identity)
    if (final.alive) throw new TaskNotCancelableError('Executor is still running')
    const proof = { taskId, identity, exitObserved: true, observation: final, observedAt: new Date().toISOString() }
    await writeJSON(join(directory, 'cancel-proof.json'), proof); return proof
  }
  async cancelTask(taskId, eventBus) {
    await this.stopTask(taskId)
    const contextId = this.active.get(taskId)?.contextId ?? (await readJSON(join(executionDirectory(this.root, taskId), 'input.json'))).contextId
    eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString() }, metadata: {} }))
    eventBus.finished()
  }
  async execute(context, eventBus) {
    const taskId = context.taskId, contextId = context.contextId
    const task = context.task ?? { id: taskId, contextId, history: [context.userMessage], artifacts: [], metadata: {}, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() } }
    eventBus.publish(AgentEvent.task(task))
    const directory = executionDirectory(this.root, taskId)
    try { await mkdir(directory, { recursive: false, mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') throw new RequestMalformedError('This peer does not re-execute an existing Task'); throw error }
    const options = context.userMessage.metadata?.peerExecution ?? {}, mode = options.mode ?? 'finite', steps = options.steps ?? 3, intervalMs = options.intervalMs ?? 25
    if (!['finite', 'busy'].includes(mode) || !Number.isSafeInteger(steps) || steps < 1 || steps > 10000 || !Number.isSafeInteger(intervalMs) || intervalMs < 5 || intervalMs > 1000) throw new RequestMalformedError('Invalid deterministic peer execution configuration')
    const text = context.userMessage.parts.filter(part => part.content?.$case === 'text').map(part => part.content.value).join('\n')
    await writeJSON(join(directory, 'input.json'), { taskId, contextId, mode, steps, intervalMs, text, inputDigest: createHash('sha256').update(JSON.stringify(context.userMessage)).digest('hex') })
    const child = spawn(process.execPath, [fileURLToPath(new URL('./executor-worker.mjs', import.meta.url)), directory], { cwd: directory, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: this.root } }); child.unref()
    this.active.set(taskId, { contextId, child })
    try {
      await until(async () => await readJSON(join(directory, 'identity.json'), null), 'Executor failed before publishing its process identity')
      eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() }, metadata: {} }))
      const identity = await readJSON(join(directory, 'identity.json'))
      // This polling observer is separate from the worker's side effects. It
      // never publishes a terminal state while the executor is still live.
      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => { try { if (!(await processObservation(identity)).alive) { clearInterval(timer); resolve() } } catch (error) { clearInterval(timer); reject(error) } }, 20); timer.unref()
      })
      if (await readJSON(join(directory, 'cancel-request.json'), null)) return
      const result = await readJSON(join(directory, 'result.json'))
      if (result.outcome !== 'completed') throw new Error('Executor exited without a completed result')
      eventBus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: { artifactId: randomUUID(), name: 'Independent executor output', description: 'Produced by the peer executor process', parts: [textPart(result.output)], metadata: { effects: result.effects, inputDigest: result.inputDigest }, extensions: [] }, append: false, lastChunk: true, metadata: {} }))
      eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() }, metadata: {} }))
      eventBus.finished()
    } finally { this.active.delete(taskId) }
  }
  async close({ preserveExecutors = false } = {}) {
    if (preserveExecutors) return
    for (const taskId of await readdir(join(this.root, 'executions'))) {
      const identity = await readJSON(join(executionDirectory(this.root, taskId), 'identity.json'), null)
      if (identity && (await processObservation(identity)).alive) await this.stopTask(taskId)
    }
  }
}
