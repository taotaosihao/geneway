import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-native-'), apiRoot = join(directory, 'api'), captures = [], errors = [], children = [], readyHosts = [], oracle = {}
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let provider, origin, session
try {
  await mkdir(apiRoot); const store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(state => { seedDelegation(state); state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; for (const employee of state.employees) { employee.skillIds = ['cycle']; employee.placement.nodeId = employee.id === 'desktop-data' ? 'pc-a' : employee.id === 'gateway' ? 'gateway' : 'cloud' }; return state })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-evidence-provider', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), index = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[index].content), context = JSON.parse(input.split('当前执行职责与授权（不能自行扩大）：')[1]), history = context.grant.execution.capabilityIds.includes('evidence.history.read.v1'), agent = history ? 'desktop-data' : 'gateway', tail = body.messages.slice(index + 1).filter(row => row.role === 'tool'), last = tail.length ? JSON.parse(flatten(tail.at(-1).content)) : null
      let tool, parameters
      if (!tail.length) { tool = history ? 'geneway_read_history' : 'geneway_inspect_site'; parameters = { clientRequestId: 'native-capture', instructionRevision: 1, resourceId: history ? 'fixture:history' : 'fixture:site', ...(history ? { datasetId: 'history' } : { sections: ['collector_health', 'recent_events'] }) } }
      else if (last?.ref && !last.schema) { tool = 'geneway_read_shared_evidence'; parameters = { ref: last.ref } }
      else if (last?.schema && tail.filter(row => { try { return !!JSON.parse(flatten(row.content)).schema } catch { return false } }).length < 2) { assert(last.partial && last.nextCursor); tool = 'geneway_read_shared_evidence'; parameters = { ref: last.ref, cursor: last.nextCursor } }
      else if (last?.schema) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: '已实际采集并读取前两页受控fixture证据，剩余资料尚未读取；不表示业务完成。' } }
      captures.push({ agent, body, tool: tool ?? null })
      response.writeHead(200, { 'content-type': 'text/event-stream' }); const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `evidence-${captures.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${captures.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '本地受控证据前两页已读取。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = portServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  await new Promise((resolve, reject) => { api.stdout.on('data', bytes => { if (bytes.toString().includes('Geneway listening on')) resolve() }); api.stderr.on('data', bytes => errors.push(bytes.toString())); api.once('exit', code => reject(new Error(`API died ${code}`))) })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  for (const [agent, nodeId, resourceId, capability] of [['desktop-data', 'pc-a', 'fixture:history', 'evidence.history.read.v1'], ['gateway', 'gateway', 'fixture:site', 'evidence.site.inspect.v1']]) {
    const history = agent === 'desktop-data', root = join(directory, nodeId), sourceRoot = join(root, 'source'); await mkdir(sourceRoot, { recursive: true })
    const entries = Array.from({ length: 40 }, (_, index) => ({ date: '2026-11-01', description: index === 0 || index === 2 ? '护罩松动' : index === 1 ? '漏油' : `独立历史条目${index}`, owner: index === 1 ? '李工' : '张工' })), events = Array.from({ length: 40 }, (_, index) => ({ sourceEventId: `fixture-event-${index}`, sourceTimestamp: null, code: 'FIXTURE', severity: 'unknown', message: `现场受控事件${index}` }))
    const source = history ? { format: 'geneway.incident-history', version: 1, entries } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events, privateMarker: 'GATEWAY_PRIVATE_MARKER_NOT_EXPORTED' }, bytes = Buffer.from(JSON.stringify(source))
    await writeFile(join(sourceRoot, 'source.json'), bytes); await writeFile(join(sourceRoot, 'private.txt'), 'PRIVATE_SIBLING_NOT_MAPPED')
    oracle[agent] = { sourceSha256: hash(bytes), expectedItems: history ? entries : events, expectedQuality: history ? 'historical' : 'unknown' }
    const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agent], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(root, 'profile.json')
    await writeFile(profile, JSON.stringify({ root, origin, maxActiveLoops: 1, pairing, evidenceProfile: { profileVersion: 1, resources: [{ resourceId, capabilityIds: [capability], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: [agent], clockTrust: 'fixture' }] } }), { mode: 0o600 })
    const child = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child)
    const ready = await new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); if (message.kind === 'host-error') errors.push(message.code) }); child.once('exit', code => reject(new Error(`Host died ${code}`))) }); readyHosts.push(ready)
    await command(`/api/admin/resources/${encodeURIComponent(resourceId)}`, { clientRequestId: `resource-${nodeId}`, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [capability], evidenceReaderAgentIds: [agent], enabled: true }, 'PUT')
  }
  await writeFile(join(directory, 'oracle.json'), JSON.stringify(oracle, null, 2))
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'coordinator', targets: ['desktop-data', 'gateway'], goal: '各自采集受控资料并读取前两页，未读尾部不得声称已读。', clientRequestId: 'evidence-native' })
  await until(async () => { const state = await store.read(); return state.multisite.attempts.every(row => row.report?.state === 'ready') && state.modelRequests.length === 10 && state.modelRequests.every(row => row.outcome === 'completed') })
  const state = await store.read(); assert.equal(state.evidence.length, 2); assert.equal(state.evidenceAccessReceipts.length, 2); assert.equal(state.artifacts.length, 0); assert.equal(state.works[0].status, 'running'); assert.equal(state.works[0].modelRequestBudget.reserved, 10)
  for (const ready of readyHosts) {
    const local = JSON.parse(await readFile(join(ready.root, 'host-journal.json'), 'utf8')); assert.equal(local.captures[0].state, 'published')
    const agent = local.executions[0].agent_id, source = oracle[agent], evidence = state.evidence.find(row => row.producerBinding.agent_id === agent), latestBody = captures.filter(row => row.agent === agent).at(-1).body, pages = latestBody.messages.filter(row => row.role === 'tool').map(row => { try { return JSON.parse(flatten(row.content)) } catch { return null } }).filter(row => row?.schema)
    assert.equal(pages.length, 2); assert.deepEqual(pages.flatMap(page => page.entries).map(item => { const { entryIndex, ...entry } = item; return entry }), source.expectedItems.slice(0, 32)); assert(pages[1].partial); assert.equal(pages[0].quality, source.expectedQuality)
    assert.equal(evidence.sourceSha256, source.sourceSha256); const bytes = await readFile(join(apiRoot, 'evidence', evidence.id)); assert.equal(hash(bytes), evidence.sha256)
    const identity = JSON.parse(await readFile(join(ready.root, 'node-identity.json'), 'utf8')); assert(!JSON.stringify(local).includes(identity.credential)); assert(!JSON.stringify(captures).includes(identity.credential)); assert(!JSON.stringify(captures).includes('PRIVATE_MARKER_NOT_EXPORTED')); assert(!JSON.stringify(captures).includes('PRIVATE_SIBLING_NOT_MAPPED'))
  }
  assert.deepEqual(captures.map(row => digest(row.body)).sort(), state.modelRequests.map(row => row.bodyDigest).sort()); assert.equal(new Set(state.multisite.attempts.map(row => row.session_id)).size, 2)
  await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-native' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
  assert.deepEqual(errors, []); const result = { result: 'passed', directory, workId: work.id, boundary: 'actual production API and independent A/G native DSH parents on loopback; synthetic provider; two pages each, not full source traversal or D3b group/analysis', independentParents: children.map(child => child.pid), nativeSessions: state.multisite.attempts.map(row => row.session_id), actualForwardRequests: 10, sharedWorkBudgetLimit: 12, actualCapturedEvidence: 2, productionSelfReceipts: 2, actualSharedPagesPerAgent: 2, actualItemsReadPerAgent: 32, remainingItemsNotClaimedRead: 8, exactProviderLedgerDigests: true, secretNotExported: true, actualStop: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, errors }, null, 2)); throw cause }
finally { for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }; if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'capture.json'), JSON.stringify({ captures, errors }, null, 2)); console.log('Evidence native root:', directory) }
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function until(predicate) { const deadline = Date.now() + 45000; while (!await predicate()) { assert(Date.now() < deadline, `Evidence native timed out: ${errors.slice(-5)}`); await new Promise(resolve => setTimeout(resolve, 100)) } }
