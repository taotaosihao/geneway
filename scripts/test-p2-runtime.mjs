import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  CYCLE_TIME_TOOL,
  GEARJOB_TOOL,
  listCapabilities,
  sanitizeFollowUpContext,
  validateCapabilityInput,
} from '../src/capabilities.mjs'
import { createDshRunner, parseRunResult } from '../src/dsh-runner.mjs'
import { authorizeExecutionGrant, connectionSnapshot, consumeExecutionGrant, resolveCredentialFile } from '../src/execution-grant.mjs'
import { calculateCycleTime } from '../src/domain/cycle-time.mjs'
import { apply as applyCycle } from '../plugins/cycle-time.mjs'
import { apply as applyGearJob, normalizeGearJobRecord, readGearJobWorkOrder } from '../plugins/gearjob-work-order.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
const root = await mkdtemp(join(tmpdir(), 'geneway-p2-runtime-'))

try {
  testCapabilities()
  testParsers()
  await testGrantAndPlugins()
  await testSourceSignalsAndMetadata()
  await testSessionMetadata()
  await testImmediateCancellation()
  console.log('P2 runtime and capability checks passed')
} finally {
  delete process.env.GENEWAY_DSH_GRANT_FILE
  await rm(root, { recursive: true, force: true })
}

function testCapabilities() {
  assert.deepEqual(listCapabilities().map(item => item.id), ['gearjob-work-order-read', 'cycle-time-calculate'])
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

async function testGrantAndPlugins() {
  const policyFile = join(root, 'state.json')
  const secretRoot = join(root, 'secrets')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(secretRoot, { mode: 0o700 }))
  await writeFile(join(secretRoot, 'source-a.json'), JSON.stringify({ token: 'test-token' }), { mode: 0o600 })
  const connection = sourceConnection('connection-a', 'http://127.0.0.1:1', 'A', 'real-frappe-rest')
  assert.throws(() => connectionSnapshot({ ...connection, revision: 0 }), /revision/)
  assert.throws(() => connectionSnapshot({ ...connection, revision: 1.5 }), /revision/)
  const cycleState = stateFor({ capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', executionId: 'exec-cycle', connection: null })
  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })

  const wrongGrant = join(root, 'wrong-grant.json')
  await writeFile(wrongGrant, JSON.stringify(grantFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-gear', connection, policyFile, secretRoot })), { mode: 0o600 })
  await assert.rejects(() => consumeExecutionGrant({ filePath: wrongGrant, toolName: CYCLE_TIME_TOOL, input: { availableSeconds: 3600, quantity: 60 } }), error => error.code === 'FORBIDDEN')
  await assert.rejects(() => consumeExecutionGrant({ filePath: wrongGrant, toolName: GEARJOB_TOOL, input: { workOrderId: 'WO-1' } }), /不可用/)

  const gearState = stateFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-gear', connection })
  await writeFile(policyFile, JSON.stringify(gearState), { mode: 0o600 })
  const gearGrantFile = join(root, 'gear-grant.json')
  await writeFile(gearGrantFile, JSON.stringify(grantFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-gear', connection, policyFile, secretRoot })), { mode: 0o600 })
  const gearGrant = await consumeExecutionGrant({ filePath: gearGrantFile, toolName: GEARJOB_TOOL, input: { workOrderId: 'WO-1' } })
  assert.equal((await authorizeExecutionGrant(gearGrant)).connection.revision, 1)
  gearState.connections[0].revision = 2
  await writeFile(policyFile, JSON.stringify(gearState), { mode: 0o600 })
  await assert.rejects(() => authorizeExecutionGrant(gearGrant), error => error.code === 'FORBIDDEN' && /revision/.test(error.message))

  await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })
  const cycleGrant = join(root, 'cycle-grant.json')
  const cycleGrantValue = grantFor({ capabilityId: 'cycle-time-calculate', skillId: 'skill-cycle-time-calculate', executionId: 'exec-cycle', connection: null, policyFile, secretRoot })
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

  const host = new Context()
  let cycleFiber
  let gearFiber
  try {
    await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await host.plugin(ToolRuntime, { mode: 'native' })
    cycleFiber = host.plugin(Object.assign(applyCycle, { inject: ['tools'] }))
    gearFiber = host.plugin(Object.assign(applyGearJob, { inject: ['tools'] }))
    await Promise.all([cycleFiber, gearFiber])
    assert.deepEqual(host.tools.schemas().map(item => item.name).sort(), [CYCLE_TIME_TOOL, GEARJOB_TOOL])
    const actualGrant = join(root, 'actual-cycle-grant.json')
    await writeFile(actualGrant, JSON.stringify(cycleGrantValue), { mode: 0o600 })
    process.env.GENEWAY_DSH_GRANT_FILE = actualGrant
    const result = await host.tools.execute({ callId: 'cycle', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.secondsPerUnit, 60)
    assert.deepEqual(host.tools.get(CYCLE_TIME_TOOL).output.render({}, result.value), [{ type: 'text', text: JSON.stringify(result.value) }])
    await cycleFiber.dispose()
    cycleFiber = undefined
    assert.deepEqual(host.tools.schemas().map(item => item.name), [GEARJOB_TOOL])
    const unavailableCycle = await host.tools.execute({ callId: 'cycle-disposed', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(unavailableCycle.isError, true)
    assert.equal(unavailableCycle.error.info.code, 'UNKNOWN_TOOL')

    const liveGearState = stateFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-gear', connection })
    await writeFile(policyFile, JSON.stringify(liveGearState), { mode: 0o600 })
    const liveGearGrant = join(root, 'live-gear-grant.json')
    await writeFile(liveGearGrant, JSON.stringify(grantFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-gear', connection, policyFile, secretRoot })), { mode: 0o600 })
    process.env.GENEWAY_DSH_GRANT_FILE = liveGearGrant
    const remainingGear = await host.tools.execute({ callId: 'gear-after-cycle-dispose', name: GEARJOB_TOOL, arguments: { workOrderId: 'WO-1' }, signal: new AbortController().signal })
    assert.equal(remainingGear.isError, false)
    assert.equal(remainingGear.value.error.code, 'UPSTREAM_ERROR')

    cycleFiber = host.plugin(Object.assign(applyCycle, { inject: ['tools'] }))
    await cycleFiber
    assert.deepEqual(host.tools.schemas().map(item => item.name).sort(), [CYCLE_TIME_TOOL, GEARJOB_TOOL])
    await writeFile(policyFile, JSON.stringify(cycleState), { mode: 0o600 })
    const remountGrant = join(root, 'remount-cycle-grant.json')
    await writeFile(remountGrant, JSON.stringify(cycleGrantValue), { mode: 0o600 })
    process.env.GENEWAY_DSH_GRANT_FILE = remountGrant
    const remountedCycle = await host.tools.execute({ callId: 'cycle-remounted', name: CYCLE_TIME_TOOL, arguments: { availableSeconds: 3600, quantity: 60 }, signal: new AbortController().signal })
    assert.equal(remountedCycle.isError, false)
    assert.equal(remountedCycle.value.secondsPerUnit, 60)
  } finally {
    await gearFiber?.dispose()
    await cycleFiber?.dispose()
    await host.fiber.dispose()
  }

  const escape = join(root, 'credential-link')
  await symlink('/etc/passwd', escape)
  await assert.rejects(() => resolveCredentialFile(root, 'credential-link'), /符号链接/)
  await writeFile(join(root, 'insecure-secret'), 'not-a-secret', { mode: 0o644 })
  await assert.rejects(() => resolveCredentialFile(root, 'insecure-secret'), /0600/)
}

async function testSourceSignalsAndMetadata() {
  const secretRoot = join(root, 'source-secrets')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(secretRoot, { mode: 0o700 }))
  await writeFile(join(secretRoot, 'source.json'), JSON.stringify({ token: 'test-token' }), { mode: 0o600 })
  let sourceCalls = 0
  const server = createServer((request, response) => {
    sourceCalls += 1
    if (request.url?.endsWith('/REDIRECT')) { response.writeHead(302, { location: '/api/resource/Work%20Order/WO-1' }); return response.end() }
    if (request.url?.endsWith('/TIMEOUT')) return setTimeout(() => response.end(JSON.stringify({ data: { name: 'TIMEOUT' } })), 200)
    if (request.url?.endsWith('/BODY')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":')
      return setTimeout(() => response.end('{"name":"BODY"}}'), 200)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: { name: 'WO-1', status: 'Draft', qty: 10, produced_qty: 2, source_system: 'untrusted-upstream', source_environment: 'production' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const sourceA = sourceConnection('a', baseUrl, 'actual-A', 'real-frappe-rest', ['WO-1', 'TIMEOUT', 'BODY', 'REDIRECT'])
    const sourceB = { ...sourceConnection('b', baseUrl, 'controlled-B', 'controlled-frappe-compatible', ['WO-1']), sourceSystem: 'GearJob-compatible', sourceEnvironment: 'controlled-test', dataMode: 'synthetic-controlled' }
    const a = await readGearJobWorkOrder({ workOrderId: 'WO-1', connection: sourceA, secretRoot })
    const b = normalizeGearJobRecord({ name: 'WO-1', source_system: 'GearJob', source_environment: 'production' }, { id: 'WO-1', source: sourceB })
    assert.deepEqual([a.sourceSystem, a.sourceInstance, a.sourceEnvironment, a.evidenceMode], ['GearJob', 'actual-A', 'external-test', 'real-frappe-rest'])
    assert.deepEqual([b.sourceSystem, b.sourceInstance, b.sourceEnvironment, b.dataMode, b.evidenceMode], ['GearJob-compatible', 'controlled-B', 'controlled-test', 'synthetic-controlled', 'controlled-frappe-compatible'])
    await assert.rejects(() => readGearJobWorkOrder({ workOrderId: 'REDIRECT', connection: sourceA, secretRoot }), error => error.code === 'UPSTREAM_ERROR')

    const policyFile = join(root, 'source-state.json')
    const toolConnection = { ...sourceA, id: 'connection-source' }
    const state = stateFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-source', connection: toolConnection })
    await writeFile(policyFile, JSON.stringify(state), { mode: 0o600 })
    const host = new Context()
    let fiber
    try {
      await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
      await host.plugin(ToolRuntime, { mode: 'native' })
      fiber = host.plugin(Object.assign(applyGearJob, { inject: ['tools'] }))
      await fiber
      const toolGrant = join(root, 'source-tool-grant.json')
      await writeFile(toolGrant, JSON.stringify(grantFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-source', connection: toolConnection, policyFile, secretRoot })), { mode: 0o600 })
      process.env.GENEWAY_DSH_GRANT_FILE = toolGrant
      const toolResult = await host.tools.execute({ callId: 'gear-source', name: GEARJOB_TOOL, arguments: { workOrderId: 'WO-1' }, signal: new AbortController().signal })
      assert.equal(toolResult.value.ok, true)
      assert.equal(toolResult.value.sourceInstance, 'actual-A')

      state.connections[0].enabled = false
      await writeFile(policyFile, JSON.stringify(state), { mode: 0o600 })
      const revokedGrant = join(root, 'source-revoked-grant.json')
      await writeFile(revokedGrant, JSON.stringify(grantFor({ capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', executionId: 'exec-source', connection: toolConnection, policyFile, secretRoot })), { mode: 0o600 })
      process.env.GENEWAY_DSH_GRANT_FILE = revokedGrant
      const callsBeforeRevoked = sourceCalls
      const denied = await host.tools.execute({ callId: 'gear-revoked', name: GEARJOB_TOOL, arguments: { workOrderId: 'WO-1' }, signal: new AbortController().signal })
      assert.equal(denied.value.error.code, 'FORBIDDEN')
      assert.equal(sourceCalls, callsBeforeRevoked)
    } finally {
      await fiber?.dispose()
      await host.fiber.dispose()
    }

    await assert.rejects(() => readGearJobWorkOrder({ workOrderId: 'TIMEOUT', connection: sourceA, secretRoot, timeoutMs: 25 }), error => error.code === 'UPSTREAM_TIMEOUT')
    const controller = new AbortController()
    const body = readGearJobWorkOrder({ workOrderId: 'BODY', connection: sourceA, secretRoot, signal: controller.signal, timeoutMs: 500 })
    setTimeout(() => controller.abort(), 25)
    await assert.rejects(() => body, error => error.code === 'CANCELLED')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
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
      return { async run() { throw new Error('unexpected model run') }, async close() { closes += 1 } }
    },
  })
  await assert.rejects(() => runner.run({ executionId: 'missing-metadata', capabilityId: 'cycle-time-calculate', input: { availableSeconds: 3600, quantity: 60 } }), /Session metadata/)
  for (const revision of [0, 1.5]) {
    await assert.rejects(() => runner.run({
      executionId: `bad-revision-${revision}`,
      capabilityId: 'gearjob-work-order-read',
      input: { workOrderId: 'WO-1' },
      sessionMetadata: gearSessionMetadata(revision),
      grant: { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets'), connection: sourceConnection('connection-metadata', 'http://127.0.0.1:1', 'metadata', 'real-frappe-rest') },
    }), /连接版本/)
  }
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
    executionId: 'metadata-snapshot-mismatch',
    capabilityId: 'gearjob-work-order-read',
    input: { workOrderId: 'WO-1' },
    sessionMetadata: gearSessionMetadata(2),
    grant: { policyFile: join(root, 'state.json'), policyRoot: root, secretRoot: join(root, 'secrets'), connection: sourceConnection('connection-metadata', 'http://127.0.0.1:1', 'metadata', 'real-frappe-rest') },
  }), /连接快照不匹配/)
  assert.equal(factories, 1)
  assert.equal(closes, 1)
  await runner.close()
}

function gearSessionMetadata(connectionRevision) {
  return {
    ownerMemberId: 'member-user',
    workId: 'work-gear',
    employeeId: 'employee-b',
    skillId: 'skill-gearjob-work-order-read',
    capabilityId: 'gearjob-work-order-read',
    connectionId: 'connection-metadata',
    connectionRevision,
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
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }] } } },
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

function grantFor({ capabilityId, skillId, executionId, connection, policyFile, secretRoot }) {
  const cycle = capabilityId === 'cycle-time-calculate'
  return {
    version: 2,
    executionId,
    memberId: 'member-user',
    employeeId: 'employee-b',
    skillId,
    capabilityId,
    workId: cycle ? 'work-cycle' : 'work-gear',
    modelRouteId: 'model-zenmux',
    operation: 'create',
    expectedTool: cycle ? CYCLE_TIME_TOOL : GEARJOB_TOOL,
    input: cycle ? { availableSeconds: 3600, quantity: 60 } : { workOrderId: 'WO-1' },
    connection,
    confirmationFingerprint: 'none',
    confirmationRefs: [],
    policyFile,
    policyRoot: root,
    secretRoot,
  }
}

function stateFor({ capabilityId, skillId, executionId, connection }) {
  const cycle = capabilityId === 'cycle-time-calculate'
  const workId = cycle ? 'work-cycle' : 'work-gear'
  return {
    version: 4,
    members: [{ id: 'member-user', enabled: true, employeeIds: ['employee-b'] }],
    modelRoutes: [{ id: 'model-zenmux', enabled: true }],
    employees: [{ id: 'employee-b', enabled: true, modelRouteId: 'model-zenmux', skillIds: [skillId], connectionIds: connection ? [connection.id] : [] }],
    skills: [{ id: skillId, enabled: true, capabilityId }],
    connections: connection ? [{ ...connection, enabled: true, status: 'ready', skillIds: [skillId] }] : [],
    works: [{ id: workId, ownerMemberId: 'member-user', employeeId: 'employee-b', skillId, capabilityId, ...(connection ? { connectionId: connection.id } : {}), executions: [{ id: executionId, operation: 'create', status: 'running' }] }],
  }
}
