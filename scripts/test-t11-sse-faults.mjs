import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/t11-sse-generation-')
const timeline = [], observations = [], delayed = []
const mark = (name, details = {}) => { const row = { name, at: new Date().toISOString(), ...details }; timeline.push(row); console.log(JSON.stringify(row)); return row }
let fixture, host, streamOrdinal = 0, oldResponse, released = false
let oldResponseClosed, oldSocketClosed, closeIntercepted
const responseClosed = new Promise(resolve => { oldResponseClosed = resolve })
const socketClosed = new Promise(resolve => { oldSocketClosed = resolve })
const intercepted = new Promise(resolve => { closeIntercepted = resolve })
const firstAbort = new AbortController(), secondAbort = new AbortController()
function onRequest(request, response) {
  if (request.method !== 'GET' || request.url !== '/internal/bridge/events') return
  const ordinal = ++streamOrdinal
  mark('real-sse-request', { ordinal, hostRunId: request.headers['x-geneway-host-run'], hasLastEventId: !!request.headers['last-event-id'], clientPort: request.socket.remotePort })
  if (ordinal !== 1) return
  oldResponse = response
  response.on('close', () => { mark('old-response-close-event'); oldResponseClosed() })
  request.socket.once('close', () => { mark('old-socket-physically-closed'); oldSocketClosed() })
  const once = response.once
  response.once = function (event, listener) {
    if (event !== 'close') return once.call(this, event, listener)
    // Only this real response's first application once(close); physical close proceeds normally.
    response.once = once
    mark('old-application-close-listener-wrapped')
    return once.call(this, event, function (...args) {
      delayed.push(() => listener.apply(this, args))
      mark('old-application-close-callback-held'); closeIntercepted()
    })
  }
}
try {
  fixture = await startBridgeService({ directory: join(directory, 'api'), onRequest })
  mark('live-started', { directory, origin: fixture.origin, pid: process.pid })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, value) {
    const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(value) })
    const result = await response.json(); observations.push({ path, status: response.status, value: result }); assert.equal(response.status, 200, JSON.stringify(result)); return result
  }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'cloud-pair', nodeId: 'cloud', siteId: 'fixture', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator', 'analysis'], expiresAt: new Date(Date.now() + 60000).toISOString() })
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID(), registrationRevision: null }
  const client = createRemoteClient({ origin: fixture.origin, identity })
  const registered = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'cloud-redeem', nodeInstanceId: identity.nodeInstanceId, credential: identity.credential })
  identity.registrationRevision = registered.node.registrationRevision
  assert.deepEqual((await client.resync()).pending, [])
  const journal = createHostJournal(join(directory, 'host-journal.json'))
  const runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
  host = createAgentHost({ nodeId: 'cloud', journal, runtime })
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '验证旧SSE close晚到不删除新generation。', clientRequestId: 'generation-work' })
  async function persistAndAck(command, label) {
    await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command)
    const persisted = await journal.read()
    assert.deepEqual(persisted.inbox.find(row => row.command.command_id === command.command_id).command, command)
    const ack = await client.ack(command)
    assert.equal(ack.command_id, command.command_id); assert.equal(ack.payload_digest, command.payload_digest)
    await host.process(); await host.flushEvents(event => client.event(event))
    mark(label, { commandId: command.command_id, payloadDigest: command.payload_digest, binding: binding(command), instructionRevision: command.instruction_revision, exactAck: ack })
  }
  const oldStream = await client.stream(firstAbort.signal)
  const launch = (await oldStream.next()).value
  await persistAndAck(launch, 'old-stream-launch-durable-exact-ack')
  const initial = await fixture.store.read(), originalBinding = binding(initial.multisite.attempts.find(row => row.work_id === work.id))
  assert.equal(streamOrdinal, 1)
  // No abort/destroy of old flow here: production installing generation2 must destroy generation1.
  const newStream = await client.stream(secondAbort.signal)
  await Promise.all([responseClosed, socketClosed, intercepted])
  assert.equal(streamOrdinal, 2); assert.equal(oldResponse.destroyed, true); assert.equal(delayed.length, 1)
  await api(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'input2-before-close-release', text: '新流先真实收到第二版，再释放旧close。' })
  const input2 = (await newStream.next()).value
  assert.equal(input2.operation, 'deliver'); assert.equal(input2.instruction_revision, 2)
  await persistAndAck(input2, 'new-generation-receives-before-old-callback-release')
  assert.equal(released, false)
  mark('release-original-old-close-callback', { newStreamAlreadyReceived: input2.command_id, oldSocketClosed: true })
  for (const callback of delayed) callback()
  released = true
  await api(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'input3-after-close-release', text: '旧close执行后，仍由原新连接接收第三版。' })
  const input3 = (await newStream.next()).value
  assert.equal(input3.operation, 'deliver'); assert.equal(input3.instruction_revision, 3)
  assert.notEqual(input3.command_id, input2.command_id)
  await persistAndAck(input3, 'new-generation-survives-late-old-close-durable-exact-ack')
  assert.equal(streamOrdinal, 2)
  const after = await fixture.store.read(), finalBinding = binding(after.multisite.attempts.find(row => row.work_id === work.id))
  assert.deepEqual(finalBinding, originalBinding)
  assert.equal(after.nodes.find(row => row.id === 'cloud').nodeInstanceId, identity.nodeInstanceId)
  assert.deepEqual((await client.resync()).pending, [])
  const durable = await journal.read()
  for (const command of [launch, input2, input3]) assert.equal(durable.inbox.filter(row => row.command.command_id === command.command_id).length, 1)
  assert.equal(timeline.filter(row => row.name === 'old-application-close-callback-held').length, 1)
  await writeFile(join(directory, 'state-after-overlap.json'), JSON.stringify(after, null, 2))
  await writeFile(join(directory, 'journal-after-overlap.json'), JSON.stringify(durable, null, 2))
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'generation-cleanup' })
  const cleanup = (await newStream.next()).value
  await persistAndAck(cleanup, 'cleanup-cancel')
  const result = { result: 'passed', directory, window: 'E08 old close callback invoked after new SSE generation installed and receiving', timeline,
    realSseConnections: streamOrdinal, applicationCloseCallbacksHeldAndReleased: delayed.length, oldSocketClosedBeforeCallbackRelease: true,
    newStreamReceivedBeforeAndAfterCallback: [input2.command_id, input3.command_id], exactBindingUnchanged: originalBinding,
    oldLaunchAndNewDeliveriesPersistedOnce: true, exactAckClearedPending: true,
    boundary: 'two real authenticated same-Node HTTP SSE connections; fixture delays only old response registered close callback, never transport close or connections Map; production business Inputs, real Host journal and exact cloud ACK; Host simulator, no SDK/native or other T11 windows' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, timeline }, null, 2)); throw cause }
finally {
  if (!released) for (const callback of delayed) callback()
  firstAbort.abort(); secondAbort.abort()
  await host?.close(); await fixture?.close()
  await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2))
  await writeFile(join(directory, 'timeline.json'), JSON.stringify(timeline, null, 2))
  console.log('T11 SSE generation root:', directory)
}
