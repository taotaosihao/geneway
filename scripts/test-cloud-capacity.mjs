import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { cloudClosingObligations, cloudCapacityStatus, assertCloudCapacity } from '../src/cloud-capacity.mjs'
import { CLOUD_CAPACITY_LIMITS } from '../src/cloud-capacity-measure.mjs'
import { buildExecutionCommand, queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { buildTerminalEvent } from '../packages/agent-contracts/terminal-proof.mjs'
import { binding, key, seal } from '../packages/agent-contracts/index.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { wakeDependencies } from '../packages/agent-orchestration/dependencies.mjs'

const source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/site-rule-GmU3uX/terminal-cloud.json'
const sourceBytes = await readFile(source), original = JSON.parse(sourceBytes), expected = migrateState(structuredClone(original))
assert.equal(original.version, 31)
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/cloud-capacity-component-')
const realPath = root + '/real-donor.json'; await writeFile(realPath, sourceBytes)
const realStore = createFileStore(realPath)
assert.deepEqual(await realStore.read(), expected); await realStore.update(state => state)
assert.deepEqual(await createFileStore(realPath).read(), expected); assert.deepEqual(await readFile(source), sourceBytes)
assert.deepEqual(CLOUD_CAPACITY_LIMITS, { historyBytes: 67108864, pendingBytes: 16777216, pendingCount: 1280, pendingPerNodeCount: 256 })
const baseline = cloudClosingObligations(expected)
assert.equal(Object.keys(baseline.measurement.tables).length, 14)
assert.equal(baseline.measurement.tables['multisite.commands'].hardCount, 10000)
assert.equal(baseline.measurement.tables['multisite.receipts'].hardCount, 30000)
assert.equal(baseline.measurement.tables.workMemberRemovals.hardCount, null)
assert.ok(!Object.hasOwn(baseline.measurement.tables, 'routingBatches'))
assert.equal(cloudCapacityStatus(expected).state, 'available')

// A hypothetical valid historical command population, never reported as actual
// business. Long IDs use the original 16000-character public text domain.
const synthetic = structuredClone(expected), template = expected.multisite.commands.find(row => row.issuerId === 'owner' && row.reply.commandId)
assert.ok(template)
const command = (index, length = 16000, source = template) => {
  const prefix = 'capacity-unit-' + index + '-', commandId = prefix + '\0'.repeat(length - prefix.length)
  return { ...structuredClone(source), commandId, key: key(source.workspaceId, source.issuerId, commandId), reply: { ...source.reply, commandId } }
}
const B = row => Buffer.byteLength(JSON.stringify(row))
let remaining = CLOUD_CAPACITY_LIMITS.historyBytes - baseline.projected.historyBytes - 1024, index = 0
while (B(command(index)) < remaining) { const row = command(index++); synthetic.multisite.commands.push(row); remaining -= B(row) }
// Fill close to the true pool limit without changing its production threshold.
const prefixBytes = B(command(index, 40)), length = Math.max(40, Math.floor((remaining - prefixBytes) / 12) + 40)
if (length <= 16000) synthetic.multisite.commands.push(command(index++, length))
const validated = migrateState(structuredClone(synthetic))
const near = cloudClosingObligations(validated)
assert.ok(near.projected.historyBytes <= CLOUD_CAPACITY_LIMITS.historyBytes)
assert.ok(CLOUD_CAPACITY_LIMITS.historyBytes - near.projected.historyBytes < 4096)
const path = root + '/near-cap.json'; await writeFile(path, JSON.stringify(validated))
const beforeBytes = await readFile(path)
await assert.rejects(createFileStore(path).update(state => { state.multisite.commands.push(command(index)); return state }), error => error.code === 'CAPACITY_EXCEEDED')
assert.deepEqual(await readFile(path), beforeBytes, 'rejected ordinary growth must not write any part of the tree')

// Isolate count/pending gates with memory-only arrays; these are not 10000
// invented Work executions and are not passed off as received history.
const sample = expected.multisite.outbox[0]; assert.ok(sample)
for (const [count, nodes] of [[257, 1], [1281, 6]]) {
  const state = structuredClone(expected); state.multisite.outbox = Array.from({ length: count }, (_, i) => ({ ...structuredClone(sample), id: key('unit-pending', i), command: { ...sample.command, command_id: key('unit-pending', i), node_id: 'unit-node-' + (i % nodes) }, acceptedAt: null }))
  const status = cloudCapacityStatus(state); assert.equal(status.state, 'overcommitted')
  assert.ok(status.reasons.includes(nodes === 1 ? 'node_pending_count' : 'pending_count'))
}
const pendingBytes = structuredClone(expected)
pendingBytes.multisite.outbox = [{ ...structuredClone(sample), acceptedAt: null, command: { ...sample.command, parameters: { text: 'x'.repeat(CLOUD_CAPACITY_LIMITS.pendingBytes) } } }]
assert.ok(cloudCapacityStatus(pendingBytes).reasons.includes('pending_bytes'))

// Gate-only proof fixture: original builders, not a claim of actual OS exit.
const stopBefore = structuredClone(validated), attempt = stopBefore.multisite.attempts.find(row => row.agent_id === 'coordinator')
assert.ok(attempt); attempt.status = 'stopping'
const work = stopBefore.works.find(row => row.id === attempt.work_id); work.status = 'stopping'
const cmd = buildExecutionCommand(stopBefore, attempt, 'cancel', null, work.workspaceId)
stopBefore.multisite.outbox = stopBefore.multisite.outbox.filter(row => row.id !== cmd.command_id)
stopBefore.multisite.receipts = stopBefore.multisite.receipts.filter(row => !(row.event.kind === 'stopped' && row.event.attempt_id === attempt.attempt_id))
stopBefore.multisite.outbox.push({ id: cmd.command_id, command: cmd, createdAt: new Date().toISOString(), acceptedAt: null })
stopBefore.multisite.commands.push(command(index++)) // keep pressure after the small proof consumes its envelope
assert.equal(cloudCapacityStatus(stopBefore).state, 'overcommitted')
const event = buildTerminalEvent({ execution: attempt, command: cmd, evidence: 'idle_after_cancel', jobEvidence: [] })
const receipt = { nodeId: event.node_id, event, historical: false, ack: { event_id: event.event_id, node_id: event.node_id, payload_digest: event.payload_digest, ...binding(event) } }
const afterStop = structuredClone(stopBefore); afterStop.multisite.receipts.push(receipt)
afterStop.multisite.attempts.find(row => row.attempt_id === attempt.attempt_id).status = 'cancelled'
assert.equal(cloudCapacityStatus(afterStop).state, 'overcommitted')
assert.doesNotThrow(() => assertCloudCapacity(stopBefore, afterStop))
assert.doesNotThrow(() => assertCloudCapacity(afterStop, structuredClone(afterStop)), 'exact replay has no row growth')
const foreign = structuredClone(afterStop), foreignEvent = seal({ ...event, attempt_id: 'foreign-binding' })
foreign.multisite.receipts[foreign.multisite.receipts.length - 1] = { ...receipt, event: foreignEvent, ack: { ...receipt.ack, attempt_id: foreignEvent.attempt_id, payload_digest: foreignEvent.payload_digest } }
assert.throws(() => assertCloudCapacity(stopBefore, foreign), error => error.code === 'CAPACITY_EXCEEDED')
const repeatedControl = structuredClone(afterStop); repeatedControl.multisite.commands.push(command(index++))
assert.throws(() => assertCloudCapacity(afterStop, repeatedControl), error => error.code === 'CAPACITY_EXCEEDED')

const acked = structuredClone(stopBefore); acked.multisite.outbox.find(row => row.id === cmd.command_id).acceptedAt = new Date().toISOString()
assert.doesNotThrow(() => assertCloudCapacity(stopBefore, acked))

const settling = structuredClone(stopBefore), model = settling.modelRequests.find(row => row.outcome !== 'unknown')
assert.ok(model)
const actualConclusion = structuredClone(model)
model.outcome = 'unknown'; model.usage = null; model.completedAt = null
if (Object.hasOwn(model, 'usageCostMicros')) model.usageCostMicros = null
const settled = structuredClone(settling); settled.modelRequests[settled.modelRequests.findIndex(row => row.id === model.id)] = actualConclusion
assert.doesNotThrow(() => assertCloudCapacity(settling, settled))

const debt = structuredClone(validated); debt.multisite.commands.push(command(index++))
assert.equal(cloudCapacityStatus(debt).state, 'overcommitted')
const debtPath = root + '/legacy-debt.json'; await writeFile(debtPath, JSON.stringify(debt))
const debtStore = createFileStore(debtPath); const debtRead = await debtStore.read(); await debtStore.update(state => state)
assert.deepEqual(await createFileStore(debtPath).read(), debtRead)
await assert.rejects(debtStore.update(state => { state.multisite.commands.push(command(index)); return state }), error => error.code === 'CAPACITY_EXCEEDED')
assert.deepEqual(await debtStore.read(), debtRead)
// Production receipt and scanner separation, on a component-only valid clone.
// Build an eligible component wait on the original B → A edge using the real
// completed A result; preserve the archived C → B wait and result unchanged.
const scannerSource = '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-recovery-a2a-result-rRB3Pj/relay/recovery-committed.json'
const scannerBytes = await readFile(scannerSource), scanner = migrateState(JSON.parse(scannerBytes).state)
const result = scanner.multisite.results.find(row => !row.historical)
const waitWork = scanner.works.find(row => row.id === result.workId)
const waitingParent = scanner.multisite.attempts.find(row => row.delegation_id === result.senderBinding.parent_delegation_id)
const originalWait = scanner.multisite.dependencyWaits.find(row => row.workId === waitWork.id && !row.wokenAt)
const wait = { ...originalWait, id: key('wait', waitingParent.attempt_id, 1), parentAttemptId: waitingParent.attempt_id, dependencyIds: [result.delegationId] }
scanner.multisite.dependencyWaits.push(wait); waitingParent.status = 'waiting_dependency'
const at = '2026-11-06T14:25:00.000Z', errors = [], scanPath = root + '/receipt-scanner.json'
const disk = createFileStore(scanPath)
const observedStore = { read: () => disk.read(), async update(mutator, options) {
  try { return await disk.update(mutator, options) } catch (error) { if (error.code === 'CAPACITY_EXCEEDED') errors.push(error.capacity); throw error }
} }
const service = createMultisiteService({ store: observedStore, hosts: scanner.nodes.map(node => ({ nodeId: node.id })), clock: () => at })
const owner = { id: waitWork.ownerMemberId }
const created = service.applyTransition(scanner, owner, 'create', { employeeId: 'analysis', goal: '组件内独立停止接收测试', clientRequestId: 'scanner-stop-work' })
const stopWorkId = created.reply.workId
service.applyTransition(scanner, owner, 'cancel', { workId: stopWorkId, clientRequestId: 'scanner-stop-cancel' })
const sourceCancel = scanner.multisite.outbox.find(row => row.command.work_id === stopWorkId && row.command.operation === 'cancel').command
const stopAttempt = scanner.multisite.attempts.find(row => row.attempt_id === sourceCancel.attempt_id)
const stopEvent = buildTerminalEvent({ execution: { ...stopAttempt, session_id: stopAttempt.session_id ?? `geneway-${stopAttempt.launch_id}` }, command: sourceCancel, evidence: 'never_started', jobEvidence: [] })
const positive = structuredClone(scanner), oldOutbox = positive.multisite.outbox.length
wakeDependencies(positive, positive.works.find(row => row.id === waitWork.id), (state, target, operation, input, at) => queueExecutionCommand(state, target, operation, input, at, waitWork.workspaceId), at)
assert.equal(positive.multisite.outbox.length, oldOutbox + 1)
const wakeId = positive.multisite.outbox.at(-1).id; assert.equal(positive.multisite.outbox.at(-1).command.operation, 'wake')
const startProjected = cloudClosingObligations(scanner).projected.historyBytes
const scanTemplate = scanner.multisite.commands.find(row => row.issuerId === owner.id && row.reply.commandId)
let spare = CLOUD_CAPACITY_LIMITS.historyBytes + 700000 - startProjected, scanIndex = 0
while (B(command(scanIndex, 16000, scanTemplate)) < spare) { const row = command(scanIndex++, 16000, scanTemplate); scanner.multisite.commands.push(row); spare -= B(row) }
const initialScan = migrateState(scanner); const pressure = cloudCapacityStatus(initialScan)
assert.equal(pressure.state, 'overcommitted'); assert.ok(pressure.history.bytes < CLOUD_CAPACITY_LIMITS.historyBytes)
await writeFile(scanPath, JSON.stringify(initialScan))
const actualAck = await service.acceptHostEvent({ workspaceId: sourceCancel.workspace_id, nodeId: sourceCancel.node_id }, stopEvent)
assert.equal(actualAck.event_id, stopEvent.event_id); assert.equal(actualAck.payload_digest, stopEvent.payload_digest)
await service.resumeBudget() // joins the scheduled scan; does not start a pump or server
const scanAfter = await disk.read()
assert.equal(scanAfter.works.find(row => row.id === stopWorkId).status, 'cancelled')
const persistedProof = scanAfter.multisite.receipts.find(row => row.event.event_id === stopEvent.event_id)
assert.deepEqual(persistedProof.ack, actualAck); assert.equal(persistedProof.historical, false)
assert.ok(errors.some(error => error?.domain === 'cloud' && error.queue === 'ordinary' && error.reason === 'history_bytes'), 'actual ordinary scanner write must hit capacity')
assert.equal(scanAfter.multisite.dependencyWaits.find(row => row.id === wait.id).wokenAt, null)
assert.equal(scanAfter.multisite.outbox.some(row => row.id === wakeId), false)
assert.equal(scanAfter.multisite.messages.some(row => row.replyTo === wait.id), false)
assert.deepEqual(await readFile(scannerSource), scannerBytes)

console.log(JSON.stringify({ root, source, nearProjectedBytes: near.projected.historyBytes, scanner: { source: scannerSource, receipt: actualAck.event_id, ordinaryRefusals: errors.length, pendingWait: wait.id }, syntheticCommandRows: validated.multisite.commands.length,
  checks: 'real donor noop/reopen; actual 64MiB FileStore rejection atomic; pending count/bytes/node edges; matched proof/ACK/model settlement; replay/new-key/foreign-binding credit boundaries; legacy debt read/noop but no new ordinary',
  boundary: 'pure capacity component and hypothetical valid history; production service receipt with component-only stop fixture; no actual runtime stop, HTTP/provider or OS proof' }))
