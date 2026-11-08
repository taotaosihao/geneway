import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { Task } from '@a2a-js/sdk'
import { verifyHttpMessageSignature, verifyRfc9421OriginProof } from '@awiki/anp-typescript-sdk'

const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const states = { 1: 'submitted', 2: 'working', 3: 'completed', 4: 'failed', 5: 'canceled', 6: 'input-required' }
const taskState = task => typeof task.state === 'string' ? task.state : states[task.status?.state]
const taskRef = artifact => artifact.globalRef ?? artifact.metadata?.globalRef

// 只读协议原件与原生产事实；mapping不能替代Work/Attempt/成果authority。
export function verifyTaskLinkage({ candidate, state, mapping, requests, peerOutputs, observations, businessEvents, grant, downloadBytes }) {
  assert.ok(['a2a', 'anp'].includes(candidate))
  assert.equal(mapping.schema, 'geneway.protocol-task-index/1')
  assert.equal(mapping.bindings.length, 1, '首次协议create必须只关联唯一原Work')
  const link = mapping.bindings[0]
  assert.ok(!['status', 'state', 'artifacts', 'currentRevision', 'question'].some(field => Object.hasOwn(link, field)), 'mapping不得成为第二业务状态权威')
  assert.equal(link.principal, grant.principal); assert.equal(link.businessActorId, grant.businessActorId)
  const work = state.works.find(row => row.id === link.workId), root = state.multisite.attempts.find(row => row.attempt_id === link.rootAttemptId)
  assert.ok(work && root); assert.equal(work.ownerMemberId, grant.businessActorId)
  assert.equal(root.work_id, work.id); assert.equal(root.delegation_id, link.rootDelegationId); assert.equal(root.parent_delegation_id, null)
  assert.equal(state.works.length, 1, '正常独立入口不得另造业务Work')
  assert.equal(state.multisite.attempts.filter(row => row.work_id === work.id).length, 5)
  const created = requests.filter(row => row.operation === 'create')
  assert.ok(created.length)
  assert.ok(created.every(row => row.clientRequestId === link.clientRequestId))
  assert.equal(link.requestDigest, hash(created[0].parameters))
  assert.equal(link.createCommandKey, 'protocol-create-' + hash(link.principal + '\0' + link.clientRequestId).slice(0, 32))
  assert.ok(state.multisite.commands.some(row => row.issuerId === grant.businessActorId && row.commandId === link.createCommandKey))
  const inputs = state.multisite.inputs.filter(row => row.workId === work.id)
  assert.deepEqual(inputs.map(row => row.revision).sort(), [1, 2, 3])
  const acceptedInputs = requests.filter(row => row.operation === 'input')
  assert.equal(acceptedInputs.length, 2)
  for (const [index, request] of acceptedInputs.entries()) {
    assert.equal(request.taskId, link.protocolTaskId); assert.equal(request.contextId, link.contextId)
    const key = 'protocol-input-' + hash(link.principal + '\0' + link.protocolTaskId + '\0' + request.clientRequestId).slice(0, 32)
    assert.ok(state.multisite.commands.some(row => row.commandId === key && row.issuerId === grant.businessActorId))
    const actual = inputs.find(row => row.revision === index + 2)
    assert.equal(actual.text, request.parameters.text)
    if (request.parameters.spreadsheetRequest?.dueDate) assert.equal(actual.spreadsheetRequest.dueDate, request.parameters.spreadsheetRequest.dueDate)
  }
  assert.ok(requests.some(row => row.operation === 'get'))
  assert.ok(peerOutputs.length >= 5)
  for (const output of peerOutputs) {
    const task = output.task
    assert.ok(task?.id && task.contextId && task.metadata?.geneway, '独立peer必须实际收到Task投影，非HTTP/群接纳ACK')
    assert.equal(task.id, link.protocolTaskId); assert.equal(task.contextId, link.contextId)
    const metadata = task.metadata.geneway
    assert.equal(metadata.workId, work.id); assert.equal(metadata.rootAttemptId, root.attempt_id); assert.equal(metadata.rootDelegationId, root.delegation_id)
    assert.ok(metadata.currentRevision >= 1 && metadata.currentRevision <= 3)
    assert.ok(metadata.businessReceipt && /^[a-f0-9]{64}$/.test(metadata.projectionDigest))
  }
  const waiting = peerOutputs.map(row => row.task).find(task => taskState(task) === 'input-required')
  assert.ok(waiting?.metadata.geneway.question?.id, '必须通过同Task get看到当前稳定问题')
  const answered = state.userQuestions.find(row => row.id === waiting.metadata.geneway.question.id)
  assert.ok(answered); assert.equal(answered.state, 'answered'); assert.equal(answered.answeredByInputId, inputs.find(row => row.revision === 2).id)
  assert.equal(waiting.metadata.geneway.currentRevision, 1)
  const completed = peerOutputs.map(row => row.task).findLast(task => taskState(task) === 'completed')
  assert.ok(completed); assert.equal(completed.metadata.geneway.currentRevision, 3)
  assert.equal(completed.metadata.geneway.workStatus, 'completed'); assert.equal(completed.metadata.geneway.rootAttemptStatus, 'completed')
  assert.equal(work.status, 'completed'); assert.equal(root.status, 'completed')
  const ready = state.artifacts.filter(row => row.workId === work.id && row.status === 'ready' && row.instructionRevision === 3)
  assert.equal(ready.length, 1); assert.equal(completed.artifacts.length, 1)
  const artifact = completed.artifacts[0], global = taskRef(artifact)
  assert.deepEqual(global, { id: ready[0].id, version: ready[0].version, sha256: ready[0].sha256 })
  assert.equal(artifact.artifactId, 'output-' + hash(link.protocolTaskId + '\0' + ready[0].id).slice(0, 24))
  assert.notEqual(artifact.artifactId, ready[0].id)
  assert.equal(hash(downloadBytes), ready[0].sha256); assert.equal(downloadBytes.length, ready[0].sizeBytes)
  const currentQuestion = work.pendingQuestion && state.userQuestions.find(row => row.id === work.pendingQuestion.id && row.state === 'open' && row.instructionRevision === work.instructionRevision)
  assert.equal(completed.metadata.geneway.projectionDigest, hash({ work, attempt: root, question: currentQuestion, ready }))
  assert.equal(businessEvents.filter(row => row.operation === 'create').length, 1)
  assert.equal(businessEvents.filter(row => row.operation === 'input').length, 2)
  assert.ok(businessEvents.every(row => row.principal === link.principal && row.protocolTaskId === link.protocolTaskId && row.workId === work.id))
  assert.ok(observations.some(row => row.task.id === link.protocolTaskId && taskState(row.task) === 'input-required'))
  assert.ok(observations.some(row => row.task.id === link.protocolTaskId && taskState(row.task) === 'completed'))
  if (candidate === 'anp') {
    assert.equal(grant.created.group_profile.discoverability, 'private')
    assert.equal(grant.created.group_policy.admission_mode, 'admin-add')
    assert.equal(String(grant.created.group_policy.max_members), '2')
    assert.equal(grant.created.group_policy.attachments_allowed, false)
  }
  return { result: 'passed', scope: 'standard-business-task-linkage-only', candidate, taskId: link.protocolTaskId, contextId: link.contextId,
    sourceWorkId: work.id, rootDelegationId: root.delegation_id, rootAttemptId: root.attempt_id,
    stableQuestionId: answered.id, finalRevision: 3, taskLocalArtifactId: artifact.artifactId, globalArtifactRef: global,
    actualDownloadedBytes: downloadBytes.length,
    boundary: 'pure retained peer Task/production state/index/byte linkage; not protocol conformance, fault recovery, native ANP Task or automatic protocol choice' }
}

// 入口清单只定位原始文件；不接受清单中的passed/status代替事实。
export async function verifyBusinessFlow(runRoot, input) {
  const root = resolve(runRoot)
  const read = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
  const lines = async file => (await readFile(join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const businessRoot = input.businessRoot, entryRoot = input.entryRoot, candidate = input.candidate
  const state = await read(join(businessRoot, 'completed-state.json'))
  const mapping = await read(join(input.mappingRoot, 'protocol-mapping.json'))
  const endpointRoot = candidate === 'a2a' ? join(entryRoot, 'a2a') : join(entryRoot, 'anp')
  const grant = await read(join(endpointRoot, 'principal-grant.json'))
  const observations = await lines(join(input.mappingRoot, 'task-observations.jsonl'))
  const businessEvents = await lines(join(input.mappingRoot, 'business-events.jsonl'))
  const peerOutputs = await Promise.all(input.peerOutputs.map(row => read(row.outputFile)))
  const peerConfigs = await Promise.all(input.peerOutputs.map(row => read(row.configFile)))
  let requests, wire, archivedPeerWire
  if (candidate === 'a2a') {
    wire = await lines(join(endpointRoot, 'wire.jsonl'))
    requests = wire.flatMap(row => {
      assert.equal(row.version, '1.0'); assert.equal(row.principal, grant.principal)
      assert.equal(row.request.jsonrpc, '2.0'); assert.equal(row.response.id, row.request.id)
      if (row.request.method === 'GetTask') { assert.equal(row.request.params.id, mapping.bindings[0].protocolTaskId); return [{ operation: 'get' }] }
      assert.equal(row.request.method, 'SendMessage'); assert.equal(row.request.params.message.role, 'ROLE_USER')
      const payload = row.request.params.message.parts.find(part => part.data)?.data
      assert.equal(payload.schema, 'geneway.protocol-task/1')
      return [{ ...payload, taskId: row.request.params.message.taskId, contextId: row.request.params.message.contextId }]
    })
    for (const [index, config] of peerConfigs.entries()) {
      assert.equal(config.operation, input.peerOutputs[index].operation)
      if (config.operation === 'get' || config.operation === 'download') assert.ok(wire.some(row => row.request.method === 'GetTask' && row.response.result?.id === peerOutputs[index].task.id && isDeepStrictEqual(JSON.parse(JSON.stringify(Task.fromJSON(row.response.result))), peerOutputs[index].task)))
      else assert.ok(wire.some(row => row.request.method === 'SendMessage' && row.request.params.message.messageId === config.clientRequestId && row.response.result?.task?.id === peerOutputs[index].task.id && isDeepStrictEqual(JSON.parse(JSON.stringify(Task.fromJSON(row.response.result.task))), peerOutputs[index].task)))
    }
  } else {
    const responses = await lines(join(endpointRoot, 'responses.jsonl'))
    requests = responses.map(row => row.request)
    const incoming = await lines(join(input.relayRoot, 'home/incoming.jsonl'))
    wire = await lines(join(input.relayRoot, 'home/wire.jsonl'))
    archivedPeerWire = await lines(join(input.relayRoot, 'independent-group-peer/wire.jsonl'))
    for (const row of responses) {
      assert.equal(row.principal, grant.principal)
      assert.ok(incoming.some(record => record.rpc.method === 'group.incoming' && record.rpc.params.body.group_did === grant.groupDid && record.rpc.params.meta.sender_did === grant.principal && record.rpc.params.meta.target.did === grant.homeDid && isDeepStrictEqual(record.rpc.params.body.payload, row.request)), '缺真正private域/原owner到Home的请求')
    }
    for (const output of peerOutputs) {
      assert.equal(output.response.schema, 'geneway.protocol-task-response/1')
      assert.equal(output.response.requestId, output.request.requestId)
      assert.equal(output.responseMessage.sender_did, grant.homeDid)
      assert.deepEqual(output.responseMessage.body.payload, output.response)
      assert.deepEqual(output.response.task, output.task)
      assert.ok(wire.some(record => record.direction === 'outbound' && record.request.method === 'group.send' && record.request.params.meta.target.did === grant.groupDid && isDeepStrictEqual(record.request.params.body.payload, output.response)), '必须有主动查询得到的实际群Task响应')
    }
  }
  const result = verifyTaskLinkage({ candidate, state, mapping, requests, peerOutputs, observations, businessEvents, grant, downloadBytes: await readFile(join(root, input.downloadFile)) })
  const peerDownload = peerOutputs.findLast(row => row.download)?.download
  assert.ok(peerDownload); assert.equal(peerDownload.sha256, result.globalArtifactRef.sha256)
  assert.equal(peerDownload.size ?? peerDownload.sizeBytes, result.actualDownloadedBytes)
  const downloads = await lines(join(endpointRoot, 'downloads.jsonl'))
  const downloaded = downloads.findLast(row => row.taskId === result.taskId && row.artifactId === result.taskLocalArtifactId)
  assert.ok(downloaded); assert.equal(downloaded.principal, grant.principal)
  assert.deepEqual(downloaded.globalRef, result.globalArtifactRef)
  assert.equal(downloaded.sha256, result.globalArtifactRef.sha256); assert.equal(downloaded.bytes, result.actualDownloadedBytes)
  let downloadAuthentication = 'retained opaque principal grant and authenticated download record', retainedWarnings = [], signedOwnerRequests = 0
  if (candidate === 'anp') {
    assert.ok(downloaded.requestHeaders['signature-input'] && downloaded.requestHeaders.signature)
    let document
    for (const record of archivedPeerWire.filter(row => row.method === 'GET' && row.status === 200 && row.responseBody)) {
      try { const value = JSON.parse(record.responseBody); if (value.id === grant.principal) document = value } catch {}
    }
    if (document) {
      const url = peerOutputs.findLast(row => row.download)?.task.artifacts[0].url
      assert.ok(url)
      verifyHttpMessageSignature(document, 'GET', url, downloaded.requestHeaders, '')
      const incoming = await lines(join(input.relayRoot, 'home/incoming.jsonl'))
      for (const request of requests) {
        const record = incoming.find(row => row.rpc.method === 'group.incoming' && row.rpc.params.body.group_did === grant.groupDid && row.rpc.params.meta.sender_did === grant.principal && row.rpc.params.meta.target.did === grant.homeDid && isDeepStrictEqual(row.rpc.params.body.payload, request))
        const { meta, auth, body } = record.rpc.params
        verifyRfc9421OriginProof(auth.origin_proof, 'group.send', { ...meta, target: { kind: 'group', did: body.group_did } }, { payload: body.payload }, { didDocument: document, options: { expectedSignerDid: grant.principal } })
        signedOwnerRequests++
      }
      downloadAuthentication = 'original signed GET independently verified against archived principal DID document'
    } else downloadAuthentication = 'signed GET headers retained; archived principal public DID not located, independent signature recheck not-run'
  }
  if (candidate === 'anp') {
    let rejected
    try { rejected = await lines(join(input.relayRoot, 'home/rejected.jsonl')) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; rejected = [] }
    for (const row of rejected) {
      const rpc = JSON.parse(row.requestBody)
      assert.equal(rpc.method, 'group.incoming')
      assert.equal(rpc.params.body.group_did, grant.groupDid)
      assert.equal(rpc.params.body.payload.schema, 'geneway.protocol-task-response/1')
      assert.equal(rpc.params.meta.sender_did, grant.homeDid); assert.equal(rpc.params.meta.target.did, grant.homeDid)
      const retried = wire.find(value => value.direction === 'inbound' && value.status === 204 && isDeepStrictEqual(value.request, rpc) && Date.parse(value.at) >= Date.parse(row.at))
      assert.ok(retried, '保留warning必须有后续真实duplicate204，不改为零error')
      retainedWarnings.push({ at: row.at, method: rpc.method, requestId: rpc.params.body.payload.requestId, classification: 'home-own-response-owner-only-listener-rejected-then-duplicate204' })
    }
  }
  const originalOracle = fileURLToPath(new URL('../../../scripts/verify-spreadsheet-collaboration-result.mjs', import.meta.url))
  const layer = await promisify(execFile)(process.execPath, [originalOracle, join(root, businessRoot)], { maxBuffer: 4 * 1024 * 1024 })
  assert.equal(JSON.parse(layer.stdout).result, 'passed')
  return { ...result, originalD4FourSheetAndRawLedgerOracle: 'passed', downloadAuthentication, signedOwnerRequests, retainedWarnings,
    protocolDescription: candidate === 'anp' ? 'signed application task.create/input/get over private group, not ANP-native Task' : 'official A2A SendMessage/GetTask same Task/context and Task-local artifact' }
}
export async function compareBusinessFlowOutputs(runRoots) {
  assert.equal(runRoots.length, 2)
  const results = [], normalized = [], environments = []
  for (const runRoot of runRoots) {
    const root = resolve(runRoot), read = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
    const input = await read('business-oracle-input.json')
    results.push(await verifyBusinessFlow(root, input))
    const state = await read(join(input.businessRoot, 'completed-state.json'))
    const environment = await read('normal-manifest.json')
    environments.push({ node: environment.node, platform: environment.platform, arch: environment.arch, fixtureSha256: environment.fixtureSha256 })
    const bytes = await readFile(join(root, input.downloadFile)), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes)
    const manifest = JSON.parse(Array.from({ length: book.worksheets[3].rowCount - 1 }, (_, index) => book.worksheets[3].getCell(index + 2, 2).value).join(''))
    const sourceKinds = new Map(manifest.sources.map(source => [source.ref.id, source.kind]))
    const site = new Map()
    for (let index = 2; index <= book.worksheets[1].rowCount; index++) {
      const row = book.worksheets[1].getRow(index), name = row.getCell(2).value
      if (name !== 'observedAt') site.set(name, (site.get(name) ?? '') + row.getCell(3).value)
    }
    const analysis = state.multisite.results.find(row => row.id === manifest.analysis.resultId).payload
    normalized.push({
      originalHistoryBytes: hash(await readFile(join(root, input.businessRoot, 'pc-a/source/source.json'))),
      originalSiteBytes: hash(await readFile(join(root, input.businessRoot, 'gateway/source/source.json'))),
      originalPhotoBytes: hash(await readFile(join(root, input.businessRoot, '现场模拟照片.png'))),
      historyBusinessCells: Array.from({ length: book.worksheets[0].rowCount }, (_, row) => Array.from({ length: 6 }, (_, column) => book.worksheets[0].getCell(row + 1, column + 1).value ?? null)),
      siteFields: [...site], analysis: { ...analysis, evidenceRefs: analysis.evidenceRefs.map(ref => sourceKinds.get(ref.id)), findings: analysis.findings.map(finding => ({ ...finding, basis: finding.basis.map(basis => ({ ...basis, evidenceRef: sourceKinds.get(basis.evidenceRef.id) })) })) },
      manifest: { version: manifest.version, dueDate: manifest.dueDate, instructionRevision: manifest.instructionRevision, rowMap: manifest.rowMap, sources: manifest.sources.map(source => ({ kind: source.kind, producerRevision: source.producerRevision })) },
    })
  }
  assert.deepEqual(results.map(result => result.candidate), ['a2a', 'anp'])
  assert.deepEqual(environments[0], environments[1]); assert.deepEqual(normalized[0], normalized[1])
  return { result: 'passed', scope: 'two-standard-business-entry-normal-semantics-only', candidates: results,
    originalInputBytesAndNormalizedBusinessOutputsEqual: true, environment: environments[0],
    boundary: 'per-root IDs/ZIP hashes legitimately differ; no full hard-gate/fault/conformance/cost scoring or protocol winner' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node oracle/business-flow.mjs <runroot> [input-manifest.json]')
  const root = resolve(process.argv[2]), input = JSON.parse(await readFile(join(root, process.argv[3] ?? 'business-oracle-input.json'), 'utf8'))
  console.log(JSON.stringify(await verifyBusinessFlow(root, input), null, 2))
}
