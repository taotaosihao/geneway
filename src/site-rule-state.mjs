import { SITE_RESOURCE, SITE_CAPABILITY } from '../packages/agent-contracts/site-rule.mjs'
import { isDeepStrictEqual as equal } from 'node:util'
import { binding, digest, error, exact, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { evidenceRef, hashValue, timestamp, validateSiteEvents } from '../packages/agent-contracts/evidence.mjs'

export const SITE_RULE_ID = 'simulated-collector-link'
export { SITE_RESOURCE, SITE_CODE, SITE_CAPABILITY, SITE_RULE_TOOLS } from '../packages/agent-contracts/site-rule.mjs'
export const SITE_RULE_LIMITS = Object.freeze({ windowMs: 5 * 60_000, cooldownMs: 15 * 60_000, draftMs: 60 * 60_000, background: 1, events: 10000, revisions: 1000, pagesPerWork: 16 })
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200
const positive = value => Number.isSafeInteger(value) && value > 0
const valid = condition => { if (!condition) throw error('INVALID_STATE', '模拟采集规则事实无效') }
export const emptySiteRuleState = () => ({ siteRuleRevisions: [], siteRuleEvents: [], siteRuleReads: [], siteRuleModelReads: [], siteDiagnosisDrafts: [] })
export function assertNoFutureSiteRule(state) {
  for (const field of Object.keys(emptySiteRuleState())) valid(state[field] === undefined || Array.isArray(state[field]) && state[field].length === 0)
  valid(!state.works?.some(work => work.origin === 'rule' || work.siteRule !== undefined))
}
export const currentSiteRule = state => state.siteRuleRevisions?.at(-1)
export const siteWindow = eventAt => ({ from: new Date(Date.parse(eventAt) - SITE_RULE_LIMITS.windowMs).toISOString(), to: eventAt })
export const siteRuleRuntime = work => work.siteRule && { eventId: work.siteRule.eventId, eventAt: work.siteRule.eventAt, window: work.siteRule.window, resourceId: SITE_RESOURCE }
export const siteEventKey = (nodeInstanceId, sourceEventId) => key(SITE_RULE_ID, SITE_RESOURCE, nodeInstanceId, sourceEventId, 1)

export function siteRuleParties(state, rule) {
  if (!rule) throw error('FORBIDDEN')
  const owner = state.members.find(row => row.id === rule.ownerId && row.enabled && row.role === 'admin' && row.employeeIds.includes(rule.employeeId))
  const thread = state.webThreads.find(row => row.id === rule.threadId && row.ownerMemberId === owner?.id)
  const node = state.nodes.find(row => row.id === rule.nodeId && row.status === 'active' && row.workspaceId === rule.workspaceId && row.nodeInstanceId === rule.nodeInstanceId && row.credentialVersion === rule.credentialVersion && row.allowedAgentIds.includes(rule.employeeId))
  const resource = state.resources.find(row => row.id === SITE_RESOURCE && row.ownerNodeId === node?.id && row.workspaceId === rule.workspaceId && row.kind === 'site_diagnostics' && row.enabled && row.revision === rule.resourceRevision && row.capabilityIds.includes(SITE_CAPABILITY) && row.evidenceReaderAgentIds.includes(rule.employeeId))
  const employee = state.employees.find(row => row.id === rule.employeeId && row.enabled && row.revision === rule.employeeRevision && row.placement?.nodeId === node?.id)
  const budget = state.budgetPolicies.find(row => row.id === rule.budgetPolicyId && row.enabled && row.revision === rule.budgetPolicyRevision && row.workspaceId === rule.workspaceId && row.coordinatorAgentId === rule.employeeId)
  if (!owner || !thread || !node || !resource || !employee || !budget || !equal(employee.placement.resourceRefs, [SITE_RESOURCE])
    || !equal(employee.multisitePolicy?.execution, { capabilityIds: [SITE_CAPABILITY], resourceRefs: [SITE_RESOURCE] })
    || !['agentIds', 'capabilityIds', 'resourceRefs'].every(field => equal(employee.multisitePolicy?.delegation?.[field], []))) throw error('FORBIDDEN', '模拟规则当前授权已失效')
  return { owner, resource, employee, budget }
}

export function assertCurrentSiteRule(state, work, execution, now = Date.now()) {
  if (work.origin !== 'rule') return
  const rule = currentSiteRule(state), pin = work.siteRule
  if (!pin || rule?.mode !== 'auto' || rule.revision !== pin.ruleRevision || rule.grantRef !== pin.grantRef || rule.ownerId !== work.ownerMemberId || rule.employeeId !== work.employeeId || now >= Date.parse(rule.expiresAt)
    || execution && (execution.agent_id !== rule.employeeId || execution.node_id !== rule.nodeId || execution.parent_delegation_id !== null)) throw error('FORBIDDEN', '模拟规则当前执行授权已失效')
  return siteRuleParties(state, rule)
}

export function assertSiteCapture(state, work, declaration, payload) {
  if (work.origin !== 'rule') return
  const rule = currentSiteRule(state)
  if (declaration.resourceId !== SITE_RESOURCE || declaration.kind !== 'site_snapshot' || declaration.sourceId !== 'snapshot' || declaration.profileVersion !== rule.profileVersion || declaration.clockTrust !== 'fixture'
    || !equal(declaration.exportToAgentIds, [rule.employeeId]) || payload && (!equal(payload.window, work.siteRule.window) || payload.cacheMode !== 'fixture' || !payload.sections.includes('recent_events'))) throw error('FORBIDDEN', '证据超出模拟规则窗口或资源')
}

export function recordSiteRuleRead(state, work, execution, revision, page, payload, now) {
  const source = state.siteRuleEvents.find(row => row.id === work.siteRule.triggerId)
  const item = page.entries.find(event => event.sourceEventId === source?.eventId && digest(event) === source.eventDigest)
  if (!item || !timestamp(item.sourceTimestamp) || item.sourceTimestamp !== work.siteRule.eventAt || !equal(payload.window, work.siteRule.window) || page.quality !== 'current' || page.clockTrust !== 'fixture') return page
  const pageDigest = digest(page), id = key('site-rule-read', binding(execution), pageDigest)
  if (!state.siteRuleReads.some(row => row.id === id)) {
    if (state.siteRuleReads.filter(row => row.workId === work.id).length >= SITE_RULE_LIMITS.pagesPerWork) throw error('EVIDENCE_READ_LIMIT')
    state.siteRuleReads.push({ id, workId: work.id, subjectBinding: binding(execution), instructionRevision: revision, evidenceRef: structuredClone(page.ref), pageDigest,
      eventDigest: source.eventDigest, quality: page.quality, observedAt: page.observedAt, sourceTimestamp: page.sourceTimestamp, readAt: new Date(now).toISOString() })
  }
  return { ...page, siteRuleReadId: id }
}

export function siteModelReadIds(state, work, execution, body) {
  if (work.origin !== 'rule') return []
  const calls = new Map(), seen = new Set()
  for (const message of body.messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (call.type === 'function') calls.set(call.id, call.function)
    if (message.role !== 'tool' || calls.get(message.tool_call_id)?.name !== 'geneway_read_shared_evidence') continue
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
    let page, params
    try { const decoded = JSON.parse(content); page = decoded.result ?? decoded; params = JSON.parse(calls.get(message.tool_call_id).arguments) } catch { continue }
    if (!page || !params) continue
    const { siteRuleReadId, ...original } = page
    const read = state.siteRuleReads.find(row => row.id === siteRuleReadId && row.workId === work.id && row.instructionRevision === work.instructionRevision && sameBinding(row.subjectBinding, execution))
    if (read && equal(params.ref, read.evidenceRef) && digest(original) === read.pageDigest) seen.add(read.id)
  }
  return [...seen]
}

export function validateSiteRuleState(state) {
  const arrays = Object.keys(emptySiteRuleState())
  for (const field of arrays) {
    const rows = state[field]
    valid(Array.isArray(rows) && rows.length <= (field === 'siteRuleRevisions' ? SITE_RULE_LIMITS.revisions : ['siteRuleReads', 'siteRuleModelReads'].includes(field) ? SITE_RULE_LIMITS.events * SITE_RULE_LIMITS.pagesPerWork : SITE_RULE_LIMITS.events))
    const ids = rows.map(row => row?.id)
    valid(ids.every(text) && new Set(ids).size === rows.length)
  }
  for (const [index, row] of state.siteRuleRevisions.entries()) {
    exact(row, ['id','revision','mode','workspaceId','ownerId','threadId','nodeId','nodeInstanceId','credentialVersion','resourceRevision','employeeId','employeeRevision','profileVersion','budgetPolicyId','budgetPolicyRevision','approvedAt','expiresAt','grantRef'])
    valid(row.id === key(SITE_RULE_ID, index + 1) && row.revision === index + 1 && ['observe','auto'].includes(row.mode)
      && ['workspaceId','ownerId','threadId','nodeId','nodeInstanceId','employeeId','budgetPolicyId'].every(field => text(row[field]))
      && ['credentialVersion','resourceRevision','employeeRevision','profileVersion','budgetPolicyRevision'].every(field => positive(row[field]))
      && timestamp(row.approvedAt) && (row.mode === 'observe' ? row.expiresAt === null && row.grantRef === null : timestamp(row.expiresAt) && row.expiresAt > row.approvedAt && row.grantRef === key('site-rule-grant', row.id, row.ownerId)))
  }
  for (const row of state.siteRuleEvents) {
    exact(row, ['id','sourceVersion','ruleRevision','nodeInstanceId','eventId','eventAt','sourceSha256','eventDigest','receivedAt','status','reason','workId'])
    const rule = state.siteRuleRevisions[row.ruleRevision - 1]
    valid(rule && rule.nodeInstanceId === row.nodeInstanceId && row.sourceVersion === 1 && text(row.eventId) && row.id === siteEventKey(row.nodeInstanceId, row.eventId) && (row.eventAt === null || timestamp(row.eventAt))
      && hashValue(row.eventDigest) && hashValue(row.sourceSha256) && timestamp(row.receivedAt)
      && ['observed','created','associated'].includes(row.status) && text(row.reason) && (row.status === 'observed' ? row.workId === null : state.works.some(work => work.id === row.workId && work.ownerMemberId === rule.ownerId)))
  }
  for (const work of state.works.filter(row => row.origin === 'rule' || row.siteRule !== undefined)) {
    const pin = work.siteRule
    exact(pin, ['ruleId','ruleRevision','triggerId','eventId','eventAt','window','grantRef'])
    const rule = state.siteRuleRevisions[pin.ruleRevision - 1], event = state.siteRuleEvents.find(row => row.id === pin.triggerId)
    const attempts = state.multisite.attempts.filter(row => row.work_id === work.id)
    valid(work.origin === 'rule' && pin.ruleId === SITE_RULE_ID && rule?.mode === 'auto' && pin.grantRef === rule.grantRef && work.workType === 'multisite' && work.modelRequestBudget.version === 2
      && work.ownerMemberId === rule.ownerId && work.employeeId === rule.employeeId && work.workspaceId === rule.workspaceId && work.instructionRevision === 1 && !work.spreadsheetRequest
      && event?.status === 'created' && event.workId === work.id && event.ruleRevision === rule.revision && pin.eventId === event.eventId && timestamp(pin.eventAt) && pin.eventAt === event.eventAt && equal(pin.window, siteWindow(event.eventAt))
      && attempts.length === 1 && attempts[0].node_id === rule.nodeId && attempts[0].agent_id === rule.employeeId && attempts[0].parent_delegation_id === null
      && equal(attempts[0].grant?.execution, { capabilityIds: [SITE_CAPABILITY], resourceRefs: [SITE_RESOURCE] })
      && ['agentIds','capabilityIds','resourceRefs'].every(field => equal(attempts[0].grant?.delegation[field], []))
      && state.multisite.outbox.some(row => row.command.operation === 'launch' && row.command.attempt_id === attempts[0].attempt_id && equal(row.command.parameters.siteRule, siteRuleRuntime(work))))
  }
  for (const read of state.siteRuleReads) {
    exact(read, ['id','workId','subjectBinding','instructionRevision','evidenceRef','pageDigest','eventDigest','quality','observedAt','sourceTimestamp','readAt']); evidenceRef(read.evidenceRef)
    const work = state.works.find(row => row.id === read.workId && row.origin === 'rule'), event = state.siteRuleEvents.find(row => row.id === work?.siteRule.triggerId)
    const evidence = state.evidence.find(row => row.id === read.evidenceRef.id && row.status === 'ready' && row.workId === work?.id && row.version === read.evidenceRef.version && row.sha256 === read.evidenceRef.sha256)
    valid(work && event?.eventDigest === read.eventDigest && evidence && sameBinding(evidence.producerBinding, read.subjectBinding) && evidence.instructionRevision === read.instructionRevision
      && read.id === key('site-rule-read', read.subjectBinding, read.pageDigest) && hashValue(read.pageDigest) && read.quality === 'current' && evidence.quality === read.quality && evidence.observedAt === read.observedAt && evidence.sourceTimestamp === read.sourceTimestamp && timestamp(read.readAt))
  }
  for (const use of state.siteRuleModelReads) {
    exact(use, ['id','readId','modelRequestId'])
    const read = state.siteRuleReads.find(row => row.id === use.readId), request = state.modelRequests.find(row => row.id === use.modelRequestId)
    valid(read && request && request.purpose === undefined && request.instructionRevision === read.instructionRevision && sameBinding(request, read.subjectBinding) && use.id === key('site-rule-model-read', read.id, request.id))
  }
  for (const draft of state.siteDiagnosisDrafts) {
    exact(draft, ['id','version','kind','workId','readId','modelRequestId','createdAt','expiresAt','decision','decidedAt'])
    const read = state.siteRuleReads.find(row => row.id === draft.readId), request = state.modelRequests.find(row => row.id === draft.modelRequestId)
    const work = state.works.find(row => row.id === draft.workId && row.origin === 'rule')
    valid(work?.status === 'completed' && work.completedAt === draft.createdAt && !work.artifactRefs?.length && read?.workId === draft.workId && request?.outcome === 'completed' && state.siteRuleModelReads.some(row => row.readId === read.id && row.modelRequestId === request.id)
      && draft.id === key('site-diagnosis', draft.workId) && draft.version === 1 && draft.kind === 'site_connection_diagnosis' && timestamp(draft.createdAt) && Date.parse(draft.expiresAt) === Date.parse(draft.createdAt) + SITE_RULE_LIMITS.draftMs
      && (draft.decision === null ? draft.decidedAt === null : ['accepted','discarded'].includes(draft.decision) && timestamp(draft.decidedAt) && draft.decidedAt >= draft.createdAt && draft.decidedAt < draft.expiresAt))
  }
}
export function assertSiteRuleImmutable(before, after) {
  for (const field of Object.keys(emptySiteRuleState()).filter(field => field !== 'siteDiagnosisDrafts')) valid(equal(before[field], after[field].slice(0, before[field].length)))
  for (const draft of before.siteDiagnosisDrafts) {
    const next = after.siteDiagnosisDrafts.find(row => row.id === draft.id)
    valid(next && (draft.decision !== null ? equal(draft, next) : equal(draft, { ...next, decision: null, decidedAt: null })))
  }
  for (const work of before.works) {
    const next = after.works.find(row => row.id === work.id)
    valid(equal(next?.siteRule, work.siteRule) && (next?.origin === 'rule') === (work.origin === 'rule'))
  }
}
export function validateSiteSource(event) { validateSiteEvents([event]); return event }
