import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createAutomationService, dailyOccurrenceKey } from '../src/automation-service.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { authorizeExecutionRequestFile, connectionSnapshot } from '../src/execution-grant.mjs'
import { migrateState, createFileStore } from '../src/store/file-store.mjs'
import { createExecutionRequestGuard } from '../plugins/execution-request-guard.mjs'
import { readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'

const now = '2026-09-21T00:00:00.000Z'
const catalog = [{ kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test' }]

await atomicAndAdmissionChecks()
await concurrencyAndCapacityChecks()
await ownerLossBeforeDispatchChecks()
await ownerLossAfterRunnerStartChecks()
await ownerLossBeforeResultCommitChecks()
await requestGuardChecks()
await actualProfileGuardChecks()
await deadlineAndCancellationChecks()
await closeTeardownChecks()
await gearJobTimeoutChecks()
console.log('P5 execution checks passed; external effects=0; real GearJob/ZenMux=not called')

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
          results: [], executions: [{ id: executionId, operation: 'automation', clientRequestId: options.occurrenceKey, input: { workOrderId: rule.workOrderId }, status: 'accepted', acceptedAt: options.acceptedAt }],
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
    prepareAutomationWork(_state, rule, options) { return { ok: true, workId: options.workId, executionId: options.executionId, acceptedAt: options.acceptedAt, work: { id: options.workId, ownerMemberId: rule.ownerMemberId, employeeId: rule.employeeId, skillId: rule.skillId, capabilityId: 'gearjob-work-order-read', connectionId: rule.connectionId, input: { workOrderId: rule.workOrderId }, status: 'accepted', acceptedAt: options.acceptedAt, results: [], executions: [{ id: options.executionId, operation: 'automation', status: 'accepted' }] } } },
    async dispatchAutomationWork() { dispatches += 1 },
  }
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'owner-loss' })
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
  await writeFile(networkPatch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local guard probe\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${providerPort}/v1\n        models:\n          - id: deepseek/deepseek-v4-pro\n            contextWindow: 200000\n            maxOutputTokens: 8192\n`, { mode: 0o600 })
  const harness = new DeepSeekHarness({
    profile: 'sdk', patches: [join(root, 'config/p1-runtime.patch.yml'), networkPatch], dshHome,
    processCwd: root, cwd: root, provider: 'zenmux', model: 'deepseek/deepseek-v4-pro',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: 'guard-must-stop-before-provider' },
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
  if (includeManualWork) initial.works.push({ id: 'manual-work', ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', input: { workOrderId: 'WO-1' }, status: 'running', results: [], executions: [{ id: 'manual-exec', operation: 'create', status: 'running' }] })
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
  const automation = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog, idFactory: () => `automation-${++sequence}` })
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
    const work = { id: 'work-1', ownerMemberId: rule.ownerMemberId, employeeId: rule.employeeId, skillId: rule.skillId, capabilityId: 'gearjob-work-order-read', connectionId: rule.connectionId, input: { workOrderId: rule.workOrderId }, status: 'running', results: [], executions: [{ id: 'exec-1', operation: 'automation', status: 'running' }] }
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
    modelRoutes: [{ id: 'route-owner', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
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
