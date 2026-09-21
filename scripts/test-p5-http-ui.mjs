import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createAutomationService, dailyOccurrenceKey } from '../src/automation-service.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const nowDate = new Date(); nowDate.setUTCSeconds(0, 0)
const now = nowDate.toISOString(), shanghaiNow = new Date(nowDate.getTime() + 8 * 60 * 60 * 1000)
const scheduledDate = shanghaiNow.toISOString().slice(0, 10), triggerTime = shanghaiNow.toISOString().slice(11, 16)
const temp = await mkdtemp(join(tmpdir(), 'geneway-p5-http-ui-'))
const statePath = join(temp, 'state.json'), authPath = join(temp, 'auth.json')
const store = createFileStore(statePath), origin = `http://127.0.0.1:${await freePort()}`
let server, browser, releaseActive, runtimeOwned = true
let runtimeRefreshes = 0

try {
  await store.update(seed)
  await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-owner': 'owner password', 'member-peer': 'peer password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
  const service = createWorkService({ store, runner: runner(), connectionCatalog: [catalog()] })
  const channel = createChannelService({ store, workService: service, clock: () => now })
  const automation = createAutomationService({ store, workService: service, connectionCatalog: [catalog()], clock: () => now, eventSourceId: 'gearjob:dev.localhost' })
  const auth = createAuthRuntime({ filePath: authPath }), index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const knowledge = { async listShareTargets() { return { members: [], employees: [] } }, async listMaterials() { return [] } }
  const channelRuntime = {
    isAvailable: id => id === 'app-feishu',
    async sendDelivery(id, { retry = false } = {}) {
      await (retry ? channel.retryDelivery({ deliveryId: id }) : channel.authorizeDelivery({ deliveryId: id }))
      return channel.recordDeliveryOutcome({ deliveryId: id, status: 'delivered', providerMessageId: `message-${id}` })
    },
  }
  const automationRuntime = { ownsLock: () => runtimeOwned, checkNow: (actor, id, input) => automation.acceptManualOccurrence(actor, id, { ...input, ownerCheck: () => runtimeOwned }), async refresh() { runtimeRefreshes += 1 } }
  server = createGenewayServer({ service, knowledge, collaborationRunner: { isKnowledgeEnabled: () => true }, channel, channelRuntime, automation, automationRuntime, store, auth, index, trustedOrigin: origin })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(origin).port, '127.0.0.1', resolve) })

  const admin = await login('admin', 'admin password'), owner = await login('owner', 'owner password'), peer = await login('peer', 'peer password')
  assert.equal((await request('/api/automations')).status, 401)
  assert.equal((await request('/api/automations', { method: 'POST', cookie: owner.cookie, json: dailyBody('WO-HTTP') })).status, 403)
  assert.equal((await request('/api/automations', { method: 'POST', session: owner, originHeader: 'http://evil.invalid', json: dailyBody('WO-HTTP') })).status, 403)
  assert.equal((await request('/api/automations', { method: 'POST', session: owner, json: { ...dailyBody('WO-HTTP'), unexpected: true } })).status, 400)
  const projected = await request('/api/automations', { cookie: owner.cookie })
  assert.deepEqual(projected.body.eventSource, { status: 'ready', sourceId: 'gearjob:dev.localhost' })
  const eventRule = await request('/api/automations', { method: 'POST', session: owner, json: { ...dailyBody('WO-HTTP'), trigger: { kind: 'gearjob-work-order-update', sourceId: 'gearjob:dev.localhost' } } })
  assert.equal(eventRule.status, 200); assert.equal(eventRule.body.trigger.kind, 'gearjob-work-order-update')
  const enabledEventRule = await request(`/api/automations/${eventRule.body.id}/enable`, { method: 'POST', session: owner, json: { expectedRevision: 1 } })
  assert.equal(enabledEventRule.body.status, 'active')
  const eventAdmission = await automation.acceptGearJobEvent({ sourceId: 'gearjob:dev.localhost', workOrderId: 'WO-HTTP', sourceRevision: `${shanghaiNow.toISOString().slice(0, 10)} ${shanghaiNow.toISOString().slice(11, 19)}.000001`, digest: 'f'.repeat(64) })
  await waitFor(async () => (await service.getWork({ id: 'member-owner' }, eventAdmission.outcomes[0].workId)).value?.status === 'completed')
  const historicalIdentityChange = await request(`/api/automations/${eventRule.body.id}`, { method: 'PATCH', session: owner, json: { ...dailyBody('WO-HTTP'), expectedRevision: 2 } })
  assert.equal(historicalIdentityChange.status, 409); assert.equal(historicalIdentityChange.body.error.code, 'INVALID_STATE')

  const created = await request('/api/automations', { method: 'POST', session: owner, json: dailyBody('WO-HTTP') })
  assert.equal(created.status, 200); assert.equal(created.body.status, 'draft')
  assert.equal((await request(`/api/automations/${created.body.id}`, { cookie: peer.cookie })).status, 404)
  assert.equal((await request(`/api/automations/${created.body.id}`, { cookie: admin.cookie })).status, 404)
  assert.deepEqual((await request('/api/automations', { cookie: peer.cookie })).body, { rules: [], occurrences: [], eventSource: { status: 'ready', sourceId: 'gearjob:dev.localhost' } })
  assert.equal((await request(`/api/automations/${created.body.id}`, { method: 'PATCH', session: owner, json: { ...dailyBody('WO-HTTP'), expectedRevision: 9 } })).status, 409)
  const enabled = await request(`/api/automations/${created.body.id}/enable`, { method: 'POST', session: owner, json: { expectedRevision: 1 } })
  assert.equal(enabled.body.status, 'active')
  assert.equal(runtimeRefreshes, 2, 'enabling each rule must refresh the automation owner')
  const dailyAdmission = await automation.acceptDailyOccurrence({ ruleId: created.body.id, scheduledDate, scheduledAt: now })
  await waitFor(async () => (await automation.listOccurrences({ id: 'member-owner' }, created.body.id)).length === 1)
  await waitFor(async () => (await service.getWork({ id: 'member-owner' }, dailyAdmission.workId)).value?.status === 'completed')
  const detailBeforeRevoke = await request(`/api/automations/${created.body.id}`, { cookie: owner.cookie })
  assert.equal(detailBeforeRevoke.body.occurrences.length, 1); assert.equal(Object.hasOwn(detailBeforeRevoke.body.occurrences[0], 'work'), false); assert.equal(Object.hasOwn(detailBeforeRevoke.body.occurrences[0], 'delivery'), false)
  runtimeOwned = false
  assert.equal((await request(`/api/automations/${created.body.id}/check-now`, { method: 'POST', session: owner, json: { expectedRevision: 2, clientRequestId: 'http-manual-unavailable' } })).status, 503)
  runtimeOwned = true
  assert.equal((await request(`/api/automations/${created.body.id}/check-now`, { method: 'POST', session: peer, json: { expectedRevision: 2, clientRequestId: 'http-manual-peer' } })).status, 404)
  assert.equal((await request(`/api/automations/${created.body.id}/check-now`, { method: 'POST', session: owner, json: { expectedRevision: 9, clientRequestId: 'http-manual-stale' } })).status, 409)
  const manual = await request(`/api/automations/${created.body.id}/check-now`, { method: 'POST', session: owner, json: { expectedRevision: 2, clientRequestId: 'http-manual-once' } })
  const manualReplay = await request(`/api/automations/${created.body.id}/check-now`, { method: 'POST', session: owner, json: { expectedRevision: 2, clientRequestId: 'http-manual-once' } })
  assert.equal(manual.status, 200); assert.equal(manualReplay.body.deduplicated, true); assert.equal(manualReplay.body.workId, manual.body.workId)
  await waitFor(async () => (await service.getWork({ id: 'member-owner' }, manual.body.workId)).value?.status === 'completed')

  const failed = await fixtureRule(automation, service, channel, 'WO-FAILED', 'failed')
  const unknown = await fixtureRule(automation, service, channel, 'WO-UNKNOWN', 'unknown')
  const activeRule = await automation.createRule({ id: 'member-owner' }, dailyBody('WO-ACTIVE'))
  const active = await automation.enableRule({ id: 'member-owner' }, activeRule.id, { expectedRevision: 1 })
  const activeAdmission = await automation.acceptDailyOccurrence({ ruleId: active.id, scheduledDate, scheduledAt: now })
  await waitFor(async () => (await service.getWork({ id: 'member-owner' }, activeAdmission.workId)).value?.status === 'running')
  const missedDraft = await automation.createRule({ id: 'member-owner' }, dailyBody('WO-BROWSER')), missedRule = await automation.enableRule({ id: 'member-owner' }, missedDraft.id, { expectedRevision: 1 })
  await store.update(state => ({ ...state, automationOccurrences: [...state.automationOccurrences, { id: 'missed-ui', occurrenceKey: dailyOccurrenceKey(missedRule.id, '2026-09-19'), ruleId: missedRule.id, ruleRevision: missedRule.revision, scheduledDate: '2026-09-19', workId: null, status: 'skipped', reason: 'missed-window', deliveryId: null, createdAt: now }] }))

  const beforeHistory = (await store.read()).automationOccurrences.filter(item => item.ruleId === created.body.id).length
  const revoked = await request(`/api/automations/${created.body.id}/revoke`, { method: 'POST', session: owner, json: { expectedRevision: 2 } })
  assert.equal(revoked.body.status, 'revoked'); assert.equal((await store.read()).automationOccurrences.filter(item => item.ruleId === created.body.id).length, beforeHistory)
  assert.equal((await request(`/api/automations/${created.body.id}/resume`, { method: 'POST', session: owner, json: { expectedRevision: 3 } })).status, 409)

  const browserResult = await browserJourney({ activeRuleId: active.id, activeWorkId: activeAdmission.workId, eventHistoryRuleId: eventRule.body.id, missedRuleId: missedRule.id, failedRuleId: failed.rule.id, failedDeliveryId: failed.delivery.id, unknownRuleId: unknown.rule.id })
  assert.deepEqual(browserResult, { desktopOverflow: false, mobileOverflow: false, eventEnabled: true, eventCreated: true, eventActionVisible: true, eventHasNoDailyControls: true, eventHistoryVisible: true, eventUnavailableDisabled: true, noNewNavigation: true, draftPreserved: true, focusPreserved: true, revisionDraftPreserved: true, manualOpened: true, manualAttentionCleared: true, mobileManualVisible: true, mobileRunningActionsVisible: true, paused: true, stopped: true, failedRetried: true, unavailableRecovery: true, unknownNoRetry: true, consoleErrors: 0, pageErrors: 0, networkErrors: 0 })
  console.log('P5 HTTP/UI checks passed', JSON.stringify(browserResult))
} finally {
  releaseActive?.()
  if (browser?.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)) }
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

async function fixtureRule(automation, service, channel, workOrderId, deliveryStatus) {
  const draft = await automation.createRule({ id: 'member-owner' }, dailyBody(workOrderId)), rule = await automation.enableRule({ id: 'member-owner' }, draft.id, { expectedRevision: 1 })
  const admission = await automation.acceptDailyOccurrence({ ruleId: rule.id, scheduledDate, scheduledAt: now })
  await waitFor(async () => ['completed', 'failed'].includes((await service.getWork({ id: 'member-owner' }, admission.workId)).value?.status))
  const work = (await service.getWork({ id: 'member-owner' }, admission.workId)).value
  assert.ok(work.results[0], JSON.stringify(work))
  const created = await channel.createDelivery({ id: 'member-owner' }, { channelAppId: 'app-feishu', requestId: `delivery-${deliveryStatus}`, workId: work.id, resultId: work.results[0].id, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' })
  await channel.authorizeDelivery({ deliveryId: created.delivery.id })
  await channel.recordDeliveryOutcome({ deliveryId: created.delivery.id, status: deliveryStatus })
  await store.update(state => ({ ...state, automationOccurrences: state.automationOccurrences.map(item => item.id === admission.occurrence.id ? { ...item, deliveryId: created.delivery.id } : item) }))
  return { rule, delivery: created.delivery }
}

function dailyBody(workOrderId) { return { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-owner', workOrderId, trigger: { kind: 'daily-time', time: triggerTime, timeZone: 'Asia/Shanghai' }, maxRuns: 10, notificationConversationId: 'conversation-owner' } }
function seed(state) {
  const member = (id, loginName, role, employeeIds) => ({ id, loginName, displayName: loginName, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  return { ...state,
    members: [member('member-admin', 'admin', 'admin', []), member('member-owner', 'owner', 'member', ['employee-owner']), member('member-peer', 'peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '工单核对员', description: '核对工单', enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob 外部测试', ...catalog(), allowedObjectIds: ['WO-HTTP', 'WO-BROWSER', 'WO-EVENT', 'WO-FAILED', 'WO-UNKNOWN', 'WO-ACTIVE'], enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }],
    channelApps: [{ id: 'app-feishu', provider: 'feishu', providerAppId: 'official-app', providerTenantId: 'official-tenant', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-feishu', providerUserId: 'user-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-feishu', providerConversationId: 'conversation-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: null, createdAt: now, updatedAt: now }],
  }
}
function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'p5-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function runner() { return { configured: true, async run(args) { if (args.input.workOrderId === 'WO-ACTIVE') await new Promise(resolve => { releaseActive = resolve }); const source = { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'p5-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' }; return { result: { kind: 'gearjob.work-order.observation', payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', ...source }, source, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }, explanation: '工单事实已核对', dshSessionRef: 'session-p5-http', contextConfirmationRefs: [], eventCount: 1 } }, async cancel() { releaseActive?.() }, async close() { releaseActive?.() } } }

async function login(name, password) { return request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password } }) }
async function request(path, options = {}) { const headers = {}; if (options.originHeader) headers.origin = options.originHeader; if (options.session) { headers.origin = options.originHeader ?? origin; headers.cookie = cookiePair(options.session.cookie); headers['x-csrf-token'] = options.session.body.csrfToken } else if (options.cookie) headers.cookie = cookiePair(options.cookie); let body; if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json) } const response = await fetch(origin + path, { method: options.method ?? 'GET', headers, body }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') } }
function cookiePair(value) { return String(value).split(';', 1)[0] }

async function browserJourney(ids) {
  const port = await freePort(), profile = join(temp, 'chrome'); await mkdir(profile, { recursive: true })
  browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', `--app=${origin}`], { stdio: 'ignore' })
  const target = await browserTarget(port), socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0, consoleErrors = 0, pageErrors = 0, networkErrors = 0
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') consoleErrors += 1; if (value.method === 'Runtime.exceptionThrown') pageErrors += 1; if (value.method === 'Network.loadingFailed' && !value.params.canceled) networkErrors += 1; if (!value.id) return; const entry = pending.get(value.id); pending.delete(value.id); value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.text); return value.result.value }
  await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(evaluate, `Boolean(document.querySelector('#login-name'))`); await evaluate(`document.querySelector('#login-name').value='owner';document.querySelector('#login-password').value='owner password';document.querySelector('#login-button').click()`); await wait(evaluate, `!document.querySelector('#app').classList.contains('hidden')`)
  await evaluate(`document.querySelector('[data-view="works"]').click()`); await wait(evaluate, `document.querySelector('#view-works').classList.contains('active')`)
  const eventEnabled = await evaluate(`!document.querySelector('#automation-trigger option[value="gearjob-work-order-update"]').disabled`), noNewNavigation = await evaluate(`![...document.querySelectorAll('.nav')].some(node=>node.innerText.includes('自动'))`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });await evaluate(`document.querySelector('#new-automation').click();document.querySelector('#automation-binding').value=document.querySelector('#automation-binding option:not([value=""])').value;document.querySelector('#automation-binding').dispatchEvent(new Event('input'));document.querySelector('#automation-order').value='WO-EVENT';document.querySelector('#automation-order').dispatchEvent(new Event('input'));document.querySelector('#automation-trigger').value='gearjob-work-order-update';document.querySelector('#automation-trigger').dispatchEvent(new Event('input'))`)
  const eventHasNoDailyControls=await evaluate(`document.querySelector('#automation-time-field').classList.contains('hidden')&&!document.querySelector('#automation-time').required`);await evaluate(`document.querySelector('#automation-form').requestSubmit()`);await wait(evaluate, `state.automationDetail?.rule?.workOrderId==='WO-EVENT'`);await evaluate(`document.querySelector('[data-rule-action="enable"]').click()`);await wait(evaluate, `state.automationDetail?.rule?.status==='active'`)
  const eventCreated=await evaluate(`document.querySelector('#automation-detail').innerText.includes('GearJob 工单更新')&&document.querySelector('#automation-detail').innerText.includes('等待 GearJob 更新')&&!document.querySelector('#automation-detail [data-check-now]')&&!document.querySelector('#automation-edit-time')`),eventActionVisible=await evaluate(`(()=>{const button=document.querySelector('#automation-detail [data-rule-action="pause"]'),nav=document.querySelector('.mobile-nav'),rect=button?.getBoundingClientRect();return Boolean(rect?.width&&rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=nav.getBoundingClientRect().top)})()`);await evaluate(`document.querySelector('#automation-detail [data-rule-action="pause"]').click()`);await wait(evaluate, `state.automationDetail?.rule?.status==='paused'`);await evaluate(`document.querySelector('#automation-detail [data-rule-action="resume"]').click()`);await wait(evaluate, `state.automationDetail?.rule?.status==='active'`);const eventMobileOverflow=await evaluate(`document.documentElement.scrollWidth>innerWidth`)
  await evaluate(`openAutomation('${ids.eventHistoryRuleId}')`);await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.eventHistoryRuleId}'`);const eventHistoryVisible=await evaluate(`document.querySelector('.automation-history').innerText.includes('事件：')&&document.querySelector('.automation-history').innerText.includes('接收：')&&document.querySelector('.automation-history').innerText.includes('查询：')&&document.querySelector('.automation-history').innerText.includes('工作：')&&!document.querySelector('.automation-history').innerText.includes('本人发起')`)
  const eventUnavailableDisabled=await evaluate(`(()=>{const capability=state.eventSource;state.eventSource={status:'unavailable',code:'SOURCE_NOT_CONFIGURED'};renderAutomations();const ok=document.querySelector('#automation-trigger option[value="gearjob-work-order-update"]').disabled&&document.querySelector('#automation-detail').innerText.includes('事件来源当前不可用');state.eventSource=capability;renderAutomations();return ok})()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`document.querySelector('#new-automation').click();document.querySelector('#automation-binding').value=document.querySelector('#automation-binding option:not([value=""])').value;document.querySelector('#automation-binding').dispatchEvent(new Event('input'));document.querySelector('#automation-order').value='WO-BROWSER';document.querySelector('#automation-order').dispatchEvent(new Event('input'));document.querySelector('#automation-time').value='10:15';document.querySelector('#automation-time').dispatchEvent(new Event('input'));document.querySelector('#automation-budget').value='3';document.querySelector('#automation-budget').dispatchEvent(new Event('input'));document.querySelector('#automation-form').requestSubmit()`)
  await wait(evaluate, `state.automations.some(rule=>rule.workOrderId==='WO-BROWSER')`); await wait(evaluate, `state.automationDetail?.rule?.workOrderId==='WO-BROWSER'`); await evaluate(`document.querySelector('[data-rule-action="enable"]').click()`); await wait(evaluate, `state.automationDetail?.rule?.status==='active'`)
  await evaluate(`document.querySelector('#automation-edit-time').value='11:11';document.querySelector('#automation-edit-time').dispatchEvent(new Event('input'));api('/api/automations/'+encodeURIComponent(state.automationDetail.rule.id)+'/pause',{method:'POST',body:{expectedRevision:state.automationDetail.rule.revision}}).then(()=>document.querySelector('#automation-edit').requestSubmit())`); await wait(evaluate, `Boolean(document.querySelector('#automation-edit .danger-note'))`); const revisionDraftPreserved = await evaluate(`document.querySelector('#automation-edit-time').value==='11:11'&&state.automationDrafts[state.automationDetail.rule.id].dirty`); await evaluate(`document.querySelector('#automation-edit').requestSubmit()`); await wait(evaluate, `state.automationDetail?.rule?.trigger?.time==='11:11'&&!state.automationDrafts[state.automationDetail.rule.id]?.dirty`)
  await evaluate(`document.querySelector('#new-automation').click();document.querySelector('#automation-order').value='LOCAL-DRAFT';document.querySelector('#automation-order').dispatchEvent(new Event('input'));document.querySelector('#automation-order').focus()`)
  await evaluate(`reloadAll()`); await wait(evaluate, `state.automationCreateDraft.workOrderId==='LOCAL-DRAFT'`); const draftPreserved = await evaluate(`document.querySelector('#automation-order').value==='LOCAL-DRAFT'`), focusPreserved = await evaluate(`document.activeElement?.id==='automation-order'`)
  await evaluate(`document.querySelector('#cancel-automation-edit').click();openAutomation('${ids.failedRuleId}')`); await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.failedRuleId}'`); const failedRetryButton = await evaluate(`Boolean(document.querySelector('#automation-detail [data-retry-delivery="${ids.failedDeliveryId}"]'))`); const unavailableRecovery = await evaluate(`(()=>{const app=state.channelApps.find(item=>item.id==='app-feishu'),status=app.runtimeStatus;app.runtimeStatus='unavailable';renderAutomations();const ok=document.body.innerText.includes('当前渠道传输未启用，请先恢复渠道')&&!document.querySelector('#automation-detail [data-retry-delivery="${ids.failedDeliveryId}"]');app.runtimeStatus=status;renderAutomations();return ok})()`); await evaluate(`document.querySelector('#automation-detail [data-retry-delivery="${ids.failedDeliveryId}"]').click()`); await wait(evaluate, `state.channels.deliveries.find(item=>item.id==='${ids.failedDeliveryId}')?.status==='delivered'`)
  await evaluate(`openAutomation('${ids.unknownRuleId}')`); await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.unknownRuleId}'`); const unknownNoRetry = await evaluate(`document.body.innerText.includes('发送结果待核对，请勿重复发送')&&!document.querySelector('#automation-detail [data-retry-delivery]')`)
  await evaluate(`openAutomation('${ids.missedRuleId}')`); await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.missedRuleId}'`); assert.equal(await evaluate(`document.querySelector('#automation-detail').innerText.includes('工单核对员')&&document.querySelector('#automation-detail').innerText.includes('工单查询')&&document.querySelector('#automation-detail').innerText.includes('GearJob 外部测试')`), true); await evaluate(`document.querySelector('#automation-detail [data-check-now]').click()`); await wait(evaluate, `state.view==='work'&&state.currentWork?.input?.workOrderId==='WO-BROWSER'`); const manualOpened = await evaluate(`state.currentWork?.status==='accepted'||state.currentWork?.status==='running'||state.currentWork?.status==='completed'`); await wait(evaluate, `state.currentWork?.status==='completed'`); await evaluate(`document.querySelector('[data-view="works"]').click();reloadAll()`); await wait(evaluate, `state.bootstrap.works.some(item=>item.id===state.currentWork.id&&item.status==='completed')`); const manualAttentionCleared = await evaluate(`!document.querySelector('#automation-attention').innerText.includes('WO-BROWSER')`)
  const desktopOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await new Promise(resolve => setTimeout(resolve, 100)); await evaluate(`openAutomation('${ids.missedRuleId}')`); await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.missedRuleId}'`); const mobileManualVisible = await evaluate(`(()=>{const button=document.querySelector('#automation-detail [data-check-now]'),nav=document.querySelector('.mobile-nav'),rect=button?.getBoundingClientRect(),navRect=nav?.getBoundingClientRect();return Boolean(rect?.width&&rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=navRect.top)})()`); await evaluate(`openAutomation('${ids.activeRuleId}')`); await wait(evaluate, `state.automationDetail?.rule?.id==='${ids.activeRuleId}'`); const mobileRunningActionsVisible = await evaluate(`(()=>{const navTop=document.querySelector('.mobile-nav').getBoundingClientRect().top,buttons=[...document.querySelectorAll('#automation-detail [data-rule-action="pause"],#automation-detail [data-stop-automation-work]')];return buttons.length===2&&buttons.every(button=>button.getBoundingClientRect().bottom<=navTop)})()`); await evaluate(`document.querySelector('[data-rule-action="pause"]').click()`); await wait(evaluate, `state.automationDetail?.rule?.status==='paused'`); await evaluate(`document.querySelector('[data-stop-automation-work="${ids.activeWorkId}"]').click()`); await wait(evaluate, `!['accepted','running','cancel_requested'].includes(state.bootstrap.works.find(item=>item.id==='${ids.activeWorkId}')?.status)`)
  const mobileOverflow = eventMobileOverflow||await evaluate(`document.documentElement.scrollWidth>innerWidth`), stopped = await evaluate(`state.bootstrap.works.find(item=>item.id==='${ids.activeWorkId}').status==='cancelled'`)
  socket.close(); return { desktopOverflow, mobileOverflow, eventEnabled, eventCreated, eventActionVisible, eventHasNoDailyControls, eventHistoryVisible, eventUnavailableDisabled, noNewNavigation, draftPreserved, focusPreserved, revisionDraftPreserved, manualOpened, manualAttentionCleared, mobileManualVisible, mobileRunningActionsVisible, paused: true, stopped, failedRetried: failedRetryButton, unavailableRecovery, unknownNoRetry, consoleErrors, pageErrors, networkErrors }
}
async function browserTarget(port) { for (let i = 0; i < 100; i += 1) { try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find(item => item.type === 'page' && item.url.startsWith(origin)); if (target) return target } catch {} await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Chrome CDP startup timed out') }
async function wait(evaluate, expression) { for (let i = 0; i < 500; i += 1) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error(`browser condition timed out: ${expression}`) }
async function waitFor(predicate) { for (let i = 0; i < 400; i += 1) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('condition did not become true') }
async function freePort() { const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port }
