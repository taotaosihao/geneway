import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createEvidenceCaptures } from '../packages/agent-host/evidence-captures.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { EVIDENCE_LIMITS as L, jsonBytes } from '../packages/agent-contracts/evidence.mjs'
import { binding } from '../packages/agent-contracts/index.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-focused-'), owner = { id: 'owner' }, hash = bytes => createHash('sha256').update(bytes).digest('hex'), results = []
const longResource = process.argv.includes('--long-resource'), worstSite = process.argv.includes('--site-worst')
let clockOffset = 0
const resourceFor = kind => longResource ? (kind === 'history' ? '史' : '站').repeat(200) : kind === 'history' ? 'fixture:history' : 'fixture:site'
const fixture = await startBridgeService({ directory: join(directory, 'api'), clock: () => Date.now() + clockOffset, seedState(state) { seedDelegation(state); for (const employee of state.employees) { employee.placement.nodeId = employee.id === 'desktop-data' ? 'pc-a' : employee.id === 'gateway' ? 'gateway' : 'cloud'; if (['desktop-data', 'gateway'].includes(employee.id)) { const id = resourceFor(employee.id === 'desktop-data' ? 'history' : 'site_snapshot'); employee.placement.resourceRefs = [id]; employee.multisitePolicy.execution.resourceRefs = [id] } }; return state } }), hosts = []
const readerAllowed = !process.argv.includes('--no-reader'), exportAllowed = !process.argv.includes('--no-export')
let foreignCursor
try {
  const deadlineMode = process.argv.includes('--deadline')
  let admin
  if (deadlineMode) { const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert(response.ok); admin = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
  async function budgetApi(path, value, method = 'POST') { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result }
  for (const [agentId, nodeId, kind] of [['desktop-data', 'pc-a', 'history'], ['gateway', 'gateway', 'site_snapshot']]) {
    const resourceId = resourceFor(kind)
    const root = join(directory, agentId), sourceRoot = join(root, 'source'); await mkdir(sourceRoot, { recursive: true })
    const entries = Array.from({ length: 200 }, (_, index) => ({ date: '2026-11-01', description: index === 0 ? '\0'.repeat(1999) + '大' : `历史条目${index}`, owner: index === 0 ? '\0'.repeat(199) + '人' : '张工' }))
    const events = Array.from({ length: 200 }, (_, index) => ({ sourceEventId: `event-${index}`, sourceTimestamp: null, code: 'ALARM', severity: 'unknown', message: `现场事件${index}` }))
    if (worstSite) events[0] = { sourceEventId: '\0'.repeat(128), sourceTimestamp: '+275760-09-13T00:00:00.000Z', code: '\0'.repeat(128), severity: 'warning', message: '\0'.repeat(2000) }
    const badWindow = kind === 'site_snapshot' && process.argv.includes('--bad-window')
    if (badWindow) { events.length = 1; events[0] = { sourceEventId: 'invalid-time', sourceTimestamp: 'invalid-time', code: 'BAD', severity: 'error', message: '字段校验不能被窗口跳过' } }
    const source = kind === 'history' ? { format: 'geneway.incident-history', version: 1, entries } : { sourceTime: worstSite ? '+275760-09-13T00:00:00.000Z' : null, health: { connection: 'unknown', lastSuccessAt: worstSite ? '+275760-09-13T00:00:00.000Z' : null, queueDepth: worstSite ? Number.MAX_SAFE_INTEGER : null }, events, privateSecret: 'DO_NOT_EXPORT_LOCAL_SECRET' }
    if (badWindow) source.sourceTime = new Date().toISOString()
    const original = Buffer.from(JSON.stringify(source)); assert(original.length <= 65536); await writeFile(join(sourceRoot, 'source.json'), original)
    await symlink(join(sourceRoot, 'source.json'), join(sourceRoot, 'symlink.json'))
    const pair = await fixture.nodes.createPairing(owner, { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agentId], expiresAt: new Date(Date.now() + 120000).toISOString() })
    const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pair.pairingId, pairingCode: pair.pairingCode, clientRequestId: 'redeem', credential: identity.credential, nodeInstanceId: identity.nodeInstanceId }); Object.assign(identity, { nodeId, registrationRevision: paired.node.registrationRevision })
    const capability = kind === 'history' ? 'evidence.history.read.v1' : 'evidence.site.inspect.v1'
    await fixture.nodes.putResource(owner, resourceId, { clientRequestId: `resource-${nodeId}`, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: kind === 'history' ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [capability], evidenceReaderAgentIds: readerAllowed ? [agentId] : [], enabled: true })
    const journal = createHostJournal(join(root, 'host.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') })
    const profile = { profileVersion: 1, resources: [{ resourceId, capabilityIds: [capability], adapterKind: kind === 'history' ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json', link: 'symlink.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: exportAllowed ? [agentId] : [], clockTrust: 'fixture' }] }
    let holdPublication = false
    const publicationEntered = Promise.withResolvers(), publicationRelease = Promise.withResolvers(), uploadTokens = []
    const captureClient = deadlineMode ? { ...client, evidence: { ...client.evidence, async publish(issued, bytes, signal) { uploadTokens.push(issued); if (holdPublication) { publicationEntered.resolve(); await publicationRelease.promise }; return client.evidence.publish(issued, bytes, signal) } } } : client
    const captures = createEvidenceCaptures({ journal, root: join(root, 'sealed'), profile, client: captureClient }), host = createAgentHost({ nodeId, journal, runtime, evidence: captures }); hosts.push(host)
    host.setOrchestrationHandler({ event: event => client.event(event), call: (execution, operation, parameters) => client.command(execution, operation, parameters) })
    const budgetPolicyId = `evidence-${agentId}`, limits = { maxModelRequests: 20, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }
    if (deadlineMode) { const state = await fixture.store.read(), employee = state.employees.find(row => row.id === agentId), route = state.modelRoutes.find(row => row.id === employee.modelRouteId); await budgetApi(`/api/admin/budget-policies/${budgetPolicyId}`, { clientRequestId: budgetPolicyId, expectedRevision: null, workspaceId: 'local', coordinatorAgentId: agentId, enabled: true, accountingMode: 'conservative_estimate', limits, executionTimeoutMs: 60000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }, 'PUT') }
    const work = await fixture.service.multisite.apply(owner, 'create', { employeeId: agentId, goal: '采集并分页读取受控资料', clientRequestId: `work-${nodeId}`, ...(deadlineMode ? { budgetPolicyId } : {}) })
    for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
    const execution = (await journal.read()).executions[0], operation = kind === 'history' ? 'read_history' : 'inspect_site', parameters = { clientRequestId: 'capture', instructionRevision: 1, resourceId, ...(kind === 'history' ? { datasetId: 'history' } : { sections: ['collector_health', 'recent_events'] }) }
    if (badWindow) {
      parameters.window = { from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString() }
      if (process.argv.includes('--expect-bad-window-accepted')) {
        const capture = await runtime.evidence(execution, operation, parameters), page = await runtime.evidence(execution, 'read_shared_evidence', { ref: capture.ref }); assert.equal(page.entries.length, 0); assert.equal(page.quality, 'current'); results.push({ agentId, rawMalformedTimeAcceptedAsEmptyCurrent: true, evidenceId: capture.ref.id })
      } else { await assert.rejects(runtime.evidence(execution, operation, parameters), { code: 'INVALID_REQUEST' }); assert(!(await fixture.store.read()).evidence.some(row => row.producerBinding.agent_id === agentId)); results.push({ agentId, malformedSelectedEventRejectedBeforeWindowAndPublication: true }) }
      continue
    }
    const captured = await runtime.evidence(execution, operation, parameters); assert.equal(captured.status, 'ready'); assert(!('entries' in captured)); assert(!JSON.stringify(captured).includes('DO_NOT_EXPORT'))
    let state = await fixture.store.read(), evidence = state.evidence.find(row => row.id === captured.ref.id), receipt = state.evidenceAccessReceipts.find(row => row.evidenceRef.id === captured.ref.id)
    assert.equal(state.works.find(row => row.id === work.workId).status, 'running'); assert.equal(evidence.sourceSha256, hash(original))
    const bytes = await readFile(join(directory, 'api/evidence', evidence.id)); assert.equal(hash(bytes), evidence.sha256)
    assert.equal(JSON.stringify(state).includes('DO_NOT_EXPORT'), false); assert.equal(bytes.includes(Buffer.from('DO_NOT_EXPORT')), false)
    if (!readerAllowed || !exportAllowed) {
      assert.equal(receipt, undefined); await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref }), { code: 'FORBIDDEN' })
      results.push({ agentId, kind, readerAllowed, exportAllowed, capturedPublishedWithoutContent: true, noSelfReceiptAndReadDenied: true }); continue
    }
    assert(receipt); assert.equal(receipt.reason, 'publisher_self')
    if (foreignCursor) await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, cursor: foreignCursor }), { code: 'INVALID_CURSOR' })
    const all = [], pages = []; let cursor
    do {
      const page = await runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, ...(cursor ? { cursor } : {}) })
      assert.equal(page.bytes, jsonBytes(page)); assert(page.bytes <= L.pageBytes); assert(page.entries.length <= L.pageItems); assert(jsonBytes({ ...page, entries: [] }) <= L.overheadBytes); assert(!JSON.stringify(page).includes(resourceId))
      if (cursor) assert.deepEqual(await runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, cursor }), page)
      pages.push(page); all.push(...page.entries); cursor = page.nextCursor
    } while (cursor)
    assert.equal(all.length, 200); assert(pages.length <= 32); assert(pages.reduce((sum, page) => sum + page.bytes, 0) <= 131072)
    if (!foreignCursor) foreignCursor = pages[0].nextCursor
    if (kind === 'history') assert.deepEqual(all.map(({ entryIndex, ...entry }) => entry), entries)
    else { assert.deepEqual(all, events); assert.equal(pages[0].health.queueDepth, worstSite ? Number.MAX_SAFE_INTEGER : null); assert.equal(pages[0].quality, 'unknown') }
    if (deadlineMode) {
      const oldDeadline = Date.parse(state.works.find(row => row.id === work.workId).modelRequestBudget.executionDeadlineAt), readToken = await client.post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision: 1, ref: captured.ref })
      assert(readToken.expiresAt <= oldDeadline); assert(uploadTokens.every(row => row.expiresAt <= oldDeadline))
      holdPublication = true
      const pendingCall = runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'pending-across-deadline' }); pendingCall.catch(() => {})
      await publicationEntered.promise
      const pendingState = await fixture.store.read(), pending = pendingState.evidence.find(row => row.workId === work.workId && row.status === 'pending'); assert(pending)
      const deadline = new Date(Date.now() + 100).toISOString()
      await budgetApi(`/api/admin/works/${work.workId}/budget`, { clientRequestId: `expire-${agentId}`, expectedRevision: 1, reason: 'Evidence令牌与sealed业务发布到期', limits, executionDeadlineAt: deadline })
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 20)); publicationRelease.resolve()
      await assert.rejects(pendingCall, { code: 'UNAUTHORIZED' })
      const oldRead = await fetch(fixture.origin + `/internal/evidence/${captured.ref.id}/content`, { headers: { authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'x-geneway-evidence-token': readToken.token } }); assert.equal(oldRead.status, 401)
      await assert.rejects(client.post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision: 1, ref: captured.ref }), { code: 'EXECUTION_DEADLINE' })
      await assert.rejects(client.post('/internal/evidence/resume-upload', { binding: binding(execution), captureId: pending.id.slice('evidence-'.length), declarationDigest: pending.declarationDigest }), { code: 'EXECUTION_DEADLINE' })
      await assert.rejects(runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'new-after-deadline' }), { code: 'EXECUTION_DEADLINE' })
      const after = await fixture.store.read(); assert.deepEqual(after.evidence.find(row => row.id === pending.id), pending); assert.equal(after.evidenceAccessReceipts.filter(row => row.evidenceRef.id === pending.id).length, 0)
      await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: `stop-${agentId}` })
      for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)); assert.equal((await fixture.store.read()).works.find(row => row.id === work.workId).status, 'cancelled')
      results.push({ agentId, kind, pageCount: pages.length, deadlineMode: true, readAndUploadTokenExpiryBounded: true, oldTokensExpiredAfterAdminShortening: true, sealedPendingPublicationAndResumeRejectedAfterDeadline: true, pendingAndOriginalReadyFactsPreserved: true, noReceiptForExpiredPending: true, stopAfterDeadline: true }); continue
    }
    const policyResults = []
    if (kind === 'site_snapshot' && process.argv.includes('--site-policy')) {
      for (const [name, sections, age, trust, expected] of [['health-only', ['collector_health'], 1000, 'fixture', 'current'], ['events-only', ['recent_events'], 1000, 'fixture', 'current'], ['stale', ['recent_events'], 180000, 'fixture', 'stale'], ['future', ['recent_events'], -60000, 'fixture', 'unknown'], ['unknown-clock', ['recent_events'], 1000, 'unknown', 'unknown']]) {
        const selected = { sourceTime: new Date(Date.now() - age).toISOString(), health: name === 'events-only' ? { secret: 'DO_NOT_EXPORT_UNSELECTED_HEALTH' } : { connection: 'connected', lastSuccessAt: null, queueDepth: null }, events: name === 'health-only' ? [{ deliberatelyMalformed: 'unselected events are not read' }] : [{ sourceEventId: name, sourceTimestamp: null, code: 'TEST', severity: 'info', message: '限域测试' }] }
        await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(selected))
        const args = { clientRequestId: `policy-${name}`, instructionRevision: 1, resourceId, sections }
        const policyCapture = trust === 'unknown' ? await createEvidenceCaptures({ journal, root: join(root, 'sealed-clock'), client, profile: { ...profile, profileVersion: 2, resources: profile.resources.map(item => ({ ...item, clockTrust: trust })) } }).call(execution, operation, args) : await runtime.evidence(execution, operation, args)
        const page = await runtime.evidence(execution, 'read_shared_evidence', { ref: policyCapture.ref }), sealed = JSON.parse(await readFile(join(directory, 'api/evidence', policyCapture.ref.id)))
        assert.equal(page.quality, expected); assert.equal(page.dataMode, 'fixture'); assert.equal(page.clockTrust, trust); assert.deepEqual(page.sections, sections)
        if (!sections.includes('collector_health')) { assert(!Object.hasOwn(page, 'health')); assert(!Object.hasOwn(sealed, 'health')) }
        if (!sections.includes('recent_events')) { assert(!Object.hasOwn(sealed, 'events')); assert.equal(page.entries.length, 0) }
        assert(!JSON.stringify(page).includes('DO_NOT_EXPORT')); policyResults.push({ name, quality: page.quality, sections: page.sections })
      }
      const oldToken = await client.post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision: 1, ref: captured.ref }); clockOffset = 300001
      const expired = await fetch(fixture.origin + `/internal/evidence/${captured.ref.id}/content`, { headers: { authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'x-geneway-evidence-token': oldToken.token } }); assert.equal(expired.status, 401)
      await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, cursor: pages[0].nextCursor }), { code: 'INVALID_CURSOR' })
      const restarted = await runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref }); assert.deepEqual(restarted.entries, pages[0].entries)
      const tampered = (restarted.nextCursor[0] === 'a' ? 'b' : 'a') + restarted.nextCursor.slice(1)
      await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, cursor: tampered }), { code: 'INVALID_CURSOR' }); await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: { ...captured.ref, version: 2 } }), { code: 'INVALID_REQUEST' }); clockOffset = 0
      policyResults.push({ name: 'cursor', expiredToken401: true, expiredCursorRejected: true, tamperedRejected: true, wrongRefVersionRejected: true, newChainSameImmutableRef: true })
    }
    await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(kind === 'history' ? { format: 'geneway.incident-history', version: 1, entries: [] } : { sourceTime: null, events: [] }))
    const same = await runtime.evidence(execution, operation, parameters); assert.deepEqual(same.ref, captured.ref); assert.deepEqual(await readFile(join(directory, 'api/evidence', evidence.id)), bytes)
    await assert.rejects(runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'capture', ...(kind === 'history' ? { datasetId: 'link' } : { sections: ['recent_events'] }) }), { code: 'IDEMPOTENCY_CONFLICT' })
    if (kind === 'history') {
      await assert.rejects(runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'link', datasetId: 'link' }), { code: 'INVALID_REQUEST' })
      await assert.rejects(runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'prototype', datasetId: 'constructor' }), { code: 'FORBIDDEN' })
    }
    await fixture.service.multisite.apply(owner, 'input', { workId: work.workId, clientRequestId: `revision-${nodeId}`, text: '修订当前要求' })
    for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
    await assert.rejects(runtime.evidence(execution, 'read_shared_evidence', { ref: captured.ref, cursor: pages[0].nextCursor }), { code: 'FORBIDDEN' })
    const fresh = await runtime.evidence(execution, operation, { ...parameters, clientRequestId: 'fresh-revision', instructionRevision: 2 }), readToken = await client.post('/internal/evidence/read-token', { binding: binding(execution), instructionRevision: 2, ref: fresh.ref })
    await fixture.nodes.revoke(owner, nodeId, { clientRequestId: `revoke-${nodeId}`, expectedRevision: (await fixture.store.read()).nodes.find(row => row.id === nodeId).revision })
    const revokedRead = await fetch(fixture.origin + `/internal/evidence/${fresh.ref.id}/content`, { headers: { authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'x-geneway-evidence-token': readToken.token } }); assert.equal(revokedRead.status, 403)
    await fixture.service.multisite.apply(owner, 'cancel', { workId: work.workId, clientRequestId: `cancel-${nodeId}` })
    for (const command of (await client.resync()).pending) { await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event))
    results.push({ agentId, kind, evidenceId: evidence.id, sourceSha256: evidence.sourceSha256, snapshotSha256: evidence.sha256, pageCount: pages.length, pageBytes: pages.map(page => page.bytes), entries: all.length, bytes: pages.reduce((sum, page) => sum + page.bytes, 0), sourceChangeSameSealedBytes: true, selfReceiptProducedByPublication: true, revisionReadDenied: true, policyResults })
  }
  const result = { result: 'passed', directory, boundary: 'real FileStore/source/seal/HTTP/production selfReceipt and AgentDelivery; simulated model runtime', results }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack }, null, 2)); throw cause }
finally { for (const host of hosts) await host.close(); await fixture.close() }
