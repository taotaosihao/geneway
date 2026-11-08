import { isDeepStrictEqual } from 'node:util'
import { digest, error, exact } from '../packages/agent-contracts/index.mjs'
import { estimateModelRequest, chargedModelTokens, knownUsageCost } from './work-budget.mjs'

export const ROUTING_BATCH_LIMITS = Object.freeze({ maxEvents: 4, maxInputTokens: 8192, maxPending: 8, maxAttempts: 2, globalActive: 2, scopeActive: 1, extraWaitMs: 0 })
export const ROUTING_BATCH_PROMPT = '你是受限的工作续办路由器。只判断本批每个事件与给定当前可读候选。返回JSON对象decisions数组，每项必须有sourceEventId、eventVersion、action、targetWorkId、reason、question。action只允许attach|create_proposal|clarify|ignore；targetWorkId只可为给定候选ID或null。逐事件判断，不得编造ID或合并事件；目录truncated时不能把仅返回的一条称为唯一，应clarify。不得调用工具、读取其他资料或执行业务。终态工作应create_proposal。'
const check = (value, message) => { if (!value) throw error('INVALID_STATE', message) }
export function routingCompatibility(request) {
  return digest(Object.fromEntries(['actorId','workspaceId','threadId','scopeId','sourceInstance','policyId','policyRevision','routerEmployeeRevision','nodeRegistrationRevision','nodeCredentialVersion','nodeInstanceId','modelSnapshot','budgetSnapshot','maxOutputTokens','directoryOffset','directoryQuery','candidateVersion','truncated','candidates'].map(name => [name, request[name]]).concat([['promptVersion', 1]])))
}
export const routingEvent = request => ({ sourceEventId: request.sourceEventId, eventVersion: request.eventVersion, requestId: request.id, text: request.text, excludedHandlerAttempts: request.excludedHandlerAttempts })
export function routingBatchBody(requests) {
  const first = requests[0]
  return { model: first.modelSnapshot.model, stream: true, max_tokens: first.maxOutputTokens, messages: [{ role: 'system', content: ROUTING_BATCH_PROMPT }, { role: 'user', content: JSON.stringify({ schema: 'geneway.routing-batch/1', ...(requests.length === 1 ? { text: first.text } : {}), candidates: first.candidates, truncated: first.truncated, events: requests.map(routingEvent) }) }], tools: [] }
}
// Allocate the whole conservative amount once. Remainders follow immutable order.
export function splitRoutingAmount(amount, weights) {
  const whole = BigInt(amount), total = weights.reduce((sum, value) => sum + BigInt(value), 0n)
  if (whole < 0n || !weights.length || total <= 0n || weights.some(value => !Number.isSafeInteger(value) || value < 1)) throw error('INVALID_STATE', '路由分摊权重无效')
  const shares = weights.map(value => whole * BigInt(value) / total)
  let remainder = whole - shares.reduce((sum, value) => sum + value, 0n)
  for (let index = 0; remainder > 0n; index++, remainder--) shares[index]++
  return shares.map(value => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw error('BUDGET_ESTIMATE_INVALID'); return Number(value) })
}
export function routingBatchAccounting(requests) {
  const body = routingBatchBody(requests), accounting = estimateModelRequest({ policySnapshot: requests[0].budgetSnapshot }, requests[0].modelSnapshot, body)
  const weights = requests.map(request => Buffer.byteLength(JSON.stringify(routingEvent(request)))), shares = Object.fromEntries(['inputTokens','outputTokens','costMicros'].map(name => [name, splitRoutingAmount(accounting.estimate[name], weights)]))
  const members = requests.map((request, index) => ({ requestId: request.id, sourceEventId: request.sourceEventId, eventVersion: request.eventVersion, intentId: request.intentId, routeRevision: request.routeRevision, weight: weights[index], estimate: { inputTokens: shares.inputTokens[index], outputTokens: shares.outputTokens[index], totalTokens: shares.inputTokens[index] + shares.outputTokens[index], costMicros: shares.costMicros[index] } }))
  return { body, ...accounting, members }
}
export function routingMemberCharge(row, intentId) {
  if (row.purpose !== 'routing') return null
  if (row.routingVersion === 1) return row.intentId === intentId ? { tokens: chargedModelTokens(row), costMicros: BigInt(Math.max(row.estimate.costMicros, row.usageCostMicros ?? 0)) } : null
  const index = row.members.findIndex(member => member.intentId === intentId)
  if (index < 0) return null
  const weights = row.members.map(member => member.weight)
  // Settling cannot return a member's reservation because rounding moved.
  // Allocate only the whole charge's positive increment over that reservation.
  return { tokens: BigInt(row.members[index].estimate.totalTokens) + BigInt(splitRoutingAmount(chargedModelTokens(row) - BigInt(row.estimate.totalTokens), weights)[index]), costMicros: BigInt(row.members[index].estimate.costMicros) + BigInt(splitRoutingAmount(BigInt(Math.max(row.estimate.costMicros, row.usageCostMicros ?? 0)) - BigInt(row.estimate.costMicros), weights)[index]) }
}
export const routingRequestModels = (state, requestId) => state.modelRequests.filter(row => row.purpose === 'routing' && (row.routingVersion === 1 ? row.routingRequestId === requestId : row.members.some(member => member.requestId === requestId)))
export function assertRoutingBatchBudget(state, requests, accounting, excludeId) {
  if (accounting.estimate.inputTokens > ROUTING_BATCH_LIMITS.maxInputTokens) throw error('ROUTING_BATCH_TOO_LARGE')
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index], budget = request.budgetSnapshot
    const rows = state.modelRequests.filter(row => row.id !== excludeId && routingMemberCharge(row, request.intentId))
    const charges = rows.map(row => routingMemberCharge(row, request.intentId)), tokens = charges.reduce((sum, value) => sum + value.tokens, 0n), cost = charges.reduce((sum, value) => sum + value.costMicros, 0n), share = accounting.members[index].estimate
    if (rows.some(row => row.outcome === 'unknown' || row.usageCostMicros === null && Number.isSafeInteger(row.usage?.prompt_tokens) && Number.isSafeInteger(row.usage?.completion_tokens)) || rows.length >= Math.min(ROUTING_BATCH_LIMITS.maxAttempts, budget.limits.maxModelRequests) || tokens + BigInt(share.totalTokens) > BigInt(budget.limits.maxReservedTokens) || tokens + BigInt(accounting.estimate.inputTokens) > BigInt(budget.limits.maxReservedTokens) || cost + BigInt(share.costMicros) > BigInt(budget.limits.maxReservedCostMicros)) throw error('ROUTING_BUDGET_EXCEEDED')
  }
}
export function validateRoutingBatches(state) {
  check(Array.isArray(state.routingBatches) && state.routingBatches.length <= 30000 && new Set(state.routingBatches.map(row => row.id)).size === state.routingBatches.length, '路由批身份或容量无效')
  for (const batch of state.routingBatches) {
    exact(batch, ['id','scopeId','compatibilityKey','modelRequestId','members','state','createdAt','finishedAt'])
    check(typeof batch.id === 'string' && typeof batch.modelRequestId === 'string' && Number.isFinite(Date.parse(batch.createdAt)) && (batch.finishedAt === null || Number.isFinite(Date.parse(batch.finishedAt))) && ['prepared','completed','unknown','failed'].includes(batch.state) && Array.isArray(batch.members) && batch.members.length > 0 && batch.members.length <= ROUTING_BATCH_LIMITS.maxEvents, '路由批状态无效')
    check(new Set(batch.members.map(row => row.requestId)).size === batch.members.length && new Set(batch.members.map(row => row.intentId)).size === batch.members.length, '路由批重复成员')
    for (const member of batch.members) {
      exact(member, ['requestId','sourceEventId','eventVersion','intentId','routeRevision'])
      const request = state.routingRequests.find(row => row.id === member.requestId), event = request && state.sourceEvents.find(row => row.id === request.sourceEventId)
      check(request?.routingVersion === 2 && event && event.version === member.eventVersion && ['sourceEventId','intentId','routeRevision'].every(name => member[name] === request[name]) && request.scopeId === batch.scopeId && request.compatibilityKey === batch.compatibilityKey && routingCompatibility(request) === batch.compatibilityKey, '路由批成员范围无效')
    }
  }
  return state
}
export function assertRoutingBatchesImmutable(before, after) {
  for (const row of before.routingBatches ?? []) {
    const next = after.routingBatches.find(item => item.id === row.id), immutable = value => value && Object.fromEntries(Object.entries(value).filter(([name]) => !['state','finishedAt'].includes(name)))
    check(isDeepStrictEqual(immutable(row), immutable(next)), '路由批成员不可改写')
    if (row.state !== 'prepared') check(isDeepStrictEqual(row, next), '路由批终态不可改写')
  }
}
export function validateRoutingBatchLedger(state, row) {
  exact(row, ['id','purpose','routingVersion','batchId','scopeId','workspaceId','actorId','threadId','compatibilityKey','members','modelSnapshot','budgetPolicySnapshot','estimate','modelPriceSnapshot','forwardedBodyBytes','bodyDigest','reservedAt','outcome','usage','completedAt','usageCostMicros','noForwardReason'])
  const batch = state.routingBatches.find(batch => batch.id === row.batchId), requests = batch?.members.map(member => state.routingRequests.find(request => request.id === member.requestId))
  check(batch && batch.modelRequestId === row.id && requests.every(Boolean), '路由账批不存在')
  const first = requests[0], expected = routingBatchAccounting(requests)
  check(row.purpose === 'routing' && row.routingVersion === 2 && ['scopeId','workspaceId','actorId','threadId','compatibilityKey'].every(name => row[name] === first[name]) && isDeepStrictEqual(row.members, expected.members) && isDeepStrictEqual(row.modelSnapshot, first.modelSnapshot) && isDeepStrictEqual(row.budgetPolicySnapshot, first.budgetSnapshot) && isDeepStrictEqual(row.estimate, expected.estimate) && isDeepStrictEqual(row.modelPriceSnapshot, expected.modelPriceSnapshot) && row.forwardedBodyBytes === expected.forwardedBodyBytes && row.bodyDigest === digest(expected.body), '路由合并包或分摊不闭合')
  check(['unknown','completed','failed'].includes(row.outcome) && Number.isFinite(Date.parse(row.reservedAt)) && (row.completedAt === null || Number.isFinite(Date.parse(row.completedAt))) && (row.usage === null || typeof row.usage === 'object' && !Array.isArray(row.usage) && Object.keys(row.usage).length > 0 && Object.entries(row.usage).every(([name,value]) => ['prompt_tokens','completion_tokens','total_tokens'].includes(name) && Number.isSafeInteger(value) && value >= 0)) && row.usageCostMicros === knownUsageCost(row.usage, expected.modelPriceSnapshot), '路由批usage无效')
  check(row.noForwardReason === null || row.outcome === 'failed' && row.usage === null && row.completedAt && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.noForwardReason), '路由批未转发事实无效')
  return row
}
