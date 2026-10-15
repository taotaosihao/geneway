import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script, createContext, runInContext } from 'node:vm'
import QRCode from 'qrcode'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { ChannelServiceError, createChannelService } from '../src/channel-service.mjs'
import { createChannelRuntime, createGenewayServer } from '../src/server.mjs'

const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), script = index.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const temp = await mkdtemp(join(tmpdir(), 'geneway-channel-ui-')), calls = [], now = new Date().toISOString(), expiresAt = new Date(Date.now() + 300_000).toISOString()
const identity = { id: 'identity-a', memberId: 'a', channelAppId: 'wx', providerUserId: 'private-owner-1234', status: 'active', defaultEmployeeId: null, activeConversationId: 'current-conversation', weixin: { botId: 'must-not-leak-bot', tokenRef: 'must-not-leak-token-ref', runtimeState: 'connected' }, updatedAt: now }
const link = { id: 'link-a', kind: 'weixin-qr', memberId: 'a', channelAppId: 'wx', status: 'active', expiresAt, qrcodeUrl: 'https://ilinkai.weixin.qq.com/scan/actual-runtime-challenge', digest: 'must-not-leak-digest', loginRef: 'must-not-leak-login-ref', tokenRef: 'must-not-leak-token-ref', updatedAt: now }
const delivery = { id: 'delivery-a', channelAppId: 'wx', targetIdentityId: identity.id, targetConversationId: 'endpoint-a', sourceRef: { kind: 'conversation-turn', conversationId: 'old-conversation', turnId: 'old-turn' }, status: 'unknown', attempts: 1, sendProgress: { totalParts: 3, acknowledgedParts: [{ index: 0, clientId: 'must-not-leak-client-id' }] }, createdAt: now, updatedAt: now }
const members = ['a', 'b', 'admin'].map(id => ({ id, authRef: id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, employeeIds: id === 'a' ? ['agent-a', 'agent-b'] : [], sessionVersion: 1 }))
let server, origin, defaultEmployeeId = 'agent-a'
const store = { async read() { return { members, channelApps: [{ id: 'wx', provider: 'weixin' }, { id: 'fs', provider: 'feishu' }], deliveries: [delivery] } } }
const retiredChannel = createChannelService({ store: { ...store, async update() { assert.fail('retired default dispatch must not write state') } } })
const stateFor = actor => ({ defaultChannelEmployeeId: defaultEmployeeId, identities: actor.id === 'a' ? [identity] : [], conversations: actor.id === 'a' ? [{ id: 'endpoint-a', identityId: identity.id, channelAppId: 'wx', type: 'private', status: 'active', providerConversationId: 'private-endpoint-9876' }] : [], messages: [], deliveries: actor.id === 'a' ? [delivery] : [], linkCodes: actor.id === 'a' ? [link] : [], workChannels: [] })
const own = actor => { if (actor.id !== 'a') throw new ChannelServiceError('NOT_FOUND', '本人渠道身份不存在') }
const admin = actor => { if (actor.role !== 'admin') throw new ChannelServiceError('FORBIDDEN', '需要管理员权限') }
const channel = {
  async memberChannelState(actor) { return structuredClone(stateFor(actor)) },
  async listChannelApps() { return [{ id: 'wx', provider: 'weixin', enabled: true, status: 'active', credentialRef: 'must-not-leak-app-ref' }, { id: 'fs', provider: 'feishu', enabled: false, status: 'disabled', credentialRef: 'must-not-leak-app-ref' }] },
  async getChannelDefaults(actor) { admin(actor); return { defaultChannelEmployeeId: defaultEmployeeId } },
  async setChannelDefaults(actor, body) { admin(actor); if (body.defaultChannelEmployeeId !== null && !['agent-a', 'agent-b'].includes(body.defaultChannelEmployeeId)) throw new ChannelServiceError('INVALID_REQUEST', '员工无效'); defaultEmployeeId = body.defaultChannelEmployeeId; return { defaultChannelEmployeeId: defaultEmployeeId } },
  async confirmLink(actor, body) { own(actor); calls.push(['confirm', structuredClone(body)]); return { ...link, status: 'consumed' } },
  async rotateConversation(actor, body) { own(actor); calls.push(['rotate', structuredClone(body)]); return { identityId: identity.id, conversationId: 'new-conversation', employeeId: body.employeeId ?? defaultEmployeeId } },
  async createConversationDelivery(actor, body) { own(actor); calls.push(['reply', structuredClone(body)]); return { delivery: { ...delivery, status: 'pending' }, deduplicated: false } },
  async createWorkDelivery(actor, body) { own(actor); calls.push(['work-reply', structuredClone(body)]); return { delivery: { ...delivery, status: 'pending' }, deduplicated: false } },
  async cancelDelivery(actor) { own(actor); return { ...delivery, status: 'cancelled' } },
  async unlinkIdentity(actor) { own(actor); return { ...identity, status: 'unlinked', activeConversationId: null } },
  setDefaultDispatch: retiredChannel.setDefaultDispatch,
}
const runtime = { isAvailable: id => id === 'wx', async sendDelivery(id, options) { if (options?.retry && delivery.status === 'unknown') throw new ChannelServiceError('INVALID_STATE', '发送效果待核对，不能直接重试'); calls.push(['send', id]); return { ...delivery, status: 'delivered', sendProgress: { ...delivery.sendProgress, acknowledgedParts: Array.from({ length: 3 }, (_, index) => ({ index, clientId: 'private' })) } } } }
const weixinRuntime = { async beginBinding(actor, body) { own(actor); calls.push(['begin', structuredClone(body)]); return link }, async cancelBinding(actor, body) { own(actor); calls.push(['cancel-binding', structuredClone(body)]); return { ...link, status: 'cancelled' } } }
try {
  await checkUi()
  await checkRuntime()
  const authFile = join(temp, 'auth.json')
  await initializeAuthFile(authFile, Object.fromEntries(members.map(item => [item.id, item.id + ' synthetic password'])))
  const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service: {}, channel, channelRuntime: runtime, weixinRuntime, store, auth: createAuthRuntime({ filePath: authFile }), index, trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const a = await login('a'), b = await login('b'), root = await login('admin')
  const beforeRetiredDispatch = structuredClone({ store: await store.read(), channelState: stateFor({ id: 'a' }), calls })
  const retiredDispatch = await request('/api/channels/conversations/endpoint-a/default-dispatch', { method: 'PATCH', session: a, json: { employeeId: 'agent-a', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'legacy-connection' } })
  assert.equal(retiredDispatch.status, 409, 'retired default-dispatch response: ' + JSON.stringify(retiredDispatch.body))
  assert.equal(retiredDispatch.body.error.code, 'SOURCE_RETIRED')
  assert.deepEqual({ store: await store.read(), channelState: stateFor({ id: 'a' }), calls }, beforeRetiredDispatch, 'retired default dispatch preserves all fixture state')
  const state = await request('/api/channels', { session: a })
  assert.equal(state.status, 200); assert.equal(state.body.defaultChannelEmployeeId, 'agent-a'); assert.equal(state.body.identities[0].externalIdentity, '…1234'); assert.equal(state.body.identities[0].activeConversationId, identity.activeConversationId)
  assert.deepEqual(state.body.deliveries[0].progress, { acknowledgedParts: 1, totalParts: 3 })
  assert.doesNotMatch(JSON.stringify(state.body), /must-not-leak|private-owner|private-endpoint/)
  for (const session of [b, root]) { const result = await request('/api/channels', { session }); assert.deepEqual(result.body.identities, []); assert.deepEqual(result.body.deliveries, []); assert.deepEqual(result.body.linkCodes, []) }
  const apps = (await request('/api/channels/apps', { session: a })).body
  assert.equal(apps.length, 2, 'disabled/history app metadata must remain visible'); assert.equal(apps[1].runtimeStatus, 'unavailable'); assert.equal(apps[1].credentialRef, undefined)
  assert.equal((await request('/api/admin/channel-defaults', { session: a })).status, 403)
  assert.equal((await request('/api/admin/channel-defaults', { method: 'PATCH', session: root, json: { defaultChannelEmployeeId: null } })).body.defaultChannelEmployeeId, null)
  assert.equal((await request('/api/admin/channel-defaults', { session: root })).body.defaultChannelEmployeeId, null)
  assert.equal((await request('/api/admin/channel-defaults', { method: 'PATCH', session: root, json: { defaultChannelEmployeeId: 'agent-b', ownerMemberId: 'a' } })).status, 400)
  const begin = await request('/api/channels/weixin/bindings', { method: 'POST', session: a, json: { channelAppId: 'wx' } })
  assert.equal(begin.status, 201); assert.equal(begin.body.qrcodeUrl, link.qrcodeUrl); assert.doesNotMatch(JSON.stringify(begin.body), /must-not-leak/)
  for (const session of [b, root]) assert.equal((await request('/api/channels/weixin/bindings/link-a/qr', { session })).status, 404)
  const qr = await request('/api/channels/weixin/bindings/link-a/qr', { session: a })
  assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type'), /image\/svg\+xml/); assert.equal(qr.headers.get('cache-control'), 'no-store'); assert.equal(qr.body, await QRCode.toString(link.qrcodeUrl, { type: 'svg' }))
  assert.equal((await request('/api/channels/weixin/bindings/link-a/qr?value=forbidden', { session: a })).status, 400)
  const originalStatus = link.status; link.status = 'cancelled'; assert.equal((await request('/api/channels/weixin/bindings/link-a/qr', { session: a })).status, 404); link.status = originalStatus
  for (const json of [{ channelAppId: 'wx', ownerMemberId: 'b' }, { token: 'forbidden' }]) assert.equal((await request('/api/channels/weixin/bindings', { method: 'POST', session: a, json })).status, 400)
  assert.equal((await request('/api/channels/weixin/bindings', { method: 'POST', session: a, csrf: '', json: {} })).status, 403)
  assert.equal((await request('/api/channels/weixin/bindings', { method: 'POST', session: a, originHeader: 'http://evil.invalid', json: {} })).status, 403)
  assert.equal((await request('/api/channels/link-codes/link-a/confirm', { method: 'POST', session: a, json: { employeeId: null } })).body.status, 'consumed')
  assert.deepEqual(calls.find(item => item[0] === 'confirm')[1], { linkCodeId: 'link-a', employeeId: null })
  assert.equal((await request('/api/channels/identities/identity-a/conversations', { method: 'POST', session: a, json: { employeeId: 'agent-b' } })).body.employeeId, 'agent-b')
  assert.equal((await request('/api/channels/identities/identity-a/conversations', { method: 'POST', session: b, json: {} })).status, 404)
  assert.equal((await request('/api/channels/identities/identity-a/conversations', { method: 'POST', session: a, json: { nativeSessionId: 'forbidden' } })).status, 400)
  const reply = { identityId: identity.id, conversationId: 'old-conversation', turnId: 'old-turn', requestId: 'explicit-reply' }
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: a, json: reply })).body.delivery.status, 'delivered')
  assert.equal(identity.activeConversationId, 'current-conversation', 'replying to old history must not reactivate its pointer')
  for (const json of [{ ...reply, text: 'forbidden arbitrary text' }, { ...reply, workId: 'mixed-source' }, { ...reply, nativeSessionId: 'forbidden' }]) assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: a, json })).status, 400)
  assert.equal((await request('/api/channels/deliveries', { method: 'POST', session: root, json: reply })).status, 404)
  const sends = calls.filter(item => item[0] === 'send').length
  assert.equal((await request('/api/channels/deliveries/delivery-a/retry', { method: 'POST', session: a, json: {} })).status, 409)
  assert.equal(calls.filter(item => item[0] === 'send').length, sends)
  assert.equal((await request('/api/channels/deliveries/delivery-a', { method: 'DELETE', session: a, json: {} })).body.status, 'cancelled')
  assert.equal((await request('/api/channels/weixin/bindings/link-a', { method: 'DELETE', session: a, json: {} })).body.status, 'cancelled')
  assert.doesNotMatch(JSON.stringify((await request('/api/channels/identities/identity-a', { method: 'DELETE', session: a, json: {} })).body), /must-not-leak|private-owner/)
  console.log('Channel UI/API checks passed: actual routes/auth/CSRF/strict references/private SVG QR/projections and actual Web helpers; injected service/transports, no native/model/bot/browser acceptance')
} finally { if (server?.listening) await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }) }

function between(start, end) { const a = script.indexOf(start), b = script.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return script.slice(a, b) }
async function login(name) { const response = await request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password: name + ' synthetic password' } }); assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken } }
async function request(path, { method = 'GET', session, json, csrf, originHeader } = {}) { const headers = {}; if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = csrf ?? session.csrf }; if (originHeader || session) headers.origin = originHeader ?? origin; if (json !== undefined) headers['content-type'] = 'application/json'; const response = await fetch(origin + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), text = await response.text(); return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text } }

async function checkRuntime() {
  const events = [], runtimeStore = { async read() { return { deliveries: [{ id: 'wx-one', channelAppId: 'wx' }, { id: 'fs-one', channelAppId: 'fs' }], channelApps: [{ id: 'wx', provider: 'weixin' }, { id: 'fs', provider: 'feishu' }] } } }
  const provider = name => ({ async start() { events.push(name + ':start') }, async sync() {}, isAvailable: () => true, async sendDelivery(id, options) { events.push(name + ':' + id); assert.equal(typeof options?.ownerCheck, 'function') }, async close() { events.push(name + ':close') } })
  const aggregate = createChannelRuntime({ store: runtimeStore, channelService: { async recover() { events.push('recover') }, async ensureAutomationDeliveries() { return { deliveries: [{ id: 'wx-one', status: 'pending' }, { id: 'fs-one', status: 'pending' }] } } }, feishuRuntime: provider('fs'), weixinRuntime: provider('wx'), ownerCheck: () => true })
  await aggregate.start(); assert.deepEqual(events, ['recover', 'fs:start', 'wx:start', 'wx:wx-one', 'fs:fs-one']); await aggregate.close(); assert.deepEqual(events.slice(-3), ['fs:close', 'wx:close', 'recover'])
  events.length = 0
  const unowned = createChannelRuntime({ store: runtimeStore, channelService: { recover() { assert.fail('unowned cleanup must not touch shared claims') } }, feishuRuntime: provider('fs'), weixinRuntime: provider('wx') }); await unowned.close(); assert.deepEqual(events, ['fs:close', 'wx:close'])
  console.log('Provider aggregation checks passed: single pre-start recovery, fixed provider routing and unowned cleanup without store recovery (controlled runtimes)')
}

async function checkUi() {
  const nodes = new Map(), datasetNodes = [], uiCalls = [], drafts = {}, frames = []
  const camel = value => value.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  function element(id) {
    if(id&&nodes.has(id))return nodes.get(id)
    let html='',children=[];const classes=new Set()
    const value={id,value:'',dataset:{},isConnected:true,classList:{toggle(name,on){if(on??!classes.has(name))classes.add(name);else classes.delete(name)},add(...names){names.forEach(name=>classes.add(name))},remove(...names){names.forEach(name=>classes.delete(name))},contains:name=>classes.has(name)},focus(){document.activeElement=value},scrollIntoView(){}}
    Object.defineProperty(value,'innerHTML',{get:()=>html,set(next){
      for(const child of children){child.isConnected=false;if(document.activeElement===child)document.activeElement=document.body;if(child.id&&nodes.get(child.id)===child)nodes.delete(child.id);const index=datasetNodes.indexOf(child);if(index>=0)datasetNodes.splice(index,1)}
      html=next;children=[]
      for(const tag of next.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)){
        const attrs=tag[2],child=element(attrs.match(/\bid="([^"]+)"/)?.[1]||'');children.push(child)
        child.classList.add(...(attrs.match(/\bclass="([^"]*)"/)?.[1]||'').split(/\s+/).filter(Boolean))
        for(const data of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g))child.dataset[camel(data[1])]=data[2]
        if(Object.keys(child.dataset).length)datasetNodes.push(child)
      }
    }})
    if(id)nodes.set(id,value);return value
  }
  for(const id of ['channel-attention','channel-list','conversation-message'])element(id)
  const state={authEpoch:1,session:{id:'a'},view:'channels',workSelection:0,conversationReadRequest:0,bootstrap:{employees:[{id:'agent-a',name:'员工甲',enabled:true},{id:'agent-b',name:'员工乙',enabled:true}]},channelDrafts:{},channels:{defaultChannelEmployeeId:'agent-a',identities:[{id:identity.id,channelAppId:'wx',status:'active',externalIdentity:'…1234',defaultEmployeeId:null,activeConversationId:'current-conversation',runtimeState:'connected'}],conversations:[],deliveries:[],linkCodes:[{...link,qrcodeUrl:link.qrcodeUrl}]},channelApps:[{id:'wx',provider:'weixin',enabled:true,runtimeStatus:'ready'}],conversations:[{id:'current-conversation',title:'当前',employeeName:'员工甲',employeeId:'agent-a',channelIdentityId:identity.id,updatedAt:now},{id:'old-conversation',title:'旧对话',employeeName:'员工乙',employeeId:'agent-b',channelIdentityId:identity.id,updatedAt:now}],currentConversation:null}
  const document={body:element('body'),getElementById:id=>nodes.get(id)??null,querySelector:selector=>selector==='.content'?element('content'):null,querySelectorAll:selector=>{if(selector==='.page')return [...nodes.values()].filter(item=>item.id.startsWith('view-'));const key=selector.match(/^\[data-([^\]]+)\]$/)?.[1];return key?datasetNodes.filter(item=>Object.hasOwn(item.dataset,camel(key))):[]}}
  document.activeElement=document.body
  let reloads=0
  const box=createContext({state,document,URLSearchParams,history:{replaceState(){}},requestAnimationFrame:callback=>frames.push(callback),crypto:{randomUUID:()=> 'request'},api:async(path,options)=>{uiCalls.push([path,options]);return {}},reloadAll:async()=>{reloads++},loadConversations:async()=>{},loadAdmin:async()=>{},bindAdminForms(){},startChannelPolling(){},stopPolling(){},renderConversation(){},conversationDraft:id=>drafts[id]??={message:'',messageType:''},openConversation:id=>uiCalls.push(['open',id]),setMessage(){}})
  runInContext(between('    const titles=','    async function api(')+between('    function show(','    async function routeFromUrl(')+between('    function channelEmployeeSelect(','    async function channelAction(')+between('    async function channelAction(','    async function createDelivery('),box)
  runInContext('renderChannels()',box)
  assert.match(element('channel-list').innerHTML,/data-channel-provider="feishu"/);assert.match(element('channel-list').innerHTML,/data-channel-provider="weixin"/)
  assert.match(element('channel-list').innerHTML,/微信本人绑定二维码/);assert.match(element('channel-list').innerHTML,/src="\/api\/channels\/weixin\/bindings\/link-a\/qr"/);assert.doesNotMatch(element('channel-list').innerHTML,/src="https:/)
  assert.match(element('channel-list').innerHTML,/旧对话/);assert.match(element('channel-list').innerHTML,/不会.*|新会话不带入旧上下文/)
  for(const id of ['view-work','view-channels','top-title','work-detail'])element(id)
  let finishLoad,pendingLoad
  const settingsClick=()=>{
    state.view='work';box.loadConversations=()=>pendingLoad=new Promise(resolve=>{finishLoad=resolve})
    element('work-detail').innerHTML=runInContext('deliveryCard('+JSON.stringify({...delivery,status:'blocked'})+')',box);runInContext('bindDeliveryActions()',box)
    const button=datasetNodes.find(item=>item.dataset.channelSettings==='wx');button.focus();button.onclick();assert.equal(state.view,'channels');return button
  }
  const finishNavigation=async()=>{finishLoad();await pendingLoad;await Promise.resolve()}
  const focusedCard=()=>{const card=element('channel-app-wx');assert.equal(document.activeElement,card);assert.equal(card.classList.contains('restored-focus'),true);return card}
  settingsClick();frames.shift()();const replacedCard=focusedCard();await finishNavigation()
  assert.equal(replacedCard.isConnected,false);assert.notEqual(element('channel-app-wx'),replacedCard);focusedCard()
  settingsClick();await finishNavigation();frames.shift()();focusedCard()
  settingsClick();frames.shift()();element('channel-employee-'+identity.id).focus();await finishNavigation()
  assert.notEqual(document.activeElement,element('channel-app-wx'),'user moved to a control before refresh; do not restore card focus')
  settingsClick();const selected=element('channel-employee-'+identity.id);selected.focus();frames.shift()()
  assert.equal(document.activeElement,selected,'user moved before RAF; do not steal focus');await finishNavigation()
  const leftView=settingsClick();state.view='home';frames.shift()();await finishNavigation()
  assert.equal(document.activeElement,leftView,'late navigation must not focus a hidden channel card')
  const previousLogin=settingsClick();state.authEpoch++;frames.shift()();await finishNavigation()
  assert.equal(document.activeElement,previousLogin,'late RAF must not steal another login focus')
  state.view='channels';box.loadConversations=async()=>{}
  const selection=element('channel-employee-'+identity.id);selection.value='agent-b';selection.onchange();const newButton=datasetNodes.find(node=>node.dataset.newChannelConversation===identity.id);await newButton.onclick()
  assert.deepEqual(JSON.parse(JSON.stringify(uiCalls[0])),['/api/channels/identities/identity-a/conversations',{method:'POST',body:{employeeId:'agent-b'}}])
  const oldButton=datasetNodes.find(node=>node.dataset.openChannelConversation==='old-conversation');oldButton.onclick();assert.equal(state.channels.identities[0].activeConversationId,'current-conversation')
  box.item={...delivery,progress:{acknowledgedParts:1,totalParts:3}};const unknown=runInContext('deliveryCard(item)',box);assert.match(unknown,/已确认 1 \/ 3 段/);assert.match(unknown,/不会盲目重发/);assert.doesNotMatch(unknown,/data-retry-delivery/)
  const callsBeforeCards=uiCalls.length
  for(const status of ['failed','blocked']){
    box.item={...delivery,status};const card=runInContext('deliveryCard(item)',box)
    assert.match(card,/data-retry-delivery="delivery-a"/)
    assert.match(card,status==='failed'?/重试未确认部分/:/核验权限并重试/)
    if(status==='blocked')assert.match(card,/data-channel-settings="wx"/)
    state.channelApps[0].runtimeStatus='unavailable'
    assert.match(runInContext('deliveryCard(item)',box),/data-retry-delivery="delivery-a" disabled/)
    state.channelApps[0].runtimeStatus='ready'
  }
  assert.equal(uiCalls.length,callsBeforeCards,'rendering retry controls and restoring transport do not send')
  state.channels.deliveries=[{...delivery,status:'blocked',workId:'saved-work',resultId:'saved-result'}]
  box.work={id:'saved-work',results:[{id:'saved-result'}]}
  assert.match(runInContext('workChannelPanel(work)',box),/data-retry-delivery="delivery-a"/)
  state.channels.deliveries=[{...delivery,status:'blocked'}]
  box.detail={id:'old-conversation',channelIdentityId:identity.id,employeeId:'agent-b',historyStatus:'available'};box.turn={id:'old-turn',status:'completed',assistantText:'已完成回复'}
  const existingReply=runInContext('conversationReplyControls(detail,turn)',box)
  assert.match(existingReply,/data-retry-delivery="delivery-a"/);assert.doesNotMatch(existingReply,/data-reply-conversation-turn/)
  let saved={members:[{id:'a',enabled:true,employeeIds:['agent-a']}],employees:[{id:'agent-a',enabled:true}],skills:[],connections:[],works:[],
    conversations:[{id:'saved-conversation',ownerMemberId:'a',employeeId:'agent-a',channelIdentityId:identity.id,turns:[{id:'saved-turn',status:'completed',assistantText:'SYNTHETIC_SAVED_REPLY'}]}],
    channelApps:[{id:'wx',provider:'weixin',enabled:true,status:'active',revision:1,allowedScopes:['result']}],
    channelIdentities:[{id:identity.id,memberId:'a',channelAppId:'wx',status:'active',revision:1,weixin:{runtimeState:'connected'}}],
    channelConversations:[{id:'endpoint-a',identityId:identity.id,memberId:'a',channelAppId:'wx',type:'private',status:'active',revision:1,allowedScopes:['result'],providerConversationId:'synthetic-endpoint'}],deliveries:[]}
  const savedFacts=structuredClone({conversations:saved.conversations,works:saved.works}),platformCalls=[],retryCalls=[],deliveryMessages=[]
  let businessCalls=0
  const rerun=()=>{businessCalls++;assert.fail('delivery retry must not run conversation or work')}
  const savedService=createChannelService({store:{async read(){return structuredClone(saved)},async update(updater){saved=structuredClone(updater(saved))}},clock:()=>now,idFactory:()=> 'saved-reply',
    conversationService:{async getConversation(){return {historyStatus:'available',turns:structuredClone(saved.conversations[0].turns)}},sendTurn:rerun},workService:{createWork:rerun}})
  const savedDelivery=(await savedService.createConversationDelivery({id:'a'},{identityId:identity.id,conversationId:'saved-conversation',turnId:'saved-turn',requestId:'saved-reply'})).delivery
  saved.members[0].employeeIds=[]
  await assert.rejects(savedService.authorizeDelivery({deliveryId:savedDelivery.id}),{code:'DELIVERY_FORBIDDEN'})
  assert.equal(saved.deliveries[0].status,'blocked');assert.equal(platformCalls.length,0)
  const previousApi=box.api,previousReload=box.reloadAll,previousMessage=box.setMessage
  box.api=async(path,options)=>{
    retryCalls.push([path,JSON.parse(JSON.stringify(options))])
    assert.equal(path,'/api/channels/deliveries/'+savedDelivery.id+'/retry');assert.deepEqual(retryCalls.at(-1)[1],{method:'POST',body:{}})
    await savedService.retryDelivery({deliveryId:savedDelivery.id})
    const claim=await savedService.validateSendClaim({deliveryId:savedDelivery.id});platformCalls.push(claim.text)
    return savedService.recordDeliveryOutcome({deliveryId:savedDelivery.id,status:'delivered',providerMessageId:'synthetic-ack'})
  }
  box.reloadAll=async()=>{reloads++;state.channels.deliveries=structuredClone(saved.deliveries)}
  box.setMessage=(...args)=>deliveryMessages.push(args)
  const renderSavedDelivery=()=>{state.channels.deliveries=structuredClone(saved.deliveries);runInContext('renderChannels()',box);return datasetNodes.find(item=>item.dataset.retryDelivery===savedDelivery.id)}
  const deniedRetry=renderSavedDelivery();assert.ok(deniedRetry);assert.equal(retryCalls.length,0)
  await deniedRetry.onclick();assert.equal(saved.deliveries[0].status,'blocked');assert.equal(platformCalls.length,0)
  assert.equal(deliveryMessages.at(-1)[2],'error');assert.equal(retryCalls.length,1)
  saved.members[0].employeeIds=['agent-a']
  const allowedRetry=renderSavedDelivery();assert.equal(saved.deliveries[0].status,'blocked');assert.equal(platformCalls.length,0);assert.equal(retryCalls.length,1)
  await allowedRetry.onclick();assert.deepEqual(platformCalls,['SYNTHETIC_SAVED_REPLY']);assert.equal(saved.deliveries[0].status,'delivered');assert.equal(saved.deliveries.length,1);assert.equal(retryCalls.length,2)
  assert.equal(deliveryMessages.at(-1)[2],'success');assert.equal(businessCalls,0);assert.deepEqual({conversations:saved.conversations,works:saved.works},savedFacts)
  saved.deliveries[0].status='unknown';const beforeUnknownRetry=structuredClone(saved)
  await assert.rejects(savedService.retryDelivery({deliveryId:savedDelivery.id}),{code:'INVALID_STATE'});assert.deepEqual(saved,beforeUnknownRetry);assert.equal(platformCalls.length,1)
  box.api=previousApi;box.reloadAll=previousReload;box.setMessage=previousMessage;state.channels.deliveries=[]
  box.detail={id:'old-conversation',channelIdentityId:identity.id,employeeId:'agent-b',historyStatus:'available'};box.turn={id:'old-turn',status:'completed',assistantText:'已完成回复'};assert.match(runInContext('conversationReplyControls(detail,turn)',box),/data-reply-conversation-turn/)
  state.currentConversation=box.detail;state.view='conversations';uiCalls.length=0;await runInContext("replyConversationTurn('old-turn')",box);assert.equal(uiCalls[0][1].body.conversationId,'old-conversation');assert.equal(uiCalls[0][1].body.identityId,identity.id);assert.equal(state.channels.identities[0].activeConversationId,'current-conversation')
  element('conversation-detail');box.startConversationWork=()=>{};state.currentConversation={id:'revoked',title:'原会话',employeeId:'agent-b',employeeName:'员工乙',channelIdentityId:identity.id,readOnlyReason:'CONTEXT_ACCESS_REVOKED',activeTurnId:null,historyStatus:'available',turns:[{id:'revoked-turn',status:'completed',userText:null,assistantText:null,contentUnavailableReason:'CONTEXT_ACCESS_REVOKED',createdAt:now}],relatedWorks:[]}
  runInContext(between('    const conversationReadOnlyMessages=','    async function updateConversation('),box)
  runInContext('renderConversation()',box)
  assert.equal(element('conversation-read-only').textContent,'对话数据授权已失效，请开启新会话。');assert.match(element('conversation-turns').innerHTML,/数据授权已失效，正文已停止访问/);assert.equal(element('send-conversation-turn').disabled,true)
  state.admin={channelDefaults:{defaultChannelEmployeeId:'agent-a'},employees:state.bootstrap.employees,channelApps:[{id:'channel-app-weixin',provider:'weixin',enabled:true,status:'active'}]};element('config-channelApps')
  runInContext(between('    function channelAppForm(','    function renderSkills('),box);runInContext('renderChannelApps()',box)
  assert.match(element('config-channelApps').innerHTML,/渠道默认员工/);assert.match(element('config-channelApps').innerHTML,/不会改写旧对话或复制上下文/);assert.doesNotMatch(element('config-channelApps').innerHTML,/新建微信/)
  uiCalls.length=0;element('channel-default-employee').value='';await element('channel-default-form').onsubmit({preventDefault(){}})
  assert.deepEqual(JSON.parse(JSON.stringify(uiCalls[0])),['/api/admin/channel-defaults',{method:'PATCH',body:{defaultChannelEmployeeId:null}}])
  let resolve;box.api=()=>new Promise(done=>{resolve=done});reloads=0;state.view='channels';const pending=runInContext("beginWeixinBinding('wx')",box);state.authEpoch++;resolve({});await pending;assert.equal(reloads,0,'late binding response must not reload another login')
  console.log('Actual channel Web helpers passed: two cards/real QR endpoint/default choice/new conversation/old pointer/partial unknown, blocked retry through current authorization without business rerun, deferred card-focus restoration and late-login isolation (VM DOM fixture and in-memory service; not browser acceptance)')
}
