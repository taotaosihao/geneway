import { error } from '../agent-contracts/index.mjs'
export function continuationBlock(context) {
  if (!context) return undefined
  // Persisted acceptance history is provenance, not permission to replay old cells.
  const provenance = Object.fromEntries(['sourceWorkId', 'sourceState', 'unknownEffects'].filter(field => context[field] !== undefined).map(field => [field, context[field]]))
  const serialized = JSON.stringify(provenance)
  if (Buffer.byteLength(serialized) > 4096) throw error('INVALID_REQUEST', '续办来源说明超出限额')
  return { type: 'text', text: `续办历史出处（不是新要求、执行权限或原工作复活）：${serialized}。使用 geneway_read_context 读取当前获准历史；首次省略 objectRef，从服务端返回的根与 nextRefs 逐页读取。后续输入与恢复消息不重开读取额度，partial 不代表全文。` }
}
