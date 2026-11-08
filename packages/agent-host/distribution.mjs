import { access, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export async function checkDistribution(profile) {
  if (!['internal', 'a2a'].includes(profile.transport === undefined ? 'internal' : profile.transport)) throw new Error('INVALID_INTERNAL_PROFILE')
  if (profile.transport === 'a2a') await access(new URL('./a2a-client.mjs', import.meta.url), constants.R_OK)
  if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('UNSUPPORTED_PLATFORM')
  if (!isAbsolute(profile.root ?? '') || profile.officeEnabled !== false) throw new Error('INVALID_INTERNAL_PROFILE')
  for (const executable of ['/bin/sh', '/usr/bin/flock']) execFileSync(executable, executable === '/bin/sh' ? ['-c', ':'] : ['--version'], { stdio: 'ignore' })
  await mkdir(profile.root, { recursive: true, mode: 0o700 })
  const probe = join(profile.root, '.distribution-check-' + process.pid), handle = await open(probe, 'wx', 0o600)
  await handle.close(); await unlink(probe); await access(profile.root, constants.W_OK)
  return { platform: process.platform, arch: process.arch, node: process.versions.node }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const profile = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
    await checkDistribution(profile)
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    process.chdir(packageRoot)
    const { startRemoteAgentHost } = await import('./remote.mjs')
    const host = await startRemoteAgentHost({ ...profile, onReady: value => console.log(JSON.stringify({ kind: 'ready', ...value })), onError: cause => console.error(JSON.stringify({ kind: 'host-error', code: typeof cause.code === 'string' && /^[A-Z_]+$/.test(cause.code) ? cause.code : 'HOST_UNAVAILABLE' })) })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void host.close().then(() => process.exit(0)) })
  } catch { console.error(JSON.stringify({ kind: 'host-error', code: 'PACKAGE_START_FAILED' })); process.exitCode = 1 }
}
