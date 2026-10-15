import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const acceptance = await readFile(new URL('./accept-p3.mjs', import.meta.url), 'utf8')
const probe = await readFile(new URL('./probe-p3-delegation.mjs', import.meta.url), 'utf8')
const scratch = await mkdtemp(join(tmpdir(), 'geneway-runtime-isolation-check-'))
try {
  await checkSessionStaging()
  await checkPartialWorkerCreation()
  await checkSynchronousForkFailure()
  console.log('Session staging uses only the exported home; worker and synchronous fork failures clean up; native SDK/Cordis/model starts=0')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function checkSessionStaging() {
  const sourceHome = join(scratch, 'exported', 'dsh'), ambientHome = join(scratch, 'ambient'), targetHome = join(scratch, 'staged')
  const currentPath = join(sourceHome, 'sessions', 'native', 'current', 'session.v1.jsonl')
  const ambientPath = join(ambientHome, '.dsh', 'sessions', 'native', 'ambient-only', 'session.v1.jsonl')
  const current = '{"type":"request","content":"isolated-session"}\n'
  for (const path of [currentPath, ambientPath]) await mkdir(dirname(path), { recursive: true })
  await writeFile(currentPath, current)
  await writeFile(ambientPath, 'ambient-session-must-not-be-read')
  const visited = []
  const stageSessions = injectedFunction(acceptance, 'stageSessions', 'assertCandidate', {
    join, basename, dirname, mkdir, copyFile, chmod, readFile,
    dshHome: targetHome, lastCanaries: [], process: { env: { HOME: ambientHome } },
    sha256: value => createHash('sha256').update(value).digest('hex'),
    run: () => { throw new Error('plain synthetic Session needs no decoder') },
    collectFiles: async (path, files) => {
      visited.push(path)
      assert.equal(path, join(sourceHome, 'sessions'), 'Session staging must never inspect the ambient home')
      files.push(currentPath)
    },
  })
  const evidence = await stageSessions(['current', 'current'], sourceHome)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].requestEvents, 1)
  assert.equal(await readFile(join(targetHome, 'sessions', 'native', 'current', 'session.v1.jsonl'), 'utf8'), current)
  await assert.rejects(stageSessions(['ambient-only'], sourceHome), /associated DSH Session file is unavailable/)
  assert.deepEqual(visited, [join(sourceHome, 'sessions'), join(sourceHome, 'sessions')])
  const call = "stageSessions(collectWorkSessionRefs(state.works), join(exported.temp, 'dsh'))"
  assert.ok(acceptance.includes(`const sessions = await ${call}`))
  assert.ok(acceptance.includes(`harnessSource.includes("${call}")`), 'legacy --harness-check must enforce the same isolated source')
}

async function checkPartialWorkerCreation() {
  const events = [], creationError = Object.assign(new Error('synthetic second worker allocation failure'), { code: 'ENOSPC' })
  let finish, calls = 0
  const completed = new Promise(resolve => { finish = resolve })
  const worker = {
    home: '/synthetic/first-worker', started: new Promise(() => {}), completed,
    child: {
      exitCode: null, signalCode: null,
      kill(signal) {
        assert.equal(signal, 'SIGKILL')
        events.push('kill')
        this.signalCode = signal
        queueMicrotask(() => { events.push('closed'); finish({}) })
      },
    },
  }
  const probeRuntimeIsolation = injectedFunction(probe, 'probeRuntimeIsolation', 'startRuntimeChild', {
    assert,
    startRuntimeChild: async () => {
      calls += 1
      if (calls === 1) return worker
      throw creationError
    },
    rm: async (path, options) => {
      assert.equal(path, worker.home)
      assert.deepEqual(options, { recursive: true, force: true })
      events.push('removed')
    },
  })
  await assert.rejects(probeRuntimeIsolation(), error => error === creationError)
  assert.equal(calls, 2)
  assert.deepEqual(events, ['kill', 'closed', 'removed'])
}

async function checkSynchronousForkFailure() {
  const parent = join(scratch, 'fork-failure')
  await mkdir(parent)
  const forkError = Object.assign(new Error('synthetic synchronous fork failure'), { code: 'EAGAIN' })
  let forkCalls = 0, removedHome
  const startRuntimeChild = injectedFunction(probe, 'startRuntimeChild', 'probeRuntimeChild', {
    mkdtemp, join, fileURLToPath, tmpdir: () => parent, root: '/synthetic/repo', probeUrl: import.meta.url,
    process: { env: { PATH: process.env.PATH } },
    fork: (_script, args, options) => {
      forkCalls += 1
      assert.deepEqual(args, ['--runtime-isolation-child', 'runtime-close-w1'])
      assert.equal(options.env.DSH_HOME, options.env.HOME)
      throw forkError
    },
    rm: async (path, options) => { removedHome = path; await rm(path, options) },
  })
  await assert.rejects(startRuntimeChild('runtime-close-w1'), error => error === forkError)
  assert.equal(forkCalls, 1)
  assert.equal(dirname(removedHome), parent)
  assert.deepEqual(await readdir(parent), [])
}

function injectedFunction(source, name, next, dependencies) {
  const start = source.indexOf(`async function ${name}(`), end = source.indexOf(`\nasync function ${next}(`, start)
  assert(start >= 0 && end > start, `missing bounded source function: ${name}`)
  const body = source.slice(start, end).replaceAll('import.meta.url', 'probeUrl')
  return new Function('dependencies', `const { ${Object.keys(dependencies).join(', ')} } = dependencies; return (${body})`)(dependencies)
}
