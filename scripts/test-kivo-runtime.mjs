import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { assertKivoTpmTools, KIVO_MCP_SCOPE } from '../plugins/kivo-tpm.mjs'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { KIVO_TPM_TOOLS, tpmSourcePath } from '../src/domain/tpm.mjs'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { createKnowledgeService } from '../src/knowledge-service.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const fixturePath = process.argv[2]
assert.ok(fixturePath, '请显式传入脱敏 tpm-wire-tools.json；不寻找或读取其他项目凭据')
const fixtureBytes = await readFile(fixturePath)
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), 'a50cfe4688335c79369e06c3672450b01f830af711696080ec5265a47f16a7dd', '必须使用 P6 已冻结的13-tool脱敏目录')
const tools = JSON.parse(fixtureBytes).map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }))
assert.equal(assertKivoTpmTools(tools).size, 13)
const temp = await mkdtemp(join(tmpdir(), 'geneway-kivo-runtime-'))
const home = join(temp, 'dsh'), secretRoot = join(temp, 'secrets'), stateFile = join(temp, 'state.json')
process.env.DSH_HOME = home
process.env.GENEWAY_SECRET_ROOT = secretRoot
process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
const actor = { id: 'owner' }, admin = { id: 'admin' }, read = 'kivo-tpm-record-read', list = 'kivo-tpm-record-list'
const deviceId = '00000000-0000-4000-8000-000000000001', recordId = '00000000-0000-4000-8000-000000000002'
const now = '2026-10-15T14:00:00.000Z', recordCanary = 'TPM-FACT-CANARY', standardCanary = 'TPM-STANDARD-CANARY'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const servers = [], failures = [], hooks = {}, modelEvents = []
const store = createFileStore(stateFile)
let service, shared, direct, mounted, remounted, model, a, b, failure, report, beforeSdkReply
try {
  await mkdir(secretRoot, { mode: 0o700 })
  for (const name of ['instance-a.pem', 'instance-b.pem']) await writeFile(join(secretRoot, name), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(join(secretRoot, 'model.key'), 'synthetic-local-model-key', { mode: 0o600 })
  model = await captureModel()
  process.env.GENEWAY_P3_CAPTURE_BASE_URL = `${model.address}/v1`
  a = await captureKivo('instance-a', 'reported')
  b = await captureKivo('instance-b', 'repairing')
  const catalog = [target(a.connection), target(b.connection)]
  await store.update(state => seed(state, [a.connection, b.connection]))
  const config = readRuntimeConfig({ GENEWAY_DSH_HOME: home, GENEWAY_STATE: stateFile, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'model.key' })
  const patch = join(temp, 'capture.patch.yml')
  await writeFile(patch, `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local controlled capture\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: ${model.address}/v1\n        models:\n          - id: deepseek/deepseek-v4.1-flash\n            contextWindow: 200000\n            maxOutputTokens: 8192\n`, { mode: 0o600 })
  direct = createDshRunner({ config, harnessFactory: options => new DeepSeekHarness({ ...options, patches: [...options.patches, patch], env: { ...options.env, ...auditEnvironment() } }) })
  service = createWorkService({ store, runner: { ...direct, async run(options) { try { const result = await direct.run(options); await beforeSdkReply?.(); return result } catch (error) { failures.push(error); throw error } } }, connectionCatalog: catalog, policyPaths: { stateFile, dataRoot: temp, secretRoot } })
  const single = await service.createWork(actor, workBody('a', read, { recordType: 'repair', reference: 'R-1' }, 'single'))
  const first = await waitWork(single.value.id)
  assert.equal(first.results[0].kind, 'kivo.tpm.observation')
  assert.equal(first.results[0].payload.records[0].facts.detail.reason, recordCanary)
  assert.equal(first.results[0].payload.linkedDevice.id, deviceId)
  assert.deepEqual(a.calls.map(call => call.name), ['tpm.repair.get', 'devices.device.get'])
  const oldObservation = structuredClone(first.results[0])
  await service.followUp(actor, first.id, '解释当前获准事实', { clientRequestId: 'single-follow' })
  await waitWork(first.id, 'completed', 2)
  assert.deepEqual((await service.getWork(actor, first.id)).value.results[0], oldObservation)
  assert.equal(a.calls.length, 2, 'fact-only follow-up must not query Kivo again')
  beforeSdkReply = async () => { await store.update(state => ({ ...state, employees: state.employees.map(employee => employee.id === 'a' ? { ...employee, enabled: false } : employee) })) }
  const lateBusiness = await service.createWork(actor, workBody('a', read, { recordType: 'repair', reference: 'R-1' }, 'late-business'))
  const businessDenied = await waitWork(lateBusiness.value.id, 'failed')
  assert.equal(businessDenied.executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(businessDenied.results.length, 0)
  await store.update(state => ({ ...state, employees: state.employees.map(employee => ({ ...employee, enabled: true })) }))
  beforeSdkReply = async () => { await store.update(state => ({ ...state, connections: state.connections.map(connection => connection.id === 'instance-a' ? { ...connection, revision: connection.revision + 1 } : connection) })) }
  await service.followUp(actor, first.id, '晚到追问不能越过连接撤销', { clientRequestId: 'late-follow' })
  const followDenied = await waitWork(first.id, 'failed')
  assert.equal(followDenied.executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(followDenied.results.length, 2)
  assert.equal(a.calls.length, 4, 'late fact-only follow-up must not add Kivo I/O')
  beforeSdkReply = undefined
  await service.close()
  service = undefined

  if (process.argv.includes('--sdk-settlement-only')) {
    report = { ok: true, scope: 'sdk-settlement-only', nativeSdk: true, nativeSharedHost: false, businessAndFollowUpPositive: true, businessRevocationBeforePersistence: true, followUpRevisionChangeBeforePersistence: true, oldResultsUnchanged: true, modelRequests: modelEvents.length, realProviderRequests: 0, realKivoRequests: 0, dataMode: 'synthetic' }
  } else {
  shared = createCollaborationRunner({ store, dshHome: home, secretRoot, connectionCatalog: catalog,
    environment: { GENEWAY_P3_CAPTURE_BASE_URL: `${model.address}/v1`, GENEWAY_P3_CAPTURE_KEY: 'synthetic-capture-key' },
    agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 4096 },
    testHooks: { ...hooks, onKivoMounted(value) { mounted = value }, beforeFinishChild: (...args) => hooks.beforeFinishChild?.(...args), beforeSummaryProjection: (...args) => hooks.beforeSummaryProjection?.(...args) },
    onError(error) { failures.push(error) },
  })
  service = createWorkService({ store, collaborationRunner: shared, connectionCatalog: catalog })
  const material = await createKnowledgeService({ store }).createMaterial(actor, { employeeIds: ['lead', 'a', 'b'], title: '维护标准', body: `${standardCanary}：维修报告必须包含设备和原因；维护计划需核对版本。`, format: 'text', sourceLabel: '本机合成标准', authorizationBasis: '成员导入合成材料' })
  const j6 = await collaboration('j6', [tpmItem('A', 'a', 'repair', 'R-1'), { ...tpmItem('B', 'b', 'plan', recordId), knowledgeQuery: standardCanary, dependsOn: ['A'] }])
  const complete = await waitWork(j6.value.id)
  const state = await store.read(), children = state.works.filter(work => work.rootWorkId === complete.id)
  assert.equal(children.length, 2)
  assert.equal(complete.handoffs.length, 2)
  assert.equal(complete.results.at(-1).payload.resultRefs.length, 2)
  assert.equal(new Set(children.map(work => work.results[0].dshSessionRef)).size, 2)
  const childB = children.find(work => work.planItemId === 'B')
  assert.deepEqual(childB.results[0].knowledgeDependencyRefs, [{ knowledgeId: material.id, revision: 1, segmentId: 'p1-c1' }])
  const bRequests = modelEvents.filter(event => event.scenario === 'B')
  assert.equal(bRequests[0].recordCanary, true, 'B must receive the current A typed fact, before any B source query')
  assert.equal(bRequests[0].standardCanary, true, 'B receives only its explicit knowledge query until search returns the segment')
  assert.deepEqual(bRequests[0].toolNames.filter(name => name !== 'structured_output').sort(), [KIVO_TPM_TOOLS.readRecord, 'geneway_knowledge_search', 'geneway_knowledge_submit_references'].sort())
  assert.equal(modelEvents.filter(event => event.scenario === 'A')[0].standardCanary, false)
  assert.equal(b.calls.some(call => call.name === 'tpm.repair.get'), false, 'B must not repeat A source query as a substitute for handoff')
  assert.equal(b.calls.some(call => call.name === 'tpm.plan.get'), true)
  const sameNumber = await collaboration('same-number', [tpmItem('same-number-B', 'b', 'repair', 'R-1')])
  await waitWork(sameNumber.value.id)
  const sameNumberChild = (await store.read()).works.find(work => work.rootWorkId === sameNumber.value.id)
  assert.equal(sameNumberChild.results[0].source.sourceInstance, 'instance-b')
  assert.equal(sameNumberChild.results[0].payload.records[0].rawStatus, 'repairing')
  assert.equal(oldObservation.payload.records[0].rawStatus, 'reported')

  const waiting = await collaboration('waiting', [tpmItem('wait-A', 'a', 'repair', 'R-1'), { ...tpmItem('wait-B', 'b', 'plan'), dependsOn: ['wait-A'] }])
  await waitWork(waiting.value.id, 'waiting_input')
  const beforeWait = (await store.read()).works.find(work => work.rootWorkId === waiting.value.id && work.planItemId === 'wait-B')
  assert.equal(beforeWait.executions.length, 0)
  const edited = await service.updateCollaborationPlan(actor, waiting.value.id, { expectedRevision: 1, items: [{ id: 'wait-B', employeeId: 'lead', goal: '按当前维护计划补充核对' }] })
  assert.equal(edited.value.plan.revision, 2)
  assert.equal((await service.continueCollaboration(actor, waiting.value.id, { clientRequestId: 'wait-next', inputs: { 'wait-B': { reference: recordId } } })).ok, true)
  await waitWork(waiting.value.id)

  const revoked = await deferredCollaboration('recipient-revoked', [tpmItem('scope-A', 'a', 'repair', 'R-1'), { ...tpmItem('scope-B', 'b', 'plan', recordId), dependsOn: ['scope-A'] }])
  hooks.beforeFinishChild = async binding => {
    const child = (await store.read()).works.find(work => work.id === binding.workId)
    if (child.planItemId !== 'scope-A') return
    await store.update(state => ({ ...state, employees: state.employees.map(employee => employee.id === 'b' ? { ...employee, connectionIds: [] } : employee) }))
  }
  const beforeScope = modelEvents.filter(event => event.scenario === 'scope-B').length
  await shared.run(revoked.value.id).catch(() => undefined)
  assert.equal((await waitWork(revoked.value.id, 'failed')).executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(modelEvents.filter(event => event.scenario === 'scope-B').length, beforeScope)
  delete hooks.beforeFinishChild
  await store.update(state => ({ ...state, employees: state.employees.map(employee => employee.id === 'b' ? { ...employee, connectionIds: ['instance-a', 'instance-b'] } : employee) }))

  const finishDenied = await deferredCollaboration('finish-revoked', [tpmItem('finish-A', 'a', 'repair', 'R-1')])
  hooks.beforeFinishChild = async binding => {
    if (binding.rootWorkId !== finishDenied.value.id) return
    await store.update(state => ({ ...state, connections: state.connections.map(connection => connection.id === 'instance-a' ? { ...connection, enabled: false } : connection) }))
  }
  await shared.run(finishDenied.value.id).catch(() => undefined)
  await waitWork(finishDenied.value.id, 'failed')
  const afterFinish = await store.read()
  assert.equal(afterFinish.works.find(work => work.rootWorkId === finishDenied.value.id).results.length, 0)
  assert.equal(afterFinish.works.find(work => work.id === finishDenied.value.id).handoffs.length, 0)
  delete hooks.beforeFinishChild
  await store.update(state => ({ ...state, connections: state.connections.map(connection => ({ ...connection, enabled: true })) }))

  const secondHopDenied = await deferredCollaboration('second-hop-revoked', [tpmItem('second-hop-A', 'a', 'repair', 'R-1')])
  const beforeHop = a.calls.length
  a.afterCall = async () => { await store.update(state => ({ ...state, connections: state.connections.map(connection => connection.id === 'instance-a' ? { ...connection, enabled: false } : connection) })) }
  await shared.run(secondHopDenied.value.id).catch(() => undefined)
  assert.equal((await waitWork(secondHopDenied.value.id, 'failed')).executions.at(-1).error.code, 'FORBIDDEN')
  assert.equal(a.calls.length - beforeHop, 1, 'revocation after the repair response must block device second-hop I/O')
  delete a.afterCall
  await store.update(state => ({ ...state, connections: state.connections.map(connection => ({ ...connection, enabled: true })) }))

  a.hold = true
  const cancelling = await collaboration('cancel', [tpmItem('cancel-A', 'a', 'repair', 'R-1')])
  await until(() => a.pending.size > 0, 'Kivo tool did not enter controlled I/O')
  const independent = await collaboration('independent', [cycleItem('independent-B')])
  assert.equal((await service.cancel(actor, cancelling.value.id)).accepted, true)
  await waitWork(independent.value.id)
  await until(() => a.pending.size === 0, 'Kivo in-flight request was not aborted')
  assert.equal((await service.getWork(actor, cancelling.value.id)).value.status, 'cancelled')
  a.hold = false

  const ctx = mounted.ctx, originalHost = ctx
  assert.deepEqual(kivoNames(ctx), Object.values(KIVO_TPM_TOOLS).sort())
  a.hold = true
  const unloading = await collaboration('unload', [tpmItem('unload-A', 'a', 'repair', 'R-1')])
  await until(() => a.pending.size > 0, 'unload request did not enter controlled I/O')
  const unloadStarted = Date.now()
  await mounted.fiber.dispose()
  await until(() => a.pending.size === 0, 'plugin disposal did not abort its in-flight HTTP request')
  const unloadElapsedMs = Date.now() - unloadStarted
  assert(unloadElapsedMs < 3000, 'plugin disposal must abort supported HTTP I/O, rather than wait for its 15-second timeout')
  await waitWork(unloading.value.id, 'cancelled')
  assert.deepEqual(kivoNames(ctx), [])
  a.hold = false
  const cycle = await collaboration('after-unload', [cycleItem('after-unload-B')])
  await waitWork(cycle.value.id)
  const chat = await shared.runChatTurn({ conversationId: 'synthetic-chat', turnId: 'synthetic-turn', sessionId: null, text: 'SCENARIO:plain-chat 合成普通对话', instructions: '', authorize: async () => {}, onSession: async () => {} })
  assert.equal(chat.stopReason, 'completed')
  assert.deepEqual(modelEvents.find(event => event.scenario === 'plain-chat').toolNames, [])
  remounted = ctx.plugin(mounted.plugin)
  await remounted
  assert.equal(ctx, originalHost)
  assert.deepEqual(kivoNames(ctx), Object.values(KIVO_TPM_TOOLS).sort())
  const afterRemount = await collaboration('remount', [tpmItem('remount-A', 'a', 'repair', 'R-1')])
  await waitWork(afterRemount.value.id)
  assert.equal((await service.getWork(actor, j6.value.id)).value.results.at(-1).payload.resultRefs.length, 2)
  const expectedNegativeCodes = failures.map(error => ({ code: error.code ?? null, name: error.name }))
  assert.deepEqual(expectedNegativeCodes.map(error => error.code).sort(), ['CANCELLED', 'CANCELLED', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
  report = { ok: true, nativeSdk: true, nativeSharedHost: true, sameHost: ctx === originalHost, toolsAfterRemount: kivoNames(ctx), typedHandoff: true, knowledgeRevision: 1, recipientRevocationBeforeModel: true, finishRevocationBeforePersistence: true, secondHopRevocationBeforeIo: true, twoInstancesSameNumber: true, independentCancel: true, pluginDisposeAbortsIo: true, unloadElapsedMs, chatAfterDispose: true, expectedNegativeCodes, modelRequests: modelEvents.length, kivoCalls: { a: a.calls.length, b: b.calls.length }, realProviderRequests: 0, realKivoRequests: 0, dataMode: 'synthetic' }
  }
} catch (error) { failure = error }
finally {
  for (const cleanup of [() => remounted?.dispose(), () => service?.close(), () => shared?.close(), () => direct?.close(), ...servers.map(server => async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }), () => rm(temp, { recursive: true, force: true })]) {
    try { await cleanup() } catch (error) { failure = failure ? new AggregateError([failure, error], 'Kivo native check and cleanup failed', { cause: failure }) : error }
  }
}
if (failure) throw failure
console.log(JSON.stringify(report))

function seed(state, connections) {
  return { ...state, members: ['owner', 'admin'].map(id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, sessionVersion: 1, employeeIds: ['lead', 'a', 'b'] })), modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', enabled: true, credentialRef: 'ZENMUX_API_KEY' }], employees: ['lead', 'a', 'b'].map(id => ({ id, name: id, enabled: true, modelRouteId: 'model', revision: 1, skillIds: [read, list, 'cycle-time-calculate'].map(id => `skill-${id}`), connectionIds: connections.map(connection => connection.id) })), skills: [read, list, 'cycle-time-calculate'].map(id => ({ id: `skill-${id}`, capabilityId: id, enabled: true })), connections }
}
function target(connection) { return Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]])) }
function auditEnvironment() {
  // The current audit owns the verified SDK spawn and propagates its explicit binding.
  if (process.env.GENEWAY_NETWORK_AUDIT_ROLE === 'host') return {}
  return Object.fromEntries(['NODE_OPTIONS', 'GENEWAY_NETWORK_AUDIT_LOG', 'GENEWAY_NETWORK_SECRET_CANARY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
}
function workBody(employeeId, capabilityId, input, clientRequestId) { return { employeeId, skillId: `skill-${capabilityId}`, connectionId: `instance-${employeeId}`, input, clientRequestId } }
function tpmItem(id, employeeId, recordType, reference) { return { id, employeeId, skillId: `skill-${read}`, connectionId: `instance-${employeeId}`, goal: `SCENARIO:${id} 核对当前获准TPM事实`, input: { recordType, ...(reference ? { reference } : {}) } } }
function cycleItem(id) { return { id, employeeId: 'b', skillId: 'skill-cycle-time-calculate', goal: id, input: { availableSeconds: 60, quantity: 2 } } }
function collaboration(id, items, workService = service) { return workService.createCollaboration(actor, { employeeId: 'lead', skillId: `skill-${read}`, connectionId: 'instance-a', goal: id, clientRequestId: id, items }) }
async function deferredCollaboration(id, items) { const staged = createWorkService({ store, connectionCatalog: [target(a.connection), target(b.connection)], collaborationRunner: { async run() {} } }); return collaboration(id, items, staged) }
function kivoNames(ctx) { return ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('geneway_kivo_tpm_')).sort() }
async function until(check, message) { const end = Date.now() + 15_000; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } assert.fail(message) }
async function waitWork(id, status = 'completed', resultCount) { let work; await until(async () => { work = (await service.getWork(actor, id)).value; if (work.status === 'failed' && status !== 'failed') throw failures.at(-1) ?? new Error(JSON.stringify(work.executions.at(-1)?.error)); return work.status === status && (resultCount === undefined || work.results.length === resultCount) }, `work did not reach ${status}`); return work }
async function readBody(request) { const parts = []; for await (const part of request) parts.push(part); return Buffer.concat(parts).toString('utf8') }
async function listen(server) { servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return `http://127.0.0.1:${server.address().port}` }
function textOf(body) { return (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n')).join('\n') }
function jsonAfter(text, marker) { const start = text.indexOf('{', text.indexOf(marker) + marker.length); let depth = 0, quoted = false, escaped = false; for (let index = start; index < text.length; index += 1) { const char = text[index]; if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false } else if (char === '"') quoted = true; else if (char === '{') depth += 1; else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1)) } throw new Error('synthetic prompt JSON missing') }

async function captureModel() {
  const server = createServer(async (request, response) => {
    try {
      assert(request.url === '/v1/chat/completions')
      const body = JSON.parse(await readBody(request)), text = textOf(body)
      const names = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name), toolMessages = (body.messages ?? []).filter(message => message.role === 'tool')
      const scenario = /SCENARIO:([a-zA-Z0-9-]+)/.exec(text)?.[1] ?? 'single'
      modelEvents.push({ scenario, toolNames: names, recordCanary: text.includes(recordCanary), standardCanary: text.includes(standardCanary) })
      const requestedTool = /必须且只能调用一次 ([a-z_]+)，/.exec(text)?.[1]
      const business = requestedTool ?? names.find(name => Object.values(KIVO_TPM_TOOLS).includes(name) || name === 'geneway_calculate_cycle_time')
      const search = names.includes('geneway_knowledge_search')
      let tool, args
      if (scenario === 'root-summary') { if (!toolMessages.length) { tool = 'geneway_collaboration_submit_summary'; args = { resultRefs: [...new Set(text.match(/result-[a-f0-9-]+/g) ?? [])] } } }
      else if (business && !toolMessages.length) {
        tool = business
        args = jsonAfter(text, text.includes(' exactly once with ') ? ' exactly once with ' : '参数必须精确为 ')
      } else if (search && toolMessages.length === 1) { tool = 'geneway_knowledge_search'; args = { query: standardCanary } }
      else if (search && toolMessages.length === 2) {
        const found = JSON.parse(toolMessages.at(-1).content)
        tool = 'geneway_knowledge_submit_references'; args = { references: found.results.map(({ knowledgeId, revision, segmentId }) => ({ knowledgeId, revision, segmentId })) }
      } else if (names.includes('structured_output')) { tool = 'structured_output'; args = { status: 'done', explanation: '根据当前获准TPM事实和标准完成核对。' } }
      completion(response, body.model, tool, args)
    } catch (error) { failures.push(error); response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'synthetic capture failed' })) }
  })
  return { address: await listen(server) }
}
function completion(response, model, tool, args) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  const id = `chatcmpl-${randomUUID()}`, send = value => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, ...value }] })}\n\n`)
  send({ delta: { role: 'assistant' }, finish_reason: null })
  if (tool) send({ delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null })
  else send({ delta: { content: '当前获准事实核对完成。' }, finish_reason: null })
  send({ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' })
  response.end('data: [DONE]\n\n')
}

async function captureKivo(id, status) {
  const state = { calls: [], pending: new Set(), hold: false }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, state.connection.issuer).pathname, raw = await readBody(request)
      const send = (code, value, headers = {}) => { response.writeHead(code, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)) }
      if (path.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: state.connection.baseUrl, authorization_servers: [state.connection.issuer], scopes_supported: KIVO_MCP_SCOPE.split(' '), bearer_methods_supported: ['header'] })
      if (path === '/.well-known/oauth-authorization-server') return send(200, { issuer: state.connection.issuer, authorization_endpoint: `${state.connection.issuer}/api/v1/oauth/authorize`, token_endpoint: `${state.connection.issuer}/api/v1/oauth/token`, grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] })
      if (path === '/api/v1/oauth/token') {
        const form = new URLSearchParams(raw), jwt = form.get('client_assertion').split('.'), claims = JSON.parse(Buffer.from(jwt[1], 'base64url'))
        assert(form.get('resource') === state.connection.baseUrl && form.get('scope') === KIVO_MCP_SCOPE && claims.sub === state.connection.clientId && claims.aud === state.connection.issuer)
        assert(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), keys.publicKey, Buffer.from(jwt[2], 'base64url')))
        return send(200, { access_token: 'synthetic-kivo-token', token_type: 'Bearer', expires_in: 300, scope: KIVO_MCP_SCOPE })
      }
      assert(path === '/api/v1/mes/mcp' && request.method === 'POST')
      const rpc = JSON.parse(raw)
      if (request.headers.authorization !== 'Bearer synthetic-kivo-token') return send(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${state.connection.issuer}/.well-known/oauth-protected-resource/api/v1/mes/mcp", error="invalid_token"` })
      const reply = value => send(200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...value } })
      if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' })
      if (rpc.method === 'tools/list') return reply({ tools, ttlMs: 0, cacheScope: 'private' })
      assert(rpc.method === 'tools/call')
      state.calls.push(rpc.params)
      if (state.hold) { state.pending.add(response); response.on('close', () => state.pending.delete(response)); return }
      const type = rpc.params.name === 'devices.device.get' ? 'device' : rpc.params.name.split('.')[1]
      const value = type === 'device' ? { id: deviceId, code: 'D-1', name: '合成设备', lifecycleStatus: 'active', connectionStatus: 'unknown', operationStatus: 'unknown', summaryStatus: 'unknown', summaryReason: null, organizationUnitId: recordId, organizationName: 'synthetic' }
        : type === 'plan' ? { id: recordId, code: 'P-1', name: '合成维护计划', purpose: 'maintenance', deviceId, organizationUnitId: recordId, organizationCode: 'synthetic', active: true, revision: 1, createdAt: now, updatedAt: now, versions: [], occurrences: [], occurrenceTotal: 0 }
          : { id: recordId, deviceId, orderNo: 'R-1', status, reporterId: null, executorId: null, acceptedById: null, revision: 1, createdAt: now, updatedAt: now, reopenedFrom: null, detail: { reason: recordCanary } }
      const result = { status: 'ok', source: { system: 'kivo', path: tpmSourcePath(rpc.params), queriedAt: now, traceId: request.headers['x-trace-id'] }, value }
      await state.afterCall?.()
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
    } catch (error) { failures.push(error); response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'synthetic Kivo failed' })) }
  })
  const issuer = await listen(server)
  state.connection = { id, name: id, kind: 'kivo-mcp', targetIdentity: id, baseUrl: `${issuer}/api/v1/mes/mcp`, issuer, clientId: '00000000-0000-4000-8000-000000000003', credentialRef: `${id}.pem`, allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: id, sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-mcp', enabled: true, status: 'ready', revision: 1, skillIds: [read, list].map(id => `skill-${id}`) }
  return state
}
