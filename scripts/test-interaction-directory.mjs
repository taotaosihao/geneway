import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-directory-'), captures = [], hosts = [], observations = []
let fixture, provider
try {
  const original = JSON.parse(await readFile('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-CWwNtz/state.json', 'utf8'))
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), input = JSON.parse(body.messages.at(-1).content); captures.push(body)
    assert(input.truncated); assert.equal(input.candidates.length, 8); assert(!JSON.stringify(input).includes('HIDDEN_PEER_DIRECTORY'))
    const content = JSON.stringify({ action: 'attach', targetWorkId: input.candidates[0].workId, reason: '受控错误：截断目录不能据此认定唯一目标', question: null })
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), seedState: state => Object.assign(state, structuredClone(original)), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-only-provider-key', { mode: 0o600 })
  async function login(name) { const response = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: name, password: `synthetic ${name} password` }) }); return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] } }
  const owner = await login('owner'), peer = await login('peer')
  async function api(path, body, method = 'POST', actor = owner) { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json(); observations.push({ path, method, status: response.status }); assert.equal(response.status, 200, JSON.stringify(value)); return value }
  for (const [id, nodeId, capability, resourceRefs] of [['coordinator', 'cloud', 'collaboration.coordinate.v1', []], ['analysis', 'cloud', 'analysis.classify.v1', []], ['desktop-data', 'catalog-data', 'evidence.history.read.v1', ['catalog:history']]]) await api('/api/admin/employees/' + id, { expectedRevision: 1, placement: { nodeId, mode: 'agent_host', resourceRefs }, multisitePolicy: { execution: { capabilityIds: [capability], resourceRefs }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }, 'PATCH')
  await api('/api/admin/members/peer', { expectedEmployeeIds: ['worker'], employeeIds: ['analysis'] }, 'PATCH')
  async function node(nodeId, allowedAgentIds) {
    const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 'pair-' + nodeId, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds, expiresAt: new Date(Date.now() + 120000).toISOString() }), identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }, client = createRemoteClient({ origin: fixture.origin, identity })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'redeem-' + nodeId, ...identity }); identity.registrationRevision = paired.node.registrationRevision
    const journal = createHostJournal(join(directory, nodeId + '-host.json')), runtime = createSimulatedRuntime({ path: join(directory, nodeId + '-sessions.json') }), host = createAgentHost({ nodeId, journal, runtime }); hosts.push(host); host.setOrchestrationHandler({ call: (execution, operation, parameters) => client.command(execution, operation, parameters), event: event => client.event(event) })
    return async () => { for (const delivery of (await client.resync()).pending) { const command = await client.resolveCommand(delivery); await host.accept({ workspaceId: 'local', nodeId }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) }
  }
  const cloud = await node('cloud', ['coordinator', 'analysis']), data = await node('catalog-data', ['desktop-data'])
  await api('/api/admin/resources/catalog%3Ahistory', { clientRequestId: 'catalog-resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: 'catalog-data', capabilityIds: ['evidence.history.read.v1'], evidenceReaderAgentIds: [], enabled: true }, 'PUT')
  const resourceWork = await api('/api/works', { workType: 'multisite', employeeId: 'desktop-data', goal: '仅核目录中的真实资源声明，不读取私源文件。', clientRequestId: 'resource-work' }); await data(); await api(`/api/works/${resourceWork.id}/multisite/cancel`, { clientRequestId: 'stop-resource-work' }); await data()
  const hidden = await api('/api/works', { workType: 'multisite', employeeId: 'analysis', goal: 'HIDDEN_PEER_DIRECTORY', clientRequestId: 'hidden-peer-work' }, 'POST', peer); await cloud(); await api(`/api/works/${hidden.id}/multisite/cancel`, { clientRequestId: 'stop-hidden-peer' }, 'POST', peer); await cloud()
  const created = []
  for (let index = 0; index < 10; index++) {
    const work = await api('/api/works', { workType: 'multisite', employeeId: 'coordinator', goal: index === 0 ? 'TITLE_TARGET_OLD：需要通过分页或标题找回' : `CATALOG_RECENT_${index}`, clientRequestId: 'catalog-' + index }); created.push(work.id); await cloud()
    if (index === 0) { await api(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'catalog-latest-input', expectedInstructionRevision: 1, text: 'LATEST_INPUT_TARGET_MARKER：这是当前有效要求。' }); await cloud() }
    await api(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-catalog-' + index }); await cloud()
  }
  const pages = []; let offset = 0
  do { const page = await api('/api/interaction/directory?offset=' + offset, undefined, 'GET'); pages.push(page); assert(page.candidates.length <= 8); offset = page.nextOffset } while (offset !== null)
  assert.equal(pages[0].candidates.length, 8); assert(pages[0].truncated); assert.equal(pages[0].nextOffset, 8); assert(!pages[0].candidates.some(row => row.workId === created[0])); assert(pages.slice(1).some(page => page.candidates.some(row => row.workId === created[0])))
  const expected = (await fixture.store.read()).works.filter(row => row.ownerMemberId === 'owner').map(row => row.id).sort(); assert.deepEqual(pages.flatMap(page => page.candidates.map(row => row.workId)).sort(), expected); assert(!JSON.stringify(pages).includes(hidden.id)); assert(!JSON.stringify(pages).includes('HIDDEN_PEER_DIRECTORY'))
  const queries = {}
  for (const query of ['TITLE_TARGET_OLD', 'LATEST_INPUT_TARGET_MARKER', 'catalog:history', '2026-11-20']) queries[query] = await api('/api/interaction/directory?query=' + encodeURIComponent(query), undefined, 'GET')
  assert.deepEqual(queries.TITLE_TARGET_OLD.candidates.map(row => row.workId), [created[0]]); assert.deepEqual(queries.LATEST_INPUT_TARGET_MARKER.candidates.map(row => row.workId), [created[0]]); assert.deepEqual(queries['catalog:history'].candidates.map(row => row.workId), [resourceWork.id]); assert(queries['2026-11-20'].candidates.some(row => row.workId === original.works.find(row => row.status === 'completed').id))
  const budget = { workspaceId: 'local', coordinatorAgentId: 'analysis', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await api('/api/admin/routing-policies/catalog-router', { clientRequestId: 'catalog-router-policy', expectedRevision: null, workspaceId: 'local', routerAgentId: 'analysis', routerNodeId: 'cloud', enabled: true, maxOutputTokens: 1024, budget }, 'PUT')
  const thread = await api('/api/interaction/threads', { clientRequestId: 'catalog-thread' }), before = await fixture.store.read(), submitted = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'catalog-source', sourceEventId: 'catalog-source', version: 1, expectedThreadRevision: 1, text: '继续此前的一份工作，但当前还未明确是哪项。', routingPolicyId: 'catalog-router' })
  await until(async () => (await fixture.store.read()).routingRequests.find(row => row.intentId === submitted.intentId)?.state === 'rejected'); const rejected = await fixture.store.read(); assert.equal(rejected.routingRequests.at(-1).error, 'INVALID_RESPONSE'); assert.equal(rejected.works.length, before.works.length); assert.equal(rejected.contextSubscriptions.length, 0); assert.equal(captures.length, 1)
  const choice = await api(`/api/interaction/threads/${thread.id}/selection`, { clientRequestId: 'filtered-user-choice', intentId: submitted.intentId, expectedRouteRevision: 1, targetWorkId: created[0], candidateVersion: queries.TITLE_TARGET_OLD.candidateVersion, offset: 0, query: 'TITLE_TARGET_OLD' }); assert.equal(choice.state, 'proposal'); const final = await fixture.store.read(); assert.equal(final.works.length, before.works.length); assert.equal(final.modelRequests.length, original.modelRequests.length + 1); assert.equal(digest(captures[0]), final.modelRequests.at(-1).bodyDigest)
  await writeFile(join(directory, 'pages-and-queries.json'), JSON.stringify({ pages, queries }, null, 2)); await writeFile(join(directory, 'state-final.json'), JSON.stringify(final, null, 2))
  const result = { result: 'passed', directory, actualCreatedAndStoppedHistoryWorks: 10, totalAuthorizedDirectoryWorks: expected.length, pageSizes: pages.map(page => page.candidates.length), targetOutsideFirstPageActuallyFound: true, titleLatestInputResourceDateQueries: true, hiddenPeerAbsent: true, truncatedAutomaticAttachRejected: true, filteredExplicitChoiceZeroAdditionalModel: true, actualProviderForwards: 1, boundary: 'real authenticated API creates/Inputs/cancels, real Node/Host/AgentDelivery simulator, declared Resource only (no source capture), real routing HTTP; no native/full search-performance or all metadata-domain claim' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { for (const host of hosts) await host.close(); await fixture?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(captures, null, 2)); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Interaction directory root:', directory) }
async function until(test) { const deadline = Date.now() + 10000; while (!await test()) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)) } }
