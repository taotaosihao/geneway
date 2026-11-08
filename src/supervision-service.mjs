import { timingSafeEqual } from 'node:crypto'
import { binding, digest, error, exact, key, text, sameBinding } from '../packages/agent-contracts/index.mjs'
import { relevantManualControls } from './manual-control.mjs'
import { committedBudget } from './work-budget.mjs'
import { contextResumePosition, currentContextWindow } from './context-read-state.mjs'
import { SUPERVISION_CLASSES, supervisionUserQuestion } from './supervision-state.mjs'

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:/@-]{1,180}$/.test(value)
const terminal = value => ['cancelled', 'completed', 'failed', 'stopping', 'interrupted'].includes(value)
const inScope = (identity, work, attempt) => work?.workspaceId === identity.workspaceId && identity.nodeIds.includes(attempt?.node_id) && (!identity.workIds || identity.workIds.includes(work.id))
const sameAttempt = (row, attempt) => row.attempt_id === attempt.attempt_id
const matches = (left, right) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function fact(id, at, kind) { return iso(at) ? { id, at, kind } : null }
function checkpoints(state, attempt) {
  const rev = attempt.instruction_revision, facts = []
  for (const input of state.multisite.inputs.filter(row => row.workId === attempt.work_id && row.revision === rev)) for (const delivery of input.deliveries) if (delivery.attemptId === attempt.attempt_id) facts.push(fact(input.id + ':' + delivery.attemptId, delivery.ingestedAt, 'input_consumed'))
  for (const sub of state.contextSubscriptions ?? []) if (sub.mode === 'handle' && sub.handlerBinding?.attempt_id === attempt.attempt_id && state.multisite.outbox.some(row => row.command.operation === 'intent_review' && row.command.instruction_revision === rev && row.command.input_id === key('intent-delivery', sub.id))) facts.push(fact(sub.id, sub.ingestedAt, 'intent_consumed'))
  for (const result of state.multisite.results) if (result.senderBinding?.attempt_id === attempt.attempt_id && result.instructionRevision === rev && !state.multisite.receipts.some(row => row.event?.event_id === result.id && row.historical)) facts.push(fact(result.id, result.acceptedAt, 'result'))
  for (const wait of state.multisite.dependencyWaits.filter(row => row.parentAttemptId === attempt.attempt_id && row.instructionRevision === rev)) for (const result of state.multisite.results.filter(row => wait.dependencyIds.includes(row.delegationId) && row.instructionRevision === rev)) facts.push(fact('dependency:' + result.id, result.acceptedAt, 'dependency_result'))
  for (const job of state.multisite.jobs) if (sameAttempt(job, attempt) && job.instructionRevision === rev) facts.push(fact(job.id + ':' + job.sequence, job.updatedAt, 'job_stage'))
  for (const artifact of state.artifacts ?? []) if (sameAttempt(artifact, attempt) && artifact.instructionRevision === rev && artifact.status === 'ready') facts.push(fact(artifact.id, artifact.verification?.at, 'artifact_ready'))
  for (const evidence of state.evidence ?? []) if (sameAttempt(evidence.producerBinding, attempt) && evidence.instructionRevision === rev && evidence.status === 'ready') facts.push(fact(evidence.id, evidence.receivedAt, 'evidence_ready'))
  const ranges = new Set()
  for (const page of state.contextReads ?? []) if (page.receiverBinding?.attempt_id === attempt.attempt_id && page.instructionRevision === rev) {
    const range = digest([page.objectRef, page.view, page.fromIndex, page.page.nextIndex]); if (ranges.has(range)) continue; ranges.add(range)
    facts.push(fact(page.id, page.readAt, 'context_range'))
  }
  return [...new Map(facts.filter(Boolean).map(row => [row.id, row])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}
export function supervisionWaits(state, attempt, work, now) {
  const reasons = [], controls = relevantManualControls(state, attempt)
  for (const control of controls) {
    const holder = control.holders.find(row => sameAttempt(row.binding, attempt))
    if (control.action === 'pause') reasons.push(holder?.idleAt ? 'MANUAL_PAUSED' : 'MANUAL_PAUSING')
    else if (holder && !holder.releasedAt) reasons.push('MANUAL_RELEASE_PENDING')
    else if (holder && !holder.resumeConsumedAt) reasons.push('MANUAL_RESUME_PENDING')
  }
  if (terminal(work.status) || terminal(attempt.status)) reasons.push(work.status === 'stopping' || attempt.status === 'stopping' ? 'STOPPING' : 'TERMINAL')
  if (attempt.status === 'unknown' || work.status === 'interrupted') reasons.push('UNKNOWN_OWNERSHIP')
  if (attempt.status === 'waiting_budget' || work.status === 'waiting_budget' || state.budgetHolds.some(row => sameAttempt(row, attempt) && row.state === 'waiting')) reasons.push('WAITING_BUDGET')
  if (work.modelRequestBudget?.version !== 2 && (work.modelRequestBudget?.exhaustedAt || work.modelRequestBudget?.reserved >= work.modelRequestBudget?.limit)) reasons.push('WAITING_BUDGET')
  if (work.modelRequestBudget?.version === 2 && now >= Date.parse(work.modelRequestBudget.executionDeadlineAt)) reasons.push('EXECUTION_DEADLINE')
  if (attempt.status === 'waiting_question' || supervisionUserQuestion(state, attempt) || state.intentQuestions?.some(row => row.state === 'open' && row.handlerBinding?.attempt_id === attempt.attempt_id) || state.multisite.questions?.some(row => row.state === 'open' && row.senderBinding?.attempt_id === attempt.attempt_id)) reasons.push('WAITING_USER')
  if (attempt.status === 'waiting_dependency' || state.multisite.dependencyWaits.some(row => row.parentAttemptId === attempt.attempt_id && row.instructionRevision === attempt.instruction_revision && !row.wokenAt)) reasons.push('WAITING_DEPENDENCY')
  for (const instance of state.contextReadInstances ?? []) if (instance.readerBinding?.attempt_id === attempt.attempt_id) {
    const window = currentContextWindow(state, instance.id)
    const readsExhausted = state.contextReads.filter(page => page.windowId === window?.id).length >= instance.limits.maxReads
    if (state.contextReads.some(page => {
      if (page.contextInstanceId !== instance.id || !(page.page.partial && !page.page.nextCursor && page.page.limitReason || window?.blockedFrontier?.parentReadId === page.id || readsExhausted)) return false
      const position = contextResumePosition(state, instance, page.id)
      if (!position) return false
      // A parent page can introduce another target after an earlier target was
      // approved. Approval belongs to the exact position, not the page forever.
      const approved = window?.continuationTarget ?? (page.page.partial ? { parentReadId: page.id, objectRef: page.objectRef, view: page.view, fromIndex: page.page.nextIndex, path: page.path } : null)
      return window?.parentReadId !== page.id || !approved || digest(approved) !== digest(position)
    })) reasons.push('CONTEXT_WAIT_USER')
  }
  return [...new Set(reasons)]
}

export function supervisionProjection(state, identity, nodeBridge, now = Date.now()) {
  const all = state.multisite.attempts.filter(attempt => inScope(identity, state.works.find(work => work.id === attempt.work_id), attempt))
  const attempts = all.slice(-64).map(attempt => {
    const work = state.works.find(row => row.id === attempt.work_id), facts = checkpoints(state, attempt), rows = state.modelRequests.filter(row => sameAttempt(row, attempt)), connection = nodeBridge?.supervisionConnection(attempt.node_id) ?? null
    const used = work.modelRequestBudget?.version === 2 ? committedBudget(state, work) : null
    const errors = state.multisite.receipts.filter(row => !row.historical && row.event.kind === 'runtime_unavailable' && sameAttempt(row.event, attempt) && row.event.instruction_revision === attempt.instruction_revision && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.event.reason)).map(row => ({ id: row.event.event_id, code: row.event.reason }))
    errors.push(...(state.supervisionToolRejections ?? []).filter(row => sameBinding(row.subjectBinding, attempt) && row.instructionRevision === attempt.instruction_revision).map(row => ({ id: row.id, code: row.code })))
    const modelReads = [...new Set(rows.filter(row => row.instructionRevision === attempt.instruction_revision).flatMap(row => row.contextReadReceiptIds ?? []))]
    return { binding: binding(attempt), instructionRevision: attempt.instruction_revision, observedRevision: attempt.observed_revision, status: attempt.status, workStatus: work.status, startedAt: attempt.startedAt ?? null,
      checkpointAt: facts.at(-1)?.at ?? attempt.startedAt ?? null, checkpointId: facts.at(-1)?.id ?? null, factRefs: facts.slice(-16),
      waits: supervisionWaits(state, attempt, work, now), nodeInstanceId: state.nodes.find(row => row.id === attempt.node_id)?.nodeInstanceId ?? null,
      manualControls: relevantManualControls(state, attempt).map(row => { const holder = row.holders.find(holder => sameAttempt(holder.binding, attempt)); return { id: row.id, scope: row.scope, generation: row.generation, action: row.action, idleAt: holder?.idleAt ?? null, releasedAt: holder?.releasedAt ?? null, resumeConsumedAt: holder?.resumeConsumedAt ?? null } }),
      budgetHolds: state.budgetHolds.filter(row => sameAttempt(row, attempt)).slice(-8).map(row => ({ id: row.id, state: row.state, idleAt: row.idleAt, dimensions: row.dimensions, createdAt: row.createdAt })),
      intents: state.contextSubscriptions.filter(sub => sub.handlerBinding.attempt_id === attempt.attempt_id && ['active', 'paused'].includes(sub.lifecycle)).slice(-8).map(sub => { const intent = state.workIntents.find(row => row.id === sub.intentId); return { intentId: sub.intentId, routeRevision: intent?.routeRevision ?? null, subscriptionId: sub.id, subscriptionRevision: sub.revision, mode: sub.mode, lifecycle: sub.lifecycle, ingestedAt: sub.ingestedAt ?? null, openQuestions: state.intentQuestions.filter(question => question.subscriptionId === sub.id && question.state === 'open').slice(-8).map(question => ({ id: question.id, routeRevision: question.routeRevision })) } }),
      connection: connection ? { generation: connection.generation, hostRunId: connection.hostRunId, connectedAt: connection.connectedAt } : null,
      jobs: state.multisite.jobs.filter(row => sameAttempt(row, attempt)).slice(-16).map(row => ({ id: row.id, state: row.state, sequence: row.sequence, updatedAt: row.updatedAt })),
      errors: errors.slice(-16), errorObservation: errors.length ? 'structured_events' : 'not_observed', unavailableReason: attempt.unavailableReason ?? null,
      modelReadReceiptIds: modelReads.slice(-16), modelReadReceiptCount: modelReads.length,
      modelAccounting: { requests: rows.length, legacyReserved: work.modelRequestBudget?.version === 2 ? null : work.modelRequestBudget?.reserved ?? null, unknown: rows.filter(row => row.outcome === 'unknown').slice(-16).map(row => ({ id: row.id, reservedAt: row.reservedAt })), unknownCount: rows.filter(row => row.outcome === 'unknown').length, usageUnknown: rows.filter(row => row.usage === null).length, committed: used ? { requests: used.requests, tokens: String(used.tokens), costMicros: String(used.costMicros) } : null, deadlineAt: work.modelRequestBudget?.executionDeadlineAt ?? null } }
  })
  const ids = new Set(attempts.map(row => row.binding.attempt_id)), pending = state.multisite.outbox.filter(row => !row.acceptedAt && ids.has(row.command.attempt_id))
  return { sampledAt: new Date(now).toISOString(), currentBusiness: 'observed', truncated: all.length > 64 || pending.length > 64, attempts, pendingCommands: pending.slice(0, 64).map(row => {
    const connection = nodeBridge?.supervisionConnection(row.command.node_id)
    return { commandId: row.id, payloadDigest: row.command.payload_digest, binding: binding(row.command), operation: row.command.operation, createdAt: row.createdAt, acceptedAt: null, generation: connection?.generation ?? null, nodeInstanceId: connection?.nodeInstanceId ?? null, sent: connection?.sentCommandIds.includes(row.id) ?? false }
  }), findings: state.supervisionFindings.filter(row => row.workspaceId === identity.workspaceId && identity.nodeIds.includes(row.scope.nodeId) && (!identity.workIds || identity.workIds.includes(row.scope.workId))).slice(-64), actions: state.supervisionActions.filter(row => ids.has(row.binding.attempt_id)).slice(-64) }
}

export function createSupervisionService({ store, nodeBridge, identities, diagnosis, clock = () => Date.now() }) {
  if (!Array.isArray(identities) || identities.some(row => !safeId(row.id) || typeof row.token !== 'string' || row.token.length < 24 || !['observe', 'recover', 'diagnose'].includes(row.role) || !safeId(row.workspaceId) || !Array.isArray(row.nodeIds) || !row.nodeIds.length || row.nodeIds.some(id => !safeId(id)) || row.workIds && (!Array.isArray(row.workIds) || row.workIds.some(id => !safeId(id)))) || new Set(identities.map(row => row.token)).size !== identities.length) throw error('INVALID_REQUEST', '监督身份配置无效')
  if (identities.some(row => row.role === 'diagnose' ? typeof row.budgetPolicyId !== 'string' || !row.budgetPolicyId.trim() : row.budgetPolicyId !== undefined) || new Set(identities.filter(row => row.role === 'diagnose').map(row => row.workspaceId)).size !== identities.filter(row => row.role === 'diagnose').length) throw error('INVALID_REQUEST', '诊断身份或独立预算配置无效')
  identities = structuredClone(identities)
  if (new Set(identities.map(row => row.id)).size !== identities.length) throw error('INVALID_REQUEST', '监督身份标识重复')
  function authenticate(header, role) { const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1], identity = token && identities.find(row => matches(row.token, token)); if (!identity || identity.role !== role) throw error('FORBIDDEN'); return identity }
  function scope(state, identity, value) {
    exact(value, ['workId', 'attemptId', 'nodeId', 'nodeInstanceId'])
    for (const field of ['workId', 'attemptId', 'nodeInstanceId']) if (value[field] !== null && !safeId(value[field])) throw error('INVALID_REQUEST')
    if (!safeId(value.nodeId) || !identity.nodeIds.includes(value.nodeId)) throw error('FORBIDDEN')
    if (value.workId === null && value.attemptId === null) { if (identity.workIds) throw error('FORBIDDEN'); return }
    const attempt = state.multisite.attempts.find(row => row.attempt_id === value.attemptId), work = state.works.find(row => row.id === value.workId)
    if (!attempt || attempt.work_id !== work?.id || attempt.node_id !== value.nodeId || !inScope(identity, work, attempt)) throw error('FORBIDDEN')
  }
  async function submit(identity, value) {
    exact(value, ['episodeId', 'scope', 'classification', 'firstObservedAt', 'lastObservedAt', 'checkpointAt', 'factRefs', 'code'])
    if (!safeId(value.episodeId) || !SUPERVISION_CLASSES.includes(value.classification) || !iso(value.firstObservedAt) || !iso(value.lastObservedAt) || Date.parse(value.lastObservedAt) < Date.parse(value.firstObservedAt) || value.checkpointAt !== null && !iso(value.checkpointAt) || !Array.isArray(value.factRefs) || value.factRefs.length > 16 || value.factRefs.some(id => !safeId(id)) || value.code !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)) throw error('INVALID_REQUEST')
    const id = key('supervision-finding', identity.id, value.episodeId); let result
    await store.update(state => {
      scope(state, identity, value.scope)
      const old = state.supervisionFindings.find(row => row.id === id)
      if (old) { if (digest({ ...old, id: undefined, identityId: undefined, workspaceId: undefined, acceptedAt: undefined, lastObservedAt: undefined }) !== digest({ ...value, lastObservedAt: undefined })) throw error('IDEMPOTENCY_CONFLICT'); if (Date.parse(value.lastObservedAt) > Date.parse(old.lastObservedAt)) old.lastObservedAt = value.lastObservedAt; result = old }
      else { result = { id, identityId: identity.id, workspaceId: identity.workspaceId, ...structuredClone(value), acceptedAt: new Date(clock()).toISOString() }; state.supervisionFindings.push(result) }
      return state
    }); return { finding: structuredClone(result) }
  }
  async function reoffer(identity, value) {
    exact(value, ['episodeId', 'commandId', 'payloadDigest', 'generation', 'nodeInstanceId'])
    for (const name of ['episodeId', 'commandId', 'payloadDigest', 'generation', 'nodeInstanceId']) if (!safeId(value[name])) throw error('INVALID_REQUEST')
    let claimed, receipt
    const offered = await nodeBridge?.reofferPending(value, state => {
      const finding = state.supervisionFindings.find(row => row.episodeId === value.episodeId && row.classification === 'COMMAND_UNACKNOWLEDGED' && row.workspaceId === identity.workspaceId)
      if (!finding) throw error('FORBIDDEN'); scope(state, identity, finding.scope)
      const command = state.multisite.outbox.find(row => row.id === value.commandId)?.command
      if (!command || command.attempt_id !== finding.scope.attemptId || command.node_id !== finding.scope.nodeId || value.nodeInstanceId !== finding.scope.nodeInstanceId || !finding.factRefs.includes(command.command_id) || clock() - Date.parse(finding.acceptedAt) > 120000) throw error('FORBIDDEN')
      const old = state.supervisionActions.find(row => row.commandId === value.commandId)
      if (old) { receipt = old; return false }
      claimed = { id: key('supervision-action', value.commandId), findingId: finding.id, identityId: identity.id, commandId: value.commandId, payloadDigest: value.payloadDigest, binding: binding(command), generation: value.generation, nodeInstanceId: value.nodeInstanceId, claimedAt: new Date(clock()).toISOString(), outcome: 'claimed', reason: null, finishedAt: null }
      state.supervisionActions.push(claimed); receipt = claimed; return true
    })
    if (claimed && offered !== undefined) await store.update(state => { const action = state.supervisionActions.find(row => row.id === claimed.id); action.outcome = offered ? 'offered' : 'not_offered'; action.reason = offered ? null : 'CURRENT_QUALIFICATION_CHANGED'; action.finishedAt = new Date(clock()).toISOString(); receipt = action; return state })
    return { action: receipt ? structuredClone(receipt) : null, offered: offered === true }
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/internal/supervision/')) return false
    let status = 200, result
    try {
      if (url.search) throw error('INVALID_REQUEST')
      if (request.method === 'GET' && url.pathname === '/internal/supervision/snapshot') { const identity = authenticate(request.headers.authorization, 'observe'); result = supervisionProjection(await store.read(), identity, nodeBridge, clock()) }
      else if (request.method === 'POST' && ['/internal/supervision/findings', '/internal/supervision/reoffer', '/internal/supervision/diagnose'].includes(url.pathname)) {
        const identity = authenticate(request.headers.authorization, url.pathname.endsWith('/reoffer') ? 'recover' : url.pathname.endsWith('/diagnose') ? 'diagnose' : 'observe')
        if (String(request.headers['content-type']).split(';')[0] !== 'application/json') throw error('INVALID_REQUEST')
        const chunks = []; let length = 0
        for await (const chunk of request) { length += chunk.length; if (length > 16384) throw error('INVALID_REQUEST'); chunks.push(chunk) }
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('INVALID_REQUEST') }
        if (url.pathname.endsWith('/diagnose')) { exact(value, ['findingId']); if (!diagnosis || typeof value.findingId !== 'string') throw error('FORBIDDEN'); result = await diagnosis.request(identity, value.findingId) }
        else result = url.pathname.endsWith('/reoffer') ? await reoffer(identity, value) : await submit(identity, value)
      } else throw error('NOT_FOUND')
    } catch (cause) { status = ({ FORBIDDEN: 403, INVALID_REQUEST: 400, IDEMPOTENCY_CONFLICT: 409, NOT_FOUND: 404 })[cause.code] ?? 503; result = { error: { code: status === 503 ? 'STORE_UNAVAILABLE' : cause.code, message: status === 503 ? '监督采样暂不可用' : '监督请求未获准' } } }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); return true
  }
  return { handle, authenticate, submit, reoffer, snapshot: async identity => supervisionProjection(await store.read(), identity, nodeBridge, clock()) }
}
