import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
const catalog = [{ kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'test' }]
const mode = process.argv[2]
assert.ok(process.argv.length <= 3 && (mode === undefined || ['--pure-only', '--native-only'].includes(mode)), '仅支持互斥的 --pure-only 或 --native-only')

if (mode !== '--native-only') {
  await profileHomeChecks()
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
  await deadlineAndCancellationChecks()
  await closeTeardownChecks()
  await gearJobTimeoutChecks()
  await gearJobEventConfigChecks()
  await gearJobEventReceiverChecks()
  console.log('P5 pure execution checks passed; injected runner/local FS/loopback only; native profile guard not included')
}
if (mode !== '--pure-only') {
  await actualProfileGuardChecks()
  console.log('P5 native profile guard checks passed')
}

async function manualAdmissionChecks() {
  const harness = await admissionHarness({ maxRuns: 1, rules: ['rule-a', 'rule-b', 'rule-c'] })
  try {
    const before = await harness.store.read()
    for (const input of [
      { expectedRevision: 1, clientRequestId: 'manual-1' },
      { expectedRevision: 1, clientRequestId: 'manual-1' },
      { expectedRevision: 2, clientRequestId: 'manual-stale' },
      { expectedRevision: 1, clientRequestId: 'bad:value' },
    ]) {
      await assert.rejects(harness.automation.acceptManualOccurrence({ id: 'member-owner' }, 'rule-a', input), error => error.code === 'CAPABILITY_RETIRED')
      assert.deepEqual(await harness.store.read(), before)
      assert.equal(harness.runs, 0)
    }
  } finally { await harness.close() }
}

async function eventAdmissionChecks() {
  const harness = await admissionHarness({ maxRuns: 3, rules: ['rule-a'] })
  try {
    await harness.store.update(state => ({ ...state, automationRules: state.automationRules.map(rule => ({ ...rule, trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' }, effectiveFrom: null, eventAcceptAfter: now })) }))
    const before = await harness.store.read()
    const input = { sourceId: 'gearjob:dev.localhost', workOrderId: 'WO-1', sourceRevision: '2026-09-21 08:01:02.123456', digest: 'a'.repeat(64) }
    for (const event of [input, input, { ...input, digest: 'b'.repeat(64) }, { ...input, sourceRevision: '2026-09-20 07:59:59.000001' }, { ...input, sourceRevision: '2026-09-31 08:02:02.000001' }, { ...input, sourceId: 'gearjob:other' }]) {
      await assert.rejects(harness.automation.acceptGearJobEvent(event), error => error.code === 'CAPABILITY_RETIRED')
      assert.deepEqual(await harness.store.read(), before)
      assert.equal(harness.runs, 0)
    }
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
    const before = await harness.store.read()
    assert.equal((await fetch(`http://127.0.0.1:${port}${GEARJOB_EVENT_PATH}`, options)).status, 503)
    assert.equal((await fetch(`http://127.0.0.1:${port}${GEARJOB_EVENT_PATH}`, options)).status, 503)
    assert.deepEqual(await harness.store.read(), before)
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
    await writeFile(statePath, JSON.stringify(fixture({ maxRuns: 3, rules: ['rule-a', 'rule-b', 'rule-c'] }), null, 2) + '\n', { mode: 0o600 })
    const store = createFileStore(statePath), before = await readFile(statePath, 'utf8'), calls = []
    const workService = {
      async ensureReady() { calls.push('ready') },
      prepareAutomationWork() { calls.push('prepare'); throw new Error('retired admission must not prepare work') },
      async dispatchAutomationWork() { calls.push('dispatch') },
    }
    const serviceA = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog })
    const serviceB = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog })
    const outcomes = await Promise.allSettled([serviceA, serviceB].map(service => service.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' })))
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.code === 'CAPABILITY_RETIRED'))
    assert.equal(await readFile(statePath, 'utf8'), before)
    assert.deepEqual(calls, [])
    assert.equal((await store.read()).works.length, 0)
    assert.equal((await store.read()).automationOccurrences.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function ownerLossBeforeDispatchChecks() {
  let state = executionFixture(), runnerCalls = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const denied = createWorkService({ store, runner: { configured: true, async run() { runnerCalls += 1; return validModel() } }, clock: () => now })
  await denied.ensureReady()
  state = migrateState({ ...state, works: [acceptedCycle('owner-before', 'owner-before-exec', now)] })
  const before = structuredClone(state)
  await assert.rejects(denied.dispatchAutomationWork('owner-before', 'owner-before-exec', now, { ownerCheck: () => false }), error => error.code === 'OWNER_LOCK_LOST')
  assert.deepEqual(state, before)
  assert.equal(runnerCalls, 0)
  await denied.close()

  let owned = true, markedRunning = false
  state = executionFixture()
  const racingStore = {
    async read() { return structuredClone(state) },
    async update(mutator) {
      state = migrateState(await mutator(structuredClone(state)))
      if (!markedRunning && state.works.some(work => work.executions.some(execution => execution.status === 'running'))) { markedRunning = true; owned = false }
      return structuredClone(state)
    },
  }
  const guarded = createWorkService({ store: racingStore, runner: { configured: true, async run() { runnerCalls += 1; return validModel() } }, clock: () => now })
  await guarded.ensureReady()
  state = migrateState({ ...state, works: [acceptedCycle('owner-race', 'owner-race-exec', now)] })
  await guarded.dispatchAutomationWork('owner-race', 'owner-race-exec', now, { ownerCheck: () => owned })
  await waitFor(() => markedRunning)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runnerCalls, 0, 'owner loss after markRunning must stop before model I/O')
  assert.equal(state.works[0].status, 'running', 'next owner recovers the accepted work without former-owner writes')
  await guarded.close()
}

async function ownerLossAfterRunnerStartChecks() {
  let state = executionFixture(), rejectRun, runnerCalls = 0, cancelCalls = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const runner = {
    configured: true,
    async run() { runnerCalls += 1; return new Promise((_resolve, reject) => { rejectRun = reject }) },
    async cancel() { cancelCalls += 1; rejectRun?.(Object.assign(new Error('owner lost'), { code: 'OWNER_LOCK_LOST' })); throw new Error('cancel cleanup failed') },
  }
  const workService = createWorkService({ store, runner, clock: () => now })
  await workService.ensureReady()
  state = migrateState({ ...state, works: [acceptedCycle('owner-running', 'owner-running-exec', now)] })
  await workService.dispatchAutomationWork('owner-running', 'owner-running-exec', now, { ownerCheck: () => true })
  await waitFor(() => runnerCalls === 1)
  await workService.automationOwnerLost()
  assert.equal(cancelCalls, 1, 'owner loss must cancel the active automation runner')
  assert.equal(state.works[0].status, 'running', 'former owner must not write a terminal result after lock loss')
  assert.equal(state.works[0].results.length, 0)
  await workService.close()
}

async function liveEventCapabilityLossChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-live-capability-'))
  let state = fixture({ rules: [] }), loseOwner, runtime, ownerLosses = 0
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const receiver = { listening: true, isListening() { return this.listening }, async close() { this.listening = false } }
  const workService = { async ensureReady() {}, async automationOwnerLost() { ownerLosses += 1 } }
  const automation = createAutomationService({ store, workService, clock: () => now, eventSourceId: 'gearjob:dev.localhost', eventSourceReady: () => runtime?.ownsLock() === true && receiver.isListening() })
  runtime = createAutomationRuntime({ store, automationService: automation, workService, dataRoot: root, lockFactory: async () => ({ lost: new Promise(resolve => { loseOwner = resolve }), async release() {} }), onOwnerLost: () => receiver.close() })
  try {
    await runtime.start()
    assert.deepEqual(await automation.eventSourceCapability({ id: 'member-owner' }), { status: 'unavailable', code: 'SOURCE_NOT_CONFIGURED', reconcileIntervalSeconds: 60, sources: [] })
    await assert.rejects(automation.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' } }), error => error.code === 'CAPABILITY_RETIRED')
    loseOwner(new Error('lost'))
    await waitFor(() => !receiver.isListening() && !runtime.ownsLock() && ownerLosses === 1)
    assert.deepEqual(await automation.eventSourceCapability({ id: 'member-owner' }), { status: 'unavailable', code: 'SOURCE_NOT_CONFIGURED', reconcileIntervalSeconds: 60, sources: [] })
  } finally { await receiver.close(); await runtime.close(); await rm(root, { recursive: true, force: true }) }
}

async function ownerLossBeforeResultCommitChecks() {
  let state = executionFixture(), owned = true, cancelCalls = 0, releaseCommit, reachedCommit
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
  await workService.ensureReady()
  state = migrateState({ ...state, works: [acceptedCycle('owner-result', 'owner-result-exec', now)] })
  await workService.dispatchAutomationWork('owner-result', 'owner-result-exec', now, { ownerCheck: () => owned })
  await commitReached
  owned = false
  const losing = workService.automationOwnerLost()
  releaseCommit()
  await losing
  assert.equal(cancelCalls, 1, 'owner loss must cancel once after the runner returned')
  assert.equal(state.works[0].status, 'running')
  assert.equal(state.works[0].executions[0].status, 'running')
  assert.equal(state.works[0].results.length, 0, 'former owner must not commit a result after lock loss')
  await workService.close()
}

async function actualProfileGuardChecks({ Harness = DeepSeekHarness, createProvider = createServer } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'geneway-p5-guard-profile-')), dshHome = join(temp, 'dsh')
  const previousHome = process.env.DSH_HOME
  const root = new URL('..', import.meta.url).pathname
  let providerCalls = 0, provider, harness
  try {
    await mkdir(dshHome, { mode: 0o700 })
    process.env.DSH_HOME = dshHome
    provider = createProvider((_request, response) => { providerCalls += 1; response.writeHead(500).end() })
    await new Promise((resolve, reject) => provider.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
    const providerPort = provider.address().port
    const networkPatch = join(temp, 'local-provider.patch.yml')
    await writeFile(networkPatch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local guard probe\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${providerPort}/v1\n        models:\n          - id: deepseek/deepseek-v4.1-flash\n            contextWindow: 200000\n            maxOutputTokens: 8192\n`, { mode: 0o600 })
    harness = new Harness({
      profile: 'sdk', patches: [join(root, 'config/p1-runtime.patch.yml'), networkPatch], dshHome,
      processCwd: root, cwd: root, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: 'guard-must-stop-before-provider' },
      initializeTimeoutMs: 15_000, requestTimeoutMs: 120_000,
    })
    const result = await harness.run('本请求必须在模型 I/O 前由缺失授权拒绝。')
    assert.equal(result.events.some(event => event.type === 'request/header'), false)
    const turnEnd = result.events.find(event => event.type === 'turn/end')
    assert.equal(turnEnd?.data?.reason?.kind, 'error')
    assert.equal(turnEnd?.data?.reason?.error?.message, '执行授权已失效')
    assert.equal(providerCalls, 0)
  } finally {
    try {
      if (harness) await harness.close().catch(() => undefined)
      if (provider) await new Promise(resolve => provider.close(resolve))
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(temp, { recursive: true, force: true })
    }
  }
}

async function profileHomeChecks() {
  const original = process.env.DSH_HOME
  try {
    for (const previous of [undefined, '/synthetic-parent-home']) for (const failAt of [undefined, 'constructor', 'run']) {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      let options, providerClosed = 0, harnessClosed = 0
      const failure = new Error('synthetic harness failure')
      const createProvider = () => ({ listen(_port, host, done) { assert.equal(host, '127.0.0.1'); done() }, address() { return { port: 32001 } }, close(done) { providerClosed += 1; done() } })
      class Harness {
        constructor(value) {
          options = value
          assert.equal(process.env.DSH_HOME, options.dshHome); assert.equal(options.env.DSH_HOME, options.dshHome)
          assert.equal(options.patches.at(-1), join(options.dshHome, '..', 'local-provider.patch.yml'))
          if (failAt === 'constructor') throw failure
        }
        async run() {
          assert.equal((await stat(options.dshHome)).mode & 0o777, 0o700)
          assert.equal((await stat(options.patches.at(-1))).mode & 0o777, 0o600)
          if (failAt === 'run') throw failure
          return { events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '执行授权已失效' } } } }] }
        }
        async close() { harnessClosed += 1 }
      }
      if (failAt) await assert.rejects(actualProfileGuardChecks({ Harness, createProvider }), error => error === failure)
      else await actualProfileGuardChecks({ Harness, createProvider })
      assert.equal(process.env.DSH_HOME, previous)
      assert.equal(providerClosed, 1); assert.equal(harnessClosed, failAt === 'constructor' ? 0 : 1)
      await assert.rejects(stat(options.dshHome), { code: 'ENOENT' })
      await assert.rejects(stat(options.patches.at(-1)), { code: 'ENOENT' })
    }
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
}

async function concurrencyAndCapacityChecks() {
  for (const options of [{ maxRuns: 1, rules: ['rule-a'] }, { rules: ['rule-a', 'rule-b', 'rule-c'], includeManualWork: true }]) {
    const harness = await admissionHarness(options)
    try {
      const before = await harness.store.read()
      const outcomes = await Promise.allSettled(['2026-09-21', '2026-09-22'].map(scheduledDate => harness.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate })))
      assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.code === 'CAPABILITY_RETIRED'))
      assert.deepEqual(await harness.store.read(), before)
      assert.equal(harness.runs, 0)
    } finally { await harness.close() }
  }
  const revoked = await admissionHarness({ rules: ['rule-a'] })
  try {
    await revoked.store.update(state => ({ ...state, connections: state.connections.map(connection => ({ ...connection, enabled: false, status: 'disabled' })) }))
    const before = await revoked.store.read()
    await assert.rejects(revoked.automation.acceptDailyOccurrence({ ruleId: 'rule-a', scheduledDate: '2026-09-21' }), error => error.code === 'CAPABILITY_RETIRED')
    assert.deepEqual(await revoked.store.read(), before)
    assert.equal(revoked.runs, 0)
  } finally { await revoked.close() }
}

async function admissionHarness({ maxRuns = 3, rules, includeManualWork = false }) {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-admission-'))
  const statePath = join(root, 'state.json')
  const initial = fixture({ maxRuns, rules })
  if (includeManualWork) initial.works.push({ id: 'manual-work', ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', input: { workOrderId: 'WO-1' }, status: 'running', results: [], actions: [], executions: [{ id: 'manual-exec', operation: 'create', status: 'running' }] })
  await writeFile(statePath, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 })
  const store = createFileStore(statePath)
  let runs = 0
  const runner = {
    configured: true,
    async run() { runs += 1; throw new Error('retired admission must not call runner') },
    async cancel() {},
  }
  const workService = createWorkService({ store, runner, clock: () => now, connectionCatalog: catalog })
  const automation = createAutomationService({ store, workService, clock: () => now, connectionCatalog: catalog, eventSourceId: 'gearjob:dev.localhost' })
  return { store, automation, get runs() { return runs }, close: async () => { await workService.close(); await rm(root, { recursive: true, force: true }) } }
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
  let current = executionFixture(), clock = now, resolveRun, runCount = 0
  const store = { async read() { return structuredClone(current) }, async update(mutator) { current = migrateState(await mutator(structuredClone(current))); return structuredClone(current) } }
  const runner = { configured: true, async run() { runCount += 1; return new Promise(resolve => { resolveRun = resolve }) }, async cancel() {} }
  const workService = createWorkService({ store, runner, clock: () => clock })
  await workService.ensureReady()
  current = migrateState({ ...current, works: [acceptedCycle('before-deadline', 'before-deadline-exec', now)] })
  await workService.dispatchAutomationWork('before-deadline', 'before-deadline-exec', now)
  await waitFor(() => runCount === 1)
  clock = '2026-09-21T00:01:59.999Z'
  resolveRun(validModel())
  await waitFor(() => current.works[0].status === 'completed')
  assert.equal(runCount, 1)

  const secondAcceptedAt = clock
  current = migrateState({ ...current, works: [...current.works, acceptedCycle('expired', 'expired-exec', secondAcceptedAt)] })
  await workService.dispatchAutomationWork('expired', 'expired-exec', secondAcceptedAt)
  await waitFor(() => runCount === 2)
  clock = new Date(new Date(secondAcceptedAt).getTime() + 120_000).toISOString()
  resolveRun(validModel())
  await waitFor(() => current.works.find(work => work.id === 'expired').status === 'failed')
  assert.equal(current.works.find(work => work.id === 'expired').executions[0].error.code, 'UPSTREAM_TIMEOUT')
  assert.equal(current.works[0].status, 'completed')
  await workService.close()

  let deadlineState = executionFixture(), finishCancel, cancelStarted = false
  const acceptedAt = new Date(Date.now() - 119_900).toISOString()
  const runResolvers = new Map(), cancelledExecutions = []
  let writeBarrier = Promise.resolve()
  // Concurrent work transitions need the same serialization as createFileStore.
  const deadlineStore = {
    async read() { await writeBarrier; return structuredClone(deadlineState) },
    update(mutator) {
      const operation = writeBarrier.then(async () => { deadlineState = migrateState(await mutator(structuredClone(deadlineState))); return structuredClone(deadlineState) })
      writeBarrier = operation.catch(() => undefined)
      return operation
    },
  }
  const deadlineRunner = {
    configured: true,
    async run({ executionId }) { return new Promise(resolve => runResolvers.set(executionId, resolve)) },
    async cancel(executionId) { cancelledExecutions.push(executionId); cancelStarted = true; return new Promise(resolve => { finishCancel = resolve }) },
  }
  const deadlineWorkService = createWorkService({ store: deadlineStore, runner: deadlineRunner, clock: () => new Date().toISOString() })
  await deadlineWorkService.ensureReady()
  const peerAcceptedAt = new Date().toISOString()
  deadlineState = migrateState({ ...deadlineState, works: [acceptedCycle('deadline-work', 'deadline-exec', acceptedAt), acceptedCycle('peer-work', 'peer-exec', peerAcceptedAt)] })
  await deadlineWorkService.dispatchAutomationWork('deadline-work', 'deadline-exec', acceptedAt)
  await deadlineWorkService.dispatchAutomationWork('peer-work', 'peer-exec', peerAcceptedAt)
  await waitFor(() => {
    const error = deadlineState.works.find(work => work.id === 'peer-work').executions[0].error
    assert.equal(error, undefined, `peer dispatch failed: ${error?.code}`)
    return runResolvers.has('peer-exec')
  })
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
  let state = executionFixture(), cancelCalls = 0, rejectRun
  const store = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const runner = { configured: true, async run() { return new Promise((_resolve, reject) => { rejectRun = reject }) }, async cancel() { cancelCalls += 1; rejectRun?.(Object.assign(new Error('closed'), { code: 'CANCELLED' })) }, async close() {} }
  const service = createWorkService({ store, runner, clock: () => new Date().toISOString() })
  await service.ensureReady()
  const acceptedAt = new Date().toISOString()
  state = migrateState({ ...state, works: [acceptedCycle('close-work', 'close-exec', acceptedAt)] })
  await service.dispatchAutomationWork('close-work', 'close-exec', acceptedAt)
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
    connections: [{ id: 'connection-owner', kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'test', enabled: true, status: 'ready', revision: 1, skillIds: ['skill-gearjob-work-order-read'], allowedObjectIds: ['WO-1'] }],
    skills: [{ id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true }], confirmations: [], knowledgeMaterials: [], channelApps: [], channelIdentities: [], channelConversations: [], channelMessages: [], deliveries: [], linkCodes: [], works: [], reservations: {},
    automationRules: rules.map((id, index) => ({ id, ownerMemberId: 'member-owner', revision: 1, status: 'active', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns, notificationConversationId: null, effectiveFrom: now, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null })),
    automationOccurrences: [],
  }
  return migrateState(value)
}

// Internal accepted-work fixtures exercise dispatch/teardown; they do not create cycle automation rules.
function executionFixture() {
  const state = fixture({ rules: [] })
  state.skills.push({ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true })
  state.employees[0].skillIds.push('skill-cycle-time-calculate')
  return migrateState(state)
}

function acceptedCycle(id, executionId, acceptedAt) {
  const input = { availableSeconds: 60, quantity: 1 }
  return { id, ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input, requiredInputs: [], status: 'accepted', acceptedAt, results: [], actions: [], executions: [{ id: executionId, operation: 'automation', clientRequestId: executionId, input, status: 'accepted', acceptedAt }] }
}

function validModel() {
  return { result: { kind: 'manufacturing.takt', payload: { availableSeconds: 60, quantity: 1, secondsPerUnit: 60, unit: 'seconds/unit' }, toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2' }, explanation: 'ok', dshSessionRef: 'session-1', contextConfirmationRefs: [] }
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
