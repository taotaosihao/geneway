import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskState } from '@a2a-js/sdk'
import { RequestMalformedError } from '@a2a-js/sdk/errors'

export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error }
}
export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
}
export function executionDirectory(root, taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(taskId) || ['.', '..'].includes(taskId)) throw new RequestMalformedError('Invalid peer task ID')
  return join(root, 'executions', taskId)
}
const ownerKey = context => JSON.stringify([context?.tenant ?? '', context?.user?.isAuthenticated ? context.user.userName : null])
const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED])

// This store belongs only to the independent peer; it never writes Geneway state.
export class FileTaskStore {
  constructor(root) { this.root = root; this.path = join(root, 'tasks.json'); this.pending = Promise.resolve() }
  async load(id, context) { const state = await readJSON(this.path, { tasks: [] }); return structuredClone(state.tasks.find(row => row.owner === ownerKey(context) && row.task.id === id)?.task) }
  async save(task, context) {
    const run = this.pending.catch(() => {}).then(async () => {
      const state = await readJSON(this.path, { version: 1, tasks: [] }), owner = ownerKey(context), existing = state.tasks.find(row => row.owner === owner && row.task.id === task.id)
      if (existing && terminal.has(existing.task.status?.state) && JSON.stringify(existing.task) !== JSON.stringify(task)) throw new RequestMalformedError('A terminal peer task cannot be overwritten')
      if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
        const stopped = await readJSON(join(executionDirectory(this.root, task.id), 'cancel-proof.json'), null)
        if (!stopped?.exitObserved) throw new RequestMalformedError('Executor exit evidence is required before canceled')
      }
      const row = { owner, task: structuredClone(task) }
      if (existing) Object.assign(existing, row); else state.tasks.push(row)
      await writeJSON(this.path, state)
    })
    this.pending = run; return run
  }
  async list(params, context) {
    const state = await readJSON(this.path, { tasks: [] })
    const tasks = state.tasks.filter(row => row.owner === ownerKey(context)).map(row => row.task).filter(task => (!params.contextId || task.contextId === params.contextId) && (!params.status || task.status?.state === params.status) && (!params.statusTimestampAfter || task.status?.timestamp >= params.statusTimestampAfter)).sort((a, b) => b.id.localeCompare(a.id))
    const size = params.pageSize ?? 50, offset = params.pageToken ? Number(Buffer.from(params.pageToken, 'base64url').toString()) : 0
    if (!Number.isSafeInteger(size) || size < 1 || size > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new RequestMalformedError('Invalid peer task page')
    const page = structuredClone(tasks.slice(offset, offset + size))
    for (const task of page) { if (!params.includeArtifacts) task.artifacts = []; if (params.historyLength !== undefined) task.history = params.historyLength === 0 ? [] : task.history.slice(-params.historyLength) }
    return { tasks: page, totalSize: tasks.length, pageSize: size, nextPageToken: offset + size < tasks.length ? Buffer.from(String(offset + size)).toString('base64url') : '' }
  }
}
