import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fork } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Provide an actual process PID')
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { pid, startTicks: fields[19], osState: fields[0], parentPid: Number(fields[1]) }
  } catch (cause) { if (cause.code === 'ENOENT' || cause.code === 'ESRCH') return null; throw cause }
}

export async function prepareIntegratedWatchdog(directory, { nodeIds }) {
  directory = resolve(directory)
  assert(Array.isArray(nodeIds) && nodeIds.length && nodeIds.every(id => typeof id === 'string' && id.length) && new Set(nodeIds).size === nodeIds.length, 'Provide the current Node scope')
  const secretRoot = join(directory, 'integrated-watchdog-credentials'), credentialRef = 'observe.token', credentialFile = join(secretRoot, credentialRef), configPath = join(directory, 'integrated-supervision-identities.json')
  await mkdir(secretRoot, { recursive: true, mode: 0o700 })
  await writeFile(credentialFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
  await writeFile(configPath, JSON.stringify({ secretRoot, identities: [{ id: 'integrated-observer', role: 'observe', workspaceId: 'local', nodeIds: [...nodeIds], credentialRef }] }, null, 2), { mode: 0o600, flag: 'wx' })
  return { configPath, credentialFile }
}

export async function startIntegratedWatchdog({ directory, origin, apiPid, parents, credentialFile, intervalMs = 100 }) {
  directory = resolve(directory)
  assert(Array.isArray(parents) && parents.length, 'Provide the actual remote parent processes')
  assert(Number.isSafeInteger(intervalMs) && intervalMs > 0)
  const api = await processIdentity(apiPid)
  assert(api && api.parentPid === process.pid, 'The API must be a live sibling started by this producer')
  const hostProcesses = await Promise.all(parents.map(async parent => {
    const identity = await processIdentity(parent.pid)
    assert(identity && identity.parentPid === process.pid, 'Each Host must be a live sibling started by this producer')
    assert(typeof parent.nodeId === 'string' && parent.nodeId)
    return { ...identity, name: 'host', agent: parent.agent, nodeId: parent.nodeId }
  }))
  const root = join(directory, 'integrated-watchdog'), stateFile = join(root, 'watchdog-state.json'), cliConfigPath = join(directory, 'integrated-watchdog-config.json'), observationsFile = join(directory, 'watchdog-observations.jsonl'), processFile = join(directory, 'integrated-watchdog-process.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const config = { origin, credentialFile: resolve(credentialFile), root, intervalMs, timeoutMs: 1000, stageDeadlineMs: 600000, processes: [{ name: 'api', pid: api.pid, startTicks: api.startTicks, nodeId: 'cloud' }, ...hostProcesses.map(row => ({ name: row.name, pid: row.pid, startTicks: row.startTicks, nodeId: row.nodeId }))], scope: { workId: null, attemptId: null, nodeId: 'cloud', nodeInstanceId: null } }
  await writeFile(cliConfigPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
  await writeFile(join(directory, 'integrated-watchdog.stdout.log'), '')
  await writeFile(join(directory, 'integrated-watchdog.stderr.log'), '')
  const child = fork(fileURLToPath(new URL('../../../src/supervision-watchdog.mjs', import.meta.url)), [cliConfigPath], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const startedAt = new Date().toISOString(), exitResult = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal, at: new Date().toISOString() })))
  let outputWrites = Promise.resolve()
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => { outputWrites = outputWrites.then(() => appendFile(join(directory, 'integrated-watchdog.' + stream + '.log'), bytes)) })
  const identity = await processIdentity(child.pid)
  assert(identity && identity.parentPid === process.pid, 'The watchdog must be an independent sibling process')
  const processFacts = { startedAt, watchdog: identity, api, hosts: hostProcesses, exit: null, finalObservation: null }
  await writeFile(processFile, JSON.stringify(processFacts, null, 2))
  const seen = new Set(); let closed = false, timer, collecting = Promise.resolve(), collectionError, closePromise
  async function collect() {
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
    for (const sample of state.samples ?? []) if (!seen.has(sample.sampledAt)) {
      // The product's ring retains a missed sample's OS/freshness facts, not its
      // earlier business snapshot. Never attach a later snapshot to that time.
      const value = sample.sampledAt === state.sampledAt ? state : { ...sample, observationKind: 'sample-metadata-only', lastSnapshot: null }
      await appendFile(observationsFile, JSON.stringify(value) + '\n')
      seen.add(sample.sampledAt)
    }
    if (state.sampledAt && !seen.has(state.sampledAt)) {
      await appendFile(observationsFile, JSON.stringify(state) + '\n')
      seen.add(state.sampledAt)
    }
    return state
  }
  function sample() {
    const pending = collecting.then(collect)
    collecting = pending.catch(cause => { collectionError = cause })
    return pending
  }
  const watcher = watch(root, () => { if (!closed) void sample().catch(() => {}) })
  watcher.on('error', cause => { collectionError = cause })
  timer = setInterval(() => { if (!closed) void sample().catch(() => {}) }, Math.max(5, Math.floor(intervalMs / 4)))
  return {
    child, stateFile,
    async phase(name, predicate) {
      assert(/^[A-Za-z0-9_-]+$/.test(name), 'Use a bounded phase filename')
      assert(typeof predicate === 'function')
      const deadline = Date.now() + 120000
      for (;;) {
        if (collectionError) throw collectionError
        const state = await sample()
        if (state && await predicate(state.lastSnapshot, state)) {
          await writeFile(join(directory, 'watchdog-phase-' + name + '.json'), JSON.stringify(state, null, 2))
          return state
        }
        assert(!closed, 'The watchdog was closed before this phase')
        assert(child.exitCode === null && child.signalCode === null, 'The watchdog exited before this phase')
        assert(Date.now() < deadline, 'No actual watchdog sample matched phase ' + name)
        await new Promise(resolveWait => setTimeout(resolveWait, Math.max(10, Math.floor(intervalMs / 2))))
      }
    },
    close() {
      return closePromise ??= (async () => {
        closed = true; clearInterval(timer); watcher.close()
        try { await sample() } catch (cause) { collectionError ??= cause }
        const current = await processIdentity(identity.pid)
        if (child.exitCode === null && child.signalCode === null && current?.startTicks === identity.startTicks) {
          if (current.osState === 'T' || current.osState === 't') child.kill('SIGCONT')
          child.kill('SIGTERM')
        }
        processFacts.exit = await exitResult
        try { await sample() } catch (cause) { collectionError ??= cause }
        await collecting; await outputWrites
        processFacts.finalObservation = await processIdentity(identity.pid)
        assert(processFacts.finalObservation === null || processFacts.finalObservation.startTicks !== identity.startTicks || processFacts.finalObservation.osState === 'Z', 'The owned watchdog process still runs')
        processFacts.currentGone = processFacts.finalObservation === null
        await writeFile(processFile, JSON.stringify(processFacts, null, 2))
        if (collectionError) throw collectionError
      })()
    },
  }
}
