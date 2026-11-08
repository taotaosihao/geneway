import { messageId } from '../packages/agent-host/delivery.mjs'
import { isDeepStrictEqual } from 'node:util'
import { error, exact, binding, digest, key, sameBinding, text, assertSealed } from '../packages/agent-contracts/index.mjs'

export const emptyBudgetState = () => ({ budgetPolicies: [], budgetCommands: [], budgetAdjustments: [], budgetHolds: [] })
const valid = (condition, code = 'INVALID_REQUEST') => { if (!condition) throw error(code, '工作预算配置或事实无效') }
const integer = (value, min = 1, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
export function budgetLimits(value) {
  exact(value, ['maxModelRequests', 'maxReservedTokens', 'maxReservedCostMicros'])
  valid(integer(value.maxModelRequests, 1, 1000) && integer(value.maxReservedTokens) && integer(value.maxReservedCostMicros))
  return structuredClone(value)
}
export function budgetPolicy(value) {
  exact(value, ['workspaceId', 'coordinatorAgentId', 'enabled', 'accountingMode', 'limits', 'executionTimeoutMs', 'currency', 'estimator', 'modelPrices'])
  text(value.workspaceId); text(value.coordinatorAgentId); valid(typeof value.enabled === 'boolean' && value.accountingMode === 'conservative_estimate' && integer(value.executionTimeoutMs, 1000, 7 * 86400000) && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency))
  budgetLimits(value.limits); exact(value.estimator, ['version', 'inputBytesNumerator', 'inputBytesDenominator', 'fixedInputTokens'])
  valid(value.estimator.version === 1 && integer(value.estimator.inputBytesNumerator, 1, 1000000) && integer(value.estimator.inputBytesDenominator, 1, 1000000) && integer(value.estimator.fixedInputTokens, 0, 1000000))
  valid(Array.isArray(value.modelPrices) && value.modelPrices.length > 0 && value.modelPrices.length <= 32)
  const names = new Set()
  for (const price of value.modelPrices) {
    exact(price, ['provider', 'model', 'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens']); text(price.provider); text(price.model)
    valid(price.provider.length <= 200 && price.model.length <= 200 && integer(price.inputMicrosPerMillionTokens) && integer(price.outputMicrosPerMillionTokens))
    const id = JSON.stringify([price.provider, price.model]); valid(!names.has(id)); names.add(id)
  }
  return structuredClone(value)
}
export function initializeWorkBudget(state, policyId, workspaceId, coordinatorAgentId, acceptedAt) {
  if (policyId === undefined) return { limit: 12, reserved: 0, exhaustedAt: null }
  const policy = state.budgetPolicies.find(row => row.id === policyId && row.enabled && row.workspaceId === workspaceId && row.coordinatorAgentId === coordinatorAgentId)
  if (!policy) throw error('FORBIDDEN', '预算策略不属于当前工作负责人')
  return { version: 2, policySnapshot: structuredClone(policy), budgetRevision: 1, limits: structuredClone(policy.limits), executionDeadlineAt: new Date(Date.parse(acceptedAt) + policy.executionTimeoutMs).toISOString(), reserved: 0, reservedTokens: 0, reservedCostMicros: 0, overReservationBudgetRevision: null }
}
const number = value => { valid(value <= BigInt(Number.MAX_SAFE_INTEGER), 'BUDGET_ESTIMATE_INVALID'); return Number(value) }
const ceiling = (top, bottom) => (top + bottom - 1n) / bottom
export function estimateModelRequest(budget, route, body) {
  const price = budget.policySnapshot.modelPrices.find(row => row.provider === route.provider && row.model === route.model)
  if (!price) throw error('BUDGET_PRICE_MISSING', '预算策略未配置本次模型的价格')
  const estimator = budget.policySnapshot.estimator, input = ceiling(BigInt(Buffer.byteLength(JSON.stringify(body))) * BigInt(estimator.inputBytesNumerator), BigInt(estimator.inputBytesDenominator)) + BigInt(estimator.fixedInputTokens), output = BigInt(body.max_tokens)
  const cost = ceiling(input * BigInt(price.inputMicrosPerMillionTokens), 1000000n) + ceiling(output * BigInt(price.outputMicrosPerMillionTokens), 1000000n)
  return { forwardedBodyBytes: Buffer.byteLength(JSON.stringify(body)), modelPriceSnapshot: structuredClone(price), estimate: { inputTokens: number(input), outputTokens: number(output), totalTokens: number(input + output), costMicros: number(cost) } }
}
export function knownUsageCost(usage, price) {
  if (!usage || !integer(usage.prompt_tokens, 0) || !integer(usage.completion_tokens, 0)) return null
  const value = ceiling(BigInt(usage.prompt_tokens) * BigInt(price.inputMicrosPerMillionTokens), 1000000n) + ceiling(BigInt(usage.completion_tokens) * BigInt(price.outputMicrosPerMillionTokens), 1000000n)
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}
export function normalizeModelUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(field => Number.isSafeInteger(value[field]) && value[field] >= 0).map(field => [field, value[field]]))
  return Object.keys(usage).length ? usage : null
}
export function chargedModelTokens(row) {
  return [BigInt(row.estimate.totalTokens), BigInt(row.usage?.total_tokens ?? 0), BigInt(row.usage?.prompt_tokens ?? 0) + BigInt(row.usage?.completion_tokens ?? 0)].reduce((a, b) => a > b ? a : b)
}
export function committedBudget(state, work) {
  const rows = state.modelRequests.filter(row => row.work_id === work.id && row.accountingVersion === 2)
  return rows.reduce((sum, row) => ({ requests: sum.requests + 1, tokens: sum.tokens + chargedModelTokens(row), costMicros: sum.costMicros + BigInt(Math.max(row.estimate.costMicros, row.usageCostMicros ?? 0)) }), { requests: 0, tokens: 0n, costMicros: 0n })
}
export function assertWorkBudget(state, work, now = Date.now()) {
  const budget = work.modelRequestBudget
  if (budget?.version !== 2) return
  if (now >= Date.parse(budget.executionDeadlineAt)) throw error('EXECUTION_DEADLINE', '工作执行期限已到，请管理员调整预算后核对续行')
  if (work.status === 'waiting_budget' || state.budgetHolds.some(row => row.work_id === work.id && row.state === 'waiting') || budget.overReservationBudgetRevision !== null && budget.budgetRevision <= budget.overReservationBudgetRevision) throw error('WAITING_BUDGET', '工作预算不足，等待管理员调整')
}
export function reserveModelBudget(state, work, attempt, request, route, body, now) {
  const budget = work.modelRequestBudget, accounting = estimateModelRequest(budget, route, body), used = committedBudget(state, work), dimensions = []
  if (used.requests + 1 > budget.limits.maxModelRequests) dimensions.push('model_requests')
  if (used.tokens + BigInt(accounting.estimate.totalTokens) > BigInt(budget.limits.maxReservedTokens)) dimensions.push('reserved_tokens')
  if (used.costMicros + BigInt(accounting.estimate.costMicros) > BigInt(budget.limits.maxReservedCostMicros)) dimensions.push('reserved_cost')
  if (now >= Date.parse(budget.executionDeadlineAt)) dimensions.push('execution_deadline')
  if (budget.overReservationBudgetRevision !== null && budget.budgetRevision <= budget.overReservationBudgetRevision) dimensions.push('actual_over_reservation')
  if (state.modelRequests.some(row => row.work_id === work.id && row.accountingVersion === 2 && integer(row.usage?.prompt_tokens, 0) && integer(row.usage?.completion_tokens, 0) && row.usageCostMicros === null)) dimensions.push('usage_cost_overflow')
  if (dimensions.length) {
    const id = key('budget-hold', request.requestId), old = state.budgetHolds.find(row => row.id === id)
    if (old && old.bodyDigest !== digest(body)) throw error('IDEMPOTENCY_CONFLICT')
    const hold = old ?? { id, ...binding(attempt), instructionRevision: attempt.instruction_revision, requestId: request.requestId, bodyDigest: digest(body), budgetRevision: budget.budgetRevision, forwardedBodyBytes: accounting.forwardedBodyBytes, estimate: accounting.estimate, modelPriceSnapshot: accounting.modelPriceSnapshot, dimensions, createdAt: new Date(now).toISOString(), state: 'waiting', idleAt: null, resumeCommandId: null, resumedAt: null, resumeRequestId: null }
    if(!old&&request.purpose==='intent_review')hold.intentReview={commandId:request.intentReviewCommandId,intentFence:structuredClone(request.intentFence),inputMessageId:messageId(state.multisite.outbox.find(row=>row.id===request.intentReviewCommandId).command.input_id,attempt.attempt_id,attempt.session_id)}
    if (!old) state.budgetHolds.push(hold)
    work.status = 'waiting_budget'; attempt.status = 'waiting_budget'
    return { hold }
  }
  budget.reserved++; budget.reservedTokens += accounting.estimate.totalTokens; budget.reservedCostMicros += accounting.estimate.costMicros; attempt.modelRequestsReserved++
  valid(integer(budget.reservedTokens, 0) && integer(budget.reservedCostMicros, 0), 'BUDGET_ESTIMATE_INVALID')
  return { accounting: { accountingVersion: 2, budgetRevisionAtReservation: budget.budgetRevision, ...accounting, usageCostMicros: null, overReservation: false } }
}
export function settleModelAccounting(state, row) {
  if (row.accountingVersion !== 2) return
  row.usageCostMicros = knownUsageCost(row.usage, row.modelPriceSnapshot)
  row.overReservation = (row.usage?.total_tokens ?? 0) > row.estimate.totalTokens || (row.usage?.prompt_tokens ?? 0) > row.estimate.inputTokens || (row.usage?.completion_tokens ?? 0) > row.estimate.outputTokens || row.usageCostMicros !== null && row.usageCostMicros > row.estimate.costMicros
  if (row.overReservation) {
    const work = state.works.find(work => work.id === row.work_id)
    work.modelRequestBudget.overReservationBudgetRevision = work.modelRequestBudget.budgetRevision
    if (!['completed', 'cancelled', 'stopping', 'interrupted', 'failed'].includes(work.status)) work.status = 'waiting_budget'
  }
}
export function validateBudgetState(state) {
  for (const name of Object.keys(emptyBudgetState())) valid(Array.isArray(state[name]) && state[name].length <= 10000 && new Set(state[name].map(row => row.id)).size === state[name].length, 'INVALID_STATE')
  for (const row of state.budgetPolicies) { const { id, revision, ...configuration } = row; text(id); valid(id.length <= 200 && integer(revision), 'INVALID_STATE'); budgetPolicy(configuration) }
  for (const work of state.works.filter(row => row.modelRequestBudget?.version === 2)) {
    const budget = work.modelRequestBudget, { id, revision, ...policy } = budget.policySnapshot; text(id); valid(integer(revision)); budgetPolicy(policy); budgetLimits(budget.limits)
    valid(budget.policySnapshot.workspaceId === work.workspaceId && budget.policySnapshot.coordinatorAgentId === work.employeeId && integer(budget.budgetRevision) && new Date(budget.executionDeadlineAt).toISOString() === budget.executionDeadlineAt, 'INVALID_STATE')
    const rows = state.modelRequests.filter(row => row.work_id === work.id)
    valid(rows.every(row => row.accountingVersion === 2) && budget.reserved === rows.length && budget.reservedTokens === rows.reduce((sum, row) => sum + row.estimate.totalTokens, 0) && budget.reservedCostMicros === rows.reduce((sum, row) => sum + row.estimate.costMicros, 0), 'INVALID_STATE')
  }
  for (const row of state.budgetHolds) valid(state.works.some(work => work.id === row.work_id && work.modelRequestBudget?.version === 2) && state.multisite.attempts.some(attempt => sameBinding(attempt, row)) && !state.modelRequests.some(request => request.id === row.requestId) && /^[a-f0-9]{64}$/.test(row.bodyDigest) && ['waiting', 'resume_queued', 'resumed', 'cancelled'].includes(row.state), 'INVALID_STATE')
  for(const hold of state.budgetHolds.filter(row=>row.intentReview)){const descriptor=hold.intentReview,command=state.multisite.outbox.find(row=>row.id===descriptor.commandId)?.command;exact(descriptor,['commandId','intentFence','inputMessageId']);valid(command?.operation==='intent_review'&&sameBinding({...binding(command),session_id:command.session_id??`geneway-${command.launch_id}`},hold)&&isDeepStrictEqual(command.parameters.intentFence,descriptor.intentFence)&&descriptor.inputMessageId===messageId(command.input_id,hold.attempt_id,hold.session_id),'INVALID_STATE')}
  return state
}
export function assertBudgetImmutable(before, after) {
  for (const name of ['budgetCommands', 'budgetAdjustments']) valid(isDeepStrictEqual(before[name], after[name].slice(0, before[name].length)), 'INVALID_STATE')
  for (const work of before.works.filter(row => row.modelRequestBudget?.version === 2)) {
    const old = work.modelRequestBudget, next = after.works.find(row => row.id === work.id)?.modelRequestBudget
    valid(next && isDeepStrictEqual(old.policySnapshot, next.policySnapshot) && next.budgetRevision >= old.budgetRevision && next.reserved >= old.reserved && next.reservedTokens >= old.reservedTokens && next.reservedCostMicros >= old.reservedCostMicros, 'INVALID_STATE')
    if (next.budgetRevision === old.budgetRevision) valid(isDeepStrictEqual(old.limits, next.limits) && old.executionDeadlineAt === next.executionDeadlineAt, 'INVALID_STATE')
  }
  for (const row of before.budgetHolds) { const next = after.budgetHolds.find(item => item.id === row.id), fixed = value => value && { ...value, state: undefined, idleAt: undefined, resumeCommandId: undefined, resumedAt: undefined, resumeRequestId: undefined, resumeAdjustmentId: undefined, resumeBudgetRevision: undefined, resumeMessageId: undefined, cancelledAt: undefined, cancelledReason: undefined }; valid(isDeepStrictEqual(fixed(row), fixed(next)), 'INVALID_STATE'); for (const field of ['idleAt', 'resumeCommandId', 'resumedAt', 'resumeRequestId', 'resumeAdjustmentId', 'resumeBudgetRevision', 'resumeMessageId', 'cancelledAt', 'cancelledReason']) if (row[field]) valid(row[field] === next[field], 'INVALID_STATE') }
}

export function assertModelAccounting(state, row) {
  const work = state.works.find(work => work.id === row.work_id), budget = work?.modelRequestBudget, attempt = state.multisite.attempts.find(attempt => attempt.attempt_id === row.attempt_id)
  valid(budget?.version === 2 && row.accountingVersion === 2 && integer(row.budgetRevisionAtReservation) && row.budgetRevisionAtReservation <= budget.budgetRevision && integer(row.forwardedBodyBytes), 'INVALID_STATE')
  const price = budget.policySnapshot.modelPrices.find(price => price.provider === attempt.modelSnapshot.provider && price.model === attempt.modelSnapshot.model)
  valid(price && isDeepStrictEqual(price, row.modelPriceSnapshot), 'INVALID_STATE')
  exact(row.estimate, ['inputTokens', 'outputTokens', 'totalTokens', 'costMicros'])
  const estimator = budget.policySnapshot.estimator, input = number(ceiling(BigInt(row.forwardedBodyBytes) * BigInt(estimator.inputBytesNumerator), BigInt(estimator.inputBytesDenominator)) + BigInt(estimator.fixedInputTokens))
  valid(Object.values(row.estimate).every(value => integer(value, 0)) && integer(row.estimate.outputTokens, 1, attempt.modelSnapshot.parameters.maxOutputTokens) && row.estimate.inputTokens === input && row.estimate.totalTokens === row.estimate.inputTokens + row.estimate.outputTokens, 'INVALID_STATE')
  const cost = number(ceiling(BigInt(input) * BigInt(price.inputMicrosPerMillionTokens), 1000000n) + ceiling(BigInt(row.estimate.outputTokens) * BigInt(price.outputMicrosPerMillionTokens), 1000000n))
  valid(row.estimate.costMicros === cost && row.usageCostMicros === knownUsageCost(row.usage, price) && typeof row.overReservation === 'boolean', 'INVALID_STATE')
}

function controlProof(state, command, now, receipt) {
  assertSealed(command)
  const original = state.multisite.outbox.find(row => row.id === command.command_id)?.command
  valid(original && isDeepStrictEqual(original, command), 'FORBIDDEN')
  const resume = command.operation === 'wake' && command.parameters.messages?.[0]?.kind === 'budget_resume', id = resume ? command.parameters.waitRelease?.id : command.parameters.budgetHold?.id
  const hold = state.budgetHolds.find(row => row.id === id), work = state.works.find(row => row.id === command.work_id)
  valid(hold && sameBinding(hold, command) && work?.modelRequestBudget.version === 2 && !state.modelRequests.some(row => row.id === hold.requestId), 'FORBIDDEN')
  if (!resume) valid(command.operation === 'budget_wait' && command.input_id === hold.id && command.instruction_revision === hold.instructionRevision && isDeepStrictEqual(command.parameters.budgetHold, { id: hold.id, requestId: hold.requestId, bodyDigest: hold.bodyDigest, budgetRevision: hold.budgetRevision }), 'FORBIDDEN')
  else {
    const adjustment = state.budgetAdjustments.find(row => row.id === hold.resumeAdjustmentId), message = state.multisite.messages.find(row => row.id === hold.resumeMessageId)
    valid(hold.idleAt && adjustment?.workId === work.id && adjustment.budgetRevision > hold.budgetRevision && hold.resumeCommandId === command.command_id && command.parameters.messages.length === 1 && command.parameters.waitRelease.kind === 'budget' && command.parameters.messages[0].id === message?.id && message?.kind === 'budget_resume' && message.targetAttemptId === hold.attempt_id && command.input_id === key('budget-resume-delivery', message.id) && command.instruction_revision === hold.instructionRevision, 'FORBIDDEN')
    if (receipt) valid(command.instruction_revision <= work.instructionRevision && ['resume_queued', 'resumed', 'cancelled'].includes(hold.state), 'FORBIDDEN')
    else valid(hold.state === 'resume_queued' && command.instruction_revision === work.instructionRevision && Date.parse(work.modelRequestBudget.executionDeadlineAt) > now && !state.modelRequests.some(row => row.work_id === work.id && row.outcome === 'unknown'), 'FORBIDDEN')
  }
  return { hold, work }
}

export const budgetControlProof = (state, command, now = Date.now()) => controlProof(state, command, now, false)
export const budgetReceiptProof = (state, command, now = Date.now()) => controlProof(state, command, now, true)

export function budgetTokenExpiry(work, expiresAt, now = Date.now()) {
  if (work?.modelRequestBudget?.version !== 2) return expiresAt
  const deadline = Date.parse(work.modelRequestBudget.executionDeadlineAt)
  if (now >= deadline) throw error('EXECUTION_DEADLINE', '工作执行期限已到')
  return Math.min(expiresAt, deadline)
}
