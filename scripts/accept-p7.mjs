import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording } from './accept-p4-s1.mjs'
import { doubleClickControl, validateP6Correlation, validateP6Creation, validateP6ActionDom, validateP6ContentGeometry, validateP6Worker, validateP6StatusAdvance } from './accept-p6-kivo.mjs'
import { COLLABORATION_TOOLS } from '../plugins/collaboration.mjs'
import { KNOWLEDGE_TOOLS } from '../plugins/knowledge.mjs'
import { KIVO_TPM_TOOLS } from '../plugins/kivo-tpm.mjs'
import { CYCLE_TIME_TOOL } from '../src/capabilities.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const script = fileURLToPath(import.meta.url)
const models = Object.freeze(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'])
const app = { id: 'p7-feishu', providerAppId: 'cli_aaaaaaaaaaaaaaaa', providerTenantId: 'synthetic-p7' }
const correlation = 'kivo-tpm-device-correlate', read = 'kivo-tpm-record-read'
const stepsRequired = Object.freeze(['fresh-configuration', 'channel-waiting-root', 'restart-and-supplement', 'two-model-collaboration', 'same-object-event', 'mobile-reject-and-approve', 'same-channel-receipt', 'normal-restart', 'empty-restore', 'post-restore-read'])
const titles = ['新对象、双模型与权限', 'iLink 交办待补充协作，飞书官方事件入口', '同会话刷新、重启与补充', '双员工真实工具与知识交接', '同对象规则及真人来源变更', '本人手机拒绝与批准创建', '同渠道回执和发送前复权', '正常重启保留关联', '停机备份与空目录恢复', '重新认证并执行新的只读操作']
const candidateClosure = ['scripts/accept-p7.mjs', 'scripts/accept-p7-capacity.mjs', 'scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/accept-p6-kivo.mjs', 'scripts/fixtures/ilink-server.mjs', 'scripts/test-p4-channel-conversations.mjs', 'src/server.mjs', 'src/model-route.mjs', 'src/store/file-store.mjs', 'src/channel-service.mjs', 'src/work-service.mjs', 'src/collaboration-runner.mjs', 'src/action-service.mjs', 'src/automation-service.mjs', 'scripts/state-transfer.mjs', 'scripts/init-p2-auth.mjs', 'web/index.html']
const safeToolNames = new Set(['structured_output', ...Object.values(KIVO_TPM_TOOLS), ...Object.values(COLLABORATION_TOOLS), ...Object.values(KNOWLEDGE_TOOLS), CYCLE_TIME_TOOL,
  'geneway_work_create', 'geneway_work_continue', 'geneway_work_follow_up', 'geneway_work_status', 'geneway_work_stop'])

if (resolve(process.argv[1] ?? '') === script) {
  const options = argumentsFor(process.argv.slice(2))
  if (options.help) console.log(usage())
  else if (options['harness-check']) await harnessCheck()
  else await acceptance(options)
}

function argumentsFor(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, 'harness-check': { type: 'boolean' }, run: { type: 'boolean' },
    output: { type: 'string' }, 'fixture-a': { type: 'string' }, 'fixture-b': { type: 'string' }, 'api-state-a': { type: 'string' }, 'api-state-b': { type: 'string' }, catalog: { type: 'string' }, candidate: { type: 'string' },
    'secret-root': { type: 'string' }, 'model-ref': { type: 'string' }, 'expected-head': { type: 'string' }, 'network-guard': { type: 'string' }, 'guard-sha256': { type: 'string' }, 'observer-config': { type: 'string' }, 'observer-config-sha': { type: 'string' }, 'run-id': { type: 'string' }, display: { type: 'string' },
  } })
  if (!args.length) return { help: true }
  assert.equal([values.help, values['harness-check'], values.run].filter(Boolean).length, 1, 'choose one mode')
  if (!values.run) { assert(Object.keys(values).every(key => ['help', 'harness-check'].includes(key)), 'runtime input requires --run'); return values }
  for (const key of ['output', 'fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'secret-root', 'network-guard', 'observer-config']) {
    assert(isAbsolute(values[key] ?? ''), 'explicit absolute --' + key + ' required')
    values[key] = resolve(values[key]); assert(!within(root, values[key]), key + ' must be outside the repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? ''), 'expected HEAD required')
  assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''), 'approved guard digest required')
  assert(/^[a-f0-9]{64}$/.test(values['observer-config-sha'] ?? ''), 'approved observer config digest required')
  assert.equal(values['model-ref'], 'ZENMUX_API_KEY')
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values['run-id'] ?? ''), 'unique run id required')
  if (values.display) assert(/^:\d+$/.test(values.display))
  return values
}
function usage() {
  return 'P7 同候选 J10 真机旅程。仅 --harness-check 为纯检查；--run 会启动 owned Host/Chrome、调用两条真实 ZenMux 路由并由受控 Kivo operator 执行获准人类写入及本人批准的维修创建。\n' +
    'node scripts/accept-p7.mjs --run --output <新0700目录> --fixture-a <新对象fixture> --fixture-b <新对象fixture> --api-state-a <当前Kivo journal> --api-state-b <当前Kivo journal> --catalog <可信目录> --candidate <冻结清单> --expected-head <40位SHA> --secret-root <隔离0700目录> --model-ref ZENMUX_API_KEY --network-guard <已审guard> --guard-sha256 <64位SHA> --observer-config <P6 create observer配置> --observer-config-sha <64位SHA> --run-id <唯一ID> [--display :N]\n' +
    'operator按p7-operator-request逐项回p7-operator-result；渠道均为模拟验收，Kivo为synthetic/external-test。任一必需步骤或证据缺失则失败；容量/空安装/DSH回退另有同候选定向证据，不能拿本脚本代替。'
}

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function within(parent, child) { const r = relative(parent, child); return !r || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) }
function noSecrets(value) { assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization|secret|token)"\s*:|whsec_|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify(value)), 'secret body in public evidence') }
function uuid(value) { assert(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) }
function js(value) { return JSON.stringify(value) }
function gone(pid) { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
async function privateJson(path) { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await fd.stat(); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600); const bytes = await fd.readFile(); return { value: JSON.parse(bytes), sha256: hash(bytes) } } finally { await fd.close() } }
async function privateBytes(path) { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await fd.stat(); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600); return fd.readFile() } finally { await fd.close() } }
async function privateDirectory(path) { const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700) }
async function secretMetadata(directory, ref) { assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)); const stat = await lstat(join(directory, ref)); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600) }
async function assertWebhookPortFree() {
  const listener = createServer()
  await new Promise((done, fail) => { listener.once('error', fail); listener.listen({ host: '127.0.0.1', port: 34481, exclusive: true }, done) })
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()))
}

export function validateP7Fixtures(a, b, catalog) {
  noSecrets({ a, b, catalog })
  assert.equal(catalog.version, 1); assert(Array.isArray(catalog.targets))
  for (const [index, fixture] of [a, b].entries()) {
    const instance = ['a', 'b'][index], c = fixture.connection, f = fixture.facts
    assert.equal(fixture.instance, instance); assert.equal(fixture.phase, 'fixture-ready')
    assert.equal(fixture.dataMode, 'synthetic'); assert.equal(fixture.sourceEnvironment, 'external-test')
    assert.equal(c.kind, 'kivo-mcp'); assert.equal(c.baseUrl, `http://127.0.0.1:${34681 + index}/api/v1/mes/mcp`)
    assert.equal(c.issuer, new URL(c.baseUrl).origin); assert.equal(c.sourceInstance, fixture.runId + '-' + instance)
    assert.equal(c.sourceSystem, 'KivoMES'); assert.equal(c.sourceEnvironment, 'external-test'); assert.equal(c.dataMode, 'synthetic'); assert.equal(c.evidenceMode, 'actual-mcp')
    assert.equal(c.credentialRef, 'MCP_PRIVATE_' + instance.toUpperCase()); assert.deepEqual(c.allowedObjectIds, [])
    for (const id of [c.clientId, f.clientId, f.organizationId, f.deviceId, f.endpointId, f.hiveBindingId, f.record.recordId]) uuid(id)
    assert.equal(f.clientId, c.clientId); assert.equal(f.record.recordType, 'repair'); assert.equal(String(f.record.currentRevision), '0'); assert(/^P7-|^GW-P7/.test(f.record.reference), 'fresh P7 object required')
    uuid(f.externalDeviceId)
    assert(isAbsolute(fixture.hiveWindowReceipt?.path ?? '') && !within(root, fixture.hiveWindowReceipt.path) && /^[a-f0-9]{64}$/.test(fixture.hiveWindowReceipt.sha256), 'fresh Hive source window receipt required')
    assert.equal(fixture.eventSource.id, c.id); assert.equal(fixture.eventSource.connectionId, c.id); assert.equal(fixture.eventSource.resource, c.baseUrl)
    assert.equal(fixture.eventSource.sourceInstance, c.sourceInstance); assert.equal(fixture.eventSource.signingSecretRef, 'WEBHOOK_' + instance.toUpperCase()); assert.equal(fixture.eventSource.enabled, true)
    assert.deepEqual([...fixture.eventSource.subscriptionIds].sort(), [...f.subscriptionIds].sort())
    assert(catalog.targets.some(target => ['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].every(key => target[key] === c[key])), 'connection differs from trusted catalogue')
  }
  assert.equal(a.runId, b.runId)
  assert.equal(a.candidate, b.candidate); assert.equal(a.facts.record.reference, b.facts.record.reference)
  assert.equal(a.facts.externalDeviceId, b.facts.externalDeviceId, 'A/B must map the same new Hive device')
  assert.notEqual(a.facts.deviceId, b.facts.deviceId); assert.notEqual(a.facts.record.recordId, b.facts.record.recordId)
  return [a, b]
}

export function validateP7ModelAudit(rows) {
  const calls = rows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai')
  assert(calls.length, 'real model calls required')
  const seen = new Set()
  for (const row of calls) {
    assert(models.includes(row.model), 'unexpected model'); seen.add(row.model)
    assert(['host', 'sdk'].includes(row.role)); assert.equal(row.permitted, true)
    assert.equal(row.maxTokens, 4096, 'P7 output budget changed')
    assert.equal(row.maxTokensValid, true)
    assert(['max_tokens', 'max_completion_tokens'].includes(row.maxTokensField))
    assert(!row.sessionLogAttached && !row.credentialInPayload && !row.unexpectedBodyFields)
    assert(Array.isArray(row.toolNames) && row.toolNames.every(name => safeToolNames.has(name)), 'retired, unknown or write tool was offered')
  }
  assert.deepEqual([...seen].sort(), [...models].sort(), 'both actual ZenMux routes required')
  assert(calls.some(row => row.toolNames.includes('geneway_kivo_tpm_correlate_device')), 'actual correlation tool was never offered')
  return { requests: calls.length, models: [...seen].sort(), writesOffered: 0 }
}

export function validateP7Polls(simulator, accountIds, { minFullCycles = 10, minHoldMs = 3000 } = {}) {
  assert.equal(simulator.failures.length, 0)
  const result = []
  for (const id of accountIds) {
    assert(simulator.maxActivePolls(id) <= 1, 'duplicate iLink consumer')
    const calls = simulator.calls.filter(call => call.botId === id && call.endpoint === '/ilink/bot/getupdates')
    assert(calls.length >= minFullCycles, 'insufficient complete poll cycles')
    const complete = calls.filter(call => call.completed && Number.isFinite(call.heldMs))
    assert(complete.length >= minFullCycles, 'incomplete poll cycles')
    assert(complete.every(call => call.heldMs >= 0 && call.heldMs < minHoldMs), 'poll hold exceeded bound')
    result.push({ botId: id, requests: calls.length, completed: complete.length, maxActive: simulator.maxActivePolls(id), maxHeldMs: Math.max(...complete.map(call => call.heldMs)) })
  }
  return result
}

export function validateP7Chain({ memberId, identity, endpoint, conversation, rootWork, children, fixture, rule, occurrence, action, delivery }) {
  assert.equal(identity.memberId, memberId); assert.equal(conversation.ownerMemberId, memberId)
  assert.equal(conversation.channelIdentityId, identity.id); assert.equal(endpoint.identityId, identity.id)
  assert.equal(rootWork.ownerMemberId, memberId); assert.equal(rootWork.workType, 'collaboration'); assert.equal(rootWork.conversationId, conversation.id)
  assert(children.length >= 2); assert(children.every(child => child.rootWorkId === rootWork.id && child.ownerMemberId === memberId))
  const correlated = children.find(child => child.results?.some(result => result.kind === 'kivo.tpm.device-correlation'))
  assert(correlated, 'correlation child missing'); validateP6Correlation(correlated, fixture)
  assert.equal(action.workId ?? correlated.id, correlated.id); assert(correlated.actions.some(item => item.id === action.id))
  assert(action.receipt?.upstreamRecordId)
  assert.equal(rule.ownerMemberId, memberId); assert.equal(rule.trigger.sourceId, fixture.eventSource.id)
  assert.equal(occurrence.ruleId, rule.id); assert.equal(occurrence.workId && typeof occurrence.workId, 'string')
  assert.equal(delivery.actionId, action.id); assert.equal(delivery.workId, correlated.id)
  assert.equal(delivery.targetIdentityId, identity.id); assert.equal(delivery.targetConversationId, endpoint.id)
  return { memberId, identityId: identity.id, conversationId: conversation.id, rootWorkId: rootWork.id, childWorkIds: children.map(child => child.id), sourceId: fixture.eventSource.id,
    tpmRecordId: fixture.facts.record.recordId, deviceId: fixture.facts.deviceId, ruleId: rule.id, occurrenceId: occurrence.id, actionId: action.id, upstreamRecordId: action.receipt.upstreamRecordId, deliveryId: delivery.id }
}

function validateP7EventObservation(work, fixture, ownerMemberId) {
  assert.equal(work.status, 'completed'); assert.equal(work.ownerMemberId, ownerMemberId)
  assert.equal(work.capabilityId, read); assert.equal(work.skillId, 'skill-' + read)
  assert.equal(work.connectionId, fixture.connection.id)
  const expected = fixture.facts.record
  assert.deepEqual(work.input, { recordType: 'repair', reference: expected.reference })
  const observation = work.results.findLast(item => item.kind === 'kivo.tpm.observation'), payload = observation?.payload
  assert.equal(observation?.kind, 'kivo.tpm.observation')
  assert.equal(payload.status, 'ok'); assert.equal(payload.mode, 'record'); assert.equal(payload.recordType, 'repair')
  assert(Array.isArray(payload.records)); assert.equal(payload.records.length, 1)
  assert.equal(payload.records[0].id, expected.recordId); assert.equal(payload.records[0].reference, expected.reference)
  assert.equal(payload.records[0].deviceId, fixture.facts.deviceId); assert.equal(payload.linkedDevice?.id, fixture.facts.deviceId)
  for (const source of [payload.source, observation.source]) {
    for (const key of ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']) assert.equal(source?.[key], fixture.connection[key])
    assert.equal(source?.sourceRecordId, 'repair:' + expected.reference)
  }
  return observation
}

async function verifyP7RevokedRetry({ request, state, simulator, delivery, sendCount }) {
  const response = await request('a', '/api/channels/deliveries/' + delivery.id + '/retry', 'POST', {})
  assert.equal(response.status, 403); assert.equal(response.body?.error?.code, 'DELIVERY_FORBIDDEN')
  const blocked = (await state()).deliveries.find(item => item.id === delivery.id)
  assert(blocked, 'revoked retry delivery was not persisted')
  for (const key of ['id', 'workId', 'resultId', 'actionId', 'targetIdentityId', 'targetConversationId']) assert.equal(blocked[key], delivery[key])
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.error?.code, 'DELIVERY_FORBIDDEN')
  assert.equal(simulator.calls.filter(call => call.endpoint === '/ilink/bot/sendmessage').length, sendCount)
  return blocked
}

function validateP7DisabledRoute({ response, before, after, modelRequestsBefore, modelRequestsAfter }) {
  assert.equal(response.status, 403); assert.equal(response.body?.error?.code, 'FORBIDDEN')
  assert.deepEqual(after.works, before.works, 'disabled route changed work or execution facts')
  assert.deepEqual(after.reservations, before.reservations, 'disabled route changed request reservations')
  assert.equal(modelRequestsAfter, modelRequestsBefore, 'disabled route reached a model')
}

function operatorChannel(input, binding, signal) {
  let pending, failure
  const used = new Set()
  const fail = error => { failure ??= error; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined } }
  const receive = line => {
    try {
      assert(Buffer.byteLength(line) <= 128 * 1024)
      const value = JSON.parse(line)
      assert(pending && value.kind === 'p7-operator-result' && value.runId === binding.runId && value.candidate === binding.candidate && value.guardSha256 === binding.guardSha256 && value.stepId === pending.id)
      assert.equal(value.ok, true); noSecrets(value.receipt)
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(value.receipt)
    } catch (error) { fail(error) }
  }
  input.on('line', receive); input.on('close', () => fail(new Error('operator ended'))); input.on('error', fail)
  signal.addEventListener('abort', () => fail(new Error('operator interrupted')), { once: true })
  return { wait(id, operation, expected = {}) {
    assert(!pending && !used.has(id)); used.add(id)
    if (failure) return Promise.reject(failure)
    return new Promise((resolveReceipt, reject) => { pending = { id, resolve: resolveReceipt, reject, timer: setTimeout(() => fail(new Error('operator timed out')), 300_000) }; console.error(JSON.stringify({ kind: 'p7-operator-request', ...binding, stepId: id, operation, expected })) })
  }, dispose() { input.removeListener('line', receive); if (pending) fail(new Error('operator disposed')) } }
}

export function validateP7Observer(candidate, input, options, fixtures) {
  const runtime = candidate.p6Runtime, config = input.value
  const mainRunId = options['run-id']
  assert(typeof mainRunId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mainRunId), 'valid observer main run id required')
  assert.equal(input.sha256, options['observer-config-sha']); noSecrets(config)
  assert(runtime && isAbsolute(runtime.root) && !within(root, runtime.root))
  assert.deepEqual(runtime.files?.map(file => file.path).sort(), ['operator.mjs', 'repair-create-observer.mjs', 'selfcheck-operator.mjs'].sort())
  for (const file of runtime.files) assert(/^[a-f0-9]{64}$/.test(file.sha256) && !file.path.includes('/') && !file.path.includes('..'))
  assert.deepEqual(config, { schemaVersion: 1, runId: mainRunId, producerRunId: fixtures[0].runId, candidate: options.candidateSha256,
    candidatePath: options.candidate, baseCandidate: fixtures[0].candidate, setupOutput: dirname(options['fixture-a']), controlDirectory: join(dirname(options['fixture-a']), 'private', 'create-observer-' + mainRunId),
    guardSha256: options['guard-sha256'], instances: fixtures.map(fixture => ({ instance: fixture.instance, resource: fixture.connection.baseUrl, clientId: fixture.connection.clientId, deviceId: fixture.facts.deviceId })) })
  return runtime
}
function validateCandidate(value) {
  assert(Array.isArray(value.files) && value.files.length)
  for (const file of value.files) assert(/^(src\/|plugins\/|config\/|web\/|vendor\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(file.path) && !file.path.split('/').includes('..') && /^[a-f0-9]{64}$/.test(file.sha256))
  assert.equal(new Set(value.files.map(file => file.path)).size, value.files.length)
  for (const path of candidateClosure) assert(value.files.some(file => file.path === path), 'candidate omits ' + path)
  const runtime = value.p7KivoRuntime
  assert(runtime && isAbsolute(runtime.root) && !within(root, runtime.root) && Array.isArray(runtime.files) && runtime.files.length, 'P7 Kivo operator runtime omitted')
  for (const file of runtime.files) assert(typeof file.path === 'string' && !file.path.split('/').includes('..') && !isAbsolute(file.path) && /^[a-f0-9]{64}$/.test(file.sha256), 'P7 Kivo runtime file invalid')
  assert.equal(new Set(runtime.files.map(file => file.path)).size, runtime.files.length)
  return value.files
}
async function snapshot(files, expectedHead) {
  assert.equal((await command('git', ['rev-parse', 'HEAD'])).trim(), expectedHead)
  for (const file of files) assert.equal(hash(await readFile(join(root, file.path))), file.sha256, 'candidate changed: ' + file.path)
  return { head: expectedHead, files: Object.fromEntries(files.map(file => [file.path, file.sha256])) }
}
async function verifyApiStates(inputs, options, fixtures) {
  const result = []
  for (const fixture of fixtures) {
    const journal = inputs['api-state-' + fixture.instance].value, pid = journal.process?.pid
    assert(journal.phase === 'ready' && journal.instance === fixture.instance && journal.runId === fixture.runId)
    assert.equal(journal.baseCandidate, fixture.candidate)
    assert.equal(journal.candidate, inputs.candidate.sha256)
    assert.equal(journal.candidatePath, options.candidate)
    assert.equal(journal.runtimeVariant, 'final')
    assert(isAbsolute(journal.runtimeRoot) && !within(root, journal.runtimeRoot))
    assert(Number.isSafeInteger(pid) && pid > 1)
    const [stat, executable, cwd] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/cwd`)])
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    assert.deepEqual(journal.process, { pid, startTicks, executable, cwd })
    assert.equal(cwd, journal.runtimeRoot)
    const port = new URL(fixture.connection.baseUrl).port, listener = await command('ss', ['-ltnpH', 'sport = :' + port])
    assert(listener.includes('127.0.0.1:' + port) && listener.includes('pid=' + pid + ','), 'Kivo listener differs from exact journal')
    assert.equal((await privateJson(options['api-state-' + fixture.instance])).sha256, inputs['api-state-' + fixture.instance].sha256)
    result.push({ instance: fixture.instance, pid, startTicks, executable, cwd, port, journalSha256: inputs['api-state-' + fixture.instance].sha256 })
  }
  return result
}

async function ipc(child, method, input) {
  const id = randomBytes(12).toString('hex'); assert(child.connected && child.exitCode === null)
  return new Promise((done, reject) => {
    const finish = () => { clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', exited) }
    const receive = result => { if (result?.kind === 'channel-acceptance' && result.id === id) { finish(); result.ok ? done(result.value) : reject(new Error('owned channel IPC failed')) } }
    const exited = () => { finish(); reject(new Error('owned Host exited during IPC')) }
    const timer = setTimeout(() => { finish(); reject(new Error('owned channel IPC timed out')) }, 20_000)
    child.on('message', receive); child.once('exit', exited)
    child.send({ kind: 'channel-acceptance', id, method, input }, error => { if (error) { finish(); reject(error) } })
  })
}
export async function stopOwned(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  if (child.auditRole === 'host' && signal === 'SIGTERM') {
    let timer, onExit
    let graceful = child.exitCode !== null || child.signalCode !== null
    if (!graceful) {
      const exited = new Promise(done => { onExit = () => done(true); child.once('exit', onExit) })
      try {
        try { process.kill(child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
        graceful = await Promise.race([exited, new Promise(done => { timer = setTimeout(() => done(false), 10_000) })])
      } finally { clearTimeout(timer); child.removeListener('exit', onExit) }
    }
    const deadline = Date.now() + 10_000
    while (graceful && child.exitCode === 0 && child.signalCode === null && !gone(-child.pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
    if (!graceful || child.exitCode !== 0 || child.signalCode !== null || !gone(-child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      const deadline = Date.now() + 10_000
      while (!gone(-child.pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
      assert(gone(-child.pid), 'owned Host group remained after failed graceful stop')
      throw new Error('owned Host did not stop gracefully; owned group cleanup was required')
    }
    return
  }
  await stop(child, signal)
  const deadline = Date.now() + 10_000
  while (!gone(-child.pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
  assert(gone(-child.pid), 'owned process group remained after graceful stop')
}

function workPath(id) { return '/api/works/' + encodeURIComponent(id) }
function actionPath(workId, actionId, operation) { return workPath(workId) + '/actions/' + encodeURIComponent(actionId) + '/' + operation }
function target(action) { return { actionId: action.id, orderNo: action.preview.payload.orderNo, deviceId: action.preview.target.deviceId, clientId: action.preview.target.clientId, traceId: action.id, resource: action.preview.target.resource } }
function approval(action) { return { expectedRevision: action.preview.expectedRevision, previewDigest: action.preview.digest, clientRequestId: 'p7-' + action.id } }
function feishuEvent(id, text) { return { schema: '2.0', header: { event_id: 'event-' + id, event_type: 'im.message.receive_v1', app_id: app.providerAppId, tenant_key: app.providerTenantId, create_time: String(Date.now()) }, event: { sender: { sender_id: { open_id: 'p7-open-a' }, sender_type: 'user', tenant_key: app.providerTenantId }, message: { message_id: id, chat_id: 'p7-chat-a', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()) } } } }

function seedState(state, fixtures, channelRef) {
  const now = new Date().toISOString()
  return { ...state,
    members: ['admin', 'a', 'b'].map(id => ({ id, loginName: id, displayName: id === 'admin' ? '验收管理员' : '验收成员 ' + id.toUpperCase(), authRef: id,
      role: id === 'admin' ? 'admin' : 'member', enabled: true, employeeIds: [], sessionVersion: 1, createdAt: now, updatedAt: now })),
    modelRoutes: [],
    skills: [{ id: 'skill-' + correlation, name: '同设备TPM关联', capabilityId: correlation, enabled: true }, { id: 'skill-' + read, name: 'TPM记录读取', capabilityId: read, enabled: true }],
    employees: [],
    connections: [],
    channelApps: [{ id: app.id, provider: 'feishu', providerAppId: app.providerAppId, providerTenantId: app.providerTenantId, credentialRef: channelRef, enabled: true, revision: 1, status: 'active', allowedScopes: ['result'], createdAt: now, updatedAt: now },
      { id: 'channel-app-weixin', provider: 'weixin', providerAppId: 'ilink', providerTenantId: 'personal', credentialRef: null, enabled: true, revision: 1, status: 'active', allowedScopes: ['result'], createdAt: now, updatedAt: now }],
  }
}

async function acceptance(options) {
  const inputKeys = ['fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'observer-config']
  const inputs = Object.fromEntries(await Promise.all(inputKeys.map(async key => [key, await privateJson(options[key])])))
  const fixtures = validateP7Fixtures(inputs['fixture-a'].value, inputs['fixture-b'].value, inputs.catalog.value)
  const files = validateCandidate(inputs.candidate.value)
  const binding = { runId: options['run-id'], candidate: inputs.candidate.sha256, guardSha256: options['guard-sha256'] }
  const observer = validateP7Observer(inputs.candidate.value, inputs['observer-config'], { ...options, candidateSha256: binding.candidate }, fixtures)
  const p7KivoRuntime = inputs.candidate.value.p7KivoRuntime
  assert.equal(hash(await readFile(options['network-guard'])), binding.guardSha256)
  for (const fixture of fixtures) assert.equal(hash(await readFile(fixture.hiveWindowReceipt.path)), fixture.hiveWindowReceipt.sha256, 'fresh Hive source window changed')
  for (const file of observer.files) assert.equal(hash(await readFile(join(observer.root, file.path))), file.sha256, 'observer changed: ' + file.path)
  for (const file of p7KivoRuntime.files) assert.equal(hash(await readFile(join(p7KivoRuntime.root, file.path))), file.sha256, 'P7 Kivo operator changed: ' + file.path)
  const preflight = { source: await snapshot(files, options['expected-head']), apis: await verifyApiStates(inputs, options, fixtures), observer: observer.files, p7KivoRuntime: p7KivoRuntime.files }
  await privateDirectory(options['secret-root'])
  for (const ref of [options['model-ref'], ...fixtures.flatMap(fixture => [fixture.connection.credentialRef, fixture.eventSource.signingSecretRef])]) await secretMetadata(options['secret-root'], ref)
  await mkdir(options.output, { mode: 0o700 }); await privateDirectory(options.output)
  const privateRoot = join(options.output, 'private'); await mkdir(privateRoot, { mode: 0o700 })
  const scratch = await mkdtemp(join(privateRoot, 'j10-'))
  let stateFile = join(scratch, 'state.json'), dshHome = join(scratch, 'dsh'), secretRoot = options['secret-root'], catalogFile = options.catalog, host, simulator, recording, recordingAt, display = options.display, failure, postflight, audit, media
  let authFile = join(scratch, 'auth.json')
  const authFiles = [authFile]
  const hostConfig = join(scratch, 'host.json'), auditFile = join(scratch, 'network.jsonl'), caption = join(scratch, 'caption.txt'), video = join(options.output, 'p7-j10.mp4')
  const children = [], pages = {}, sessions = {}, steps = [], facts = [], refs = {}, eventAcks = []
  const passwords = Object.fromEntries(['admin', 'a', 'b'].map(id => [id, randomBytes(24).toString('base64url')]))
  const weixinAccount = { id: 'synthetic-p7-' + binding.runId, ownerUserId: 'synthetic-p7-owner-a', token: 'SYNTHETIC_TOKEN_' + randomBytes(24).toString('hex') }
  let weixinSequence = 0
  const abort = new AbortController(), input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }), operator = operatorChannel(input, binding, abort.signal)
  let settle
  const operationSettled = new Promise(done => { settle = done })
  const cleanup = runCleanup({ children, browsers: pages, recording: () => recording, operationSettled, removeAuth: () => Promise.all(authFiles.map(path => rm(path, { force: true }))), onFailure: error => { failure ??= error }, stopChild: stopOwned })
  const interrupts = interruptHandlers(process, (signal, force) => { failure ??= new Error('interrupted by ' + signal); abort.abort(signal); if (force) void cleanup.run(true) })
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  async function silentSnapshot() {
    const current = await state()
    const auditRows = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const attempts = await privateBytes(join(inputs['observer-config'].value.controlDirectory, 'create-attempts.jsonl'))
    const createRows = attempts.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(createRows.every(row => row.runId === binding.runId && row.candidate === binding.candidate), 'create observer binding changed')
    return { modelRequests: auditRows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai').length,
      sends: simulator.calls.filter(call => call.endpoint === '/ilink/bot/sendmessage').length,
      createDispatches: createRows.filter(row => row.kind === 'create-dispatch-attempt').length, createObserverSha256: hash(attempts),
      persistedSha256: hash(JSON.stringify({ works: current.works, conversations: current.conversations, automationRules: current.automationRules,
        automationInbox: current.automationInbox, deliveries: current.deliveries, channelMessages: current.channelMessages })) }
  }
  async function verifyDurableAcks(receipt, label) {
    assert(Array.isArray(receipt.deliveries) && receipt.deliveries.length, label + ' has no Kivo delivery receipts')
    const inbox = (await state()).automationInbox
    for (const delivery of receipt.deliveries) {
      assert.equal(delivery.eventId, receipt.event.eventId)
      const saved = inbox.find(item => item.event.eventId === delivery.eventId && item.deliveries.some(entry => entry.id === delivery.id))
      assert(saved && Number.isFinite(Date.parse(saved.acceptedAt)), 'successful HTTP ACK has no durable Geneway inbox entry')
      const stored = saved.deliveries.find(item => item.id === delivery.id)
      const successful = delivery.attempts?.filter(item => item.httpStatus >= 200 && item.httpStatus < 300) ?? []
      assert(successful.length, 'Kivo event delivery had no successful HTTP ACK')
      for (const attempt of successful) {
        assert(/^[a-f0-9]{64}$/.test(attempt.wireBodySha256) && attempt.wireBodySha256 === stored.rawDigest, 'ACK body is not the persisted raw delivery')
        const duration = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
        assert(Number.isFinite(duration) && duration >= 0 && Math.abs(duration - attempt.ackDurationMs) <= 10, 'Kivo ACK timing is not traceable')
        assert(attempt.ackDurationMs < 10_000, 'successful durable ACK exceeded ten seconds')
        eventAcks.push({ label, eventId: delivery.eventId, deliveryId: delivery.id, attemptId: attempt.id, httpStatus: attempt.httpStatus, ackDurationMs: attempt.ackDurationMs,
          acceptedAt: saved.acceptedAt, rawDigest: stored.rawDigest })
      }
    }
  }
  const fixture = instance => fixtures.find(item => item.instance === instance)
  const fail = error => { failure ??= error; abort.abort(error) }
  try {
    const [{ createFileStore }, { initializeAuthFile }, { createILinkSimulator }] = await Promise.all([import('../src/store/file-store.mjs'), import('../src/auth.mjs'), import('./fixtures/ilink-server.mjs')])
    simulator = await createILinkSimulator({ holdMs: 100 })
    simulator.addAccount(weixinAccount)
    refs.loopbackRoutes = JSON.stringify([
      ...fixtures.map(item => ({ purpose: 'kivo', origin: new URL(item.connection.baseUrl).origin })),
      { purpose: 'ilink', origin: new URL(simulator.url).origin },
    ])
    refs.loopbackRoutesSha256 = hash(Buffer.from(refs.loopbackRoutes, 'utf8'))
    await writeFile(hostConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    const channelRef = 'P7_' + hash(binding.runId).slice(0, 24).toUpperCase() + '_FEISHU'
    await writeFile(join(secretRoot, channelRef), JSON.stringify({ appId: app.providerAppId, appSecret: 'synthetic_' + randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(scratch, 'event-sources.json'), JSON.stringify({ version: 1, sources: fixtures.map(item => item.eventSource) }), { mode: 0o600, flag: 'wx' })
    await createFileStore(stateFile).update(value => seedState(value, fixtures, channelRef))
    await initializeAuthFile(authFile, passwords)
    host = await boot(true)
    if (!display) {
      const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
      display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
    }
    await writeFile(caption, 'P7 同候选 J10；渠道为模拟验收；synthetic/external-test', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; await access(font)
    recording = watchRecording(launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', display + '.0', '-vf',
      'pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=' + font + ':textfile=' + caption + ':reload=1:fontcolor=white:fontsize=24:x=20:y=h-54',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] }), fail)
    recordingAt = recording.state.startedAt
    for (const actor of ['admin', 'a', 'b']) { await login(actor); pages[actor] = await browser(actor) }
    await journeys()
    assert(eventAcks.length >= 2, 'insufficient durable event ACK samples')
    const sortedAcks = eventAcks.map(item => item.ackDurationMs).sort((a, b) => a - b)
    assert(sortedAcks[Math.ceil(sortedAcks.length * 0.95) - 1] <= 1000, 'durable event ACK p95 exceeds one second')
    assert.deepEqual(steps.map(item => [item.id, item.status]), stepsRequired.map(id => [id, 'passed']))
  } catch (error) { fail(error) }
  finally {
    settle(); await cleanup.run()
    try { await simulator?.close() } catch (error) { failure ??= error }
    operator.dispose(); input.close()
    try {
      for (const child of children) if (child.pid) assert(gone(child.pid) && gone(-child.pid), 'owned PID/group remains')
      await assert.rejects(access(authFile), { code: 'ENOENT' })
      postflight = { source: await snapshot(files, options['expected-head']), apis: await verifyApiStates(inputs, options, fixtures), observer: observer.files, p7KivoRuntime: p7KivoRuntime.files }
      assert.deepEqual(postflight, preflight)
      for (const key of inputKeys) assert.equal((await privateJson(options[key])).sha256, inputs[key].sha256)
      assert.equal(hash(await readFile(options['network-guard'])), binding.guardSha256)
      for (const fixture of fixtures) assert.equal(hash(await readFile(fixture.hiveWindowReceipt.path)), fixture.hiveWindowReceipt.sha256, 'fresh Hive source window changed during J10')
      assert.equal(hash(await readFile(catalogFile)), inputs.catalog.sha256)
      for (const file of observer.files) assert.equal(hash(await readFile(join(observer.root, file.path))), file.sha256)
      for (const file of p7KivoRuntime.files) assert.equal(hash(await readFile(join(p7KivoRuntime.root, file.path))), file.sha256)
      const rows = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(rows.every(row => row.loopbackRoutesSha256 === refs.loopbackRoutesSha256), 'guard loopback routes changed during J10')
      audit = { ...networkAudit(rows, { ...binding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid), models }), models: validateP7ModelAudit(rows), polls: validateP7Polls(simulator, [weixinAccount.id]) }
      for (const port of [34681, 34682]) assert(rows.some(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.port === port && row.path === '/api/v1/mes/mcp'), 'actual Kivo MCP traffic missing')
    } catch (error) { failure ??= error }
    try {
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
      const coverage = recordingCoverage(recording.state, probe, steps)
      await command('ffmpeg', ['-v', 'error', '-xerror', '-i', video, '-f', 'null', '-'])
      if (!failure) validateTimeline(steps)
      media = { video: 'p7-j10.mp4', ...coverage, sha256: hash(await readFile(video)), decoded: true, recording: recording.state }
    } catch (error) { failure ??= error }
    const report = { ok: !failure, phase: 'P7-J10', scope: '同一候选、两条真实ZenMux路由、synthetic/external-test Kivo；渠道为模拟验收。容量、空安装、DSH回退另需同候选证据。',
      binding, preflight, postflight, audit, media, steps, facts, eventAcks, failure: failure ? { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code ?? '') ? failure.code : 'ACCEPTANCE_FAILED', step: steps.find(item => item.status === 'failed')?.id ?? null } : null, cleanup: cleanup.state }
    if (failure) await writeFile(join(privateRoot, 'first-failure.json'), JSON.stringify({ name: failure.name, code: failure.code ?? null, message: String(failure.message).slice(0, 8192), stack: String(failure.stack ?? '').slice(0, 16384) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }).catch(() => {})
    try {
      await writeFile(join(options.output, 'index.html'), manual(report), { mode: 0o600 })
      await writeFile(join(options.output, 'observations.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    }
    catch (error) {
      failure ??= error; report.ok = false
      report.failure = { code: 'REPORT_WRITE_FAILED', step: steps.find(item => item.status === 'failed')?.id ?? null }
      await rm(join(options.output, 'index.html'), { force: true }).catch(() => {})
      await writeFile(join(options.output, 'observations.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }).catch(() => {})
    }
    finally { interrupts.dispose() }
    console.log(JSON.stringify({ ok: report.ok, runId: binding.runId, output: options.output, steps: steps.map(step => ({ id: step.id, status: step.status })), failure: report.failure }))
    if (failure) process.exitCode = 1
  }

  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.once('error', error => { child.spawnError = error }); children.push(child)
    return child
  }
  async function boot(channelsExpected = true) {
    await assertWebhookPortFree()
    const port = refs.port ??= 34481, origin = refs.origin ??= 'http://127.0.0.1:' + port
    const env = { ...systemEnvironment(), DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile,
      GENEWAY_PORT: String(port), GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'], GENEWAY_CONNECTION_CATALOG: catalogFile,
      NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href + ' --import=' + pathToFileURL(join(observer.root, 'repair-create-observer.mjs')).href,
      GENEWAY_P6_CREATE_OBSERVER_CONFIG: options['observer-config'], GENEWAY_P6_CREATE_OBSERVER_CONFIG_SHA256: options['observer-config-sha'],
      GENEWAY_NETWORK_AUDIT_RUN_ID: binding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: binding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
      GENEWAY_NETWORK_AUDIT_LOOPBACK_ROUTES: refs.loopbackRoutes,
      GENEWAY_CHANNEL_ACCEPT_HOST: '1', GENEWAY_CHANNEL_HOST_CONFIG: hostConfig }
    const child = launch(process.execPath, [join(root, 'scripts/accept-p4.mjs'), '--host'], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.auditRole = 'host'
    child.auditFile = auditFile; child.auditBinding = binding
    await poll(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Host failed'); try { return (await fetch(origin)).status === 200 } catch { return false } }, 'owned P7 Host', 30_000)
    const value = await ipc(child, 'snapshot'); assert.equal(value.pid, child.pid); assert.equal(value.address.port, port); assert.equal(value.sdkDispatcher, channelsExpected)
    assert(value.consumers.maxActive <= 1, 'multiple Feishu SDK consumers')
    return child
  }
  async function waitWeixinRestart() {
    await poll(async () => {
      const identity = (await state()).channelIdentities.find(item => item.id === refs.weixinIdentity.id)
      assert(identity, 'original Weixin identity disappeared after restart')
      for (const key of ['id', 'memberId', 'channelAppId']) assert.equal(identity[key], refs.weixinIdentity[key], 'Weixin identity changed after restart')
      assert.equal(identity.weixin?.botId, weixinAccount.id); assert.equal(identity.status, 'active')
      assert(identity.weixin.runtimeState !== 'unavailable' && identity.weixin.error?.code !== 'WEIXIN_LOCK_LOST', 'Weixin became unavailable after restart')
      const active = simulator.activePolls(identity.weixin.botId), max = simulator.maxActivePolls(identity.weixin.botId)
      assert(max <= 1 && active <= 1, 'multiple Weixin pollers after restart')
      return identity.weixin.runtimeState === 'connected' && active === 1
    }, 'same Weixin identity connected after normal restart', 30_000)
  }
  async function login(actor) {
    const result = await request(actor, '/api/session', 'POST', { loginName: actor, password: passwords[actor] })
    assert.equal(result.status, 200); sessions[actor] = { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken }
  }
  async function request(actor, path, method = 'GET', body, headers = {}) {
    const session = sessions[actor], origin = refs.origin
    const result = await fetch(origin + path, { method, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) })
    const text = await result.text(), value = text ? JSON.parse(text) : null; noSecrets(value)
    return { status: result.status, body: value, cookie: result.headers.get('set-cookie') }
  }
  async function api(actor, path, method = 'GET', body) { const response = await request(actor, path, method, body); assert(response.status >= 200 && response.status < 300, 'product request failed: ' + method + ' ' + path + ' ' + response.status); return response.body }
  async function work(actor, id) { return api(actor, workPath(id)) }
  async function browser(actor, profileName = actor) {
    const port = await freePort(), profile = join(scratch, 'chrome-' + profileName)
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
    const args = ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', '--app=' + refs.origin]
    const child = launch('/usr/bin/google-chrome', args, { env: { ...systemEnvironment(), DISPLAY: display } })
    const target = await poll(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Chrome failed'); try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith(refs.origin)) } catch { return false } }, 'isolated Chrome')
    const page = await connect(target, () => false), front = page.front; page.actor = actor; page.child = child
    page.front = async () => {
      for (const other of Object.values(pages).filter(item => item !== page)) { const window = await other.send('Browser.getWindowForTarget'); await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } }) }
      const { width, height } = page.size(), window = await page.send('Browser.getWindowForTarget')
      await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } }); await front()
      const current = steps.at(-1); await writeFile(caption, (current ? steps.length + '. ' + current.title + '；' : 'P7 J10；') + (actor === 'admin' ? '管理员' : '成员 ' + actor.toUpperCase()) + '；渠道为模拟验收', { mode: 0o600 })
    }
    await page.viewport(1440, 900); await page.front(); await page.wait('Boolean(document.querySelector("#login-name"))')
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait('!document.querySelector("#app")?.classList.contains("hidden")')
    return page
  }
  async function reload(page, view = 'works') {
    await page.front(); const before = await page.evaluate('performance.timeOrigin'); await page.send('Page.reload')
    await page.wait('performance.timeOrigin !== ' + before + ' && !document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
    await page.nav(view)
  }
  async function browserLogin(actor) {
    const page = pages[actor]
    await page.front()
    const before = await page.evaluate('performance.timeOrigin')
    await page.send('Page.reload')
    await page.wait('performance.timeOrigin !== ' + before + ' && !document.querySelector("#login-shell")?.classList.contains("hidden")')
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait('!document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
  }
  async function openWork(actor, id, page = pages[actor]) {
    await reload(page); await page.click('#all-work-cards [data-open-work="' + id + '"]')
    await page.wait('document.querySelector("#view-work")?.classList.contains("active") && state.currentWork?.id === ' + js(id))
    return work(actor, id)
  }
  async function workContentFits(page) {
    const layout = await page.evaluate(`(() => { const work = document.querySelector('#view-work.active'); if (!work) return null;
      const measure = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'), left: r.left, right: r.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth } };
      return { width: innerWidth, content: measure(document.querySelector('.content')), cards: [...work.querySelectorAll('[data-correlation-result],#repair-actions,[data-repair-action-id]')].map(measure).filter(item => item.visible) } })()`)
    if (layout?.cards.length) validateP6ContentGeometry(layout)
  }
  async function capture(page, label) {
    recording.assertRunning(); await page.front(); await new Promise(done => setTimeout(done, 250)); await workContentFits(page)
    const entry = steps.at(-1), image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = 'step-' + String(steps.length).padStart(2, '0') + '-' + String(entry.screenshots.length + 1).padStart(2, '0') + '.png'
    await writeFile(join(options.output, file), Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' })
    entry.screenshots.push({ file, label, actor: page.actor, viewport: page.size(), seconds: (Date.now() - recordingAt) / 1000 })
  }
  async function step(id, action) {
    assert.equal(id, stepsRequired[steps.length]); abort.signal.throwIfAborted(); recording.assertRunning()
    const entry = { id, title: titles[steps.length], status: 'running', actor: id === 'fresh-configuration' ? 'admin' : 'a', startedAt: new Date().toISOString(), startSeconds: (Date.now() - recordingAt) / 1000, screenshots: [] }
    steps.push(entry); console.error('[accept:p7] ' + id)
    let error
    try { await pages[entry.actor].front(); await action(); for (const page of Object.values(pages)) { assert.deepEqual(page.errors, []); await page.noOverflow() }; recording.assertRunning(); entry.status = 'passed' }
    catch (cause) { error = cause; entry.status = 'failed'; throw cause }
    finally {
      try { await capture(pages[entry.actor], entry.title) } catch (cause) { entry.status = 'failed'; if (!error) throw cause }
      finally { entry.completedAt = new Date().toISOString(); entry.endSeconds = (Date.now() - recordingAt) / 1000 }
    }
  }
  function weixinMessage(id, text) {
    return { message_id: id, from_user_id: weixinAccount.ownerUserId, to_user_id: weixinAccount.id, message_type: 1, message_state: 2, seq: ++weixinSequence, create_time_ms: Date.now(),
      context_token: 'SYNTHETIC_CONTEXT_' + binding.runId + '_' + id, item_list: [{ type: 1, text_item: { text } }] }
  }
  async function channelTurn(messageId) {
    const message = await poll(async () => { const item = (await state()).channelMessages.find(value => value.providerMessageId === messageId); if (!item || item.status === 'reserved') return false; assert.equal(item.status, 'accepted'); return item }, 'durable channel message', 90_000)
    assert(message.memberConversationId && message.turnId)
    await poll(async () => { const conversation = await api('a', '/api/conversations/' + encodeURIComponent(message.memberConversationId)); const turn = conversation.turns.find(item => item.id === message.turnId); return turn?.status === 'completed' ? conversation : false }, 'native channel turn', 150_000)
    await poll(async () => (await state()).deliveries.some(item => item.sourceRef?.turnId === message.turnId && item.status === 'delivered'), 'actual simulated platform acknowledgment', 60_000)
    return message
  }
  async function actionDom(page, action, status) {
    const selector = '[data-repair-action-id="' + action.id + '"]'
    const view = await poll(async () => {
      const value = await page.evaluate(`(() => { const node = document.querySelector(${js(selector)}); if (!node) return null;
        const visible = item => Boolean(item && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
        return { id: node.dataset.repairActionId, status: node.dataset.repairStatus, visible: visible(node), text: node.innerText,
          fields: Object.fromEntries([...node.querySelectorAll('.kv')].map(item => [...item.querySelectorAll(':scope > span')].map(span => span.innerText.trim())).filter(item => item.length === 2)),
          summary: node.querySelector(':scope > summary')?.innerText || '' } })()`)
      try { validateP6ActionDom(value, action, status); return value } catch { return false }
    }, 'actual action DOM ' + status)
    await page.evaluate('document.querySelector(' + js(selector) + ').scrollIntoView({ block: "center" })'); await capture(page, status + ' 维修动作')
    return view
  }
  async function preview(workId, suffix) {
    await openWork('a', workId)
    const before = (await work('a', workId)).actions.map(item => item.id)
    await pages.a.click('#repair-open'); await pages.a.fill('#repair-reason', 'P7 新对象核对 ' + suffix)
    await pages.a.fill('#repair-description', '基于本轮新TPM及同设备当前监控、知识交接的synthetic维修请求 ' + suffix)
    await pages.a.click('#repair-save-preview')
    return poll(async () => { const matches = (await work('a', workId)).actions.filter(item => !before.includes(item.id)); assert(matches.length <= 1); return matches[0] }, 'durable owner preview')
  }
  async function transfer(args) {
    const child = launch(process.execPath, [join(root, 'scripts/state-transfer.mjs'), ...args], { env: { ...systemEnvironment(), GENEWAY_STATE: stateFile, GENEWAY_DSH_HOME: dshHome, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'] }, stdio: ['ignore', 'pipe', 'pipe'] })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); assert.equal(code, 0, 'formal transfer failed')
  }

  async function journeys() {
    await step('fresh-configuration', async () => {
      const page = pages.admin
      await page.nav('admin')
      await page.click('#tab-modelRoutes')
      for (const [id, model] of [['p7-deepseek', models[0]], ['p7-glm', models[1]]]) {
        const form = 'form[data-kind="modelRoute"][data-id=""]'
        await page.fill(form + ' [name="id"]', id)
        await page.fill(form + ' [name="displayName"]', model)
        await page.select(form + ' [name="model"]', model)
        await page.fill(form + ' [name="maxOutputTokens"]', '4096')
        await page.click(form + ' button.primary')
        await poll(async () => (await api('admin', '/api/admin/model-routes')).find(item => item.id === id && item.model === model && item.parameters.maxOutputTokens === 4096), 'admin Web model route ' + id)
        await page.wait('Boolean(document.querySelector(' + js('form[data-kind="modelRoute"][data-id="' + id + '"]') + '))')
      }
      await page.click('#tab-skills')
      for (const id of ['skill-' + correlation, 'skill-' + read]) {
        const form = 'form[data-kind="skill"][data-id="' + id + '"]'
        await page.fill(form + ' [name="name"]', 'P7 ' + id)
        await page.click(form + ' button.primary')
        await poll(async () => (await api('admin', '/api/admin/skills')).find(item => item.id === id && item.enabled && item.name === 'P7 ' + id), 'admin Web trusted Skill ' + id)
      }
      await page.click('#tab-connections')
      for (const source of fixtures) {
        const c = source.connection, form = 'form[data-kind="connection"][data-id=""]'
        await page.click('details:has(' + form + ') > summary')
        for (const [name, value] of Object.entries({ id: c.id, name: 'P7 Kivo ' + source.instance.toUpperCase(), targetIdentity: c.targetIdentity,
          baseUrl: c.baseUrl, issuer: c.issuer, clientId: c.clientId, credentialRef: c.credentialRef, sourceSystem: c.sourceSystem,
          sourceInstance: c.sourceInstance, sourceEnvironment: c.sourceEnvironment, dataMode: c.dataMode, evidenceMode: c.evidenceMode })) await page.fill(form + ' [name="' + name + '"]', value)
        for (const skillId of ['skill-' + correlation, 'skill-' + read]) await page.check(form + ' [name="skillIds"][value="' + skillId + '"]', true)
        await page.click(form + ' button.primary')
        await poll(async () => (await api('admin', '/api/admin/connections')).find(item => item.id === c.id && item.baseUrl === c.baseUrl && item.credentialRef === c.credentialRef), 'admin Web connection ' + c.id)
        await page.wait('Boolean(document.querySelector(' + js('form[data-kind="connection"][data-id="' + c.id + '"]') + '))')
        const savedForm = 'form[data-kind="connection"][data-id="' + c.id + '"]'
        await page.click('details:has(' + savedForm + ') > summary')
        await page.click('[data-test-connection="' + c.id + '"]')
        await poll(async () => (await api('admin', '/api/admin/connections')).find(item => item.id === c.id && item.status === 'ready'), 'actual Kivo MCP connection test')
      }
      await page.click('#tab-employees')
      const employeeSpecs = [
        { id: 'p7-agent-a', name: 'P7 协作负责人', instructions: '按计划交办，不猜业务单号；仅使用当前获准工具事实；维修创建只能由本人Web批准。', route: 'p7-deepseek', connection: fixtures[0].connection.id, skills: ['skill-' + correlation, 'skill-' + read], members: ['a'] },
        { id: 'p7-reviewer', name: 'P7 知识复核员工', instructions: '检索获准维护知识，核对来源和不确定性，交接给负责人；不创建业务对象。', route: 'p7-glm', connection: fixtures[0].connection.id, skills: ['skill-' + correlation, 'skill-' + read], members: ['a'] },
        { id: 'p7-agent-b', name: 'P7 B隔离员工', instructions: '只读取B实例当前获准事实。', route: 'p7-glm', connection: fixtures[1].connection.id, skills: ['skill-' + correlation, 'skill-' + read], members: ['b'] },
      ]
      for (const spec of employeeSpecs) {
        const form = 'form[data-kind="employee"][data-id=""]'
        for (const [name, value] of Object.entries({ id: spec.id, name: spec.name, instructions: spec.instructions })) await page.fill(form + ' [name="' + name + '"]', value)
        await page.select(form + ' [name="modelRouteId"]', spec.route)
        await page.check(form + ' [name="connectionIds"][value="' + spec.connection + '"]', true)
        for (const id of spec.skills) await page.check(form + ' [name="skillIds"][value="' + id + '"]', true)
        for (const id of spec.members) await page.check(form + ' [name="memberIds"][value="' + id + '"]', true)
        await page.click(form + ' button.primary')
        const savedEmployee = await poll(async () => (await api('admin', '/api/admin/employees')).find(item => item.id === spec.id), 'admin Web employee and open scope ' + spec.id)
        assert.deepEqual([...savedEmployee.skillIds].sort(), [...spec.skills].sort())
        assert.deepEqual(savedEmployee.connectionIds, [spec.connection])
        assert.deepEqual([...savedEmployee.memberIds].sort(), [...spec.members].sort())
        assert.equal(savedEmployee.modelRouteId, spec.route); assert.equal(savedEmployee.enabled, true)
        await page.wait('Boolean(document.querySelector(' + js('form[data-kind="employee"][data-id="' + spec.id + '"]') + '))')
      }
      const configured = await Promise.all(['members', 'employees', 'connections', 'skills', 'model-routes'].map(kind => api('admin', '/api/admin/' + kind)))
      assert.deepEqual(configured[0].find(item => item.id === 'a').employeeIds.sort(), ['p7-agent-a', 'p7-reviewer'].sort())
      assert.deepEqual(configured[0].find(item => item.id === 'b').employeeIds, ['p7-agent-b'])
      assert.equal(configured[1].length, 3); assert.equal(configured[2].length, 2); assert.equal(configured[4].length, 2)
      assert.equal((await request('a', '/api/admin/runtime')).status, 403)
      assert.equal((await request('b', '/api/admin/runtime')).status, 403)
      await capture(page, '管理员Web配置双路由、Skill、Kivo连接、员工和开放范围')
      const switched = await operator.wait('switch-endpoints', 'verify-endpoints', { endpoints: fixtures.map(source => ({ id: source.facts.endpointId, sourceId: source.eventSource.id, urlHash: hash(refs.origin + '/api/events/kivo/' + source.eventSource.id) })) })
      assert.equal(switched.signingSecretsMatch, true); assert.equal(switched.newDeviceScopeVerified, true); assert.equal(switched.endpointUrlsMatch, true)
      const material = await api('a', '/api/knowledge', 'POST', { employeeIds: ['p7-reviewer'], sharedMemberIds: ['a'], sharedEmployeeIds: ['p7-reviewer', 'p7-agent-a'],
        title: 'P7 新设备维护知识', body: '本轮新设备只依据明确的TPM单号、设备UUID和当前监控事实判断。出现采样缺失或来源质量未知时保持未知。维修创建必须由本人在Web核对预览并批准。', sourceLabel: 'P7 synthetic fixture', authorizationBasis: '本轮隔离验收资料' })
      refs.knowledgeId = material.id; refs.material = material
      const wxLink = await api('a', '/api/channels/weixin/bindings', 'POST', { channelAppId: 'channel-app-weixin' })
      simulator.queueLogin(simulator.confirmedLogin(weixinAccount.id))
      await poll(async () => (await api('a', '/api/channels')).linkCodes.find(item => item.id === wxLink.id)?.status === 'matched', 'actual iLink owner binding')
      await api('a', '/api/channels/link-codes/' + wxLink.id + '/confirm', 'POST', { employeeId: 'p7-agent-a' })
      const feishuLink = await api('a', '/api/channels/link-codes', 'POST', { channelAppId: app.id })
      await ipc(host, 'feishu-event', feishuEvent('bind-' + feishuLink.id, feishuLink.code))
      await poll(async () => (await api('a', '/api/channels')).linkCodes.find(item => item.id === feishuLink.id)?.status === 'matched', 'actual Lark EventDispatcher binding')
      await api('a', '/api/channels/link-codes/' + feishuLink.id + '/confirm', 'POST', { employeeId: 'p7-agent-a' })
      const own = await api('a', '/api/channels')
      refs.weixinIdentity = own.identities.find(item => item.channelAppId === 'channel-app-weixin' && item.status === 'active')
      refs.feishuIdentity = own.identities.find(item => item.channelAppId === app.id && item.status === 'active')
      assert(refs.weixinIdentity && refs.feishuIdentity)
      assert.equal((await request('b', '/api/knowledge/' + refs.knowledgeId + '?employeeId=p7-reviewer')).status, 404)
      facts.push({ kind: 'fresh-fixture', runId: binding.runId, producerRunId: fixtures[0].runId, baseCandidate: fixtures[0].candidate, records: fixtures.map(source => ({ instance: source.instance, recordId: source.facts.record.recordId, deviceId: source.facts.deviceId, externalDeviceId: source.facts.externalDeviceId, sourceInstance: source.connection.sourceInstance })), knowledgeId: material.id })
    })

    await step('channel-waiting-root', async () => {
      const messageId = 'p7-create-' + binding.runId
      const initial = `请用 geneway_work_create 创建一项 workType=collaboration 协作工作，负责人为当前获准会话 Agent p7-agent-a。工作目标是核对本轮新设备的TPM及监控，并由第二员工检索维护知识复核。计划仅两项：correlate由p7-agent-a执行skill-${correlation}，连接${fixture('a').connection.id}，input仅有recordType=repair，knowledgeQuery=P7 新设备维护知识；review由p7-reviewer执行skill-${read}，连接${fixture('a').connection.id}，input仅有recordType=repair，knowledgeQuery=P7 新设备维护知识，并依赖correlate。现在我故意没有提供单号；请保存待补充，不猜最近单据，不创建或批准维修单。`
      simulator.push(weixinAccount.id, [weixinMessage(messageId, initial)])
      refs.initialMessage = await channelTurn(messageId)
      const beforeReplay = (await state()).works.map(item => item.id)
      simulator.push(weixinAccount.id, [weixinMessage(messageId, initial)])
      await poll(async () => (await state()).channelMessages.filter(item => item.providerMessageId === messageId).length === 1, 'durable duplicate channel message')
      assert.deepEqual((await state()).works.map(item => item.id), beforeReplay)
      const sameConversation = refs.initialMessage.memberConversationId
      const rootWork = await poll(async () => { const found = (await state()).works.filter(item => item.conversationId === sameConversation && item.workType === 'collaboration'); assert(found.length <= 1); return found[0]?.status === 'waiting_input' ? found[0] : false }, 'channel-created waiting collaboration root', 150_000)
      refs.rootId = rootWork.id; refs.conversationId = sameConversation
      assert.equal(rootWork.plan.items.length, 2)
      assert(rootWork.plan.items.some(item => item.childWorkId), 'first waiting child was not saved')
      assert(rootWork.plan.items.some(item => item.employeeId === 'p7-reviewer'))
      await openWork('a', rootWork.id)
      await pages.a.wait('document.querySelector("#collaboration-continue-form") && document.querySelectorAll("[data-collaboration-item]").length === 2')
      await capture(pages.a, 'iLink交办的同一待补充协作根')
      const feishuId = 'p7-feishu-' + binding.runId
      await ipc(host, 'feishu-event', feishuEvent(feishuId, '请只说明你当前能处理获准的协作交接；不要创建工作、修改工作或批准维修。'))
      const feishuMessage = await channelTurn(feishuId)
      assert.notEqual(feishuMessage.memberConversationId, sameConversation)
      const snap = await ipc(host, 'snapshot'); assert.equal(snap.sdkDispatcher, true); assert.equal(snap.consumers.maxActive, 1)
      refs.feishuMessageId = feishuId
    })

    await step('restart-and-supplement', async () => {
      const before = await state(), rootBefore = before.works.find(item => item.id === refs.rootId)
      assert.equal(rootBefore.status, 'waiting_input')
      await stopOwned(host); host = await boot(true)
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await waitWeixinRestart()
      assert.equal((await work('a', refs.rootId)).status, 'waiting_input')
      for (let generation = 0; generation < rootBefore.plan.items.length; generation++) {
        await openWork('a', refs.rootId)
        const currentRoot = await work('a', refs.rootId)
        if (currentRoot.status === 'completed') break
        assert.equal(currentRoot.status, 'waiting_input')
        await pages.a.wait('Boolean(document.querySelector("#collaboration-continue-form"))')
        const pending = (await state()).works.filter(item => item.rootWorkId === refs.rootId && item.status === 'waiting_input')
        assert(pending.length >= 1)
        for (const child of pending) {
          const prefix = 'collaboration-input-' + child.planItemId
          await pages.a.select('#' + prefix + '-record-type', 'repair')
          await pages.a.fill('#' + prefix + '-reference', fixture('a').facts.record.reference)
        }
        await capture(pages.a, '本人Web补充同一根的新TPM单号')
        await pages.a.click('#collaboration-continue-form button')
        await poll(async () => { const value = await work('a', refs.rootId); return !['accepted', 'running'].includes(value.status) && value.collaboration?.generation > currentRoot.collaboration.generation ? value : false }, 'same-root native continuation', 360_000)
      }
      refs.root = await work('a', refs.rootId)
      assert.equal(refs.root.status, 'completed'); assert.equal(refs.root.id, refs.rootId)
      assert.equal((await state()).works.filter(item => item.id === refs.rootId).length, 1)
      await openWork('a', refs.rootId)
      await pages.a.wait('document.querySelectorAll("[data-collaboration-item] [data-open-work]").length >= 2')
    })

    await step('two-model-collaboration', async () => {
      const current = await state(), rootWork = current.works.find(item => item.id === refs.rootId), children = current.works.filter(item => item.rootWorkId === refs.rootId)
      assert.equal(rootWork.status, 'completed'); assert.equal(children.length, 2)
      assert(rootWork.handoffs.length >= 2 && rootWork.results.some(item => item.kind === 'assistant.collaboration-summary'))
      assert(children.every(item => item.status === 'completed' && item.executions.some(execution => execution.dshSessionRef)))
      refs.correlationChild = children.find(item => item.results.some(result => result.kind === 'kivo.tpm.device-correlation'))
      refs.reviewChild = children.find(item => item.id !== refs.correlationChild?.id)
      assert(refs.correlationChild && refs.reviewChild)
      const actual = new Set([rootWork, ...children].flatMap(item => item.executions.map(execution => execution.modelSnapshot?.model)).filter(Boolean))
      assert.deepEqual([...actual].sort(), [...models].sort(), 'both model routes must execute in the selected root/children')
      const result = validateP6Correlation(refs.correlationChild, fixture('a'))
      assert(result.knowledgeDependencyRefs?.some(ref => ref.knowledgeId === refs.knowledgeId), 'correlation child did not save its authorized maintenance knowledge dependency')
      assert(refs.reviewChild.results.some(item => item.knowledgeDependencyRefs?.some(ref => ref.knowledgeId === refs.knowledgeId)), 'review did not use authorized knowledge')
      await openWork('a', refs.rootId); await pages.a.click('[data-collaboration-item] [data-open-work="' + refs.correlationChild.id + '"]')
      await pages.a.wait('state.currentWork?.id === ' + js(refs.correlationChild.id))
      const card = '[data-correlation-result="' + result.id + '"]'
      await pages.a.wait('Boolean(document.querySelector(' + js(card) + '))')
      if (!await pages.a.evaluate('document.querySelector(' + js(card + ' details') + ')?.open')) await pages.a.click(card + ' details > summary')
      await capture(pages.a, '协作根导航到真实关联子工作与来源')
      const auditBefore = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const baseline = Object.fromEntries(models.map(model => [model, auditBefore.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai' && row.model === model).length]))
      const bMcpBefore = auditBefore.filter(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.port === 34682 && row.path === '/api/v1/mes/mcp').length
      const pair = await Promise.all([
        { actor: 'a', employeeId: 'p7-agent-a', instance: 'a', model: models[0], label: 'W1' },
        { actor: 'b', employeeId: 'p7-agent-b', instance: 'b', model: models[1], label: 'W2' },
      ].map(async spec => ({ ...spec, created: await api(spec.actor, '/api/works', 'POST', { employeeId: spec.employeeId, skillId: 'skill-' + read,
        connectionId: fixture(spec.instance).connection.id, goal: 'P7_PARALLEL_' + spec.label + '_' + binding.runId + ' 仅读取本轮明确TPM单号',
        input: { recordType: 'repair', reference: fixture(spec.instance).facts.record.reference }, clientRequestId: 'p7-parallel-' + spec.label + '-' + binding.runId }) })))
      assert.notEqual(pair[0].created.id, pair[1].created.id)
      await poll(async () => {
        const rows = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        return pair.every(spec => rows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai' && row.model === spec.model).length > baseline[spec.model])
      }, 'both independent actual model routes dispatched', 90_000)
      const running = await Promise.all(pair.map(spec => work(spec.actor, spec.created.id)))
      assert(running.every(item => ['accepted', 'running'].includes(item.status)), 'independent W1/W2 did not overlap while both model routes ran')
      assert(running.every((item, index) => item.executions.at(-1).modelSnapshot.model === pair[index].model && item.executions.at(-1).startedAt), 'actual parallel route snapshots missing')
      await api('a', workPath(pair[0].created.id) + '/cancel', 'POST', {})
      const stopped = await poll(async () => { const item = await work('a', pair[0].created.id); return item.status === 'cancelled' && item.executions.at(-1).closePending === false ? item : false }, 'W1 isolated native cancellation', 120_000)
      const surviving = await poll(async () => { const item = await work('b', pair[1].created.id); assert.notEqual(item.status, 'cancelled', 'W1 cancellation stopped W2'); return item.status === 'completed' ? item : false }, 'W2 unaffected actual model completion', 180_000)
      const w1 = stopped.executions.at(-1), w2 = surviving.executions.at(-1)
      assert(Date.parse(w1.startedAt) < Date.parse(w2.completedAt) && Date.parse(w2.startedAt) < Date.parse(w1.completedAt), 'W1/W2 execution intervals never overlapped')
      assert.equal(w2.runtime.model, models[1]); assert(w2.runtime.requestCount > 0 && w2.runtime.requestCount <= w2.runtime.requestLimit)
      assert(Number.isFinite(w2.runtime.durationMs) && w2.runtime.durationMs >= 0)
      const observation = surviving.results.find(item => item.kind === 'kivo.tpm.observation'), observed = observation?.payload, expectedB = fixture('b')
      assert.equal(surviving.ownerMemberId, 'b'); assert.equal(surviving.connectionId, expectedB.connection.id)
      assert.equal(observed?.status, 'ok'); assert.equal(observed.mode, 'record'); assert.equal(observed.recordType, 'repair'); assert.equal(observed.records.length, 1)
      assert.equal(observed.records[0].id, expectedB.facts.record.recordId); assert.equal(observed.records[0].reference, expectedB.facts.record.reference)
      assert.equal(observed.linkedDevice?.id, expectedB.facts.deviceId)
      assert.equal(observed.source.sourceInstance, expectedB.connection.sourceInstance); assert.equal(observation.source.sourceInstance, expectedB.connection.sourceInstance)
      assert.notEqual(observed.records[0].id, fixture('a').facts.record.recordId); assert.notEqual(observed.linkedDevice.id, fixture('a').facts.deviceId)
      assert.equal((await request('a', workPath(surviving.id))).status, 404); assert.equal((await request('b', workPath(stopped.id))).status, 404)
      const parallelAudit = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(parallelAudit.filter(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.port === 34682 && row.path === '/api/v1/mes/mcp').length > bMcpBefore, 'W2 never reached B actual MCP resource')
      await openWork('b', surviving.id)
      await pages.b.click('#work-detail [data-runtime-facts] > summary')
      const ownRuntime = await pages.b.evaluate('document.querySelector("#work-detail [data-runtime-facts]")?.innerText')
      assert(ownRuntime?.includes(models[1]) && ownRuntime.includes(String(w2.runtime.requestCount) + ' / ' + String(w2.runtime.requestLimit)) && ownRuntime.includes('耗时（毫秒）'), 'owner model, request budget or elapsed time absent from Web')
      await capture(pages.b, 'B本人可见独立实例W2模型、请求预算、耗时与用量')
      await pages.admin.front(); await pages.admin.nav('admin'); await pages.admin.click('#tab-runtime')
      await pages.admin.wait('[...document.querySelectorAll("#config-runtime [data-admin-runtime=work]")].some(item => item.innerText.includes(' + js(surviving.id) + '))')
      const metadata = await api('admin', '/api/admin/runtime')
      const row = metadata.executions.find(item => item.workId === surviving.id && item.executionId === w2.id)
      assert(row && row.runtime.model === models[1] && row.runtime.requestCount === w2.runtime.requestCount)
      assert.deepEqual(Object.keys(row).sort(), ['employeeId', 'errorCode', 'executionId', 'runtime', 'status', 'workId'].sort(), 'administrator execution DTO exposed member body')
      assert(!JSON.stringify(metadata).includes('P7_PARALLEL_W2_'), 'administrator metadata contains owner goal')
      const rowIndex = metadata.executions.findIndex(item => item.workId === surviving.id && item.executionId === w2.id)
      await pages.admin.wait('document.querySelectorAll("#config-runtime [data-admin-runtime=work]").length > ' + rowIndex)
      await pages.admin.click('#config-runtime [data-admin-runtime="work"]:nth-of-type(' + (rowIndex + 1) + ') [data-runtime-facts] > summary')
      const adminRuntime = await pages.admin.evaluate('document.querySelector("#config-runtime")?.innerText')
      assert(adminRuntime.includes(surviving.id) && adminRuntime.includes(models[1]) && !adminRuntime.includes('P7_PARALLEL_W2_'), 'administrator Web metadata omitted execution or exposed owner body')
      assert.equal((await request('a', '/api/admin/runtime')).status, 403)
      await capture(pages.admin, '管理员仅见执行元数据，不见成员正文')
      assert.equal((await request('admin', workPath(refs.rootId))).status, 404)
      assert.equal((await request('b', workPath(refs.correlationChild.id))).status, 404)
      facts.push({ kind: 'collaboration', rootWorkId: refs.rootId, childWorkIds: children.map(item => item.id), correlationResultId: result.id, knowledgeId: refs.knowledgeId, models: [...actual].sort(),
        independentParallel: { w1: stopped.id, w2: surviving.id, w1Status: stopped.status, w2Status: surviving.status, overlap: true, w2Requests: w2.runtime.requestCount, w2Limit: w2.runtime.requestLimit,
          w2Owner: 'b', w2RecordId: observed.records[0].id, w2DeviceId: observed.linkedDevice.id, w2SourceInstance: observed.source.sourceInstance, w2Resource: expectedB.connection.baseUrl } })
    })

    await step('same-object-event', async () => {
      await reload(pages.a, 'works'); await pages.a.click('#new-automation')
      await pages.a.select('#automation-employee', 'p7-agent-a')
      await pages.a.select('#automation-skill', 'skill-' + read)
      await pages.a.select('#automation-connection', fixture('a').connection.id)
      await pages.a.select('#automation-record-type', 'repair')
      await pages.a.fill('#automation-reference', fixture('a').facts.record.reference)
      await pages.a.select('#automation-trigger-kind', 'kivo-record-update')
      await pages.a.select('#automation-source', fixture('a').eventSource.id)
      await pages.a.select('#automation-notification', refs.weixinIdentity.id)
      await pages.a.click('#automation-save')
      refs.rule = await poll(async () => { const rules = (await state()).automationRules.filter(item => item.ownerMemberId === 'a' && item.input?.reference === fixture('a').facts.record.reference); assert(rules.length <= 1); return rules[0] }, 'owner Web rule draft')
      await pages.a.wait('Boolean(document.querySelector(' + js('[data-automation-rule="' + refs.rule.id + '"]') + '))')
      await pages.a.click('[data-automation-rule="' + refs.rule.id + '"] [data-rule-action="enable"]')
      refs.rule = await poll(async () => { const value = (await state()).automationRules.find(item => item.id === refs.rule.id); return value?.status === 'active' ? value : false }, 'owner Web enabled rule')
      const expected = { recordId: fixture('a').facts.record.recordId, reference: fixture('a').facts.record.reference, deviceId: fixture('a').facts.deviceId, resource: fixture('a').connection.baseUrl, statusBefore: 'reported', statusAfter: 'dispatched' }
      const proof = await operator.wait('source-human-update', 'human-update-source-and-release', expected)
      validateP6StatusAdvance(proof); validateP6Worker(proof, fixture('a'), proof.event.eventId, binding.candidate)
      refs.occurrence = await poll(async () => { const details = await api('a', '/api/automations/' + refs.rule.id); return details.occurrences.find(item => item.event?.eventId === proof.event.eventId && item.workId) }, 'same-object producer occurrence', 120_000)
      await verifyDurableAcks(proof, 'human-source-update')
      const observed = await poll(async () => { const item = await work('a', refs.occurrence.workId); return ['accepted', 'running'].includes(item.status) ? false : item }, 'same-object native follow-up', 180_000)
      validateP7EventObservation(observed, fixture('a'), 'a')
      await reload(pages.a, 'works')
      await pages.a.click('#automation-list [data-open-automation="' + refs.rule.id + '"]')
      await pages.a.wait('state.automationDetail?.rule?.id === ' + js(refs.rule.id) + ' && Boolean(document.querySelector(' + js('[data-automation-occurrence="' + refs.occurrence.id + '"] [data-open-work="' + observed.id + '"]') + '))')
      await pages.a.click('[data-automation-occurrence="' + refs.occurrence.id + '"] [data-open-work="' + observed.id + '"]')
      await pages.a.wait('state.currentWork?.id === ' + js(observed.id)); await capture(pages.a, '人类来源变化后的规则发生和新观察')
      const previousCorrelationId = refs.correlationChild.results.findLast(item => item.kind === 'kivo.tpm.device-correlation').id
      const revised = await api('a', '/api/knowledge/' + refs.knowledgeId, 'PATCH', { expectedRevision: refs.material.revision,
        body: '本轮维护规则更正：一旦来源单据版本变化，必须重新读取明确单号与同设备当前监控后再考虑维修；不可沿用旧版本观察。缺失或来源质量未知仍保持未知，维修创建仍须本人Web批准。' })
      assert(revised.revision > refs.material.revision)
      await poll(async () => { const value = await work('a', refs.rootId); return value.collaboration?.status === 'stale' && value.collaboration.staleItemIds.includes(refs.correlationChild.planItemId) ? value : false }, 'knowledge change invalidated correlation child')
      const auditBeforeRecheck = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const countRecheck = predicate => auditBeforeRecheck.filter(predicate).length
      const modelBeforeRecheck = countRecheck(row => row.kind === 'fetch' && row.host === 'zenmux.ai')
      const kivoBeforeRecheck = countRecheck(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.path === '/api/v1/mes/mcp')
      await openWork('a', refs.rootId); await pages.a.wait('Boolean(document.querySelector("#recheck-work"))')
      await pages.a.click('#recheck-work')
      const refreshedRoot = await poll(async () => { const value = await work('a', refs.rootId); return value.collaboration?.status === 'completed' && value.collaboration.generation > refs.root.collaboration.generation ? value : false }, 'same-root current-fact recheck', 360_000)
      const refreshed = (await state()).works.find(item => item.id === refs.correlationChild.id)
      const refreshedResult = validateP6Correlation(refreshed, fixture('a'))
      assert.notEqual(refreshedResult.id, previousCorrelationId, 'correlation child did not execute a fresh read')
      assert.equal(String(refreshedResult.payload.tpm.revision), String(proof.event.sourceRevision), 'root child did not refresh the human source revision')
      const auditAfterRecheck = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(auditAfterRecheck.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai').length > modelBeforeRecheck, 'recheck did not reach the actual model')
      assert(auditAfterRecheck.filter(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.path === '/api/v1/mes/mcp').length > kivoBeforeRecheck, 'recheck did not reach actual Kivo MCP')
      refs.root = refreshedRoot; refs.correlationChild = refreshed
      await capture(pages.a, '新来源与知识版本后，同一根重新核对')
      facts.push({ kind: 'same-object-event', ruleId: refs.rule.id, occurrenceId: refs.occurrence.id, followUpWorkId: observed.id, recordId: expected.recordId, eventId: proof.event.eventId })
    })

    await step('mobile-reject-and-approve', async () => {
      await pages.a.viewport(390, 844)
      await openWork('a', refs.rootId)
      await pages.a.click('[data-collaboration-item] [data-open-work="' + refs.correlationChild.id + '"]')
      await pages.a.wait('state.currentWork?.id === ' + js(refs.correlationChild.id))
      const beforeReject = await silentSnapshot()
      const rejected = await preview(refs.correlationChild.id, '先拒绝')
      await pages.a.click('[data-repair-id="' + rejected.id + '"][data-repair-operation="reject"]')
      const rejectedSaved = await poll(async () => { const item = (await work('a', refs.correlationChild.id)).actions.find(value => value.id === rejected.id); return item?.decision?.kind === 'rejected' ? item : false }, 'durable owner rejection')
      await actionDom(pages.a, rejectedSaved, 'rejected')
      const afterReject = await silentSnapshot()
      assert.equal(beforeReject.createDispatches, 0); assert.equal(afterReject.createDispatches, 0)
      assert.equal(afterReject.createObserverSha256, beforeReject.createObserverSha256, 'rejected preview dispatched a business create')
      refs.action = await preview(refs.correlationChild.id, '本人批准')
      const noWrite = await operator.wait('pre-approval-no-write', 'read-created-repair', target(refs.action))
      assert.equal(noWrite.matchingBusinessRows, 0); assert.equal(noWrite.matchingCreateRequests, 0)
      const beforeSend = simulator.calls.filter(call => call.endpoint === '/ilink/bot/sendmessage').length
      simulator.queueSend(weixinAccount.id, { httpStatus: 200, body: { ret: 403 } })
      await doubleClickControl(pages.a, '[data-repair-id="' + refs.action.id + '"][data-repair-operation="approve"]')
      refs.created = await poll(async () => { const item = (await work('a', refs.correlationChild.id)).actions.find(value => value.id === refs.action.id); return item?.receipt ? item : false }, 'actual machine creation and independent readback', 150_000)
      await actionDom(pages.a, refs.created, 'created')
      assert(/^GW-/.test(refs.created.preview.payload.orderNo), 'new GW order number required')
      const proof = await operator.wait('created-readback', 'read-created-repair', target(refs.created))
      validateP6Creation(refs.created, fixture('a'), proof.record)
      assert.equal(proof.matchingBusinessRows, 1); assert.equal(proof.matchingCreateRequests, 1)
      const echo = await operator.wait('created-event', 'release-created-event', target(refs.created))
      validateP6Worker(echo, fixture('a'), echo.event.eventId, binding.candidate)
      assert.equal(echo.event.action, 'create'); assert.equal(echo.event.actorKind, 'machine')
      await poll(async () => (await state()).automationInbox.some(item => item.event.eventId === echo.event.eventId && item.actionRef?.actionId === refs.action.id), 'creation echo correlation', 90_000)
      await verifyDurableAcks(echo, 'created-repair-event')
      assert(simulator.calls.filter(call => call.endpoint === '/ilink/bot/sendmessage').length >= beforeSend + 1, 'receipt send was not attempted')
      facts.push({ kind: 'repair-created', rootWorkId: refs.rootId, childWorkId: refs.correlationChild.id, rejectedActionId: rejected.id, actionId: refs.action.id, orderNo: refs.created.preview.payload.orderNo, upstreamRecordId: refs.created.receipt.upstreamRecordId, traceId: refs.action.id })
    })

    await step('same-channel-receipt', async () => {
      refs.delivery = await poll(async () => (await state()).deliveries.find(item => item.actionId === refs.action.id && item.workId === refs.correlationChild.id && item.status === 'failed'), 'durable failed receipt delivery')
      assert.equal(refs.delivery.error?.code, 'WEIXIN_SEND_REJECTED')
      assert.equal(refs.delivery.targetIdentityId, refs.weixinIdentity.id)
      const before = simulator.calls.filter(call => call.endpoint === '/ilink/bot/sendmessage').length
      const source = (await state()).members.find(item => item.id === 'a').employeeIds
      await api('admin', '/api/admin/members/a', 'PATCH', { employeeIds: source.filter(id => id !== 'p7-agent-a'), expectedEmployeeIds: source })
      await verifyP7RevokedRetry({ request, state, simulator, delivery: refs.delivery, sendCount: before })
      await api('admin', '/api/admin/members/a', 'PATCH', { employeeIds: source, expectedEmployeeIds: source.filter(id => id !== 'p7-agent-a') })
      const sent = await api('a', '/api/channels/deliveries/' + refs.delivery.id + '/retry', 'POST', {})
      assert.equal(sent.status, 'delivered'); assert.equal(sent.id, refs.delivery.id)
      refs.delivery = (await state()).deliveries.find(item => item.id === refs.delivery.id)
      assert.equal(refs.delivery.status, 'delivered')
      await openWork('a', refs.correlationChild.id); await capture(pages.a, '同一渠道维修回执与重试不重新执行业务')
    })

    await step('normal-restart', async () => {
      const before = await state(), action = before.works.find(item => item.id === refs.correlationChild.id).actions.find(item => item.id === refs.action.id)
      assert(action.receipt)
      await stopOwned(host); host = await boot(true)
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await waitWeixinRestart()
      const after = await state()
      assert.deepEqual(after.works.find(item => item.id === refs.rootId).plan, before.works.find(item => item.id === refs.rootId).plan)
      assert.deepEqual(after.works.find(item => item.id === refs.correlationChild.id).actions, before.works.find(item => item.id === refs.correlationChild.id).actions)
      assert.equal(after.deliveries.find(item => item.id === refs.delivery.id).status, 'delivered')
      await openWork('a', refs.rootId); await capture(pages.a, '正常重启后根与子工作仍可进入')
      await pages.a.click('[data-collaboration-item] [data-open-work="' + refs.correlationChild.id + '"]')
      await actionDom(pages.a, action, 'created')
      const proof = await operator.wait('restart-no-write', 'read-action-traces', { traces: [refs.action.id] }); assert.equal(proof.newCreateRequests, 0)
    })

    await step('empty-restore', async () => {
      await stopOwned(host)
      const before = await state(), backup = join(privateRoot, 'backup'), secretPackage = join(privateRoot, 'secret-package'), restored = join(privateRoot, 'restored'), restoredSecrets = join(privateRoot, 'restored-secrets')
      await transfer(['backup', '--output', backup, '--secret-output', secretPackage, '--secret-root', secretRoot])
      await transfer(['restore', '--input', backup, '--data-root', restored, '--secret-input', secretPackage, '--secret-root', restoredSecrets])
      stateFile = join(restored, 'state.json'); dshHome = join(restored, 'dsh'); secretRoot = restoredSecrets
      catalogFile = join(restored, 'connection-catalog.json')
      await writeFile(catalogFile, await readFile(options.catalog), { mode: 0o600, flag: 'wx' })
      assert.equal(hash(await readFile(catalogFile)), inputs.catalog.sha256)
      const after = await state()
      assert.deepEqual(after.works.map(item => item.results), before.works.map(item => item.results))
      assert(after.automationRules.every(item => item.status !== 'active'))
      assert(after.channelApps.every(item => !item.enabled))
      assert(after.channelIdentities.filter(item => item.channelAppId === 'channel-app-weixin').every(item => item.status === 'rebind-required'))
      assert(after.deliveries.find(item => item.id === refs.delivery.id).status === 'delivered')
      assert(JSON.parse(await readFile(join(restored, 'event-sources.json'), 'utf8')).sources.every(item => !item.enabled))
      const members = join(restored, 'members.json'), newAuth = join(restored, 'auth.json')
      await writeFile(members, JSON.stringify(after.members.map(item => ({ id: item.id, authRef: item.authRef }))), { mode: 0o600, flag: 'wx' })
      await rekey(members, newAuth)
      authFile = newAuth; authFiles.push(newAuth)
      const baseline = await silentSnapshot()
      host = await boot(false)
      assert.equal((await request('a', '/api/bootstrap')).status, 401, 'old cookie survived rekey')
      await new Promise(done => setTimeout(done, 5000))
      const quiet = await silentSnapshot()
      assert.deepEqual(quiet, baseline, 'empty restore produced model requests, channel sends, create dispatches or new persisted work during the silent window')
      facts.push({ kind: 'restore-silent-window', seconds: 5, modelRequests: 0, channelSends: 0, createDispatches: 0, persistedChanges: 0,
        createObserverSha256: quiet.createObserverSha256 })
      for (const actor of ['admin', 'a', 'b']) { delete sessions[actor]; await login(actor); await browserLogin(actor) }
      assert.equal((await request('b', workPath(refs.rootId))).status, 404)
      assert.equal((await request('admin', workPath(refs.correlationChild.id))).status, 404)
      const proof = await operator.wait('restore-no-write', 'read-action-traces', { traces: [refs.action.id] }); assert.equal(proof.newCreateRequests, 0)
      const restoredState = await state()
      assert.equal(restoredState.works.find(item => item.id === refs.correlationChild.id).actions.find(item => item.id === refs.action.id).receipt.upstreamRecordId, refs.created.receipt.upstreamRecordId)
      await openWork('a', refs.rootId); await capture(pages.a, '空目录恢复与旧渠道停发、历史可读')
      refs.restoreRoot = restored
    })

    await step('post-restore-read', async () => {
      await pages.a.viewport(390, 844)
      await reload(pages.a, 'home')
      const before = (await state()).works.map(item => item.id)
      await pages.a.select('#work-employee', 'p7-agent-a')
      await pages.a.select('#work-skill', 'skill-' + read)
      await pages.a.select('#work-connection', fixture('a').connection.id)
      await pages.a.select('#work-tpm-record-type', 'repair')
      await pages.a.fill('#work-tpm-reference', fixture('a').facts.record.reference)
      await pages.a.fill('#work-goal', '恢复后只读核对本轮明确TPM单号与当前状态，不创建维修单')
      await pages.a.click('#submit-work')
      const newWork = await poll(async () => { const found = (await state()).works.filter(item => !before.includes(item.id) && item.ownerMemberId === 'a'); assert(found.length <= 1); return found[0]?.status === 'completed' ? found[0] : false }, 'new authorized read-only native work after restore', 180_000)
      assert(newWork.results.length && newWork.actions.length === 0)
      assert.equal((await state()).deliveries.filter(item => item.id === refs.delivery.id).length, 1)
      await openWork('a', newWork.id); await capture(pages.a, '重新认证后的新只读执行')
      const stateNow = await state(), conversation = stateNow.conversations.find(item => item.id === refs.conversationId), identity = stateNow.channelIdentities.find(item => item.id === refs.weixinIdentity.id)
      const rule = stateNow.automationRules.find(item => item.id === refs.rule.id), occurrence = (await api('a', '/api/automations/' + rule.id)).occurrences.find(item => item.id === refs.occurrence.id)
      const action = stateNow.works.find(item => item.id === refs.correlationChild.id).actions.find(item => item.id === refs.action.id)
      const endpoint = stateNow.channelConversations.find(item => item.identityId === refs.weixinIdentity.id && item.type === 'private')
      const chain = validateP7Chain({ memberId: 'a', identity, endpoint, conversation, rootWork: stateNow.works.find(item => item.id === refs.rootId), children: stateNow.works.filter(item => item.rootWorkId === refs.rootId),
        fixture: fixture('a'), rule, occurrence, action, delivery: stateNow.deliveries.find(item => item.id === refs.delivery.id) })
      facts.push({ kind: 'j10-chain', ...chain, postRestoreReadWorkId: newWork.id, restoredRoot: refs.restoreRoot })
      await api('admin', '/api/admin/model-routes/p7-deepseek', 'PATCH', { enabled: false })
      const disabledBefore = await state()
      const callsBefore = (await readFile(auditFile, 'utf8')).split('\n').filter(line => line.includes('"host":"zenmux.ai"')).length
      const unavailable = await request('a', '/api/works', 'POST', { employeeId: 'p7-agent-a', skillId: 'skill-' + read, connectionId: fixture('a').connection.id,
        goal: '停用路由拒绝且不可隐式回退', input: { recordType: 'repair', reference: fixture('a').facts.record.reference }, clientRequestId: 'p7-disabled-route-' + binding.runId })
      validateP7DisabledRoute({ response: unavailable, before: disabledBefore, after: await state(), modelRequestsBefore: callsBefore,
        modelRequestsAfter: (await readFile(auditFile, 'utf8')).split('\n').filter(line => line.includes('"host":"zenmux.ai"')).length })
      await api('admin', '/api/admin/model-routes/p7-deepseek', 'PATCH', { enabled: true })
      facts.push({ kind: 'disabled-route', status: unavailable.status, code: unavailable.body.error.code, modelRequests: 0, fallback: false })
    })
  }
  async function rekey(members, output) {
    const child = launch(process.execPath, [join(root, 'scripts/init-p2-auth.mjs'), '--mode', 'rekey', '--state', stateFile, '--auth', output, '--members', members],
      { env: { ...systemEnvironment(), GENEWAY_MEMBER_PASSWORDS: JSON.stringify(passwords) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); assert.equal(code, 0, 'formal member rekey failed')
  }
}

function validateTimeline(steps) {
  assert.deepEqual(steps.map(step => [step.id, step.status]), stepsRequired.map(id => [id, 'passed']))
  let end = 0
  for (const item of steps) {
    assert(item.startSeconds >= end && item.endSeconds >= item.startSeconds)
    assert(item.screenshots.length > 0)
    for (const shot of item.screenshots) assert(shot.seconds >= item.startSeconds && shot.seconds <= item.endSeconds)
    end = item.endSeconds
  }
  for (const id of ['mobile-reject-and-approve', 'same-channel-receipt', 'post-restore-read']) assert(steps.find(step => step.id === id).screenshots.some(shot => shot.viewport.width === 390))
}

function manual(report) {
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const rows = report.steps.map((step, index) => `<section><h2>${index + 1}. ${esc(step.title)}</h2><p>${esc(step.status)} · ${esc(step.startSeconds?.toFixed(1))}–${esc(step.endSeconds?.toFixed(1))} 秒</p><div class="shots">${step.screenshots.map(shot => `<figure><img src="${esc(shot.file)}" alt="${esc(shot.label)}"><figcaption>${esc(shot.label)} · ${esc(shot.seconds.toFixed(1))} 秒 · ${esc(shot.actor)}</figcaption></figure>`).join('')}</div></section>`).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>P7 J10 同候选实录</title><style>body{font-family:system-ui,"Noto Sans CJK SC",sans-serif;max-width:1100px;margin:auto;padding:32px;color:#18251f;background:#f7faf7}header,section{background:white;padding:24px;margin:0 0 20px;border:1px solid #d9e6dc;border-radius:12px}video{width:100%}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}figure{margin:0}img{max-width:100%;border:1px solid #d9e6dc}figcaption,p{color:#526359}h1,h2{line-height:1.4}h2{font-size:20px}</style><header><h1>P7 J10 同候选操作实录</h1><p>${esc(report.ok ? '全部十步通过' : '本轮未通过；保留失败步骤与已拍摄证据')}</p><p>渠道为模拟验收；Kivo 为 synthetic/external-test。模型为实际 ZenMux DeepSeek Flash 与 GLM Flash。此页只记录本轮 J10；容量、安装、回退及发布有独立结论。</p><video controls preload="metadata" src="p7-j10.mp4"></video><p>运行编号：${esc(report.binding.runId)} · 候选 SHA-256：${esc(report.binding.candidate)}</p></header>${rows}</html>`
}

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true })
  assert.throws(() => argumentsFor(['--run']))
  assert.throws(() => argumentsFor(['--harness-check', '--candidate', '/synthetic/candidate']))
  const runtimeArgs = ['--run', ...['output', 'fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'secret-root', 'network-guard', 'observer-config'].flatMap(key => ['--' + key, '/synthetic/' + key]),
    '--expected-head', 'a'.repeat(40), '--guard-sha256', 'b'.repeat(64), '--observer-config-sha', 'c'.repeat(64), '--model-ref', 'ZENMUX_API_KEY', '--run-id', 'p7-pure']
  assert.equal(argumentsFor(runtimeArgs)['observer-config'], '/synthetic/observer-config')
  for (const key of ['observer-config', 'observer-config-sha', 'fixture-a', 'fixture-b', 'candidate', 'run-id']) {
    const missing = [...runtimeArgs], index = missing.indexOf('--' + key); missing.splice(index, 2); assert.throws(() => argumentsFor(missing), 'missing ' + key)
  }
  const harness = await readFile(script, 'utf8')
  await callerChecks(harness)
  {
    const [{ getCapability, parseCapabilityToolResult, sanitizeFollowUpContext }, { connectionInputAllowed, connectionSnapshot }, { assertTrustedConnection }, { createKnowledgeService, currentKnowledgeReference }, { connection, correlationFixture, now }] = await Promise.all([
      import('../src/capabilities.mjs'), import('../src/execution-grant.mjs'), import('../src/connection-catalog.mjs'), import('../src/knowledge-service.mjs'), import('./fixtures/kivo-device-correlation.mjs'),
    ])
    const binding = { ...connection, skillIds: ['skill-' + correlation, 'skill-' + read] }
    const specStart = harness.indexOf('      const employeeSpecs = ['), specEnd = harness.indexOf('\n      for (const spec of employeeSpecs)', specStart)
    assert(specStart >= 0 && specEnd > specStart)
    const specs = new Function('fixtures', 'correlation', 'read', harness.slice(specStart, specEnd) + '\nreturn employeeSpecs')([{ connection: binding }, { connection: { id: 'synthetic-b' } }], correlation, read)
    const recipient = specs.find(item => item.id === 'p7-reviewer')
    assert.equal(recipient.route, 'p7-glm'); assert.deepEqual(recipient.members, ['a']); assert.equal(recipient.connection, binding.id)
    const capability = getCapability(correlation), payload = correlationFixture({ binding })
    const result = { ...parseCapabilityToolResult(capability.id, { ok: true, observation: payload }, payload.input), id: 'result', capabilityId: capability.id }
    const child = { id: 'child', ownerMemberId: 'a', rootWorkId: 'root', employeeId: 'p7-agent-a', skillId: capability.skillId, capabilityId: capability.id, connectionId: binding.id, status: 'completed', input: payload.input, results: [result] }
    let state = { members: [{ id: 'a', enabled: true, employeeIds: ['p7-agent-a', recipient.id] }],
      employees: specs.map(item => ({ id: item.id, enabled: true, skillIds: [...item.skills], connectionIds: [item.connection], modelRouteId: item.route })),
      skills: [correlation, read].map(id => ({ id: getCapability(id).skillId, capabilityId: id, enabled: true })), connections: [binding], knowledgeMaterials: [], works: [child] }
    const knowledge = createKnowledgeService({ store: { async read() { return structuredClone(state) }, async update(mutate) { state = mutate(structuredClone(state)) } }, clock: () => now, idFactory: () => 'p7-handoff' })
    const material = await knowledge.createMaterial({ id: 'a' }, { employeeIds: ['p7-agent-a', recipient.id], title: '合成维护知识', body: '仅核对当前关联事实。', sourceLabel: 'pure fixture', authorizationBasis: '合成权限检查' })
    const ref = await knowledge.resolveReference({ id: 'a' }, { employeeId: recipient.id, knowledgeId: material.id, revision: material.revision, segmentId: 'p1-c1' })
    const knowledgeRef = { knowledgeId: ref.knowledgeId, revision: ref.revision, segmentId: ref.segmentId }
    const rootWork = { id: 'root', ownerMemberId: 'a', employeeId: child.employeeId, plan: { items: [{ id: 'correlate', childWorkId: child.id, status: 'completed' }, { id: 'review', dependsOn: ['correlate'] }] },
      handoffs: [{ id: 'handoff', childWorkId: child.id, status: 'current', resultRefs: [result.id], knowledgeRefs: [knowledgeRef] }] }
    const source = await readFile(join(root, 'src/collaboration-runner.mjs'), 'utf8')
    const start = source.indexOf('  function handoffProjection('), end = source.indexOf('\n  async function validateRequestContext(', start)
    const runtimeError = source.split('\n').find(line => line.startsWith('function runtimeError('))
    assert(start >= 0 && end > start && runtimeError)
    const project = new Function('getCapability', 'connectionInputAllowed', 'assertTrustedConnection', 'connectionCatalog', 'connectionSnapshot', 'currentKnowledgeReference', 'sanitizeFollowUpContext', runtimeError + '\n' + source.slice(start, end) + '\nreturn dependencyProjection')(
      getCapability, connectionInputAllowed, assertTrustedConnection, [binding], connectionSnapshot, currentKnowledgeReference, sanitizeFollowUpContext)
    const item = rootWork.plan.items.find(item => item.id === 'review')
    const original = structuredClone(state)
    original.employees.find(item => item.id === recipient.id).skillIds = ['skill-' + read]
    assert.throws(() => project(original, rootWork, item, recipient.id), { code: 'FORBIDDEN', message: '交接事实连接授权已撤销' })
    const dependencies = project(state, rootWork, item, recipient.id)
    assert.equal(dependencies.length, 1); assert.equal(dependencies[0].resultId, result.id)
    assert.equal(dependencies[0].fact.kind, 'kivo.tpm.device-correlation'); assert.deepEqual(dependencies[0].knowledgeRefs, [knowledgeRef])
    assert.deepEqual(dependencies[0].connection, connectionSnapshot(binding))
    for (const field of ['skillIds', 'connectionIds']) {
      const revoked = structuredClone(state), employee = revoked.employees.find(item => item.id === recipient.id)
      employee[field] = employee[field].filter(id => id !== (field === 'skillIds' ? capability.skillId : binding.id))
      assert.throws(() => project(revoked, rootWork, item, recipient.id), { code: 'FORBIDDEN', message: '交接事实连接授权已撤销' }, 'revoked recipient ' + field)
    }
  }
  {
    const options = { ...argumentsFor(runtimeArgs), candidateSha256: 'd'.repeat(64) }
    const fixtures = ['a', 'b'].map((instance, index) => ({ instance, runId: 'p7-producer', candidate: 'e'.repeat(64), connection: { baseUrl: `http://127.0.0.1:${34681 + index}/api/v1/mes/mcp`, clientId: String(index) }, facts: { deviceId: 'device-' + instance } }))
    const candidate = { p6Runtime: { root: '/synthetic/runtime', files: ['operator.mjs', 'repair-create-observer.mjs', 'selfcheck-operator.mjs'].map(path => ({ path, sha256: 'f'.repeat(64) })) } }
    const config = { schemaVersion: 1, runId: options['run-id'], producerRunId: fixtures[0].runId, candidate: options.candidateSha256, candidatePath: options.candidate,
      baseCandidate: fixtures[0].candidate, setupOutput: dirname(options['fixture-a']), controlDirectory: join(dirname(options['fixture-a']), 'private', 'create-observer-' + options['run-id']),
      guardSha256: options['guard-sha256'], instances: fixtures.map(fixture => ({ instance: fixture.instance, resource: fixture.connection.baseUrl, clientId: fixture.connection.clientId, deviceId: fixture.facts.deviceId })) }
    const input = value => ({ value, sha256: options['observer-config-sha'] })
    assert.equal(validateP7Observer(candidate, input(config), options, fixtures), candidate.p6Runtime)
    for (const controlDirectory of [join(config.setupOutput, 'private/create-observer'), join(config.setupOutput, 'private/create-observer-other'), '/other/private/create-observer-' + options['run-id']]) assert.throws(() => validateP7Observer(candidate, input({ ...config, controlDirectory }), options, fixtures))
    assert.throws(() => validateP7Observer(candidate, input({ ...config, runId: 'other-main' }), options, fixtures))
    for (const runId of ['', '../escape', '/absolute', 'a'.repeat(129)]) assert.throws(() => validateP7Observer(candidate, input({ ...config, runId, controlDirectory: join(config.setupOutput, 'private', 'create-observer-' + runId) }), { ...options, 'run-id': runId }, fixtures))
  }
  assert.equal(stepsRequired.length, 10); assert.equal(new Set(stepsRequired).size, 10)
  const safe = model => ({ kind: 'fetch', host: 'zenmux.ai', model, role: 'sdk', permitted: true, maxTokens: 4096, maxTokensValid: true, maxTokensField: 'max_tokens', toolNames: ['geneway_kivo_tpm_correlate_device'] })
  assert.equal(validateP7ModelAudit(models.map(safe)).requests, 2)
  for (const change of [{ model: 'unapproved' }, { maxTokens: 8192 }, { maxTokensValid: false }, { permitted: false }, { toolNames: ['geneway_kivo_tpm_repair_create'] }, { credentialInPayload: true }]) assert.throws(() => validateP7ModelAudit([{ ...safe(models[0]), ...change }, safe(models[1])]))
  assert.throws(() => validateP7ModelAudit([safe(models[0])]))
  const polls = { failures: [], calls: [1, 2, 3].map(heldMs => ({ botId: 'a', endpoint: '/ilink/bot/getupdates', completed: true, heldMs })), maxActivePolls: () => 1 }
  assert.equal(validateP7Polls(polls, ['a'], { minFullCycles: 3 }).length, 1)
  assert.throws(() => validateP7Polls({ ...polls, maxActivePolls: () => 2 }, ['a'], { minFullCycles: 3 }))
  assert.throws(() => validateP7Polls({ ...polls, calls: polls.calls.slice(1) }, ['a'], { minFullCycles: 3 }))
  for (const value of [{ accessToken: 'synthetic' }, { note: 'Bearer synthetic' }, { privateKey: 'not-a-key' }]) assert.throws(() => noSecrets(value))
  console.log('P7 J10 harness checks passed (same-object records, retry HTTP/readback, actual protocol failure classification, disabled-route refusal and unchanged business facts, argument guard, actual handoff permissions and revocation, main-run observer directory, dual actual-model audit, poll cycles and secret rejection; native/browser/Kivo/model/network/state-file writes=0)')
}

async function callerChecks(harness) {
  const [{ normalizeTpmObservation }, { createChannelService }, weixinApi, { repairTargetFromCorrelation }, { parseCapabilityToolResult }, { connection, correlationFixture, now }, { createWorkService, authorizeWorkBinding }] = await Promise.all([
    import('../src/domain/tpm.mjs'), import('../src/channel-service.mjs'), import('../vendor/dsh-im/weixin/weixin-api.mjs'), import('../src/domain/kivo-repair.mjs'), import('../src/capabilities.mjs'), import('./fixtures/kivo-device-correlation.mjs'), import('../src/work-service.mjs'),
  ])
  const samples = ['a', 'b'].map((owner, index) => {
    const recordId = '00000000-0000-4000-8000-00000000010' + index, deviceId = '00000000-0000-4000-8000-00000000020' + index, reference = 'P7-PURE-' + owner
    const fixture = { connection: { ...connection, id: 'pure-' + owner, sourceInstance: 'pure-' + owner }, facts: { record: { recordId, reference }, deviceId } }
    const response = (path, value) => ({ status: 'ok', source: { system: 'kivo', path, queriedAt: now, traceId: 'pure-' + owner }, value })
    const input = { recordType: 'repair', reference }
    const payload = normalizeTpmObservation({ mode: 'record', input, connection: fixture.connection,
      result: response('/api/v1/mes/tpm/repairs/' + reference, { id: recordId, orderNo: reference, deviceId, status: 'reported' }),
      deviceResult: response('/api/v1/mes/equipment/ledger/devices/' + deviceId, { id: deviceId, lifecycleStatus: 'active' }) })
    const result = { ...parseCapabilityToolResult(read, { ok: true, observation: payload }, input), id: 'pure-' + owner + '-observation' }
    return { owner, fixture, work: { status: 'completed', ownerMemberId: owner, capabilityId: read, skillId: 'skill-' + read, connectionId: fixture.connection.id, input, results: [result] } }
  })
  for (const { owner, fixture, work } of samples) assert.equal(validateP7EventObservation(work, fixture, owner).id, work.results[0].id)
  assert.throws(() => validateP7EventObservation(samples[1].work, samples[0].fixture, 'a'))
  const sample = samples[0], changes = [
    work => { work.status = 'failed' }, work => { work.ownerMemberId = 'b' }, work => { work.capabilityId = correlation }, work => { work.skillId = 'skill-' + correlation },
    work => { work.connectionId = 'other' }, work => { work.input.reference = 'other' }, work => { work.input.recordType = 'maintenance' },
    work => { work.results[0].kind = 'kivo.tpm.device-correlation' }, work => { work.results[0].payload.status = 'scope_empty' },
    work => { work.results[0].payload.mode = 'list' }, work => { work.results[0].payload.recordType = 'maintenance' },
    work => { work.results[0].payload.records = [] }, work => { work.results[0].payload.records.push(structuredClone(work.results[0].payload.records[0])) },
    work => { work.results[0].payload.records[0].id = samples[1].fixture.facts.record.recordId }, work => { work.results[0].payload.records[0].reference = 'other' },
    work => { work.results[0].payload.records[0].deviceId = samples[1].fixture.facts.deviceId }, work => { work.results[0].payload.linkedDevice.id = samples[1].fixture.facts.deviceId },
    ...['tpm', 'record'].map(key => work => { work.results[0].payload = { [key]: { id: sample.fixture.facts.record.recordId } } }),
    ...['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId'].flatMap(key => [
      work => { work.results[0].payload.source[key] = 'other' }, work => { work.results[0].source[key] = 'other' },
    ]),
  ]
  for (const change of changes) { const wrong = structuredClone(sample.work); change(wrong); assert.throws(() => validateP7EventObservation(wrong, sample.fixture, sample.owner)) }
  const latest = structuredClone(sample.work)
  latest.results.push({ ...structuredClone(latest.results[0]), id: 'latest-observation' })
  assert.equal(validateP7EventObservation(latest, sample.fixture, sample.owner).id, 'latest-observation')
  latest.results.at(-1).payload.records[0].id = samples[1].fixture.facts.record.recordId
  assert.throws(() => validateP7EventObservation(latest, sample.fixture, sample.owner), 'an old correct observation cannot hide the latest wrong observation')

  const plugin = await readFile(join(root, 'plugins/weixin.mjs'), 'utf8'), sendStart = plugin.indexOf('  async function send(input) {'), sendEnd = plugin.indexOf('\n  return {', sendStart)
  const codeStart = plugin.indexOf('function protocolCode(error) {'), codeEnd = plugin.indexOf('\nfunction runtimeError(', codeStart)
  const runtimeError = plugin.split('\n').find(line => line.startsWith('function runtimeError('))
  assert(sendStart >= 0 && sendEnd > sendStart && codeStart >= 0 && codeEnd > codeStart && runtimeError)
  // Exercise the unchanged send body without starting its polling/OS-lock lifecycle.
  const sendFactory = new Function('deps', 'const { account, secrets, api, beforeSend, recordSendProgress, splitWeixinText, officialId, WeixinApiError, sha256, attest } = deps;\n' +
    'const closed = false, available = true, controller = new AbortController(), maxMessageChars = 1800;\n' + runtimeError + '\n' + plugin.slice(codeStart, codeEnd) + '\n' + plugin.slice(sendStart, sendEnd) + '\nreturn send')
  let configuredReply
  const queueLine = harness.split('\n').find(line => line.trim().startsWith('simulator.queueSend(weixinAccount.id, '))
  assert(queueLine)
  new Function('simulator', 'weixinAccount', queueLine)({ queueSend(id, value) { assert.equal(id, 'pure-bot'); configuredReply = value } }, { id: 'pure-bot' })
  assert.deepEqual(configuredReply, { httpStatus: 200, body: { ret: 403 } })
  const correlationPayload = correlationFixture(), correlated = { ...parseCapabilityToolResult(correlation, { ok: true, observation: correlationPayload }, correlationPayload.input), id: 'pure-result' }
  const target = repairTargetFromCorrelation(correlated.payload), action = { id: 'pure-action', intent: { kind: 'kivo.tpm.repair.create' }, preview: { digest: 'd'.repeat(64), resultId: correlated.id, target,
    payload: { orderNo: 'GW-P7-PURE', deviceId: target.deviceId, reason: '纯回归', description: '不执行业务写入' } } }
  action.receipt = { previewDigest: action.preview.digest, upstreamRecordId: '00000000-0000-4000-8000-000000000999', recordedAt: now, orderNo: action.preview.payload.orderNo, deviceId: target.deviceId,
    status: 'reported', creation: { actorKind: 'machine', machineAccountId: target.clientId, traceId: action.id, revision: '1' }, currentRevision: '1', replayed: false, queriedAt: now }
  const initial = { id: 'pure-delivery', workId: 'pure-work', resultId: correlated.id, actionId: action.id, channelAppId: 'pure-app', targetIdentityId: 'pure-identity', targetConversationId: 'pure-endpoint',
    contentKey: 'action.receipt', contentScope: 'result', status: 'pending', attempts: 0, createdAt: now, updatedAt: now }
  let memory = { members: [{ id: 'a', enabled: true, employeeIds: ['pure-agent'] }],
    employees: [{ id: 'pure-agent', enabled: true, modelRouteId: 'pure-route', skillIds: ['skill-' + correlation], connectionIds: [connection.id] }],
    modelRoutes: [{ id: 'pure-route', provider: 'zenmux', model: models[0], credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    skills: [{ id: 'skill-' + correlation, capabilityId: correlation, enabled: true }], connections: [connection], knowledgeMaterials: [], automationRules: [], automationOccurrences: [],
    works: [{ id: initial.workId, ownerMemberId: 'a', employeeId: 'pure-agent', skillId: 'skill-' + correlation, capabilityId: correlation, connectionId: connection.id, conversationId: 'pure-conversation', status: 'completed', input: correlationPayload.input, results: [correlated], actions: [action] }],
    conversations: [{ id: 'pure-conversation', ownerMemberId: 'a', employeeId: 'pure-agent', channelIdentityId: initial.targetIdentityId }],
    channelApps: [{ id: initial.channelAppId, provider: 'weixin', enabled: true, status: 'active', revision: 1, allowedScopes: ['result'] }],
    channelIdentities: [{ id: initial.targetIdentityId, channelAppId: initial.channelAppId, memberId: 'a', status: 'active', revision: 1, weixin: { runtimeState: 'connected' } }],
    channelConversations: [{ id: initial.targetConversationId, channelAppId: initial.channelAppId, identityId: initial.targetIdentityId, memberId: 'a', type: 'private', providerConversationId: 'pure-owner', status: 'active', revision: 1, allowedScopes: ['result'] }], deliveries: [structuredClone(initial)] }
  const channel = createChannelService({ store: { async read() { return structuredClone(memory) }, async update(mutate) { memory = mutate(structuredClone(memory)) } }, clock: () => now, connectionCatalog: [connection],
    workService: { async getWork() { return { ok: true, value: structuredClone(memory.works[0]) } } } })
  const calls = [], originalFetch = globalThis.fetch
  let reply = { httpStatus: 503, body: { ret: -1 } }
  globalThis.fetch = async url => { assert.equal(new URL(url).href, 'http://127.0.0.1:1/ilink/bot/sendmessage'); calls.push({ endpoint: '/ilink/bot/sendmessage' }); return new Response(JSON.stringify(reply.body), { status: reply.httpStatus }) }
  try {
    const send = sendFactory({ account: { baseUrl: 'http://127.0.0.1:1/', ownerUserId: 'pure-owner', tokenRef: 'pure-token', contextRef: 'pure-context' }, secrets: { async read(ref) { assert(['pure-token', 'pure-context'].includes(ref)); return ref === 'pure-token' ? 'controlled-token' : { token: 'controlled-context' } } },
      api: weixinApi.createWeixinApi({ testMode: true, testBaseUrl: 'http://127.0.0.1:1/' }), ...weixinApi, sha256: hash, attest: async () => assert.fail('no stale-token response in this check'),
      beforeSend: async input => { await channel.validateSendClaim(input); return true }, recordSendProgress: input => channel.recordSendProgress(input) })
    const dispatch = async retry => {
      await channel.authorizeDelivery({ deliveryId: initial.id, retry })
      const envelope = await channel.validateSendClaim({ deliveryId: initial.id })
      await send({ deliveryId: initial.id, attemptId: envelope.uuid, text: envelope.text, acknowledgedParts: envelope.acknowledgedParts, previousStatus: retry ? 'failed' : 'pending' })
      return structuredClone(memory.deliveries[0])
    }
    // The real adapter and send body classify HTTP 503 as unknown, never retryable failed.
    const unknown = await dispatch(false)
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error.code, 'WEIXIN_HTTP_ERROR')
    const unknownCount = calls.length
    await assert.rejects(channel.retryDelivery({ deliveryId: initial.id }), { code: 'INVALID_STATE' })
    assert.equal(calls.length, unknownCount); assert.equal(memory.deliveries[0].status, 'unknown')
    memory.deliveries = [structuredClone(initial)]; reply = configuredReply
    const failed = await dispatch(false)
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'WEIXIN_SEND_REJECTED')
    const before = calls.length
    memory.members[0].employeeIds = []
    const request = async (actor, path, method, body) => {
      assert.equal(actor, 'a'); assert.equal(path, '/api/channels/deliveries/' + initial.id + '/retry'); assert.equal(method, 'POST'); assert.deepEqual(body, {})
      try { return { status: 200, body: await dispatch(true) } } catch (error) { assert.equal(error.code, 'DELIVERY_FORBIDDEN'); return { status: 403, body: { error: { code: error.code } } } }
    }
    const blocked = await verifyP7RevokedRetry({ request, state: async () => memory, simulator: { calls }, delivery: failed, sendCount: before })
    const response = { status: 403, body: { error: { code: 'DELIVERY_FORBIDDEN' } } }, base = { request: async () => response, state: async () => ({ deliveries: [blocked] }), simulator: { calls }, delivery: failed, sendCount: before }
    for (const wrong of [{ status: 200, body: response.body }, { status: 403, body: { error: { code: 'FORBIDDEN' } } }, { status: 403, body: null }]) await assert.rejects(verifyP7RevokedRetry({ ...base, request: async () => wrong }))
    for (const key of ['id', 'workId', 'resultId', 'actionId', 'targetIdentityId', 'targetConversationId', 'status']) await assert.rejects(verifyP7RevokedRetry({ ...base, state: async () => ({ deliveries: [{ ...blocked, [key]: 'wrong' }] }) }))
    await assert.rejects(verifyP7RevokedRetry({ ...base, state: async () => ({ deliveries: [] }) }))
    await assert.rejects(verifyP7RevokedRetry({ ...base, state: async () => ({ deliveries: [{ ...blocked, error: { code: 'FORBIDDEN' } }] }) }))
    await assert.rejects(verifyP7RevokedRetry({ ...base, simulator: { calls: [...calls, { endpoint: '/ilink/bot/sendmessage' }] } }))
    memory.members[0].employeeIds = ['pure-agent']; reply = { httpStatus: 200, body: { ret: 0 } }
    const apiLine = harness.split('\n').find(line => line.trim().startsWith('async function api(actor, path,'))
    assert(apiLine)
    const api = new Function('request', 'assert', apiLine + '\nreturn api')(request, assert)
    const delivered = await api('a', '/api/channels/deliveries/' + initial.id + '/retry', 'POST', {})
    assert.equal(delivered.status, 'delivered'); assert.equal(calls.length, before + 1)
    for (const key of ['id', 'workId', 'resultId', 'actionId', 'targetIdentityId', 'targetConversationId']) assert.equal(delivered[key], initial[key])
    assert.deepEqual(memory.works[0].actions, [action], 'delivery retries do not create or rewrite the business action')
  } finally { globalThis.fetch = originalFetch }
  {
    const binding = { ...connection, skillIds: ['skill-' + read] }, actor = { id: 'a' }
    const body = { employeeId: 'p7-agent-a', skillId: 'skill-' + read, connectionId: binding.id, goal: 'P7 pure disabled route',
      input: { recordType: 'repair', reference: 'P7-PURE-A' }, clientRequestId: 'pure-disabled-route' }
    let memory = { members: [{ id: actor.id, enabled: true, employeeIds: [body.employeeId] }],
      employees: [{ id: body.employeeId, enabled: true, modelRouteId: 'p7-deepseek', skillIds: [body.skillId], connectionIds: [binding.id] }],
      modelRoutes: models.map((model, index) => ({ id: index ? 'p7-glm' : 'p7-deepseek', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', enabled: index === 1 })),
      skills: [{ id: body.skillId, capabilityId: read, enabled: true }], connections: [binding], works: [], reservations: {}, conversations: [] }
    let runnerCalls = 0
    const store = { async read() { return structuredClone(memory) }, async update(mutate) { memory = mutate(structuredClone(memory)) } }
    const service = createWorkService({ store, clock: () => now, connectionCatalog: [binding], runner: { configured: true, async run() { runnerCalls++; assert.fail('disabled route reached runner') } } })
    await service.ensureReady()
    const before = await store.read(), enabled = structuredClone(before)
    enabled.modelRoutes[0].enabled = true
    const allowed = authorizeWorkBinding(enabled, actor, { ...body, ownerMemberId: actor.id, capabilityId: read }, [binding])
    assert.deepEqual(allowed.input, body.input); assert.equal(allowed.binding.route.model, models[0])
    assert.equal(before.modelRoutes[0].enabled, false); assert.equal(before.modelRoutes[1].enabled, true)
    const result = await service.createWork(actor, body), after = await store.read()
    const response = { status: result.error?.status ?? 200, body: result.ok ? result.value : { error: result.error } }
    assert.deepEqual(after, before); assert.equal(runnerCalls, 0)
    const check = { response, before, after, modelRequestsBefore: 0, modelRequestsAfter: 0 }
    validateP7DisabledRoute(check)
    for (const wrong of [{ status: 403, body: { error: { code: 'MODEL_NOT_CONFIGURED' } } }, { status: 503, body: response.body }, { status: 200, body: response.body },
      ...[400, 401, 404, 409].map(status => ({ status, body: response.body }))]) assert.throws(() => validateP7DisabledRoute({ ...check, response: wrong }))
    assert.throws(() => validateP7DisabledRoute({ ...check, after: { ...after, works: [{ id: 'unexpected-work', executions: [{ id: 'unexpected-execution' }] }] } }))
    assert.throws(() => validateP7DisabledRoute({ ...check, after: { ...after, reservations: { unexpected: { workId: 'unexpected-work' } } } }))
    assert.throws(() => validateP7DisabledRoute({ ...check, modelRequestsAfter: 1 }))
    console.log(JSON.stringify({ check: 'disabled-route-caller', status: response.status, code: response.body.error.code, enabledCopyAuthorized: true, wholeMemoryStateUnchanged: true, runnerCalls }))
  }
  console.log(JSON.stringify({ check: 'j10-caller-contracts', normalizedOwners: 2, observationNegatives: changes.length + 2, sendReplies: ['503:unknown', '200/ret403:failed', 'revoked:blocked/403', 'restored:delivered'], networkCalls: 0, stateFileWrites: 0 }))
}
