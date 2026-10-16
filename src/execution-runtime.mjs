export const TOP_LEVEL_LIMIT = 4
export const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
const ACTIVE = new Set(['accepted', 'running', 'cancel_requested'])

export function activeTopLevelCount(state) {
  return state.works.reduce((count, work) => count + (work.rootWorkId ? 0 : work.executions.filter(execution => ACTIVE.has(execution.status) || execution.closePending === true).length), 0)
    + (state.conversations ?? []).reduce((count, conversation) => count + conversation.turns.filter(turn => ACTIVE.has(turn.status)).length, 0)
}

export function assertExecutionCapacity(state) {
  if (activeTopLevelCount(state) >= TOP_LEVEL_LIMIT) throw Object.assign(new Error('当前执行已满，请稍后重试'), { code: 'BUSY' })
}

export function unknownUsage() { return Object.fromEntries(USAGE_KEYS.map(key => [key, null])) }

export function nativeUsage(events, sessionId = '') {
  const total = unknownUsage(), seen = new Set(), unknown = new Set()
  for (const event of events ?? []) {
    const identity = `${event.sessionId ?? sessionId}:${event.seq}`
    if (!['assistant/message', 'assistant/attempt'].includes(event.type) || seen.has(identity)) continue
    seen.add(identity)
    const chunks = (event.data.stream ?? []).filter(item => item.type === 'chunk').map(item => item.chunk)
    const usage = event.data.usage ?? chunks.findLast(chunk => chunk.type === 'usage')?.usage
    // A failed request's synthetic empty usage cannot make a partial total look complete.
    const reported = usage && Object.values(usage).some(value => Number.isFinite(value) && value > 0)
    for (const key of USAGE_KEYS) {
      if (!reported || !Number.isFinite(usage[key]) || usage[key] < 0) { unknown.add(key); total[key] = null }
      else if (!unknown.has(key)) total[key] = (total[key] ?? 0) + usage[key]
    }
  }
  return total
}

export function nativeRequestCount(events, sessionId = '') {
  return new Set((events ?? []).filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type)).map(event => `${event.sessionId ?? sessionId}:${event.seq}`)).size
}

export function newExecutionRuntime(snapshot, requestLimit, startedAt = null) {
  return { modelRouteId: snapshot.modelRouteId, provider: snapshot.provider, model: snapshot.model,
    parameters: { ...snapshot.parameters }, requestCount: 0, requestLimit, startedAt, completedAt: null, durationMs: null,
    usage: unknownUsage(), terminationReason: null }
}

export function finishExecutionRuntime(runtime, { events, requestCount, usage, completedAt, terminationReason = null } = {}) {
  if (!runtime) return undefined
  return { ...runtime, requestCount: requestCount ?? (events ? nativeRequestCount(events) : runtime.requestCount),
    usage: usage ?? (events ? nativeUsage(events) : runtime.usage), completedAt,
    durationMs: runtime.startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(runtime.startedAt)) : null, terminationReason }
}

export function validateExecutionRuntime(value) {
  const keys = ['modelRouteId', 'provider', 'model', 'parameters', 'requestCount', 'requestLimit', 'startedAt', 'completedAt', 'durationMs', 'usage', 'terminationReason']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error('执行运行反馈无效')
  for (const key of ['modelRouteId', 'provider', 'model']) if (typeof value[key] !== 'string' || !value[key]) throw new Error('执行模型身份无效')
  if (!value.parameters || Object.keys(value.parameters).length !== 1 || !Number.isSafeInteger(value.parameters.maxOutputTokens)
    || value.parameters.maxOutputTokens < 1 || value.parameters.maxOutputTokens > 4096) throw new Error('执行输出上限无效')
  if (![4, 6, 12].includes(value.requestLimit) || value.requestCount !== null && (!Number.isSafeInteger(value.requestCount) || value.requestCount < 0 || value.requestCount > value.requestLimit)) throw new Error('执行请求预算无效')
  for (const key of ['startedAt', 'completedAt']) if (value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])))) throw new Error('执行运行时间无效')
  if (value.durationMs !== null && (!Number.isFinite(value.durationMs) || value.durationMs < 0)) throw new Error('执行耗时无效')
  if (!value.usage || USAGE_KEYS.some(key => !Object.hasOwn(value.usage, key)) || Object.keys(value.usage).some(key => !USAGE_KEYS.includes(key))) throw new Error('执行用量无效')
  for (const count of Object.values(value.usage)) if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error('执行用量无效')
  if (value.terminationReason !== null && typeof value.terminationReason !== 'string') throw new Error('执行终止原因无效')
  return value
}
