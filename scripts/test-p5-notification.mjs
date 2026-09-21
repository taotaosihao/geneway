import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createFeishuRuntime } from '../plugins/feishu.mjs'
import { createAutomationService } from '../src/automation-service.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { migrateState } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const now = '2026-09-21T00:00:00.000Z'
let sequence = 0
const ids = () => `n-${++sequence}`

await deliveryLifecycle()
await terminalCallback()
await runtimeOwnerGates()
console.log('P5 automation notification checks passed; fake SDK only; extra work/execution=0; blind unknown retries=0')

async function deliveryLifecycle() {
  const memory = memoryStore(fixture())
  const channel = createChannelService({ store: memory, clock: () => now, idFactory: ids })
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
  await automation.resumeRule({ id: 'member-owner' }, 'rule-a', { expectedRevision: 2 })
  assert.equal((await channel.retryDelivery({ deliveryId: first.deliveries[0].id })).status, 'sending')
  await channel.validateSendClaim({ deliveryId: first.deliveries[0].id })
  await channel.recordDeliveryOutcome({ deliveryId: first.deliveries[0].id, status: 'failed', error: { code: 'FEISHU_230001' } })

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
  assert.deepEqual(counts(await memory.read()), { works: 4, executions: 4 })
}

async function runtimeOwnerGates() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-notification-'))
  const secretRoot = join(root, 'secrets')
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'FEISHU_TEST'), JSON.stringify({ appId: 'cli_aaaaaaaaaaaaaaaa', appSecret: 'controlled_secret_123456' }), { mode: 0o600 })
  const memory = memoryStore(fixture())
  const channel = createChannelService({ store: memory, clock: () => now, idFactory: ids })
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
  const memory = memoryStore(fixture())
  const channel = createChannelService({ store: memory, clock: () => now, idFactory: ids })
  const workService = createWorkService({
    store: memory, clock: () => now, connectionCatalog: [catalog()],
    runner: { configured: true, async run() { return validModel() }, async cancel() {}, async close() {} },
    onAutomationTerminal: options => channel.ensureAutomationDeliveries(options),
  })
  const automation = createAutomationService({ store: memory, workService, clock: () => now, idFactory: ids, connectionCatalog: [catalog()] })
  try {
    await memory.update(state => ({ ...state, automationRules: [...state.automationRules, ruleRecord('callback')] }))
    const accepted = await automation.acceptDailyOccurrence({ ruleId: 'rule-callback', scheduledDate: '2026-09-21', ownerCheck: () => true })
    await waitFor(async () => ['completed', 'failed'].includes((await memory.read()).works.find(item => item.id === accepted.workId)?.status))
    await waitFor(async () => Boolean((await memory.read()).automationOccurrences[0].deliveryId))
    const state = await memory.read()
    assert.equal(state.deliveries.find(item => item.id === state.automationOccurrences[0].deliveryId)?.status, 'pending')
    assert.equal(state.works.find(item => item.id === accepted.workId).status, 'completed')
    assert.deepEqual(counts(state), { works: 1, executions: 1 })
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
    modelRoutes: [{ id: 'route-owner', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    employees: [{ id: 'employee-owner', enabled: true, modelRouteId: 'route-owner', skillIds: ['skill-gearjob-work-order-read'], connectionIds: ['connection-owner'] }],
    connections: [{ id: 'connection-owner', ...catalog(), enabled: true, status: 'ready', revision: 1, skillIds: ['skill-gearjob-work-order-read'], allowedObjectIds: ['WO-1'] }],
    skills: [{ id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true }], confirmations: [], knowledgeMaterials: [],
    channelApps: [{ id: 'app-owner', provider: 'feishu', providerAppId: 'cli_aaaaaaaaaaaaaaaa', providerTenantId: 'tenant-test', credentialRef: 'FEISHU_TEST', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-owner', providerUserId: 'user-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-owner', providerConversationId: 'chat-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelMessages: [], deliveries: [], linkCodes: [], works: [], reservations: {}, automationRules: [], automationOccurrences: [],
  })
}

function ruleRecord(suffix) { return { id: `rule-${suffix}`, ownerMemberId: 'member-owner', revision: 1, status: 'active', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 10, notificationConversationId: 'conversation-owner', effectiveFrom: now, eventAcceptAfter: null, createdAt: now, updatedAt: now, revokedAt: null } }
function workRecord(suffix, status) {
  const completed = status === 'completed', resultId = `result-${suffix}`
  const source = { sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', sourceRecordId: 'Work Order:WO-1', sourceRevision: 'r1' }
  const result = { id: resultId, kind: 'gearjob.work-order.observation', capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', schemaVersion: 1, input: { workOrderId: 'WO-1' }, payload: { observationId: resultId, workOrderId: 'WO-1', status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', completion: { ratio: 0.4, overPlan: false }, queriedAt: now, ...source, explanation: 'safe', dshSessionRef: `session-${suffix}` }, explanation: 'safe', source, createdAt: now, dshSessionRef: `session-${suffix}`, contextConfirmationRefs: [], toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }
  return { id: `work-${suffix}`, ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', goal: '读取工单', input: { workOrderId: 'WO-1' }, requiredInputs: [], status, acceptedAt: now, results: completed ? [result] : [], actions: [], executions: [{ id: `exec-${suffix}`, operation: 'automation', clientRequestId: `rule-${suffix}:2026-09-21`, input: { workOrderId: 'WO-1' }, status, acceptedAt: now, completedAt: now, ...(completed ? { resultId } : { error: { code: 'UPSTREAM_ERROR', message: '来源读取失败' } }) }] }
}

function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function validModel() { const source = { sourceSystem: 'GearJob', sourceInstance: 'test', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', sourceRecordId: 'Work Order:WO-1', sourceRevision: 'r1' }; return { explanation: 'safe', dshSessionRef: 'session-callback', contextConfirmationRefs: [], result: { kind: 'gearjob.work-order.observation', payload: { workOrderId: 'WO-1', status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', ...source }, source, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' } } }
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
        const outcome = fake.outcomes.shift() ?? 'success'
        return outcome === 'failed' ? { code: 230001 } : { code: 0, data: { message_id: `om-${fake.calls.length}`, chat_id: request.data.receive_id } }
      } } } }
    }
    async request() { return { code: 0, bot: { open_id: 'ou_bot_test' } } }
  }
  fake.WSClient = class { constructor(options) { this.options = options } async start({ eventDispatcher }) { this.eventDispatcher = eventDispatcher; this.options.onReady() } close() {} }
  return fake
}
