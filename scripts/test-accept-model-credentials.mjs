import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readModelCredential, readRuntimeConfig } from '../src/runtime-config.mjs'

const scratch = await mkdtemp(join(tmpdir(), 'geneway-accept-model-check-'))
const sourceRoot = join(scratch, 'authorized-secrets')
const sourceRef = 'authorized-model.key'
const modelKey = 'synthetic-accept-model-key'
const failures = []
try {
  await mkdir(sourceRoot, { mode: 0o700 })
  await writeFile(join(sourceRoot, sourceRef), `${modelKey}\n`, { mode: 0o600 })
  for (const phase of ['p1', 'p2', 'p5']) {
    try { await checkCaller(phase) } catch (error) { failures.push(new Error(`${phase}: ${error.code ?? error.message}`, { cause: error })) }
  }
  if (failures.length) throw new AggregateError(failures, 'Acceptance child model credential staging failed')
  console.log('P1/P2/P5 child model references use isolated 0700 roots and 0600 files; P2 missing-source restore keeps its model; missing model fails before spawn; native/model/network starts=0')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function checkCaller(phase) {
  const source = await readFile(new URL(`./accept-${phase}.mjs`, import.meta.url), 'utf8')
  const body = source.match(/async function startServer\([\s\S]*?\n\}/)?.[0]
  assert(body, `${phase} startServer is unavailable`)
  const targetRoot = join(scratch, phase, 'secrets')
  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  const env = { GENEWAY_SECRET_ROOT: sourceRoot, GENEWAY_MODEL_CREDENTIAL_REF: sourceRef }
  const paths = { state: join(scratch, phase, 'state.json'), auth: join(scratch, phase, 'auth.json'), catalog: join(scratch, phase, 'connections.json'), secrets: targetRoot, dsh: join(scratch, phase, 'dsh') }
  const config = { runtime: readRuntimeConfig(env, scratch), gearJobUrl: 'http://127.0.0.1:1', gearJobHost: 'fixture.local', workOrderId: 'fixture-work' }
  const child = { exitCode: null, stderr: { on() {} } }
  const spawned = []
  const dependencies = {
    process: { execPath: process.execPath, env }, root: scratch, port: 1, appUrl: 'http://127.0.0.1:1',
    statePath: paths.state, authPath: paths.auth, connectionCatalogPath: paths.catalog, secretRoot: targetRoot, dshHome: paths.dsh,
    EVENT_SOURCE_ID: 'synthetic', EVENT_SOURCE_ADDRESS: '127.0.0.1', EVENT_HOST: '127.0.0.1', EVENT_PORT: 1,
    readModelCredential, readRuntimeConfig, mkdir, writeFile, chmod, join,
    spawn: (_executable, _args, options) => { spawned.push(options); return child },
    fetch: async () => ({ ok: true }),
  }
  const startServer = new Function(...Object.keys(dependencies), `return (${body})`)(...Object.values(dependencies))
  const start = overrides => phase === 'p5' ? startServer({ ...paths, ...overrides }, 'http://127.0.0.1:1', 1, config) : startServer(overrides)
  await start()
  await checkChild(spawned.at(-1), targetRoot)
  const stagedPath = join(targetRoot, spawned.at(-1).env.GENEWAY_MODEL_CREDENTIAL_REF)
  await chmod(stagedPath, 0o644)
  await start()
  await checkChild(spawned.at(-1), targetRoot)

  if (phase === 'p2') {
    const missingSourceRoot = join(scratch, phase, 'restored-empty-secrets')
    await mkdir(missingSourceRoot, { mode: 0o700 })
    await start({ secret: missingSourceRoot })
    await checkChild(spawned.at(-1), missingSourceRoot)
    await assert.rejects(stat(join(missingSourceRoot, 'gearjob-a.json')), { code: 'ENOENT' })
  }

  const before = spawned.length
  env.GENEWAY_MODEL_CREDENTIAL_REF = 'missing-model.key'
  config.runtime = readRuntimeConfig(env, scratch)
  await assert.rejects(start(), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(spawned.length, before, 'an unavailable authorized model must not spawn the child')
  assert.equal((await stat(join(sourceRoot, sourceRef))).mode & 0o777, 0o600)
}

async function checkChild(options, secretRoot) {
  const config = readRuntimeConfig(options.env, scratch)
  assert.equal(config.model.secretRoot, secretRoot)
  assert.equal(await readModelCredential(config), modelKey)
  assert.equal((await stat(secretRoot)).mode & 0o777, 0o700)
  assert.equal((await stat(join(secretRoot, config.model.credentialRef))).mode & 0o777, 0o600)
  assert.equal(JSON.stringify(options).includes(modelKey), false, 'the key must never enter spawn options or child environment')
}
