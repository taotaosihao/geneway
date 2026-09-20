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
      agent.ctx.on('agent/request', async (_request, next) => {
        try { await authorize(filePath) }
        catch { throw Object.assign(new Error('执行授权已失效'), { code: 'FORBIDDEN' }) }
        return next()
      })
    })
    return ctx
  }
  return install
}
