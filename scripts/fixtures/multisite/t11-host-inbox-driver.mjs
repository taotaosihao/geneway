import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { faultControl } from './t11-host-fault-control.mjs'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './journal.mjs' && context.parentURL?.endsWith('/packages/agent-host/remote.mjs')) return { url: new URL('./t11-host-journal-shim.mjs', import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
} })
let host
process.once('message', async configuration => {
  try {
    const { startRemoteAgentHost } = await import('../../../packages/agent-host/remote.mjs')
    faultControl.armed = true
    const profile = JSON.parse(await readFile(configuration.profile, 'utf8'))
    host = await startRemoteAgentHost({ ...profile, onReady: value => process.send?.({ kind: 'ready', ...value }), onError: cause => process.send?.({ kind: 'host-error', code: cause.code, stack: cause.stack }) })
  } catch (cause) { process.send?.({ kind: 'driver-failure', code: cause.code, stack: cause.stack }); process.exitCode = 1 }
})
process.on('message', message => { if (message.kind === 'restore-io') faultControl.armed = false })
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { host?.close().finally(() => process.exit(0)) })
