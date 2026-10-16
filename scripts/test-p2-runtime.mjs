import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CYCLE_TIME_TOOL,
  GEARJOB_TOOL,
  listCapabilities,
  sanitizeFollowUpContext,
  validateCapabilityInput,
  WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
  WORK_ORDER_DEVICE_CORRELATION_TOOL,
} from '../src/capabilities.mjs'
import { createDshRunner, parseRunResult } from '../src/dsh-runner.mjs'
import { authorizeExecutionGrant, connectionSnapshot, consumeExecutionGrant, resolveCredentialFile } from '../src/execution-grant.mjs'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'
import { apply as applyCycle } from '../plugins/cycle-time.mjs'
import { normalizeGearJobRecord } from '../plugins/gearjob-work-order.mjs'

const args = process.argv.slice(2)
assert(args.every(arg => arg === '--pure-only'), '本测试仅接受 --pure-only；默认入口包含实际 cycle 插件生命周期检查')
const pureOnly = args.includes('--pure-only')
const root = await mkdtemp(join(tmpdir(), 'geneway-p2-runtime-'))
const previousDshHome = process.env.DSH_HOME, previousGrant = process.env.GENEWAY_DSH_GRANT_FILE
const originalFetch = globalThis.fetch
let fetchCalls = 0
if (pureOnly) globalThis.fetch = () => { fetchCalls += 1; throw new Error('--pure-only must not perform network I/O') }
process.env.DSH_HOME = join(root, 'dsh-native')

try {
  testCapabilities()
  testParsers()
  const fixture = await testGrantAndCredentialBoundary()
  testHistoricalSourceMetadata()
  await testSessionMetadata()
  await testConnectionSessionMetadata()
  await testImmediateCancellation()
  if (!pureOnly) await testCyclePluginLifecycle(fixture)
  if (pureOnly) assert.equal(fetchCalls, 0)
  console.log(pureOnly
    ? 'P2 pure capability/parser/grant/fake-harness checks passed; native cycle mount/dispose/remount skipped (--pure-only)'
    : 'P2 runtime and capability checks passed (actual cycle plugin lifecycle included)')
} finally {
  if (previousGrant === undefined) delete process.env.GENEWAY_DSH_GRANT_FILE
  else process.env.GENEWAY_DSH_GRANT_FILE = previousGrant
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  globalThis.fetch = originalFetch
  await rm(root, { recursive: true, force: true })
}

function testCapabilities() {
  const capabilities = listCapabilities()
  assert.deepEqual(capabilities.map(item => item.id), ['kivo-tpm-device-correlate', 'gearjob-work-order-read', 'cycle-time-calculate', WORK_ORDER_DEVICE_CORRELATION_CAPABILITY, 'kivo-tpm-record-read', 'kivo-tpm-record-list'])
  const correlation = capabilities.find(item => item.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY)
  assert.deepEqual(Object.fromEntries(['id', 'skillId', 'action', 'toolName', 'pluginId', 'pluginVersion', 'resultKind', 'requiredInputs', 'requiresConnection', 'connectionKind'].map(key => [key, correlation[key]])), {
    id: WORK_ORDER_DEVICE_CORRELATION_CAPABILITY,
    skillId: 'skill-manufacturing-work-order-device-correlate',
    action: 'manufacturing.work-order-device.correlate',
    toolName: WORK_ORDER_DEVICE_CORRELATION_TOOL,
    pluginId: 'geneway-work-order-device-correlation',
    pluginVersion: '1',
    resultKind: 'manufacturing.work-order-device-correlation',
    requiredInputs: ['workOrderId'],
    requiresConnection: true,
    connectionKind: null,
  })
  assert.deepEqual(validateCapabilityInput('gearjob-work-order-read', {}, { allowMissing: true }).missing, ['workOrderId'])
  assert.equal(validateCapabilityInput('gearjob-work-order-read', { workOrderId: ' WO-1 ' }).input.workOrderId, 'WO-1')
  assert.equal(validateCapabilityInput('cycle-time-calculate', { availableSeconds: 'bad' }, { allowMissing: true }).error.code, 'INVALID_AVAILABLE_SECONDS_TYPE')
  assert.deepEqual(validateCapabilityInput('cycle-time-calculate', { availableSeconds: 0 }, { allowMissing: true }), { ok: true, input: { availableSeconds: 0 }, missing: ['quantity'] })
  assert.equal(validateCapabilityInput('cycle-time-calculate', { availableSeconds: 0, quantity: 60 }).input.availableSeconds, 0)
  assert.equal(calculateCycleTime({ availableSeconds: Number.MAX_VALUE, quantity: Number.MIN_VALUE }).error.code, 'NON_FINITE_RESULT')
  for (const input of [
    { availableSeconds: 1, quantity: 0 },
    { availableSeconds: -1, quantity: 1 },
    { availableSeconds: Number.NaN, quantity: 1 },
    { availableSeconds: 1, quantity: Number.POSITIVE_INFINITY },
  ]) assert.equal(validateCapabilityInput('cycle-time-calculate', input).ok, false)
  assert.throws(() => sanitizeFollowUpContext({
    question: '为什么',
    facts: [{ kind: 'manufacturing.takt', payload: { availableSeconds: 60, quantity: 1, secondsPerUnit: 60, unit: 'seconds/unit' }, explanation: '禁止复制' }],
    confirmations: [],
  }), /未声明字段/)
}

function testParsers() {
  const gearPayload = {
    ok: true,
    workOrderId: 'WO-1',
    status: 'In Process',
    plannedQuantity: 10,
    completedQuantity: 2,
    unit: 'Nos',
    sourceRecordId: 'Work Order:WO-1',
    sourceSystem: 'GearJob',
    sourceInstance: 'A',
    sourceEnvironment: 'external-test',
    dataMode: 'synthetic',
    evidenceMode: 'real-frappe-rest',
  }
  const gear = interval(GEARJOB_TOOL, { workOrderId: 'WO-1' }, gearPayload)
  assert.equal(parseRunResult(gear, { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }).result.kind, 'gearjob.work-order.observation')
  assert.throws(() => parseRunResult({ events: [], finalResponse: 'ok' }, { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }), /恰好有一次/)
  assert.throws(() => parseRunResult({ ...gear, events: [...gear.events, gear.events[0]] }, { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }), /恰好有一次/)
  assert.throws(() => parseRunResult(interval(CYCLE_TIME_TOOL, { workOrderId: 'WO-1' }, gearPayload), { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }), /非预期工具/)
  assert.throws(() => parseRunResult(interval(GEARJOB_TOOL, { workOrderId: 'WO-2' }, gearPayload), { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }), /参数与能力输入不匹配/)
  const emptyCall = interval(GEARJOB_TOOL, { workOrderId: 'WO-1' }, gearPayload)
  emptyCall.events[0].data.callId = ''
  assert.throws(() => parseRunResult(emptyCall, { capabilityId: 'gearjob-work-order-read', input: { workOrderId: 'WO-1' } }), /callId/)
  assert.throws(() => parseRunResult(interval(CYCLE_TIME_TOOL, { availableSeconds: 3600, quantity: 60 }, { ok: true, availableSeconds: 3600, quantity: 60, secondsPerUnit: 61, unit: 'seconds\/unit' }), { capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 } }), /确定性输入不匹配/)
  assert.throws(() => parseRunResult({ events: gear.events, finalResponse: 'ok' }, { operation: 'follow-up', capabilityId: 'gearjob-work-order-read' }), /禁止调用工具/)
}

async function testGrantAndCredentialBoundary() {
  const policyFile = join(root, 'state.json')
  const secretRoot = join(root, 'secrets')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(secretRoot, { mode: 0o700 }))
  const connection = sourceConnection('connection-a', 'http://127.0.0.1:1', 'A', 'real-frappe-rest')
  assert.throws(() => connectionSnapshot({ ...connection, revision: 0 }), /revision/)
  assert.throws(() => connectionSnapshot({ ...connection, revision: 1.5 }), /revision/)
  const cycleState = stateFor('exec-cycle')
  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })

  const wrongGrant = join(root, 'wrong-grant.json')
  await writeFile(wrongGrant, JSON.stringify(grantFor({ executionId: 'exec-cycle', policyFile, secretRoot })), { mode: 0o600 })
  await assert.rejects(() => consumeExecutionGrant({ filePath: wrongGrant, toolName: GEARJOB_TOOL, input: { workOrderId: 'WO-1' } }), error => error.code === 'FORBIDDEN')
  await assert.rejects(() => consumeExecutionGrant({ filePath: wrongGrant, toolName: CYCLE_TIME_TOOL, input: { availableSeconds: 3600, quantity: 60 } }), /不可用/)

  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })
  const cycleGrant = join(root, 'cycle-grant.json')
  const cycleGrantValue = grantFor({ executionId: 'exec-cycle', policyFile, secretRoot })
  await writeFile(cycleGrant, JSON.stringify(cycleGrantValue), { mode: 0o600 })
  const consumed = await consumeExecutionGrant({ filePath: cycleGrant, toolName: CYCLE_TIME_TOOL, input: { availableSeconds: 3600, quantity: 60 } })
  assert.equal((await authorizeExecutionGrant(consumed)).execution.id, 'exec-cycle')

  const revoked = structuredClone(cycleState)
  revoked.skills[0].enabled = false
  await writeFile(policyFile, JSON.stringify(revoked), { mode: 0o600 })
  await assert.rejects(() => authorizeExecutionGrant(consumed), error => error.code === 'FORBIDDEN' && /能力绑定/.test(error.message))
  for (const mutate of [
    state => { delete state.members[0].enabled },
    state => { state.employees[0].enabled = 'true' },
    state => { state.skills[0].enabled = false },
    state => { state.modelRoutes[0].enabled = 1 },
  ]) {
    const malformed = structuredClone(cycleState)
    mutate(malformed)
    await writeFile(policyFile, JSON.stringify(malformed), { mode: 0o600 })
    await assert.rejects(() => authorizeExecutionGrant(consumed), error => error.code === 'FORBIDDEN')
  }
  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })

  const confirmationState = structuredClone(cycleState)
  confirmationState.confirmations = [{ id: 'confirmation-1', ownerMemberId: 'member-user', employeeId: 'employee-b', revision: 1, status: 'active' }]
  await writeFile(policyFile, JSON.stringify(confirmationState), { mode: 0o600 })
  const confirmationGrantFile = join(root, 'confirmation-grant.json')
  const confirmationGrant = { ...cycleGrantValue, confirmationFingerprint: 'confirmation-1:1', confirmationRefs: [{ id: 'confirmation-1', revision: 1 }] }
  await writeFile(confirmationGrantFile, JSON.stringify(confirmationGrant), { mode: 0o600 })
  const confirmationConsumed = await consumeExecutionGrant({ filePath: confirmationGrantFile, toolName: CYCLE_TIME_TOOL, input: { availableSeconds: 3600, quantity: 60 } })
  await authorizeExecutionGrant(confirmationConsumed)
  confirmationState.confirmations[0] = { ...confirmationState.confirmations[0], revision: 2 }
  await writeFile(policyFile, JSON.stringify(confirmationState), { mode: 0o600 })
  await assert.rejects(() => authorizeExecutionGrant(confirmationConsumed), /确认信息 revision/)
  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })

  const escape = join(root, 'credential-link')
  await symlink('/etc/passwd', escape)
  await assert.rejects(() => resolveCredentialFile(root, 'credential-link'), /符号链接/)
  await writeFile(join(root, 'insecure-secret'), 'not-a-secret', { mode: 0o644 })
  await assert.rejects(() => resolveCredentialFile(root, 'insecure-secret'), /0600/)
  return { cycleState, cycleGrantValue, policyFile }
}

function testHistoricalSourceMetadata() {
  const sourceA = sourceConnection('a', 'http://127.0.0.1:1', 'actual-A', 'real-frappe-rest')
  const sourceB = { ...sourceConnection('b', 'http://127.0.0.1:1', 'controlled-B', 'controlled-frappe-compatible'), sourceSystem: 'GearJob-compatible', sourceEnvironment: 'controlled-test', dataMode: 'synthetic-controlled' }
  const raw = { name: 'WO-1', status: 'Draft', qty: 10, produced_qty: 2, source_system: 'untrusted-upstream', source_environment: 'production' }
  const a = normalizeGearJobRecord(raw, { id: 'WO-1', source: sourceA })
  const b = normalizeGearJobRecord(raw, { id: 'WO-1', source: sourceB })
  assert.deepEqual([a.sourceSystem, a.sourceInstance, a.sourceEnvironment, a.evidenceMode], ['GearJob', 'actual-A', 'external-test', 'real-frappe-rest'])
  assert.deepEqual([b.sourceSystem, b.sourceInstance, b.sourceEnvironment, b.dataMode, b.evidenceMode], ['GearJob-compatible', 'controlled-B', 'controlled-test', 'synthetic-controlled', 'controlled-frappe-compatible'])
}

async function testCyclePluginLifecycle({ cycleState, cycleGrantValue, policyFile }) {
  const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
  const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const host = new Context()
  let cycleFiber
  try {
    await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await host.plugin(ToolRuntime, { mode: 'native' })
    cycleFiber = host.plugin(Object.assign(applyCycle, { inject: ['tools'] }))
    await cycleFiber
    assert.deepEqual(host.tools.schemas().map(item => item.name), [CYCLE_TIME_TOOL])
    await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })
    const actualGrant = join(root, 'actual-cycle-grant.json')
    await writeFile(actualGrant, JSON.stringify(cycleGrantValue), { mode: 0o600 })
    process.env.GENEWAY_DSH_GRANT_FILE = actualGrant
    const result = await host.tools.execute({ callId: 'cycle', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.secondsPerUnit, 60)
    assert.deepEqual(host.tools.get(CYCLE_TIME_TOOL).output.render({}, result.value), [{ type: 'text', text: JSON.stringify(result.value) }])
    await cycleFiber.dispose()
    cycleFiber = undefined
    assert.deepEqual(host.tools.schemas().map(item => item.name), [])
    const unavailableCycle = await host.tools.execute({ callId: 'cycle-disposed', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(unavailableCycle.isError, true)
    assert.equal(unavailableCycle.error.info.code, 'UNKNOWN_TOOL')
    cycleFiber = host.plugin(Object.assign(applyCycle, { inject: ['tools'] }))
    await cycleFiber
    assert.deepEqual(host.tools.schemas().map(item => item.name), [CYCLE_TIME_TOOL])
    const remountGrant = join(root, 'remount-cycle-grant.json')
    await writeFile(remountGrant, JSON.stringify(cycleGrantValue), { mode: 0o600 })
    process.env.GENEWAY_DSH_GRANT_FILE = remountGrant
    const remountedCycle = await host.tools.execute({ callId: 'cycle-remounted', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(remountedCycle.isError, false)
    assert.equal(remountedCycle.value.secondsPerUnit, 60)
  } finally {
    await cycleFiber?.dispose()
    await host.fiber.dispose()
  }
}

async function testSessionMetadata() {
  const dshHome = join(root, 'dsh')
  const harnesses = []
  const prompts = []
  const runner = createDshRunner({
    root: process.cwd(),
    config: {
      model: { configured: true, provider: 'test', model: 'test' },
      source: { configured: true },
      dshHome,
      stateFile: join(root, 'state.json'),
      dataRoot: root,
      secretRoot: join(root, 'secrets'),
    },
    harnessFactory: () => {
      const index = harnesses.length + 1
      const harness = {
        closes: 0,
        async run(prompt) { prompts.push(prompt); return { ...interval(CYCLE_TIME_TOOL, { availableSeconds: 3600, quantity: 60 }, { ok: true, availableSeconds: 3600, quantity: 60, secondsPerUnit: 60, unit: 'seconds/unit' }), sessionId: `session-${index}` } },
        async close() { this.closes += 1 },
      }
      harnesses.push(harness)
      return harness
    },
  })
  const metadata = {
    ownerMemberId: 'member-user',
    workId: 'work-cycle',
    employeeId: 'employee-b',
    skillId: 'skill-cycle-time-calculate',
    capabilityId: 'cycle-time-calculate',
    connectionId: null,
    connectionRevision: null,
    modelRouteId: 'model-zenmux',
    confirmationFingerprint: 'none',
    confirmationRefs: [],
  }
  const grant = { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets') }
  const first = await runner.run({ executionId: 'one', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 }, sessionMetadata: metadata, grant })
  const second = await runner.run({ executionId: 'two', sessionId: first.dshSessionRef, capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 }, sessionMetadata: metadata, grant })
  assert.equal(second.continuity, 'same-session')
  assert.equal(harnesses.length, 1)
  const changed = await runner.run({ executionId: 'three', sessionId: first.dshSessionRef, capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 }, sessionMetadata: { ...metadata, confirmationFingerprint: 'changed', confirmationRefs: [{ id: 'confirmation-1', revision: 2 }] }, confirmations: [{ id: 'confirmation-1', revision: 2, label: '班次', value: '夜班' }], grant })
  assert.equal(changed.continuity, 'successor')
  assert.equal(changed.continuedFromDshSessionRef, first.dshSessionRef)
  assert.deepEqual(changed.contextConfirmationRefs, [{ id: 'confirmation-1', revision: 2 }])
  assert.equal(harnesses.length, 2)
  assert.equal(harnesses[0].closes, 1)
  assert.match(prompts.at(-1), /"label":"班次","value":"夜班"/)
  assert.deepEqual(await readdir(join(dshHome, 'grants')), [])
  await runner.close()
}

async function testConnectionSessionMetadata() {
  const dshHome = join(root, 'connection-metadata-dsh')
  let factories = 0, modelRuns = 0, closes = 0
  const connection = {
    id: 'connection-metadata', revision: 1, kind: 'kivo-mcp', targetIdentity: 'metadata-fixture',
    baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: '00000000-0000-4000-8000-000000000003',
    credentialRef: 'metadata.pem', allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'metadata-fixture', sourceEnvironment: 'test', dataMode: 'synthetic', evidenceMode: 'controlled',
  }
  const metadata = connectionRevision => ({ ...cycleSessionMetadata(), workId: 'work-tpm', skillId: 'skill-kivo-tpm-record-read', capabilityId: 'kivo-tpm-record-read', connectionId: connection.id, connectionRevision })
  const options = connectionRevision => ({ executionId: `connection-revision-${connectionRevision}`, capabilityId: 'kivo-tpm-record-read', input: { recordType: 'repair', reference: 'R-1' }, sessionMetadata: metadata(connectionRevision), grant: { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets'), connection } })
  const runner = createDshRunner({
    root: process.cwd(),
    config: { model: { configured: true, provider: 'test', model: 'test' }, source: { configured: true }, dshHome, stateFile: join(root, 'state.json'), dataRoot: root, secretRoot: join(root, 'secrets') },
    harnessFactory: () => {
      factories += 1
      return { async run() { modelRuns += 1; throw new Error('metadata checks must precede model run') }, async close() { closes += 1 } }
    },
  })
  try {
    for (const revision of [0, 1.5]) {
      await assert.rejects(() => runner.run(options(revision)), error => error.code === 'INVALID_REQUEST' && /连接版本/.test(error.message))
      assert.deepEqual([factories, modelRuns, closes], [0, 0, 0])
      await assert.rejects(() => readdir(dshHome), { code: 'ENOENT' })
    }
    await assert.rejects(() => runner.run(options(2)), error => error.code === 'INVALID_REQUEST' && /连接快照不匹配/.test(error.message))
    assert.deepEqual([factories, modelRuns, closes], [1, 0, 1])
    assert.deepEqual(await readdir(join(dshHome, 'grants')), [])
  } finally {
    await runner.close()
  }
  assert.deepEqual([factories, modelRuns, closes], [1, 0, 1])
}

async function testImmediateCancellation() {
  const dshHome = join(root, 'cancel-dsh')
  let factories = 0
  let closes = 0
  const runner = createDshRunner({
    root: process.cwd(),
    config: {
      model: { configured: true, provider: 'test', model: 'test' },
      source: { configured: true },
      dshHome,
      stateFile: join(root, 'state.json'),
      dataRoot: root,
      secretRoot: join(root, 'secrets'),
    },
    harnessFactory: () => {
      factories += 1
      return { async run() { throw new Error('synthetic harness failure') }, async close() { closes += 1 } }
    },
  })
  await assert.rejects(() => runner.run({ executionId: 'missing-metadata', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 } }), /Session metadata/)
  assert.equal(factories, 0)
  const pending = runner.run({
    executionId: 'cancel-before-initialize',
    capabilityId: 'cycle-time-calculate',
    input: { availableSeconds: 3600, quantity: 60 },
    sessionMetadata: {
      ownerMemberId: 'member-user',
      workId: 'work-cycle',
      employeeId: 'employee-b',
      skillId: 'skill-cycle-time-calculate',
      capabilityId: 'cycle-time-calculate',
      connectionId: null,
      connectionRevision: null,
      modelRouteId: 'model-zenmux',
      confirmationFingerprint: 'none',
      confirmationRefs: [],
    },
    grant: { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets') },
  })
  assert.equal(await runner.cancel('cancel-before-initialize'), true)
  await assert.rejects(() => pending, error => error.code === 'CANCELLED')
  assert.equal(factories, 0)
  assert.deepEqual(await readdir(join(dshHome, 'grants')), [])
  await assert.rejects(() => runner.run({
    executionId: 'failed-after-initialize',
    capabilityId: 'cycle-time-calculate',
    input: { availableSeconds: 3600, quantity: 60 },
    sessionMetadata: cycleSessionMetadata(),
    grant: { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets') },
  }), /synthetic harness failure/)
  assert.equal(factories, 1)
  assert.equal(closes, 1)
  assert.deepEqual(await readdir(join(dshHome, 'grants')), [])
  await runner.close()
}

function cycleSessionMetadata() {
  return {
    ownerMemberId: 'member-user',
    workId: 'work-cycle',
    employeeId: 'employee-b',
    skillId: 'skill-cycle-time-calculate',
    capabilityId: 'cycle-time-calculate',
    connectionId: null,
    connectionRevision: null,
    modelRouteId: 'model-zenmux',
    confirmationFingerprint: 'none',
    confirmationRefs: [],
  }
}

function interval(toolName, args, value) {
  const callId = 'call-1'
  return {
    events: [
      { type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(args) } },
      { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } } },
    ],
    finalResponse: '结构化结果说明',
  }
}

function sourceConnection(id, baseUrl, sourceInstance, evidenceMode, allowedObjectIds = ['WO-1']) {
  return {
    id,
    revision: 1,
    kind: 'gearjob-rest',
    targetIdentity: sourceInstance,
    baseUrl,
    credentialRef: id === 'connection-a' ? 'source-a.json' : 'source.json',
    allowedObjectIds,
    sourceSystem: 'GearJob',
    sourceInstance,
    sourceEnvironment: 'external-test',
    dataMode: 'synthetic',
    evidenceMode,
  }
}

function grantFor({ executionId, policyFile, secretRoot }) {
  return {
    version: 2,
    executionId,
    memberId: 'member-user',
    employeeId: 'employee-b',
    skillId: 'skill-cycle-time-calculate',
    capabilityId: 'cycle-time-calculate',
    workId: 'work-cycle',
    modelRouteId: 'model-zenmux',
    operation: 'create',
    expectedTool: CYCLE_TIME_TOOL,
    input: { availableSeconds: 3600, quantity: 60 },
    connection: null,
    confirmationFingerprint: 'none',
    confirmationRefs: [],
    policyFile,
    policyRoot: root,
    secretRoot,
  }
}

function stateFor(executionId) {
  const skillId = 'skill-cycle-time-calculate', capabilityId = 'cycle-time-calculate'
  return {
    version: 4,
    members: [{ id: 'member-user', enabled: true, employeeIds: ['employee-b'] }],
    modelRoutes: [{ id: 'model-zenmux', enabled: true }],
    employees: [{ id: 'employee-b', enabled: true, modelRouteId: 'model-zenmux', skillIds: [skillId], connectionIds: [] }],
    skills: [{ id: skillId, enabled: true, capabilityId }],
    connections: [],
    works: [{ id: 'work-cycle', ownerMemberId: 'member-user', employeeId: 'employee-b', skillId, capabilityId, executions: [{ id: executionId, operation: 'create', status: 'running' }] }],
  }
}
