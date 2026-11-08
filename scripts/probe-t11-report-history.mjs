import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { collaborationTemplateReference } from '../src/spreadsheet-template.mjs'
import { SPREADSHEET_CANDIDATE_SCHEMA } from '../packages/agent-contracts/spreadsheet-collaboration.mjs'
import { binding, digest, assertSealed } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/t11-report-history-'), captures = [], traffic = [], witnesses = [], errors = [], parents = [], children = []
const agents = ['coordinator', 'desktop-office', 'desktop-data', 'gateway', 'analysis'], nodeFor = id => ({ coordinator: 'cloud', 'desktop-office': 'pc-b', 'desktop-data': 'pc-a', gateway: 'gateway', analysis: 'analysis' })[id]
const flatten = value => typeof value === 'string' ? value : (value ?? []).filter(row => row.type === 'text').map(row => row.text).join('')
const gate = (() => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } })()
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
let fixture, provider, proxy, workId, oldB, newBReached, stage = 'setup'
async function until(predicate, label, timeout = 120000) { const end = Date.now() + timeout; while (!await predicate()) { assert(!errors.length, JSON.stringify(errors)); assert(Date.now() < end, `${label} timed out at ${stage}`); await new Promise(resolve => setTimeout(resolve, 25)) } }
console.log(JSON.stringify({ stage, directory, pid: process.pid }))
try {
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    try {
      const users = body.messages.filter(row => row.role === 'user'), text = flatten(users.findLast(row => flatten(row.content).includes('当前执行职责与授权（不能自行扩大）：')).content), context = JSON.parse(text.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0].split('用户整改表要求：')[0].split('受控资料引用：')[0]), capability = context.grant.execution.capabilityIds[0], agent = ({ 'collaboration.coordinate.v1': 'coordinator', 'office.xlsx.render.v1': 'desktop-office', 'evidence.history.read.v1': 'desktop-data', 'evidence.site.inspect.v1': 'gateway', 'analysis.classify.v1': 'analysis' })[capability]
      assert(agent)
      const state = await fixture.store.read(), attempt = state.multisite.attempts.findLast(row => row.agent_id === agent && row.work_id === workId), revision = attempt.instruction_revision, callMap = new Map(body.messages.filter(row => row.role === 'assistant').flatMap(row => (row.tool_calls ?? []).map(call => [call.id, call.function]))), outputs = body.messages.filter(row => row.role === 'tool').map(row => { try { const call = callMap.get(row.tool_call_id); return { name: call?.name, args: JSON.parse(call?.arguments ?? '{}'), value: JSON.parse(flatten(row.content)) } } catch { return null } }).filter(Boolean)
      assert(!outputs.some(row => row.value.isError), JSON.stringify(outputs.filter(row => row.value.isError)))
      const latest = name => outputs.filter(row => row.name === name).at(-1)?.value, calls = [], add = (name, args) => calls.push({ name, args }), common = { instructionRevision: revision }, messages = users.flatMap(row => { const value = flatten(row.content); if (!value.includes('Agent来源消息（不是用户修订）：')) return []; return JSON.parse(value.split('Agent来源消息（不是用户修订）：')[1].split('用户整改表要求：')[0]) }), pages = outputs.map(row => row.value).filter(row => ['geneway.incident-history/1', 'geneway.site-snapshot/1'].includes(row.schema))
      const child = (id, target, cap, resourceRefs = [], evidenceRefs) => ({ ...common, clientRequestId: id, targetAgentId: target, goal: target === 'desktop-office' && revision === 2 ? 'H07_NEW_B_REVISION_2' : '仅核对真实模拟来源并回报', requestedCapabilityId: cap, resourceRefs, resultSchema: target === 'desktop-office' ? SPREADSHEET_CANDIDATE_SCHEMA : target === 'analysis' ? 'geneway.analysis-result/1' : 'geneway.delegation-result/1', ...(evidenceRefs ? { evidenceRefs } : {}) })
      if (agent === 'coordinator') {
        const delegated = outputs.find(row => row.name === 'geneway_delegate' && row.args.instructionRevision === revision)?.value
        if (!delegated) add('geneway_delegate', child('output-b-' + revision, 'desktop-office', 'office.xlsx.render.v1'))
        else if (!messages.some(row => row.result?.candidateId) || revision === 2) add('geneway_wait_dependencies', { ...common, clientRequestId: 'wait-b-' + revision, dependencyIds: [delegated.delegationId] })
        else if (!outputs.some(row => row.name === 'geneway_multisite_report')) add('geneway_multisite_report', { state: 'waiting', summary: 'H07_C_WAITING_INPUT' })
      } else if (agent === 'desktop-office' && revision === 2) {
        assert(text.includes('H07_NEW_B_REVISION_2')); newBReached = { attempt: structuredClone(attempt), body, at: new Date().toISOString() }; await save('new-b-actual-provider-body.json', newBReached); await gate.promise
      } else if (agent === 'desktop-office') {
        const delegated = outputs.filter(row => row.name === 'geneway_delegate').map(row => row.value), refs = [...new Map(pages.map(row => [row.ref.id, row.ref])).values()]
        if (!outputs.some(row => row.name === 'geneway_multisite_report')) add('geneway_multisite_report', { state: 'ready', summary: 'H07_OLD_B_SEALED_REPORT' })
        else if (!delegated.length) { add('geneway_delegate', child('a', 'desktop-data', 'evidence.history.read.v1', ['fixture:history'])); add('geneway_delegate', child('g', 'gateway', 'evidence.site.inspect.v1', ['fixture:site'])) }
        else if (!pages.length) { const received = messages.filter(row => row.kind === 'dependency_result').flatMap(row => row.result.evidenceRefs); if (received.length) for (const ref of received) add('geneway_read_shared_evidence', { ref }); else add('geneway_wait_dependencies', { ...common, clientRequestId: 'wait-sources', dependencyIds: delegated.slice(0, 2).map(row => row.delegationId) }) }
        else if (delegated.length === 2) add('geneway_delegate', child('analysis', 'analysis', 'analysis.classify.v1', [], refs))
        else if (!messages.some(row => row.result?.findings)) add('geneway_wait_dependencies', { ...common, clientRequestId: 'wait-analysis', dependencyIds: [delegated.at(-1).delegationId] })
        else if (!latest('geneway_start_spreadsheet')) {
          const resultIds = messages.filter(row => row.kind === 'dependency_result').map(row => row.resultRef), history = pages.find(row => row.schema === 'geneway.incident-history/1')
          assert.equal(history.entries[0].description, 'H07_REAL_HISTORY_ROW'); add('geneway_start_spreadsheet', { ...common, clientRequestId: 'old-source-job', template: collaborationTemplateReference(), sourceResultIds: resultIds, rows: [{ sourceRef: history.ref, entryIndex: 0, dueDate: '2026-11-20', photoRefs: [] }] })
        } else {
          const job = latest('geneway_start_spreadsheet'), found = latest('geneway_get_spreadsheet_job')
          if (!found?.candidate) add('geneway_get_spreadsheet_job', { jobId: job.id })
          else add('geneway_complete_delegation', { ...common, clientRequestId: 'complete-old-candidate', result: { summary: '真实旧候选待协调，尚未发布', evidenceRefs: refs, jobId: job.id, candidateId: found.candidate.id, version: found.candidate.version, sha256: found.candidate.sha256, inputDigest: job.inputDigest, manifestDigest: found.candidate.manifestDigest, sourceResultIds: messages.filter(row => row.kind === 'dependency_result').map(row => row.resultRef) } })
        }
      } else if (agent === 'desktop-data' || agent === 'gateway') {
        const history = agent === 'desktop-data', captured = outputs.map(row => row.value).find(row => row.status === 'ready' && row.ref)
        if (!captured) add(history ? 'geneway_read_history' : 'geneway_inspect_site', { ...common, clientRequestId: 'capture', resourceId: history ? 'fixture:history' : 'fixture:site', ...(history ? { datasetId: 'history' } : { sections: ['collector_health', 'recent_events'] }) })
        else add('geneway_complete_delegation', { ...common, clientRequestId: 'complete', result: { summary: '原模拟资料已实际封存', evidenceRefs: [captured.ref] } })
      } else {
        const refs = context.evidenceRefs
        if (!pages.length) for (const ref of refs) add('geneway_read_shared_evidence', { ref })
        else { const history = pages.find(row => row.schema === 'geneway.incident-history/1'), site = pages.find(row => row.schema === 'geneway.site-snapshot/1'); assert.equal(history.entries[0].description, 'H07_REAL_HISTORY_ROW'); add('geneway_complete_delegation', { ...common, clientRequestId: 'complete', result: { summary: '只基于实际模拟来源分析', evidenceRefs: refs, findings: [{ category: 'history_match', certainty: 'supported', statement: '首条记录已读', basis: [{ evidenceRef: history.ref, entryIndexes: [0] }] }, { category: 'insufficient_evidence', certainty: 'unknown', statement: '现场时钟未知', basis: [{ evidenceRef: site.ref, sourceEventIds: ['h07-site-event'] }] }], limitations: ['仅模拟资料'] } }) }
      }
      captures.push({ agent, revision, binding: binding(attempt), body, calls, at: new Date().toISOString() }); await save('captures-live.json', captures)
      response.writeHead(200, { 'content-type': 'text/event-stream' }); const send = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (calls.length) { send({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: 'h07-' + captures.length + '-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, null); send({}, 'tool_calls') } else { send({ role: 'assistant', content: '本轮保留真实事实，等待明确输入。' }, null); send({}, 'stop') }; response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); if (!response.headersSent) response.writeHead(500); response.end('{}'); await save('provider-errors.json', errors) }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, seedState(state) { seedDelegation(state); for (const row of state.employees) { row.placement.nodeId = nodeFor(row.id); row.placement.resourceRefs = row.id === 'desktop-data' ? ['fixture:history'] : row.id === 'gateway' ? ['fixture:site'] : [] }; return state } })
  proxy = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks)
    if (request.method === 'POST' && request.url === '/internal/bridge/events') traffic.push({ event: JSON.parse(body).event, at: new Date().toISOString() })
    const upstream = httpRequest(new URL(request.url, fixture.origin), { method: request.method, headers: { ...request.headers, host: new URL(fixture.origin).host } }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response) })
    upstream.on('error', () => response.destroy()); response.on('close', () => upstream.destroy()); upstream.end(body)
  }); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); const nodeOrigin = `http://127.0.0.1:${proxy.address().port}`
  await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-h07-provider', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function user(path, body, method = 'POST') { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value }
  for (const agent of agents) {
    const nodeId = nodeFor(agent), root = join(directory, nodeId), sourceRoot = join(root, 'source'); await mkdir(sourceRoot, { recursive: true })
    const history = agent === 'desktop-data', resourceId = history ? 'fixture:history' : agent === 'gateway' ? 'fixture:site' : null
    const data = history ? { format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: 'H07_REAL_HISTORY_ROW', owner: '张工' }] } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events: [{ sourceEventId: 'h07-site-event', sourceTimestamp: null, code: 'FIXTURE', severity: 'unknown', message: 'H07真实封存模拟事件' }] }
    if (resourceId) await writeFile(join(sourceRoot, 'source.json'), JSON.stringify(data))
    const capability = history ? 'evidence.history.read.v1' : 'evidence.site.inspect.v1', pairing = await fixture.nodes.createPairing({ id: 'owner' }, { clientRequestId: 'pair-' + nodeId, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agent], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(root, 'profile.json')
    await writeFile(profile, JSON.stringify({ root, origin: nodeOrigin, pairing, officeEnabled: agent === 'desktop-office', evidenceProfile: { profileVersion: 1, resources: resourceId ? [{ resourceId, capabilityIds: [capability], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: agents, clockTrust: 'fixture' }] : [] } }), { mode: 0o600 })
    const selected = agent === 'desktop-office', child = fork(fileURLToPath(new URL(selected ? './fixtures/multisite/t11-report-driver.mjs' : '../packages/agent-host/remote.mjs', import.meta.url)), selected ? [] : [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child)
    child.stderr.on('data', bytes => void appendFile(join(directory, 'host-' + child.pid + '.log'), bytes)); child.on('message', value => { if (value.kind.startsWith('report-')) witnesses.push({ ...value, at: new Date().toISOString() }); if (value.kind === 'host-error') errors.push(value.code) })
    const ready = await new Promise((resolve, reject) => { child.on('message', value => { if (value.kind === 'ready') resolve(value); if (value.kind === 'driver-failure') reject(Error(JSON.stringify(value))) }); child.once('exit', (code, signal) => reject(Error('Host exited before ready ' + code + '/' + signal))); if (selected) child.send({ profile }) }); parents.push({ agent, child, ready, root })
    if (resourceId) await user('/api/admin/resources/' + encodeURIComponent(resourceId), { clientRequestId: 'resource-' + nodeId, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [capability], evidenceReaderAgentIds: agents, enabled: true }, 'PUT')
  }
  const route = (await fixture.store.read()).modelRoutes[0]
  await user('/api/admin/budget-policies/h07-finite', { clientRequestId: 'h07-policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 64, maxReservedTokens: 2000000, maxReservedCostMicros: 10000 }, executionTimeoutMs: 240000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] }, 'PUT')
  const created = await user('/api/works', { workType: 'multisite', employeeId: 'coordinator', clientRequestId: 'h07-work', goal: '真实新修订委派后只把旧回报归档，不污染当前产出职责。', budgetPolicyId: 'h07-finite', spreadsheetRequest: { templateId: 'incident-collaboration-v1', dueDate: '2026-11-20' } }); workId = created.id ?? created.workId; stage = 'old-candidate-and-sealed-report'
  const office = parents.find(row => row.agent === 'desktop-office'), coordinator = parents.find(row => row.agent === 'coordinator'), journal = () => readFile(join(office.root, 'host-journal.json')).then(JSON.parse)
  await until(async () => { const state = await fixture.store.read(); oldB = state.multisite.attempts.find(row => row.agent_id === 'desktop-office'); return oldB?.status === 'completed' && oldB.settledAt && state.artifacts.some(row => row.candidateVerification) && captures.some(row => row.agent === 'coordinator' && row.body.messages.some(message => message.role === 'tool' && flatten(message.content).includes('"accepted":true'))) && state.modelRequests.every(row => row.outcome === 'completed') }, 'Old B actually completed and settled with a verified candidate')
  await until(async () => (await sessionFrames(coordinator.root)).some(row => row.frames.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed')), 'Original coordinator has an actual completed SDK turn')
  const oldLocal = await journal(), oldState = await fixture.store.read(), original = oldLocal.outbox.find(row => row.event.kind === 'report' && row.event.report.summary === 'H07_OLD_B_SEALED_REPORT')
  assert(original && !original.acknowledged); assertSealed(original.event); assert(!oldState.multisite.receipts.some(row => row.event.event_id === original.event.event_id)); assert(!traffic.some(row => row.event?.event_id === original.event.event_id)); assert(witnesses.some(row => row.kind === 'report-selection-witness' && row.target.event.event_id === original.event.event_id)); assert(oldLocal.executions.find(row => row.attempt_id === oldB.attempt_id).status === 'settled')
  await save('old-completed-report-still-unacked.json', { host: oldLocal, cloud: oldState, original, witnesses, traffic }); stage = 'formal-input2-and-new-b'
  await user(`/api/works/${workId}/multisite/inputs`, { clientRequestId: 'h07-formal-input2', text: 'H07_FORMAL_REV2：新的期限为11月21日，请明确重新委派B后核对，旧候选只留历史。', revisionScope: 'due_date_only', spreadsheetRequest: { templateId: 'incident-collaboration-v1', dueDate: '2026-11-21' } })
  await until(() => !!newBReached, 'New B actual provider request after SDK input consumption')
  const current = await fixture.store.read(), newB = current.multisite.attempts.findLast(row => row.agent_id === 'desktop-office'), input = current.multisite.inputs.find(row => row.workId === workId && row.revision === 2), expectedMessageId = messageId(input.id, newB.attempt_id, newB.session_id), frames = await sessionFrames(office.root), sourceFrame = frames.flatMap(row => row.frames.map(event => ({ ...event, sourceFile: row.path }))).find(event => event.type === 'user/message' && event.data.id === expectedMessageId)
  assert(sourceFrame); assert(flatten(sourceFrame.data.content).includes('H07_FORMAL_REV2')); assert(input.deliveries.some(row => row.attemptId === newB.attempt_id && row.sessionId === newB.session_id && row.ingestedAt)); assert.equal(newB.observed_revision, 2); assert.notEqual(newB.delegation_id, oldB.delegation_id); assert.notEqual(newB.session_id, oldB.session_id)
  assert(!current.multisite.receipts.some(row => row.event.event_id === original.event.event_id)); assert(!(await journal()).outbox.find(row => row.event.event_id === original.event.event_id).acknowledged); assert(!traffic.some(row => row.event?.event_id === original.event.event_id)); assert.equal(current.spreadsheetOutputBindings.at(-1).outputBinding.attempt_id, newB.attempt_id)
  await save('new-b-actual-input-before-old-first-post.json', { cloud: current, local: await journal(), expectedMessageId, sourceFrame, provider: newBReached, oldB, newB, traffic, witnesses }); stage = 'release-original-sealed-report'
  office.child.send({ kind: 'release-old-report' })
  await until(async () => (await journal()).outbox.find(row => row.event.event_id === original.event.event_id)?.acknowledged, 'Original late report exact ACK persisted')
  const after = await fixture.store.read(), receipts = after.multisite.receipts.filter(row => row.event.event_id === original.event.event_id), local = await journal()
  assert.equal(receipts.length, 1); assert.equal(receipts[0].historical, true); assert.deepEqual(receipts[0].event, original.event); assert.deepEqual(binding(receipts[0].ack), binding(original.event)); assert.equal(receipts[0].ack.payload_digest, original.event.payload_digest)
  for (const field of ['works', 'artifacts', 'userQuestions', 'intentQuestions', 'spreadsheetOutputBindings', 'modelRequests', 'evidence', 'evidenceAccessReceipts']) assert.deepEqual(after[field], current[field], field)
  for (const field of ['attempts', 'delegations', 'inputs', 'jobs', 'results', 'questions', 'messages']) assert.deepEqual(after.multisite[field], current.multisite[field], field)
  assert.deepEqual(local.outbox.find(row => row.event.event_id === original.event.event_id).event, original.event); assert.equal(traffic.filter(row => row.event?.event_id === original.event.event_id).length, 1)
  await save('old-report-historical-exact-ack.json', { cloud: after, host: local, receipt: receipts[0], traffic, witnesses }); gate.release(); await until(async () => (await fixture.store.read()).modelRequests.every(row => row.outcome === 'completed'), 'New B held model finishes without replay')
  const settled = await fixture.store.read(); assert.deepEqual(settled.modelRequests.map(row => row.bodyDigest).sort(), captures.map(row => digest(row.body)).sort()); await user(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'h07-finish' }); await until(async () => (await fixture.store.read()).works[0].status === 'cancelled', 'Real cancellation cleanup')
  await save('terminal-cloud.json', await fixture.store.read()); await save('terminal-host.json', await journal()); const result = { result: 'passed', directory, workId, originalReportId: original.event.event_id, oldDelegationId: oldB.delegation_id, newDelegationId: newB.delegation_id, actualNewSdkUserMessageId: expectedMessageId, originalReportFirstPostAfterNewSdkConsume: true, historicalExactAckWithNoCurrentEffect: true, originalReportRemainedDurableUnacknowledgedUntilRelease: true, providerForwards: captures.length, boundary: 'actual same Work revision1→2/new office Delegation, original and new official SDK Sessions and controlled XLSX worker/candidate; test-only sender selection view delays one genuine sealed report before its first HTTP POST; not same-Delegation retry, not already-inflight HTTP disorder or OS reboot' }; await save('result.json', result); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await save('failure.json', { stage, code: cause.code, stack: cause.stack, errors, witnesses }); console.error(cause.stack); process.exitCode = 1 }
finally {
  gate.release(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM') }); await fixture?.close(); for (const server of [proxy, provider]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await save('provider-bodies.json', captures.map(row => row.body)); await save('captures.json', captures); await save('traffic.json', traffic); await save('selection-witnesses.json', witnesses); await save('errors.json', errors)
  await save('parents.json', parents.map(({ agent, child, ready, root }) => ({ agent, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, ready, root })))
  for (const parent of parents) { const files = await sessionFrames(parent.root); for (let index = 0; index < files.length; index++) await writeFile(join(directory, parent.agent + '-session-' + index + '-allframes.jsonl'), files[index].frames.map(row => JSON.stringify(row)).join('\n') + '\n') }
  console.log('T11 report history evidence:', directory)
}
async function sessionFrames(root) {
  const files = []; async function walk(path) { let rows; try { rows = await readdir(path, { withFileTypes: true }) } catch (cause) { if (cause.code === 'ENOENT') return; throw cause }; for (const row of rows) { const next = join(path, row.name); if (row.isDirectory()) await walk(next); else if (row.name === 'session.v4.jsonl.zstd') files.push(next) } }; await walk(root)
  return Promise.all(files.map(async path => { const { stdout } = await promisify(execFile)('zstd', ['-dc', '--', path], { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }); return { path, frames: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) } }))
}
