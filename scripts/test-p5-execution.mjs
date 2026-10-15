import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createAutomationRuntime, createAutomationService, dailyOccurrenceKey } from '../src/automation-service.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { authorizeExecutionRequestFile, connectionSnapshot } from '../src/execution-grant.mjs'
import { migrateState, createFileStore } from '../src/store/file-store.mjs'
import { createExecutionRequestGuard } from '../plugins/execution-request-guard.mjs'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'
import { createGearJobEventReceiver, GEARJOB_EVENT_PATH, readGearJobEventRuntimeConfig } from '../plugins/gearjob-events.mjs'

const now = '2026-09-21T00:00:00.000Z'
const catalog = [{ kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test' }]

await atomicAndAdmissionChecks()
await manualAdmissionChecks()
await eventAdmissionChecks()
await eventReceiverReplayChecks()
await concurrencyAndCapacityChecks()
await ownerLossBeforeDispatchChecks()
await ownerLossAfterRunnerStartChecks()
await ownerLossBeforeResultCommitChecks()
await liveEventCapabilityLossChecks()
await requestGuardChecks()
await actualProfileGuardChecks()
await deadlineAndCancellationChecks()
await closeTeardownChecks()
await gearJobTimeoutChecks()
await gearJobEventConfigChecks()
await gearJobEventReceiverChecks()
console.log('P5 execution checks passed; external effects=0; real GearJob/ZenMux=not called')

async function manualAdmissionChecks() {
  const harness = await admissionHarness({ maxRuns: 3, rules: ['rule-a'] })
  try {
    const input = { expectedRevision: 1, clientRequestId: 'manual-1' }
    const first = await harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', input)
    const replay = await harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', input)
    assert.equal(first.accepted, true); assert.equal(replay.deduplicated, true); assert.equal(replay.workId, first.workId)
    let state = await harness.store.read(), occurrence = state.automationOccurrences[0]
    assert.equal(occurrence.scheduledDate, null); assert.equal(occurrence.occurrenceKey, 'rule-a:manual:manual-1')
    const overlap = await harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'manual-2' })
    assert.equal(overlap.reason, 'overlap')
    await assert.rejects(harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 2, clientRequestId: 'manual-stale' }), error => error.code === 'REVISION_CONFLICT')
    await assert.rejects(harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'bad:value' }), error => error.code === 'INVALID_REQUEST')
    await harness.store.update(value => ({ ...value, works: value.works.map(work => ({ ...work, status: 'completed', executions: work.executions.map(execution => ({ ...execution, status: 'completed' })) })) }))
    const daily = await harness.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' })
    assert.equal(daily.accepted, true, 'manual identity must not consume the daily date identity')
    state = await harness.store.read()
    assert.equal(state.automationOccurrences.some(item => item.occurrenceKey === 'rule-a:2026-09-21'), true)
    await harness.store.update(value => ({ ...value, automationRules: value.automationRules.map(rule => ({ ...rule, status: 'paused' })) }))
    await assert.rejects(harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'manual-paused' }), error => error.code === 'INVALID_STATE')
  } finally { await harness.close() }

  const budget = await admissionHarness({ maxRuns: 1, rules: ['rule-a'] })
  try {
    await budget.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'budget-1' })
    await budget.store.update(value => ({ ...value, works: value.works.map(work => ({ ...work, status: 'completed', executions: work.executions.map(execution => ({ ...execution, status: 'completed' })) })) }))
    const exhausted = await budget.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'budget-2' })
    assert.equal(exhausted.reason, 'budget')
  } finally { await budget.close() }

  const capacity = await admissionHarness({ rules: ['rule-a', 'rule-b', 'rule-c'] })
  try {
    const outcomes = await Promise.all(['rule-a', 'rule-b', 'rule-c'].map((ruleId, index) => capacity.automation.acceptManualOccurrence({ id: 'member-owner' }, ruleId, { expectedRevision: 1, clientRequestId: `capacity-${index}` })))
    assert.equal(outcomes.filter(item => item.accepted).length, 2); assert.equal(outcomes.find(item => item.reason)?.reason, 'capacity')
  } finally { await capacity.close() }
}

async function eventAdmissionChecks() {
  const harness = await admissionHarness({ maxRuns: 3, rules: ['rule-a'] })
  try {
    await harness.store.update(state => ({ ...state, automationRules: state.automationRules.map(rule => rule.id === 'rule-a' ? { ...rule, trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' }, effectiveFrom: null, eventAcceptAfter: '2026-09-21T00:00:00.000Z' } : rule) }))
    const input = { sourceId: 'gearjob:dev.localhost', workOrderId: 'WO-1', sourceRevision: '2026-09-21 08:01:02.123456', digest: 'a'.repeat(64) }
    const first = await harness.automation.acceptGearJobEvent(input)
    const replay = await harness.automation.acceptGearJobEvent(input)
    assert.equal(first.accepted, 1)
    assert.equal(replay.outcomes[0].deduplicated, true)
    let state = await harness.store.read()
    assert.equal(state.automationOccurrences[0].scheduledDate, null)
    assert.deepEqual(state.automationOccurrences[0].event, { sourceId: input.sourceId, sourceRevision: input.sourceRevision, digest: input.digest })
    assert.equal(Object.hasOwn(state.automationOccurrences[0].event, 'sourceTime'), false)
    assert.match(state.automationOccurrences[0].occurrenceKey, /^rule-a:event:[a-f0-9]{64}$/)
    assert.equal(state.works.length, 1)
    await assert.rejects(harness.automation.acceptGearJobEvent({ ...input, digest: 'b'.repeat(64) }), error => error.code === 'CONFLICT')
    await harness.store.update(value => ({ ...value, works: value.works.map(work => ({ ...work, status: 'completed', executions: work.executions.map(execution => ({ ...execution, status: 'completed' })) })) }))
    const stale = await harness.automation.acceptGearJobEvent({ ...input, sourceRevision: '2026-09-20 07:59:59.000001', digest: 'c'.repeat(64) })
    assert.equal(stale.accepted, 0)
    assert.equal(stale.outcomes[0].reason, 'before-active-window')
    assert.equal((await harness.store.read()).works.length, 1)
    const unverifiable = await harness.automation.acceptGearJobEvent({ ...input, sourceRevision: '2026-09-31 08:02:02.000001', digest: 'd'.repeat(64) })
    assert.equal(unverifiable.outcomes[0].reason, 'source-time-unverifiable')
    await assert.rejects(harness.automation.acceptGearJobEvent({ ...input, sourceId: 'gearjob:other', sourceRevision: '2026-09-21 08:02:02.000001', digest: 'e'.repeat(64) }), error => error.code === 'SOURCE_NOT_CONFIGURED')
    state = await harness.store.read()
    assert.equal(state.automationOccurrences.length, 3)
  } finally { await harness.close() }
}

async function gearJobEventReceiverChecks() {
  const secret = Buffer.from('receiver-secret')
  const port = await freePort()
  const calls = []
  let failure
  const receiver = createGearJobEventReceiver({
    secret,
    sourceId: 'gearjob:dev.localhost',
    expectedSourceAddress: '127.0.0.1',
    host: '127.0.0.1',
    port,
    automationRuntime: { async acceptGearJobEvent(input) { calls.push(input); if (failure) throw failure; return { matched: 1, accepted: 1 } } },
  })
  await receiver.start()
  try {
    const duplicate = createGearJobEventReceiver({ secret, sourceId: 'gearjob:dev.localhost', expectedSourceAddress: '127.0.0.1', host: '127.0.0.1', port, automationRuntime: { async acceptGearJobEvent() { return { matched: 0, accepted: 0 } } } })
    await assert.rejects(duplicate.start(), error => error.code === 'EADDRINUSE')
    await duplicate.close()
    const body = JSON.stringify({ source: 'gearjob:dev.localhost', event: 'on_update', doctype: 'Work Order', name: 'WO-1', modified: '2026-09-21 08:01:02.123456' })
    const signature = createHmac('sha256', secret).update(body).digest('base64')
    const accepted = await fetch(`http://127.0.0.1:${port}/p5/gearjob/work-order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': signature }, body })
    assert.equal(accepted.status, 202)
    assert.deepEqual(calls.map(item => ({ sourceId: item.sourceId, workOrderId: item.workOrderId, sourceRevision: item.sourceRevision })), [{ sourceId: 'gearjob:dev.localhost', workOrderId: 'WO-1', sourceRevision: '2026-09-21 08:01:02.123456' }])
    const rejected = await fetch(`http://127.0.0.1:${port}/p5/gearjob/work-order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': 'bad' }, body })
    assert.equal(rejected.status, 401)
    assert.equal(calls.length, 1)
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': signature }, body })).status, 404)
    failure = Object.assign(new Error('conflict'), { code: 'CONFLICT' })
    assert.equal((await fetch(`http://127.0.0.1:${port}/p5/gearjob/work-order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': signature }, body })).status, 409)
    failure = new Error('store failed')
    assert.equal((await fetch(`http://127.0.0.1:${port}/p5/gearjob/work-order`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': signature }, body })).status, 503)
  } finally { await receiver.close() }
  await assert.rejects(fetch(`http://127.0.0.1:${port}${GEARJOB_EVENT_PATH}`))
}

async function eventReceiverReplayChecks() {
  const harness = await admissionHarness({ maxRuns: 3, rules: ['rule-a'] })
  const secret = Buffer.from('replay-secret'), port = await freePort()
  const receiver = createGearJobEventReceiver({ secret, sourceId: 'gearjob:dev.localhost', expectedSourceAddress: '127.0.0.1', host: '127.0.0.1', port, automationRuntime: { acceptGearJobEvent: input => harness.automation.acceptGearJobEvent(input) } })
  try {
    await harness.store.update(state => ({ ...state, automationRules: state.automationRules.map(rule => rule.id === 'rule-a' ? { ...rule, trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' }, effectiveFrom: null, eventAcceptAfter: now } : rule) }))
    await receiver.start()
    const body = JSON.stringify({ source: 'gearjob:dev.localhost', event: 'on_update', doctype: 'Work Order', name: 'WO-1', modified: '2026-09-21 08:00:00.000001' })
    const signature = createHmac('sha256', secret).update(body).digest('base64'), options = { method: 'POST', headers: { 'content-type': 'application/json', 'x-frappe-webhook-signature': signature }, body }
    assert.equal((await fetch(`http://127.0.0.1:${port}${GEARJOB_EVENT_PATH}`, options)).status, 202)
    assert.equal((await fetch(`http://127.0.0.1:${port}${GEARJOB_EVENT_PATH}`, options)).status, 200)
    const state = await harness.store.read()
    assert.equal(state.automationOccurrences.length, 1); assert.equal(state.works.length, 1)
  } finally { await receiver.close(); await harness.close() }
}

async function gearJobEventConfigChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-event-config-'))
  const repo = join(root, 'repo'), secretPath = join(root, 'event-secret')
  try {
    await writeFile(secretPath, 'secret', { mode: 0o600 })
    assert.equal(await readGearJobEventRuntimeConfig({}, repo), null)
    await assert.rejects(readGearJobEventRuntimeConfig({ GENEWAY_GEARJOB_EVENT_PATH: '/other' }, repo), /不允许环境覆盖/)
    await assert.rejects(readGearJobEventRuntimeConfig({ GENEWAY_GEARJOB_EVENT_SECRET_FILE: secretPath }, repo), /全有或全无/)
    const env = { GENEWAY_GEARJOB_EVENT_SECRET_FILE: secretPath, GENEWAY_GEARJOB_EVENT_SOURCE_ID: 'gearjob:dev.localhost', GENEWAY_GEARJOB_EVENT_SOURCE_ADDRESS: '172.20.0.5', GENEWAY_GEARJOB_EVENT_HOST: '172.20.0.1', GENEWAY_GEARJOB_EVENT_PORT: '39471' }
    const config = await readGearJobEventRuntimeConfig(env, repo)
    assert.deepEqual({ ...config, secret: config.secret.toString() }, { secret: 'secret', sourceId: 'gearjob:dev.localhost', expectedSourceAddress: '172.20.0.5', host: '172.20.0.1', port: 39471 })
    await assert.rejects(readGearJobEventRuntimeConfig({ ...env, GENEWAY_GEARJOB_EVENT_HOST: '0.0.0.0' }, repo), /wildcard/)
    assert.equal(GEARJOB_EVENT_PATH, '/p5/gearjob/work-order')
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function atomicAndAdmissionChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-execution-'))
  try {
    const statePath = join(root, 'state.json')
    const initial = fixture({ maxRuns: 3, rules: ['rule-a', 'rule-b', 'rule-c'] })
    await writeFile(statePath, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 })
    const store = createFileStore(statePath)
    const calls = []
    let sequence = 0
    const workService = {
      async ensureReady() { calls.push('ready') },
      prepareAutomationWork(state, rule, options) {
        calls.push('prepare')
        const workId = options.workId, executionId = options.executionId
        return { ok: true, workId, executionId, acceptedAt: options.acceptedAt, work: {
          id: workId, ownerMemberId: rule.ownerMemberId, employeeId: rule.employeeId, skillId: rule.skillId,
          capabilityId: 'gearjob-work-order-read', connectionId: rule.connectionId, goal: 'gearjob.work-order.read',
          input: { workOrderId: rule.workOrderId }, requiredInputs: [], status: 'accepted', acceptedAt: options.acceptedAt,
          results: [], actions: [], executions: [{ id: executionId, operation: 'automation', clientRequestId: options.occurrenceKey, input: { workOrderId: rule.workOrderId }, status: 'accepted', acceptedAt: options.acceptedAt }],
        } }
      },
      async dispatchAutomationWork(workId, executionId) { calls.push(`dispatch:${workId}:${executionId}`) },
    }
    const serviceA = createAutomationService({ store, workService, clock: () => now, idFactory: () => `a-${++sequence}`, connectionCatalog: catalog })
    const serviceB = createAutomationService({ store, workService, clock: () => now, idFactory: () => `b-${++sequence}`, connectionCatalog: catalog })
    const [first, second] = await Promise.all([
      serviceA.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' }),
      serviceB.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' }),
    ])
    assert.equal([first, second].filter(value => value.accepted).length, 2, 'dedup result should retain accepted fact')
    assert.equal((await store.read()).works.length, 1)
    assert.equal((await store.read()).automationOccurrences.length, 1)
    assert.equal(first.occurrence.workId, second.occurrence.workId)
    assert.deepEqual(calls.slice(0, 2), ['ready', 'ready'])

    const stateAfter = await store.read()
    const ruleA = stateAfter.automationRules.find(rule => rule.id === 'rule-a')
    await store.update(state => ({ ...state, works: state.works.map(work => ({ ...work, status: 'completed', executions: work.executions.map(execution => ({ ...execution, status: 'completed' })) })) }))
    const admitted = await serviceA.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-22' })
    assert.equal(admitted.accepted, true)
    assert.equal((await store.read()).automationOccurrences.filter(item => item.ruleId === ruleA.id && item.workId).length, 2)

    const overlap = await serviceA.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-23' })
    assert.equal(overlap.reason, 'overlap')
    const inactive = await store.update(state => ({ ...state, automationRules: state.automationRules.map(rule => rule.id === 'rule-c' ? { ...rule, status: 'paused' } : rule) }))
    assert.ok(inactive)
    const blocked = await serviceA.acceptDailyOccurrence({ ruleId: 'rule-c', scheduledDate: '2026-09-21' })
    assert.equal(blocked.reason, 'rule-inactive')
    assert.equal(blocked.occurrence.workId, null)

    await store.update(state => ({ ...state,
      automationRules: state.automationRules.map(rule => rule.id === 'rule-a' ? { ...rule, maxRuns: 2 } : rule),
      works: state.works.map(work => ({ ...work, status: 'completed', executions: work.executions.map(execution => ({ ...execution, status: 'completed' })) })),
    }))
    const budget = await serviceA.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-24' })
    assert.equal(budget.reason, 'budget')
    assert.equal(budget.occurrence.workId, null)

    const snapshot = await store.read()
    assert.equal(snapshot.works.filter(work => work.id === first.workId).length, 1)
    assert.equal(snapshot.works.find(work => work.id === first.workId).executions.length, 1)
    assert.equal(snapshot.automationOccurrences.some(item => item.workId === first.workId), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function ownerLossBeforeDispatchChecks() {
  let state = fixture({ rules: ['rule-a'] })
  let dispatches = 0, checks = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const workService = {
    async ensureReady() {},
    prepareAutomationWork(_state, rule, options) { return { ok: true, workId: options.workId, executionId: options.executionId, acceptedAt: options.acceptedAt, work: { id: options.workId, ownerMemberId: rule.ownerMemberId, employeeId: rule.employeeId, skillId: rule.skillId, capabilityId: 'gearjob-work-order-read', connectionId: rule.connectionId, input: { workOrderId: rule.workOrderId }, status: 'accepted', acceptedAt: options.acceptedAt, results: [], actions: [], executions: [{ id: options.executionId, operation: 'automation', status: 'accepted' }] } } },
    async dispatchAutomationWork() { dispatches += 1 },
  }
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'owner-loss' })
  await assert.rejects(automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'owner-before', ownerCheck: () => false }), error => error.code === 'OWNER_LOCK_LOST')
  assert.equal(state.automationOccurrences.length, 0)
  checks = 0
  const manual = await automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1, clientRequestId: 'owner-after', ownerCheck: () => ++checks < 3 })
  assert.equal(manual.dispatchError.code, 'OWNER_LOCK_LOST'); assert.equal(dispatches, 0); assert.equal(state.automationOccurrences[0].workId, manual.workId)
  state = fixture({ rules: ['rule-a'] }); checks = 0
  const result = await automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21', ownerCheck: () => ++checks < 3 })
  assert.equal(result.dispatchError.code, 'OWNER_LOCK_LOST')
  assert.equal(dispatches, 0)
  assert.equal(state.automationOccurrences[0].workId, result.workId, 'atomic acceptance remains for next-owner recovery')

  let owned = true, runnerCalls = 0, markedRunning = false
  state = fixture({ rules: ['rule-a'] })
  const racingStore = {
    async read() { return structuredClone(state) },
    async update(mutator) {
      state = migrateState(await mutator(structuredClone(state)))
      if (!markedRunning && state.works.some(work => work.executions.some(execution => execution.status === 'running'))) {
        markedRunning = true
        owned = false
      }
      return structuredClone(state)
    },
  }
  const guardedWork = createWorkService({ store: racingStore, runner: { configured: true, async run() { runnerCalls += 1; return validModel() } }, clock: () => now, connectionCatalog: catalog })
  const guardedAutomation = createAutomationService({ store: racingStore, workService: guardedWork, clock: () => now, idFactory: () => 'owner-race', connectionCatalog: catalog })
  const raced = await guardedAutomation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21', ownerCheck: () => owned })
  await waitFor(() => markedRunning)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(raced.accepted, true)
  assert.equal(runnerCalls, 0, 'owner loss after markRunning must stop before model I/O')
  assert.equal(state.works[0].status, 'running', 'next owner recovers the accepted work without former-owner writes')
  await guardedWork.close()
}

async function ownerLossAfterRunnerStartChecks() {
  let state = fixture({ rules: ['rule-a'] }), rejectRun, runnerCalls = 0, cancelCalls = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const runner = {
    configured: true,
    async run() { runnerCalls += 1; return new Promise((_resolve, reject) => { rejectRun = reject }) },
    async cancel() { cancelCalls += 1; rejectRun?.(Object.assign(new Error('owner lost'), { code: 'OWNER_LOCK_LOST' })); throw new Error('cancel cleanup failed') },
  }
  const workService = createWorkService({ store, runner, clock: () => now, connectionCatalog: catalog })
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'owner-running', connectionCatalog: catalog })
  const accepted = await automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21', ownerCheck: () => true })
  await waitFor(() => runnerCalls === 1)
  await workService.automationOwnerLost()
  assert.equal(accepted.accepted, true)
  assert.equal(cancelCalls, 1, 'owner loss must cancel the active automation runner')
  assert.equal(state.works[0].status, 'running', 'former owner must not write a terminal result after lock loss')
  assert.equal(state.works[0].results.length, 0)
  await workService.close()
}

async function liveEventCapabilityLossChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-live-capability-'))
  let state = fixture({ rules: [] }), loseOwner, runtime, receiver, ownerLosses = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const workService = { async ensureReady() {}, async automationOwnerLost() { ownerLosses += 1 } }
  const automation = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog, eventSourceId: 'gearjob:dev.localhost', eventSourceReady: () => runtime?.ownsLock() === true && receiver?.isListening() === true })
  runtime = createAutomationRuntime({ store, automationService: automation, workService, dataRoot: root, lockFactory: async () => ({ lost: new Promise(resolve => { loseOwner = resolve }), async release() {} }), onOwnerLost: async () => receiver.close() })
  receiver = createGearJobEventReceiver({ secret: Buffer.from('live-secret'), sourceId: 'gearjob:dev.localhost', expectedSourceAddress: '127.0.0.1', host: '127.0.0.1', port: await freePort(), automationRuntime: runtime })
  try {
    await runtime.start(); await receiver.start()
    assert.deepEqual(automation.eventSourceCapability(), { status: 'ready', sourceId: 'gearjob:dev.localhost' })
    await receiver.close()
    assert.equal(automation.eventSourceCapability().status, 'unavailable')
    await assert.rejects(automation.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' } }), error => error.code === 'SOURCE_NOT_CONFIGURED')
    await receiver.start()
    loseOwner(new Error('lost'))
    await waitFor(() => !receiver.isListening() && !runtime.ownsLock() && ownerLosses === 1)
    assert.equal(automation.eventSourceCapability().status, 'unavailable')
  } finally { await receiver.close(); await runtime.close(); await rm(root, { recursive: true, force: true }) }
}

async function ownerLossBeforeResultCommitChecks() {
  let state = fixture({ rules: ['rule-a'] }), owned = true, cancelCalls = 0, releaseCommit, reachedCommit
  const commitReached = new Promise(resolve => { reachedCommit = resolve })
  const commitGate = new Promise(resolve => { releaseCommit = resolve })
  const store = {
    async read() { return structuredClone(state) },
    async update(mutator, options = {}) {
      const next = migrateState(await mutator(structuredClone(state)))
      if (state.works.some(work => work.status === 'running') && next.works.some(work => work.status === 'completed')) {
        reachedCommit()
        await commitGate
        await options.beforeCommit?.()
      }
      state = next
      return structuredClone(state)
    },
  }
  const runner = { configured: true, async run() { return validModel() }, async cancel() { cancelCalls += 1 } }
  const workService = createWorkService({ store, runner, clock: () => now, connectionCatalog: catalog })
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'owner-result', connectionCatalog: catalog })
  const accepted = await automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21', ownerCheck: () => owned })
  await commitReached
  owned = false
  const losing = workService.automationOwnerLost()
  releaseCommit()
  await losing
  assert.equal(accepted.accepted, true)
  assert.equal(cancelCalls, 1, 'owner loss must cancel once after the runner returned')
  assert.equal(state.works[0].status, 'running')
  assert.equal(state.works[0].executions[0].status, 'running')
  assert.equal(state.works[0].results.length, 0, 'former owner must not commit a result after lock loss')
  await workService.close()
}

async function actualProfileGuardChecks() {
  const dshHome = await mkdtemp(join(tmpdir(), 'geneway-p5-guard-profile-'))
  const root = new URL('..', import.meta.url).pathname
  let providerCalls = 0
  const provider = createServer((_request, response) => { providerCalls += 1; response.writeHead(500).end() })
  await new Promise((resolve, reject) => provider.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  const providerPort = provider.address().port
  const networkPatch = join(dshHome, 'local-provider.patch.yml')
  await writeFile(networkPatch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local guard probe\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${providerPort}/v1\n        models:\n          - id: deepseek/deepseek-v4.1-flash\n            contextWindow: 200000\n            maxOutputTokens: 8192\n`, { mode: 0o600 })
  const harness = new DeepSeekHarness({
    profile: 'sdk', patches: [join(root, 'config/p1-runtime.patch.yml'), networkPatch], dshHome,
    processCwd: root, cwd: root, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: 'guard-must-stop-before-provider' },
    initializeTimeoutMs: 15_000, requestTimeoutMs: 120_000,
  })
  try {
    const result = await harness.run('本请求必须在模型 I/O 前由缺失授权拒绝。')
    assert.equal(result.events.some(event => event.type === 'request/header'), false)
    const turnEnd = result.events.find(event => event.type === 'turn/end')
    assert.equal(turnEnd?.data?.reason?.kind, 'error')
    assert.equal(turnEnd?.data?.reason?.error?.message, '执行授权已失效')
    assert.equal(providerCalls, 0)
  } finally {
    await harness.close().catch(() => undefined)
    await new Promise(resolve => provider.close(resolve))
    await rm(dshHome, { recursive: true, force: true })
  }
}

async function concurrencyAndCapacityChecks() {
  const budget = await admissionHarness({ maxRuns: 1, rules: ['rule-a'] })
  try {
    const outcomes = await Promise.all([
      budget.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' }),
      budget.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-22' }),
    ])
    assert.equal(outcomes.filter(item => item.accepted && !item.deduplicated).length, 1)
    assert.equal(outcomes.find(item => item.reason)?.reason, 'budget')
    assert.equal(outcomes.find(item => item.reason)?.deduplicated, false)
    assert.equal((await budget.store.read()).works.length, 1)
  } finally { await budget.close() }

  const capacity = await admissionHarness({ rules: ['rule-a', 'rule-b', 'rule-c'], includeManualWork: true })
  try {
    const outcomes = await Promise.all(['rule-a', 'rule-b', 'rule-c'].map(ruleId => capacity.automation.acceptDailyOccurrence({ ruleId, scheduledDate: '2026-09-21' })))
    assert.equal(outcomes.filter(item => item.accepted).length, 2)
    assert.equal(outcomes.find(item => item.reason)?.reason, 'capacity')
    assert.equal(outcomes.find(item => item.reason)?.deduplicated, false)
    assert.equal((await capacity.store.read()).works.filter(work => work.id !== 'manual-work').length, 2)
  } finally { await capacity.close() }

  const revoked = await admissionHarness({ rules: ['rule-a'] })
  try {
    await revoked.store.update(state => ({ ...state, connections: state.connections.map(connection => ({ ...connection, enabled: false, status: 'disabled' })) }))
    const blocked = await revoked.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' })
    assert.equal(blocked.reason, 'auth-blocked')
    assert.equal(blocked.deduplicated, false)
    assert.equal((await revoked.store.read()).works.length, 0)
  } finally { await revoked.close() }
}

async function admissionHarness({ maxRuns = 3, rules, includeManualWork = false }) {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-admission-'))
  const statePath = join(root, 'state.json')
  const initial = fixture({ maxRuns, rules })
  if (includeManualWork) initial.works.push({ id: 'manual-work', ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', input: { workOrderId: 'WO-1' }, status: 'running', results: [], actions: [], executions: [{ id: 'manual-exec', operation: 'create', status: 'running' }] })
  await writeFile(statePath, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 })
  const store = createFileStore(statePath)
  let sequence = 0
  const pending = new Map()
  const runner = {
    configured: true,
    async run({ executionId }) { return new Promise((resolve, reject) => pending.set(executionId, { resolve, reject })) },
    async cancel(executionId) { pending.get(executionId)?.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); pending.delete(executionId) },
  }
  const workService = createWorkService({ store, runner, clock: () => now, connectionCatalog: catalog, idFactory: () => `work-service-${++sequence}` })
  const automation = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog, idFactory: () => `automation-${++sequence}`, eventSourceId: 'gearjob:dev.localhost' })
  return { store, automation, close: async () => { await workService.close(); await rm(root, { recursive: true, force: true }) } }
}

async function requestGuardChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-request-'))
  try {
    const path = join(root, 'request.json')
    const grant = { version: 2, executionId: 'exec-1', memberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', workId: 'work-1', modelRouteId: 'route-owner', operation: 'automation', expectedTool: 'geneway_gearjob_read_work_order', input: { workOrderId: 'WO-1' }, connection: null, confirmationFingerprint: 'fingerprint', confirmationRefs: [], policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: root }
    await writeFile(path, JSON.stringify(grant), { mode: 0o600 })
    const reads = []
    const guard = createExecutionRequestGuard({ filePath: path, authorize: async filePath => { reads.push(filePath); return true } })
    const handlers = {}
    const ctx = { on(name, handler) { handlers[name] = handler } }
    guard(ctx)
    const requestHandlers = []
    const agent = { ctx: { on(name, handler) { requestHandlers.push(handler) } }, session: { header: { origin: 'root' } } }
    handlers['agent/created']({ agent })
    assert.equal(requestHandlers.length, 1)
    let nextCalls = 0
    await requestHandlers[0]({ agent }, async () => { nextCalls += 1; return 'next' })
    await requestHandlers[0]({ agent }, async () => { nextCalls += 1; return 'next' })
    assert.equal(nextCalls, 2)
    assert.equal(reads.length, 2)
    const state = fixture({ rules: ['rule-a'] })
    const rule = state.automationRules[0]
    const work = { id: 'work-1', ownerMemberId: rule.ownerMemberId, employeeId: rule.employeeId, skillId: rule.skillId, capabilityId: 'gearjob-work-order-read', connectionId: rule.connectionId, input: { workOrderId: rule.workOrderId }, status: 'running', results: [], actions: [], executions: [{ id: 'exec-1', operation: 'automation', status: 'running' }] }
    state.works.push(work)
    state.automationOccurrences.push({ id: 'occurrence-1', occurrenceKey: dailyOccurrenceKey(rule.id, '2026-09-21'), ruleId: rule.id, ruleRevision: rule.revision, scheduledDate: '2026-09-21', workId: work.id, status: null, reason: null, deliveryId: null, createdAt: now })
    grant.connection = connectionSnapshot(state.connections[0])
    await writeFile(path, JSON.stringify(grant), { mode: 0o600 })
    await authorizeExecutionRequestFile({ filePath: path, readState: async () => state })
    rule.status = 'paused'
    await assert.rejects(authorizeExecutionRequestFile({ filePath: path, readState: async () => state }), error => error.code === 'FORBIDDEN')
    rule.status = 'active'
    await chmod(path, 0o644)
    await assert.rejects(authorizeExecutionRequestFile({ filePath: path, readState: async () => state }), error => error.code === 'FORBIDDEN')
    await chmod(path, 0o600)
    await rm(path)
    await assert.rejects(authorizeExecutionRequestFile(path), error => error.code === 'FORBIDDEN')
    await assert.rejects(authorizeExecutionRequestFile(), error => error.code === 'FORBIDDEN')
    assert.match(await readFile(new URL('../config/p1-runtime.patch.yml', import.meta.url), 'utf8'), /execution-request-guard\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function deadlineAndCancellationChecks() {
  const state = fixture({ maxRuns: 3, rules: ['rule-a'] })
  let current = state
  let clock = now
  let resolveRun
  let runCount = 0
  const store = { async read() { return structuredClone(current) }, async update(mutator) { current = migrateState(await mutator(structuredClone(current))); return structuredClone(current) } }
  const runner = { configured: true, async run() { runCount += 1; return new Promise(resolve => { resolveRun = resolve }) }, async cancel() {} }
  const workService = createWorkService({ store, runner, clock: () => clock, connectionCatalog: catalog, idFactory: (() => { let i = 0; return () => `w-${++i}` })() })
  const automation = createAutomationService({ store, workService, clock: () => clock, idFactory: (() => { let i = 0; return () => `a-${++i}` })(), connectionCatalog: catalog })
  const accepted = await automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' })
  assert.equal(accepted.accepted, true)
  await waitFor(() => runCount === 1)
  clock = '2026-09-21T00:01:59.999Z'
  resolveRun(validModel())
  await waitFor(() => current.works[0].status === 'completed')
  assert.equal(runCount, 1)

  const expired = await automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-22' })
  assert.equal(expired.accepted, true)
  const expiredWork = current.works.find(work => work.id === expired.workId)
  clock = new Date(new Date(expiredWork.acceptedAt).getTime() + 120_000).toISOString()
  await waitFor(() => current.works.find(work => work.id === expired.workId)?.status === 'failed')
  assert.equal(current.works.find(work => work.id === expired.workId).executions[0].error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(current.works.find(work => work.id === accepted.workId).status, 'completed')
  await workService.close()

  let deadlineState = fixture({ rules: ['rule-a', 'rule-b'] })
  const acceptedAt = new Date(Date.now() - 119_900).toISOString()
  let finishCancel
  let cancelStarted = false
  const runResolvers = new Map()
  const cancelledExecutions = []
  const deadlineStore = { async read() { return structuredClone(deadlineState) }, async update(mutator) { deadlineState = migrateState(await mutator(structuredClone(deadlineState))); return structuredClone(deadlineState) } }
  const deadlineRunner = {
    configured: true,
    async run({ executionId }) { return new Promise(resolve => runResolvers.set(executionId, resolve)) },
    async cancel(executionId) { cancelledExecutions.push(executionId); cancelStarted = true; return new Promise(resolve => { finishCancel = resolve }) },
  }
  const deadlineWorkService = createWorkService({ store: deadlineStore, runner: deadlineRunner, clock: () => new Date().toISOString(), connectionCatalog: catalog })
  await deadlineWorkService.ensureReady()
  const prepared = deadlineWorkService.prepareAutomationWork(deadlineState, deadlineState.automationRules[0], { occurrenceKey: 'rule-a:2026-09-21', acceptedAt, workId: 'deadline-work', executionId: 'deadline-exec' })
  const peerAcceptedAt = new Date().toISOString()
  const peer = deadlineWorkService.prepareAutomationWork(deadlineState, deadlineState.automationRules[1], { occurrenceKey: 'rule-b:2026-09-21', acceptedAt: peerAcceptedAt, workId: 'peer-work', executionId: 'peer-exec' })
  deadlineState = migrateState({ ...deadlineState, works: [prepared.work, peer.work], automationOccurrences: [
    { id: 'deadline-occurrence', occurrenceKey: 'rule-a:2026-09-21', ruleId: 'rule-a', ruleRevision: 1, scheduledDate: '2026-09-21', workId: prepared.workId, status: null, reason: null, deliveryId: null, createdAt: acceptedAt },
    { id: 'peer-occurrence', occurrenceKey: 'rule-b:2026-09-21', ruleId: 'rule-b', ruleRevision: 1, scheduledDate: '2026-09-21', workId: peer.workId, status: null, reason: null, deliveryId: null, createdAt: peerAcceptedAt },
  ] })
  await deadlineWorkService.dispatchAutomationWork(prepared.workId, prepared.executionId, acceptedAt)
  await deadlineWorkService.dispatchAutomationWork(peer.workId, peer.executionId, peerAcceptedAt)
  await waitFor(() => runResolvers.has('peer-exec'))
  await waitFor(() => cancelStarted)
  assert.equal(deadlineState.works[0].status, 'running', 'deadline must retain capacity until runner teardown')
  assert.deepEqual(cancelledExecutions, ['deadline-exec'])
  runResolvers.get('peer-exec')(validModel())
  await waitFor(() => deadlineState.works.find(work => work.id === 'peer-work').status === 'completed')
  finishCancel()
  await waitFor(() => deadlineState.works[0].status === 'failed')
  assert.equal(deadlineState.works[0].executions[0].error.code, 'UPSTREAM_TIMEOUT')
  await deadlineWorkService.close()
}

async function gearJobTimeoutChecks() {
  const secretRoot = await mkdtemp(join(tmpdir(), 'geneway-p5-secret-'))
  try {
    await writeFile(join(secretRoot, 'GEARJOB_TEST'), 'token', { mode: 0o600 })
    const signalController = new AbortController()
    signalController.abort(Object.assign(new Error('deadline'), { code: 'UPSTREAM_TIMEOUT' }))
    let calls = 0
    await assert.rejects(readGearJobWorkOrder({ workOrderId: 'WO-1', connection: { ...catalog[0], allowedObjectIds: ['WO-1'] }, secretRoot, signal: signalController.signal, fetchImpl: async () => { calls += 1 } }), error => error.code === 'UPSTREAM_TIMEOUT')
    assert.equal(calls, 0)
    const inFlight = new AbortController()
    const reading = readGearJobWorkOrder({
      workOrderId: 'WO-1', connection: { ...catalog[0], allowedObjectIds: ['WO-1'] }, secretRoot,
      signal: inFlight.signal, authorize: async () => undefined,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    })
    inFlight.abort(Object.assign(new Error('deadline'), { code: 'UPSTREAM_TIMEOUT' }))
    await assert.rejects(reading, error => error.code === 'UPSTREAM_TIMEOUT')
  } finally {
    await rm(secretRoot, { recursive: true, force: true })
  }
}

async function closeTeardownChecks() {
  let state = fixture({ rules: ['rule-a'] })
  let cancelCalls = 0
  let rejectRun
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const runner = {
    configured: true,
    async run() { return new Promise((_resolve, reject) => { rejectRun = reject }) },
    async cancel() { cancelCalls += 1; rejectRun?.(Object.assign(new Error('closed'), { code: 'CANCELLED' })) },
    async close() {},
  }
  const service = createWorkService({ store, runner, clock: () => new Date().toISOString(), connectionCatalog: catalog })
  await service.ensureReady()
  const acceptedAt = new Date().toISOString()
  const prepared = service.prepareAutomationWork(state, state.automationRules[0], { occurrenceKey: 'rule-a:2026-09-21', acceptedAt, workId: 'close-work', executionId: 'close-exec' })
  state = migrateState({ ...state, works: [prepared.work], automationOccurrences: [{ id: 'close-occurrence', occurrenceKey: 'rule-a:2026-09-21', ruleId: 'rule-a', ruleRevision: 1, scheduledDate: '2026-09-21', workId: prepared.workId, status: null, reason: null, deliveryId: null, createdAt: acceptedAt }] })
  await service.dispatchAutomationWork(prepared.workId, prepared.executionId, acceptedAt)
  await waitFor(() => Boolean(rejectRun))
  await service.close()
  assert.equal(cancelCalls, 1)
  assert.equal(state.works[0].status, 'interrupted')
}

function fixture({ maxRuns = 3, rules = ['rule-a'] } = {}) {
  const value = {
    version: 7,
    members: [{ id: 'member-owner', loginName: 'owner', displayName: 'Owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds: ['employee-owner'] }],
    modelRoutes: [{ id: 'route-owner', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    employees: [{ id: 'employee-owner', enabled: true, modelRouteId: 'route-owner', skillIds: ['skill-gearjob-work-order-read'], connectionIds: ['connection-owner'] }],
    connections: [{ id: 'connection-owner', kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test', enabled: true, status: 'ready', revision: 1, skillIds: ['skill-gearjob-work-order-read'], allowedObjectIds: ['WO-1'] }],
    skills: [{ id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true }], confirmations: [], knowledgeMaterials: [], channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [], works: [], reservations: {},
    automationRules: rules.map((id, index) => ({ id, ownerMemberId: 'member-owner', revision: 1, status: 'active', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns, notificationConversationId: null, effectiveFrom: now, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null })),
    automationOccurrences: [],
  }
  return migrateState(value)
}

function validModel() {
  return { result: { kind: 'gearjob.work-order.observation', payload: { workOrderId: 'WO-1', status: 'Draft', plannedQuantity: 10, completedQuantity: 1, unit: '件', sourceTime: now, sourceRecordId: 'Work Order:WO-1', sourceRevision: '1', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test' }, source: { sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test', sourceRecordId: 'Work Order:WO-1', sourceRevision: '1', sourceTime: now }, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }, explanation: 'ok', dshSessionRef: 'session-1' }
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not settle')
}

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
