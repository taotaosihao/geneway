import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-backpressure-')
let fixture, socket, recoveryAbort
try {
  fixture = await startBridgeService({ directory: join(directory, 'api') })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, body, method = 'POST') { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert(response.ok && result.ok !== false, JSON.stringify(result)); return result }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair', nodeId: 'cloud', siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 120_000).toISOString() })
  const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID(), registrationRevision: 1 }, client = createRemoteClient({ origin: fixture.origin, identity })
  await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem', credential: identity.credential, nodeInstanceId: identity.nodeInstanceId })
  // Legal bounded metadata makes the 32-frame inflight window exceed the local TCP send buffer.
  const resourceRefs = Array.from({ length: 32 }, (_, index) => `resource-${index}-` + '资'.repeat(180))
  for (let index = 0; index < resourceRefs.length; index++) await api(`/api/admin/resources/${encodeURIComponent(resourceRefs[index])}`, { clientRequestId: `resource-${index}`, expectedRevision: null, workspaceId: 'local', siteId: 'simulated-site', kind: 'analysis', ownerNodeId: 'cloud', capabilityIds: ['collaboration.coordinate.v1'], enabled: true }, 'PUT')
  await api('/api/admin/employees/coordinator', { expectedRevision: 1, placement: { nodeId: 'cloud', mode: 'agent_host', resourceRefs }, multisitePolicy: { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs }, delegation: { agentIds: [], capabilityIds: ['collaboration.coordinate.v1'], resourceRefs } } }, 'PATCH')
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '异'.repeat(16000), clientRequestId: 'work' })
  for (let index = 0; index < 34; index++) await api(`/api/works/${work.id}/multisite/inputs`, { text: '案'.repeat(16000), clientRequestId: `input-${index}` })
  const before = await fixture.store.read(), original = before.multisite.outbox.map(row => row.command); assert.equal(original.length, 35); assert(original.every(command => Buffer.byteLength(JSON.stringify(command)) < 256 * 1024))
  const url = new URL(fixture.origin), openedAt = Date.now(); let receivedBytes = 0, remoteClosed = false
  socket = createConnection({ host: url.hostname, port: Number(url.port) }); socket.on('error', () => {})
  const closed = new Promise(resolve => socket.once('close', () => { remoteClosed = true; resolve() }))
  await new Promise(resolve => socket.once('connect', resolve)); socket.pause()
  socket.write(`GET /internal/bridge/events HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${identity.credential}\r\nX-Geneway-Node-Instance: ${identity.nodeInstanceId}\r\nX-Geneway-Host-Run: slow-consumer\r\nAccept: text/event-stream\r\n\r\n`)
  // Keep the reader paused beyond the server's bounded drain timeout, then observe its close.
  await new Promise(resolve => setTimeout(resolve, 6500)); socket.on('data', bytes => { receivedBytes += bytes.length }); socket.resume()
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('slow socket was not disconnected by the bounded backpressure path')), 8000))])
  assert(remoteClosed); const closedAfterMs = Date.now() - openedAt
  assert((await fixture.store.read()).multisite.outbox.every(row => row.acceptedAt === null), 'SSE write/drain/close never counts as an exact ACK')
  recoveryAbort = new AbortController(); const stream = await client.stream(recoveryAbort.signal), seen = []
  for await (const command of stream) { const expected = original.find(row => row.command_id === command.command_id); assert.deepEqual(command, expected); seen.push(command.command_id); await client.ack(command); if (seen.length === original.length) break }
  recoveryAbort.abort(); assert.equal(new Set(seen).size, original.length); assert((await fixture.store.read()).multisite.outbox.every(row => row.acceptedAt))
  assert.equal((await fixture.store.read()).works[0].modelRequestBudget.reserved, 0)
  const result = { result: 'passed', directory, boundary: 'actual HTTP legal text/resource metadata and paused real TCP reader, no fake transport; recovery uses exact Node ACK; no Host/model execution', boundedFrameBytesMax: Math.max(...original.map(row => Buffer.byteLength(JSON.stringify(row)))), pendingCommands: 35, socketReaderPausedMs: 6500, socketClosedAfterMs: closedAfterMs, receivedBytes, serverClosedSlowSocket: true, noAckFromSseWrite: true, reconnectReplayedAllOriginalCommands: true, exactAckedAfterRecovery: 35, modelReservations: 0 }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { socket?.destroy(); recoveryAbort?.abort(); await fixture?.close() }
