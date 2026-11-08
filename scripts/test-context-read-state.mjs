import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { CONTEXT_READ_LIMITS as L } from '../packages/agent-contracts/context-read.mjs'
import {
  emptyContextReadState, openContextInstance, currentContextWindow, continueContextWindow,
  contextWindowUsage, recordContextPage, validateContextReadState, assertContextReadImmutable, contextResumePosition,
} from '../src/context-read-state.mjs'

// 纯状态组件夹具；不是已提交业务事实、模型消费证明或HTTP/SDK验收。
const at = '2026-11-06T08:00:00.000Z'
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)
function fixture() {
  const reader = { work_id: 'new-work', delegation_id: 'root-delegation', parent_delegation_id: null,
    attempt_id: 'root-attempt', execution_epoch: 1, agent_id: 'root-agent', node_id: 'node', launch_id: 'launch', session_id: 'session' }
  const state = { ...emptyContextReadState(), workContinuations: [{ id: 'continuation', workId: reader.work_id }],
    members: [{ id: 'human' }], sourceEvents: ['initial-human', 'continue-human', 'duplicate-human'].map(id => ({ id })),
    modelRequests: [{ id: 'model-request', ...reader }] }
  const options = { continuationId: 'continuation', actorId: 'human', threadId: 'thread', readerBinding: reader, sourceEventId: 'initial-human', at }
  const instance = openContextInstance(state, options)
  const root = { kind: 'continuation', id: 'continuation' }, child = { kind: 'work', id: 'old-work' }
  let sequence = 0
  function page(overrides = {}) {
    const id = `read-${++sequence}`, windowId = currentContextWindow(state, instance.id).id
    const row = { id, requestDigest: digest({ id }), contextInstanceId: instance.id, windowId,
      receiverBinding: binding(reader), modelRequestId: 'model-request', objectRef: root, view: 'summary',
      path: ['continuation:continuation'], parentReadId: null, fromIndex: 0, ...overrides }
    row.page = { readId: row.id, contextInstanceId: instance.id, windowId: row.windowId,
      entries: [{ text: '历史资料甲🙂' }], nextIndex: row.fromIndex + 1, totalItems: 100, partial: true,
      nextRefs: [{ objectRef: child }], ...overrides.page }
    row.bytes = Buffer.byteLength(JSON.stringify(row.page)); row.tokenEstimate = row.bytes; row.pageDigest = digest(row.page)
    return row
  }
  return { state, reader, options, instance, root, child, page }
}

test('root重读、模型请求/用途/Input/人工预算恢复凭据变化不自动新开窗口或返还额度', () => {
  const { state, options, instance, root, page } = fixture()
  recordContextPage(state, page())
  const before = contextWindowUsage(state, currentContextWindow(state, instance.id).id, root)
  for (const round of [
    { modelRequestId: 'request-2' }, { purpose: 'intent_review', inputMessageId: 'input-2' },
    { manualResumeCommandId: 'manual-resume', manualFence: { workGeneration: 2, agentGeneration: 0 } },
    { intentBudgetResumeCommandId: 'budget-resume' }, { sourceEventId: 'ordinary-input-2' },
  ]) assert.equal(openContextInstance(state, { ...options, ...round }).id, instance.id)
  assert.equal(state.contextReadWindows.length, 1)
  assert.deepEqual(contextWindowUsage(state, currentContextWindow(state, instance.id).id, root), before)
  recordContextPage(state, page())
  assert.equal(state.contextReadWindows.length, 1)
  assert.equal(contextWindowUsage(state, currentContextWindow(state, instance.id).id, root).reads, 2)
})

test('同parentRead的人类并发重复续窗只开一窗，旧IO不能跨到新额度', async () => {
  const { state, instance, root, page } = fixture()
  const first = recordContextPage(state, page()), late = page()
  const oldWindow = first.windowId
  // 模拟在同一事务状态提交的两个竞争候选；不声称这是FileStore锁或HTTP并发验收。
  const windows = await Promise.all(['continue-human', 'duplicate-human'].map(source => Promise.resolve().then(() => continueContextWindow(state, instance, first.id, source, at))))
  assert.equal(windows[0].id, windows[1].id)
  assert.equal(state.contextReadWindows.length, 2)
  rejects(() => recordContextPage(state, late), 'REVISION_CONFLICT')
  assert.equal(contextWindowUsage(state, windows[0].id, root).reads, 0)
  const continued = page({ parentReadId: first.id, fromIndex: first.page.nextIndex })
  recordContextPage(state, continued)
  assert.equal(contextWindowUsage(state, oldWindow, root).reads, 1)
  assert.equal(contextWindowUsage(state, windows[0].id, root).reads, 1)
  validateContextReadState(state)
})

test('cursor分叉竞争窗口最后一read额度仅一成功，失败不写入事实', async () => {
  const { state, instance, root, child, page } = fixture()
  let parent
  for (let index = 0; index < L.objectPages; index++) parent = recordContextPage(state, page())
  for (let index = 0; index < L.maxReads - L.objectPages - 1; index++) recordContextPage(state, page({ objectRef: child, path: ['continuation:continuation', 'work:old-work'], parentReadId: parent.id }))
  const candidates = [page({ objectRef: child, path: ['continuation:continuation', 'work:old-work'], parentReadId: parent.id }), page({ objectRef: child, path: ['continuation:continuation', 'work:old-work'], parentReadId: parent.id })]
  const results = await Promise.allSettled(candidates.map(row => Promise.resolve().then(() => recordContextPage(state, row))))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CONTEXT_READ_LIMIT')
  assert.equal(state.contextReads.length, L.maxReads)
  assert.equal(contextWindowUsage(state, currentContextWindow(state, instance.id).id, root).reads, L.maxReads)
})

test('页重放不双扣或复制余额；相同ID异文/异binding冲突', () => {
  const { state, instance, root, page } = fixture()
  const row = page(); recordContextPage(state, row)
  const usage = contextWindowUsage(state, row.windowId, root)
  assert.deepEqual(recordContextPage(state, structuredClone(row)), row)
  assert.deepEqual(contextWindowUsage(state, row.windowId, root), usage)
  rejects(() => recordContextPage(state, { ...row, requestDigest: 'changed' }), 'IDEMPOTENCY_CONFLICT')
  rejects(() => recordContextPage(state, { ...row, receiverBinding: { ...row.receiverBinding, session_id: 'other' } }), 'IDEMPOTENCY_CONFLICT')
  continueContextWindow(state, instance, row.id, 'continue-human', at)
  recordContextPage(state, structuredClone(row))
  assert.equal(contextWindowUsage(state, currentContextWindow(state, instance.id).id, root).reads, 0)
  assert.deepEqual(contextWindowUsage(state, row.windowId, root), usage)
  // state API没有auth参数；幂等重放fresh currentauth必须由service层单独实测。
})

test('同对象连续分页不增加关系hop；cycle及超过关系深度均拒绝', () => {
  const { state, page } = fixture()
  let previous = recordContextPage(state, page())
  for (let index = 0; index < L.objectPages - 1; index++) {
    previous = recordContextPage(state, page({ parentReadId: previous.id, fromIndex: previous.page.nextIndex, path: previous.path }))
    assert.equal(previous.path.length, 1)
  }
  const before = state.contextReads.length
  // 使用另一对象避免由已满的objectPages提前遮蔽深度判断。
  rejects(() => recordContextPage(state, page({ objectRef: { kind: 'work', id: 'old-work' }, parentReadId: previous.id,
    path: ['continuation:continuation', 'work:old-work', 'continuation:continuation'] })), 'CONTEXT_READ_LIMIT')
  rejects(() => recordContextPage(state, page({ objectRef: { kind: 'work', id: 'old-work' }, parentReadId: previous.id,
    path: Array.from({ length: L.maxHops + 2 }, (_, i) => `object-${i}`) })), 'CONTEXT_READ_LIMIT')
  assert.equal(state.contextReads.length, before)
})

test('完整JSON UTF8恰好16384bytes可记账；metadata越界/低报entry字节均拒绝', () => {
  const { state, page } = fixture()
  const row = page({ page: { metadata: '汉字🙂', entries: [{ text: '边界🙂' }] } })
  const room = L.pageBytes - Buffer.byteLength(JSON.stringify(row.page))
  row.page.metadata += 'x'.repeat(room)
  row.bytes = Buffer.byteLength(JSON.stringify(row.page)); row.tokenEstimate = row.bytes; row.pageDigest = digest(row.page)
  assert.equal(row.bytes, L.pageBytes)
  assert.ok(JSON.stringify(row.page).length < row.bytes)
  recordContextPage(state, row)
  const oversized = page({ page: { entries: row.page.entries, metadata: row.page.metadata + '超' } })
  assert.ok(oversized.bytes > L.pageBytes)
  rejects(() => recordContextPage(state, oversized), 'INVALID_STATE')
  const underreported = page({ page: { entries: [{ text: '一条' }], metadata: '🙂'.repeat(L.pageBytes) } })
  underreported.bytes = Buffer.byteLength(JSON.stringify(underreported.page.entries)); underreported.tokenEstimate = underreported.bytes
  rejects(() => recordContextPage(state, underreported), 'INVALID_STATE')
  assert.equal(state.contextReads.length, 1)
})

test('窗口、读取页和来源身份不可改写；无未读位置不能续窗', () => {
  const { state, instance, page } = fixture()
  const row = recordContextPage(state, page({ page: { nextIndex: 1, totalItems: 1, partial: false } }))
  rejects(() => continueContextWindow(state, instance, row.id, 'continue-human', at), 'CONTEXT_READ_UNAVAILABLE')
  const before = structuredClone(state)
  for (const mutate of [
    s => { s.contextReadInstances[0].actorId = 'other' },
    s => { s.contextReadWindows[0].sourceEventId = 'other' },
    s => { s.contextReads[0].page.entries[0].text = 'changed' },
    s => { s.contextReads = [] },
  ]) { const changed = structuredClone(state); mutate(changed); rejects(() => assertContextReadImmutable(before, changed), 'INVALID_STATE') }
  assertContextReadImmutable(before, state)
  validateContextReadState(state)
})

test('人类新窗首读必须精确续原object/version/view/nextIndex；不能重根或改offset', () => {
  const { state, instance, root, child, page } = fixture()
  const originalRef = { ...root, version: 1 }
  const parent = recordContextPage(state, page({ objectRef: originalRef }))
  continueContextWindow(state, instance, parent.id, 'continue-human', at)
  const before = structuredClone(state)
  const invalid = [
    page({ objectRef: originalRef }),
    page({ objectRef: originalRef, parentReadId: parent.id, fromIndex: 0 }),
    page({ objectRef: originalRef, parentReadId: parent.id, fromIndex: parent.page.nextIndex + 1 }),
    page({ objectRef: originalRef, parentReadId: parent.id, fromIndex: parent.page.nextIndex, view: 'content' }),
    page({ objectRef: { ...root, version: 2 }, parentReadId: parent.id, fromIndex: parent.page.nextIndex }),
    page({ objectRef: child, parentReadId: parent.id, fromIndex: 0, path: [...parent.path, 'work:old-work'] }),
  ]
  for (const candidate of invalid) {
    rejects(() => recordContextPage(state, candidate), 'CONTEXT_READ_UNAVAILABLE')
    assert.deepEqual(state, before)
    // 直接装入旧缺陷形状的负向持久夹具；没有产生任何正向读取/消费事实。
    const corrupted = structuredClone(before)
    corrupted.contextReads.push(structuredClone(candidate))
    rejects(() => validateContextReadState(corrupted), 'INVALID_STATE')
  }
  const continued = recordContextPage(state, page({ objectRef: originalRef, parentReadId: parent.id,
    fromIndex: parent.page.nextIndex, path: parent.path }))
  assert.equal(continued.fromIndex, parent.page.nextIndex)
  assert.deepEqual(continued.objectRef, parent.objectRef)
  validateContextReadState(state)
})

test('A→B→A不能通过每页单项path绕环；validator也拒旧坏页，B分页继承父path', () => {
  const { state, root, child, page } = fixture()
  const a = recordContextPage(state, page())
  const shortenedB = page({ objectRef: child, parentReadId: a.id, path: ['work:old-work'],
    page: { nextRefs: [{ objectRef: root }] } })
  const beforeB = structuredClone(state)
  rejects(() => recordContextPage(state, shortenedB), 'CONTEXT_READ_LIMIT')
  const badB = structuredClone(beforeB); badB.contextReads.push(shortenedB)
  rejects(() => validateContextReadState(badB), 'INVALID_STATE')
  assert.deepEqual(state, beforeB)
  const b = recordContextPage(state, page({ objectRef: child, parentReadId: a.id,
    path: [...a.path, 'work:old-work'], page: { nextRefs: [{ objectRef: root }] } }))
  const bNext = recordContextPage(state, page({ objectRef: child, parentReadId: b.id,
    fromIndex: b.page.nextIndex, path: b.path, page: { nextRefs: [{ objectRef: root }] } }))
  assert.deepEqual(bNext.path, b.path)
  assert.equal(bNext.path.length, 2)
  validateContextReadState(state)
  for (const path of [['continuation:continuation'], [...bNext.path, 'continuation:continuation']]) {
    const candidate = page({ objectRef: root, parentReadId: bNext.id, path })
    const before = structuredClone(state)
    rejects(() => recordContextPage(state, candidate), 'CONTEXT_READ_LIMIT')
    assert.deepEqual(state, before)
    const corrupted = structuredClone(before); corrupted.contextReads.push(candidate)
    rejects(() => validateContextReadState(corrupted), 'INVALID_STATE')
  }
})

test('满64reads的完整父页可沿原可见edge续新对象0，不能重根或改批准target', () => {
  const { state, instance, root, child, page } = fixture()
  const target = { kind: 'evidence', id: 'sealed-evidence', version: 1 }
  let parent
  for (let index = 0; index < L.objectPages; index++) recordContextPage(state, page({ page: { partial: false, totalItems: 1, nextIndex: 1, nextRefs: [{ objectRef: child, view: 'content' }] } }))
  const rootPage = state.contextReads.at(-1)
  for (let index = L.objectPages; index < L.maxReads; index++) parent = recordContextPage(state, page({ objectRef: child,
    parentReadId: rootPage.id, path: [...rootPage.path, 'work:old-work'],
    page: { partial: false, totalItems: 1, nextIndex: 1, nextRefs: [{ objectRef: target, view: 'content' }] } }))
  const oldWindow = currentContextWindow(state, instance.id)
  const expected = { parentReadId: parent.id, objectRef: target, view: 'content', fromIndex: 0, path: [...parent.path, 'evidence:sealed-evidence'] }
  assert.deepEqual(contextResumePosition(state, instance, parent.id), expected)
  const window = continueContextWindow(state, instance, parent.id, 'continue-human', at)
  assert.deepEqual(window.continuationTarget, expected)
  const before = structuredClone(state)
  const candidate = overrides => page({ objectRef: target, view: 'content', parentReadId: parent.id, path: expected.path, ...overrides })
  for (const row of [
    page(), candidate({ objectRef: { ...target, id: 'guessed-evidence' }, path: [...parent.path, 'evidence:guessed-evidence'] }),
    candidate({ objectRef: { ...target, version: 2 } }), candidate({ view: 'summary' }), candidate({ fromIndex: 1 }),
  ]) {
    rejects(() => recordContextPage(state, row), 'CONTEXT_READ_UNAVAILABLE')
    assert.deepEqual(state, before)
    const corrupted = structuredClone(before); corrupted.contextReads.push(row)
    rejects(() => validateContextReadState(corrupted), 'INVALID_STATE')
  }
  recordContextPage(state, candidate({}))
  assert.equal(contextWindowUsage(state, oldWindow.id, root).reads, L.maxReads)
  assert.equal(contextWindowUsage(state, window.id, target).reads, 1)
  validateContextReadState(state)
})

test('有界blockedFrontier仅保存一次原edge；低于64reads不能自行续完整页', () => {
  const { state, instance, child, page } = fixture()
  const parent = recordContextPage(state, page({ page: { partial: false, totalItems: 1, nextIndex: 1, nextRefs: [{ objectRef: child, view: 'content' }] } }))
  assert.equal(contextResumePosition(state, instance, parent.id), null)
  rejects(() => continueContextWindow(state, instance, parent.id, 'continue-human', at), 'CONTEXT_READ_UNAVAILABLE')
  const before = structuredClone(state), window = currentContextWindow(state, instance.id)
  // 纯组件有界事实夹具；不声称这里执行了真实budget失败/fresh auth或文件IO审批。
  window.blockedFrontier = { parentReadId: parent.id, objectRef: child, view: 'content', fromIndex: 0, path: [...parent.path, 'work:old-work'] }
  validateContextReadState(state)
  assertContextReadImmutable(before, state)
  assert.deepEqual(contextResumePosition(state, instance, parent.id), window.blockedFrontier)
  const fixed = structuredClone(state)
  for (const mutate of [
    value => { delete value.contextReadWindows[0].blockedFrontier },
    value => { value.contextReadWindows[0].blockedFrontier.fromIndex = 1 },
    value => { value.contextReadWindows[0].blockedFrontier.objectRef = { kind: 'work', id: 'guessed-work' } },
    value => { value.contextReadWindows[0].blockedFrontier.view = 'summary' },
  ]) {
    const changed = structuredClone(state); mutate(changed)
    rejects(() => assertContextReadImmutable(fixed, changed), 'INVALID_STATE')
  }
  const malformed = structuredClone(state)
  malformed.contextReadWindows[0].blockedFrontier.objectRef = { kind: 'work', id: 'guessed-work' }
  malformed.contextReadWindows[0].blockedFrontier.path = [...parent.path, 'work:guessed-work']
  rejects(() => validateContextReadState(malformed), 'INVALID_STATE')
  continueContextWindow(state, instance, parent.id, 'continue-human', at)
  recordContextPage(state, page({ objectRef: child, view: 'content', parentReadId: parent.id, path: [...parent.path, 'work:old-work'] }))
  validateContextReadState(state)
})

test('目标已有partial coverage时不从关系0覆盖，继续原partial只取实际未读nextIndex', () => {
  const { state, instance, child, page } = fixture()
  const parent = recordContextPage(state, page({ page: { partial: false, totalItems: 1, nextIndex: 1, nextRefs: [{ objectRef: child, view: 'content' }] } }))
  const partial = recordContextPage(state, page({ objectRef: child, view: 'content', parentReadId: parent.id, path: [...parent.path, 'work:old-work'] }))
  currentContextWindow(state, instance.id).blockedFrontier = { parentReadId: parent.id, objectRef: child, view: 'content', fromIndex: 0, path: partial.path }
  assert.equal(contextResumePosition(state, instance, parent.id), null)
  rejects(() => continueContextWindow(state, instance, parent.id, 'continue-human', at), 'CONTEXT_READ_UNAVAILABLE')
  const position = contextResumePosition(state, instance, partial.id)
  assert.deepEqual(position, { parentReadId: partial.id, objectRef: child, view: partial.view, fromIndex: partial.page.nextIndex, path: partial.path })
  const window = continueContextWindow(state, instance, partial.id, 'continue-human', at)
  assert.deepEqual(window.continuationTarget, position)
  rejects(() => recordContextPage(state, page({ objectRef: child, view: 'content', parentReadId: partial.id, path: partial.path, fromIndex: 0 })), 'CONTEXT_READ_UNAVAILABLE')
  recordContextPage(state, page({ objectRef: child, view: 'content', parentReadId: partial.id, path: partial.path, fromIndex: partial.page.nextIndex }))
  validateContextReadState(state)
})

test('当前第二窗满额可复用旧Job父页批准G第三窗；旧Source仍精确回第二窗', () => {
  const { state, instance, root, page } = fixture()
  state.sourceEvents.push({ id: 'third-human' }, { id: 'duplicate-third-human' })
  const job = { kind: 'job', id: 'original-job', version: 1 }
  const a = { kind: 'evidence', id: 'source-a', version: 1 }, g = { kind: 'evidence', id: 'source-g', version: 1 }
  const rootRefs = [{ objectRef: job, view: 'manifest' }]
  const nextRefs = [{ objectRef: a, view: 'content' }, { objectRef: g, view: 'content' }]
  const complete = refs => ({ partial: false, nextIndex: 1, totalItems: 1, nextRefs: refs })
  let oldJobParent, rootParent
  for (let i = 0; i < L.objectPages; i++) rootParent = recordContextPage(state, page({ page: complete(rootRefs) }))
  for (let i = L.objectPages; i < L.maxReads; i++) oldJobParent = recordContextPage(state, page({ objectRef: job, view: 'manifest',
    parentReadId: rootParent.id, path: [...rootParent.path, 'job:original-job'], page: complete(nextRefs) }))
  const firstWindow = currentContextWindow(state, instance.id)
  const second = continueContextWindow(state, instance, oldJobParent.id, 'continue-human', at)
  assert.equal(second.sourceWindowId, firstWindow.id)
  assert.deepEqual(second.continuationTarget.objectRef, a)
  for (let i = 0; i < L.objectPages; i++) recordContextPage(state, page({ objectRef: a, view: 'content', parentReadId: oldJobParent.id,
    path: [...oldJobParent.path, 'evidence:source-a'], page: complete([]) }))
  for (let i = L.objectPages; i < L.maxReads; i++) recordContextPage(state, page({ page: complete(rootRefs) }))
  const oldFacts = structuredClone(state)
  assert.equal(contextWindowUsage(state, second.id, root).reads, L.maxReads)
  const expected = { parentReadId: oldJobParent.id, objectRef: g, view: 'content', fromIndex: 0, path: [...oldJobParent.path, 'evidence:source-g'] }
  assert.deepEqual(contextResumePosition(state, instance, oldJobParent.id), expected)
  const third = continueContextWindow(state, instance, oldJobParent.id, 'third-human', at)
  assert.notEqual(third.id, second.id)
  assert.equal(third.sourceWindowId, second.id)
  assert.equal(oldJobParent.windowId, firstWindow.id)
  assert.deepEqual(third.continuationTarget, expected)
  assert.equal(continueContextWindow(state, instance, oldJobParent.id, 'duplicate-third-human', at).id, third.id)
  assert.equal(state.contextReadWindows.length, 3)
  assert.equal(continueContextWindow(state, instance, oldJobParent.id, 'continue-human', at).id, second.id)
  assert.equal(currentContextWindow(state, instance.id).id, third.id)
  const beforeFirstRead = structuredClone(state)
  rejects(() => recordContextPage(state, page({ objectRef: a, view: 'content', parentReadId: oldJobParent.id,
    path: [...oldJobParent.path, 'evidence:source-a'], page: complete([]) })), 'CONTEXT_READ_UNAVAILABLE')
  assert.deepEqual(state, beforeFirstRead)
  const firstG = recordContextPage(state, page({ objectRef: g, view: 'content', parentReadId: oldJobParent.id,
    path: expected.path, page: complete([]) }))
  assert.equal(firstG.fromIndex, 0)
  assert.equal(firstG.windowId, third.id)
  assertContextReadImmutable(oldFacts, state)
  assert.deepEqual(state.contextReadWindows.slice(0, 2), oldFacts.contextReadWindows)
  assert.equal(contextWindowUsage(state, second.id, root).reads, L.maxReads)
  validateContextReadState(state)
})
