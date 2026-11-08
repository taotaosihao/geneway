import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, exact, key, sameBinding, seal, SCHEMA, text } from '../packages/agent-contracts/index.mjs'

export const emptyManualControlState = () => ({ manualControls: [] })
const terminalWork = work => ['completed', 'cancelled', 'failed', 'stopping'].includes(work.status)
const terminalAttempt = attempt => ['completed', 'cancelled'].includes(attempt.status)
const check = value => { if (!value) throw error('INVALID_STATE', '人工控制事实不闭合') }

export function assertManualControlOwner(state, work, actor) {
  const owner = state.members.find(row => row.id === actor?.id && row.enabled), root = state.employees.find(row => row.id === work.employeeId && row.enabled)
  if (!owner || owner.id !== work.ownerMemberId || !root || !owner.employeeIds.includes(root.id) || (root.revision ?? 1) !== work.coordinatorRevision) throw error('FORBIDDEN', '协调员工当前授权已变化')
  return owner
}

export function manualScope(value) {
  exact(value, ['kind', 'agentId'])
  if (!['work', 'agent'].includes(value.kind) || value.kind === 'work' && value.agentId !== undefined) throw error('INVALID_REQUEST')
  if (value.kind === 'agent') text(value.agentId)
  return value.kind === 'work' ? { kind: 'work' } : { kind: 'agent', agentId: value.agentId }
}
export const manualScopeId = (workId, scope) => key('manual-scope', workId, scope.kind, scope.agentId ?? '')
export function currentManualControl(state, workId, scope) {
  const id = manualScopeId(workId, scope)
  return (state.manualControls ?? []).filter(row => row.scopeId === id).reduce((latest, row) => !latest || row.generation > latest.generation ? row : latest, null)
}
export function relevantManualControls(state, execution) {
  return [{ kind: 'work' }, { kind: 'agent', agentId: execution.agent_id }].map(scope => currentManualControl(state, execution.work_id, scope)).filter(Boolean)
}
export function manualFence(state, execution) {
  return { workGeneration: currentManualControl(state, execution.work_id, { kind: 'work' })?.generation ?? 0, agentGeneration: currentManualControl(state, execution.work_id, { kind: 'agent', agentId: execution.agent_id })?.generation ?? 0 }
}
export function assertManualExecution(state, execution, capturedFence) {
  if (capturedFence !== undefined && !isDeepStrictEqual(capturedFence, manualFence(state, execution))) throw error('REVISION_CONFLICT', '人工控制已换代，请核对当前可继续事项')
  if (relevantManualControls(state, execution).some(row => row.action === 'pause')) throw error('MANUALLY_PAUSED', '此执行已请求人工暂停，等待用户明确解除')
  if (relevantManualControls(state, execution).some(row => row.action === 'resume' && row.holders.some(holder => sameBinding(holder.binding, { ...execution, session_id: execution.session_id ?? `geneway-${execution.launch_id}` }) && !holder.releasedAt))) throw error('MANUAL_RELEASE_PENDING', '人工暂停已解除，仍等待原执行安全确认')
}
export function assertManualConsumption(state, execution) {
  for (const control of relevantManualControls(state, execution).filter(row => row.action === 'resume')) {
    const holder = control.holders.find(row => sameBinding(row.binding, { ...execution, session_id: execution.session_id ?? `geneway-${execution.launch_id}` }))
    if (holder && !holder.resumeConsumedAt) throw error('MANUAL_RESUME_PENDING', '人工暂停已解除，仍须实际消费当前续行事项')
  }
}
export function assertManualJobAdmission(state, execution, jobIdentity) {
  if (jobIdentity !== undefined) {
    exact(jobIdentity, ['id', 'inputDigest'])
    const job = state.multisite.jobs.find(row => row.id === jobIdentity.id && row.inputDigest === jobIdentity.inputDigest && sameBinding(row, execution))
    if (job) return job
    // A newly accepted local Job can reach launch before its first cloud event.
    // It retains the full new-business gate; only an existing cloud Job skips it.
    const local = execution.id === jobIdentity.id && execution.input && digest(execution.input) === jobIdentity.inputDigest
    const prepared = state.multisite.commands.some(row => row.receiptKind === 'spreadsheet_prepared' && row.reply.jobId === jobIdentity.id && row.reply.inputDigest === jobIdentity.inputDigest && sameBinding(row.senderBinding, execution))
    if (!local && !prepared) throw error('FORBIDDEN', '既有生成任务身份不匹配')
    assertManualConsumption(state, execution); return
  }
  assertManualConsumption(state, execution)
}

// Dispatch and the UI consume the same current qualification. A past release/receipt
// alone cannot authorize another turn, including when another scope was paused later.
export function manualWakeQualification(state, execution, authorize, authorizeDelivery) {
  const blockedReasons = []
  try { assertManualExecution(state, execution); if (!authorize) throw error('CURRENT_AUTHORITY_UNCHECKED'); authorize(state, execution) } catch (cause) { blockedReasons.push(cause.code ?? 'FORBIDDEN') }
  const current = state.multisite.attempts.find(row => row.attempt_id === execution.attempt_id)
  if (!current || ['unknown', 'stopping', 'cancelled', 'completed'].includes(current.status)) blockedReasons.push('EXECUTION_NOT_RUNNABLE')
  if (['waiting_dependency', 'waiting_question', 'waiting_budget'].includes(current?.status)) blockedReasons.push(current.status.toUpperCase())
  if (state.intentQuestions?.some(row => row.state === 'open' && sameBinding(row.handlerBinding, execution)) || state.multisite.questions?.some(row => row.state === 'open' && row.senderBinding.attempt_id === execution.attempt_id)) blockedReasons.push('QUESTION_PENDING')
  if (state.multisite.dependencyWaits?.some(row => row.parentAttemptId === execution.attempt_id && row.instructionRevision === current?.instruction_revision && !row.wokenAt)) blockedReasons.push('DEPENDENCIES_PENDING')
  const pending = state.multisite.outbox.some(row => {
    if (row.acceptedAt || !sameBinding({ ...row.command, session_id: row.command.session_id ?? `geneway-${row.command.launch_id}` }, execution) || !['launch', 'deliver', 'wake', 'intent_review'].includes(row.command.operation)) return false
    try { if (!authorizeDelivery) return false; authorizeDelivery(state, row.command); return true } catch (cause) { if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'MODEL_NOT_CONFIGURED', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING', 'WAITING_BUDGET', 'EXECUTION_DEADLINE'].includes(cause.code)) return false; throw cause }
  })
  if (!pending) blockedReasons.push('NO_PENDING_DELIVERY')
  return { canWake: blockedReasons.length === 0, blockedReasons: [...new Set(blockedReasons)] }
}

function controlCommand(state, row, holder, attempt) {
  const operation = row.action === 'pause' ? 'manual_pause' : 'manual_release'
  const command = seal({ schema: SCHEMA, command_id: key(operation, row.id, holder.id), operation, workspace_id: row.workspaceId, ...holder.binding, input_id: holder.id, instruction_revision: attempt.instruction_revision, observed_revision: attempt.observed_revision, resource_refs: structuredClone(attempt.resource_refs), employee_revision: attempt.employeeRevision, parameters: { manualControl: { id: row.id, scopeId: row.scopeId, scope: row.scope, generation: row.generation, action: row.action, holderId: holder.id, pauseId: row.action === 'pause' ? row.id : row.pauseId } } })
  state.multisite.outbox.push({ id: command.command_id, command, createdAt: row.acceptedAt, acceptedAt: null }); holder.commandId = command.command_id
}

// Called inside the original user-command transaction, after its owner/root checks.
// A release is an explicit user fact; wake qualification is a separate consumer.
export function applyManualControl(state, work, actor, operation, parameters, at) {
  const scope = manualScope(parameters.scope)
  if (!Number.isSafeInteger(parameters.expectedControlGeneration) || parameters.expectedControlGeneration < 0) throw error('INVALID_REQUEST')
  if (terminalWork(work)) throw error('INVALID_STATE', '工作已结束，不能以人工恢复重开')
  if (scope.kind === 'agent' && (!actor.employeeIds.includes(scope.agentId) || !state.multisite.attempts.some(attempt => attempt.work_id === work.id && attempt.agent_id === scope.agentId))) throw error('FORBIDDEN')
  const previous = currentManualControl(state, work.id, scope)
  if ((previous?.generation ?? 0) !== parameters.expectedControlGeneration) throw error('REVISION_CONFLICT', '人工控制已变化，请刷新后重试')
  if (operation === 'pause' && previous?.action === 'pause' || operation === 'resume' && previous?.action !== 'pause') throw error('INVALID_STATE', operation === 'pause' ? '该范围已经请求暂停' : '该范围没有待解除的人工暂停')
  const row = { id: key('manual-control', work.id, manualScopeId(work.id, scope), (previous?.generation ?? 0) + 1), scopeId: manualScopeId(work.id, scope), workId: work.id, workspaceId: work.workspaceId, scope, generation: (previous?.generation ?? 0) + 1, action: operation === 'pause' ? 'pause' : 'resume', actorId: actor.id, acceptedAt: at, previousId: previous?.id ?? null, pauseId: operation === 'resume' ? previous.id : null, holders: [] }
  const attempts = state.multisite.attempts.filter(attempt => attempt.work_id === work.id && (scope.kind === 'work' || attempt.agent_id === scope.agentId) && !terminalAttempt(attempt) && state.multisite.delegations.some(delegation => delegation.id === attempt.delegation_id && delegation.currentAttemptId === attempt.attempt_id))
  if (operation === 'pause') {
    row.holders = attempts.map(attempt => ({ id: key('manual-holder', row.id, attempt.attempt_id), binding: { ...binding(attempt), session_id: attempt.session_id ?? `geneway-${attempt.launch_id}` }, commandId: null, idleAt: null, idleEvidence: null, jobEvidence: [], releasedAt: null, resumeCommandId: null, resumeConsumedAt: null }))
  } else {
    row.holders = previous.holders.map(holder => ({ id: key('manual-holder', row.id, holder.binding.attempt_id), binding: structuredClone(holder.binding), pauseHolderId: holder.id, commandId: null, releasedAt: null, resumeCommandId: null, resumeConsumedAt: null }))
  }
  state.manualControls.push(row)
  for (const holder of row.holders) {
    const attempt = attempts.find(attempt => attempt.attempt_id === holder.binding.attempt_id)
    if (attempt) controlCommand(state, row, holder, attempt)
  }
  return { workId: work.id, scope: row.scope, controlGeneration: row.generation, stage: operation === 'pause' ? row.holders.length ? 'pausing' : 'paused' : 'released', accepted: true, released: operation === 'resume', canWake: false, blockedReasons: operation === 'resume' ? ['WAITING_FOR_SAFE_CONTROL'] : ['MANUALLY_PAUSED'] }
}

export function manualCommandProof(state, command) {
  const value = command?.parameters.manualControl
  exact(value, ['id', 'scopeId', 'scope', 'generation', 'action', 'holderId', 'pauseId'])
  const original = state.multisite.outbox.find(row => row.id === command.command_id)?.command, row = state.manualControls.find(row => row.id === value.id), holder = row?.holders.find(holder => holder.id === value.holderId)
  if (!original || !isDeepStrictEqual(original, command) || !row || !holder || !sameBinding(holder.binding, command) || row.scopeId !== value.scopeId || !isDeepStrictEqual(row.scope, value.scope) || row.generation !== value.generation || row.action !== value.action || command.input_id !== holder.id || holder.commandId !== command.command_id || value.pauseId !== (row.action === 'pause' ? row.id : row.pauseId) || command.operation !== (row.action === 'pause' ? 'manual_pause' : 'manual_release')) throw error('FORBIDDEN', '人工控制身份或代次不匹配')
  return { control: row, holder }
}

export function currentManualCommand(state, command) {
  const proof = manualCommandProof(state, command), latest = currentManualControl(state, proof.control.workId, proof.control.scope)
  if (latest?.id !== proof.control.id && !(proof.control.action === 'pause' && latest?.action === 'resume' && latest.pauseId === proof.control.id)) throw error('REVISION_CONFLICT', '人工控制已换代')
  return proof
}

export function applyManualControlEvent(state, event, at, authorize) {
  const command = state.multisite.outbox.find(row => row.id === event.source_command_id)?.command
  if (!command || !sameBinding(command, event) || command.input_id !== event.input_id || command.instruction_revision !== event.instruction_revision || !isDeepStrictEqual(command.parameters.manualControl, event.manual_control)) throw error('FORBIDDEN')
  const proof = manualCommandProof(state, command), latest = currentManualControl(state, proof.control.workId, proof.control.scope)
  const active = latest?.id === proof.control.id || proof.control.action === 'pause' && latest?.action === 'resume' && latest.pauseId === proof.control.id
  if (!active) return { historical: true }
  authorize(state, command)
  if (event.kind === 'manual_idle') {
    if (command.operation !== 'manual_pause' || !['idle_and_flushed', 'never_started'].includes(event.idle_evidence) || !Array.isArray(event.job_pause_evidence)) throw error('FORBIDDEN')
    const jobs = state.multisite.jobs.filter(job => sameBinding(job, event))
    if (event.job_pause_evidence.length !== jobs.length || new Set(event.job_pause_evidence.map(row => row.jobId)).size !== jobs.length) throw error('FORBIDDEN')
    for (const job of jobs) {
      const evidence = event.job_pause_evidence.find(row => row.jobId === job.id)
      if (!evidence || !['not_started', 'never_started', 'exit_confirmed'].includes(evidence.workerState) || evidence.workerState === 'not_started' && job.state !== 'accepted' || ['never_started', 'exit_confirmed'].includes(evidence.workerState) && !['candidate', 'stopped', 'failed'].includes(job.state)) throw error('FORBIDDEN')
    }
    if (!proof.holder.idleAt) { proof.holder.idleAt = at; proof.holder.idleEvidence = event.idle_evidence; proof.holder.jobEvidence = structuredClone(event.job_pause_evidence) }
  } else if (event.kind === 'manual_released') {
    const pause = state.manualControls.find(row => row.id === proof.control.pauseId), holder = pause?.holders.find(row => row.id === proof.holder.pauseHolderId)
    if (command.operation !== 'manual_release' || !holder?.idleAt) throw error('FORBIDDEN')
    proof.holder.releasedAt ??= at
  } else throw error('INVALID_REQUEST')
  return { historical: false }
}

export function manualControlsProjection(state, work, actor, authorize, authorizeDelivery) {
  let admissionReason = null
  try { assertManualControlOwner(state, work, actor) } catch (cause) { admissionReason = cause.code ?? 'FORBIDDEN' }
  const agents = [...new Set(state.multisite.attempts.filter(attempt => attempt.work_id === work.id).map(attempt => attempt.agent_id))]
  return [{ kind: 'work' }, ...agents.map(agentId => ({ kind: 'agent', agentId }))].map(scope => {
    const control = currentManualControl(state, work.id, scope), generation = control?.generation ?? 0, paused = control?.action === 'pause', holders = control?.holders ?? [], uncertain = holders.some(holder => state.multisite.attempts.find(attempt => attempt.attempt_id === holder.binding.attempt_id)?.status === 'unknown')
    const stage = !control ? 'unpaused' : !paused ? 'released' : holders.every(holder => holder.idleAt) ? 'paused' : 'pausing'
    const authorized = !admissionReason && (scope.kind === 'work' || actor.employeeIds.includes(scope.agentId)), ended = terminalWork(work)
    const qualification = holders.map(holder => manualWakeQualification(state, holder.binding, authorize, authorizeDelivery))
    const related = scope.kind === 'work' ? (state.manualControls ?? []).filter(row => row.workId === work.id && currentManualControl(state, work.id, row.scope)?.id === row.id) : relevantManualControls(state, { work_id: work.id, agent_id: scope.agentId })
    const otherScopes = related.filter(row => row.scopeId !== manualScopeId(work.id, scope) && row.action === 'pause').map(row => ({ scope: row.scope, generation: row.generation, stage: row.holders.every(holder => holder.idleAt) ? 'paused' : 'pausing' }))
    return { scope, generation, stage, acceptedAt: control?.acceptedAt ?? null, uncertain, canPause: authorized && !ended && !paused, canResume: authorized && !ended && paused, disabledReason: !authorized ? 'FORBIDDEN' : ended ? 'WORK_ENDED' : null, released: control?.action === 'resume', canWake: control?.action === 'resume' && qualification.some(row => row.canWake), blockedReasons: paused ? ['MANUALLY_PAUSED'] : [...new Set(qualification.flatMap(row => row.blockedReasons))], otherScopes, holders: holders.map((holder, index) => ({ employeeId: holder.binding.agent_id, idleConfirmed: !!(holder.idleAt ?? state.manualControls.find(row => row.id === control.pauseId)?.holders.find(row => row.id === holder.pauseHolderId)?.idleAt), released: !!holder.releasedAt, resumeConsumed: !!holder.resumeConsumedAt, businessWait: state.multisite.attempts.find(row => row.attempt_id === holder.binding.attempt_id)?.status ?? null, blockedReasons: qualification[index].blockedReasons })) }
  })
}

export function validateManualControlState(state) {
  check(Array.isArray(state.manualControls) && state.manualControls.length <= 30000 && new Set(state.manualControls.map(row => row.id)).size === state.manualControls.length)
  check(new Set(state.manualControls.map(row => `${row.scopeId}:${row.generation}`)).size === state.manualControls.length)
  for (const row of state.manualControls) {
    manualScope(row.scope); check(state.works.some(work => work.id === row.workId && work.workspaceId === row.workspaceId) && row.scopeId === manualScopeId(row.workId, row.scope) && row.id === key('manual-control', row.workId, row.scopeId, row.generation) && Number.isSafeInteger(row.generation) && row.generation >= 1 && ['pause', 'resume'].includes(row.action) && state.members.some(member => member.id === row.actorId) && Number.isFinite(Date.parse(row.acceptedAt)))
    const previous = row.previousId && state.manualControls.find(control => control.id === row.previousId)
    check(row.generation === (previous?.generation ?? 0) + 1 && (!previous || previous.scopeId === row.scopeId) && (row.action === 'pause' ? row.pauseId === null : previous?.action === 'pause' && row.pauseId === previous.id))
    check(Array.isArray(row.holders) && new Set(row.holders.map(holder => holder.id)).size === row.holders.length)
    for (const holder of row.holders) {
      check(holder.id === key('manual-holder', row.id, holder.binding.attempt_id) && state.multisite.attempts.some(attempt => sameBinding({ ...binding(attempt), session_id: attempt.session_id ?? `geneway-${attempt.launch_id}` }, holder.binding)) && (row.scope.kind === 'work' || holder.binding.agent_id === row.scope.agentId))
      if (holder.commandId) manualCommandProof(state, state.multisite.outbox.find(item => item.id === holder.commandId)?.command)
      for (const field of ['idleAt', 'releasedAt', 'resumeConsumedAt']) if (holder[field] !== undefined && holder[field] !== null) check(Number.isFinite(Date.parse(holder[field])))
      if (row.action === 'pause') check(holder.idleAt ? ['idle_and_flushed', 'never_started'].includes(holder.idleEvidence) : holder.idleEvidence === null)
      else check(previous.holders.some(item => item.id === holder.pauseHolderId && sameBinding(item.binding, holder.binding)))
      if (holder.resumeCommandId) check(state.multisite.outbox.some(item => item.id === holder.resumeCommandId && sameBinding({ ...binding(item.command), session_id: item.command.session_id ?? `geneway-${item.command.launch_id}` }, holder.binding)))
    }
  }
  return state
}
export function assertManualControlImmutable(before, after) {
  for (const row of before.manualControls) {
    const next = after.manualControls.find(control => control.id === row.id), fixed = control => control && { ...control, holders: control.holders.map(holder => { const { idleAt, idleEvidence, jobEvidence, releasedAt, resumeCommandId, resumeConsumedAt, resumeFence, ...identity } = holder; return identity }) }
    check(isDeepStrictEqual(fixed(row), fixed(next)))
    for (const holder of row.holders) { const current = next.holders.find(item => item.id === holder.id); for (const field of ['idleAt', 'idleEvidence', 'releasedAt', 'resumeCommandId', 'resumeConsumedAt', 'resumeFence']) if (holder[field]) check(isDeepStrictEqual(holder[field], current[field])) }
    for (const holder of row.holders.filter(holder => holder.idleAt)) check(isDeepStrictEqual(holder.jobEvidence, next.holders.find(item => item.id === holder.id).jobEvidence))
  }
}
