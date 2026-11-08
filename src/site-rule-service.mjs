import { isDeepStrictEqual as equal } from 'node:util'
import { digest, error, exact, key, sameBinding, text } from '../packages/agent-contracts/index.mjs'
import { hashValue, timestamp } from '../packages/agent-contracts/evidence.mjs'
import { assertNodeCaller } from '../packages/agent-contracts/nodes.mjs'
import { authorizeMultisiteExecution } from './multisite-authorization.mjs'
import { assertManualExecution, assertManualConsumption } from './manual-control.mjs'
import { assertEvidenceReader } from './evidence-access.mjs'
import { assertCurrentSiteRule, currentSiteRule, SITE_CAPABILITY, SITE_CODE, SITE_RESOURCE, SITE_RULE_ID, SITE_RULE_LIMITS as L, siteEventKey, siteRuleParties, siteWindow, validateSiteSource } from './site-rule-state.mjs'

const active = work => !['completed', 'cancelled', 'failed', 'stopping'].includes(work.status)
const nowIso = now => new Date(now).toISOString()
const ruleInfo = rule => rule ? { ...rule, ruleId: SITE_RULE_ID, resourceId: SITE_RESOURCE, capabilityId: SITE_CAPABILITY, modeLabel: 'simulated', limits: L, approvedBy: rule.ownerId } : { ruleId: SITE_RULE_ID, resourceId: SITE_RESOURCE, revision: 0, mode: 'observe', modeLabel: 'simulated', limits: L }
const eventInfo = event => ({ eventId: event.eventId, status: event.status, reason: event.reason, workId: event.workId })

export function createSiteRuleService({ store, nodes, multisite, clock = Date.now, onError = () => {} }) {
  function admin(state, actor) {
    const owner = state.members.find(row => row.id === actor?.id && row.enabled && row.role === 'admin')
    if (!owner) throw error('FORBIDDEN', '需要管理员权限')
    return owner
  }
  function invalidWork(state, work, now) {
    try { assertCurrentSiteRule(state, work, undefined, now); return false } catch (cause) {
      if (cause.code !== 'FORBIDDEN') throw cause
      return true
    }
  }
  const activeRuleWork = state => state.works.filter(row => row.origin === 'rule' && active(row))
  function stopInvalid(state, now) {
    for (const work of activeRuleWork(state)) if (invalidWork(state, work, now)) multisite.cancelSiteRuleWork(state, work, nowIso(now))
  }
  async function put(actor, body) {
    exact(body, ['expectedRevision', 'mode', 'nodeId', 'threadId', 'employeeId', 'profileVersion', 'budgetPolicyId', 'expiresAt'])
    if (!['observe', 'auto'].includes(body.mode) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw error('INVALID_REQUEST')
    let result
    await store.update(state => {
      const owner = admin(state, actor), old = currentSiteRule(state), now = clock(), approvedAt = nowIso(now)
      if (old && old.ownerId !== owner.id) throw error('FORBIDDEN')
      if ((old?.revision ?? 0) !== body.expectedRevision) throw error('REVISION_CONFLICT')
      const revision = body.expectedRevision + 1, id = key(SITE_RULE_ID, revision)
      if (revision > L.revisions || revision === L.revisions && body.mode === 'auto') throw error('INVALID_STATE', '模拟规则需保留关闭所用版本')
      const supplied = ['nodeId', 'threadId', 'employeeId', 'profileVersion', 'budgetPolicyId'].some(field => body[field] !== undefined)
      let row
      if (old && !supplied && body.mode === 'observe') {
        // A disabled or revoked source must not prevent the human owner from closing the grant.
        if (body.expiresAt !== undefined && body.expiresAt !== null) throw error('INVALID_REQUEST')
        row = { ...old, id, revision, mode: 'observe', approvedAt, expiresAt: null, grantRef: null }
      } else {
        const nodeId = text(body.nodeId), threadId = text(body.threadId), employeeId = text(body.employeeId), budgetPolicyId = text(body.budgetPolicyId)
        if (!Number.isSafeInteger(body.profileVersion) || body.profileVersion < 1 || (body.mode === 'auto' ? !timestamp(body.expiresAt) || Date.parse(body.expiresAt) <= now : body.expiresAt != null)) throw error('INVALID_REQUEST')
        const node = state.nodes.find(row => row.id === nodeId), resource = state.resources.find(row => row.id === SITE_RESOURCE), employee = state.employees.find(row => row.id === employeeId), budget = state.budgetPolicies.find(row => row.id === budgetPolicyId)
        row = { id, revision, mode: body.mode, workspaceId: node?.workspaceId, ownerId: owner.id, threadId, nodeId, nodeInstanceId: node?.nodeInstanceId, credentialVersion: node?.credentialVersion, resourceRevision: resource?.revision,
          employeeId, employeeRevision: employee?.revision, profileVersion: body.profileVersion, budgetPolicyId, budgetPolicyRevision: budget?.revision, approvedAt, expiresAt: body.mode === 'auto' ? body.expiresAt : null, grantRef: body.mode === 'auto' ? key('site-rule-grant', id, owner.id) : null }
        siteRuleParties(state, row)
      }
      state.siteRuleRevisions.push(row)
      stopInvalid(state, now)
      result = ruleInfo(row)
      return state
    })
    return result
  }
  let needsScan = true
  async function receive(request, body) {
    exact(body, ['profileVersion', 'maxActiveLoops', 'sourceSha256', 'event'])
    if (!Number.isSafeInteger(body.maxActiveLoops) || body.maxActiveLoops < 1 || body.maxActiveLoops > 32 || !hashValue(body.sourceSha256)) throw error('INVALID_REQUEST')
    const event = validateSiteSource(body.event)
    let result
    await store.update(state => {
      const auth = nodes.authenticate(state, request.headers.authorization, request.headers['x-geneway-node-instance'])
      const rule = currentSiteRule(state)
      if (!rule || auth.nodeId !== rule.nodeId || auth.nodeInstanceId !== rule.nodeInstanceId || auth.credentialVersion !== rule.credentialVersion || auth.workspaceId !== rule.workspaceId || body.profileVersion !== rule.profileVersion) throw error('FORBIDDEN')
      const { owner } = siteRuleParties(state, rule)
      const id = siteEventKey(auth.nodeInstanceId, event.sourceEventId), eventDigest = digest(event), old = state.siteRuleEvents.find(row => row.id === id)
      if (old) {
        if (old.eventDigest !== eventDigest) throw error('IDEMPOTENCY_CONFLICT')
        result = { ...eventInfo(old), replay: true }; return state
      }
      if (event.code !== SITE_CODE || event.severity !== 'error') { result = { eventId: event.sourceEventId, status: 'ignored', reason: 'CONDITION_NOT_MET', workId: null }; return state }
      if (state.siteRuleEvents.length >= L.events) throw error('INVALID_STATE', '模拟规则事件容量已满')
      const now = clock(), at = nowIso(now), eventAt = event.sourceTimestamp, eventMs = Date.parse(eventAt)
      const row = { id, sourceVersion: 1, ruleRevision: rule.revision, nodeInstanceId: auth.nodeInstanceId, eventId: event.sourceEventId, eventAt, sourceSha256: body.sourceSha256, eventDigest, receivedAt: at, status: 'observed', reason: 'OBSERVE_ONLY', workId: null }
      // A missed/old source occurrence is retained as observed, never queued for later auto.
      if (rule.mode === 'auto') {
        if (!timestamp(eventAt) || eventMs > now || eventMs < now - L.windowMs) row.reason = 'EVENT_TIME_UNCONFIRMED'
        else if (eventMs <= Date.parse(rule.approvedAt)) row.reason = 'BEFORE_ENABLEMENT'
        else if (now >= Date.parse(rule.expiresAt)) row.reason = 'GRANT_EXPIRED'
        else if (body.maxActiveLoops < 2) row.reason = 'FOREGROUND_SLOT_REQUIRED'
        else {
          const related = state.works.find(work => work.ownerMemberId === owner.id && work.workType === 'multisite' && work.workspaceId === rule.workspaceId
            && (work.origin === 'rule' ? active(work) && state.siteRuleRevisions[work.siteRule.ruleRevision - 1]?.nodeId === rule.nodeId
              && eventMs >= Date.parse(work.siteRule.window.from) && eventMs <= Date.parse(work.siteRule.window.to)
              : Date.parse(work.acceptedAt) >= eventMs - L.windowMs && Date.parse(work.acceptedAt) <= now && (active(work) || work.status === 'completed')
                && state.multisite.attempts.some(attempt => attempt.work_id === work.id && owner.employeeIds.includes(attempt.agent_id) && attempt.node_id === rule.nodeId && attempt.resource_refs.includes(SITE_RESOURCE))))
          const latest = state.siteRuleEvents.findLast(row => row.status === 'created')
          if (related) Object.assign(row, { status: 'associated', reason: 'EXISTING_WORK', workId: related.id })
          else if (state.works.some(work => work.origin === 'rule' && (active(work) || work.status === 'stopping'))) row.reason = 'BACKGROUND_BUSY'
          else if (latest && now - Date.parse(latest.receivedAt) < L.cooldownMs) row.reason = 'COOLDOWN'
          else if (state.multisite.attempts.some(attempt => attempt.agent_id === rule.employeeId && !['completed', 'cancelled'].includes(attempt.status))) row.reason = 'EMPLOYEE_BUSY'
          else {
            const siteRule = { ruleId: SITE_RULE_ID, ruleRevision: rule.revision, triggerId: id, eventId: event.sourceEventId, eventAt, window: siteWindow(eventAt), grantRef: rule.grantRef }
            const goal = '采集连接异常诊断草稿（本机模拟）。仅在规定窗口采集 fixture:site recent_events，读取实际证据页；仅在匹配触发事件后提交内部草稿。'
            const transition = multisite.applyTransition(state, owner, 'create', { employeeId: rule.employeeId, goal, budgetPolicyId: rule.budgetPolicyId, clientRequestId: key('site-rule-work', id) }, { siteRule })
            Object.assign(row, { status: 'created', reason: 'AUTO_ADMITTED', workId: transition.reply.workId })
          }
        }
      }
      state.siteRuleEvents.push(row); result = { ...eventInfo(row), replay: false }
      return state
    })
    if (result.status === 'created') needsScan = true
    return result
  }

  function project(state, actor, workId, now) {
    const { user, work } = multisite.authorizeRead(state, actor, workId)
    if (work.origin !== 'rule') throw error('NOT_FOUND')
    const pin = work.siteRule, rule = state.siteRuleRevisions[pin.ruleRevision - 1], draft = state.siteDiagnosisDrafts.find(row => row.workId === work.id)
    const read = draft && state.siteRuleReads.find(row => row.id === draft.readId)
    const row = read && state.evidence.find(row => row.id === read.evidenceRef.id && row.status === 'ready' && row.workId === work.id && row.ownerMemberId === user.id && row.version === read.evidenceRef.version && row.sha256 === read.evidenceRef.sha256)
    const source = row && state.resources.find(resource => resource.id === SITE_RESOURCE && resource.enabled && resource.workspaceId === work.workspaceId && resource.revision === row.resourceRevision && resource.ownerNodeId === rule.nodeId && resource.evidenceReaderAgentIds.includes(work.employeeId))
    const employee = state.employees.find(employee => employee.id === work.employeeId && employee.enabled && employee.revision === rule.employeeRevision)
    const node = state.nodes.find(node => node.id === rule.nodeId && node.status === 'active' && node.nodeInstanceId === rule.nodeInstanceId && node.credentialVersion === rule.credentialVersion && node.allowedAgentIds.includes(work.employeeId))
    const available = !!(source && employee && node)
    const ledger = state.modelRequests.filter(row => row.work_id === work.id && row.purpose === undefined)
    return { origin: 'rule', workId, rule: { id: SITE_RULE_ID, revision: pin.ruleRevision, eventId: pin.eventId, eventAt: pin.eventAt, window: pin.window, mode: 'simulated' },
      draft: draft && available ? { id: draft.id, version: draft.version, kind: draft.kind, summary: '模拟采集证据在指定窗口内包含连接中断事件。', limitations: '来源为本机模拟数据；该草稿不证明现场设备故障，也不会外发。', quality: read.quality, observedAt: read.observedAt, sourceTimestamp: read.sourceTimestamp,
        evidenceRef: read.evidenceRef, createdAt: draft.createdAt, expiresAt: draft.expiresAt, decision: draft.decision, actionable: draft.decision === null && now < Date.parse(draft.expiresAt) } : null,
      accounting: { reservedRequests: work.modelRequestBudget.reserved, usageKnown: ledger.length > 0 && ledger.every(row => row.usage !== null) } }
  }
  let scanning
  const scan = () => {
    if (!needsScan) return scanning
    return scanning ??= (async () => {
      // Reopen checks existing Work; otherwise do not keep reading an empty Store.
      needsScan = false
      const snapshot = await store.read(), works = activeRuleWork(snapshot), now = clock()
      needsScan ||= works.length > 0
      if (works.some(work => invalidWork(snapshot, work, now))) await store.update(state => { stopInvalid(state, clock()); return state })
    })().catch(cause => { needsScan = true; onError(cause) }).finally(() => { scanning = undefined })
  }
  return { get: async actor => { const state = await store.read(), owner = admin(state, actor), rule = currentSiteRule(state); if (rule && rule.ownerId !== owner.id) throw error('FORBIDDEN'); return ruleInfo(rule) }, put, receive, scan, async close() { await scanning }, getWork: async (actor, workId) => project(await store.read(), actor, workId, clock()),
    async decide(actor, workId, body) {
      exact(body, ['draftId', 'expectedVersion', 'decision'])
      if (!['accepted', 'discarded'].includes(body.decision)) throw error('INVALID_REQUEST')
      let result
      await store.update(state => {
        const now = clock(), view = project(state, actor, workId, now)
        if (!view.draft) throw error('NOT_FOUND')
        if (view.draft.id !== body.draftId || view.draft.version !== body.expectedVersion) throw error('REVISION_CONFLICT')
        if (view.draft.decision !== body.decision) {
          if (!view.draft.actionable) throw error('REVISION_CONFLICT')
          const draft = state.siteDiagnosisDrafts.find(row => row.id === body.draftId)
          draft.decision = body.decision; draft.decidedAt = nowIso(now)
        }
        result = project(state, actor, workId, now); return state
      })
      return result
    }
  }
}

// Only the original authenticated root Attempt may conclude this Work. No report/Artifact is created.
export function submitSiteDiagnosis(state, execution, parameters, { nodeAuth, manualFence, queue, at }) {
  exact(parameters, ['clientRequestId', 'instructionRevision', 'readId'])
  if (!nodeAuth) throw error('FORBIDDEN')
  const work = state.works.find(row => row.id === execution.work_id && row.origin === 'rule')
  if (!work) throw error('FORBIDDEN')
  const commandId = text(parameters.clientRequestId), namespace = key(work.workspaceId, execution.attempt_id, commandId), payloadDigest = digest({ operation: 'submit_site_diagnosis', parameters })
  const old = state.multisite.commands.find(row => row.key === namespace && row.issuerKind === 'agent')
  assertNodeCaller(state, nodeAuth, execution)
  if (old) {
    if (!sameBinding(old.senderBinding, execution)) throw error('FORBIDDEN')
    if (old.digest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT')
    assertCurrentSiteRule(state, work, execution, Date.parse(at))
    return structuredClone(old.reply)
  }
  const { current } = authorizeMultisiteExecution(state, execution)
  assertManualExecution(state, execution, manualFence); assertManualConsumption(state, execution)
  const read = state.siteRuleReads.find(row => row.id === parameters.readId && row.workId === work.id && row.instructionRevision === parameters.instructionRevision && sameBinding(row.subjectBinding, execution))
  if (!read || parameters.instructionRevision !== work.instructionRevision || state.siteDiagnosisDrafts.some(row => row.workId === work.id) || state.modelRequests.some(row => row.attempt_id === current.attempt_id && row.outcome === 'unknown')) throw error('INVALID_STATE', '缺少当前模型已读取的模拟证据')
  assertEvidenceReader(state, execution, parameters.instructionRevision, read.evidenceRef)
  const use = state.siteRuleModelReads.find(row => row.readId === read.id && state.modelRequests.some(request => request.id === row.modelRequestId && request.outcome === 'completed'))
  if (!use) throw error('INVALID_STATE', '缺少当前模型已读取的模拟证据')
  const draftId = key('site-diagnosis', work.id)
  state.siteDiagnosisDrafts.push({ id: draftId, version: 1, kind: 'site_connection_diagnosis', workId: work.id, readId: read.id, modelRequestId: use.modelRequestId, createdAt: at, expiresAt: nowIso(Date.parse(at) + L.draftMs), decision: null, decidedAt: null })
  current.status = 'completed'; work.status = 'completed'; work.completedAt = at
  state.multisite.delegations.find(row => row.id === current.delegation_id).status = 'completed'
  queue(state, current, 'settle', null, at)
  const reply = { workId: work.id, draftId, status: 'completed' }
  state.multisite.commands.push({ key: namespace, workspaceId: work.workspaceId, issuerId: current.attempt_id, issuerKind: 'agent', senderBinding: read.subjectBinding, commandId, digest: payloadDigest, reply: structuredClone(reply), acceptedAt: at })
  return reply
}
