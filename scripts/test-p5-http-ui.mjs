import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script, createContext, runInContext } from 'node:vm'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createAutomationRuntime, createAutomationService, dailyOccurrenceKey, eventOccurrenceKey } from '../src/automation-service.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore, migrateState, STATE_VERSION } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const now = '2026-10-15T00:00:00.000Z', historicalAt = '2026-09-21T00:00:00.000Z', scheduledDate = '2026-09-21'
const sourceId = 'gearjob:dev.localhost', sourceRevision = '2026-09-21 08:00:00.000001'
const actor = { id: 'member-owner' }, unconfiguredSource = { status: 'unavailable', code: 'SOURCE_NOT_CONFIGURED', reconcileIntervalSeconds: 60, sources: [] }
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--harness-check') await harnessCheck()
else if (args.length === 1 && args[0] === '--http-only') await main({ httpOnly: true })
else if (args.length === 1 && args[0] === '--help') console.log('P4 保留回归：无参数执行受控 loopback HTTP 和隔离 Chrome 桌面/手机检查；实际运行须 controller 的候选/guard/GO。\n--http-only 仅运行同一受控 HTTP 回归，不代表浏览器检查通过。\n--harness-check 仅检查内存夹具、服务边界与实际 Web helpers，不监听端口或启动浏览器/native/model。')
else { assert.equal(args.length, 0, '支持无参数、--http-only、--harness-check 或 --help'); await main() }

async function main({ httpOnly = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'geneway-p5-http-ui-')), authPath = join(temp, 'auth.json')
  const store = createFileStore(join(temp, 'state.json')), origin = `http://127.0.0.1:${await freePort()}`
  const injectedRunner = controlledRunner()
  let server, service, runtime, runtimeRefreshes = 0, transportAvailable = true, sends = 0
  const request = client(origin)
  try {
    await store.update(() => fixture())
    await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-owner': 'owner password', 'member-peer': 'peer password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
    service = createWorkService({ store, runner: injectedRunner, connectionCatalog: [catalog()] })
    await service.ensureReady()
    const channel = createChannelService({ store, workService: service, clock: () => now, connectionCatalog: [catalog()] })
    const automation = createAutomationService({ store, workService: service, connectionCatalog: [catalog()], clock: () => now })
    // No timer callback is executed: these are historical rules, not a restored event source.
    runtime = createAutomationRuntime({ store, automationService: automation, workService: service, dataRoot: temp, clock: () => now, lockFactory: async () => ({ async release() {} }), timerFactory: () => ({ unref() {} }), clearTimer() {} })
    const automationRuntime = { ...runtime, async refresh() { runtimeRefreshes += 1; await runtime.refresh() } }
    const channelRuntime = {
      isAvailable: id => id === 'app-feishu' && transportAvailable,
      async sendDelivery(id, { retry = false } = {}) {
        await (retry ? channel.retryDelivery({ deliveryId: id }) : channel.authorizeDelivery({ deliveryId: id }))
        await channel.validateSendClaim({ deliveryId: id }); sends += 1
        return channel.recordDeliveryOutcome({ deliveryId: id, status: 'delivered', providerMessageId: `controlled-message-${sends}` })
      },
    }
    const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
    server = createGenewayServer({ service, conversationService: { async listConversations() { return [] } }, knowledge: { async listShareTargets() { return { members: [], employees: [] } }, async listMaterials() { return [] } }, collaborationRunner: { isKnowledgeEnabled: () => true }, channel, channelRuntime, automation, automationRuntime, connectionCatalog: [catalog()], store, auth: createAuthRuntime({ filePath: authPath }), index, trustedOrigin: origin })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(origin).port, '127.0.0.1', resolve) })
    const login = (name, password) => request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password } })
    const admin = await login('admin', 'admin password'), owner = await login('owner', 'owner password'), peer = await login('peer', 'peer password')
    for (const session of [admin, owner, peer]) assert.equal(session.status, 200)
    assert.equal((await request('/api/automations')).status, 401)
    assert.equal((await request('/api/automations', { method: 'POST', cookie: owner.cookie, json: dailyBody() })).status, 403)
    assert.equal((await request('/api/automations', { method: 'POST', session: owner, originHeader: 'http://evil.invalid', json: dailyBody() })).status, 403)
    for (const extra of [{ unexpected: true }, { notificationConversationId: 'conversation-owner' }, { ownerMemberId: 'member-peer' }]) assert.equal((await request('/api/automations', { method: 'POST', session: owner, json: { ...dailyBody(), ...extra } })).status, 400)
    assert.equal((await request('/api/automations?unexpected=true', { session: owner })).status, 400)
    assert.deepEqual((await request('/api/automations', { session: owner })).body.eventSource, unconfiguredSource)
    for (const session of [peer, admin]) {
      assert.deepEqual((await request('/api/automations', { session })).body, { rules: [], occurrences: [], eventSource: unconfiguredSource })
      assert.equal((await request('/api/automations/rule-http', { session })).status, 404)
      assert.equal((await request('/api/works/work-http', { session })).status, 404)
      for (const action of ['pause', 'revoke']) assert.equal((await request('/api/automations/rule-http/' + action, { method: 'POST', session, json: { expectedRevision: 1 } })).status, 404)
      assert.equal((await request('/api/channels/deliveries/delivery-failed/retry', { method: 'POST', session, json: {} })).status, 404)
    }
    const history = (await request('/api/automations/rule-http', { session: owner })).body
    assert.equal(history.occurrences.length, 1)
    for (const key of ['work', 'delivery']) assert.equal(Object.hasOwn(history.occurrences[0], key), false)
    const beforeUnavailable = await store.read()
    const unavailable = await request('/api/automations/rule-http/check-now', { method: 'POST', session: owner, json: { expectedRevision: 1, clientRequestId: 'owner-unavailable' } })
    assert.equal(unavailable.status, 503)
    assert.deepEqual(unavailable.body, { error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求', status: 503 } })
    assert.deepEqual(await store.read(), beforeUnavailable)
    await runtime.start()
    const retiredRequests = [
      ['/api/automations', 'POST', dailyBody()],
      ['/api/automations', 'POST', { ...dailyBody(), trigger: { kind: 'gearjob-work-order-update', sourceId } }],
      ['/api/automations/rule-http', 'PATCH', { ...dailyBody(), expectedRevision: 1 }],
      ['/api/automations/rule-draft/enable', 'POST', { expectedRevision: 1 }],
      ['/api/automations/rule-paused/resume', 'POST', { expectedRevision: 2 }],
      ['/api/automations/rule-http/check-now', 'POST', { expectedRevision: 1, clientRequestId: 'retired-manual' }],
      ['/api/automations/rule-http/check-now', 'POST', { expectedRevision: 1, clientRequestId: 'retired-manual' }],
      ['/api/works/work-http/continue', 'POST', { clientRequestId: 'retired-continue', input: { workOrderId: 'WO-HTTP' } }],
      ['/api/works/work-http/refresh', 'POST', { clientRequestId: 'retired-refresh' }],
      ['/api/works/work-http/follow-up', 'POST', { clientRequestId: 'retired-question', text: '补充核对' }],
    ]
    for (const [path, method, json] of retiredRequests) {
      const before = await store.read(), response = await request(path, { method, json, session: owner })
      assert.equal(response.status, 409, path + ' response: ' + JSON.stringify(response.body)); assert.equal(response.body.error.code, 'CAPABILITY_RETIRED', path)
      assert.deepEqual(await store.read(), before, path + ' must not create rules, works, executions, reservations, occurrences or deliveries')
    }
    const beforePause = await store.read()
    assert.equal((await request('/api/automations/rule-http/pause', { method: 'POST', session: owner, json: { expectedRevision: 9 } })).body.error.code, 'REVISION_CONFLICT')
    assert.deepEqual(await store.read(), beforePause)
    const paused = await request('/api/automations/rule-http/pause', { method: 'POST', session: owner, json: { expectedRevision: 1 } })
    assert.equal(paused.status, 200); assert.equal(paused.body.status, 'paused'); assert.equal(paused.body.revision, 2)
    const revoked = await request('/api/automations/rule-http/revoke', { method: 'POST', session: owner, json: { expectedRevision: 2 } })
    assert.equal(revoked.status, 200); assert.equal(revoked.body.status, 'revoked'); assert.equal(revoked.body.revision, 3)
    assert.equal(runtimeRefreshes, 2, 'successful pause and revoke refresh the existing owner')
    assert.deepEqual(facts(await store.read()), facts(beforePause), 'pause/revoke preserve original occurrence, result, source, time and delivery facts')
    assert.equal((await request('/api/channels/deliveries/delivery-unknown/retry', { method: 'POST', session: owner, json: {} })).body.error.code, 'INVALID_STATE')
    assert.equal(sends, 0)
    if (httpOnly) { assert.equal(injectedRunner.calls, 0); console.log('P4 retained controlled HTTP checks passed: auth/strict fields/owner history, exact retirement 409/code/no new facts, safe owner-unavailable 503 and pause/revoke CAS; browser skipped, native/real-model/upstream calls=0'); return }

    // This independent cycle work is the only new execution; it is not an old automatic rule.
    const created = await request('/api/works', { method: 'POST', session: owner, json: { employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', goal: '停止合法节拍工作', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: 'retained-cycle-stop' } })
    assert.equal(created.status, 200)
    await waitFor(async () => (await service.getWork(actor, created.body.id)).value.status === 'running')
    const beforeBrowser = await store.read()
    const browserResult = await browserJourney({ origin, temp, request, owner, activeWorkId: created.body.id, setTransportAvailable(value) { transportAvailable = value } })
    const afterBrowser = await store.read()
    assert.equal(afterBrowser.works.find(item => item.id === created.body.id).status, 'cancelled')
    assert.equal(afterBrowser.deliveries.find(item => item.id === 'delivery-failed').status, 'delivered')
    assert.equal(afterBrowser.deliveries.find(item => item.id === 'delivery-unknown').status, 'unknown')
    assert.deepEqual(counts(afterBrowser), counts(beforeBrowser), 'UI pause/revoke/stop/notification retry must not create new work or execute again')
    assert.deepEqual(afterBrowser.works.filter(item => item.id !== created.body.id), beforeBrowser.works.filter(item => item.id !== created.body.id))
    assert.deepEqual(afterBrowser.automationOccurrences, beforeBrowser.automationOccurrences)
    assert.equal(injectedRunner.calls, 1); assert.equal(sends, 1)
    console.log('P4 retained automation HTTP/UI checks passed; synthetic history, controlled cycle runner/transport, no native/model/upstream calls', JSON.stringify(browserResult))
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    await runtime?.close(); await service?.close(); await injectedRunner.close()
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

function dailyBody() { return { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId: 'WO-HTTP', trigger: { kind: 'daily-time', time: '08:00', timeZone: 'Asia/Shanghai' }, maxRuns: 10, notificationIdentityId: 'identity-owner' } }
function ruleRecord(suffix, status = 'active', event = false) {
  return { id: 'rule-' + suffix, ownerMemberId: actor.id, revision: status === 'paused' ? 2 : status === 'revoked' ? 3 : 1, status, ...dailyBody(), workOrderId: 'WO-' + suffix.toUpperCase(), trigger: event ? { kind: 'gearjob-work-order-update', sourceId } : dailyBody().trigger, effectiveFrom: status === 'draft' || event ? null : historicalAt, eventAcceptAfter: event && status !== 'draft' ? historicalAt : null, createdAt: historicalAt, updatedAt: historicalAt, revokedAt: status === 'revoked' ? historicalAt : null }
}
function workRecord(suffix, cycle = false) {
  const capabilityId = cycle ? 'cycle-time-calculate' : 'gearjob-work-order-read', skillId = 'skill-' + capabilityId, resultId = 'result-' + suffix, session = 'historical-session-' + suffix
  const input = cycle ? { availableSeconds: 60, quantity: 1 } : { workOrderId: 'WO-' + suffix.toUpperCase() }
  const source = { sourceSystem: 'GearJob', sourceInstance: 'p5-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', sourceRecordId: 'Work Order:' + input.workOrderId, sourceRevision }
  const result = { id: resultId, kind: cycle ? 'manufacturing.takt' : 'gearjob.work-order.observation', capabilityId, skillId, schemaVersion: 1, input, payload: cycle ? { ...input, secondsPerUnit: 60, unit: 'seconds/unit' } : { observationId: resultId, ...input, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', completion: { ratio: 0.4, overPlan: false }, queriedAt: historicalAt, ...source, explanation: '原工单事实', dshSessionRef: session }, explanation: cycle ? '原节拍结果 60 秒/件' : '原工单事实', ...(cycle ? {} : { source }), createdAt: historicalAt, dshSessionRef: session, contextConfirmationRefs: [], toolName: cycle ? 'geneway_calculate_cycle_time' : 'geneway_gearjob_read_work_order', pluginId: cycle ? 'geneway-cycle-time' : 'geneway-gearjob-work-order', pluginVersion: '2' }
  return { id: 'work-' + suffix, ownerMemberId: actor.id, employeeId: 'employee-owner', capabilityId, skillId, ...(cycle ? {} : { connectionId: 'connection-owner' }), goal: cycle ? '已保存的节拍工作' : '原工单核对', input, requiredInputs: [], status: 'completed', acceptedAt: historicalAt, results: [result], actions: [], executions: [{ id: 'exec-' + suffix, operation: cycle ? 'create' : 'automation', clientRequestId: cycle ? 'historical-cycle' : suffix === 'event' ? eventOccurrenceKey('rule-event', sourceId, sourceRevision, input.workOrderId) : dailyOccurrenceKey('rule-' + suffix, scheduledDate), input, status: 'completed', acceptedAt: historicalAt, completedAt: historicalAt, resultId }] }
}
function deliveryRecord(suffix, workId, status, automatic = false) {
  return { id: 'delivery-' + suffix, channelAppId: 'app-feishu', requestId: 'historical-' + suffix, workId, resultId: 'result-' + workId.slice('work-'.length), targetConversationId: 'conversation-owner', targetIdentityId: 'identity-owner', contentScope: 'result', contentKey: automatic ? 'automation.completed' : 'result.gearjob', authorizationRevisions: { app: 1, identity: 1, conversation: 1 }, status, attempts: 1, ...(status === 'delivered' ? { providerMessageId: 'historical-message-' + suffix } : { error: { code: status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'FEISHU_230001', message: status === 'unknown' ? '发送效果待核对' : '渠道发送失败' } }), createdAt: historicalAt, updatedAt: historicalAt }
}
function fixture() {
  const member = (id, loginName, role, employeeIds) => ({ id, loginName, displayName: loginName, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: historicalAt, updatedAt: historicalAt })
  const rules = [ruleRecord('http'), ruleRecord('draft', 'draft'), ruleRecord('paused', 'paused'), ruleRecord('revoked', 'revoked'), ruleRecord('event', 'active', true), ruleRecord('mobile'), ruleRecord('conflict')]
  const occurrences = ['http', 'paused', 'revoked', 'event', 'mobile'].map(suffix => {
    const event = suffix === 'event' ? { sourceId, sourceRevision, digest: 'f'.repeat(64) } : null
    return { id: 'occ-' + suffix, occurrenceKey: event ? eventOccurrenceKey('rule-' + suffix, sourceId, sourceRevision, 'WO-EVENT') : dailyOccurrenceKey('rule-' + suffix, scheduledDate), ruleId: 'rule-' + suffix, ruleRevision: 1, scheduledDate: event ? null : scheduledDate, event, workId: 'work-' + suffix, status: null, reason: null, deliveryId: suffix === 'http' ? 'delivery-delivered' : suffix === 'event' ? 'delivery-unknown' : null, createdAt: historicalAt }
  })
  occurrences.push({ id: 'occ-missed', occurrenceKey: dailyOccurrenceKey('rule-conflict', '2026-09-20'), ruleId: 'rule-conflict', ruleRevision: 1, scheduledDate: '2026-09-20', event: null, workId: null, status: 'skipped', reason: 'missed-window', deliveryId: null, createdAt: historicalAt })
  return migrateState({ version: STATE_VERSION, defaultChannelEmployeeId: null,
    members: [member('member-admin', 'admin', 'admin', []), member(actor.id, 'owner', 'member', ['employee-owner']), member('member-peer', 'peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: '受控模型替身', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '工单核对员', description: '保留历史并执行独立节拍工作', instructions: '', revision: 1, enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read', 'skill-cycle-time-calculate'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob 外部测试', ...catalog(), allowedObjectIds: rules.map(rule => rule.workOrderId), enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '原工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }, { id: 'skill-cycle-time-calculate', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }],
    channelApps: [{ id: 'app-feishu', provider: 'feishu', providerAppId: 'official-app', providerTenantId: 'official-tenant', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: historicalAt, updatedAt: historicalAt }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-feishu', providerUserId: 'user-owner', memberId: actor.id, verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: historicalAt, updatedAt: historicalAt }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-feishu', providerConversationId: 'conversation-owner', identityId: 'identity-owner', memberId: actor.id, type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: null, createdAt: historicalAt, updatedAt: historicalAt }],
    automationRules: rules, automationOccurrences: occurrences, automationInbox: [],
    works: [...['http', 'paused', 'revoked', 'event', 'mobile'].map(suffix => workRecord(suffix)), workRecord('cycle-notify', true)],
    deliveries: [deliveryRecord('delivered', 'work-http', 'delivered', true), deliveryRecord('unknown', 'work-event', 'unknown', true), deliveryRecord('failed', 'work-cycle-notify', 'failed')],
    confirmations: [], knowledgeMaterials: [], channelMessages: [], linkCodes: [], conversations: [], reservations: {},
  })
}
function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'p5-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function facts(state) { return { works: state.works, occurrences: state.automationOccurrences, deliveries: state.deliveries, reservations: state.reservations } }
function counts(state) { return { works: state.works.length, executions: state.works.reduce((sum, work) => sum + work.executions.length, 0), occurrences: state.automationOccurrences.length, deliveries: state.deliveries.length, reservations: Object.keys(state.reservations).length } }
function controlledRunner() {
  const gates = new Map()
  return { configured: true, calls: 0,
    async run(options) { assert.equal(options.capabilityId, 'cycle-time-calculate', 'no retired source may execute'); this.calls += 1; await new Promise(resolve => gates.set(options.executionId, resolve)); return { explanation: '受控节拍结果', dshSessionRef: 'controlled-cycle-session', contextConfirmationRefs: [], result: { kind: 'manufacturing.takt', payload: { ...options.input, secondsPerUnit: options.input.availableSeconds / options.input.quantity, unit: 'seconds/unit' }, toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2' } } },
    async cancel(executionId) { gates.get(executionId)?.(); gates.delete(executionId) }, async close() { for (const release of gates.values()) release(); gates.clear() },
  }
}
function client(origin) {
  return async (path, options = {}) => {
    const headers = {}; if (options.originHeader) headers.origin = options.originHeader
    if (options.session) { headers.origin = options.originHeader ?? origin; headers.cookie = String(options.session.cookie).split(';', 1)[0]; headers['x-csrf-token'] = options.session.body.csrfToken } else if (options.cookie) headers.cookie = String(options.cookie).split(';', 1)[0]
    if (options.json !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(origin + path, { method: options.method ?? 'GET', headers, body: options.json === undefined ? undefined : JSON.stringify(options.json) }), text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') }
  }
}

async function harnessCheck() {
  let value = fixture()
  const store = { async read() { return structuredClone(value) }, async update(mutator) { value = migrateState(await mutator(structuredClone(value))); return structuredClone(value) } }
  const automation = createAutomationService({ store, workService: {}, connectionCatalog: [catalog()], clock: () => now })
  assert.deepEqual(await automation.eventSourceCapability(actor), unconfiguredSource)
  const baseline = await store.read()
  for (const attempt of [() => automation.createRule(actor, dailyBody()), () => automation.updateRule(actor, 'rule-http', { ...dailyBody(), expectedRevision: 1 }), () => automation.enableRule(actor, 'rule-draft', { expectedRevision: 1 }), () => automation.resumeRule(actor, 'rule-paused', { expectedRevision: 2 }), () => automation.acceptManualOccurrence(actor, 'rule-http', { expectedRevision: 1, clientRequestId: 'pure-retired' }), () => automation.acceptDailyOccurrence({ ruleId: 'rule-http', scheduledDate }), () => automation.acceptGearJobEvent({ sourceId, workOrderId: 'WO-EVENT', sourceRevision, digest: 'f'.repeat(64) })]) { await assert.rejects(attempt, { code: 'CAPABILITY_RETIRED' }); assert.deepEqual(await store.read(), baseline) }
  for (const id of ['member-peer', 'member-admin']) { await assert.rejects(automation.getRule({ id }, 'rule-http'), { code: 'NOT_FOUND' }); await assert.rejects(automation.listOccurrences({ id }, 'rule-http'), { code: 'NOT_FOUND' }) }
  await assert.rejects(automation.pauseRule(actor, 'rule-http', { expectedRevision: 9 }), { code: 'REVISION_CONFLICT' })
  assert.equal((await automation.pauseRule(actor, 'rule-http', { expectedRevision: 1 })).revision, 2)
  assert.equal((await automation.revokeRule(actor, 'rule-http', { expectedRevision: 2 })).status, 'revoked')
  assert.deepEqual(facts(await store.read()), facts(baseline))
  const workService = createWorkService({ store, connectionCatalog: [catalog()] })
  const channel = createChannelService({ store, workService, clock: () => now, connectionCatalog: [catalog()] })
  await assert.rejects(channel.retryDelivery({ deliveryId: 'delivery-unknown' }), { code: 'INVALID_STATE' })
  const beforeRetry = counts(await store.read())
  await channel.retryDelivery({ deliveryId: 'delivery-failed' }); await channel.validateSendClaim({ deliveryId: 'delivery-failed' })
  await channel.recordDeliveryOutcome({ deliveryId: 'delivery-failed', status: 'delivered', providerMessageId: 'pure-controlled-ack' })
  assert.deepEqual(counts(await store.read()), beforeRetry)
  assert.equal((await store.read()).deliveries.find(item => item.id === 'delivery-unknown').status, 'unknown')
  const injectedRunner = controlledRunner(), stopService = createWorkService({ store, runner: injectedRunner, connectionCatalog: [catalog()] })
  try {
    const created = await stopService.createWork(actor, { employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 120, quantity: 2 }, clientRequestId: 'pure-cycle-stop' })
    assert.equal(created.ok, true)
    await waitFor(async () => (await stopService.getWork(actor, created.value.id)).value.status === 'running')
    await stopService.cancel(actor, created.value.id)
    await waitFor(async () => (await stopService.getWork(actor, created.value.id)).value.status === 'cancelled')
    assert.equal(injectedRunner.calls, 1)
    assert.deepEqual((await store.read()).works.filter(item => item.id !== created.value.id), baseline.works)
  } finally { await stopService.close() }
  await checkUi(fixture())
  await checkAutomationEditor()
  console.log('P4 retained harness checks passed: current schema closed history graph, retired admissions/no new facts, owner-only history, pause/revoke CAS, legal cycle stop/saved notification retry, unknown no retry and actual Web helpers; HTTP/browser/native/real-model/upstream not run')
}
async function checkUi(fixtureState) {
  const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), script = index.match(/<script>([\s\S]*?)<\/script>/)[1]
  new Script(script)
  const elements = new Map(), element = id => { if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id) }
  const automation = createAutomationService({ store: { async read() { return fixtureState }, async update() { assert.fail('UI history rendering must not mutate its fixture') } }, clock: () => now })
  const state = { bootstrap: fixtureState, channels: { deliveries: fixtureState.deliveries }, channelApps: fixtureState.channelApps.map(item => ({ ...item, runtimeStatus: 'ready' })), automations: await automation.listRules(actor), automationOccurrences: fixtureState.automationOccurrences, automationDetail: null }
  const box = createContext({ state, document: { getElementById: element, querySelectorAll: () => [] }, bindWorkLinks() {}, bindDeliveryActions() {}, openAutomation() {} })
  const between = (start, end) => { const a = script.indexOf(start), b = script.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return script.slice(a, b) }
  runInContext(between('    const titles=', '    async function api(') + between('    function automationView(', '    async function openAutomation(') + between('    function deliveryCard(', '    function conversationReplyControls('), box)
  for (const rule of state.automations) {
    state.automationDetail = { rule, occurrences: fixtureState.automationOccurrences.filter(item => item.ruleId === rule.id) }
    runInContext('renderAutomations()', box)
    const html = element('automation-detail').innerHTML
    assert.doesNotMatch(html, /data-rule-action="(?:enable|resume)"|data-check-now|automation-edit/)
    assert.equal(/data-rule-action="pause"/.test(html), rule.status === 'active')
    assert.equal(/data-rule-action="revoke"/.test(html), rule.status !== 'revoked')
    if (rule.id === 'rule-event') { assert.ok(html.includes(sourceRevision)); for (const label of ['事件：', '接收：', '通知：']) assert.ok(html.includes(label)) }
  }
  box.delivery = fixtureState.deliveries.find(item => item.id === 'delivery-unknown')
  assert.match(runInContext('deliveryCard(delivery)', box), /不会盲目重发/)
  assert.doesNotMatch(runInContext('deliveryCard(delivery)', box), /data-retry-delivery/)
  box.delivery = fixtureState.deliveries.find(item => item.id === 'delivery-failed')
  assert.match(runInContext('deliveryCard(delivery)', box), /data-retry-delivery="delivery-failed"/)
  state.channelApps[0].runtimeStatus = 'unavailable'
  assert.match(runInContext('deliveryCard(delivery)', box), /data-retry-delivery="delivery-failed" disabled/)
  assert.equal(element('new-automation').disabled, true, 'retained GearJob grants cannot create Kivo rules')
}

async function checkAutomationEditor() {
  const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), script = index.match(/<script>([\s\S]*?)<\/script>/)[1]
  new Script(script)
  const elements = new Map(), calls = [], messages = [], frames = []
  const node = id => { if (!elements.has(id)) elements.set(id, { id, value: '', innerHTML: '', disabled: false, focus() { document.activeElement = this } }); return elements.get(id) }
  const document = { activeElement: null, body: node('body'), getElementById: node, querySelectorAll: () => [] }
  const employee = { id: 'employee-a', name: 'TPM 员工', enabled: true, skillIds: ['read'], connectionIds: ['connection-a'] }
  const connection = { id: 'connection-a', name: 'Kivo A', kind: 'kivo-mcp', enabled: true, status: 'ready', skillIds: ['read'] }
  const source = { sourceId: 'source-a', connectionId: connection.id, recordTypes: ['repair', 'maintenance', 'inspection'], status: 'available' }
  const state = { authEpoch: 1, view: 'works', automationReadRequest: 0, automationPending: false, automationEditor: null, automationDetail: null, automations: [], automationOccurrences: [], channelApps: [{ id: 'app', provider: 'feishu', enabled: true, status: 'active', runtimeStatus: 'ready' }], channels: { identities: [{ id: 'identity-a', channelAppId: 'app', status: 'active' }], conversations: [{ identityId: 'identity-a', type: 'private', status: 'active' }], deliveries: [] }, bootstrap: { employees: [employee], skills: [{ id: 'read', name: 'TPM 读取', enabled: true, capabilityId: 'kivo-tpm-record-read' }], connections: [connection], works: [] }, eventSource: { status: 'available', reconcileIntervalSeconds: 60, sources: [source, { ...source, sourceId: 'foreign-source', connectionId: 'foreign-connection' }] } }
  let serverRule, rejectSave = false, rejectRead = false, deferSave, reloads = 0
  const box = createContext({ state, document, structuredClone, requestAnimationFrame: callback => frames.push(callback), window: { confirm: () => true }, crypto: { randomUUID: () => 'explicit-check' }, bindWorkLinks() {}, bindDeliveryActions() {}, reloadAll: async () => { reloads++ }, setMessage: (...args) => messages.push(args), api: async (path, options = {}) => {
    calls.push([path, JSON.parse(JSON.stringify(options))])
    if (options.method === 'POST' && path === '/api/automations') { if (deferSave) return new Promise(resolve => { deferSave = resolve }); serverRule = { id: 'new-rule', capabilityId: 'kivo-tpm-record-read', retired: false, revision: 1, status: 'draft', usedRuns: 0, pauseReason: null, ...JSON.parse(JSON.stringify(options.body)) }; return serverRule }
    if (options.method === 'PATCH') { if (rejectSave) throw Object.assign(new Error('规则已变化，请刷新后重试'), { status: 409 }); serverRule = { ...serverRule, ...JSON.parse(JSON.stringify(options.body)), revision: serverRule.revision + 1 }; return serverRule }
    if (options.method === 'POST') { const action = path.split('/').at(-1); if (action === 'check-now') return { accepted: true, workId: 'current-check', deduplicated: false }; serverRule = { ...serverRule, status: { enable: 'active', pause: 'paused', resume: 'active', revoke: 'revoked' }[action], revision: serverRule.revision + 1 }; return serverRule }
    if (rejectRead) throw new Error('规则读取暂不可用')
    return { rule: structuredClone(serverRule), occurrences: [], eventSource: state.eventSource }
  } })
  const between = (start, end) => { const a = script.indexOf(start), b = script.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return script.slice(a, b) }
  runInContext(between('    const titles=', '    async function api(') + between('    function automationView(', '    function channelEmployeeSelect(') + between('    function deliveryCard(', '    function conversationReplyControls('), box)
  const choose = (id, value) => { const input = node('automation-' + id); input.value = value; (input.oninput || input.onchange)() }
  const editorHtml = () => node('automation-editor').innerHTML
  const body = () => JSON.parse(JSON.stringify(runInContext('automationEditorBody(state.automationEditor)', box)))
  runInContext('renderAutomations()', box); assert.equal(node('new-automation').disabled, false)
  node('new-automation').onclick(); assert.equal(state.automationEditor.fields.employeeId, employee.id); assert.match(editorHtml(), /保存草稿/)
  choose('reference', '  REPAIR-001  '); choose('notification', 'identity-a')
  assert.equal(calls.length, 0, 'opening and editing local fields never saves or enables')
  for (const recordType of ['repair', 'maintenance', 'inspection']) for (const kind of ['daily-time', 'kivo-record-update']) {
    choose('record-type', recordType); choose('trigger-kind', kind)
    const value = body(); assert.deepEqual(value.input, { recordType, reference: 'REPAIR-001' }); assert.equal(value.maxRuns, 10); assert.equal(value.notificationIdentityId, 'identity-a')
    assert.equal(value.trigger.kind, kind); assert.equal(value.employeeId, employee.id); assert.equal(value.connectionId, connection.id)
    if (kind === 'kivo-record-update') { assert.equal(value.trigger.sourceId, source.sourceId); assert.doesNotMatch(editorHtml(), /foreign-source/); assert.match(editorHtml(), /每 60 秒发起当前状态核对/); assert.match(editorHtml(), /不补历史变更/) }
    else assert.deepEqual(value.trigger, { kind, time: '08:00', timeZone: 'Asia/Shanghai' })
    assert.equal(value.capabilityId, undefined); assert.equal(value.ownerMemberId, undefined)
  }
  state.automationEditor.fields.sourceId = 'foreign-source'; assert.throws(body, /当前连接和单据类型/); state.automationEditor.fields.sourceId = source.sourceId
  source.recordTypes = ['repair']; choose('record-type', 'inspection'); assert.throws(body, /当前连接和单据类型/); assert.match(editorHtml(), /没有可用事件来源/)
  source.recordTypes = ['repair', 'maintenance', 'inspection']; choose('record-type', 'inspection')
  choose('max-runs', '11'); assert.throws(body, /1–10/); choose('max-runs', '4')
  node('automation-close').onclick(); assert.equal(state.automationEditor, null); assert.equal(calls.length, 0)
  node('new-automation').onclick(); assert.equal(state.automationEditor.fields.reference, '', 'reopen starts a new unsaved draft'); assert.equal(calls.length, 0)
  choose('reference', 'REPAIR-001'); await node('automation-form').onsubmit({ preventDefault() {} })
  assert.equal(state.automationEditor, null); assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1); assert.equal(serverRule.status, 'draft'); assert.equal(reloads, 1)
  assert.match(node('automation-detail').innerHTML, /data-rule-action="enable"/); assert.match(node('automation-detail').innerHTML, /data-automation-rule="new-rule" data-revision="1"/)
  runInContext('startAutomationEditor(state.automationDetail.rule)', box); choose('reference', 'LOCAL-UNSAVED'); rejectSave = true
  await node('automation-form').onsubmit({ preventDefault() {} }); assert.equal(state.automationEditor.fields.reference, 'LOCAL-UNSAVED'); assert.equal(state.automationEditor.rule.revision, 1); assert.equal(state.automationEditor.conflict, true)
  state.automations = [{ ...serverRule, revision: 2 }]; runInContext('renderAutomations()', box); assert.equal(state.automationEditor.fields.reference, 'LOCAL-UNSAVED'); assert.equal(body().expectedRevision, 1, 'rerender must not silently advance CAS')
  rejectRead = true; await node('automation-reload-editor').onclick(); assert.equal(state.automationEditor.fields.reference, 'LOCAL-UNSAVED'); assert.equal(state.automationEditor.rule.revision, 1); rejectRead = false
  serverRule = { ...serverRule, revision: 2 }; await node('automation-reload-editor').onclick(); assert.equal(state.automationEditor.rule.revision, 2); assert.equal(state.automationEditor.fields.reference, 'REPAIR-001'); rejectSave = false
  node('automation-close').onclick(); await runInContext('automationAction(state.automationDetail.rule,"enable")', box)
  assert.equal(state.automationDetail.rule.status, 'active'); assert.equal(calls.find(([path]) => path.endsWith('/enable'))[1].body.expectedRevision, 2)
  for (const status of ['active', 'paused']) {
    serverRule = { ...serverRule, status, usedRuns: status === 'active' ? 0 : 2, baselineRevision: 7, handledRevision: 9 }; state.automationDetail = { rule: serverRule, occurrences: [] }
    runInContext('startAutomationEditor(state.automationDetail.rule)', box)
    for (const id of ['employee', 'skill', 'connection', 'record-type', 'trigger-kind']) assert.match(editorHtml(), new RegExp('id="automation-' + id + '" disabled'))
    assert.match(editorHtml(), /id="automation-reference"[^>]*readonly/)
    state.automationEditor.fields.reference = 'FORGED-NEW-TARGET'; choose('time', '09:30'); choose('max-runs', '6'); choose('notification', '')
    assert.deepEqual(body(), { expectedRevision: serverRule.revision, maxRuns: 6, notificationIdentityId: null, trigger: { kind: 'daily-time', time: '09:30', timeZone: 'Asia/Shanghai' } })
    node('automation-close').onclick()
  }
  serverRule = { ...serverRule, status: 'paused', trigger: { kind: 'kivo-record-update', sourceId: source.sourceId }, pauseReason: { code: 'ACCESS_REVOKED', message: '当前连接授权已撤销' } }; state.automationDetail = { rule: serverRule, occurrences: [] }
  runInContext('renderAutomations()', box); assert.match(node('automation-detail').innerHTML, /automation-pause-reason/); assert.match(node('automation-detail').innerHTML, /当前连接授权已撤销/)
  assert.match(node('automation-detail').innerHTML, /恢复并建立新基线/); assert.doesNotMatch(node('automation-detail').innerHTML, /data-check-now/)
  runInContext('startAutomationEditor(state.automationDetail.rule)', box); assert.equal(body().trigger, undefined, 'event identity is not resent by nonidentity edits'); node('automation-close').onclick()
  await runInContext('automationAction(state.automationDetail.rule,"resume")', box); await runInContext('automationAction(state.automationDetail.rule,"check-now")', box)
  assert.deepEqual(calls.find(([path]) => path.endsWith('/check-now'))[1].body, { expectedRevision: serverRule.revision, clientRequestId: 'explicit-check' })
  const eventAt = '2026-10-16T00:00:01.000Z', queryAt = '2026-10-16T00:00:05.000Z'
  state.automationDetail = { rule: { ...serverRule, eventTargets: [{ eventId: 'pending-event', sourceRevision: 12, occurredAt: eventAt, acceptedAt: eventAt, status: 'pending', occurrenceId: null, reasonText: '当前查询版本尚未达到事件版本，等待下一次核对' }] }, occurrences: [{ id: 'occ-current', ruleId: serverRule.id, scheduledDate: null, createdAt: queryAt, workId: null, event: { sourceRevision: 8, occurredAt: eventAt }, query: { sourceRevision: 10, queriedAt: queryAt }, reasonText: '已按当前版本核对' }] }
  runInContext('renderAutomations()', box)
  const history = node('automation-detail').innerHTML
  assert.match(history, /data-automation-target="pending-event"/); assert.match(history, /等待下一次核对/)
  assert.match(history, /automation-event-facts">事件：8/); assert.match(history, /当前查询版本：10/); assert.ok(history.includes(eventAt) && history.includes(queryAt)); assert.match(history, /已按当前版本核对/)
  assert.ok(calls.every(([path]) => path.startsWith('/api/automations')), 'rule actions never call business work, model or delivery APIs')
  const beforeRetired = calls.length; state.automationDetail.rule = { ...serverRule, retired: true }; await runInContext('automationAction(state.automationDetail.rule,"resume")', box); assert.equal(calls.length, beforeRetired)
  state.automationDetail = null; runInContext('startAutomationEditor()', box); choose('reference', 'LATE-SAVE'); deferSave = true
  const pending = node('automation-form').onsubmit({ preventDefault() {} }); state.authEpoch++; state.automationEditor = null; state.automationDetail = null; const beforeLate = calls.length; deferSave({ id: 'late-rule' }); await pending
  assert.equal(state.automationDetail, null); assert.equal(calls.length, beforeLate, 'late save cannot read into another login')
  state.bootstrap.employees = []; runInContext('renderAutomations()', box); assert.equal(node('new-automation').disabled, true, 'metadata alone does not grant a rule creator'); assert.match(node('automation-create-reason').textContent, /没有获准/)
  console.log('Kivo automation Web helpers passed: fixed three-type daily/event forms, trusted source binding, local close/reopen, draft-only identity, CAS conflict retention, explicit enable/resume/current check, permission reason and late-login isolation (VM only)')
}

async function browserJourney({ origin, temp, request, owner, activeWorkId, setTransportAvailable }) {
  const port = await freePort(), profile = join(temp, 'chrome'); await mkdir(profile, { recursive: true })
  const browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-component-update', '--disable-sync', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', `--app=${origin}`], { stdio: 'ignore' })
  let socket
  try {
    const target = await browserTarget(port, origin); socket = new WebSocket(target.webSocketDebuggerUrl)
    const pending = new Map(); let sequence = 0, consoleErrors = 0, pageErrors = 0, networkErrors = 0, loadEvents = 0, confirmNext = false, confirmations = 0, wheelEvents = 0
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data)
      if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') consoleErrors += 1
      if (value.method === 'Runtime.exceptionThrown') pageErrors += 1
      if (value.method === 'Network.loadingFailed' && !value.params.canceled) networkErrors += 1
      if (value.method === 'Page.loadEventFired') loadEvents += 1
      if (value.method === 'Page.javascriptDialogOpening') { const accept = confirmNext; confirmNext = false; if (accept) confirmations += 1; void send('Page.handleJavaScriptDialog', { accept }).catch(() => { pageErrors += 1 }) }
      if (!value.id) return
      const entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result)
    })
    const evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.text); return value.result.value }
    const wait = expression => waitFor(() => evaluate(expression))
    const rect = selector => evaluate(`(()=>{const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');if(!node)return null;const r=node.getBoundingClientRect(),nav=document.querySelector('.mobile-nav'),n=nav?.getBoundingClientRect(),bar=document.querySelector('.topbar')?.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,disabled:node.disabled,minimum:node.closest('.sidebar,.mobile-nav,.topbar')?0:Math.max(0,bar?.bottom||0),limit:node.closest('.mobile-nav')?innerHeight:n?.height?n.top:innerHeight,viewportWidth:innerWidth}})()`)
    const click = async selector => {
      let geometry
      for (let attempt = 0; attempt < 30; attempt++) {
        geometry = await rect(selector); assert.ok(geometry, 'visible DOM target missing: ' + selector)
        if (geometry.width > 0 && geometry.height > 0 && geometry.x >= 0 && geometry.right <= geometry.viewportWidth && geometry.y >= geometry.minimum && geometry.bottom < geometry.limit) break
        const point = await evaluate(`(()=>{const r=document.querySelector('.content').getBoundingClientRect();return {x:Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y:Math.max(1,Math.min(innerHeight-100,r.y+Math.min(r.height/2,300)))}})()`)
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: geometry.y < geometry.minimum ? -500 : 500 }); wheelEvents += 1
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(geometry?.width && geometry.y >= geometry.minimum && geometry.bottom < geometry.limit && geometry.x >= 0 && geometry.right <= geometry.viewportWidth, 'mouse cannot reach: ' + selector)
      assert.equal(Boolean(geometry.disabled), false, 'disabled target: ' + selector)
      const point = { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 }
      assert.equal(await evaluate(`(()=>{const n=document.elementFromPoint(${point.x},${point.y});return Boolean(n?.closest(${JSON.stringify(selector)}))})()`), true, 'target is covered: ' + selector)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
      return geometry
    }
    const nav = async view => { await click('[data-view="' + view + '"]'); await wait(`document.querySelector('#view-${view}').classList.contains('active')`) }
    const openRule = async id => { await click('[data-open-automation="' + id + '"]'); await wait(`document.querySelector('#automation-detail h3')?.textContent===${JSON.stringify('WO-' + id.slice(5).toUpperCase())}`) }
    const reload = async () => { const previous = loadEvents; await send('Page.reload', { ignoreCache: true }); await waitFor(() => loadEvents > previous); await wait(`!document.querySelector('#app').classList.contains('hidden')`) }
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await wait(`Boolean(document.querySelector('#login-name'))`)
    await click('#login-name'); await send('Input.insertText', { text: 'owner' }); await click('#login-password'); await send('Input.insertText', { text: 'owner password' }); await click('#login-button')
    await wait(`!document.querySelector('#app').classList.contains('hidden')`); await nav('works')
    const noRetiredCreation = await evaluate(`document.querySelector('#new-automation')?.disabled===true&&!document.querySelector('#automation-form,[data-rule-action="enable"],[data-rule-action="resume"],[data-check-now]')`); assert.equal(noRetiredCreation, true)
    await openRule('rule-event')
    const eventHistory = await evaluate(`document.querySelector('.automation-history').innerText`)
    assert.ok(eventHistory.includes(sourceRevision)); assert.match(eventHistory, /事件：/); assert.match(eventHistory, /接收：/); assert.match(eventHistory, /通知：/)
    await click('[data-open-work="work-event"]'); await wait(`document.querySelector('#work-retired-note')&&!document.querySelector('#work-retired-note').classList.contains('hidden')`)
    assert.equal(await evaluate(`Boolean(document.querySelector('#refresh-work,#continue-form,#follow-form'))`), false)
    const historicalWork = await evaluate(`document.querySelector('#work-detail').innerText`); assert.match(historicalWork, /p5-http/); assert.match(historicalWork, /external-test/); assert.match(historicalWork, /synthetic/)
    await nav('works'); await openRule('rule-conflict')
    const changed = await request('/api/automations/rule-conflict/pause', { method: 'POST', session: owner, json: { expectedRevision: 1 } }); assert.equal(changed.status, 200)
    await click('#automation-detail [data-rule-action="pause"]'); await wait(`document.querySelector('#automation-message').classList.contains('error')`)
    assert.match(await evaluate(`document.querySelector('#automation-message').innerText`), /版本|变化|刷新/)
    await reload(); await nav('works'); await openRule('rule-conflict')
    assert.match(await evaluate(`document.querySelector('#automation-detail-card').innerText`), /已暂停/)
    await openRule('rule-event'); const desktopPause = await click('#automation-detail [data-rule-action="pause"]')
    await wait(`document.querySelector('#automation-detail-card .record-title .pill')?.textContent==='已暂停'&&document.querySelector('#automation-message').classList.contains('success')`)
    assert.equal((await request('/api/automations/rule-event', { session: owner })).body.rule.status, 'paused')
    const desktopOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`); assert.equal(desktopOverflow, false)
    await nav('channels'); await wait(`Boolean(document.querySelector('[data-delivery="delivery-unknown"]'))`)
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-delivery="delivery-unknown"] [data-retry-delivery]'))`), false)
    setTransportAvailable(false); await reload(); await nav('channels'); await wait(`Boolean(document.querySelector('[data-retry-delivery="delivery-failed"]')?.disabled)`)
    setTransportAvailable(true); await reload(); await nav('channels'); await wait(`document.querySelector('[data-retry-delivery="delivery-failed"]')?.disabled===false`)
    await click('[data-retry-delivery="delivery-failed"]'); await wait(`!document.querySelector('[data-delivery="delivery-failed"]')`)
    assert.equal((await request('/api/channels', { session: owner })).body.deliveries.find(item => item.id === 'delivery-failed').status, 'delivered')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await nav('works'); await openRule('rule-mobile'); const mobilePause = await click('#automation-detail [data-rule-action="pause"]')
    await wait(`document.querySelector('#automation-detail-card .record-title .pill')?.textContent==='已暂停'&&document.querySelector('#automation-message').classList.contains('success')`)
    await waitFor(async () => (await request('/api/automations/rule-mobile', { session: owner })).body.rule.status === 'paused')
    confirmNext = true; const mobileRevoke = await click('#automation-detail [data-rule-action="revoke"]')
    await waitFor(async () => (await request('/api/automations/rule-mobile', { session: owner })).body.rule.status === 'revoked')
    await wait(`document.querySelector('#automation-detail-card .record-title .pill')?.textContent==='已撤销'`)
    assert.equal(confirmations, 1)
    await click('[data-open-work="' + activeWorkId + '"]'); await wait(`document.querySelector('#cancel-work')?.disabled===false`)
    const mobileStop = await click('#cancel-work')
    await waitFor(async () => (await request('/api/works/' + activeWorkId, { session: owner })).body.status === 'cancelled')
    await wait(`document.querySelector('#cancel-work')?.disabled===true`)
    const mobileOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`); assert.equal(mobileOverflow, false)
    assert.ok(wheelEvents > 0, 'retained journey must actually use the mouse wheel')
    assert.deepEqual({ consoleErrors, pageErrors, networkErrors }, { consoleErrors: 0, pageErrors: 0, networkErrors: 0 })
    return { desktopOverflow, mobileOverflow, noRetiredCreation, eventHistory, desktopPause, mobilePause, mobileRevoke, mobileStop, wheelEvents, consoleErrors, pageErrors, networkErrors }
  } finally {
    socket?.close()
    if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)) }
  }
}
async function browserTarget(port, origin) { for (let i = 0; i < 100; i++) { try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find(item => item.type === 'page' && item.url.startsWith(origin)); if (target) return target } catch {} await new Promise(resolve => setTimeout(resolve, 25)) }; throw new Error('Chrome CDP startup timed out') }
async function waitFor(predicate) { for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }; throw new Error('retained check condition timed out') }
async function freePort() { const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port }
