import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJSON } from './storage.mjs'

const directory = process.argv[2], input = JSON.parse(await readFile(join(directory, 'input.json'), 'utf8'))
const stat = await readFile('/proc/self/stat', 'utf8'), startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
await writeJSON(join(directory, 'identity.json'), { pid: process.pid, startTicks, taskId: input.taskId, startedAt: new Date().toISOString() })
const effects = await open(join(directory, 'effects.jsonl'), 'ax', 0o600)
let stopped = false
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true })
try {
  let sequence = 0
  while (!stopped && (input.mode === 'busy' || sequence < input.steps)) {
    sequence++
    await effects.writeFile(JSON.stringify({ taskId: input.taskId, pid: process.pid, sequence, at: new Date().toISOString(), inputDigest: input.inputDigest }) + '\n'); await effects.sync()
    if (!stopped && (input.mode === 'busy' || sequence < input.steps)) await new Promise(resolve => setTimeout(resolve, input.intervalMs))
  }
  await writeJSON(join(directory, 'result.json'), { taskId: input.taskId, outcome: stopped ? 'stopped' : 'completed', effects: sequence, inputDigest: input.inputDigest, output: stopped ? null : input.text, finishedAt: new Date().toISOString() })
} finally { await effects.close() }
