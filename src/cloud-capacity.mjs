import { terminalProofProfile, assertTerminalEventEnvelope, assertBridgeEventBytes } from '../packages/agent-contracts/terminal-proof.mjs'
import { isDeepStrictEqual as equal } from 'node:util'
import { binding, key, digest, error, sameBinding, MULTISITE_WORK_STATUSES } from '../packages/agent-contracts/index.mjs'
import { publicNode } from '../packages/agent-contracts/nodes.mjs'
import { buildExecutionCommand, queueExecutionCommand } from '../packages/agent-orchestration/commands.mjs'
import { closeQuestions } from '../packages/agent-orchestration/conversations.mjs'
import { removeWorkMember } from './work-member-removal.mjs'
import { a2aGroupId, a2aParticipantSource } from './a2a-group-state.mjs'
import { measureCloudCapacity, modelSettlementGrowth } from './cloud-capacity-measure.mjs'

const MAX_TIME = new Date(8.64e15).toISOString()
const REQUEST_ID = '\0'.repeat(16000)
const UUID = 'f'.repeat(36)
const HASH = 'f'.repeat(64)
const EVENT_BYTES = 262144
const jsonBytes = row => Buffer.byteLength(JSON.stringify(row))
const pathRows = (state, name) => name.split('.').reduce((value, field) => value[field], state)
const rowKey = (name, row) => name === 'multisite.commands' ? row.key : name === 'multisite.receipts' ? row.event.event_id : name === 'workMemberRemovals' ? key(row.workspaceId, row.workId, row.employeeId) : row.id
const expected = attempt => ({ ...binding(attempt), session_id: attempt.session_id ?? `geneway-${attempt.launch_id}` })
const outstanding = attempt => attempt.status !== 'cancelled' && !attempt.settledAt
const cancelable = work => !['completed', 'cancelled', 'stopping'].includes(work.status)
export const isCloudOrdinaryCapacityError = cause => cause?.code === 'CAPACITY_EXCEEDED' && cause.capacity?.domain === 'cloud' && cause.capacity.queue === 'ordinary'

function maxOutboxRow(row) {
  return { ...row, createdAt: row.createdAt ?? MAX_TIME, acceptedAt: row.acceptedAt ?? MAX_TIME, blockedAt: row.blockedAt ?? MAX_TIME, blockedReason: (row.blockedReason?.length ?? 0) > 'MANUAL_RELEASE_PENDING'.length ? row.blockedReason : 'MANUAL_RELEASE_PENDING' }
}
function receiptEnvelope(command, kind) {
  const subject = expected(command), id = key('event', command.node_id, command.command_id, kind)
  const row = { nodeId: command.node_id, event: null, historical: false, ack: { event_id: id, node_id: command.node_id, payload_digest: HASH, ...subject } }
  return { id, bytes: EVENT_BYTES - jsonBytes({ event: null }) + jsonBytes(row), command, kind }
}
function controlKind(command) {
  if (command.operation === 'cancel') return 'stopped'
  if (command.operation === 'settle') return 'settled'
  if (command.operation === 'manual_pause') return 'manual_idle'
  if (command.operation === 'manual_release') return 'manual_released'
  if (command.operation === 'budget_wait') return 'budget_idle'
  if (command.operation === 'intent_question_closed') return 'intent_control_consumed'
  if (command.operation === 'wake' && command.parameters.messages?.some(row => row.kind === 'question_closed')) return 'control_consumed'
}
function inputMaximum(state, input) {
  return { ...input, deliveries: input.deliveries.map(row => {
    const attempt = state.multisite.attempts.find(attempt => attempt.attempt_id === row.attemptId)
    return { ...row, sessionId: row.sessionId ?? (attempt ? expected(attempt).session_id : null), deliveredAt: row.deliveredAt ?? MAX_TIME, ingestedAt: row.ingestedAt ?? MAX_TIME }
  }) }
}
function messageMaximum(state, message) {
  if (!message.targetAttemptId) return message
  const attempt = state.multisite.attempts.find(row => row.attempt_id === message.targetAttemptId)
  return { ...message, sessionId: message.sessionId ?? (attempt ? expected(attempt).session_id : null), deliveredAt: message.deliveredAt ?? MAX_TIME, ingestedAt: message.ingestedAt ?? MAX_TIME,
    ...(message.kind === 'question_closed' ? { controlConsumedAt: message.controlConsumedAt ?? MAX_TIME } : {}) }
}

// Envelopes are calculations only. They are never written as business facts.
export function cloudClosingObligations(state, now = Date.now()) {
  const measurement = measureCloudCapacity(state, now), tables = Object.keys(measurement.tables)
  const credits = Object.fromEntries(tables.map(name => [name, new Map()]))
  const actual = Object.fromEntries(tables.map(name => [name, new Map(pathRows(state, name).map(row => [rowKey(name, row), row]))]))
  const symbolic = []
  function reserve(name, id, maxBytes, details = {}) {
    const existing = actual[name].get(id), current = existing ? jsonBytes(existing) : 0
    const old = credits[name].get(id)
    if (!old || old.maxBytes < maxBytes) credits[name].set(id, { id, currentBytes: current, maxBytes: Math.max(maxBytes, current), missing: !existing, ...details })
  }
  function row(name, value, details) { reserve(name, rowKey(name, value), jsonBytes(value), details) }
  function control(command) {
    const kind = controlKind(command)
    if (!kind) return
    const value = receiptEnvelope(command, kind)
    if (!actual['multisite.receipts'].has(value.id)) reserve('multisite.receipts', value.id, value.bytes, { kind: 'receipt', command, eventKind: kind })
  }
  function outbox(value) {
    row('multisite.outbox', maxOutboxRow(value), { kind: 'outbox', nodeId: value.command.node_id, pending: value.acceptedAt === null,
      pendingMaxBytes: jsonBytes({ ...maxOutboxRow(value), acceptedAt: null }) })
    control(value.command)
  }
  for (const value of state.multisite.outbox) {
    if (value.acceptedAt === null) outbox(value)
    else control(value.command)
  }
  for (const input of state.multisite.inputs) row('multisite.inputs', inputMaximum(state, input), { kind: 'input-delivery' })
  for (const message of state.multisite.messages) row('multisite.messages', messageMaximum(state, message), { kind: 'message-delivery' })
  for (const question of state.multisite.questions.filter(row => row.state === 'open')) {
    const max = { ...question, state: 'superseded', closedReason: 'EXECUTION_AUTHORITY_CHANGED', closedAt: MAX_TIME, answerMessageId: HASH.slice(0, 32) }
    row('multisite.questions', max, { kind: 'question-close' })
  }
  for (const request of state.modelRequests) {
    const growth = modelSettlementGrowth(request)
    if (growth.positiveD === null) {
      // A new unrecognized model protocol cannot silently acquire forward capacity.
      symbolic.push({ kind: 'unsupported-model', id: request.id })
    } else if (growth.positiveD > 0) reserve('modelRequests', request.id, growth.maxFinalBytes, { kind: 'model-settlement' })
  }
  const memberRemoval = (work, employeeId) => state.workMemberRemovals.some(row => row.workspaceId === work.workspaceId && row.workId === work.id && row.employeeId === employeeId)
  for (const work of state.works.filter(row => row.workType === 'multisite')) {
    const attempts = state.multisite.attempts.filter(row => row.work_id === work.id)
    const owner = state.members.find(row => row.id === work.ownerMemberId)
    if (!owner) continue
    if (cancelable(work) && attempts.some(row => !['completed', 'cancelled'].includes(row.status))) {
      const id = '@owner-cancel:' + work.id, payloadDigest = digest({ operation: 'cancel', parameters: { workId: work.id } })
      const value = { key: HASH.slice(0, 32), workspaceId: work.workspaceId, issuerId: owner.id, commandId: REQUEST_ID, digest: payloadDigest, reply: { workId: work.id, commandId: REQUEST_ID, status: 'stopping' }, acceptedAt: MAX_TIME }
      reserve('multisite.commands', id, jsonBytes(value), { kind: 'owner-cancel', workId: work.id, ownerId: owner.id, digest: payloadDigest })
    }
    for (const attempt of attempts.filter(outstanding)) {
      const execution = expected(attempt)
      const commands = ['cancel','settle'].map(operation => buildExecutionCommand(state, { ...attempt, session_id: execution.session_id }, operation, null, work.workspaceId))
      const preparedJobIds = state.multisite.commands.filter(row => row.receiptKind === 'spreadsheet_prepared' && sameBinding(row.senderBinding, execution)).map(row => row.reply.jobId)
      const registeredJobs = state.multisite.jobs.filter(row => sameBinding(row, execution))
      const sealedEvents = state.multisite.receipts.filter(row => sameBinding(row.event, execution)).map(row => row.event)
      const profile = terminalProofProfile({ execution, commands, preparedJobIds, registeredJobs, sealedEvents })
      if (!profile.fits) symbolic.push({ kind: 'terminal-proof-debt', id: attempt.attempt_id, reason: profile.legacyDebt ? 'unregistered-job' : 'terminal-envelope' })
    }
    // Both normal completion and revocation have deterministic, different original keys.
    for (const attempt of attempts.filter(outstanding)) for (const operation of attempt.status === 'completed' ? ['settle'] : ['cancel', 'settle']) {
      const preview = { ...attempt, session_id: expected(attempt).session_id }
      const command = buildExecutionCommand(state, preview, operation, null, work.workspaceId)
      if (!actual['multisite.outbox'].has(command.command_id)) outbox({ id: command.command_id, command, createdAt: MAX_TIME, acceptedAt: null })
    }
    // Only these facts are read by the original closure builders. Historical
    // receipt/model bodies are not cloned to calculate a future queue envelope.
    const base = () => ({ works: [structuredClone(work)], userQuestions: structuredClone(state.userQuestions.filter(row => row.workId === work.id)),
      workMemberRemovals: structuredClone(state.workMemberRemovals.filter(row => row.workId === work.id)),
      multisite: {
        attempts: structuredClone(attempts),
        delegations: structuredClone(state.multisite.delegations.filter(row => row.workId === work.id)),
        dependencyWaits: structuredClone(state.multisite.dependencyWaits.filter(row => row.workId === work.id)),
        questions: structuredClone(state.multisite.questions.filter(row => row.workId === work.id)),
        outbox: [], messages: [],
      } })
    const closedView = base()
    closeQuestions(closedView, () => true, 'EXECUTION_AUTHORITY_CHANGED', { queue: (draft, target, operation, input, at) => queueExecutionCommand(draft, target, operation, input, at, work.workspaceId), at: MAX_TIME })
    for (const item of closedView.multisite.outbox) if (!actual['multisite.outbox'].has(item.id)) outbox(item)
    for (const item of closedView.multisite.messages) if (!actual['multisite.messages'].has(item.id)) row('multisite.messages', messageMaximum(closedView, item), { kind: 'closure-message' })
    for (const employeeId of new Set(attempts.map(row => row.agent_id))) {
      if (memberRemoval(work, employeeId)) continue
      const id = key(work.workspaceId, work.id, employeeId)
      row('workMemberRemovals', { workspaceId: work.workspaceId, workId: work.id, employeeId, actorId: owner.id, commandId: REQUEST_ID, acceptedAt: MAX_TIME }, { kind: 'member-remove', workId: work.id, employeeId, ownerId: owner.id })
      const payloadDigest = digest({ operation: 'remove-member', parameters: { workId: work.id, employeeId } })
      const view = base()
      removeWorkMember(view, view.works[0], owner, employeeId, REQUEST_ID, { queue: (draft, target, operation, input, at) => queueExecutionCommand(draft, target, operation, input, at, work.workspaceId), closeQuestions, at: MAX_TIME })
      const replies = MULTISITE_WORK_STATUSES.map(status => ({ key: HASH.slice(0,32), workspaceId: work.workspaceId, issuerId: owner.id, commandId: REQUEST_ID, digest: payloadDigest,
        reply: { workId: work.id, commandId: REQUEST_ID, status, employeeId, access: 'removed' }, acceptedAt: MAX_TIME }))
      reserve('multisite.commands', '@owner-remove:' + id, Math.max(...replies.map(jsonBytes)),
        { kind: 'owner-remove', workId: work.id, employeeId, ownerId: owner.id, digest: payloadDigest })
      for (const item of view.multisite.outbox) if (!actual['multisite.outbox'].has(item.id)) outbox(item)
      for (const item of view.multisite.messages) if (!actual['multisite.messages'].has(item.id)) row('multisite.messages', messageMaximum(view, item), { kind: 'closure-message' })
      for (const item of view.multisite.questions) row('multisite.questions', item, { kind: 'question-close' })
    }
  }
  for (const node of state.nodes.filter(row => row.status === 'active')) {
    const attempts = state.multisite.attempts.filter(row => row.node_id === node.id && row.nodeSnapshot?.nodeInstanceId === node.nodeInstanceId && outstanding(row))
    const value = { ...node, status: 'cleanup_only', revision: node.revision + 1, revokedAt: node.revokedAt ?? MAX_TIME, cleanupBindings: attempts.map(expected) }
    row('nodes', value, { kind: 'node-revoke', nodeId: node.id, nodeInstanceId: node.nodeInstanceId, registrationRevision: node.registrationRevision })
    reserve('nodeCommands', '@node-revoke:' + node.id, jsonBytes({ id: HASH.slice(0,32), payloadDigest: HASH, reply: { node: publicNode(value) }, acceptedAt: MAX_TIME }),
      { kind: 'node-revoke-command', nodeId: node.id, nodeInstanceId: node.nodeInstanceId, registrationRevision: node.registrationRevision })
  }
  for (const delivery of state.a2aProtocol.deliveries) {
    const max = { ...delivery, offeredAt: delivery.offeredAt ?? MAX_TIME, revokedBy: delivery.revokedBy ?? REQUEST_ID,
      metadataAck: delivery.metadataAck ?? { operationId: '\0'.repeat(200), payloadDigest: HASH, acceptedAt: MAX_TIME } }
    row('a2aProtocol.deliveries', max, { kind: 'group-delivery' })
  }
  for (const workId of new Set(state.a2aProtocol.tasks.map(row => row.workId))) {
    const work = state.works.find(row => row.id === workId && row.workType === 'multisite')
    if (!work) continue
    const id = a2aGroupId(work.workspaceId, work.id), existing = actual['a2aProtocol.groups'].get(id)
    const group = structuredClone(existing ?? { id, workspaceId: work.workspaceId, workId: work.id, createdAt: MAX_TIME, members: [], calibrations: [] })
    for (const attempt of state.multisite.attempts.filter(row => row.work_id === work.id)) {
      if (group.members.some(row => row.employeeId === attempt.agent_id)) continue
      const source = a2aParticipantSource(state, work, attempt)
      if (source) group.members.push({ employeeId: attempt.agent_id, contextId: UUID, sourceAttemptId: attempt.attempt_id, sourceCommandKey: source.key, joinedAt: source.acceptedAt })
    }
    for (const member of group.members) {
      const removal = state.workMemberRemovals.find(row => row.workId === work.id && row.employeeId === member.employeeId)
      const actualCommandId = removal?.commandId ?? REQUEST_ID
      if (!group.calibrations.some(row => row.employeeId === member.employeeId && (!removal || row.removalCommandId === actualCommandId))) group.calibrations.push({ employeeId: member.employeeId, removalCommandId: actualCommandId, sourceDigest: HASH, calibratedAt: MAX_TIME })
    }
    row('a2aProtocol.groups', group, { kind: 'group-calibration' })
  }
  let bytes = measurement.history.bytes, pendingBytes = measurement.pending.bytes, pendingCount = measurement.pending.count
  const byNode = new Map(Object.entries(measurement.pending.byNode).map(([id, value]) => [id, { bytes: value.bytes, count: value.count }]))
  const projectedTables = {}
  for (const name of tables) {
    let count = measurement.tables[name].count, extra = 0
    for (const credit of credits[name].values()) {
      const difference = credit.maxBytes - credit.currentBytes
      extra += difference
      if (credit.missing) count++
      if (name === 'multisite.outbox' && credit.pending) {
        const actualRow = actual[name].get(credit.id), currentPending = actualRow?.acceptedAt === null ? jsonBytes(actualRow) : 0
        pendingBytes += credit.pendingMaxBytes - currentPending
        if (!actualRow) pendingCount++
        const node = byNode.get(credit.nodeId) ?? { count: 0, bytes: 0 }
        node.bytes += credit.pendingMaxBytes - currentPending
        if (!actualRow) node.count++
        byNode.set(credit.nodeId, node)
      }
    }
    bytes += extra
    projectedTables[name] = { count, bytes: measurement.tables[name].bytes + extra, remainingCount: count - measurement.tables[name].count, remainingBytes: extra, hardCount: measurement.tables[name].hardCount }
  }
  return { measurement, credits, actual, unsupported: symbolic, projected: { historyBytes: bytes, tables: projectedTables, pendingBytes, pendingCount, byNode: Object.fromEntries(byNode) } }
}

function reasons(obligations) {
  const { projected, measurement, unsupported } = obligations, limits = measurement.limits
  const result = []
  if (unsupported.length) result.push('legacy-proof-debt')
  if (projected.historyBytes > limits.historyBytes) result.push('history_bytes')
  if (projected.pendingBytes > limits.pendingBytes) result.push('pending_bytes')
  if (projected.pendingCount > limits.pendingCount) result.push('pending_count')
  if (Object.values(projected.byNode).some(row => row.count > limits.pendingPerNodeCount)) result.push('node_pending_count')
  for (const [name, row] of Object.entries(projected.tables)) if (row.hardCount !== null && row.count > row.hardCount) result.push('history_count:' + name)
  return result
}
export function cloudCapacityStatus(state, now = Date.now()) {
  const obligations = cloudClosingObligations(state, now)
  const failures = reasons(obligations)
  return { ...obligations.measurement, remaining: obligations.projected, state: failures.length ? 'overcommitted' : 'available', reasons: failures }
}
function authenticReceipt(credit, value, before) {
  try {
    const { command, eventKind } = credit, event = value.event
    if (event.kind !== eventKind || event.event_id !== credit.id || event.node_id !== command.node_id || value.nodeId !== command.node_id || event.workspace_id !== command.workspace_id
      || !sameBinding(expected(command), event) || value.ack?.event_id !== event.event_id || value.ack.payload_digest !== event.payload_digest || !sameBinding(value.ack, event)) return false
    assertBridgeEventBytes(event)
    if (['stopped','settled'].includes(eventKind)) {
      assertTerminalEventEnvelope(event)
      const known = new Set([
        ...before.multisite.commands.filter(row => row.receiptKind === 'spreadsheet_prepared' && sameBinding(row.senderBinding, event)).map(row => row.reply.jobId),
        ...before.multisite.jobs.filter(row => sameBinding(row, event)).map(row => row.id),
      ])
      if (!(event.job_stop_evidence ?? event.job_settle_evidence ?? []).every(item => known.has(item.jobId))) return false
      const attempt = before.multisite.attempts.find(row => row.attempt_id === event.attempt_id)
      return (eventKind === 'stopped' ? attempt?.status === 'stopping' : attempt?.status === 'completed')
        && event.instruction_revision === command.instruction_revision && event.input_id === command.input_id && equal(event.resource_refs, command.resource_refs)
    }
    // The original assignment/control validator checks the exact original marker.
    return event.source_command_id === command.command_id
  } catch { return false }
}
function matchesCredit(name, credit, value, before, after) {
  if (jsonBytes(value) > credit.maxBytes) return false
  if (credit.kind === 'owner-cancel' || credit.kind === 'owner-remove') {
    if (value.workspaceId !== before.works.find(row => row.id === credit.workId)?.workspaceId || value.issuerId !== credit.ownerId || value.issuerKind !== undefined
      || value.reply.workId !== credit.workId || value.digest !== credit.digest || value.key !== key(value.workspaceId, value.issuerId, value.commandId)) return false
    if (credit.kind === 'owner-cancel') return after.works.some(row => row.id === credit.workId && row.status === 'stopping')
    return after.workMemberRemovals.some(row => row.workId === credit.workId && row.employeeId === credit.employeeId && row.actorId === value.issuerId && row.commandId === value.commandId)
  }
  if (credit.kind === 'node-revoke-command') {
    const node = after.nodes.find(row => row.id === credit.nodeId && row.status === 'cleanup_only' && row.nodeInstanceId === credit.nodeInstanceId && row.registrationRevision === credit.registrationRevision)
    return !!node && equal(value.reply, { node: publicNode(node) })
  }
  if (credit.kind === 'node-revoke') {
    const node = before.nodes.find(row => row.id === credit.nodeId)
    const targets = before.multisite.attempts.filter(row => row.node_id === node.id && row.nodeSnapshot?.nodeInstanceId === node.nodeInstanceId && outstanding(row))
    return value.status === 'cleanup_only' && value.revision === node.revision + 1 && value.nodeInstanceId === node.nodeInstanceId && equal(value.cleanupBindings, targets.map(binding))
  }
  if (credit.kind === 'receipt') return authenticReceipt(credit, value, before)
  if (credit.kind === 'member-remove') return value.workId === credit.workId && value.employeeId === credit.employeeId && value.actorId === credit.ownerId
  return rowKey(name, value) === credit.id
}
function noWorse(before, after) {
  if (after.projected.historyBytes > before.projected.historyBytes || after.projected.pendingBytes > before.projected.pendingBytes || after.projected.pendingCount > before.projected.pendingCount) return false
  for (const [name, row] of Object.entries(after.projected.tables)) if (row.count > before.projected.tables[name].count || row.bytes > before.projected.tables[name].bytes) return false
  for (const [nodeId, row] of Object.entries(after.projected.byNode)) if (row.count > (before.projected.byNode[nodeId]?.count ?? 0) || row.bytes > (before.projected.byNode[nodeId]?.bytes ?? 0)) return false
  return after.unsupported.every(value => before.unsupported.some(old => old.id === value.id && old.kind === value.kind))
}
function actualFits(state) {
  const actual = state.measurement, limits = actual.limits
  return actual.history.bytes <= limits.historyBytes && actual.pending.bytes <= limits.pendingBytes && actual.pending.count <= limits.pendingCount
    && Object.values(actual.pending.byNode).every(value => value.count <= limits.pendingPerNodeCount)
    && Object.values(actual.tables).every(value => value.hardCount === null || value.count <= value.hardCount)
}

// Every real typed caller crosses this boundary. A caller cannot request a bypass.
// Legacy debt allows only unchanged facts and exact pre-existing closing credit,
// never a new ordinary effect or a fabricated receipt.
export function assertCloudCapacity(before, after, now = Date.now()) {
  const next = cloudClosingObligations(after, now), failures = reasons(next)
  if (!failures.length) return
  const previous = cloudClosingObligations(before, now)
  let growth = false, covered = true
  for (const name of Object.keys(next.actual)) for (const [id, row] of next.actual[name]) {
    const old = previous.actual[name].get(id)
    if (old && jsonBytes(row) <= jsonBytes(old)) continue
    growth = true
    const direct = previous.credits[name].get(id)
    const candidates = direct ? [direct] : [...previous.credits[name].values()].filter(credit => credit.id.startsWith('@'))
    if (!candidates.some(credit => matchesCredit(name, credit, row, before, after))) { covered = false; break }
  }
  if (!growth && noWorse(previous, next)) return
  if (covered && actualFits(next) && noWorse(previous, next)) return
  throw Object.assign(error('CAPACITY_EXCEEDED', '云端有限事实容量不足，本次新增未受理'), {
    capacity: { domain: 'cloud', queue: 'ordinary', reason: failures[0] },
  })
}
