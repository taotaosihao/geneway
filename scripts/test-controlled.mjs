import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { createDshRunner, GEARJOB_TOOL, parseRunResult } from '../src/dsh-runner.mjs'
import { assertExecutionGrant, readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'

testToolContract()
await testRunnerFailureClosesHarness()
await testRunnerCancellationIsScoped()
await testSourceAbortMapsToTimeout()
await testFollowUpGrantBlocksBeforeSource()

const root = await mkdtemp(join(tmpdir(), 'geneway-controlled-'))
let service
try {
  const store = createFileStore(join(root, 'state.json'))
  await store.update(state => testBinding(state, 'e', 'c'))
  let reads = 0
  const source = { configured: true, read() { throw new Error('direct source bypass') } }
  const runner = {
    configured: true,
    sourceConfigured: true,
    async run({ operation, workOrderId, sessionId, observation }) {
      reads += operation === 'follow-up' ? 0 : 1
      if (operation === 'follow-up') return { explanation: 'controlled follow-up', dshSessionRef: sessionId, continuity: 'same-session', contextObservationId: observation.observationId }
      await new Promise(resolve => setTimeout(resolve, 25))
      return { observation: { workOrderId, status: 'Draft', plannedQuantity: 1, completedQuantity: 0, unit: 'Nos', sourceRecordId: workOrderId, sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic' }, explanation: 'controlled', dshSessionRef: sessionId ?? 's', continuity: sessionId ? 'same-session' : 'new' }
    },
    async cancel() {},
  }
  service = createWorkService({ store, source, runner })
  const first = await service.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W1', clientRequestId: 'same' })
  const duplicate = await service.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W1', clientRequestId: 'same' })
  assert.equal(duplicate.deduplicated, true)
  await service.cancel(first.value.id)
  assert.equal((await waitFor(service, first.value.id)).status, 'cancelled')
  const second = await service.createWork({ employeeId: 'e', connectionId: 'c', workOrderId: 'W2', clientRequestId: 'second' })
  assert.equal((await waitFor(service, second.value.id)).status, 'completed')
  assert.equal(reads, 2)
  await service.close()
  await store.update(state => ({ ...state, works: [...state.works, { id: 'interrupted', employeeId: 'e', connectionId: 'c', operatorId: state.operator.id, workOrderId: 'W3', status: 'running', observations: [], executions: [{ id: 'exec-interrupted', operation: 'create', status: 'running' }], followUps: [] }] }))
  const restarted = createWorkService({ store, source, runner })
  const boot = await restarted.bootstrap()
  assert.equal(boot.works.find(item => item.id === 'interrupted').status, 'interrupted')
  await restarted.close()
  console.log('controlled checks passed')
} finally {
  await service?.close()
  await rm(root, { recursive: true, force: true })
}

async function waitFor(service, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const work = (await service.getWork(id)).value
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(work.status)) return work
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for controlled work')
}

function testToolContract() {
  const observation = { workOrderId: 'W1', status: 'Draft', plannedQuantity: 1, completedQuantity: 0, unit: 'Nos', sourceRecordId: 'Work Order:W1', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic' }
  const call = { type: 'tool/call', data: { callId: 'call-1', name: GEARJOB_TOOL, arguments: JSON.stringify({ workOrderId: 'W1' }) } }
  const result = { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true, ...observation }) }] }] } } }
  assert.deepEqual(parseRunResult({ events: [call, result], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }).observation, observation)
  assert.throws(() => parseRunResult({ events: [call], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /恰好有一次/)
  assert.throws(() => parseRunResult({ events: [result], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /恰好有一次/)
  assert.throws(() => parseRunResult({ events: [call, call, result], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /恰好有一次/)
  assert.throws(() => parseRunResult({ events: [call, { ...result, data: { ...result.data, message: { ...result.data.message, content: [{ ...result.data.message.content[0], isError: true }] } } }], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /结构/)
  const notFound = { ...result, data: { message: { ...result.data.message, content: [{ ...result.data.message.content[0], content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'GearJob 中不存在该工单' } }) }] }] } } }
  assert.throws(() => parseRunResult({ events: [call, notFound], finalResponse: 'ignored' }, { operation: 'create', workOrderId: 'W1' }), error => error.code === 'NOT_FOUND' && /不存在/.test(error.message))
  assert.throws(() => parseRunResult({ events: [call, result], finalResponse: 'ok' }, { operation: 'follow-up', workOrderId: 'W1' }), /禁止调用工具/)
  assert.throws(() => parseRunResult({ events: [{ ...call, data: { ...call.data, callId: undefined } }, { ...result, data: { message: { ...result.data.message, source: { kind: 'tool', callId: undefined }, content: [{ ...result.data.message.content[0], toolCallId: undefined }] } } }], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /callId/)
  assert.throws(() => parseRunResult({ events: [call, { ...result, data: { message: { ...result.data.message, source: { kind: 'tool', callId: 'wrong' } } } }], finalResponse: 'ok' }, { operation: 'create', workOrderId: 'W1' }), /缺失或标记为错误/)
  assert.throws(() => parseRunResult({ events: [], finalResponse: '   ' }, { operation: 'follow-up', workOrderId: 'W1' }), /没有模型说明/)
}

async function testRunnerFailureClosesHarness() {
  let closes = 0
  const runner = createDshRunner({
    config: {
      model: { configured: true, provider: 'test', model: 'test' },
      source: { configured: true },
      dshHome: '/tmp/geneway-controlled-dsh',
    },
    harnessFactory: () => ({
      async run() { throw new Error('model failed') },
      async close() { closes += 1 },
    }),
  })
  await assert.rejects(() => runner.run({ executionId: 'failed-run', workOrderId: 'W1' }), /model failed/)
  assert.equal(closes, 1)
  await runner.close()
}

async function testRunnerCancellationIsScoped() {
  const harnesses = []
  const runner = createDshRunner({
    config: {
      model: { configured: true, provider: 'test', model: 'test' },
      source: { configured: true },
      dshHome: '/tmp/geneway-controlled-dsh',
    },
    harnessFactory: () => {
      let rejectRun
      const harness = {
        closes: 0,
        run: () => new Promise((_resolve, reject) => { rejectRun = reject }),
        async close() { this.closes += 1; rejectRun?.(Object.assign(new Error('closed'), { name: 'AbortError' })) },
      }
      harnesses.push(harness)
      return harness
    },
  })
  const first = runner.run({ executionId: 'cancel-first', workOrderId: 'W1' })
  const second = runner.run({ executionId: 'keep-second', workOrderId: 'W2' })
  void first.catch(() => undefined)
  void second.catch(() => undefined)
  assert.equal(await runner.cancel('cancel-first'), true)
  for (let attempt = 0; harnesses.length === 0 && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(harnesses.length, 1)
  assert.equal(harnesses[0].closes, 0)
  assert.equal(await runner.cancel('keep-second'), true)
  await Promise.allSettled([first, second])
  assert.equal(harnesses[0].closes, 1)
  await runner.close()
}

async function testSourceAbortMapsToTimeout() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-source-timeout-'))
  try {
    const credentialFile = join(root, 'credential.json')
    await writeFile(credentialFile, JSON.stringify({ apiKey: 'test', apiSecret: 'test' }), { mode: 0o600 })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => readGearJobWorkOrder({
      workOrderId: 'W1',
      signal: controller.signal,
      config: { source: { configured: true, baseUrl: 'http://127.0.0.1:1', credentialFile, allowedWorkOrders: ['W1'] } },
    }), error => error.code === 'UPSTREAM_TIMEOUT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testFollowUpGrantBlocksBeforeSource() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-follow-up-grant-'))
  try {
    const grant = join(root, 'grant.json')
    await writeFile(grant, JSON.stringify({ operation: 'follow-up', workOrderId: 'W1', allowRead: false }), { mode: 0o600 })
    await assert.rejects(() => assertExecutionGrant('W1', grant), error => error.code === 'FORBIDDEN' && /不允许查询/.test(error.message))
    await writeFile(grant, JSON.stringify({ operation: 'refresh', workOrderId: 'W1', allowRead: true }), { mode: 0o600 })
    await assertExecutionGrant('W1', grant)
    await assert.rejects(() => assertExecutionGrant('W1', grant), error => error.code === 'FORBIDDEN' && /授权不可用/.test(error.message))
    await writeFile(grant, JSON.stringify({ operation: 'refresh', workOrderId: 'W1', allowRead: true }), { mode: 0o600 })
    await assert.rejects(() => assertExecutionGrant('', grant), error => error.code === 'INVALID_REQUEST')
    await assert.rejects(() => assertExecutionGrant('W1', grant), error => error.code === 'FORBIDDEN' && /授权不可用/.test(error.message))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function testBinding(state, employeeId, connectionId) {
  const skillId = 'skill-gearjob-work-order-read'
  return { ...state, skills: [{ id: skillId, name: 'read', action: 'gearjob.work-order.read', toolName: GEARJOB_TOOL, enabled: true }], employees: [{ id: employeeId, enabled: true, connectionIds: [connectionId], skillIds: [skillId] }], connections: [{ id: connectionId, enabled: true, status: 'ready', skillIds: [skillId] }] }
}
