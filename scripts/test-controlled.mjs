import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTION_TARGET_FIELDS } from '../src/connection-catalog.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-p2-controlled-service-'))
const stateFile = join(root, 'state.json')
const store = createFileStore(stateFile)
const pending = new Map()
const calls = []
const runner = {
  configured: true,
  run(args) {
    calls.push(structuredClone(args))
    return new Promise((resolve, reject) => pending.set(args.executionId, { resolve, reject }))
  },
  async cancel(executionId) {
    return pending.has(executionId)
  },
  async close() {},
}

try {
  await store.update(seed)
  const connectionCatalog = (await store.read()).connections.map(connection => Object.fromEntries(CONNECTION_TARGET_FIELDS.map(key => [key, connection[key]])))
  const service = createWorkService({ store, runner, connectionCatalog, policyPaths: { stateFile, dataRoot: root, secretRoot: join(root, 'secrets') } })
  const actor = { id: 'member-user' }
  const first = await service.createWork(actor, request('W1', 'w1'))
  const second = await service.createWork(actor, request('W2', 'w2'))
  await waitUntil(() => pending.size === 2)
  const firstExecution = first.value.executions[0].id
  const secondExecution = second.value.executions[0].id
  assert.notEqual(firstExecution, secondExecution)
  assert.deepEqual(new Set(calls.map(item => item.sessionMetadata.workId)), new Set([first.value.id, second.value.id]))
  assert.ok(calls.every(item => item.sessionMetadata.ownerMemberId === actor.id))
  assert.ok(calls.every(item => item.grant.connection.id === 'connection-a'))
  assert.ok(calls.every(item => item.grant.policyFile === stateFile))

  await service.cancel(actor, first.value.id)
  pending.get(firstExecution).resolve(resultFor('W1', calls.find(item => item.executionId === firstExecution)))
  pending.delete(firstExecution)
  pending.get(secondExecution).resolve(resultFor('W2', calls.find(item => item.executionId === secondExecution)))
  pending.delete(secondExecution)
  const cancelled = await waitFor(service, actor, first.value.id, work => work.status === 'cancelled')
  const completed = await waitFor(service, actor, second.value.id, work => work.status === 'completed')
  assert.equal(cancelled.results.length, 0)
  assert.equal(completed.results.length, 1)
  assert.equal(completed.results[0].payload.workOrderId, 'W2')
  assert.equal(completed.executions[0].resultObservationId, completed.results[0].id)

  const duplicate = await service.createWork(actor, request('W2', 'w2'))
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.value.id, second.value.id)
  assert.equal(calls.length, 2)

  await service.close()
  console.log('controlled checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

function request(workOrderId, clientRequestId) {
  return { employeeId: 'employee-user', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-a', input: { workOrderId }, clientRequestId }
}

function resultFor(workOrderId, call) {
  const payload = { workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', sourceRecordId: `Work Order:${workOrderId}`, sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' }
  return { result: { kind: 'gearjob.work-order.observation', payload, source: { sourceRecordId: payload.sourceRecordId, sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' }, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }, explanation: 'W2 完成', dshSessionRef: 'session-w2', continuity: 'new', contextConfirmationRefs: call.sessionMetadata.confirmationRefs, eventCount: 3 }
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for dispatch')
}

async function waitFor(service, actor, id, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const work = await service.getWork(actor, id)
    if (work.ok && predicate(work.value)) return work.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for work')
}

function seed(state) {
  const now = '2026-09-19T00:00:00.000Z'
  return {
    ...state,
    members: [{ id: 'member-user', loginName: 'member', displayName: '成员', role: 'member', enabled: true, authRef: 'member-user', sessionVersion: 1, employeeIds: ['employee-user'], createdAt: now, updatedAt: now }],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }],
    employees: [{ id: 'employee-user', name: '员工', enabled: true, modelRouteId: 'model-zenmux', connectionIds: ['connection-a'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-a', name: 'A', kind: 'gearjob-rest', targetIdentity: 'A', baseUrl: 'http://127.0.0.1:8100', credentialRef: 'a.json', allowedObjectIds: ['W1', 'W2'], sourceSystem: 'GearJob', sourceInstance: 'A', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
  }
}
