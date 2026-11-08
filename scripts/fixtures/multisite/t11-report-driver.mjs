import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { reportSelection } from './t11-report-control.mjs'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './journal.mjs' && context.parentURL?.endsWith('/packages/agent-host/remote.mjs')) return { url: new URL('./t11-report-journal.mjs', import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
} })
let remote
process.once('message', async configuration => {
  try {
    const { startRemoteAgentHost } = await import('../../../packages/agent-host/remote.mjs'), profile = JSON.parse(await readFile(configuration.profile, 'utf8'))
    remote = await startRemoteAgentHost({ ...profile, onReady: value => process.send?.({ kind: 'ready', ...value }), onError: cause => process.send?.({ kind: 'host-error', code: cause.code }) })
  } catch (cause) { process.send?.({ kind: 'driver-failure', code: cause.code, stack: cause.stack }); process.exitCode = 1 }
})
process.on('message', message => { if (message.kind === 'release-old-report') { reportSelection.held = false; process.send?.({ kind: 'report-selection-released', targetId: reportSelection.targetId, selectedReads: reportSelection.selectedReads, at: new Date().toISOString() }) } })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { Promise.resolve(remote?.close()).finally(() => process.exit(0)) })
