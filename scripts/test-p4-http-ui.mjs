import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createChannelService } from '../src/channel-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-p4-http-ui-'))
const statePath = join(temp, 'state.json'), authPath = join(temp, 'auth.json')
const store = createFileStore(statePath), origin = `http://127.0.0.1:${await freePort()}`
let server, browser

try {
  await store.update(seed)
  await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-owner': 'owner password', 'member-peer': 'peer password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
  const service = createWorkService({ store, runner: runner(), connectionCatalog: [catalog()] })
  const channel = createChannelService({ store, workService: service, clock: () => '2026-09-20T01:00:00.000Z' })
  const ownerActor = { id: 'member-owner' }
  const inbound = await channel.handleInbound({ channelAppId: 'app-feishu', providerEventId: 'event-origin', providerMessageId: 'message-origin', providerConversationId: 'conversation-official-owner', providerUserId: 'user-official-owner', text: '交办 工单 WO-1' })
  assert.equal(inbound.code, 'WORK_ACCEPTED')
  const work = await waitWork(service, ownerActor, inbound.workId), resultId = work.results[0].id
  const groupInbound = await channel.handleInbound({ channelAppId: 'app-feishu', providerEventId: 'event-group-origin', providerMessageId: 'message-group-origin', providerConversationId: 'group-official-owner', providerUserId: 'user-official-owner', conversationType: 'group', botMentioned: true, text: '交办 工单 WO-1' })
  assert.equal(groupInbound.code, 'WORK_ACCEPTED')
  const groupWork = await waitWork(service, ownerActor, groupInbound.workId), groupResultId = groupWork.results[0].id
  const pending = await channel.createDelivery(ownerActor, delivery('pending', work.id, resultId))
  const failed = await channel.createDelivery(ownerActor, delivery('failed', work.id, resultId)); await channel.authorizeDelivery({ deliveryId: failed.delivery.id }); await channel.recordDeliveryOutcome({ deliveryId: failed.delivery.id, status: 'failed' })
  const unknown = await channel.createDelivery(ownerActor, delivery('unknown', work.id, resultId)); await channel.authorizeDelivery({ deliveryId: unknown.delivery.id }); await channel.recordDeliveryOutcome({ deliveryId: unknown.delivery.id, status: 'unknown' })
  const blocked = await channel.createDelivery(ownerActor, delivery('blocked', work.id, resultId)); await channel.upsertChannelApp({ id: 'member-admin' }, { id: 'app-feishu', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['knowledge'], status: 'active' }); await assert.rejects(channel.authorizeDelivery({ deliveryId: blocked.delivery.id }), error => error.code === 'DELIVERY_FORBIDDEN'); await channel.upsertChannelApp({ id: 'member-admin' }, { id: 'app-feishu', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], status: 'active' })

  const auth = createAuthRuntime({ filePath: authPath }), index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const knowledge = { async listShareTargets() { return { members: [], employees: [] } }, async listMaterials() { return [] } }
  let runtimeReady = false
  server = createGenewayServer({ service, knowledge, collaborationRunner: { isKnowledgeEnabled: () => true }, channel, channelRuntimeAvailable: () => runtimeReady, store, auth, index, trustedOrigin: origin })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(origin).port, '127.0.0.1', resolve) })

  const admin = await login('admin', 'admin password'), owner = await login('owner', 'owner password'), peer = await login('peer', 'peer password')
  assert.equal((await request('/api/channels')).status, 401)
  assert.equal((await request('/api/admin/channel-apps', { cookie: peer.cookie })).status, 403)
  const adminApps = await request('/api/admin/channel-apps', { cookie: admin.cookie }), unavailableApp = adminApps.body.find(item => item.id === 'app-feishu')
  assert.equal(unavailableApp.credentialRef, 'FEISHU_SECRET_REF'); assert.equal(unavailableApp.status, 'unavailable')
  for (const session of [owner, peer]) {
    const apps = await request('/api/channels/apps', { cookie: session.cookie })
    assert.deepEqual(apps.body, [])
  }
  const configured = await request('/api/admin/channel-apps', { method: 'POST', session: admin, json: { id: 'app-configured-only', provider: 'feishu', providerAppId: 'configured-only-app', providerTenantId: 'configured-only-tenant', credentialRef: 'CONFIGURED_ONLY_REF', enabled: true, allowedScopes: ['result'] } })
  assert.equal(configured.body.status, 'unavailable')
  assert.equal((await request('/api/channels/apps', { cookie: owner.cookie })).body.some(item => item.id === 'app-configured-only'), false)
  assert.equal((await request('/api/admin/channel-apps', { method: 'POST', session: admin, json: { id: 'bad-status', provider: 'feishu', providerAppId: 'bad', providerTenantId: 'bad', credentialRef: 'BAD_STATUS_REF', enabled: true, allowedScopes: ['result'], status: 'active' } })).status, 400)
  const ownerView = await request('/api/channels', { cookie: owner.cookie }), peerView = await request('/api/channels', { cookie: peer.cookie })
  assert.equal(JSON.stringify(ownerView.body).includes('user-official-owner'), false)
  assert.equal(JSON.stringify(ownerView.body).includes('交办 工单'), false)
  assert.equal(ownerView.body.workChannels[0].workId, work.id)
  assert.deepEqual(peerView.body, { identities: [], conversations: [], deliveries: [], linkCodes: [], workChannels: [] })
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', cookie: owner.cookie, json: { channelAppId: 'app-feishu' } })).status, 403)
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', session: owner, originHeader: 'http://evil.invalid', json: { channelAppId: 'app-feishu' } })).status, 403)
  const linksBeforeUnavailable = (await store.read()).linkCodes
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', session: owner, json: { channelAppId: 'app-feishu' } })).status, 503)
  assert.deepEqual((await store.read()).linkCodes, linksBeforeUnavailable)
  const deliveriesBeforeUnavailable = (await store.read()).deliveries
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply-unavailable', workId: work.id, resultId } })).status, 503)
  assert.deepEqual((await store.read()).deliveries, deliveriesBeforeUnavailable)
  await channel.setChannelAppRuntime({ channelAppId: unavailableApp.id, revision: unavailableApp.revision, providerAppId: unavailableApp.providerAppId, providerTenantId: unavailableApp.providerTenantId, available: true })
  runtimeReady = true
  const recoveredApps = await request('/api/channels/apps', { cookie: owner.cookie })
  assert.deepEqual(Object.keys(recoveredApps.body[0]).sort(), ['id', 'provider', 'runtimeStatus']); assert.equal(recoveredApps.body[0].runtimeStatus, 'ready')
  const issued = await request('/api/channels/link-codes', { method: 'POST', session: owner, json: { channelAppId: 'app-feishu' } })
  assert.equal(issued.status, 200); assert.equal(typeof issued.body.code, 'string')
  const disk = await readFile(statePath, 'utf8'); assert.equal(disk.includes(issued.body.code), false); assert.equal(disk.includes('digest'), true)
  assert.equal((await request('/api/channels/link-codes/match', { method: 'POST', session: owner, json: {} })).status, 404)
  const conversationId = ownerView.body.conversations[0].id
  assert.equal((await request('/api/channels/identities/identity-owner', { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'DELETE', session: owner, json: {} })).status, 200)
  await store.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'connection-owner' ? { ...item, status: 'offline' } : item) }))
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'PATCH', session: owner, json: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' } })).status, 403)
  await store.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'connection-owner' ? { ...item, status: 'ready' } : item) }))
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'PATCH', session: owner, json: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' } })).status, 200)

  for (const [field, value] of Object.entries({ channelAppId: 'app-feishu', targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result', contentKey: 'result.gearjob' })) {
    const before = (await store.read()).deliveries
    assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: `forbidden-${field}`, workId: work.id, resultId, [field]: value } })).status, 400)
    assert.deepEqual((await store.read()).deliveries, before)
  }
  const beforeRecoveredReply = await store.read(), recoveredReply = await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply', workId: work.id, resultId } })
  assert.equal(recoveredReply.status, 200); assert.equal(recoveredReply.body.delivery.status, 'pending'); assert.equal(recoveredReply.body.delivery.targetConversationId, 'conversation-owner'); assert.equal(recoveredReply.body.delivery.targetIdentityId, 'identity-owner'); assert.equal((await store.read()).deliveries.length, beforeRecoveredReply.deliveries.length + 1)
  const groupConversation = (await store.read()).channelConversations.find(item => item.type === 'group' && item.providerConversationId === 'group-official-owner')
  const groupReply = await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply-group', workId: groupWork.id, resultId: groupResultId } })
  assert.equal(groupReply.status, 200); assert.equal(groupReply.body.delivery.targetConversationId, 'conversation-owner'); assert.notEqual(groupReply.body.delivery.targetConversationId, groupConversation.id); assert.equal(groupReply.body.delivery.targetIdentityId, 'identity-owner')
  const beforeUnavailable = await store.read()
  assert.equal((await request(`/api/channels/deliveries/${failed.delivery.id}/retry`, { method: 'POST', session: owner, json: {} })).status, 503)
  const afterUnavailable = await store.read()
  assert.deepEqual(afterUnavailable.deliveries, beforeUnavailable.deliveries)
  assert.equal((await request(`/api/channels/deliveries/${pending.delivery.id}`, { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/deliveries/${unknown.delivery.id}`, { method: 'DELETE', session: owner, json: {} })).status, 409)

  const browserResult = await browserJourney(work.id, pending.delivery.id)
  assert.deepEqual(browserResult, { desktopOverflow: false, mobileOverflow: false, pendingCancelled: true, workStatus: 'completed' })
  assert.equal((await request('/api/channels/identities/identity-owner', { method: 'DELETE', session: owner, json: {} })).status, 200)
  const afterUnlink = (await store.read()).deliveries
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply-unlinked', workId: work.id, resultId } })).status, 404)
  assert.deepEqual((await store.read()).deliveries, afterUnlink)
  console.log('P4 HTTP/UI checks passed', JSON.stringify(browserResult))
} finally {
  if (browser?.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)) }
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

function delivery(requestId, workId, resultId) { return { channelAppId: 'app-feishu', requestId, workId, resultId, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' } }
function seed(state) {
  const now = '2026-09-20T00:00:00.000Z', member = (id, loginName, role, employeeIds) => ({ id, loginName, displayName: loginName, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  return { ...state,
    members: [member('member-admin', 'admin', 'admin', []), member('member-owner', 'owner', 'member', ['employee-owner']), member('member-peer', 'peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '工单核对员', description: '核对工单', enabled: true, modelRouteId: 'model-1', connectionIds: ['connection-owner'], skillIds: ['skill-gearjob-work-order-read'] }],
    connections: [{ id: 'connection-owner', name: 'GearJob 外部测试', ...catalog(), allowedObjectIds: ['WO-1'], enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }],
    skills: [{ id: 'skill-gearjob-work-order-read', name: '工单查询', capabilityId: 'gearjob-work-order-read', enabled: true }],
    channelApps: [{ id: 'app-feishu', provider: 'feishu', providerAppId: 'official-app-secret-id', providerTenantId: 'official-tenant-secret-id', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-feishu', providerUserId: 'user-official-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-feishu', providerConversationId: 'conversation-official-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: { employeeId: 'employee-owner', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'connection-owner' }, createdAt: now, updatedAt: now }],
  }
}
function catalog() { return { kind: 'gearjob-rest', targetIdentity: 'gearjob-test', baseUrl: 'http://127.0.0.1/gearjob', credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'p4-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' } }
function runner() { return { configured: true, async run(args) { const source = { sourceRecordId: `Work Order:${args.input.workOrderId}`, sourceRevision: 'r1', sourceSystem: 'GearJob', sourceInstance: 'p4-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled' }; return { result: { kind: 'gearjob.work-order.observation', payload: { workOrderId: args.input.workOrderId, status: 'In Process', plannedQuantity: 10, completedQuantity: 4, unit: 'Nos', ...source }, source, toolName: 'geneway_gearjob_read_work_order', pluginId: 'geneway-gearjob-work-order', pluginVersion: '2' }, explanation: '工单事实已核对', dshSessionRef: 'session-p4-http', contextConfirmationRefs: [], eventCount: 1 } }, async cancel() {}, async close() {} } }

async function login(name, password) { return request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password } }) }
async function request(path, options = {}) { const headers = {}; if (options.originHeader) headers.origin = options.originHeader; if (options.session) { headers.origin = options.originHeader ?? origin; headers.cookie = cookiePair(options.session.cookie); headers['x-csrf-token'] = options.session.body.csrfToken } else if (options.cookie) headers.cookie = cookiePair(options.cookie); let body; if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json) } const response = await fetch(origin + path, { method: options.method ?? 'GET', headers, body }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') } }
function cookiePair(value) { return String(value).split(';', 1)[0] }

async function browserJourney(workId, pendingId) {
  const port = await freePort(), profile = join(temp, 'chrome'); await mkdir(profile, { recursive: true })
  browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', `--app=${origin}`], { stdio: 'ignore' })
  const target = await browserTarget(port), socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (!value.id) return; const entry = pending.get(value.id); pending.delete(value.id); value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.text); return value.result.value }
  await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(evaluate, `Boolean(document.querySelector('#login-name'))`); await evaluate(`document.querySelector('#login-name').value='owner';document.querySelector('#login-password').value='owner password';document.querySelector('#login-button').click()`); await wait(evaluate, `!document.querySelector('#app').classList.contains('hidden')`)
  await evaluate(`document.querySelector('[data-view="channels"]').click()`); await wait(evaluate, `document.querySelector('#view-channels').classList.contains('active')`)
  const channelText = await evaluate(`document.querySelector('#view-channels').innerText`)
  assert.match(channelText, /发送结果待核对，请勿重复发送/); assert.match(channelText, /确定未发送/); assert.equal(await evaluate(`Boolean(document.querySelector('[data-cancel-delivery="${pendingId}"]'))`), true)
  const desktopOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`)
  assert.equal(await evaluate(`!document.querySelector('[data-issue-link]').disabled&&document.querySelector('[data-issue-link]').closest('.card').innerText.includes('传输可用')`), true)
  assert.equal(await evaluate(`(()=>{const button=document.querySelector('[data-unlink]');button.focus();return document.activeElement===button&&getComputedStyle(button).outlineWidth!=='0px'})()`), true)
  assert.equal(await evaluate(`document.querySelectorAll('[data-config]').length===6&&[...document.querySelectorAll('[role="tab"]')].every(tab=>tab.hasAttribute('aria-selected')&&tab.hasAttribute('aria-controls'))&&[...document.querySelectorAll('[role="tabpanel"]')].every(panel=>panel.hasAttribute('aria-labelledby'))`), true)
  assert.equal(await evaluate(`document.querySelector('button[title="需要可信平台回查能力"]')?.disabled===true&&!document.querySelector('[data-retry-unknown]')`), true)
  assert.equal(await evaluate(`(()=>{const button=document.querySelector('[data-channel-settings]');return button?.tagName==='BUTTON'&&button.getAttribute('aria-label')==='查看当前投递的渠道设置'})()`), true)
  await evaluate(`document.querySelector('[data-channel-settings]').focus()`); await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await wait(evaluate, `document.activeElement?.id==='channel-app-app-feishu'`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await new Promise(resolve => setTimeout(resolve, 100)); const channelMobileOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`)
  assert.equal(await evaluate(`document.querySelector('.mobile-nav').scrollWidth<=document.querySelector('.mobile-nav').clientWidth`), true)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`document.querySelector('[data-cancel-delivery="${pendingId}"]').click()`); await wait(evaluate, `state.channels.deliveries.find(item=>item.id==='${pendingId}')?.status==='cancelled'`)
  await evaluate(`openWork('${workId}')`); await wait(evaluate, `document.body.innerText.includes('渠道来源与回复')&&document.querySelector('#cancel-work')?.innerText==='停止本次'`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await new Promise(resolve => setTimeout(resolve, 100))
  const mobileOverflow = channelMobileOverflow || await evaluate(`document.documentElement.scrollWidth>innerWidth`), workStatus = await evaluate(`state.currentWork.status`)
  assert.equal(await evaluate(`Boolean(document.querySelector('#view-work [data-channel-settings]'))`), true); await evaluate(`document.querySelector('#view-work [data-channel-settings]').click()`); await wait(evaluate, `state.view==='channels'&&document.activeElement?.id==='channel-app-app-feishu'`)
  socket.close()
  return { desktopOverflow, mobileOverflow, pendingCancelled: true, workStatus }
}
async function browserTarget(port) { for (let i = 0; i < 100; i += 1) { try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find(item => item.type === 'page' && item.url.startsWith(origin)); if (target) return target } catch {} await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Chrome CDP startup timed out') }
async function wait(evaluate, expression) { for (let i = 0; i < 500; i += 1) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error(`browser condition timed out: ${expression}`) }
async function freePort() { const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port }
async function waitWork(service, actor, workId) { let last; for (let i = 0; i < 200; i += 1) { last = (await service.getWork(actor, workId)).value; if (last?.status === 'completed') return last; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error(`work completion timed out: ${JSON.stringify(last)}`) }
