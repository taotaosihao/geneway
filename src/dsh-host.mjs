import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INSTALL_ANCHOR, prepareProfile, PROFILE_ROOT_FILENAME } from '@deepseek-ai/dsh/profile-boot'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const [appBoot, proxy, cmdline, launchEnvironment, homePaths] = await Promise.all([
  '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-http-proxy', '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-launch-environment', '@deepseek-ai/dsh-home-paths',
].map(name => import(pathToFileURL(requireFromDsh.resolve(name)).href)))

// The embedding process owns signals and exit; the official boot APIs own the profile tree.
export async function bootDshHost({ environment, profile, patchFiles, args }) {
  let ctx, uninstallFailLoud, disposal
  const disposeProxy = await proxy.installProxyFromEnvironment(environment, message => process.stderr.write(`dsh: ${message}\n`))
  const dispose = () => disposal ??= (async () => {
    const failures = []
    for (const release of [() => ctx?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    uninstallFailLoud?.()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'DSH Host 清理失败', { cause: failures[0] })
  })()
  try {
    const prepared = prepareProfile(profile)
    const resolution = await appBoot.createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile: prepared })
    const profileContext = {
      name: profile, dir: prepared.dir, patchPath: prepared.patchPath, installAnchor: INSTALL_ANCHOR,
      startedBundles: prepared.layers.map(layer => layer.packageName), cwd: process.cwd(), home: homePaths.resolveDshHome(),
      overlays: patchFiles.flatMap(file => appBoot.loadOverlayPatches('dsh', resolve(file))),
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    uninstallFailLoud = appBoot.installFailLoud('dsh', process, dispose)
    let booted
    try {
      booted = await appBoot.boot('dsh', join(prepared.dir, PROFILE_ROOT_FILENAME), appBoot.readProfilePatches('dsh', profileContext, prepared), async host => {
        ctx = host
        host.provide('profileContext', profileContext)
        host.provide(launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        await host.plugin(appBoot.PluginPackages, { resolution })
        cmdline.provideCmdline(host, { args, exit() {
          throw Object.assign(new Error('Geneway Host 不接受命令行退出请求'), { code: 'HOST_EXIT_UNSUPPORTED' })
        } })
      })
    } catch (error) {
      // Public boot disposes its partial context before rejecting.
      ctx = undefined
      throw error
    }
    ctx = booted
    return { ctx, shutdown: { shutdown: dispose } }
  } catch (error) {
    try { await dispose() }
    catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], 'DSH Host 启动及清理失败', { cause: error }), { code: 'HOST_CLEANUP_FAILED' }) }
    throw error
  }
}
