import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function processIdentity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { pid, startTicks: fields[19], state: fields[0], parentPid: Number(fields[1]) }
  } catch (cause) { if (cause.code === 'ENOENT' || cause.code === 'ESRCH') return null; throw cause }
}
export async function waitFor(predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  for (;;) { const result = await predicate(); if (result) return result; assert(Date.now() < deadline, label + ' timed out'); await new Promise(resolve => setTimeout(resolve, 30)) }
}
export async function startChild({ path, args = [], env, directory, name, facts }) {
  const child = fork(path, args, { cwd: process.cwd(), env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const identity = await processIdentity(child.pid)
  assert(identity)
  facts.push({ kind: 'start', name, ...identity, at: new Date().toISOString() })
  child.once('exit', (code, signal) => facts.push({ kind: 'exit', name, pid: child.pid, startTicks: identity.startTicks, code, signal, at: new Date().toISOString() }))
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => { void appendFile(join(directory, name + '.' + stream + '.log'), bytes) })
  return { child, identity, name }
}
export async function signalOwned(item, signal, facts) {
  const current = await processIdentity(item.identity.pid)
  assert(current && current.startTicks === item.identity.startTicks, 'Owned process identity changed')
  item.child.kill(signal)
  facts.push({ kind: 'signal', name: item.name, pid: current.pid, startTicks: current.startTicks, signal, at: new Date().toISOString() })
}
export async function stopOwned(item, facts) {
  if (!item || item.child.exitCode !== null || item.child.signalCode !== null) return
  const current = await processIdentity(item.identity.pid)
  if (!current || current.startTicks !== item.identity.startTicks) return
  if (current.state === 'T' || current.state === 't') await signalOwned(item, 'SIGCONT', facts)
  const exited = new Promise(resolve => item.child.once('exit', resolve))
  await signalOwned(item, 'SIGTERM', facts)
  await exited
}
