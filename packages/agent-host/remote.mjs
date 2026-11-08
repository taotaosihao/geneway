import { assertNodeTransport, createA2aGroupPump } from './a2a-client.mjs'
import { randomUUID } from 'node:crypto'
import { readFile, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAgentHost, isOrdinaryInboxCapacityError, isCloudOrdinaryCapacityError } from './host.mjs'
import { createHostJournal } from './journal.mjs'
import { createProcessRuntime } from './process-runtime.mjs'
import { createRemoteClient } from './remote-client.mjs'
import { readHostIdentity, writeHostIdentity } from './identity.mjs'
import { acquireHostOwner } from './ownership.mjs'
import { readRuntimeConfig } from '../../src/runtime-config.mjs'
import { digest, error } from '../agent-contracts/index.mjs'
import { createSpreadsheetJobs } from './spreadsheet-jobs.mjs'
import { createSpreadsheetUploader } from './spreadsheet-upload.mjs'
import { createEvidenceCaptures } from './evidence-captures.mjs'

export async function startRemoteAgentHost({ root, origin, pairing, identityOperations, maxActiveLoops = 1, officeEnabled = false, evidenceProfile, transport = 'internal', onError = () => {}, onReady = () => {} }) {
  if (typeof officeEnabled !== 'boolean') throw error('INVALID_REQUEST', 'Office 配置无效')
  assertNodeTransport(transport)
  root = resolve(root)
  const owner = await acquireHostOwner(root)
  let identity, host, timer, groupTimer, siteRuleTimer, groupPump, pumping, publishing, siteRulePolling, closePromise, closing = false, streamTask
  const connectionAbort = new AbortController(), publicationAbort = new AbortController(), siteRuleAbort = new AbortController(), hostRunId = randomUUID()
  try {
    identity = await readHostIdentity(root, identityOperations)
    const client = createRemoteClient({ origin, identity, hostRunId, transport })
    if (!identity.nodeId) {
      if (!pairing) throw error('PAIRING_REQUIRED', '此数据根尚未配对')
      const reply = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: identity.pairRequestId, nodeInstanceId: identity.nodeInstanceId, credential: identity.credential })
      if (reply.node.nodeInstanceId !== identity.nodeInstanceId) throw error('FORBIDDEN')
      identity.nodeId = reply.node.id; identity.registrationRevision = reply.node.registrationRevision; identity.credentialVersion = reply.node.credentialVersion
      await writeHostIdentity(root, identity, identityOperations)
    }
    const config = readRuntimeConfig({ GENEWAY_STATE: join(root, 'host-runtime-state.json'), GENEWAY_DSH_HOME: join(root, 'dsh'), GENEWAY_SECRET_ROOT: join(root, 'unused-provider-secrets') }, process.cwd())
    const journal = createHostJournal(join(root, 'host-journal.json'))
    await journal.update(() => {})
    const runtime = createProcessRuntime({ root: process.cwd(), config, gateway: client, gatewayOrigin: () => origin })
    const jobs = officeEnabled ? createSpreadsheetJobs({ journal, root: join(root, 'spreadsheet-jobs'), evidenceService: client.spreadsheet, nodeId: identity.nodeId, onError }) : undefined
    const uploadCandidates = jobs ? createSpreadsheetUploader({ journal, jobs, issueUploadToken: job => client.spreadsheet.issueUploadToken(job), origin, onError }) : undefined
    const evidence = createEvidenceCaptures({ journal, root: join(root, 'evidence-captures'), profile: evidenceProfile ?? { profileVersion: 1, resources: [] }, client })
    host = createAgentHost({ nodeId: identity.nodeId, journal, runtime, jobs, evidence, uploadCandidates, maxActiveLoops })
    if (client.group) groupPump = createA2aGroupPump({
      client, executions: async () => (await journal.read()).executions, onError,
      readMetadata: async () => { try { return JSON.parse(await readFile(join(root, 'a2a-group-metadata.json'), 'utf8')) } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause } },
      onMetadata: async value => {
        const temporary = join(root, `.a2a-group-observation.${randomUUID()}.tmp`), file = await open(temporary, 'wx', 0o600)
        let committed = false
        try {
          await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close()
          await rename(temporary, join(root, 'a2a-group-metadata.json')); committed = true
          const directory = await open(root, 'r'); try { await directory.sync() } finally { await directory.close() }
        } finally { await file.close().catch(() => {}); if (!committed) await unlink(temporary).catch(() => {}) }
      },
    })
    host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
    client.setBeforeRequest((execution, inputMessageId) => host.synchronizeInputs(execution, { inputMessageId }))
    const reportedUnavailable = new Set()
    function diagnose(diagnostic) {
      const id = diagnostic.commandId ?? diagnostic.waitId
      if (reportedUnavailable.has(id)) return
      reportedUnavailable.add(id)
      onError(Object.assign(error(diagnostic.code ?? 'COMMAND_UNAVAILABLE', '命令或等待无法投递，可停止对应执行。'), { commandId: id }))
    }
    const accept = async delivery => {
      if (delivery.kind === 'command_unavailable') { diagnose(delivery); return true }
      let command
      try { command = await client.resolveCommand(delivery) } catch (cause) { onError(Object.assign(cause, { commandId: delivery.commandId })); return false }
      try { await host.accept({ workspaceId: command.workspace_id, nodeId: identity.nodeId }, command) }
      catch (cause) {
        if (!isOrdinaryInboxCapacityError(cause)) throw cause
        onError(Object.assign(cause, { commandId: command.command_id }))
        return true
      }
      await client.ack(command); return true
    }
    async function pump() {
      if (closing) return
      return pumping ??= (async () => { await host.process(); await host.flushEvents(event => client.event(event), { cleanupOnly: client.cleanupOnly }) })().catch(async cause => {
        if (isCloudOrdinaryCapacityError(cause)) { try { await host.flushTerminalProofs(event => client.event(event), cause) } catch (proofCause) { onError(proofCause) } }
        onError(cause)
      }).finally(() => { pumping = undefined })
    }
    function publishSealed() {
      if (closing || !evidence || publishing) return
      publishing = evidence.recoverSealed({ signal: publicationAbort.signal, onError }).catch(cause => { if (!closing) onError(cause) }).finally(() => { publishing = undefined })
    }
    const offeredSiteEvents = new Set()
    function pollSiteRule() {
      if (closing || siteRulePolling || client.cleanupOnly) return
      siteRulePolling = (async () => {
        const { events, ...source } = await evidence.readSiteRuleEvents()
        const current = new Set(events.map(event => digest(event)))
        for (const id of offeredSiteEvents) if (!current.has(id)) offeredSiteEvents.delete(id)
        const signal = AbortSignal.any([siteRuleAbort.signal, AbortSignal.timeout(2000)])
        for (const event of events) {
          if (signal.aborted || client.cleanupOnly) break
          const id = digest(event)
          if (offeredSiteEvents.has(id)) continue
          try {
            await client.post('/internal/site-rule/events', { ...source, maxActiveLoops, event }, { attempts: 1, signal })
            offeredSiteEvents.add(id)
          } catch (cause) {
            if (!signal.aborted) onError(error(cause.code ?? 'SITE_RULE_SOURCE_UNAVAILABLE'))
          }
        }
      })().catch(cause => { if (!closing) onError(error(cause.code ?? 'SITE_RULE_SOURCE_UNAVAILABLE')) }).finally(() => { siteRulePolling = undefined })
    }
    async function connect() {
      while (!closing) {
        try {
          const state = await client.resync()
          for (const diagnostic of state.unavailable ?? []) diagnose(diagnostic)
          let accepted = true
          for (const command of state.pending) if (!await accept(command)) accepted = false
          if (!accepted) throw error('COMMAND_UNAVAILABLE', '命令取回失败，稍后重试。')
          const stream = await client.stream(connectionAbort.signal)
          for await (const command of stream) { if (closing || !await accept(command)) break }
        } catch (cause) { if (!closing) onError(cause) }
        if (!closing) await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    const initial = await client.resync()
    for (const diagnostic of initial.unavailable ?? []) diagnose(diagnostic)
    for (const command of initial.pending) await accept(command)
    if (groupPump) { groupTimer = setInterval(() => { void groupPump.run() }, 250); groupTimer.unref() }
    timer = setInterval(() => { void pump(); publishSealed() }, 100); timer.unref()
    if (evidence.readSiteRuleEvents) { siteRuleTimer = setInterval(pollSiteRule, 1000); siteRuleTimer.unref(); pollSiteRule() }
    streamTask = connect()
    owner.lost.then(() => { if (!closing) { onError(error('HOST_OWNER_LOST')); void close() } })
    const ready = { nodeId: identity.nodeId, nodeInstanceId: identity.nodeInstanceId, hostRunId, root, pid: process.pid, mode: 'remote' }
    onReady(ready)
    function close() {
      return closePromise ??= (async () => {
        closing = true; clearInterval(timer); clearInterval(groupTimer); clearInterval(siteRuleTimer); const groupClosing = groupPump?.close(); connectionAbort.abort(); publicationAbort.abort(); siteRuleAbort.abort(); await siteRulePolling; await streamTask?.catch(() => {}); await pumping?.catch(() => {}); await publishing?.catch(() => {}); await host.close(); await groupClosing; await owner.release()
      })()
    }
    return { ...ready, journal, client, host, close }
  } catch (cause) { closing = true; clearInterval(timer); clearInterval(groupTimer); clearInterval(siteRuleTimer); const groupClosing = groupPump?.close(); connectionAbort.abort(); siteRuleAbort.abort(); await siteRulePolling; await host?.close().catch(() => {}); await groupClosing; await owner.release(); throw cause }
}

function remoteErrorDiagnostic(cause, fallback = 'REMOTE_UNAVAILABLE') {
  const value = { kind: 'host-error', code: cause.code ?? fallback, ...(cause.commandId ? { commandId: cause.commandId } : {}) }
  if (['host-inbox', 'cloud'].includes(cause.capacity?.domain)) {
    const { domain, queue, reason, count, bytes } = cause.capacity
    value.capacity = { domain, queue, reason, count, bytes }
  }
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let host
  try {
    const profile = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
    host = await startRemoteAgentHost({ ...profile, onReady: value => { if (process.connected) process.send({ kind: 'ready', ...value }); else console.log(JSON.stringify(value)) }, onError: cause => { const value = remoteErrorDiagnostic(cause); if (process.connected) process.send(value); else console.error(JSON.stringify(value)) } })
  } catch (cause) { if (process.connected) process.send(remoteErrorDiagnostic(cause, 'HOST_START_FAILED')); process.exitCode = 1 }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { host?.close().finally(() => process.exit(0)) })
}
