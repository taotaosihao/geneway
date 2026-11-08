import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { verifyW3cProof, extractPublicKey } from '../node_modules/@awiki/anp-typescript-sdk/dist/index.js'

const read = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'))
const lines = async (root, path) => (await readFile(join(root, path), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const canonical = value => JSON.stringify(normalize(value))
function normalize(value) { return Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value }
const hash = value => createHash('sha256').update(value).digest()
function base58(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const char of value) { const index = alphabet.indexOf(char); assert.ok(index >= 0); number = number * 58n + BigInt(index) }
  let hex = number.toString(16); if (hex.length % 2) hex = '0' + hex
  return Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), number === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')])
}
function key(document, methodId, relationship) {
  const method = document.verificationMethod.find(row => row.id === methodId)
  assert.ok(method); assert.ok(document[relationship].includes(methodId))
  const encoded = base58(method.publicKeyMultibase.slice(1))
  assert.equal(method.publicKeyMultibase[0], 'z'); assert.deepEqual(encoded.subarray(0, 2), Buffer.from([0xed, 0x01])); assert.equal(encoded.length, 34)
  return { method, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), encoded.subarray(2)]), type: 'spki', format: 'der' }) }
}
function dataProof(document, didDocument, multibase = false) {
  const { proof, ...payload } = document, { proofValue, ...options } = proof
  assert.equal(proof.type, 'DataIntegrityProof'); assert.equal(proof.cryptosuite, 'eddsa-jcs-2022')
  const signature = multibase ? base58(proofValue.slice(1)) : Buffer.from(proofValue, 'base64url')
  if (multibase) assert.equal(proofValue[0], 'z')
  assert.equal(signature.length, 64)
  const selected = key(didDocument, proof.verificationMethod, 'assertionMethod')
  const input = Buffer.concat([hash(canonical(options)), hash(canonical(payload))])
  assert.ok(verify(null, input, selected.publicKey, signature), '独立Ed25519/JCS签名失败')
  // SDK通用W3C验证器仅接受base64url；验证副本只换编码，不改原protected payload/options。
  const copy = { ...payload, proof: { ...options, proofValue: signature.toString('base64url') } }
  assert.deepEqual(Object.fromEntries(Object.entries(copy).filter(([name]) => name !== 'proof')), payload)
  assert.deepEqual(Object.fromEntries(Object.entries(copy.proof).filter(([name]) => name !== 'proofValue')), options)
  assert.ok(verifyW3cProof(copy, extractPublicKey(selected.method), { expectedPurpose: 'assertionMethod' }))
  assert.equal(verify(null, Buffer.concat([hash(canonical(options)), hash(canonical({ ...payload, oracleTamper: true }))]), selected.publicKey, signature), false)
  return { verificationMethod: proof.verificationMethod, signatureBytes: 64, protectedPayloadAndOptionsUnchanged: true }
}
function originProof(proof, method, meta, body, document) {
  const expectedDigest = `sha-256=:${hash(canonical({ method, meta, body })).toString('base64')}:`
  assert.equal(proof.contentDigest, expectedDigest)
  const input = /^sig1=(\("@method" "@target-uri" "content-digest"\);.+)$/.exec(proof.signatureInput)
  assert.ok(input)
  const methodId = /;keyid="([^"]+)"/.exec(input[1])?.[1]
  assert.ok(methodId?.startsWith(meta.sender_did + '#'))
  const target = encodeURIComponent(meta.target.did).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  const signatureBase = `"@method": ${method}\n"@target-uri": anp://${meta.target.kind}/${target}\n"content-digest": ${expectedDigest}\n"@signature-params": ${input[1]}`
  const signature = /^sig1=:([^:]+):$/.exec(proof.signature)?.[1]
  assert.ok(signature)
  assert.ok(verify(null, Buffer.from(signatureBase), key(document, methodId, 'authentication').publicKey, Buffer.from(signature, 'base64')))
  return { signerDid: meta.sender_did, noncePresent: /;nonce=/.test(input[1]), boundary: 'archive cryptographic binding only; no live freshness/replay-cache claim' }
}

export async function verifyA2aPreflight(root) {
  const adapter = await read(root, 'adapter-process/process-start.json'), peer = await read(root, 'peer-process/process-start.json')
  assert.notEqual(adapter.identity.pid, peer.identity.pid); assert.ok(adapter.identity.startTicks && peer.identity.startTicks)
  assert.match(adapter.entry, /adapters\/a2a\/server\.mjs$/); assert.match(peer.entry, /peers\/a2a\/run\.mjs$/)
  const card = await read(root, 'adapter/agent-card.json')
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0'); assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC')
  const certificate = new X509Certificate(await readFile(join(root, 'tls/server.cert.pem')))
  assert.ok(certificate.checkIP('127.0.0.1'))
  const forward = await lines(root, 'adapter-to-peer-wire.jsonl')
  assert.ok(forward.every(row => row.status === 200 && row.headers['a2a-version'] === '1.0' && new URL(row.url).protocol === 'https:'))
  const send = forward.map(row => row.requestBody && JSON.parse(row.requestBody)).find(row => row?.method === 'SendMessage')
  const get = forward.map(row => row.requestBody && JSON.parse(row.requestBody)).find(row => row?.method === 'GetTask')
  assert.ok(send && get)
  const tasks = await read(root, 'peer/tasks.json'), task = tasks.tasks.find(row => row.task.id === get.params.id).task
  const execution = `peer/executions/${task.id}`
  const input = await read(root, execution + '/input.json'), identity = await read(root, execution + '/identity.json')
  const output = await read(root, execution + '/result.json'), effects = await lines(root, execution + '/effects.jsonl')
  assert.notEqual(identity.pid, peer.identity.pid); assert.ok(identity.startTicks)
  assert.equal(input.taskId, task.id); assert.equal(task.history[0].messageId, send.params.message.messageId)
  assert.equal(input.text, send.params.message.parts[0].text)
  assert.equal(effects.length, 3); assert.deepEqual(effects.map(row => row.sequence), [1, 2, 3])
  assert.ok(effects.every(row => row.pid === identity.pid && row.taskId === task.id && row.inputDigest === input.inputDigest))
  assert.equal(output.outcome, 'completed'); assert.equal(output.effects, effects.length); assert.equal(output.inputDigest, input.inputDigest)
  assert.equal(task.status.state, 3); assert.equal(task.artifacts[0].parts[0].content.value, output.output)
  const reverse = await lines(root, 'adapter/wire.jsonl')
  assert.equal(reverse.length, 1)
  assert.equal(reverse[0].request.method, 'SendMessage'); assert.equal(reverse[0].response.id, reverse[0].request.id)
  assert.equal(reverse[0].response.result.message.parts[0].data.echo, reverse[0].request.params.message.parts[0].text)
  return { protocol: 'a2a', minimalInterop: 'passed-for-retained-wire-and-durable-executor-facts', independentProcesses: [adapter.identity.pid, peer.identity.pid, identity.pid],
    actualExecutorEffects: effects.length, taskId: task.id, reverseWireBodyVerified: true,
    notRun: ['forward SendMessage/GetTask response body not retained; Task file is not raw response', 'full X01-X10 and hard gates', 'normal five-role/file business flow', 'TLS client certificate-validation policy independent verification'] }
}

export async function verifyAnpPreflight(root) {
  const process = await read(root, 'process-start.json'), peer = await read(root, 'peer/process-ready.json')
  assert.notEqual(process.adapterPid, process.peerPid); assert.equal(peer.pid, process.peerPid)
  const docs = new Map()
  for (const role of ['service', 'owner', 'coordinator', 'desktop-data', 'gateway', 'desktop-office', 'analysis']) {
    const identity = await read(root, `adapter/${role}-identity.json`); docs.set(identity.didDocument.id, identity.didDocument)
  }
  const service = await read(root, 'peer/service-did-document.json'); docs.set(service.id, service)
  const peerWire = await lines(root, 'peer/wire.jsonl')
  for (const row of peerWire.filter(row => row.method === 'GET' && row.status === 200 && row.path.endsWith('/did.json'))) {
    const document = JSON.parse(row.responseBody); docs.set(document.id, document)
  }
  for (const document of docs.values()) dataProof(document, document)
  const wire = await lines(root, 'adapter/wire.jsonl'), inbound = await lines(root, 'adapter/incoming.jsonl')
  const originChecks = [], receipts = new Map()
  for (const row of wire.filter(row => row.direction === 'outbound')) {
    assert.equal(row.status, 200); assert.equal(row.response.jsonrpc, '2.0'); assert.equal(row.request.jsonrpc, '2.0')
    assert.equal(row.request.id, row.response.id)
    if (row.request.params.auth?.origin_proof) originChecks.push(originProof(row.request.params.auth.origin_proof, row.request.method, row.request.params.meta, row.request.params.body, docs.get(row.request.params.meta.sender_did)))
    const receipt = row.response.result?.group_receipt
    if (receipt) { dataProof(receipt, docs.get(receipt.group_did), true); receipts.set(receipt.operation_id, receipt) }
    const peerRecord = peerWire.find(record => record.method === 'POST' && record.requestBody && JSON.parse(record.requestBody).id === row.request.id)
    assert.ok(peerRecord); assert.deepEqual(JSON.parse(peerRecord.requestBody), row.request)
    assert.deepEqual(JSON.parse(peerRecord.responseBody), Object.fromEntries(Object.entries(row.response).filter(([name]) => name !== 'httpStatus')))
  }
  assert.ok(wire.some(row => row.request.method === 'group.join')); assert.ok(wire.some(row => row.request.method === 'group.get_info')); assert.ok(wire.some(row => row.request.method === 'group.send'))
  for (const row of inbound) {
    const recorded = wire.find(value => value.direction === 'inbound' && canonical(value.request) === canonical(row.rpc))
    assert.ok(recorded); assert.equal(recorded.status, 204)
  }
  const messages = inbound.filter(row => row.rpc.method === 'group.incoming')
  assert.equal(messages.length, 2)
  for (const row of messages) {
    const { meta, body, auth } = row.rpc.params
    dataProof(body.group_receipt, docs.get(body.group_did), true)
    const originalMeta = { ...meta, target: { kind: 'group', did: body.group_did } }
    const originalBody = Object.fromEntries(Object.entries(body).filter(([name]) => !['group_did', 'group_state_version', 'group_event_seq', 'accepted_at', 'group_receipt'].includes(name)))
    originChecks.push(originProof(auth.origin_proof, 'group.send', originalMeta, originalBody, docs.get(meta.sender_did)))
    assert.equal(body.group_receipt.actor_did, meta.sender_did)
    const group = docs.get(body.group_did), hostService = group.service.find(value => value.type === 'ANPMessageService').serviceDid
    assert.equal(row.httpSignerDid, hostService) // identity binding only, not signature revalidation.
  }
  const db = new DatabaseSync(join(root, 'peer/data/awiki-open-server.sqlite3'), { readOnly: true })
  let stored
  try { stored = db.prepare('SELECT message_id, sender_did, operation_id, body_json, receipt_json FROM hosted_group_messages ORDER BY group_event_seq').all() } finally { db.close() }
  assert.equal(stored.length, 2)
  for (const message of messages) {
    const body = message.rpc.params.body, row = stored.find(row => row.message_id === message.rpc.params.meta.message_id)
    assert.ok(row); assert.equal(row.sender_did, message.rpc.params.meta.sender_did); assert.equal(row.operation_id, message.rpc.params.meta.operation_id)
    assert.deepEqual(JSON.parse(row.body_json).payload, body.payload)
    assert.deepEqual(JSON.parse(row.receipt_json), body.group_receipt)
  }
  return { protocol: 'anp', minimalInterop: 'passed-for-retained-origin-receipt-and-durable-message-facts', independentProcessIds: [process.adapterPid, process.peerPid],
    originalSignedRequestsVerified: originChecks.length, groupReceiptsVerified: receipts.size, actualBidirectionalIncoming: messages.length, sqliteMessages: stored.length,
    signatureEncodingBoundary: 'group receipt original z-base58btc decoded to 64 bytes; only generic W3C verifier copy reencodes base64url; independent crypto also verifies original protected payload/options',
    notRun: ['Host→home original HTTP headers/raw body/target URL absent, httpSigner signature not independently revalidated', 'ANP parent process startTicks absent in process-start archive', 'live nonce/freshness/replay-cache', 'full P4/Profile/X01-X10 and hard gates', 'normal five-role/file business flow', 'public TLS/two-egress'] }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  assert.ok(process.argv[2] && process.argv[3], 'Usage: node oracle/preflight.mjs <a2a-root> <anp-root>')
  const results = await Promise.all([verifyA2aPreflight(resolve(process.argv[2])), verifyAnpPreflight(resolve(process.argv[3]))])
  console.log(JSON.stringify({ schema: 'geneway.protocol-preflight-oracle/1', results, allExperimentCases: 'not-run', eligibleForScoring: false, winner: null, boundary: 'pure read-only retained minimal interoperability evidence, no new peer/process/business run or gate approval' }, null, 2))
}
