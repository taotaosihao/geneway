import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomationRuntime, createAutomationService } from '../src/automation-service.mjs'

await dueAndRollbackChecks()
await sameDueChecks()
await missedWindowAndNoBackfillChecks()
await ownerLockChecks()
await ownerLossCancellationChecks()
console.log('P5 timer checks passed; owner contention=closed; external effects=0')

async function dueAndRollbackChecks() {
  let now = '2026-09-20T23:59:30.000Z'
  const state = timerState()
  const calls = []
  const timers = fakeTimers()
  const runtime = createAutomationRuntime({
    store: readStore(state),
    automationService: { async acceptDailyOccurrence(value) { calls.push(value) } },
    workService: { async ensureReady() { calls.push('ready') }, async automationOwnerLost() {} },
    dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => now,
    timerFactory: timers.set, clearTimer: timers.clear, lockFactory: fakeLock,
  })
  await runtime.start()
  assert.equal(calls[0], 'ready')
  assert.equal(timers.pending[0].delay, 30_000)
  now = '2026-09-20T23:58:00.000Z'
  timers.pending.shift().callback()
  await waitFor(() => timers.pending.length === 1)
  assert.equal(calls.length, 1, 'clock rollback must not dispatch')
  assert.equal(timers.pending[0].delay, 120_000)
  now = '2026-09-21T00:00:59.999Z'
  timers.pending.shift().callback()
  await waitFor(() => calls.length === 2)
  assert.deepEqual({ ruleId: calls[1].ruleId, scheduledDate: calls[1].scheduledDate, scheduledAt: calls[1].scheduledAt }, { ruleId: 'rule-a', scheduledDate: '2026-09-21', scheduledAt: '2026-09-21T00:00:00.000Z' })
  assert.equal(calls[1].ownerCheck(), true)
  await runtime.close()
  assert.equal(timers.pending.length, 0)
}

async function sameDueChecks() {
  let now = '2026-09-20T23:59:59.999Z'
  const state = timerState(['rule-a', 'rule-b', 'rule-c'])
  const calls = []
  const timers = fakeTimers()
  const runtime = createAutomationRuntime({ store: readStore(state), automationService: { async acceptDailyOccurrence(value) { calls.push(value.ruleId) } }, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => now, timerFactory: timers.set, clearTimer: timers.clear, lockFactory: fakeLock })
  await runtime.start()
  assert.equal(timers.pending[0].delay, 1)
  now = '2026-09-21T00:00:00.001Z'
  timers.pending.shift().callback()
  await waitFor(() => calls.length === 3)
  assert.deepEqual(calls, ['rule-a', 'rule-b', 'rule-c'])
  await runtime.close()
}

async function missedWindowAndNoBackfillChecks() {
  let now = '2026-09-20T23:59:30.000Z'
  let state = timerState()
  const store = {
    async read() { return structuredClone(state) },
    async update(mutator) { state = await mutator(structuredClone(state)); return structuredClone(state) },
  }
  const workService = { async ensureReady() {}, async automationOwnerLost() {}, prepareAutomationWork() { throw new Error('missed window must not prepare work') } }
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'missed' })
  const timers = fakeTimers()
  const runtime = createAutomationRuntime({ store, automationService: automation, workService, dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => now, timerFactory: timers.set, clearTimer: timers.clear, lockFactory: fakeLock })
  await runtime.start()
  now = '2026-09-21T00:01:00.001Z'
  timers.pending.shift().callback()
  await waitFor(() => state.automationOccurrences.length === 1)
  assert.deepEqual({ status: state.automationOccurrences[0].status, reason: state.automationOccurrences[0].reason, workId: state.automationOccurrences[0].workId }, { status: 'skipped', reason: 'missed-window', workId: null })
  await runtime.close()

  now = '2026-09-21T01:00:00.000Z'
  state = timerState()
  const startupTimers = fakeTimers()
  const startup = createAutomationRuntime({ store: readStore(state), automationService: { async acceptDailyOccurrence() { assert.fail('startup must not backfill') } }, workService: { async ensureReady() {}, async automationOwnerLost() {} }, dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => now, timerFactory: startupTimers.set, clearTimer: startupTimers.clear, lockFactory: fakeLock })
  await startup.start()
  assert.equal(startupTimers.pending.length, 1)
  assert.equal(startupTimers.pending[0].delay, 23 * 60 * 60 * 1000)
  assert.equal(state.automationOccurrences.length, 0)
  await startup.close()
}

async function ownerLockChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-owner-'))
  try {
    const store = { async read() { return { automationRules: [], automationOccurrences: [] } } }
    const automationService = { async acceptDailyOccurrence() { assert.fail('empty owner must not dispatch') } }
    let firstReady = 0, secondReady = 0
    const first = createAutomationRuntime({ store, automationService, workService: { async ensureReady() { firstReady += 1 }, async automationOwnerLost() {} }, dataRoot: root })
    const second = createAutomationRuntime({ store, automationService, workService: { async ensureReady() { secondReady += 1 }, async automationOwnerLost() {} }, dataRoot: root })
    await first.start()
    await assert.rejects(second.start(), error => error.code === 'OWNER_ALREADY_RUNNING')
    assert.equal(firstReady, 1)
    assert.equal(secondReady, 0)
    await first.close()
    await second.start()
    assert.equal(secondReady, 1)
    await second.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function ownerLossCancellationChecks() {
  let lose, cancelled = 0, errors = 0
  const lost = new Promise(resolve => { lose = resolve })
  const runtime = createAutomationRuntime({
    store: readStore({ automationRules: [], automationOccurrences: [] }),
    automationService: { async acceptDailyOccurrence() {} },
    workService: { async ensureReady() {}, async automationOwnerLost() { cancelled += 1 } },
    dataRoot: '/tmp/geneway-p5-fake-owner', lockFactory: async () => ({ lost, async release() {} }),
    onError() { errors += 1 },
  })
  await runtime.start()
  lose({ code: 1 })
  await waitFor(() => errors === 1)
  assert.equal(cancelled, 1)
  await runtime.close()
}

function timerState(ruleIds = ['rule-a']) {
  return {
    automationRules: ruleIds.map(id => ({ id, status: 'active', maxRuns: 10, effectiveFrom: '2026-09-20T00:00:00.000Z', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' } })),
    automationOccurrences: [],
  }
}

function readStore(state) { return { async read() { return structuredClone(state) } } }
function fakeLock() { return Promise.resolve({ lost: new Promise(() => undefined), async release() {} }) }
function fakeTimers() {
  const pending = []
  return {
    pending,
    set(callback, delay) { const timer = { callback, delay, unref() {} }; pending.push(timer); return timer },
    clear(timer) { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1) },
  }
}
async function waitFor(predicate) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('timer condition did not settle') }
