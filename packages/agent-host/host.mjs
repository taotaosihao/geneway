import { isDeepStrictEqual } from 'node:util'
import { assertSealed, binding, BINDING_FIELDS, error, exact, key, sameBinding, SCHEMA, seal, attachmentRefs } from '../agent-contracts/index.mjs'
import { assertTerminalEventEnvelope } from '../agent-contracts/terminal-proof.mjs'
import { COMMAND_FETCH_LIMIT } from '../agent-contracts/command-bytes.mjs'
import { questionClosure, intentQuestionClosure } from '../agent-contracts/conversation.mjs'
import { manualCommand, assertLocalManualFence, isManualCommand, manualBlocked, assertLocalManualExecution, exactManualExecution, jobPauseEvidence, safelyUnstartedJob } from './manual-control.mjs'
import { messageId } from './delivery.mjs'

// At most eight queued items per supported active Loop, with a bounded budget
// for several maximum-size command envelopes. Hot history stays separately
// bounded; two cleanup items per Loop are reserved when no cohort can be archived.
export const HOST_INBOX_LIMITS = Object.freeze({ ordinaryCount: 256, ordinaryBytes: 16 * 1024 * 1024, controlCount: 64, controlBytes: 1024 * 1024, historyCount: 10_000, ordinaryHistoryCount: 9_936, commandBytes: COMMAND_FETCH_LIMIT })
const cleanupOperation = operation => operation === 'cancel' || operation === 'settle'
export function isPendingHostInboxRow(row) {
  return ['accepted', 'delivered'].includes(row.status) && !row.supersededAt && !row.controlConsumedAt && !row.manualIdleAt && !row.manualReleasedAt && !row.budgetIdleAt
}
export function hostInboxPressure(inbox) {
  if (!Array.isArray(inbox)) throw error('INVALID_STATE', 'Host Inbox 无效')
  const history = { count: inbox.length, bytes: 0 }, ordinary = { count: 0, bytes: 0 }, control = { count: 0, bytes: 0 }
  for (const row of inbox) {
    if (!row?.command || typeof row.command.operation !== 'string' || typeof row.status !== 'string') throw error('INVALID_STATE', 'Host Inbox 行无效')
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    history.bytes += bytes
    if (!isPendingHostInboxRow(row)) continue
    const pending = cleanupOperation(row.command.operation) ? control : ordinary
    pending.count++; pending.bytes += bytes
  }
  ordinary.remainingCount = Math.max(0, HOST_INBOX_LIMITS.ordinaryCount - ordinary.count)
  ordinary.remainingBytes = Math.max(0, HOST_INBOX_LIMITS.ordinaryBytes - ordinary.bytes)
  control.remainingCount = Math.max(0, HOST_INBOX_LIMITS.controlCount - control.count)
  control.remainingBytes = Math.max(0, HOST_INBOX_LIMITS.controlBytes - control.bytes)
  return { history, ordinary, control, limits: HOST_INBOX_LIMITS }
}
export function isOrdinaryInboxCapacityError(cause) {
  return cause?.code === 'CAPACITY_EXCEEDED' && cause.capacity?.domain === 'host-inbox' && cause.capacity.queue === 'ordinary'
}
export function isCloudOrdinaryCapacityError(cause) {
  return cause?.code === 'CAPACITY_EXCEEDED' && cause.capacity?.domain === 'cloud' && cause.capacity.queue === 'ordinary'
}
export function assertHostInboxAdmission(state, row) {
  const command = row.command, cleanup = cleanupOperation(command.operation)
  if (cleanup) {
    exact(command.parameters, command.operation === 'cancel' ? [] : ['artifactRefs'])
    const refs = command.parameters.artifactRefs
    if (refs !== undefined) {
      if (!Array.isArray(refs)) throw error('FORBIDDEN', '成果清理引用无效')
      for (const ref of refs) {
        exact(ref, ['artifactId', 'version', 'sha256'])
        if (typeof ref.artifactId !== 'string' || !ref.artifactId || !Number.isSafeInteger(ref.version) || ref.version < 1 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw error('FORBIDDEN', '成果清理引用无效')
      }
    }
    // Artifact publication uses its original input ID and artifactRefs; generic
    // settle uses null/{}. Both retain the same exact execution cleanup gate.
    if ((command.operation === 'cancel' ? command.input_id !== null : command.input_id !== null && (typeof command.input_id !== 'string' || !command.input_id)) || !Number.isSafeInteger(command.execution_epoch) || command.execution_epoch < 1 || BINDING_FIELDS.some(field => field !== 'execution_epoch' && !(['parent_delegation_id', 'session_id'].includes(field) && command[field] === null) && (typeof command[field] !== 'string' || !command[field]))) throw error('FORBIDDEN', '清理命令绑定无效')
    const execution = state.executions.find(item => item.launch_id === command.launch_id)
    const matches = source => sameBinding(command, source) || sameBinding(command, source, { firstSession: true })
    if (command.operation === 'settle' && (!execution || !sameBinding(command, execution)) || command.operation === 'cancel' && execution && !matches(execution)) throw error('FORBIDDEN', '清理命令绑定不匹配')
    // A trusted, sealed cancel can also calibrate never_started when its launch
    // was not admitted. Requiring a local execution would block that old path.
  }
  const pressure = hostInboxPressure(state.inbox), queue = cleanup ? 'control' : 'ordinary', pending = pressure[queue]
  const reject = reason => { throw Object.assign(error('CAPACITY_EXCEEDED', 'Host 队列容量不足，命令尚未受理'), { capacity: { domain: 'host-inbox', queue, reason, count: pending.count, bytes: pending.bytes } }) }
  if (Buffer.byteLength(JSON.stringify(command), 'utf8') > HOST_INBOX_LIMITS.commandBytes) reject('command_bytes')
  if (state.inbox.length >= (cleanup ? HOST_INBOX_LIMITS.historyCount : HOST_INBOX_LIMITS.ordinaryHistoryCount)) reject('history_count')
  if (pending.count + 1 > HOST_INBOX_LIMITS[queue + 'Count']) reject('pending_count')
  if (pending.bytes + Buffer.byteLength(JSON.stringify(row), 'utf8') > HOST_INBOX_LIMITS[queue + 'Bytes']) reject('pending_bytes')
}

export function createAgentHost({ nodeId, workspaceId = 'local', journal, runtime, jobs, evidence, uploadCandidates, clock = () => new Date().toISOString(), maxActiveLoops = 8 }) {
  let processing, closing = false, orchestration
  if (!Number.isSafeInteger(maxActiveLoops) || maxActiveLoops < 1 || maxActiveLoops > 32) throw error('INVALID_REQUEST')
  const calibrated = new Set()
  function eventFor(execution, kind, command, extra = {}) {
    return seal({ schema: SCHEMA, event_id: key('event', nodeId, command.command_id, kind), workspace_id: workspaceId,
      kind, ...binding(execution), input_id: command.input_id, instruction_revision: command.instruction_revision,
      observed_revision: kind === 'session_ingested' ? command.instruction_revision : command.observed_revision,
      resource_refs: command.resource_refs, ...extra })
  }
  function releasedBy(row, execution, kind, id) {
    try { assertSealed(row.command); return row.command.operation === 'wake' && sameBinding(row.command, execution) && row.command.parameters.waitRelease?.kind === kind && row.command.parameters.waitRelease?.id === id } catch { return false }
  }
  // Journal commit also resolves newly appended IDs against complete cold rows.
  function append(state, event) {
    if (['stopped', 'settled'].includes(event.kind)) assertTerminalEventEnvelope(event)
    const previous = state.outbox.find(row => row.event.event_id === event.event_id)
    if (previous && previous.event.payload_digest !== event.payload_digest) throw error('IDEMPOTENCY_CONFLICT')
    if (!previous) state.outbox.push({ event, acknowledged: false })
  }
  // Both the row and its receipts advance in one Host transaction; retries never downgrade ingestion.
  function mergeDelivery(state, command, execution, status) {
    const current = state.executions.find(item => item.launch_id === execution.launch_id)
    const row = state.inbox.find(item => item.command.command_id === command.command_id)
    if (!current || !row || !sameBinding(current, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT', '执行已变化')
    if (!status.delivered) return
    delete row.lastError
    if (row.status === 'accepted') {
      append(state, eventFor(current, command.operation === 'intent_review' ? 'intent_delivered' : command.operation === 'wake' ? 'message_delivered' : 'session_delivered', command, command.operation === 'intent_review' ? { source_command_id: command.command_id, intent_fence: command.parameters.intentFence } : {})); row.status = 'delivered'
    }
    if (status.ingested && row.status !== 'ingested') {
      append(state, eventFor(current, command.operation === 'intent_review' ? 'intent_ingested' : command.operation === 'wake' ? 'message_ingested' : 'session_ingested', command, command.operation === 'intent_review' ? { source_command_id: command.command_id, intent_fence: command.parameters.intentFence } : {})); row.status = 'ingested'
      if (!['wake','intent_review'].includes(command.operation)) current.observed_revision = Math.max(current.observed_revision, command.instruction_revision)
    }
  }
  async function report(launchId, report) {
    const snapshot = await journal.read(), execution = snapshot.executions.find(item => item.launch_id === launchId)
    if (execution) assertLocalManualExecution(snapshot, execution)
    if (!execution || !execution.runtimeStarted || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status)) throw error('REVISION_CONFLICT', '执行已变化')
    const candidates = snapshot.inbox.filter(row => row.command.launch_id === launchId && row.command.input_id !== null && row.command.operation !== 'wake')
    const ids = candidates.map(row => messageId(row.command.input_id, row.command.attempt_id, execution.session_id))
    // Read/flush only: inspection cannot start a Loop, redeliver input, or wait for the reporting tool itself.
    const facts = await runtime.inspectInputs(execution, ids)
    await journal.update(state => {
      const current = state.executions.find(item => item.launch_id === launchId)
      if (!current || !sameBinding(current, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT', '执行已变化')
      const consumed = []
      for (let index = 0; index < candidates.length; index++) {
        const fact = facts.find(value => value.id === ids[index])
        if (!fact?.ingested) continue
        const command = candidates[index].command
        mergeDelivery(state, command, current, fact)
        consumed.push(command)
      }
      const input = consumed.sort((left, right) => right.instruction_revision - left.instruction_revision)[0]
      if (!input) throw error('REVISION_CONFLICT', '执行尚未消费当前输入')
      const command = { ...input, command_id: key('report', launchId, input.input_id, JSON.stringify(report)) }
      append(state, eventFor(current, 'report', command, { report, observed_revision: input.instruction_revision }))
      if (report.state === 'waiting' && runtime.inspectState) current.waitStatus = 'waiting_input'
    })
  }
  async function spreadsheetTool(execution, operation, parameters) {
    if (!jobs) throw error('FORBIDDEN', '本 Host 未配置整改表能力')
    if (operation === 'read_evidence') return jobs.readEvidence(execution, parameters)
    if (operation === 'get_spreadsheet_job') return jobs.get(execution, parameters)
    if (operation !== 'start_spreadsheet') throw error('INVALID_REQUEST')
    const snapshot = await journal.read(), current = snapshot.executions.find(row => row.launch_id === execution.launch_id)
    assertLocalManualExecution(snapshot, execution)
    if (!current || !current.runtimeStarted || !sameBinding(current, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT')
    const candidates = snapshot.inbox.filter(row => row.command.launch_id === execution.launch_id && row.command.input_id !== null && row.command.operation !== 'wake')
    const ids = candidates.map(row => messageId(row.command.input_id, row.command.attempt_id, execution.session_id)), facts = await runtime.inspectInputs(execution, ids)
    return jobs.start(execution, parameters, { beforeAccept(state) {
      const current = state.executions.find(row => row.launch_id === execution.launch_id)
      if (!current || !sameBinding(current, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT')
      let consumed = false
      for (let index = 0; index < candidates.length; index++) {
        const fact = facts.find(value => value.id === ids[index]); if (!fact?.ingested) continue
        mergeDelivery(state, candidates[index].command, current, fact)
        if (candidates[index].command.instruction_revision === parameters.instructionRevision) consumed = true
      }
      if (!consumed) throw error('REVISION_CONFLICT', '生成请求尚未消费对应用户输入')
    } })
  }
  const terminalProofPasses = new WeakSet()
  async function flushTerminalProofs(send, cause) {
    if (!isCloudOrdinaryCapacityError(cause) || terminalProofPasses.has(cause)) return
    terminalProofPasses.add(cause)
    const snapshot = await journal.read()
    const proofs = snapshot.outbox.filter(row => !row.acknowledged && ['stopped', 'settled'].includes(row.event.kind)).slice(0, 16)
    for (const { event } of proofs) {
      assertTerminalEventEnvelope(event)
      const operation = event.kind === 'stopped' ? 'cancel' : 'settle', evidenceField = event.kind === 'stopped' ? 'stop_evidence' : 'settle_evidence', jobsField = event.kind === 'stopped' ? 'job_stop_evidence' : 'job_settle_evidence'
      const commandRow = snapshot.inbox.find(row => row.command.operation === operation && event.event_id === key('event', nodeId, row.command.command_id, event.kind))
      if (!commandRow || commandRow.status !== event.kind) throw error('FORBIDDEN', '终止证明缺少原受理控制命令')
      const command = commandRow.command; assertSealed(command)
      const neverStarted = event[evidenceField] === 'never_started'
      if (!['idle_after_cancel', 'never_started'].includes(event[evidenceField]) || !sameBinding(command, event) && !(command.session_id === null && sameBinding(command, event, { firstSession: true }))) throw error('FORBIDDEN', '终止证明绑定无效')
      const execution = snapshot.executions.find(row => row.launch_id === event.launch_id)
      const matchesExecution = execution && (sameBinding(execution, event) || neverStarted && event.session_id === command.session_id && BINDING_FIELDS.every(field => field === 'session_id' || execution[field] === event[field]))
      if (!matchesExecution || execution.status !== event.kind || execution.slotHeld !== false) throw error('FORBIDDEN', '终止证明尚未停稳')
      const expected = eventFor(event, event.kind, command, { [evidenceField]: event[evidenceField], ...(Object.hasOwn(event, jobsField) ? { [jobsField]: event[jobsField] } : {}) })
      if (!isDeepStrictEqual(event, expected)) throw error('FORBIDDEN', '终止证明原封包不匹配')
      const ack = await send(event)
      if (ack.node_id !== nodeId || ack.event_id !== event.event_id || ack.payload_digest !== event.payload_digest || !sameBinding(ack, event)) throw error('FORBIDDEN', '回执 ACK 不匹配')
      await journal.update(state => { const row = state.outbox.find(item => item.event.event_id === event.event_id); if (!row || row.event.payload_digest !== event.payload_digest) throw error('IDEMPOTENCY_CONFLICT'); row.acknowledged = true })
    }
  }
  async function flushReceipts(send, { cleanupOnly = false } = {}) {
    for (const row of (await journal.read()).outbox.filter(item => !item.acknowledged)) {
      const event = row.event
      let ack
      try { ack = await send(event) } catch (cause) {
        if (isCloudOrdinaryCapacityError(cause)) { await flushTerminalProofs(send, cause); throw cause }
        const local = cause.code === 'FORBIDDEN' ? await journal.read() : null
        const stoppedJob = event.kind === 'spreadsheet_job' && local?.executions.some(execution => sameBinding(execution, event) && ['stopped', 'settled'].includes(execution.status)) && local.outbox.some(row => sameBinding(row.event, event) && ['stopped', 'settled'].includes(row.event.kind) && (row.event.job_stop_evidence ?? row.event.job_settle_evidence ?? []).some(item => item.jobId === event.job.id && ['exit_confirmed', 'never_started'].includes(item.workerExit)))
        const terminalCleanup = event.kind !== 'spreadsheet_job' && local?.executions.some(execution => sameBinding(execution, event) && ['stopped', 'settled'].includes(execution.status)) && local.outbox.some(row => sameBinding(row.event, event) && (row.event.kind === 'stopped' && ['idle_after_cancel', 'never_started'].includes(row.event.stop_evidence) || row.event.kind === 'settled' && ['idle_after_cancel', 'never_started'].includes(row.event.settle_evidence)))
        if ((cleanupOnly || stoppedJob || terminalCleanup) && cause.code === 'FORBIDDEN' && !['stopped', 'settled'].includes(event.kind)) continue
        throw cause
      }
      if (ack.node_id !== nodeId || ack.event_id !== event.event_id || ack.payload_digest !== event.payload_digest || !sameBinding(ack, event)) throw error('FORBIDDEN', '回执 ACK 不匹配')
      await journal.update(state => { state.outbox.find(item => item.event.event_id === event.event_id).acknowledged = true })
    }
  }
  async function synchronizeInputs(execution, { instructionRevision, inputMessageId } = {}) {
    const snapshot = await journal.read(), current = snapshot.executions.find(row => row.launch_id === execution.launch_id)
    assertLocalManualExecution(snapshot, execution)
    if (!orchestration || !current || !current.runtimeStarted || !sameBinding(current, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT')
    const candidates = snapshot.inbox.filter(row => row.command.launch_id === execution.launch_id && row.command.input_id !== null && !row.controlConsumedAt)
    const ids = candidates.map(row => messageId(row.command.input_id, execution.attempt_id, execution.session_id)), facts = await runtime.inspectInputs(execution, ids)
    await journal.update(state => {
      const active = state.executions.find(row => row.launch_id === execution.launch_id)
      if (!active || !sameBinding(active, execution) || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(active.status)) throw error('REVISION_CONFLICT')
      let consumed = false
      for (let i = 0; i < candidates.length; i++) if (facts[i]?.ingested) {
        mergeDelivery(state, candidates[i].command, active, facts[i])
        if (inputMessageId !== undefined ? ids[i] === inputMessageId : !['wake','intent_review'].includes(candidates[i].command.operation) && candidates[i].command.instruction_revision === instructionRevision) consumed = true
      }
      if (!consumed) throw error('REVISION_CONFLICT', '尚未消费当前用户要求')
    })
    await flushReceipts(orchestration.event)
  }
  async function orchestrationTool(execution, operation, parameters, context = {}) {
    const snapshot = await journal.read(), current = snapshot.executions.find(row => row.launch_id === execution.launch_id)
    if (!current || !sameBinding(current, execution)) throw error('FORBIDDEN')
    if (operation === 'assertManualFence') { assertLocalManualFence(snapshot, execution, parameters?.manualFence); return { authorized: true } }
    if (operation !== 'confirmPark') assertLocalManualExecution(snapshot, execution)
    if (operation === 'synchronizeIntent') {
      const command=snapshot.inbox.find(row=>row.command.command_id===parameters.commandId&&row.command.operation==='intent_review'&&sameBinding({...binding(row.command),session_id:row.command.session_id??`geneway-${row.command.launch_id}`},execution))?.command
      if(!command)throw error('FORBIDDEN')
      await synchronizeInputs(execution,{inputMessageId:messageId(command.input_id,execution.attempt_id,execution.session_id)});return{synchronized:true}
    }
    if(['intent_context','reply_intent','split_intent'].includes(operation)&&!parameters.intentFence){if(!orchestration)throw error('FORBIDDEN');await synchronizeInputs(execution,{instructionRevision:current.observed_revision});return orchestration.call(execution,operation,parameters,context)}
    if(['intent_context','accept_intent','handback_intent','ask_intent','reply_intent'].includes(operation)){
      const command=snapshot.inbox.find(row=>row.command.operation==='intent_review'&&sameBinding({...binding(row.command),session_id:row.command.session_id??`geneway-${row.command.launch_id}`},execution)&&isDeepStrictEqual(row.command.parameters.intentFence,parameters.intentFence))?.command
      if(!command||!orchestration)throw error('FORBIDDEN')
      await synchronizeInputs(execution,{inputMessageId:messageId(command.input_id,execution.attempt_id,execution.session_id)})
      const reply=await orchestration.call(execution,operation,parameters,context)
      if(['waiting_intent','handed_back','accepted'].includes(reply.status))await journal.update(state=>{const active=state.executions.find(row=>sameBinding(row,execution));active.waitStatus=reply.status==='waiting_intent'?'waiting_intent':'waiting_input';active.waitId=reply.questionId??null})
      return reply
    }
    if (operation === 'synchronizeBudgetResume') {
      const command = snapshot.inbox.find(row => row.command.command_id === parameters.commandId && sameBinding(row.command, execution) && row.command.parameters.messages?.[0]?.kind === 'budget_resume')?.command
      if (!command) throw error('FORBIDDEN')
      await synchronizeInputs(execution, { instructionRevision: command.instruction_revision }); return { synchronized: true }
    }
    if (operation === 'confirmPark') { if (parameters?.manualOnly) return manualBlocked(snapshot, execution); if (manualBlocked(snapshot, execution)) return true }
    assertLocalManualExecution(snapshot, execution)
    if (operation === 'confirmPark') return ['waiting_dependency', 'waiting_question', 'waiting_budget', 'waiting_intent', 'waiting_input', 'completed'].includes(current.waitStatus)
    if (!orchestration || !current.runtimeStarted || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(current.status)) throw error('REVISION_CONFLICT')
    await synchronizeInputs(execution, { instructionRevision: parameters.instructionRevision })
    const reply = await orchestration.call(execution, operation, parameters, context)
    let satisfied = false, closed = false
    if (operation === 'ask_agent' && reply.status === 'waiting_question' || operation === 'wait_dependencies' && reply.status === 'waiting_dependency' || ['complete_delegation', 'review_spreadsheet_candidate'].includes(operation) && reply.status === 'completed') await journal.update(state => {
      const active = state.executions.find(row => row.launch_id === execution.launch_id)
      if (!active || !sameBinding(active, execution)) throw error('REVISION_CONFLICT')
      const kind = operation === 'ask_agent' ? 'question' : operation === 'wait_dependencies' ? 'dependency' : null, waitId = reply.waitId ?? reply.questionId
      if (kind && state.inbox.some(row => row.status === 'ingested' && releasedBy(row, execution, kind, waitId))) { satisfied = true; return }
      if (kind === 'question' && state.inbox.some(row => { if (!row.controlConsumedAt || !releasedBy(row, execution, kind, waitId)) return false; try { return questionClosure(row.command).replyTo === waitId } catch { return false } })) { closed = true; return }
      active.waitStatus = operation === 'wait_dependencies' ? 'waiting_dependency' : operation === 'ask_agent' ? 'waiting_question' : 'completed'
      active.waitId = reply.waitId ?? reply.questionId ?? null
    })
    return closed ? { ...reply, status: 'closed' } : satisfied ? { ...reply, status: 'already_satisfied' } : reply
  }
  async function recoverCandidate(execution) {
    if (!jobs) return false
    const state = await journal.read(), latest = Math.max(0, ...state.inbox.filter(row => row.command.launch_id === execution.launch_id && row.command.operation !== 'settle').map(row => row.command.instruction_revision))
    const job = state.jobs.find(row => sameBinding(row, execution) && row.state === 'candidate' && row.instructionRevision === latest)
    if (!job) return false
    // A sealed, complete output is recoverable without resuming the model Session.
    await jobs.readCandidate(job.id)
    return true
  }
  runtime.setOrchestrationHandler?.(orchestrationTool)
  runtime.setEvidenceHandler?.(async (execution, operation, parameters) => {
    if (!evidence) throw error('FORBIDDEN')
    try {
      const current = (await journal.read()).executions.find(row => sameBinding(row, execution))
      const revision = operation === 'read_shared_evidence' ? current?.observed_revision : parameters.instructionRevision
      await synchronizeInputs(execution, { instructionRevision: revision })
      return await evidence.call(execution, operation, parameters, revision)
    } catch (cause) {
      // Native filesystem errors can contain the parent's private profile paths.
      throw error(cause.code ?? 'EVIDENCE_UNAVAILABLE', cause.code === 'CAPTURE_NOT_SEALED' ? '该采集请求未完成封存；请使用新的采集请求重新读取。' : '受控证据请求无法完成')
    }
  })
  runtime.setSpreadsheetHandler?.(spreadsheetTool)
  runtime.setReporter?.(report)
  async function processManualControls(failures) {
    for (const pending of (await journal.read()).inbox.filter(row => isManualCommand(row.command))) {
      const command = pending.command, control = manualCommand(command)
      const snapshot = await journal.read(), execution = snapshot.executions.find(row => exactManualExecution(command, row))
      if (command.operation === 'manual_release') {
        if (pending.manualReleasedAt) continue
        const pause = snapshot.inbox.find(row => row.command.operation === 'manual_pause' && exactManualExecution(row.command, command) && row.command.parameters.manualControl.id === control.pauseId)
        if (!pause?.manualIdleAt) continue
        await journal.update(state => { const row = state.inbox.find(row => row.command.command_id === command.command_id); row.manualReleasedAt = clock(); row.status = 'manual_released'; append(state, eventFor(command, 'manual_released', command, { source_command_id: command.command_id, manual_control: control })) })
        continue
      }
      if (pending.manualIdleAt || execution && ['unknown', 'stopping', 'stopped', 'settling', 'settled'].includes(execution.status)) continue
      try {
        let idleEvidence = 'never_started'
        if (execution && !execution.runtimeStarted && execution.runtimeLaunchReservedAt) {
          await journal.update(state => { const current = state.executions.find(row => sameBinding(row, execution)); current.status = 'unknown'; current.slotHeld = false; current.unavailableReason = 'RUNTIME_LAUNCH_UNCONFIRMED'; append(state, eventFor(current, 'runtime_unavailable', command, { reason: current.unavailableReason })) }); continue
        }
        if (execution?.runtimeStarted) { await runtime.park?.(execution); if (!(await runtime.inspectState?.(execution))?.idle) continue; idleEvidence = 'idle_and_flushed' }
        const fresh = await journal.read(), jobEvidence = jobPauseEvidence(fresh, execution ?? command)
        if (!jobEvidence) continue
        if (orchestration && fresh.outbox.some(row => !row.acknowledged && row.event.kind === 'spreadsheet_job' && sameBinding(row.event, execution ?? command))) await flushReceipts(orchestration.event)
        await journal.update(state => {
          const row = state.inbox.find(row => row.command.command_id === command.command_id), current = state.executions.find(row => exactManualExecution(command, row))
          if (current && ['unknown', 'stopping', 'stopped', 'settling', 'settled'].includes(current.status) || !jobPauseEvidence(state, current ?? command)) return
          row.manualIdleAt = clock(); row.status = 'manual_idle'
          if (current) { current.slotHeld = false; current.yieldedAt = row.manualIdleAt }
          append(state, eventFor(command, 'manual_idle', command, { source_command_id: command.command_id, manual_control: control, idle_evidence: idleEvidence, job_pause_evidence: jobEvidence }))
        })
      } catch (cause) { if (cause.code === 'RUNTIME_PROCESS_DIED' && execution) await journal.update(state => { const current = state.executions.find(row => sameBinding(row, execution)); current.status = 'unknown'; current.slotHeld = false; append(state, eventFor(current, 'runtime_unavailable', command, { reason: cause.code })) }); else failures.push(cause) }
    }
  }
  async function processInbox() {
    const failures = []
    await processManualControls(failures)
    for (const pending of (await journal.read()).inbox.filter(row => row.command.operation === 'budget_wait' && row.status === 'accepted')) {
      const command = pending.command, control = command.parameters.budgetHold
      if (!control || command.input_id !== control.id) throw error('FORBIDDEN')
      const execution = (await journal.read()).executions.find(row => sameBinding(row, command))
      if (!execution || ['stopping', 'stopped', 'unknown', 'settled', 'settling'].includes(execution.status)) continue
      await journal.update(state => { const active = state.executions.find(row => sameBinding(row, command)); active.waitStatus = 'waiting_budget'; active.waitId = control.id })
      let idle
      try { await runtime.park?.(execution); idle = (await runtime.inspectState?.(execution))?.idle } catch (cause) {
        if (cause.code === 'RUNTIME_PROCESS_DIED') await journal.update(state => { const active = state.executions.find(row => sameBinding(row, command)); active.status = 'unknown'; active.slotHeld = false; append(state, eventFor(active, 'runtime_unavailable', command, { reason: cause.code })) })
        else failures.push(cause)
        continue
      }
      if (!idle) continue
      if (jobs && (await journal.read()).jobs.some(row => row.launch_id === execution.launch_id && !['candidate', 'stopped', 'failed'].includes(row.state) && !safelyUnstartedJob(row))) continue
      await journal.update(state => {
        const active = state.executions.find(row => sameBinding(row, command)), row = state.inbox.find(row => row.command.command_id === command.command_id)
        row.status = 'budget_idle'; row.budgetIdleAt = clock(); active.slotHeld = false; active.yieldedAt = row.budgetIdleAt
        append(state, eventFor(active, 'budget_idle', command, { budget_hold_id: control.id, source_command_id: command.command_id, idle_evidence: 'idle_and_flushed' }))
      })
    }
    for (const execution of (await journal.read()).executions.filter(row => row.slotHeld && row.waitStatus && row.waitStatus !== 'waiting_budget')) {
      try {
        if (jobs && (await journal.read()).jobs.some(row => row.launch_id === execution.launch_id && !['candidate', 'stopped', 'failed'].includes(row.state) && !safelyUnstartedJob(row))) continue
        if ((await runtime.inspectState?.(execution))?.idle) await journal.update(state => { const row = state.executions.find(row => row.launch_id === execution.launch_id); row.slotHeld = false; row.yieldedAt = clock() })
      } catch (cause) { failures.push(cause) }
    }
    for (const pending of (await journal.read()).inbox.filter(row => row.status === 'accepted' && row.command.parameters.messages?.some(message => message.kind === 'question_closed'))) {
      const command = pending.command, message = questionClosure(command)
      const execution = (await journal.read()).executions.find(row => sameBinding(row, command))
      if (!execution || ['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status)) continue
      if (execution.slotHeld && execution.waitStatus === 'waiting_question' && execution.waitId === message.replyTo) continue
      await journal.update(state => {
        const active = state.executions.find(row => sameBinding(row, command)), row = state.inbox.find(row => row.command.command_id === command.command_id)
        if (!active || row.controlConsumedAt) return
        const at = clock(); row.controlConsumedAt = at; row.status = 'control_consumed'
        if (active.waitStatus === 'waiting_question' && active.waitId === message.replyTo) { delete active.waitStatus; delete active.waitId }
        append(state, eventFor(active, 'control_consumed', command, { source_command_id: command.command_id, control_message_id: message.id }))
      })
    }
    for(const pending of(await journal.read()).inbox.filter(row=>row.status==='accepted'&&row.command.operation==='intent_question_closed')){
      const command=pending.command,value=intentQuestionClosure(command),execution=(await journal.read()).executions.find(row=>sameBinding(row,command))
      if(!execution||['stopping','stopped','unknown','settling','settled'].includes(execution.status))continue
      if(execution.slotHeld&&!(await runtime.inspectState?.(execution))?.idle)continue
      await journal.update(state=>{const active=state.executions.find(row=>sameBinding(row,command)),row=state.inbox.find(row=>row.command.command_id===command.command_id);if(!active||row.controlConsumedAt)return;row.controlConsumedAt=clock();row.status='control_consumed';if(active.waitStatus==='waiting_intent'&&active.waitId===value.questionId){delete active.waitStatus;delete active.waitId}append(state,eventFor(active,'intent_control_consumed',command,{source_command_id:command.command_id,control_question_id:value.questionId}))})
    }
    const needsAttachmentRuntime = command => attachmentRefs(command.parameters.attachmentRefs).length > 0 && runtime.supportsAttachments !== true
    for (const row of (await journal.read()).inbox.filter(item => item.command.operation === 'settle' && item.status !== 'settled')) {
      try {
        const command = row.command, execution = (await journal.read()).executions.find(item => item.launch_id === command.launch_id)
        if (!execution || !sameBinding(execution, command)) throw error('FORBIDDEN', '成果清理绑定不匹配')
        if (execution.waitStatus === 'completed' && execution.slotHeld) continue
        await journal.update(state => { state.executions.find(item => item.launch_id === command.launch_id).status = 'settling' })
        const jobEvidence = jobs ? await jobs.settleExecution(execution) : []
        const result = runtime.settle ? await runtime.settle(execution) : await runtime.stop(execution)
        if (!['idle_after_cancel', 'never_started'].includes(result.evidence)) throw error('INVALID_STATE', '成果清理证据无效')
        await journal.update(state => {
          const current = state.executions.find(item => item.launch_id === command.launch_id)
          append(state, eventFor(current, 'settled', command, { settle_evidence: result.evidence, job_settle_evidence: jobEvidence }))
          current.status = 'settled'; current.slotHeld = false
          for (const pending of state.inbox.filter(item => item.command.launch_id === command.launch_id)) pending.status = 'settled'
        })
      } catch (cause) { failures.push(cause) }
    }
    // A durable stop must not wait behind an input whose ordinary run permission was revoked.
    for (const row of (await journal.read()).inbox.filter(item => item.command.operation === 'cancel' && item.status !== 'stopped')) {
      try {
        const command = row.command
        const execution = (await journal.read()).executions.find(item => item.launch_id === command.launch_id)
        if (execution && !['stopping', 'stopped'].includes(execution.status)) await journal.update(state => { const current = state.executions.find(item => item.launch_id === execution.launch_id); if (current.status !== 'stopped') current.status = 'stopping' })
        const jobStopEvidence = jobs ? await jobs.stopExecution(execution ?? command) : []
        let stopped = execution, evidence = 'never_started'
        if (execution?.runtimeStarted) {
          await journal.update(state => { state.executions.find(item => item.launch_id === execution.launch_id).status = 'stopping' })
          const result = await runtime.stop(execution)
          evidence = result.evidence
        } else if (execution) {
          const result = await runtime.stop(execution)
          evidence = result.evidence
          if (evidence === 'never_started') stopped = { ...execution, session_id: command.session_id }
        } else stopped = { ...binding(command), status: 'stopped', runtimeStarted: false, observed_revision: 0 }
        if (!['idle_after_cancel', 'never_started'].includes(evidence)) throw error('INVALID_STATE', '停止证据无效')
        await journal.update(state => {
          let current = state.executions.find(item => item.launch_id === command.launch_id)
          if (!current) { current = stopped; state.executions.push(current) }
          append(state, eventFor(stopped, 'stopped', command, { stop_evidence: evidence, ...(jobs ? { job_stop_evidence: jobStopEvidence } : {}) }))
          current.status = 'stopped'; current.slotHeld = false
          for (const pending of state.inbox.filter(item => item.command.launch_id === command.launch_id)) pending.status = 'stopped'
        })
      } catch (cause) { failures.push(cause) }
    }
    for (const execution of (await journal.read()).executions.filter(item => item.runtimeStarted && item.slotHeld !== false && ['accepted', 'running'].includes(item.status))) {
      try { if (!await recoverCandidate(execution)) await runtime.checkExecution?.(execution) } catch (cause) {
        const command = (await journal.read()).inbox.find(row => row.command.launch_id === execution.launch_id)?.command
        await journal.update(state => {
          const current = state.executions.find(item => item.launch_id === execution.launch_id)
          if (['stopping', 'stopped'].includes(current.status)) return
          current.status = 'unknown'; current.unavailableReason = cause.code ?? 'RUNTIME_UNAVAILABLE'
          append(state, eventFor(current, 'runtime_unavailable', command, { reason: current.unavailableReason }))
        })
      }
    }
    if (jobs && orchestration) { const snapshot = await journal.read(); if (snapshot.jobs.some(job => job.state === 'accepted' && job.input.sourceManifest?.schema === 'geneway.spreadsheet-source-manifest/1' && snapshot.outbox.some(row => !row.acknowledged && row.event.kind === 'spreadsheet_job' && row.event.job.id === job.id))) await flushReceipts(orchestration.event) }
    await jobs?.process()
    // Active execution recovery is independent of whether every old input was already consumed.
    for (const execution of (await journal.read()).executions.filter(item => item.runtimeStarted && item.slotHeld !== false && ['accepted', 'running'].includes(item.status) && !calibrated.has(item.launch_id))) {
      try {
        if (manualBlocked(await journal.read(), execution)) continue
        if (await recoverCandidate(execution)) { calibrated.add(execution.launch_id); continue }
        if ((await journal.read()).inbox.some(row => row.command.launch_id === execution.launch_id && row.status !== 'stopped' && needsAttachmentRuntime(row.command))) continue
        if (await runtime.start(execution) !== execution.session_id) throw error('FORBIDDEN', 'Runtime Session 不匹配')
        const snapshot = await journal.read()
        const inputs = snapshot.inbox.filter(row => row.command.launch_id === execution.launch_id && row.command.input_id !== null && row.command.operation !== 'wake')
        const settled = snapshot.outbox.some(row => row.event.launch_id === execution.launch_id && row.event.kind === 'report'
          && row.event.observed_revision === execution.observed_revision && ['waiting', 'ready', 'blocked', 'failed'].includes(row.event.report?.state))
        if (inputs.length && inputs.every(row => row.status === 'ingested') && !settled) throw error('RECOVERY_EXECUTION_UNCONFIRMED', '会话已加载，但没有恢复活动推理的证据')
        calibrated.add(execution.launch_id)
      } catch (cause) {
        const command = (await journal.read()).inbox.find(row => row.command.launch_id === execution.launch_id)?.command
        await journal.update(state => {
          const current = state.executions.find(item => item.launch_id === execution.launch_id)
          if (['stopping', 'stopped'].includes(current.status)) return
          current.status = 'unknown'; current.unavailableReason = cause.code ?? 'RUNTIME_UNAVAILABLE'
          append(state, eventFor(current, 'runtime_unavailable', command, { reason: current.unavailableReason }))
        })
        if (!['FORBIDDEN', 'UNAUTHORIZED', 'RECOVERY_EXECUTION_UNCONFIRMED'].includes(cause.code)) failures.push(cause)
      }
    }
    const { inbox } = await journal.read()
    const background = new Set(inbox.filter(({ command }) => command.operation === 'launch' && command.parameters.siteRule && typeof command.parameters.siteRule === 'object' && !Array.isArray(command.parameters.siteRule)).map(({ command }) => command.launch_id))
    const eligible = inbox.filter(item => !['cancel', 'settle', 'budget_wait', 'manual_pause', 'manual_release'].includes(item.command.operation) && ['accepted', 'delivered'].includes(item.status) && !item.supersededAt)
    eligible.sort((a, b) => Number(background.has(a.command.launch_id)) - Number(background.has(b.command.launch_id)))
    for (const row of eligible) {
      const command = row.command
      try {
        if (command.parameters.messages?.[0]?.kind === 'budget_resume' && (await journal.read()).inbox.some(item => item.command.attempt_id === command.attempt_id && item.command.operation === 'deliver' && item.command.instruction_revision > command.instruction_revision)) {
          await journal.update(state => { state.inbox.find(item => item.command.command_id === command.command_id).supersededAt ??= clock() }); continue
        }
        if (needsAttachmentRuntime(command)) {
          if (row.lastError !== 'ATTACHMENT_RUNTIME_UNAVAILABLE') await journal.update(state => { state.inbox.find(item => item.command.command_id === command.command_id).lastError = 'ATTACHMENT_RUNTIME_UNAVAILABLE' })
          continue
        }
        let execution = (await journal.read()).executions.find(item => item.launch_id === command.launch_id)
        if (!execution) {
          if (command.operation !== 'launch') continue
          execution = { ...binding(command), session_id: `geneway-${command.launch_id}`, status: 'accepted', runtimeStarted: false, observed_revision: 0 }
          await journal.update(state => { state.executions.push(execution) })
        }
        assertLocalManualExecution(await journal.read(), execution)
        if (command.session_id !== null && command.session_id !== execution.session_id) throw error('FORBIDDEN', 'Session 绑定不匹配')
        if (['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status)) continue
        if (execution.waitStatus && execution.slotHeld) continue
        if (execution.waitStatus && ['waiting_dependency', 'waiting_question', 'waiting_budget', 'waiting_intent'].includes(execution.waitStatus)) {
          const release = command.parameters.waitRelease
          const legacyDependency = !release && execution.waitStatus === 'waiting_dependency' && command.parameters.messages?.every(message => message.kind === 'dependency_result' && message.replyTo === execution.waitId)
          const matching = release && release.id === execution.waitId && release.kind === (execution.waitStatus === 'waiting_dependency' ? 'dependency' : execution.waitStatus === 'waiting_budget' ? 'budget' : execution.waitStatus === 'waiting_intent' ? 'intent_question' : 'question')
          if (!(command.operation === 'deliver' && command.instruction_revision > execution.observed_revision) && !matching && !legacyDependency) continue
        }
        if (!execution.slotHeld) {
          const held = (await journal.read()).executions.filter(row => row.slotHeld && !['stopped', 'settled', 'unknown'].includes(row.status))
          if (held.length >= maxActiveLoops || held.some(row => row.agent_id === execution.agent_id && row.launch_id !== execution.launch_id)) continue
          if (background.has(execution.launch_id) && (held.length >= maxActiveLoops - 1 || held.some(row => background.has(row.launch_id)))) continue
          await journal.update(state => { const row = state.executions.find(row => row.launch_id === execution.launch_id); row.slotHeld = true; delete row.waitStatus; delete row.waitId })
        }
        const budgetResumeCommandId = command.parameters.messages?.[0]?.kind === 'budget_resume' ? command.command_id : undefined, intentReviewCommandId = command.operation === 'intent_review' ? command.command_id : undefined
        await journal.update(state => { assertLocalManualExecution(state, execution); const current = state.executions.find(row => sameBinding(row, execution)); current.runtimeLaunchReservedAt ??= clock() })
        const actualSession = await runtime.start(execution, { budgetResumeCommandId, intentReviewCommandId })
        if (actualSession !== execution.session_id) throw error('FORBIDDEN', 'Runtime Session 不匹配')
        calibrated.add(execution.launch_id)
        if (!execution.runtimeStarted) await journal.update(state => {
          const current = state.executions.find(item => item.launch_id === execution.launch_id)
          current.runtimeStarted = true; current.status = 'running'
          const launch = state.inbox.find(item => item.command.launch_id === execution.launch_id && item.command.operation === 'launch').command
          append(state, eventFor(current, 'started', launch))
        })
        const id = messageId(command.input_id, command.attempt_id, execution.session_id)
        const status = await runtime.deliver(execution, { id, text: command.parameters.text, attachmentRefs: attachmentRefs(command.parameters.attachmentRefs), spreadsheetRequest: command.parameters.spreadsheetRequest ?? null, inputId: command.input_id, instructionRevision: command.instruction_revision, executionContext: command.parameters.executionContext, continuationContext: command.parameters.continuationContext, messages: command.parameters.messages, budgetResumeCommandId, intentReviewCommandId, intentFence: command.parameters.intentFence, sourceEvent: command.parameters.sourceEvent, intentAnswer: command.parameters.intentAnswer, sourceKind: command.operation === 'intent_review' ? 'geneway-intent-review' : command.operation === 'wake' ? 'geneway-agent-message' : undefined })
        if (!status.delivered) throw error('DELIVERY_PENDING')
        await journal.update(state => mergeDelivery(state, command, execution, status))
      } catch (cause) {
        await journal.update(state => {
          const current = state.inbox.find(item => item.command.command_id === command.command_id); current.lastError = cause.code ?? 'DELIVERY_PENDING'
          const execution = state.executions.find(item => item.launch_id === command.launch_id)
          if (execution && !['stopping', 'stopped', 'unknown', 'settling', 'settled'].includes(execution.status) && ['RUNTIME_PROCESS_DIED', 'RUNTIME_REQUEST_UNKNOWN', 'HISTORY_UNAVAILABLE'].includes(cause.code)) {
            execution.status = 'unknown'; execution.unavailableReason = cause.code
            append(state, eventFor(execution.runtimeStarted ? execution : { ...execution, session_id: command.session_id }, 'runtime_unavailable', command, { reason: cause.code }))
          }
        })
        if (!['FORBIDDEN', 'UNAUTHORIZED', 'RUNTIME_REQUEST_UNKNOWN', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING'].includes(cause.code)) failures.push(cause)
      }
    }
    if (failures.length) throw failures[0]
  }
  return {
    nodeId, workspaceId, synchronizeInputs,
    setOrchestrationHandler(value) { orchestration = value },
    async accept(authenticated, command) {
      assertSealed(command)
      if (isManualCommand(command)) manualCommand(command)
      if (closing || authenticated.nodeId !== nodeId || authenticated.workspaceId !== workspaceId || command.node_id !== nodeId || command.workspace_id !== workspaceId) throw error('FORBIDDEN', 'Host binding 不匹配')
      await journal.update(async (state, lookup, prepareArchive) => {
        const old = state.inbox.find(row => row.command.command_id === command.command_id) ?? await lookup?.('inbox', command.command_id)
        if (old) { if (old.command.payload_digest !== command.payload_digest) throw error('IDEMPOTENCY_CONFLICT'); return }
        const row = { command: structuredClone(command), status: 'accepted', acceptedAt: clock() }
        try { assertHostInboxAdmission(state, row) } catch (cause) {
          if (cause.capacity?.domain !== 'host-inbox' || cause.capacity.reason !== 'history_count' || !prepareArchive) throw cause
          await prepareArchive()
          assertHostInboxAdmission(state, row)
        }
        state.inbox.push(row)
      })
      if (command.operation === 'manual_pause') { const snapshot = await journal.read(), execution = snapshot.executions.find(row => exactManualExecution(command, row)); if (execution?.runtimeStarted && manualBlocked(snapshot, execution) && !['unknown', 'stopped', 'settled'].includes(execution.status)) await runtime.park?.(execution) }
      return { command_id: command.command_id, node_id: nodeId, payload_digest: command.payload_digest, ...binding(command) }
    },
    process() {
      if (closing) return Promise.resolve()
      return processing ??= processInbox().finally(() => { processing = undefined })
    },
    flushTerminalProofs,
    async flushEvents(send, options) {
      await flushReceipts(send, options)
      await uploadCandidates?.()
    },
    report,
    async close() { closing = true; await processing?.catch(() => {}); try { await jobs?.close() } finally { await runtime.close?.() } },
  }
}
