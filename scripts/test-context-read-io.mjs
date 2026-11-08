import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { manualFence } from '../src/manual-control.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-native-XEeXvl'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-io-')
const bodies = [], observations = [], races = []
let fixture, provider, host, barrier
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function armBarrier(label, artifact) {
  let reached, release
  const seen = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  barrier = { label, artifact, seen, release, reached, gate, claimed: false, completedFileRead: null }
  return barrier
}
// 只拦实际Artifact文件handle的close：readFile、hash校验、ZIP验证、sync均已执行。
// 此处尚未进入context receipt最终Store事务，因此另一真实API不会等待同一Store锁。
const fileOperations = { async open(path, ...args) {
  const handle = await open(path, ...args), active = barrier
  if (!active || active.claimed || basename(String(path)) !== active.artifact.id) return handle
  active.claimed = true
  let bytes
  return new Proxy(handle, { get(target, property) {
    if (property === 'readFile') return async (...values) => { bytes = await target.readFile(...values); return bytes }
    if (property === 'close') return async () => {
      await target.close()
      assert.ok(bytes)
      assert.equal(bytes.length, active.artifact.sizeBytes); assert.equal(hash(bytes), active.artifact.sha256)
      active.completedFileRead = { bytes: bytes.length, sha256: hash(bytes), at: new Date().toISOString() }
      active.reached(active.completedFileRead); await active.gate
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
} }
try {
  const sourceBytes = await readFile(join(sourceRoot, 'old-ready-state.json')), original = JSON.parse(sourceBytes)
  const sourceWork = original.works.find(row => row.status === 'completed'), artifact = original.artifacts.find(row => row.workId === sourceWork.id && row.status === 'ready')
  assert.ok(artifact)
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"核对当前授权资料"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), seedState: state => Object.assign(state, structuredClone(original)),
    upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, spreadsheetFileOperations: fileOperations })
  for (const name of ['artifacts', 'evidence']) await cp(join(sourceRoot, 'api', name), join(directory, 'api', name), { recursive: true })
  await mkdir(join(directory, 'api/secrets')); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-context-io-key', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body, method = 'POST') {
    const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json(); observations.push({ path, method, status: response.status, value }); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const identity = JSON.parse(await readFile(join(sourceRoot, 'cloud/node-identity.json')))
  const client = createRemoteClient({ origin: fixture.origin, identity }), journal = createHostJournal(join(directory, 'host.json'))
  const runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
  host = createAgentHost({ nodeId: 'cloud', journal, runtime })
  host.setOrchestrationHandler({ call: (...args) => client.command(...args), event: event => client.event(event) })
  async function pump() {
    for (let turn = 0; turn < 3; turn++) {
      for (const pending of (await client.resync()).pending) { const command = await client.resolveCommand(pending); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }
      await host.process(); await host.flushEvents(event => client.event(event))
    }
  }
  const route = original.modelRoutes.find(row => row.enabled)
  await api('/api/admin/budget-policies/context-io-reader', { clientRequestId: 'io-policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 64, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }, 'PUT')
  const thread = await api('/api/interaction/threads', { clientRequestId: 'io-thread' })
  const proposal = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'source', sourceEventId: 'source', version: 1, expectedThreadRevision: 1, text: '核对已发布原成果的历史资料。', workId: sourceWork.id })
  const preview = await api(`/api/interaction/threads/${thread.id}/artifacts/${proposal.intentId}/${artifact.id}`, undefined, 'GET')
  const continuation = await api(`/api/interaction/threads/${thread.id}/continuation`, { clientRequestId: 'reader', intentId: proposal.intentId, expectedRouteRevision: proposal.routeRevision, employeeId: 'coordinator', budgetPolicyId: 'context-io-reader', goal: '读取原资料，验证当前轮次切换。', artifactReadId: preview.id })
  await pump()
  let state = await fixture.store.read()
  const execution = binding(state.multisite.attempts.find(row => row.work_id === continuation.workId))
  async function forward(input) {
    const inputMessageId = messageId(input.id, execution.attempt_id, execution.session_id)
    const issued = await client.issue(execution, { request: true, inputMessageId }); assert.ok(issued.modelStep)
    const response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: input.text }] }) })
    assert.equal(response.status, 200, await response.text()); return issued.modelStep
  }
  const input1 = state.multisite.inputs.find(row => row.workId === continuation.workId)
  const step1 = await forward(input1)
  const root = await client.context.read(execution, { clientRequestId: 'root-1', view: 'content' }, step1)
  const work = await client.context.read(execution, { clientRequestId: 'work-1', objectRef: root.nextRefs[0].objectRef, view: 'content' }, step1)
  const artifactRef = work.nextRefs[0].objectRef
  const first = await client.context.read(execution, { clientRequestId: 'artifact-1', objectRef: artifactRef, view: 'content' }, step1)
  assert.ok(first.nextCursor)
  const initialWindow = first.windowId
  async function finishRejectedRace(active, request, change) {
    const before = await fixture.store.read(), bodyCount = bodies.length
    const pending = request().then(value => ({ value }), cause => ({ cause }))
    await Promise.race([active.seen, pending.then(result => {
      if (!active.completedFileRead) throw result.cause ?? new Error('Request completed before reaching actual file I/O barrier')
      return active.completedFileRead
    })])
    await writeFile(join(directory, active.label + '-file-read.json'), JSON.stringify(active.completedFileRead, null, 2))
    await change()
    const changed = await fixture.store.read()
    if (active.label === 'manual-race') {
      assert.deepEqual(manualFence(before, execution), { workGeneration: 0, agentGeneration: 0 })
      assert.deepEqual(manualFence(changed, execution), { workGeneration: 1, agentGeneration: 0 })
    }
    active.release()
    const result = await pending
    assert.ok(result.cause, 'old read must fail after an actual current-phase change')
    assert.ok(['FORBIDDEN', 'REVISION_CONFLICT', 'CONTEXT_READ_UNAVAILABLE', 'MANUALLY_PAUSED'].includes(result.cause.code), result.cause.stack)
    const after = await fixture.store.read()
    assert.deepEqual(after.contextReads, before.contextReads)
    assert.deepEqual(after.modelRequests, before.modelRequests)
    assert.equal(bodies.length, bodyCount)
    races.push({ label: active.label, beforeManualFence: manualFence(before, execution), changedManualFence: manualFence(changed, execution), fileRead: active.completedFileRead, errorCode: result.cause.code, noNewReadReceipt: true, noNewModelRequestOrBody: true, beforeReads: before.contextReads.length, changedWorkRevision: changed.works.find(row => row.id === continuation.workId).instructionRevision })
    await writeFile(join(directory, active.label + '-states.json'), JSON.stringify({ before, changed, after }, null, 2))
    barrier = undefined
  }
  const inputBarrier = armBarrier('input2-race', artifact)
  await finishRejectedRace(inputBarrier, () => client.context.read(execution, { clientRequestId: 'late-old-phase', objectRef: artifactRef, view: 'content', cursor: first.nextCursor }, step1), async () => {
    const view = await api('/api/interaction/threads/' + thread.id, undefined, 'GET')
    await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'input2', sourceEventId: 'input2', version: 1, expectedThreadRevision: view.thread.revision, text: '继续核对原资料，记录为第二次正式要求。', workId: continuation.workId, expectedInstructionRevision: 1 })
    await pump()
  })
  state = await fixture.store.read()
  const input2 = state.multisite.inputs.findLast(row => row.workId === continuation.workId)
  assert.equal(input2.revision, 2)
  assert.ok(state.multisite.receipts.some(row => row.event.kind === 'session_ingested' && row.event.input_id === input2.id && row.event.instruction_revision === 2 && !row.historical))
  const step2 = await forward(input2)
  const beforeCursor = (await fixture.store.read()).contextReads.length
  await assert.rejects(client.context.read(execution, { clientRequestId: 'new-step-old-cursor', objectRef: artifactRef, view: 'content', cursor: first.nextCursor }, step2), { code: 'INVALID_CURSOR' })
  assert.equal((await fixture.store.read()).contextReads.length, beforeCursor)
  const newRoot = await client.context.read(execution, { clientRequestId: 'root-input2', view: 'content' }, step2)
  assert.equal(newRoot.contextInstanceId, root.contextInstanceId); assert.equal(newRoot.windowId, initialWindow)
  const afterInput2 = await fixture.store.read()
  assert.equal(afterInput2.contextReadWindows.length, 1)
  assert.ok(afterInput2.contextReads.length > beforeCursor)
  const currentArtifact = await client.context.read(execution, { clientRequestId: 'artifact-input2', objectRef: artifactRef, view: 'content' }, step2)
  assert.ok(currentArtifact.nextCursor)
  const manualBarrier = armBarrier('manual-race', artifact)
  await finishRejectedRace(manualBarrier, () => client.context.read(execution, { clientRequestId: 'late-pre-pause', objectRef: artifactRef, view: 'content', cursor: currentArtifact.nextCursor }, step2), async () => {
    await api(`/api/works/${continuation.workId}/multisite/pause`, { clientRequestId: 'manual-pause-during-file-io', scope: { kind: 'work' }, expectedControlGeneration: 0 })
  })
  const final = await fixture.store.read()
  for (const field of ['artifacts', 'evidence', 'evidenceAccessReceipts']) assert.deepEqual(final[field], original[field])
  assert.deepEqual(final.works.find(row => row.id === sourceWork.id), sourceWork)
  assert.deepEqual(final.modelRequests.slice(0, original.modelRequests.length), original.modelRequests)
  assert.deepEqual(await readFile(join(sourceRoot, 'old-ready-state.json')), sourceBytes)
  await writeFile(join(directory, 'state-final.json'), JSON.stringify(final, null, 2))
  await api(`/api/works/${continuation.workId}/multisite/cancel`, { clientRequestId: 'cleanup-cancel' }); await pump()
  const result = { result: 'passed', directory, races, actualProviderBodies: bodies.length, input2ActuallyConsumed: true, oldPhaseCursorDeniedUnderFreshStep: true, input2RetainsSourceInstanceAndWindow: true, oldSourceFactsUnchanged: true,
    boundary: 'real HTTP/paired Node/Host simulator and gateway requests; actual copied D4 XLSX read/hash/validation/sync completed before barrier, then real Source Input2 or Work pause before final receipt transaction; no official SDK/native new acceptance' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack }, null, 2)); throw cause }
finally {
  barrier?.release()
  await host?.close(); await fixture?.close()
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2))
  await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2))
  console.log('Context IO root:', directory)
}
