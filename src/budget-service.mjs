import { budgetLimits, budgetPolicy } from './work-budget.mjs'
import { digest, error, exact, key, text } from '../packages/agent-contracts/index.mjs'

export function createBudgetService({ store, workspaceId = 'local', clock = () => Date.now(), onAdjusted = () => {} }) {
  const admin = (state, actor) => { const member = state.members.find(row => row.id === actor?.id && row.enabled && row.role === 'admin'); if (!member) throw error('FORBIDDEN', '仅管理员可调整工作预算'); return member }
  async function command(actor, operation, targetId, parameters, apply) {
    let reply
    await store.update(state => {
      const member = admin(state, actor), id = key('budget', workspaceId, member.id, text(parameters.clientRequestId)), payloadDigest = digest({ operation, targetId, parameters }), old = state.budgetCommands.find(row => row.id === id)
      if (old) { if (old.digest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); reply = old.reply; return state }
      reply = apply(state, member, id)
      state.budgetCommands.push({ id, actorId: member.id, workspaceId, digest: payloadDigest, reply: structuredClone(reply), acceptedAt: new Date(clock()).toISOString() }); return state
    })
    return reply
  }
  return {
    async directory(actor) { const state = await store.read(); admin(state, actor); return { policies: state.budgetPolicies.filter(row => row.workspaceId === workspaceId) } },
    async putPolicy(actor, policyId, parameters) {
      exact(parameters, ['clientRequestId', 'expectedRevision', 'workspaceId', 'coordinatorAgentId', 'enabled', 'accountingMode', 'limits', 'executionTimeoutMs', 'currency', 'estimator', 'modelPrices'])
      const { clientRequestId, expectedRevision, ...value } = parameters, configuration = budgetPolicy(value)
      if (typeof policyId !== 'string' || !policyId.trim() || policyId.length > 200) throw error('INVALID_REQUEST')
      return command(actor, 'policy', policyId, parameters, state => {
        if (configuration.workspaceId !== workspaceId || !state.employees.some(row => row.id === configuration.coordinatorAgentId && row.enabled)) throw error('FORBIDDEN')
        const old = state.budgetPolicies.find(row => row.id === policyId)
        if ((old?.revision ?? null) !== (expectedRevision ?? null)) throw error('REVISION_CONFLICT')
        const policy = { id: policyId, ...configuration, revision: (old?.revision ?? 0) + 1 }
        if (old) state.budgetPolicies[state.budgetPolicies.indexOf(old)] = policy; else state.budgetPolicies.push(policy)
        return { policy }
      })
    },
    async adjustWork(actor, workId, parameters) {
      exact(parameters, ['clientRequestId', 'expectedRevision', 'reason', 'limits', 'executionDeadlineAt'])
      const limits = budgetLimits(parameters.limits), reason = text(parameters.reason), deadline = Date.parse(parameters.executionDeadlineAt)
      if (reason.length > 2000 || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== parameters.executionDeadlineAt ) throw error('INVALID_REQUEST', '预算调整原因或执行期限无效')
      let fresh = false
      const reply = await command(actor, 'adjust', workId, parameters, (state, member, id) => {
        const work = state.works.find(row => row.id === workId && row.workType === 'multisite' && row.workspaceId === workspaceId), budget = work?.modelRequestBudget
        if (budget?.version !== 2) throw error('INVALID_STATE', '旧工作不支持预算续行，请保留历史并新建工作')
        if (['completed', 'cancelled', 'stopping', 'failed', 'interrupted'].includes(work.status)) throw error('INVALID_STATE', '已停止、中断或终态工作不能由预算调整恢复')
        if (budget.budgetRevision !== parameters.expectedRevision) throw error('REVISION_CONFLICT')
        if (deadline <= clock() || deadline > clock() + 7 * 86400000) throw error('INVALID_REQUEST', '预算执行期限无效')
        fresh = true
        const before = { limits: structuredClone(budget.limits), executionDeadlineAt: budget.executionDeadlineAt }
        budget.budgetRevision++; budget.limits = limits; budget.executionDeadlineAt = parameters.executionDeadlineAt
        state.budgetAdjustments.push({ id, workId, actorId: member.id, reason, previousBudgetRevision: budget.budgetRevision - 1, budgetRevision: budget.budgetRevision, before, after: { limits: structuredClone(limits), executionDeadlineAt: budget.executionDeadlineAt }, acceptedAt: new Date(clock()).toISOString() })
        return { workId, budgetRevision: budget.budgetRevision, status: work.status }
      })
      if (fresh) await onAdjusted(workId)
      return reply
    },
  }
}
