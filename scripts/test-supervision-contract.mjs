import { emptySiteRuleState } from '../src/site-rule-state.mjs'
import { emptySupervisionDiagnosisState } from '../src/supervision-diagnosis-state.mjs'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore, STATE_VERSION } from '../src/store/file-store.mjs'
import { createSupervisionService, supervisionProjection } from '../src/supervision-service.mjs'
import { emptySupervisionState, validateSupervisionState, assertSupervisionImmutable } from '../src/supervision-state.mjs'
import { manualScopeId } from '../src/manual-control.mjs'
import { createNodeBridge } from '../src/node-bridge.mjs'

const evidenceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence'
const directory = await mkdtemp(join(evidenceRoot, 'supervision-contract-'))
const compatibility = [], checks = []
const additions = { ...emptySiteRuleState(), routingBatches: [], ...emptySupervisionDiagnosisState(), ...emptySupervisionState(), workMemberRemovals: [], a2aProtocol: { tasks: [], groups: [], deliveries: [] } }
assert.equal(STATE_VERSION, 31)
assert.deepEqual(additions, { ...emptySiteRuleState(), routingBatches: [], ...emptySupervisionDiagnosisState(), supervisionFindings: [], supervisionActions: [], workMemberRemovals: [], a2aProtocol: { tasks: [], groups: [], deliveries: [] } })
let store
for (const [name, relative] of [
  ['context-three-windows', 'context-source-rejection-fnMp30/state.json'],
  ['legacy-evidence-ledger', 'context-read-compat-yI9U2m/retained-evidence-artifact-budget/state.json'],
  ['manual-release-facts', 'context-read-compat-yI9U2m/native-manual-released/state.json'],
]) {
  const source = join(evidenceRoot, relative), bytes = await readFile(source), before = JSON.parse(bytes)
  assert.equal(before.version, 25)
  for (const field of Object.keys(additions)) assert.equal(Object.hasOwn(before, field), false)
  const targetRoot = join(directory, name); await mkdir(targetRoot)
  const target = join(targetRoot, 'state.json'); await writeFile(target, bytes)
  const expected = { ...before, version: 31, ...additions }
  assert.deepEqual(await createFileStore(target).read(), expected)
  assert.deepEqual(await readFile(target), bytes)
  await createFileStore(target).update(state => state)
  assert.deepEqual(JSON.parse(await readFile(target)), expected)
  assert.deepEqual(await createFileStore(target).read(), expected)
  assert.deepEqual(await readFile(source), bytes)
  compatibility.push({ source, target, originalVersion: 25, targetVersion: 31, oldFieldsDeepEqual: true, sourceBytesUnchanged: true,
    oldFacts: { works: before.works.length, modelRequests: before.modelRequests.length, evidence: before.evidence.length,
      evidenceReceipts: before.evidenceAccessReceipts.length, manualControls: before.manualControls.length,
      contextReads: before.contextReads.length, contextWindows: before.contextReadWindows.length } })
  if (name === 'context-three-windows') store = createFileStore(target)
}
const initial = await store.read()
const instance = initial.contextReadInstances[0]
const attempt = initial.multisite.attempts.find(row => row.attempt_id === instance.readerBinding.attempt_id)
const work = initial.works.find(row => row.id === attempt.work_id), node = initial.nodes.find(row => row.id === attempt.node_id)
const token = () => randomBytes(32).toString('base64url')
const observer = { id: 'contract-observer', token: token(), role: 'observe', workspaceId: work.workspaceId, nodeIds: [attempt.node_id], workIds: [work.id] }
const recoverer = { ...observer, id: 'contract-recoverer', token: token(), role: 'recover' }
const foreign = { ...observer, id: 'contract-foreign-node', token: token(), nodeIds: ['not-authorized-node'] }
const wrongWork = { ...observer, id: 'contract-foreign-work', token: token(), workIds: ['not-authorized-work'] }
const wrongWorkspace = { ...observer, id: 'contract-foreign-workspace', token: token(), workspaceId: 'not-authorized-workspace' }
const bridge = createNodeBridge({ store }) // 无连接；不声称命中samegeneration/sent时的恢复门。
const service = createSupervisionService({ store, nodeBridge: bridge, identities: [observer, recoverer, foreign, wrongWork, wrongWorkspace] })
async function call(path, { method = 'GET', identity = observer, body, contentType = 'application/json', authorization } = {}, target = service) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  request.method = method
  request.headers = { ...(authorization !== null ? { authorization: authorization ?? `Bearer ${identity.token}` } : {}), 'content-type': contentType }
  let status, output
  const response = { writeHead(code) { status = code }, end(text) { output = JSON.parse(text) } }
  assert.equal(await target.handle(request, response, new URL(path, 'http://supervision.contract')), true)
  return { status, output }
}
async function unchangedCall(name, path, options, expected, target = service) {
  const before = await store.read(), result = await call(path, options, target)
  assert.equal(result.status, expected, name + ':' + JSON.stringify(result.output))
  assert.deepEqual(await store.read(), before)
  checks.push({ name, status: result.status, stateUnchanged: true })
  return result
}
const finding = { episodeId: 'contract-episode', scope: { workId: work.id, attemptId: attempt.attempt_id, nodeId: node.id, nodeInstanceId: node.nodeInstanceId },
  classification: 'COMMAND_UNACKNOWLEDGED', firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), checkpointAt: null, factRefs: [], code: null }
const reoffer = { episodeId: finding.episodeId, commandId: 'original-command', payloadDigest: 'original-digest', generation: 'current-generation', nodeInstanceId: node.nodeInstanceId }
await unchangedCall('缺身份', '/internal/supervision/snapshot', { authorization: null }, 403)
await unchangedCall('浏览器或Node类随机token不授监督', '/internal/supervision/snapshot', { authorization: 'Bearer unrelated-node-or-browser-token' }, 403)
await unchangedCall('recover不能读snapshot', '/internal/supervision/snapshot', { identity: recoverer }, 403)
await unchangedCall('recover不能报finding', '/internal/supervision/findings', { method: 'POST', identity: recoverer, body: finding }, 403)
await unchangedCall('observe不能reoffer', '/internal/supervision/reoffer', { method: 'POST', body: reoffer }, 403)
await unchangedCall('未启用监督身份默认403', '/internal/supervision/snapshot', {}, 403, createSupervisionService({ store, identities: [] }))
await unchangedCall('错Node scope拒finding', '/internal/supervision/findings', { method: 'POST', identity: foreign, body: finding }, 403)
await unchangedCall('错Work scope拒finding', '/internal/supervision/findings', { method: 'POST', identity: wrongWork, body: finding }, 403)
await unchangedCall('错workspace拒finding', '/internal/supervision/findings', { method: 'POST', identity: wrongWorkspace, body: finding }, 403)
await unchangedCall('finding不能附加自由正文', '/internal/supervision/findings', { method: 'POST', body: { ...finding, body: '不应保存正文' } }, 400)
await unchangedCall('finding只接受结构码', '/internal/supervision/findings', { method: 'POST', body: { ...finding, code: 'free form error text' } }, 400)
await unchangedCall('finding请求完整bytes有界', '/internal/supervision/findings', { method: 'POST', body: 'x'.repeat(16385) }, 400)
const unreadablePath = join(directory, 'unreadable-clone.json')
await writeFile(unreadablePath, '{')
const unreadable = createSupervisionService({ store: createFileStore(unreadablePath), identities: [observer] })
const unavailable = await call('/internal/supervision/snapshot', {}, unreadable)
assert.equal(unavailable.status, 503)
assert.equal(unavailable.output.error.code, 'STORE_UNAVAILABLE')
assert.equal(JSON.stringify(unavailable.output).includes('SyntaxError'), false)
checks.push({ name: '真实FileStore损坏副本读失败只返回不可用', status: 503, boundary: 'malformed JSON clone, not physical disk EIO' })
assert.throws(() => createSupervisionService({ store, identities: [observer, { ...recoverer, token: observer.token }] }), { code: 'INVALID_REQUEST' })
const snapshot = await call('/internal/supervision/snapshot')
assert.equal(snapshot.status, 200)
assert.ok(snapshot.output.attempts.length)
assert.ok(snapshot.output.attempts.every(row => row.binding.work_id === work.id && row.binding.node_id === node.id))
function noPrivateKeys(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['goal', 'text', 'body', 'messages', 'prompt', 'credential', 'token', 'parameters', 'page', 'items', 'entries'].includes(key), 'projection leaked field:' + key)
    noPrivateKeys(item)
  }
}
noPrivateKeys(snapshot.output)
const withPending = structuredClone(initial)
const oldCommand = withPending.multisite.outbox.find(row => row.command.attempt_id === attempt.attempt_id)
assert.ok(oldCommand)
oldCommand.acceptedAt = null // 仅负向投影视图，绝不提交或重供这条旧命令。
const pendingProjection = supervisionProjection(withPending, observer)
assert.ok(pendingProjection.pendingCommands.length)
noPrivateKeys(pendingProjection)
assert.deepEqual(Object.keys(pendingProjection.pendingCommands[0]).sort(), ['commandId', 'payloadDigest', 'binding', 'operation', 'createdAt', 'acceptedAt', 'generation', 'nodeInstanceId', 'sent'].sort())
for (const identity of [foreign, wrongWork, wrongWorkspace]) {
  const deniedScope = await service.snapshot(identity)
  assert.deepEqual(deniedScope.attempts, []); assert.deepEqual(deniedScope.pendingCommands, [])
}
const accepted = await call('/internal/supervision/findings', { method: 'POST', body: finding })
assert.equal(accepted.status, 200)
const acceptedState = await store.read()
assert.equal(acceptedState.supervisionFindings.length, 1)
assert.deepEqual((await call('/internal/supervision/findings', { method: 'POST', body: finding })).output, accepted.output)
assert.equal((await store.read()).supervisionFindings.length, 1)
const later = { ...finding, lastObservedAt: new Date(Date.parse(finding.lastObservedAt) + 1000).toISOString() }
assert.equal((await call('/internal/supervision/findings', { method: 'POST', body: later })).status, 200)
const laterState = await store.read()
assert.equal(laterState.supervisionFindings[0].lastObservedAt, later.lastObservedAt)
assertSupervisionImmutable(acceptedState, laterState)
await unchangedCall('同episode异分类冲突', '/internal/supervision/findings', { method: 'POST', body: { ...finding, classification: 'STAGE_STALLED' } }, 409)
const reopenedService = createSupervisionService({ store: createFileStore(compatibility[0].target), identities: [observer, recoverer] })
assert.equal((await call('/internal/supervision/findings', { method: 'POST', body: later }, reopenedService)).status, 200)
assert.equal((await store.read()).supervisionFindings.length, 1)
for (const mutate of [
  state => { state.supervisionFindings[0].classification = 'STAGE_STALLED' },
  state => { state.supervisionFindings[0].lastObservedAt = '2000-01-01T00:00:00.000Z' },
  state => { state.supervisionFindings = [] },
]) {
  const changed = structuredClone(laterState); mutate(changed)
  assert.throws(() => assertSupervisionImmutable(laterState, changed), { code: 'INVALID_STATE' })
}
validateSupervisionState(await store.read())
const waitCases = []
for (const [name, mutate, reason] of [
  ['人工正在暂停', state => state.manualControls.push({ scopeId: manualScopeId(work.id, { kind: 'work' }), workId: work.id, scope: { kind: 'work' }, generation: 1, action: 'pause', holders: [{ binding: attempt, idleAt: null }] }), 'MANUAL_PAUSING'],
  ['人工已安全暂停', state => state.manualControls.push({ scopeId: manualScopeId(work.id, { kind: 'work' }), workId: work.id, scope: { kind: 'work' }, generation: 1, action: 'pause', holders: [{ binding: attempt, idleAt: new Date().toISOString() }] }), 'MANUAL_PAUSED'],
  ['预算等待', state => { state.multisite.attempts.find(row => row.attempt_id === attempt.attempt_id).status = 'waiting_budget' }, 'WAITING_BUDGET'],
  ['用户等待', state => { state.multisite.attempts.find(row => row.attempt_id === attempt.attempt_id).status = 'waiting_question' }, 'WAITING_USER'],
  ['依赖等待', state => { state.multisite.attempts.find(row => row.attempt_id === attempt.attempt_id).status = 'waiting_dependency' }, 'WAITING_DEPENDENCY'],
  ['unknown归属', state => { state.multisite.attempts.find(row => row.attempt_id === attempt.attempt_id).status = 'unknown' }, 'UNKNOWN_OWNERSHIP'],
]) {
  const negative = structuredClone(laterState); mutate(negative)
  const projected = supervisionProjection(negative, observer).attempts.find(row => row.binding.attempt_id === attempt.attempt_id)
  assert.ok(projected.waits.includes(reason), name)
  waitCases.push({ name, reason })
}
await unchangedCall('没有当前连接不声称处置成功', '/internal/supervision/reoffer', { method: 'POST', identity: recoverer, body: reoffer }, 200)
assert.deepEqual((await store.read()).supervisionActions, [])
for (const [field, value] of Object.entries(initial)) if (!Object.keys(additions).includes(field)) assert.deepEqual((await store.read())[field], value, 'business field changed:' + field)
bridge.close()
const connected = process.argv.includes('--connected') ? await connectedChecks(directory) : null
const result = { result: 'passed', directory, compatibility, checks, connected, projectionScopedAndNoPrivateBody: true, findingDedupAcrossReopen: true,
  waitProjectionCases: waitCases, noConnectionRecoveryClaims: 0,
  boundary: 'production FileStore25→31 and service.handle with in-process Readable/request response collector; pure negative projection clones only, not admitted hold facts; no network HTTP, OS/SDK or same-generation sent-command recovery test. Recovery holds need real connected Bridge lane; no-connection no-op does not prove those branches' }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))


async function connectedChecks(parentDirectory) {
  const { createServer } = await import('node:http')
  const { randomUUID } = await import('node:crypto')
  const { startBridgeService } = await import('./fixtures/multisite/bridge-service.mjs')
  const { createRemoteClient, parseCommandStream } = await import('../packages/agent-host/remote-client.mjs')
  const { createHostJournal } = await import('../packages/agent-host/journal.mjs')
  const { createAgentHost } = await import('../packages/agent-host/host.mjs')
  const { createSimulatedRuntime } = await import('./fixtures/multisite/runtime.mjs')
  const root = join(parentDirectory, 'connected'), timeline = [], frames = [], observers = []
  await mkdir(root)
  const unknownRace = process.argv.includes('--unknown-race')
  let fixture, auxiliary, host, provider, releaseProvider, modelPending, releaseClaim, restoreUpdate
  const aborts = [new AbortController(), new AbortController()]
  const mark = (name, extra = {}) => { const value = { name, at: new Date().toISOString(), ...extra }; timeline.push(value); console.log(JSON.stringify(value)); return value }
  let ordinal = 0
  const watchedFetch = async (...args) => {
    const response = await fetch(...args)
    if (new URL(String(args[0])).pathname !== '/internal/bridge/events' || args[1]?.method === 'POST' || !response.ok) return response
    const stream = ++ordinal, [business, observe] = response.body.tee()
    const observation = (async () => {
      try { for await (const command of parseCommandStream(observe)) { frames.push({ stream, commandId: command.command_id, payloadDigest: command.payload_digest, operation: command.operation }); mark('wire-command', frames.at(-1)) } }
      catch (cause) { mark('wire-stream-ended', { stream, code: cause.code ?? cause.name }) }
    })()
    observers.push(observation)
    return new Response(business, { status: response.status, headers: response.headers })
  }
  try {
    let providerReached
    const providerSeen = new Promise(resolve => { providerReached = resolve })
    const providerGate = new Promise(resolve => { releaseProvider = resolve })
    if (unknownRace) {
      provider = createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        await writeFile(join(root, 'actual-provider-body.json'), Buffer.concat(chunks))
        mark('real-provider-received-after-model-ledger-reservation'); providerReached(); await providerGate
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"受控实际模型请求"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
    }
    fixture = await startBridgeService({ directory: join(root, 'api'), ...(provider ? { upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` } : {}) })
    if (unknownRace) { await mkdir(join(root, 'api/secrets')); await writeFile(join(root, 'api/secrets/key'), 'synthetic-contract-provider-key', { mode: 0o600 }) }
    const observeIdentity = { id: 'connected-observer', token: token(), role: 'observe', workspaceId: 'local', nodeIds: ['cloud'] }
    const recoveryIdentity = { ...observeIdentity, id: 'connected-recoverer', token: token(), role: 'recover' }
    const supervision = createSupervisionService({ store: fixture.store, nodeBridge: fixture.bridge, identities: [observeIdentity, recoveryIdentity] })
    auxiliary = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://supervision.connected')
      if (await supervision.handle(request, response, url)) return
      if (await fixture.bridge.handle(request, response, url)) return
      response.writeHead(404); response.end()
    })
    await new Promise(resolve => auxiliary.listen(0, '127.0.0.1', resolve))
    const supervisionOrigin = `http://127.0.0.1:${auxiliary.address().port}`
    mark('connected-live-started', { root, pid: process.pid, origin: fixture.origin, supervisionOrigin })
    const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
    const browser = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
    async function api(path, body) {
      const response = await fetch(fixture.origin + path, { method: 'POST', headers: { origin: fixture.origin, cookie, 'x-csrf-token': browser.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
    }
    async function supervisionPost(path, identity, body) {
      const response = await fetch(supervisionOrigin + path, { method: 'POST', headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
    }
    const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'connected-pair', nodeId: 'cloud', siteId: 'fixture', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 60000).toISOString() })
    const nodeIdentity = { credential: token(), nodeInstanceId: randomUUID(), registrationRevision: null }
    const client = createRemoteClient({ origin: fixture.origin, identity: nodeIdentity, fetchImpl: watchedFetch })
    const registered = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'connected-redeem', nodeInstanceId: nodeIdentity.nodeInstanceId, credential: nodeIdentity.credential })
    nodeIdentity.registrationRevision = registered.node.registrationRevision
    assert.deepEqual((await client.resync()).pending, [])
    const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', clientRequestId: 'pending-work', goal: '保原pending，验证有限恢复的世代与手停竞争。' })
    const journal = createHostJournal(join(root, 'host-journal.json')), runtime = createSimulatedRuntime({ path: join(root, 'sessions.json') })
    host = createAgentHost({ nodeId: 'cloud', journal, runtime })
    const firstStream = await client.stream(aborts[0].signal), command = (await firstStream.next()).value
    assert.equal(command.operation, 'launch')
    await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command)
    if (unknownRace) {
      await host.process(); await host.flushEvents(event => client.event(event))
      const consumed = await fixture.store.read()
      assert.ok(consumed.multisite.receipts.some(row => row.event.kind === 'session_ingested' && row.event.input_id === command.input_id && !row.historical))
      mark('real-host-consumed-input-while-command-transport-ack-held')
    }
    const initialStarts = runtime.starts()
    const firstConnection = fixture.bridge.supervisionConnection('cloud')
    assert.ok(firstConnection.sentCommandIds.includes(command.command_id))
    assert.equal((await fixture.store.read()).multisite.outbox.find(row => row.id === command.command_id).acceptedAt, null)
    const now = new Date().toISOString()
    const report = { episodeId: 'pending-connected-episode', scope: { workId: work.id, attemptId: command.attempt_id, nodeId: 'cloud', nodeInstanceId: nodeIdentity.nodeInstanceId }, classification: 'COMMAND_UNACKNOWLEDGED', firstObservedAt: now, lastObservedAt: now, checkpointAt: null, factRefs: [command.command_id], code: null }
    await supervisionPost('/internal/supervision/findings', observeIdentity, report)
    const secondStream = await client.stream(aborts[1].signal), repeated = (await secondStream.next()).value
    assert.deepEqual(repeated, command)
    await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, repeated)
    const secondConnection = fixture.bridge.supervisionConnection('cloud')
    assert.notEqual(secondConnection.generation, firstConnection.generation)
    const value = { episodeId: report.episodeId, commandId: command.command_id, payloadDigest: command.payload_digest, generation: firstConnection.generation, nodeInstanceId: nodeIdentity.nodeInstanceId }
    const stale = await supervisionPost('/internal/supervision/reoffer', recoveryIdentity, value)
    assert.equal(stale.offered, false); assert.equal(stale.action, null)
    assert.equal((await fixture.store.read()).supervisionActions.length, 0)
    assert.equal((await fixture.store.read()).multisite.outbox.find(row => row.id === command.command_id).acceptedAt, null)
    mark('old-generation-refused-while-original-still-pending', { commandId: command.command_id, oldGeneration: firstConnection.generation, currentGeneration: secondConnection.generation })
    let reachedClaim
    const reached = new Promise(resolve => { reachedClaim = resolve }), released = new Promise(resolve => { releaseClaim = resolve })
    const update = fixture.store.update.bind(fixture.store)
    let armed = true
    restoreUpdate = () => { fixture.store.update = update }
    fixture.store.update = async (mutator, options) => {
      let newClaim = false
      const returned = await update(async draft => {
        const before = draft.supervisionActions.length, next = await mutator(draft)
        newClaim = next.supervisionActions.length > before && next.supervisionActions.at(-1).outcome === 'claimed'
        return next
      }, options)
      // Actual FileStore update/rename/fsync has returned; no transaction lock is held here.
      if (armed && newClaim) { armed = false; mark('durable-claim-committed-before-offer-barrier'); reachedClaim(); await released }
      return returned
    }
    const recovery = supervisionPost('/internal/supervision/reoffer', recoveryIdentity, { ...value, generation: secondConnection.generation })
    await Promise.race([reached, recovery.then(() => { throw Error('No durable claim barrier was reached') })])
    const beforePause = await fixture.store.read()
    assert.equal(beforePause.supervisionActions.length, 1)
    assert.equal(beforePause.supervisionActions[0].outcome, 'claimed')
    const wireBeforePause = frames.filter(row => row.commandId === command.command_id).length
    assert.equal(wireBeforePause, 2)
    if (unknownRace) {
      const { binding } = await import('../packages/agent-contracts/index.mjs')
      const { messageId } = await import('../packages/agent-host/delivery.mjs')
      const execution = binding(beforePause.multisite.attempts.find(row => row.attempt_id === command.attempt_id))
      const issued = await client.issue(execution, { request: true, inputMessageId: messageId(command.input_id, execution.attempt_id, execution.session_id) })
      modelPending = fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: issued.modelSnapshot.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: command.parameters.text }] }) }).then(async response => ({ status: response.status, body: await response.text() }))
      await Promise.race([providerSeen, modelPending.then(result => { throw Error('Model request did not reach provider: ' + JSON.stringify(result)) })])
    } else {
      await api(`/api/works/${work.id}/multisite/pause`, { clientRequestId: 'pause-between-claim-and-write', scope: { kind: 'work' }, expectedControlGeneration: 0 })
    }
    const held = await fixture.store.read()
    if (unknownRace) assert.equal(held.modelRequests.filter(row => row.attempt_id === command.attempt_id && row.outcome === 'unknown').length, 1)
    else assert.equal(held.manualControls.at(-1).action, 'pause')
    mark(unknownRace ? 'real-unknown-request-inflight-after-durable-claim' : 'real-pause-committed-after-durable-claim', { commandId: command.command_id })
    releaseClaim()
    const raced = await recovery
    assert.equal(raced.offered, false); assert.equal(raced.action.outcome, 'not_offered')
    if (!unknownRace) { const manual = (await secondStream.next()).value; assert.equal(manual.operation, 'manual_pause') }
    assert.equal(frames.filter(row => row.commandId === command.command_id).length, wireBeforePause)
    assert.equal(fixture.bridge.supervisionConnection('cloud').generation, secondConnection.generation)
    const afterPause = await fixture.store.read()
    const refusal = await supervisionPost('/internal/supervision/reoffer', recoveryIdentity, { ...value, generation: secondConnection.generation })
    assert.equal(refusal.offered, false)
    assert.equal((await fixture.store.read()).supervisionActions.length, 1)
    assert.equal((await fixture.store.read()).multisite.outbox.find(row => row.id === command.command_id).acceptedAt, null)
    assert.equal((await journal.read()).inbox.filter(row => row.command.command_id === command.command_id).length, 1)
    assert.equal(runtime.starts(), initialStarts)
    if (unknownRace) {
      assert.equal(afterPause.modelRequests.length, beforePause.modelRequests.length + 1)
      assert.deepEqual(afterPause.modelRequests, held.modelRequests)
      releaseProvider(); const modelResult = await modelPending; assert.equal(modelResult.status, 200)
    } else assert.deepEqual(afterPause.modelRequests, beforePause.modelRequests)
    await writeFile(join(root, 'claim-and-pause.json'), JSON.stringify({ beforePause, held, afterPause, stale, raced, refusal }, null, 2))
    restoreUpdate(); restoreUpdate = null
    await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'connected-cleanup' })
    const cancel = (await secondStream.next()).value
    assert.equal(cancel.operation, 'cancel')
    assert.equal(frames.filter(row => row.commandId === command.command_id).length, wireBeforePause)
    const result = { result: 'passed', root, oldGenerationStillPendingRefused: true, sameCommandWireFrames: wireBeforePause,
      race: unknownRace ? 'actual-provider-inflight-unknown' : 'real-manual-pause', durableClaimThenCurrentHoldNoWireOffer: true, actionRetainedNotOffered: true, heldCurrentConnectionRefused: true,
      noAckForged: true, uniqueDurableInbox: true, supervisionAddsNoRuntimeStartOrModelRequests: true, legitimateInFlightModelRequests: unknownRace ? 1 : 0,
      boundary: 'real same-Node two SSE generations and supervision HTTP; real FileStore durable claim barrier after update returns, then real pause API or actual gateway/provider in-flight unknown before reoffer send; Host simulator, no SDK or ordinary-question race claim' }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); return result
  } catch (cause) { await writeFile(join(root, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, timeline }, null, 2)); throw cause }
  finally {
    releaseClaim?.(); releaseProvider?.(); restoreUpdate?.()
    if (modelPending) await modelPending.catch(() => {})
    for (const abort of aborts) abort.abort()
    await host?.close(); await fixture?.close()
    if (auxiliary) { auxiliary.closeAllConnections(); await new Promise(resolve => auxiliary.close(resolve)) }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
    await Promise.allSettled(observers)
    await writeFile(join(root, 'timeline.json'), JSON.stringify(timeline, null, 2))
    await writeFile(join(root, 'wire-frames.json'), JSON.stringify(frames, null, 2))
    console.log('Supervision connected root:', root)
  }
}
