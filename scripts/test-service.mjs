import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-service-'))
let service
try {
  const store = createFileStore(join(root, 'state.json'))
  await store.update(state => ({
    ...state,
    employees: [{ id: 'employee-1', name: '测试员工', enabled: true, connectionIds: ['connection-1'] }],
    connections: [{ id: 'connection-1', name: '测试只读连接', kind: 'controlled', status: 'ready', enabled: true }],
  }))
  let directReads = 0
  const calls = []
  service = createWorkService({
    store,
    source: { configured: true, read() { directReads += 1; throw new Error('direct source bypass') } },
    runner: {
      configured: true,
      sourceConfigured: true,
      async run(args) {
        calls.push(args)
        if (args.operation === 'follow-up') return { explanation: '追问说明', dshSessionRef: args.sessionId, continuity: 'same-session', contextObservationId: args.observation.observationId }
        return { observation: { workOrderId: 'WO-1', status: 'running', plannedQuantity: 10, completedQuantity: calls.filter(item => item.operation !== 'follow-up').length, unit: '件', sourceRecordId: 'source-' + calls.length, sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic' }, explanation: '基于工具事实的测试说明', dshSessionRef: args.sessionId ?? 'session-test', continuity: args.sessionId ? 'same-session' : 'new' }
      },
      async cancel() {},
    },
  })
  const first = await service.createWork({ employeeId: 'employee-1', connectionId: 'connection-1', workOrderId: 'WO-1', clientRequestId: 'request-1' })
  assert.equal(first.ok, true)
  const duplicate = await service.createWork({ employeeId: 'employee-1', connectionId: 'connection-1', workOrderId: 'WO-1', clientRequestId: 'request-1' })
  assert.equal(duplicate.deduplicated, true)
  await waitFor(service, first.value.id, work => work.status === 'completed')
  assert.equal(directReads, 0)
  assert.equal(calls[0].operation, 'create')
  const refreshed = await service.refreshWork(first.value.id, { clientRequestId: 'refresh-1' })
  assert.equal(refreshed.ok, true)
  await waitFor(service, first.value.id, work => work.observations.length === 2)
  assert.equal(directReads, 0)
  assert.equal(calls[1].operation, 'refresh')
  assert.equal(calls[1].sessionId, 'session-test')
  const followed = await service.followUp(first.value.id, '补充现场信息', { clientRequestId: 'follow-1' })
  assert.equal(followed.ok, true)
  await waitFor(service, first.value.id, work => work.followUps.length === 1)
  const persisted = await service.getWork(first.value.id)
  assert.equal(persisted.value.observations[0].sourceRecordId, 'source-1')
  assert.equal(persisted.value.followUps[0].text, '补充现场信息')
  assert.equal(calls.at(-1).operation, 'follow-up')
  assert.equal(calls.at(-1).sessionId, 'session-test')

  await store.update(state => ({ ...state, connections: state.connections.map(item => ({ ...item, status: 'offline' })) }))
  const blocked = await service.refreshWork(first.value.id, { clientRequestId: 'refresh-offline' })
  assert.equal(blocked.error.code, 'FORBIDDEN')
  await store.update(state => ({ ...state, connections: state.connections.map(item => ({ ...item, status: 'ready' })) }))

  const scopedStore = createFileStore(join(root, 'scoped-state.json'))
  await scopedStore.update(state => ({ ...state, employees: [{ id: 'e', enabled: true, connectionIds: ['c'] }], connections: [{ id: 'c', enabled: true, status: 'ready' }] }))
  let scopedRuns = 0
  const scoped = createWorkService({ store: scopedStore, source: { configured: true, allows: id => id === 'ALLOWED' }, runner: { configured: true, sourceConfigured: true, async run() { scopedRuns += 1; throw new Error('must not run') } } })
  const denied = await scoped.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'DENIED', clientRequestId: 'denied' })
  assert.equal(denied.error.code, 'FORBIDDEN')
  assert.equal(scopedRuns, 0)
  await scoped.close()

  const concurrentStore = createFileStore(join(root, 'concurrent-state.json'))
  await concurrentStore.update(state => ({ ...state, employees: [{ id: 'e', enabled: true, connectionIds: ['c'] }], connections: [{ id: 'c', enabled: true, status: 'ready' }] }))
  let concurrentRuns = 0
  const concurrent = createWorkService({
    store: concurrentStore,
    source: { configured: true, allows: () => true },
    runner: {
      configured: true,
      sourceConfigured: true,
      async run({ workOrderId }) {
        concurrentRuns += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return { observation: { workOrderId, status: 'Draft', plannedQuantity: 1, completedQuantity: 0, unit: 'Nos', sourceRecordId: `Work Order:${workOrderId}`, sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic' }, explanation: 'ok', dshSessionRef: 's', continuity: 'new' }
      },
    },
  })
  const [concurrentA, concurrentB] = await Promise.all([
    concurrent.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W', clientRequestId: 'same-concurrent' }),
    concurrent.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W', clientRequestId: 'same-concurrent' }),
  ])
  assert.equal(concurrentA.value.id, concurrentB.value.id)
  await waitFor(concurrent, concurrentA.value.id, work => work.status === 'completed')
  assert.equal(concurrentRuns, 1)
  await concurrent.close()

  const failureStore = createFileStore(join(root, 'failure-state.json'))
  await failureStore.update(state => ({ ...state, employees: [{ id: 'e', enabled: true, connectionIds: ['c'] }], connections: [{ id: 'c', enabled: true, status: 'ready' }] }))
  const failureService = createWorkService({ store: failureStore, source: { configured: true, allows: () => true }, runner: { configured: true, sourceConfigured: true, async run() { throw Object.assign(new Error('模型调用失败'), { code: 'MODEL_FAILURE' }) } } })
  const failed = await failureService.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W', clientRequestId: 'model-failure' })
  const failedWork = await waitFor(failureService, failed.value.id, work => work.status === 'failed')
  assert.equal(failedWork.executions.at(-1).error.code, 'MODEL_FAILURE')
  await failureService.close()

  await service.close()
  const successorCalls = []
  const successor = createWorkService({
    store,
    source: { configured: true },
    runner: {
      configured: true,
      sourceConfigured: true,
      async run(args) {
        successorCalls.push(args)
        return { explanation: 'successor 说明', dshSessionRef: 'session-successor', continuedFromDshSessionRef: args.sessionId, contextObservationId: args.observation.observationId, continuity: 'successor' }
      },
    },
  })
  const successorFollow = await successor.followUp(first.value.id, '恢复后的追问', { clientRequestId: 'follow-successor' })
  assert.equal(successorFollow.ok, true)
  const recovered = await waitFor(successor, first.value.id, work => work.followUps.length === 2)
  assert.equal(successorCalls[0].sessionId, 'session-test')
  assert.equal(recovered.followUps.at(-1).continuity, 'successor')
  assert.equal(recovered.followUps.at(-1).continuedFromDshSessionRef, 'session-test')
  await successor.close()
  console.log('service checks passed')
} finally {
  await service?.close()
  await rm(root, { recursive: true, force: true })
}

async function waitFor(service, id, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await service.getWork(id)
    if (result.ok && predicate(result.value)) return result.value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for work')
}
