import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import ExcelJS from 'exceljs'
import bs58 from 'bs58'
import { verifyW3cProof, extractPublicKey, verifyRfc9421OriginProof } from '@awiki/anp-typescript-sdk'
import { binding, digest } from '../../../packages/agent-contracts/index.mjs'

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async (root, name) => JSON.parse(await readFile(join(root, name), 'utf8'))
const lines = async (root, name) => (await readFile(join(root, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const defaults = [
  '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-normal-baseline-XaPHmr/business-Afdh2i',
  '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-normal-a2a-HxKBac/business-oKujmV',
  '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-normal-anp-mO7M8c/business-ZcbzOJ',
]
function appFacts(state, request, response) {
  const persisted = state.multisite.commands.find(row => row.issuerKind === 'agent' && row.issuerId === request.binding.attempt_id && row.commandId === request.parameters.clientRequestId)
  assert.ok(persisted, '缺生产受理回执:' + request.operation)
  assert.deepEqual(persisted.senderBinding, request.binding)
  assert.equal(persisted.digest, digest({ operation: request.operation, parameters: request.parameters }))
  assert.equal(response.status, 200); assert.deepEqual(persisted.reply, response.body)
  const attempt = state.multisite.attempts.find(row => row.attempt_id === request.binding.attempt_id)
  assert.deepEqual(binding(attempt), request.binding)
}
async function business(root) {
  const parent = dirname(root), manifest = await json(parent, 'normal-manifest.json')
  const verified = await exec(process.execPath, [join(repository, 'scripts/verify-spreadsheet-collaboration-result.mjs'), root], { maxBuffer: 4 * 1024 * 1024 })
  assert.equal(JSON.parse(verified.stdout).result, 'passed')
  const state = await json(root, 'completed-state.json'), oracle = await json(root, 'oracle.json')
  const historyBytes = await readFile(join(root, 'pc-a/source/source.json')), siteBytes = await readFile(join(root, 'gateway/source/source.json'))
  const photo = await readFile(join(root, '现场模拟照片.png'))
  assert.equal(oracle.history.length, 20); assert.equal(oracle.site.events.length, 20)
  assert.deepEqual(JSON.parse(historyBytes).entries, oracle.history); assert.deepEqual(JSON.parse(siteBytes).events, oracle.site.events)
  const artifact = state.artifacts.find(row => row.status === 'ready'), work = state.works.find(row => row.id === artifact.workId)
  const job = state.multisite.jobs.find(row => row.id === artifact.jobId)
  assert.equal(work.status, 'completed'); assert.equal(work.instructionRevision, 3)
  assert.equal(state.multisite.attempts.length, 5)
  const book = new ExcelJS.Workbook(); const download = await readFile(join(root, '下载多来源整改表.xlsx')); await book.xlsx.load(download)
  assert.equal(hash(download), artifact.sha256)
  assert.equal(hash(await readFile(join(root, 'api/artifacts', artifact.id))), artifact.sha256)
  assert.equal(hash(await readFile(join(root, 'pc-b/spreadsheet-jobs', job.id, 'incident-register.xlsx'))), artifact.sha256)
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['整改明细', '现场快照', '分析结论', '来源依据'])
  const actualManifest = JSON.parse(Array.from({ length: book.worksheets[3].rowCount - 1 }, (_, i) => book.worksheets[3].getCell(i + 2, 2).value).join(''))
  assert.deepEqual(actualManifest, job.sourceManifest)
  assert.equal(digest(actualManifest), artifact.manifestDigest)
  const sourceNames = new Map(actualManifest.sources.map(source => [source.ref.id, source.kind]))
  const analysis = state.multisite.results.find(row => row.id === actualManifest.analysis.resultId).payload
  const normalized = {
    historyCells: Array.from({ length: book.worksheets[0].rowCount }, (_, i) => Array.from({ length: 6 }, (_, j) => book.worksheets[0].getCell(i + 1, j + 1).value ?? null)),
    site: { health: oracle.site.health, events: oracle.site.events },
    analysis: { summary: analysis.summary, limitations: analysis.limitations, findings: analysis.findings.map(finding => ({ ...finding, basis: finding.basis.map(basis => ({ ...basis, evidenceRef: sourceNames.get(basis.evidenceRef.id) })) })) },
    manifest: { version: actualManifest.version, instructionRevision: actualManifest.instructionRevision, dueDate: actualManifest.dueDate, rowMap: actualManifest.rowMap, sourceKinds: actualManifest.sources.map(row => row.kind), analysisProducerRevision: actualManifest.analysis.producerRevision },
  }
  let sourceSnapshot = 'not-retained-for-baseline'
  if (manifest.candidate !== 'baseline') {
    const copies = await json(parent, 'source-files.json')
    for (const file of copies) { const bytes = await readFile(join(parent, 'source-copies', file.path)); assert.equal(hash(bytes), file.sha256); assert.equal(bytes.length, file.bytes) }
    const fixtureCopy = await readFile(join(parent, 'runtime-source/probe-spreadsheet-collaboration.mjs'))
    assert.ok(fixtureCopy.length)
    sourceSnapshot = 'startup-experiment-copies-verified; runtime fixture is the explicitly patched transport derivative'
  }
  assert.equal(hash(await readFile(manifest.fixturePath)), manifest.fixtureSha256, '当前可读原fixture必须吻合原manifest SHA；不补拍baseline历史源码')
  return { root, parent, manifest, state, normalized, hashes: { history: hash(historyBytes), site: hash(siteBytes), photo: hash(photo) },
    summary: { candidate: manifest.candidate, modelRequests: state.modelRequests.length, candidatePages: state.spreadsheetReads.length, artifactSha256: artifact.sha256, sourceSnapshot } }
}
async function verifyA2a(flow) {
  const rows = await lines(flow.parent, 'relay/application-wire.jsonl')
  assert.ok(rows.length)
  for (const row of rows) {
    assert.equal(row.request.method, 'SendMessage'); assert.equal(row.request.params.message.role, 'ROLE_USER')
    assert.equal(row.request.jsonrpc, '2.0'); assert.equal(row.response.id, row.request.id)
    const request = row.request.params.message.parts[0].data, response = row.response.result.message.parts[0].data
    appFacts(flow.state, request, response)
    assert.equal(row.requestBytes, Buffer.byteLength(JSON.stringify(row.request)))
    assert.equal(row.responseBytes, Buffer.byteLength(JSON.stringify(row.response)))
  }
  return { exchanges: rows.length, actualProductionAgentReceiptsMatched: rows.length, roleUserIsNotHumanAuthorization: true,
    boundary: 'retained application JSON-RPC body and production agent binding/digest/reply; no unseen SDK response internals or negative conformance claim' }
}
async function verifyAnp(flow) {
  const root = join(flow.parent, 'relay'), runtime = await json(flow.parent, 'relay-runtime.json')
  assert.notEqual(runtime.pid, runtime.peerPid)
  const group = await json(root, 'group.json'), wire = await lines(root, 'home/wire.jsonl'), incoming = await lines(root, 'home/incoming.jsonl')
  const peerWire = await lines(root, 'independent-group-peer/wire.jsonl'), applications = await lines(root, 'application-wire.jsonl')
  const sends = wire.filter(row => row.direction === 'outbound' && row.request.method === 'group.send')
  const docs = new Map()
  for (const role of ['coordinator', 'desktop-office', 'desktop-data', 'gateway', 'analysis']) { const file = await json(root, `home/${role}-identity.json`); docs.set(file.didDocument.id, file.didDocument) }
  let groupDocument
  for (const row of peerWire.filter(row => row.method === 'GET' && row.path.endsWith('/did.json') && row.status === 200)) {
    const document = JSON.parse(row.responseBody); if (document.id === group.groupDid) groupDocument = document
  }
  assert.ok(groupDocument)
  const db = new DatabaseSync(join(root, 'independent-group-peer/data/awiki-open-server.sqlite3'), { readOnly: true })
  let persisted
  try { persisted = db.prepare('SELECT message_id, sender_did, body_json, receipt_json FROM hosted_group_messages ORDER BY group_event_seq').all() } finally { db.close() }
  assert.equal(sends.length, applications.length * 2)
  const payloads = sends.map(row => row.request.params.body.payload)
  assert.equal(new Set(payloads.filter(row => row.kind === 'geneway.command.request/1').map(row => row.requestId)).size, applications.length)
  assert.equal(new Set(payloads.filter(row => row.kind === 'geneway.command.response/1').map(row => row.responseRef)).size, applications.length)
  for (const [index, payload] of payloads.entries()) {
    assert.ok(['geneway.command.request/1', 'geneway.command.response/1'].includes(payload.kind))
    assert.deepEqual(Object.keys(payload).sort(), (payload.kind.endsWith('request/1') ? ['kind', 'requestId', 'actor', 'commandDigest'] : ['kind', 'requestId', 'actor', 'commandDigest', 'responseRef']).sort())
    assert.deepEqual(Object.keys(sends[index].request.params.body), ['payload'])
    const sent = sends[index], retained = persisted.find(row => row.message_id === sent.request.params.meta.message_id)
    assert.ok(retained); assert.deepEqual(JSON.parse(retained.body_json), sent.request.params.body)
    assert.equal(retained.sender_did, sent.request.params.meta.sender_did)
    const independentWire = peerWire.find(row => row.method === 'POST' && row.requestBody && JSON.parse(row.requestBody).id === sent.request.id)
    assert.ok(independentWire); assert.deepEqual(JSON.parse(independentWire.requestBody), sent.request)
  }
  let authenticatedDeliveries = 0
  for (const application of applications) {
    appFacts(flow.state, application.request, application.response)
    assert.equal(application.requestBytes, Buffer.byteLength(JSON.stringify(application.request)))
    assert.equal(application.responseBytes, Buffer.byteLength(JSON.stringify(application.response)))
    const actor = application.request.binding.agent_id, digestValue = hash(JSON.stringify(application.request))
    const requests = sends.filter(row => { const value = row.request.params.body.payload; return value.kind === 'geneway.command.request/1' && value.commandDigest === digestValue && value.actor === actor })
    assert.equal(requests.length, 1)
    const request = requests[0], payload = request.request.params.body.payload
    const response = sends.find(row => row.request.params.body.payload.kind === 'geneway.command.response/1' && row.request.params.body.payload.requestId === payload.requestId)
    assert.ok(response); assert.equal(response.request.params.body.payload.commandDigest, digestValue)
    assert.equal(response.request.params.body.payload.actor, actor)
    assert.ok(response.request.params.body.payload.responseRef)
    for (const [sent, targetActor, senderActor] of [[request, 'coordinator', actor], [response, actor, 'coordinator']]) {
      assert.equal(sent.request.params.meta.sender_did, group.memberDids[senderActor])
      const delivered = incoming.find(row => row.rpc.method === 'group.incoming' && row.rpc.params.meta.message_id === sent.request.params.meta.message_id && row.rpc.params.meta.target.did === group.memberDids[targetActor])
      assert.ok(delivered, '必须真实送到目标role，不只group接纳')
      const { meta, body, auth } = delivered.rpc.params
      assert.equal(meta.sender_did, group.memberDids[senderActor]); assert.deepEqual(body.payload, sent.request.params.body.payload)
      const originalMeta = { ...meta, target: { kind: 'group', did: body.group_did } }, originalBody = { payload: body.payload }
      verifyRfc9421OriginProof(auth.origin_proof, 'group.send', originalMeta, originalBody, { didDocument: docs.get(meta.sender_did), options: { expectedSignerDid: meta.sender_did } })
      const receipt = body.group_receipt, method = groupDocument.verificationMethod.find(row => row.id === receipt.proof.verificationMethod)
      assert.ok(groupDocument.assertionMethod.includes(method.id))
      const signature = bs58.decode(receipt.proof.proofValue.slice(1)); assert.equal(signature.length, 64)
      const copy = { ...receipt, proof: { ...receipt.proof, proofValue: Buffer.from(signature).toString('base64url') } }
      assert.ok(verifyW3cProof(copy, extractPublicKey(method), { expectedPurpose: 'assertionMethod' }))
      assert.equal(receipt.actor_did, meta.sender_did); assert.equal(receipt.operation_id, meta.operation_id)
      authenticatedDeliveries++
    }
  }
  const publicGroupBytes = JSON.stringify({ wire, incoming, peerWire, persisted })
  for (const node of ['cloud', 'pc-b', 'pc-a', 'gateway', 'analysis']) {
    const identity = await json(flow.root, `${node}/node-identity.json`)
    assert.equal(publicGroupBytes.includes(identity.credential), false, 'Node credential不能进入群')
  }
  return { exchanges: applications.length, publicReferenceMessages: sends.length, authenticatedTargetDeliveries: authenticatedDeliveries,
    payloadFieldAllowlistExact: true, privateCommandOnlyMatchesGroupDigest: true, durableProductionRepliesMatched: true,
    boundary: 'references only in group; request/reply data joined by requestId, exact command hash, actor, authenticated sender and actual target incoming plus production receipt. Pending memory itself is not archived; no claimed independent HTTP-header verification or fake-ACK negative test' }
}

export async function verifyNormalFlows(roots) {
  assert.equal(roots.length, 3)
  const flows = []
  for (const root of roots) flows.push(await business(resolve(root)))
  assert.deepEqual(flows.map(row => row.manifest.candidate), ['baseline', 'a2a', 'anp'])
  for (const flow of flows.slice(1)) {
    for (const field of ['fixtureSha256', 'node', 'platform', 'arch']) assert.equal(flow.manifest[field], flows[0].manifest[field])
    assert.deepEqual(flow.hashes, flows[0].hashes)
    assert.deepEqual(flow.normalized, flows[0].normalized)
  }
  const a2a = await verifyA2a(flows[1]), anp = await verifyAnp(flows[2])
  return { result: 'passed', scope: 'normal-five-role-file-flow-only', commonFixtureSha256: flows[0].manifest.fixtureSha256,
    sourceHashes: flows[0].hashes, normalizedBusinessResultsEqual: true, candidates: flows.map(row => row.summary), a2a, anp,
    hardGatesAndFaultMatrix: 'not-run', eligibleForScoring: false, winner: null,
    boundary: 'read-only actual normal-run artifacts and original oracle layer; different model counts and artifact hashes allowed. Experimental command wire over production Bridge/model/file authority, not complete protocol migration/T03b or release approval' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyNormalFlows(process.argv.length > 2 ? process.argv.slice(2) : defaults), null, 2))
