import { assertWorkMemberAccess, workMemberAffected } from '../../src/work-member-removal.mjs'
import { assertManualExecution } from '../../src/manual-control.mjs'
import { SPREADSHEET_CANDIDATE_SCHEMA } from '../agent-contracts/spreadsheet-collaboration.mjs'
import { adoptSpreadsheetSources, bindSpreadsheetOutput, validateSpreadsheetCandidate } from '../../src/spreadsheet-sources.mjs'
import { applyConversation, assertRequiredMessagesConsumed, assertWaitGraph } from './conversations.mjs'
import { assertEvidenceReader, shareEvidence, evidenceBinding } from '../../src/evidence-access.mjs'
import { buildExecutionCommand } from './commands.mjs'
import { COMMAND_FETCH_LIMIT, RESULT_PAYLOAD_LIMIT, jsonBytes } from '../agent-contracts/command-bytes.mjs'
import { snapshotNode, assertNodeExecution } from '../agent-contracts/nodes.mjs'
import { employeeModelRoute } from '../../src/model-route.mjs'
import { authorizeMultisiteExecution } from '../../src/multisite-authorization.mjs'
import { delegationRequest, delegationResult, ids, multisitePolicy, DELEGATION_RESULT_SCHEMA, ANALYSIS_RESULT_SCHEMA, resultPayload, evidenceReferences } from '../agent-contracts/delegation.mjs'
import { binding, digest, error, exact, key, text, sameBinding } from '../agent-contracts/index.mjs'

const intersect = (left, right) => left.filter(id => right.includes(id))
const subset = (requested, allowed) => requested.every(id => allowed.includes(id))
export function rootGrant(employee, owner) {
  if (!employee.multisitePolicy) return undefined
  const policy = multisitePolicy(employee.multisitePolicy)
  if (!subset(policy.execution.resourceRefs, employee.placement.resourceRefs)) throw error('FORBIDDEN', '执行资源超出节点上限')
  return { execution: policy.execution, delegation: { ...policy.delegation, agentIds: intersect(policy.delegation.agentIds, owner.employeeIds) } }
}
export function assertDelegationAuthority(state, attempt, { replay = false, sealedTransport = false, questionLifecycle = false, sourceData = false } = {}) {
  if (workMemberAffected(state, attempt)) throw error('FORBIDDEN', '本工作成员资格或当前委派链已撤销')
  if (!attempt.grant) return
  const work = state.works.find(row => row.id === attempt.work_id), owner = state.members.find(row => row.id === work?.ownerMemberId && row.enabled)
  const seen = new Set()
  let current = attempt
  while (current) {
    assertNodeExecution(state, current)
    const employee = state.employees.find(row => row.id === current.agent_id && row.enabled)
    if (seen.has(current.agent_id) || !owner?.employeeIds.includes(current.agent_id) || !employee?.multisitePolicy || employee.revision !== current.employeeRevision || employee.placement?.nodeId !== current.node_id) throw error('FORBIDDEN', '委派链授权已变化')
    seen.add(current.agent_id)
    const policy = multisitePolicy(employee.multisitePolicy)
    if (!subset(current.grant.execution.capabilityIds, policy.execution.capabilityIds) || !subset(current.grant.execution.resourceRefs, policy.execution.resourceRefs) || !subset(current.grant.execution.resourceRefs, employee.placement.resourceRefs) || !subset(current.grant.delegation.agentIds, policy.delegation.agentIds) || !subset(current.grant.delegation.capabilityIds, policy.delegation.capabilityIds) || !subset(current.grant.delegation.resourceRefs, policy.delegation.resourceRefs)) throw error('FORBIDDEN', '执行授权已撤销')
    if (current.parent_delegation_id === null) break
    const parent = state.multisite.attempts.find(row => row.delegation_id === current.parent_delegation_id && state.multisite.delegations.some(delegation => delegation.id === row.delegation_id && delegation.currentAttemptId === row.attempt_id))
    if (!parent?.grant || !replay && (['stopping', 'cancelled'].includes(parent.status) || !sourceData && parent.status === 'completed' || !sealedTransport && !questionLifecycle && parent.status === 'unknown') || !parent.grant.delegation.agentIds.includes(current.agent_id) || !subset(current.grant.execution.capabilityIds, parent.grant.delegation.capabilityIds) || !subset(current.grant.execution.resourceRefs, parent.grant.delegation.resourceRefs)) throw error('FORBIDDEN', '父委派授权已失效')
    current = parent
  }
}
function currentInput(state, attempt, revision) {
  const work = state.works.find(row => row.id === attempt.work_id)
  if (revision !== work.instructionRevision || attempt.instruction_revision !== revision || attempt.observed_revision < revision || !state.multisite.inputs.some(row => row.workId === work.id && row.revision === revision && row.deliveries.some(delivery => delivery.attemptId === attempt.attempt_id && delivery.ingestedAt))) throw error('REVISION_CONFLICT', '执行尚未消费当前用户要求')
  return work
}
function dependencyMessage(parent, wait, result, at) {
  return { id: key(result.id, parent.attempt_id), workId: parent.work_id, senderBinding: result.senderBinding, kind: 'dependency_result', targetAttemptId: parent.attempt_id,
    replyTo: wait.id, sourceDelegationId: result.delegationId, instructionRevision: wait.instructionRevision, resultRef: result.id, createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null }
}
const wakeInput = (wait, messages) => ({ id: wait.id, revision: wait.instructionRevision, text: '子委派结果已可用。', messages, waitRelease: { kind: 'dependency', id: wait.id } })
export function waitEnvelopeBytes(state, parent, wait, workspaceId) {
  const messages = []; let pending = 0
  for (const id of wait.dependencyIds) {
    const result = state.multisite.results.find(row => row.delegationId === id && row.instructionRevision === wait.instructionRevision && !row.historical)
    if (result && state.multisite.messages.some(row => row.id === key(result.id, parent.attempt_id))) continue
    const child = state.multisite.attempts.find(row => row.delegation_id === id && state.multisite.delegations.some(delegation => delegation.id === id && delegation.currentAttemptId === row.attempt_id))
    const candidate = result ?? { id: key('result', child.attempt_id, 'upper-bound'), delegationId: id, senderBinding: { ...binding(child), session_id: child.session_id ?? `geneway-${child.launch_id}` }, payload: null }
    messages.push({ ...dependencyMessage(parent, { ...wait, instructionRevision: Number.MAX_SAFE_INTEGER }, candidate, '+275760-09-13T00:00:00.000Z'), result: candidate.payload })
    if (!result) pending++
  }
  const preview = { ...parent, execution_epoch: Number.MAX_SAFE_INTEGER, instruction_revision: Number.MAX_SAFE_INTEGER, observed_revision: Number.MAX_SAFE_INTEGER, employeeRevision: Number.MAX_SAFE_INTEGER }
  const command = buildExecutionCommand(state, preview, 'wake', wakeInput({ ...wait, instructionRevision: Number.MAX_SAFE_INTEGER }, messages), workspaceId)
  return jsonBytes(command) + pending * (RESULT_PAYLOAD_LIMIT - jsonBytes(null))
}
export function wakeDependencies(state, work, queue, at) {
  for (const wait of state.multisite.dependencyWaits.filter(row => row.workId === work.id && row.instructionRevision === work.instructionRevision && !row.wokenAt)) {
    const parent = state.multisite.attempts.find(row => row.attempt_id === wait.parentAttemptId)
    if (!parent || ['stopping', 'cancelled', 'completed', 'unknown'].includes(parent.status)) continue
    const results = wait.dependencyIds.map(id => state.multisite.results.find(row => row.delegationId === id && row.instructionRevision === wait.instructionRevision && !row.historical))
    if (results.some(row => !row)) continue
    wait.wokenAt = at
    for (const result of results) {
      const message = dependencyMessage(parent, wait, result, at)
      if (!state.multisite.messages.some(row => row.id === message.id)) state.multisite.messages.push(message)
    }
    parent.status = 'running'
    queue(state, parent, 'wake', wakeInput(wait, state.multisite.messages.filter(row => row.replyTo === wait.id).map(row => ({ ...row, result: state.multisite.results.find(result => result.id === row.resultRef).payload }))), at)
  }
}
export function applyAgentCommand(state, execution, operation, parameters, { queue, workspaceId, requireRemoteNodes = false, analysisValidation, candidateValidation, at }) {
  const commandId = text(parameters.clientRequestId), namespace = key(workspaceId, execution.attempt_id, commandId), payloadDigest = digest({ operation, parameters })
  const old = state.multisite.commands.find(row => row.key === namespace && row.issuerKind === 'agent')
  if (old) {
    const current = state.multisite.attempts.find(row => row.attempt_id === execution.attempt_id), work = state.works.find(row => row.id === current?.work_id), owner = state.members.find(row => row.id === work?.ownerMemberId && row.enabled), root = state.employees.find(row => row.id === work?.employeeId && row.enabled)
    if (!current || !sameBinding(current, execution) || !owner?.employeeIds.includes(root?.id) || root.revision !== work.coordinatorRevision) throw error('FORBIDDEN')
    if (old.digest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT')
    if (workMemberAffected(state, current)) {
      const receiptKeys = new Set(['workId','delegationId','attemptId','resultId','messageId','questionId','responsibleAttemptId','targetAttemptId','waitId','status'])
      if (!Object.keys(old.reply).every(field => receiptKeys.has(field) && (typeof old.reply[field] === 'string' || old.reply[field] === null))) throw error('FORBIDDEN', '成员资格已撤销，原回执不授予重新取数权限')
    } else assertDelegationAuthority(state, current, { replay: true })
    return structuredClone(old.reply)
  }
  const access = authorizeMultisiteExecution(state, execution), { current: parent, work, owner } = access
  if (!parent.grant) throw error('FORBIDDEN', '未配置主动协作授权')
  assertDelegationAuthority(state, parent)
  if (operation === 'complete_delegation' && Number.isSafeInteger(parameters.instructionRevision) && parameters.instructionRevision > 0 && parameters.instructionRevision < work.instructionRevision) {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'result'])
    const revision = parameters.instructionRevision
    if (parent.parent_delegation_id === null || !state.multisite.inputs.some(input => input.workId === work.id && input.revision === revision && input.deliveries.some(delivery => delivery.attemptId === parent.attempt_id && delivery.sessionId === parent.session_id && delivery.ingestedAt))) throw error('REVISION_CONFLICT', '旧要求未被当前执行实际消费')
    if (state.modelRequests.some(row => row.attempt_id === parent.attempt_id && row.instructionRevision === revision && row.outcome === 'unknown')) throw error('RUNTIME_REQUEST_UNKNOWN')
    const schema = state.multisite.delegations.find(row => row.id === parent.delegation_id).resultSchema ?? DELEGATION_RESULT_SCHEMA
    const payload = resultPayload(parameters.result, schema, { admission: true })
    for (const ref of payload.evidenceRefs) {
      if (ref.kind === 'evidence') { assertEvidenceReader(state, execution, work.instructionRevision, ref); continue }
      const rows = ref.kind === 'attachment' ? state.attachments : state.artifacts
      if (!rows.some(row => row.id === ref.id && row.workId === work.id && row.ownerMemberId === owner.id && row.status === 'ready' && row.version === ref.version && row.sha256 === ref.sha256)) throw error('FORBIDDEN')
    }
    const id = key('result', parent.attempt_id, commandId), reply = { workId: work.id, resultId: id, status: 'historical' }
    state.multisite.results.push({ id, workId: work.id, delegationId: parent.delegation_id, senderBinding: binding(parent), instructionRevision: revision, schema, payloadDigest: digest(payload), payload, acceptedAt: at, historical: true })
    state.multisite.commands.push({ key: namespace, workspaceId, issuerId: parent.attempt_id, issuerKind: 'agent', senderBinding: binding(parent), commandId, digest: payloadDigest, reply: structuredClone(reply), acceptedAt: at })
    return reply
  }
  currentInput(state, parent, parameters.instructionRevision)
  if (work.modelRequestBudget.exhaustedAt) throw error('BUDGET_EXHAUSTED')
  let reply
  if (['publish_observation', 'ask_agent', 'answer_agent'].includes(operation)) {
    reply = applyConversation(state, execution, operation, parameters, { parent, work, namespace, queue, at })
  } else if (operation === 'adopt_sources') {
    reply = adoptSpreadsheetSources(state, execution, parameters, namespace, at)
  } else if (operation === 'delegate') {
    const request = delegationRequest(parameters), ancestors = new Set(), chain = []
    assertWorkMemberAccess(state, work.id, request.targetAgentId)
    let cursor = parent
    while (cursor) { ancestors.add(cursor.agent_id); chain.push(cursor.delegation_id); cursor = state.multisite.attempts.find(row => row.delegation_id === cursor.parent_delegation_id) }
    if (chain.length > 3 || state.multisite.delegations.filter(row => row.workId === work.id && row.parentDelegationId !== null).length >= 8) throw error('CAPACITY_EXCEEDED', '主动委派深度或数量达到上限')
    if (ancestors.has(request.targetAgentId)) throw error('DEPENDENCY_CYCLE', '不能委派给祖先 Agent')
    if (state.multisite.delegations.some(row => chain.includes(row.parentDelegationId) && row.agentId === request.targetAgentId && row.instructionRevision === work.instructionRevision)) throw error('DUPLICATE_DEPENDENCY', '同一依赖链不能重复委派')
    const target = state.employees.find(row => row.id === request.targetAgentId && row.enabled && owner.employeeIds.includes(row.id)), scope = parent.grant.delegation
    assertManualExecution(state, { work_id: work.id, agent_id: request.targetAgentId })
    if (!target?.multisitePolicy || !scope.agentIds.includes(target.id) || !scope.capabilityIds.includes(request.requestedCapabilityId) || !subset(request.resourceRefs, scope.resourceRefs)) throw error('FORBIDDEN', '请求超出父委派授权')
    const policy = multisitePolicy(target.multisitePolicy)
    if (!policy.execution.capabilityIds.includes(request.requestedCapabilityId) || !subset(request.resourceRefs, policy.execution.resourceRefs) || !subset(request.resourceRefs, target.placement?.resourceRefs ?? [])) throw error('FORBIDDEN', '目标能力或资源未获准')
    if (state.multisite.attempts.some(row => row.agent_id === target.id && !['completed', 'cancelled'].includes(row.status))) throw error('AGENT_BUSY', '目标 Agent 已有活动执行')
    const delegationId = key('delegation', parent.attempt_id, commandId), attemptId = key('attempt', delegationId, '1')
    const grant = { execution: { capabilityIds: [request.requestedCapabilityId], resourceRefs: request.resourceRefs }, delegation: { agentIds: intersect(intersect(scope.agentIds, policy.delegation.agentIds), owner.employeeIds).filter(id => !ancestors.has(id) && id !== target.id), capabilityIds: intersect(scope.capabilityIds, policy.delegation.capabilityIds), resourceRefs: intersect(scope.resourceRefs, policy.delegation.resourceRefs) } }
    const child = { work_id: work.id, delegation_id: delegationId, parent_delegation_id: parent.delegation_id, attempt_id: attemptId, execution_epoch: 1, agent_id: target.id, node_id: target.placement.nodeId, launch_id: key('launch', attemptId), session_id: null,
      instruction_revision: work.instructionRevision, observed_revision: 0, modelRequestsReserved: 0, employeeRevision: target.revision, modelSnapshot: employeeModelRoute(state, target), resource_refs: [...grant.execution.resourceRefs], grant, status: 'accepted' }
    snapshotNode(state, child, { required: requireRemoteNodes })
    state.multisite.delegations.push({ id: delegationId, workId: work.id, parentDelegationId: parent.delegation_id, fromAgent: parent.agent_id, agentId: target.id, currentAttemptId: attemptId, status: 'accepted', goal: request.goal, requestedCapabilityId: request.requestedCapabilityId, resultSchema: request.resultSchema, instructionRevision: work.instructionRevision, policyRevision: target.revision, grant: structuredClone(grant), ...(request.evidenceRefs ? { evidenceRefs: structuredClone(request.evidenceRefs) } : {}) })
    state.multisite.attempts.push(child)
    bindSpreadsheetOutput(state, parent, child, request.resultSchema, namespace, at)
    if (request.evidenceRefs?.length) shareEvidence(state, execution, child, request.evidenceRefs, { reason: 'delegate', sourceCommandKey: namespace, at })
    const input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === work.instructionRevision)
    input.deliveries.push({ attemptId, sessionId: null, deliveredAt: null, ingestedAt: null })
    queue(state, child, 'launch', input, at)
    reply = { workId: work.id, delegationId, attemptId, status: 'accepted' }
  } else if (operation === 'share_evidence') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'targetAttemptId', 'evidenceRefs']); evidenceReferences(parameters.evidenceRefs)
    const receiver = state.multisite.attempts.find(row => row.attempt_id === parameters.targetAttemptId && row.work_id === work.id)
    if (!receiver) throw error('FORBIDDEN')
    shareEvidence(state, execution, receiver, parameters.evidenceRefs, { reason: 'share', sourceCommandKey: namespace, at })
    reply = { workId: work.id, targetAttemptId: receiver.attempt_id, status: 'shared' }
  } else if (operation === 'wait_dependencies') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'dependencyIds'])
    const dependencyIds = ids(parameters.dependencyIds, '依赖委派')
    if (!dependencyIds.length || dependencyIds.some(id => !state.multisite.delegations.some(row => row.id === id && row.parentDelegationId === parent.delegation_id && state.multisite.attempts.find(attempt => attempt.attempt_id === row.currentAttemptId)?.instruction_revision === work.instructionRevision))) throw error('FORBIDDEN', '只能等待当前要求的直接子委派')
    if (dependencyIds.every(id => state.multisite.messages.some(row => row.kind === 'dependency_result' && row.targetAttemptId === parent.attempt_id && row.sourceDelegationId === id && row.instructionRevision === work.instructionRevision))) throw error('INVALID_STATE', '这些依赖结果已定向投递')
    if (state.multisite.dependencyWaits.some(row => row.parentAttemptId === parent.attempt_id && row.instructionRevision === work.instructionRevision && (!row.wokenAt || state.multisite.messages.some(message => message.replyTo === row.id && !message.ingestedAt) || row.dependencyIds.length === dependencyIds.length && row.dependencyIds.every(id => dependencyIds.includes(id))))) throw error('INVALID_STATE', '已有活动依赖等待')
    assertWaitGraph(state, parent.attempt_id, dependencyIds.map(id => state.multisite.delegations.find(row => row.id === id).currentAttemptId))
    const generation = state.multisite.dependencyWaits.filter(row => row.parentAttemptId === parent.attempt_id).length + 1, id = key('wait', parent.attempt_id, generation)
    const wait = { id, workId: work.id, parentAttemptId: parent.attempt_id, instructionRevision: work.instructionRevision, dependencyIds, waitGeneration: generation, createdAt: at, wokenAt: null }
    const upperBytes = waitEnvelopeBytes(state, parent, wait, workspaceId)
    if (upperBytes > COMMAND_FETCH_LIMIT) throw error('COMMAND_TOO_LARGE', '依赖回报合计过大，请减少本次等待的依赖，分批等待。')
    state.multisite.dependencyWaits.push({ ...wait, envelopeVersion: 1, upperBytes })
    parent.status = 'waiting_dependency'
    wakeDependencies(state, work, queue, at)
    reply = { workId: work.id, waitId: id, status: 'waiting_dependency' }
  } else if (operation === 'complete_delegation') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'result'])
    if (parent.parent_delegation_id === null) throw error('INVALID_STATE', '根协调执行不能以子回报完成整个工作')
    if (state.modelRequests.some(row => row.attempt_id === parent.attempt_id && row.outcome === 'unknown')) throw error('RUNTIME_REQUEST_UNKNOWN')
    assertRequiredMessagesConsumed(state, parent, work.instructionRevision)
    if (state.multisite.questions.some(row => row.state === 'open' && (row.senderBinding.attempt_id === parent.attempt_id || row.responsibleAttemptId === parent.attempt_id))) throw error('DEPENDENCIES_PENDING', '定向问题尚未处理')
    if (work.pendingQuestion || state.multisite.attempts.some(row => row.parent_delegation_id === parent.delegation_id && !['completed', 'cancelled'].includes(row.status))) throw error('DEPENDENCIES_PENDING')
    const schema = state.multisite.delegations.find(row => row.id === parent.delegation_id).resultSchema ?? DELEGATION_RESULT_SCHEMA
    const payload = resultPayload(parameters.result, schema, { admission: true })
    for (const ref of payload.evidenceRefs) {
      if (ref.kind === 'evidence') { assertEvidenceReader(state, execution, work.instructionRevision, ref); continue }
      const rows = ref.kind === 'attachment' ? state.attachments : state.artifacts
      if (!rows.some(row => row.id === ref.id && row.workId === work.id && row.status === 'ready' && row.version === ref.version && row.sha256 === ref.sha256 && row.ownerMemberId === owner.id)) throw error('FORBIDDEN', '证据不属于当前工作')
    }
    if (schema === ANALYSIS_RESULT_SCHEMA && (!analysisValidation || analysisValidation.payloadDigest !== digest(payload) || analysisValidation.instructionRevision !== work.instructionRevision)) throw error('INVALID_REQUEST', '分析来源尚未校验')
    if (schema === SPREADSHEET_CANDIDATE_SCHEMA) { if (!candidateValidation || candidateValidation.payloadDigest !== digest(payload) || candidateValidation.instructionRevision !== work.instructionRevision) throw error('INVALID_REQUEST', '候选字节尚未核验'); validateSpreadsheetCandidate(state, execution, payload) }
    const receiver = state.multisite.attempts.find(row => row.delegation_id === parent.parent_delegation_id && state.multisite.delegations.some(item => item.id === row.delegation_id && item.currentAttemptId === row.attempt_id))
    if (payload.evidenceRefs.some(ref => ref.kind === 'evidence')) shareEvidence(state, execution, receiver, payload.evidenceRefs.filter(ref => ref.kind === 'evidence'), { reason: 'result', sourceCommandKey: namespace, at })
    const id = key('result', parent.attempt_id, commandId)
    state.multisite.results.push({ id, workId: work.id, delegationId: parent.delegation_id, senderBinding: binding(parent), instructionRevision: work.instructionRevision, schema, payloadDigest: digest(payload), payload, acceptedAt: at })
    parent.status = 'completed'; parent.resultId = id
    state.multisite.delegations.find(row => row.id === parent.delegation_id).status = 'completed'
    queue(state, parent, 'settle', null, at)
    reply = { workId: work.id, resultId: id, status: 'completed' }
  } else throw error('INVALID_REQUEST')
  state.multisite.commands.push({ key: namespace, workspaceId, issuerId: parent.attempt_id, issuerKind: 'agent', senderBinding: binding(parent), commandId, digest: payloadDigest, reply: structuredClone(reply), acceptedAt: at })
  return reply
}

// Classify only the existing result schema parser, after the original caller
// rejection. No payload is retained and no business transition is retried.
export function authorizedResultStructureRejection(state, execution, parameters) {
  const { current, work } = authorizeMultisiteExecution(state, execution)
  assertDelegationAuthority(state, current)
  exact(parameters, ['clientRequestId', 'instructionRevision', 'result']); text(parameters.clientRequestId)
  if (current.parent_delegation_id === null || parameters.instructionRevision !== work.instructionRevision) return false
  currentInput(state, current, parameters.instructionRevision)
  const schema = state.multisite.delegations.find(row => row.id === current.delegation_id)?.resultSchema ?? DELEGATION_RESULT_SCHEMA
  try { resultPayload(parameters.result, schema, { admission: true }); return false } catch (cause) { if (cause.code === 'INVALID_REQUEST') return true; throw cause }
}
