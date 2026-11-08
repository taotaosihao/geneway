import { binding, error, exact, key, text } from '../agent-contracts/index.mjs'
import { evidenceReferences } from '../agent-contracts/delegation.mjs'
import { assertEvidenceReader, evidenceBinding, shareEvidence } from '../../src/evidence-access.mjs'
import { authorizeMultisiteExecution, authorizeQuestionParticipant } from '../../src/multisite-authorization.mjs'

export function assertWaitGraph(state, from, targets) {
  const edges = new Map()
  const add = (source, target) => edges.set(source, [...(edges.get(source) ?? []), target])
  for (const wait of state.multisite.dependencyWaits.filter(row => !row.wokenAt && state.works.find(work => work.id === row.workId)?.instructionRevision === row.instructionRevision && state.multisite.attempts.find(attempt => attempt.attempt_id === row.parentAttemptId)?.status === 'waiting_dependency')) for (const id of wait.dependencyIds) {
    const child = state.multisite.delegations.find(row => row.id === id)
    if (child && !state.multisite.results.some(row => row.delegationId === id && row.instructionRevision === wait.instructionRevision && !row.historical)) add(wait.parentAttemptId, child.currentAttemptId)
  }
  for (const row of state.multisite.questions.filter(row => row.state === 'open')) add(row.senderBinding.attempt_id, row.responsibleAttemptId)
  for (const target of targets) add(from, target)
  const visit = (id, chain = new Set()) => { if (chain.has(id)) throw error('DEPENDENCY_CYCLE', '定向问题与子委派等待不能形成环'); const next = new Set(chain).add(id); for (const target of edges.get(id) ?? []) visit(target, next) }
  visit(from)
}
const message = (sender, target, id, revision, kind, replyTo, at, value = {}) => ({ id, workId: sender.work_id, senderBinding: binding(sender), kind, targetAttemptId: target?.attempt_id ?? null, replyTo, sourceDelegationId: sender.delegation_id, instructionRevision: revision, resultRef: null, createdAt: at, deliveredAt: null, ingestedAt: null, sessionId: null, ...value })
function dispatch(state, target, row, queue, at, waitRelease) {
  state.multisite.messages.push(row)
  queue(state, target, 'wake', { id: key('message-delivery', row.id), revision: row.instructionRevision, text: row.kind === 'question' ? '收到定向协作问题。' : '定向协作问题已有回执。', messages: [structuredClone(row)], ...(waitRelease ? { waitRelease } : {}) }, at)
}
export function applyConversation(state, execution, operation, parameters, { parent, work, namespace, queue, at }) {
  if (operation === 'publish_observation') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'text', 'evidenceRefs']); evidenceReferences(parameters.evidenceRefs)
    for (const ref of parameters.evidenceRefs) assertEvidenceReader(state, execution, work.instructionRevision, ref)
    const content = text(parameters.text); if (content.length > 4000) throw error('INVALID_REQUEST')
    const id = key('observation', namespace)
    state.multisite.messages.push(message(execution, null, id, work.instructionRevision, 'observation', null, at, { text: content, evidenceRefs: structuredClone(parameters.evidenceRefs) }))
    return { workId: work.id, messageId: id, status: 'published' }
  }
  if (operation === 'ask_agent') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'targetAgentId', 'text', 'evidenceRefs']); evidenceReferences(parameters.evidenceRefs)
    if (state.multisite.questions.some(row => row.state === 'open' && row.senderBinding.attempt_id === parent.attempt_id)) throw error('INVALID_STATE', '已有待答定向问题')
    const candidates = state.multisite.attempts.filter(row => row.work_id === work.id && row.agent_id === parameters.targetAgentId && !['completed', 'cancelled', 'stopping', 'unknown'].includes(row.status))
    if (candidates.length !== 1 || candidates[0].attempt_id === parent.attempt_id) throw error('FORBIDDEN', '没有唯一有效的责任执行')
    const target = candidates[0], content = text(parameters.text); if (content.length > 4000) throw error('INVALID_REQUEST')
    authorizeMultisiteExecution(state, evidenceBinding(target))
    assertWaitGraph(state, parent.attempt_id, [target.attempt_id])
    const id = key('question', namespace), messageId = key('question-message', id)
    shareEvidence(state, execution, target, parameters.evidenceRefs, { reason: 'share', sourceCommandKey: namespace, at })
    state.multisite.questions.push({ id, workId: work.id, senderBinding: binding(execution), responsibleAttemptId: target.attempt_id, instructionRevision: work.instructionRevision, messageId, state: 'open', answerMessageId: null })
    dispatch(state, target, message(execution, target, messageId, work.instructionRevision, 'question', id, at, { text: content, evidenceRefs: structuredClone(parameters.evidenceRefs) }), queue, at)
    parent.status = 'waiting_question'
    return { workId: work.id, questionId: id, responsibleAttemptId: target.attempt_id, status: 'waiting_question' }
  }
  if (operation === 'answer_agent') {
    exact(parameters, ['clientRequestId', 'instructionRevision', 'questionId', 'text', 'evidenceRefs']); evidenceReferences(parameters.evidenceRefs)
    const question = state.multisite.questions.find(row => row.id === parameters.questionId && row.workId === work.id)
    if (!question || question.responsibleAttemptId !== parent.attempt_id) throw error('FORBIDDEN')
    if (!state.multisite.messages.some(row => row.id === question.messageId && row.targetAttemptId === parent.attempt_id && row.ingestedAt && row.sessionId === execution.session_id)) throw error('INPUT_CONSUMPTION_PENDING')
    const content = text(parameters.text); if (content.length > 4000) throw error('INVALID_REQUEST')
    const id = key('answer', namespace), asker = state.multisite.attempts.find(row => row.attempt_id === question.senderBinding.attempt_id)
    if (question.state !== 'open' || question.instructionRevision !== work.instructionRevision) {
      for (const ref of parameters.evidenceRefs) assertEvidenceReader(state, execution, work.instructionRevision, ref)
      state.multisite.messages.push(message(execution, asker, id, question.instructionRevision, 'answer', question.id, at, { text: content, evidenceRefs: structuredClone(parameters.evidenceRefs), historical: true }))
      return { workId: work.id, messageId: id, status: 'historical' }
    }
    shareEvidence(state, execution, asker, parameters.evidenceRefs, { reason: 'share', sourceCommandKey: namespace, at })
    question.state = 'answered'; question.answerMessageId = id
    if (asker.status === 'waiting_question') asker.status = 'running'
    dispatch(state, asker, message(execution, asker, id, work.instructionRevision, 'answer', question.id, at, { text: content, evidenceRefs: structuredClone(parameters.evidenceRefs) }), queue, at, { kind: 'question', id: question.id })
    return { workId: work.id, messageId: id, status: 'answered' }
  }
  throw error('INVALID_REQUEST')
}
export function closeQuestions(state, predicate, reason, { queue, at, superseded = false }) {
  for (const question of state.multisite.questions.filter(row => row.state === 'open' && predicate(row))) {
    question.state = superseded ? 'superseded' : 'cancelled'; question.closedReason = reason; question.closedAt = at
    const asker = state.multisite.attempts.find(row => row.attempt_id === question.senderBinding.attempt_id)
    if (!asker || ['completed', 'cancelled', 'stopping', 'unknown'].includes(asker.status)) continue
    const work = state.works.find(row => row.id === asker.work_id)
    if (asker.status === 'waiting_question') asker.status = 'running'
    const id = key('question-closed', question.id)
    dispatch(state, asker, message(question.senderBinding, asker, id, work.instructionRevision, 'question_closed', question.id, at, { text: '定向问题已关闭。', reason }), queue, at, { kind: 'question', id: question.id })
  }
}

export function invalidQuestion(state, question) {
  const work = state.works.find(row => row.id === question.workId)
  if (work?.instructionRevision !== question.instructionRevision) return 'USER_REVISION_CHANGED'
  try {
    for (const id of [question.senderBinding.attempt_id, question.responsibleAttemptId]) {
      const attempt = state.multisite.attempts.find(row => row.attempt_id === id)
      if (!attempt) return 'EXECUTION_UNAVAILABLE'
      authorizeQuestionParticipant(state, evidenceBinding(attempt))
    }
  } catch { return 'EXECUTION_AUTHORITY_CHANGED' }
  return null
}

export function assertRequiredMessagesConsumed(state, attempt, revision) {
  if (state.multisite.messages.some(row => row.targetAttemptId === attempt.attempt_id && row.instructionRevision === revision && !row.historical && !(row.kind === 'question_closed' && row.controlConsumedAt) && !row.ingestedAt)) throw error('INPUT_CONSUMPTION_PENDING')
}
