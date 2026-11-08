import { isDeepStrictEqual } from 'node:util'
import { assertSealed, error, sameBinding } from '../agent-contracts/index.mjs'

export const isManualCommand = command => ['manual_pause', 'manual_release'].includes(command.operation)
const executionBinding = command => ({ ...command, session_id: command.session_id ?? `geneway-${command.launch_id}` })
export function manualCommand(command) {
  assertSealed(command)
  const value = command.parameters?.manualControl
  if (!isManualCommand(command) || !value || !Number.isSafeInteger(value.generation) || value.generation < 1 || !['work', 'agent'].includes(value.scope?.kind) || value.scope.kind === 'agent' && value.scope.agentId !== command.agent_id || command.input_id !== value.holderId || value.action !== (command.operation === 'manual_pause' ? 'pause' : 'resume') || typeof value.scopeId !== 'string' || typeof value.id !== 'string' || typeof value.pauseId !== 'string') throw error('FORBIDDEN', '人工控制身份无效')
  return value
}
export function manualRows(state, execution) {
  return state.inbox.filter(row => isManualCommand(row.command) && row.command.work_id === execution.work_id && (row.command.parameters.manualControl.scope.kind === 'work' || row.command.parameters.manualControl.scope.agentId === execution.agent_id))
}
export function localManualFence(state, execution) {
  const fence = { workGeneration: 0, agentGeneration: 0 }
  for (const row of manualRows(state, execution)) {
    const control = manualCommand(row.command), field = control.scope.kind === 'work' ? 'workGeneration' : 'agentGeneration'
    fence[field] = Math.max(fence[field], control.generation)
  }
  return fence
}
export function assertLocalManualFence(state, execution, captured) {
  if (!isDeepStrictEqual(captured, localManualFence(state, execution))) throw error('REVISION_CONFLICT', '人工控制已换代')
  assertLocalManualExecution(state, execution)
}
export function manualBlocked(state, execution) {
  const rows = manualRows(state, execution), latest = new Map()
  for (const row of rows) {
    const control = manualCommand(row.command), prior = latest.get(control.scopeId)
    if (!prior || manualCommand(prior.command).generation < control.generation) latest.set(control.scopeId, row)
  }
  // A different holder receiving its release cannot release this execution's pause.
  const ownPausePending = rows.some(row => row.command.operation === 'manual_pause' && exactManualExecution(row.command, execution) && !rows.some(release => {
    const pause = manualCommand(row.command), control = manualCommand(release.command)
    return release.command.operation === 'manual_release' && release.manualReleasedAt && exactManualExecution(release.command, execution) && control.scopeId === pause.scopeId && control.pauseId === pause.id && control.generation > pause.generation
  }))
  return ownPausePending || [...latest.values()].some(row => row.command.operation === 'manual_pause' || rows.some(item => item.command.parameters.manualControl.scopeId === row.command.parameters.manualControl.scopeId && item.command.parameters.manualControl.generation === row.command.parameters.manualControl.generation && exactManualExecution(item.command, execution) && !item.manualReleasedAt))
}
export function assertLocalManualExecution(state, execution) {
  if (manualBlocked(state, execution)) throw error('MANUALLY_PAUSED', '此执行正在人工暂停或等待安全解除')
}
export function exactManualExecution(command, execution) { return sameBinding(executionBinding(command), execution) }
// Accepted is not proof: only this durable launch fence excludes a queued Job.
export function safelyUnstartedJob(job) { return job.state === 'accepted' && job.launchState === 'not_started' && job.worker === null && !job.startedAt }
export function jobPauseEvidence(state, execution) {
  const result = []
  for (const job of state.jobs.filter(job => sameBinding(job, execution))) {
    if (safelyUnstartedJob(job)) result.push({ jobId: job.id, workerState: 'not_started' })
    else if (['candidate', 'failed', 'stopped'].includes(job.state) && (job.launchState === 'never_started' && !job.worker || job.workerExitConfirmedAt || job.stopEvidence?.workerExit === 'exit_confirmed')) result.push({ jobId: job.id, workerState: job.launchState === 'never_started' && !job.worker ? 'never_started' : 'exit_confirmed' })
    else return null
  }
  return result
}
export function validateHostManualControls(state) {
  const generations = new Map()
  for (const row of state.inbox.filter(row => isManualCommand(row.command))) {
    const value = manualCommand(row.command), id = `${value.scopeId}:${value.generation}:${value.holderId}`, previous = generations.get(id)
    if (previous && !isDeepStrictEqual(previous, row.command)) throw error('INVALID_STATE', '人工控制代次冲突')
    generations.set(id, row.command)
    if (row.manualIdleAt && row.command.operation !== 'manual_pause' || row.manualReleasedAt && row.command.operation !== 'manual_release') throw error('INVALID_STATE')
  }
}

export const validateManualInboxFacts = validateHostManualControls
export function assertManualInboxImmutable(before, after) {
  for (const row of before.inbox.filter(row => isManualCommand(row.command))) {
    const next = after.inbox.find(item => item.command.command_id === row.command.command_id)
    if (!next || !isDeepStrictEqual(row.command, next.command)) throw error('INVALID_STATE')
    for (const field of ['manualIdleAt', 'manualReleasedAt']) if (row[field] && row[field] !== next[field]) throw error('INVALID_STATE')
  }
}
