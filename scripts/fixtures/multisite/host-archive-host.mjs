import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { archiveIOFacts, archiveIOPhase } from './host-archive-journal.mjs'
import { simulatedRuntimeFacts } from './host-archive-runtime.mjs'

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/packages/agent-host/remote.mjs')) {
    if (specifier === './journal.mjs') return { url: new URL('./host-archive-journal.mjs', import.meta.url).href, shortCircuit: true }
    if (specifier === './process-runtime.mjs') return { url: new URL('./host-archive-runtime.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
} })
let remote, closing
process.on('message', message => { void (async () => {
  try {
    if (message.kind === 'start') {
      const { startRemoteAgentHost } = await import('../../../packages/agent-host/remote.mjs')
      remote = await startRemoteAgentHost({ ...JSON.parse(await readFile(message.profile, 'utf8')), onReady: info => process.send({ kind: 'ready', ...info, runtime: 'HostSim' }), onError: cause => process.send({ kind: 'host-error', code: cause.code, commandId: cause.commandId }) })
      return
    }
    if (message.kind !== 'control') throw Error('Unsupported private test IPC')
    let value
    if (message.operation === 'phase') { archiveIOPhase(message.parameters.phase); value = true }
    else if (message.operation === 'metrics') value = archiveIOFacts()
    else if (message.operation === 'read') value = await remote.journal.read()
    else if (message.operation === 'facts') value = { metadata: await remote.journal.archiveMetadata(), runtime: simulatedRuntimeFacts() }
    else if (message.operation === 'lookup') value = await remote.journal.lookup(message.parameters.kind, message.parameters.id)
    else if (message.operation === 'accept') value = await remote.host.accept({ workspaceId: 'local', nodeId: remote.nodeId }, message.parameters.command)
    else throw Error('Unsupported private test operation')
    process.send({ kind: 'control-result', requestId: message.requestId, value })
  } catch (cause) {
    process.send({ kind: message.kind === 'start' ? 'start-error' : 'control-result', requestId: message.requestId, error: { code: cause.code, message: cause.message } })
    if (message.kind === 'start') process.exitCode = 1
  }
})() })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  closing ??= (async () => {
    try { await remote?.close(); process.exit(0) }
    catch (cause) { process.send?.({ kind: 'close-error', code: cause.code }); process.exit(1) }
  })()
})
