import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireAutomationOwner, createAutomationRuntime, createAutomationService } from '../src/automation-service.mjs'

await dueAndRollbackChecks()
await sameDueChecks()
await missedWindowAndNoBackfillChecks()
await refreshChecks()
await ownerLockChecks()
await ownerReleaseChecks()
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
  let state = { ...timerState(), works: [] }
  const calls = []
  let prepared = 0
  const store = {
    async read() { return structuredClone(state) },
    async update(mutator) { state = await mutator(structuredClone(state)); return structuredClone(state) },
  }
  const workService = { async ensureReady() {}, async automationOwnerLost() {}, prepareAutomationWork() { prepared += 1; assert.fail('missed window must not prepare work') } }
  const automation = createAutomationService({ store, workService, clock: () => now, idFactory: () => 'missed' })
  const timers = fakeTimers()
  const runtime = createAutomationRuntime({ store, automationService: { async acceptDailyOccurrence(value) { calls.push(value) } }, workService, dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => now, timerFactory: timers.set, clearTimer: timers.clear, lockFactory: fakeLock })
  await runtime.start()
  now = '2026-09-21T00:01:00.001Z'
  timers.pending.shift().callback()
  await waitFor(() => calls.length === 1)
  assert.deepEqual({ ruleId: calls[0].ruleId, scheduledDate: calls[0].scheduledDate, scheduledAt: calls[0].scheduledAt }, { ruleId: 'rule-a', scheduledDate: '2026-09-21', scheduledAt: '2026-09-21T00:00:00.000Z' })
  assert.equal(calls[0].ownerCheck(), true)
  assert.equal(prepared, 0)
  state.automationRules = state.automationRules.map(({ capabilityId: _current, ...legacy }) => legacy)
  await assert.rejects(automation.acceptDailyOccurrence(calls[0]), { code: 'CAPABILITY_RETIRED' })
  assert.deepEqual(state.automationOccurrences, [])
  assert.deepEqual(state.works, [])
  assert.equal(prepared, 0, 'retired GearJob must not prepare work even after the window elapsed')
  await runtime.close()
  assert.equal(calls[0].ownerCheck(), false)

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

async function ownerReleaseChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-owner-release-')), holders = []
  const spawnHolder = (command, args, options) => {
    const holder = spawn(command, args, options)
    holders.push(holder)
    return holder
  }
  try {
    const first = await acquireAutomationOwner(root, { spawnImpl: spawnHolder }), firstHolder = holders.at(-1)
    let lost = false
    void first.lost.then(() => { lost = true })
    await assert.rejects(acquireAutomationOwner(root, { spawnImpl: spawnHolder }), { code: 'OWNER_ALREADY_RUNNING' })
    assert.equal(holders.at(-1).exitCode, 73)
    await first.release()
    await first.release()
    assert.equal(firstHolder.exitCode, 0, 'normal EOF must exit the holder successfully')
    assert.equal(firstHolder.signalCode, null)
    assert.equal(lost, false, 'normal release must not report owner loss')

    const interrupted = await acquireAutomationOwner(root, { spawnImpl: spawnHolder }), interruptedHolder = holders.at(-1)
    interruptedHolder.kill('SIGTERM')
    assert.deepEqual(await interrupted.lost, { code: null, signal: 'SIGTERM' })
    await interrupted.release()

    const closed = await acquireAutomationOwner(root, { spawnImpl(command, _args, options) {
      return spawnHolder(command, ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; exec 0<&-; printf ready; /bin/sleep 0.2'], options)
    } }), closedHolder = holders.at(-1)
    assert.equal(closedHolder.exitCode, null, 'closed stdin must be tested before the holder exits')
    await closed.release()
    assert.equal(closedHolder.exitCode, 0, 'release must still wait for the real closed-pipe holder exit')
    assert.equal(closedHolder.signalCode, null)

    const reacquired = await acquireAutomationOwner(root, { spawnImpl: spawnHolder }), reacquiredHolder = holders.at(-1)
    await reacquired.release()
    assert.equal(reacquiredHolder.exitCode, 0)
    for (const holder of holders) assert.throws(() => process.kill(holder.pid, 0), { code: 'ESRCH' })
  } finally {
    await Promise.all(holders.filter(holder => holder.exitCode === null && holder.signalCode === null).map(holder => new Promise(resolve => {
      holder.once('exit', resolve)
      holder.kill('SIGKILL')
    })))
    await rm(root, { recursive: true, force: true })
  }
}

async function refreshChecks() {
  let state = { automationRules: [], automationOccurrences: [] }
  const timers = fakeTimers()
  const runtime = createAutomationRuntime({
    store: { async read() { return structuredClone(state) } },
    automationService: { async acceptDailyOccurrence() {} },
    workService: { async ensureReady() {}, async automationOwnerLost() {} },
    dataRoot: '/tmp/geneway-p5-fake-owner', clock: () => '2026-09-20T23:59:30.000Z',
    timerFactory: timers.set, clearTimer: timers.clear, lockFactory: fakeLock,
  })
  await runtime.start()
  assert.equal(timers.pending.length, 0)
  state = timerState()
  await runtime.refresh()
  assert.equal(timers.pending.length, 1)
  assert.equal(timers.pending[0].delay, 30_000, 'HTTP rule writes must arm a newly enabled timer')
  state.automationRules[0].trigger.time = '08:01'
  await runtime.refresh()
  assert.equal(timers.pending.length, 1, 'refresh must replace rather than duplicate the native timer')
  assert.equal(timers.pending[0].delay, 90_000)
  await runtime.close()
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
    automationRules: ruleIds.map(id => ({ id, capabilityId: 'kivo-tpm-record-read', status: 'active', maxRuns: 10, effectiveFrom: '2026-09-20T00:00:00.000Z', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' } })),
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
