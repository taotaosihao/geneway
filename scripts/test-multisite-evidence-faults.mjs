import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createEvidenceCaptures } from '../packages/agent-host/evidence-captures.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding, key } from '../packages/agent-contracts/index.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createEvidenceTools } from '../packages/agent-host/evidence-tools.mjs'

const directory = await fs.mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-faults-'), hash = bytes => createHash('sha256').update(bytes).digest('hex'), results = []
const modes = process.argv[2] ? [process.argv[2]] : ['response-loss', 'ready-write', 'midread-revoke', 'midread-revision', 'hash-retry', 'schema', 'missing-source']
for (const mode of modes) {
  const root = join(directory, mode), sourceRoot = join(root, 'source'); await fs.mkdir(sourceRoot, { recursive: true })
  let armed = false, writeFailure = false, fixture, host, proxy, authorizations = 0, injected = false, workId
  const lossPaths = new Set(), original = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '原始私源条目', owner: '张工' }] }))
  await fs.writeFile(join(sourceRoot, 'source.json'), original)
  try {
    fixture = await startBridgeService({ directory: join(root, 'api'), storeOperations: { async open(path, ...args) { const handle = await fs.open(path, ...args), write = handle.writeFile.bind(handle); handle.writeFile = async (...values) => { if (armed) { const state = JSON.parse(String(values[0])); if (state.evidence?.some(row => row.status === 'ready') && state.evidenceAccessReceipts?.length) { armed = false; writeFailure = true; throw Object.assign(new Error('controlled ready receipt write failure'), { code: 'EIO' }) } }; return write(...values) }; return handle } } })
    let origin = fixture.origin
    if (mode === 'response-loss') {
      proxy = createServer(async (request, response) => { try { const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks), upstream = await fetch(new URL(request.url, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host }, body: body.length ? body : undefined }), bytes = Buffer.from(await upstream.arrayBuffer()); if (upstream.ok && (request.url === '/internal/evidence/init' || request.method === 'PUT') && !lossPaths.has(request.url)) { lossPaths.add(request.url); response.destroy(); return }; response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(bytes) } catch { response.destroy() } }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${proxy.address().port}`
    }
    const owner = { id: 'owner' }, pair = await fixture.nodes.createPairing(owner, { clientRequestId: 'pair', nodeId: 'pc-a', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-data'], expiresAt: new Date(Date.now() + 120000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }
    const client = createRemoteClient({ origin, identity, fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/internal/evidence/authorize' && ++authorizations === 2 && mode.startsWith('midread-')) {
        injected = true
        if (mode === 'midread-revoke') await fixture.nodes.revoke(owner, 'pc-a', { clientRequestId: 'midread-revoke', expectedRevision: 1 })
        else await fixture.service.multisite.apply(owner, 'input', { workId, clientRequestId: 'midread-revision', text: '读取期间修订要求' })
      }
      return fetch(url, options)
    } })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'redeem', nodeInstanceId: identity.nodeInstanceId, credential: identity.credential }); Object.assign(identity, { nodeId: 'pc-a', registrationRevision: paired.node.registrationRevision })
    await fixture.nodes.putResource(owner, 'fixture:history', { clientRequestId: 'resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: 'pc-a', capabilityIds: ['evidence.history.read.v1'], evidenceReaderAgentIds: ['desktop-data'], enabled: true })
    const journal = createHostJournal(join(root, 'host.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') }), parentClient = { ...client, evidence: { ...client.evidence, publish(issued, bytes) { if (mode === 'hash-retry' && !injected) { injected = true; return client.evidence.publish(issued, Buffer.from('wrong hash')) }; return client.evidence.publish(issued, bytes) } } }
    const captures = createEvidenceCaptures({ journal, root: join(root, 'sealed'), client: parentClient, profile: { profileVersion: 1, resources: [{ resourceId: 'fixture:history', capabilityIds: ['evidence.history.read.v1'], adapterKind: 'history_json', root: sourceRoot, datasets: { history: mode === 'missing-source' ? 'missing.json' : 'source.json' }, allowedSections: [], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: ['desktop-data'], clockTrust: 'fixture' }] } })
    host = createAgentHost({ nodeId: 'pc-a', journal, runtime, evidence: captures }); host.setOrchestrationHandler({ event: event => client.event(event), call: (execution, operation, parameters) => client.command(execution, operation, parameters) })
    workId = (await fixture.service.multisite.apply(owner, 'create', { employeeId: 'desktop-data', goal: '证据故障专项', clientRequestId: 'work' })).workId
    for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId: 'pc-a' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
    const execution = (await journal.read()).executions[0], parameters = { clientRequestId: 'capture', instructionRevision: 1, resourceId: 'fixture:history', datasetId: 'history' }
    armed = mode === 'ready-write'
    if (['response-loss', 'ready-write', 'hash-retry'].includes(mode)) {
      await assert.rejects(runtime.evidence(execution, 'read_history', parameters)); const local = await journal.read(); assert.equal(local.captures[0].state, 'sealed')
      let state = await fixture.store.read()
      if (mode !== 'response-loss') { assert.equal(state.evidence[0].status, 'pending'); assert.equal(state.evidenceAccessReceipts.length, 0) }
      else { assert.equal(state.evidence[0].status, 'ready'); assert.equal(lossPaths.size, 2) }
      await fs.writeFile(join(sourceRoot, 'source.json'), JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [] }))
      const result = await runtime.evidence(execution, 'read_history', parameters); state = await fixture.store.read(); assert.equal(state.evidence.length, 1); assert.equal(state.evidenceAccessReceipts.length, 1); assert.equal(state.evidence[0].sha256, hash(original)); assert.equal(state.evidence[0].sourceSha256, hash(original)); assert.deepEqual(await fs.readFile(join(root, 'api/evidence', result.ref.id)), original)
      if (mode === 'ready-write') assert(writeFailure)
      results.push({ mode, originalSealedBytesAfterSourceChange: true, singleEvidenceAndProductionReceipt: true, noFalseAckOnFailure: true, sourceSha256: hash(original) })
    } else if (mode.startsWith('midread-')) {
      await assert.rejects(runtime.evidence(execution, 'read_history', parameters), { code: mode === 'midread-revoke' ? 'FORBIDDEN' : 'REVISION_CONFLICT' }); assert(injected); assert.equal((await fixture.store.read()).evidence.length, 0); assert.equal((await journal.read()).captures[0].state, 'failed'); results.push({ mode, actualSourceReadBeforeAuthorizationBarrier: true, noSealOrPublicationAfterAuthorityChanged: true })
    } else if (mode === 'missing-source') {
      let cause; try { await runtime.evidence(execution, 'read_history', parameters) } catch (error) { cause = error }; assert(cause); assert.equal(cause.code, 'ENOENT')
      const leaksPath = cause.message.includes(sourceRoot); assert.equal(leaksPath, process.argv.includes('--expect-path-leak')); results.push({ mode, modelFacingErrorLeaksSourcePath: leaksPath, code: cause.code })
      if (!process.argv.includes('--expect-path-leak')) {
        await fs.writeFile(join(sourceRoot, 'missing.json'), original)
        const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json')), { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href), { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href), toolHost = new Context()
        try {
          await toolHost.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }); await toolHost.plugin(ToolRuntime, { mode: 'native' })
          await toolHost.plugin(Object.assign(ctx => { for (const tool of createEvidenceTools((operation, args) => runtime.evidence(execution, operation, args), { execution: { capabilityIds: ['evidence.history.read.v1'] } })) ctx.tools.register(tool) }, { inject: ['tools'] }))
          const rendered = await toolHost.tools.execute({ callId: 'retry-unsealed', name: 'geneway_read_history', arguments: parameters, signal: new AbortController().signal })
          assert(rendered.isError); const message = JSON.stringify(rendered.content); assert.match(message, /未完成封存/); assert.match(message, /新的采集请求重新读取/); assert(!message.includes(sourceRoot)); await fs.writeFile(join(root, 'actual-dsh-tool-error.json'), JSON.stringify(rendered, null, 2))
        } finally { await toolHost.fiber.dispose() }
        const fresh = await runtime.evidence(execution, 'read_history', { ...parameters, clientRequestId: 'fresh-after-repair' }); assert(fresh.ref); assert.equal((await journal.read()).captures.find(row => row.requestId === 'capture').reason, 'ENOENT'); results.at(-1).persistentFailedRetryActualDshToolGuidance = true
      }
    } else if (mode === 'schema') {
      const good = await runtime.evidence(execution, 'read_history', parameters), local = (await journal.read()).captures[0], bad = Buffer.from(JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: 'bad-date', description: '拒绝坏结构', owner: '张工' }] }))
      const pending = await client.evidence.init({ binding: binding(execution), captureId: key('bad-schema', local.id), captureFormatVersion: 2, profileDigest: local.profileDigest, instructionRevision: 1, kind: 'history', resourceId: local.resourceId, resourceRevision: local.resourceRevision, profileVersion: local.profileVersion, exportToAgentIds: local.exportToAgentIds, sourceId: local.sourceId, sourceSha256: local.sourceSha256, sha256: hash(bad), sizeBytes: bad.length, observedAt: local.observedAt, sourceTimestamp: null, clockTrust: 'fixture' })
      await assert.rejects(client.evidence.publish(pending, bad), { code: 'INVALID_REQUEST' }); const state = await fixture.store.read(); assert.equal(state.evidence.find(row => row.id === pending.id).status, 'pending'); assert.equal(state.evidenceAccessReceipts.length, 1); results.push({ mode, independentCloudSchemaRejectsMatchingHashMalformedBytes: true, onlyOriginalGoodEvidenceReady: good.ref.id })
    }
  } catch (cause) { await fs.writeFile(join(root, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack }, null, 2)); throw cause }
  finally { await host?.close(); await fixture?.close(); if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) } }
}
const result = { result: 'passed', directory, boundary: 'real sources/FileStore/HTTP/AgentDelivery and production capture/receipts; simulated model; selected fault barriers, no OS or physical network claims', results }; await fs.writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
