import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { startChild, signalOwned, processIdentity } from './fixtures/multisite/supervision-process-lifecycle.mjs'
import { startDiagnosisProvider } from './fixtures/multisite/supervision-diagnosis-provider.mjs'
import { readDiagnosisSessions, readOptionalJSON } from './fixtures/multisite/supervision-diagnosis-evidence.mjs'
import { SUPERVISION_DIAGNOSIS_PROMPT, SUPERVISION_DIAGNOSIS_LIMITS } from '../src/supervision-diagnosis-state.mjs'
import { binding, key, sameBinding } from '../packages/agent-contracts/index.mjs'

const selectedModes = ['--repeated-error', '--drift', '--truncated'].filter(flag => process.argv.includes(flag))
assert(selectedModes.length <= 1, 'Select only one diagnosis scenario per run')
const mode = selectedModes[0]?.slice(2) ?? 'normal'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/supervision-diagnosis-')
const apiRoot = join(directory, 'api'), remoteRoot = join(directory, 'remote'), watchRoot = join(directory, 'watchdog')
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2))
const children = [], processes = [], errors = [], events = [], writes = [], observeToken = randomBytes(32).toString('base64url'), diagnosisToken = randomBytes(32).toString('base64url')
const descendants = new Map()
const nodeId = 'diagnosis-node', stateFile = join(apiRoot, 'state.json'), goal = '目标A：核对获准历史与现场证据后形成多来源整改表；当前仅保持明确授权范围，不得将观察陈述冒充已发布成果。'
let provider, api, host, watchdog, origin, session, work
const ordinals = new Map()
const cloud = () => readFile(stateFile, 'utf8').then(JSON.parse)
const flatten = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const sleep = () => new Promise(resolve => setTimeout(resolve, 1000))
function observationDecision(ordinal) {
  if (mode === 'drift') return { calls: [{ name: 'geneway_multisite_report', parameters: { state: 'blocked', summary: ordinal === 1 ? '当前报告仍按目标A核对范围，尚无实际成果。' : '近期只整理目标B的事项；这是执行者报告陈述，不表示任何外部动作或成果已经完成。' } }] }
  return { calls: [{ name: 'geneway_publish_observation', parameters: { clientRequestId: 'no-progress-observation-' + ordinal, instructionRevision: 1, text: '当前仍按目标A核对范围；此观察仅为陈述，没有Evidence或已发布整改表。', evidenceRefs: [] } }] }
}
const rejectedCompletion = ordinal => ({ calls: [{ name: 'geneway_complete_delegation', parameters: { clientRequestId: 'invalid-complete-' + ordinal, instructionRevision: 1, result: { summary: '', evidenceRefs: [] } } }] })
const delegateDecision = () => ({ calls: [{ name: 'geneway_delegate', parameters: { clientRequestId: 'schema-child', instructionRevision: 1, targetAgentId: 'desktop-office', goal: '目标A：返回有界结构回报；没有Evidence不代表读取资料或生成整改表。', requestedCapabilityId: 'office.xlsx.render.v1', resourceRefs: [], resultSchema: 'geneway.delegation-result/1' } }] })
async function observeDiagnosisChildBeforeReply(decision, claim) {
  // The actual diagnostic request is waiting on this provider callback now.
  await rememberDescendants(api.child.pid)
  const privateRoot = join(apiRoot, 'supervision-diagnoses', createHash('sha256').update(claim.sessionId).digest('hex'))
  const observation = [...descendants.values()].find(row => row.diagnosisChild?.cwd === join(privateRoot, 'workspace'))
  assert(observation, 'Actual diagnosis child must be visible while its provider request is pending')
  assert.equal((await processIdentity(observation.pid))?.startTicks, observation.startTicks)
  assert.equal(observation.diagnosisChild.environment.HOME, join(privateRoot, 'home'))
  assert.equal(observation.diagnosisChild.environment.DSH_HOME, join(privateRoot, 'dsh'))
  await save('actual-diagnosis-private-child.json', { observedDuringProviderAt: new Date().toISOString(), observation, sessionId: claim.sessionId, privateRoot, scope: 'actual proc identity and whitelist values during provider request; Node IPC key names only; no token contents' })
  return decision
}
async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout
  for (;;) { for (const item of children) await rememberDescendants(item.child.pid); const value = await predicate(); if (value) return value; assert(Date.now() < deadline, label + ' timed out'); await sleep() }
}
async function rememberDescendants(pid) {
  let nested
  try { nested = (await readFile('/proc/' + pid + '/task/' + pid + '/children', 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch (cause) { if (['ENOENT', 'ESRCH'].includes(cause.code)) return; throw cause }
  for (const id of nested) {
    const identity = await processIdentity(id); if (!identity) continue
    const identityKey = id + ':' + identity.startTicks
    const record = descendants.get(identityKey) ?? { ...identity, observedAt: new Date().toISOString() }
    if (!record.diagnosisChild) {
      try {
        const argv = (await readFile('/proc/' + id + '/cmdline', 'utf8')).split('\0').filter(Boolean)
        if (argv.some(value => value.endsWith('/src/supervision-diagnosis-worker.mjs'))) {
          const { readlink } = await import('node:fs/promises')
          const environment = (await readFile('/proc/' + id + '/environ', 'utf8')).split('\0').filter(Boolean)
          const allowed = new Set(['PATH', 'HOME', 'DSH_HOME', 'DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_DISABLED', 'GENEWAY_DIAGNOSIS_GATEWAY'])
          const ipcNames = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'])
          record.diagnosisChild = { argv, cwd: await readlink('/proc/' + id + '/cwd'), environment: Object.fromEntries(environment.filter(value => allowed.has(value.split('=')[0])).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)])), nodeIPCEnvironmentNames: environment.map(value => value.split('=')[0]).filter(name => ipcNames.has(name)), unexpectedEnvironmentNames: environment.map(value => value.split('=')[0]).filter(name => !allowed.has(name) && !ipcNames.has(name)) }
          assert.equal(record.diagnosisChild.unexpectedEnvironmentNames.length, 0, 'Diagnosis child environment must remain the actual whitelist')
          writes.push(appendFile(join(directory, 'diagnosis-child-observations.jsonl'), JSON.stringify(record) + '\n'))
        }
      } catch (cause) { if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause }
    }
    descendants.set(identityKey, record)
    await rememberDescendants(id)
  }
}
async function stage(name, facts = {}) { for (const item of children) await rememberDescendants(item.child.pid); events.push({ name, at: new Date().toISOString(), ...facts }); await save('events.json', events); console.log(JSON.stringify({ stage: name, directory, pid: process.pid, ...facts })) }
async function owner(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
}
async function spawn(relative, args, env, name) {
  const item = await startChild({ path: fileURLToPath(new URL(relative, import.meta.url)), args, env, directory, name, facts: processes })
  children.push(item); item.messages = []
  item.exited = new Promise(resolve => item.child.once('exit', (code, signal) => resolve({ code, signal })))
  item.closed = new Promise(resolve => item.child.once('close', resolve))
  item.child.on('message', value => { item.messages.push(value); if (['host-error', 'error'].includes(value.kind)) errors.push({ name, ...value }) })
  // startChild already saves stdout/stderr. Preserve every IPC response separately.
  item.child.on('message', value => writes.push(appendFile(join(directory, name + '.ipc.jsonl'), JSON.stringify({ at: new Date().toISOString(), value }) + '\n')))
  return item
}
async function stop(item) {
  if (!item || item.child.exitCode !== null || item.child.signalCode !== null) return
  await rememberDescendants(item.child.pid)
  await signalOwned(item, 'SIGTERM', processes); let timer
  try { await Promise.race([item.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned process TERM grace expired')), 15000) })]) }
  catch (cause) { await signalOwned(item, 'SIGKILL', processes); processes.push({ kind: 'fallback', pid: item.child.pid, reason: cause.message }); await item.exited }
  finally { clearTimeout(timer) }
  await item.closed; const current = await processIdentity(item.identity.pid); assert(!current || current.startTicks !== item.identity.startTicks)
  processes.push({ kind: 'os-final', ...item.identity, gone: true })
}
async function verifyTruncatedRequest(attempt, held) {
  const episode = await until(async () => (await readOptionalJSON(join(watchRoot, 'watchdog-state.json')))?.episodes.find(row => row.finding.classification === 'BUDGET_WITHOUT_PROGRESS' && row.finding.scope.attemptId === attempt.attempt_id && row.findingId && row.submittedAt && row.diagnosisAdmission?.state === 'not_admitted'), 'real watchdog Budget finding and disabled-grant refusal before truncation')
  assert((await cloud()).supervisionFindings.some(row => row.id === episode.findingId && row.episodeId === episode.id))
  async function diagnoseOriginalFinding() {
    const requestedAt = new Date().toISOString(), body = { findingId: episode.findingId }
    const response = await fetch(origin + '/internal/supervision/diagnose', { method: 'POST', headers: { authorization: 'Bearer ' + diagnosisToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json()
    assert.equal(response.status, 200); assert.equal(value.findingId, episode.findingId)
    assert.equal(value.admitted, false); assert.equal(value.state, 'not_admitted'); assert.equal(value.diagnosis, undefined)
    return { requestedAt, respondedAt: new Date().toISOString(), path: '/internal/supervision/diagnose', request: body, status: response.status, response: value }
  }
  async function assertNoDiagnosis(state) {
    assert.equal(state.supervisionDiagnoses.length, 0)
    assert.equal(state.modelRequests.filter(row => row.purpose === 'supervision_diagnosis').length, 0)
    assert.equal(provider.captures.filter(row => row.purpose === 'supervision_diagnosis').length, 0)
    assert.equal([...descendants.values()].filter(row => row.diagnosisChild).length, 0)
    let directories
    try { directories = await readdir(join(apiRoot, 'supervision-diagnoses')) } catch (cause) { if (cause.code !== 'ENOENT') throw cause; directories = [] }
    assert.equal(directories.length, 0, 'No private diagnostic Session directory may be created')
  }
  const offGate = await diagnoseOriginalFinding(), off = await cloud()
  await assertNoDiagnosis(off); assert(!(await owner('/api/works/' + work.id + '/supervision')).grant?.enabled)
  await save('default-off-real-finding.json', { episode, gate: offGate, cloud: off, watchdog: await readOptionalJSON(join(watchRoot, 'watchdog-state.json')) })
  const original = held.modelRequests.find(row => row.purpose === undefined && sameBinding(row, attempt) && row.outcome === 'unknown')
  assert(original && original.completedAt === null)
  assert.equal((await processIdentity(api.identity.pid))?.startTicks, api.identity.startTicks)
  await provider.truncate('fourth-business')
  let nativeTerminal
  await until(async () => {
    const native = (await readDiagnosisSessions(join(remoteRoot, 'multisite-executions', key(attempt.attempt_id, attempt.execution_epoch)))).find(row => row.sessionId === attempt.session_id)
    const end = native?.events.findLast(row => row.type === 'turn/end')
    if (!end) return false
    assert.notEqual(end.data.reason?.kind, 'completed', 'Truncated model transport cannot supply a completed native turn')
    nativeTerminal = { ...native, officialEnd: end, errorEvents: native.events.filter(row => /error|failed/.test(row.type) || row.data?.error) }
    return true
  }, 'actual native turn ends after incomplete provider SSE')
  const cut = await cloud(), retained = cut.modelRequests.find(row => row.id === original.id)
  assert.equal(retained.outcome, 'unknown')
  assert.equal(cut.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, attempt)).length, 4)
  assert.equal(provider.captures.filter(row => row.purpose === 'ordinary').length, 4)
  assert.equal(provider.captures.find(row => row.modelRequestId === original.id).responseEndedAt, undefined)
  await assertNoDiagnosis(cut)
  await save('actual-truncated-native-unknown.json', { originalHeldRow: original, actualAfterCutRow: retained, nativeTerminal, cloud: cut, apiIdentity: await processIdentity(api.identity.pid), boundary: 'same API; incomplete SSE with no DONE; business catch clears private active ownership. completedAt is retained exactly, not synthesized' })
  const businessEffects = state => ({ attempts: state.multisite.attempts.map(binding), modelRequests: state.modelRequests, results: state.multisite.results, jobs: state.multisite.jobs, artifacts: state.artifacts, evidence: state.evidence, commands: state.multisite.commands, messages: state.multisite.messages, inputs: state.multisite.inputs, sourceAdoptions: state.sourceAdoptions, instructionRevision: state.works.find(row => row.id === work.id).instructionRevision })
  const beforeGate = businessEffects(cut)
  const enabled = await owner('/api/works/' + work.id + '/supervision/diagnosis', { enabled: true, expectedInstructionRevision: 1, clientRequestId: 'enable-after-actual-cut' })
  assert(enabled.grant?.enabled)
  const gate = await diagnoseOriginalFinding()
  assert(['RUNTIME_REQUEST_UNKNOWN', 'FORBIDDEN', 'DIAGNOSIS_NOT_ELIGIBLE'].includes(gate.response.reason), 'Retain an actual current-scope refusal; configuration or budget refusal is not this control')
  await until(async () => {
    const observed = await readOptionalJSON(join(watchRoot, 'watchdog-state.json'))
    return observed?.sampledAt > gate.respondedAt && observed.lastSnapshot?.attempts.some(row => sameBinding(row.binding, attempt) && row.modelAccounting.unknownCount === 1)
  }, 'independent watchdog samples original unknown after explicit authorized diagnosis refusal')
  const after = await cloud(); await assertNoDiagnosis(after)
  assert.deepEqual(businessEffects(after), beforeGate)
  assert.equal(after.modelRequests.find(row => row.id === original.id).outcome, 'unknown')
  assert.equal(provider.captures.filter(row => row.purpose === 'ordinary').length, 4)
  assert.equal((await processIdentity(api.identity.pid))?.startTicks, api.identity.startTicks)
  await save('unknown-diagnosis-zero-effects-gate.json', { episodeId: episode.id, findingId: episode.findingId, enabled, gate, beforeGate: cut, afterGate: after, nativeTerminal, watchdog: await readOptionalJSON(join(watchRoot, 'watchdog-state.json')), captures: provider.captures, apiIdentity: await processIdentity(api.identity.pid), zero: { claims: 0, privateSessions: 0, diagnosisForwards: 0, newOrdinaryForwards: 0 } })
  await stop(watchdog)
  return { result: 'passed', mode, workId: work.id, findingId: episode.findingId, originalUnknownRequestId: original.id, actualUnknownCompletedAt: retained.completedAt, actualNativeEndReason: nativeTerminal.officialEnd.data.reason, actualAdmissionReason: gate.response.reason, ordinaryCompletedBeforeCut: 3, fourthActuallyTruncated: true, sameApiIdentity: true, diagnosisClaims: 0, diagnosisSessions: 0, diagnosisForwards: 0, newOrdinaryForwardsAfterCut: 0, scope: 'actual truncated SSE and current-scope diagnosis veto on one existing finding; private Map is not an HTTP diagnostic surface, no runtime or ledger repair' }
}
const sourcePaths = [...new Set(['scripts/probe-supervision-diagnosis.mjs', ...(await readdir('scripts/fixtures/multisite')).filter(name => name.startsWith('supervision-diagnosis-')).map(name => 'scripts/fixtures/multisite/' + name), ...(await readdir('src')).filter(name => name.startsWith('supervision-')).map(name => 'src/' + name), 'config/supervision-diagnosis-runtime.patch.yml', 'src/model-gateway.mjs', 'src/server.mjs', 'src/store/file-store.mjs', 'src/work-budget.mjs', 'src/budget-service.mjs', 'src/node-bridge.mjs', 'src/dsh-host.mjs', 'packages/agent-orchestration/service.mjs', 'packages/agent-orchestration/dependencies.mjs', 'packages/agent-host/remote.mjs', 'packages/agent-host/process-runtime.mjs', 'packages/agent-host/runtime-worker.mjs', 'packages/agent-host/delivery.mjs', 'packages/agent-host/delegation-tools.mjs', 'web/index.html', 'package.json', 'pnpm-lock.yaml'])].sort()
async function sources(phase) {
  await mkdir(join(directory, 'source-' + phase)); const entries = []
  for (const path of sourcePaths) { const bytes = await readFile(path); await writeFile(join(directory, 'source-' + phase, path.replaceAll('/', '__')), bytes); entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
  await save('source-' + phase + '.json', { at: new Date().toISOString(), pid: process.pid, argv: process.argv, entries }); return entries
}
const sourceStart = await sources('start')
await stage('source-start', { argv: process.argv, mode, scope: 'one real native business/watchdog/zero-tool diagnosis chain; controlled HTTP model decisions' })
try {
  assert.equal(SUPERVISION_DIAGNOSIS_LIMITS.cooldownMs, 60000)
  await mkdir(apiRoot, { recursive: true, mode: 0o700 }); await mkdir(remoteRoot, { mode: 0o700 })
  const store = createFileStore(stateFile)
  await store.update(state => { seedDelegation(state); for (const employee of state.employees) { employee.placement = { nodeId, mode: 'agent_host', resourceRefs: [] }; employee.multisitePolicy.execution.resourceRefs = []; employee.multisitePolicy.delegation.resourceRefs = [] } return state })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-diagnosis-provider-only', { mode: 0o600 })
  await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  const authFile = join(apiRoot, 'auth.json'); await initializeAuthFile(authFile, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  const credentials = join(directory, 'credentials'); await mkdir(credentials, { mode: 0o700 })
  await writeFile(join(credentials, 'observe'), observeToken, { mode: 0o600 }); await writeFile(join(credentials, 'diagnose'), diagnosisToken, { mode: 0o600 })
  const supervisionConfig = join(directory, 'supervision-identities.json')
  await writeFile(supervisionConfig, JSON.stringify({ secretRoot: credentials, identities: [{ id: 'diagnosis-observer', role: 'observe', workspaceId: 'local', nodeIds: [nodeId], credentialRef: 'observe' }, { id: 'diagnosis-reader', role: 'diagnose', workspaceId: 'local', nodeIds: [nodeId], credentialRef: 'diagnose', budgetPolicyId: 'diagnosis-simulated-price' }] }), { mode: 0o600 })
  provider = await startDiagnosisProvider({ directory, onError: cause => errors.push({ stage: 'provider', message: cause.message, stack: cause.stack }), async decide(capture) {
    const diagnosis = capture.body.messages.some(message => flatten(message.content).includes(SUPERVISION_DIAGNOSIS_PROMPT))
    if (diagnosis) {
      assert.notEqual(mode, 'truncated', 'A truncated unknown business request must never admit a diagnostic provider forward')
      assert(!capture.body.tools?.length); assert(capture.body.max_tokens <= 512); assert(capture.bodyBytes <= 16384)
      const state = await cloud(), row = state.modelRequests.find(row => row.purpose === 'supervision_diagnosis' && row.bodyDigest === capture.bodyDigest)
      assert(row, 'Actual typed diagnosis reservation must precede provider request')
      const claim = state.supervisionDiagnoses.find(item => item.sessionId === row.diagnosisSessionId)
      assert(claim?.packet.facts.length)
      capture.purpose = 'supervision_diagnosis'; capture.modelRequestId = row.id; capture.diagnosisSessionId = row.diagnosisSessionId
      if (mode === 'repeated-error') {
        const rejected = claim.packet.facts.filter(fact => fact.kind === 'authorized_tool_rejection')
        assert.equal(rejected.length, 3)
        return observeDiagnosisChildBeforeReply({ text: JSON.stringify({ kind: 'repeated_error', refs: rejected.map(fact => fact.id), reason: '当前子分工发生三次已获授权的结构回报拒绝，尚未形成受理结果。', advice: '请核对原结果schema并修正结构；不要将被拒回报当作成果。' }) }, claim)
      }
      if (mode === 'drift') {
        const target = claim.packet.facts.find(fact => fact.kind === 'authorized_goal')
        const statement = claim.packet.facts.findLast(fact => fact.kind === 'executor_statement' && fact.summary?.includes('目标B'))
        assert(target && statement?.statementOnly)
        assert(state.multisite.receipts.some(receipt => receipt.event.event_id === statement.id && receipt.event.kind === 'report' && receipt.event.report.summary.includes('目标B') && !receipt.historical))
        return observeDiagnosisChildBeforeReply({ text: JSON.stringify({ kind: 'possible_drift', refs: [target.id, statement.id], reason: '当前授权目标为A，近期已受理报告陈述却转向目标B；这不证明B已经执行。', advice: '请当前负责人核对目标A与这条报告陈述，确认后续义务范围。' }) }, claim)
      }
      return { text: JSON.stringify({ kind: 'possible_drift', refs: claim.packet.facts.slice(0, 2).map(fact => fact.id), reason: '可能已偏离目标A，需要人工核对当前工作范围。', advice: '请当前负责人核对目标A与最近观察；本建议不代表已经执行任何修正。' }) }
    }
    const state = await cloud(), row = state.modelRequests.findLast(row => row.purpose === undefined && row.bodyDigest === capture.bodyDigest && row.outcome === 'unknown')
    assert(row, 'Actual ordinary reservation must identify its binding before provider response')
    capture.purpose = 'ordinary'; capture.modelRequestId = row.id; capture.subjectBinding = binding(row); capture.agentId = row.agent_id
    capture.ordinal = (ordinals.get(row.attempt_id) ?? 0) + 1; ordinals.set(row.attempt_id, capture.ordinal)
    if (mode === 'repeated-error' && row.agent_id === 'coordinator') {
      if (capture.ordinal === 1) return { hold: 'first-business' }
      if (capture.ordinal === 2) {
        const child = state.multisite.delegations.find(item => item.parentDelegationId === row.delegation_id && item.agentId === 'desktop-office')
        assert(child)
        return { calls: [{ name: 'geneway_wait_dependencies', parameters: { clientRequestId: 'wait-schema-child', instructionRevision: 1, dependencyIds: [child.id] } }] }
      }
      assert.equal(capture.ordinal, 3, 'Only the actual child-result wake may make a third root request')
      return { text: '已收到子分工的有限修正回报；不将其当作已发布整改表。' }
    }
    const toolName = mode === 'repeated-error' ? 'geneway_complete_delegation' : mode === 'drift' ? 'geneway_multisite_report' : 'geneway_publish_observation'
    assert(capture.body.tools.some(tool => tool.function.name === toolName))
    if (capture.ordinal === 1) return { hold: mode === 'repeated-error' ? 'first-subject' : 'first-business' }
    if (capture.ordinal === 4) return { hold: 'fourth-business' }
    assert(capture.ordinal <= 4, 'No extra ordinary model request is authorized')
    return mode === 'repeated-error' ? rejectedCompletion(capture.ordinal) : observationDecision(capture.ordinal)
  } })
  const reserved = createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + reserved.address().port; await new Promise(resolve => reserved.close(resolve))
  api = await spawn('./fixtures/multisite/supervision-diagnosis-api.mjs', [], { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'business-unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: new URL(origin).port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_DIAGNOSIS_FIXTURE_UPSTREAM: provider.origin + '/v1', GENEWAY_SUPERVISION_CONFIG: supervisionConfig }, 'api')
  await until(async () => { assert(api.child.exitCode === null && api.child.signalCode === null); try { return (await fetch(origin)).ok } catch { return false } }, 'formal API ready')
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert.equal(login.status, 200)
  session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  const original = await cloud()
  await owner('/api/admin/budget-policies/diagnosis-simulated-price', { clientRequestId: 'diagnosis-price', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }, 'PUT')
  const pairing = await owner('/api/admin/nodes/pairings', { clientRequestId: 'diagnosis-pair', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: mode === 'repeated-error' ? ['coordinator', 'desktop-office'] : ['coordinator'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  const profile = join(remoteRoot, 'profile.json'); await writeFile(profile, JSON.stringify({ root: remoteRoot, origin, pairing, maxActiveLoops: mode === 'repeated-error' ? 2 : 1, officeEnabled: false }), { mode: 0o600 })
  host = await spawn('../packages/agent-host/remote.mjs', [profile], { PATH: process.env.PATH, HOME: remoteRoot }, 'host')
  await until(() => host.messages.some(row => row.kind === 'ready'), 'native business Host ready')
  work = await owner('/api/works', { clientRequestId: 'diagnosis-work', workType: 'multisite', employeeId: 'coordinator', goal, attachmentRefs: [], spreadsheetRequest: { templateId: 'incident-collaboration-v1', dueDate: null } })
  await until(() => provider.isHeld('first-business'), 'first actual native business request arrived')
  const disabled = await owner('/api/works/' + work.id + '/supervision')
  assert(disabled.configured && !disabled.grant?.enabled, 'Owner browser must observe the default disabled diagnosis grant')
  await save('owner-default-disabled.json', disabled)
  if (mode === 'normal') {
  const browserConfig = { workId: work.id, enableDiagnosis: true, feedbackKind: 'false_positive', requireEvidence: true, stateFile, timeoutMs: 180000, note: '当前最近观察仍明确围绕目标A；请保留原建议并记录此误报反证。' }
  await save('browser-config.json', browserConfig)
  await save('browser-window.json', { origin, configFile: join(directory, 'browser-config.json'), config: browserConfig, enabledFile: join(directory, 'browser-enabled.json'), diagnosisReadyFile: join(directory, 'diagnosis-ready.json'), completionFile: join(directory, 'browser-complete.json') })
  await stage('browser-enable-window-ready', { origin, workId: work.id, configFile: join(directory, 'browser-config.json'), enabledFile: join(directory, 'browser-enabled.json') })
  for (;;) {
    if (await readOptionalJSON(join(directory, 'browser-enabled.json'))) break
    assert(api.child.exitCode === null && api.child.signalCode === null, 'API exited during the owner browser enable window')
    await sleep()
  }
  const enabled = await owner('/api/works/' + work.id + '/supervision')
  assert(enabled.grant?.enabled && enabled.grant.instructionRevision === 1, 'Browser marker must correspond to an actual current owner grant')
  await save('owner-browser-enabled.json', enabled)
  } else if (mode !== 'truncated') {
    const enabled = await owner('/api/works/' + work.id + '/supervision/diagnosis', { enabled: true, expectedInstructionRevision: 1, clientRequestId: 'enable-' + mode })
    assert(enabled.grant?.enabled); await save('owner-http-enabled.json', enabled)
  }
  const current = await cloud(), hostReady = host.messages.find(row => row.kind === 'ready')
  let attempt = current.multisite.attempts.find(row => row.work_id === work.id && row.parent_delegation_id === null)
  const watchConfig = join(directory, 'watchdog-config.json')
  await writeFile(watchConfig, JSON.stringify({ origin, credentialFile: join(credentials, 'observe'), diagnosisCredentialFile: join(credentials, 'diagnose'), root: watchRoot, intervalMs: 500, timeoutMs: 10000, stageDeadlineMs: 60000, jobDeadlineMs: 300000, repeatedErrorCount: 3, budgetWithoutProgressRequests: 3, processes: [{ name: 'api', ...api.identity, nodeId }, { name: 'host', ...host.identity, nodeId }], scope: { workId: work.id, attemptId: attempt.attempt_id, nodeId, nodeInstanceId: hostReady.nodeInstanceId } }), { mode: 0o600 })
  watchdog = await spawn('../src/supervision-watchdog.mjs', [watchConfig], { PATH: process.env.PATH, HOME: join(directory, 'watchdog-home') }, 'watchdog')
  await until(async () => (await readOptionalJSON(join(watchRoot, 'watchdog-state.json')))?.lastSnapshot?.attempts.some(row => row.binding.attempt_id === attempt.attempt_id && row.observedRevision === 1), 'independent watchdog current Input/checkpoint baseline')
  await provider.release('first-business', mode === 'repeated-error' ? delegateDecision() : observationDecision(1))
  if (mode === 'repeated-error') {
    await until(() => provider.isHeld('first-subject'), 'real delegated child first native request')
    attempt = (await cloud()).multisite.attempts.find(row => row.work_id === work.id && row.agent_id === 'desktop-office')
    assert(attempt?.parent_delegation_id)
    assert.equal((await cloud()).multisite.delegations.find(row => row.id === attempt.delegation_id).resultSchema, 'geneway.delegation-result/1')
    await until(async () => {
      const observed = await readOptionalJSON(join(watchRoot, 'watchdog-state.json'))
      const local = JSON.parse(await readFile(join(remoteRoot, 'host-journal.json'), 'utf8'))
      return observed?.lastSnapshot?.attempts.some(row => sameBinding(row.binding, attempt) && row.observedRevision === 1) && local.executions.some(row => row.parent_delegation_id === null && row.waitStatus === 'waiting_dependency' && row.slotHeld === false)
    }, 'watchdog actual child Input and root dependency wait with released slot')
    await save('real-child-before-rejections.json', { attempt, cloud: await cloud(), watchdog: await readOptionalJSON(join(watchRoot, 'watchdog-state.json')) })
    await provider.release('first-subject', rejectedCompletion(1))
  }
  await until(() => provider.isHeld('fourth-business'), 'fourth actual request held at provider')
  const held = await cloud(), ordinary = held.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, attempt))
  assert.equal(ordinary.filter(row => row.outcome === 'completed' && row.completedAt).length, 3)
  assert.equal(ordinary.filter(row => row.outcome === 'unknown' && row.completedAt === null).length, 1)
  if (mode === 'repeated-error') {
    const rejections = held.supervisionToolRejections.filter(row => sameBinding(row.subjectBinding, attempt))
    assert.equal(rejections.length, 3); assert.equal(new Set(rejections.map(row => row.clientRequestId)).size, 3)
    assert(rejections.every(row => row.tool === 'complete_delegation' && row.code === 'RESULT_SCHEMA_INVALID'))
    assert.equal(held.multisite.results.filter(row => sameBinding(row.senderBinding, attempt)).length, 0)
    assert(!held.multisite.commands.some(row => rejections.some(rejection => row.key === key('local', attempt.attempt_id, rejection.clientRequestId))))
    await save('three-real-structure-rejections.json', { attempt, rejections, cloud: held, scope: 'actual native child SDK calls and server-authorized semantic rejection; no accepted result or successful command yet' })
  }
  if (mode === 'drift') await until(async () => (await cloud()).multisite.receipts.filter(row => !row.historical && sameBinding(row.event, attempt) && row.event.kind === 'report' && row.event.report.summary.includes('目标B')).length >= 1, 'actual accepted native report statement about B')
  await save('three-completed-fourth-held.json', { cloud: held, captures: provider.captures, watchdog: await readOptionalJSON(join(watchRoot, 'watchdog-state.json')) })
  await stage('three-completed-fourth-held', { origin, workId: work.id, apiPid: api.child.pid, hostPid: host.child.pid, watchdogPid: watchdog.child.pid })
  let scenarioResult
  if (mode === 'truncated') scenarioResult = await verifyTruncatedRequest(attempt, held)
  else {
  const diagnosis = await until(async () => {
    const row = (await cloud()).supervisionDiagnoses.find(row => row.workId === work.id && sameBinding(row.subjectBinding, attempt))
    assert(!row || !['failed', 'unknown'].includes(row.state), 'Actual diagnosis ended ' + row?.state + ': ' + row?.errorCode)
    return row?.state === 'completed' ? row : false
  }, 'actual independent diagnosis Session completed')
  assert(provider.isHeld('fourth-business'))
  const diagnosed = await cloud(), diagnosisLedger = diagnosed.modelRequests.find(row => row.id === diagnosis.modelRequestId), diagnosisCapture = provider.captures.find(row => row.modelRequestId === diagnosis.modelRequestId)
  assert.equal(diagnosisLedger.outcome, 'completed'); assert(diagnosisCapture)
  assert.equal(diagnosisCapture.bodyDigest, diagnosisLedger.bodyDigest)
  assert.equal(diagnosed.modelRequests.filter(row => row.purpose === undefined && sameBinding(row, attempt) && row.outcome === 'unknown').length, 1)
  if (mode === 'repeated-error') {
    assert.equal(diagnosed.supervisionFindings.find(row => row.id === diagnosis.findingId).classification, 'REPEATED_ERROR')
    assert.equal(diagnosis.result.kind, 'repeated_error')
    assert.equal(diagnosis.packet.facts.filter(fact => fact.kind === 'authorized_tool_rejection').length, 3)
  }
  if (mode === 'drift') {
    assert.equal(diagnosis.result.kind, 'possible_drift')
    assert(diagnosis.result.refs.some(id => diagnosis.packet.facts.some(fact => fact.id === id && fact.kind === 'authorized_goal')))
    assert(diagnosis.result.refs.some(id => diagnosis.packet.facts.some(fact => fact.id === id && fact.kind === 'executor_statement' && fact.statementOnly && fact.summary.includes('目标B'))))
  }
  const sessions = await readDiagnosisSessions(directory), sessionDirectory = createHash('sha256').update(diagnosis.sessionId).digest('hex')
  const matchingSessions = sessions.filter(row => row.sessionId === diagnosis.sessionId && row.path.split('/').includes(sessionDirectory))
  assert.equal(matchingSessions.length, 1, 'Actual Session header ID and private manager hash directory must select one diagnosis Session')
  const diagnosticSession = matchingSessions[0]
  assert.equal(diagnosticSession.events.filter(row => row.type === 'tool/call').length, 0)
  assert(diagnosticSession.events.some(row => row.type === 'assistant/message'))
  assert(diagnosticSession.events.some(row => row.type === 'turn/end' && row.data.reason?.kind === 'completed'))
  if (mode === 'repeated-error') {
    const childSession = sessions.find(row => row.sessionId === attempt.session_id)
    assert(childSession)
    const rejectedTools = [1, 2, 3].map(ordinal => {
      const call = childSession.events.find(event => event.type === 'tool/call' && event.data.name === 'geneway_complete_delegation' && (() => { const args = JSON.parse(event.data.arguments); return args.clientRequestId === 'invalid-complete-' + ordinal && args.result.summary === '' })())
      const returned = call && childSession.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId && event.sourceEventSeqs?.includes(call.seq))
      assert(returned?.data.message.isError, 'Each real semantic rejection must retain its actual SDK error result')
      return { call, returned }
    })
    await save('three-original-rejected-native-tools.json', { sessionId: childSession.sessionId, path: childSession.path, rejectedTools })
  }
  await save('diagnosis-before-business-release.json', { diagnosis, ledger: diagnosisLedger, capture: diagnosisCapture, sessions, watchdog: await readOptionalJSON(join(watchRoot, 'watchdog-state.json')), cloud: diagnosed })
  await stop(watchdog)
  if (mode === 'repeated-error') {
    const summary = '目标A的结构回报已修正；没有Evidence，仅证明本次有限回报结构被受理，不证明来源读取或整改表完成。'
    await provider.release('fourth-business', { calls: [{ name: 'geneway_complete_delegation', parameters: { clientRequestId: 'invalid-complete-3', instructionRevision: 1, result: { summary, evidenceRefs: [] } } }] })
    await until(async () => (await cloud()).multisite.results.some(row => sameBinding(row.senderBinding, attempt)), 'same previously rejected clientRequestId accepts an actual valid child result')
    const corrected = await cloud(), result = corrected.multisite.results.find(row => sameBinding(row.senderBinding, attempt)), receipt = corrected.multisite.commands.find(row => row.key === key('local', attempt.attempt_id, 'invalid-complete-3'))
    assert.equal(corrected.multisite.results.filter(row => sameBinding(row.senderBinding, attempt)).length, 1)
    assert.equal(result.schema, 'geneway.delegation-result/1'); assert.equal(result.payload.summary, summary)
    assert.equal(receipt.reply.resultId, result.id)
    await until(async () => {
      const local = JSON.parse(await readFile(join(remoteRoot, 'host-journal.json'), 'utf8'))
      return local.executions.some(row => sameBinding(row, attempt) && row.status === 'settled' && row.slotHeld === false)
    }, 'actual corrected child settled with released slot before reading its final native frames')
    let terminalEvidence
    await until(async () => {
      const native = (await readDiagnosisSessions(join(remoteRoot, 'multisite-executions', key(attempt.attempt_id, attempt.execution_epoch)))).find(row => row.sessionId === attempt.session_id)
      const call = native?.events.findLast(event => event.type === 'tool/call' && event.data.name === 'geneway_complete_delegation' && (() => { const args = JSON.parse(event.data.arguments); return args.clientRequestId === 'invalid-complete-3' && args.result.summary === summary })())
      const returned = call && native.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId && event.sourceEventSeqs?.includes(call.seq))
      const end = returned && native.events.find(event => event.type === 'turn/end' && event.data.turn === call.data.turn && event.seq > returned.seq)
      if (!end) return false
      terminalEvidence = { sessionId: native.sessionId, path: native.path, call, returned, end }; return true
    }, 'actual final corrected tool call has its corresponding result and subsequent official turn end')
    await save('same-key-corrected-real-result.json', { attempt, result, receipt, retainedRejections: corrected.supervisionToolRejections.filter(row => sameBinding(row.subjectBinding, attempt)), terminalEvidence, scope: 'original semantic rejection did not reserve successful idempotency key; SDK tool/error and official end preserved exactly' })
    await until(() => provider.captures.some(row => row.agentId === 'coordinator' && row.ordinal === 3 && row.responseEndedAt), 'root receives its actual dependency wake without generating another result')
  } else await provider.release('fourth-business', { text: mode === 'drift' ? '以上仅为目标B相关报告陈述，不代表B已执行或已有成果；请人工核对目标A。' : '目标A保持不变；本次仅记录有限观察，不声称成果已生成。' })
  await until(async () => (await cloud()).modelRequests.filter(row => row.purpose === undefined).every(row => row.outcome === 'completed'), 'fourth original request completed without retry')
  const view = await owner('/api/works/' + work.id + '/supervision')
  await save('owner-before-feedback.json', view)
  if (mode === 'normal') {
  await save('diagnosis-ready.json', { workId: work.id, diagnosisId: diagnosis.id, ordinaryFourthCompleted: true, at: new Date().toISOString(), ack: { kind: 'supervision-ui-ack', phase: 'diagnosis-enabled' } })
  await stage('diagnosis-ready-for-browser-feedback', { origin, workId: work.id, diagnosisId: diagnosis.id, diagnosisReadyFile: join(directory, 'diagnosis-ready.json'), completionFile: join(directory, 'browser-complete.json') })
  for (;;) {
    if (await readOptionalJSON(join(directory, 'browser-complete.json'))) break
    assert(api.child.exitCode === null && api.child.signalCode === null, 'API exited while owner browser was using its authorized window')
    await sleep()
  }
  const finalView = await owner('/api/works/' + work.id + '/supervision'), corrected = await cloud()
  assert(corrected.supervisionDiagnosisFeedback.some(row => row.diagnosisId === diagnosis.id && row.actorId === 'owner' && row.kind === 'false_positive' && row.refs.length > 0))
  await save('owner-feedback-refreshed.json', finalView)
  }
  scenarioResult = { result: 'passed', mode, scope: 'one actual scenario only; controlled model decisions do not establish model diagnosis accuracy or actual target-B execution', workId: work.id, diagnosisId: diagnosis.id, subject: binding(attempt), actualSubjectOrdinaryCompletedBeforeFourth: 3, fourthActuallyHeldDuringDiagnosisForward: true, providerRequests: provider.captures.length, nativeBusiness: true, nativeDiagnosis: true, independentWatchdog: true, ownerFeedbackThroughRealAPIAndBrowser: mode === 'normal', actualRejectedChildCalls: mode === 'repeated-error' ? 3 : null, sameRejectedKeyCorrectedResult: mode === 'repeated-error', actualAcceptedReportBStatement: mode === 'drift', syntheticPrice: { currency: 'CNY', numerator: 1, denominator: 1, fixedInputTokens: 0, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 } }
  }
  await owner('/api/works/' + work.id + '/multisite/cancel', { clientRequestId: 'diagnosis-final-stop' })
  await until(async () => (await cloud()).works.find(row => row.id === work.id).status === 'cancelled', 'own business execution real cancellation')
  await save('terminal-cloud.json', await cloud()); await save('terminal-sessions.json', await readDiagnosisSessions(directory))
  await save('result.json', scenarioResult)
} catch (cause) {
  await save('failure.json', { message: cause.message, code: cause.code, stack: cause.stack, errors }); console.error(cause); process.exitCode = 1
} finally {
  const cleanupErrors = []
  for (const item of [...children].reverse()) try { await stop(item) } catch (cause) { cleanupErrors.push({ pid: item.child.pid, message: cause.message }) }
  for (const identity of descendants.values()) {
    let current = await processIdentity(identity.pid)
    if (current?.startTicks === identity.startTicks) {
      process.kill(identity.pid, 'SIGTERM'); processes.push({ kind: 'descendant-signal', ...identity, signal: 'SIGTERM' })
      for (let attempt = 0; attempt < 3 && (await processIdentity(identity.pid))?.startTicks === identity.startTicks; attempt++) await sleep()
      current = await processIdentity(identity.pid)
      if (current?.startTicks === identity.startTicks) { process.kill(identity.pid, 'SIGKILL'); processes.push({ kind: 'descendant-signal', ...identity, signal: 'SIGKILL' }); await sleep() }
    }
    current = await processIdentity(identity.pid)
    if (current?.startTicks === identity.startTicks) cleanupErrors.push({ ...identity, message: 'Owned descendant still present after cleanup' })
    processes.push({ kind: 'descendant-final', original: identity, current })
  }
  const providerPort = provider ? Number(new URL(provider.origin).port) : null
  await provider?.close(); await Promise.all(writes)
  await save('provider-bodies.json', provider?.captures ?? []); await save('processes.json', processes); await save('errors.json', errors)
  const ports = [origin ? Number(new URL(origin).port) : null, providerPort].filter(Boolean), portStates = []
  for (const port of ports) { const listening = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) }); portStates.push({ port, listening }); if (listening) cleanupErrors.push({ port, message: 'Owned port still listening' }) }
  await save('cleanup.json', { errors: cleanupErrors, ports: portStates, children: await Promise.all(children.map(async item => ({ ...item.identity, current: await processIdentity(item.identity.pid) }))) })
  const sourceEnd = await sources('end'), sourceChanged = JSON.stringify(sourceStart) !== JSON.stringify(sourceEnd)
  await save('source-comparison.json', { sourceChanged }); if (sourceChanged || cleanupErrors.length) process.exitCode = 1
  console.log(JSON.stringify({ stage: 'closed', directory, sourceChanged, exitCode: process.exitCode ?? 0 }))
}
