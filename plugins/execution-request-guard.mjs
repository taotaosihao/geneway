import { modelRouteSnapshot, modelAgentOptions } from '../src/model-route.mjs'
import { authorizeExecutionRequestFile } from '../src/execution-grant.mjs'

export const name = 'geneway-execution-request-guard'

export function apply(ctx) {
  return createExecutionRequestGuard()(ctx)
}

export function createExecutionRequestGuard({ filePath = process.env.GENEWAY_DSH_REQUEST_GRANT_FILE, authorize = authorizeExecutionRequestFile } = {}) {
  const install = ctx => {
    if (!ctx || typeof ctx.on !== 'function') throw new TypeError('execution request guard 需要 runtime context')
    ctx.on('agent/created', ({ agent } = {}) => {
      if (!agent?.ctx || typeof agent.ctx.on !== 'function') return
      if (agent.session?.header?.origin === 'subagent') return
      let executionId, requestCount = 0
      agent.ctx.on('agent/request', async (_request, next) => {
        let authorization
        try { authorization = await authorize(filePath) }
        catch { throw Object.assign(new Error('执行授权已失效'), { code: 'FORBIDDEN' }) }
        const config = await next()
        if (authorization?.grant) {
          const { grant } = authorization
          const snapshot = grant.modelSnapshot ?? modelRouteSnapshot(authorization.authorization.route)
          const expected = modelAgentOptions(snapshot)
          if (config.provider !== expected.provider || config.model !== expected.model || config.maxTokens !== expected.maxTokens) throw Object.assign(new Error('执行授权已失效'), { code: 'FORBIDDEN' })
          if (executionId !== grant.executionId) { executionId = grant.executionId; requestCount = 0 }
          if (requestCount >= 4) throw Object.assign(new Error('本次模型请求预算已耗尽'), { code: 'BUDGET_EXHAUSTED' })
          requestCount += 1
        }
        return config
      })
    })
    return ctx
  }
  return install
}
