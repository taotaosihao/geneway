import { randomBytes, randomUUID } from 'node:crypto'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { seal } from '../packages/agent-contracts/index.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, open as fsOpen } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { startRemoteAgentHost } from '../packages/agent-host/remote.mjs'
import { acquireHostOwner } from '../packages/agent-host/ownership.mjs'
import { parseCommandStream } from '../packages/agent-host/remote-client.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-focused-')
let fixture, host
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function admin(path, value) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) }); const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result }
  const pair = (nodeId, allowedAgentIds) => admin('/api/admin/nodes/pairings', { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  let ready = 0
  const gatewayPairing = await pair('gateway', ['gateway']), root = join(directory, 'gateway')
  host = await startRemoteAgentHost({ root, origin: fixture.origin, pairing: gatewayPairing, onReady() { ready++ } })
  assert.equal(ready, 1)
  const journal = JSON.parse(await readFile(join(root, 'host-journal.json'), 'utf8')); assert.deepEqual(journal.executions, []); assert.deepEqual(journal.inbox, [])
  await assert.rejects(acquireHostOwner(root), { code: 'HOST_ALREADY_RUNNING' })
  const stableIdentity = JSON.parse(await readFile(join(root, 'node-identity.json'), 'utf8'))
  const firstInstance = host.nodeInstanceId, firstRun = host.hostRunId
  await host.close(); host = await startRemoteAgentHost({ root, origin: fixture.origin, onReady() { ready++ } })
  assert.equal(host.nodeInstanceId, firstInstance); assert.notEqual(host.hostRunId, firstRun); assert.equal(ready, 2)
  assert.equal(JSON.parse(await readFile(join(root, 'node-identity.json'), 'utf8')).credential, stableIdentity.credential)
  await host.close(); host = undefined
  const failedPairing = await pair('pc-b', ['desktop-office']), failedRoot = join(directory, 'failed-persistence')
  await mkdir(join(failedRoot, 'host-journal.json'), { recursive: true, mode: 0o700 })
  let failedReady = false
  await assert.rejects(startRemoteAgentHost({ root: failedRoot, origin: fixture.origin, pairing: failedPairing, onReady() { failedReady = true } }))
  assert.equal(failedReady, false); assert.equal((await fixture.store.read()).multisite.attempts.length, 0)
  const owner = await acquireHostOwner(failedRoot)
  process.kill(owner.helperPid, 'SIGKILL'); await owner.lost
  await assert.rejects(acquireHostOwner(failedRoot), { code: 'HOST_ALREADY_RUNNING' })
  await owner.release(); const replacementOwner = await acquireHostOwner(failedRoot); await replacementOwner.release()
  const identityPairing = await pair('identity-fixture', []), identityRoot = join(directory, 'identity-durability'), pairCount = fixture.requestCount('/internal/nodes/pair')
  let identityReady = false
  const fault = (stage) => ({ async open(path, flags, mode) {
    const file = await fsOpen(path, flags, mode)
    return new Proxy(file, { get(target, field) {
      if (field === 'sync') return async () => { if (stage === 'directory' && path === identityRoot || stage === 'file' && path === join(identityRoot, 'node-identity.json')) throw Object.assign(new Error('identity durability unavailable'), { code: 'EIO' }); return target.sync() }
      const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  await assert.rejects(startRemoteAgentHost({ root: identityRoot, origin: fixture.origin, pairing: identityPairing, identityOperations: fault('directory'), onReady() { identityReady = true } }), { code: 'EIO' })
  const unpublishedRegistration = JSON.parse(await readFile(join(identityRoot, 'node-identity.json'), 'utf8'))
  assert.equal(unpublishedRegistration.nodeId, null); assert.equal(fixture.requestCount('/internal/nodes/pair'), pairCount); assert.equal(identityReady, false)
  for (const stage of ['file', 'directory']) {
    await assert.rejects(startRemoteAgentHost({ root: identityRoot, origin: fixture.origin, pairing: identityPairing, identityOperations: fault(stage), onReady() { identityReady = true } }), { code: 'EIO' })
    assert.equal(fixture.requestCount('/internal/nodes/pair'), pairCount); assert.equal(identityReady, false)
  }
  host = await startRemoteAgentHost({ root: identityRoot, origin: fixture.origin, pairing: identityPairing })
  const registeredIdentity = JSON.parse(await readFile(join(identityRoot, 'node-identity.json'), 'utf8'))
  assert.equal(registeredIdentity.credential, unpublishedRegistration.credential); assert.equal(registeredIdentity.pairRequestId, unpublishedRegistration.pairRequestId); assert.equal(fixture.requestCount('/internal/nodes/pair'), pairCount + 1)
  assert.equal((await fixture.store.read()).nodePairings.find(row => row.id === identityPairing.pairingId).redemptionRequestId, unpublishedRegistration.pairRequestId)
  await host.close(); host = undefined
  const data = new TextEncoder().encode('id: one\r\nevent: command\r\ndata: {"command_id":"稳定消息"}\r\n\r\n'), chunks = [...data].map(byte => Uint8Array.of(byte)), seen = []
  for await (const command of parseCommandStream(new ReadableStream({ start(controller) { for (const bytes of chunks) controller.enqueue(bytes); controller.close() } }))) seen.push(command)
  assert.deepEqual(seen, [{ command_id: '稳定消息' }])
  async function rejectStream(text) { await assert.rejects(async () => { for await (const row of parseCommandStream(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } }))) {} }, { code: 'INVALID_RESPONSE' }) }
  await rejectStream('data: {"incomplete":true}'); await rejectStream('data: ' + 'x'.repeat(256 * 1024 + 1)); await rejectStream('data: invalid-json\n\n')
  const cloudPairing = await pair('cloud', ['coordinator', 'analysis']), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID(), registrationRevision: null }
  const client = createRemoteClient({ origin: fixture.origin, identity }), registered = await client.post('/internal/nodes/pair', { pairingId: cloudPairing.pairingId, pairingCode: cloudPairing.pairingCode, clientRequestId: 'cloud-redeem', nodeInstanceId: identity.nodeInstanceId, credential: identity.credential }); identity.registrationRevision = registered.node.registrationRevision
  const snapshotBefore = await client.resync(); assert.deepEqual(snapshotBefore.pending, [])
  const work = await admin('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '只验证出站 SSE 与持久 exactACK。', clientRequestId: 'stream-work' })
  const firstAbort = new AbortController(), firstStream = await client.stream(firstAbort.signal), launch = (await firstStream.next()).value
  const cloudJournal = createHostJournal(join(directory, 'cloud-host-journal.json')), simulated = createSimulatedRuntime({ path: join(directory, 'cloud-host-sessions.json') }), cloudHost = createAgentHost({ nodeId: 'cloud', journal: cloudJournal, runtime: simulated })
  await cloudHost.accept({ workspaceId: 'local', nodeId: 'cloud' }, launch)
  firstAbort.abort()
  // A position hint requires resync; it never substitutes for the exact ACK.
  const secondAbort = new AbortController(), response = await fetch(fixture.origin + '/internal/bridge/events', { headers: { authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId, 'x-geneway-host-run': randomUUID(), 'last-event-id': launch.command_id }, signal: secondAbort.signal })
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'RESYNC_REQUIRED')
  assert((await client.resync()).pending.some(row => row.command_id === launch.command_id))
  const secondStream = await client.stream(secondAbort.signal)
  const repeated = (await secondStream.next()).value; assert.deepEqual(repeated, launch)
  await cloudHost.accept({ workspaceId: 'local', nodeId: 'cloud' }, repeated); assert.equal((await cloudJournal.read()).inbox.length, 1)
  await client.ack(launch); assert.equal((await client.resync()).pending.length, 0)
  await cloudHost.process(); await cloudHost.flushEvents(event => client.event(event))
  await admin(`/api/works/${work.id}/multisite/inputs`, { text: '新连接存活后到达的第二版输入。', clientRequestId: 'stream-input2' })
  const delivered = (await secondStream.next()).value; assert.equal(delivered.operation, 'deliver'); assert.equal(delivered.instruction_revision, 2)
  await cloudHost.accept({ workspaceId: 'local', nodeId: 'cloud' }, delivered); await client.ack(delivered); await cloudHost.process(); await cloudHost.flushEvents(event => client.event(event))
  const bindingBeforeRevoke = (await fixture.store.read()).multisite.attempts.find(row => row.work_id === work.id)
  await simulated.report(bindingBeforeRevoke.launch_id, { state: 'ready', summary: '尚未上报的普通回报，撤权后不得生效。' })
  await admin('/api/admin/nodes/cloud/revoke', { clientRequestId: 'cleanup-stream', expectedRevision: registered.node.revision })
  const cleanup = await client.resync(); assert.equal(cleanup.status, 'cleanup_only'); assert(cleanup.pending.every(row => ['cancel', 'settle'].includes(row.operation)))
  for (const command of cleanup.pending) { await cloudHost.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }
  await cloudHost.process(); await cloudHost.flushEvents(event => client.event(event), { cleanupOnly: client.cleanupOnly })
  const cleanupJournal = await cloudJournal.read(); assert.equal(cleanupJournal.outbox.find(row => row.event.kind === 'report').acknowledged, false); assert.equal(cleanupJournal.outbox.find(row => row.event.kind === 'stopped').acknowledged, true)
  assert.equal((await fixture.store.read()).works.find(row => row.id === work.id).status, 'cancelled')
  await admin('/api/admin/nodes/cloud/revoke', { clientRequestId: 'cleanup-again', expectedRevision: registered.node.revision + 1 })
  assert.equal((await fixture.store.read()).nodes.find(row => row.id === 'cloud').cleanupBindings.length, 0)
  const acceptedEvent = cleanupJournal.outbox.find(row => row.event.kind === 'started').event
  assert.equal((await client.event(acceptedEvent)).event_id, acceptedEvent.event_id)
  assert.equal((await client.ack(launch)).command_id, launch.command_id)
  const { payload_digest, ...eventBody } = acceptedEvent
  await assert.rejects(client.event(seal({ ...eventBody, reason: 'new-payload-under-old-event-id' })), { code: 'FORBIDDEN' })
  secondAbort.abort(); await cloudHost.close()
  const result = { result: 'passed', directory, boundary: 'actual HTTP Node redeem/resync/SSE with real remote entry idle startup, native filesystem/flock; parser negatives use streamed external input; no DSH task yet', identityReopenFileAndDirectoryConfirmation: true, failedIdentityConfirmationZeroHttp: true, originalCredentialAndPairRequestReused: true, idleJournalDurableBeforeReady: true, persistenceFailureNoReady: true, realSingleWriterLock: true, helperLossRetainsParentLockUntilRelease: true, restartKeepsInstanceAndCredential: true, distinctHostRun: true, crlfAndSplitUtf8: true, boundedParserRejectsPartialAndOversize: true, realSsePendingReplayWithoutAck: true, lastEventIdCannotSkip: true, exactAckClearsPending: true, newConnectionSurvivesOldClose: true, resyncBeforeNewCommandHasNoGap: true, cleanupSkipsRejectedOrdinaryWithoutAck: true, acceptedReceiptReplayOutsideCleanupBindings: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await host?.close(); await fixture?.close() }
