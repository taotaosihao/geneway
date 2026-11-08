import { workMemberAffected } from '../../src/work-member-removal.mjs'
import { SPREADSHEET_CANDIDATE_SCHEMA } from '../agent-contracts/spreadsheet-collaboration.mjs'
import { spreadsheetPreparationKey } from '../../src/spreadsheet-preparation.mjs'
import { COMMAND_FETCH_LIMIT } from '../agent-contracts/command-bytes.mjs'
import { multisitePolicy, resultPayload, DELEGATION_RESULT_SCHEMA, ANALYSIS_RESULT_SCHEMA, evidenceReferences } from '../agent-contracts/delegation.mjs'
import { assertSpreadsheetRequest } from '../../src/spreadsheet-template.mjs'
import { attachmentForRef } from '../../src/artifact-service.mjs'
import { validateModelSnapshot } from '../../src/model-route.mjs'
import { isDeepStrictEqual } from 'node:util'
import { assertSealed, binding, digest, error, key, placement, sameBinding, text, attachmentRefs, MULTISITE_WORK_STATUSES } from '../agent-contracts/index.mjs'

export const emptyMultisite = () => ({ commands: [], outbox: [], delegations: [], attempts: [], inputs: [], receipts: [], jobs: [], results: [], messages: [], dependencyWaits: [], questions: [] })
const check = (condition, label) => { if (!condition) throw error('INVALID_STATE', `多地点状态无效：${label}`) }
const unique = (rows, field, label) => check(new Set(rows.map(row => row[field])).size === rows.length, `${label}重复`)
export function validateMultisite(state) {
  const domain = state.multisite
  check(domain && typeof domain === 'object' && Object.keys(domain).length === 11, '事务域')
  for (const name of Object.keys(emptyMultisite())) check(Array.isArray(domain[name]), name)
  for (const employee of state.employees) { if (employee.placement !== undefined) placement(employee.placement); if (employee.multisitePolicy !== undefined) multisitePolicy(employee.multisitePolicy) }
  for (const [name, field] of [['commands', 'key'], ['outbox', 'id'], ['delegations', 'id'], ['attempts', 'attempt_id'], ['inputs', 'id']]) unique(domain[name], field, name)
  check(domain.commands.length <= 10_000 && domain.outbox.length <= 10_000 && domain.receipts.length <= 30_000 && domain.inputs.length <= 10_000 && domain.questions.length <= 10_000 && domain.messages.length <= 30_000, '容量上限')
  const works = state.works.filter(item => item.workType === 'multisite'), workById = new Map(works.map(work => [work.id, work]))
  const attemptById = new Map(domain.attempts.map(attempt => [attempt.attempt_id, attempt]))
  for (const work of works) {
    text(work.workspaceId); text(work.goal); assertSpreadsheetRequest(work.spreadsheetRequest)
    check(isDeepStrictEqual(domain.inputs.find(input => input.workId === work.id && input.revision === work.instructionRevision)?.spreadsheetRequest, work.spreadsheetRequest), '当前用户整改表要求必须关联Input快照')
    check(state.members.some(item => item.id === work.ownerMemberId) && state.employees.some(item => item.id === work.employeeId), 'Work身份')
    check(Number.isSafeInteger(work.instructionRevision) && work.instructionRevision > 0 && work.executions.length === 0, 'Work版本/旧执行')
    check(MULTISITE_WORK_STATUSES.includes(work.status), 'Work状态')
    const budget = work.modelRequestBudget
    check(budget && (budget.version === 2 || Object.keys(budget).length === 3 && budget.limit === 12) && Number.isSafeInteger(budget.reserved) && budget.reserved >= 0 && (budget.version === 2 || budget.reserved <= budget.limit), '工作请求预算缺失或无效，禁止重新计零')
    if (budget.version !== 2) check(budget.exhaustedAt === null || Number.isFinite(Date.parse(budget.exhaustedAt)) && budget.reserved === budget.limit, '预算耗尽事实')
    check(domain.attempts.filter(attempt => attempt.work_id === work.id).reduce((sum, attempt) => sum + attempt.modelRequestsReserved, 0) === budget.reserved, '工作与执行预算不闭合')
    if (budget.exhaustedAt) check(work.error?.code === 'BUDGET_EXHAUSTED' && ['failed', 'stopping', 'cancelled'].includes(work.status), '预算耗尽原因或状态')
    check(domain.delegations.some(item => item.workId === work.id), 'Work无委派')
  }
  for (const delegation of domain.delegations) {
    const work = workById.get(delegation.workId), attempt = attemptById.get(delegation.currentAttemptId)
    check(work && attempt?.delegation_id === delegation.id && attempt.work_id === work.id && attempt.agent_id === delegation.agentId, '委派引用')
    check(delegation.parentDelegationId === null || domain.delegations.some(item => item.id === delegation.parentDelegationId && item.workId === work.id), '父委派引用')
  }
  for (const attempt of domain.attempts) {
    if (attempt.grant) { multisitePolicy(attempt.grant); check(isDeepStrictEqual(attempt.resource_refs, attempt.grant.execution.resourceRefs), '执行资源授权快照'); const delegation = domain.delegations.find(row => row.id === attempt.delegation_id); check(isDeepStrictEqual(delegation?.grant, attempt.grant) && delegation.policyRevision === attempt.employeeRevision, '委派授权快照') }
    validateModelSnapshot(attempt.modelSnapshot)
    check(Number.isSafeInteger(attempt.modelRequestsReserved) && attempt.modelRequestsReserved >= 0 && attempt.modelRequestsReserved <= (workById.get(attempt.work_id)?.modelRequestBudget?.version === 2 ? 1000 : 12), '执行请求预算')
    const work = workById.get(attempt.work_id)
    check(work && domain.delegations.some(item => item.id === attempt.delegation_id && item.workId === work.id), 'Attempt引用')
    for (const field of ['attempt_id', 'agent_id', 'node_id', 'launch_id']) text(attempt[field])
    check(state.employees.some(item => item.id === attempt.agent_id) && Number.isSafeInteger(attempt.employeeRevision) && attempt.employeeRevision > 0, 'Attempt Agent')
    check(attempt.session_id === null || typeof attempt.session_id === 'string' && !!attempt.session_id, 'Session')
    check(Number.isSafeInteger(attempt.execution_epoch) && attempt.execution_epoch > 0
      && Number.isSafeInteger(attempt.instruction_revision) && attempt.instruction_revision > 0 && attempt.instruction_revision <= work.instructionRevision
      && Number.isSafeInteger(attempt.observed_revision) && attempt.observed_revision >= 0 && attempt.observed_revision <= attempt.instruction_revision, 'Attempt版本')
    check(Array.isArray(attempt.resource_refs) && attempt.resource_refs.every(ref => typeof ref === 'string'), '资源引用')
    check(['accepted', 'running', 'stopping', 'cancelled', 'unknown', 'completed', 'waiting_dependency', 'waiting_question', 'waiting_budget'].includes(attempt.status), 'Attempt状态')
  }
  for (const input of domain.inputs) {
    const work = workById.get(input.workId)
    text(input.text); text(input.issuerId); text(input.at); assertSpreadsheetRequest(input.spreadsheetRequest)
    check(work && Number.isSafeInteger(input.revision) && input.revision > 0 && input.revision <= work.instructionRevision && Array.isArray(input.deliveries) && input.deliveries.length > 0, 'Input归属')
    for (const ref of attachmentRefs(input.attachmentRefs)) {
      const file = attachmentForRef(state, ref)
      check(file.workId === input.workId && file.ownerMemberId === input.issuerId && file.workspaceId === work.workspaceId, 'Input附件绑定')
    }
    unique(input.deliveries, 'attemptId', 'delivery')
    for (const delivery of input.deliveries) {
      const attempt = attemptById.get(delivery.attemptId)
      check(attempt?.work_id === work.id && (delivery.sessionId === null || delivery.sessionId === attempt.session_id), '输入目标')
      check(!delivery.ingestedAt || !!delivery.deliveredAt, '未送达已消费')
      for (const field of ['deliveredAt', 'ingestedAt']) check(delivery[field] === null || Number.isFinite(Date.parse(delivery[field])), '输入回执时间')
    }
  }
  for (const row of domain.commands) {
    check(row.key === (row.receiptKind === 'spreadsheet_prepared' ? spreadsheetPreparationKey(row.workspaceId, row.issuerId, row.commandId) : key(row.workspaceId, row.issuerId, row.commandId)) && /^[a-f0-9]{64}$/.test(row.digest), '命令身份/摘要')
    if (row.receiptKind !== undefined) {
      check(row.receiptKind === 'spreadsheet_prepared' && row.issuerKind === 'agent' && row.reply.jobId === key('spreadsheet-job', row.senderBinding, row.commandId) && /^[a-f0-9]{64}$/.test(row.reply.inputDigest) && /^[a-f0-9]{64}$/.test(row.reply.requestDigest) && Number.isSafeInteger(row.reply.instructionRevision) && row.reply.instructionRevision > 0 && ['workGeneration', 'agentGeneration'].every(field => Number.isSafeInteger(row.manualFence?.[field]) && row.manualFence[field] >= 0), '生成准备只读受理回执')
    }
    check(workById.get(row.reply.workId)?.workspaceId === row.workspaceId && (row.issuerKind === 'agent' ? attemptById.has(row.issuerId) && sameBinding(attemptById.get(row.issuerId), row.senderBinding) : state.members.some(item => item.id === row.issuerId)), '命令回执')
  }
  for (const row of domain.outbox) {
    const command = row.command, attempt = attemptById.get(command.attempt_id)
    assertSealed(command)
    check(command.command_id === row.id && attempt && sameBinding({ ...attempt, session_id: command.session_id }, command)
      && command.workspace_id === workById.get(attempt.work_id)?.workspaceId && isDeepStrictEqual(command.resource_refs, attempt.resource_refs), 'outbox绑定')
    check(['launch', 'deliver', 'cancel', 'settle', 'wake', 'budget_wait', 'intent_review', 'intent_question_closed', 'manual_pause', 'manual_release'].includes(command.operation), 'outbox操作')
    if (command.input_id !== null && !['settle', 'wake', 'budget_wait', 'intent_review', 'intent_question_closed', 'manual_pause', 'manual_release'].includes(command.operation)) {
      const source = domain.inputs.find(input => input.id === command.input_id)
      check(isDeepStrictEqual(command.parameters.spreadsheetRequest, source?.spreadsheetRequest) && isDeepStrictEqual(attachmentRefs(command.parameters.attachmentRefs), attachmentRefs(source?.attachmentRefs)) && command.parameters.text === source?.text && isDeepStrictEqual(command.parameters.continuationContext, source?.continuationContext), 'outbox输入内容')
    }
    if (command.input_id !== null && !['wake', 'budget_wait', 'intent_review', 'intent_question_closed', 'manual_pause', 'manual_release'].includes(command.operation)) check(domain.inputs.some(input => input.id === command.input_id && input.workId === attempt.work_id && input.revision === command.instruction_revision && input.deliveries.some(delivery => delivery.attemptId === attempt.attempt_id)), 'outbox输入')
  }
  unique(domain.receipts.map(row => ({ id: key(row.nodeId, row.event.event_id) })), 'id', 'receipt')
  for (const row of domain.receipts) {
    assertSealed(row.event)
    check(row.event.node_id === row.nodeId && row.ack.event_id === row.event.event_id && row.ack.payload_digest === row.event.payload_digest && sameBinding(row.ack, row.event), 'receipt ACK')
  }
  for (const name of ['results', 'messages', 'dependencyWaits', 'questions']) unique(domain[name], 'id', name)
  unique(domain.results.filter(row => !row.historical), 'delegationId', '有效委派结果')
  for (const row of domain.results) {
    const attempt = attemptById.get(row.senderBinding?.attempt_id)
    check(attempt && sameBinding(attempt, row.senderBinding) && row.workId === attempt.work_id && row.delegationId === attempt.delegation_id && row.instructionRevision <= attempt.instruction_revision && [DELEGATION_RESULT_SCHEMA, ANALYSIS_RESULT_SCHEMA, SPREADSHEET_CANDIDATE_SCHEMA].includes(row.schema) && row.schema === (domain.delegations.find(item => item.id === row.delegationId).resultSchema ?? DELEGATION_RESULT_SCHEMA), '结果绑定')
    resultPayload(row.payload, row.schema)
    check(row.payloadDigest === digest(row.payload), '结果摘要')
    if (!row.historical) check(attempt.status === 'completed' && attempt.resultId === row.id, '委派唯一有效结果')
  }
  for (const row of domain.messages) {
    const parent = attemptById.get(row.targetAttemptId), source = attemptById.get(row.senderBinding?.attempt_id)
    check(source && row.workId === source.work_id && sameBinding(source, row.senderBinding), '消息来源')
    if (row.kind === 'dependency_result') {
      const result = domain.results.find(result => result.id === row.resultRef)
      check(result && parent && result.workId === parent.work_id && row.workId === parent.work_id && sameBinding(result.senderBinding, row.senderBinding) && row.instructionRevision === result.instructionRevision && row.id === key(result.id, parent.attempt_id), '消息绑定')
    } else {
      check(['observation', 'question', 'answer', 'question_closed', 'budget_resume', 'manual_resume', 'context_read_available', 'dependency_unavailable'].includes(row.kind) && typeof row.text === 'string' && row.text.length <= 4000, '协作消息')
      if (row.kind !== 'question_closed') evidenceReferences(row.evidenceRefs)
      check(row.kind === 'dependency_unavailable' ? parent?.work_id === row.workId && row.senderBinding.attempt_id === parent.attempt_id && domain.dependencyWaits.some(wait => wait.id === row.replyTo && wait.parentAttemptId === parent.attempt_id && wait.wokenAt && wait.dependencyIds.some(id => domain.attempts.some(attempt => attempt.delegation_id === id && workMemberAffected(state, attempt)))) : row.kind === 'context_read_available' ? parent?.work_id === row.workId && state.contextReadWindows.some(window => window.id === row.contextReadWindowId && window.id === row.replyTo && state.contextReadInstances.some(instance => instance.id === window.contextInstanceId && sameBinding(instance.readerBinding, row.senderBinding))) : row.kind === 'observation' ? row.targetAttemptId === null && row.replyTo === null : row.kind === 'manual_resume' ? parent?.work_id === row.workId && state.manualControls.some(control => control.id === row.manualResume?.controlId && control.holders.some(holder => holder.id === row.replyTo && holder.id === row.manualResume.holderId && sameBinding(holder.binding, row.senderBinding))) : row.kind === 'budget_resume' ? parent?.work_id === row.workId && state.budgetHolds.some(hold => hold.id === row.replyTo && hold.resumeMessageId === row.id && hold.attempt_id === parent.attempt_id) : parent?.work_id === row.workId && domain.questions.some(question => question.id === row.replyTo), '定向消息')
    }
    if (row.controlConsumedAt) check(row.kind === 'question_closed' && !row.ingestedAt && !row.deliveredAt && !row.sessionId && Number.isFinite(Date.parse(row.controlConsumedAt)), '系统控制消费不冒模型消费')
    check(!row.ingestedAt || row.deliveredAt && row.sessionId === parent?.session_id, '消息消费')
  }
  for (const row of domain.questions) {
    const sender = attemptById.get(row.senderBinding?.attempt_id), receiver = attemptById.get(row.responsibleAttemptId), source = domain.messages.find(message => message.id === row.messageId)
    check(sender && receiver && sender.work_id === row.workId && receiver.work_id === row.workId && sameBinding(sender, row.senderBinding) && source?.kind === 'question' && source.targetAttemptId === receiver.attempt_id && source.replyTo === row.id && ['open', 'answered', 'superseded', 'cancelled'].includes(row.state), '问题绑定')
    if (row.state === 'open') check(row.answerMessageId === null && row.closedAt === undefined && row.closedReason === undefined, '未答问题不能伪终态')
    if (['superseded', 'cancelled'].includes(row.state)) check(row.answerMessageId === null && typeof row.closedReason === 'string' && Number.isFinite(Date.parse(row.closedAt)), '问题关闭事实')
    check(row.state !== 'answered' || domain.messages.some(message => message.id === row.answerMessageId && message.kind === 'answer' && message.replyTo === row.id), '问题答案')
  }
  for (const row of domain.dependencyWaits) check(attemptById.get(row.parentAttemptId)?.work_id === row.workId && row.dependencyIds.length > 0 && row.dependencyIds.every(id => domain.delegations.some(child => child.id === id && child.parentDelegationId === attemptById.get(row.parentAttemptId).delegation_id)), '依赖等待')
  for (const row of domain.dependencyWaits) if (row.envelopeVersion !== undefined || row.upperBytes !== undefined) check(row.envelopeVersion === 1 && Number.isSafeInteger(row.upperBytes) && row.upperBytes > 0 && row.upperBytes <= COMMAND_FETCH_LIMIT, '等待命令包络预检')
  return state
}
export function assertMultisiteImmutable(before, after) {
  const old = before.multisite, next = after.multisite
  for (const work of before.works.filter(item => item.workType === 'multisite')) {
    const current = after.works.find(item => item.id === work.id), previous = work.modelRequestBudget, budget = current?.modelRequestBudget
    check(budget && budget.version === previous.version && budget.limit === previous.limit && budget.reserved >= previous.reserved && (!previous.exhaustedAt || previous.exhaustedAt === budget.exhaustedAt), '工作预算不可重置')
  }
  const preserve = (rows, candidates, field, project = value => value) => {
    for (const row of rows) check(isDeepStrictEqual(project(row), project(candidates.find(item => item[field] === row[field]))), `不可改写${field}`)
  }
  preserve(old.commands, next.commands, 'key')
  preserve(old.results, next.results, 'id')
  preserve(old.questions, next.questions, 'id', row => row && { ...row, state: undefined, answerMessageId: undefined, closedReason: undefined, closedAt: undefined })
  for (const row of old.questions.filter(row => row.state !== 'open')) check(isDeepStrictEqual(row, next.questions.find(item => item.id === row.id)), '问题终态不可回退')
  preserve(old.messages, next.messages, 'id', row => row && { ...row, deliveredAt: undefined, ingestedAt: undefined, sessionId: undefined, controlConsumedAt: undefined })
  preserve(old.dependencyWaits, next.dependencyWaits, 'id', row => row && { ...row, wokenAt: undefined })
  for (const row of old.messages) { const current = next.messages.find(item => item.id === row.id); for (const field of ['deliveredAt', 'ingestedAt', 'sessionId', 'controlConsumedAt']) if (row[field]) check(current[field] === row[field], '消息消费不可回退') }
  for (const row of old.dependencyWaits) if (row.wokenAt) check(next.dependencyWaits.find(item => item.id === row.id)?.wokenAt === row.wokenAt, '依赖唤醒不可回退')
  preserve(old.delegations, next.delegations, 'id', row => row && { ...row, status: undefined })
  check(isDeepStrictEqual(old.receipts, next.receipts.slice(0, old.receipts.length)), 'receipt不可改写')
  preserve(old.outbox, next.outbox, 'id', row => row?.command)
  preserve(old.inputs, next.inputs, 'id', row => row && { ...row, deliveries: undefined })
  for (const input of old.inputs) {
    const current = next.inputs.find(item => item.id === input.id)
    for (const delivery of input.deliveries) {
      const found = current?.deliveries.find(item => item.attemptId === delivery.attemptId)
      check(found && (!delivery.sessionId || found.sessionId === delivery.sessionId), 'delivery身份不可改写')
      for (const field of ['deliveredAt', 'ingestedAt']) if (delivery[field]) check(found[field] === delivery[field], '消费事实不可改写')
    }
  }
  for (const attempt of old.attempts) {
    const current = next.attempts.find(item => item.attempt_id === attempt.attempt_id)
    check(current && isDeepStrictEqual({ ...binding(attempt), session_id: null }, { ...binding(current), session_id: null })
      && (!attempt.session_id || attempt.session_id === current.session_id) && current.observed_revision >= attempt.observed_revision && current.modelRequestsReserved >= attempt.modelRequestsReserved, 'Attempt绑定不可改写')
    check(isDeepStrictEqual(current.nodeSnapshot, attempt.nodeSnapshot) && isDeepStrictEqual(current.resourceSnapshots, attempt.resourceSnapshots) && isDeepStrictEqual(current.grant, attempt.grant) && current.employeeRevision === attempt.employeeRevision && isDeepStrictEqual(current.modelSnapshot, attempt.modelSnapshot) && isDeepStrictEqual(current.resource_refs, attempt.resource_refs), 'Attempt授权快照不可改写')
    if (['cancelled', 'completed'].includes(attempt.status)) check(current.status === attempt.status, '人工停止不可撤销')
  }
}
