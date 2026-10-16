import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createFeishuRuntime } from '../plugins/feishu.mjs'
import { createAutomationService } from '../src/automation-service.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { getCapability, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { normalizeTpmObservation } from '../src/domain/tpm.mjs'

const now = '2026-09-21T00:00:00.000Z'
let sequence = 0
const ids = () => `n-${++sequence}`

await deliveryLifecycle()
await terminalCallback()
await kivoNotificationChecks()
await runtimeOwnerGates()
console.log('P5 automation notification checks passed; fake SDK only; extra work/execution=0; blind unknown retries=0')

async function deliveryLifecycle() {
  const memory = memoryStore(fixture())
  const channel = createChannelService({ store: memory, clock: () => now, idFactory: ids, connectionCatalog: [catalog()], workService: createWorkService({ store: memory, clock: () => now, connectionCatalog: [catalog()] }) })
  const automation = createAutomationService({ store: memory, workService: {}, clock: () => now, idFactory: ids, connectionCatalog: [catalog()] })
  await addTerminal(memory, 'completed', 'a')
  const baseline = counts(await memory.read())
  const first = await channel.ensureAutomationDeliveries({ ownerCheck: () => true })
  assert.equal(first.deliveries.length, 1)
  assert.equal(first.deliveries[0].contentKey, 'automation.completed')
  assert.equal(first.deliveries[0].requestId, 'automation:rule-a:2026-09-21:terminal')
  assert.equal((await memory.read()).automationOccurrences[0].deliveryId, first.deliveries[0].id)
  assert.deepEqual(counts(await memory.read()), baseline)
  await channel.ensureAutomationDeliveries({ ownerCheck: () => true })
  assert.equal((await memory.read()).deliveries.length, 1)

  await automation.pauseRule({ id: 'member-owner' }, 'rule-a', { expectedRevision: 1 })
  assert.equal((await memory.read()).deliveries[0].status, 'blocked')
  const paused = await memory.read()
  await assert.rejects(automation.resumeRule({ id: 'member-owner' }, 'rule-a', { expectedRevision: 2 }), hasCode('CAPABILITY_RETIRED'))
  assert.deepEqual(await memory.read(), paused)
  await assert.rejects(channel.retryDelivery({ deliveryId: first.deliveries[0].id }), hasCode('DELIVERY_FORBIDDEN'))

  await addTerminal(memory, 'completed', 'active')
  const active = (await channel.ensureAutomationDeliveries({ ownerCheck: () => true })).deliveries[0]
  await channel.authorizeDelivery({ deliveryId: active.id })
  await channel.validateSendClaim({ deliveryId: active.id })
  await channel.recordDeliveryOutcome({ deliveryId: active.id, status: 'failed', error: { code: 'FEISHU_230001' } })
  assert.equal((await channel.retryDelivery({ deliveryId: active.id })).status, 'sending')
  await channel.validateSendClaim({ deliveryId: active.id })
  await channel.recordDeliveryOutcome({ deliveryId: active.id, status: 'delivered', providerMessageId: 'om-active' })
  assert.equal((await memory.read()).deliveries.find(item => item.id === active.id).status, 'delivered')

  await addTerminal(memory, 'failed', 'b')
  const failed = (await channel.ensureAutomationDeliveries({ ownerCheck: () => true })).deliveries[0]
  assert.equal(failed.contentKey, 'automation.failed')
  await channel.authorizeDelivery({ deliveryId: failed.id })
  const envelope = await channel.validateSendClaim({ deliveryId: failed.id })
  assert.match(envelope.text, /未完成.*\/works\/work-b/)
  assert.doesNotMatch(envelope.text, /stack|token|secret|accepted/i)
  await channel.recordDeliveryOutcome({ deliveryId: failed.id, status: 'failed', error: { code: 'FEISHU_230001' } })
  assert.equal((await channel.retryDelivery({ deliveryId: failed.id })).attempts, 2)
  await channel.recordDeliveryOutcome({ deliveryId: failed.id, status: 'unknown', error: { code: 'DELIVERY_UNKNOWN' } })
  await assert.rejects(channel.retryDelivery({ deliveryId: failed.id }), hasCode('INVALID_STATE'))

  await addTerminal(memory, 'failed', 'c')
  const sending = (await channel.ensureAutomationDeliveries({ ownerCheck: () => true })).deliveries[0]
  await channel.authorizeDelivery({ deliveryId: sending.id })
  await automation.revokeRule({ id: 'member-owner' }, 'rule-c', { expectedRevision: 1 })
  assert.equal((await memory.read()).deliveries.find(item => item.id === sending.id).status, 'unknown')

  await addTerminal(memory, 'failed', 'binding')
  await memory.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'connection-owner' ? { ...item, enabled: false } : item) }))
  assert.equal((await channel.ensureAutomationDeliveries({ ownerCheck: () => true })).deliveries[0].status, 'blocked')
  assert.deepEqual(counts(await memory.read()), { works: 5, executions: 5 })
}

async function runtimeOwnerGates() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-notification-'))
  const secretRoot = join(root, 'secrets')
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'FEISHU_TEST'), JSON.stringify({ appId: 'cli_aaaaaaaaaaaaaaaa', appSecret: 'controlled_secret_123456' }), { mode: 0o600 })
  const memory = memoryStore(fixture())
  const channel = createChannelService({ store: memory, clock: () => now, idFactory: ids, connectionCatalog: [catalog()], workService: createWorkService({ store: memory, clock: () => now, connectionCatalog: [catalog()] }) })
  const fake = fakeSdk()
  let owner = true
  let loseAfterAuthorize = false
  const runtimeChannel = { ...channel, async authorizeDelivery(input) { const result = await channel.authorizeDelivery(input); if (loseAfterAuthorize) owner = false; return result } }
  const runtime = createFeishuRuntime({ store: memory, channelService: runtimeChannel, secretRoot, sdk: { ...Lark, Client: fake.Client, WSClient: fake.WSClient }, automationOwnerCheck: () => owner })
  try {
    await runtime.start()

    await addTerminal(memory, 'completed', 'pre')
    owner = true
    loseAfterAuthorize = true
    const beforePre = fake.calls.length
    await runtime.sendAutomationNotifications()
    assert.equal(fake.calls.length, beforePre)
    const preDelivery = deliveryFor(await memory.read(), 'pre')
    assert.equal(preDelivery.status, 'unknown', JSON.stringify(preDelivery))

    owner = true
    loseAfterAuthorize = false
    await addTerminal(memory, 'completed', 'post')
    fake.afterIo = () => { owner = false }
    await runtime.sendAutomationNotifications()
    assert.equal(deliveryFor(await memory.read(), 'post').status, 'unknown')
    const postCalls = fake.calls.length
    await assert.rejects(runtime.sendDelivery(deliveryFor(await memory.read(), 'post').id, { retry: true, ownerCheck: () => true }), hasCode('INVALID_STATE'))
    assert.equal(fake.calls.length, postCalls)

    owner = true
    fake.afterIo = undefined
    await addTerminal(memory, 'failed', 'retry')
    fake.outcomes.push('failed')
    await runtime.sendAutomationNotifications()
    const failed = deliveryFor(await memory.read(), 'retry')
    assert.equal(failed.status, 'failed')
    fake.outcomes.push('success')
    assert.equal((await runtime.sendDelivery(failed.id, { retry: true, ownerCheck: () => owner })).status, 'delivered')
    assert.deepEqual(counts(await memory.read()), { works: 3, executions: 3 })
  } finally {
    await runtime.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

async function terminalCallback() {
  const notifications = memoryStore(fixture())
  await addTerminal(notifications, 'completed', 'callback')
  const channel = createChannelService({ store: notifications, clock: () => now, idFactory: ids, connectionCatalog: [catalog()], workService: createWorkService({ store: notifications, clock: () => now, connectionCatalog: [catalog()] }) })
  const initial = fixture()
  initial.skills.push({ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true })
  initial.employees[0].skillIds.push('skill-cycle-time-calculate')
  const memory = memoryStore(migrateState(initial))
  let callbacks = 0
  const workService = createWorkService({
    store: memory, clock: () => now,
    runner: { configured: true, async run() { return validModel() }, async cancel() {}, async close() {} },
    onAutomationTerminal: options => { callbacks += 1; return channel.ensureAutomationDeliveries(options) },
  })
  try {
    await workService.ensureReady()
    // The internal cycle has no rule; its callback processes a separate closed historical notification graph.
    const input = { availableSeconds: 60, quantity: 1 }
    await memory.update(state => ({ ...state, works: [{ id: 'callback-cycle', ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', input, requiredInputs: [], status: 'accepted', acceptedAt: now, results: [], actions: [], executions: [{ id: 'callback-cycle-exec', operation: 'automation', clientRequestId: 'callback-cycle', input, status: 'accepted', acceptedAt: now }] }] }))
    await workService.dispatchAutomationWork('callback-cycle', 'callback-cycle-exec', now, { ownerCheck: () => true })
    await waitFor(async () => (await memory.read()).works[0]?.status === 'completed')
    await waitFor(async () => Boolean((await notifications.read()).automationOccurrences[0].deliveryId))
    const state = await memory.read()
    const notified = await notifications.read()
    assert.equal(notified.deliveries.find(item => item.id === notified.automationOccurrences[0].deliveryId)?.status, 'pending')
    assert.equal(callbacks, 1)
    assert.deepEqual(state.automationRules, [])
    assert.deepEqual(state.automationOccurrences, [])
    assert.deepEqual(counts(state), { works: 1, executions: 1 })
    assert.deepEqual(counts(notified), { works: 1, executions: 1 })
  } finally {
    await workService.close()
  }
}

async function addTerminal(store, status, suffix) {
  await store.update(state => {
    const rule = ruleRecord(suffix)
    const work = workRecord(suffix, status)
    const occurrence = { id: `occ-${suffix}`, occurrenceKey: `${rule.id}:2026-09-21`, ruleId: rule.id, ruleRevision: 1, scheduledDate: '2026-09-21', workId: work.id, status: null, reason: null, deliveryId: null, createdAt: now }
    return { ...state, automationRules: [...state.automationRules, rule], works: [...state.works, work], automationOccurrences: [...state.automationOccurrences, occurrence] }
  })
}

function fixture() {
  return migrateState({
    version: 7,
    members: [{ id: 'member-owner', loginName: 'owner', displayName: 'Owner', role: 'member', enabled: true, authRef: 'owner', sessionVersion: 1, employeeIds: ['employee-owner'], createdAt: now, updatedAt: now }],
    modelRoutes: [{ id: 'route-owner', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    employees: [{ id: 'employee-owner', enabled: true, modelRouteId: 'route-owner', skillIds: ['skill-gearjob-work-order-read'], connectionIds: ['connection-owner'] }],
    connections: [{ id: 'connection-owner', ...catalog(), enabled: true, status: 'ready', revision: 1, skillIds: ['skill-gearjob-work-order-read'], allowedObjectIds: ['WO-1'] }],
    skills: [{ id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true }], confirmations: [], knowledgeMaterials: [],
    channelApps: [{ id: 'app-owner', provider: 'feishu', providerAppId: 'cli_aaaaaaaaaaaaaaaa', providerTenantId: 'tenant-test', credentialRef: 'FEISHU_TEST', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-owner', providerUserId: 'user-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-owner', providerConversationId: 'chat-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelMessages: [], deliveries: [], linkCodes: [], works: [], reservations: {}, automationRules: [], automationOccurrences: [],
  })
}

function ruleRecord(suffix) { return { id: `rule-${suffix}`, ownerMemberId: 'member-owner', revision: 1, status: 'active', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 10, notificationIdentityId: 'identity-owner', effectiveFrom: now, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null } }
function workRecord(suffix, status) {
  const completed = status === 'completed', resultId = `result-${suffix}`
  const source = { sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', sourceRecordId: 'Work Order:WO-1', sourceRevision: 'r1' }
  const result = { id: resultId, kind: 'gearjob.work-order.observation', capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', schemaVersion: 1, input: { workOrderId: 'WO-1' }, payload: { observationId: resultId, workOrderId: 'WO-1', status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', completion: { ratio: 0.4, overPlan: false }, queriedAt: now, ...source, explanation: 'safe', dshSessionRef: `session-${suffix}` }, explanation: 'safe', source, createdAt: now, dshSessionRef: `session-${suffix}`, contextConfirmationRefs: [], toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }
  return { id: `work-${suffix}`, ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', goal: '读取工单', input: { workOrderId: 'WO-1' }, requiredInputs: [], status, acceptedAt: now, results: completed ? [result] : [], actions: [], executions: [{ id: `exec-${suffix}`, operation: 'automation', clientRequestId: `rule-${suffix}:2026-09-21`, input: { workOrderId: 'WO-1' }, status, acceptedAt: now, completedAt: now, ...(completed ? { resultId } : { error: { code: 'UPSTREAM_ERROR', message: '来源读取失败' } }) }] }
}

function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function validModel() { return { explanation: 'safe', dshSessionRef: 'session-callback', contextConfirmationRefs: [], result: { kind: 'manufacturing.takt', payload: { availableSeconds: 60, quantity: 1, secondsPerUnit: 60, unit: 'seconds/unit' }, toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2' } } }
function memoryStore(initial) { let state = initial; return { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } } }
function counts(state) { return { works: state.works.length, executions: state.works.reduce((sum, work) => sum + work.executions.length, 0) } }
function deliveryFor(state, suffix) { return state.deliveries.find(item => item.workId === `work-${suffix}`) }
function hasCode(code) { return value => value?.code === code }
async function waitFor(predicate) { for (let attempt = 0; attempt < 100; attempt += 1) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('condition did not become true') }

function fakeSdk() {
  const fake = { calls: [], outcomes: [], afterIo: undefined }
  fake.Client = class {
    constructor(options) {
      this.options = options
      this.im = { v1: { message: { create: async request => {
        fake.calls.push(structuredClone(request))
        fake.afterIo?.()
        if (fake.responseGate) await fake.responseGate
        const outcome = fake.outcomes.shift() ?? 'success'
        return outcome === 'failed' ? { code: 230001 } : { code: 0, data: { message_id: `om-${fake.calls.length}`, chat_id: request.data.receive_id } }
      } } } }
    }
    async request() { return { code: 0, bot: { open_id: 'ou_bot_test' } } }
  }
  fake.WSClient = class { constructor(options) { this.options = options } async start({ eventDispatcher }) { this.eventDispatcher = eventDispatcher; this.options.onReady() } close() {} }
  return fake
}

async function kivoNotificationChecks() {
  const capability = getCapability('kivo-tpm-record-read'), owner = { id: 'member-owner' }
  const deviceId = '00000000-0000-4000-8000-000000000002', objectId = '00000000-0000-4000-8000-000000000001'
  const connection = { id: 'connection-owner', name: '合成Kivo', kind: 'kivo-mcp', targetIdentity: 'pure-kivo', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: '00000000-0000-4000-8000-000000000003', credentialRef: 'not-read.pem', revision: 1, enabled: true, status: 'ready', allowedObjectIds: [], skillIds: [capability.skillId], sourceSystem: 'Kivo', sourceInstance: 'pure-a', sourceEnvironment: 'pure-test', dataMode: 'synthetic', evidenceMode: 'controlled-function' }
  const trusted = Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))
  const source = { system: 'kivo', path: '/api/v1/mes/tpm/repairs/R-1', queriedAt: now, traceId: 'pure-notification' }
  const observation = normalizeTpmObservation({ mode: 'record', input: { recordType: 'repair', reference: 'R-1' }, connection,
    result: { status: 'ok', source, value: { id: objectId, orderNo: 'R-1', deviceId, status: 'reported', revision: 1 } },
    deviceResult: { status: 'ok', source: { ...source, path: '/api/v1/mes/equipment/ledger/devices/' + deviceId }, value: { id: deviceId, lifecycleStatus: 'active' } } })
  async function setup(catalog = [trusted]) {
    const seed = fixture()
    seed.skills = [{ id: capability.skillId, capabilityId: capability.id, enabled: true }]
    seed.connections = [connection]
    seed.employees[0] = { ...seed.employees[0], skillIds: [capability.skillId], connectionIds: [connection.id] }
    const memory = memoryStore(migrateState(seed))
    const workService = createWorkService({ store: memory, connectionCatalog: [trusted], clock: () => now })
    const automation = createAutomationService({ store: memory, workService: { ...workService, async ensureReady() {}, async dispatchAutomationWork() {} }, connectionCatalog: [trusted], clock: () => now, idFactory: ids,
      readCurrentRecord: async ({ authorize }) => { await authorize(); return structuredClone(observation) } })
    const rule = await automation.createRule(owner, { employeeId: 'employee-owner', skillId: capability.skillId, connectionId: connection.id, input: { recordType: 'repair', reference: 'R-1' }, trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 2, notificationIdentityId: 'identity-owner' })
    const active = await automation.enableRule(owner, rule.id, { expectedRevision: rule.revision })
    const admission = await automation.acceptManualOccurrence(owner, rule.id, { expectedRevision: active.revision, clientRequestId: 'notification-work' })
    await memory.update(state => ({ ...state, works: state.works.map(work => {
      const result = { ...parseCapabilityToolResult(capability.id, { ok: true, observation }, work.input), id: 'tpm-notify-result', capabilityId: capability.id, skillId: capability.skillId, schemaVersion: 1, input: work.input, explanation: '合成单据当前状态已核对', createdAt: now, dshSessionRef: 'explicit-pure-fixture', contextConfirmationRefs: [] }
      return { ...work, status: 'completed', results: [result], executions: work.executions.map(execution => ({ ...execution, status: 'completed', completedAt: now, resultId: result.id })) }
    }) }))
    const channel = createChannelService({ store: memory, workService, connectionCatalog: catalog, clock: () => now, idFactory: ids })
    return { memory, automation, channel, active, workId: admission.workId }
  }
  const positive = await setup(), before = counts(await positive.memory.read())
  const delivery = (await positive.channel.ensureAutomationDeliveries()).deliveries[0]
  assert.equal(delivery.status, 'pending')
  await positive.channel.authorizeDelivery({ deliveryId: delivery.id })
  const envelope = await positive.channel.validateSendClaim({ deliveryId: delivery.id })
  assert.match(envelope.text, /合成单据当前状态已核对/)
  assert.deepEqual(counts(await positive.memory.read()), before)
  await positive.channel.recordDeliveryOutcome({ deliveryId: delivery.id, status: 'failed', error: { code: 'SYNTHETIC_RETRY' } })
  await positive.automation.updateRule(owner, positive.active.id, { expectedRevision: positive.active.revision, maxRuns: 3 })
  await assert.rejects(positive.channel.retryDelivery({ deliveryId: delivery.id }), hasCode('DELIVERY_FORBIDDEN'), 'config revision invalidates the prior occurrence notification')

  const changedBeforeCreation = await setup()
  await changedBeforeCreation.automation.updateRule(owner, changedBeforeCreation.active.id, { expectedRevision: changedBeforeCreation.active.revision, maxRuns: 3 })
  assert.equal((await changedBeforeCreation.channel.ensureAutomationDeliveries()).deliveries[0].status, 'blocked')

  const noTrust = await setup([])
  assert.equal((await noTrust.channel.ensureAutomationDeliveries()).deliveries[0].status, 'blocked', 'TPM notification must use the same trusted catalogue as work authorization')
  for (const revoke of [
    state => { state.members[0].employeeIds = [] },
    state => { state.skills[0].enabled = false },
    state => { state.modelRoutes[0].enabled = false },
    state => { state.connections[0].enabled = false },
    state => { state.connections[0].credentialRef = 'unregistered-rotation.pem'; state.connections[0].revision += 1 },
  ]) {
    const sample = await setup(), delivery = (await sample.channel.ensureAutomationDeliveries()).deliveries[0]
    await sample.channel.authorizeDelivery({ deliveryId: delivery.id })
    await sample.memory.update(state => { revoke(state); return state })
    await assert.rejects(sample.channel.validateSendClaim({ deliveryId: delivery.id }), hasCode('DELIVERY_FORBIDDEN'))
  }
  const segmented = await setup(), segmentDelivery = (await segmented.channel.ensureAutomationDeliveries()).deliveries[0]
  await segmented.channel.authorizeDelivery({ deliveryId: segmentDelivery.id })
  const segmentEnvelope = await segmented.channel.validateSendClaim({ deliveryId: segmentDelivery.id })
  const sha = value => createHash('sha256').update(value).digest('hex'), attemptId = segmentEnvelope.uuid, textDigest = sha(segmentEnvelope.text)
  const firstPart = { index: 0, clientId: 'geneway-weixin-' + sha(attemptId + '\0' + 0).slice(0, 32) }
  await segmented.channel.validateSendClaim({ deliveryId: segmentDelivery.id, attemptId, totalParts: 2, textDigest, partIndex: 0, clientId: firstPart.clientId })
  await segmented.automation.pauseRule(owner, segmented.active.id, { expectedRevision: segmented.active.revision })
  await segmented.channel.recordSendProgress({ deliveryId: segmentDelivery.id, attemptId, totalParts: 2, textDigest, status: 'sending', acknowledgedParts: [firstPart] })
  await assert.rejects(segmented.channel.validateSendClaim({ deliveryId: segmentDelivery.id, attemptId, totalParts: 2, textDigest, partIndex: 1, clientId: 'geneway-weixin-' + sha(attemptId + '\0' + 1).slice(0, 32) }), hasCode('DELIVERY_FORBIDDEN'))
  const partial = (await segmented.memory.read()).deliveries[0]
  assert.equal(partial.status, 'unknown')
  assert.deepEqual(partial.sendProgress.acknowledgedParts, [firstPart], 'known ACK prefix survives while the next segment is forbidden')

  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geneway-kivo-notify-flight-'))
  await writeFile(join(runtimeRoot, 'FEISHU_TEST'), JSON.stringify({ appId: 'cli_aaaaaaaaaaaaaaaa', appSecret: 'synthetic_flight_secret' }), { mode: 0o600 })
  try {
    for (const operation of ['pause', 'budget', 'known-failure', 'timeout', 'before-io']) {
      const sample = await setup(), fake = fakeSdk()
      let reached, release
      const entered = new Promise(resolve => { reached = resolve })
      fake.responseGate = new Promise(resolve => { release = resolve }); fake.afterIo = reached
      if (operation === 'known-failure') fake.outcomes.push('failed')
      const channel = operation === 'before-io' ? { ...sample.channel, async authorizeDelivery(input) {
        const claimed = await sample.channel.authorizeDelivery(input)
        await sample.automation.pauseRule(owner, sample.active.id, { expectedRevision: sample.active.revision })
        return claimed
      } } : sample.channel
      const runtime = createFeishuRuntime({ store: sample.memory, channelService: channel, secretRoot: runtimeRoot, recover: false, flushOnStart: false,
        sdk: { ...Lark, Client: fake.Client, WSClient: fake.WSClient }, httpTimeoutMs: operation === 'timeout' ? 20 : 1000, automationOwnerCheck: () => true })
      try {
        await runtime.start()
        const sending = runtime.sendAutomationNotifications({ ownerCheck: () => true })
        if (operation === 'before-io') {
          await sending
          assert.equal(fake.calls.length, 0, 'pause before I/O must still stop the request')
          assert.equal((await sample.memory.read()).deliveries[0].status, 'unknown')
          continue
        }
        await entered
        if (operation === 'budget') await sample.automation.updateRule(owner, sample.active.id, { expectedRevision: sample.active.revision, maxRuns: 3 })
        else await sample.automation.pauseRule(owner, sample.active.id, { expectedRevision: sample.active.revision })
        assert.equal((await sample.memory.read()).deliveries[0].status, 'sending', 'rule edit must leave the original in-flight attempt for actual settlement')
        if (operation !== 'timeout') release()
        await sending
        const final = (await sample.memory.read()).deliveries[0]
        assert.equal(final.status, operation === 'known-failure' ? 'failed' : operation === 'timeout' ? 'unknown' : 'delivered')
        assert.equal(final.providerMessageId, ['pause', 'budget'].includes(operation) ? 'om-1' : undefined)
        assert.equal(fake.calls.length, 1)
        if (operation === 'timeout') { release(); await new Promise(resolve => setImmediate(resolve)); assert.equal((await sample.memory.read()).deliveries[0].status, 'unknown', 'a timed-out attempt must not blindly settle a late SDK response') }
        await assert.rejects(sample.channel.retryDelivery({ deliveryId: final.id }), hasCode(operation === 'known-failure' ? 'DELIVERY_FORBIDDEN' : 'INVALID_STATE'))
      } finally { release(); await runtime.close() }
    }
  } finally { await rm(runtimeRoot, { recursive: true, force: true }) }

}
