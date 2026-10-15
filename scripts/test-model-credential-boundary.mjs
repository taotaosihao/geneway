import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-model-boundary-'))
const saved = Object.fromEntries(['DSH_HOME', 'GENEWAY_SECRET_ROOT', 'GENEWAY_MODEL_CREDENTIAL_REF', 'ZENMUX_API_KEY'].map(key => [key, process.env[key]]))
const secretRoot = join(root, 'secrets'), keyFile = join(secretRoot, 'model.key')
const storedKey = 'synthetic-unreferenced-stored-key', explicitKey = 'synthetic-explicit-model-key'
try {
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(keyFile, explicitKey, { mode: 0o600 })
  process.env.GENEWAY_SECRET_ROOT = secretRoot
  delete process.env.GENEWAY_MODEL_CREDENTIAL_REF
  process.env.ZENMUX_API_KEY = storedKey
  const missing = await boot('missing-ref')
  assert.equal(missing.environment.get('ZENMUX_API_KEY'), undefined)
  await assert.rejects(missing.request(), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(missing.resolverCalls(), 0)
  await missing.runner.disableKnowledge()
  await missing.runner.enableKnowledge()
  await missing.runner.close()

  process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
  const valid = await boot('valid-ref')
  assert.equal(valid.environment.get('ZENMUX_API_KEY').value, explicitKey)
  await valid.request()
  assert.equal(valid.resolverCalls(), 1)
  await writeFile(keyFile, 'synthetic-rotated-key', { mode: 0o600 })
  await assert.rejects(valid.request(), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(valid.resolverCalls(), 1)
  await writeFile(keyFile, explicitKey, { mode: 0o600 })
  delete process.env.GENEWAY_MODEL_CREDENTIAL_REF
  await assert.rejects(valid.request(), { code: 'MODEL_NOT_CONFIGURED' })
  await valid.runner.close()

  for (const [name, address, allowed] of [
    ['local-capture', 'http://127.0.0.1:12345/v1', true],
    ['remote-capture', 'https://example.invalid/v1', false],
    ['credential-url', 'http://user:password@127.0.0.1:12345/v1', false],
  ]) {
    const capture = await boot(name, { agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 10 }, environment: { GENEWAY_P3_CAPTURE_BASE_URL: address, GENEWAY_P3_CAPTURE_KEY: 'synthetic-local-capture' } })
    if (allowed) await capture.request()
    else await assert.rejects(capture.request(), { code: 'MODEL_NOT_CONFIGURED' })
    assert.equal(capture.resolverCalls(), Number(allowed))
    await capture.runner.close()
  }

  const addedAfterBoot = await boot('late-ref')
  process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
  await assert.rejects(addedAfterBoot.request(), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(addedAfterBoot.resolverCalls(), 0)
  await addedAfterBoot.runner.close()
  await checkDirectRunner()
  console.log('Model credential boundary checks passed: explicit refs precede resolvers; unconfigured maintenance works; stored/env keys and remote capture cannot bypass; direct ZenMux run fails closed (injected runtimes only)')
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(root, { recursive: true, force: true })
}

async function boot(name, overrides = {}) {
  const dshHome = join(root, name), listeners = new Map()
  await mkdir(dshHome, { mode: 0o700 })
  await writeFile(join(dshHome, '.credentials.yaml'), `ZENMUX_API_KEY: ${storedKey}\n`, { mode: 0o600 })
  process.env.DSH_HOME = dshHome
  let environment, resolverCalls = 0
  const ctx = {
    on(name, callback) { listeners.set(name, callback) },
    tools: { register() {}, guard() {}, schemas: () => [] },
    plugin: () => ({ async dispose() {} }),
  }
  const runner = createCollaborationRunner({ store: {}, dshHome, ...overrides, runProfileImpl: async options => { environment = options.environment; return { ctx, shutdown: { async shutdown() {} } } } })
  await runner.enableKnowledge()
  return { runner, environment, resolverCalls: () => resolverCalls,
    async request() {
      const next = async () => {
        resolverCalls += 1
        const key = environment.get('ZENMUX_API_KEY')?.value ?? storedKey
        assert(key)
        return overrides.agentOptions ?? { provider: 'zenmux', model: readRuntimeConfig({}).model.model }
      }
      const hook = listeners.get('agent/request')
      return hook ? hook({ agent: {}, signal: new AbortController().signal }, next) : next()
    },
  }
}

async function checkDirectRunner() {
  const dshHome = join(root, 'direct'), stop = new Error('injected Harness factory reached')
  await mkdir(dshHome, { mode: 0o700 })
  await writeFile(join(dshHome, '.credentials.yaml'), `ZENMUX_API_KEY: ${storedKey}\n`, { mode: 0o600 })
  let factories = 0
  const config = readRuntimeConfig({ GENEWAY_DSH_HOME: dshHome, GENEWAY_SECRET_ROOT: secretRoot }, process.cwd())
  const runner = createDshRunner({ config, harnessFactory: () => { factories += 1; throw stop } })
  const request = { capabilityId: 'cycle-time-calculate', input: { availableSeconds: 60, quantity: 1 },
    sessionMetadata: { ownerMemberId: 'member', workId: 'work', employeeId: 'agent', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', modelRouteId: 'route', confirmationFingerprint: 'none', confirmationRefs: [], connectionId: null, connectionRevision: null },
  }
  await assert.rejects(runner.run(request), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal(factories, 0)
  config.model.credentialRef = 'model.key'
  await assert.rejects(runner.run(request), error => error === stop)
  assert.equal(factories, 1)
  await runner.close()
}
