import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { connect, freePort, interruptHandlers, stop, systemEnvironment } from './accept-p4-s1.mjs'

let temp, statePath, authPath, store, origin, server, browser, service, conversationService, pageConnection, interruption
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--harness-check') await harnessCheck()
else if (args.length === 1 && args[0] === '--help') console.log('无参数：执行受控 loopback HTTP 和隔离 Chrome 1440×900 / 390×844 回归；实际运行须 controller 的新 GO。\n--harness-check：仅做内存夹具、键盘驱动及取消回读断言，不启动 HTTP/browser/native/model，不读取凭据。')
else { assert.equal(args.length, 0, '支持无参数、--harness-check 或 --help'); await main() }

async function main() {
  const [{ createAuthRuntime, initializeAuthFile }, { createChannelService }, { createConversationService }, { createGenewayServer }, { createFileStore }, { createWorkService }] = await Promise.all([
    import('../src/auth.mjs'), import('../src/channel-service.mjs'), import('../src/conversation-service.mjs'), import('../src/server.mjs'), import('../src/store/file-store.mjs'), import('../src/work-service.mjs'),
  ])
  temp = await mkdtemp(join(tmpdir(), 'geneway-p4-http-ui-'))
  statePath = join(temp, 'state.json'); authPath = join(temp, 'auth.json')
  store = createFileStore(statePath)
  const controlled = runner()
  let browserResult
  const signals = interruptHandlers(process, (signal, forced) => {
    interruption ??= new Error('controlled HTTP/UI run interrupted by ' + signal)
    pageConnection?.socket.close(); server?.closeAllConnections()
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
      try { process.kill(-browser.pid, forced ? 'SIGKILL' : 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') interruption = error }
    }
  })
try {
  origin = `http://127.0.0.1:${await freePort()}`
  if (interruption) throw interruption
  await store.update(seed)
  await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-owner': 'owner password', 'member-peer': 'peer password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
  if (interruption) throw interruption
  service = createWorkService({ store, runner: controlled, connectionCatalog: [] })
  conversationService = createConversationService({ store, runner: controlled, connectionCatalog: [] })
  const channel = createChannelService({ store, workService: service, conversationService, clock: () => '2026-09-20T01:00:00.000Z' })
  const ownerActor = { id: 'member-owner' }
  const association = await channel.rotateConversation(ownerActor, { identityId: 'identity-owner', employeeId: 'employee-owner' })
  const accepted = await service.createWork(ownerActor, { employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', conversationId: association.conversationId, input: { availableSeconds: 60, quantity: 2 }, clientRequestId: 'controlled-cycle' })
  assert.equal(accepted.ok, true)
  const work = await waitWork(service, ownerActor, accepted.value.id), resultId = work.results[0].id
  const pending = await channel.createDelivery(ownerActor, delivery('pending', work.id, resultId))
  const failed = await channel.createDelivery(ownerActor, delivery('failed', work.id, resultId)); await channel.authorizeDelivery({ deliveryId: failed.delivery.id }); await channel.recordDeliveryOutcome({ deliveryId: failed.delivery.id, status: 'failed' })
  const unknown = await channel.createDelivery(ownerActor, delivery('unknown', work.id, resultId)); await channel.authorizeDelivery({ deliveryId: unknown.delivery.id }); await channel.recordDeliveryOutcome({ deliveryId: unknown.delivery.id, status: 'unknown' })
  const blocked = await channel.createDelivery(ownerActor, delivery('blocked', work.id, resultId)); await channel.upsertChannelApp({ id: 'member-admin' }, { id: 'app-feishu', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['knowledge'], status: 'active' }); await assert.rejects(channel.authorizeDelivery({ deliveryId: blocked.delivery.id }), error => error.code === 'DELIVERY_FORBIDDEN'); await channel.upsertChannelApp({ id: 'member-admin' }, { id: 'app-feishu', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], status: 'active' })

  const auth = createAuthRuntime({ filePath: authPath }), index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const knowledge = { async listShareTargets() { return { members: [], employees: [] } }, async listMaterials() { return [] } }
  const readyApps = new Set()
  const channelRuntime = {
    isAvailable: id => readyApps.has(id),
    async sync() {},
    async sendDelivery(id, { retry = false } = {}) {
      if (retry) throw Object.assign(new Error('controlled unavailable runtime'), { code: 'UNAVAILABLE', status: 503 })
      return (await store.read()).deliveries.find(item => item.id === id)
    },
  }
  server = createGenewayServer({ service, conversationService, knowledge, collaborationRunner: { isKnowledgeEnabled: () => true }, channel, channelRuntime, store, auth, index, trustedOrigin: origin })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(origin).port, '127.0.0.1', resolve) })

  const admin = await login('admin', 'admin password'), owner = await login('owner', 'owner password'), peer = await login('peer', 'peer password')
  assert.equal((await request('/api/channels')).status, 401)
  assert.equal((await request('/api/admin/channel-apps', { cookie: peer.cookie })).status, 403)
  const adminApps = await request('/api/admin/channel-apps', { cookie: admin.cookie }), unavailableApp = adminApps.body.find(item => item.id === 'app-feishu')
  assert.equal(unavailableApp.credentialRef, 'FEISHU_SECRET_REF'); assert.equal(unavailableApp.status, 'unavailable')
  const ownerApps = await request('/api/channels/apps', { cookie: owner.cookie }), peerApps = await request('/api/channels/apps', { cookie: peer.cookie })
  assert.equal(ownerApps.status, 200); assert.deepEqual(ownerApps.body, [{ id: 'app-feishu', provider: 'feishu', enabled: true, status: 'unavailable', runtimeStatus: 'unavailable' }])
  assert.equal(peerApps.status, 200); assert.deepEqual(peerApps.body, [])
  const configured = await request('/api/admin/channel-apps', { method: 'POST', session: admin, json: { id: 'app-configured-only', provider: 'feishu', providerAppId: 'configured-only-app', providerTenantId: 'configured-only-tenant', credentialRef: 'CONFIGURED_ONLY_REF', enabled: true, allowedScopes: ['result'] } })
  assert.equal(configured.body.status, 'unavailable')
  assert.equal((await request('/api/channels/apps', { cookie: owner.cookie })).body.some(item => item.id === 'app-configured-only'), false)
  assert.equal((await request('/api/admin/channel-apps', { method: 'POST', session: admin, json: { id: 'bad-status', provider: 'feishu', providerAppId: 'bad', providerTenantId: 'bad', credentialRef: 'BAD_STATUS_REF', enabled: true, allowedScopes: ['result'], status: 'active' } })).status, 400)
  const ownerView = await request('/api/channels', { cookie: owner.cookie }), peerView = await request('/api/channels', { cookie: peer.cookie })
  assert.equal(JSON.stringify(ownerView.body).includes('user-official-owner'), false)
  assert.equal(JSON.stringify(ownerView.body).includes('交办 工单'), false)
  assert.equal(ownerView.body.workChannels[0].workId, work.id)
  assert.deepEqual(peerView.body, { defaultChannelEmployeeId: null, identities: [], conversations: [], deliveries: [], linkCodes: [], workChannels: [] })
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', cookie: owner.cookie, json: { channelAppId: 'app-feishu' } })).status, 403)
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', session: owner, originHeader: 'http://evil.invalid', json: { channelAppId: 'app-feishu' } })).status, 403)
  const linksBeforeUnavailable = (await store.read()).linkCodes
  assert.equal((await request('/api/channels/link-codes', { method: 'POST', session: owner, json: { channelAppId: 'app-feishu' } })).status, 503)
  assert.deepEqual((await store.read()).linkCodes, linksBeforeUnavailable)
  const deliveriesBeforeUnavailable = (await store.read()).deliveries
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply-unavailable', workId: work.id, resultId } })).status, 503)
  assert.deepEqual((await store.read()).deliveries, deliveriesBeforeUnavailable)
  await channel.setChannelAppRuntime({ channelAppId: unavailableApp.id, revision: unavailableApp.revision, providerAppId: unavailableApp.providerAppId, providerTenantId: unavailableApp.providerTenantId, available: true })
  readyApps.add(unavailableApp.id)
  const recoveredApps = await request('/api/channels/apps', { cookie: owner.cookie })
  assert.equal(recoveredApps.status, 200); assert.deepEqual(recoveredApps.body, [{ id: 'app-feishu', provider: 'feishu', enabled: true, status: 'active', runtimeStatus: 'ready' }])
  const issued = await request('/api/channels/link-codes', { method: 'POST', session: owner, json: { channelAppId: 'app-feishu' } })
  assert.equal(issued.status, 200); assert.equal(typeof issued.body.code, 'string')
  const disk = await readFile(statePath, 'utf8'); assert.equal(disk.includes(issued.body.code), false); assert.equal(disk.includes('digest'), true)
  assert.equal((await request('/api/channels/link-codes/match', { method: 'POST', session: owner, json: {} })).status, 404)
  const conversationId = ownerView.body.conversations[0].id
  assert.equal((await request('/api/channels/identities/identity-owner', { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'DELETE', session: owner, json: {} })).status, 200)
  const beforeRetiredDispatch = await store.read()
  const retiredDispatch = await request(`/api/channels/conversations/${conversationId}/default-dispatch`, { method: 'PATCH', session: owner, json: { employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate' } })
  assert.equal(retiredDispatch.status, 409); assert.equal(retiredDispatch.body.error.code, 'SOURCE_RETIRED')
  assert.deepEqual(await store.read(), beforeRetiredDispatch)

  for (const [field, value] of Object.entries({ channelAppId: 'app-feishu', targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result', contentKey: 'result.gearjob' })) {
    const before = (await store.read()).deliveries
    assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: `forbidden-${field}`, workId: work.id, resultId, [field]: value } })).status, 400)
    assert.deepEqual((await store.read()).deliveries, before)
  }
  const beforeRecoveredReply = await store.read(), recoveredReply = await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply', workId: work.id, resultId } })
  assert.equal(recoveredReply.status, 200); assert.equal(recoveredReply.body.delivery.status, 'pending'); assert.equal(recoveredReply.body.delivery.targetConversationId, 'conversation-owner'); assert.equal(recoveredReply.body.delivery.targetIdentityId, 'identity-owner'); assert.equal((await store.read()).deliveries.length, beforeRecoveredReply.deliveries.length + 1)
  const beforeUnavailable = await store.read()
  assert.equal((await request(`/api/channels/deliveries/${failed.delivery.id}/retry`, { method: 'POST', session: owner, json: {} })).status, 503)
  const afterUnavailable = await store.read()
  assert.deepEqual(afterUnavailable.deliveries, beforeUnavailable.deliveries)
  assert.equal((await request(`/api/channels/deliveries/${pending.delivery.id}`, { method: 'DELETE', session: peer, json: {} })).status, 404)
  assert.equal((await request(`/api/channels/deliveries/${unknown.delivery.id}`, { method: 'DELETE', session: owner, json: {} })).status, 409)

  const beforeBrowser = await store.read(), runnerCalls = controlled.calls
  browserResult = await browserJourney(work.id, pending.delivery.id, blocked.delivery.id, owner)
  assert.deepEqual(browserResult, { desktopOverflow: false, mobileOverflow: false, keyboardSettingsFocus: true, pendingCancelled: true, workStatus: 'completed' })
  assertDeliveryCancellation(beforeBrowser, await store.read(), pending.delivery.id, work.id)
  assert.equal(controlled.calls, runnerCalls, 'delivery cancellation must not rerun business work')
  assert.equal(controlled.cancelCalls, 0, 'delivery cancellation must not call the work runner cancellation')
  assert.equal((await request('/api/channels/identities/identity-owner', { method: 'DELETE', session: owner, json: {} })).status, 200)
  const afterUnlink = (await store.read()).deliveries
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: owner, json: { requestId: 'web-reply-unlinked', workId: work.id, resultId } })).status, 404)
  assert.deepEqual((await store.read()).deliveries, afterUnlink)
} finally {
  const closed = await Promise.allSettled([stop(browser), conversationService?.close(), service?.close(), server?.listening ? new Promise(resolve => server.close(resolve)) : undefined])
  try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } finally { signals.dispose() }
  if (interruption) throw interruption
  const failures = closed.filter(item => item.status === 'rejected').map(item => item.reason)
  if (failures.length) throw new AggregateError(failures, 'controlled HTTP/UI cleanup failed')
}
  console.log('P4 HTTP/UI checks passed (controlled cycle runner and simulated channel transport; actual isolated Chrome, no native/model/provider calls)', JSON.stringify(browserResult))
}

function delivery(requestId, workId, resultId) { return { channelAppId: 'app-feishu', requestId, workId, resultId, targetIdentityId: 'identity-owner', targetConversationId: 'conversation-owner', contentScope: 'result' } }
function seed(state) {
  const now = '2026-09-20T00:00:00.000Z', member = (id, loginName, role, employeeIds) => ({ id, loginName, displayName: loginName, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now })
  return { ...state,
    members: [member('member-admin', 'admin', 'admin', []), member('member-owner', 'owner', 'member', ['employee-owner']), member('member-peer', 'peer', 'member', [])],
    modelRoutes: [{ id: 'model-1', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: 'ZenMux', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    employees: [{ id: 'employee-owner', name: '节拍核对员', description: '受控节拍计算', instructions: '', revision: 1, enabled: true, modelRouteId: 'model-1', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] }],
    connections: [],
    skills: [{ id: 'skill-cycle-time-calculate', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }],
    channelApps: [{ id: 'app-feishu', provider: 'feishu', providerAppId: 'official-app-secret-id', providerTenantId: 'official-tenant-secret-id', credentialRef: 'FEISHU_SECRET_REF', enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now }],
    channelIdentities: [{ id: 'identity-owner', channelAppId: 'app-feishu', providerUserId: 'user-official-owner', memberId: 'member-owner', verificationMethod: 'link-code', status: 'active', revision: 1, defaultEmployeeId: null, activeConversationId: null, createdAt: now, updatedAt: now }],
    channelConversations: [{ id: 'conversation-owner', channelAppId: 'app-feishu', providerConversationId: 'conversation-official-owner', identityId: 'identity-owner', memberId: 'member-owner', type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, defaultDispatch: null, createdAt: now, updatedAt: now }],
  }
}
function runner() { return { configured: true, calls: 0, cancelCalls: 0,
  async run(args) { assert.equal(args.capabilityId, 'cycle-time-calculate', 'retired sources must never execute'); this.calls += 1; return { result: { kind: 'manufacturing.takt', payload: { ...args.input, secondsPerUnit: args.input.availableSeconds / args.input.quantity, unit: 'seconds/unit' }, toolName: 'geneway_calculate_cycle_time', pluginId: 'geneway-cycle-time', pluginVersion: '2' }, explanation: '受控节拍结果', dshSessionRef: `controlled-cycle-${args.executionId}`, continuity: 'new', contextConfirmationRefs: [], eventCount: 1 } },
  async cancel() { this.cancelCalls += 1 }, async close() {},
  async readChatHistory(ids) { assert.deepEqual(ids, [], 'this regression never creates native chat history'); return [] },
  async runChatTurn() { assert.fail('this regression must not start native chat or a model') },
} }

async function login(name, password) { return request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password } }) }
async function request(path, options = {}) { if (interruption) throw interruption; const headers = {}; if (options.originHeader) headers.origin = options.originHeader; if (options.session) { headers.origin = options.originHeader ?? origin; headers.cookie = cookiePair(options.session.cookie); headers['x-csrf-token'] = options.session.body.csrfToken } else if (options.cookie) headers.cookie = cookiePair(options.cookie); let body; if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json) } const response = await fetch(origin + path, { method: options.method ?? 'GET', headers, body }); const text = await response.text(); if (interruption) throw interruption; return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') } }
function cookiePair(value) { return String(value).split(';', 1)[0] }

async function browserJourney(workId, pendingId, blockedId, owner) {
  const port = await freePort(), profile = join(temp, 'chrome'); await mkdir(profile, { recursive: true })
  if (interruption) throw interruption
  browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', `--app=${origin}`], { detached: true, env: systemEnvironment(), stdio: 'ignore' })
  browser.on('error', error => { browser.startupError = error })
  const page = pageConnection = await connect(await browserTarget(port), () => false)
  const { evaluate } = page, settings = `#view-channels [data-delivery="${blockedId}"] [data-channel-settings]`
  try {
    await page.viewport(1440, 900)
    await page.wait(`Boolean(document.querySelector('#login-name'))`)
    await page.fill('#login-name', 'owner'); await page.fill('#login-password', 'owner password'); await page.click('#login-button')
    await page.wait(`!document.querySelector('#app').classList.contains('hidden')`)
    await page.nav('channels'); await page.wait(`Boolean(document.querySelector(${JSON.stringify(settings)}))`)
    const channelText = await evaluate(`document.querySelector('#view-channels').innerText`)
    assert.match(channelText, /发送结果待核对，不会盲目重发/); assert.match(channelText, /未确认部分发送失败，可明确重试/)
    assert.equal(await evaluate(`Boolean(document.querySelector('#view-channels [data-cancel-delivery="${pendingId}"]'))`), true)
    await page.noOverflow()
    assert.equal(await evaluate(`Boolean(document.querySelector('#channel-app-app-feishu > .record-title .pill.ready'))`), true)
    assert.equal(await evaluate(`document.querySelectorAll('[data-config]').length===6&&[...document.querySelectorAll('[role="tab"]')].every(tab=>tab.hasAttribute('aria-selected')&&tab.hasAttribute('aria-controls'))&&[...document.querySelectorAll('[role="tabpanel"]')].every(panel=>panel.hasAttribute('aria-labelledby'))`), true)
    assert.equal(await evaluate(`(()=>{const unknown=[...document.querySelectorAll('#view-channels [data-delivery]')].find(node=>node.innerText.includes('发送结果待核对'));return !!unknown&&!unknown.querySelector('[data-retry-delivery]')})()`), true)
    assert.equal(await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(settings)});return button?.tagName==='BUTTON'&&button.textContent.trim()==='查看我的渠道'})()`), true)
    await tabTo(page, settings); await assertFocusOutline(page, settings)
    await key(page, 'Enter', 13)
    await page.wait(`document.activeElement?.id==='channel-app-app-feishu'`)
    await assertFocusOutline(page, '#channel-app-app-feishu')
    await tabTo(page, '#view-channels [data-unlink="identity-owner"]')
    await assertFocusOutline(page, '#view-channels [data-unlink="identity-owner"]')
    await page.viewport(390, 844); await page.noOverflow()
    assert.equal(await evaluate(`document.querySelector('.mobile-nav').scrollWidth<=document.querySelector('.mobile-nav').clientWidth`), true)
    await page.viewport(1440, 900)
    await page.click(`#view-channels [data-cancel-delivery="${pendingId}"]`)
    await page.wait(`document.querySelector('#channel-message').textContent.includes('待发回复已取消，业务状态没有改变')`)
    const channels = await request('/api/channels', { cookie: owner.cookie })
    assert.equal(channels.status, 200)
    const pendingCancelled = channels.body.deliveries.find(item => item.id === pendingId)?.status === 'cancelled'
    assert.equal(pendingCancelled, true)
    await page.nav('works'); await page.click(`#all-work-cards [data-open-work="${workId}"]`)
    await page.wait(`document.querySelector('#view-work').classList.contains('active')&&document.querySelector('#cancel-work')?.textContent==='停止本次'`)
    assert.match(await evaluate(`document.querySelector('#view-work').innerText`), /渠道来源与回复/)
    assert.equal(await evaluate(`document.querySelector('#cancel-work').disabled`), true)
    await page.noOverflow(); await page.viewport(390, 844); await page.noOverflow()
    await page.click(`#view-work [data-delivery="${blockedId}"] [data-channel-settings]`)
    await page.wait(`document.querySelector('#view-channels').classList.contains('active')&&document.activeElement?.id==='channel-app-app-feishu'`)
    await assertFocusOutline(page, '#channel-app-app-feishu'); await page.noOverflow()
    const currentWork = await request(`/api/works/${workId}`, { cookie: owner.cookie })
    assert.equal(currentWork.status, 200); assert.deepEqual(page.errors, [])
    return { desktopOverflow: false, mobileOverflow: false, keyboardSettingsFocus: true, pendingCancelled, workStatus: currentWork.body.status }
  } finally { page.socket.close(); pageConnection = undefined }
}
async function key(page, name, code) {
  const event = { key: name, code: name, windowsVirtualKeyCode: code }
  await page.send('Input.dispatchKeyEvent', { ...event, type: name === 'Enter' ? 'rawKeyDown' : 'keyDown' })
  if (name === 'Enter') await page.send('Input.dispatchKeyEvent', { ...event, type: 'char', text: '\r', unmodifiedText: '\r' })
  await page.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
}
async function tabTo(page, selector, maxTabs = 80) {
  assert.equal(await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), true, 'keyboard target is missing')
  for (let count = 0; count <= maxTabs; count += 1) {
    if (await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return count
    if (count < maxTabs) await key(page, 'Tab', 9)
  }
  assert.fail('keyboard target was not reached by Tab')
}
async function assertFocusOutline(page, selector) { assert.equal(await page.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return document.activeElement===node&&parseFloat(getComputedStyle(node).outlineWidth)>0})()`), true, 'actual focused control needs a visible outline') }
function assertDeliveryCancellation(before, after, deliveryId, workId) {
  assert.equal(before.deliveries.find(item => item.id === deliveryId)?.status, 'pending')
  assert.equal(after.deliveries.find(item => item.id === deliveryId)?.status, 'cancelled')
  assert.equal(after.works.find(item => item.id === workId)?.status, 'completed')
  assert.deepEqual(after.works, before.works, 'cancelling a pending delivery must leave all business work unchanged')
}
async function browserTarget(port) { for (let i = 0; i < 100; i += 1) { if (interruption) throw interruption; if (browser.startupError) throw browser.startupError; assert.equal(browser.exitCode, null, 'isolated Chrome exited during startup'); assert.equal(browser.signalCode, null, 'isolated Chrome was signalled during startup'); try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find(item => item.type === 'page' && item.url.startsWith(origin)); if (target) return target } catch {} await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Chrome CDP startup timed out') }
async function waitWork(service, actor, workId) { for (let i = 0; i < 200; i += 1) { const last = await service.getWork(actor, workId); assert.equal(last.ok, true); if (last.value.status === 'completed') return last.value; assert(!['failed', 'cancelled', 'interrupted'].includes(last.value.status), 'controlled cycle fixture did not complete'); await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('controlled cycle fixture completion timed out') }

async function harnessCheck() {
  const { migrateState, STATE_VERSION } = await import('../src/store/file-store.mjs')
  const fixture = migrateState(seed({ version: STATE_VERSION, works: [], confirmations: [], knowledgeMaterials: [], channelMessages: [], deliveries: [], linkCodes: [], automationRules: [], automationOccurrences: [], automationInbox: [], conversations: [], reservations: {}, defaultChannelEmployeeId: null }))
  assert.deepEqual(fixture.connections, []); assert.deepEqual(fixture.skills.map(item => item.capabilityId), ['cycle-time-calculate'])
  assert.equal(fixture.channelConversations[0].defaultDispatch, null)
  const controlled = runner(), outcome = await controlled.run({ capabilityId: 'cycle-time-calculate', executionId: 'pure', input: { availableSeconds: 60, quantity: 2 } })
  assert.equal(outcome.result.payload.secondsPerUnit, 30)
  await assert.rejects(controlled.run({ capabilityId: 'gearjob-work-order-read' }), /retired sources/)
  await assert.rejects(controlled.runChatTurn(), /must not start/)
  const [{ createWorkService }, { createChannelService }, { createConversationService }] = await Promise.all([import('../src/work-service.mjs'), import('../src/channel-service.mjs'), import('../src/conversation-service.mjs')])
  let state = fixture
  const memory = { async read() { return structuredClone(state) }, async update(mutator) { state = migrateState(await mutator(structuredClone(state))); return structuredClone(state) } }
  const workService = createWorkService({ store: memory, runner: controlled, connectionCatalog: [] })
  const conversation = createConversationService({ store: memory, runner: controlled, connectionCatalog: [] })
  const channel = createChannelService({ store: memory, workService, conversationService: conversation }), owner = { id: 'member-owner' }
  try {
    const association = await channel.rotateConversation(owner, { identityId: 'identity-owner', employeeId: 'employee-owner' })
    const accepted = await workService.createWork(owner, { employeeId: 'employee-owner', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', conversationId: association.conversationId, input: { availableSeconds: 60, quantity: 2 }, clientRequestId: 'pure-cycle' })
    assert.equal(accepted.ok, true)
    const work = await waitWork(workService, owner, accepted.value.id)
    assert.equal((await channel.memberChannelState(owner)).workChannels[0].workId, work.id)
    const pending = await channel.createDelivery(owner, delivery('pure-pending', work.id, work.results[0].id)), baseline = await memory.read()
    await channel.cancelDelivery(owner, { deliveryId: pending.delivery.id })
    assertDeliveryCancellation(baseline, await memory.read(), pending.delivery.id, work.id)
    assert.equal(controlled.cancelCalls, 0)
  } finally { await conversation.close(); await workService.close() }
  const events = []; let tabs = 0
  const page = { async evaluate(expression) { return expression.startsWith('Boolean(') || tabs === 3 }, async send(method, params) { assert.equal(method, 'Input.dispatchKeyEvent'); events.push(params); if (params.type === 'keyUp' && params.key === 'Tab') tabs += 1 } }
  assert.equal(await tabTo(page, '#synthetic-control', 4), 3)
  await key(page, 'Enter', 13)
  assert.deepEqual(events.map(item => [item.type, item.key]), [...Array.from({ length: 3 }, () => [['keyDown', 'Tab'], ['keyUp', 'Tab']]).flat(), ['rawKeyDown', 'Enter'], ['char', 'Enter'], ['keyUp', 'Enter']])
  assert.equal(events.at(-2).text, '\r'); assert.equal(events.at(-2).unmodifiedText, '\r')
  await assert.rejects(tabTo({ evaluate: async expression => expression.startsWith('Boolean('), send: async () => {} }, '#never-focused', 2), /not reached by Tab/)
  await assert.rejects(tabTo({ evaluate: async () => false }, '#missing'), /target is missing/)
  const before = { works: [{ id: 'work', status: 'completed', results: [{ id: 'result' }], executions: [{ id: 'execution', status: 'completed' }] }], deliveries: [{ id: 'delivery', status: 'pending' }] }
  const after = structuredClone(before); after.deliveries[0].status = 'cancelled'
  assertDeliveryCancellation(before, after, 'delivery', 'work')
  for (const field of ['status', 'results', 'executions']) {
    const changed = structuredClone(after); changed.works[0][field] = field === 'status' ? 'cancelled' : []
    assert.throws(() => assertDeliveryCancellation(before, changed, 'delivery', 'work'))
  }
  assert.throws(() => assertDeliveryCancellation(before, before, 'delivery', 'work'))
  const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  new Script(index.match(/<script>([\s\S]*?)<\/script>/)[1])
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', checked: ['cycle-fixture-schema', 'controlled-cycle-and-channel-association', 'Tab/Enter-CDP-events', 'missing-or-unreachable-focus-rejected', 'delivery-cancel-work-unchanged', 'actual-Web-syntax'], skipped: ['HTTP routes and permissions', 'real Chrome 1440x900/390x844 keyboard and geometry', 'native SDK', 'model', 'provider transport'], startedProcesses: 0, listeningServers: 0, secretReads: 0 }))
}
