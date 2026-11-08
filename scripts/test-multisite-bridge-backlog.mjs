import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { startRemoteAgentHost } from '../packages/agent-host/remote.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/bridge-backlog-'), bodies = []
let fixture, host
try {
  fixture = await startBridgeService({ directory: join(directory, 'api'), fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); bodies.push(body)
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"最新要求已消费"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  await mkdir(join(directory, 'api/secrets')); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-only-key', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  async function api(path, body) { const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result }
  const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair-cloud', nodeId: 'cloud', siteId: 'simulated-site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator', 'analysis'], expiresAt: new Date(Date.now() + 120_000).toISOString() })
  const root = join(directory, 'host')
  // Pair and durably initialize the real Host, then take it offline before adding the backlog.
  host = await startRemoteAgentHost({ root, origin: fixture.origin, pairing }); await host.close(); host = undefined
  const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: '合法离线输入积压恢复。', clientRequestId: 'create' })
  for (let index = 0; index < 20; index++) await api(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: `input-${index}`, text: index === 19 ? 'LATEST_CURRENT_' + 'x'.repeat(15985) : 'x'.repeat(16000) })
  const before = await fixture.store.read(); assert.equal(before.multisite.outbox.length, 21); assert(before.multisite.outbox.every(row => row.acceptedAt === null)); assert.equal(before.works[0].instructionRevision, 21)
  const identity = JSON.parse(await readFile(join(root, 'node-identity.json'), 'utf8'))
  const resync = await fetch(fixture.origin + '/internal/bridge/resync', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.credential}`, 'x-geneway-node-instance': identity.nodeInstanceId }, body: JSON.stringify({ hostRunId: 'backlog-check' }) }), responseBytes = Buffer.from(await resync.arrayBuffer()), snapshot = JSON.parse(responseBytes)
  assert.equal(resync.status, 200); assert(responseBytes.length <= 256 * 1024); assert(snapshot.pending.length > 0 && snapshot.pending.length <= 21); assert(snapshot.hasMorePending || snapshot.pending.some(row => row.kind === 'command_ref'))
  await writeFile(join(directory, 'bounded-resync.json'), responseBytes)
  host = await startRemoteAgentHost({ root, origin: fixture.origin })
  await until(async () => { const state = await fixture.store.read(); return state.multisite.inputs.find(row => row.revision === 21).deliveries[0].ingestedAt && state.multisite.outbox.every(row => row.acceptedAt) && state.modelRequests.length === 1 && state.modelRequests[0].outcome === 'completed' })
  const final = await fixture.store.read(), journal = await host.journal.read()
  assert.equal(final.modelRequests[0].instructionRevision, 21); assert.equal(bodies.length, 1); assert.equal(final.works[0].modelRequestBudget.reserved, 1)
  const latest = bodies[0].messages.findLast(row => row.role === 'user'); assert(JSON.stringify(latest).includes('LATEST_CURRENT_'))
  assert.equal(journal.executions.length, 1); assert.equal(new Set(journal.executions.map(row => row.session_id)).size, 1); assert.equal(journal.inbox.filter(row => !['cancel', 'settle'].includes(row.command.operation)).length, 21)
  assert.equal(final.multisite.inputs.length, 21)
  await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'cancel' }); await until(async () => (await fixture.store.read()).works[0].status === 'cancelled')
  const result = { result: 'passed', directory, acceptedInputCount: 21, currentRevision: 21, resyncBytes: responseBytes.length, firstBatchCount: snapshot.pending.length, remainingFromOriginalDurableOutbox: true, allExactAcked: true, currentInputActuallyIngested: true, nativeSessions: 1, oldRevisionModelForwards: 0, actualForwardRequests: 1, actualStop: true, boundary: 'real HTTP twenty legal 16000-character inputs, real remote Host/DSH and model gateway; synthetic provider; no business data reads' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await host?.close(); await fixture?.close(); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)) }
async function until(predicate) { const deadline = Date.now() + 45_000; while (!await predicate()) { assert(Date.now() < deadline, 'legal backlog native recovery timed out'); await new Promise(resolve => setTimeout(resolve, 70)) } }
