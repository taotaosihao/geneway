import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, sameBinding } from '../packages/agent-contracts/index.mjs'
import { assertDelegationAuthority } from '../packages/agent-orchestration/dependencies.mjs'
import { authorizeMultisiteExecution, authorizeOwnedReadyArtifactRead } from './multisite-authorization.mjs'
import { continuationReaderSource, continuationArtifact, continuationEvidence } from './context-read-access.mjs'
import { interactionWork } from './interaction-state.mjs'
import { assertManualExecution } from './manual-control.mjs'
import { assertWorkBudget } from './work-budget.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { supervisionWaits } from './supervision-service.mjs'
import { SUPERVISION_DIAGNOSIS_LIMITS as limits } from './supervision-diagnosis-state.mjs'

export function readableDiagnosisSubject(state, actor, workId, subject) {
  const { member, work } = interactionWork(state, actor, workId)
  const employee = state.employees.find(row => row.id === subject.agent_id && row.enabled)
  if (subject.work_id !== work.id || !employee || !member.employeeIds.includes(employee.id)) throw error('FORBIDDEN')
  return { member, work }
}
// Historical diagnosis reads use current data authority, independently of a turn's
// running state or whether a newer Input has been consumed.
export function readableDiagnosisFact(state, actor, workId, subject, fact) {
  try {
    const { work } = interactionWork(state, actor, workId)
    const input = state.multisite.inputs.find(row => row.workId === workId && row.revision === fact.revision)
    const source = value => { if (!value || !state.multisite.attempts.some(row => sameBinding(row, value))) throw error('FORBIDDEN'); readableDiagnosisSubject(state, actor, workId, value); return value }
    const result = id => { const row = state.multisite.results.find(row => row.id === id && row.workId === workId); source(row?.senderBinding); return row }
    if (fact.kind === 'owner_ready_artifact') {
      const artifact = state.artifacts.find(row => fact.id === 'ready:' + row.id + ':' + row.version && row.workId === workId && row.instructionRevision === fact.revision)
      return !!artifact && authorizeOwnedReadyArtifactRead(state, actor, workId, artifact.id).version === fact.version
    }
    source(subject)
    switch (fact.kind) {
      case 'authorized_goal': return !!input && fact.id === 'goal:' + workId + ':' + input.revision
      case 'obligation': return !!input && state.multisite.delegations.some(row => row.id === subject.delegation_id && row.workId === workId && fact.id === 'obligation:' + row.id + ':' + fact.revision)
      case 'input_consumed': return !!input && fact.id === input.id + ':' + subject.attempt_id && input.deliveries.some(row => row.attemptId === subject.attempt_id && row.sessionId === subject.session_id && row.ingestedAt === fact.at)
      case 'accepted_result':
      case 'accepted_dependency_result': {
        const row = result(fact.id)
        return row.instructionRevision === fact.revision && row.acceptedAt === fact.at && (sameBinding(row.senderBinding, subject) || state.multisite.dependencyWaits.some(wait => wait.parentAttemptId === subject.attempt_id && wait.instructionRevision === fact.revision && wait.dependencyIds.includes(row.delegationId)))
      }
      case 'current_source_adoption': {
        const row = state.sourceAdoptions.find(row => row.id === fact.id && row.workId === workId && row.instructionRevision === fact.revision && row.createdAt === fact.at && sameBinding(row.receiverBinding, subject))
        return !!row && row.sourceResultIds.every(id => !!result(id)) && row.sources.every(entry => { const evidence = state.evidence.find(item => item.id === entry.ref.id && item.version === entry.ref.version && item.sha256 === entry.ref.sha256 && item.status === 'ready' && item.workId === workId && item.ownerMemberId === actor.id), resource = evidence && state.resources.find(item => item.id === evidence.resourceId && item.enabled && item.revision === evidence.resourceRevision); return !!resource && resource.evidenceReaderAgentIds.includes(subject.agent_id) && evidence.exportToAgentIds.includes(subject.agent_id) })
      }
      case 'verified_candidate': {
        const row = state.artifacts.find(row => row.workId === workId && row.instructionRevision === fact.revision && row.candidateVerification && fact.id === 'verified:' + row.id + ':' + row.version + ':' + row.candidateVerification.manifestDigest)
        if (!row) return false
        source(row); return row.ownerMemberId === actor.id && row.version === fact.version
      }
      case 'authorized_tool_rejection': return state.supervisionToolRejections.some(row => row.id === fact.id && row.instructionRevision === fact.revision && row.observedAt === fact.at && sameBinding(row.subjectBinding, subject) && row.code === fact.code && row.tool === fact.tool)
      case 'executor_statement': return state.multisite.messages.some(row => row.id === fact.id && row.workId === workId && row.instructionRevision === fact.revision && row.createdAt === fact.at && row.senderBinding && sameBinding(row.senderBinding, subject)) || state.multisite.receipts.some(row => row.event.event_id === fact.id && !row.historical && row.event.kind === 'report' && row.event.instruction_revision === fact.revision && row.event.payload_digest === fact.sourceDigest && fact.summary === row.event.report?.summary?.slice(0, limits.maxTextChars) && Number.isFinite(Date.parse(fact.at)) && sameBinding(row.event, subject))
      case 'accepted_operation': return state.multisite.commands.some(row => row.key === fact.id && row.issuerKind === 'agent' && row.acceptedAt === fact.at && row.senderBinding && sameBinding(row.senderBinding, subject))
      case 'ordinary_model_calls': return Array.isArray(fact.requestIds) && fact.requestIds.length > 0 && fact.requestIds.length <= 3 && fact.id === 'model-calls:' + digest(fact.requestIds) && fact.requestIds.every(id => state.modelRequests.some(row => row.id === id && row.purpose === undefined && row.outcome === 'completed' && row.instructionRevision === fact.revision && sameBinding(row, subject)))
      case 'consumed_context_range': {
        const page = state.contextReads.find(row => row.id === fact.id && row.readAt === fact.at && sameBinding(row.receiverBinding, subject))
        if (!page) return false
        const origin = continuationReaderSource(state, subject), ref = page.objectRef
        if (ref.kind === 'continuation') return ref.id === origin.link.id
        if (ref.kind === 'work') return ref.id === origin.source.id && ref.version === origin.source.instructionRevision
        const artifact = continuationArtifact(state, origin)
        if (ref.kind === 'artifact') return artifact.id === ref.id && artifact.version === ref.version
        const job = state.multisite.jobs.find(row => row.id === artifact.jobId && row.work_id === origin.source.id), manifest = job?.sourceManifest
        if (!manifest || digest(manifest) !== job.sourceManifestDigest) return false
        for (const entry of manifest.sources) { const row = state.multisite.results.find(row => row.id === entry.resultId && row.workId === origin.source.id); if (!row) return false; readableDiagnosisSubject(state, actor, origin.source.id, row.senderBinding); continuationEvidence(state, origin, entry.ref, subject) }
        if (manifest.analysis) { const row = state.multisite.results.find(row => row.id === manifest.analysis.resultId && row.workId === origin.source.id); if (!row) return false; readableDiagnosisSubject(state, actor, origin.source.id, row.senderBinding) }
        if (ref.kind === 'job') return ref.id === job.id
        if (ref.kind === 'result') return [...manifest.sources.map(row => row.resultId), manifest.analysis?.resultId].includes(ref.id)
        if (ref.kind === 'evidence') return manifest.sources.some(row => row.ref.id === ref.id && row.ref.version === ref.version)
        return false
      }
      default: return false
    }
  } catch { return false }
}
export function diagnosisFeedbackFacts(state, actor, workId, subject, stored = []) {
  let fresh = []
  try { fresh = diagnosisFacts(state, subject).packet.facts } catch {}
  return [...new Map([...stored, ...fresh].filter(fact => readableDiagnosisFact(state, actor, workId, subject, fact)).map(fact => [fact.id, fact])).values()]
}
export function latestDiagnosisGrant(state, workId) {
  return state.supervisionDiagnosisGrants.filter(row => row.workId === workId).sort((a, b) => b.grantRevision - a.grantRevision)[0] ?? null
}
export function diagnosisFacts(state, subject, { now = Date.now() } = {}) {
  const work = state.works.find(row => row.id === subject.work_id), revision = work.instructionRevision
  const delegation = state.multisite.delegations.find(row => row.id === subject.delegation_id)
  const input = state.multisite.inputs.find(row => row.workId === work.id && row.revision === revision && row.deliveries.some(delivery => delivery.attemptId === subject.attempt_id && delivery.sessionId === subject.session_id && delivery.ingestedAt))
  if (!input) throw error('REVISION_CONFLICT')
  const facts = [], progress = [], complete = { goal: true, input: true, obligations: true, results: true }, used = new Set()
  const text = (value, max, key) => { if (typeof value !== 'string') { if (key) complete[key] = false; return null }; if (value.length > max) { if (key) complete[key] = false; return value.slice(0, max) }; return value }
  const fact = (id, kind, at, details = {}, advances = false) => { if (used.has(id) || !at) return; used.add(id); const row = { id, kind, at, revision, ...details }; facts.push(row); if (advances) progress.push({ id, kind, at }) }
  fact('goal:' + work.id + ':' + revision, 'authorized_goal', input.createdAt ?? work.acceptedAt, { summary: text(work.goal, limits.maxTextChars, 'goal') })
  fact('obligation:' + delegation.id + ':' + revision, 'obligation', input.createdAt ?? work.acceptedAt, { summary: text(delegation.goal ?? work.goal, limits.maxTextChars, 'obligations'), resultSchema: delegation.resultSchema ?? null })
  const delivery = input.deliveries.find(row => row.attemptId === subject.attempt_id && row.sessionId === subject.session_id && row.ingestedAt)
  fact(input.id + ':' + subject.attempt_id, 'input_consumed', delivery.ingestedAt, { summary: text(input.text, limits.maxInputChars, 'input') }, true)
  for (const result of state.multisite.results.filter(row => row.workId === work.id && row.instructionRevision === revision)) {
    const own = sameBinding(result.senderBinding, subject)
    const dependency = state.multisite.dependencyWaits.some(wait => wait.parentAttemptId === subject.attempt_id && wait.instructionRevision === revision && wait.dependencyIds.includes(result.delegationId))
    if (!own && !dependency) continue
    try { readableDiagnosisSubject(state, { id: work.ownerMemberId }, work.id, result.senderBinding) } catch { complete.results = false; continue }
    fact(result.id, own ? 'accepted_result' : 'accepted_dependency_result', result.acceptedAt, { resultSchema: result.schema, sourceRevision: result.instructionRevision }, true)
  }
  for (const row of state.sourceAdoptions.filter(row => row.workId === work.id && row.instructionRevision === revision && sameBinding(row.receiverBinding, subject))) fact(row.id, 'current_source_adoption', row.createdAt, {}, true)
  for (const artifact of state.artifacts.filter(row => row.workId === work.id && row.instructionRevision === revision && ['candidate', 'ready'].includes(row.status))) {
    if (artifact.ownerMemberId !== work.ownerMemberId) { complete.results = false; continue }
    if (artifact.candidateVerification) fact('verified:' + artifact.id + ':' + artifact.version + ':' + artifact.candidateVerification.manifestDigest, 'verified_candidate', artifact.candidateVerification.at ?? artifact.receivedAt ?? artifact.updatedAt, { version: artifact.version }, true)
    if (artifact.status === 'ready') fact('ready:' + artifact.id + ':' + artifact.version, 'owner_ready_artifact', artifact.verification?.at ?? artifact.updatedAt, { version: artifact.version }, true)
  }
  const consumed = new Set(state.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, subject) && row.instructionRevision === revision && row.outcome === 'completed').flatMap(row => row.contextReadReceiptIds ?? []))
  const ranges = new Set()
  for (const page of state.contextReads.filter(row => consumed.has(row.id))) {
    const range = digest([page.objectRef, page.view, page.fromIndex, page.page.nextIndex])
    if (!ranges.has(range)) { ranges.add(range); fact(page.id, 'consumed_context_range', page.readAt, {}, true) }
  }
  for (const row of state.supervisionToolRejections.filter(row => sameBinding(row.subjectBinding, subject) && row.instructionRevision === revision)) fact(row.id, 'authorized_tool_rejection', row.observedAt, { tool: row.tool, code: row.code })
  for (const row of state.multisite.messages.filter(row => row.workId === work.id && row.instructionRevision === revision && row.senderBinding && sameBinding(row.senderBinding, subject)).slice(-4)) fact(row.id, 'executor_statement', row.createdAt, { summary: text(row.text, limits.maxTextChars), statementOnly: true })
  const completed = state.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, subject) && row.instructionRevision === revision && row.outcome === 'completed' && row.completedAt && row.inputMessageId === messageId(input.id, subject.attempt_id, subject.session_id))
  if (completed.length) { const observed = completed.slice(-3), requestIds = observed.map(row => row.id); fact('model-calls:' + digest(requestIds), 'ordinary_model_calls', observed.at(-1).completedAt, { requestIds, requests: completed.length, usageUnknown: observed.some(row => row.usage === null), advancesObligation: false }) }
  const report = state.multisite.attempts.find(row => sameBinding(row, subject))?.report, reportTime = report?.at
  if (Number.isFinite(Date.parse(reportTime))) {
    const payload = Object.fromEntries(Object.entries(report).filter(([name]) => name !== 'at'))
    const receipt = state.multisite.receipts.findLast(row => !row.historical && sameBinding(row.event, subject) && row.event.instruction_revision === revision && row.event.kind === 'report' && isDeepStrictEqual(row.event.report, payload))
    if (receipt) fact(receipt.event.event_id, 'executor_statement', reportTime, { summary: text(report.summary, limits.maxTextChars), statementOnly: true, sourceDigest: receipt.event.payload_digest })
  }
  for (const row of state.multisite.commands.filter(row => row.issuerKind === 'agent' && row.senderBinding && sameBinding(row.senderBinding, subject)).slice(-4)) fact(row.key, 'accepted_operation', row.acceptedAt, { receiptKind: row.receiptKind ?? (row.reply.messageId ? 'statement_message' : row.reply.resultId ? 'result' : 'operation') })
  const meaningful = progress.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), last = meaningful.at(-1)
  const readable = facts.filter(fact => readableDiagnosisFact(state, { id: work.ownerMemberId }, work.id, subject, fact))
  if (readable.length !== facts.length) complete.results = false
  const essential = new Set(readable.filter(row => row.kind === 'authorized_tool_rejection').slice(-3)), fixed = readable.filter(row => ['authorized_goal', 'obligation', 'input_consumed'].includes(row.kind) || essential.has(row)), recent = readable.filter(row => !fixed.includes(row)).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const selected = [...fixed, ...recent.slice(-(limits.maxFacts - fixed.length))]
  if (facts.some(row => ['accepted_result', 'accepted_dependency_result', 'current_source_adoption', 'verified_candidate', 'owner_ready_artifact', 'consumed_context_range'].includes(row.kind) && !selected.includes(row))) complete.results = false
  return { packet: { schema: 'geneway.supervision-diagnosis-facts/1', workId: work.id, instructionRevision: revision, subject: binding(subject), facts: selected, complete, truncated: facts.length > selected.length, unavailable: !Object.values(complete).every(Boolean), sampledAt: new Date(now).toISOString() }, progressDigest: digest(meaningful), checkpointAt: last?.at ?? work.acceptedAt, inputMessageId: messageId(input.id, subject.attempt_id, subject.session_id) }
}
export function authorizeDiagnosis(state, identity, finding, { nodeBridge, isOwnedExecutionInFlight, now = Date.now() }) {
  const attempt = state.multisite.attempts.find(row => row.attempt_id === finding.scope.attemptId), grant = latestDiagnosisGrant(state, finding.scope.workId)
  const work = state.works.find(row => row.id === finding.scope.workId)
  if (identity?.role !== 'diagnose' || !grant?.enabled || grant.diagnosisIdentityId !== identity.id || identity.workspaceId !== work?.workspaceId || !identity.nodeIds.includes(attempt?.node_id) || identity.workIds && !identity.workIds.includes(work.id) || grant.instructionRevision !== work.instructionRevision || grant.coordinatorRevision !== work.coordinatorRevision || finding.scope.nodeId !== attempt.node_id || finding.scope.workId !== attempt.work_id || !attempt.session_id || !['accepted', 'running', 'waiting_input'].includes(attempt.status) || work.spreadsheetRequest?.templateId !== 'incident-collaboration-v1') throw error('FORBIDDEN', '当前工作未授权语义诊断')
  readableDiagnosisSubject(state, { id: grant.actorId }, work.id, attempt)
  const facts = diagnosisFacts(state, attempt, { now })
  const access = authorizeMultisiteExecution(state, binding(attempt), { workspaceId: work.workspaceId, inputMessageId: facts.inputMessageId })
  assertDelegationAuthority(state, attempt); assertManualExecution(state, attempt); assertWorkBudget(state, work, now)
  if (attempt.observed_revision !== work.instructionRevision || supervisionWaits(state, attempt, work, now).length || !nodeBridge?.supervisionConnection(attempt.node_id) || state.multisite.jobs.some(row => row.work_id === work.id && ['accepted', 'running', 'stopping', 'unknown'].includes(row.state))) throw error('DIAGNOSIS_NOT_ELIGIBLE')
  for (const row of state.modelRequests.filter(row => row.work_id === work.id && row.outcome === 'unknown')) if (!isOwnedExecutionInFlight?.(row, attempt, work.instructionRevision)) throw error('RUNTIME_REQUEST_UNKNOWN')
  const ordinary = state.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, attempt) && row.instructionRevision === work.instructionRevision && row.outcome === 'completed' && row.completedAt && row.inputMessageId === facts.inputMessageId && Date.parse(row.reservedAt) >= Date.parse(facts.checkpointAt))
  const errors = facts.packet.facts.filter(row => row.kind === 'authorized_tool_rejection')
  const qualifies = finding.classification === 'BUDGET_WITHOUT_PROGRESS' ? ordinary.length >= 3 : finding.classification === 'REPEATED_ERROR' ? errors.length >= 3 : finding.classification === 'STAGE_STALLED' && now - Date.parse(facts.checkpointAt) >= 60000
  if (!qualifies) throw error('DIAGNOSIS_NOT_ELIGIBLE')
  return { ...access, attempt, grant, ...facts }
}

export function authorizeDiagnosisRecord(state, diagnosis, options) {
  const finding = state.supervisionFindings.find(row => row.id === diagnosis.findingId)
  const identity = options.identities.find(row => row.id === state.supervisionDiagnosisGrants.find(grant => grant.id === diagnosis.grantId)?.diagnosisIdentityId)
  if (!finding || !identity) throw error('FORBIDDEN')
  const access = authorizeDiagnosis(state, identity, finding, options)
  if (access.grant.id !== diagnosis.grantId || !sameBinding(access.attempt, diagnosis.subjectBinding) || access.work.instructionRevision !== diagnosis.instructionRevision || access.progressDigest !== diagnosis.progressDigest) throw error('REVISION_CONFLICT', '诊断采样后当前资格或实质进展已变化')
  return { ...access, identity }
}
