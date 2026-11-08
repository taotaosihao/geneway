import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createInteractionService } from '../src/interaction-service.mjs'
import { createContextReadService } from '../src/context-read-service.mjs'
import { contextResumePosition } from '../src/context-read-state.mjs'
import { createSpreadsheetArtifacts } from '../src/spreadsheet-artifacts.mjs'

// 真实T20归档副本上的生产服务事务检查；不启动HTTP/Host/provider，不伪造读取页或审批。
const evidenceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence'
const thirdMode = process.argv.includes('--third-window-source')
const frontierMode = process.argv.includes('--frontier-source')
const sourceRoot = join(evidenceRoot, thirdMode ? 'context-read-HkTjN7' : frontierMode ? 'context-read-4yiBQC' : 'context-read-hUeMUQ')
const source = join(sourceRoot, thirdMode ? 'cross-window-before-third.json' : frontierMode ? 'complete-metadata-window.json' : 'window-approved-waiting.json')
const sourceBytes = await readFile(source), archived = JSON.parse(sourceBytes), sourceStateField = thirdMode || frontierMode ? 'state' : 'before'
const original = archived[sourceStateField]
// wrapper内是主writer真实HTTP前完整快照；不删页、不改权限/版本或制造未读。
assert.equal(original.version, 25)
const directory = await mkdtemp(join(evidenceRoot, 'context-source-rejection-'))
const path = join(directory, 'state.json'); await writeFile(path, JSON.stringify(original, null, 2) + '\n')
const artifactRoot = join(directory, 'artifacts')
await cp(join(sourceRoot, 'api/artifacts'), artifactRoot, { recursive: true })
const store = createFileStore(path)
const snapshot = await store.read()
const read = thirdMode ? snapshot.contextReads.find(row => row.id === archived.parent.readId) : frontierMode ? snapshot.contextReads.find(row => row.id === archived.workPage.readId) : snapshot.contextReads.findLast(row => row.objectRef.kind === 'artifact' && row.page.partial && row.page.nextIndex < row.page.totalItems)
assert.ok(read, 'source must contain the actual parent page')
const instance = snapshot.contextReadInstances.find(row => row.id === read.contextInstanceId)
assert.ok(instance)
const expectedTarget = contextResumePosition(snapshot, instance, read.id)
assert.ok(expectedTarget, 'source must have an actual approved-resumable position')
if (frontierMode) {
  assert.equal(read.page.partial, false)
  assert.equal(expectedTarget.objectRef.kind, 'artifact')
  assert.equal(expectedTarget.fromIndex, 0)
  assert.deepEqual(expectedTarget.objectRef, read.page.nextRefs[0].objectRef)
}
const actor = { id: instance.actorId }, threadId = instance.threadId
if (thirdMode) { assert.deepEqual(expectedTarget.objectRef, archived.target.objectRef); assert.equal(expectedTarget.view, archived.target.view); assert.equal(expectedTarget.fromIndex, 0) }
const verificationCalls = []
const clock = () => Date.now()
function services(root = artifactRoot) {
  const spreadsheetArtifacts = createSpreadsheetArtifacts({ store, root, clock })
  const contextReader = createContextReadService({ store, spreadsheetArtifacts, clock })
  const verify = contextReader.verifyWindowApproval.bind(contextReader)
  contextReader.verifyWindowApproval = async (...args) => {
    verificationCalls.push({ windowId: args[4], target: args[0].contextReadWindows.find(window => window.id === args[4])?.continuationTarget })
    return verify(...args)
  }
  return createInteractionService({ store, spreadsheetArtifacts, contextReader, clock })
}
const service = services(), observations = []
let sequence = 0
const parameters = (state, additions = {}) => ({ clientRequestId: `rejection-${++sequence}`, sourceEventId: `source-rejection-${sequence}`,
  version: 1, expectedThreadRevision: state.webThreads.find(row => row.id === threadId).revision,
  text: '继续读取资料', continueContextRead: { readId: read.id }, ...additions })
async function reject(name, additions, expected, targetThread = threadId, targetActor = actor, targetService = service) {
  const before = await store.read(), bytes = await readFile(path), args = parameters(before, additions)
  let observed
  await assert.rejects(targetService.submit(targetActor, targetThread, args), cause => { observed = { code: cause.code, message: cause.message }; return cause.code === expected })
  assert.deepEqual(await store.read(), before, `${name}: no partial Source/window/intent/Input/receipt or other fact`)
  assert.deepEqual(await readFile(path), bytes, `${name}: no durable file rewrite`)
  observations.push({ name, expected, observed, wholeStateUnchanged: true, durableBytesUnchanged: true })
}
for (const [name, value] of [
  ['workId', instance.readerBinding.work_id],
  ['replyToQuestion', { id: 'question', answer: '不能混合' }],
  ['replyToIntentQuestion', { id: 'intent-question', routeRevision: 1 }],
  ['attachmentRefs', []],
  ['spreadsheetRequest', { templateId: 'incident-collaboration-v1' }],
  ['expectedInstructionRevision', snapshot.works.find(row => row.id === instance.readerBinding.work_id).instructionRevision],
  ['revisionScope', 'typed'],
  ['replyToEventId', snapshot.sourceEvents[0].id],
]) await reject(`continueContextRead互斥:${name}`, { [name]: value }, 'INVALID_REQUEST')
await reject('未知readId', { continueContextRead: { readId: 'read-does-not-exist' } }, 'CONTEXT_READ_UNAVAILABLE')
await reject('额外continue字段', { continueContextRead: { readId: read.id, offset: read.page.nextIndex } }, 'INVALID_REQUEST')
await reject('错误Thread revision', { expectedThreadRevision: 0 }, 'REVISION_CONFLICT')
const peer = snapshot.members.find(row => row.enabled && row.id !== actor.id)
assert.ok(peer, 'real source must contain another enabled member')
await reject('真实其它成员不能提交本Thread', {}, 'NOT_FOUND', threadId, { id: peer.id })
// 使用真实createThread建立独立的合法Thread，不手造角色或修改旧事实。
const otherThread = await service.createThread(actor, { clientRequestId: 'other-thread-for-read-boundary', title: '资料读取边界验证' })
await reject('同用户其它Thread不能借原read', { expectedThreadRevision: otherThread.revision }, 'CONTEXT_READ_UNAVAILABLE', otherThread.id)
const peerThread = await service.createThread({ id: peer.id }, { clientRequestId: 'peer-thread-for-read-boundary', title: '资料读取边界验证' })
await reject('其它真实成员自有Thread不能借原read', { expectedThreadRevision: peerThread.revision }, 'CONTEXT_READ_UNAVAILABLE', peerThread.id, { id: peer.id })
// 真实beforeCommit文件I/O失败；生产审批先在内存写Source/window，持久事务应完整回滚。
if (!thirdMode) await reject('审批后实际文件I/O失败仍整体回滚', {}, 'ENOENT', threadId, actor, services(join(directory, 'missing-artifact-root')))
// 第三目标为immutable result，没有文件读取路径，不伪造G文件ENOENT。
const beforePositive = await store.read(), args = parameters(beforePositive)
const approved = await service.submit(actor, threadId, args)
assert.equal(approved.readId, read.id)
const afterPositive = await createFileStore(path).read()
assert.equal(afterPositive.sourceEvents.length, beforePositive.sourceEvents.length + 1)
assert.equal(afterPositive.contextReadWindows.length, beforePositive.contextReadWindows.length + 1)
assert.equal(afterPositive.sourceEvents.at(-1).payload.continueContextRead.readId, read.id)
assert.equal(afterPositive.contextReadWindows.at(-1).parentReadId, read.id)
assert.deepEqual(afterPositive.contextReadWindows.at(-1).continuationTarget, expectedTarget)
if (thirdMode) {
  assert.equal(afterPositive.contextReadWindows.length, 3)
  assert.notEqual(approved.contextReadWindowId, beforePositive.contextReadWindows.at(-1).id)
  assert.equal(afterPositive.contextReadWindows.at(-1).sourceWindowId, beforePositive.contextReadWindows.at(-1).id)
  assert.equal(verificationCalls.at(-1).windowId, approved.contextReadWindowId)
  assert.deepEqual(verificationCalls.at(-1).target, expectedTarget)
}
for (const field of ['works', 'workIntents', 'contextReads', 'modelRequests', 'artifacts', 'evidence', 'evidenceAccessReceipts']) assert.deepEqual(afterPositive[field], beforePositive[field], field)
assert.deepEqual(afterPositive.multisite.inputs, beforePositive.multisite.inputs)
assert.equal(afterPositive.contextReadWindows.at(-1).deliveredAt, null)
assert.deepEqual(await service.submit(actor, threadId, args), approved)
assert.deepEqual(await createFileStore(path).read(), afterPositive)
if (thirdMode) {
  const oldWindow = beforePositive.contextReadWindows.at(-1)
  const oldSource = beforePositive.sourceEvents.find(event => event.id === oldWindow.sourceEventId)
  assert.ok(oldSource?.receipt)
  const oldReply = await service.submit(actor, threadId, { ...oldSource.payload, clientRequestId: 'old-human-source-real-payload-replay', expectedThreadRevision: afterPositive.webThreads.find(thread => thread.id === threadId).revision })
  assert.equal(oldReply.contextReadWindowId, oldWindow.id)
  const replayed = await store.read()
  assert.equal(replayed.contextReadWindows.length, 3)
  assert.equal(replayed.contextReadWindows.at(-1).id, approved.contextReadWindowId)
  assert.deepEqual(replayed.contextReadWindows, afterPositive.contextReadWindows)
  assert.deepEqual(replayed.contextReads, afterPositive.contextReads)
}
assert.deepEqual(await readFile(source), sourceBytes)
const result = { result: 'passed', directory, source, sourceStateField, mode: thirdMode ? 'third-window-original-parent-result-g' : frontierMode ? 'complete-parent-artifact-frontier' : 'partial-artifact', sourceVersion: original.version, sourceBytesUnchanged: true, clock: 'current Date.now; no deadline or source clock rewritten',
  rejectedCases: observations.length, observations, verificationCalls, targetFileIoRollbackTested: !thirdMode, positive: { tested: true, approved, target: expectedTarget, nextIndex: read.page.nextIndex, actualProductionApproveAndBeforeCommitVerification: true, actualTargetFileVerification: !thirdMode, thirdWindowExactVerifyArgumentAndOldSourceReplay: thirdMode, sourceEventsAdded: 1, windowsAdded: 1, oldBusinessInputsUnchanged: true, oldBusinessFactsUnchanged: true, replayAddsNoFacts: true, actualNotificationConsumed: false },
  boundary: 'production FileStore + interaction/context/artifact service in process, real archived parent page/approved frontier and copied XLSX; no mocked approval, server/Host/provider/worker/SDK, new model consumption or notification delivery acceptance' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
