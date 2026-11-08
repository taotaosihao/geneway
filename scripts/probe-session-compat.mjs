import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fork, execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { processIdentity, waitFor, stopOwned } from './fixtures/multisite/supervision-process-lifecycle.mjs'
import { createSessionCompatibilityProvider } from './fixtures/multisite/r15-provider.mjs'

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const oldArchive = resolve(option('--old-archive') ?? ''), newArchive = resolve(option('--new-archive') ?? ''), newSha256 = option('--new-sha256')
assert(option('--old-archive') && option('--new-archive') && /^[a-f0-9]{64}$/.test(newSha256 ?? ''), 'Required: --old-archive PATH --new-archive PATH --new-sha256 SHA256 [--directory NEW_ABSOLUTE_PATH]')
assert.notEqual(newSha256, 'aa4f13cb8e2000254904bb69e4d1648e25f1d6dfc778204ce475f3a72f0d2f08', 'Candidate must be a distinct frozen archive')
assert.equal(process.platform + '/' + process.arch + '/' + process.versions.node, 'linux/x64/26.5.0')
const oldSha256 = 'aa4f13cb8e2000254904bb69e4d1648e25f1d6dfc778204ce475f3a72f0d2f08', execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const requestedDirectory = option('--directory')
if (requestedDirectory) assert(isAbsolute(requestedDirectory) && resolve(requestedDirectory) === requestedDirectory, 'Evidence directory must be a new absolute path')
const directory = requestedDirectory ?? await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/session-compat-')
if (requestedDirectory) await mkdir(directory, { recursive: false, mode: 0o700 })
const apiRoot = join(directory, 'api'), dataRoot = join(directory, 'host-data'), home = join(directory, 'fresh-home'), profile = join(directory, 'profile.json'), facts = [], children = [], logs = []
const input1 = '先核对本次兼容任务并报告等待用户补充，不执行外部动作。', input2 = '原用户明确补充：请继续原任务并报告续办结果。INPUT2_' + randomBytes(12).toString('hex')
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
let provider, api, origin, actor, oldHost, newHost, store, completed = false
const fixtureEntry = fileURLToPath(new URL('./fixtures/multisite/r15-package-host.mjs', import.meta.url)), env = { PATH: process.env.PATH, HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' }
async function listen(server) { await new Promise(done => server.listen(0, '127.0.0.1', done)); return 'http://127.0.0.1:' + server.address().port }
async function start(path, parameters, values, name) {
  const child = fork(path, parameters, { cwd: directory, env: values, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), identity = await processIdentity(child.pid)
  assert(identity); const item = { child, identity, name, messages: [], exit: null }; children.push(item)
  facts.push({ kind: 'start', name, ...identity, at: new Date().toISOString() })
  child.on('message', message => { item.messages.push(message); void save(name + '-messages.json', item.messages) })
  child.once('exit', (code, signal) => { item.exit = { code, signal }; facts.push({ kind: 'exit', name, pid: child.pid, startTicks: identity.startTicks, code, signal, at: new Date().toISOString() }) })
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => { const pending = appendFile(join(directory, name + '.' + stream + '.log'), bytes, { mode: 0o600 }); logs.push(pending) })
  return item
}
async function ready(item) { return waitFor(() => { assert(!item.exit, item.name + ' exited before ready'); return item.messages.find(row => row.kind === 'ready') }, item.name + ' ready', 90000) }
async function owner(path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { origin, cookie: actor.cookie, 'x-csrf-token': actor.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value)); return value
}
async function journal() { return JSON.parse(await readFile(join(dataRoot, 'host-journal.json'), 'utf8')) }
async function packageFromArchive(archive, sha256, name) {
  const bytes = await readFile(archive); assert.equal(hash(bytes), sha256, name + ' archive SHA mismatch')
  const install = join(directory, name); await mkdir(install); await execute('tar', ['-xzf', archive, '-C', install])
  const root = join(install, 'geneway-agent-host'), manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'))
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x64'); assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
  for (const row of manifest.files.filter(row => row.symlink)) assert((await realpath(join(root, row.path))).startsWith(root + '/'))
  const moduleSources = []
  for (const name of ['remote.mjs', 'journal.mjs', 'host.mjs', 'dsh-runtime.mjs', 'process-runtime.mjs', 'runtime-worker.mjs']) { const path = await realpath(join(root, 'packages/agent-host', name)); assert(path.startsWith(root + '/')); const content = await readFile(path); moduleSources.push({ path, bytes: content.length, sha256: hash(content) }) }
  await save(name + '-package.json', { archive, sha256, bytes: bytes.length, root, manifest, moduleSources })
  return root
}
async function workers(item, root) {
  const pids = (await readFile(`/proc/${item.child.pid}/task/${item.child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number), result = []
  for (const pid of pids) {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    if (!cmdline.includes('/packages/agent-host/runtime-worker.mjs')) continue
    assert(cmdline.includes(root + '/packages/agent-host/runtime-worker.mjs'))
    const identity = await processIdentity(pid), cwd = await readlink(`/proc/${pid}/cwd`)
    assert(identity && cwd.startsWith(dataRoot + '/multisite-executions/')); result.push({ ...identity, cwd, cmdline })
  }
  return result
}
async function gone(identities, label) {
  await waitFor(async () => (await Promise.all(identities.map(async item => { const current = await processIdentity(item.pid); return !current || current.startTicks !== item.startTicks }))).every(Boolean), label, 45000)
  await save(label + '.json', identities.map(item => ({ pid: item.pid, startTicks: item.startTicks, originalIdentityGone: true })))
}
function reportTail(rows, reportEvent, inputText) {
  const call = rows.find(row => row.type === 'tool/call' && row.data.name === 'geneway_multisite_report' && digest(typeof row.data.arguments === 'string' ? JSON.parse(row.data.arguments) : row.data.arguments) === digest(reportEvent.report))
  if (!call) return null
  const turnStart = rows.findLast(row => row.type === 'turn/start' && row.data.turn === call.data.turn && row.seq < call.seq)
  assert(turnStart, 'Report tool call has no matching turn/start')
  const result = rows.find(row => row.type === 'tool/result' && row.seq > call.seq && row.data.turn === call.data.turn && row.data.step === call.data.step && row.data.message?.toolCallId === call.data.callId && row.data.message?.source?.callId === call.data.callId)
  if (!result) return null
  assert.equal(result.data.message.isError, false, 'Actual report tool result isError is not false')
  assert(result.sourceEventSeqs?.includes(call.seq), 'Tool result does not reference the matching call seq')
  const end = rows.find(row => row.type === 'turn/end' && row.data.turn === call.data.turn && row.seq > result.seq)
  if (!end) return null
  assert(!rows.some(row => row.type === 'turn/start' && row.seq > turnStart.seq && row.seq < end.seq), 'Report tail crosses into another turn')
  assert(['completed', 'blocked'].includes(end.data.reason?.kind), 'Report turn ended abnormally: ' + JSON.stringify(end.data.reason))
  const inputs = rows.filter(row => row.type === 'user/message' && row.seq > turnStart.seq && row.seq < call.seq && JSON.stringify(row.data.content).includes(inputText))
  assert.equal(inputs.length, 1, 'Matching report turn must consume its exact owner Input once')
  return { cloudReportEvent: reportEvent, turnStart, input: inputs[0], call, result, actualIsError: result.data.message.isError, end, actualReason: end.data.reason }
}
async function decodeSession(compressed) {
  const stdout = await new Promise((done, reject) => {
    const child = execFile('zstd', ['-dc'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (cause, stdout) => cause ? reject(cause) : done(stdout))
    child.stdin.on('error', reject); child.stdin.end(compressed)
  })
  // Decode the complete output of every concatenated frame once, including UTF-8 split across frames.
  const rows = stdout.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0]?.type, 'session'); assert.equal(rows[0]?.version, 4); assert(rows.length > 1)
  return { compressed, stdout, rows }
}
async function sessionSnapshot(label, qualification) {
  const paths = []
  async function find(path) { for (const row of await readdir(path, { withFileTypes: true })) { const next = join(path, row.name); if (row.isDirectory()) await find(next); else if (row.name === 'session.v4.jsonl.zstd') paths.push(next) } }
  await find(join(dataRoot, 'multisite-executions')); assert.equal(paths.length, 1, 'Expected one original Session')
  let snapshot
  async function read() {
    let current
    try { current = await decodeSession(await readFile(paths[0])) }
    catch (cause) { if (qualification?.waitForTail && cause.code === 1) return false; throw cause }
    const tail = qualification ? reportTail(current.rows, qualification.event, qualification.input) : null
    if (qualification && !tail) { if (qualification.waitForTail) return false; assert.fail('Final stopped Session lacks its exact report/result/normal tail') }
    snapshot = { ...current, tail }; return true
  }
  if (qualification?.waitForTail) await waitFor(read, label + ' exact SDK report/result/normal turn tail', 90000)
  else await read()
  await writeFile(join(directory, label + '.session.v4.jsonl.zstd'), snapshot.compressed, { mode: 0o600 }); await writeFile(join(directory, label + '.session.jsonl'), snapshot.stdout, { mode: 0o600 })
  await save(label + '-session.json', { path: paths[0], compressedSha256: hash(snapshot.compressed), rows: snapshot.rows, tail: snapshot.tail })
  return { path: paths[0], rows: snapshot.rows, tail: snapshot.tail }
}
function exactAck(local, cloud, kind, execution) {
  const rows = local.outbox.filter(row => row.event.kind === kind && row.acknowledged && JSON.stringify(binding(row.event)) === JSON.stringify(binding(execution)))
  return rows.findLast(row => cloud.multisite.receipts.some(receipt => receipt.event.event_id === row.event.event_id && receipt.event.payload_digest === row.event.payload_digest && JSON.stringify(receipt.event) === JSON.stringify(row.event)))
}
console.log(JSON.stringify({ stage: 'prepare', directory, pid: process.pid, oldArchive, newArchive }))
try {
  for (const path of [apiRoot, dataRoot, home]) await mkdir(path)
  const [oldPackage, newPackage] = await Promise.all([packageFromArchive(oldArchive, oldSha256, 'old'), packageFromArchive(newArchive, newSha256, 'candidate')])
  store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(state => { seedDelegation(state); state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; for (const employee of state.employees) { employee.skillIds = ['cycle']; employee.placement = { nodeId: employee.id === 'gateway' ? 'compat-g' : 'unused', mode: 'agent_host', resourceRefs: [] }; employee.multisitePolicy.execution.resourceRefs = [] }; return state })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-session-compat-provider', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 }); await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  provider = createSessionCompatibilityProvider({ save, input2 }); const upstream = await listen(provider.server), reserve = createServer(); origin = await listen(reserve); await new Promise(done => reserve.close(done))
  api = await start(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { ...env, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: new URL(origin).port, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: upstream + '/v1' }, 'api')
  await waitFor(async () => { assert(!api.exit, 'API exited'); try { return (await fetch(origin)).ok } catch { return false } }, 'API ready')
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); assert.equal(login.status, 200); actor = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  const pairing = await owner('/api/admin/nodes/pairings', { clientRequestId: 'compat-pair', nodeId: 'compat-g', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['gateway'], expiresAt: new Date(Date.now() + 120000).toISOString() })
  await writeFile(profile, JSON.stringify({ root: dataRoot, origin, pairing, officeEnabled: false }), { mode: 0o600 }); assert(!input1.includes(provider.marker) && !input2.includes(provider.marker))
  oldHost = await start(fixtureEntry, [oldPackage, profile], env, 'old-host'); const oldReady = await ready(oldHost)
  const work = await owner('/api/works', { workType: 'multisite', employeeId: 'gateway', goal: input1, clientRequestId: 'compat-work', attachmentRefs: [] }), workId = work.id ?? work.workId
  await waitFor(async () => {
    const local = await journal(), cloud = await store.read(), execution = local.executions[0]
    return execution?.runtimeStarted === true && execution.status === 'running' && execution.observed_revision === 1 && execution.waitStatus === 'waiting_input' && execution.slotHeld === false && local.inbox.some(row => row.status === 'ingested' && row.command.instruction_revision === 1) && local.outbox.every(row => row.acknowledged) && exactAck(local, cloud, 'report', execution)?.event.report.state === 'waiting' && cloud.modelRequests.length === 2 && cloud.modelRequests.every(row => row.outcome === 'completed') && local.jobs.length === 0
  }, 'old real waiting report ACK and official idle/flush slot release', 90000)
  const waiting = await journal(), waitingCloud = await store.read(), original = waiting.executions[0], identityBytes = await readFile(join(dataRoot, 'node-identity.json')), identity = JSON.parse(identityBytes), oldWorkers = await workers(oldHost, oldPackage)
  assert.equal(oldWorkers.length, 1); assert.equal(waiting.executions.length, 1); assert.equal(provider.bodies.length, 2); assert.equal(provider.failures.length, 0)
  const waitingReport = exactAck(waiting, waitingCloud, 'report', original).event
  const oldSession = await sessionSnapshot('old-waiting', { event: waitingReport, input: input1, waitForTail: true }); assert.equal(oldSession.rows[0].id, original.session_id); assert.equal(oldSession.rows[0].cwd, oldWorkers[0].cwd)
  assert.equal(oldSession.rows.filter(row => row.type === 'user/message').length, 1); assert(oldSession.rows.some(row => row.type === 'assistant/message' && JSON.stringify(row.data.message).includes(provider.marker)))
  assert(!oldSession.rows.some(row => ['user/message', 'system/message', 'tool/call', 'tool/result'].includes(row.type) && JSON.stringify(row.data).includes(provider.marker)))
  await save('old-waiting-facts.json', { oldReady, waiting, cloud: waitingCloud, workers: oldWorkers, exactSdkReportTail: oldSession.tail, marker: provider.marker, input1, input2, identity: { nodeId: identity.nodeId, nodeInstanceId: identity.nodeInstanceId, credentialVersion: identity.credentialVersion } })
  const beforeContender = await readFile(join(dataRoot, 'host-journal.json')), contender = await start(fixtureEntry, [newPackage, profile], env, 'candidate-contender')
  await waitFor(() => contender.exit, 'same-root contender rejection'); assert.equal(contender.exit.code, 1); assert(contender.messages.some(row => row.kind === 'start-error' && row.code === 'HOST_ALREADY_RUNNING')); assert(!contender.messages.some(row => row.kind === 'ready'))
  assert.deepEqual(await readFile(join(dataRoot, 'host-journal.json')), beforeContender); assert.deepEqual(await readFile(join(dataRoot, 'node-identity.json')), identityBytes); assert.equal(provider.bodies.length, 2); assert.deepEqual((await store.read()).modelRequests, waitingCloud.modelRequests)
  const afterContenderWorkers = await workers(oldHost, oldPackage); assert.deepEqual(afterContenderWorkers.map(({ state, ...row }) => row), oldWorkers.map(({ state, ...row }) => row))
  await save('contender-rejected.json', { exit: contender.exit, messages: contender.messages, forwardCount: provider.bodies.length, oldWorkersUnchanged: true, hostAndWorkerPids: oldWorkers, boundary: 'Ordinary new package Host rejected by original dataRoot owner before runtime creation; no managed update or Journal edit' })
  await stopOwned(oldHost, facts); await gone([oldHost.identity, ...oldWorkers], 'old-parent-and-dsh-gone'); assert.deepEqual(await journal(), waiting)
  const frozen = await sessionSnapshot('old-parent-closed', { event: waitingReport, input: input1 }); assert.deepEqual(frozen.rows.slice(0, oldSession.rows.length), oldSession.rows); await save('before-new-host-cloud.json', await store.read())
  newHost = await start(fixtureEntry, [newPackage, profile], env, 'candidate-host'); const newReady = await ready(newHost)
  assert.equal(newReady.nodeInstanceId, oldReady.nodeInstanceId); assert.notEqual(newReady.hostRunId, oldReady.hostRunId)
  await new Promise(done => setTimeout(done, 1500)); assert.equal(provider.bodies.length, 2); assert.deepEqual((await store.read()).modelRequests, waitingCloud.modelRequests); assert.deepEqual(await readFile(join(dataRoot, 'node-identity.json')), identityBytes); assert.equal((await workers(newHost, newPackage)).length, 0)
  const reopened = await journal(); assert.equal(reopened.executions[0].status, 'running'); assert.equal(reopened.executions[0].slotHeld, false); assert.deepEqual(binding(reopened.executions[0]), binding(original)); await save('new-host-without-input.json', { newReady, local: reopened, cloud: await store.read(), quietObservationMs: 1500, forwardCount: provider.bodies.length })
  provider.authorizeInput2(); const inputReceipt = await owner(`/api/works/${workId}/multisite/inputs`, { clientRequestId: 'compat-input2', text: input2 }); await save('owner-input2-receipt.json', inputReceipt)
  await waitFor(async () => { const cloud = await store.read(), local = await journal(), execution = local.executions[0]; return cloud.multisite.attempts.length === 1 && cloud.multisite.attempts[0].report?.state === 'ready' && cloud.multisite.attempts[0].observed_revision === 2 && local.inbox.some(row => row.command.instruction_revision === 2 && row.status === 'ingested') && exactAck(local, cloud, 'report', execution)?.event.report.state === 'ready' && provider.bodies.length === 4 && cloud.modelRequests.length === 4 && cloud.modelRequests.every(row => row.outcome === 'completed') }, 'real resumed SDK Input2 report and exact ACK', 90000)
  const resumed = await journal(), resumedCloud = await store.read(), newWorkers = await workers(newHost, newPackage), resumedReport = exactAck(resumed, resumedCloud, 'report', resumed.executions[0]).event
  const resumedSession = await sessionSnapshot('candidate-resumed', { event: resumedReport, input: input2, waitForTail: true })
  assert.equal(provider.failures.length, 0); assert.equal(newWorkers.length, 1); assert.equal(newWorkers[0].cwd, oldWorkers[0].cwd); assert.equal(resumedSession.path, frozen.path); assert.deepEqual(resumedSession.rows.slice(0, frozen.rows.length), frozen.rows)
  assert.deepEqual(binding(resumed.executions[0]), binding(original)); assert.deepEqual(binding(resumedCloud.multisite.attempts[0]), binding(original)); assert.equal(resumed.executions.length, 1)
  const users = resumedSession.rows.filter(row => row.type === 'user/message'); assert.equal(users.length, 2); assert.equal(new Set(users.map(row => row.data.id)).size, 2); assert.equal(users.filter(row => JSON.stringify(row.data.content).includes(input2)).length, 1)
  assert.deepEqual(provider.bodies.map(row => digest(row.body)).sort(), resumedCloud.modelRequests.map(row => row.bodyDigest).sort()); assert.deepEqual(resumedCloud.modelRequests.slice(0, 2), waitingCloud.modelRequests)
  await save('resumed-facts.json', { newReady, local: resumed, cloud: resumedCloud, workers: newWorkers, originalBinding: binding(original), exactSdkReportTail: resumedSession.tail, actualResumeProof: { sameSessionAndWorkspace: true, oldEventPrefixPreserved: true, assistantOnlyMarkerInNewForward: true, ownerInput2ExactlyOnce: true, noProviderReinjection: true } })
  await save('owner-stop-receipt.json', await owner(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'compat-final-stop' }))
  await waitFor(async () => { const local = await journal(), cloud = await store.read(); return local.executions.every(row => row.status === 'stopped' && row.slotHeld === false) && local.outbox.every(row => row.acknowledged) && exactAck(local, cloud, 'stopped', local.executions[0]) && cloud.multisite.outbox.filter(row => row.command.operation === 'cancel').every(row => row.acceptedAt) }, 'owner stop exact receipt ACK and slot released')
  await save('business-stopped.json', { local: await journal(), cloud: await store.read() }); await stopOwned(newHost, facts); await gone([newHost.identity, ...newWorkers], 'new-parent-and-dsh-gone')
  const finalSession = await sessionSnapshot('candidate-final-closed', { event: resumedReport, input: input2 })
  assert.equal(finalSession.path, frozen.path); assert.deepEqual(finalSession.rows.slice(0, frozen.rows.length), frozen.rows)
  assert.deepEqual(finalSession.rows.slice(0, resumedSession.rows.length), resumedSession.rows); assert.deepEqual(finalSession.tail, resumedSession.tail)
  const finalUsers = finalSession.rows.filter(row => row.type === 'user/message'); assert.equal(finalUsers.length, 2); assert.equal(new Set(finalUsers.map(row => row.data.id)).size, 2); assert.equal(finalUsers.filter(row => JSON.stringify(row.data.content).includes(input2)).length, 1)
  assert.deepEqual(binding((await journal()).executions[0]), binding(original)); assert.deepEqual(await readFile(join(dataRoot, 'node-identity.json')), identityBytes)
  assert.equal(provider.bodies.length, 4); assert.deepEqual((await store.read()).modelRequests, resumedCloud.modelRequests); completed = true
  await save('result.json', { result: 'passed', directory, oldArchive, oldSha256, newArchive, newSha256, workId, originalBinding: binding(original), nodeInstanceId: identity.nodeInstanceId, workspace: oldWorkers[0].cwd, modelForwards: provider.bodies.length, oldWaitingNotStopped: true, competingNewHostRejected: true, noInputReopenNoForward: true, actualOfficialSessionResume: true, oldAssistantOnlyHistoryInForward: true, input2ExactlyOnce: true, ownerStopExactAckAndSlotFree: true, oldTurnReason: oldSession.tail.actualReason, resumedTurnReason: finalSession.tail.actualReason, finalClosedFullSessionRechecked: true, boundary: 'One current Linux x64/Node26.5/DSHrc.2 Session-v4 pair compatibility via private ordinary-Host fixture; no managed waiting update, arbitrary version/OS/SDK migration, physical effects or field deployment' })
  console.log(JSON.stringify({ stage: 'passed', directory, workId, modelForwards: provider.bodies.length }))
} catch (cause) {
  await save('failure.json', { message: cause.message, code: cause.code, stack: cause.stack });
  await save('failure-facts.json', { cloud: await store?.read().catch(() => null), local: await journal().catch(() => null), providerBodies: provider?.bodies.length ?? 0, providerFailures: provider?.failures ?? [] }); console.error(cause.stack); process.exitCode = 1
} finally {
  for (const item of [...children].reverse()) await stopOwned(item, facts)
  if (provider) { provider.server.closeAllConnections(); await new Promise(done => provider.server.close(done)) }
  await Promise.all(logs); for (const item of children) facts.push({ kind: 'final-os', name: item.name, original: item.identity, current: await processIdentity(item.identity.pid) })
  await save('processes.json', facts); await save('completion-boundary.json', { completed, normalBusinessStopConfirmed: completed, failureCleanupDoesNotProveBusinessStop: !completed })
  console.log(JSON.stringify({ stage: 'closed', directory }))
}
