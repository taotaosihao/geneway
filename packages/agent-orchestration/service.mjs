import { stoppedJobHistory } from '../../src/spreadsheet-job-history.mjs'
import { isCloudOrdinaryCapacityError } from '../../src/cloud-capacity.mjs'
import { submitSiteDiagnosis } from '../../src/site-rule-service.mjs'
import { assertCurrentSiteRule } from '../../src/site-rule-state.mjs'
import { removeWorkMember, workMemberAffected } from '../../src/work-member-removal.mjs'
import { applyA2aTransition } from '../../src/a2a-state.mjs'
import { queueContextReadWindows, recordContextWindowDelivery } from '../../src/context-read-delivery.mjs'
import { applyManualControl, assertManualControlOwner, assertManualExecution, assertManualConsumption } from '../../src/manual-control.mjs'
import { authorizeManualResume, queueManualResumes, recordManualResumeConsumption } from '../../src/manual-resume.mjs'
import { preparationForJob } from '../../src/spreadsheet-preparation.mjs'
import { authorizeExecutionCommand } from './execution-dispatch.mjs'
import { authorizeIntentDelivery, authorizeIntentQuestionClosure, pendingIntentReview } from '../../src/interaction-state.mjs'
import { SPREADSHEET_CANDIDATE_SCHEMA } from '../agent-contracts/spreadsheet-collaboration.mjs'
import { currentOutput } from '../../src/spreadsheet-sources.mjs'
import { queueBudgetResumes } from './budgets.mjs'
import { initializeWorkBudget } from '../../src/work-budget.mjs'
import { closeQuestions, invalidQuestion } from './conversations.mjs'
import { queueExecutionCommand } from './commands.mjs'
import { snapshotNode, assertNodeCaller } from '../agent-contracts/nodes.mjs'
import { assertSpreadsheetAuthority } from '../agent-contracts/tools.mjs'
import { applyAgentCommand, wakeDependencies, rootGrant, assertDelegationAuthority, authorizedResultStructureRejection } from './dependencies.mjs'
import { isCollaborationSpreadsheet, spreadsheetRequest } from '../../src/spreadsheet-template.mjs'
import { employeeModelRoute } from '../../src/model-route.mjs'
import { randomUUID } from 'node:crypto'
import { binding, digest, error, exact, key, placement, SCHEMA, seal, text, assertSealed, sameBinding, attachmentRefs } from '../agent-contracts/index.mjs'
import { receiveInput } from './intake.mjs'
import { assignmentEvent } from './assignments.mjs'
import { authorizeSpreadsheetJobReceipt, authorizeManualControlCommand, authorizeQuestionParticipant, authorizeMultisiteExecution, authorizeBudgetControlCommand, authorizeQuestionClosureCommand } from '../../src/multisite-authorization.mjs'

export function createMultisiteService({ store, workspaceId = 'local', hosts = [], clock = () => new Date().toISOString(), kick = () => {}, attachments, requireRemoteNodes = false, onError = () => {}, evidence, spreadsheetArtifacts }) {
  const byNode = new Map(hosts.map(host => [host.nodeId, host]))
  let draining, timer, interactionService, continuationScan, continuationOffset = 0
  const member = (state, actor) => {
    const found = state.members.find(item => item.id === actor?.id && item.enabled)
    if (!found) throw error('UNAUTHORIZED', '会话无效')
    return found
  }
  function authorizeRead(state, actor, workId) {
    const user = member(state, actor), work = state.works.find(item => item.id === workId && item.workType === 'multisite' && item.ownerMemberId === user.id)
    if (!work) throw error('NOT_FOUND', '工作不存在')
    if (!user.employeeIds.includes(work.employeeId)) throw error('FORBIDDEN', 'Agent 授权已撤销')
    return { user, work }
  }
  function authorizeTargets(state, user, ids) {
    return ids.map(id => {
      const employee = state.employees.find(item => item.id === id && item.enabled === true && user.employeeIds.includes(id))
      if (!employee) throw error('FORBIDDEN', 'Agent 未获准')
      placement(employee.placement)
      return employee
    })
  }
  const queue = (state, attempt, operation, input, at) => queueExecutionCommand(state, attempt, operation, input, at, workspaceId)
  function stopWork(state, work, at) {
    const attempts = state.multisite.attempts.filter(item => item.work_id === work.id && !['cancelled', 'completed'].includes(item.status))
    if (attempts.length) work.status = 'stopping'
    for (const attempt of attempts) { attempt.status = 'stopping'; queue(state, attempt, 'cancel', null, at) }
    for (const question of state.userQuestions.filter(row => row.workId === work.id && row.state === 'open')) { question.state = 'cancelled'; question.closedAt = at }; delete work.pendingQuestion
    closeQuestions(state, row => row.workId === work.id, 'WORK_CANCELLED', { queue, at })
    for (const hold of state.budgetHolds.filter(row => row.work_id === work.id && ['waiting', 'resume_queued'].includes(row.state))) { hold.state = 'cancelled'; hold.cancelledReason = 'WORK_CANCELLED'; hold.cancelledAt = at }
  }
  function cancelSiteRuleWork(state, work, at) {
    if (work.origin !== 'rule' || !state.works.includes(work)) throw error('FORBIDDEN')
    if (!['completed', 'cancelled', 'stopping'].includes(work.status)) stopWork(state, work, at)
  }
  function applyTransition(state, actor, operation, parameters, context) {
    const commandId = text(parameters.clientRequestId, '命令 ID')
    const issuerId = member(state, actor).id
    const normalized = { operation, parameters: structuredClone(parameters), ...(context?.siteRule ? { siteRule: context.siteRule } : {}) }
    delete normalized.parameters.clientRequestId
    const payloadDigest = digest(normalized), namespace = key(workspaceId, issuerId, commandId)
    let reply, attachmentState, references = []

      const user = member(state, actor)
      const previous = state.multisite.commands.find(item => item.key === namespace)
      if (previous) {
        if (operation === 'cancel' || operation === 'remove-member') {
          if (!state.works.some(work => work.id === previous.reply.workId && work.ownerMemberId === user.id && work.workType === 'multisite')) throw error('NOT_FOUND')
        } else authorizeRead(state, actor, previous.reply.workId)
        if (previous.digest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT', '命令 ID 已被其他内容使用')
        references = attachmentRefs(parameters.attachmentRefs)
        attachmentState = state
        if (references.length && !attachments) throw error('INVALID_STATE', '附件服务未配置')
        if (references.length) attachments.bind(state, actor, references, state.works.find(work => work.id === previous.reply.workId))
        reply = structuredClone(previous.reply); return { reply, references, attachmentState }
      }
      const at = clock()
      let work
      if (operation === 'create') {
        exact(parameters, ['workType', 'employeeId', 'goal', 'targets', 'clientRequestId', 'attachmentRefs', 'spreadsheetRequest', 'budgetPolicyId'])
        const coordinatorId = text(parameters.employeeId, '协调 Agent'), goal = text(parameters.goal, '目标')
        const ids = parameters.targets ?? [coordinatorId]
        if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw error('INVALID_REQUEST', '目标 Agent 无效')
        authorizeTargets(state, user, [coordinatorId])
        const requestedOutput = parameters.spreadsheetRequest === undefined ? undefined : spreadsheetRequest(parameters.spreadsheetRequest)
        if (requestedOutput && ids.length !== 1) throw error('INVALID_REQUEST', '整改表场景只支持一个执行员工')
        const employees = authorizeTargets(state, user, ids)
        const workId = `work-${randomUUID()}`
        work = { id: workId, workType: 'multisite', workspaceId, ownerMemberId: user.id, employeeId: coordinatorId,
          coordinatorRevision: state.employees.find(item => item.id === coordinatorId).revision ?? 1,
          skillId: 'multisite-collaboration', capabilityId: 'multisite-collaboration', goal, input: {}, requiredInputs: [],
          instructionRevision: 1, modelRequestBudget: initializeWorkBudget(state, parameters.budgetPolicyId, workspaceId, coordinatorId, at), status: 'accepted', acceptedAt: at, results: [], actions: [], executions: [], conversationId: null }
        if (context?.siteRule) {
          if (requestedOutput || parameters.attachmentRefs || ids.length !== 1 || ids[0] !== coordinatorId) throw error('FORBIDDEN')
          Object.assign(work, { origin: 'rule', siteRule: structuredClone(context.siteRule) })
          assertCurrentSiteRule(state, work, undefined, Date.parse(at))
        }
        if (requestedOutput) work.spreadsheetRequest = requestedOutput
        state.works.push(work)
        for (const employee of employees) {
          const delegationId = key('delegation', workId, employee.id), attemptId = key('attempt', delegationId, '1')
          const attempt = { work_id: workId, delegation_id: delegationId, parent_delegation_id: null, attempt_id: attemptId,
            execution_epoch: 1, agent_id: employee.id, node_id: employee.placement.nodeId, launch_id: key('launch', attemptId), session_id: null,
            instruction_revision: 1, observed_revision: 0, modelRequestsReserved: 0, employeeRevision: employee.revision ?? 1, modelSnapshot: employeeModelRoute(state, employee), resource_refs: [...employee.placement.resourceRefs], status: 'accepted' }
          const grant = rootGrant(employee, user)
          if (grant) { attempt.grant = grant; attempt.resource_refs = [...grant.execution.resourceRefs] }
          snapshotNode(state, attempt, { required: requireRemoteNodes })
          if (requestedOutput && !isCollaborationSpreadsheet(requestedOutput)) assertSpreadsheetAuthority(attempt)
          if (grant && state.multisite.attempts.some(row => row.agent_id === employee.id && !['completed', 'cancelled'].includes(row.status))) throw error('AGENT_BUSY')
          state.multisite.delegations.push({ id: delegationId, workId, parentDelegationId: null, agentId: employee.id, currentAttemptId: attemptId, status: 'accepted', ...(grant ? { goal, grant: structuredClone(grant), policyRevision: employee.revision, resultSchema: 'geneway.delegation-result/1' } : {}) })
          state.multisite.attempts.push(attempt)
        }
        const attempts = state.multisite.attempts.filter(item => item.work_id === workId)
        references = attachmentRefs(parameters.attachmentRefs)
        if (references.length && !attachments) throw error('INVALID_STATE', '附件服务未配置')
        if (references.length) attachments.bind(state, actor, references, work)
        const input = receiveInput(state, work, { issuerId, commandId, text: goal, attachmentRefs: references, spreadsheetRequest: work.spreadsheetRequest }, attempts, at)
        if (context?.continuationContext) input.continuationContext = structuredClone(context.continuationContext)
        for (const attempt of attempts) queue(state, attempt, 'launch', input, at)
      } else {
        exact(parameters, operation === 'input' ? ['workId', 'text', 'clientRequestId', 'attachmentRefs', 'spreadsheetRequest', 'revisionScope', 'replyToQuestion', 'expectedInstructionRevision'] : operation === 'remove-member' ? ['workId', 'employeeId', 'clientRequestId'] : ['pause', 'resume'].includes(operation) ? ['workId', 'clientRequestId', 'scope', 'expectedControlGeneration'] : ['workId', 'clientRequestId'])
        work = ['cancel', 'remove-member'].includes(operation) ? state.works.find(item => item.id === parameters.workId && item.ownerMemberId === user.id && item.workType === 'multisite')
          : authorizeRead(state, actor, parameters.workId).work
        if (!work) throw error('NOT_FOUND', '工作不存在')
        if (operation === 'remove-member') {
          const employeeId = text(parameters.employeeId, '员工 ID')
          removeWorkMember(state, work, user, employeeId, commandId, { queue, closeQuestions, at })
          interactionService?.reconcileSubscriptions(state, at)
          reply = { workId: work.id, commandId, status: work.status, employeeId, access: 'removed' }
        } else {
        if (work.status === 'completed') throw error('INVALID_STATE', '已完成工作请新建后续工作')
        const attempts = state.multisite.attempts.filter(item => item.work_id === work.id && !['completed', 'cancelled'].includes(item.status) && (operation === 'cancel' || !workMemberAffected(state, item)))
        if (operation === 'input') {
          if (work.origin === 'rule') throw error('FORBIDDEN', '受管诊断不接收其他业务要求')
          if (work.modelRequestBudget.exhaustedAt) throw error('BUDGET_EXHAUSTED', '本工作模型请求预算已耗尽')
          authorizeTargets(state, user, attempts.map(item => item.agent_id))
          if (['stopping', 'cancelled', 'interrupted'].includes(work.status)) throw error('INVALID_STATE', '人工停止后不能通过普通补充重启')
          const collaboration = isCollaborationSpreadsheet(work.spreadsheetRequest)
          if (collaboration && parameters.expectedInstructionRevision !== undefined && parameters.expectedInstructionRevision !== work.instructionRevision) throw error('REVISION_CONFLICT', '工作要求已更新，请刷新当前问题或修订')
          let answeredQuestion
          if (parameters.replyToQuestion !== undefined) {
            exact(parameters.replyToQuestion, ['id', 'instructionRevision'])
            const current = work.pendingQuestion, question = state.userQuestions.find(row => row.id === parameters.replyToQuestion.id && row.workId === work.id)
            if (!collaboration || parameters.expectedInstructionRevision !== work.instructionRevision || !question || question.state !== 'open' || current?.id !== question.id || question.instructionRevision !== work.instructionRevision || parameters.replyToQuestion.instructionRevision !== question.instructionRevision || !sameBinding(currentOutput(state, work).outputBinding, question.askingBinding) || !['running', 'waiting_budget', 'waiting_question', 'waiting_dependency'].includes(state.multisite.attempts.find(row => row.attempt_id === question.askingBinding.attempt_id)?.status)) throw error('REVISION_CONFLICT', '此问题已经失效，请刷新后回答当前问题')
            authorizeQuestionParticipant(state, question.askingBinding)
            answeredQuestion = question
          }
          references = attachmentRefs(parameters.attachmentRefs)
          if (references.length && !attachments) throw error('INVALID_STATE', '附件服务未配置')
          // The execution gateway consumes the complete Work history, with the same eight-ref bound.
          // Check only new admission: old command receipts and cancellation retain their semantics.
          attachmentRefs([...new Map([...state.multisite.inputs.filter(input => input.workId === work.id).flatMap(input => input.attachmentRefs), ...references].map(ref => [ref.attachmentId, ref])).values()])
          if (references.length) attachments.bind(state, actor, references, work)
          if (parameters.revisionScope !== undefined && (!collaboration || parameters.revisionScope !== 'due_date_only' || parameters.spreadsheetRequest === undefined || references.length || parameters.spreadsheetRequest.templateId !== work.spreadsheetRequest.templateId)) throw error('INVALID_REQUEST', '期限采纳必须明确限于原资料范围')
          if (parameters.spreadsheetRequest !== undefined) {
            if (work.spreadsheetRequest && work.spreadsheetRequest.templateId !== parameters.spreadsheetRequest.templateId) throw error('INVALID_REQUEST', '已有工作不能更换模板协议，请新建工作')
            if (!collaboration && attempts.length !== 1) throw error('INVALID_REQUEST', '整改表场景只支持一个执行员工')
            if (!collaboration) for (const attempt of attempts) assertSpreadsheetAuthority(attempt)
            work.spreadsheetRequest = spreadsheetRequest(parameters.spreadsheetRequest)
          }
          work.instructionRevision += 1
          const input = receiveInput(state, work, { issuerId, commandId, text: parameters.text, attachmentRefs: references, spreadsheetRequest: work.spreadsheetRequest, ...(collaboration ? { revisionScope: parameters.revisionScope ?? 'source_change' } : {}) }, attempts, at)
          if (collaboration) for (const question of state.userQuestions.filter(row => row.workId === work.id && row.state === 'open')) { question.state = question === answeredQuestion ? 'answered' : 'superseded'; question.closedAt = at; if (question === answeredQuestion) question.answeredByInputId = input.id }
          delete work.pendingQuestion
          for (const attempt of attempts) {
            attempt.instruction_revision = work.instructionRevision
            if (attempt.status === 'waiting_dependency') attempt.status = 'running'
            queue(state, attempt, 'deliver', input, at)
          }
          closeQuestions(state, row => row.workId === work.id, 'USER_REVISION_CHANGED', { queue, at, superseded: true })
          work.status = work.modelRequestBudget.version === 2 && (work.status === 'waiting_budget' || state.budgetHolds.some(row => row.work_id === work.id && row.state === 'waiting')) ? 'waiting_budget' : 'running'
        } else if (operation === 'pause' || operation === 'resume') {
          assertManualControlOwner(state, work, user)
          reply = applyManualControl(state, work, user, operation, parameters, at)
          interactionService?.reconcileSubscriptions(state, at)
        } else if (operation === 'cancel') {
          stopWork(state, work, at)
        } else throw error('INVALID_REQUEST')
        }
      }
      reply ??= { workId: work.id, commandId, status: work.status }
      attachmentState = state
      state.multisite.commands.push({ key: namespace, workspaceId, issuerId, commandId, digest: payloadDigest, reply: structuredClone(reply), acceptedAt: at })
      return { reply, references, attachmentState }
  }
  async function apply(actor, operation, parameters) {
    let transition
    await store.update(state => { transition = applyTransition(state, actor, operation, parameters); return state }, { beforeCommit: async () => { if (transition.references.length) await attachments.verifyReferences(transition.attachmentState, transition.references) } })
    try { kick() } catch { /* durable scan remains authoritative */ }
    scheduleContinuations()
    return transition.reply
  }

  async function applyA2a(scope, request) {
    if (scope.workspaceId !== workspaceId) throw error('FORBIDDEN')
    let transition
    await store.update(state => {
      transition = applyA2aTransition(state, scope, request, applyTransition)
      return state
    }, { beforeCommit: async () => { if (transition.references.length) await attachments.verifyReferences(transition.attachmentState, transition.references) } })
    try { kick() } catch { /* original durable dispatch remains authoritative */ }
    scheduleContinuations()
    return { taskId: transition.taskId, contextId: transition.contextId, receipt: transition.reply }
  }

  async function acceptHostEvent(authenticated, event) {
    assertSealed(event)
    if (authenticated.workspaceId !== workspaceId || event.workspace_id !== workspaceId || authenticated.nodeId !== event.node_id
      || !byNode.has(authenticated.nodeId) && !authenticated.remote) throw error('FORBIDDEN', '节点身份不匹配')
    let reply
    await store.update(state => {
      const old = state.multisite.receipts.find(item => item.event.event_id === event.event_id && item.nodeId === authenticated.nodeId)
      const denied = workMemberAffected(state, event)
      const lateJobHistory = authenticated.remote && stoppedJobHistory(state, authenticated, event)
      if (authenticated.remote) assertNodeCaller(state, authenticated, event, { cleanup: denied || lateJobHistory || ['stopped', 'settled'].includes(event.kind), receiptReplay: !!old && old.event.payload_digest === event.payload_digest })
      if (old) {
        if (old.event.payload_digest !== event.payload_digest) throw error('IDEMPOTENCY_CONFLICT')
        reply = old.ack; return state
      }
      const ruleWork = state.works.find(work => work.id === event.work_id && work.origin === 'rule')
      if (ruleWork && !['started','session_delivered','session_ingested','runtime_unavailable','stopped','settled','budget_idle','message_delivered','message_ingested','manual_idle','manual_released'].includes(event.kind)) throw error('FORBIDDEN')
      if (authenticated.remote && event.kind === 'spreadsheet_job' && !denied && !lateJobHistory) {
        assertNodeCaller(state, authenticated, event)
        const previous = state.multisite.jobs.find(job => job.id === event.job.id && sameBinding(job, event) && job.inputDigest === event.job.inputDigest && job.requestDigest === event.job.requestDigest), admitted = preparationForJob(state, event.job)
        assertSpreadsheetAuthority((previous || admitted ? authorizeSpreadsheetJobReceipt(state, event) : authorizeMultisiteExecution(state, event)).current)
        if (!previous && !admitted) assertManualConsumption(state, event)
      }
      const deniedJob = denied && event.kind === 'spreadsheet_job'
      const existingJob = deniedJob && state.multisite.jobs.find(job => job.id === event.job.id && sameBinding(job, event) && job.inputDigest === event.job.inputDigest && job.requestDigest === event.job.requestDigest)
      // Retain every sequence of an already admitted Job so its final stop proof
      // can arrive through the original FIFO; this does not admit uploads or ready.
      const jobCleanup = deniedJob && (existingJob || preparationForJob(state, event.job))
      const result = deniedJob && !jobCleanup ? { historical: true } : assignmentEvent(state, event, clock()); if (lateJobHistory) result.historical = true; interactionService?.reconcileSubscriptions(state,clock()); if (!result.historical) { recordManualResumeConsumption(state, event, clock()); recordContextWindowDelivery(state, event, clock()) }
      reply = { event_id: event.event_id, node_id: event.node_id, payload_digest: event.payload_digest, ...binding(event) }
      state.multisite.receipts.push({ nodeId: authenticated.nodeId, event: structuredClone(event), historical: result.historical, ack: reply })
      return state
    })
    scheduleContinuations()
    return reply
  }
  async function drain() {
    if (draining) return draining
    draining = (async () => {
      const failures = [], snapshot = await store.read()
      if (snapshot.multisite.questions.some(row => row.state === 'open' && invalidQuestion(snapshot, row))) await store.update(draft => {
        closeQuestions(draft, row => !!invalidQuestion(draft, row), 'EXECUTION_AUTHORITY_CHANGED', { queue, at: clock() }); return draft
      })
      await scanContinuations()
      const state = await store.read()
      for (const entry of state.multisite.outbox.filter(item => !item.acceptedAt)) {
        const host = byNode.get(entry.command.node_id)
        if (!host) continue
        try {
          const current = await store.read(), attempt = current.multisite.attempts.find(item => item.attempt_id === entry.command.attempt_id)
          const work = current.works.find(item => item.id === attempt?.work_id)
          if (!attempt || !work) throw error('NOT_FOUND')
          if (!['cancel', 'settle'].includes(entry.command.operation)) {
            const dispatch = entry.command, execution = { ...binding(dispatch), session_id: dispatch.session_id ?? `geneway-${dispatch.launch_id}` }
            authorizeExecutionCommand(current, dispatch)
            if (!['manual_pause', 'manual_release'].includes(dispatch.operation)) {
            assertDelegationAuthority(current, attempt)
            if (work.modelRequestBudget.exhaustedAt) continue
            const { user } = authorizeRead(current, { id: work.ownerMemberId }, work.id)
            const root = authorizeTargets(current, user, [work.employeeId])[0]
            const employee = authorizeTargets(current, user, [attempt.agent_id])[0]
            if ((root.revision ?? 1) !== work.coordinatorRevision || employee.revision !== attempt.employeeRevision || employee.placement.nodeId !== attempt.node_id) throw error('FORBIDDEN')
            if (['stopping', 'cancelled', 'unknown', 'completed'].includes(attempt.status)) continue
            const refs = attachmentRefs(entry.command.parameters.attachmentRefs)
            if (refs.length && !attachments) throw error('INVALID_STATE', '附件服务未配置')
            if (refs.length) await attachments.verifyReferences(current, refs)
            }
          }
          const ack = await host.accept({ workspaceId, nodeId: host.nodeId }, entry.command)
          if (ack.command_id !== entry.id || ack.payload_digest !== entry.command.payload_digest || ack.node_id !== host.nodeId || !sameBinding(ack, entry.command)) throw error('ACK_MISMATCH', 'Host ACK 不匹配')
          await store.update(draft => { const row = draft.multisite.outbox.find(item => item.id === entry.id); row.acceptedAt ??= clock(); delete row.blockedReason; delete row.blockedAt; return draft })
        } catch (cause) {
          if (['FORBIDDEN', 'UNAUTHORIZED', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING'].includes(cause.code)) {
            if (entry.blockedReason !== cause.code) await store.update(draft => { const row = draft.multisite.outbox.find(item => item.id === entry.id); row.blockedReason = cause.code; row.blockedAt ??= clock(); return draft })
          } else failures.push(cause)
        }
      }
      for (const host of hosts) {
        try { await host.process() } catch (cause) { failures.push(cause) }
        try { await host.flushEvents(event => acceptHostEvent({ workspaceId, nodeId: host.nodeId }, event)) } catch (cause) { failures.push(cause) }
      }
      if (failures.length) throw failures[0]
    })().finally(() => { draining = undefined })
    return draining
  }
  async function performAgentCommand(execution, operation, parameters, { nodeAuth, manualFence } = {}) {
    if (operation === 'submit_site_diagnosis') {
      let reply
      await store.update(state => {
        reply = submitSiteDiagnosis(state, execution, parameters, { nodeAuth, manualFence, queue, at: clock() })
        return state
      })
      try { kick() } catch {}
      return reply
    }
    if (['intent_context','accept_intent','handback_intent','ask_intent','reply_intent','split_intent'].includes(operation)) { if (!interactionService) throw error('FORBIDDEN'); return interactionService.intentCommand(execution,operation,parameters,{nodeAuth,manualFence}) }
    const initial = await store.read()
    if (initial.works.some(work => work.id === execution.work_id && work.origin === 'rule')) throw error('FORBIDDEN')
    if (!initial.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) assertManualConsumption(initial, execution)
    if (pendingIntentReview(initial,execution)) throw error('FORBIDDEN','本轮意图尚未受理，不允许普通业务工具')
    let reply, analysisValidation, candidateValidation, adoptionRefs, committedState
    if (operation === 'read_spreadsheet_candidate') { if (!spreadsheetArtifacts) throw error('FORBIDDEN'); return spreadsheetArtifacts.readCandidate(execution, parameters, nodeAuth, manualFence) }
    if (operation === 'review_spreadsheet_candidate') { if (!spreadsheetArtifacts) throw error('FORBIDDEN'); const snapshot = await store.read(); if (!snapshot.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) return spreadsheetArtifacts.reviewCandidate(execution, parameters, nodeAuth, manualFence) }
    if (operation === 'adopt_sources') { if (!evidence) throw error('FORBIDDEN'); const snapshot = await store.read(); if (!snapshot.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) adoptionRefs = await evidence.validateAdoption(execution, parameters) }
    if (operation === 'complete_delegation') {
      const snapshot = await store.read(), delegation = snapshot.multisite.delegations.find(row => row.id === execution.delegation_id)
      if (delegation?.resultSchema === SPREADSHEET_CANDIDATE_SCHEMA && !snapshot.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) { if (!spreadsheetArtifacts) throw error('FORBIDDEN'); candidateValidation = await spreadsheetArtifacts.validateCandidateResult(execution, parameters.result) }
      if (delegation?.resultSchema === 'geneway.analysis-result/1' && !snapshot.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) {
        if (!evidence) throw error('FORBIDDEN', '分析来源校验未配置')
        analysisValidation = await evidence.validateAnalysis(execution, parameters.result)
      }
    }
    await store.update(state => { if (nodeAuth) assertNodeCaller(state, nodeAuth, execution); if (!state.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) { assertManualExecution(state, execution, manualFence); assertManualConsumption(state, execution) }; if (pendingIntentReview(state,execution)) throw error('FORBIDDEN'); reply = applyAgentCommand(state, execution, operation, parameters, { queue, workspaceId, requireRemoteNodes, analysisValidation, candidateValidation, at: clock() }); interactionService?.reconcileSubscriptions(state,clock()); committedState = state; return state }, { beforeCommit: async () => { if (adoptionRefs) await evidence.verifySealedReferences(committedState, adoptionRefs); if (candidateValidation) await spreadsheetArtifacts.verifyCandidateBytes(committedState, candidateValidation.candidateId) } })
    try { kick() } catch {}
    scheduleContinuations()
    return reply
  }
  async function agentCommand(execution, operation, parameters, options = {}) {
    try { return await performAgentCommand(execution, operation, parameters, options) } catch (cause) {
      if (operation === 'complete_delegation' && cause.code === 'INVALID_REQUEST' && typeof parameters?.clientRequestId === 'string' && parameters.clientRequestId.length <= 16000) {
        try { await store.update(state => {
          try {
            if (requireRemoteNodes && !options.nodeAuth) return state
            if (!parameters.clientRequestId.trim()) return state
            if (state.multisite.commands.some(row => row.key === key(workspaceId, execution.attempt_id, parameters.clientRequestId))) return state
            if (options.nodeAuth) assertNodeCaller(state, options.nodeAuth, execution)
            assertManualExecution(state, execution, options.manualFence); assertManualConsumption(state, execution)
            if (pendingIntentReview(state, execution) || !authorizedResultStructureRejection(state, execution, parameters)) return state
          } catch (authorizationError) {
            if (['FORBIDDEN', 'UNAUTHORIZED', 'REVISION_CONFLICT', 'WAITING_BUDGET', 'BUDGET_EXHAUSTED', 'EXECUTION_DEADLINE', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'MANUAL_RESUME_PENDING'].includes(authorizationError.code)) return state
            throw authorizationError
          }
          const id = key('authorized-result-rejection', workspaceId, binding(execution), parameters.clientRequestId.trim())
          if (!state.supervisionToolRejections.some(row => row.id === id)) state.supervisionToolRejections.push({ id, workspaceId, subjectBinding: binding(execution), instructionRevision: parameters.instructionRevision, clientRequestId: parameters.clientRequestId, tool: 'complete_delegation', code: 'RESULT_SCHEMA_INVALID', observedAt: clock() })
          return state
        }) } catch (observationError) {
          // The original rejected command has no business effect. An unavailable
          // observation must not replace its error or be advertised as recorded.
          onError(Object.assign(error('SUPERVISION_OBSERVATION_UNAVAILABLE'), { reason: observationError.code ?? 'STORE_UNAVAILABLE' }))
        }
      }
      throw cause
    }
  }
  function scheduleContinuations() { queueMicrotask(() => { scanContinuations().catch(onError) }) }
  function scanContinuations() {
    return continuationScan ??= (async () => {
      const snapshot = await store.read()
      const ids = [...new Set([
        ...snapshot.budgetHolds.filter(row => ['waiting','resume_queued'].includes(row.state) && row.idleAt).map(row => row.work_id),
        ...snapshot.manualControls.filter(row => row.action === 'resume' && row.holders.some(holder => holder.releasedAt && !holder.resumeConsumedAt)).map(row => row.workId),
        ...snapshot.contextReadInstances.filter(row => snapshot.contextReadWindows.some(window => window.contextInstanceId === row.id && window.parentReadId && !window.deliveredAt)).map(row => row.readerBinding.work_id),
        ...snapshot.multisite.dependencyWaits.filter(row => !row.wokenAt).map(row => row.workId),
      ])]
      if (!ids.length) return
      continuationOffset %= ids.length
      const selected = [...ids.slice(continuationOffset), ...ids.slice(0,continuationOffset)].slice(0,16)
      continuationOffset = (continuationOffset + selected.length) % ids.length
      for (const workId of selected) for (const operation of ['budget','context','manual','dependency']) {
        try {
          await store.update(state => {
            if (operation === 'budget') queueBudgetResumes(state, queue, clock(), {workId})
            if (operation === 'context') queueContextReadWindows(state, clock(), {workId})
            if (operation === 'manual') queueManualResumes(state, clock(), {workId})
            if (operation === 'dependency') { const work = state.works.find(row => row.id === workId); if (work) wakeDependencies(state, work, queue, clock()) }
            return state
          })
        } catch (cause) { if (!isCloudOrdinaryCapacityError(cause)) throw cause }
      }
    })().finally(() => { continuationScan = undefined })
  }
  for (const host of hosts) host.setOrchestrationHandler?.({ call: agentCommand, event: event => acceptHostEvent({ workspaceId, nodeId: host.nodeId }, event) })
  return { async resumeBudget() { await scanContinuations().catch(onError); try { kick() } catch {} }, setInteractionService(value) { interactionService=value }, apply, applyA2a, applyTransition, cancelSiteRuleWork, verifyTransitionAttachments: transition => attachments.verifyReferences(transition.attachmentState, transition.references), agentCommand, drain, acceptHostEvent, authorizeRead,
    start() {
      if (timer) return
      const scan = () => { drain().catch(onError) }
      timer = setInterval(scan, 1000); timer.unref(); scan()
    },
    async close() { clearInterval(timer); await draining?.catch(() => {}); await continuationScan?.catch(() => {}); for (const host of hosts) await host.close?.() },
  }
}
