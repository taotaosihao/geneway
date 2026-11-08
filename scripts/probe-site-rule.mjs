import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { binding, digest, sameBinding } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { SITE_RESOURCE, SITE_CODE, SITE_CAPABILITY } from '../packages/agent-contracts/site-rule.mjs'
import { SITE_RULE_LIMITS } from '../src/site-rule-state.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { processIdentity, signalOwned, startChild } from './fixtures/multisite/supervision-process-lifecycle.mjs'
import { readDiagnosisSessions, readOptionalJSON } from './fixtures/multisite/supervision-diagnosis-evidence.mjs'
import { startSiteRuleProvider } from './fixtures/multisite/site-rule-provider.mjs'

assert(process.argv.slice(2).every(value => value === '--wait-ui'), 'Only --wait-ui is supported')
const waitUI = process.argv.includes('--wait-ui')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/site-rule-')
const apiRoot = join(directory, 'api'), hostRoot = join(directory, 'host'), sourceRoot = join(hostRoot, 'source')
const stateFile = join(apiRoot, 'state.json'), sourceFile = join(sourceRoot, 'snapshot.json')
const nodeId = 'site-rule-node', employeeId = 'site-rule-gateway', foregroundId = 'coordinator', profileVersion = 1, budgetPolicyId = 'site-rule-simulated-price'
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const children = [], descendants = new Map(), facts = [], stages = [], http = [], errors = [], writes = [], sessions = {}
let api, host, provider, origin
const cloud = () => readFile(stateFile, 'utf8').then(JSON.parse)
const local = () => readFile(join(hostRoot, 'host-journal.json'), 'utf8').then(JSON.parse)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function observeChildren(pid) {
  let nested
  try { nested = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return; throw cause }
  for (const child of nested) {
    const identity = await processIdentity(child); if (!identity) continue
    const id = child + ':' + identity.startTicks
    if (!descendants.has(id)) {
      try { descendants.set(id, { ...identity, argv: (await readFile(`/proc/${child}/cmdline`, 'utf8')).split('\0').filter(Boolean), observedAt: new Date().toISOString() }) }
      catch (cause) { if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause }
    }
    await observeChildren(child)
  }
}
async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  for (;;) {
    for (const item of children) await observeChildren(item.child.pid)
    const value = await predicate(); if (value) return value
    const providerError = errors.find(row => row.stage === 'provider'); assert(!providerError, JSON.stringify(providerError))
    assert(Date.now() < deadline, label + ' timed out'); await delay(500)
  }
}
async function stage(name, details = {}) {
  const value = { name, at: new Date().toISOString(), ...details }; stages.push(value); await save('stages.json', stages)
  console.log(JSON.stringify({ stage: name, directory, pid: process.pid, origin, apiPid: api?.child.pid, hostPid: host?.child.pid, provider: provider?.origin, ...details }))
}
async function spawn(relative, args, env, name) {
  const item = await startChild({ path: fileURLToPath(new URL(relative, import.meta.url)), args, env, directory, name, facts })
  children.push(item); item.messages = []
  item.exit = new Promise(resolve => item.child.once('exit', (code, signal) => resolve({ code, signal })))
  item.closed = new Promise(resolve => item.child.once('close', resolve))
  item.child.on('message', value => { item.messages.push(value); writes.push(appendFile(join(directory, name + '.ipc.jsonl'), JSON.stringify({ at: new Date().toISOString(), value }) + '\n')); if (value.kind === 'host-error') errors.push({ stage: name, ...value }) })
  facts.push({ kind: 'actual-argv', name, ...item.identity, argv: (await readFile(`/proc/${item.child.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) })
  return item
}
async function stop(item) {
  if (!item || item.child.exitCode !== null || item.child.signalCode !== null) return
  await observeChildren(item.child.pid); await signalOwned(item, 'SIGTERM', facts)
  let timer
  try { await Promise.race([item.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned process TERM grace expired')), 15000) })]) }
  catch (cause) { await signalOwned(item, 'SIGKILL', facts); facts.push({ kind: 'cleanup-fallback', pid: item.child.pid, reason: cause.message }); await item.exit }
  finally { clearTimeout(timer) }
  await item.closed
  assert.notEqual((await processIdentity(item.identity.pid))?.startTicks, item.identity.startTicks)
}
async function request(actor, path, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const session = sessions[actor]
  const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  http.push({ actor, path, method, status: response.status, at: new Date().toISOString(), request: body, response: path === '/api/admin/nodes/pairings' ? { ...value, pairingCode: '[redacted]' } : value })
  assert.equal(response.status, expected, JSON.stringify(value)); return value
}
const owner = (path, body, method) => request('owner', path, body, method)
async function snapshotSource(label, events, sourceTime) {
  const bytes = Buffer.from(JSON.stringify({ sourceTime, events }) + '\n')
  const temporary = sourceFile + '.new'; await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, sourceFile)
  const actual = await readFile(sourceFile); assert.deepEqual(actual, bytes)
  await writeFile(join(directory, 'raw-source-' + label + '.json'), actual)
  const proof = { file: sourceFile, sha256: sha(actual), bytes: actual.length, parsed: JSON.parse(actual) }
  await save('raw-source-' + label + '-proof.json', proof); return proof
}
const sourcePaths = [...new Set(['scripts/probe-site-rule.mjs', 'scripts/probe-site-rule-ui.mjs', 'scripts/fixtures/multisite/site-rule-provider.mjs', 'scripts/fixtures/multisite/production-service.mjs', 'scripts/fixtures/multisite/supervision-process-lifecycle.mjs', 'scripts/fixtures/multisite/supervision-diagnosis-evidence.mjs', 'scripts/fixtures/multisite/delegation.mjs', ...(await readdir('src')).filter(name => /^(site-rule|routing|interaction|supervision)-/.test(name)).map(name => 'src/' + name), 'src/server.mjs', 'src/store/file-store.mjs', 'src/spreadsheet-state.mjs', 'src/model-gateway.mjs', 'src/node-bridge.mjs', 'src/node-service.mjs', 'src/evidence-service.mjs', 'src/evidence-access.mjs', 'src/artifact-files.mjs', 'src/work-budget.mjs', 'src/multisite-authorization.mjs', 'src/dsh-host.mjs', 'config/multisite-runtime.patch.yml', 'packages/agent-host/remote.mjs', 'packages/agent-host/remote-client.mjs', 'packages/agent-host/host.mjs', 'packages/agent-host/journal.mjs', 'packages/agent-host/journal-archive.mjs', 'packages/agent-host/evidence-captures.mjs', 'packages/agent-host/evidence-tools.mjs', 'packages/agent-host/site-rule-tool.mjs', 'packages/agent-host/dsh-runtime.mjs', 'packages/agent-host/process-runtime.mjs', 'packages/agent-host/runtime-worker.mjs', 'packages/agent-contracts/site-rule.mjs', 'packages/agent-contracts/evidence.mjs', 'packages/agent-orchestration/service.mjs', 'packages/agent-orchestration/commands.mjs', 'web/index.html', 'package.json', 'pnpm-lock.yaml'])].sort()
async function source(phase) {
  const folder = join(directory, 'source-' + phase); await mkdir(folder)
  const entries = []
  for (const path of sourcePaths) { const bytes = await readFile(path); await writeFile(join(folder, path.replaceAll('/', '__')), bytes); entries.push({ path, bytes: bytes.length, sha256: sha(bytes) }) }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), argv: process.argv, owner: await processIdentity(process.pid), entries }); return entries
}
const sourceStart = await source('start')
await stage('source-start', { argv: process.argv, scope: 'one simulated collector rule; real API, Node, native DSH and loopback model replacement' })
try {
  assert.equal(SITE_RULE_LIMITS.windowMs, 300000); assert.equal(SITE_RULE_LIMITS.cooldownMs, 900000); assert.equal(SITE_RULE_LIMITS.draftMs, 3600000); assert.equal(SITE_RULE_LIMITS.background, 1)
  await mkdir(apiRoot, { recursive: true, mode: 0o700 }); await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
  const store = createFileStore(stateFile)
  await store.update(state => {
    seedDelegation(state)
    const foreground = state.employees.find(row => row.id === foregroundId)
    foreground.placement = { nodeId, mode: 'agent_host', resourceRefs: [] }
    foreground.multisitePolicy.delegation.resourceRefs = []
    const dedicated = { ...structuredClone(state.employees.find(row => row.id === 'gateway')), id: employeeId, name: '模拟规则现场专员', connectionIds: [], skillIds: [], placement: { nodeId, mode: 'agent_host', resourceRefs: [SITE_RESOURCE] }, multisitePolicy: { execution: { capabilityIds: [SITE_CAPABILITY], resourceRefs: [SITE_RESOURCE] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }
    state.employees.push(dedicated); state.members.find(row => row.id === 'owner').employeeIds.push(employeeId); state.members.find(row => row.id === 'peer').employeeIds = [employeeId]
    return state
  })
  await mkdir(join(apiRoot, 'secrets'), { mode: 0o700 }); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-site-rule-provider-only', { mode: 0o600 })
  const authFile = join(apiRoot, 'auth.json'); await initializeAuthFile(authFile, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  const catalog = join(apiRoot, 'connection-catalog.json'); await writeFile(catalog, JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  await snapshotSource('initial-empty', [], new Date().toISOString())
  provider = await startSiteRuleProvider({ directory, readState: cloud, onError: cause => errors.push({ stage: 'provider', message: cause.message, stack: cause.stack }) })
  const port = createServer(); await new Promise(resolve => port.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + port.address().port; await new Promise(resolve => port.close(resolve))
  api = await spawn('./fixtures/multisite/production-service.mjs', [], { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: catalog, GENEWAY_DSH_HOME: join(apiRoot, 'unused-api-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: new URL(origin).port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: provider.origin + '/v1' }, 'api')
  await until(async () => { assert(api.child.exitCode === null && api.child.signalCode === null); try { return (await fetch(origin)).ok } catch { return false } }, 'formal API ready')
  for (const actor of ['owner', 'peer']) {
    const response = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: actor, password: 'synthetic ' + actor + ' password' }) })
    assert.equal(response.status, 200); sessions[actor] = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] }
  }
  const initialRule = await owner('/api/admin/site-rule'); assert.equal(initialRule.mode, 'observe'); assert.equal(initialRule.revision, 0)
  const thread = await owner('/api/interaction/threads', { clientRequestId: 'site-rule-owner-thread', title: '本机模拟采集异常诊断' })
  const state = await cloud()
  await owner('/api/admin/budget-policies/' + budgetPolicyId, { clientRequestId: 'site-rule-v2-price', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: employeeId, enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: state.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }, 'PUT')
  const pairing = await owner('/api/admin/nodes/pairings', { clientRequestId: 'site-rule-pair', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [employeeId, foregroundId], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const profile = join(hostRoot, 'profile.json')
  await writeFile(profile, JSON.stringify({ root: hostRoot, origin, pairing, maxActiveLoops: 2, officeEnabled: false, evidenceProfile: { profileVersion, resources: [{ resourceId: SITE_RESOURCE, capabilityIds: [SITE_CAPABILITY], adapterKind: 'site_snapshot_json', root: sourceRoot, datasets: {}, fixedFiles: { snapshot: 'snapshot.json' }, allowedSections: ['recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 300, exportToAgentIds: [employeeId], clockTrust: 'fixture' }] } }), { mode: 0o600 })
  host = await spawn('../packages/agent-host/remote.mjs', [profile], { PATH: process.env.PATH, HOME: hostRoot }, 'host')
  const ready = await until(() => { assert(host.child.exitCode === null && host.child.signalCode === null); return host.messages.find(row => row.kind === 'ready') }, 'real native Node Host ready')
  const resource = await owner('/api/admin/resources/' + encodeURIComponent(SITE_RESOURCE), { clientRequestId: 'site-rule-resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [SITE_CAPABILITY], evidenceReaderAgentIds: [employeeId], enabled: true }, 'PUT')
  const scope = { nodeId, threadId: thread.id, employeeId, profileVersion, budgetPolicyId }
  const observe = await owner('/api/admin/site-rule', { expectedRevision: initialRule.revision, mode: 'observe', ...scope }, 'PUT')
  assert.equal(observe.mode, 'observe'); assert.equal(observe.revision, 1)
  await stage('native-site-node-ready', { nodeId, nodeInstanceId: ready.nodeInstanceId, profileVersion })
  const observedEvent = { sourceEventId: 'fixture-observe-link-down', sourceTimestamp: new Date().toISOString(), code: SITE_CODE, severity: 'error', message: '本机模拟：启用自动规则前的连接中断观察。' }
  const observedSource = await snapshotSource('observe', [observedEvent], observedEvent.sourceTimestamp)
  const observed = await until(async () => (await cloud()).siteRuleEvents.find(row => row.eventId === observedEvent.sourceEventId), 'actual Host automatically offers the observe source')
  assert.equal(observed.status, 'observed'); assert.equal(observed.workId, null); assert.equal(observed.sourceSha256, observedSource.sha256); assert.equal(observed.eventDigest, digest(observedEvent)); assert.equal(observed.nodeInstanceId, ready.nodeInstanceId)
  const beforeReplay = await cloud()
  assert.equal(beforeReplay.works.length, 0); assert.equal(provider.captures.length, 0)
  const identity = JSON.parse(await readFile(join(hostRoot, 'node-identity.json'), 'utf8'))
  assert.equal(identity.nodeInstanceId, ready.nodeInstanceId)
  const node = createRemoteClient({ origin, identity, hostRunId: ready.hostRunId })
  const replayBody = { profileVersion, maxActiveLoops: 2, sourceSha256: observedSource.sha256, event: observedSource.parsed.events[0] }
  const replay = await node.post('/internal/site-rule/events', replayBody, { attempts: 1 })
  assert.equal(replay.replay, true); assert.equal(replay.workId, null); assert.equal(replay.status, 'observed')
  const replayed = await cloud(); assert.deepEqual(replayed.siteRuleEvents, beforeReplay.siteRuleEvents); assert.equal(replayed.works.length, 0); assert.equal(provider.captures.length, 0)
  await save('real-observe-and-exact-replay.json', { initialRule, observe, resource, automaticHostEvent: observed, replayRequest: replayBody, replayResponse: replay, cloud: replayed, boundary: 'initial event was automatically read and offered by the actual Host; exact replay used its own registered Node identity on the real HTTP ingress' })
  const auto = await owner('/api/admin/site-rule', { expectedRevision: observe.revision, mode: 'auto', ...scope, expiresAt: new Date(Date.now() + 300000).toISOString() }, 'PUT')
  assert.equal(auto.mode, 'auto'); assert.equal(auto.approvedBy, 'owner'); assert.equal(auto.revision, 2)
  assert.equal((await cloud()).works.length, 0, 'Enabling must not turn old observations into Work')
  await until(() => Date.now() > Date.parse(auto.approvedAt), 'new trigger timestamp follows real approval')
  const activeEvent = { sourceEventId: 'fixture-auto-new-link-down', sourceTimestamp: new Date().toISOString(), code: SITE_CODE, severity: 'error', message: '本机模拟：本次固定窗内的采集链路中断；不代表现场设备故障。' }
  const autoSource = await snapshotSource('auto', [observedEvent, activeEvent], activeEvent.sourceTimestamp)
  assert.deepEqual(autoSource.parsed.events[0], observedSource.parsed.events[0])
  const admission = await until(async () => (await cloud()).siteRuleEvents.find(row => row.eventId === activeEvent.sourceEventId), 'actual Host auto event accepted')
  assert.equal(admission.status, 'created'); assert(admission.workId); assert.equal(admission.sourceSha256, autoSource.sha256); assert.equal(admission.eventDigest, digest(activeEvent))
  const background = (await cloud()).works.find(row => row.id === admission.workId)
  assert.equal(background.origin, 'rule'); assert.equal(background.employeeId, employeeId); assert.equal(background.ownerMemberId, 'owner'); assert.equal(background.siteRule.grantRef, auto.grantRef); assert.equal(background.modelRequestBudget.version, 2)
  const actualWindow = { from: new Date(Date.parse(activeEvent.sourceTimestamp) - 300000).toISOString(), to: activeEvent.sourceTimestamp }
  assert.deepEqual(background.siteRule.window, actualWindow)
  await until(() => provider.isHeld('background-first'), 'actual native background model request held before first read tool')
  const foreground = await owner('/api/works', { workType: 'multisite', employeeId: foregroundId, clientRequestId: 'site-rule-independent-foreground', goal: '本次只验证同节点前台工作在后台模型悬持时仍有实际执行槽。', attachmentRefs: [] })
  await until(() => provider.isHeld('foreground-first'), 'different employee starts a real foreground native model on the same Node')
  const overlap = await local(), overlapCloud = await cloud(), bg = overlap.executions.find(row => row.work_id === background.id), fg = overlap.executions.find(row => row.work_id === foreground.id)
  assert(bg?.slotHeld && fg?.slotHeld); assert.equal(bg.node_id, nodeId); assert.equal(fg.node_id, nodeId); assert.notEqual(bg.agent_id, fg.agent_id); assert.notEqual(bg.session_id, fg.session_id)
  assert(provider.isHeld('background-first') && provider.isHeld('foreground-first'))
  for (const capture of [provider.capture('background-first'), provider.capture('foreground-first')]) assert(overlapCloud.modelRequests.some(row => row.id === capture.modelRequestId && row.outcome === 'unknown' && sameBinding(row, capture.binding)))
  await save('actual-overlapping-native-slots.json', { background: binding(bg), foreground: binding(fg), journal: overlap, cloud: overlapCloud, provider: provider.captures, boundary: 'two actual slots and distinct Sessions on one Node while both actual mock upstream responses are held' })
  await stage('same-node-foreground-and-background-held', { workId: background.id, foregroundWorkId: foreground.id })
  await provider.release('foreground-first')
  await until(async () => (await cloud()).modelRequests.some(row => row.work_id === foreground.id && row.outcome === 'completed'), 'actual foreground ledger completed')
  await owner('/api/works/' + foreground.id + '/multisite/cancel', { clientRequestId: 'site-rule-foreground-stop' })
  await until(async () => (await cloud()).works.find(row => row.id === foreground.id).status === 'cancelled', 'own foreground Work actual stop')
  await provider.release('background-first')
  const draft = await until(async () => (await cloud()).siteDiagnosisDrafts.find(row => row.workId === background.id), 'real native inspect/read/submit creates a prepared draft')
  await until(async () => {
    const journal = await local(), cloudState = await cloud()
    return cloudState.works.find(row => row.id === background.id).status === 'completed' && journal.executions.some(row => sameBinding(row, bg) && row.status === 'settled' && row.slotHeld === false) && journal.outbox.some(row => sameBinding(row.event, bg) && row.event.kind === 'settled' && row.acknowledged)
  }, 'actual completed background Work obtains original Host settle proof and ACK')
  const completed = await cloud(), hostState = await local(), ruleCaptures = provider.captures.filter(row => row.lane === 'background')
  assert.equal(ruleCaptures.length, 3); assert.deepEqual(ruleCaptures.map(row => row.calls[0].name), ['geneway_inspect_site', 'geneway_read_shared_evidence', 'geneway_submit_site_diagnosis'])
  assert.equal(completed.modelRequests.length, 4); assert.equal(provider.captures.length, 4)
  const pageCapture = ruleCaptures[2], page = pageCapture.evidencePage, { siteRuleReadId, ...rawPage } = page
  const read = completed.siteRuleReads.find(row => row.id === siteRuleReadId), evidence = completed.evidence.find(row => row.id === read.evidenceRef.id)
  assert.equal(read.pageDigest, digest(rawPage)); assert.equal(read.eventDigest, digest(activeEvent)); assert.equal(draft.readId, read.id); assert.equal(draft.modelRequestId, pageCapture.modelRequestId)
  assert(completed.siteRuleModelReads.some(row => row.readId === read.id && row.modelRequestId === pageCapture.modelRequestId))
  assert.deepEqual(page.entries.find(row => row.sourceEventId === activeEvent.sourceEventId), autoSource.parsed.events[1])
  assert.equal(evidence.status, 'ready'); assert.equal(evidence.quality, 'current'); assert.equal(evidence.clockTrust, 'fixture'); assert.equal(evidence.sourceSha256, autoSource.sha256)
  assert.deepEqual(evidence.exportToAgentIds, [employeeId]); assert.equal(evidence.sha256, read.evidenceRef.sha256)
  const uploadedBytes = await readFile(join(apiRoot, 'evidence', evidence.id)), uploaded = JSON.parse(uploadedBytes)
  assert.equal(sha(uploadedBytes), evidence.sha256); assert.deepEqual(uploaded.window, actualWindow)
  assert.deepEqual(uploaded.events.find(row => row.sourceEventId === activeEvent.sourceEventId), autoSource.parsed.events[1])
  const localCapture = hostState.captures.find(row => sameBinding(row.producerBinding, bg) && row.state === 'published'); assert.equal(localCapture.sourceSha256, autoSource.sha256); assert.equal(localCapture.snapshotSha256, evidence.sha256)
  for (const capture of provider.captures) {
    const row = completed.modelRequests.find(row => row.id === capture.modelRequestId)
    assert.equal(row.outcome, 'completed'); assert.equal(row.bodyDigest, capture.bodyDigest); assert(sameBinding(row, capture.binding))
  }
  const nativeSessions = await readDiagnosisSessions(join(hostRoot, 'multisite-executions'))
  for (const execution of [bg, fg]) {
    const session = nativeSessions.find(row => row.sessionId === execution.session_id), input = completed.multisite.inputs.find(row => row.workId === execution.work_id)
    assert(session && input); const expectedMessage = messageId(input.id, execution.attempt_id, execution.session_id)
    assert.equal(session.events.filter(row => row.type === 'user/message' && row.data.id === expectedMessage).length, 1)
  }
  const nativeBg = nativeSessions.find(row => row.sessionId === bg.session_id), call = nativeBg.events.find(row => row.type === 'tool/call' && row.data.name === 'geneway_submit_site_diagnosis' && JSON.parse(row.data.arguments).readId === read.id)
  const returned = call && nativeBg.events.find(row => row.type === 'tool/result' && row.data.message.toolCallId === call.data.callId && row.sourceEventSeqs?.includes(call.seq))
  const end = returned && nativeBg.events.find(row => row.type === 'turn/end' && row.data.turn === call.data.turn && row.seq > returned.seq)
  assert(end, 'Original native submit must retain matching result and subsequent official turn end')
  await writeFile(join(directory, 'actual-uploaded-site-evidence.json'), uploadedBytes)
  await save('prepared-draft-independent-oracle.json', { activeEvent, autoSource, auto, admission, actualWindow, evidence, uploaded, read, page, pageModelRequestId: pageCapture.modelRequestId, draft, cloud: completed, host: hostState, nativeSessions, terminalTool: { call, returned, end }, boundary: 'disk oracle + actual provider body/read/model link; retained SDK result/end exactly' })
  const draftPath = '/api/works/' + background.id + '/site-diagnosis', before = await owner(draftPath)
  assert.equal(before.origin, 'rule'); assert.equal(before.rule.mode, 'simulated'); assert.equal(before.draft.id, draft.id); assert.equal(before.draft.version, 1); assert(before.draft.actionable); assert.deepEqual(before.draft.evidenceRef, read.evidenceRef)
  assert.equal(before.draft.kind, 'site_connection_diagnosis'); assert.equal(before.draft.quality, 'current'); assert.equal(before.accounting.reservedRequests, 3); assert.equal(before.accounting.usageKnown, true)
  const peerDenied = await request('peer', draftPath, undefined, 'GET', 404); assert.equal(peerDenied.error.code, 'NOT_FOUND')
  await save('owner-draft-before-decision.json', before)
  if (waitUI) {
    const completionFile = join(directory, 'site-rule-ui-complete.json')
    await save('site-rule-ui-window.json', { origin, workId: background.id, draftId: draft.id, expectedVersion: 1, decision: 'accepted', completionFile })
    await stage('site-rule-ui-window-ready', { workId: background.id, draftId: draft.id, completionFile })
    await until(() => readOptionalJSON(completionFile), 'independent browser owner decision', 120000)
  } else await owner(draftPath, { draftId: draft.id, expectedVersion: 1, decision: 'accepted' })
  const after = await owner(draftPath), final = await cloud(); assert.equal(after.draft.decision, 'accepted'); assert.equal(after.draft.actionable, false)
  assert.equal(final.siteDiagnosisDrafts.length, 1); assert.equal(final.works.filter(row => row.origin === 'rule').length, 1); assert.equal(final.works.length, 2)
  assert.equal(final.multisite.results.length, 0); assert.equal(final.artifacts.length, 0); assert.equal(final.multisite.jobs.length, 0)
  assert.deepEqual(final.modelRequests, completed.modelRequests); assert.deepEqual(final.multisite.results, completed.multisite.results); assert.deepEqual(final.artifacts, completed.artifacts); assert.deepEqual(final.multisite.jobs, completed.multisite.jobs)
  assert.equal(sha(await readFile(sourceFile)), autoSource.sha256)
  const publicWire = JSON.stringify({ http, captures: provider.captures })
  for (const credential of [identity.credential, pairing.pairingCode, ...Object.values(sessions).flatMap(session => [session.cookie, session.csrfToken])]) { assert(credential); assert(!publicWire.includes(credential), 'Public wire must not include Node, pairing, session or CSRF credentials') }
  await save('owner-draft-after-decision.json', after); await save('terminal-cloud.json', final); await save('terminal-host.json', await local())
  await save('result.json', { result: 'passed', workId: background.id, foregroundWorkId: foreground.id, draftId: draft.id, actualNativeBackgroundModels: ruleCaptures.length, actualNativeForegroundModels: provider.captures.filter(row => row.lane === 'foreground').length, trueObserveAndExactNodeReplayZeroWork: true, actualSameNodeForegroundSlotDuringHeldBackground: true, actualEvidenceReadAndModelLink: true, originalSettleAck: true, ownerDecision: 'accepted', decisionSurface: waitUI ? 'browser with real owner HTTP readback' : 'owner HTTP', nonOwnerReadDenied: true, scope: 'T24b local simulated collector rule only; mock model decisions and price; no real site fault, deployment, external delivery or T25 gain claim' })
} catch (cause) {
  await save('failure.json', { message: cause.message, code: cause.code, stack: cause.stack, errors }); console.error(cause); process.exitCode = 1
} finally {
  const cleanupErrors = [], ports = [origin ? Number(new URL(origin).port) : null, provider ? Number(new URL(provider.origin).port) : null].filter(Boolean)
  try { await provider?.close() } catch (cause) { cleanupErrors.push({ phase: 'provider-close', message: cause.message }) }
  for (const item of [...children].reverse()) try { await stop(item) } catch (cause) { cleanupErrors.push({ pid: item.child.pid, message: cause.message }) }
  for (const identity of descendants.values()) {
    let current = await processIdentity(identity.pid)
    if (current?.startTicks === identity.startTicks) {
      try { process.kill(identity.pid, 'SIGTERM'); facts.push({ kind: 'descendant-signal', ...identity, signal: 'SIGTERM' }) } catch (cause) { if (cause.code !== 'ESRCH') throw cause }
      for (let count = 0; count < 3 && (await processIdentity(identity.pid))?.startTicks === identity.startTicks; count++) await delay(500)
      current = await processIdentity(identity.pid)
      if (current?.startTicks === identity.startTicks) { try { process.kill(identity.pid, 'SIGKILL'); facts.push({ kind: 'descendant-signal', ...identity, signal: 'SIGKILL' }) } catch (cause) { if (cause.code !== 'ESRCH') throw cause }; await delay(500) }
    }
    current = await processIdentity(identity.pid); facts.push({ kind: 'descendant-final', original: identity, current })
    if (current?.startTicks === identity.startTicks) cleanupErrors.push({ ...identity, message: 'Owned descendant still present' })
  }
  const portStates = []
  for (const port of ports) { const listening = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) }); portStates.push({ port, listening }); if (listening) cleanupErrors.push({ port, message: 'Owned port still listening' }) }
  await Promise.all(writes); await save('http-wire.json', http); await save('provider-bodies.json', provider?.captures ?? []); await save('processes.json', facts); await save('errors.json', errors)
  await save('cleanup.json', { owner: await processIdentity(process.pid), errors: cleanupErrors, ports: portStates, children: await Promise.all(children.map(async item => ({ ...item.identity, current: await processIdentity(item.identity.pid) }))) })
  const sourceEnd = await source('end'), sourceChanged = JSON.stringify(sourceStart) !== JSON.stringify(sourceEnd)
  await save('source-comparison.json', { sourceChanged }); if (sourceChanged || cleanupErrors.length) process.exitCode = 1
  console.log(JSON.stringify({ stage: 'closed', directory, pid: process.pid, sourceChanged, exitCode: process.exitCode ?? 0 }))
}
