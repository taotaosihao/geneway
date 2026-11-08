import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { migrateState } from '../src/store/file-store.mjs'
import { CLOUD_CAPACITY_LIMITS, measureCloudCapacity, modelSettlementGrowth } from '../src/cloud-capacity-measure.mjs'

const evidence = '/home/gewu/.codex/task-checkpoints/geneway-evidence/'
const load = async relative => JSON.parse(await readFile(evidence + relative))
const B = row => Buffer.byteLength(JSON.stringify(row), 'utf8')
const now = '2026-11-07T03:00:00.000Z'
const diagnosis = migrateState(await load('supervision-diagnosis-BpDS2q/terminal-cloud.json'))
const batch = await load('routing-batch-JLAJK1/prepared-real-batch.json')
const batchState = migrateState(batch.cloud)
const batchRow = batchState.modelRequests.find(row => row.id === batch.batch.modelRequestId)
const diagnosticRow = diagnosis.modelRequests.find(row => row.purpose === 'supervision_diagnosis')
assert.deepEqual(modelSettlementGrowth(batchRow), { variant: 'routing-v2', actualBytes: 2468, maxFinalBytes: 2606, positiveD: 138 })
assert.deepEqual(modelSettlementGrowth(diagnosticRow), { variant: 'supervision-diagnosis', actualBytes: 2011, maxFinalBytes: 2011, positiveD: 0 })
const reconstructed = { ...diagnosticRow, outcome: 'unknown', completedAt: null }
assert.deepEqual(modelSettlementGrowth(reconstructed), { variant: 'supervision-diagnosis', actualBytes: 1987, maxFinalBytes: 2125, positiveD: 138 })
const unknown = (await load('routing-batch-JLAJK1/actual-unknown-no-retry.json')).originalUnknown
assert.deepEqual(modelSettlementGrowth(unknown), { variant: 'routing-v2', actualBytes: 1938, maxFinalBytes: 1938, positiveD: 0 })
const legacy = migrateState(await load('interaction-routing-BSmBtC/state-final.json'))
const v1 = legacy.modelRequests.find(row => row.routingVersion === 1)
const legacyBusiness = diagnosis.modelRequests.find(row => row.purpose === undefined)
const business = migrateState(await load('a2a-collaboration-native-GYVANs/completed-state.json'))
const v2Business = business.modelRequests.find(row => row.accountingVersion === 2)
for (const [original, variant] of [[v1, 'routing-v1'], [legacyBusiness, 'business-legacy'], [v2Business, 'business-v2']]) {
  const reserve = { ...original, outcome: 'unknown', completedAt: null, usage: null,
    ...(Object.hasOwn(original, 'usageCostMicros') ? { usageCostMicros: null } : {}),
    ...(Object.hasOwn(original, 'noForwardReason') ? { noForwardReason: null } : {}) }
  const snapshot = structuredClone(reserve), result = modelSettlementGrowth(reserve)
  assert.equal(result.variant, variant); assert.ok(result.positiveD > 0)
  assert.equal(result.maxFinalBytes, result.actualBytes + result.positiveD)
  assert.deepEqual(reserve, snapshot)
}
assert.equal(modelSettlementGrowth({ ...batchRow, routingVersion: 3 }).variant, 'unsupported')
assert.equal(modelSettlementGrowth({ ...batchRow, purpose: 'unreviewed' }).positiveD, null)

const measured = measureCloudCapacity(diagnosis, now)
assert.deepEqual(CLOUD_CAPACITY_LIMITS, { historyBytes: 67108864, pendingBytes: 16777216, pendingCount: 1280, pendingPerNodeCount: 256 })
assert.equal(Object.keys(measured.tables).length, 14)
assert.deepEqual(measured.history, { count: 21, bytes: 19462 })
assert.equal(measured.tables.workMemberRemovals.hardCount, null)
assert.equal(Object.hasOwn(measureCloudCapacity(batchState, now).tables, 'routingBatches'), false)
assert.equal(measured.tables.nodes.bytes, diagnosis.nodes.reduce((sum, row) => sum + B(row), 0))
// The exact ACK shape changes only acceptedAt on an existing, real outbox row.
// Reconstruct the preceding pending view in memory; this is not another HTTP ACK.
const after = migrateState(await load('routing-batch-JLAJK1/terminal-cloud.json'))
const before = structuredClone(after), accepted = after.multisite.outbox.find(row => row.acceptedAt !== null)
const pending = before.multisite.outbox.find(row => row.id === accepted.id); pending.acceptedAt = null
const a = measureCloudCapacity(after, now), b = measureCloudCapacity(before, now)
assert.equal(a.pending.count, 0); assert.equal(a.pending.oldestAgeMs, null)
assert.equal(b.pending.count, 1); assert.equal(b.pending.bytes, B(pending)); assert.equal(b.pending.byNode[pending.command.node_id].bytes, B(pending))
assert.equal(b.pending.oldestCreatedAt, pending.createdAt)
assert.equal(b.pending.oldestAgeMs, Date.parse(now) - Date.parse(pending.createdAt))
assert.equal(a.history.count, b.history.count); assert.equal(a.history.bytes - b.history.bytes, B(accepted) - B(pending))
assert.equal(measureCloudCapacity(before, 'invalid clock').pending.oldestAgeMs, 'unknown')
assert.deepEqual(before.multisite.outbox.find(row => row.id === pending.id), pending)
console.log(JSON.stringify({ tables: 14, diagnosisBytes: 19462, reserveGrowth: 138, exactAckPendingBefore: b.pending.count,
  boundary: 'pure row measurement and settlement byte envelopes; no admission, budget, physical disk, or additional ACK proof' }))
