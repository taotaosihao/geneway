import { isDeepStrictEqual } from 'node:util'
import { binding, digest, error, key, sameBinding } from '../packages/agent-contracts/index.mjs'
import { CONTEXT_READ_LIMITS as L, contextObjectRef } from '../packages/agent-contracts/context-read.mjs'
const check = (value, label) => { if (!value) throw error('INVALID_STATE', '资料读取事实无效：' + label) }
export const emptyContextReadState = () => ({ contextReadInstances: [], contextReadWindows: [], contextReads: [] })
export function openContextInstance(state, { continuationId, actorId, threadId, readerBinding, sourceEventId, at }) {
  const id = key('context-instance', continuationId, actorId, binding(readerBinding)), old = state.contextReadInstances.find(row => row.id === id)
  if (old) return old
  const instance = { id, continuationId, actorId, threadId, readerBinding: binding(readerBinding), sourceEventId, limits: { ...L }, createdAt: at }
  state.contextReadInstances.push(instance)
  state.contextReadWindows.push({ id: key('context-window', id, sourceEventId), contextInstanceId: id, sourceEventId, parentReadId: null, createdAt: at, deliveryCommandId: null, deliveryCommandIds: [], deliveredAt: null })
  return instance
}
export function currentContextWindow(state, instanceId) { return state.contextReadWindows.filter(row => row.contextInstanceId === instanceId).at(-1) }
export function contextResumePosition(state, instance, readId) {
  const read = state.contextReads.find(row => row.id === readId && row.contextInstanceId === instance.id)
  if (!read) return null
  const window = currentContextWindow(state, instance.id), frontier = window?.blockedFrontier
  const blocked = frontier && !state.contextReads.some(row => row.contextInstanceId === instance.id && isDeepStrictEqual(row.objectRef, frontier.objectRef) && row.view === frontier.view) ? frontier : null
  if (read.page.partial && read.page.nextIndex < read.page.totalItems) {
    if (state.contextReads.some(row => row.contextInstanceId === instance.id && isDeepStrictEqual(row.objectRef, read.objectRef) && row.view === read.view && row.fromIndex <= read.page.nextIndex && row.page.nextIndex > read.page.nextIndex)) return null
    return { parentReadId: read.id, objectRef: read.objectRef, view: read.view, fromIndex: read.page.nextIndex, path: read.path }
  }
  if (blocked && blocked.parentReadId !== read.id) return null
  if (!blocked && contextWindowUsage(state, window.id, read.objectRef).reads < instance.limits.maxReads) return null
  const next = read.page.nextRefs.find(next => (!blocked || isDeepStrictEqual(next.objectRef, blocked.objectRef) && next.view === blocked.view) && !state.contextReads.some(row => row.contextInstanceId === instance.id && isDeepStrictEqual(row.objectRef, next.objectRef) && row.view === next.view))
  if (next && !blocked && state.contextReads.findLast(row => row.contextInstanceId === instance.id && row.page.nextRefs.some(edge => isDeepStrictEqual(edge.objectRef, next.objectRef) && edge.view === next.view))?.id !== read.id) return null
  const path = next && [...read.path, contextObjectKey(next.objectRef)]
  return path && path.length <= instance.limits.maxHops + 1 && new Set(path).size === path.length ? { parentReadId: read.id, objectRef: next.objectRef, view: next.view, fromIndex: 0, path } : null
}
export function continueContextWindow(state, instance, readId, sourceEventId, at) {
  const read = state.contextReads.find(row => row.id === readId && row.contextInstanceId === instance.id)
  const old = state.contextReadWindows.find(row => row.contextInstanceId === instance.id && row.sourceEventId === sourceEventId)
  if (old) return old
  const source = currentContextWindow(state, instance.id)
  if (source.parentReadId && !state.contextReads.some(row => row.windowId === source.id)) {
    if (source.parentReadId === readId) return source
    throw error('CONTEXT_READ_UNAVAILABLE', '已批准窗口须先从原位置继续')
  }
  const position = read && contextResumePosition(state, instance, readId)
  if (!position) throw error('CONTEXT_READ_UNAVAILABLE', '当前页没有可继续的未读位置')
  const window = { id: key('context-window', instance.id, sourceEventId), contextInstanceId: instance.id, sourceEventId, sourceWindowId: source.id, parentReadId: readId, continuationTarget: structuredClone(position), modelRequestCountAtApproval: state.modelRequests.length, approvalIntent: read.purpose === 'intent_review' ? { intentId: read.intentFence.intentId, routeRevision: read.intentFence.routeRevision } : null, createdAt: at, deliveryCommandId: null, deliveryCommandIds: [], deliveredAt: null }
  state.contextReadWindows.push(window); return window
}
export function contextWindowUsage(state, windowId, objectRef) {
  const reads = state.contextReads.filter(row => row.windowId === windowId), objects = reads.filter(row => isDeepStrictEqual(row.objectRef, objectRef))
  return { reads: reads.length, bytes: reads.reduce((sum, row) => sum + row.bytes, 0), tokens: reads.reduce((sum, row) => sum + row.tokenEstimate, 0), objectPages: objects.length, objectBytes: objects.reduce((sum, row) => sum + row.bytes, 0) }
}
export const contextObjectKey = ref => `${ref.kind}:${ref.id}`
function expectedPath(parent, ref) { return parent ? isDeepStrictEqual(parent.objectRef, ref) ? parent.path : [...parent.path, contextObjectKey(ref)] : [contextObjectKey(ref)] }
export function recordContextPage(state, row) {
  const old = state.contextReads.find(item => item.id === row.id)
  if (old) { if (old.requestDigest !== row.requestDigest || !sameBinding(old.receiverBinding, row.receiverBinding)) throw error('IDEMPOTENCY_CONFLICT'); return old }
  const instance = state.contextReadInstances.find(item => item.id === row.contextInstanceId), window = currentContextWindow(state, instance?.id)
  if (!instance || window?.id !== row.windowId || !sameBinding(instance.readerBinding, row.receiverBinding)) throw error('REVISION_CONFLICT', '资料窗口已变化')
  const usage = contextWindowUsage(state, window.id, row.objectRef), limits = instance.limits
  if (usage.reads >= limits.maxReads || usage.bytes + row.bytes > limits.maxBytes || usage.tokens + row.tokenEstimate > limits.maxTokens || usage.objectPages >= limits.objectPages || usage.objectBytes + row.bytes > limits.objectBytes) throw error('CONTEXT_READ_LIMIT', '本次资料窗口额度已用完，请明确继续读取')
  if (row.path.length > limits.maxHops + 1 || new Set(row.path).size !== row.path.length) throw error('CONTEXT_READ_LIMIT', '资料关系不能成环或超过本次深度')
  const parent = row.parentReadId && state.contextReads.find(item => item.id === row.parentReadId && item.contextInstanceId === instance.id)
  const target = window.continuationTarget ?? (parent && { objectRef: parent.objectRef, view: parent.view, fromIndex: parent.page.nextIndex })
  const resumed = window.parentReadId === row.parentReadId && parent && isDeepStrictEqual(target.objectRef, row.objectRef) && target.view === row.view && target.fromIndex === row.fromIndex
  if (window.parentReadId && !state.contextReads.some(read => read.windowId === window.id) && !resumed) throw error('CONTEXT_READ_UNAVAILABLE', '新窗口须从已批准的原未读位置继续')
  if (!isDeepStrictEqual(row.path, expectedPath(parent, row.objectRef))) throw error('CONTEXT_READ_LIMIT', '资料路径必须承接真实父页')
  if (row.parentReadId && !parent || row.parentReadId && !resumed && !(isDeepStrictEqual(parent.objectRef, row.objectRef) && parent.view === row.view && parent.page.nextIndex === row.fromIndex || parent.page.nextRefs.some(next => isDeepStrictEqual(next.objectRef, row.objectRef)) && row.fromIndex === 0)) throw error('CONTEXT_READ_UNAVAILABLE')
  if (!row.parentReadId && (row.objectRef.kind !== 'continuation' || row.objectRef.id !== instance.continuationId || row.fromIndex !== 0)) throw error('CONTEXT_READ_UNAVAILABLE')
  if (row.bytes !== Buffer.byteLength(JSON.stringify(row.page)) || row.bytes > limits.pageBytes || row.tokenEstimate !== row.bytes || row.pageDigest !== digest(row.page) || row.page.readId !== row.id || row.page.contextInstanceId !== instance.id || row.page.windowId !== window.id) throw error('INVALID_STATE', '资料页完整字节或身份不一致')
  state.contextReads.push(structuredClone(row)); return row
}
export function validateContextReadState(state) {
  for (const name of Object.keys(emptyContextReadState())) check(Array.isArray(state[name]) && state[name].length <= 30000 && new Set(state[name].map(row => row.id)).size === state[name].length, name)
  for (const row of state.contextReadInstances) check(state.workContinuations.some(link => link.id === row.continuationId && link.workId === row.readerBinding.work_id) && state.members.some(member => member.id === row.actorId) && isDeepStrictEqual(row.limits, L), '续办读者')
  for (const row of state.contextReadWindows) check(state.contextReadInstances.some(instance => instance.id === row.contextInstanceId) && state.sourceEvents.some(event => event.id === row.sourceEventId) && (!row.parentReadId || state.contextReads.some(read => read.id === row.parentReadId && read.contextInstanceId === row.contextInstanceId)), '人类窗口')
  for (const row of state.contextReads) { contextObjectRef(row.objectRef); check(state.contextReadWindows.some(window => window.id === row.windowId && window.contextInstanceId === row.contextInstanceId) && row.pageDigest === digest(row.page) && row.bytes === Buffer.byteLength(JSON.stringify(row.page)) && row.bytes <= L.pageBytes && row.tokenEstimate === row.bytes && row.page.readId === row.id && Number.isSafeInteger(row.fromIndex) && row.fromIndex >= 0 && row.page.nextIndex >= row.fromIndex && row.path.length <= L.maxHops + 1 && new Set(row.path).size === row.path.length && state.modelRequests.some(request => request.id === row.modelRequestId && sameBinding(request, row.receiverBinding)), '实际资料页') }
  for (const window of state.contextReadWindows) {
    if (window.sourceWindowId !== undefined) check(window.parentReadId && state.contextReadWindows.some(row => row.id === window.sourceWindowId && row.contextInstanceId === window.contextInstanceId) && state.contextReadWindows.findIndex(row => row.id === window.sourceWindowId) < state.contextReadWindows.indexOf(window), '实际消耗的源窗口')
    for (const position of [window.blockedFrontier, window.continuationTarget].filter(Boolean)) {
      const parent = state.contextReads.find(read => read.id === position.parentReadId && read.contextInstanceId === window.contextInstanceId)
      check(parent && Number.isSafeInteger(position.fromIndex) && position.path.length <= L.maxHops + 1 && new Set(position.path).size === position.path.length && isDeepStrictEqual(position.path, expectedPath(parent, position.objectRef)) && (isDeepStrictEqual(parent.objectRef, position.objectRef) && parent.view === position.view && parent.page.partial && parent.page.nextIndex === position.fromIndex || position.fromIndex === 0 && parent.page.nextRefs.some(next => isDeepStrictEqual(next.objectRef, position.objectRef) && next.view === position.view)), '原未读目标')
      if (position === window.continuationTarget) check(position.parentReadId === window.parentReadId, '批准父页')
    }
    const reads = state.contextReads.filter(read => read.windowId === window.id)
    check(reads.length <= L.maxReads && reads.reduce((sum, read) => sum + read.bytes, 0) <= L.maxBytes && reads.reduce((sum, read) => sum + read.tokenEstimate, 0) <= L.maxTokens, '窗口累计额度')
    for (const read of reads) {
      const parent = read.parentReadId && state.contextReads.find(row => row.id === read.parentReadId && row.contextInstanceId === read.contextInstanceId)
      check(isDeepStrictEqual(read.path, expectedPath(parent, read.objectRef)), '持久父路径')
      const target = window.continuationTarget ?? (parent && { objectRef: parent.objectRef, view: parent.view, fromIndex: parent.page.nextIndex })
      if (read === reads[0] && window.parentReadId) check(parent?.id === window.parentReadId && isDeepStrictEqual(target.objectRef, read.objectRef) && target.view === read.view && target.fromIndex === read.fromIndex, '续窗起点')
      const usage = contextWindowUsage(state, window.id, read.objectRef); check(usage.objectPages <= L.objectPages && usage.objectBytes <= L.objectBytes, '对象累计额度')
    }
  }
  return state
}
export function assertContextReadImmutable(before, after) {
  for (const name of ['contextReadInstances', 'contextReads']) check(isDeepStrictEqual(before[name], after[name].slice(0, before[name].length)), name + '不可改写')
  for (const row of before.contextReadWindows) { const next = after.contextReadWindows.find(item => item.id === row.id), fixed = value => value && Object.fromEntries(Object.entries(value).filter(([name]) => !['deliveryCommandId', 'deliveryCommandIds', 'deliveredAt', 'deliveredByCommandId', 'blockedFrontier'].includes(name))); check(isDeepStrictEqual(fixed(row), fixed(next)) && (!row.blockedFrontier || isDeepStrictEqual(row.blockedFrontier, next.blockedFrontier)) && (!row.deliveryCommandId || row.deliveryCommandId === next.deliveryCommandId) && (!row.deliveredAt || row.deliveredAt === next.deliveredAt) && (!row.deliveredByCommandId || row.deliveredByCommandId === next.deliveredByCommandId) && isDeepStrictEqual(row.deliveryCommandIds ?? [], (next.deliveryCommandIds ?? []).slice(0, row.deliveryCommandIds?.length ?? 0)), '窗口身份/投递不可改写') }
}
