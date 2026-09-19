import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { readSettings } from '../src/runtime-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { createUserMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const dshVersion = requireFromDsh('@deepseek-ai/dsh/package.json').version
const patchPath = join(root, 'config', 'p3-delegation.patch.yml')
const TOOL_A = 'p3_probe_employee_a'
const TOOL_B = 'p3_probe_employee_b'
const STRUCTURED_OUTPUT = 'structured_output'
const ROUTE = Object.freeze({ provider: 'geneway-p3-capture', model: 'p3-probe', maxTokens: 256 })

const capture = await startCaptureServer()
const dshHome = await mkdtemp(join(tmpdir(), 'geneway-p3-delegation-'))
const realModelEnabled = process.env.GENEWAY_P3_PROBE_MODEL === 'true'
const configuredZenMuxKey = realModelEnabled ? readSettings()?.env?.ANTHROPIC_AUTH_TOKEN : undefined
const probeEnvironment = {
  DSH_HOME: dshHome,
  DSH_TELEMETRY_MODE: 'DISABLED',
  GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`,
  GENEWAY_P3_CAPTURE_KEY: 'local-probe-only',
}
if (typeof configuredZenMuxKey === 'string' && configuredZenMuxKey.trim()) probeEnvironment.ZENMUX_API_KEY = configuredZenMuxKey
const restoreEnvironment = setEnvironment(probeEnvironment)

let runtime
try {
  const store = await createProbeStore(join(dshHome, 'geneway-p3-probe-state.json'))
  runtime = await runProfile({
    environment: launchEnvironment(),
    profile: 'sdk',
    patchFiles: [patchPath],
    args: [],
    resolutionMode: 'runtime',
  })
  const result = await runProbe(runtime.ctx, capture, store, realModelEnabled)
  console.log(JSON.stringify({ ok: true, dshVersion, ...result }, null, 2))
} finally {
  await runtime?.shutdown.shutdown(0).catch(() => undefined)
  restoreEnvironment()
  await capture.close()
  await rm(dshHome, { recursive: true, force: true })
}

async function runProbe(ctx, captureServer, store, runRealModel) {
  const trace = []
  let sequence = 0
  const record = (type, data = {}) => trace.push({ sequence: ++sequence, type, ...data })
  captureServer.record = record
  const { harness, provider } = setupHarness(ctx, captureServer, store, record)

  const happy = await probeHappyPath(harness, captureServer)
  const denials = await probeIdentityDenials(harness, captureServer)
  const cancellation = await probeCancellation(harness, captureServer)
  const budget = await probeBudget(harness, captureServer)
  const dispatchLimits = await probeDispatchLimits(harness, captureServer)
  const timeouts = await probeTimeouts(harness, captureServer)
  const dynamicAuthorization = await probeDynamicAuthorization(harness, captureServer)
  const unknownUsage = await probeUnknownUsage(harness)
  const realModel = await probeRealModel(harness, runRealModel)
  const runtimeIsolation = await probeRuntimeIsolation(captureServer, store)

  return {
    provider: { name: provider.name, inheritsParentContext: provider.inheritsParentContext, capabilities: provider.capabilities },
    happy,
    denials,
    cancellation,
    budget,
    dispatchLimits,
    timeouts,
    dynamicAuthorization,
    unknownUsage,
    runtimeIsolation,
    realModel,
    traceChecks: verifyTrace(trace),
    modelRoute: { deterministic: 'local-capture', realZenMuxCalled: realModel.ran, businessDataSent: false },
    tempProductState: { persisted: true, reopened: true, childProcessWrites: false },
  }
}

function setupHarness(ctx, captureServer, store, record) {
  assert.deepEqual(ctx.subagents.list(), ['spawn'])
  const provider = ctx.subagents.getProvider('spawn')
  assert(provider)
  assert.equal(provider.inheritsParentContext, false)
  assert.deepEqual(provider.capabilities, {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  })

  const gates = new Map()
  const bindings = new WeakMap()
  const modelRequests = []
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === 'zenmux') {
      modelRequests.push({
        sessionId: options.sessionId,
        parentCanaryPresent: JSON.stringify(options.messages).includes('PARENT_CANARY_'),
      })
    }
    return next()
  })

  ctx.tools.register(captureTool(TOOL_A, captureServer.address, bindings))
  ctx.tools.register(captureTool(TOOL_B, captureServer.address, bindings))
  ctx.tools.guard(exec => {
    if (exec.name !== TOOL_A && exec.name !== TOOL_B) return undefined
    const binding = exec.agent && bindings.get(exec.agent)
    const denial = bindingDenial(binding, exec.agent, exec.name)
    if (denial) return denial
    record('tool-authorized', { sessionId: exec.agent.id, scenario: exec.arguments.scenario, tool: exec.name })
    return undefined
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return
    const gate = deferred()
    gates.set(agent.id, { agent, binding: undefined, decision: gate })
    record('agent-created-unbound', { sessionId: agent.id })
    agent.ctx.on('agent/request', async ({ agent: requestAgent, signal }, next) => {
      const entry = gates.get(requestAgent.id)
      assert(entry && entry.agent === requestAgent)
      const decision = await untilAbort(entry.decision.promise, signal)
      if (!decision.ok) throw decision.error
      const binding = bindings.get(requestAgent)
      const denial = bindingDenial(binding, requestAgent)
      if (denial) throw new Error(denial)
      await store.authorizeRequest(binding)
      if (binding.budget.accepted >= binding.budget.limit || binding.rootWork.requestBudget.accepted >= binding.rootWork.requestBudget.limit) {
        binding.budget.rejected += 1
        binding.rootWork.requestBudget.rejected += 1
        record('request-budget-rejected', { sessionId: requestAgent.id, scenario: binding.scenario })
        throw new Error('P3 request budget exhausted before model dispatch')
      }
      binding.budget.accepted += 1
      binding.rootWork.requestBudget.accepted += 1
      await store.reserveRequest(binding.rootWorkId, binding.generation)
      record('request-budget-reserved', { sessionId: requestAgent.id, scenario: binding.scenario })
      return next()
    })
  })
  ctx.on('agent/disposed', ({ agent }) => gates.delete(agent.id))
  return { harness: { ctx, gates, bindings, modelRequests, store, record }, provider }
}

async function probeHappyPath(harness, captureServer) {
  const canary = `PARENT_CANARY_${randomUUID()}`
  const rootWork = await createRoot(harness, 'happy', [
    { childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
    { childWorkId: 'child-b', executionId: 'exec-b', employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', allowedTools: [TOOL_B] },
  ])
  const runs = []
  try {
    rootWork.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `SCENARIO:parent-canary ${canary}` }],
      source: { kind: 'user' },
    }))
    await rootWork.agent.whenIdle()
    assert(JSON.stringify(rootWork.agent.session.snapshotEvents()).includes(canary))

    const [runA, runB] = await Promise.all([
      dispatchChild(harness, rootWork, rootWork.grants[0], {
        childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'happy-a', budgetLimit: 4,
      }),
      dispatchChild(harness, rootWork, rootWork.grants[1], {
        childWorkId: 'child-b', executionId: 'exec-b', employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', scenario: 'happy-b', budgetLimit: 4,
      }),
    ])
    runs.push(runA, runB)
    const [resultA, resultB] = await Promise.all([runA.result, runB.result])
    assert.equal(resultA.stopReason, 'completed')
    assert.equal(resultB.stopReason, 'completed')
    assert.deepEqual(resultA.structured, { scenario: 'happy-a', status: 'done' })
    assert.deepEqual(resultB.structured, { scenario: 'happy-b', status: 'done' })
    const readbackA = await persistReadback(harness, runA, resultA)
    const readbackB = await persistReadback(harness, runB, resultB)
    const summary = await persistSummary(harness, rootWork, [readbackA.resultId, readbackB.resultId])
    const persistedState = await harness.store.read()
    const persistedRoot = persistedState.roots.find(entry => entry.id === rootWork.id)
    assert.deepEqual(
      { executionId: persistedRoot.executionId, employeeId: persistedRoot.employeeId, requestCount: persistedRoot.requestCount },
      { executionId: rootWork.executionId, employeeId: rootWork.employeeId, requestCount: 5 },
    )

    assert.notEqual(rootWork.agent.id, runA.id)
    assert.notEqual(rootWork.agent.id, runB.id)
    assert.notEqual(runA.id, runB.id)
    for (const run of runs) {
      assert.equal(run.id, run.localAgent.id)
      assert.equal(run.localAgent.session.header.parentSession, rootWork.agent.id)
      assert.equal(run.localAgent.session.header.isSeeded, false)
      assert.equal(run.localAgent.session.header.delegationDepth, 1)
      assert.equal(run.localAgent.session.inheritedEventCount, 0)
      assert(!JSON.stringify(run.localAgent.session.snapshotEvents()).includes(canary))
    }

    const parentRequest = captureServer.models.find(entry => entry.scenario === 'parent-canary')
    const requestA = captureServer.models.find(entry => entry.scenario === 'happy-a')
    const requestB = captureServer.models.find(entry => entry.scenario === 'happy-b')
    assert(parentRequest && requestA && requestB)
    assert.equal(parentRequest.parentCanaryPresent, true)
    assert.deepEqual(requestA.tools.sort(), [STRUCTURED_OUTPUT, TOOL_A].sort())
    assert.deepEqual(requestB.tools.sort(), [STRUCTURED_OUTPUT, TOOL_B].sort())
    assert.equal(requestA.parentCanaryPresent, false)
    assert.equal(requestB.parentCanaryPresent, false)
    const toolA = captureServer.tools.find(entry => entry.scenario === 'happy-a')
    const toolB = captureServer.tools.find(entry => entry.scenario === 'happy-b')
    assert(toolA && toolB)
    assert.deepEqual({ connectionId: toolA.connectionId, objectId: toolA.objectId }, { connectionId: 'connection-a', objectId: 'object-a' })
    assert.deepEqual({ connectionId: toolB.connectionId, objectId: toolB.objectId }, { connectionId: 'connection-b', objectId: 'object-b' })

    const deniedToolCount = captureServer.tools.length
    const wrongScope = await harness.ctx.tools.execute({
      callId: `p3-wrong-scope-${randomUUID()}`,
      name: TOOL_B,
      arguments: { scenario: 'wrong-tool-scope' },
      agent: runA.localAgent,
      signal: new AbortController().signal,
    })
    assert.equal(wrongScope.isError, true)
    assert.equal(captureServer.tools.length, deniedToolCount)

    const fakeAgent = new Proxy(runA.localAgent, {})
    const fakeIdentity = await harness.ctx.tools.execute({
      callId: `p3-fake-agent-${randomUUID()}`,
      name: TOOL_A,
      arguments: { scenario: 'fake-agent-identity' },
      agent: fakeAgent,
      signal: new AbortController().signal,
    })
    assert.equal(fakeIdentity.isError, true)
    assert.equal(captureServer.tools.length, deniedToolCount)
    const bridge = createBridgeAuthorizer(harness, captureServer.address)
    const bridgeCredential = bridge.mint(runA.localAgent)
    const bridgeCount = captureServer.bridges.length
    await assert.rejects(bridge.call({ ...bridgeCredential, agentId: `forged-${runA.id}` }))
    assert.equal(captureServer.bridges.length, bridgeCount)
    await bridge.call(bridgeCredential)
    assert.equal(captureServer.bridges.length, bridgeCount + 1)
    await assert.rejects(bridge.call(bridgeCredential))
    await assert.rejects(bridge.call({ ...bridgeCredential, credential: randomUUID() }))
    assert.equal(captureServer.bridges.length, bridgeCount + 1)

    return {
      freshChild: true,
      parentCanaryExcluded: true,
      independentSessions: true,
      rootIdentityBoundBeforeFirstRequest: true,
      sharedRootRequestCount: 5,
      identityBoundBeforeFirstRequest: true,
      toolScopes: { employeeA: [TOOL_A], employeeB: [TOOL_B], wrongScopeRejected: true },
      readback: {
        employeeA: readbackSummary(readbackA),
        employeeB: readbackSummary(readbackB),
        parentSummaryRefs: summary.resultRefs,
      },
      forgedAgentObjectRejectedBeforeToolIo: true,
      bridgeIdentity: { forgedAgentIdRejected: true, forgedCredentialRejected: true, replayRejected: true, validCalls: 1 },
    }
  } finally {
    await Promise.allSettled(runs.map(run => run.dispose()))
    await rootWork.dispose()
  }
}

async function probeIdentityDenials(harness, captureServer) {
  const rootWork = await createRoot(harness, 'denials', [
    { childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
    { kind: 'parent', childWorkId: 'root', executionId: 'root-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ])
  try {
    const cases = [
      ['wrong-employee', rootWork.grants[0], { childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-b', connectionId: 'connection-a', objectId: 'object-a' }],
      ['wrong-child-work', rootWork.grants[0], { childWorkId: 'child-other', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a' }],
      ['wrong-connection', rootWork.grants[0], { childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-b', objectId: 'object-a' }],
      ['wrong-object', rootWork.grants[0], { childWorkId: 'child-a', executionId: 'exec-a', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-b' }],
      ['parent-grant', rootWork.grants[1], { childWorkId: 'root', executionId: 'root-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a' }],
    ]
    for (const [scenario, grant, identity] of cases) {
      const before = captureServer.ioCount()
      await assert.rejects(dispatchChild(harness, rootWork, grant, { ...identity, scenario, budgetLimit: 1 }))
      await pause(25)
      assert.equal(captureServer.ioCount(), before)
    }
    return { wrongEmployee: 'rejected-before-io', wrongChildWork: 'rejected-before-io', wrongConnection: 'rejected-before-io', wrongObject: 'rejected-before-io', parentGrant: 'rejected-before-io' }
  } finally {
    await rootWork.dispose()
  }
}

async function probeCancellation(harness, captureServer) {
  const pre = await createRoot(harness, 'cancel-pre', [
    { childWorkId: 'pre-a', executionId: 'pre-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ])
  try {
    const before = captureServer.ioCount()
    await cancelRoot(harness, pre, 'before-dispatch')
    await assert.rejects(dispatchChild(harness, pre, pre.grants[0], {
      childWorkId: 'pre-a', executionId: 'pre-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'cancel-pre', budgetLimit: 2,
    }))
    assert.equal(captureServer.ioCount(), before)
  } finally {
    await pre.dispose()
  }

  const model = await cancellationScenario(harness, captureServer, 'cancel-model', 'w2-model', 'model')
  const tool = await cancellationScenario(harness, captureServer, 'cancel-tool', 'w2-tool', 'tool')
  return { beforeDispatch: 'no-io', duringModel: model, duringToolIo: tool }
}

async function cancellationScenario(harness, captureServer, w1Scenario, w2Scenario, waitKind) {
  const w1 = await createRoot(harness, w1Scenario, [
    { childWorkId: `${w1Scenario}-a`, executionId: `${w1Scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ])
  const w2 = await createRoot(harness, w2Scenario, [
    { childWorkId: `${w2Scenario}-b`, executionId: `${w2Scenario}-exec`, employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', allowedTools: [TOOL_B] },
  ])
  let runW1
  let runW2
  try {
    ;[runW1, runW2] = await Promise.all([
      dispatchChild(harness, w1, w1.grants[0], {
        childWorkId: `${w1Scenario}-a`, executionId: `${w1Scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: w1Scenario, budgetLimit: 4,
      }),
      dispatchChild(harness, w2, w2.grants[0], {
        childWorkId: `${w2Scenario}-b`, executionId: `${w2Scenario}-exec`, employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', scenario: w2Scenario, budgetLimit: 4,
      }),
    ])
    await captureServer.waitFor(waitKind, w1Scenario)
    await cancelRoot(harness, w1, waitKind)
    const afterCancel = captureServer.countScenario(w1Scenario)
    await assert.rejects(dispatchChild(harness, w1, w1.grants[0], {
      childWorkId: `${w1Scenario}-a`, executionId: `${w1Scenario}-late`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: `${w1Scenario}-late`, budgetLimit: 1,
    }))
    const [resultW1, resultW2] = await Promise.all([runW1.result, runW2.result])
    await captureServer.waitForAbort(waitKind, w1Scenario)
    await pause(50)
    assert.equal(resultW1.stopReason, 'aborted')
    assert.equal(resultW2.stopReason, 'completed')
    const lateWrite = await harness.store.tryComplete(`${w1Scenario}-exec`, w1.generation - 1, { status: 'completed' })
    assert.equal(lateWrite, false)
    assert.equal(captureServer.countScenario(w1Scenario), afterCancel)
    assert.equal(captureServer.countScenario(`${w1Scenario}-late`), 0)
    return { w1: 'aborted', storeClosedBeforeAbort: true, lateWriteRejected: true, inFlightIoAborted: true, laterDispatch: 'rejected-before-io', independentW2: 'completed' }
  } finally {
    await Promise.allSettled([runW1?.dispose(), runW2?.dispose()].filter(Boolean))
    await Promise.allSettled([w1.dispose(), w2.dispose()])
  }
}

async function probeBudget(harness, captureServer) {
  const rootWork = await createRoot(harness, 'budget', [
    { childWorkId: 'budget-a', executionId: 'budget-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ], 1)
  let run
  try {
    run = await dispatchChild(harness, rootWork, rootWork.grants[0], {
      childWorkId: 'budget-a', executionId: 'budget-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'budget-one', budgetLimit: 1,
    })
    const result = await run.result
    const binding = harness.bindings.get(run.localAgent)
    assert.equal(result.stopReason, 'error')
    assert.equal(binding.budget.accepted, 1)
    assert.equal(binding.budget.rejected, 1)
    assert.equal(rootWork.requestBudget.accepted, 1)
    assert.equal(rootWork.requestBudget.rejected, 1)
    assert.equal(captureServer.models.filter(entry => entry.scenario === 'budget-one').length, 1)
    assert.equal(captureServer.tools.filter(entry => entry.scenario === 'budget-one').length, 1)
    return { limit: 1, acceptedRequests: 1, rejectedBeforeSecondModelIo: 1, terminal: 'error' }
  } finally {
    await run?.dispose()
    await rootWork.dispose()
  }
}

async function probeDispatchLimits(harness, captureServer) {
  const grants = Array.from({ length: 4 }, (_, index) => ({
    childWorkId: `limit-child-${index + 1}`,
    executionId: `limit-exec-${index + 1}`,
    employeeId: 'employee-a',
    connectionId: 'connection-a',
    objectId: `object-${index + 1}`,
    allowedTools: [TOOL_A],
  }))
  const countRoot = await createRoot(harness, 'child-count', grants)
  try {
    for (let index = 0; index < grants.length; index += 1) {
      const spec = grants[index]
      const run = await dispatchChild(harness, countRoot, countRoot.grants[index], { ...spec, scenario: `limit-count-${index + 1}`, budgetLimit: 2 })
      try {
        const result = await run.result
        assert.equal(result.stopReason, 'completed')
        assert.equal(result.structured?.status, 'done')
        await persistReadback(harness, run, result)
      } finally {
        await run.dispose()
      }
    }
    const before = captureServer.ioCount()
    await assert.rejects(dispatchChild(harness, countRoot, countRoot.grants[0], { ...grants[0], scenario: 'limit-count-5', budgetLimit: 1 }))
    assert.equal(captureServer.ioCount(), before)
    assert.deepEqual({ started: countRoot.childBudget.started, rejected: countRoot.childBudget.rejected }, { started: 4, rejected: 1 })
  } finally {
    await countRoot.dispose()
  }

  const concurrentGrants = Array.from({ length: 3 }, (_, index) => ({
    childWorkId: `concurrent-child-${index + 1}`,
    executionId: `concurrent-exec-${index + 1}`,
    employeeId: 'employee-a',
    connectionId: 'connection-a',
    objectId: `concurrent-object-${index + 1}`,
    allowedTools: [TOOL_A],
  }))
  const concurrentRoot = await createRoot(harness, 'child-concurrency', concurrentGrants)
  let first
  let second
  try {
    ;[first, second] = await Promise.all(concurrentGrants.slice(0, 2).map((spec, index) => dispatchChild(
      harness,
      concurrentRoot,
      concurrentRoot.grants[index],
      { ...spec, scenario: `limit-hold-${index + 1}`, budgetLimit: 2 },
    )))
    await Promise.all([captureServer.waitFor('model', 'limit-hold-1'), captureServer.waitFor('model', 'limit-hold-2')])
    const before = captureServer.ioCount()
    await assert.rejects(dispatchChild(harness, concurrentRoot, concurrentRoot.grants[2], { ...concurrentGrants[2], scenario: 'limit-hold-3', budgetLimit: 1 }))
    assert.equal(captureServer.ioCount(), before)
    await cancelRoot(harness, concurrentRoot, 'concurrency-limit-cleanup')
    const results = await Promise.all([first.result, second.result])
    assert(results.every(result => result.stopReason === 'aborted'))
  } finally {
    await Promise.allSettled([first?.dispose(), second?.dispose()].filter(Boolean))
    await concurrentRoot.dispose()
  }
  return { maxChildren: 4, fifthRejectedBeforeIo: true, maxConcurrent: 2, thirdConcurrentRejectedBeforeIo: true }
}

async function probeTimeouts(harness, captureServer) {
  const childRoot = await createRoot(harness, 'child-timeout', [
    { childWorkId: 'timeout-child', executionId: 'timeout-child-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ], 12, { childTimeoutMs: 50 })
  let childRun
  try {
    childRun = await dispatchChild(harness, childRoot, childRoot.grants[0], {
      childWorkId: 'timeout-child', executionId: 'timeout-child-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'timeout-child', budgetLimit: 2,
    })
    const result = await childRun.result
    assert.equal(result.stopReason, 'aborted')
    await captureServer.waitForAbort('model', 'timeout-child')
    await cancelRoot(harness, childRoot, 'child-timeout-cleanup')
  } finally {
    await childRun?.dispose()
    await childRoot.dispose()
  }

  const rootWork = await createRoot(harness, 'root-timeout', [
    { childWorkId: 'timeout-root', executionId: 'timeout-root-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ], 12, { rootTimeoutMs: 100 })
  let rootRun
  let rootTimeout
  try {
    const timeoutDone = new Promise((resolve, reject) => {
      rootTimeout = setTimeout(() => cancelRoot(harness, rootWork, 'root-timeout').then(resolve, reject), rootWork.rootTimeoutMs)
    })
    rootRun = await dispatchChild(harness, rootWork, rootWork.grants[0], {
      childWorkId: 'timeout-root', executionId: 'timeout-root-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'timeout-root', budgetLimit: 2,
    })
    await captureServer.waitFor('model', 'timeout-root')
    await timeoutDone
    const result = await rootRun.result
    assert.equal(result.stopReason, 'aborted')
    await captureServer.waitForAbort('model', 'timeout-root')
    const state = await harness.store.read()
    assert.equal(state.roots.find(entry => entry.id === rootWork.id).status, 'cancelled')
  } finally {
    clearTimeout(rootTimeout)
    await rootRun?.dispose()
    await rootWork.dispose()
  }
  return { childConfiguredMs: 120_000, childTestMs: 50, childHardAbort: true, rootConfiguredMs: 360_000, rootTestMs: 100, rootStoreFirstAbort: true }
}

async function probeDynamicAuthorization(harness, captureServer) {
  const outcomes = {}
  for (const scope of ['member', 'employee', 'connection', 'knowledge']) {
    const scenario = `scope-${scope}`
    const rootWork = await createRoot(harness, scenario, [
      { childWorkId: `${scenario}-child`, executionId: `${scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
    ])
    let run
    try {
      run = await dispatchChild(harness, rootWork, rootWork.grants[0], {
        childWorkId: `${scenario}-child`, executionId: `${scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario, budgetLimit: 3,
      })
      await captureServer.waitFor('tool', scenario)
      assert.equal(captureServer.models.filter(entry => entry.scenario === scenario).length, 1)
      await harness.store.revokeExecution(`${scenario}-exec`, scope)
      captureServer.releaseTool(scenario)
      const result = await run.result
      assert.equal(result.stopReason, 'error')
      await pause(25)
      assert.equal(captureServer.models.filter(entry => entry.scenario === scenario).length, 1)
      outcomes[scope] = 'revoked-before-next-model-io'
      await cancelRoot(harness, rootWork, `${scenario}-cleanup`)
    } finally {
      await run?.dispose()
      await rootWork.dispose()
    }
  }
  return outcomes
}

async function probeUnknownUsage(harness) {
  const check = async scenario => {
    const rootWork = await createRoot(harness, scenario, [
      { childWorkId: `${scenario}-child`, executionId: `${scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
    ])
    let run
    try {
      run = await dispatchChild(harness, rootWork, rootWork.grants[0], {
        childWorkId: `${scenario}-child`, executionId: `${scenario}-exec`, employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario, budgetLimit: 3,
      })
      const result = await run.result
      assert.equal(result.stopReason, 'completed')
      const readback = await persistReadback(harness, run, result)
      const reopened = await harness.store.read()
      return { usage: readback.usage, persisted: reopened.results.find(entry => entry.id === readback.resultId).usage }
    } finally {
      await run?.dispose()
      await rootWork.dispose()
    }
  }
  const missing = await check('usage-missing')
  assert.equal(missing.usage.inputTokens, null)
  assert.equal(missing.usage.outputTokens, null)
  assert.equal(missing.persisted.inputTokens, null)
  assert.equal(missing.persisted.outputTokens, null)
  const partial = await check('usage-partial')
  assert(partial.usage.inputTokens > 0)
  assert.equal(partial.usage.outputTokens, null)
  assert.equal(partial.persisted.outputTokens, null)
  return {
    missing: { inputTokens: null, outputTokens: null },
    partial: { inputTokens: partial.usage.inputTokens, outputTokens: null },
    persistedAndReopened: true,
  }
}

async function probeRuntimeIsolation(captureServer, store) {
  const firstRuntime = await bootIsolatedRuntime(captureServer)
  const secondRuntime = await bootIsolatedRuntime(captureServer)
  const trace = []
  let sequence = 0
  const record = (type, data = {}) => trace.push({ sequence: ++sequence, type, ...data })
  captureServer.record = record
  const firstHarness = setupHarness(firstRuntime.runtime.ctx, captureServer, store, record).harness
  const secondHarness = setupHarness(secondRuntime.runtime.ctx, captureServer, store, record).harness
  const w1 = await createRoot(firstHarness, 'runtime-close-w1', [
    { childWorkId: 'runtime-w1-child', executionId: 'runtime-w1-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', allowedTools: [TOOL_A] },
  ])
  const w2 = await createRoot(secondHarness, 'runtime-close-w2', [
    { childWorkId: 'runtime-w2-child', executionId: 'runtime-w2-exec', employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', allowedTools: [TOOL_B] },
  ])
  let runW1
  let runW2
  try {
    ;[runW1, runW2] = await Promise.all([
      dispatchChild(firstHarness, w1, w1.grants[0], {
        childWorkId: 'runtime-w1-child', executionId: 'runtime-w1-exec', employeeId: 'employee-a', connectionId: 'connection-a', objectId: 'object-a', scenario: 'runtime-close-w1', budgetLimit: 2,
      }),
      dispatchChild(secondHarness, w2, w2.grants[0], {
        childWorkId: 'runtime-w2-child', executionId: 'runtime-w2-exec', employeeId: 'employee-b', connectionId: 'connection-b', objectId: 'object-b', scenario: 'w2-runtime-close', budgetLimit: 2,
      }),
    ])
    await captureServer.waitFor('model', 'runtime-close-w1')
    await cancelRoot(firstHarness, w1, 'runtime-close')
    const closeW1 = firstRuntime.runtime.shutdown.shutdown(0)
    const [resultW1, resultW2] = await Promise.all([runW1.result, runW2.result])
    await closeW1
    assert.equal(resultW1.stopReason, 'aborted')
    assert.equal(resultW2.stopReason, 'completed')
    assert.deepEqual(resultW2.structured, { scenario: 'w2-runtime-close', status: 'done' })
    await persistReadback(secondHarness, runW2, resultW2)
    return { separateRuntimes: true, w1RuntimeClosed: true, w1: 'aborted', w2: 'completed' }
  } finally {
    await Promise.allSettled([runW1?.dispose(), runW2?.dispose(), w1.dispose(), w2.dispose()].filter(Boolean))
    await Promise.allSettled([firstRuntime.runtime.shutdown.shutdown(0), secondRuntime.runtime.shutdown.shutdown(0)])
    await Promise.allSettled([rm(firstRuntime.home, { recursive: true, force: true }), rm(secondRuntime.home, { recursive: true, force: true })])
  }
}

async function bootIsolatedRuntime(captureServer) {
  const home = await mkdtemp(join(tmpdir(), 'geneway-p3-isolated-'))
  const restore = setEnvironment({
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: 'DISABLED',
    GENEWAY_P3_CAPTURE_BASE_URL: `${captureServer.address}/v1`,
    GENEWAY_P3_CAPTURE_KEY: 'local-probe-only',
  })
  try {
    const isolatedRuntime = await runProfile({
      environment: launchEnvironment(),
      profile: 'sdk',
      patchFiles: [patchPath],
      args: [],
      resolutionMode: 'runtime',
    })
    return { runtime: isolatedRuntime, home }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  } finally {
    restore()
  }
}

async function probeRealModel(harness, enabled) {
  if (!enabled) return { ran: false, reason: 'set GENEWAY_P3_PROBE_MODEL=true for the zero-business-data ZenMux spawn check' }
  if (!process.env.ZENMUX_API_KEY) throw new Error('GENEWAY_P3_PROBE_MODEL=true but the configured ZenMux credential is unavailable')
  const realRoute = { provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', maxTokens: 256 }
  const rootWork = await createRoot(harness, 'real-zenmux', [
    { childWorkId: 'real-child', executionId: 'real-exec', employeeId: 'employee-a', connectionId: 'local-none', objectId: 'probe-only', allowedTools: [TOOL_A] },
  ], 12, { agentOptions: realRoute })
  let run
  try {
    const canary = `PARENT_CANARY_REAL_${randomUUID()}`
    rootWork.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `This is a zero-business-data root probe. Reply only OK. Do not call tools. ${canary}` }],
      source: { kind: 'user' },
    }))
    await rootWork.agent.whenIdle()
    assert(JSON.stringify(rootWork.agent.session.snapshotEvents()).includes(canary))
    run = await dispatchChild(harness, rootWork, rootWork.grants[0], {
      childWorkId: 'real-child',
      executionId: 'real-exec',
      employeeId: 'employee-a',
      connectionId: 'local-none',
      objectId: 'probe-only',
      scenario: 'real-zenmux',
      budgetLimit: 3,
      agentOptions: realRoute,
      prompt: 'This is a zero-business-data native spawn probe. Do not call product tools. Call structured_output once with {"scenario":"real-zenmux","status":"done"}.',
    })
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`real ZenMux spawn failed closed: ${JSON.stringify(realFailureSummary(run.localAgent.session.snapshotEvents(), result))}`)
    }
    assert.deepEqual(result.structured, { scenario: 'real-zenmux', status: 'done' })
    assert(!JSON.stringify(run.localAgent.session.snapshotEvents()).includes(canary))
    const rootRequests = harness.modelRequests.filter(entry => entry.sessionId === rootWork.agent.id)
    const childRequests = harness.modelRequests.filter(entry => entry.sessionId === run.id)
    assert(rootRequests.some(entry => entry.parentCanaryPresent))
    assert(childRequests.length > 0 && childRequests.every(entry => !entry.parentCanaryPresent))
    const readback = await persistReadback(harness, run, result)
    return {
      ran: true,
      provider: 'zenmux',
      model: 'deepseek/deepseek-v4-pro',
      rootRequests: rootRequests.length,
      childRequests: childRequests.length,
      parentCanaryExcludedFromChild: true,
      structured: true,
      usageSeen: readback.usage.inputTokens !== null,
    }
  } finally {
    await run?.dispose()
    await rootWork.dispose()
  }
}

function realFailureSummary(events, result) {
  return {
    stopReason: result.stopReason,
    hasStructured: result.structured !== undefined,
    outputTypes: result.output.map(block => block.type),
    events: events.map(event => ({
      type: event.type,
      reasonKind: event.type === 'turn/end' ? event.data.reason?.kind : undefined,
      toolName: event.type === 'tool/call' ? event.data.name : undefined,
      contentTypes: event.type === 'assistant/message' ? event.data.message.content.map(block => block.type) : undefined,
      dataKeys: Object.keys(event.data ?? {}),
      failureCode: event.data?.failure?.code,
      failureStatus: event.data?.failure?.status,
      failureHints: event.data?.failure?.message ? Object.fromEntries([
        ['fetch', /fetch/i.test(event.data.failure.message)],
        ['connect', /connect|socket|tls|network/i.test(event.data.failure.message)],
        ['schema', /schema|tool/i.test(event.data.failure.message)],
        ['credential', /credential|api key|unauthor/i.test(event.data.failure.message)],
      ]) : undefined,
      stream: (event.data?.stream ?? []).map(chunk => ({ type: chunk.type, code: chunk.error?.code ?? chunk.code })),
    })),
  }
}

async function createRoot(harness, label, grantSpecs, requestLimit = 12, limits = {}) {
  assert(Number.isSafeInteger(requestLimit) && requestLimit >= 1 && requestLimit <= 12)
  assert(Number.isSafeInteger(limits.childLimit ?? 4) && (limits.childLimit ?? 4) >= 1 && (limits.childLimit ?? 4) <= 4)
  assert(Number.isSafeInteger(limits.maxActive ?? 2) && (limits.maxActive ?? 2) >= 1 && (limits.maxActive ?? 2) <= 2)
  assert(Number.isSafeInteger(limits.childTimeoutMs ?? 120_000) && (limits.childTimeoutMs ?? 120_000) > 0 && (limits.childTimeoutMs ?? 120_000) <= 120_000)
  assert(Number.isSafeInteger(limits.rootTimeoutMs ?? 360_000) && (limits.rootTimeoutMs ?? 360_000) > 0 && (limits.rootTimeoutMs ?? 360_000) <= 360_000)
  const id = `p3-root-${label}-${randomUUID()}`
  const controller = new AbortController()
  const rootWork = {
    id: `work-${label}-${randomUUID()}`,
    executionId: `root-execution-${label}-${randomUUID()}`,
    employeeId: 'employee-owner',
    generation: 1,
    active: true,
    controller,
    requestBudget: { limit: requestLimit, accepted: 0, rejected: 0 },
    childBudget: { limit: limits.childLimit ?? 4, maxActive: limits.maxActive ?? 2, started: 0, active: 0, rejected: 0 },
    childTimeoutMs: limits.childTimeoutMs ?? 120_000,
    rootTimeoutMs: limits.rootTimeoutMs ?? 360_000,
    grants: undefined,
    agent: undefined,
    handle: undefined,
  }
  rootWork.grants = Object.freeze(grantSpecs.map(spec => Object.freeze({
    kind: spec.kind ?? 'child',
    rootWorkId: rootWork.id,
    generation: rootWork.generation,
    childWorkId: spec.childWorkId,
    executionId: spec.executionId,
    employeeId: spec.employeeId,
    connectionId: spec.connectionId,
    objectId: spec.objectId,
    allowedTools: Object.freeze([...spec.allowedTools]),
  })))
  rootWork.handle = await harness.ctx.agents.create({ sessionId: id, meta: { cwd: root }, agentOptions: limits.agentOptions ?? ROUTE })
  rootWork.agent = rootWork.handle.agent
  rootWork.dispose = () => rootWork.handle.dispose()
  const rootBinding = Object.freeze({
    kind: 'root',
    rootWork,
    rootWorkId: rootWork.id,
    executionId: rootWork.executionId,
    employeeId: rootWork.employeeId,
    generation: rootWork.generation,
  })
  harness.bindings.set(rootWork.agent, rootBinding)
  await harness.store.bindRoot(rootBinding, rootWork.agent.id)
  harness.record('root-identity-bound', { sessionId: rootWork.agent.id, scenario: label })
  rootWork.agent.ctx.on('agent/request', async ({ agent, signal }, next) => {
    const binding = harness.bindings.get(agent)
    if (binding !== rootBinding || !rootWork.active || binding.generation !== rootWork.generation) throw new Error('P3 root identity is stale or unbound')
    if (signal.aborted) throw signal.reason ?? new Error('P3 root request aborted')
    await harness.store.authorizeRequest(rootBinding)
    if (rootWork.requestBudget.accepted >= rootWork.requestBudget.limit) {
      rootWork.requestBudget.rejected += 1
      throw new Error('P3 root request budget exhausted before model dispatch')
    }
    rootWork.requestBudget.accepted += 1
    await harness.store.reserveRequest(rootWork.id, rootWork.generation)
    harness.record('root-request-budget-reserved', { sessionId: agent.id, scenario: label })
    return next()
  })
  return rootWork
}

async function dispatchChild(harness, rootWork, grant, proposed) {
  if (!rootWork.active || rootWork.controller.signal.aborted) throw new Error('root work is closed before child dispatch')
  if (!Number.isSafeInteger(proposed.budgetLimit) || proposed.budgetLimit < 1 || proposed.budgetLimit > rootWork.requestBudget.limit) {
    throw new Error('request budget must be bounded before child dispatch')
  }
  const childBudget = rootWork.childBudget
  if (childBudget.started >= childBudget.limit || childBudget.active >= childBudget.maxActive) {
    childBudget.rejected += 1
    throw new Error('child dispatch budget exhausted before native start')
  }
  childBudget.started += 1
  childBudget.active += 1
  let reservationCommitted = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    childBudget.active -= 1
    if (!reservationCommitted) childBudget.started -= 1
  }
  let run
  try {
    const signal = AbortSignal.any([rootWork.controller.signal, AbortSignal.timeout(rootWork.childTimeoutMs)])
    run = await harness.ctx.subagents.start('spawn', {
      label: proposed.scenario,
      prompt: [{ type: 'text', text: proposed.prompt ?? `SCENARIO:${proposed.scenario} use the only visible probe tool, then report completion.` }],
      parent: rootWork.agent,
      signal,
      agentOptions: proposed.agentOptions ?? ROUTE,
      outputSchema: {
        type: 'object',
        properties: { scenario: { type: 'string' }, status: { type: 'string', const: 'done' } },
        required: ['scenario', 'status'],
        additionalProperties: false,
      },
      maxDepth: 1,
      toolFilter: { allow: [...grant.allowedTools] },
      persona: `You are ${proposed.employeeId}; use only the visible probe tool.`,
    })
    const binding = Object.freeze({
      kind: 'child',
      rootWork,
      grant,
      rootWorkId: rootWork.id,
      generation: rootWork.generation,
      childWorkId: proposed.childWorkId,
      executionId: proposed.executionId,
      employeeId: proposed.employeeId,
      connectionId: proposed.connectionId,
      objectId: proposed.objectId,
      scenario: proposed.scenario,
      allowedTools: grant.allowedTools,
      budget: { limit: proposed.budgetLimit, accepted: 0, rejected: 0 },
    })
    await bindRun(harness, run, binding)
    reservationCommitted = true
    run.result.then(release, release)
    return run
  } catch (error) {
    if (run) {
      denyRun(harness, run, error)
      await run.dispose().catch(() => undefined)
    }
    release()
    throw error
  }
}

async function bindRun(harness, run, binding) {
  const entry = harness.gates.get(run.id)
  assert(entry, 'native child was not gated at agent/created')
  assert.equal(entry.agent, run.localAgent)
  assert.equal(run.id, run.localAgent.id)
  assert.equal(run.localAgent.session.header.parentSession, binding.rootWork.agent.id)
  assert.equal(run.localAgent.session.header.isSeeded, false)
  assert.equal(run.localAgent.session.header.delegationDepth, 1)
  assert.equal(harness.ctx.agents.isOwnedBy(run.id, binding.rootWork.agent), true)
  const denial = bindingDenial(binding, run.localAgent)
  if (denial) throw new Error(denial)
  entry.binding = binding
  harness.bindings.set(run.localAgent, binding)
  await harness.store.bindChild(binding, run.id)
  harness.record('identity-bound', { sessionId: run.id, scenario: binding.scenario })
  entry.decision.resolve({ ok: true })
}

function denyRun(harness, run, error) {
  const entry = harness.gates.get(run.id)
  if (entry && !entry.decision.settled()) entry.decision.resolve({ ok: false, error })
}

function bindingDenial(binding, agent, toolName) {
  if (!binding || !agent) return 'P3 Agent identity is not bound'
  if (binding.kind !== 'child') return 'P3 root Agent cannot use a child execution grant'
  const { rootWork, grant } = binding
  if (!rootWork.active || rootWork.controller.signal.aborted) return 'P3 root work is cancelled'
  if (binding.generation !== rootWork.generation || grant.generation !== rootWork.generation) return 'P3 root generation is stale'
  if (!rootWork.grants.includes(grant) || grant.kind !== 'child') return 'P3 parent or unknown grant cannot authorize a child'
  if (binding.rootWorkId !== grant.rootWorkId || binding.childWorkId !== grant.childWorkId) return 'P3 child work identity mismatch'
  if (binding.executionId !== grant.executionId || binding.employeeId !== grant.employeeId) return 'P3 execution or employee identity mismatch'
  if (binding.connectionId !== grant.connectionId || binding.objectId !== grant.objectId) return 'P3 connection or object scope mismatch'
  if (agent.session.header.parentSession !== rootWork.agent.id) return 'P3 native parent identity mismatch'
  if (toolName && !binding.allowedTools.includes(toolName)) return 'P3 employee tool scope rejected the call'
  return undefined
}

async function cancelRoot(harness, rootWork, reason) {
  const nextGeneration = rootWork.generation + 1
  await harness.store.cancelRoot(rootWork.id, rootWork.generation, nextGeneration, reason)
  harness.record('root-store-closed', { sessionId: rootWork.agent.id, scenario: reason })
  rootWork.active = false
  rootWork.generation = nextGeneration
  rootWork.controller.abort(new Error('P3 root cancelled'))
  harness.record('root-signal-aborted', { sessionId: rootWork.agent.id, scenario: reason })
}

async function persistReadback(harness, run, result) {
  const binding = harness.bindings.get(run.localAgent)
  const events = run.localAgent.session.snapshotEvents()
  const resultId = `result-${binding.executionId}`
  const readback = {
    resultId,
    rootWorkId: binding.rootWorkId,
    childWorkId: binding.childWorkId,
    executionId: binding.executionId,
    employeeId: binding.employeeId,
    sessionId: run.id,
    output: result.output,
    usage: usageFromEvents(events),
    eventCount: events.length,
    structured: result.structured,
  }
  await harness.store.saveResult(binding, readback)
  await harness.store.saveHandoff(binding, resultId)
  const reopened = await harness.store.read()
  const persisted = reopened.results.find(entry => entry.id === resultId)
  const handoff = reopened.handoffs.find(entry => entry.resultId === resultId)
  assert(persisted && handoff)
  assert.deepEqual(persisted.structured, result.structured)
  assert.equal(persisted.sessionId, run.id)
  return Object.freeze({ ...readback, persisted: true, handoffId: handoff.id })
}

async function persistSummary(harness, rootWork, resultRefs) {
  await harness.store.saveSummary(rootWork.id, rootWork.generation, resultRefs)
  const reopened = await harness.store.read()
  const summary = reopened.summaries.find(entry => entry.rootWorkId === rootWork.id)
  assert(summary)
  assert.deepEqual(summary.resultRefs, resultRefs)
  assert.equal(Object.hasOwn(summary, 'childOutput'), false)
  return summary
}

function usageFromEvents(events) {
  const total = {}
  const seen = new Set()
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    if (event.data.usage) {
      addUsage(total, event.data.usage, seen)
    } else {
      for (const chunk of event.data.stream ?? []) {
        if (chunk.type !== 'usage') continue
        addUsage(total, chunk.usage, seen)
      }
    }
  }
  // pi-ai normalizes an omitted OpenAI usage block to zeroes; zero is therefore
  // not evidence of measured usage on this route and remains unknown.
  return Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].map(key => [
    key,
    seen.has(key) && total[key] !== 0 ? total[key] : null,
  ]))
}

function addUsage(total, usage, seen = undefined) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (!Number.isFinite(usage[key])) continue
    total[key] = (total[key] ?? 0) + usage[key]
    seen?.add(key)
  }
}

function readbackSummary(readback) {
  return {
    mapped: Boolean(readback.rootWorkId && readback.childWorkId && readback.executionId && readback.employeeId),
    sessionId: readback.sessionId,
    eventCount: readback.eventCount,
    usage: readback.usage,
    outputReadable: readback.output.length > 0,
    structuredReadable: readback.structured?.status === 'done',
    persisted: readback.persisted,
  }
}

function verifyTrace(trace) {
  const rootBound = trace.find(entry => entry.type === 'root-identity-bound' && entry.scenario === 'happy')
  const rootReserved = trace.find(entry => entry.type === 'root-request-budget-reserved' && entry.scenario === 'happy')
  const rootModel = trace.find(entry => entry.type === 'model-capture' && entry.scenario === 'parent-canary')
  assert(rootBound && rootReserved && rootModel)
  assert(rootBound.sequence < rootReserved.sequence && rootReserved.sequence < rootModel.sequence)
  for (const scenario of ['happy-a', 'happy-b']) {
    const bound = trace.find(entry => entry.type === 'identity-bound' && entry.scenario === scenario)
    const reserved = trace.find(entry => entry.type === 'request-budget-reserved' && entry.scenario === scenario)
    const model = trace.find(entry => entry.type === 'model-capture' && entry.scenario === scenario)
    const toolAllowed = trace.find(entry => entry.type === 'tool-authorized' && entry.scenario === scenario)
    const tool = trace.find(entry => entry.type === 'tool-capture' && entry.scenario === scenario)
    assert(bound && reserved && model && toolAllowed && tool)
    assert(bound.sequence < reserved.sequence && reserved.sequence < model.sequence)
    assert(toolAllowed.sequence < tool.sequence)
  }
  return { rootMappingBeforeModelIo: true, mappingBeforeModelIo: true, reservationBeforeModelIo: true, authorizationBeforeToolIo: true }
}

function captureTool(name, address, bindings) {
  return defineTool({
    name,
    description: `Local P3 capture tool ${name}.`,
    parameters: { scenario: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          tool: { type: 'string', required: true },
          scenario: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ scenario }, exec) {
      const binding = exec.agent && bindings.get(exec.agent)
      if (binding?.kind !== 'child') throw new Error('capture tool requires a bound child identity')
      const url = new URL(`/tool/${encodeURIComponent(name)}`, address)
      url.searchParams.set('scenario', scenario)
      url.searchParams.set('connectionId', binding.connectionId)
      url.searchParams.set('objectId', binding.objectId)
      const response = await fetch(url, { signal: exec.signal })
      if (!response.ok) throw new Error(`capture tool returned HTTP ${response.status}`)
      return response.json()
    },
  })
}

function createBridgeAuthorizer(harness, address) {
  const credentials = new Map()
  return {
    mint(agent) {
      const binding = harness.bindings.get(agent)
      assert(binding?.kind === 'child')
      const credential = randomUUID()
      const claim = Object.freeze({
        credential,
        agentId: agent.id,
        rootWorkId: binding.rootWorkId,
        generation: binding.generation,
      })
      credentials.set(credential, { claim, used: false })
      return claim
    },
    async call(claim) {
      const entry = credentials.get(claim.credential)
      if (!entry || entry.used) throw new Error('bridge credential is invalid or already used')
      const expected = entry.claim
      if (claim.agentId !== expected.agentId || claim.rootWorkId !== expected.rootWorkId || claim.generation !== expected.generation) {
        throw new Error('bridge identity claim does not match the credential')
      }
      const gate = harness.gates.get(claim.agentId)
      const binding = gate && harness.bindings.get(gate.agent)
      if (!binding || binding.rootWorkId !== claim.rootWorkId || binding.generation !== claim.generation || !binding.rootWork.active) {
        throw new Error('bridge Agent identity is not currently authorized')
      }
      entry.used = true
      const url = new URL('/bridge', address)
      url.searchParams.set('agentId', claim.agentId)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`bridge capture returned HTTP ${response.status}`)
    },
  }
}

async function createProbeStore(path) {
  const initial = { roots: [], executions: [], results: [], handoffs: [], summaries: [] }
  await writeJsonAtomic(path, initial)
  let tail = Promise.resolve()
  const update = operation => {
    const pending = tail.then(async () => {
      const state = JSON.parse(await readFile(path, 'utf8'))
      const result = operation(state)
      await writeJsonAtomic(path, state)
      return result
    })
    tail = pending.catch(() => undefined)
    return pending
  }
  return {
    path,
    async read() {
      await tail
      return JSON.parse(await readFile(path, 'utf8'))
    },
    bindRoot(binding, sessionId) {
      return update(state => {
        assert(!state.roots.some(entry => entry.id === binding.rootWorkId))
        state.roots.push({
          id: binding.rootWorkId,
          sessionId,
          executionId: binding.executionId,
          employeeId: binding.employeeId,
          generation: binding.generation,
          status: 'active',
          requestLimit: binding.rootWork.requestBudget.limit,
          requestCount: 0,
          childTimeoutMs: binding.rootWork.childTimeoutMs,
          rootTimeoutMs: binding.rootWork.rootTimeoutMs,
          memberActive: true,
          employeeActive: true,
        })
      })
    },
    bindChild(binding, sessionId) {
      return update(state => {
        const rootState = activeRoot(state, binding.rootWorkId, binding.generation)
        assert(rootState)
        assert(!state.executions.some(entry => entry.id === binding.executionId))
        state.executions.push({
          id: binding.executionId,
          rootWorkId: binding.rootWorkId,
          childWorkId: binding.childWorkId,
          employeeId: binding.employeeId,
          connectionId: binding.connectionId,
          objectId: binding.objectId,
          sessionId,
          generation: binding.generation,
          status: 'running',
          employeeActive: true,
          connectionActive: true,
          knowledgeActive: true,
        })
      })
    },
    authorizeRequest(binding) {
      return update(state => {
        const rootState = activeRoot(state, binding.rootWorkId, binding.generation)
        assert(rootState, 'request authorization rejected for a closed root generation')
        assert(rootState.memberActive && rootState.employeeActive, 'current member or root employee authorization was revoked')
        if (binding.kind === 'root') return
        const execution = state.executions.find(entry => entry.id === binding.executionId)
        assert(execution && execution.rootWorkId === binding.rootWorkId && execution.generation === binding.generation)
        assert(execution.employeeActive && execution.connectionActive && execution.knowledgeActive, 'current employee, connection, or knowledge authorization was revoked')
      })
    },
    revokeExecution(executionId, scope) {
      return update(state => {
        const execution = state.executions.find(entry => entry.id === executionId)
        assert(execution)
        const rootState = state.roots.find(entry => entry.id === execution.rootWorkId)
        assert(rootState?.status === 'active')
        if (scope === 'member') rootState.memberActive = false
        else if (scope === 'employee') execution.employeeActive = false
        else if (scope === 'connection') execution.connectionActive = false
        else if (scope === 'knowledge') execution.knowledgeActive = false
        else throw new Error(`unknown scope ${scope}`)
      })
    },
    reserveRequest(rootWorkId, generation) {
      return update(state => {
        const rootState = activeRoot(state, rootWorkId, generation)
        assert(rootState, 'request reservation rejected for a closed root')
        assert(rootState.requestCount < rootState.requestLimit, 'persisted root request budget exhausted')
        rootState.requestCount += 1
      })
    },
    cancelRoot(rootWorkId, generation, nextGeneration, reason) {
      return update(state => {
        const rootState = activeRoot(state, rootWorkId, generation)
        assert(rootState, 'root cancellation generation is stale')
        rootState.status = 'cancelled'
        rootState.generation = nextGeneration
        rootState.cancelReason = reason
        for (const execution of state.executions) {
          if (execution.rootWorkId === rootWorkId && execution.status === 'running') execution.status = 'cancelled'
        }
      })
    },
    tryComplete(executionId, generation, value) {
      return update(state => {
        const execution = state.executions.find(entry => entry.id === executionId)
        const rootState = execution && state.roots.find(entry => entry.id === execution.rootWorkId)
        if (!execution || !rootState || rootState.status !== 'active' || rootState.generation !== generation || execution.generation !== generation) return false
        execution.status = value.status
        return true
      })
    },
    saveResult(binding, readback) {
      return update(state => {
        assert(activeRoot(state, binding.rootWorkId, binding.generation), 'late result rejected after root closure')
        const execution = state.executions.find(entry => entry.id === binding.executionId && entry.sessionId === readback.sessionId)
        assert(execution && execution.status === 'running')
        state.results.push({
          id: readback.resultId,
          executionId: binding.executionId,
          sessionId: readback.sessionId,
          usage: readback.usage,
          output: readback.output,
          structured: readback.structured,
        })
        execution.status = 'completed'
      })
    },
    saveHandoff(binding, resultId) {
      return update(state => {
        assert(activeRoot(state, binding.rootWorkId, binding.generation))
        assert(state.results.some(entry => entry.id === resultId))
        state.handoffs.push({
          id: `handoff-${binding.executionId}`,
          rootWorkId: binding.rootWorkId,
          childWorkId: binding.childWorkId,
          fromEmployeeId: binding.employeeId,
          toEmployeeId: binding.rootWork.employeeId,
          resultId,
        })
      })
    },
    saveSummary(rootWorkId, generation, resultRefs) {
      return update(state => {
        assert(activeRoot(state, rootWorkId, generation))
        assert(resultRefs.length > 0 && resultRefs.every(ref => state.results.some(result => result.id === ref)))
        state.summaries.push({ id: `summary-${rootWorkId}`, rootWorkId, resultRefs: [...resultRefs] })
      })
    },
  }
}

function activeRoot(state, rootWorkId, generation) {
  return state.roots.find(entry => entry.id === rootWorkId && entry.status === 'active' && entry.generation === generation)
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function startCaptureServer() {
  const models = []
  const tools = []
  const bridges = []
  const pending = new Set()
  const heldTools = new Map()
  const api = {
    address: undefined,
    models,
    tools,
    bridges,
    record: undefined,
    ioCount: () => models.length + tools.length,
    countScenario: scenario => models.filter(entry => entry.scenario === scenario).length + tools.filter(entry => entry.scenario === scenario).length,
    async waitFor(kind, scenario) {
      const collection = kind === 'tool' ? tools : models
      const deadline = Date.now() + 5_000
      while (!collection.some(entry => entry.scenario === scenario)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${kind} capture in ${scenario}`)
        await pause(10)
      }
    },
    async waitForAbort(kind, scenario) {
      const collection = kind === 'tool' ? tools : models
      const deadline = Date.now() + 5_000
      while (!collection.some(entry => entry.scenario === scenario && entry.aborted)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${kind} abort in ${scenario}`)
        await pause(10)
      }
    },
    releaseTool(scenario) {
      const held = heldTools.get(scenario)
      assert(held, `no held tool response for ${scenario}`)
      heldTools.delete(scenario)
      pending.delete(held.response)
      json(held.response, 200, { ok: true, tool: held.entry.tool, scenario })
    },
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://capture.invalid')
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(request)
        const serialized = JSON.stringify(body)
        const scenario = /SCENARIO:([a-z0-9-]+)/i.exec(serialized)?.[1] ?? 'unknown'
        const entry = {
          scenario,
          tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean),
          parentCanaryPresent: serialized.includes('PARENT_CANARY_'),
          aborted: false,
        }
        models.push(entry)
        pushTrace(api, 'model-capture', { scenario })
        if (scenario === 'cancel-model' || scenario.startsWith('limit-hold') || scenario === 'timeout-child' || scenario === 'timeout-root' || scenario === 'runtime-close-w1') return hold(response, entry, pending)
        const hasToolResult = (body.messages ?? []).some(message => message.role === 'tool')
        const requestedTool = scenario.endsWith('-b') || scenario.startsWith('w2-') ? TOOL_B : TOOL_A
        const nextTool = scenario === 'parent-canary' ? undefined : hasToolResult ? STRUCTURED_OUTPUT : requestedTool
        return sendCompletion(response, body.model ?? 'p3-probe', nextTool, scenario)
      }
      if (request.method === 'GET' && url.pathname.startsWith('/tool/')) {
        const tool = decodeURIComponent(url.pathname.slice('/tool/'.length))
        const scenario = url.searchParams.get('scenario') ?? 'unknown'
        const entry = {
          scenario,
          tool,
          connectionId: url.searchParams.get('connectionId'),
          objectId: url.searchParams.get('objectId'),
          aborted: false,
        }
        tools.push(entry)
        pushTrace(api, 'tool-capture', { scenario, tool })
        if (scenario === 'cancel-tool') return hold(response, entry, pending)
        if (scenario.startsWith('scope-')) {
          pending.add(response)
          heldTools.set(scenario, { response, entry })
          response.on('close', () => {
            pending.delete(response)
            heldTools.delete(scenario)
            if (!response.writableEnded) entry.aborted = true
          })
          return
        }
        return json(response, 200, { ok: true, tool, scenario })
      }
      if (request.method === 'GET' && url.pathname === '/bridge') {
        bridges.push({ agentId: url.searchParams.get('agentId') })
        return json(response, 200, { ok: true })
      }
      json(response, 404, { message: 'not found' })
    } catch (error) {
      json(response, 400, { message: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  api.address = `http://127.0.0.1:${server.address().port}`
  api.close = async () => {
    for (const response of pending) response.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  return api
}

function sendCompletion(response, model, tool, scenario) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const id = `chatcmpl-${randomUUID()}`
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  if (tool) {
    send({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(tool === STRUCTURED_OUTPUT ? { scenario, status: 'done' } : { scenario }) } }] }, finish_reason: null }],
    })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content: `DONE:${scenario}` }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  if (scenario !== 'usage-missing') {
    send({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [],
      usage: scenario === 'usage-partial'
        ? { prompt_tokens: 11, total_tokens: 11 }
        : { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    })
  }
  response.end('data: [DONE]\n\n')
}

function hold(response, entry, pending) {
  pending.add(response)
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  response.write(': waiting for cancellation\n\n')
  response.on('close', () => {
    pending.delete(response)
    if (!response.writableEnded) entry.aborted = true
  })
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 1_000_000) throw new Error('capture request is too large')
  }
  return JSON.parse(raw || '{}')
}

function json(response, statusCode, value) {
  if (response.destroyed || response.headersSent && response.writableEnded) return
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function pushTrace(api, type, data) {
  api.record?.(type, data)
}

function deferred() {
  let resolvePromise
  let done = false
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return {
    promise,
    resolve(value) {
      if (done) return
      done = true
      resolvePromise(value)
    },
    settled: () => done,
  }
}

function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function setEnvironment(values) {
  const previous = new Map()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function launchEnvironment() {
  const values = { ...process.env }
  return {
    get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' },
    getFrom: (name, sources) => sources.includes('process') && values[name] !== undefined ? { value: values[name], source: 'process' } : undefined,
  }
}

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
