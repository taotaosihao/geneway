// Private compatibility entrypoint: use the selected package's ordinary remote Host.
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = await realpath(resolve(process.argv[2])), profilePath = resolve(process.argv[3])
const send = value => { if (process.connected) process.send(value); else console.log(JSON.stringify(value)) }
let host, closing
async function close() {
  return closing ??= (async () => { await host?.close(); process.exit(0) })()
}
try {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  if (profile.officeEnabled !== false || !profile.root?.startsWith('/')) throw Object.assign(Error('INVALID_PRIVATE_PROFILE'), { code: 'INVALID_PRIVATE_PROFILE' })
  const entry = await realpath(join(packageRoot, 'packages/agent-host/remote.mjs'))
  if (!entry.startsWith(packageRoot + '/')) throw Error('PACKAGE_ENTRY_ESCAPED')
  process.chdir(packageRoot)
  const { startRemoteAgentHost } = await import(pathToFileURL(entry).href)
  host = await startRemoteAgentHost({ ...profile,
    onReady: ready => send({ kind: 'ready', ...ready, packageRoot, entry }),
    onError: cause => send({ kind: 'host-error', code: cause.code ?? 'REMOTE_UNAVAILABLE' }),
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close() })
} catch (cause) {
  send({ kind: 'start-error', code: cause.code ?? 'HOST_START_FAILED', packageRoot })
  process.exitCode = 1
}
