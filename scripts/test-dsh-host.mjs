import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { inspect } from 'node:util'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const source = await readFile('src/dsh-host.mjs', 'utf8')
const implementation = source.slice(source.indexOf('export async function bootDshHost(')).replace('export ', '')
const appBootSource = await readFile(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot'), 'utf8')
const fatalSource = appBootSource.slice(appBootSource.indexOf('function installFailLoud('), appBootSource.indexOf('\n/**\n* Value mirrors', appBootSource.indexOf('function installFailLoud(')))
const installFailLoud = new Function('inspect', 'assembledActivationRejections', 'FAIL_LOUD_RELEASE_TIMEOUT_MS', `${fatalSource}; return installFailLoud`)(inspect, new WeakSet(), 2000)
const environment = { get() {} }, options = { environment, profile: 'sdk', patchFiles: ['/synthetic/first.patch.yml', '/synthetic/second.patch.yml'], args: [] }
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture({ startupError, resolutionError, proxyError, contextError, duringBoot, disposeGate, bootGate } = {}) {
  const state = { contextDisposals: 0, proxyDisposals: 0, exits: [], outsideSignals: 0 }, proc = new EventEmitter()
  const outside = () => { state.outsideSignals += 1 }
  for (const event of ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException']) proc.on(event, outside)
  Object.assign(proc, { cwd: () => '/synthetic/workspace', env: { DSH_TELEMETRY_DISABLED: 'true' }, stderr: { write() {} }, exit(code) { state.exits.push(code) } })
  const ctx = { fiber: { async dispose() { state.contextDisposals += 1; if (disposeGate) await disposeGate.promise; if (contextError) throw contextError } },
    provide(key, value) { (state.provided ??= []).push([key, value]) }, async plugin(plugin, value) { state.packagePlugin = { plugin, value } },
  }
  const prepared = { dir: '/synthetic/profile', patchPath: '/synthetic/profile/cordis.patch.yml', layers: [{ packageName: 'native-base' }, { packageName: 'native-sdk' }] }
  const appBoot = {
    PluginPackages: 'official-package-service', installFailLoud,
    async createRuntimeResolution(value) { state.resolutionInput = value; if (resolutionError) throw resolutionError; return 'official-resolution' },
    loadOverlayPatches(name, file) { assert.equal(name, 'dsh'); return [{ file }] },
    readProfilePatches(name, context, value) { state.profileContext = context; assert.equal(name, 'dsh'); assert.equal(value, prepared); return ['official-patch-stack'] },
    async boot(name, root, patches, prepare) {
      assert.equal(name, 'dsh'); assert.equal(root, '/synthetic/profile/cordis.yml'); assert.deepEqual(patches, ['official-patch-stack'])
      try { await prepare(ctx); if (duringBoot) await duringBoot(state); if (bootGate) await bootGate.promise; if (startupError) throw startupError; return ctx }
      catch (error) { await ctx.fiber.dispose(); throw error }
    },
  }
  const values = { appBoot, proxy: { async installProxyFromEnvironment(value) { assert.equal(value, environment); return async () => { state.proxyDisposals += 1; if (proxyError) throw proxyError } } },
    cmdline: { provideCmdline(host, value) { assert.equal(host, ctx); state.cmdline = value } }, launchEnvironment: { DSH_LAUNCH_ENVIRONMENT_KEY: 'native-launch-environment' }, homePaths: { resolveDshHome: () => '/synthetic/dsh' },
    prepareProfile(name) { assert.equal(name, 'sdk'); return prepared }, INSTALL_ANCHOR: '/synthetic/installed-dsh/package.json', PROFILE_ROOT_FILENAME: 'cordis.yml', join, resolve, process: proc,
  }
  const boot = new Function(...Object.keys(values), `${implementation}; return bootDshHost`)(...Object.values(values))
  return { state, proc, ctx, prepared, boot }
}

{
  const value = fixture(), host = await value.boot(options)
  assert.equal(host.ctx, value.ctx)
  assert.deepEqual(value.state.resolutionInput, { installAnchor: '/synthetic/installed-dsh/package.json', profile: value.prepared })
  assert.deepEqual(value.state.packagePlugin, { plugin: 'official-package-service', value: { resolution: 'official-resolution' } })
  assert.equal(value.state.profileContext.home, '/synthetic/dsh')
  assert.equal(value.state.profileContext.telemetryDisabledEnv, 'true')
  assert.deepEqual(value.state.profileContext.startedBundles, ['native-base', 'native-sdk'])
  assert.deepEqual(value.state.profileContext.overlays, options.patchFiles.map(file => ({ file })))
  assert.equal(value.state.provided[1][1], environment)
  assert.deepEqual(value.state.cmdline.args, []); assert.equal(value.state.cmdline.ready, undefined)
  assert.throws(() => value.state.cmdline.exit(0), { code: 'HOST_EXIT_UNSUPPORTED' })
  value.proc.emit('SIGTERM'); value.proc.emit('SIGINT')
  assert.equal(value.state.outsideSignals, 2); assert.deepEqual(value.state.exits, [])
  const closing = host.shutdown.shutdown(0); assert.equal(host.shutdown.shutdown(0), closing); await closing
  assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 1)
  for (const event of ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException']) assert.equal(value.proc.listenerCount(event), 1)
}
{
  const pending = gate(), value = fixture({ bootGate: pending }), starting = value.boot(options)
  await tick(); value.proc.emit('SIGTERM')
  assert.equal(value.state.outsideSignals, 1); assert.deepEqual(value.state.exits, [])
  pending.resolve(); await (await starting).shutdown.shutdown(0)
}
for (const phase of ['startupError', 'resolutionError']) {
  const original = new Error(`synthetic ${phase}`), value = fixture({ [phase]: original })
  await assert.rejects(value.boot(options), error => error === original)
  assert.equal(value.state.contextDisposals, phase === 'startupError' ? 1 : 0)
  assert.equal(value.state.proxyDisposals, 1); assert.equal(value.proc.listenerCount('unhandledRejection'), 1)
}
{
  const original = new Error('synthetic startup failure'), cleanup = new Error('synthetic proxy failure'), value = fixture({ startupError: original, proxyError: cleanup })
  await assert.rejects(value.boot(options), error => error instanceof AggregateError && error.cause === original && error.errors[0] === original && error.errors[1] === cleanup)
  assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 1)
}
{
  const value = fixture({ duringBoot: state => state.cmdline.exit(0) })
  await assert.rejects(value.boot(options), { code: 'HOST_EXIT_UNSUPPORTED' })
  assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 1); assert.deepEqual(value.state.exits, [])
}
{
  const pending = gate(), value = fixture({ disposeGate: pending }), host = await value.boot(options)
  const closing = host.shutdown.shutdown(0); assert.equal(host.shutdown.shutdown(0), closing)
  await tick(); assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 0)
  pending.resolve(); await closing; assert.equal(value.state.proxyDisposals, 1)
}
{
  const value = fixture(), host = await value.boot(options)
  value.proc.emit('unhandledRejection', new Error('synthetic fatal failure'))
  await tick(); assert.deepEqual(value.state.exits, [1])
  assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 1)
  await host.shutdown.shutdown(0); assert.equal(value.state.contextDisposals, 1)
}
{
  const contextError = new Error('context cleanup failed'), proxyError = new Error('proxy cleanup failed'), value = fixture({ contextError, proxyError }), host = await value.boot(options)
  await assert.rejects(host.shutdown.shutdown(0), error => error instanceof AggregateError && error.cause === contextError && error.errors[1] === proxyError)
  assert.equal(value.state.proxyDisposals, 1); assert.equal(value.proc.listenerCount('unhandledRejection'), 1)
}
{
  const previous = { DSH_HOME: process.env.DSH_HOME, GENEWAY_MODEL_CREDENTIAL_REF: process.env.GENEWAY_MODEL_CREDENTIAL_REF }
  process.env.DSH_HOME = '/synthetic/dsh'
  delete process.env.GENEWAY_MODEL_CREDENTIAL_REF
  try {
    const startup = new Error('synthetic startup failure'), cleanup = new Error('synthetic proxy cleanup failure')
    for (const [original, proxyError] of [
      [startup, cleanup], [startup, undefined],
      [Object.assign(new Error('synthetic shutdown'), { code: 'PROCESS_SHUTDOWN' }), undefined],
      [new AggregateError([startup], 'synthetic startup aggregate'), undefined],
    ]) {
      const value = fixture({ startupError: original, proxyError }), entered = gate(), pending = gate()
      const runner = createCollaborationRunner({ store: {}, dshHome: process.env.DSH_HOME, runProfileImpl: async () => {
        entered.resolve(); await pending.promise
        return value.boot(options)
      } })
      const starting = runner.enableKnowledge().then(() => assert.fail('synthetic startup must fail'), error => error)
      await entered.promise
      const closing = runner.close()
      assert.equal(runner.close(), closing)
      const closed = closing.then(() => undefined, error => error)
      pending.resolve()
      const [startupFailure, cleanupFailure] = await Promise.all([starting, closed])
      if (proxyError) {
        assert.equal(cleanupFailure, startupFailure, 'close must retain an adapter-observed startup cleanup failure')
        assert.equal(startupFailure.code, 'HOST_CLEANUP_FAILED')
        assert(startupFailure instanceof AggregateError)
        assert.equal(startupFailure.cause, original)
        assert.deepEqual(startupFailure.errors, [original, proxyError])
      } else {
        assert.equal(startupFailure, original)
        assert.equal(cleanupFailure, undefined, 'successful cleanup must not turn a startup rejection into a close failure')
      }
      assert.equal(value.state.contextDisposals, 1); assert.equal(value.state.proxyDisposals, 1)
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
console.log('DSH embedding checks passed: official composition, external signals, pending startup, CLI exit rejection, original errors, single cleanup, proxy, runner cleanup failure propagation and official fatal nonzero semantics (pure extraction; native/model/network=0)')
