import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createAutomationService, dailyOccurrenceKey, deriveUsedRuns, nextDailyOccurrence } from '../src/automation-service.mjs'
import { migrateState } from '../src/store/file-store.mjs'

const execFile = promisify(execFileCallback)
const transfer = fileURLToPath(new URL('./state-transfer.mjs', import.meta.url))
const now = '2026-09-20T01:00:00.000Z'
const catalog = [
  { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'https://gearjob.test', hostHeader: 'gearjob.test', credentialRef: 'GEARJOB_TEST', sourceSystem: 'gearjob', sourceInstance: 'test', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test' },
  { kind: 'gearjob-rest', targetIdentity: 'gearjob-test-2', baseUrl: 'https://gearjob.test-2', hostHeader: 'gearjob.test-2', credentialRef: 'GEARJOB_TEST_2', sourceSystem: 'gearjob', sourceInstance: 'test-2', sourceEnvironment: 'synthetic', dataMode: 'live', evidenceMode: 'test' },
]

const state = fixture()
let idCounter = 0
const store = {
  async read() { return structuredClone(state.current) },
  async update(mutator) { state.current = migrateState(await mutator(structuredClone(state.current))); return structuredClone(state.current) },
}
const service = createAutomationService({ store, clock: () => state.clock, idFactory: () => `id-${++idCounter}`, connectionCatalog: catalog })

await migrationChecks()
await validatorChecks()
await historicalBindingChecks()
await ruleChecks()
await derivedChecks()
await transferChecks()
console.log('P5 automation checks passed; event=SOURCE_NOT_CONFIGURED; external effects=0')

async function validatorChecks() {
  const base = fixture().current
  const dailyRule = automationRule('rule-daily', 'active', daily('08:00'))
  assert.doesNotThrow(() => migrateState({ ...base, automationRules: [dailyRule] }))
  const eventDraft = automationRule('rule-event-draft', 'draft', eventTrigger(), { effectiveFrom: null, eventAcceptAfter: null })
  const eventActive = automationRule('rule-event-active', 'active', eventTrigger(), { effectiveFrom: null, eventAcceptAfter: now })
  assert.doesNotThrow(() => migrateState({ ...base, automationRules: [eventDraft, eventActive] }))
  assert.throws(() => migrateState({ ...base, automationRules: [{ ...dailyRule, eventAcceptAfter: now }] }), /daily eventAcceptAfter/)
  assert.throws(() => migrateState({ ...base, automationRules: [{ ...eventActive, effectiveFrom: now }] }), /event effectiveFrom/)
  assert.throws(() => migrateState({ ...base, automationRules: [{ ...eventActive, eventAcceptAfter: null }] }), /eventAcceptAfter 缺失/)
  assert.throws(() => migrateState({ ...base, automationRules: [{ ...eventDraft, eventAcceptAfter: now }] }), /draft eventAcceptAfter/)
  assert.throws(() => migrateState({ ...base, automationRules: [{ ...dailyRule, createdAt: 'not-a-time' }] }), /createdAt/)

  const work1 = workRecord('work-valid'), work2 = workRecord('work-valid-2')
  const delivery = deliveryRecord('delivery-valid', work1.id)
  const success = occurrenceRecord('occurrence-valid', dailyRule, '2026-09-20', work1.id, 'delivery-valid')
  assert.doesNotThrow(() => migrateState({ ...base, works: [work1], deliveries: [delivery], automationRules: [dailyRule], automationOccurrences: [success] }))
  assert.throws(() => migrateState({ ...base, works: [work1], deliveries: [delivery], automationRules: [dailyRule], automationOccurrences: [success, occurrenceRecord('occurrence-duplicate-work', dailyRule, '2026-09-21', work1.id)] }), /工作引用重复/)
  const budgetRule = { ...dailyRule, id: 'rule-budget', maxRuns: 1 }
  assert.throws(() => migrateState({ ...base, works: [work1, work2], automationRules: [budgetRule], automationOccurrences: [occurrenceRecord('occurrence-budget-1', budgetRule, '2026-09-20', work1.id), occurrenceRecord('occurrence-budget-2', budgetRule, '2026-09-21', work2.id)] }), /累计预算超限/)
  assert.throws(() => migrateState({ ...base, works: [work1], deliveries: [delivery], automationRules: [dailyRule], automationOccurrences: [occurrenceRecord('occurrence-terminal-delivery', dailyRule, '2026-09-20', null, 'delivery-valid', 'skipped')] }), /投递引用不闭合/)
  assert.throws(() => migrateState({ ...base, automationRules: [eventDraft], automationOccurrences: [occurrenceRecord('occurrence-event', eventDraft, '2026-09-20', null, null, 'skipped')] }), /规则引用不闭合/)
}

async function historicalBindingChecks() {
  const local = fixture(), localStore = {
    async read() { return structuredClone(local.current) },
    async update(mutator) { local.current = migrateState(await mutator(structuredClone(local.current))); return structuredClone(local.current) },
  }
  const localService = createAutomationService({ store: localStore, clock: () => local.clock, idFactory: () => 'history', connectionCatalog: catalog })
  const created = await localService.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: daily('08:00') })
  const active = await localService.enableRule({ id: 'member-owner' }, created.id, { expectedRevision: 1 })
  const historicalWork = workRecord('historical-work')
  const historicalOccurrence = occurrenceRecord('historical-occurrence', active, '2026-09-20', historicalWork.id)
  local.current = migrateState({ ...local.current, works: [historicalWork], automationOccurrences: [historicalOccurrence] })
  const updated = await localService.updateRule({ id: 'member-owner' }, active.id, { expectedRevision: 2, employeeId: 'employee-owner-2', skillId: 'skill-owner-2', connectionId: 'connection-owner-2', workOrderId: 'WO-2' })
  assert.equal(updated.revision, 3)
  assert.deepEqual([updated.employeeId, updated.skillId, updated.connectionId, updated.workOrderId], ['employee-owner-2', 'skill-owner-2', 'connection-owner-2', 'WO-2'])
  local.current = migrateState({
    ...local.current,
    members: local.current.members.map(member => member.id === 'member-owner' ? { ...member, employeeIds: ['employee-owner'] } : member),
    employees: local.current.employees.map(employee => employee.id === 'employee-owner-2' ? { ...employee, enabled: false } : employee),
    connections: local.current.connections.map(connection => connection.id === 'connection-owner-2' ? { ...connection, enabled: false, status: 'unavailable', allowedObjectIds: [] } : connection),
  })
  assert.doesNotThrow(() => migrateState(structuredClone(local.current)))
  await assert.rejects(localService.updateRule({ id: 'member-owner' }, active.id, { expectedRevision: 3, maxRuns: 9 }), error => error.code === 'FORBIDDEN')
  await assert.rejects(localService.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner-2', skillId: 'skill-owner-2', connectionId: 'connection-owner-2', workOrderId: 'WO-2', trigger: daily('08:00') }), error => error.code === 'FORBIDDEN')
  const paused = await localService.pauseRule({ id: 'member-owner' }, active.id, { expectedRevision: 3 })
  assert.equal(paused.status, 'paused')
  await assert.rejects(localService.resumeRule({ id: 'member-owner' }, active.id, { expectedRevision: 4 }), error => error.code === 'FORBIDDEN')
  await localService.revokeRule({ id: 'member-owner' }, active.id, { expectedRevision: 4 })
  const persisted = await localStore.read()
  assert.deepEqual(persisted.automationOccurrences, [historicalOccurrence])
  assert.deepEqual(persisted.works, [historicalWork])
}

async function ruleChecks() {
  const created = await service.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: daily('08:00') })
  assert.equal(created.status, 'draft')
  assert.equal(created.revision, 1)
  assert.equal(created.maxRuns, 10)
  assert.equal(created.usedRuns, 0)
  assert.equal(created.nextDueAt, null)
  assert.deepEqual(Object.keys((await store.read()).automationRules[0]).sort(), ['connectionId', 'createdAt', 'effectiveFrom', 'employeeId', 'eventAcceptAfter', 'id', 'maxRuns', 'notificationConversationId', 'ownerMemberId', 'revision', 'revokedAt', 'skillId', 'status', 'trigger', 'updatedAt', 'workOrderId'])
  await assert.rejects(service.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: { kind: 'event', source: 'gearjob' } }), error => error.code === 'SOURCE_NOT_CONFIGURED')
  await assert.rejects(service.createRule({ id: 'member-owner' }, { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: daily('08:00'), maxRuns: 0 }), error => error.code === 'INVALID_REQUEST')
  const enabled = await service.enableRule({ id: 'member-owner' }, created.id, { expectedRevision: 1 })
  assert.equal(enabled.status, 'active')
  assert.equal(enabled.revision, 2)
  assert.equal(enabled.effectiveFrom, state.clock)
  await assert.rejects(service.getRule({ id: 'member-peer' }, created.id), error => error.code === 'NOT_FOUND')
  await assert.rejects(service.getRule({ id: 'member-admin' }, created.id), error => error.code === 'NOT_FOUND')
  const channels = Object.fromEntries(['channelApps', 'channelIdentities', 'channelConversations'].map(key => [key, structuredClone(state.current[key])]))
  const notificationInput = { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger: daily('08:00'), notificationConversationId: 'conversation-owner' }
  state.current = { ...state.current, channelIdentities: state.current.channelIdentities.map(item => item.id === 'identity-owner' ? { ...item, status: 'pending' } : item) }
  await assert.rejects(service.createRule({ id: 'member-owner' }, notificationInput), error => error.code === 'FORBIDDEN')
  state.current = { ...state.current, channelIdentities: state.current.channelIdentities.map(item => item.id === 'identity-owner' ? { ...item, status: 'unlinked', unlinkedAt: state.clock } : item) }
  await assert.rejects(service.createRule({ id: 'member-owner' }, notificationInput), error => error.code === 'FORBIDDEN')
  state.current = { ...state.current, channelIdentities: channels.channelIdentities.map(item => item.id === 'identity-owner' ? { ...item, status: 'active' } : item), channelConversations: state.current.channelConversations.map(item => item.id === 'conversation-owner' ? { ...item, identityId: 'identity-peer' } : item) }
  await assert.rejects(service.createRule({ id: 'member-owner' }, notificationInput), error => error.code === 'FORBIDDEN')
  state.current = { ...state.current, ...channels, channelApps: channels.channelApps.map(item => ({ ...item, enabled: false, status: 'disabled' })) }
  await assert.rejects(service.createRule({ id: 'member-owner' }, notificationInput), error => error.code === 'FORBIDDEN')
  state.current = migrateState({ ...state.current, ...channels })
  const eventDraft = automationRule('event-service', 'draft', eventTrigger(), { effectiveFrom: null, eventAcceptAfter: null })
  state.current = migrateState({ ...state.current, automationRules: [...state.current.automationRules, eventDraft] })
  await assert.rejects(service.updateRule({ id: 'member-owner' }, eventDraft.id, { expectedRevision: 1, trigger: eventTrigger() }), error => error.code === 'SOURCE_NOT_CONFIGURED')
  await assert.rejects(service.enableRule({ id: 'member-owner' }, eventDraft.id, { expectedRevision: 1 }), error => error.code === 'SOURCE_NOT_CONFIGURED')
  state.current = migrateState({ ...state.current, automationRules: state.current.automationRules.map(rule => rule.id === eventDraft.id ? { ...rule, status: 'paused', eventAcceptAfter: now } : rule) })
  await assert.rejects(service.resumeRule({ id: 'member-owner' }, eventDraft.id, { expectedRevision: 1 }), error => error.code === 'SOURCE_NOT_CONFIGURED')
  state.current = migrateState({ ...state.current, automationRules: state.current.automationRules.filter(rule => rule.id !== eventDraft.id) })
  state.clock = '2026-09-20T02:00:00.000Z'
  const updated = await service.updateRule({ id: 'member-owner' }, created.id, { expectedRevision: 2, maxRuns: 2, notificationConversationId: 'conversation-owner' })
  assert.equal(updated.revision, 3)
  assert.equal(updated.maxRuns, 2)
  assert.equal(updated.effectiveFrom, state.clock)
  await assert.rejects(service.updateRule({ id: 'member-owner' }, created.id, { expectedRevision: 2, maxRuns: 2 }), error => error.code === 'REVISION_CONFLICT')
  const paused = await service.pauseRule({ id: 'member-owner' }, created.id, { expectedRevision: 3 })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.revision, 4)
  state.clock = '2026-09-20T03:00:00.000Z'
  const resumed = await service.resumeRule({ id: 'member-owner' }, created.id, { expectedRevision: 4 })
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.revision, 5)
  assert.equal(resumed.effectiveFrom, state.clock)
  state.current = migrateState({ ...state.current, employees: state.current.employees.map(item => item.id === 'employee-owner' ? { ...item, enabled: false } : item), connections: state.current.connections.map(item => item.id === 'connection-owner' ? { ...item, enabled: false, status: 'unavailable' } : item) })
  const activeEvent = automationRule('event-containment', 'active', eventTrigger())
  state.current = migrateState({ ...state.current, automationRules: [...state.current.automationRules, activeEvent] })
  const pausedEvent = await service.pauseRule({ id: 'member-owner' }, activeEvent.id, { expectedRevision: 1 })
  assert.equal(pausedEvent.status, 'paused')
  assert.equal(pausedEvent.eventAcceptAfter, activeEvent.eventAcceptAfter)
  state.current = migrateState({ ...state.current, automationRules: state.current.automationRules.filter(rule => rule.id !== activeEvent.id) })
  const pausedAfterBindingLoss = await service.pauseRule({ id: 'member-owner' }, created.id, { expectedRevision: 5 })
  assert.equal(pausedAfterBindingLoss.status, 'paused')
  assert.equal(pausedAfterBindingLoss.revision, 6)
  await assert.rejects(service.resumeRule({ id: 'member-owner' }, created.id, { expectedRevision: 6 }), error => error.code === 'FORBIDDEN')
  const revoked = await service.revokeRule({ id: 'member-owner' }, created.id, { expectedRevision: 6 })
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revision, 7)
  await assert.rejects(service.resumeRule({ id: 'member-owner' }, created.id, { expectedRevision: 7 }), error => error.code === 'INVALID_STATE')
  const ownerRules = await service.listRules({ id: 'member-owner' })
  assert.equal(ownerRules.length, 1)
}

async function derivedChecks() {
  const rule = { id: 'rule-derived', status: 'active', maxRuns: 3, effectiveFrom: '2026-09-20T00:00:00.000Z', trigger: daily('08:00') }
  assert.equal(dailyOccurrenceKey(rule.id, '2026-09-20'), 'rule-derived:2026-09-20')
  assert.equal(nextDailyOccurrence(rule, '2026-09-19T23:30:00.000Z', []), '2026-09-20T00:00:00.000Z')
  assert.equal(nextDailyOccurrence(rule, '2026-09-20T01:00:00.000Z', []), '2026-09-21T00:00:00.000Z')
  const midnight = { ...rule, trigger: daily('00:00') }
  assert.equal(nextDailyOccurrence(midnight, '2026-09-20T15:59:00.000Z', []), '2026-09-20T16:00:00.000Z')
  const existing = [{ ruleId: rule.id, scheduledDate: '2026-09-21', workId: null }]
  assert.equal(nextDailyOccurrence(rule, '2026-09-20T01:00:00.000Z', existing), null)
  assert.equal(nextDailyOccurrence({ ...rule, effectiveFrom: '2026-09-20T00:30:00.000Z' }, '2026-09-20T01:00:00.000Z', [{ ruleId: rule.id, scheduledDate: '2026-09-20', workId: null }]), '2026-09-21T00:00:00.000Z')
  assert.equal(nextDailyOccurrence({ ...rule, status: 'paused' }, '2026-09-20T00:30:00.000Z', []), null)
  assert.equal(nextDailyOccurrence({ ...rule, maxRuns: 1 }, '2026-09-20T00:30:00.000Z', [{ ruleId: rule.id, workId: 'work-1' }]), null)
  assert.equal(deriveUsedRuns(rule, [{ ruleId: rule.id, workId: 'work-1' }, { ruleId: rule.id, workId: null }]), 1)
  const effectiveTomorrow = { ...rule, effectiveFrom: '2026-09-21T02:00:00.000Z' }
  assert.equal(nextDailyOccurrence(effectiveTomorrow, '2026-09-20T01:00:00.000Z', []), '2026-09-22T00:00:00.000Z')
  assert.equal(nextDailyOccurrence(rule, '2026-09-22T01:00:00.000Z', []), '2026-09-23T00:00:00.000Z')
  assert.equal(nextDailyOccurrence(rule, '2026-09-19T23:00:00.000Z', [{ ruleId: rule.id, scheduledDate: '2026-09-20', workId: 'work-back' }]), '2026-09-21T00:00:00.000Z')
  const work = { id: 'work-1', ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', input: { workOrderId: 'WO-1' }, status: 'completed', results: [], executions: [] }
  state.current = migrateState({ ...state.current, works: [work], automationRules: [{ ...state.current.automationRules[0], status: 'revoked', effectiveFrom: state.current.automationRules[0].effectiveFrom, revokedAt: state.clock, revision: 7 }], automationOccurrences: [{ id: 'occurrence-1', occurrenceKey: dailyOccurrenceKey(state.current.automationRules[0].id, '2026-09-20'), ruleId: state.current.automationRules[0].id, ruleRevision: 7, scheduledDate: '2026-09-20', workId: 'work-1', status: null, reason: null, deliveryId: null, createdAt: state.clock }] })
  assert.equal(deriveUsedRuns(state.current.automationRules[0], state.current.automationOccurrences), 1)
  await assert.rejects(store.update(current => ({ ...current, automationOccurrences: [{ ...current.automationOccurrences[0], status: 'skipped', reason: 'bad' }] })), /结果不闭合/)
}

async function migrationChecks() {
  for (const version of [3, 4, 5, 6]) {
    const value = version === 3 ? { version: 3 } : { ...fixture().current, version }
    if (version < 6) {
      delete value.automationRules
      delete value.automationOccurrences
      if (version < 5) delete value.knowledgeMaterials
      if (version < 6) for (const key of ['channelApps', 'channelIdentities', 'channelConversations', 'channelMessages', 'deliveries', 'linkCodes']) delete value[key]
    }
    const migrated = migrateState(value)
    assert.equal(migrated.version, 7)
    assert.deepEqual(migrated.automationRules, [])
    assert.deepEqual(migrated.automationOccurrences, [])
  }
  assert.throws(() => migrateState({ version: 8 }), /未来/)
  const broken = fixture().current
  broken.automationRules = [{ ...broken.automationRules[0], id: 'bad' }]
  assert.throws(() => migrateState(broken), /自动规则/)
}

async function transferChecks() {
  const root = await mkdtemp(join(tmpdir(), 'geneway-p5-transfer-'))
  try {
    const source = join(root, 'source'), backup = join(root, 'backup'), restored = join(root, 'restored')
    await mkdir(source, { recursive: true })
    const rules = [automationRule('rule-active', 'active', daily('08:00'), { notificationConversationId: 'conversation-owner' }), automationRule('rule-draft', 'draft', daily('08:00')), automationRule('rule-paused', 'paused', daily('08:00')), automationRule('rule-revoked', 'revoked', daily('08:00'))]
    const transferWork = workRecord('work-transfer')
    const transferOccurrence = occurrenceRecord('occurrence-transfer', rules[0], '2026-09-20', transferWork.id)
    const transferState = migrateState({ ...fixture().current, works: [transferWork], automationRules: rules, automationOccurrences: [transferOccurrence] })
    await writeFile(join(source, 'state.json'), JSON.stringify(transferState, null, 2) + '\n', { mode: 0o600 })
    await run(['backup', '--output', backup], { GENEWAY_STATE: join(source, 'state.json'), GENEWAY_DSH_HOME: join(source, 'dsh') })
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
    assert.equal(manifest.schema.automationRules, 4)
    assert.equal(manifest.schema.automationOccurrences, 1)
    await run(['restore', '--input', backup, '--data-root', restored])
    const restoredState = JSON.parse(await readFile(join(restored, 'state.json'), 'utf8'))
    const restoredRules = new Map(restoredState.automationRules.map(rule => [rule.id, rule]))
    assert.equal(restoredRules.get('rule-active').status, 'paused')
    assert.equal(restoredRules.get('rule-active').revision, 2)
    assert.notEqual(restoredRules.get('rule-active').updatedAt, rules[0].updatedAt)
    for (const rule of rules.slice(1)) assert.deepEqual(restoredRules.get(rule.id), rule)
    assert.deepEqual(restoredState.automationOccurrences, [transferOccurrence])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fixture() {
  const app = { id: 'app-owner', provider: 'feishu', providerAppId: 'app', providerTenantId: 'tenant', credentialRef: 'FEISHU_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }
  const identity = { id: 'identity-owner', channelAppId: app.id, providerUserId: 'user-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }
  const conversation = { id: 'conversation-owner', channelAppId: app.id, providerConversationId: 'conversation', identityId: identity.id, memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }
  const value = migrateState({
    version: 7,
    members: [member('member-owner', ['employee-owner', 'employee-owner-2']), member('member-peer', ['employee-peer']), member('member-admin', [])],
    modelRoutes: [route('route-owner'), route('route-owner-2'), route('route-peer')],
    employees: [employee('employee-owner', 'route-owner', 'connection-owner'), employee('employee-owner-2', 'route-owner-2', 'connection-owner-2'), employee('employee-peer', 'route-peer', 'connection-peer')],
    connections: [connection('connection-owner', 'WO-1'), connection('connection-owner-2', 'WO-2'), connection('connection-peer', 'WO-3')],
    skills: [skill(), { id: 'skill-owner-2', capabilityId: 'gearjob-work-order-read', enabled: true }, { id: 'skill-peer', capabilityId: 'gearjob-work-order-read', enabled: true }],
    confirmations: [], knowledgeMaterials: [], channelApps: [app], channelIdentities: [identity], channelConversations: [conversation], channelMessages: [], deliveries: [], linkCodes: [], works: [], reservations: {}, automationRules: [], automationOccurrences: [],
  })
  return { current: value, clock: now }
}

function member(id, employeeIds) { return { id, loginName: id, displayName: id, role: id === 'member-admin' ? 'admin' : 'member', enabled: true, authRef: id, sessionVersion: 1, employeeIds } }
function route(id) { return { id, provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', credentialRef: 'ZENMUX_API_KEY', enabled: true } }
function employee(id, modelRouteId, connectionId) { return { id, enabled: true, modelRouteId, skillIds: [id === 'employee-owner' ? 'skill-gearjob-work-order-read' : id === 'employee-owner-2' ? 'skill-owner-2' : 'skill-peer'], connectionIds: [connectionId] } }
function skill(value = {}) { return { id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', enabled: true, ...value } }
function connection(id, workOrderId) { const target = id === 'connection-owner-2' ? catalog[1] : catalog[0]; return { id, kind: target.kind, targetIdentity: target.targetIdentity, baseUrl: target.baseUrl, hostHeader: target.hostHeader, credentialRef: target.credentialRef, sourceSystem: target.sourceSystem, sourceInstance: target.sourceInstance, sourceEnvironment: target.sourceEnvironment, dataMode: target.dataMode, evidenceMode: target.evidenceMode, enabled: true, status: 'ready', revision: 1, skillIds: [id === 'connection-owner' ? 'skill-gearjob-work-order-read' : id === 'connection-owner-2' ? 'skill-owner-2' : 'skill-peer'], allowedObjectIds: [workOrderId] } }
function daily(time) { return { kind: 'daily-time', time, timeZone: 'Asia/Shanghai' } }
function eventTrigger() { return { kind: 'gearjob-work-order-update', sourceId: 'source-test' } }
function automationRule(id, status, trigger, extra = {}) {
  const event = trigger.kind === 'gearjob-work-order-update'
  return {
    id, ownerMemberId: 'member-owner', revision: 1, status, employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-1', trigger, maxRuns: 10, notificationConversationId: null,
    effectiveFrom: event || status === 'draft' || status === 'revoked' ? null : now,
    eventAcceptAfter: event && ['active', 'paused'].includes(status) ? now : null,
    createdAt: now, updatedAt: now, revokedAt: status === 'revoked' ? now : null, ...extra,
  }
}
function workRecord(id) { return { id, ownerMemberId: 'member-owner', employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner', input: { workOrderId: 'WO-1' }, status: 'completed', results: [], executions: [] } }
function deliveryRecord(id, workId) { return { id, channelAppId: 'app-owner', requestId: `request-${id}`, workId, targetConversationId: 'conversation-owner', targetIdentityId: 'identity-owner', contentScope: 'result', contentKey: 'work.accepted', status: 'pending', attempts: 0, createdAt: now, updatedAt: now } }
function occurrenceRecord(id, rule, scheduledDate, workId, deliveryId = null, status = null) { return { id, occurrenceKey: dailyOccurrenceKey(rule.id, scheduledDate), ruleId: rule.id, ruleRevision: rule.revision, scheduledDate, workId, status, reason: status ? 'test-reason' : null, deliveryId, createdAt: now } }
function run(args, env) { return execFile(process.execPath, [transfer, ...args], { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 }) }
