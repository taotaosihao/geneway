import assert from 'node:assert/strict'
import { createActionService } from '../src/action-service.mjs'
import { createAutomationService } from '../src/automation-service.mjs'
import { getCapability, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY as correlation } from '../src/capabilities.mjs'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const owner = { id: 'owner' }, admin = { id: 'admin' }, now = '2026-10-15T14:00:00.000Z'
const read = 'gearjob-work-order-read', cycle = 'cycle-time-calculate'
const order = 'WO-26-00096', gear = connection('gear', 'gearjob-rest'), hive = connection('hive', 'hive-tenant-records')
const retiredError = { code: 'CAPABILITY_RETIRED' }
let modelCalls = 0, sourceCalls = 0, nativeBoots = 0, harnesses = 0
const store = memoryStore(seed()), catalog = [gear, hive]
const work = createWorkService({ store, clock: () => now, connectionCatalog: catalog,
  runner: { configured: true, async run() { modelCalls += 1; throw new Error('retired work reached model') }, async cancel() { return true }, async close() {} },
  collaborationRunner: { async run() { nativeBoots += 1 }, async cancel() { return false }, async close() {} },
})
await work.ensureReady()
try {
  assert.equal(getCapability(read).retired, true)
  assert.equal(getCapability(correlation).retired, true)
  assert.equal(getCapability(cycle).retired, false)
  assert.equal(getCapability('kivo-tpm-record-read').retired, false)
  const historical = await work.getWork(owner, 'gear-work')
  assert.equal(historical.value.retired, true)
  assert.deepEqual(historical.value.results[0].payload, { historical: 'EXACT_OLD_TYPED_FACT' })
  assert.equal((await work.getWork(owner, 'cycle-child')).value.retired, true)
  assert.equal((await work.getWork(owner, 'old-root')).value.retired, true)
  assert.equal((await work.getWork(owner, 'standalone-cycle')).value.retired, false)
  assert.equal((await work.getWork({ id: 'other' }, 'gear-work')).error.code, 'NOT_FOUND')
  const baseline = await store.read()
  await assert.rejects(work.testConnection(admin, 'gear'), retiredError)
  await assert.rejects(work.testConnection(admin, 'hive'), retiredError)
  const create = await work.createWork(owner, { employeeId: 'agent', skillId: `skill-${read}`, connectionId: 'gear', input: { workOrderId: order }, clientRequestId: 'new-legacy' })
  assert.equal(create.error.code, 'CAPABILITY_RETIRED')
  const collab = await work.createCollaboration(owner, { employeeId: 'agent', skillId: `skill-${cycle}`, goal: 'must not create legacy tree', clientRequestId: 'new-old-tree', items: [{ id: 'old', employeeId: 'agent', skillId: `skill-${read}`, connectionId: 'gear', input: { workOrderId: order } }] })
  assert.equal(collab.error.code, 'CAPABILITY_RETIRED')
  for (const id of ['gear-work', 'correlation-work', 'cycle-child']) {
    await assert.rejects(work.continueWork(owner, id, { clientRequestId: `continue-${id}` }), retiredError)
    await assert.rejects(work.refreshWork(owner, id, { clientRequestId: `refresh-${id}` }), retiredError)
    await assert.rejects(work.followUp(owner, id, '只解释旧事实也会新增模型执行', { clientRequestId: `follow-${id}` }), retiredError)
  }
  await assert.rejects(work.continueCollaboration(owner, 'old-root'), retiredError)
  await assert.rejects(work.recheckCollaboration(owner, 'old-root'), retiredError)
  await assert.rejects(work.updateCollaborationPlan(owner, 'old-root', { expectedRevision: 1, items: [{ id: 'cycle-item', goal: 'new goal' }] }), retiredError)
  await assert.rejects(work.dispatchAutomationWork('gear-work', 'new-execution', now), retiredError)
  const prepared = work.prepareAutomationWork(await store.read(), { id: 'rule', ownerMemberId: owner.id, status: 'active', employeeId: 'agent', skillId: `skill-${read}`, connectionId: 'gear', workOrderId: order }, { occurrenceKey: 'retired-rule' })
  assert.equal(prepared.error.code, 'CAPABILITY_RETIRED')
  assert.deepEqual(await store.read(), baseline, 'denial must not append executions, results, native refs or reservations')

  const direct = createDshRunner({ config: { model: {}, source: {}, dshHome: '/tmp/retired-must-not-create-home' }, harnessFactory() { harnesses += 1; throw new Error('unexpected Harness') } })
  for (const capabilityId of [read, correlation]) await assert.rejects(direct.run({ capabilityId, input: { workOrderId: order } }), retiredError)
  await direct.close()
  const shared = createCollaborationRunner({ store, runProfileImpl: async () => { nativeBoots += 1; throw new Error('unexpected Host') } })
  await assert.rejects(shared.run('old-root'), retiredError)
  await shared.close()
  assert.equal(harnesses, 0)
  assert.equal(nativeBoots, 0)
  assert.equal(modelCalls, 0)

  const automation = createAutomationService({ store, workService: work, connectionCatalog: catalog, clock: () => now, eventSourceId: 'legacy-source' })
  assert.deepEqual(automation.eventSourceCapability(), { status: 'unavailable', code: 'CAPABILITY_RETIRED' })
  const automationBaseline = await store.read()
  await assert.rejects(automation.createRule(owner, {}), retiredError)
  await assert.rejects(automation.updateRule(owner, 'rule', { expectedRevision: 1 }), retiredError)
  await assert.rejects(automation.enableRule(owner, 'draft-rule', { expectedRevision: 1 }), retiredError)
  await assert.rejects(automation.acceptDailyOccurrence({ ruleId: 'rule', scheduledDate: '2026-10-15' }), retiredError)
  await assert.rejects(automation.acceptManualOccurrence(owner, 'rule', { expectedRevision: 1, clientRequestId: 'manual' }), retiredError)
  await assert.rejects(automation.acceptGearJobEvent({}), retiredError)
  assert.deepEqual(await store.read(), automationBaseline)

  const actions = createActionService({ store, connectionCatalog: catalog, clock: () => now,
    adapter: { async dispatch() { sourceCalls += 1 }, async reconcile() { sourceCalls += 1 } },
    readCorrelation: async () => { sourceCalls += 1 },
  })
  await store.update(state => {
    const pending = state.works.find(item => item.id === 'correlation-work').actions[1]
    pending.decision = { kind: 'approved', memberId: owner.id, previewDigest: 'digest', decidedAt: now }
    return state
  })
  const actionBaseline = await store.read()
  await assert.rejects(actions.createPreview(owner, 'correlation-work', { body: 'safe historical comment', clientRequestId: 'new-preview' }), retiredError)
  await assert.rejects(actions.approve(owner, 'correlation-work', 'unknown-action', {}), retiredError)
  await assert.rejects(actions.reconcile(owner, 'correlation-work', 'unknown-action'), retiredError)
  assert.deepEqual(await store.read(), actionBaseline)
  assert.equal(sourceCalls, 0)
  const cancelled = await work.cancel(owner, 'gear-work')
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.accepted, false)
  assert.equal((await automation.pauseRule(owner, 'rule', { expectedRevision: 1 })).status, 'paused')
  assert.equal((await automation.revokeRule(owner, 'rule', { expectedRevision: 2 })).status, 'revoked')
  await actions.revoke(owner, 'correlation-work', 'pending-action', { previewDigest: 'digest' })
  const current = (await store.read()).works.find(item => item.id === 'correlation-work')
  assert.equal(current.actions[1].decision.invalidationReason, 'OWNER_REVOKED')
  assert.deepEqual(current.actions[0], actionBaseline.works.find(item => item.id === current.id).actions[0], 'unknown effect must remain unchanged, without readback or resend')
  await assert.rejects(work.createConfig(admin, 'skills', { id: `skill-${read}`, name: 'retired', capabilityId: read, enabled: true }), retiredError)
  await assert.rejects(work.createConfig(admin, 'connections', { ...gear, id: 'new-legacy' }), retiredError)
  assert.equal(modelCalls + sourceCalls + nativeBoots + harnesses, 0)
  console.log('Retired capability checks passed: all legacy execution/automation/Comment paths fail before new facts, Host/Harness/model/source I/O; old typed history, owner isolation, stop/revoke and unknown effects preserved (injected only)')
} finally { await work.close() }

function connection(id, kind) { return { id, name: id, revision: 1, kind, targetIdentity: kind === 'hive-tenant-records' ? '00000000-0000-4000-8000-000000000001' : 'legacy-a', baseUrl: `http://127.0.0.1:${id === 'gear' ? 42001 : 42002}`, credentialRef: `${id}.json`, allowedObjectIds: [kind === 'gearjob-rest' ? order : 'device-1'], enabled: true, status: 'ready', skillIds: [`skill-${read}`, `skill-${correlation}`], sourceSystem: kind === 'gearjob-rest' ? 'GearJob' : 'Hive', sourceInstance: 'legacy', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'historical' } }
function seed() {
  const base = migrateState({ version: 3 }), member = id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', authRef: id, enabled: true, employeeIds: ['agent'], sessionVersion: 1 })
  const work = (id, capabilityId, extras = {}) => ({ id, ownerMemberId: 'owner', employeeId: 'agent', capabilityId, skillId: `skill-${capabilityId}`, goal: id, status: 'completed', input: capabilityId === cycle ? { availableSeconds: 60, quantity: 1 } : { workOrderId: order }, requiredInputs: [], acceptedAt: now, executions: [], results: [], actions: [], ...extras })
  const target = { system: 'gearjob', sourceInstance: gear.sourceInstance, sourceEnvironment: 'external-test', dataMode: 'synthetic', objectType: 'Work Order', workOrderId: order }
  const preview = { digest: 'digest', resultId: 'correlation-result', target, payload: { body: 'saved historical action' }, expectedRevision: 'old-revision', createdAt: now, expiresAt: '2026-10-15T15:00:00.000Z' }
  const action = id => ({ id, requestKeys: [id], proposalKey: id, intent: { kind: 'gearjob.work-order.comment', targetKey: `gearjob:${gear.targetIdentity}:Work Order:${order}` }, preview, decision: { kind: 'approved', memberId: 'owner', previewDigest: 'digest', decidedAt: now }, attempt: null, receipt: null })
  return { ...base,
    members: [member('owner'), member('admin'), member('other')],
    employees: [{ id: 'agent', name: 'Agent', enabled: true, modelRouteId: 'route', revision: 1, connectionIds: ['gear', 'hive'], skillIds: [read, cycle, correlation].map(id => `skill-${id}`) }],
    modelRoutes: [{ id: 'route', enabled: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY' }],
    skills: [read, cycle, correlation].map(id => ({ id: `skill-${id}`, name: id, capabilityId: id, enabled: true })), connections: [gear, hive],
    works: [
      work('gear-work', read, { connectionId: 'gear', results: [{ id: 'old-typed', kind: 'gearjob.work-order.observation', payload: { historical: 'EXACT_OLD_TYPED_FACT' }, dshSessionRef: 'old-native-ref' }] }),
      work('correlation-work', correlation, { connectionIds: { gearJob: 'gear', hive: 'hive' }, results: [{ id: 'correlation-result', kind: 'manufacturing.work-order-device-correlation', input: { workOrderId: order }, payload: { workOrderId: order, connections: { gearJob: { id: 'gear' } }, gearJob: { sourceRevision: 'old-revision' } } }], actions: [{ ...action('unknown-action'), attempt: { actionId: 'unknown-action', unknownAt: now, unknownReason: 'UPSTREAM_TIMEOUT' } }, { ...action('pending-action'), decision: { kind: 'rejected', memberId: 'owner', previewDigest: 'digest', decidedAt: now } }] }),
      work('old-root', cycle, { workType: 'collaboration', collaboration: { generation: 1, cancelGeneration: 0, status: 'completed', childWorkIds: ['gear-child', 'cycle-child'] }, plan: { revision: 1, items: [{ id: 'gear-item', childWorkId: 'gear-child', status: 'completed' }, { id: 'cycle-item', childWorkId: 'cycle-child', status: 'completed' }] }, handoffs: [] }),
      work('gear-child', read, { workType: 'collaboration-child', rootWorkId: 'old-root', connectionId: 'gear' }),
      work('cycle-child', cycle, { workType: 'collaboration-child', rootWorkId: 'old-root' }),
      work('standalone-cycle', cycle),
    ],
    automationRules: ['rule', 'draft-rule'].map(id => ({ id, ownerMemberId: 'owner', employeeId: 'agent', skillId: `skill-${read}`, connectionId: 'gear', workOrderId: order, status: id === 'rule' ? 'active' : 'draft', revision: 1, trigger: { kind: 'daily-time', time: '09:00', timeZone: 'Asia/Shanghai' }, maxRuns: 2, notificationConversationId: null, effectiveFrom: now, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null })),
  }
}
function memoryStore(value) { let state = structuredClone(value); return { async read() { return structuredClone(state) }, async update(mutator) { state = structuredClone(await mutator(structuredClone(state))); return structuredClone(state) } } }
