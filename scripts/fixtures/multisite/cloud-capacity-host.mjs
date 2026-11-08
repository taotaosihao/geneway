import assert from 'node:assert/strict'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRemoteClient } from '../../../packages/agent-host/remote-client.mjs'
import { createAgentHost, isCloudOrdinaryCapacityError } from '../../../packages/agent-host/host.mjs'
import { createHostJournal } from '../../../packages/agent-host/journal.mjs'
import { readHostIdentity, writeHostIdentity } from '../../../packages/agent-host/identity.mjs'
import { createSpreadsheetJobs } from '../../../packages/agent-host/spreadsheet-jobs.mjs'
import { createSimulatedRuntime } from './runtime.mjs'

// Test-only process controls pause transport polling, never edit a receipt or Job.
const config = JSON.parse(await readFile(process.argv[2], 'utf8')), root = config.root
await mkdir(root, { recursive: true, mode: 0o700 })
const writes = [], identity = await readHostIdentity(root), hostRunId = randomUUID()
const wire = row => { writes.push(appendFile(join(root, 'node-http.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 })) }
const client = createRemoteClient({ origin: config.origin, identity, hostRunId, fetchImpl: async (url, options = {}) => {
  const startedAt = new Date().toISOString(), path = new URL(url).pathname
  const request = options.body ? JSON.parse(options.body) : null
  // Pairing and credentials stay in private identity/config; wire headers are omitted.
  const safe = path === '/internal/nodes/pair' ? { ...request, credential: '[redacted]', pairingCode: '[redacted]' } : request
  try {
    const response = await fetch(url, options), body = await response.clone().json()
    wire({ startedAt, path, method: options.method ?? 'GET', request: safe, status: response.status, response: body }); return response
  } catch (cause) { wire({ startedAt, path, request: safe, failure: { code: cause.code, message: cause.message } }); throw cause }
} })
if (!identity.nodeId) {
  const reply = await client.post('/internal/nodes/pair', { pairingId: config.pairing.pairingId, pairingCode: config.pairing.pairingCode, clientRequestId: identity.pairRequestId, nodeInstanceId: identity.nodeInstanceId, credential: identity.credential })
  Object.assign(identity, { nodeId: reply.node.id, registrationRevision: reply.node.registrationRevision, credentialVersion: reply.node.credentialVersion }); await writeHostIdentity(root, identity)
}
const journal = createHostJournal(join(root, 'host-journal.json'))
const runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }); runtime.supportsAttachments = true
const jobs = createSpreadsheetJobs({ journal, root: join(root, 'jobs'), nodeId: identity.nodeId, evidenceService: client.spreadsheet,
  forkImpl: (...args) => { const child = fork(...args); assert(child.kill('SIGSTOP')); process.send?.({ kind: 'worker-started', pid: child.pid }); return child },
  onError: cause => process.send?.({ kind: 'host-error', code: cause.code, message: cause.message }) })
const host = createAgentHost({ nodeId: identity.nodeId, journal, runtime, jobs })
host.setOrchestrationHandler({ call: (...args) => client.command(...args), event: event => client.event(event) })
client.setBeforeRequest((execution, inputMessageId) => host.synchronizeInputs(execution, { inputMessageId }))
let pumping, paused = false, closing = false
const failure = cause => ({ code: cause.code ?? 'FIXTURE_FAILED', status: cause.status, capacity: cause.capacity, message: cause.message })
function pump({ manual = false } = {}) {
  if (closing || paused && !manual) return Promise.resolve({ skipped: true })
  return pumping ??= (async () => {
    try {
      for (const delivery of (await client.resync()).pending) {
        const command = await client.resolveCommand(delivery)
        await host.accept({ workspaceId: 'local', nodeId: identity.nodeId }, command); await client.ack(command)
      }
      await host.process(); await host.flushEvents(event => client.event(event)); return { processed: true }
    } catch (cause) {
      // Same bounded proof-only pass as the production remote pump.
      if (isCloudOrdinaryCapacityError(cause)) await host.flushTerminalProofs(event => client.event(event), cause)
      const error = failure(cause); process.send?.({ kind: 'pump-error', ...error }); return { error }
    }
  })().finally(() => { pumping = undefined })
}
await pump()
const timer = setInterval(() => { void pump().catch(cause => process.send?.({ kind: 'host-error', ...failure(cause) })) }, 200); timer.unref()
process.send?.({ kind: 'ready', pid: process.pid, nodeId: identity.nodeId, nodeInstanceId: identity.nodeInstanceId, hostRunId })
process.on('message', async message => {
  if (!message.id) return
  try {
    let value
    if (message.operation === 'pausePump') { paused = true; await pumping; value = { paused: true } }
    else if (message.operation === 'resumePump') { paused = false; value = { paused: false } }
    else if (message.operation === 'pump') value = await pump({ manual: true })
    else if (message.operation === 'snapshot') value = await journal.read()
    else if (message.operation === 'flush') { await host.flushEvents(event => client.event(event)); value = { flushed: true } }
    else if (message.operation === 'sendEvent') value = await client.event(message.event)
    else {
      const execution = (await journal.read()).executions.filter(row => row.work_id === message.workId).at(-1)
      assert(execution, 'Original execution must exist')
      if (message.operation === 'report') { await host.report(execution.launch_id, message.report); value = { reported: true } }
      else if (message.operation === 'spreadsheet') value = await runtime.spreadsheet(execution, 'start_spreadsheet', message.parameters)
      else throw Error('Unknown fixture operation')
    }
    await Promise.all(writes.splice(0)); process.send?.({ id: message.id, value })
  } catch (cause) { await Promise.all(writes.splice(0)); process.send?.({ id: message.id, failure: failure(cause) }) }
})
async function close() { if (closing) return; closing = true; clearInterval(timer); await pumping; client.group.close(); await host.close(); await Promise.all(writes); process.exit(0) }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void close().catch(cause => { process.stderr.write(cause.stack + '\n'); process.exit(1) }) })
