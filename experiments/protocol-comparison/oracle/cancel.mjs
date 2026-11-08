import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { assertEntryProcessReplaced, assertSameWaitingTask, assertNoBusinessRecreated } from './recovery.mjs'
import { binding, sameBinding, assertSealed } from '../../../packages/agent-contracts/index.mjs'

const taskState = task => task.state ?? ({ 1: 'submitted', 2: 'working', 3: 'completed', 4: 'failed', 5: 'canceled', 6: 'input-required' })[task.status?.state]
const osState = value => value.osState ?? value.state
function sameTask(before, after) {
  assert.equal(after.id, before.id); assert.equal(after.contextId, before.contextId)
  for (const field of ['workId', 'rootDelegationId', 'rootAttemptId']) assert.equal(after.metadata.geneway[field], before.metadata.geneway[field])
}
function stoppedReceipts(state, execution) {
  return state.multisite.receipts.filter(row => !row.historical && row.event.kind === 'stopped' && sameBinding(row.event, execution))
}

// 真实OS屏障与两个独立协议观察结果，不能以cancel调用返回或固定sleep替代。
export function assertStoppingWhileHostBlocked({ busyState, stoppingState, beforeTask, cancelTask, independentlyQueriedTask, busyJob,
  workerBefore, workerDuring, hostBefore, hostDuring }) {
  const workId = beforeTask.metadata.geneway.workId
  const office = busyState.multisite.attempts.find(row => row.work_id === workId && row.agent_id === 'desktop-office')
  assert.ok(office); assert.equal(busyJob.work_id, workId); assert.equal(busyJob.state, 'running')
  assert.equal(busyJob.instructionRevision, office.instruction_revision)
  for (const [first, during] of [[workerBefore, workerDuring], [hostBefore, hostDuring]]) {
    assert.ok(Number.isSafeInteger(first.pid)); assert.ok(first.startTicks)
    assert.equal(during.pid, first.pid); assert.equal(String(during.startTicks), String(first.startTicks))
    assert.ok(['T', 't'].includes(osState(first))); assert.ok(['T', 't'].includes(osState(during)))
  }
  assert.equal(workerBefore.pid, busyJob.worker.pid)
  const work = stoppingState.works.find(row => row.id === workId)
  assert.equal(work.status, 'stopping')
  const pending = stoppingState.multisite.outbox.filter(row => row.command.operation === 'cancel' && row.command.work_id === workId)
  assert.ok(pending.some(row => row.command.attempt_id === office.attempt_id))
  for (const row of pending) assertSealed(row.command)
  assert.equal(stoppedReceipts(stoppingState, office).length, 0)
  assert.equal(stoppingState.artifacts.some(row => row.workId === workId && row.status === 'ready'), false)
  for (const task of [cancelTask, independentlyQueriedTask]) {
    sameTask(beforeTask, task)
    assert.ok(!['completed', 'canceled', 'failed'].includes(taskState(task)), '未停稳不能投影协议终态')
    assert.equal(task.metadata.geneway.workStatus, 'stopping')
    assert.deepEqual(task.artifacts, [])
  }
  return { workId, officeBinding: binding(office), originalJobId: busyJob.id, originalWorkerPid: workerBefore.pid,
    originalWorkerStartTicks: workerBefore.startTicks, blockedHostPid: hostBefore.pid,
    actualCancelCommands: pending.map(row => row.id), noEarlyStoppedReceipt: true, independentQueryStillNonterminal: true }
}

export function assertWorkerExitObservation(original, observed) {
  assert.equal(observed.pid, original.pid)
  const gone = ['ENOENT', 'ESRCH'].includes(observed.reason ?? observed.code)
  const zombie = osState(observed) === 'Z' && String(observed.startTicks) === String(original.startTicks)
  const reused = observed.startTicks !== undefined && String(observed.startTicks) !== String(original.startTicks)
  assert.ok(gone || zombie || reused, '必须原始/proc退出错误、原PID僵尸或PID复用身份，不能只信gone=true')
  return { pid: original.pid, startTicks: original.startTicks, evidence: gone ? 'proc-not-found' : zombie ? 'zombie' : 'pid-reused' }
}

export function assertActualCancellation({ busyState, finalState, beforeTask, finalTask, journals, busyJob, workerBefore, workerAfter }) {
  sameTask(beforeTask, finalTask)
  const workId = beforeTask.metadata.geneway.workId, work = finalState.works.find(row => row.id === workId)
  assert.equal(work.status, 'cancelled'); assert.equal(taskState(finalTask), 'canceled')
  assert.equal(finalTask.metadata.geneway.workStatus, 'cancelled')
  assert.deepEqual(finalTask.artifacts, [])
  const oldAttempts = busyState.multisite.attempts.filter(row => row.work_id === workId)
  const attempts = finalState.multisite.attempts.filter(row => row.work_id === workId)
  assert.deepEqual(attempts.map(row => row.attempt_id).sort(), oldAttempts.map(row => row.attempt_id).sort())
  const office = attempts.find(row => row.agent_id === 'desktop-office')
  const officeJournal = journals.find(local => local.executions.some(row => sameBinding(row, office)))
  assert.ok(officeJournal)
  const job = officeJournal.jobs.find(row => row.id === busyJob.id)
  assert.equal(job.state, 'stopped')
  assert.equal(job.stopEvidence.workerExit, 'exit_confirmed'); assert.equal(job.stopEvidence.output, 'no_published_output')
  const stopped = []
  for (const attempt of attempts) {
    const previous = oldAttempts.find(row => row.attempt_id === attempt.attempt_id)
    assert.ok(['completed', 'cancelled'].includes(attempt.status))
    if (previous.status === 'completed') { assert.equal(attempt.status, 'completed'); continue }
    assert.equal(attempt.status, 'cancelled'); assert.ok(attempt.stoppedAt)
    const journal = journals.find(local => local.executions.some(row => sameBinding(row, attempt)))
    assert.ok(journal)
    const execution = journal.executions.find(row => sameBinding(row, attempt))
    assert.ok(['stopped', 'settled'].includes(execution.status)); assert.equal(execution.slotHeld, false)
    const receipts = stoppedReceipts(finalState, attempt)
    assert.equal(receipts.length, 1)
    const receipt = receipts[0], event = receipt.event
    assertSealed(event)
    assert.ok(['idle_after_cancel', 'never_started'].includes(event.stop_evidence))
    const local = journal.outbox.find(row => row.event.event_id === event.event_id)
    assert.ok(local); assert.deepEqual(local.event, event); assert.equal(local.acknowledged, true)
    assert.equal(receipt.ack.event_id, event.event_id); assert.equal(receipt.ack.payload_digest, event.payload_digest)
    assert.ok(sameBinding(receipt.ack, event))
    stopped.push({ eventId: event.event_id, payloadDigest: event.payload_digest, binding: binding(event) })
  }
  for (const result of busyState.multisite.results.filter(row => row.workId === workId)) assert.deepEqual(finalState.multisite.results.find(row => row.id === result.id), result)
  assert.deepEqual(finalState.evidence, busyState.evidence)
  assert.equal(finalState.artifacts.some(row => row.workId === workId && row.status === 'ready'), false)
  return { workId, originalJobId: busyJob.id, workerExit: assertWorkerExitObservation(workerBefore, workerAfter),
    acknowledgedStopped: stopped, originalResultsPreserved: true, allRelatedExecutionsStoppedOrPreviouslyCompleted: true,
    boundary: 'actual execution/Job stop and exactACK, not a requirement for idle official DSH parent processes to exit; no claim prior side effects were undone' }
}

export async function verifyCancellation(runRoot) {
  const root = resolve(runRoot), load = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
  const nav = await load('cancel-oracle-input.json')
  const [before, barrier, stopping, final] = await Promise.all([nav.cancelBefore, nav.cancelBarrier, nav.cancelStopping, nav.cancelFinal].map(load))
  assert.ok(Date.parse(barrier.at) <= Date.parse(stopping.at))
  assert.ok(Date.parse(stopping.at) < Date.parse(final.at))
  const intermediate = assertStoppingWhileHostBlocked({ busyState: before.state, stoppingState: stopping.state,
    beforeTask: before.task, cancelTask: stopping.cancel.task, independentlyQueriedTask: stopping.query.task,
    busyJob: before.heldWorker, workerBefore: before.workerIdentity, workerDuring: stopping.worker,
    hostBefore: barrier.parent, hostDuring: stopping.parent })
  assert.equal(barrier.worker.identity.pid, before.workerIdentity.pid)
  assert.equal(barrier.worker.identity.startTicks, before.workerIdentity.startTicks)
  const release = await load('business-entry/cancel/release-parent.json')
  assert.equal(release.signal, 'SIGCONT')
  assert.equal(release.identity.pid, barrier.parent.pid)
  assert.equal(release.identity.startTicks, barrier.parent.startTicks)
  assert.ok(Date.parse(stopping.at) <= Date.parse(release.at) && Date.parse(release.at) <= Date.parse(final.at))
  const after = final.workerAfter.identity ?? { ...final.workerAfter, reason: final.workerAfter.unavailableReason }
  const terminal = assertActualCancellation({ busyState: before.state, finalState: final.state, beforeTask: before.task,
    finalTask: final.task, journals: final.journals.map(row => row.journal), busyJob: before.heldWorker,
    workerBefore: before.workerIdentity, workerAfter: after })
  const base = join(nav.entryRoot, 'recovery')
  const [identityBefore, identityAfter, mappingBefore, mappingAfter, processBefore, queryAfter, offlineQuery, cloudBefore, cloudOffline, cloudAfter] = await Promise.all(
    ['identity-files-before.json', 'identity-files-after.json', 'before-mapping.json', 'after-mapping.json', 'before-processes.json', 'after-query.json', 'offline-query.json', 'before-cloud.json', 'offline-cloud.json', 'after-cloud.json'].map(name => load(join(base, name))))
  assert.deepEqual(mappingAfter, mappingBefore); assert.deepEqual(identityAfter, identityBefore)
  for (const file of identityAfter) assert.equal(createHash('sha256').update(await readFile(file.file)).digest('hex'), file.sha256)
  const events = (await readFile(join(root, nav.entryRoot, 'business-process-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const first = events.find(row => row.kind === 'ready' && row.generation === 1), next = events.find(row => row.kind === 'ready' && row.generation === 2)
  const kill = events.find(row => row.kind === 'signal' && row.signal === 'SIGKILL'), exit = events.find(row => row.kind === 'exit' && row.generation === 1)
  assert.equal(events.find(row => row.kind === 'start' && row.generation === 2).openExisting, true)
  assert.equal(exit.terminal.signal, 'SIGKILL'); assert.equal(exit.finalIdentity, null)
  assert.deepEqual(next.ready.peerConfig, first.ready.peerConfig)
  const restart = assertEntryProcessReplaced({ before: first.identity, after: next.identity, killedAt: kill.at, exitedAt: exit.terminal.at, signal: kill.signal,
    endpointBefore: first.ready.origin, endpointAfter: next.ready.origin, identityBefore, identityAfter })
  const recoveredTask = assertSameWaitingTask(processBefore.task, queryAfter.task)
  assertNoBusinessRecreated(cloudBefore, cloudOffline, recoveredTask.workId); assertNoBusinessRecreated(cloudBefore, cloudAfter, recoveredTask.workId)
  assert.ok(offlineQuery.error && offlineQuery.exitCode !== 0); assert.equal(offlineQuery.task, undefined)
  return { candidate: nav.candidate, case: 'cancel', intermediate, terminal, restart,
    boundary: 'read-only cancellation facts; restart/identity bytes/mapping and cancellation checked; protocol message cryptographic authentication is not independently reverified by this entrypoint' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await verifyCancellation(process.argv[2]), null, 2)) }
  catch (error) { console.error(error.stack); process.exitCode = 1 }
}
