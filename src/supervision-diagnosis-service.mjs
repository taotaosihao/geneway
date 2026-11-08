import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, exact, key } from '../packages/agent-contracts/index.mjs'
import { interactionWork } from './interaction-state.mjs'
import { createSupervisionDiagnosisSessions } from './supervision-diagnosis-session.mjs'
import { authorizeDiagnosis, authorizeDiagnosisRecord, diagnosisFacts, latestDiagnosisGrant, readableDiagnosisSubject, readableDiagnosisFact, diagnosisFeedbackFacts } from './supervision-diagnosis-facts.mjs'
import { assertDiagnosisBudget, diagnosisPolicy } from './supervision-diagnosis-gateway.mjs'
import { DIAGNOSIS_KINDS, SUPERVISION_DIAGNOSIS_LIMITS as limits } from './supervision-diagnosis-state.mjs'

const requestId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw error('INVALID_REQUEST'); return value }
const knownAdmission = new Set(['FORBIDDEN', 'NOT_FOUND', 'DIAGNOSIS_DISABLED', 'DIAGNOSIS_NOT_ELIGIBLE', 'DIAGNOSIS_POLICY_UNAVAILABLE', 'DIAGNOSIS_POLICY_CHANGED', 'BUDGET_PRICE_MISSING', 'DIAGNOSIS_BUDGET_EXCEEDED', 'DIAGNOSIS_COOLDOWN', 'DIAGNOSIS_ACTIVE', 'CAPACITY_EXCEEDED', 'RUNTIME_REQUEST_UNKNOWN', 'WAITING_BUDGET', 'EXECUTION_DEADLINE', 'MANUALLY_PAUSED', 'MANUAL_RELEASE_PENDING', 'REVISION_CONFLICT'])
export function createSupervisionDiagnosisService({ store, identities, nodeBridge, modelGateway, root, gatewayOrigin, clock = () => Date.now() }) {
  const identity = identities.find(row => row.role === 'diagnose'), active = new Map()
  let closed = false
  const sessions = identity && modelGateway ? createSupervisionDiagnosisSessions({ root, gatewayOrigin }) : null
  const gateway = modelGateway?.createSupervisionGateway?.({ identities, nodeBridge })
  const options = () => ({ identities, nodeBridge, isOwnedExecutionInFlight: modelGateway?.isOwnedExecutionInFlight, now: clock() })
  function safeFinding(state, caller, id) {
    if (caller.role !== 'diagnose') throw error('FORBIDDEN')
    const finding = state.supervisionFindings.find(row => row.id === id)
    if (!finding || caller.workspaceId !== finding.workspaceId || !caller.nodeIds.includes(finding.scope.nodeId) || caller.workIds && !caller.workIds.includes(finding.scope.workId)) throw error('FORBIDDEN')
    return finding
  }
  function conclusion(diagnosis, text) {
    let value
    try { value = JSON.parse(text); exact(value, ['kind', 'reason', 'advice', 'refs']) } catch {}
    const valid = value && DIAGNOSIS_KINDS.includes(value.kind) && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 160 && typeof value.advice === 'string' && value.advice.length > 0 && value.advice.length <= 160 && Array.isArray(value.refs) && value.refs.length <= 4 && value.refs.every(id => diagnosis.packet.facts.some(row => row.id === id)) && (value.kind === 'insufficient_evidence' || value.refs.length > 0)
    const complete = Object.values(diagnosis.packet.complete).every(Boolean), errors = diagnosis.packet.facts.filter(row => row.kind === 'authorized_tool_rejection')
    if (!valid || !complete && !(value.kind === 'repeated_error' && value.refs.length >= 2 && value.refs.every(id => errors.some(row => row.id === id)))) return { kind: 'insufficient_evidence', refs: [], reason: '本次可读事实或诊断输出不足，不能据此认定目标偏离或没有成果。', advice: '请人工核对当前要求与可读原始事实。' }
    return value
  }
  async function finish(id, text, failure) {
    await store.update(state => {
      const row = state.supervisionDiagnoses.find(item => item.id === id)
      if (!row || ['completed', 'failed', 'unknown'].includes(row.state)) return state
      const ledger = state.modelRequests.find(item => item.id === row.modelRequestId)
      let current = true
      try { const access = authorizeDiagnosisRecord(state, row, options()); diagnosisPolicy(state, access, access.identity) } catch { current = false }
      row.reviewRequired = !current; row.finishedAt = new Date(clock()).toISOString()
      if (failure) { row.state = ledger?.outcome === 'unknown' ? 'unknown' : 'failed'; row.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'DIAGNOSIS_SESSION_UNCONFIRMED'; row.result = null }
      else if (ledger?.outcome === 'completed') { row.state = 'completed'; row.result = conclusion(row, text); row.errorCode = null }
      else { row.state = ledger?.outcome === 'failed' ? 'failed' : 'unknown'; row.errorCode = 'DIAGNOSIS_SESSION_UNCONFIRMED'; row.result = null }
      return state
    })
  }
  async function run(id) {
    try {
      const state = await store.read(), diagnosis = state.supervisionDiagnoses.find(row => row.id === id), access = authorizeDiagnosisRecord(state, diagnosis, options())
      assertDiagnosisBudget(state, access, access.identity, undefined, clock())
      if (closed || !sessions || !gateway) throw error('PROCESS_SHUTDOWN')
      const token = gateway.issue(id, diagnosis.deadlineAt)
      const result = await sessions.run({ diagnosisId: id, sessionId: diagnosis.sessionId, modelSnapshot: diagnosis.modelSnapshot, token, packet: diagnosis.packet, deadlineAt: diagnosis.deadlineAt })
      await finish(id, result.text)
    } catch (cause) { await finish(id, null, cause) }
  }
  async function request(caller, findingId) {
    if (typeof findingId !== 'string') throw error('INVALID_REQUEST')
    let diagnosis, claimed = false, denied
    await store.update(state => {
      const finding = safeFinding(state, caller, findingId)
      diagnosis = state.supervisionDiagnoses.find(row => row.episodeId === finding.episodeId && row.workId === finding.scope.workId)
      if (diagnosis) return state
      try {
        if (closed || !sessions || !gateway || identity?.id !== caller.id) throw error('DIAGNOSIS_DISABLED')
        const access = authorizeDiagnosis(state, caller, finding, options()), budget = assertDiagnosisBudget(state, access, caller, undefined, clock())
        if (state.supervisionDiagnoses.some(row => row.workId === access.work.id && ['claimed', 'running', 'unknown'].includes(row.state))) throw error('DIAGNOSIS_ACTIVE')
        const last = state.supervisionDiagnoses.filter(row => row.workId === access.work.id).at(-1)
        if (last && clock() - Date.parse(last.claimedAt) < limits.cooldownMs) throw error('DIAGNOSIS_COOLDOWN')
        const id = key('supervision-diagnosis', finding.episodeId, access.work.id)
        diagnosis = { id, workspaceId: access.work.workspaceId, workId: access.work.id, findingId, episodeId: finding.episodeId, grantId: access.grant.id, grantRevision: access.grant.grantRevision, subjectBinding: binding(access.attempt), instructionRevision: access.work.instructionRevision, sessionId: 'geneway-diagnosis-' + id, modelRequestId: randomUUID(), packet: access.packet, packetDigest: digest(access.packet), progressDigest: access.progressDigest, modelSnapshot: structuredClone(budget.route), budgetPolicySnapshot: structuredClone(budget.policy), claimedAt: new Date(clock()).toISOString(), deadlineAt: new Date(clock() + Math.min(limits.timeoutMs, budget.policy.executionTimeoutMs)).toISOString(), state: 'claimed', result: null, finishedAt: null, reviewRequired: false, errorCode: null }
        state.supervisionDiagnoses.push(diagnosis); claimed = true
      } catch (cause) { if (!knownAdmission.has(cause.code)) throw cause; denied = { findingId, admitted: false, state: 'not_admitted', reason: cause.code, notBefore: new Date(clock() + limits.cooldownMs).toISOString() } }
      return state
    })
    if (denied) return denied
    if (claimed) { const task = run(diagnosis.id).finally(() => active.delete(diagnosis.id)); active.set(diagnosis.id, task); task.catch(() => {}) }
    return { findingId, admitted: true, diagnosis: { id: diagnosis.id, state: diagnosis.state } }
  }
  async function history(actor, workId) {
    const state = await store.read(), { work } = interactionWork(state, actor, workId), grant = latestDiagnosisGrant(state, workId)
    const diagnoses = state.supervisionDiagnoses.filter(row => row.workId === work.id).map(row => {
      let restricted = false, facts = [], feedbackOptions = [], current = false
      try {
        readableDiagnosisSubject(state, actor, workId, row.subjectBinding)
        facts = row.packet.facts.filter(fact => readableDiagnosisFact(state, actor, workId, row.subjectBinding, fact))
        restricted = facts.length !== row.packet.facts.length
        feedbackOptions = diagnosisFeedbackFacts(state, actor, workId, row.subjectBinding, row.packet.facts)
        try { const access = authorizeDiagnosisRecord(state, row, options()); diagnosisPolicy(state, access, access.identity); current = !row.reviewRequired } catch {}
      } catch { restricted = true; facts = row.packet.facts.filter(fact => readableDiagnosisFact(state, actor, workId, row.subjectBinding, fact)) }
      if (restricted) current = false
      const feedbackRows = state.supervisionDiagnosisFeedback.filter(item => item.diagnosisId === row.id)
      return { id: row.id, findingId: row.findingId, classification: state.supervisionFindings.find(finding => finding.id === row.findingId)?.classification, createdAt: row.claimedAt, state: row.state, current, restricted, conclusion: restricted ? null : row.result, facts, feedbackOptions, feedback: feedbackRows.map(item => ({ id: item.id, actorId: item.actorId, kind: item.kind, note: restricted || item.refs.some(id => !feedbackOptions.some(fact => fact.id === id)) ? '' : item.note, refs: restricted ? [] : item.refs.filter(id => feedbackOptions.some(fact => fact.id === id)), createdAt: item.createdAt })) }
    })
    return { workId, instructionRevision: work.instructionRevision, configured: !!(identity && gateway && sessions), grant: grant ? { enabled: grant.enabled && grant.instructionRevision === work.instructionRevision && grant.coordinatorRevision === work.coordinatorRevision && grant.diagnosisIdentityId === identity?.id, grantRevision: grant.grantRevision, instructionRevision: grant.instructionRevision } : null, diagnoses }
  }
  async function setGrant(actor, workId, parameters) {
    exact(parameters, ['enabled', 'expectedInstructionRevision', 'clientRequestId']); requestId(parameters.clientRequestId)
    if (typeof parameters.enabled !== 'boolean') throw error('INVALID_REQUEST')
    await store.update(state => {
      const { work } = interactionWork(state, actor, workId), id = key('diagnosis-grant', workId, actor.id, parameters.clientRequestId), old = state.supervisionDiagnosisGrants.find(row => row.id === id), requestDigest = digest(parameters)
      if (old) { if (old.requestDigest !== requestDigest) throw error('IDEMPOTENCY_CONFLICT'); return state }
      if (parameters.expectedInstructionRevision !== work.instructionRevision) throw error('REVISION_CONFLICT')
      if (parameters.enabled && (!identity || !gateway || !sessions)) throw error('DIAGNOSIS_DISABLED')
      const last = latestDiagnosisGrant(state, workId)
      state.supervisionDiagnosisGrants.push({ id, workspaceId: work.workspaceId, workId, actorId: actor.id, coordinatorRevision: work.coordinatorRevision, instructionRevision: work.instructionRevision, diagnosisIdentityId: identity?.id ?? last?.diagnosisIdentityId ?? 'unconfigured', grantRevision: (last?.grantRevision ?? 0) + 1, enabled: parameters.enabled, clientRequestId: parameters.clientRequestId, requestDigest, acceptedAt: new Date(clock()).toISOString() })
      return state
    })
    return history(actor, workId)
  }
  async function feedback(actor, workId, diagnosisId, parameters) {
    exact(parameters, ['kind', 'note', 'refs', 'clientRequestId']); requestId(parameters.clientRequestId)
    if (!['false_positive', 'new_evidence', 'acknowledged'].includes(parameters.kind) || typeof parameters.note !== 'string' || parameters.note.length > 160 || !Array.isArray(parameters.refs) || parameters.refs.length > 4 || parameters.refs.some(id => typeof id !== 'string')) throw error('INVALID_REQUEST')
    await store.update(state => {
      interactionWork(state, actor, workId)
      const row = state.supervisionDiagnoses.find(item => item.id === diagnosisId && item.workId === workId)
      if (!row) throw error('NOT_FOUND')
      readableDiagnosisSubject(state, actor, workId, row.subjectBinding)
      const available = diagnosisFeedbackFacts(state, actor, workId, row.subjectBinding, row.packet.facts)
      if (parameters.refs.some(id => !available.some(fact => fact.id === id))) throw error('FORBIDDEN', '反证不属于当前可读事实')
      const id = key('diagnosis-feedback', diagnosisId, actor.id, parameters.clientRequestId), old = state.supervisionDiagnosisFeedback.find(item => item.id === id), requestDigest = digest(parameters)
      if (old) { if (old.requestDigest !== requestDigest) throw error('IDEMPOTENCY_CONFLICT'); return state }
      state.supervisionDiagnosisFeedback.push({ id, diagnosisId, actorId: actor.id, kind: parameters.kind, note: parameters.note, refs: [...new Set(parameters.refs)], clientRequestId: parameters.clientRequestId, requestDigest, createdAt: new Date(clock()).toISOString() }); return state
    })
    return history(actor, workId)
  }
  return { request, history, setGrant, feedback, handleModel: (req, res, url) => gateway?.handle(req, res, url) ?? false, async close() { closed = true; gateway?.close(); await sessions?.close(); await Promise.allSettled(active.values()) } }
}
