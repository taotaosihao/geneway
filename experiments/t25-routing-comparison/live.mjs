import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { connect } from 'node:net'
import { startBridgeService } from '../../scripts/fixtures/multisite/bridge-service.mjs'
import { seedDelegation } from '../../scripts/fixtures/multisite/delegation.mjs'
import { createSimulatedRuntime } from '../../scripts/fixtures/multisite/runtime.mjs'
import { createAgentHost } from '../../packages/agent-host/host.mjs'
import { createHostJournal } from '../../packages/agent-host/journal.mjs'
import { createRemoteClient } from '../../packages/agent-host/remote-client.mjs'
import { createEvidenceCaptures } from '../../packages/agent-host/evidence-captures.mjs'
import { createBudgetService } from '../../src/budget-service.mjs'
import { messageId } from '../../packages/agent-host/delivery.mjs'
import { scenario } from './fixture.mjs'
import { startProvider } from './provider.mjs'
import { hash } from './ablation.mjs'

const nodeId = 't25-node', resourceId = 'fixture:history', policyId = 't25-routing'
const historyCapability = 'evidence.history.read.v1'
const workers = { history: 'desktop-data', maintenance: 'desktop-office' }
const tools = ['geneway_read_history', 'geneway_read_shared_evidence'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))

export async function openArm({ directory, record }) {
  let fixture, provider, host, timer, pump, pumpFailure, active
  const stopPump = async () => { clearInterval(timer); await pump }
  async function close() {
    const failures = []
    for (const action of [stopPump, () => host?.close(), () => fixture?.close(), () => provider?.close()]) {
      try { await action() } catch (error) { failures.push(error.message) }
    }
    const ports = []
    for (const origin of [fixture?.origin, provider?.origin].filter(Boolean)) {
      const port = Number(new URL(origin).port)
      const status = await new Promise(resolve => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.setTimeout(1000, () => { socket.destroy(); resolve('unknown') })
        socket.once('connect', () => { socket.destroy(); resolve('listening') })
        socket.once('error', error => resolve(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'))
      })
      ports.push({ port, status })
      if (status !== 'closed') failures.push('本地端口未确认关闭：' + port)
    }
    await record({ type: 'close', errors: failures, ports, childProcessesStarted: 0 })
    assert.deepEqual(failures, [])
  }
  try {
    provider = await startProvider(value => record({ ...value, round: active?.number ?? null }))
    fixture = await startBridgeService({ directory: join(directory, 'api'), upstreamBaseUrl: provider.origin + '/v1',
      seedState(state) {
        seedDelegation(state)
        for (const employee of state.employees) {
          const refs = employee.id === workers.history ? [resourceId] : []
          employee.placement = { nodeId, mode: 'agent_host', resourceRefs: refs }
          employee.multisitePolicy.execution.resourceRefs = refs
          employee.multisitePolicy.delegation.resourceRefs = []
        }
      } })
    const cloud = () => fixture.store.read()
    await mkdir(join(directory, 'api/secrets'), { mode: 0o700 })
    await writeFile(join(directory, 'api/secrets/key'), 'synthetic-t25-provider', { mode: 0o600 })
    const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json()
    async function api(path, request, method = request === undefined ? 'GET' : 'POST') {
      const sentAt = new Date().toISOString()
      const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, ...(request === undefined ? {} : { body: JSON.stringify(request) }), signal: AbortSignal.timeout(10000) })
      const value = await response.json()
      await record({ type: 'http', round: active?.number ?? null, path, method, request, status: response.status, sentAt, receivedAt: new Date().toISOString(), response: path === '/api/admin/nodes/pairings' ? { ...value, pairingCode: '[redacted]' } : value })
      assert.equal(response.status, 200, JSON.stringify(value))
      return value
    }
    const pairing = await api('/api/admin/nodes/pairings', { clientRequestId: 't25-pair', nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['analysis', ...Object.values(workers)], expiresAt: new Date(Date.now() + 120000).toISOString() })
    const identity = { credential: randomBytes(32).toString('base64url'), nodeInstanceId: randomUUID() }
    const client = createRemoteClient({ origin: fixture.origin, identity })
    const paired = await client.post('/internal/nodes/pair', { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 't25-redeem', ...identity })
    identity.registrationRevision = paired.node.registrationRevision
    await api('/api/admin/resources/' + encodeURIComponent(resourceId), { clientRequestId: 't25-resource', expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: 'history_directory', ownerNodeId: nodeId, capabilityIds: [historyCapability], evidenceReaderAgentIds: [workers.history], enabled: true }, 'PUT')
    await mkdir(join(directory, 'host'), { mode: 0o700 })
    const journal = createHostJournal(join(directory, 'host/journal.json')), sessionsPath = join(directory, 'host/sessions.json')
    const runtime = createSimulatedRuntime({ path: sessionsPath })
    const evidence = createEvidenceCaptures({ journal, root: join(directory, 'host/evidence'), client, profile: { profileVersion: 1, resources: [{
      resourceId, capabilityIds: [historyCapability], adapterKind: 'history_json', root: dirname(fileURLToPath(import.meta.url)),
      datasets: { history: 'history.json' }, fixedFiles: {}, allowedSections: [], maxBytes: 65536, maxEntries: 48,
      maxWindowSeconds: 3600, exportToAgentIds: [workers.history], clockTrust: 'fixture',
    }] } })
    host = createAgentHost({ nodeId, journal, runtime, evidence, maxActiveLoops: 2 })
    host.setOrchestrationHandler({ call: (execution, operation, parameters, context) => client.command(execution, operation, parameters, context), event: event => client.event(event) })
    timer = setInterval(() => {
      if (pump || pumpFailure) return
      pump = (async () => {
        for (const delivery of (await client.resync()).pending) {
          const command = await client.resolveCommand(delivery)
          await host.accept({ workspaceId: 'local', nodeId }, command)
          await client.ack(command)
        }
        await host.process()
        await host.flushEvents(event => client.event(event))
      })().catch(error => { pumpFailure = error }).finally(() => { pump = undefined })
    }, 45)
    async function until(label, predicate) {
      const deadline = Date.now() + 12000
      do {
        if (pumpFailure) throw pumpFailure
        const value = await predicate(await cloud())
        if (value) return value
        await setTimeout(45)
      } while (Date.now() < deadline)
      throw Error('等待超时：' + label)
    }
    const historySha256 = hash(await readFile(new URL('./history.json', import.meta.url)))
    const modelPrices = (await cloud()).modelRoutes.filter(row => row.enabled).map(({ provider, model }) => ({ provider, model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }))
    const policy = (coordinatorAgentId, routing = false) => ({ workspaceId: 'local', coordinatorAgentId, enabled: true, accountingMode: 'conservative_estimate',
      limits: { maxModelRequests: routing ? 3 : 40, maxReservedTokens: routing ? 262144 : 1000000, maxReservedCostMicros: 1000 },
      executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices })
    await api('/api/admin/routing-policies/' + policyId, { clientRequestId: policyId, expectedRevision: null, workspaceId: 'local', routerAgentId: 'analysis', routerNodeId: nodeId, enabled: true, maxOutputTokens: 256, budget: policy('analysis', true) }, 'PUT')
    const budgets = createBudgetService({ store: fixture.store })
    for (const [name, agent] of Object.entries(workers)) await budgets.putPolicy({ id: 'owner' }, 't25-' + name, { clientRequestId: 't25-budget-' + name, expectedRevision: null, ...policy(agent) })
    const execution = async workId => (await journal.read()).executions.find(row => row.work_id === workId)
    const workOf = (state, id) => state.works.find(row => row.id === id)
    const inputOf = (state, id) => state.multisite.inputs.find(row => row.id === id)
    const actualInput = id => until('实际消费 Input ' + id, state => inputOf(state, id)?.deliveries.some(row => row.ingestedAt) && inputOf(state, id))
    const review = (intentId, answerId) => until('实际消费意图 ' + intentId, state => {
      const command = state.multisite.outbox.findLast(row => row.command.operation === 'intent_review' && row.command.parameters.intentFence?.intentId === intentId && (answerId === undefined || row.command.parameters.intentAnswer?.eventId === answerId))?.command
      return command && state.contextSubscriptions.find(row => row.id === state.workIntents.find(intent => intent.id === intentId)?.handlerSubscriptionId)?.ingestedAt && command
    })
    const stop = async (round, name) => {
      const id = round.works[name]
      if (!id || ['cancelled', 'completed'].includes(workOf(await cloud(), id)?.status)) return
      const reply = await api('/api/works/' + id + '/multisite/cancel', { clientRequestId: round.key + '-stop-' + name })
      return reply
    }
    async function model(execution, source, phase, input, command, tail) {
      const inputMessageId = messageId(input.id ?? command.input_id, execution.attempt_id, execution.session_id)
      const messages = [{ role: 'user', content: JSON.stringify({ sourceEventId: source.id, text: source.text, phase, instructionRevision: input.revision ?? command.instruction_revision }) }]
      for (let step = 0; step < 8; step++) {
        const issued = command ? await client.issueIntentReview(execution, command.command_id, { request: true, inputMessageId }) : await client.issue(execution, { request: true, inputMessageId })
        const response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' },
          body: JSON.stringify({ model: issued.modelSnapshot.model, stream: true, max_tokens: 256, messages, tools: tail ? tools : [] }), signal: AbortSignal.timeout(12000) })
        const raw = await response.text()
        assert(response.ok && raw.includes('data: [DONE]'), raw)
        const chunks = raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
        const delta = chunks.map(chunk => chunk.choices[0]?.delta).find(value => value?.content || value?.tool_calls)
        assert(delta)
        if (delta.content) return delta.content
        const [call] = delta.tool_calls, args = JSON.parse(call.function.arguments)
        const op = { geneway_read_history: 'read_history', geneway_read_shared_evidence: 'read_shared_evidence' }[call.function.name]
        assert(tail && op)
        await setTimeout(scenario.toolDelayMs)
        const result = await runtime.evidence(execution, op, args)
        await record({ type: 'tool', round: active.number, sourceEventId: source.id, workId: execution.work_id, sessionId: execution.session_id, op, args, result, completedAt: new Date().toISOString() })
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: call.type, function: call.function }] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
      throw Error('模型工具轮超出固定上限')
    }
    function workQueue(round, workId, eventId, job) {
      const next = (round.jobs.get(workId) ?? Promise.resolve()).then(job).catch(async error => {
        round.errors.push(eventId)
        await record({ type: 'worker-failure', round: round.number, eventId, message: error.message, code: error.code ?? null })
      })
      round.jobs.set(workId, next)
    }
    async function processEvent(round, event, receipt) {
      const source = (await cloud()).sourceEvents.find(row => row.id === receipt.eventId)
      assert(source)
      let workId, command
      if (event.work) {
        const intent = (await cloud()).workIntents.find(row => row.id === receipt.intentId)
        if (intent?.state !== 'accepted') return
        workId = intent.workId
      } else {
        command = await review(receipt.intentId, event.answerTo ? receipt.eventId : undefined)
        workId = command.work_id
      }
      workQueue(round, workId, event.id, async () => {
        const exec = await execution(workId)
        assert(exec)
        if (command) {
          const fence = command.parameters.intentFence
          const reviewText = await model(exec, source, 'review', {}, command, false)
          const instructionRevision = workOf(await cloud(), workId).instructionRevision
          const accepted = await runtime.orchestration(exec, 'accept_intent', { clientRequestId: round.key + '-accept-' + event.id, intentFence: fence, expectedInstructionRevision: instructionRevision })
          const input = await actualInput(accepted.inputId)
          const text = event.id === 'known-tail' ? await model(exec, source, 'execution', input, undefined, true) : reviewText
          await runtime.orchestration(exec, 'reply_intent', { clientRequestId: round.key + '-reply-' + event.id, intentId: receipt.intentId, inputId: input.id, text })
        } else {
          const intent = (await cloud()).workIntents.find(row => row.id === receipt.intentId)
          const input = await actualInput(intent.acceptedInputId)
          await model(exec, source, 'execution', input, undefined, false)
        }
      })
    }
    async function threadSeed(round, name, workId, label, text) {
      const threadId = round.threads[name], path = '/api/interaction/threads/' + threadId
      const { thread } = await api(path)
      const source = await api(path + '/events', { clientRequestId: round.key + '-' + label, sourceEventId: round.key + '-' + label, version: 1, expectedThreadRevision: thread.revision, text })
      const query = round.key, directory = await api('/api/interaction/directory?query=' + query)
      await api(path + '/selection', { clientRequestId: round.key + '-select-' + label, intentId: source.intentId, expectedRouteRevision: source.routeRevision, targetWorkId: workId, candidateVersion: directory.candidateVersion, offset: 0, query })
      const command = await review(source.intentId)
      round.seeds[label] = source
      return command
    }
    return {
      async prepareRound(number) {
        assert(!active || active.closed, '上一轮未结束')
        const round = active = { key: 't25-r' + number, number, works: {}, threads: {}, seeds: {}, submitted: {}, jobs: new Map(), pending: [], errors: [] }
        for (const [name, agent] of Object.entries(workers)) {
          const work = await api('/api/works', { workType: 'multisite', employeeId: agent, goal: round.key + (name === 'history' ? ' 事件历史核对' : ' 维护台账核对'), clientRequestId: round.key + '-' + name, attachmentRefs: [], budgetPolicyId: 't25-' + name })
          round.works[name] = work.id
          await until('初始要求实际消费', state => state.multisite.inputs.some(row => row.workId === work.id && row.deliveries.some(delivery => delivery.ingestedAt)))
        }
        for (const name of ['known', 'maintenance', 'questions', 'unbound', 'separate']) {
          const { id } = await api('/api/interaction/threads', { clientRequestId: round.key + '-thread-' + name, title: round.key + ' ' + name })
          round.threads[name] = id
        }
        for (const [name, target, label] of [['known', 'history', 'subscription-seed'], ['maintenance', 'maintenance', 'maintenance-seed']]) {
          const command = await threadSeed(round, name, round.works[target], label, '预先建立此线程与工作处理者的正常订阅。')
          const exec = await execution(command.work_id)
          const result = await runtime.orchestration(exec, 'accept_intent', { clientRequestId: round.key + '-accept-' + label, intentFence: command.parameters.intentFence, expectedInstructionRevision: 1 })
          await actualInput(result.inputId)
        }
        const command = await threadSeed(round, 'questions', round.works.maintenance, 'question-seed', '核对维护台账的日期范围。')
        const question = await runtime.orchestration(await execution(command.work_id), 'ask_intent', { clientRequestId: round.key + '-ask', intentFence: command.parameters.intentFence, text: '请明确要核对的维护台账时间范围。' })
        round.question = { id: question.questionId, routeRevision: command.parameters.intentFence.routeRevision }
        const state = await cloud()
        const comparisonInputs = {
          historySha256, modelRoutes: state.modelRoutes, routingPolicy: state.routingPolicies.find(row => row.id === policyId),
          budgetPolicies: state.budgetPolicies, owner: state.members.find(row => row.id === 'owner'),
          employees: state.employees, resources: state.resources, hostSlots: 2,
        }
        return { works: round.works, threads: round.threads, seeds: round.seeds, question: round.question, nodeId, provider: provider.origin, api: fixture.origin, comparisonInputs }
      },
      async submit(number, event) {
        const round = active
        assert.equal(round.number, number)
        if (event.operation === 'stop') return stop(round, event.work)
        const path = '/api/interaction/threads/' + round.threads[event.thread]
        const { thread } = await api(path)
        const body = event.replay ? { ...round.submitted[event.replay], clientRequestId: round.key + '-' + event.id, expectedThreadRevision: thread.revision } : {
          clientRequestId: round.key + '-' + event.id, sourceEventId: round.key + '-' + event.id, version: 1, expectedThreadRevision: thread.revision,
          text: event.text, routingPolicyId: policyId, directoryQuery: round.key,
          ...(event.work ? { workId: round.works[event.work], expectedInstructionRevision: workOf(await cloud(), round.works[event.work]).instructionRevision } : {}),
          ...(event.replyTo ? { replyToEventId: round.seeds[event.replyTo].eventId } : {}),
          ...(event.answerTo ? { replyToIntentQuestion: round.question } : {}),
        }
        const receipt = await api(path + '/events', body)
        round.submitted[event.id] = body
        if (!event.replay && (event.work || event.replyTo || event.answerTo)) {
          round.pending.push(processEvent(round, event, receipt).catch(async error => {
            round.errors.push(event.id); await record({ type: 'worker-failure', round: round.number, eventId: event.id, message: error.message, code: error.code ?? null })
          }))
        }
        return receipt
      },
      async finishRound(number, results) {
        const round = active
        assert.equal(round.number, number)
        await Promise.all(round.pending)
        await Promise.all(round.jobs.values())
        await until('路由和人可见回复结算', state => !state.routingRequests.some(row => row.state === 'pending') && !state.intentReplies.some(row => row.state === 'queued'))
        const projections = {}
        for (const [name, id] of Object.entries(round.threads)) projections[name] = await api('/api/interaction/threads/' + id)
        const beforeCleanup = await cloud()
        for (const name of scenario.workNames) await stop(round, name)
        const terminal = await until('本轮 Work 已停止', state => scenario.workNames.every(name => workOf(state, round.works[name]).status === 'cancelled') && state)
        const root = join(directory, round.key)
        await mkdir(root)
        const save = async (name, value) => { const path = join(root, name + '.json'); await writeFile(path, JSON.stringify(value, null, 2)); return path }
        const raw = { beforeCleanup: await save('cloud-before-cleanup', beforeCleanup), cloud: await save('cloud', terminal), host: await save('host', await journal.read()),
          sessions: await save('sessions', JSON.parse(await readFile(sessionsPath, 'utf8'))), projections: await save('owner-projections', projections) }
        round.closed = true
        return { raw, submitted: results.length, workerFailures: round.errors, providerFailures: provider.failures.slice() }
      },
      async abortRound(number) {
        const round = active
        if (round?.number !== number || round.closed) return
        await Promise.all(round.pending)
        await Promise.all(round.jobs.values())
        for (const name of Object.keys(round.works)) await stop(round, name)
        const snapshot = await until('失败轮次隔离', state => Object.values(round.works).every(id => ['cancelled', 'completed'].includes(workOf(state, id)?.status)) && !state.routingRequests.some(row => row.state === 'pending') && state)
        const path = join(directory, round.key + '-failed-cloud.json')
        await writeFile(path, JSON.stringify(snapshot, null, 2))
        await record({ type: 'failed-snapshot', round: number, path })
        round.closed = true
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
