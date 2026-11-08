import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import bs58 from 'bs58'
import { verifyRfc9421OriginProof, verifyW3cProof, extractPublicKey, verifyHttpMessageSignature } from '@awiki/anp-typescript-sdk'
import { Task } from '@a2a-js/sdk'
import { verifyBusinessFlow, verifyTaskLinkage } from './business-flow.mjs'
import { digest, sameBinding } from '../../../packages/agent-contracts/index.mjs'

// 只解释已留存的原生产事实。CLI导航/transport失败形状在runner实际schema冻结后接入。
export function resultEffects(state, request, { requireFeedback = false } = {}) {
  assert.equal(request.operation, 'complete_delegation')
  assert.equal(request.binding.agent_id, 'desktop-data')
  const commands = state.multisite.commands.filter(row => row.issuerKind === 'agent' && row.issuerId === request.binding.attempt_id && row.commandId === request.parameters.clientRequestId)
  assert.equal(commands.length, 1)
  const command = commands[0]
  assert.ok(sameBinding(command.senderBinding, request.binding))
  assert.equal(command.digest, digest({ operation: request.operation, parameters: request.parameters }))
  const results = state.multisite.results.filter(row => row.id === command.reply.resultId)
  assert.equal(results.length, 1)
  const result = results[0]
  assert.ok(sameBinding(result.senderBinding, request.binding))
  assert.equal(result.instructionRevision, request.parameters.instructionRevision)
  const feedback = state.multisite.messages.filter(row => row.kind === 'dependency_result' && row.resultRef === result.id)
  assert.ok(feedback.length <= 1)
  if (requireFeedback) assert.equal(feedback.length, 1)
  return { command, result, feedback: feedback.map(row => ({ id: row.id, resultRef: row.resultRef, targetAttemptId: row.targetAttemptId,
    sourceDelegationId: row.sourceDelegationId, instructionRevision: row.instructionRevision })),
    senderModelRequestIds: state.modelRequests.filter(row => row.attempt_id === request.binding.attempt_id).map(row => row.id) }
}

export function assertResultReplayInvariant(committed, afterReplay, request) {
  const before = resultEffects(committed, request), after = resultEffects(afterReplay, request)
  assert.deepEqual(after, before, '同一真实结果的命令/结果/反馈身份与本发送者模型集合不可重复或改写')
  return { resultId: before.result.id, commandKey: before.command.key, dependencyFeedbackId: before.feedback[0]?.id ?? null,
    persistedResultCount: 1, persistedCommandCount: 1, dependencyFeedbackCountAtReplay: before.feedback.length }
}

export function assertSummaryOnlyConflict(original, changed, conflict) {
  assert.deepEqual(changed.binding, original.binding)
  assert.equal(changed.operation, original.operation)
  assert.equal(changed.parameters.clientRequestId, original.parameters.clientRequestId)
  const summary = original.parameters.result.summary, nextSummary = changed.parameters.result.summary
  assert.equal(typeof summary, 'string'); assert.equal(typeof nextSummary, 'string')
  assert.ok(nextSummary.startsWith(summary))
  assert.equal(Array.from(nextSummary).length, Array.from(summary).length + 1)
  const copy = structuredClone(changed); copy.parameters.result.summary = summary
  assert.deepEqual(copy, original, '只允许原summary尾部附加一个普通字符，不能另换权限或坏schema')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')
}

export function assertExactP4Replay(originalRpc, replayRpc, originalHostResult, replayHostResult) {
  assert.equal(originalRpc.method, 'group.send')
  assert.deepEqual(replayRpc, originalRpc, '原sealed P4重放须保全部RPC/operationId/messageId/proof，不能新UUID冒原重放')
  assert.ok(originalRpc.params.meta.operation_id && originalRpc.params.meta.message_id)
  assert.equal(replayHostResult.idempotent_replay, true)
  const { idempotent_replay, ...replayedAcceptance } = replayHostResult
  assert.deepEqual(replayedAcceptance, originalHostResult)
  assert.deepEqual(replayHostResult.group_receipt, originalHostResult.group_receipt)
  return { operationId: originalRpc.params.meta.operation_id, messageId: originalRpc.params.meta.message_id,
    hostReceiptOnly: true, boundary: 'Host旧receipt不证明业务reply重投；独立新关联的合法result query须另外检查' }
}

function taskState(task) { return task.state ?? ({ 1: 'submitted', 2: 'working', 3: 'completed', 6: 'input-required' })[task.status?.state] }
export function assertSameWaitingTask(before, after) {
  assert.equal(taskState(before), 'input-required'); assert.equal(taskState(after), 'input-required')
  assert.equal(after.id, before.id); assert.equal(after.contextId, before.contextId)
  const first = before.metadata.geneway, next = after.metadata.geneway
  for (const name of ['workId', 'rootDelegationId', 'rootAttemptId', 'currentRevision', 'workStatus', 'rootAttemptStatus']) assert.deepEqual(next[name], first[name], name)
  assert.ok(first.question?.id); assert.deepEqual(next.question, first.question)
  return { taskId: before.id, contextId: before.contextId, workId: first.workId,
    rootAttemptId: first.rootAttemptId, rootDelegationId: first.rootDelegationId, revision: first.currentRevision, questionId: first.question.id }
}

export function assertEntryProcessReplaced({ before, after, killedAt, exitedAt, signal, endpointBefore, endpointAfter, identityBefore, identityAfter }) {
  assert.ok(Number.isSafeInteger(before.pid) && Number.isSafeInteger(after.pid))
  assert.ok(before.startTicks && after.startTicks)
  assert.ok(before.pid !== after.pid || String(before.startTicks) !== String(after.startTicks))
  assert.equal(signal, 'SIGKILL'); assert.ok(Number.isFinite(Date.parse(killedAt)))
  assert.ok(Date.parse(exitedAt) >= Date.parse(killedAt))
  assert.equal(endpointAfter, endpointBefore)
  assert.deepEqual(identityAfter, identityBefore, '原CA/token或Home DID/key/group/principal原样重开，不重新授权')
  return { oldPid: before.pid, oldStartTicks: before.startTicks, newPid: after.pid, newStartTicks: after.startTicks, endpoint: endpointBefore }
}

export function assertNoBusinessRecreated(before, after, workId) {
  assert.deepEqual(after.works.map(row => row.id).sort(), before.works.map(row => row.id).sort())
  assert.deepEqual(after.works.filter(row => row.id === workId), before.works.filter(row => row.id === workId))
  for (const name of ['attempts', 'delegations', 'inputs']) assert.deepEqual(after.multisite[name].filter(row => row.work_id === workId || row.workId === workId), before.multisite[name].filter(row => row.work_id === workId || row.workId === workId))
  assert.deepEqual(after.modelRequests.filter(row => row.work_id === workId), before.modelRequests.filter(row => row.work_id === workId))
}


export async function verifyRecovery(runRoot) {
  const root = resolve(runRoot), read = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
  const lines = async file => (await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const input = await read('recovery-oracle-input.json')
  assert.ok(['a2a', 'anp'].includes(input.candidate))
  if (input.case === 'task-service') return verifyTaskServiceRecovery(root, input)
  assert.equal(input.case, 'result-reply')
  const committed = await read(input.x05.committed), replayed = await read(input.x05.replayed), conflict = await read(input.x05.conflict)
  const callers = await lines(input.x05.callerAttempts), events = await lines(input.x05.events)
  const command = committed.command
  assert.equal(committed.reply.status, 200); assert.equal(replayed.reply.status, 200)
  assert.deepEqual(replayed.command, command); assert.deepEqual(replayed.reply, committed.reply)
  const sends = callers.filter(row => row.type === 'actual-host-send')
  assert.equal(sends.length, 2, '必须是两个物理发送，不是原成功对象重复展示')
  assert.ok(Date.parse(sends[1].at) > Date.parse(sends[0].at))
  assert.deepEqual(sends[1].identity, sends[0].identity)
  assert.deepEqual(sends[0].command, command); assert.deepEqual(sends[1].command, command)
  const dropped = events.find(row => row.type === 'committed-response-dropped')
  const transportError = callers.find(row => row.type === 'actual-host-transport-error')
  const response = callers.find(row => row.type === 'actual-host-response')
  const changed = callers.find(row => row.type === 'same-host-changed-summary')
  assert.ok(dropped && transportError && response && changed)
  assert.deepEqual(dropped.command, command); assert.deepEqual(dropped.reply, committed.reply)
  assert.deepEqual(transportError.identity, sends[0].identity); assert.deepEqual(response.identity, sends[0].identity); assert.deepEqual(changed.identity, sends[0].identity)
  assert.deepEqual(transportError.command, command); assert.ok(transportError.error?.code || transportError.error?.message)
  assert.ok(Date.parse(dropped.at) >= Date.parse(sends[0].at))
  assert.ok(Date.parse(transportError.at) >= Date.parse(dropped.at) && Date.parse(transportError.at) < Date.parse(sends[1].at))
  assert.ok(Date.parse(response.at) >= Date.parse(sends[1].at))
  assert.equal(response.status, 200); assert.deepEqual(response.reply, committed.reply.body)
  assert.deepEqual(response.command, command)
  const parents = await read(join(input.businessRoot, 'parents.json'))
  assert.equal(parents.parents.find(row => row.agent === 'desktop-data').pid, sends[0].identity.pid)
  const identity = await read(join(input.businessRoot, 'pc-a/node-identity.json'))
  assert.equal(identity.nodeInstanceId, sends[0].identity.nodeInstanceId)
  assert.equal(identity.nodeInstanceId, dropped.nodeInstanceId); assert.equal(sends[0].identity.hostRunId, dropped.hostRunId)
  assert.equal(createHash('sha256').update('Bearer ' + identity.credential).digest('hex'), dropped.credentialSha256)
  const effects = assertResultReplayInvariant(committed.state, replayed.state, command)
  assertResultReplayInvariant(committed.state, conflict.state, command)
  assertSummaryOnlyConflict(command, conflict.command, conflict.reply)
  assert.deepEqual(changed.command, conflict.command); assert.equal(changed.status, 409); assert.deepEqual(changed.reply, conflict.reply.body)
  const final = await read(join(input.businessRoot, 'completed-state.json'))
  const finalEffects = resultEffects(final, command, { requireFeedback: true })
  assert.deepEqual(finalEffects.command, resultEffects(committed.state, command).command)
  assert.deepEqual(finalEffects.result, resultEffects(committed.state, command).result)
  const targetWire = await lines(join(input.relayRoot, 'application-wire.jsonl'))
  if (input.candidate === 'a2a') {
    const matching = targetWire.map(row => ({ request: row.request?.params?.message?.parts?.find(part => part.data)?.data, response: row.response?.result?.message?.parts?.find(part => part.data)?.data }))
    assert.ok(matching.some(row => JSON.stringify(row.request) === JSON.stringify(command) && JSON.stringify(row.response) === JSON.stringify(committed.reply)))
    assert.ok(matching.some(row => JSON.stringify(row.request) === JSON.stringify(conflict.command) && JSON.stringify(row.response) === JSON.stringify(conflict.reply)))
  }
  const verifier = fileURLToPath(new URL('../../../scripts/verify-spreadsheet-collaboration-result.mjs', import.meta.url))
  const layer = await promisify(execFile)(process.execPath, [verifier, join(root, input.businessRoot)], { maxBuffer: 4 * 1024 * 1024 })
  assert.equal(JSON.parse(layer.stdout).result, 'passed')
  const anp = input.candidate === 'anp' ? await verifyAnpResultProtocol({ root, input, events, command, conflict }) : null
  return { result: 'passed', anp, scope: 'X05-result-reply-only', candidate: input.candidate,
    effects, physicalSameHostSends: 2, originalCallerActuallyLostReply: true, changedSummarySameKey409: true,
    finalDependencyFeedbackCount: finalEffects.feedback.length, finalDependencyFeedbackId: finalEffects.feedback[0].id,
    originalD4FourSheetAndLedgerOracle: 'passed',
    protocolExtra: input.candidate === 'a2a' ? 'original A2A application response and conflict wire matched' : 'original sealed P4 receipt replay and distinct fresh result-query with signed response independently verified',
    boundary: 'fresh authorized Host original result scope only; later ordinary business models may advance and are not counted as duplicate replay effects; no X07/full hard gates or winner claim' }
}
async function verifyAnpResultProtocol({ root, input, events, command, conflict }) {
  const lines = async file => (await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const peerWire = await lines(join(input.relayRoot, 'independent-group-peer/wire.jsonl'))
  const homeWire = await lines(join(input.relayRoot, 'home/wire.jsonl')), incoming = await lines(join(input.relayRoot, 'home/incoming.jsonl'))
  const documents = new Map()
  for (const actor of ['desktop-data', 'coordinator']) {
    const file = JSON.parse(await readFile(join(root, input.relayRoot, 'home', actor + '-identity.json'), 'utf8'))
    documents.set(file.didDocument.id, file.didDocument)
  }
  for (const row of peerWire.filter(row => row.method === 'GET' && row.status === 200 && row.path.endsWith('/did.json'))) {
    const document = JSON.parse(row.responseBody); documents.set(document.id, document)
  }
  function receipt(proofDocument) {
    const document = documents.get(proofDocument.group_did)
    assert.ok(document)
    const selected = document.verificationMethod.find(row => row.id === proofDocument.proof.verificationMethod)
    assert.ok(selected && document.assertionMethod.includes(selected.id))
    assert.equal(proofDocument.proof.proofValue[0], 'z')
    const bytes = bs58.decode(proofDocument.proof.proofValue.slice(1)); assert.equal(bytes.length, 64)
    const copy = { ...proofDocument, proof: { ...proofDocument.proof, proofValue: Buffer.from(bytes).toString('base64url') } }
    assert.ok(verifyW3cProof(copy, extractPublicKey(selected), { expectedPurpose: 'assertionMethod' }))
  }
  function signed(rpc) {
    const { meta, body, auth } = rpc.params
    verifyRfc9421OriginProof(auth.origin_proof, rpc.method, meta, body, { didDocument: documents.get(meta.sender_did), options: { expectedSignerDid: meta.sender_did } })
  }
  const replays = events.filter(row => row.type === 'p4-exact-replay'), queries = events.filter(row => row.type === 'new-result-query')
  assert.equal(replays.length, 2); assert.equal(queries.length, 2)
  const original = replays[0].request
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(original.params.body.payload.commandDigest, sha(command))
  assert.equal(original.params.body.payload.kind, 'geneway.command.request/1')
  for (const replay of replays) {
    assert.deepEqual(replay.request, original)
    assertExactP4Replay(replay.request, replay.replayedRequest, replay.originalReceipt, replay.replayedReceipt)
    signed(replay.request); receipt(replay.originalReceipt.group_receipt)
  }
  const physical = peerWire.filter(row => row.method === 'POST' && row.requestBody && isDeepStrictEqual(JSON.parse(row.requestBody), original))
  assert.ok(physical.length >= 3, '原P4必须首次wire与两个真实exact replay，不是只存event标志')
  const db = new DatabaseSync(join(root, input.relayRoot, 'independent-group-peer/data/awiki-open-server.sqlite3'), { readOnly: true })
  let stored
  try { stored = db.prepare('SELECT operation_id, message_id, body_json, receipt_json FROM hosted_group_messages').all() } finally { db.close() }
  assert.equal(stored.filter(row => row.operation_id === original.params.meta.operation_id).length, 1)
  const responseRefs = []
  const exactResponse = events.find(row => row.type === 'exact-result-returned')
  const conflictResponse = events.find(row => row.type === 'changed-summary-conflict')
  for (const [index, query] of queries.entries()) {
    assert.ok(Date.parse(query.at) <= Date.parse(index === 0 ? exactResponse.at : conflictResponse.at))
    assert.ok(BigInt(query.hostReceipt.group_event_seq) > BigInt(replays[index].originalReceipt.group_event_seq))
    const rpc = query.request, payload = rpc.params.body.payload
    assert.equal(rpc.method, 'group.send'); signed(rpc)
    assert.equal(payload.kind, 'geneway.command.result-query/1'); assert.equal(payload.actor, 'desktop-data')
    assert.equal(payload.commandDigest, sha(index === 0 ? command : conflict.command))
    assert.notEqual(rpc.params.meta.operation_id, original.params.meta.operation_id)
    assert.notEqual(rpc.params.meta.message_id, original.params.meta.message_id)
    assert.notEqual(payload.requestId, original.params.body.payload.requestId)
    assert.equal(stored.filter(row => row.operation_id === rpc.params.meta.operation_id).length, 1)
    assert.ok(peerWire.some(row => row.method === 'POST' && row.requestBody && isDeepStrictEqual(JSON.parse(row.requestBody), rpc)))
    receipt(query.hostReceipt.group_receipt)
    const sentResponse = homeWire.find(row => row.direction === 'outbound' && row.request.method === 'group.send' && row.request.params.body.payload.kind === 'geneway.command.response/1' && row.request.params.body.payload.requestId === payload.requestId)
    assert.ok(sentResponse)
    assert.equal(sentResponse.request.params.body.payload.commandDigest, payload.commandDigest)
    responseRefs.push(sentResponse.request.params.body.payload.responseRef)
    const delivered = incoming.find(row => row.rpc.method === 'group.incoming' && row.rpc.params.meta.target.did === rpc.params.meta.sender_did && isDeepStrictEqual(row.rpc.params.body.payload, sentResponse.request.params.body.payload))
    assert.ok(delivered, 'Host接纳不能代真实当前caller收到新query答复')
    const { meta, body, auth } = delivered.rpc.params
    assert.equal(meta.sender_did, sentResponse.request.params.meta.sender_did)
    verifyRfc9421OriginProof(auth.origin_proof, 'group.send', { ...meta, target: { kind: 'group', did: body.group_did } }, { payload: body.payload }, { didDocument: documents.get(meta.sender_did), options: { expectedSignerDid: meta.sender_did } })
    receipt(body.group_receipt)
  }
  assert.equal(new Set(responseRefs).size, 2)
  assert.notEqual(queries[0].request.params.meta.operation_id, queries[1].request.params.meta.operation_id)
  return { physicalOriginalP4Sends: physical.length, exactReplayEvents: 2, originalHostMessageRows: 1, distinctFreshResultQueries: 2,
    exactQueryReturnsOriginalResult: true, changedQueryCallerGets409: true, signedResponseTargetCallerVerified: true,
    boundary: 'sealed P4 old receipt and fresh business-result query are separate facts; mutation replays original P4 but queries the changed canonical command, never uses old Host acceptance as a new reply' }
}
async function verifyTaskServiceRecovery(root, input) {
  const read = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
  const lines = async file => (await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const base = join(input.entryRoot, 'recovery')
  const before = await read(join(base, 'before-cloud.json')), offline = await read(join(base, 'offline-cloud.json')), after = await read(join(base, 'after-cloud.json'))
  const mappingBefore = await read(join(base, 'before-mapping.json')), mappingAfter = await read(join(base, 'after-mapping.json'))
  assert.deepEqual(mappingAfter, mappingBefore)
  const processes = await read(join(base, 'before-processes.json')), afterQuery = await read(join(base, 'after-query.json')), failedQuery = await read(join(base, 'offline-query.json'))
  const resultFile = await read(input.x07.result), events = await lines(input.x07.events)
  const initial = events.find(row => row.kind === 'ready' && row.generation === 1)
  const restarted = events.find(row => row.kind === 'ready' && row.generation === 2)
  const kill = events.find(row => row.kind === 'signal' && row.signal === 'SIGKILL')
  const exit = events.find(row => row.kind === 'exit' && row.generation === kill?.generation)
  const confirmed = events.find(row => row.kind === 'stop-confirmed' && row.generation === kill?.generation)
  const restartStart = events.find(row => row.kind === 'start' && row.generation === 2)
  assert.ok(initial && restarted && kill && exit && confirmed && restartStart)
  assert.equal(restartStart.openExisting, true)
  assert.equal(exit.terminal.signal, 'SIGKILL'); assert.equal(confirmed.terminal.signal, 'SIGKILL')
  assert.equal(exit.finalIdentity, null); assert.equal(confirmed.finalIdentity, null)
  assert.deepEqual(processes.businessChild, initial.identity); assert.deepEqual(kill.identity, initial.identity)
  assert.deepEqual(resultFile.oldIdentity, initial.identity); assert.deepEqual(resultFile.newIdentity, restarted.identity)
  assert.ok(Date.parse(restartStart.at) >= Date.parse(exit.terminal.at))
  assert.ok(Date.parse(restarted.at) >= Date.parse(restartStart.at))
  const identityBefore = await read(join(base, 'identity-files-before.json')), identityAfter = await read(join(base, 'identity-files-after.json'))
  assert.deepEqual(identityAfter, identityBefore)
  for (const file of identityAfter) assert.equal(createHash('sha256').update(await readFile(file.file)).digest('hex'), file.sha256, '当前原identity文件必须仍等原前后原bytes hash')
  const processProof = assertEntryProcessReplaced({ before: initial.identity, after: restarted.identity, killedAt: kill.at, exitedAt: exit.terminal.at, signal: kill.signal,
    endpointBefore: initial.ready.origin, endpointAfter: restarted.ready.origin, identityBefore, identityAfter })
  assert.deepEqual(restarted.ready.peerConfig, initial.ready.peerConfig)
  assert.equal(processes.origin, initial.ready.origin); assert.deepEqual(processes.peerConfig, initial.ready.peerConfig)
  assert.ok(failedQuery.error && failedQuery.exitCode !== 0)
  assert.equal(failedQuery.task, undefined); assert.ok(!failedQuery.output?.task)
  const offlineStderr = await readFile(join(root, input.entryRoot, 'peer-recovery-offline-query-stderr.log'), 'utf8')
  assert.equal(offlineStderr, failedQuery.error.stderr)
  const task = assertSameWaitingTask(processes.task, afterQuery.task)
  assertNoBusinessRecreated(before, offline, task.workId); assertNoBusinessRecreated(before, after, task.workId)
  assert.equal(before.modelRequests.filter(row => row.work_id === task.workId).length, after.modelRequests.filter(row => row.work_id === task.workId).length)
  assert.deepEqual(processes.parents.map(row => row.name).sort(), ['api', 'coordinator', 'desktop-office', 'desktop-data', 'gateway', 'analysis'].sort())
  let parentOsContinuity = { status: 'not-run', reason: 'A2A first retained run has before identities and executed helper assertions, but no archived offline/after proc observations; no bool promoted to independent OS proof' }
  const actualSamples = []
  for (const file of ['offline-processes.json', 'after-processes.json']) {
    try { actualSamples.push(await read(join(base, file))) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  }
  if (actualSamples.length === 2) {
    for (const sample of actualSamples) {
      const rows = Array.isArray(sample) ? sample : sample.parents
      assert.equal(rows.length, processes.parents.length)
      for (const expected of processes.parents) {
        const actual = rows.find(row => row.pid === expected.pid)
        assert.ok(actual); assert.equal(actual.startTicks, expected.startTicks); assert.ok(!['T', 't', 'Z'].includes(actual.state))
      }
      if (processes.independentGroupHost) {
        const actual = sample.independentGroupHost
        assert.equal(actual.pid, processes.independentGroupHost.pid); assert.equal(actual.startTicks, processes.independentGroupHost.startTicks); assert.ok(!['T', 't', 'Z'].includes(actual.state))
      }
    }
    parentOsContinuity = { status: 'passed', originalApiAndFiveHosts: 6, independentGroupHost: !!processes.independentGroupHost }
  }
  const businessInput = await read('business-oracle-input.json')
  const anpPaths = input.candidate === 'anp' ? {
    home: relative(root, dirname(identityBefore.find(row => row.file.endsWith('/service-identity.json')).file)),
    peer: relative(root, dirname(processes.peerConfig.peerConfigPath)),
  } : null
  const normal = input.candidate === 'a2a' ? await verifyBusinessFlow(root, businessInput) : await verifyRestartedAnpNormal(root, businessInput, anpPaths)
  assert.equal(normal.taskId, task.taskId); assert.equal(normal.sourceWorkId, task.workId)
  let queryProof
  if (input.candidate === 'a2a') {
    const wire = await lines(join(input.entryRoot, 'a2a/wire.jsonl'))
    const fresh = wire.find(row => row.request.method === 'GetTask' && Date.parse(row.at) >= Date.parse(restarted.at) && isDeepStrictEqual(JSON.parse(JSON.stringify(Task.fromJSON(row.response.result))), afterQuery.task))
    assert.ok(fresh); assert.equal(fresh.version, '1.0'); assert.equal(fresh.principal, mappingBefore.bindings[0].principal)
    assert.ok(offlineStderr.includes('ECONNREFUSED'))
    queryProof = { newActualGetTaskAfterNewProcessReady: true, version: fresh.version }
  } else {
    const grant = await read(join(input.entryRoot, 'anp/principal-grant.json'))
    const incoming = await lines(join(anpPaths.home, 'incoming.jsonl')), wire = await lines(join(anpPaths.home, 'wire.jsonl'))
    const peerWire = await lines(join(anpPaths.peer, 'wire.jsonl'))
    assert.equal(grant.groupDid, initial.ready.peerConfig.groupDid)
    assert.equal(grant.groupDid, restarted.ready.peerConfig.groupDid)
    assert.equal(grant.homeDid, initial.ready.peerConfig.homeDid)
    assert.equal(afterQuery.request.operation, 'get'); assert.equal(afterQuery.request.taskId, task.taskId)
    assert.equal(afterQuery.response.requestId, afterQuery.request.requestId)
    assert.notEqual(afterQuery.request.requestId, failedQuery.output?.request?.requestId)
    assert.equal(afterQuery.responseMessage.sender_did, grant.homeDid)
    assert.deepEqual(afterQuery.responseMessage.body.payload, afterQuery.response)
    assert.deepEqual(afterQuery.response.task, afterQuery.task)
    const documents = new Map()
    for (const row of peerWire.filter(row => row.method === 'GET' && row.status === 200 && row.path.endsWith('/did.json'))) { const value = JSON.parse(row.responseBody); documents.set(value.id, value) }
    const home = await read(join(anpPaths.home, 'coordinator-identity.json')); documents.set(home.didDocument.id, home.didDocument)
    const ownerRequest = incoming.find(row => row.rpc.method === 'group.incoming' && row.rpc.params.body.group_did === grant.groupDid && row.rpc.params.meta.sender_did === grant.principal && row.rpc.params.meta.target.did === grant.homeDid && isDeepStrictEqual(row.rpc.params.body.payload, afterQuery.request))
    assert.ok(ownerRequest); assert.ok(Date.parse(ownerRequest.at) >= Date.parse(restarted.at))
    const parameters = ownerRequest.rpc.params
    verifyRfc9421OriginProof(parameters.auth.origin_proof, 'group.send', { ...parameters.meta, target: { kind: 'group', did: grant.groupDid } }, { payload: afterQuery.request }, { didDocument: documents.get(grant.principal), options: { expectedSignerDid: grant.principal } })
    const newResponse = wire.find(row => row.direction === 'outbound' && row.request.method === 'group.send' && row.request.params.meta.target.did === grant.groupDid && isDeepStrictEqual(row.request.params.body.payload, afterQuery.response))
    assert.ok(newResponse); assert.ok(Date.parse(newResponse.at) >= Date.parse(restarted.at))
    assert.equal(newResponse.request.params.meta.sender_did, grant.homeDid)
    verifyRfc9421OriginProof(newResponse.request.params.auth.origin_proof, 'group.send', newResponse.request.params.meta, newResponse.request.params.body, { didDocument: documents.get(grant.homeDid), options: { expectedSignerDid: grant.homeDid } })
    const message = afterQuery.responseMessage
    assert.equal(message.group_did, grant.groupDid)
    assert.equal(message.operation_id, newResponse.request.params.meta.operation_id)
    assert.equal(message.message_id, newResponse.request.params.meta.message_id)
    assert.deepEqual(message.group_receipt, newResponse.response.result.group_receipt)
    const groupDocument = documents.get(grant.groupDid), selected = groupDocument.verificationMethod.find(row => row.id === message.group_receipt.proof.verificationMethod)
    assert.ok(groupDocument.assertionMethod.includes(selected.id))
    const signature = bs58.decode(message.group_receipt.proof.proofValue.slice(1)); assert.equal(signature.length, 64)
    assert.ok(verifyW3cProof({ ...message.group_receipt, proof: { ...message.group_receipt.proof, proofValue: Buffer.from(signature).toString('base64url') } }, extractPublicKey(selected), { expectedPurpose: 'assertionMethod' }))
    const oldRequests = (await lines(join(input.entryRoot, 'anp/responses.jsonl'))).filter(row => Date.parse(row.at) < Date.parse(kill.at))
    assert.ok(oldRequests.length)
    assert.ok(oldRequests.every(row => row.request.requestId !== afterQuery.request.requestId))
    const actualNewWireRequest = peerWire.find(row => row.method === 'POST' && row.requestBody && JSON.parse(row.requestBody).params?.body?.payload?.requestId === afterQuery.request.requestId)
    assert.ok(actualNewWireRequest)
    const rpc = JSON.parse(actualNewWireRequest.requestBody)
    const oldOriginalRpc = peerWire.filter(row => row.method === 'POST' && row.requestBody).map(row => JSON.parse(row.requestBody)).filter(row => row.params?.body?.payload?.schema === 'geneway.protocol-task/1' && row.params.body.payload.requestId !== afterQuery.request.requestId)
    assert.ok(oldOriginalRpc.every(row => row.params.meta.operation_id !== rpc.params.meta.operation_id && row.params.meta.message_id !== rpc.params.meta.message_id))
    queryProof = { newActualSignedQueryAfterNewProcessReady: true, freshRequestId: afterQuery.request.requestId, freshOperationId: rpc.params.meta.operation_id, freshMessageId: rpc.params.meta.message_id,
      actualNewCorrelatedHomeResponse: message.message_id, originalGroupAndPrincipalPreserved: true }
  }
  return { result: 'passed', scope: 'X07-business-entry-process-restart-only', candidate: input.candidate, task, processProof,
    originalEndpointAndIdentityBytesRecomputed: true, mappingUnchanged: true, actualOfflinePeerQueryFailedWithoutTask: true,
    originalBusinessAndModelRowsUnchangedDuringRestart: true, queryProof, parentOsContinuity, resumedOriginalNormalFlow: normal,
    boundary: 'retained real SIGKILL/exit/new process, same authorized Task/current Q and later original file delivery; parent OS continuity only where actual phase proc samples retained, not helper booleans. No cloud/GroupHost restart/full X07/whole hard-gate or winner claim' }
}
async function verifyRestartedAnpNormal(root, input, paths) {
  const read = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
  const lines = async file => (await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const responses = await lines(join(input.entryRoot, 'anp/responses.jsonl'))
  const requests = responses.map(row => row.request), grant = await read(join(input.entryRoot, 'anp/principal-grant.json'))
  const peerOutputs = await Promise.all(input.peerOutputs.map(row => read(row.outputFile)))
  const incoming = await lines(join(paths.home, 'incoming.jsonl')), wire = await lines(join(paths.home, 'wire.jsonl'))
  for (const row of responses) assert.ok(incoming.some(value => value.rpc.method === 'group.incoming' && value.rpc.params.meta.sender_did === grant.principal && value.rpc.params.meta.target.did === grant.homeDid && value.rpc.params.body.group_did === grant.groupDid && isDeepStrictEqual(value.rpc.params.body.payload, row.request)))
  for (const output of peerOutputs) {
    assert.equal(output.response.requestId, output.request.requestId)
    assert.equal(output.responseMessage.sender_did, grant.homeDid)
    assert.deepEqual(output.responseMessage.body.payload, output.response); assert.deepEqual(output.response.task, output.task)
    assert.ok(wire.some(value => value.direction === 'outbound' && value.request.method === 'group.send' && value.request.params.meta.target.did === grant.groupDid && isDeepStrictEqual(value.request.params.body.payload, output.response)))
  }
  const normal = verifyTaskLinkage({ candidate: 'anp', state: await read(join(input.businessRoot, 'completed-state.json')),
    mapping: await read(join(input.mappingRoot, 'protocol-mapping.json')), requests, peerOutputs,
    observations: await lines(join(input.mappingRoot, 'task-observations.jsonl')), businessEvents: await lines(join(input.mappingRoot, 'business-events.jsonl')),
    grant, downloadBytes: await readFile(join(root, input.downloadFile)) })
  const download = (await lines(join(input.entryRoot, 'anp/downloads.jsonl'))).findLast(row => row.taskId === normal.taskId)
  assert.deepEqual(download.globalRef, normal.globalArtifactRef); assert.equal(download.sha256, normal.globalArtifactRef.sha256); assert.equal(download.bytes, normal.actualDownloadedBytes)
  assert.equal(download.principal, grant.principal)
  const peerWire = await lines(join(paths.peer, 'wire.jsonl'))
  let owner
  for (const value of peerWire.filter(row => row.method === 'GET' && row.status === 200 && row.responseBody)) {
    try { const document = JSON.parse(value.responseBody); if (document.id === grant.principal) owner = document } catch {}
  }
  assert.ok(owner)
  const downloadedTask = peerOutputs.findLast(row => row.download).task
  verifyHttpMessageSignature(owner, 'GET', downloadedTask.artifacts[0].url, download.requestHeaders, '')
  const verifier = fileURLToPath(new URL('../../../scripts/verify-spreadsheet-collaboration-result.mjs', import.meta.url))
  const layer = await promisify(execFile)(process.execPath, [verifier, join(root, input.businessRoot)], { maxBuffer: 4 * 1024 * 1024 })
  assert.equal(JSON.parse(layer.stdout).result, 'passed')
  return { ...normal, originalD4FourSheetAndRawLedgerOracle: 'passed', actualOwnerSignedDownloadReverified: true,
    originalRecoveryHomeAndIndependentPeerPaths: paths, boundary: 'recovery child owns recovery-home/recovery-peer, not the unrelated five-role command relay Home; no old raw relocation or fictitious normal adapter state' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node oracle/recovery.mjs <runroot>')
  console.log(JSON.stringify(await verifyRecovery(process.argv[2]), null, 2))
}
