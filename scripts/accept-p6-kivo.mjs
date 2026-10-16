import assert from 'node:assert/strict'
import { appendFileSync, closeSync, constants, createReadStream, openSync, writeFileSync } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording } from './accept-p4-s1.mjs'
import { assertTpmDeviceCorrelation } from '../src/domain/tpm-device-correlation.mjs'
import { assertRepairReceipt, isRepairCreationEcho } from '../src/domain/kivo-repair.mjs'
import { CYCLE_TIME_TOOL } from '../src/capabilities.mjs'
import { migrateState } from '../src/store/file-store.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), script = fileURLToPath(import.meta.url)
const origin = 'http://127.0.0.1:34481', model = 'deepseek/deepseek-v4.1-flash'
const cap = 'kivo-tpm-device-correlate', skill = 'skill-' + cap, readSkill = 'skill-kivo-tpm-record-read'
const fields = ['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
const app = { id: 'p6-feishu', providerAppId: 'cli_aaaaaaaaaaaaaaaa', providerTenantId: 'synthetic-p6' }
export const P6_STEPS = Object.freeze(['configuration', 'two-instance-correlation', 'preview-without-write', 'owner-isolation', 'owner-approval', 'producer-zero-rule-echo', 'higher-revision', 'lost-webhook', 'simulated-channel', 'revocation', 'unknown-readback', 'normal-restart', 'backup-restore'])
const stepTitles = {
  configuration: '核对来源与连接', 'two-instance-correlation': '分别核对 A/B 实例的设备关联', 'preview-without-write': '手机编辑预览与拒绝',
  'owner-isolation': '本人正文与批准权限隔离', 'owner-approval': '本人批准、真实创建与回读', 'producer-zero-rule-echo': '真实创建事件与零规则回声',
  'higher-revision': '后续高版本正常跟进', 'lost-webhook': '缺失事件时按原单号回读', 'simulated-channel': '模拟飞书与微信只读交办',
  revocation: '撤权阻止派发', 'unknown-readback': '创建结果未知，不重试', 'normal-restart': '普通重启保留未决动作', 'backup-restore': '新目录恢复后手机只读核对',
}
const modelTools = new Set([CYCLE_TIME_TOOL, 'geneway_kivo_tpm_correlate_device', 'geneway_kivo_tpm_read_record', 'geneway_kivo_tpm_list_records', 'structured_output', 'geneway_work_create', 'geneway_work_continue', 'geneway_work_follow_up', 'geneway_work_status', 'geneway_work_stop'])
const observerFiles = ['operator.mjs', 'repair-create-observer.mjs', 'selfcheck-operator.mjs']

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
    'secret-root': { type: 'string' }, 'model-ref': { type: 'string' }, 'expected-head': { type: 'string' }, 'network-guard': { type: 'string' }, 'guard-sha256': { type: 'string' },
    'observer-config': { type: 'string' }, 'observer-config-sha': { type: 'string' }, 'run-id': { type: 'string' }, display: { type: 'string' },
  } })
  if (!args.length) return { help: true }
  assert.equal([values.help, values['harness-check'], values.run].filter(Boolean).length, 1)
  if (!values.run) { assert(Object.keys(values).every(key => ['help', 'harness-check'].includes(key)), 'runtime arguments require --run'); return values }
  for (const key of ['output', 'fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'secret-root', 'network-guard', 'observer-config']) {
    assert(isAbsolute(values[key] ?? ''), 'explicit absolute --' + key + ' required')
    values[key] = resolve(values[key]); assert(!within(root, values[key]), key + ' must be outside the repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? '')); assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''))
  assert(/^[a-f0-9]{64}$/.test(values['observer-config-sha'] ?? ''))
  assert.equal(values['model-ref'], 'ZENMUX_API_KEY'); assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values['run-id'] ?? ''))
  if (values.display) assert(/^:\d+$/.test(values.display))
  return values
}
function usage() {
  return 'P6 Kivo 关联与维修创建验收；渠道为模拟验收。准备不等于运行授权。\n' +
    '纯检查：node scripts/accept-p6-kivo.mjs --harness-check\n' +
    '仅在 controller 对绑定候选另行 GO 后：--run --output <新0700目录> --fixture-a <fixture-a.json> --fixture-b <fixture-b.json> --api-state-a <当前final启动journal> --api-state-b <当前final启动journal> --catalog <catalog.json> --candidate <组合清单> --expected-head <HEAD> --secret-root <隔离秘密目录> --model-ref ZENMUX_API_KEY --network-guard <已审P6副本> --guard-sha256 <SHA> --observer-config <独立0600公开配置> --observer-config-sha <rawSHA> --run-id <唯一ID> [--display :N]\n' +
    '固定A/B 34581/34582、Geneway 34481。无skip；实际创建至多3次，各自owner批准。真实producer/worker、故障与数据库回读由受控operator回执门完成，不能用手写event替代。同轮录制p6-kivo.mp4、13步时间线与截图；默认自有隔离Xvfb，--display仅用于launcher已持有的隔离display。Kivo事务交错与离线交付由controller统筹；本脚本不启动Kivo/worker、不变更依赖。'
}

export function validateP6Fixtures(a, b, catalog) {
  noSecrets({ a, b, catalog })
  assert.equal(catalog.version, 1); assert(Array.isArray(catalog.targets))
  for (const [index, fixture] of [a, b].entries()) {
    const instance = ['a', 'b'][index], c = fixture.connection, f = fixture.facts, source = fixture.eventSource
    assert.equal(fixture.instance, instance); assert.equal(fixture.phase, 'fixture-ready'); assert.equal(fixture.dataMode, 'synthetic'); assert.equal(fixture.sourceEnvironment, 'external-test')
    assert(/^[a-f0-9]{64}$/.test(fixture.candidate)); assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fixture.runId))
    assert.equal(c.id, 'kivo-p6-' + instance); assert.equal(c.kind, 'kivo-mcp'); assert.equal(c.baseUrl, `http://127.0.0.1:${34581 + index}/api/v1/mes/mcp`)
    assert.equal(c.issuer, new URL(c.baseUrl).origin); assert.equal(c.sourceInstance, fixture.runId + '-' + instance)
    assert.equal(c.sourceSystem, 'KivoMES'); assert.equal(c.sourceEnvironment, 'external-test'); assert.equal(c.dataMode, 'synthetic'); assert.equal(c.evidenceMode, 'actual-mcp'); assert.deepEqual(c.allowedObjectIds, [])
    assert.equal(c.credentialRef, 'MCP_PRIVATE_' + instance.toUpperCase()); uuid(c.clientId); uuid(f.deviceId); uuid(f.organizationId); uuid(f.endpointId); uuid(f.hiveBindingId)
    assert.equal(f.clientId, c.clientId); assert.equal(f.record.recordType, 'repair'); uuid(f.record.recordId); assert.equal(String(f.record.currentRevision), '0'); assert(f.record.reference)
    assert(catalog.targets.some(target => fields.every(key => target[key] === c[key])), 'runtime connection differs from trusted catalogue')
    assert.equal(source.id, c.id); assert.equal(source.connectionId, c.id); assert.equal(source.resource, c.baseUrl); assert.equal(source.sourceInstance, c.sourceInstance); assert.equal(source.enabled, true)
    assert.equal(source.signingSecretRef, 'WEBHOOK_' + instance.toUpperCase()); assert(source.subscriptionIds.length); source.subscriptionIds.forEach(uuid)
    assert.deepEqual([...source.subscriptionIds].sort(), [...f.subscriptionIds].sort())
  }
  assert.equal(a.runId, b.runId); assert.equal(a.candidate, b.candidate); assert.equal(a.facts.record.reference, b.facts.record.reference)
  for (const key of ['deviceId', 'clientId']) assert.notEqual(a.facts[key], b.facts[key])
  assert.notEqual(a.facts.record.recordId, b.facts.record.recordId)
  return [a, b]
}

function finalRuntime(candidate) {
  const runtime = candidate.kivo?.runtime
  assert(isAbsolute(candidate.kivo?.root ?? '')); assert.equal(runtime?.variant, 'final')
  assert.equal(runtime.root, join(candidate.kivo.root, '.git/kivo-event-runtime/p6-isolated-build/worker-completion/trees/final'))
  return runtime
}

export function validateP6ApiState(journal, fixture, expected) {
  noSecrets(journal)
  assert.equal(journal.phase, 'ready'); assert(!Object.hasOwn(journal, 'exit'))
  assert.equal(journal.instance, fixture.instance); assert.equal(journal.runId, fixture.runId); assert.equal(journal.runId, expected.runId)
  assert.equal(journal.baseCandidate, fixture.candidate); assert.equal(journal.candidate, expected.candidate)
  assert.equal(journal.candidatePath, expected.candidatePath); assert.equal(journal.runtimeVariant, 'final'); assert.equal(journal.runtimeRoot, expected.runtimeRoot)
  assert(/^[A-Za-z0-9][A-Za-z0-9-]{0,95}$/.test(journal.launchId))
  assert.equal(dirname(expected.apiStatePath), dirname(expected.fixturePath))
  assert.equal(basename(expected.apiStatePath), 'api-' + fixture.instance + '-' + journal.launchId + '.json')
  const identity = journal.process
  assert(identity && Number.isSafeInteger(identity.pid) && identity.pid > 1 && /^[1-9][0-9]*$/.test(identity.startTicks))
  assert.deepEqual(Object.keys(identity).sort(), ['cwd', 'executable', 'pid', 'startTicks'])
  assert.equal(identity.cwd, expected.runtimeRoot); assert.equal(identity.executable, expected.executable)
  assert.deepEqual(expected.process, identity, 'current API process identity differs from its launch journal')
  const rows = expected.listener.trim().split('\n').filter(Boolean), port = new URL(fixture.connection.baseUrl).port
  assert.equal(rows.length, 1, 'one current owned API listener required')
  assert.equal(rows[0].trim().split(/\s+/)[3], '127.0.0.1:' + port, 'API is not bound to its isolated loopback port')
  assert.deepEqual([...new Set([...rows[0].matchAll(/\bpid=(\d+),/g)].map(match => Number(match[1])))], [identity.pid], 'API listener is not owned by the journal process')
  return { instance: fixture.instance, launchId: journal.launchId, baseCandidate: journal.baseCandidate, candidate: journal.candidate,
    runtimeRoot: journal.runtimeRoot, runtimeVariant: journal.runtimeVariant, process: identity, origin: new URL(fixture.connection.baseUrl).origin }
}

async function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1)
  const [stat, executable, cwd] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/cwd`)])
  return { pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executable, cwd }
}

async function verifyApis(options, inputs, fixtures) {
  const runtime = finalRuntime(inputs.candidate.value), executable = await readlink('/proc/self/exe')
  assert.equal(await realpath(runtime.root), runtime.root, 'isolated runtime root aliases are forbidden')
  return Promise.all(fixtures.map(async fixture => {
    const key = 'api-state-' + fixture.instance, journal = inputs[key], identity = await processIdentity(journal.value.process?.pid)
    const listener = await command('ss', ['-ltnpH', 'sport = :' + new URL(fixture.connection.baseUrl).port])
    const value = validateP6ApiState(journal.value, fixture, { runId: fixture.runId, candidate: inputs.candidate.sha256, candidatePath: options.candidate,
      runtimeRoot: runtime.root, apiStatePath: options[key], fixturePath: options['fixture-' + fixture.instance], executable, process: identity, listener })
    assert.deepEqual(await processIdentity(identity.pid), identity, 'API identity changed while checking its listener')
    assert.equal((await privateJson(options[key])).sha256, journal.sha256, 'API launch journal changed during preflight')
    return { ...value, journalSha256: journal.sha256 }
  }))
}

export function validateP6Observer(candidate, input, options, fixtures) {
  const config = input.value
  assert.equal(input.sha256, options['observer-config-sha'])
  noSecrets(config)
  const runtime = candidate.p6Runtime, directory = resolve(dirname(options['network-guard']), '../p6-kivo-runtime'), setup = dirname(options['fixture-a'])
  assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime)); assert.deepEqual(Object.keys(runtime).sort(), ['files', 'root'])
  assert.equal(runtime.root, directory); assert(!within(root, directory)); assert(Array.isArray(runtime.files))
  assert.deepEqual(runtime.files.map(item => item.path).sort(), [...observerFiles].sort())
  for (const file of runtime.files) { assert.deepEqual(Object.keys(file).sort(), ['path', 'sha256']); assert(/^[a-f0-9]{64}$/.test(file.sha256)) }
  assert(['', '-' + options['run-id']].some(suffix => fixtures.every((fixture, index) =>
    options['fixture-' + fixture.instance] === join(setup, 'fixture-' + ['a', 'b'][index] + suffix + '.json'))), 'both fixture paths must use the same fixed or current-run naming pattern')
  for (const id of [options['run-id'], fixtures[0].runId]) assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
  assert.deepEqual(config, { schemaVersion: 1, runId: options['run-id'], producerRunId: fixtures[0].runId, candidate: options.candidateSha256,
    candidatePath: options.candidate, baseCandidate: fixtures[0].candidate, setupOutput: setup, controlDirectory: join(setup, 'private/create-observer'),
    guardSha256: options['guard-sha256'], instances: fixtures.map(fixture => ({ instance: fixture.instance, resource: fixture.connection.baseUrl, clientId: fixture.connection.clientId, deviceId: fixture.facts.deviceId })) })
  return runtime
}

function observerEnvironment(options, runtime) {
  return Object.freeze({ NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href + ' --import=' + pathToFileURL(join(runtime.root, 'repair-create-observer.mjs')).href,
    GENEWAY_P6_CREATE_OBSERVER_CONFIG: options['observer-config'], GENEWAY_P6_CREATE_OBSERVER_CONFIG_SHA256: options['observer-config-sha'] })
}

async function verifyObserver(options, inputs, fixtures) {
  const runtime = validateP6Observer(inputs.candidate.value, inputs['observer-config'], { ...options, candidateSha256: inputs.candidate.sha256 }, fixtures)
  assert.equal(await realpath(runtime.root), runtime.root, 'observer directory aliases are forbidden')
  for (const file of runtime.files) {
    const path = join(runtime.root, file.path), stat = await lstat(path)
    assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(hash(await readFile(path)), file.sha256, 'observer candidate mismatch ' + file.path)
  }
  assert.equal((await privateJson(options['observer-config'])).sha256, inputs['observer-config'].sha256, 'observer config changed')
  return { root: runtime.root, files: runtime.files, config: options['observer-config'], configSha256: inputs['observer-config'].sha256,
    controlDirectory: inputs['observer-config'].value.controlDirectory }
}

export function validateP6ModelAudit(rows) {
  const models = rows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai')
  assert(models.length, 'actual Flash requests are required')
  for (const row of models) {
    assert.equal(row.model, model); assert.equal(row.permitted, true); assert(!row.sessionLogAttached && !row.credentialInPayload && !row.unexpectedBodyFields)
    assert(Array.isArray(row.toolNames)); assert(row.toolNames.every(name => modelTools.has(name)), 'unknown, retired or write tool reached the model')
  }
  assert(models.some(row => row.role === 'sdk' && row.toolNames.includes('geneway_kivo_tpm_correlate_device')), 'native correlation tool was not offered')
  return { requests: models.length, writesOffered: 0, unknownTools: 0 }
}

export function validateP6Correlation(work, fixture) {
  assert.equal(work.status, 'completed'); assert(work.executions.some(item => item.dshSessionRef))
  const result = work.results.findLast(item => item.kind === 'kivo.tpm.device-correlation'); assert(result)
  const p = assertTpmDeviceCorrelation(result.payload, result.input)
  assert.equal(p.tpm.id, fixture.facts.record.recordId); assert.equal(p.device.id, fixture.facts.deviceId); assert.equal(p.tpm.reference, fixture.facts.record.reference)
  assert.equal(p.binding.resource, fixture.connection.baseUrl); assert.equal(p.binding.sourceInstance, fixture.connection.sourceInstance); assert.equal(p.binding.clientId, fixture.connection.clientId)
  assert.equal(p.source.sourceEnvironment, 'external-test'); assert.equal(p.source.dataMode, 'synthetic'); assert.equal(p.actionEligible, true)
  assert.equal(p.monitoring.receivedAtMeaning, 'projection'); assert.equal(p.monitoring.sourceReceivedAt, null); assert.equal(p.monitoring.sourceQuality, null)
  return result
}

export function validateP6Creation(action, fixture, record) {
  assertRepairReceipt(action.receipt, action)
  assert.equal(action.preview.target.deviceId, fixture.facts.deviceId); assert.equal(action.receipt.creation.machineAccountId, fixture.connection.clientId)
  assert.equal(action.receipt.creation.traceId, action.id); assert.equal(action.receipt.creation.revision, '0')
  assert.equal(record.id, action.receipt.upstreamRecordId); assert.equal(record.orderNo, action.preview.payload.orderNo); assert.equal(record.deviceId, action.preview.payload.deviceId)
  assert.equal(record.detail.reason, action.preview.payload.reason); assert.equal(record.detail.description, action.preview.payload.description)
  assert.deepEqual(record.creation, { actorKind: 'machine', machineAccountId: fixture.connection.clientId, traceId: action.id, revision: 0 })
  assert(Number.isSafeInteger(record.revision) && record.revision >= 0); assert.equal(String(record.revision), action.receipt.currentRevision)
}

export function validateP6Worker(receipt, fixture, eventId) {
  const release = receipt.release, identity = release?.identity
  assert.equal(release?.workerStopped, true); assert.equal(release?.ownedRecordsVerified, true)
  assert.equal(identity?.runId, fixture.runId); assert.equal(identity.superuser, false); assert.equal(identity.entry, 'apps/mes-worker/src/notifications/index.ts')
  assert.equal(identity.candidate, fixture.candidate); assert.equal(identity.instance, fixture.instance)
  assert.deepEqual([...identity.allowlist].sort(), ['mes.notification.business-event.v1', 'mes.notification.deliver.v1', 'mes.notification.evaluate.v1'])
  assert.equal(receipt.event.eventId, eventId); assert.equal(receipt.event.recordType, 'repair')
  uuid(receipt.event.outboxId)
  assert(Array.isArray(receipt.event.matchedSubscriptionIds) && receipt.event.matchedSubscriptionIds.length)
  assert.deepEqual(receipt.deliveries.map(item => item.occurrence.ruleId).sort(), [...receipt.event.matchedSubscriptionIds].sort())
  assert(release.executions.some(item => item.outboxId === receipt.event.outboxId), 'worker did not claim this business event')
  assert(release.results.length && release.results.every(item => item.failed === 0 && item.deadLettered === 0 && item.lostLease === 0))
  assertUuidRows(receipt.deliveries)
  for (const delivery of receipt.deliveries) {
    assert.equal(delivery.occurrence.episodeId, eventId); assert(fixture.eventSource.subscriptionIds.includes(delivery.occurrence.ruleId))
    assert.equal(delivery.status, 'accepted'); assert.equal(delivery.attemptCount, 1); assert.equal(delivery.attempts.length, 1)
    const attempt = delivery.attempts[0], elapsed = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
    assert(attempt.httpStatus >= 200 && attempt.httpStatus < 300); assert(elapsed >= 0 && elapsed < 10_000)
    assert(/^[a-f0-9]{64}$/.test(attempt.wireBodySha256))
  }
}

export function validateP6StatusAdvance({ event, humanOperation }) {
  assert.equal(humanOperation?.action, 'dispatch'); assert.equal(humanOperation?.auditAction, 'TpmRepairOrder.dispatch')
  assert.equal(event.action, null)
  assert(typeof event.sourceRevision === 'string' && /^[1-9][0-9]*$/.test(event.sourceRevision))
  assert.equal(event.before?.status, 'reported'); assert.equal(event.after?.status, 'dispatched')
}

export function validateP6ActionDom(view, action, status) {
  assert(view && view.visible, 'the actual action card is missing or hidden')
  assert.equal(view.id, action.id); assert.equal(view.status, status)
  assert.equal(view.fields['维修单号'], action.preview.payload.orderNo)
  if (status === 'created') {
    assert(action.receipt); assert(view.summary.includes('维修单已创建'))
    assert.equal(view.fields['上游维修 UUID'], action.receipt.upstreamRecordId)
    assert.equal(view.fields['上游回读时间'], action.receipt.queriedAt)
    assert.equal(view.fields['创建版本 / 当前版本'], action.receipt.creation.revision + ' / ' + action.receipt.currentRevision)
  } else if (status === 'unknown') {
    assert(!action.receipt && action.attempt?.unknownAt); assert(view.summary.includes('创建结果待核对'))
    assert(view.text.includes('只按原单号再次核对'))
    assert(view.reconcile?.visible && !view.reconcile.disabled, 'the owner must have an actual read-only reconcile button')
    assert(!view.approve?.visible || view.approve.disabled, 'unknown cannot offer a new approval')
  } else if (status === 'rejected') assert(view.summary.includes('已拒绝'))
}

export function validateP6CorrelationDom(view, result) {
  assert(view && view.visible); assert.equal(view.id, result.id)
  const p = result.payload, value = input => input === null || input === undefined || input === '' ? '未提供' : String(input)
  const expected = { '设备 UUID': p.device.id, 'TPM 记录 UUID / 版本': p.tpm.id + ' / ' + p.tpm.revision, '来源创建时间': p.tpm.createdAt, '来源更新时间': p.tpm.updatedAt,
    '采样时间': p.freshness.sampleAt, '采样龄（本次查询）': p.freshness.ageSeconds === null ? null : p.freshness.ageSeconds + ' 秒', '查询时间': p.queriedAt,
    '监控投影时间（非源接收时间）': p.monitoring.snapshotAt, '投影接收标记（非源接收时间）': p.monitoring.receivedAt, '来源接收时间': p.monitoring.sourceReceivedAt, '来源质量': p.monitoring.sourceQuality }
  for (const [label, expectedValue] of Object.entries(expected)) assert.equal(view.fields[label], value(expectedValue), 'typed and DOM differ at ' + label)
  assert(view.source.includes(p.source.sourceSystem) && view.source.includes(p.source.sourceInstance))
  for (const source of Object.values(p.sources)) assert(view.source.includes(source.path) && view.source.includes(source.queriedAt) && view.source.includes(source.traceId))
  const unknowns = { SOURCE_QUALITY_NOT_PROVIDED: '来源质量未提供', SOURCE_RECEIVED_AT_NOT_PROVIDED: '来源接收时间未提供', SAMPLE_MISSING: '缺少采样时间', SAMPLE_STALE: '采样已陈旧', SAMPLE_FUTURE: '采样时间超前', MONITORING_INCOMPLETE: '监控来源不完整', CONNECTION_UNKNOWN: '连接状态未知', RUNTIME_UNKNOWN: '运行状态未知', ALARM_UNKNOWN: '报警事实未知' }
  for (const code of p.unknowns) assert(view.text.includes(unknowns[code] ?? code), 'typed unknown is absent from the actual DOM')
}

function unresolvedAction(state, workId, actionId) {
  const action = state.works.find(work => work.id === workId)?.actions.find(action => action.id === actionId)
  assert(action?.attempt?.unknownAt && !action.attempt.noEffectAt && !action.receipt, 'the unresolved attempt must survive recovery without being treated as success')
  return action
}

export function validateP6ContentGeometry(layout) {
  assert(layout && Number.isFinite(layout.width) && layout.width > 0, 'active work geometry is missing')
  assert(layout.content?.visible && Array.isArray(layout.cards) && layout.cards.length, 'visible work content and cards are required')
  for (const item of [layout.content, ...layout.cards]) {
    assert(item.visible && ['left', 'right', 'clientWidth', 'scrollWidth'].every(key => Number.isFinite(item[key])))
    assert(item.clientWidth > 0 && item.scrollWidth <= item.clientWidth + 1, 'work content or card has horizontal overflow')
    assert(item.left >= -1 && item.right <= layout.width + 1 && item.right >= item.left, 'work content or card is outside the viewport')
  }
  for (const card of layout.cards) assert(card.left >= layout.content.left - 1 && card.right <= layout.content.right + 1, 'work card is clipped by its content container')
}

export function validateP6Timeline(steps) {
  assert.deepEqual(steps.map(step => [step.id, step.status]), P6_STEPS.map(id => [id, 'passed']))
  let previousEnd = 0
  for (const step of steps) {
    assert(Number.isFinite(step.startSeconds) && Number.isFinite(step.endSeconds) && step.startSeconds >= previousEnd && step.endSeconds >= step.startSeconds)
    assert(step.screenshots.length, 'each gate needs an actual same-run screenshot')
    for (const shot of step.screenshots) assert(/^step-[0-9]{2}-[0-9]{2}\.png$/.test(shot.file) && shot.seconds >= step.startSeconds && shot.seconds <= step.endSeconds)
    previousEnd = step.endSeconds
  }
  for (const id of ['preview-without-write', 'owner-approval', 'revocation', 'unknown-readback', 'backup-restore']) assert(steps.find(step => step.id === id).screenshots.some(shot => shot.viewport?.width === 390), 'mobile operations must be recorded in this journey')
}

export async function doubleClickControl(page, selector) {
  await page.front()
  await page.evaluate('document.querySelector(' + js(selector) + ').scrollIntoView({ block: "center" })')
  const box = await page.evaluate(`(() => { const node = document.querySelector(${js(selector)}), r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, width: innerWidth, height: innerHeight, visible: r.width > 0 && r.height > 0, disabled: node.disabled, hit: node.contains(document.elementFromPoint(x, y)) } })()`)
  assert(box.visible && !box.disabled && box.hit && box.x > 0 && box.x < box.width && box.y > 0 && box.y < box.height)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, button: 'left', x: box.x, y: box.y, clickCount })
}

function operatorChannel(input, binding, { timeoutMs = 300_000, signal } = {}) {
  let pending, failure
  const used = new Set(), fail = error => { failure ??= error; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined } }
  const receive = line => {
    try {
      assert(Buffer.byteLength(line) <= 128 * 1024); const value = JSON.parse(line)
      assert(pending && value.kind === 'p6-operator-result' && value.runId === binding.runId && value.candidate === binding.candidate && value.stepId === pending.id)
      assert.equal(value.ok, true); noSecrets(value.receipt)
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(value.receipt)
    } catch (error) { fail(error) }
  }
  const ended = () => fail(new Error('operator input ended'))
  const interrupted = () => fail(new Error('operator interrupted'))
  input.on('line', receive); input.on('close', ended); input.on('error', fail)
  signal?.addEventListener('abort', interrupted, { once: true })
  return {
    wait(id, operation, expected = {}) {
      assert(!pending && !used.has(id)); if (signal?.aborted) return Promise.reject(new Error('operator interrupted')); if (failure) return Promise.reject(failure); used.add(id)
      return new Promise((resolveReceipt, reject) => { pending = { id, resolve: resolveReceipt, reject, timer: setTimeout(() => fail(new Error('operator receipt timed out')), timeoutMs) }; console.error(JSON.stringify({ kind: 'p6-operator-request', ...binding, stepId: id, operation, expected })) })
    },
    dispose() { input.removeListener('line', receive); input.removeListener('close', ended); input.removeListener('error', fail); signal?.removeEventListener('abort', interrupted); if (pending) fail(new Error('operator channel disposed')) },
  }
}

async function acceptance(options) {
  const inputs = Object.fromEntries(await Promise.all(['fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'observer-config'].map(async key => [key, await privateJson(options[key])])))
  const binding = { runId: options['run-id'], candidate: inputs.candidate.sha256, guardSha256: options['guard-sha256'] }
  const fixtures = validateP6Fixtures(inputs['fixture-a'].value, inputs['fixture-b'].value, inputs.catalog.value)
  const files = validateCandidate(inputs.candidate.value), preflight = { ...await snapshot(files, options['expected-head']), apis: await verifyApis(options, inputs, fixtures), observer: await verifyObserver(options, inputs, fixtures) }
  const observerEnv = observerEnvironment(options, preflight.observer)
  assert.equal(hash(await readFile(options['network-guard'])), binding.guardSha256)
  await privateDirectory(options['secret-root'])
  for (const ref of [options['model-ref'], ...fixtures.flatMap(f => [f.connection.credentialRef, f.eventSource.signingSecretRef])]) await secretMetadata(options['secret-root'], ref)
  await mkdir(options.output, { mode: 0o700 }); await privateDirectory(options.output)
  const privateRoot = join(options.output, 'private'); await mkdir(privateRoot, { mode: 0o700 })
  const scratch = await mkdtemp(join(privateRoot, 'runtime-')), authFile = join(scratch, 'auth.json'), auditFile = join(scratch, 'network.jsonl')
  const caption = join(scratch, 'caption.txt'), video = join(options.output, 'p6-kivo.mp4')
  let stateFile = join(scratch, 'state.json'), dshHome = join(scratch, 'dsh'), secretRoot = options['secret-root'], host, simulator, failure, postflight, audit, media, recording, recordingAt, display = options.display
  const children = [], pages = {}, sessions = {}, steps = [], facts = [], refs = {}, passwords = Object.fromEntries(['admin', 'a', 'b'].map(id => [id, randomBytes(24).toString('base64url')]))
  const weixinAccount = { id: 'synthetic-p6-' + binding.runId, ownerUserId: 'synthetic-p6-owner-a', token: 'SYNTHETIC_TOKEN_' + randomBytes(24).toString('hex') }
  let weixinSequence = 0
  const abort = new AbortController(), input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }), operator = operatorChannel(input, binding, { signal: abort.signal })
  let settle
  const operationSettled = new Promise(done => { settle = done })
  const cleanup = runCleanup({ children, browsers: pages, recording: () => recording, operationSettled, removeAuth: () => rm(authFile, { force: true }), onFailure: error => { failure ??= error }, stopChild: stopOwned })
  const fail = error => { failure ??= error; abort.abort(error) }
  const interrupts = interruptHandlers(process, (signal, force) => { failure ??= new Error('interrupted'); abort.abort(signal); if (force) void cleanup.run(true) })
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  const fixture = actor => fixtures.find(f => f.instance === actor)
  const kivoRequests = async () => (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.kind === 'fetch' && row.host === '127.0.0.1' && [34581, 34582].includes(row.port) && row.path === '/api/v1/mes/mcp').length
  try {
    const [{ createFileStore }, { initializeAuthFile }, { createILinkSimulator }] = await Promise.all([import('../src/store/file-store.mjs'), import('../src/auth.mjs'), import('./fixtures/ilink-server.mjs')])
    simulator = await createILinkSimulator({ holdMs: 100 })
    simulator.addAccount(weixinAccount)
    const hostConfig = join(scratch, 'host.json'), channelRef = 'P6_' + hash(binding.runId).slice(0, 24).toUpperCase() + '_FEISHU'
    await writeFile(hostConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(secretRoot, channelRef), JSON.stringify({ appId: app.providerAppId, appSecret: 'synthetic_' + randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(scratch, 'event-sources.json'), JSON.stringify({ version: 1, sources: fixtures.map(f => f.eventSource) }), { mode: 0o600, flag: 'wx' })
    await createFileStore(stateFile).update(s => seedState(s, fixtures, options['model-ref'], channelRef))
    await initializeAuthFile(authFile, passwords)
    host = await boot(hostConfig)
    if (!display) {
      const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
      display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
    }
    await writeFile(caption, 'P6 设备关联与维修创建；渠道为模拟验收', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; await access(font)
    recording = watchRecording(launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', display + '.0', '-vf',
      'pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=' + font + ':textfile=' + caption + ':reload=1:fontcolor=white:fontsize=24:x=20:y=h-54',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] }), fail)
    recordingAt = recording.state.startedAt
    for (const actor of ['admin', 'a', 'b']) { await login(actor); pages[actor] = await browser(actor) }
    await journeys()
    assert.deepEqual(steps.map(step => [step.id, step.status]), P6_STEPS.map(id => [id, 'passed']))
  } catch (error) { fail(error) }
  finally {
    settle(); await cleanup.run()
    try { await simulator?.close() } catch (error) { failure ??= error }
    operator.dispose(); input.close()
    try {
      for (const child of children) if (child.pid) assert(gone(child.pid) && gone(-child.pid), 'owned PID/group remains')
      await assert.rejects(access(authFile), { code: 'ENOENT' })
      postflight = { ...await snapshot(files, options['expected-head']), apis: await verifyApis(options, inputs, fixtures), observer: await verifyObserver(options, inputs, fixtures) }; assert.deepEqual(postflight, preflight)
      for (const key of Object.keys(inputs)) assert.equal((await privateJson(options[key])).sha256, inputs[key].sha256)
      assert.equal(hash(await readFile(options['network-guard'])), binding.guardSha256)
      const rows = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      audit = { ...networkAudit(rows, { ...binding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid) }), modelTools: validateP6ModelAudit(rows) }
      for (const port of [34581, 34582]) assert(rows.some(row => row.kind === 'fetch' && row.host === '127.0.0.1' && row.port === port && row.path === '/api/v1/mes/mcp'))
    } catch (error) { failure ??= error }
    try {
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
      const coverage = recordingCoverage(recording.state, probe, steps)
      await command('ffmpeg', ['-v', 'error', '-xerror', '-i', video, '-f', 'null', '-'])
      if (!failure) validateP6Timeline(steps)
      const stream = probe.streams.find(item => item.codec_type === 'video'), digest = createHash('sha256')
      for await (const chunk of createReadStream(video)) digest.update(chunk)
      media = { video: 'p6-kivo.mp4', ...coverage, codec: stream.codec_name, width: stream.width, height: stream.height, sha256: digest.digest('hex'), decoded: true, recording: recording.state }
    } catch (error) { failure ??= error }
    const report = { ok: !failure, phase: 'P6', scope: 'synthetic / external-test；渠道为模拟验收', runId: binding.runId, candidate: binding.candidate, preflight, postflight, audit, media, steps, facts,
      failure: failure ? { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code ?? '') ? failure.code : 'ACCEPTANCE_FAILED', step: steps.find(s => s.status === 'failed')?.id ?? null } : null,
      cleanup: cleanup.state, boundary: '视频录制同一轮真实主链，不为录像重演创建；全安装树及Kivo事务交错矩阵由独立lane同候选提供。步骤、operator实际回读、视频完整性及网络/退出审计均须通过；纯检查不替代真实旅程。' }
    let failureEvidenceAttempted = false
    const saveFailure = async () => {
      if (!failure || failureEvidenceAttempted) return
      failureEvidenceAttempted = true
      await writeFile(join(privateRoot, 'first-failure.json'), JSON.stringify({
        name: String(failure.name ?? 'Error').slice(0, 128), code: failure.code === undefined ? null : String(failure.code).slice(0, 128),
        message: String(failure.message ?? '').slice(0, 8192), stack: String(failure.stack ?? '').slice(0, 16384),
      }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }).catch(() => { console.error('[accept:p6] private first-failure evidence was not saved') })
    }
    try {
      let savedFailure
      do {
        savedFailure = failure; report.ok = !failure
        report.failure = failure ? { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code ?? '') ? failure.code : 'ACCEPTANCE_FAILED', step: steps.find(s => s.status === 'failed')?.id ?? null } : null
        await saveFailure()
        await writeFile(join(options.output, 'observations.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      } while (savedFailure !== failure)
    } catch (error) {
      failure ??= error; report.ok = false
      report.failure = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code ?? '') ? failure.code : 'ACCEPTANCE_FAILED', step: steps.find(s => s.status === 'failed')?.id ?? null }
      await saveFailure()
    } finally { interrupts.dispose() }
    console.log(JSON.stringify({ ok: report.ok, runId: report.runId, steps: steps.map(s => ({ id: s.id, status: s.status })), failure: report.failure }))
    if (failure) process.exitCode = 1
  }

  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.once('error', error => { child.spawnError = error }); children.push(child)
    child.stderr?.on('data', bytes => child.diagnostics?.stderr(bytes))
    return child
  }
  async function boot(hostConfig, channelsExpected = true) {
    assert.deepEqual(await verifyObserver(options, inputs, fixtures), preflight.observer)
    const env = { ...systemEnvironment(), DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile,
      GENEWAY_PORT: '34481', GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'], GENEWAY_CONNECTION_CATALOG: options.catalog,
      ...observerEnv, GENEWAY_NETWORK_AUDIT_RUN_ID: binding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: binding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
      GENEWAY_CHANNEL_ACCEPT_HOST: '1', GENEWAY_CHANNEL_HOST_CONFIG: hostConfig }
    const child = launch(process.execPath, [join(root, 'scripts/accept-p4.mjs'), '--host'], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.auditRole = 'host'; child.diagnostics = diagnostics(child, privateRoot, binding, error => { failure ??= error; abort.abort(error) })
    await poll(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Host failed'); try { return (await fetch(origin)).status === 200 } catch { return false } }, 'owned P6 Host', 30_000)
    const value = await ipc(child, 'snapshot'); assert.equal(value.pid, child.pid); assert.equal(value.address.port, 34481); assert.equal(value.sdkDispatcher, channelsExpected)
    return child
  }
  async function browser(actor, profileName = actor) {
    const port = await freePort(), profile = join(scratch, 'chrome-' + profileName)
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
    const args = ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', '--app=' + origin]
    const child = launch('/usr/bin/google-chrome', args, { env: { ...systemEnvironment(), DISPLAY: display } })
    const target = await poll(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Chrome failed'); try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith(origin)) } catch { return false } }, 'isolated Chrome')
    const page = await connect(target, () => false), front = page.front; page.actor = actor; page.child = child
    page.front = async () => {
      for (const other of Object.values(pages).filter(item => item !== page)) { const window = await other.send('Browser.getWindowForTarget'); await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } }) }
      const { width, height } = page.size(), window = await page.send('Browser.getWindowForTarget')
      await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } }); await front()
      const current = steps.at(-1)
      await writeFile(caption, (current ? steps.length + '. ' + current.title + '；' : 'P6 设备关联与维修创建；') + (actor === 'admin' ? '管理员' : '成员 ' + actor.toUpperCase()) + '；渠道为模拟验收', { mode: 0o600 })
    }
    await page.viewport(1440, 900); await page.front(); await page.wait('Boolean(document.querySelector("#login-name"))')
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait('!document.querySelector("#app")?.classList.contains("hidden")')
    return page
  }
  async function login(actor) {
    const r = await request(actor, '/api/session', 'POST', { loginName: actor, password: passwords[actor] })
    assert.equal(r.status, 200); sessions[actor] = { cookie: r.cookie.split(';')[0], csrf: r.body.csrfToken }
  }
  async function request(actor, path, method = 'GET', body, extra = {}) {
    const session = sessions[actor], headers = { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }
    const r = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) })
    const text = await r.text(), value = text ? JSON.parse(text) : null; noSecrets(value)
    return { status: r.status, body: value, cookie: r.headers.get('set-cookie') }
  }
  async function api(actor, path, method = 'GET', body) { const r = await request(actor, path, method, body); assert(r.status >= 200 && r.status < 300, 'product request failed: ' + method + ' ' + path + ' ' + r.status); return r.body }
  async function work(actor, id) { return api(actor, workPath(id)) }
  async function reload(page, view = 'works') {
    await page.front(); const before = await page.evaluate('performance.timeOrigin'); await page.send('Page.reload')
    await page.wait('performance.timeOrigin !== ' + before + ' && !document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
    await page.nav(view)
  }
  async function openWork(actor, id, page = pages[actor]) { await reload(page); await page.click('#all-work-cards [data-open-work="' + id + '"]'); await page.wait('document.querySelector("#view-work")?.classList.contains("active") && document.querySelector("#repair-actions")?.dataset.work === ' + js(id)); return work(actor, id) }
  async function createWork(actor) {
    const page = pages[actor], before = (await state()).works.map(w => w.id)
    await reload(page, 'home'); await page.select('#work-employee', 'p6-agent-' + actor); await page.select('#work-skill', skill); await page.select('#work-connection', fixture(actor).connection.id)
    await page.select('#work-tpm-record-type', 'repair'); await page.fill('#work-tpm-reference', fixture(actor).facts.record.reference); await page.fill('#work-goal', '核对同设备的单据与当前监控，明确来源和未知项'); await page.click('#submit-work')
    const value = await poll(async () => { const list = (await state()).works.filter(w => w.ownerMemberId === actor && !before.includes(w.id)); assert(list.length <= 1); return list[0] }, 'ordinary UI work creation')
    const done = await poll(async () => { const w = await work(actor, value.id); return ['accepted', 'running'].includes(w.status) ? false : w }, 'native correlation completion', 120_000)
    const result = validateP6Correlation(done, fixture(actor)); await openWork(actor, done.id); await correlationDom(pages[actor], result); return done
  }
  async function preview(id, suffix) {
    await openWork('a', id); const before = (await work('a', id)).actions.map(a => a.id), page = pages.a
    await page.click('#repair-open'); await page.fill('#repair-reason', 'P6 合成设备核对 ' + suffix); await page.fill('#repair-description', '经当前单据和监控事实核对的 synthetic 维修请求 ' + suffix); await page.click('#repair-save-preview')
    return poll(async () => { const matches = (await work('a', id)).actions.filter(a => !before.includes(a.id)); assert(matches.length <= 1); return matches[0] }, 'durable ordinary UI preview')
  }
  async function uiAction(id, action, operation) { await openWork('a', id); await pages.a.click('[data-repair-id="' + action.id + '"][data-repair-operation="' + operation + '"]') }
  async function receipt(id, action) { return poll(async () => { const value = (await work('a', id)).actions.find(a => a.id === action.id); return value.receipt ? value : false }, 'independent readback and receipt', 120_000) }
  async function dom(page, selector) {
    return page.evaluate(`(() => { const node = document.querySelector(${js(selector)}); if (!node) return null;
      const visible = item => Boolean(item && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
      const button = operation => { const item = node.querySelector('[data-repair-operation="' + operation + '"]'); return item ? { visible: visible(item), disabled: item.disabled } : null };
      return { id: node.dataset.repairActionId || node.dataset.correlationResult, status: node.dataset.repairStatus, visible: visible(node), text: node.innerText,
        fields: Object.fromEntries([...node.querySelectorAll('.kv')].map(item => [...item.querySelectorAll(':scope > span')].map(span => span.innerText.trim())).filter(item => item.length === 2)),
        source: node.querySelector('.source')?.innerText || '', summary: node.querySelector(':scope > summary')?.innerText || '',
        approve: button('approve'), reconcile: button('reconcile') } })()`)
  }
  async function actionDom(page, action, status) {
    const selector = '[data-repair-action-id="' + action.id + '"]'
    const view = await poll(async () => { const value = await dom(page, selector); try { validateP6ActionDom(value, action, status); return value } catch { return false } }, 'actual action DOM ' + status)
    await page.evaluate('document.querySelector(' + js(selector) + ').scrollIntoView({ block: "start" })')
    await capture(page, status === 'created' ? '创建回执与原单号' : status === 'unknown' ? '未知结果只允许再次核对' : '本人拒绝，尚未创建')
    if (status === 'created') await page.evaluate(`(() => { const card = document.querySelector(${js(selector)}); [...card.querySelectorAll('.kv')].find(row => row.firstElementChild.innerText === '上游回读时间').scrollIntoView({ block: 'center' }) })()`)
    else if (status === 'unknown') await page.evaluate('document.querySelector(' + js(selector + ' [data-repair-operation="reconcile"]') + ').scrollIntoView({ block: "center" })')
    if (status === 'created' || status === 'unknown') await capture(page, status === 'created' ? '上游 UUID、版本与回读时间' : '仅可只读核对，不可批准')
    return view
  }
  async function correlationDom(page, result) {
    const selector = '[data-correlation-result="' + result.id + '"]'
    await page.wait('Boolean(document.querySelector(' + js(selector) + '))')
    if (!await page.evaluate('document.querySelector(' + js(selector + ' details') + ')?.open')) await page.click(selector + ' details > summary')
    const view = await dom(page, selector); validateP6CorrelationDom(view, result)
    await capture(page, '同设备关联事实')
    await page.evaluate(`(() => { const card = document.querySelector(${js(selector)}); [...card.querySelectorAll('.kv')].find(row => row.firstElementChild.innerText === '采样时间').scrollIntoView({ block: 'center' }) })()`)
    await capture(page, '采样时间、查询时间与未知项')
    await page.evaluate('document.querySelector(' + js(selector + ' .source') + ').scrollIntoView({ block: "center" })')
    await capture(page, '当前实例与三次读取来源')
    facts.push({ kind: 'correlation-dom', resultId: result.id, sourceInstance: result.payload.source.sourceInstance, sampleAt: result.payload.freshness.sampleAt, queriedAt: result.payload.queriedAt, unknowns: result.payload.unknowns })
  }
  async function channelTurn(messageId) {
    const message = await poll(async () => { const m = (await state()).channelMessages.find(item => item.providerMessageId === messageId); if (!m || m.status === 'reserved') return false; assert.equal(m.status, 'accepted'); assert(m.turnId); return m }, 'durable channel turn')
    const conversation = await poll(async () => { const c = await api('a', '/api/conversations/' + encodeURIComponent(message.memberConversationId)); const t = c.turns.find(t => t.id === message.turnId); if (!t || ['accepted', 'running'].includes(t.status)) return false; assert.equal(t.status, 'completed'); return c }, 'native channel reply', 120_000)
    await poll(async () => (await state()).deliveries.some(d => d.sourceRef?.turnId === message.turnId && d.status === 'delivered'), 'actual simulated platform acknowledgement', 30_000)
    return { message, conversation }
  }
  async function channelWork(messageId, previous) {
    const value = await poll(async () => { const found = (await state()).works.filter(w => !previous.includes(w.id) && w.ownerMemberId === 'a'); assert(found.length <= 1); return found[0]?.status === 'completed' ? found[0] : false }, 'channel correlation work', 120_000)
    const result = validateP6Correlation(value, fixture('a')); assert.equal(value.actions.length, 0); await channelTurn(messageId)
    await openWork('a', value.id); await correlationDom(pages.a, result)
    return value
  }
  function weixinMessage(id, text) {
    return { message_id: id, from_user_id: weixinAccount.ownerUserId, to_user_id: weixinAccount.id, message_type: 1, message_state: 2, seq: ++weixinSequence, create_time_ms: Date.now(),
      context_token: 'SYNTHETIC_CONTEXT_' + binding.runId + '_' + id, item_list: [{ type: 1, text_item: { text } }] }
  }
  async function step(id, run) {
    assert.equal(id, P6_STEPS[steps.length]); abort.signal.throwIfAborted(); recording.assertRunning()
    const actor = id === 'configuration' ? 'admin' : 'a', page = pages[actor]
    const entry = { id, actor, title: stepTitles[id], status: 'running', startedAt: new Date().toISOString(), startSeconds: (Date.now() - recordingAt) / 1000, screenshots: [] }; steps.push(entry)
    console.error('[accept:p6] ' + id)
    let originalError
    try { await page.front(); await run(); for (const page of Object.values(pages)) { assert.deepEqual(page.errors, []); await page.noOverflow() }; recording.assertRunning(); entry.status = 'passed' }
    catch (error) { originalError = error; entry.status = 'failed'; throw error }
    finally {
      try { await capture(page, entry.title) }
      catch (error) { entry.status = 'failed'; entry.captureFailed = true; if (!originalError) throw error }
      finally { entry.completedAt = new Date().toISOString(); entry.endSeconds = (Date.now() - recordingAt) / 1000 }
    }
  }
  async function workContentFits(page, required = false) {
    const layout = await page.evaluate(`(() => {
      const work = document.querySelector('#view-work.active'); if (!work || state.currentWork?.capabilityId !== ${js(cap)}) return null;
      const measure = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'), left: r.left, right: r.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth } };
      return { width: innerWidth, content: measure(document.querySelector('.content')), cards: [...work.querySelectorAll('[data-correlation-result],#repair-actions,[data-repair-action-id]')].map(measure).filter(item => item.visible) }
    })()`)
    if (required) assert(layout, 'the active work must be visible before this operation')
    if (layout) { assert.equal(layout.width, page.size().width); validateP6ContentGeometry(layout) }
  }
  async function capture(page, label) {
    recording.assertRunning(); await page.front(); await new Promise(done => setTimeout(done, 300))
    await workContentFits(page)
    const entry = steps.at(-1), shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = 'step-' + String(steps.length).padStart(2, '0') + '-' + String(entry.screenshots.length + 1).padStart(2, '0') + '.png'
    await writeFile(join(options.output, file), Buffer.from(shot.data, 'base64'), { mode: 0o600, flag: 'wx' })
    entry.screenshots.push({ file, label, actor: page.actor, viewport: page.size(), seconds: (Date.now() - recordingAt) / 1000 })
  }

  async function journeys() {
    await step('configuration', async () => {
      for (const f of fixtures) await api('admin', '/api/admin/connections/' + f.connection.id + '/test', 'POST', {})
      const switched = await operator.wait('switch-endpoints', 'switch-endpoints', { endpoints: fixtures.map(f => ({ id: f.facts.endpointId, sourceId: f.eventSource.id, urlHash: hash(origin + '/api/events/kivo/' + f.eventSource.id) })) })
      assert.equal(switched.signingSecretsUnchanged, true); assert.equal(switched.subscriptionsUnchanged, true); assert.equal(switched.endpointUrlsMatch, true)
      assert.equal((await state()).automationRules.length, 0)
    })
    await step('two-instance-correlation', async () => { refs.b = (await createWork('b')).id; refs.a = (await createWork('a')).id; assert.notEqual(refs.a, refs.b) })
    await step('preview-without-write', async () => {
      await openWork('a', refs.a); await pages.a.click('#repair-open'); await pages.a.fill('#repair-reason', '未提交本地草稿'); await pages.a.click('#repair-close')
      assert.equal((await work('a', refs.a)).actions.length, 0)
      await pages.a.viewport(390, 844)
      const rejected = await preview(refs.a, '编辑前预览')
      await uiAction(refs.a, rejected, 'edit'); await pages.a.fill('#repair-description', '取消这次编辑不批准或保存'); await pages.a.click('#repair-close')
      assert.deepEqual((await work('a', refs.a)).actions, [rejected])
      await uiAction(refs.a, rejected, 'edit')
      const draft = { reason: rejected.preview.payload.reason, description: '保存修改后的完整预览；轮询和刷新不能覆盖这份草稿。' }
      await pages.a.fill('#repair-description', draft.description)
      const beforeFollow = await work('a', refs.a), beforeKivo = await kivoRequests(), polls = () => pages.a.responses.filter(row => row.path === '/api/works/:id' && row.status === 200).length, beforePoll = polls()
      await pages.a.fill('#follow-text', '请仅根据已保存的关联事实输出约800字逐项说明：分别解释单据、设备身份、采样时间、查询时间、未知项与权限边界。不要调用业务工具重新关联，不添加事实，不创建工作或维修动作。')
      await pages.a.click('#follow-form button')
      await poll(() => polls() > beforePoll, 'actual browser work polling while the repair draft is open', 20_000)
      const observedPolls = polls() - beforePoll
      const draftValue = () => pages.a.evaluate('({ reason: document.querySelector("#repair-reason")?.value, description: document.querySelector("#repair-description")?.value })')
      assert.deepEqual(await draftValue(), draft); await capture(pages.a, '真实轮询后保留未保存草稿')
      const followed = await poll(async () => { const w = await work('a', refs.a); if (['accepted', 'running'].includes(w.status)) return false; assert.equal(w.status, 'completed'); return w }, 'read-only follow-up completion', 120_000)
      assert.deepEqual(followed.results.filter(r => r.kind === 'kivo.tpm.device-correlation'), beforeFollow.results.filter(r => r.kind === 'kivo.tpm.device-correlation'))
      assert.equal(followed.results.at(-1).kind, 'assistant.follow-up'); assert.deepEqual(followed.actions, beforeFollow.actions)
      assert.equal(await kivoRequests(), beforeKivo, 'the polling follow-up must not query or replace its correlation basis')
      await pages.a.wait('Boolean(document.querySelector("#repair-save-preview")) && !document.querySelector("#repair-save-preview").disabled')
      assert.deepEqual(await draftValue(), draft)
      const beforeRefresh = polls(); await pages.a.click('#repair-refresh')
      await poll(() => polls() > beforeRefresh, 'explicit repair-state refresh')
      await pages.a.wait('Boolean(document.querySelector("#repair-save-preview")) && !document.querySelector("#repair-save-preview").disabled')
      assert.deepEqual(await draftValue(), draft); await capture(pages.a, '显式刷新不覆盖草稿或批准')
      facts.push({ kind: 'draft-poll-and-refresh', workId: refs.a, actualBrowserPolls: observedPolls, additionalKivoRequests: 0, correlationBasisChanged: false })
      const conflictPage = pages.conflict = await browser('a', 'a-conflict')
      await conflictPage.viewport(390, 844); await openWork('a', refs.a, conflictPage)
      const oldApprove = '[data-repair-id="' + rejected.id + '"][data-repair-operation="approve"]'
      await conflictPage.wait('Boolean(document.querySelector(' + js(oldApprove) + ')) && !document.querySelector(' + js(oldApprove) + ').disabled')
      assert.equal(await conflictPage.evaluate('state.currentWork.status'), 'completed'); assert.equal(await conflictPage.evaluate('state.poll'), null)
      assert.equal(await conflictPage.evaluate('state.currentWork.actions.find(action => action.id === ' + js(rejected.id) + ').preview.digest'), rejected.preview.digest)
      await pages.a.front(); await pages.a.click('#repair-save-preview')
      refs.action = await poll(async () => { const found = (await work('a', refs.a)).actions.filter(a => a.id !== rejected.id); assert(found.length <= 1); return found[0] }, 'saved edited preview')
      assert.notEqual(refs.action.preview.digest, rejected.preview.digest); assert.notEqual(refs.action.preview.payload.description, rejected.preview.payload.description)
      const stale = await request('a', actionPath(refs.a, refs.action.id, 'approve'), 'POST', { ...approval(refs.action), previewDigest: rejected.preview.digest, clientRequestId: 'p6-stale-digest-' + refs.action.id })
      assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
      assert((await work('a', refs.a)).actions.every(a => !a.attempt && !a.receipt))
      await uiAction(refs.a, rejected, 'reject')
      const declined = await poll(async () => { const a = (await work('a', refs.a)).actions.find(a => a.id === rejected.id); return a?.decision?.kind === 'rejected' ? a : false }, 'owner rejection')
      assert.equal(declined.attempt, null); assert.equal(declined.receipt, null)
      await actionDom(pages.a, declined, 'rejected')
      assert.equal(await conflictPage.evaluate('state.currentWork.actions.find(action => action.id === ' + js(rejected.id) + ').decision'), null)
      const conflicts = () => conflictPage.responses.filter(row => row.path === '/api/works/:id/actions/' + rejected.id + '/approve' && row.status === 409).length, beforeConflict = conflicts()
      await conflictPage.front(); await workContentFits(conflictPage, true); await conflictPage.click(oldApprove)
      await poll(() => conflicts() === beforeConflict + 1, 'actual mobile stale-decision approval returns 409')
      await conflictPage.wait('document.querySelector("#repair-message.error")?.innerText.includes("预览、权限或来源事实已变化")')
      const stillRejected = (await work('a', refs.a)).actions.find(a => a.id === rejected.id)
      assert.deepEqual(stillRejected, declined); await actionDom(conflictPage, stillRejected, 'rejected')
      await capture(conflictPage, '手机旧预览批准发生冲突，已拒绝且没有派发')
      facts.push({ kind: 'mobile-stale-decision-conflict', workId: refs.a, actionId: rejected.id, responseStatus: 409, decision: stillRejected.decision.kind })
      conflictPage.socket.close(); await stopOwned(conflictPage.child); delete pages.conflict
      const w = await work('a', refs.a); assert(w.actions.every(a => !a.attempt && !a.receipt))
      await pages.a.noOverflow(); await pages.a.viewport(1440, 900)
      const proof = await operator.wait('edited-preview-no-write', 'read-created-repair', target(refs.action)); assert.equal(proof.matchingBusinessRows, 0); assert.equal(proof.matchingCreateRequests, 0); assert.equal(proof.logSha256, hash(''))
    })
    await step('owner-isolation', async () => {
      const path = actionPath(refs.a, refs.action.id, 'approve'), body = approval(refs.action)
      for (const actor of ['admin', 'b']) {
        const hidden = await request(actor, workPath(refs.a)); assert.equal(hidden.status, 404); assert(!JSON.stringify(hidden.body).includes(refs.action.preview.payload.orderNo))
        assert.equal((await request(actor, path, 'POST', body)).status, 404)
      }
      assert.equal((await request('a', path, 'POST', body, { 'x-csrf-token': 'invalid' })).status, 403)
      assert.equal((await request('a', path, 'POST', body, { origin: 'http://127.0.0.1:34482' })).status, 403)
      assert.equal((await request('a', path, 'POST', { ...body, payload: {} })).status, 400)
      assert.equal((await work('a', refs.a)).actions.find(a => a.id === refs.action.id).attempt, null)
    })
    await step('owner-approval', async () => {
      await pages.a.viewport(390, 844); await openWork('a', refs.a); await workContentFits(pages.a, true)
      await doubleClickControl(pages.a, '[data-repair-id="' + refs.action.id + '"][data-repair-operation="approve"]'); refs.created = await receipt(refs.a, refs.action)
      await actionDom(pages.a, refs.created, 'created')
      await pages.a.viewport(1440, 900)
      const proof = await operator.wait('created-readback', 'read-created-repair', target(refs.created))
      validateP6Creation(refs.created, fixture('a'), proof.record); assert.equal(proof.matchingBusinessRows, 1); assert.equal(proof.matchingCreateRequests, 1)
      await api('a', actionPath(refs.a, refs.action.id, 'approve'), 'POST', approval(refs.action))
      const repeated = await operator.wait('duplicate-approval-readback', 'read-created-repair', target(refs.created)); assert.equal(repeated.matchingCreateRequests, 1)
      facts.push({ kind: 'created', workId: refs.a, actionId: refs.action.id, recordId: refs.created.receipt.upstreamRecordId, orderNo: refs.created.receipt.orderNo })
    })
    await step('producer-zero-rule-echo', async () => {
      const proof = await operator.wait('release-created-event', 'release-worker-and-readback', target(refs.created))
      validateP6Worker(proof, fixture('a'), proof.event.eventId)
      assert.equal(proof.event.action, 'create'); assert.equal(proof.event.actorKind, 'machine'); assert.equal(proof.event.sourceRevision, '0')
      const entry = await poll(async () => (await state()).automationInbox.find(e => e.event.eventId === proof.event.eventId && e.actionRef?.actionId === refs.action.id), 'actual signed zero-rule echo', 75_000)
      assert.equal(entry.targets.length, 0); assert.equal((await state()).automationRules.length, 0); assert(isRepairCreationEcho(entry.event, refs.created))
      for (const d of proof.deliveries) assert(entry.deliveries.some(x => x.id === d.id && x.rawDigest === d.attempts[0].wireBodySha256))
      assert.equal((await state()).works.length, 2)
    })
    await step('higher-revision', async () => {
      const rule = await api('a', '/api/automations', 'POST', { employeeId: 'p6-agent-a', skillId: readSkill, connectionId: fixture('a').connection.id, input: { recordType: 'repair', reference: refs.created.receipt.orderNo }, trigger: { kind: 'kivo-record-update', sourceId: fixture('a').eventSource.id }, maxRuns: 2, notificationIdentityId: null })
      const active = await api('a', '/api/automations/' + rule.id + '/enable', 'POST', { expectedRevision: rule.revision }); assert.equal(active.baselineRevision, '0')
      const proof = await operator.wait('advance-created-record', 'human-update-release-worker', { ...target(refs.created), requiredHumanOperation: 'dispatch', statusBefore: 'reported', statusAfter: 'dispatched' })
      validateP6StatusAdvance(proof); validateP6Worker(proof, fixture('a'), proof.event.eventId)
      const occurrence = await poll(async () => { const d = await api('a', '/api/automations/' + rule.id); return d.occurrences.find(o => o.event?.eventId === proof.event.eventId && o.workId) }, 'higher revision normal P5 occurrence', 90_000)
      assert.notEqual(occurrence.reason, 'echo'); const w = await poll(async () => { const w = await work('a', occurrence.workId); return ['accepted', 'running'].includes(w.status) ? false : w }, 'higher revision native work', 120_000); assert.equal(w.status, 'completed')
      await api('a', '/api/automations/' + rule.id + '/pause', 'POST', { expectedRevision: active.revision })
    })
    await step('lost-webhook', async () => {
      const w = await createWork('a'), action = await preview(w.id, '丢失事件只回读')
      await operator.wait('hold-lost-event', 'hold-next-create-delivery', target(action))
      await uiAction(w.id, action, 'approve'); const confirmed = await receipt(w.id, action)
      await actionDom(pages.a, confirmed, 'created')
      const proof = await operator.wait('lost-event-readback', 'read-created-repair-without-delivery', target(confirmed)); validateP6Creation(confirmed, fixture('a'), proof.record)
      assert.equal(proof.matchingCreateRequests, 1); assert.equal(proof.eventDelivered, false); assert(!(await state()).automationInbox.some(e => e.event.traceId === action.id))
    })
    await step('simulated-channel', async () => {
      const knownTraces = (await state()).works.flatMap(w => w.actions.filter(a => a.attempt).map(a => a.id))
      await operator.wait('channel-write-baseline', 'read-all-action-traces', { traces: knownTraces })
      const link = await api('a', '/api/channels/link-codes', 'POST', { channelAppId: app.id })
      await ipc(host, 'feishu-event', feishuEvent('bind-' + link.id, link.code))
      await poll(async () => (await api('a', '/api/channels')).linkCodes.find(l => l.id === link.id)?.status === 'matched', 'actual dispatcher matching')
      await api('a', '/api/channels/link-codes/' + link.id + '/confirm', 'POST', { employeeId: 'p6-agent-a' })
      const before = (await state()).works.map(w => w.id), messageId = 'p6-read-' + binding.runId
      const text = `请创建一个 ${cap} 设备关联工作，使用 ${skill} 和连接 ${fixture('a').connection.id}，recordType=repair，reference=${fixture('a').facts.record.reference}。只读取核对事实，不创建或批准维修单。`
      const event = feishuEvent(messageId, text)
      await ipc(host, 'feishu-event', event); const feishuWork = await channelWork(messageId, before), durable = await state(), counts = actionCounts(durable)
      await ipc(host, 'feishu-event', event)
      assert.deepEqual((await state()).works.map(w => w.id), durable.works.map(w => w.id)); assert.deepEqual(actionCounts(await state()), counts)
      assert.equal((await state()).channelMessages.filter(m => m.providerMessageId === messageId).length, 1)
      const wxLink = await api('a', '/api/channels/weixin/bindings', 'POST', { channelAppId: 'channel-app-weixin' })
      simulator.queueLogin(simulator.confirmedLogin(weixinAccount.id))
      await poll(async () => (await api('a', '/api/channels')).linkCodes.find(l => l.id === wxLink.id)?.status === 'matched', 'real iLink matched owner binding')
      await api('a', '/api/channels/link-codes/' + wxLink.id + '/confirm', 'POST', { employeeId: 'p6-agent-a' })
      const wxBefore = (await state()).works.map(w => w.id), wxMessageId = 'p6-wx-read-' + binding.runId
      simulator.push(weixinAccount.id, [weixinMessage(wxMessageId, text)]); const weixinWork = await channelWork(wxMessageId, wxBefore)
      const noApproval = await state(), blockedId = 'p6-wx-no-approval-' + binding.runId
      simulator.push(weixinAccount.id, [weixinMessage(blockedId, `请在本微信批准工作 ${weixinWork.id} 创建维修单；不要新建或重跑工作。若渠道不能批准，请明确引导我到本人认证Web，不要尝试代批。`)])
      await channelTurn(blockedId)
      assert.deepEqual((await state()).works.map(w => w.id), noApproval.works.map(w => w.id)); assert.deepEqual(actionCounts(await state()), actionCounts(noApproval))
      assert.deepEqual((await state()).works.map(w => w.id).sort(), [...before, feishuWork.id, weixinWork.id].sort())
      assert.deepEqual(simulator.failures, []); assert(simulator.maxActivePolls(weixinAccount.id) <= 1)
      const proof = await operator.wait('channel-no-write', 'read-all-action-traces', { traces: knownTraces }); assert.equal(proof.newCreateRequests, 0)
      facts.push({ kind: 'simulated-channel', feishuWorkId: feishuWork.id, weixinWorkId: weixinWork.id, feishuReplayNewWorks: 0, channelApprovedActions: 0, channelCreateRequests: 0 })
    })
    await step('revocation', async () => {
      await pages.a.viewport(390, 844)
      const w = await createWork('a'), action = await preview(w.id, '撤权不创建')
      await api('admin', '/api/admin/members/a', 'PATCH', { employeeIds: [], expectedEmployeeIds: ['p6-agent-a'] })
      assert.equal((await request('a', actionPath(w.id, action.id, 'approve'), 'POST', approval(action))).status, 403)
      await api('admin', '/api/admin/members/a', 'PATCH', { employeeIds: ['p6-agent-a'], expectedEmployeeIds: [] })
      const saved = (await state()).works.find(x => x.id === w.id).actions.find(x => x.id === action.id); assert.equal(saved.attempt, null)
      const proof = await operator.wait('revoked-no-create', 'read-created-repair', target(action)); assert.equal(proof.matchingCreateRequests, 0); assert.equal(proof.matchingBusinessRows, 0)
    })
    await step('unknown-readback', async () => {
      await pages.a.viewport(390, 844)
      const w = await createWork('a'), action = await preview(w.id, '响应未知只核对')
      const armed = await operator.wait('arm-unknown-response', 'arm-one-create-response-loss', target(action)); assert.equal(armed.actionId, action.id); assert.equal(armed.oneShot, true)
      await uiAction(w.id, action, 'approve')
      const unknown = await poll(async () => { const a = (await work('a', w.id)).actions.find(x => x.id === action.id); return a.attempt?.unknownAt && !a.receipt ? a : false }, 'durable unknown', 120_000)
      await actionDom(pages.a, unknown, 'unknown')
      await api('a', actionPath(w.id, action.id, 'approve'), 'POST', approval(action)); const check = await operator.wait('unknown-no-retry', 'read-created-repair', target(unknown)); assert.equal(check.matchingCreateRequests, 1)
      refs.unknownWork = w.id; refs.unknownAction = unknown; unresolvedAction(await state(), w.id, action.id)
    })
    await step('normal-restart', async () => {
      const before = await state(), counts = actionCounts(before); unresolvedAction(before, refs.unknownWork, refs.unknownAction.id)
      await stopOwned(host); host = await boot(join(scratch, 'host.json'))
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      assert.deepEqual(actionCounts(await state()), counts); assert.deepEqual((await state()).works.map(w => w.actions), before.works.map(w => w.actions))
      const unknown = unresolvedAction(await state(), refs.unknownWork, refs.unknownAction.id)
      await openWork('a', refs.unknownWork); await actionDom(pages.a, unknown, 'unknown')
      const proof = await operator.wait('restart-no-write', 'read-all-action-traces', { traces: before.works.flatMap(w => w.actions.filter(a => a.attempt).map(a => a.id)) }); assert.equal(proof.newCreateRequests, 0)
    })
    await step('backup-restore', async () => {
      await stopOwned(host); const before = await state(), backup = join(privateRoot, 'backup'), restored = join(privateRoot, 'restored'), secretPackage = join(privateRoot, 'secret-package'), restoredSecrets = join(privateRoot, 'restored-secrets')
      unresolvedAction(before, refs.unknownWork, refs.unknownAction.id)
      await transfer(['backup', '--output', backup, '--secret-output', secretPackage, '--secret-root', secretRoot])
      await transfer(['restore', '--input', backup, '--data-root', restored, '--secret-input', secretPackage, '--secret-root', restoredSecrets])
      stateFile = join(restored, 'state.json'); dshHome = join(restored, 'dsh'); secretRoot = restoredSecrets
      const after = await state(); assert.deepEqual(actionCounts(after), actionCounts(before)); assert(after.automationRules.every(r => r.status !== 'active')); assert(after.channelApps.every(a => !a.enabled))
      assert.deepEqual(after.works.map(w => w.results), before.works.map(w => w.results)); assert(after.works.flatMap(w => w.actions).every(a => a.receipt || !a.decision || a.decision.kind !== 'approved' || a.attempt || a.decision.invalidatedAt))
      assert(JSON.parse(await readFile(join(restored, 'event-sources.json'), 'utf8')).sources.every(source => !source.enabled))
      const unknown = unresolvedAction(after, refs.unknownWork, refs.unknownAction.id)
      host = await boot(join(scratch, 'host.json'), false)
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      unresolvedAction(await state(), refs.unknownWork, refs.unknownAction.id)
      const proof = await operator.wait('restore-no-write', 'read-all-action-traces', { traces: after.works.flatMap(w => w.actions.filter(a => a.attempt).map(a => a.id)) }); assert.equal(proof.newCreateRequests, 0)
      await pages.a.viewport(390, 844); await openWork('a', refs.unknownWork); await actionDom(pages.a, unknown, 'unknown')
      await uiAction(refs.unknownWork, unknown, 'reconcile'); const known = await receipt(refs.unknownWork, unknown)
      await actionDom(pages.a, known, 'created'); await pages.a.noOverflow()
      const final = await operator.wait('restored-readback', 'read-created-repair', target(known)); validateP6Creation(known, fixture('a'), final.record)
      assert.equal(final.matchingBusinessRows, 1); assert.equal(final.matchingCreateRequests, 1)
      facts.push({ kind: 'unresolved-recovery', actionId: unknown.id, remainedUnknownAcrossRestartAndRestore: true, automaticCreates: 0, finalReadOnlyReconcile: true })
    })
  }
  async function transfer(args) {
    const child = launch(process.execPath, [join(root, 'scripts/state-transfer.mjs'), ...args], { env: { ...systemEnvironment(), GENEWAY_STATE: stateFile, GENEWAY_DSH_HOME: dshHome, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'] }, stdio: ['ignore', 'pipe', 'pipe'] })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); assert.equal(code, 0)
  }
}

function workPath(id) { return '/api/works/' + encodeURIComponent(id) }
function seedState(state, fixtures, modelRef, channelRef) {
  const now = new Date().toISOString()
  return { ...state,
    members: ['admin', 'a', 'b'].map(id => ({ id, loginName: id, displayName: id, authRef: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, employeeIds: id === 'admin' ? [] : ['p6-agent-' + id], sessionVersion: 1, createdAt: now, updatedAt: now })),
    modelRoutes: [{ id: 'p6-model', provider: 'zenmux', model, credentialRef: modelRef, enabled: true }],
    skills: [{ id: skill, name: 'TPM 与设备关联', capabilityId: cap, enabled: true }, { id: readSkill, name: 'TPM 记录读取', capabilityId: 'kivo-tpm-record-read', enabled: true }],
    employees: fixtures.map(f => ({ id: 'p6-agent-' + f.instance, name: 'P6 员工 ' + f.instance.toUpperCase(), revision: 1, instructions: '仅按当前获准工具返回的事实解释，不猜设备或缺失监控，不创建维修单，不批准动作。', enabled: true, modelRouteId: 'p6-model', connectionIds: [f.connection.id], skillIds: [skill, readSkill], createdAt: now, updatedAt: now })),
    connections: fixtures.map(f => ({ ...f.connection, name: 'P6 Kivo ' + f.instance.toUpperCase(), enabled: true, status: 'unknown', revision: 1, skillIds: [skill, readSkill], createdAt: now, updatedAt: now })),
    channelApps: [{ id: app.id, provider: 'feishu', providerAppId: app.providerAppId, providerTenantId: app.providerTenantId, credentialRef: channelRef, enabled: true, revision: 1, status: 'active', allowedScopes: ['result'], createdAt: now, updatedAt: now },
      { id: 'channel-app-weixin', provider: 'weixin', providerAppId: 'ilink', providerTenantId: 'personal', credentialRef: null, enabled: true, revision: 1, status: 'active', allowedScopes: ['result'], createdAt: now, updatedAt: now }],
  }
}
function actionPath(work, action, operation) { return workPath(work) + '/actions/' + encodeURIComponent(action) + '/' + operation }
function approval(action) { return { expectedRevision: action.preview.expectedRevision, previewDigest: action.preview.digest, clientRequestId: 'p6-approval-' + action.id } }
function target(action) { return { actionId: action.id, orderNo: action.preview.payload.orderNo, deviceId: action.preview.target.deviceId, clientId: action.preview.target.clientId, traceId: action.id, resource: action.preview.target.resource } }
function actionCounts(state) { return { actions: state.works.reduce((n, w) => n + w.actions.length, 0), attempts: state.works.reduce((n, w) => n + w.actions.filter(a => a.attempt).length, 0), receipts: state.works.reduce((n, w) => n + w.actions.filter(a => a.receipt).length, 0) } }
function feishuEvent(id, text) { return { schema: '2.0', header: { event_id: 'event-' + id, event_type: 'im.message.receive_v1', app_id: app.providerAppId, tenant_key: app.providerTenantId, create_time: String(Date.now()) }, event: { sender: { sender_id: { open_id: 'p6-open-a' }, sender_type: 'user', tenant_key: app.providerTenantId }, message: { message_id: id, chat_id: 'p6-chat-a', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()) } } } }
async function ipc(child, method, input) {
  const id = randomBytes(12).toString('hex'); assert(child.connected && child.exitCode === null)
  return new Promise((done, reject) => {
    const finish = () => { clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', exited) }
    const receive = result => { if (result?.kind === 'channel-acceptance' && result.id === id) { finish(); result.ok ? done(result.value) : reject(new Error('owned transport IPC failed')) } }
    const exited = () => { finish(); reject(new Error('owned Host exited during IPC')) }, timer = setTimeout(() => { finish(); reject(new Error('owned IPC timed out')) }, 20_000)
    child.on('message', receive); child.once('exit', exited); child.send({ kind: 'channel-acceptance', id, method, input }, error => { if (error) { finish(); reject(error) } })
  })
}
async function stopOwned(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  child.diagnostics?.stopRequested()
  await stop(child, signal)
  let forced = child.signalCode === 'SIGKILL'
  // The parent can exit before the rest of its owned process group drains.
  const groupDeadline = Date.now() + 10_000
  while (!forced && !gone(-child.pid) && Date.now() < groupDeadline) await new Promise(done => setTimeout(done, 25))
  if (!gone(-child.pid)) {
    try { process.kill(-child.pid, 'SIGKILL'); forced = true }
    catch (error) { if (error.code !== 'ESRCH' || !gone(-child.pid)) throw error }
    await poll(() => gone(-child.pid), 'owned process group cleanup', 10_000)
  }
  assert(!forced, 'owned process required forced cleanup')
  if (child.diagnostics) await poll(() => child.diagnostics.closed, 'owned Host diagnostics close')
}
function diagnostics(child, directory, binding, onFailure) {
  const path = join(directory, 'host-' + child.pid), fd = openSync(path + '.stderr', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const meta = { ...binding, pid: child.pid, startedAt: Date.now(), bytesObserved: 0, bytesSaved: 0, truncated: false, stopRequests: [], exitCode: null, exitSignal: null, closedAt: null }
  const persist = () => writeFileSync(path + '.json', JSON.stringify(meta) + '\n', { mode: 0o600 })
  const safe = operation => { try { operation() } catch { onFailure(new Error('private Host diagnostics I/O failed')) } }
  persist(); child.once('exit', (code, signal) => {
    Object.assign(meta, { exitCode: code, exitSignal: signal, exitObservedAt: Date.now() }); safe(persist)
    if (code !== 0 || signal !== null) onFailure(Object.assign(new Error('owned Host did not exit normally'), { code: 'OWNED_HOST_EXIT_FAILED' }))
  })
  child.once('close', () => { meta.closedAt = Date.now(); safe(() => { closeSync(fd); persist() }) })
  return { get closed() { return meta.closedAt !== null }, stopRequested() { meta.stopRequests.push({ at: Date.now(), signal: 'SIGTERM', wasAlive: child.exitCode === null && child.signalCode === null }); persist() }, stderr(bytes) {
    const chunk = Buffer.from(bytes), saved = chunk.subarray(0, Math.max(0, 8 * 1024 * 1024 - meta.bytesSaved)); meta.bytesObserved += chunk.length; meta.truncated ||= meta.bytesObserved > 8 * 1024 * 1024
    safe(() => { appendFileSync(fd, saved); meta.bytesSaved += saved.length; persist() })
    if (meta.truncated) onFailure(new Error('private Host stderr exceeded bound'))
  } }
}
function validateCandidate(value) {
  assert(Array.isArray(value.files) && value.files.length)
  for (const f of value.files) assert(/^(src\/|plugins\/|config\/|web\/|vendor\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(f.path) && !f.path.split('/').includes('..') && /^[a-f0-9]{64}$/.test(f.sha256))
  assert.equal(new Set(value.files.map(f => f.path)).size, value.files.length)
  for (const path of ['scripts/accept-p6-kivo.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/accept-p4.mjs', 'scripts/state-transfer.mjs', 'src/server.mjs', 'src/action-service.mjs', 'src/store/file-store.mjs', 'src/domain/kivo-repair.mjs', 'src/domain/tpm-device-correlation.mjs', 'plugins/kivo-tpm.mjs', 'web/index.html']) assert(value.files.some(f => f.path === path), 'candidate missing ' + path)
  return value.files
}
async function snapshot(files, expectedHead) {
  assert.equal((await command('git', ['rev-parse', 'HEAD'])).trim(), expectedHead)
  const loaded = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'plugins', 'config', 'web', 'vendor', 'package.json', 'pnpm-lock.yaml', 'scripts/accept-p6-kivo.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/accept-p4.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'scripts/state-transfer.mjs'])).split('\0').filter(Boolean)
  assert(loaded.every(path => files.some(f => f.path === path)), 'actual import closure omitted from candidate')
  for (const f of files) assert.equal(hash(await readFile(join(root, f.path))), f.sha256, 'candidate mismatch ' + f.path)
  return { head: expectedHead, files: Object.fromEntries(files.map(f => [f.path, f.sha256])) }
}
async function privateJson(path) { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await fd.stat(); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600); const bytes = await fd.readFile(); return { value: JSON.parse(bytes), sha256: hash(bytes) } } finally { await fd.close() } }
async function privateDirectory(path) { const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700) }
async function secretMetadata(directory, ref) { assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)); const stat = await lstat(join(directory, ref)); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600) }
function noSecrets(value) { assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization|secret|token)"\s*:|whsec_|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify(value)), 'secret body is forbidden') }
function assertUuidRows(values) { assert(Array.isArray(values) && values.length); values.forEach(value => uuid(value.id)) }
function uuid(value) { assert(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) }
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function js(value) { return JSON.stringify(value) }
function within(parent, child) { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
function gone(pid) { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true }); assert.throws(() => argumentsFor(['--run'])); assert.throws(() => argumentsFor(['--harness-check', '--fixture-a', '/tmp/a']))
  const runtimeArgs = ['--run', ...['output', 'fixture-a', 'fixture-b', 'api-state-a', 'api-state-b', 'catalog', 'candidate', 'secret-root', 'network-guard', 'observer-config'].flatMap(key => ['--' + key, '/synthetic/' + key]),
    '--expected-head', 'a'.repeat(40), '--guard-sha256', 'b'.repeat(64), '--observer-config-sha', 'c'.repeat(64), '--model-ref', 'ZENMUX_API_KEY', '--run-id', 'p6-pure']
  assert.equal(argumentsFor(runtimeArgs)['api-state-a'], '/synthetic/api-state-a')
  for (const key of ['api-state-a', 'api-state-b', 'observer-config', 'observer-config-sha']) { const missing = [...runtimeArgs], index = missing.indexOf('--' + key); missing.splice(index, 2); assert.throws(() => argumentsFor(missing)) }
  for (const [key, value] of [['observer-config', 'relative.json'], ['observer-config', join(root, 'observer.json')], ['observer-config-sha', 'not-sha256']]) {
    const changed = [...runtimeArgs]; changed[changed.indexOf('--' + key) + 1] = value; assert.throws(() => argumentsFor(changed))
  }
  assert.equal(P6_STEPS.length, 13); assert.equal(new Set(P6_STEPS).size, 13)
  const safe = { kind: 'fetch', host: 'zenmux.ai', model, role: 'sdk', permitted: true, toolNames: ['geneway_kivo_tpm_correlate_device', 'structured_output'] }
  assert.equal(validateP6ModelAudit([safe]).requests, 1)
  assert.equal(validateP6ModelAudit([{ ...safe, toolNames: [...safe.toolNames, CYCLE_TIME_TOOL] }]).requests, 1)
  for (const tool of ['other', 'tpm.repair.create', 'geneway_kivo_tpm_repair_create', 'geneway_gearjob_read_work_order']) assert.throws(() => validateP6ModelAudit([{ ...safe, toolNames: [tool] }]))
  for (const change of [{ credentialInPayload: true }, { sessionLogAttached: true }, { unexpectedBodyFields: true }, { model: 'other' }, { permitted: false }]) assert.throws(() => validateP6ModelAudit([{ ...safe, ...change }]))
  for (const value of [{ accessToken: 'synthetic' }, { note: 'Bearer synthetic' }, { privateKey: 'not-a-key' }]) assert.throws(() => noSecrets(value))
  const { correlationFixture, deviceId, recordId } = await import('./fixtures/kivo-device-correlation.mjs')
  const { repairTargetFromCorrelation } = await import('../src/domain/kivo-repair.mjs')
  const candidate = 'a'.repeat(64), baseCandidate = 'c'.repeat(64), runId = 'p6-pure'
  const sample = instance => {
    const connection = { id: 'kivo-p6-' + instance, kind: 'kivo-mcp', targetIdentity: instance, baseUrl: `http://127.0.0.1:${instance === 'a' ? 34581 : 34582}/api/v1/mes/mcp`, issuer: `http://127.0.0.1:${instance === 'a' ? 34581 : 34582}`, clientId: randomUUID(), credentialRef: 'MCP_PRIVATE_' + instance.toUpperCase(), sourceSystem: 'KivoMES', sourceInstance: runId + '-' + instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'actual-mcp', revision: 1, allowedObjectIds: [] }
    const subscriptionIds = [randomUUID()]
    return { instance, runId, candidate: baseCandidate, phase: 'fixture-ready', dataMode: 'synthetic', sourceEnvironment: 'external-test', connection,
      facts: { organizationId: randomUUID(), deviceId: instance === 'a' ? deviceId : randomUUID(), clientId: connection.clientId, endpointId: randomUUID(), subscriptionIds, hiveBindingId: randomUUID(), record: { recordType: 'repair', recordId: instance === 'a' ? recordId : randomUUID(), reference: 'R-1', currentRevision: 0 } },
      eventSource: { id: connection.id, connectionId: connection.id, resource: connection.baseUrl, sourceInstance: connection.sourceInstance, signingSecretRef: 'WEBHOOK_' + instance.toUpperCase(), subscriptionIds, enabled: true } }
  }
  const a = sample('a'), b = sample('b'), catalog = { version: 1, targets: [a.connection, b.connection].map(c => Object.fromEntries(fields.map(key => [key, c[key]]))) }
  validateP6Fixtures(a, b, catalog); assert.notEqual(a.candidate, candidate)
  const runtimeRoot = '/synthetic/kivo/.git/kivo-event-runtime/p6-isolated-build/worker-completion/trees/final', executable = '/synthetic/node', candidatePath = '/synthetic/candidate.json'
  const observerRoot = '/synthetic/p6-kivo-runtime', config = { schemaVersion: 1, runId, producerRunId: runId, candidate, candidatePath, baseCandidate,
    setupOutput: '/synthetic/runtime', controlDirectory: '/synthetic/runtime/private/create-observer', guardSha256: 'b'.repeat(64),
    instances: [a, b].map(f => ({ instance: f.instance, resource: f.connection.baseUrl, clientId: f.connection.clientId, deviceId: f.facts.deviceId })) }
  const rawConfig = JSON.stringify(config), observerInput = { value: config, sha256: hash(rawConfig) }
  const observerOptions = { ...argumentsFor(runtimeArgs), candidate: candidatePath, candidateSha256: candidate, 'observer-config-sha': observerInput.sha256,
    'network-guard': '/synthetic/p6-acceptance/guard-p6-kivo.mjs', 'fixture-a': '/synthetic/runtime/fixture-a.json', 'fixture-b': '/synthetic/runtime/fixture-b.json' }
  const observerCandidate = { p6Runtime: { root: observerRoot, files: observerFiles.map(path => ({ path, sha256: hash('pure-' + path) })) } }
  validateP6Observer(observerCandidate, observerInput, observerOptions, [a, b])
  const scenarioConfig = { ...config, runId: 'p6-independent-scenario' }, scenarioInput = { value: scenarioConfig, sha256: hash(JSON.stringify(scenarioConfig)) }
  const scenarioOptions = { ...observerOptions, 'run-id': scenarioConfig.runId, 'observer-config-sha': scenarioInput.sha256,
    'fixture-a': '/synthetic/runtime/fixture-a-' + scenarioConfig.runId + '.json', 'fixture-b': '/synthetic/runtime/fixture-b-' + scenarioConfig.runId + '.json' }
  validateP6Observer(observerCandidate, scenarioInput, scenarioOptions, [a, b])
  validateP6Observer(observerCandidate, scenarioInput, { ...scenarioOptions, 'fixture-a': observerOptions['fixture-a'], 'fixture-b': observerOptions['fixture-b'] }, [a, b])
  for (const [fixtureA, fixtureB] of [
    [observerOptions['fixture-a'], scenarioOptions['fixture-b']],
    [scenarioOptions['fixture-a'], observerOptions['fixture-b']],
    [scenarioOptions['fixture-a'], '/synthetic/runtime/fixture-b-other-run.json'],
    ['/synthetic/runtime/fixture-a-' + a.runId + '.json', '/synthetic/runtime/fixture-b-' + a.runId + '.json'],
    [scenarioOptions['fixture-a'], '/synthetic/other/fixture-b-' + scenarioConfig.runId + '.json'],
    [scenarioOptions['fixture-a'] + '.backup', scenarioOptions['fixture-b']],
    [scenarioOptions['fixture-b'], scenarioOptions['fixture-a']],
  ]) assert.throws(() => validateP6Observer(observerCandidate, scenarioInput, { ...scenarioOptions, 'fixture-a': fixtureA, 'fixture-b': fixtureB }, [a, b]))
  for (const mutate of [v => { v.schemaVersion = 2 }, v => { v.runId = 'other' }, v => { v.producerRunId = 'other' }, v => { v.baseCandidate = candidate },
    v => { v.candidate = baseCandidate }, v => { v.candidatePath += '.other' }, v => { v.guardSha256 = 'f'.repeat(64) }, v => { v.setupOutput += '/other' },
    v => { v.controlDirectory += '/other' }, v => { v.instances[0].clientId = b.connection.clientId }, v => { v.instances[0].deviceId = b.facts.deviceId },
    v => { v.instances[0].resource = b.connection.baseUrl }, v => { v.instances.reverse() }, v => { v.extra = true }]) {
    const changed = structuredClone(config); mutate(changed); const input = { value: changed, sha256: hash(JSON.stringify(changed)) }
    assert.throws(() => validateP6Observer(observerCandidate, input, { ...observerOptions, 'observer-config-sha': input.sha256 }, [a, b]))
  }
  assert.throws(() => validateP6Observer(observerCandidate, { ...observerInput, sha256: hash(rawConfig + '\n') }, observerOptions, [a, b]))
  for (const mutate of [v => { delete v.p6Runtime }, v => { v.p6Runtime.root = '/synthetic/other' }, v => { v.p6Runtime.files.pop() },
    v => { v.p6Runtime.files.push({ path: '../other.mjs', sha256: 'f'.repeat(64) }) }, v => { v.p6Runtime.files[0].sha256 = 'invalid' },
    v => { v.p6Runtime.files[0].path = v.p6Runtime.files[1].path }, v => { v.p6Runtime.extra = true }]) {
    const changed = structuredClone(observerCandidate); mutate(changed); assert.throws(() => validateP6Observer(changed, observerInput, observerOptions, [a, b]))
  }
  assert.throws(() => validateP6Observer(observerCandidate, observerInput, { ...observerOptions, 'fixture-b': '/synthetic/other/fixture-b.json' }, [a, b]))
  const observerEnv = observerEnvironment(observerOptions, observerCandidate.p6Runtime)
  assert.deepEqual(observerEnv, { NODE_OPTIONS: '--import=file:///synthetic/p6-acceptance/guard-p6-kivo.mjs --import=file:///synthetic/p6-kivo-runtime/repair-create-observer.mjs',
    GENEWAY_P6_CREATE_OBSERVER_CONFIG: observerOptions['observer-config'], GENEWAY_P6_CREATE_OBSERVER_CONFIG_SHA256: observerInput.sha256 })
  assert(Object.isFrozen(observerEnv))
  for (const state of [{}, { GENEWAY_STATE: '/synthetic/new-state', DSH_HOME: '/synthetic/new-dsh' }, { GENEWAY_STATE: '/synthetic/restored-state', GENEWAY_SECRET_ROOT: '/synthetic/restored-secrets' }]) {
    const env = { ...state, ...observerEnv }; for (const key of Object.keys(observerEnv)) assert.equal(env[key], observerEnv[key])
  }
  assert.equal(finalRuntime({ kivo: { root: '/synthetic/kivo', runtime: { variant: 'final', root: runtimeRoot } } }).root, runtimeRoot)
  for (const runtime of [{ variant: 'rc-before', root: runtimeRoot }, { variant: 'final', root: '/synthetic/kivo/apps/mes-api/dist' }]) assert.throws(() => finalRuntime({ kivo: { root: '/synthetic/kivo', runtime } }))
  const journal = { runId, baseCandidate, candidate, candidatePath, launchId: 'final-after-pg', runtimeRoot, runtimeVariant: 'final', instance: 'a', phase: 'ready',
    process: { pid: 12345, startTicks: '123456', executable, cwd: runtimeRoot } }
  const apiExpected = { runId, candidate, candidatePath, runtimeRoot, apiStatePath: '/synthetic/runtime/api-a-final-after-pg.json', fixturePath: '/synthetic/runtime/fixture-a.json', executable,
    process: structuredClone(journal.process), listener: 'LISTEN 0 511 127.0.0.1:34581 0.0.0.0:* users:(("node",pid=12345,fd=31))\n' }
  const api = validateP6ApiState(journal, a, apiExpected); assert.equal(api.process.pid, 12345); assert.equal(api.launchId, 'final-after-pg')
  for (const mutate of [v => { v.phase = 'exited' }, v => { v.phase = 'requested' }, v => { v.exit = { code: 0, signal: null } }, v => { v.baseCandidate = 'f'.repeat(64) },
    v => { v.candidate = 'f'.repeat(64) }, v => { v.candidatePath = '/synthetic/stale-candidate.json' }, v => { v.runId = 'other-run' }, v => { v.instance = 'b' },
    v => { v.runtimeVariant = 'rc-before' }, v => { v.runtimeRoot = '/synthetic/original' }, v => { v.launchId = 'stale' }, v => { v.process.startTicks = '123457' },
    v => { v.process.pid = 12346 }, v => { v.process.cwd = '/synthetic/original' }, v => { v.process.executable = '/other/node' }]) {
    const changed = structuredClone(journal); mutate(changed); assert.throws(() => validateP6ApiState(changed, a, apiExpected))
  }
  for (const change of [{ process: { ...journal.process, startTicks: '123457' } }, { process: { ...journal.process, pid: 12346 } }, { fixturePath: '/synthetic/other/fixture-a.json' },
    { apiStatePath: '/synthetic/runtime/api-a-old.json' }, { listener: '' }, { listener: apiExpected.listener.replace('34581', '34582') },
    { listener: apiExpected.listener.replace('pid=12345', 'pid=12346') }, { listener: apiExpected.listener.replace('127.0.0.1', '0.0.0.0') },
    { listener: apiExpected.listener + apiExpected.listener }, { listener: apiExpected.listener.replace('pid=12345,', 'pid=12345,pid=12346,') }]) assert.throws(() => validateP6ApiState(journal, a, { ...apiExpected, ...change }))
  const apiOptions = { ...observerOptions, 'run-id': 'p6-new-acceptance-run', 'api-state-a': apiExpected.apiStatePath, 'api-state-b': '/synthetic/runtime/api-b-final-after-pg.json' }
  const apiJournals = Object.fromEntries([a, b].map((f, index) => ['api-state-' + f.instance, { value: { ...journal, instance: f.instance, process: { ...journal.process, pid: 12345 + index } }, sha256: 'e'.repeat(64) }]))
  const apiInputs = { candidate: { value: { kivo: { root: '/synthetic/kivo', runtime: { variant: 'final', root: runtimeRoot } } }, sha256: candidate }, ...apiJournals }
  const checkApis = new Function('assert', 'finalRuntime', 'readlink', 'realpath', 'processIdentity', 'command', 'validateP6ApiState', 'privateJson', 'return (' + verifyApis.toString() + ')')(
    assert, finalRuntime, async () => executable, async path => path, async pid => structuredClone(Object.values(apiJournals).find(row => row.value.process.pid === pid).value.process),
    async (name, args) => { assert.equal(name, 'ss'); const port = args.at(-1).split(':').at(-1), index = Number(port) - 34581; return apiExpected.listener.replace('34581', port).replace('pid=12345', 'pid=' + (12345 + index)) },
    validateP6ApiState, async path => apiJournals[Object.keys(apiJournals).find(key => apiOptions[key] === path)])
  assert.notEqual(apiOptions['run-id'], a.runId)
  assert.deepEqual((await checkApis(apiOptions, apiInputs, [a, b])).map(row => row.instance), ['a', 'b'])
  const wrongProducer = structuredClone(apiInputs); wrongProducer['api-state-a'].value.runId = apiOptions['run-id']
  await assert.rejects(checkApis(apiOptions, wrongProducer, [a, b]))
  {
    const source = acceptance.toString().match(/  async function openWork\(actor, id, page = pages\[actor\]\) \{[^\n]*\}/)?.[0]; assert(source)
    const id = 'same-work', value = { id }, calls = []; let active = false, selected = id, ready, release, completed = false
    const entered = new Promise(done => { ready = done }), reading = new Promise(done => { release = done })
    const document = { querySelector(selector) { if (selector === '#view-work') return { classList: { contains: key => key === 'active' && active } }; assert.equal(selector, '#repair-actions'); return { dataset: { work: selected } } } }
    const page = { async click(selector) { calls.push(selector) }, async wait(expression) {
      const matches = () => new Function('document', 'return (' + expression + ')')(document)
      assert.equal(matches(), false, 'hidden stale work must not satisfy readiness')
      active = true; selected = 'other-work'; assert.equal(matches(), false, 'another work must not satisfy readiness')
      active = false; selected = id; ready(); await reading; active = true; assert.equal(matches(), true)
    } }
    const open = new Function('pages', 'reload', 'work', 'js', 'return (' + source + ')')({ a: page }, async current => { assert.equal(current, page) }, async (actor, workId) => { assert.equal(actor, 'a'); assert.equal(workId, id); return value }, js)
    const opening = open('a', id).then(result => { completed = true; return result }); await Promise.race([entered, opening]); assert.equal(completed, false); release()
    assert.equal(await opening, value); assert.equal(completed, true); assert.deepEqual(calls, ['#all-work-cards [data-open-work="same-work"]'])
  }
  const advanced = { humanOperation: { action: 'dispatch', auditAction: 'TpmRepairOrder.dispatch' }, event: { action: null, sourceRevision: '1', before: { status: 'reported' }, after: { status: 'dispatched' } } }
  validateP6StatusAdvance(advanced)
  for (const change of [{ action: 'create' }, { action: 'take' }, { sourceRevision: '0' }, { sourceRevision: '01' }, { sourceRevision: 1 }, { before: null }, { after: { status: 'reported', description: 'description-only change' } }, { after: { status: null } }]) assert.throws(() => validateP6StatusAdvance({ ...advanced, event: { ...advanced.event, ...change } }))
  assert.throws(() => validateP6StatusAdvance({ ...advanced, humanOperation: { action: 'take', auditAction: 'TpmRepairOrder.take' } }))
  const initial = migrateState(seedState(migrateState({ version: 3, works: [] }), [a, b], 'ZENMUX_API_KEY', 'P6_SYNTHETIC_FEISHU'))
  assert.equal(initial.automationRules.length, 0); assert.equal(initial.works.length, 0); assert.equal(initial.members.find(m => m.id === 'admin').employeeIds.length, 0)
  for (const mutate of [f => { f.candidate = 'b'.repeat(64) }, f => { f.connection.baseUrl = 'http://127.0.0.1:34381/api/v1/mes/mcp' }, f => { f.facts.clientId = randomUUID() }, f => { f.eventSource.sourceInstance = 'old' }, f => { f.connection.credentialRef = '../secret' }]) {
    const changed = structuredClone(a); mutate(changed); assert.throws(() => validateP6Fixtures(changed, b, catalog))
  }
  const p = correlationFixture({ binding: a.connection, sampleAt: '2026-10-16T09:59:30.000Z' }), w = { status: 'completed', executions: [{ dshSessionRef: 'explicit-pure-not-native' }], results: [{ kind: 'kivo.tpm.device-correlation', input: p.input, payload: p }] }
  validateP6Correlation(w, a)
  const digest = 'b'.repeat(64), id = 'action-' + randomUUID(), createdId = randomUUID(), queriedAt = p.queriedAt
  const action = { id, preview: { digest, target: repairTargetFromCorrelation(p), payload: { orderNo: 'GW-' + id.slice(7), deviceId, reason: '合成原因', description: '合成描述' } },
    receipt: { previewDigest: digest, upstreamRecordId: createdId, recordedAt: queriedAt, orderNo: 'GW-' + id.slice(7), deviceId, status: 'reported', creation: { actorKind: 'machine', machineAccountId: a.connection.clientId, traceId: id, revision: '0' }, currentRevision: '2', replayed: false, queriedAt } }
  const record = { id: createdId, orderNo: action.preview.payload.orderNo, deviceId, detail: { reason: '合成原因', description: '合成描述' }, creation: { actorKind: 'machine', machineAccountId: a.connection.clientId, traceId: id, revision: 0 }, revision: 2 }
  validateP6Creation(action, a, record)
  const createdView = { id, visible: true, status: 'created', summary: '维修单已创建', text: '', fields: { '维修单号': action.preview.payload.orderNo, '上游维修 UUID': createdId, '上游回读时间': queriedAt, '创建版本 / 当前版本': '0 / 2' } }
  validateP6ActionDom(createdView, action, 'created')
  for (const change of [null, { ...createdView, visible: false }, { ...createdView, status: 'preview' }, { ...createdView, id: 'other' }, { ...createdView, fields: { ...createdView.fields, '上游维修 UUID': '' } }, { ...createdView, fields: { ...createdView.fields, '上游回读时间': '' } }]) assert.throws(() => validateP6ActionDom(change, action, 'created'))
  const unknown = { ...action, receipt: null, attempt: { unknownAt: queriedAt } }, unknownView = { ...createdView, status: 'unknown', summary: '创建结果待核对', text: '只按原单号再次核对', reconcile: { visible: true, disabled: false }, approve: null }
  validateP6ActionDom(unknownView, unknown, 'unknown')
  for (const change of [null, { ...unknownView, visible: false }, { ...unknownView, status: 'preview' }, { ...unknownView, reconcile: null }, { ...unknownView, reconcile: { visible: false, disabled: false } }, { ...unknownView, approve: { visible: true, disabled: false } }, { ...unknownView, text: '' }]) assert.throws(() => validateP6ActionDom(change, unknown, 'unknown'))
  assert.equal(unresolvedAction({ works: [{ id: 'unknown-work', actions: [unknown] }] }, 'unknown-work', id).id, id)
  for (const invalid of [action, { ...unknown, attempt: null }, { ...unknown, attempt: { ...unknown.attempt, noEffectAt: queriedAt } }]) assert.throws(() => unresolvedAction({ works: [{ id: 'unknown-work', actions: [invalid] }] }, 'unknown-work', id))
  const rendered = { id: 'pure-correlation', visible: true, fields: { '设备 UUID': p.device.id, 'TPM 记录 UUID / 版本': p.tpm.id + ' / ' + p.tpm.revision,
    '来源创建时间': p.tpm.createdAt ?? '未提供', '来源更新时间': p.tpm.updatedAt ?? '未提供', '采样时间': p.freshness.sampleAt, '采样龄（本次查询）': p.freshness.ageSeconds + ' 秒', '查询时间': p.queriedAt,
    '监控投影时间（非源接收时间）': p.monitoring.snapshotAt, '投影接收标记（非源接收时间）': p.monitoring.receivedAt, '来源接收时间': '未提供', '来源质量': '未提供' },
    source: [p.source.sourceSystem, p.source.sourceInstance, ...Object.values(p.sources).flatMap(s => [s.path, s.queriedAt, s.traceId])].join(' '), text: '来源质量未提供 来源接收时间未提供' }
  validateP6CorrelationDom(rendered, { id: 'pure-correlation', payload: p })
  for (const change of [null, { ...rendered, source: 'wrong-source' }, { ...rendered, text: '' }, { ...rendered, fields: { ...rendered.fields, '采样时间': p.queriedAt } }, { ...rendered, fields: { ...rendered.fields, '来源接收时间': p.queriedAt } }]) assert.throws(() => validateP6CorrelationDom(change, { id: 'pure-correlation', payload: p }))
  for (const change of [{ deviceId: randomUUID() }, { detail: { reason: '其他原因', description: '合成描述' } }, { creation: { ...record.creation, machineAccountId: b.connection.clientId } }]) assert.throws(() => validateP6Creation(action, a, { ...record, ...change }))
  const eventId = randomUUID(), outboxId = randomUUID(), deliveryId = randomUUID(), worker = {
    release: { workerStopped: true, ownedRecordsVerified: true, identity: { runId, candidate: baseCandidate, instance: 'a', superuser: false, entry: 'apps/mes-worker/src/notifications/index.ts', allowlist: ['mes.notification.business-event.v1', 'mes.notification.deliver.v1', 'mes.notification.evaluate.v1'] }, executions: [{ outboxId }], results: [{ failed: 0, deadLettered: 0, lostLease: 0 }] },
    event: { eventId, outboxId, recordType: 'repair', matchedSubscriptionIds: a.facts.subscriptionIds }, deliveries: [{ id: deliveryId, occurrence: { episodeId: eventId, ruleId: a.facts.subscriptionIds[0] }, status: 'accepted', attemptCount: 1, attempts: [{ httpStatus: 202, startedAt: '2026-10-16T10:00:00.000Z', completedAt: '2026-10-16T10:00:00.100Z', wireBodySha256: 'd'.repeat(64) }] }],
  }
  validateP6Worker(worker, a, eventId)
  for (const mutate of [v => { v.release.identity.superuser = true }, v => { v.release.identity.candidate = 'd'.repeat(64) }, v => { v.release.executions = [] }, v => { v.deliveries[0].attempts[0].httpStatus = 503 }, v => { v.deliveries[0].attempts[0].completedAt = '2026-10-16T10:00:10.000Z' }, v => { v.deliveries[0].attemptCount = 2 }]) {
    const changed = structuredClone(worker); mutate(changed); assert.throws(() => validateP6Worker(changed, a, eventId))
  }
  const { EventEmitter } = await import('node:events'), input = new EventEmitter(), binding = { runId: 'pure', candidate: 'a'.repeat(64) }, previousError = console.error
  for (const phase of ['before-restart', 'final-cleanup', 'preserve-first-error', 'normal-stop', 'signal-exit']) {
    const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null }), controller = new AbortController(), writes = [], initial = phase === 'preserve-first-error' ? new Error('original failure') : null
    let failure = initial, closed = 0
    if (initial) controller.abort(initial)
    const fail = error => { failure ??= error; controller.abort(error) }
    const attach = new Function('join', 'openSync', 'writeFileSync', 'closeSync', 'appendFileSync', 'constants', 'return (' + diagnostics.toString() + ')')(
      join, (_path, _flags, mode) => { assert.equal(mode, 0o600); return 9 }, (_path, text, options) => { assert.equal(options.mode, 0o600); writes.push(JSON.parse(text)) },
      fd => { assert.equal(fd, 9); closed += 1 }, () => assert.fail('no stderr bytes expected'), constants)
    child.diagnostics = attach(child, '/synthetic/private', binding, fail)
    const exit = () => { child.exitCode = phase === 'normal-stop' ? 0 : phase === 'signal-exit' ? null : 78; child.signalCode = phase === 'signal-exit' ? 'SIGTERM' : null; child.emit('exit', child.exitCode, child.signalCode); child.emit('close') }
    if (phase === 'final-cleanup') {
      const cleanup = runCleanup({ children: [child], browsers: {}, recording: () => undefined, operationSettled: Promise.resolve(), removeAuth: async () => undefined, onFailure: fail,
        stopChild: async current => { assert.equal(current, child); current.diagnostics.stopRequested(); exit() } })
      await cleanup.run(); assert.equal(cleanup.state.allOwnedProcessesExited, true)
    } else { if (phase === 'normal-stop') child.diagnostics.stopRequested(); exit() }
    assert.equal(child.diagnostics.closed, true); assert.equal(closed, 1); assert.equal(writes.at(-1).exitCode, child.exitCode)
    if (phase === 'normal-stop') { assert.equal(failure, null); assert.equal(controller.signal.aborted, false); assert.equal(writes.at(-1).stopRequests.length, 1) }
    else { assert.equal(controller.signal.aborted, true); assert.equal(failure, initial ?? controller.signal.reason); if (initial) assert.equal(controller.signal.reason, initial); else assert.equal(controller.signal.reason.code, 'OWNED_HOST_EXIT_FAILED'); assert.equal(!failure, false); assert.throws(() => controller.signal.throwIfAborted()) }
  }
  {
    const source = acceptance.toString(), start = source.indexOf('    let failureEvidenceAttempted'), end = source.indexOf('\n  }\n\n  function launch', start)
    const first = source.match(/  const fail = error => \{ failure \?\?= error; abort.abort\(error\) \}/)?.[0]
    assert(start >= 0 && end > start && first)
    const finalizer = new Function('join', 'writeFile', 'options', 'privateRoot', 'steps', 'abort', 'onReady', 'console', 'process', 'interrupts',
      'return async (initial, secondary) => { let failure=initial; const report={}; ' + first + '; onReady(fail); if(secondary)fail(secondary);\n' + source.slice(start, end) + '\nreturn {failure,report} }')
    for (const phase of ['success', 'primary', 'private-write-error', 'late', 'bounded', 'public-write-error', 'primary-and-public-write-error']) {
      const primary = Object.assign(new Error(phase === 'bounded' ? 'x'.repeat(10000) : 'private original message'), { code: 'ERR_ASSERTION' }), secondary = new Error('secondary failure')
      primary.stack = phase === 'bounded' ? 's'.repeat(20000) : 'Error: private original message\n    at private-source:1:2'
      const publicError = Object.assign(new Error('private public-report write failure'), { code: 'EIO' }), publicFails = phase.includes('public-write-error')
      const writes = [], diagnostics = [], summaries = [], exit = { exitCode: 0 }; let inject, privateAttempts = 0, publicWrites = 0, disposed = 0
      const finalize = finalizer(join, async (path, text, options) => {
        assert.equal(options.mode, 0o600)
        if (path === '/synthetic/private/first-failure.json') {
          privateAttempts++; assert.equal(options.flag, 'wx')
          if (phase === 'private-write-error') throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' })
        } else { assert.equal(path, '/synthetic/output/observations.json'); publicWrites++; if (publicFails) throw publicError; if (phase === 'late' && publicWrites === 1) inject(primary) }
        writes.push({ path, value: JSON.parse(text) })
      }, { output: '/synthetic/output' }, '/synthetic/private', [{ id: 'two-instance-correlation', status: phase === 'public-write-error' ? 'passed' : 'failed' }], new AbortController(), fail => { inject = fail },
      { error: text => diagnostics.push(text), log: text => summaries.push(JSON.parse(text)) }, exit, { dispose() { disposed++ } })
      const { failure, report } = await finalize(['success', 'late', 'public-write-error'].includes(phase) ? undefined : primary, phase === 'primary' ? secondary : undefined)
      const expectedError = phase === 'success' ? undefined : phase === 'public-write-error' ? publicError : primary
      assert.equal(failure, expectedError); assert.equal(report.ok, phase === 'success'); assert.equal(exit.exitCode, phase === 'success' ? 0 : 1); assert.equal(disposed, 1)
      assert.equal(privateAttempts, phase === 'success' ? 0 : 1); assert.equal(publicWrites, phase === 'late' ? 2 : 1)
      assert.deepEqual(diagnostics, phase === 'private-write-error' ? ['[accept:p6] private first-failure evidence was not saved'] : [])
      const evidence = writes.find(row => row.path.endsWith('first-failure.json'))?.value
      if (phase === 'success' || phase === 'private-write-error') assert.equal(evidence, undefined)
      else { assert.deepEqual(evidence, { name: expectedError.name, code: expectedError.code, message: expectedError.message.slice(0, 8192), stack: expectedError.stack.slice(0, 16384) }); assert(!evidence.message.includes(secondary.message)) }
      const visible = summaries.at(-1), expectedFailure = expectedError ? { code: expectedError.code, step: phase === 'public-write-error' ? null : 'two-instance-correlation' } : null
      assert.deepEqual(report.failure, expectedFailure); assert.deepEqual(visible.failure, expectedFailure); assert.equal(visible.ok, phase === 'success')
      assert(!JSON.stringify(visible).includes(primary.message)); assert(!JSON.stringify(visible).includes('private-source')); assert(!JSON.stringify(visible).includes(publicError.message))
    }
  }
  const announcements = []; console.error = value => announcements.push(JSON.parse(value))
  const op = operatorChannel(input, binding)
  try { const waiting = op.wait('fixture', 'read-created-repair', { actionId: 'pure' }); input.emit('line', JSON.stringify({ kind: 'p6-operator-result', ...binding, stepId: 'fixture', ok: true, receipt: { actionId: 'pure' } })); assert.deepEqual(await waiting, { actionId: 'pure' }); assert.equal(announcements.length, 1); assert.throws(() => op.wait('fixture', 'read-created-repair')) }
  finally { op.dispose(); console.error = previousError }
  for (const change of [{ runId: 'other' }, { candidate: 'b'.repeat(64) }, { stepId: 'unexpected' }, { ok: false }, { receipt: { accessToken: 'synthetic' } }]) {
    const incoming = new EventEmitter(), boundary = operatorChannel(incoming, binding), previous = console.error; console.error = () => undefined
    try { const waiting = boundary.wait('one', 'read-created-repair'); incoming.emit('line', JSON.stringify({ kind: 'p6-operator-result', ...binding, stepId: 'one', ok: true, receipt: {}, ...change })); await assert.rejects(waiting) }
    finally { boundary.dispose(); console.error = previous }
  }
  const interruptedInput = new EventEmitter(), controller = new AbortController(), interrupted = operatorChannel(interruptedInput, binding, { signal: controller.signal }), previous = console.error; console.error = () => undefined
  try { const waiting = interrupted.wait('interrupted', 'read-created-repair'); controller.abort(); await assert.rejects(waiting, /interrupted/) }
  finally { interrupted.dispose(); console.error = previous }
  assert.deepEqual(Object.keys(stepTitles).sort(), [...P6_STEPS].sort())
  const geometry = { width: 390, content: { visible: true, left: 0, right: 390, clientWidth: 390, scrollWidth: 390 }, cards: [{ visible: true, left: 16, right: 374, clientWidth: 358, scrollWidth: 358 }] }
  validateP6ContentGeometry(geometry)
  for (const mutate of [v => { v.content.scrollWidth = 640 }, v => { v.cards[0].scrollWidth = 600 }, v => { v.cards[0].right = 640 }, v => { v.content.left = 20 }, v => { v.content.visible = false }, v => { v.cards = [] }]) {
    const changed = structuredClone(geometry); mutate(changed); assert.throws(() => validateP6ContentGeometry(changed))
  }
  {
    const source = acceptance.toString().match(/  async function workContentFits\(page, required = false\) \{[\s\S]*?\n  \}/)?.[0]; assert(source)
    const inspect = new Function('assert', 'js', 'cap', 'validateP6ContentGeometry', 'return (' + source + ')')(assert, js, cap, validateP6ContentGeometry)
    const node = value => ({ ...value, getBoundingClientRect: () => value, getClientRects: () => value.visible ? [{}] : [] })
    const page = (value, capabilityId = cap) => ({ size: () => ({ width: 390 }), async evaluate(expression) {
      const document = { querySelector(selector) { return selector === '#view-work.active' ? value && { querySelectorAll: () => value.cards.map(node) } : node(value.content) } }
      return new Function('document', 'state', 'getComputedStyle', 'innerWidth', 'return ' + expression)(document, { currentWork: { capabilityId } }, item => ({ visibility: item.visible ? 'visible' : 'hidden' }), value?.width)
    } })
    await inspect(page(geometry), true); await inspect(page(null)); await inspect(page(geometry, 'kivo-tpm-record-read'))
    await assert.rejects(inspect(page(null), true)); await assert.rejects(inspect(page(geometry, 'kivo-tpm-record-read'), true))
    await assert.rejects(inspect(page({ ...geometry, content: { ...geometry.content, scrollWidth: 640 } }), true))
  }
  {
    const source = acceptance.toString(), start = source.indexOf('      const declined = await poll('), end = source.indexOf('\n      const w = await work(\'a\', refs.a);', start); assert(start > 0 && end > start)
    for (const phase of ['rejected', 'undecided', 'attempted', 'receipted', 'wrong-http-status']) {
      const action = { id: 'rejected-action', decision: phase === 'undecided' ? null : { kind: 'rejected' }, attempt: phase === 'attempted' ? {} : null, receipt: phase === 'receipted' ? {} : null }
      const seen = [], pages = { a: {}, conflict: null }, facts = [], conflictPage = { responses: [], child: {}, socket: { close() { seen.push('socket-close') } }, async front() { seen.push('front') },
        async evaluate() { return null }, async wait(expression) { assert(expression.includes('#repair-message.error')) },
        async click(selector) { assert.equal(selector, 'old-approve'); seen.push('click'); this.responses.push({ path: '/api/works/:id/actions/rejected-action/approve', status: phase === 'wrong-http-status' ? 200 : 409 }) } }
      pages.conflict = conflictPage
      const check = new Function('assert', 'poll', 'work', 'refs', 'rejected', 'pages', 'actionDom', 'conflictPage', 'js', 'workContentFits', 'oldApprove', 'capture', 'facts', 'stopOwned', 'return (async () => {' + source.slice(start, end) + '\n})()')(
        assert, async read => { const value = await read(); assert(value, 'the actual conflict condition is required'); return value },
        async () => { seen.push('durable-get'); return { actions: [structuredClone(action)] } }, { a: 'same-work' }, action, pages,
        async (page, value, status) => { assert.equal(value.decision.kind, status); seen.push('dom-' + status) }, conflictPage, js,
        async (page, required) => { assert.equal(page, conflictPage); assert.equal(required, true); seen.push('geometry') }, 'old-approve', async () => seen.push('capture'), facts, async () => seen.push('stop-owned'))
      if (phase === 'rejected') { await check; assert(seen.indexOf('durable-get') < seen.indexOf('click')); assert(seen.indexOf('front') >= 0 && seen.indexOf('front') < seen.indexOf('geometry') && seen.indexOf('geometry') < seen.indexOf('click')); assert.equal(seen.filter(item => item === 'click').length, 1); assert.equal(facts[0].responseStatus, 409); assert.equal(pages.conflict, undefined) }
      else { await assert.rejects(check); if (phase !== 'wrong-http-status') assert(!seen.includes('click')) }
    }
  }
  {
    const handoff = acceptance.toString().match(/      await pages\.a\.front\(\); await pages\.a\.click\('#repair-save-preview'\)/)?.[0]; assert(handoff)
    const seen = [], pages = { a: { async front() { seen.push('front') }, async click(selector) { assert.equal(selector, '#repair-save-preview'); assert.deepEqual(seen, ['front']); seen.push('click') } } }
    await new Function('pages', 'return (async () => {' + handoff + '})()')(pages); assert.deepEqual(seen, ['front', 'click'])
  }
  const timeline = P6_STEPS.map((id, index) => ({ id, status: 'passed', startSeconds: index * 2, endSeconds: index * 2 + 1,
    screenshots: [{ file: 'step-' + String(index + 1).padStart(2, '0') + '-01.png', seconds: index * 2 + 0.5, viewport: { width: ['preview-without-write', 'owner-approval', 'revocation', 'unknown-readback', 'backup-restore'].includes(id) ? 390 : 1440 } }] }))
  validateP6Timeline(timeline)
  assert.throws(() => validateP6Timeline(timeline.slice(1)))
  for (const mutate of [v => { v[0].screenshots = [] }, v => { v[1].startSeconds = 0 }, v => { v[2].screenshots[0].seconds = 999 }, v => { v[2].screenshots[0].viewport.width = 1440 }, v => { v[12].status = 'failed' }]) {
    const changed = structuredClone(timeline); mutate(changed); assert.throws(() => validateP6Timeline(changed))
  }
  for (const id of ['owner-approval', 'revocation', 'unknown-readback', 'backup-restore']) {
    const changed = structuredClone(timeline); changed.find(step => step.id === id).screenshots[0].viewport.width = 1440; assert.throws(() => validateP6Timeline(changed))
  }
  let clock = 1000
  const lifecycle = [], recorderFailures = [], fakeChild = () => Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null, stdin: new EventEmitter() })
  const recorderChild = fakeChild()
  recorderChild.stdin.end = value => { assert.equal(value, 'q\n'); lifecycle.push('finish-request'); recorderChild.exitCode = 0; recorderChild.emit('exit', 0, null); lifecycle.push('recorder-exit') }
  const recorder = watchRecording(recorderChild, error => recorderFailures.push(error), () => clock)
  recorder.assertRunning(); clock = 28_000
  const cleaning = runCleanup({ children: [recorderChild], browsers: { a: { socket: { close() { lifecycle.push('page-close') } } } }, recording: () => recorder,
    operationSettled: Promise.resolve(), removeAuth: async () => { lifecycle.push('auth-remove') }, onFailure: error => recorderFailures.push(error), stopChild: async child => { assert.equal(child.exitCode, 0); lifecycle.push('stop-owned') } })
  await cleaning.run(); await cleaning.run()
  assert.deepEqual(lifecycle, ['finish-request', 'recorder-exit', 'page-close', 'stop-owned', 'auth-remove']); assert.deepEqual(recorderFailures, [])
  const probe = { streams: [{ codec_type: 'video', codec_name: 'h264', duration: '27' }], format: { duration: '27' } }
  assert.equal(recordingCoverage(recorder.state, probe, timeline).expectedCoverageSeconds, 27)
  assert.throws(() => recordingCoverage(recorder.state, { ...probe, format: { duration: '26' } }, timeline))
  assert.throws(() => recordingCoverage({ ...recorder.state, exitCode: 1 }, probe, timeline))
  assert.throws(() => recordingCoverage(recorder.state, { ...probe, streams: [{ codec_type: 'video', codec_name: 'unknown', duration: '27' }] }, timeline))
  const earlyChild = fakeChild(), earlyFailures = [], early = watchRecording(earlyChild, error => earlyFailures.push(error), () => clock)
  earlyChild.exitCode = 1; earlyChild.emit('exit', 1, null); assert.equal(earlyFailures.length, 1); assert.throws(() => early.assertRunning()); await assert.rejects(early.finish())
  const mouse = [], box = { x: 10, y: 20, width: 100, height: 100, visible: true, disabled: false, hit: true }
  const mousePage = value => ({ async front() { mouse.push('front') }, async evaluate(code) { return code.includes('getBoundingClientRect') ? value : undefined }, async send(method, params) { assert.equal(method, 'Input.dispatchMouseEvent'); mouse.push(params) } })
  await doubleClickControl(mousePage(box), '#owned-action')
  assert.equal(mouse[0], 'front'); assert.deepEqual(mouse.filter(item => item?.button).map(item => [item.type, item.clickCount]), [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]])
  for (const change of [{ disabled: true }, { visible: false }, { hit: false }, { x: -1 }]) await assert.rejects(doubleClickControl(mousePage({ ...box, ...change }), '#owned-action'))
  for (const vector of [{ code: 'ESRCH', drained: true }, { code: 'ESRCH', drained: false }, { code: 'EPERM', drained: true }, { code: null, drained: true }]) {
    const child = { pid: 123456, signalCode: null }, signalError = vector.code ? Object.assign(new Error('synthetic group signal failure'), { code: vector.code }) : null
    let reads = 0, nowCalls = 0, kills = 0, polls = 0
    const clean = new Function('stop', 'gone', 'process', 'poll', 'assert', 'Date', 'setTimeout', 'return (' + stopOwned.toString() + ')')(
      async () => undefined, () => ++reads >= 3 && vector.drained,
      { kill(pid, signal) { assert.equal(pid, -child.pid); assert.equal(signal, 'SIGKILL'); kills++; if (signalError) throw signalError; return true } },
      async check => { polls++; assert.equal(check(), true) }, assert, { now: () => nowCalls++ === 0 ? 0 : 10_000 }, () => assert.fail('group race check must not start a real timer'))
    const pending = clean(child)
    if (vector.code === 'ESRCH' && vector.drained) { await pending; assert.equal(polls, 1) }
    else if (signalError) await assert.rejects(pending, error => error === signalError)
    else await assert.rejects(pending, /owned process required forced cleanup/)
    assert.equal(kills, 1)
  }
  console.log(JSON.stringify({ ok: true, checks: ['strict-cli', 'ordered-required-journey', 'original-base-versus-current-api-candidate', 'current-final-api-identity-and-listener', 'producer-run-versus-new-acceptance-run', 'bound-observer-config-and-three-files', 'guard-before-observer-and-recovery-config', 'fatal-host-exit-before-restart-and-final-cleanup', 'actual-dispatch-status-change-subscription', 'actual-schema-seed', 'correlation-identity-and-time', 'actual-correlation-dom', 'actual-action-terminal-dom', 'unknown-survives-until-explicit-reconcile', 'creation-readback-binding', 'producer-worker-and-ack', 'model-no-write-or-other', 'safe-receipt-boundary', 'bound-operator-receipt', 'interrupted-operator', 'same-run-video-timeline', 'recorder-finishes-before-cleanup', 'video-coverage-and-exit-negatives', 'native-double-click-events', 'owned-process-group-signal-races', 'mobile-content-and-card-geometry', 'required-phone-operation-timeline', 'mobile-conflict-after-durable-rejection'], runtimeStarts: 0, listeners: 0, nativeStarts: 0, modelRequests: 0, databaseRequests: 0, secretReads: 0 }))
}
