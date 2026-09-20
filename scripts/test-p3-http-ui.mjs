import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer as createNodeServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService, ERROR_STATUS } from '../src/work-service.mjs'

const temp = await mkdtemp(join(tmpdir(), 'geneway-p3-http-ui-'))
const store = createFileStore(join(temp, 'state.json'))
const authPath = join(temp, 'auth.json')
const origin = `http://127.0.0.1:${await freePort()}`
const capture = await startCapture()
const connection = { id: 'connection-gear', name: 'GearJob 外部测试 A', kind: 'gearjob-rest', targetIdentity: 'p3-http', baseUrl: capture.address, credentialRef: 'gearjob.json', allowedObjectIds: ['WO-26-00096'], sourceSystem: 'GearJob', sourceInstance: 'p3-http', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'controlled', enabled: true, status: 'ready', skillIds: ['skill-gearjob-work-order-read'], revision: 1 }
const previousCaptureUrl = process.env.GENEWAY_P3_CAPTURE_BASE_URL
process.env.GENEWAY_P3_CAPTURE_BASE_URL = `${capture.address}/v1`
let server, browser, service
const runtimeErrors = []

try {
  await store.update(state => seed(state, connection))
  await mkdir(join(temp, 'secrets'), { recursive: true, mode: 0o700 })
  await writeFile(join(temp, 'secrets', 'gearjob.json'), 'local-test-only', { mode: 0o600 })
  await initializeAuthFile(authPath, { 'member-admin': 'admin password', 'member-owner': 'owner password', 'member-peer': 'peer password' }, { mode: 'create', allowedMemberIds: ['member-admin', 'member-owner', 'member-peer'] })
  const auth = createAuthRuntime({ filePath: authPath })
  const collaborationRunner = createCollaborationRunner({ store, root: process.cwd(), dshHome: join(temp, 'dsh'), environment: { GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`, GENEWAY_P3_CAPTURE_KEY: 'local-only' }, agentOptions: { provider: 'geneway-p3-capture', model: 'p3-runtime-test', maxTokens: 4096 }, secretRoot: join(temp, 'secrets'), onError: error => runtimeErrors.push(error) })
  service = createWorkService({ store, collaborationRunner, connectionCatalog: [connection], runner: { async close() {} } })
  const knowledge = collaborationRunner.getKnowledgeService()
  const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  server = createGenewayServer({ service, knowledge, collaborationRunner, store, auth, index, trustedOrigin: origin })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(new URL(origin).port, '127.0.0.1', resolve) })

  const owner = await login('owner', 'owner password')
  const peer = await login('peer', 'peer password')
  const admin = await login('admin', 'admin password')
  assert.equal((await request('/api/knowledge?employeeId=employee-a&extra=1', { cookie: owner.cookie })).status, 400)
  assert.equal((await request('/api/knowledge/share-targets/extra', { cookie: owner.cookie })).status, 404)
  assert.equal((await request('/api/knowledge', { method: 'POST', session: owner, json: { title: 'x', body: 'x', format: 'text', sourceLabel: 'x', authorizationBasis: 'x', employeeIds: ['employee-a'], sharedMemberIds: [], sharedEmployeeIds: [], url: 'https://invalid.example' } })).status, 400)

  const material = await request('/api/knowledge', { method: 'POST', session: owner, json: { title: '进度复核说明', body: '只区分工单事实、人工输入与建议。', format: 'markdown', sourceLabel: '团队授权测试文本', authorizationBasis: '成员明确导入', employeeIds: ['employee-b'], sharedMemberIds: [], sharedEmployeeIds: [] } })
  assert.equal(material.status, 200)
  const shared = await request(`/api/knowledge/${material.body.id}/sharing`, { method: 'PATCH', session: owner, json: { expectedRevision: 1, memberIds: ['member-peer'], employeeIds: ['employee-b'] } })
  assert.equal(shared.body.revision, 2)
  assert.equal((await request(`/api/knowledge/${material.body.id}?employeeId=employee-b`, { cookie: peer.cookie })).status, 200)
  assert.equal((await request(`/api/knowledge/${material.body.id}?employeeId=employee-a`, { cookie: peer.cookie })).status, 404)
  const found = await request('/api/knowledge/search', { method: 'POST', session: peer, json: { employeeId: 'employee-b', query: '工单事实' } })
  assert.equal(found.body[0].knowledgeId, material.body.id)
  assert.equal((await request(`/api/knowledge/${material.body.id}`, { method: 'PATCH', session: admin, json: { expectedRevision: 2, title: '越权' } })).status, 404)
  const revoked = await request(`/api/knowledge/${material.body.id}/sharing`, { method: 'PATCH', session: owner, json: { expectedRevision: 2, memberIds: [], employeeIds: [] } })
  assert.equal(revoked.status, 200)
  assert.equal((await request(`/api/knowledge/${material.body.id}?employeeId=employee-b`, { cookie: peer.cookie })).status, 404)
  const deleted = await request(`/api/knowledge/${material.body.id}`, { method: 'DELETE', session: owner, json: { expectedRevision: 3 } })
  assert.equal(deleted.body.status, 'deleted')

  await collaborationRunner.disableKnowledge()
  const disabledBody = { title: 'disabled', body: 'disabled', format: 'text', sourceLabel: 'test', authorizationBasis: 'test', employeeIds: ['employee-b'], sharedMemberIds: [], sharedEmployeeIds: [] }
  assert.equal((await request('/api/knowledge', { method: 'POST', originHeader: origin, cookie: owner.cookie, json: disabledBody })).status, 403)
  assert.equal((await request('/api/knowledge', { method: 'POST', originHeader: 'http://evil.invalid', cookie: owner.cookie, csrf: owner.body.csrfToken, json: disabledBody })).status, 403)
  assert.equal((await request('/api/knowledge/search', { method: 'POST', session: owner, json: { employeeId: 'employee-b', query: '工单' } })).status, 503)
  assert.equal((await request('/api/knowledge', { method: 'POST', session: owner, json: disabledBody })).status, 503)
  assert.equal((await request('/api/knowledge', { cookie: owner.cookie })).status, 200)
  await collaborationRunner.enableKnowledge()

  assert.equal((await request('/api/works', { method: 'POST', session: owner, json: { workType: 'unknown' } })).status, 400)
  const invalidBefore=await store.read(),invalidCounts=[invalidBefore.works.length,Object.keys(invalidBefore.reservations).length]
  assert.equal((await request('/api/works', { method: 'POST', session: owner, json: collaborationBody({ extra: true }) })).status, 400)
  assert.equal((await request('/api/works', { method: 'POST', session: owner, json: collaborationBody({ input: { workOrderId: 'WO-26-00096', url: 'https://invalid.example' } }) })).status, 400)
  assert.equal((await request('/api/works', { method: 'POST', session: owner, json: { ...collaborationBody(), input: { quantity: 1 } } })).status, 400)
  assert.equal((await request('/api/works', { method: 'POST', session: owner, json: collaborationBody({ workOrderId: 'WO-26-00096' }) })).status, 400)
  const directQuantity=collaborationBody();directQuantity.items[1].quantity=6
  const inputQuantity=collaborationBody();inputQuantity.items[1].input.quantity=6
  for(const body of [directQuantity,inputQuantity])assert.equal((await request('/api/works',{method:'POST',session:owner,json:body})).status,400)
  const invalidAfter=await store.read();assert.deepEqual([invalidAfter.works.length,Object.keys(invalidAfter.reservations).length],invalidCounts)
  capture.hold('read-order')
  const created = await request('/api/works', { method: 'POST', session: owner, json: collaborationBody() })
  assert.equal(created.status, 200)
  await capture.waitForPending('read-order')
  assert.equal(created.body.plan.items.map(item => item.id).join(','), 'read-order,check-cycle')
  assert.equal((await request(`/api/works/${created.body.id}`, { cookie: peer.cookie })).status, 404)
  assert.equal((await request(`/api/works/${created.body.id}`, { cookie: admin.cookie })).status, 404)
  const plan = await request(`/api/works/${created.body.id}/plan`, { method: 'PATCH', session: owner, json: { expectedRevision: 1, items: [{ id: 'check-cycle', goal: '只计算平均节拍', employeeId: 'employee-b' }] } })
  assert.equal(plan.body.plan.revision, 2)
  assert.equal((await request(`/api/works/${created.body.id}/plan`, { method: 'PATCH', session: owner, json: { expectedRevision: 1, items: [{ id: 'check-cycle', goal: '过期草稿', employeeId: 'employee-b' }] } })).status, 409)
  assert.equal((await request(`/api/works/${created.body.id}/continue`, { method: 'POST', session: owner, json: { clientRequestId: 'continue-route', inputs: {} } })).status, 409)
  assert.equal((await request(`/api/works/${created.body.id}/continue`, { method: 'POST', session: owner, json: { clientRequestId: 'continue-extra', inputs: { unknown: { quantity: 1 } } } })).status, 400)
  assert.equal((await request(`/api/works/${created.body.id}/refresh`, { method: 'POST', session: owner, json: { clientRequestId: 'wrong-refresh' } })).status, 400)
  assert.equal((await request(`/api/works/${created.body.id}/follow-up`, { method: 'POST', session: owner, json: { text: 'wrong', clientRequestId: 'wrong-follow' } })).status, 400)
  assert.equal((await request(`/api/works/${created.body.id}/recheck`, { method: 'POST', session: owner, json: { clientRequestId: 'recheck-route', itemIds: ['check-cycle'] } })).status, 400)
  const beforePostPlan = await request(`/api/works/${created.body.id}`, { cookie: owner.cookie })
  assert.equal((await request(`/api/works/${created.body.id}/plan`, { method: 'POST', session: owner, json: {} })).status, 404)
  assert.equal((await request(`/api/works/${created.body.id}/continue`, { cookie: owner.cookie })).status, 404)
  assert.equal((await request(`/api/works/${created.body.id}/cancel`, { method: 'PATCH', session: owner, json: {} })).status, 404)
  const afterPostPlan = await request(`/api/works/${created.body.id}`, { cookie: owner.cookie })
  assert.deepEqual([afterPostPlan.body.status, afterPostPlan.body.plan.revision, afterPostPlan.body.collaboration.cancelGeneration, afterPostPlan.body.executions.length], [beforePostPlan.body.status, beforePostPlan.body.plan.revision, beforePostPlan.body.collaboration.cancelGeneration, beforePostPlan.body.executions.length])
  assert.equal((await request(`/api/works/${created.body.id}/cancel`, { method: 'POST', session: owner, json: {} })).status, 200)
  capture.release('read-order')

  const ordinary=await request('/api/works',{method:'POST',session:owner,json:{employeeId:'employee-b',skillId:'skill-cycle-time-calculate',capabilityId:'cycle-time-calculate',input:{availableSeconds:60},clientRequestId:'ordinary-shape'}})
  assert.equal(ordinary.status,200)
  assert.equal((await request(`/api/works/${ordinary.body.id}/plan`,{method:'PATCH',session:owner,json:{expectedRevision:1,items:[]}})).status,400)
  assert.equal((await request(`/api/works/${ordinary.body.id}/recheck`,{method:'POST',session:owner,json:{clientRequestId:'ordinary-recheck',inputs:{}}})).status,400)
  assert.equal((await request(`/api/works/${ordinary.body.id}/continue`,{method:'POST',session:owner,json:{clientRequestId:'ordinary-collab-shape',inputs:{}}})).status,400)

  for (const [code, expected] of Object.entries({ INVALID_REQUEST: 400, CAPACITY_EXCEEDED: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BUSY: 409, REVISION_CONFLICT: 409, KNOWLEDGE_REFERENCE_INVALID: 409, BUDGET_EXHAUSTED: 409, UPSTREAM_ERROR: 502, INVALID_SOURCE: 502, SOURCE_NOT_CONFIGURED: 503, MODEL_NOT_CONFIGURED: 503, KNOWLEDGE_PLUGIN_DISABLED: 503, UPSTREAM_TIMEOUT: 504 })) {
    assert.equal(ERROR_STATUS[code], expected)
    const original = service.listConfig
    service.listConfig = async () => { throw Object.assign(new Error('private detail'), { code }) }
    assert.equal((await request('/api/admin/employees', { cookie: admin.cookie })).status, expected)
    service.listConfig = original
  }
  const original = service.listConfig
  service.listConfig = async () => { throw new Error('/private/secret') }
  const unknown = await request('/api/admin/employees', { cookie: admin.cookie })
  service.listConfig = original
  assert.deepEqual(unknown.body.error, { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求', status: 500 })

  const browserResult = await browserJourney(owner, capture, collaborationRunner)
  assert.equal(browserResult.desktopOverflow, false)
  assert.equal(browserResult.mobileOverflow, false)
  assert.match(browserResult.text, /已停止访问/)
  assert.deepEqual(browserResult.consoleErrors, [])
  assert.equal(browserResult.failedRequests.length, 0)
  console.log('P3 HTTP/UI checks passed', JSON.stringify(browserResult.viewports))
} finally {
  if (browser?.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)) }
  if (server) await new Promise(resolve => server.close(resolve))
  await service?.close()
  await capture.close()
  if (previousCaptureUrl === undefined) delete process.env.GENEWAY_P3_CAPTURE_BASE_URL
  else process.env.GENEWAY_P3_CAPTURE_BASE_URL = previousCaptureUrl
  await rm(temp, { recursive: true, force: true })
}

function collaborationBody(itemExtra = {}) {
  return { workType: 'collaboration', employeeId: 'employee-lead', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: '工单进度与剩余节拍核对', clientRequestId: crypto.randomUUID(), items: [
    { id: 'read-order', employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: connection.id, goal: '读取当前工单事实', input: { workOrderId: 'WO-26-00096' }, ...itemExtra },
    { id: 'check-cycle', employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: '核对平均节拍', input: { availableSeconds: 3600 }, dependsOn: ['read-order'] },
  ] }
}

async function login(loginName, password) { return request('/api/session', { method: 'POST', originHeader: origin, json: { loginName, password } }) }
async function request(path, options = {}) {
  const headers = {}
  if (options.originHeader) headers.origin = options.originHeader
  if (options.session) { headers.origin = origin; headers.cookie = cookiePair(options.session.cookie); headers['x-csrf-token'] = options.session.body.csrfToken }
  if (options.cookie) headers.cookie = cookiePair(options.cookie)
  if (options.csrf) headers['x-csrf-token'] = options.csrf
  let body
  if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json) }
  const response = await fetch(origin + path, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') }
}
function cookiePair(value) { return String(value).split(';', 1)[0] }

async function browserJourney(ownerSession, runtimeCapture, runtime) {
  let apiOwner = ownerSession
  const debuggingPort = await freePort(), userData = join(temp, 'chrome')
  const files = { valid: join(temp, 'browser-current.MD'), html: join(temp, 'browser.html'), extensionless: join(temp, 'browser-file'), invalid: join(temp, 'invalid.txt'), large: join(temp, 'large.md') }
  await writeFile(files.valid, '浏览器当前依据\n\n明确区分工单事实、用户条件和建议。')
  await writeFile(files.html, '<script>bad()</script>')
  await writeFile(files.extensionless, 'no suffix')
  await writeFile(files.invalid, Buffer.from([0xff, 0xfe, 0xfd]))
  await writeFile(files.large, '甲'.repeat(11_000))
  browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`, `--remote-debugging-port=${debuggingPort}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', `--app=${origin}`], { stdio: 'ignore' })
  const target = await browserTarget(debuggingPort, origin), socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), browserErrors = [], failedRequests = [], requests = new Map(), responses = []
  let sequence = 0
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(message.error.message)) : entry?.resolve(message.result); return } if(message.method==='Network.requestWillBeSent')requests.set(message.params.requestId,{url:message.params.request.url,method:message.params.request.method});if(message.method==='Network.responseReceived')responses.push({...requests.get(message.params.requestId),status:message.params.response.status});if (message.method === 'Runtime.consoleAPICalled' && ['warning','error'].includes(message.params.type)) browserErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' ')); if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text); if (message.method === 'Log.entryAdded' && ['warning','error'].includes(message.params.entry.level)) browserErrors.push(message.params.entry.text); if (message.method === 'Network.loadingFailed' && !message.params.canceled && message.params.errorText !== 'net::ERR_ABORTED') failedRequests.push(message.params.errorText) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
  const pressTab=async()=>{await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})}
  const tabTo=async selector=>{for(let index=0;index<120;index+=1){if(await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)){const focus=await evaluate(`({name:document.activeElement.getAttribute('aria-label')||document.activeElement.innerText||document.activeElement.labels?.[0]?.innerText||'',outline:getComputedStyle(document.activeElement).outlineWidth})`);assert.equal(Boolean(focus.name.trim())&&focus.outline!=='0px',true);return}await pressTab()}throw new Error(`keyboard focus target not reached: ${selector}`)}
  const keyboardActivate=async selector=>{await tabTo(selector);await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})}
  const visibleEngineeringPattern=/[0-9a-f]{8}-[0-9a-f-]{27,}|\b(?:collaboration-root|collaboration-recheck|collaboration-continue|read-order|check-cycle|employee-a|employee-b|session-|sessionVersion|sourceInstance|sourceEnvironment|dataMode|evidenceMode|confirmedFacts)\b|\bsegmentId\b|\bsegment\s*[:：]?\s*p\d+-c\d+\b|P3-(?:R\d+|REVOKED)-[0-9a-f]+|KNOWLEDGE-R\d+-CANARY/i
  assert.equal(visibleEngineeringPattern.test('segmentId p1-c1'),true);assert.equal(visibleEngineeringPattern.test('segment p1-c1'),true);assert.equal(visibleEngineeringPattern.test('Knowledge search returned the authorized segment'),false);for(const key of ['sessionVersion','sourceInstance','sourceEnvironment','dataMode','evidenceMode','confirmedFacts'])assert.equal(visibleEngineeringPattern.test(key),true)
  const assertVisibleSurfaceClean=async()=>{const dom=await evaluate(`document.body.innerText`),ax=await send('Accessibility.getFullAXTree'),axText=ax.nodes.flatMap(node=>[node.name?.value,node.description?.value,node.value?.value]).filter(value=>typeof value==='string').join('\n'),raw=dom+'\n'+axText,match=raw.match(visibleEngineeringPattern);assert.equal(match,null,match?.[0])}
  await send('Runtime.enable');await send('Network.enable');await send('Page.enable');await send('DOM.enable');await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const setFile = async path => { const document = await send('DOM.getDocument'); const node = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#knowledge-file' }); await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] }) }
  const loginUi = async (name,password) => { await waitEval(evaluate, `Boolean(document.querySelector('#login-name'))`);await evaluate(`document.querySelector('#login-name').value=${JSON.stringify(name)};document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-button').click()`);await waitEval(evaluate, `!document.querySelector('#app').classList.contains('hidden')`) }
  const logoutUi = async () => { await evaluate(`document.querySelector('#logout').click()`);await waitEval(evaluate, `!document.querySelector('#login-shell').classList.contains('hidden')`) }
  await waitEval(evaluate, `Boolean(document.querySelector('#login-name'))`)
  const desktopMeasured=await evaluate(`({width:innerWidth,height:innerHeight})`);assert.deepEqual(desktopMeasured,{width:1440,height:900})
  await loginUi('owner','owner password')
  await keyboardActivate('[data-view="knowledge"]')
  await send('Browser.setPermission',{permission:{name:'clipboard-read'},setting:'granted',origin});await send('Browser.setPermission',{permission:{name:'clipboard-write'},setting:'granted',origin})
  await evaluate(`navigator.clipboard.writeText('浏览器真实粘贴文本').then(()=>document.querySelector('#knowledge-body').focus())`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',modifiers:2,commands:['Paste']});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',modifiers:2});await waitEval(evaluate,`document.querySelector('#knowledge-body').value==='浏览器真实粘贴文本'`)
  for (const [path,message] of [[files.html,'只支持扩展名为 .txt 或 .md 的文件'],[files.extensionless,'只支持扩展名为 .txt 或 .md 的文件'],[files.invalid,'文件不是有效 UTF-8 文本'],[files.large,'单份知识正文不能超过 32 KiB']]) { await evaluate(`document.querySelector('#knowledge-file-error').textContent=''`);await setFile(path);await waitEval(evaluate, `document.querySelector('#knowledge-file-error').innerText.length>0`);assert.equal(await evaluate(`document.querySelector('#knowledge-file-error').innerText`),message) }
  await setFile(files.valid)
  await waitEval(evaluate, `document.querySelector('#knowledge-body').value.includes('浏览器当前依据')`)
  await evaluate(`document.querySelector('#knowledge-title').value='浏览器知识';document.querySelector('#knowledge-source').value='浏览器文件选择';document.querySelector('#knowledge-authorization').value='成员明确导入';document.querySelector('input[name="knowledgeEmployeeIds"][value="employee-lead"]').click();document.querySelector('input[name="knowledgeEmployeeIds"][value="employee-b"]').click()`);await keyboardActivate('#knowledge-form button')
  await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText==='知识已导入，可供所选员工使用'&&document.body.innerText.includes('浏览器知识')`)
  const knowledgeId = await evaluate(`state.knowledge.find(item=>item.title==='浏览器知识').id`)
  runtimeCapture.setKnowledge({ knowledgeId, revision: 1 })
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`)
  await waitEval(evaluate, `Boolean(document.querySelector('[data-save-sharing]'))`)
  await evaluate(`document.querySelector('input[name="sharedMemberIds"][value="member-peer"]').click();document.querySelector('input[name="sharedEmployeeIds"][value="employee-b"]').click();document.querySelector('[data-save-sharing]').click()`)
  await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText.includes('共享范围已更新')`)
  runtimeCapture.setKnowledge({ knowledgeId, revision: 2 })
  await logoutUi();await loginUi('peer','peer password')
  await evaluate(`document.querySelector('[data-view="knowledge"]').click();document.querySelector('#knowledge-search-employee').value='employee-b';document.querySelector('#knowledge-search-query').value='浏览器当前依据';document.querySelector('#knowledge-search-form button').click()`)
  await waitEval(evaluate, `document.querySelector('#knowledge-search-results').innerText.includes('浏览器当前依据')`)
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`)
  await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`)
  await logoutUi();await loginUi('owner','owner password');apiOwner=await login('owner','owner password')
  runtimeCapture.hold('read-order');runtimeCapture.hold('check-cycle')
  await keyboardActivate('[data-view="home"]');await evaluate(`document.querySelector('#work-mode').value='collaboration';document.querySelector('#work-mode').dispatchEvent(new Event('change'));document.querySelector('#work-employee').value='employee-lead';document.querySelector('#work-employee').dispatchEvent(new Event('change'));document.querySelector('#work-skill').value='skill-cycle-time-calculate';document.querySelector('#work-skill').dispatchEvent(new Event('change'));document.querySelector('#collab-a-employee').value='employee-a';document.querySelector('#collab-b-employee').value='employee-b';document.querySelector('#work-goal').value='浏览器协作核对';document.querySelector('#collab-a-order').value='WO-26-00096';document.querySelector('#collab-seconds').value='3600';document.querySelector('#collab-knowledge-query').value='浏览器当前依据'`);await keyboardActivate('#submit-work')
  await waitEval(evaluate, `document.body.innerText.includes('浏览器协作核对')&&document.body.innerText.includes('工作计划')`)
  const workId = await evaluate(`state.currentWork.id`)
  await runtimeCapture.waitForPending('read-order')
  await waitEval(evaluate, `Boolean(document.querySelector('[data-plan-goal="check-cycle"]'))`)
  await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal="check-cycle"]');input.focus();input.value='浏览器本地草稿';input.dispatchEvent(new Event('input'))})()`)
  await new Promise(resolve => setTimeout(resolve, 1400))
  assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value==='浏览器本地草稿'&&document.activeElement.id==='plan-goal-check-cycle'`), true)
  const serverPlan = await request(`/api/works/${workId}/plan`, { method: 'PATCH', session: apiOwner, json: { expectedRevision: 1, items: [{ id: 'check-cycle', goal: '服务端最新目标', employeeId: 'employee-b' }] } })
  assert.equal(serverPlan.status, 200)
  await keyboardActivate('#save-plan')
  await waitEval(evaluate, `document.body.innerText.includes('本地草稿仍保留')`)
  assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value`), '浏览器本地草稿')
  assert.equal(await evaluate(`document.body.innerText.includes('服务端最新目标')`), true)
  await keyboardActivate('#rebase-plan');await keyboardActivate('#save-plan')
  await waitEval(evaluate, `state.currentWork.plan.revision===3`)
  await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal="check-cycle"]');input.focus();input.value='运行后仍保留的草稿';input.dispatchEvent(new Event('input'))})()`)
  runtimeCapture.release('read-order');await runtimeCapture.waitForPending('check-cycle')
  await waitEval(evaluate, `document.body.innerText.includes('此项已开始，草稿不会提交或丢失')`)
  assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value==='运行后仍保留的草稿'&&document.querySelector('[data-plan-goal="check-cycle"]').readOnly&&document.activeElement.id==='plan-goal-check-cycle'`), true)
  runtimeCapture.release('check-cycle')
  const completedWork=await waitHttpWork(workId,apiOwner,work=>['completed','failed'].includes(work.status));assert.equal(completedWork.status,'completed',JSON.stringify({completedWork,runtimeErrors:runtimeErrors.map(error=>error.stack)}))
  await evaluate(`reloadAll().then(()=>openWork(${JSON.stringify(workId)}))`)
  await waitEval(evaluate, `document.body.innerText.includes('工单核对员 → 协调负责人')&&document.body.innerText.includes('节拍核对员 → 协调负责人')&&document.body.innerText.includes('当前有效')`)
  await assertVisibleSurfaceClean()
  const expectedBusinessFields=[`来源实例：${connection.sourceInstance}`,`来源环境：${connection.sourceEnvironment}`,`数据模式：${connection.dataMode}`,`证据方式：${connection.evidenceMode}`],businessFieldProjection=await evaluate(`Object.fromEntries(${JSON.stringify(expectedBusinessFields)}.map(value=>[value,document.body.innerText.includes(value)]))`);assert.equal(Object.values(businessFieldProjection).every(Boolean),true,businessFieldProjection);assert.equal(await evaluate(`!${JSON.stringify(['sourceInstance','sourceEnvironment','dataMode','evidenceMode','confirmedFacts'])}.some(value=>document.body.innerText.includes(value))`),true);if(connection.evidenceMode==='controlled')assert.equal(await evaluate(`document.body.innerText.includes('已确认事实：工单字段已核对')`),true)
  assert.equal(await evaluate(`document.body.innerText.includes('片段位置 p1-c1')&&!/segment(?:Id)?\\s+p1-c1/i.test(document.body.innerText)`),true)
  assert.equal(await evaluate(`document.querySelector('[data-open-reference]').innerText.includes('版本 2 · 片段位置 p1-c1')`),true)
  assert.equal((await request(`/api/bootstrap`, { cookie: apiOwner.cookie })).body.works.filter(work=>work.workType==='collaboration-child').length >= 2, true)
  assert.equal(await evaluate(`![...document.querySelectorAll('#all-work-cards [data-open-work]')].some(button=>state.bootstrap.works.find(work=>work.id===button.dataset.openWork)?.workType==='collaboration-child')`), true)
  await keyboardActivate('[data-open-reference]')
  await waitEval(evaluate, `document.body.innerText.includes('明确区分工单事实')`)
  await logoutUi();await evaluate(`location.href='/?view=work&work='+${JSON.stringify(workId)}`)
  await waitEval(evaluate, `Boolean(document.querySelector('#login-name'))`);await loginUi('owner','owner password');apiOwner=await login('owner','owner password')
  await waitEval(evaluate, `state.currentWork?.id===${JSON.stringify(workId)}`)
  await evaluate(`document.querySelector('[data-view="knowledge"]').click();[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`);await waitEval(evaluate,`Boolean(document.querySelector('.knowledge-edit'))`)
  assert.equal(await evaluate(`[...document.querySelectorAll('.knowledge-edit input,.knowledge-edit textarea,.knowledge-edit select,.knowledge-edit button')].every(control=>(control.labels?.length||control.innerText.trim()||control.getAttribute('aria-label'))) `),true)
  await evaluate(`document.querySelector('.knowledge-edit [name="body"]').value='浏览器当前依据第 3 版，不含旧内容。';document.querySelector('.knowledge-edit button[type="submit"],.knowledge-edit button').focus()`);await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await waitEval(evaluate,`document.querySelector('#knowledge-message').innerText.includes('更正已保存')`);runtimeCapture.setKnowledge({ knowledgeId, revision: 3 })
  await evaluate(`reloadAll().then(()=>openWork(${JSON.stringify(workId)}))`)
  await waitEval(evaluate, `document.body.innerText.includes('旧依据版本 2')&&document.body.innerText.includes('当前替代版本 3')&&document.body.innerText.includes('浏览器本地草稿（节拍核对员）')&&!document.body.innerText.includes('check-cycle')&&!document.body.innerText.includes('generation')`)
  await assertVisibleSurfaceClean()
  await evaluate(`document.querySelector('#recheck-work').click()`)
  await waitEval(evaluate, `state.currentWork?.status==='completed'&&state.currentWork?.collaboration?.generation===2`)
  await evaluate(`openWork(${JSON.stringify(workId)})`);await waitEval(evaluate, `document.body.innerText.includes('已被新交接替代')`)
  const rechecked = await request(`/api/works/${workId}`, { cookie: apiOwner.cookie })
  assert.equal(rechecked.body.handoffs.some(item=>item.status==='superseded'), true)
  assert.equal(rechecked.body.handoffs.some(item=>item.status==='current'&&item.generation===2), true)
  assert.equal(rechecked.body.results.at(-1).generation, 2)

  await evaluate(`document.querySelector('[data-view="home"]').click();document.querySelector('#work-mode').value='collaboration';document.querySelector('#work-mode').dispatchEvent(new Event('change'));document.querySelector('#work-employee').value='employee-lead';document.querySelector('#work-employee').dispatchEvent(new Event('change'));document.querySelector('#work-skill').value='skill-cycle-time-calculate';document.querySelector('#work-skill').dispatchEvent(new Event('change'));document.querySelector('#collab-a-employee').value='employee-a';document.querySelector('#collab-b-employee').value='employee-b';document.querySelector('#work-goal').value='待补充协作';document.querySelector('#collab-a-order').value='WO-26-00096';document.querySelector('#collab-knowledge-query').value='';document.querySelector('#collab-seconds').value='';document.querySelector('#submit-work').click()`)
  await waitEval(evaluate, `Boolean(document.querySelector('#collaboration-continue'))`)
  await waitEval(evaluate, `state.currentWork?.collaboration?.status==='waiting_input'`)
  assert.equal(await evaluate(`document.querySelector('#collab-quantity')===null&&document.querySelector('[data-supplement-name="quantity"]')===null`),true)
  assert.equal(await evaluate(`(()=>{const children=[...document.querySelector('#work-detail').children],source=children.findIndex(node=>node.innerText.startsWith('来源与依据')),supplement=children.findIndex(node=>node.id==='collaboration-continue'),history=children.findIndex(node=>node.innerText.startsWith('补充与执行历史'));return source===2&&supplement>source&&history>supplement})()`),true)
  assert.equal(await evaluate(`const inputs=[...document.querySelectorAll('#collaboration-continue input')];inputs.length>0&&inputs.every(input=>input.id&&document.querySelector('label[for="'+input.id+'"]')&&input.labels.length)`), true)
  const waitingWorkId=await evaluate(`state.currentWork.id`);const rejectedQuantity=await request(`/api/works/${waitingWorkId}/continue`,{method:'POST',session:apiOwner,json:{clientRequestId:'http-client-quantity',inputs:{'check-cycle':{availableSeconds:3600,quantity:99}}}});assert.equal(rejectedQuantity.status,400);assert.equal(rejectedQuantity.body.error.code,'INVALID_INPUT');await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal="check-cycle"]');input.value='等待态本地草稿';input.dispatchEvent(new Event('input'))})()`);assert.equal((await request(`/api/works/${waitingWorkId}/plan`,{method:'PATCH',session:apiOwner,json:{expectedRevision:1,items:[{id:'check-cycle',goal:'等待态服务端目标',employeeId:'employee-b'}]}})).status,200);await keyboardActivate('#save-plan');await waitEval(evaluate,`document.body.innerText.includes('本地草稿仍保留')`);assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value`),'等待态本地草稿');await keyboardActivate('#rebase-plan');await keyboardActivate('#save-plan');await waitEval(evaluate,`state.currentWork.plan.revision===3`);runtimeCapture.hold('check-cycle');await evaluate(`document.querySelector('[data-supplement-name="availableSeconds"]').value='3600'`);await keyboardActivate('#collaboration-continue-form button');await runtimeCapture.waitForPending('check-cycle')
  await waitEval(evaluate,`document.activeElement?.id==='cancel-work'`);assert.deepEqual(await evaluate(`({name:document.activeElement.innerText,outline:getComputedStyle(document.activeElement).outlineWidth})`),{name:'停止本工作',outline:'3px'});await new Promise(resolve=>setTimeout(resolve,1400));assert.equal(await evaluate(`document.activeElement?.id==='cancel-work'`),true);const desktopOverflow=await evaluate(`document.documentElement.scrollWidth>innerWidth`);await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(resolve=>setTimeout(resolve,100));const mobileMeasured=await evaluate(`({width:innerWidth,height:innerHeight})`);assert.deepEqual(mobileMeasured,{width:390,height:844});assert.equal(await evaluate(`document.activeElement?.id==='cancel-work'&&document.activeElement.innerText==='停止本工作'&&getComputedStyle(document.activeElement).outlineWidth==='3px'`),true);runtimeCapture.release('check-cycle')
  const continuedWork=await waitHttpWork(waitingWorkId,apiOwner,work=>['completed','failed'].includes(work.status));assert.equal(continuedWork.status,'completed',JSON.stringify(continuedWork));await waitEval(evaluate,`state.currentWork?.status==='completed'&&document.activeElement?.matches('[data-view="works"]')`);const terminalFocus=await evaluate(`({name:document.activeElement.getAttribute('aria-label')||document.activeElement.innerText,outline:getComputedStyle(document.activeElement).outlineWidth})`);assert.equal(terminalFocus.name.includes('工作')&&terminalFocus.outline==='3px',true,JSON.stringify(terminalFocus))
  await evaluate(`reloadAll().then(()=>openWork(${JSON.stringify(waitingWorkId)}))`);await waitEval(evaluate,`document.body.innerText.includes('用户提供的计算条件下平均分摊')&&document.body.innerText.includes('当前工单计划 10 − 已完成 4 = 6')`)
  runtimeCapture.hold('read-order');runtimeCapture.hold('check-cycle')
  await keyboardActivate('[data-view="home"]');await evaluate(`document.querySelector('#work-mode').value='collaboration';document.querySelector('#work-mode').dispatchEvent(new Event('change'));document.querySelector('#work-employee').value='employee-lead';document.querySelector('#work-employee').dispatchEvent(new Event('change'));document.querySelector('#work-skill').value='skill-cycle-time-calculate';document.querySelector('#work-skill').dispatchEvent(new Event('change'));document.querySelector('#collab-a-employee').value='employee-a';document.querySelector('#collab-b-employee').value='employee-b';document.querySelector('#work-goal').value='移动端完整协作';document.querySelector('#collab-a-order').value='WO-26-00096';document.querySelector('#collab-seconds').value='3600';document.querySelector('#collab-knowledge-query').value='浏览器当前依据'`);await keyboardActivate('#submit-work')
  await runtimeCapture.waitForPending('read-order');await waitEval(evaluate,`Boolean(document.querySelector('[data-plan-goal="check-cycle"]'))`);const mobileWorkId=await evaluate(`state.currentWork.id`)
  await evaluate(`(()=>{const input=document.querySelector('[data-plan-goal="check-cycle"]');input.focus();input.value='移动端本地草稿';input.dispatchEvent(new Event('input'))})()`);await new Promise(resolve=>setTimeout(resolve,1400));assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value==='移动端本地草稿'&&document.activeElement.id==='plan-goal-check-cycle'`),true)
  assert.equal((await request(`/api/works/${mobileWorkId}/plan`,{method:'PATCH',session:apiOwner,json:{expectedRevision:1,items:[{id:'check-cycle',goal:'移动端服务端最新目标',employeeId:'employee-b'}]}})).status,200)
  await keyboardActivate('#save-plan');await waitEval(evaluate,`document.body.innerText.includes('本地草稿仍保留')&&document.body.innerText.includes('移动端服务端最新目标')`);assert.equal(await evaluate(`document.querySelector('[data-plan-goal="check-cycle"]').value`),'移动端本地草稿');await keyboardActivate('#rebase-plan');await keyboardActivate('#save-plan');await waitEval(evaluate,`state.currentWork.plan.revision===3`)
  runtimeCapture.release('read-order');await runtimeCapture.waitForPending('check-cycle');runtimeCapture.release('check-cycle');assert.equal((await waitHttpWork(mobileWorkId,apiOwner,work=>['completed','failed'].includes(work.status))).status,'completed')
  await logoutUi();await evaluate(`location.href='/?view=work&work='+${JSON.stringify(mobileWorkId)}`);await waitEval(evaluate,`Boolean(document.querySelector('#login-name'))`);await loginUi('owner','owner password');apiOwner=await login('owner','owner password');await waitEval(evaluate,`state.currentWork?.id===${JSON.stringify(mobileWorkId)}`)
  await assertVisibleSurfaceClean()
  await keyboardActivate('[data-open-reference]');await waitEval(evaluate,`document.body.innerText.includes('浏览器当前依据第 3 版')`)
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`);await waitEval(evaluate,`Boolean(document.querySelector('.knowledge-edit'))`);assert.equal(await evaluate(`[...document.querySelectorAll('.knowledge-edit input,.knowledge-edit textarea,.knowledge-edit select,.knowledge-edit button')].every(control=>(control.labels?.length||control.innerText.trim()||control.getAttribute('aria-label'))) `),true)
  await evaluate(`document.querySelector('.knowledge-edit [name="body"]').value='浏览器当前依据第 4 版，移动端更正。';document.querySelector('.knowledge-edit button').focus()`);await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await waitEval(evaluate,`document.querySelector('#knowledge-message').innerText.includes('更正已保存')`);runtimeCapture.setKnowledge({knowledgeId,revision:4})
  await evaluate(`reloadAll().then(()=>openWork(${JSON.stringify(mobileWorkId)}))`);await waitEval(evaluate,`document.body.innerText.includes('移动端本地草稿（节拍核对员）')&&document.body.innerText.includes('旧依据版本 3')&&document.body.innerText.includes('当前替代版本 4')&&!document.body.innerText.includes('check-cycle')&&!document.body.innerText.includes('generation')`);await keyboardActivate('#recheck-work');await waitEval(evaluate,`state.currentWork?.status==='completed'&&state.currentWork?.collaboration?.generation===2`)

  const w1Body = collaborationBody();w1Body.goal='移动端停止 W1';w1Body.clientRequestId=randomUUID();w1Body.items[0].id='cancel-item';w1Body.items[1].id='cancel-follow';w1Body.items[1].dependsOn=['cancel-item'];delete w1Body.items[1].knowledgeQuery
  const w2Body = collaborationBody();w2Body.goal='独立完成 W2';w2Body.clientRequestId=randomUUID();w2Body.items[0].id='independent-a';w2Body.items[1].id='independent-b';w2Body.items[1].dependsOn=['independent-a'];delete w2Body.items[1].knowledgeQuery
  runtimeCapture.hold('cancel-item');const w1=await request('/api/works',{method:'POST',session:apiOwner,json:w1Body});await runtimeCapture.waitForPending('cancel-item');const w2=await request('/api/works',{method:'POST',session:apiOwner,json:w2Body})
  await evaluate(`openWork(${JSON.stringify(w1.body.id)})`);await waitEval(evaluate, `Boolean(document.querySelector('#cancel-work'))`);await keyboardActivate('#cancel-work')
  await waitHttpWork(w1.body.id,apiOwner,work=>work.status==='cancelled');await waitHttpWork(w2.body.id,apiOwner,work=>work.status==='completed');runtimeCapture.release('cancel-item')
  await runtime.disableKnowledge()
  await evaluate(`document.querySelector('[data-view="knowledge"]').click();document.querySelector('#knowledge-search-employee').value='employee-b';document.querySelector('#knowledge-search-query').value='浏览器当前依据';document.querySelector('#knowledge-search-form').requestSubmit()`);await waitEval(evaluate,`document.querySelector('#knowledge-search-message').innerText.includes('知识能力已停用')`)
  await evaluate(`document.querySelector('#knowledge-title').value='停用时导入';document.querySelector('#knowledge-source').value='停用检查';document.querySelector('#knowledge-authorization').value='成员测试';document.querySelector('#knowledge-body').value='不得导入';document.querySelector('input[name="knowledgeEmployeeIds"][value="employee-b"]').checked=true;document.querySelector('#knowledge-form').requestSubmit()`);await waitEval(evaluate,`document.querySelector('#knowledge-message').innerText.includes('知识能力已停用')`)
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`);await waitEval(evaluate,`Boolean(document.querySelector('.knowledge-edit'))`);await evaluate(`document.querySelector('.knowledge-edit [name="body"]').value='插件停用期间仍可维护，第 5 版。';document.querySelector('.knowledge-edit').requestSubmit()`);await waitEval(evaluate,`document.querySelector('#knowledge-message').innerText.includes('更正已保存')`)
  await evaluate(`document.querySelector('[data-view="home"]').click();document.querySelector('#work-mode').value='collaboration';document.querySelector('#work-mode').dispatchEvent(new Event('change'));document.querySelector('#work-employee').value='employee-lead';document.querySelector('#work-employee').dispatchEvent(new Event('change'));document.querySelector('#work-skill').value='skill-cycle-time-calculate';document.querySelector('#work-skill').dispatchEvent(new Event('change'));document.querySelector('#collab-a-employee').value='employee-a';document.querySelector('#collab-b-employee').value='employee-b';document.querySelector('#work-goal').value='停用知识时的无知识工作';document.querySelector('#collab-a-order').value='WO-26-00096';document.querySelector('#collab-knowledge-query').value='';document.querySelector('#collab-seconds').value='600';document.querySelector('#submit-work').click()`);const disabledWorkId=await waitEvalValue(evaluate,`state.currentWork?.goal==='停用知识时的无知识工作'&&state.currentWork.id`);assert.equal((await waitHttpWork(disabledWorkId,apiOwner,work=>['completed','failed'].includes(work.status))).status,'completed')
  await evaluate(`document.querySelector('[data-view="knowledge"]').click()`)
  await waitEval(evaluate, `Boolean([...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')))`)
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`)
  await waitEval(evaluate, `Boolean(document.querySelector('[data-revoke-sharing]'))`)
  await evaluate(`document.querySelector('[data-revoke-sharing]').click()`)
  await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText.includes('共享已撤销')`)
  assert.equal((await request(`/api/knowledge/${knowledgeId}?employeeId=employee-b`,{cookie:(await login('peer','peer password')).cookie})).status,404)
  await logoutUi();await loginUi('peer','peer password');await evaluate(`location.href='/?view=work&work='+${JSON.stringify(mobileWorkId)}`);await waitEval(evaluate,`document.body.innerText.includes('工作不存在')||document.body.innerText.includes('请选择一项工作')`);assert.equal(await evaluate(`!['明确区分工单事实','插件停用期间仍可维护','KNOWLEDGE-R4-CANARY'].some(secret=>document.body.innerText.includes(secret))`),true)
  await logoutUi();await loginUi('owner','owner password');apiOwner=await login('owner','owner password');await evaluate(`document.querySelector('[data-view="knowledge"]').click();[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`);await waitEval(evaluate,`document.body.innerText.includes('之前的共享范围已撤销')`)
  await evaluate(`[...document.querySelectorAll('[data-open-knowledge]')].find(button=>button.parentElement.innerText.includes('浏览器知识')).click()`);await waitEval(evaluate, `Boolean(document.querySelector('[data-delete-knowledge]'))`);await evaluate(`document.querySelector('[data-delete-knowledge]').click()`);await waitEval(evaluate, `document.querySelector('#knowledge-message').innerText.includes('已停止访问')`)
  await runtime.enableKnowledge()
  await logoutUi();await loginUi('peer','peer password');const peerAfterRevoke=await login('peer','peer password');await evaluate(`document.querySelector('[data-view="knowledge"]').click();document.querySelector('#knowledge-search-employee').value='employee-b';document.querySelector('#knowledge-search-query').value='浏览器当前依据';document.querySelector('#knowledge-search-form').requestSubmit()`);await waitEval(evaluate,`document.querySelector('#knowledge-search-results').innerText.includes('未找到当前获准依据')`);assert.equal(await evaluate(`!['明确区分工单事实','插件停用期间仍可维护','KNOWLEDGE-R4-CANARY'].some(secret=>document.body.innerText.includes(secret))`),true);const peerSearch=await request('/api/knowledge/search',{method:'POST',session:peerAfterRevoke,json:{employeeId:'employee-b',query:'浏览器当前依据'}}),peerRoot=await request(`/api/works/${mobileWorkId}`,{cookie:peerAfterRevoke.cookie}),peerMaterial=await request(`/api/knowledge/${knowledgeId}?employeeId=employee-b`,{cookie:peerAfterRevoke.cookie});assert.deepEqual(peerSearch.body,[]);assert.equal(peerRoot.status,404);assert.equal(peerMaterial.status,404);assert.equal(JSON.stringify({peerSearch,peerRoot,peerMaterial}).includes('明确区分工单事实')||JSON.stringify({peerSearch,peerRoot,peerMaterial}).includes('插件停用期间仍可维护')||JSON.stringify({peerSearch,peerRoot,peerMaterial}).includes('KNOWLEDGE-R4-CANARY'),false)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'})
  const focusEvidence=await evaluate(`({name:document.activeElement.getAttribute('aria-label')||document.activeElement.innerText||document.activeElement.labels?.[0]?.innerText||'',outline:getComputedStyle(document.activeElement).outlineWidth})`)
  assert.equal(Boolean(focusEvidence.name.trim())&&focusEvidence.outline!=='0px',true)
  const mobileOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`)
  const text = await evaluate(`document.body.innerText`)
  const unexpectedLogs=browserErrors.filter(entry=>!/^Failed to load resource: the server responded with a status of (401 \(Unauthorized\)|404 \(Not Found\)|409 \(Conflict\)|503 \(Service Unavailable\))$/.test(entry))
  socket.close()
  const unexpectedResponses=responses.filter(item=>item.status>=400&&!((item.status===401&&item.method==='GET'&&new URL(item.url).pathname==='/api/session')||(item.status===404&&item.method==='GET'&&new URL(item.url).pathname===`/api/works/${mobileWorkId}`)||(item.status===409&&item.method==='PATCH'&&/\/api\/works\/[^/]+\/plan$/.test(new URL(item.url).pathname))||(item.status===503&&item.method==='POST'&&['/api/knowledge','/api/knowledge/search'].includes(new URL(item.url).pathname))));assert.deepEqual(unexpectedResponses,[])
  return { desktopOverflow, mobileOverflow, text, consoleErrors: unexpectedLogs, expectedHttpLogs: browserErrors, failedRequests, unexpectedResponses, viewports: [desktopMeasured,mobileMeasured] }
}

async function browserTarget(port, expectedOrigin) { for (let i = 0; i < 100; i += 1) { try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const target = targets.find(item => item.type === 'page' && item.url.startsWith(expectedOrigin)); if (target) return target } catch {} await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Chrome CDP startup timed out') }
async function waitEval(evaluate, expression) { for (let i = 0; i < 800; i += 1) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error(`browser condition timed out: ${expression}`) }
async function waitEvalValue(evaluate, expression) { for (let i=0;i<800;i+=1){const value=await evaluate(expression);if(value)return value;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(`browser value timed out: ${expression}`) }
async function waitHttpWork(id, session, predicate) { const deadline=Date.now()+20_000;let last;while(Date.now()<deadline){last=await request(`/api/works/${id}`,{cookie:session.cookie});if(last.status===200&&predicate(last.body))return last.body;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(`HTTP work timed out: ${id}; last=${JSON.stringify(last)}; runtime=${runtimeErrors.map(error=>error.stack).join('\n')}`) }
async function freePort() { const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port }

async function startCapture() {
  const holds = new Set(), pending = new Map(), seen = new Set()
  let knowledgeRef
  const captureServer = createNodeServer(async (incoming, response) => {
    if (incoming.method === 'GET' && incoming.url?.includes('/api/resource/Work%20Order/')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { name: 'WO-26-00096', status: 'In Process', qty: 10, produced_qty: 4 } }))
      return
    }
    const body = await readRequestJson(incoming), serialized = JSON.stringify(body)
    const scenario = /SCENARIO:([a-z0-9-]+)/i.exec(serialized)?.[1] ?? 'unknown'
    const toolResults = body.messages?.filter(message => message.role === 'tool').length ?? 0
    const tools = (body.tools ?? []).map(entry => entry.function?.name ?? entry.name)
    const businessTool = tools.find(name => ['geneway_calculate_cycle_time', 'geneway_gearjob_read_work_order'].includes(name))
    const summaryRefs = [...new Set(serialized.match(/result-[a-f0-9-]+/g) ?? [])]
    const usesKnowledge = tools.includes('geneway_knowledge_search')
    const tool = scenario === 'root-summary' ? (toolResults ? undefined : 'geneway_collaboration_submit_summary')
      : usesKnowledge && toolResults === 1 ? 'geneway_knowledge_search'
        : usesKnowledge && toolResults === 2 ? 'geneway_knowledge_submit_references'
          : toolResults ? 'structured_output' : businessTool
    const input = serialized.match(/\\?"availableSeconds\\?":(\d+),\\?"quantity\\?":(\d+)/)
    const stepLabel=businessTool==='geneway_gearjob_read_work_order'?'工单事实核对':'节拍核对'
    const args = tool === 'structured_output' ? { status: 'done', explanation: `${stepLabel} ${usesKnowledge && knowledgeRef ? 'Knowledge search returned the authorized segment；segmentId p1-c1；segment p1-c1；sourceInstance: p3-http；sourceEnvironment: external-test；dataMode: synthetic；evidenceMode: controlled；confirmedFacts: 工单字段已核对' : '受控结果'} 已完成` }
      : tool === 'geneway_collaboration_submit_summary' ? { resultRefs: summaryRefs }
        : tool === 'geneway_knowledge_search' ? { query: '浏览器当前依据' }
          : tool === 'geneway_knowledge_submit_references' ? { references: knowledgeRef ? [{ ...knowledgeRef, segmentId: 'p1-c1' }] : [] }
            : tool === 'geneway_gearjob_read_work_order' ? { workOrderId: 'WO-26-00096' }
              : { availableSeconds: Number(input?.[1] ?? 3600), quantity: Number(input?.[2] ?? 6) }
    const complete = () => sendCaptureCompletion(response, body.model, tool, args, scenario === 'root-summary' && !tool ? `受控协作汇总完成 ${summaryRefs.join(' ')} employee-lead read-order collaboration-root` : undefined)
    seen.add(scenario)
    if (holds.has(scenario) && toolResults === 0) {
      pending.set(scenario, { response, complete })
      response.on('close', () => { if (!response.writableEnded) pending.delete(scenario) })
      return
    }
    complete()
  })
  await new Promise((resolve, reject) => { captureServer.once('error', reject); captureServer.listen(0, '127.0.0.1', resolve) })
  return {
    address: `http://127.0.0.1:${captureServer.address().port}`,
    hold(id) { holds.add(id) },
    release(id) { holds.delete(id); const entry = pending.get(id); if (entry && !entry.response.destroyed) entry.complete(); pending.delete(id) },
    setKnowledge(value) { knowledgeRef = value },
    async waitForPending(id) { const deadline = Date.now() + 10_000; while (!pending.has(id)) { if (Date.now() > deadline) assert.fail(`capture pending timeout: ${id}; seen=${[...seen]}; runtime=${runtimeErrors.map(error=>error.stack).join('\n')}`); await new Promise(resolve => setTimeout(resolve, 10)) } },
    async waitFor(id) { const deadline = Date.now() + 10_000; while (!seen.has(id)) { if (Date.now() > deadline) assert.fail(`capture seen timeout: ${id}`); await new Promise(resolve => setTimeout(resolve, 10)) } },
    close: () => new Promise((resolve, reject) => captureServer.close(error => error ? reject(error) : resolve())),
  }
}

function sendCaptureCompletion(response, model, tool, args, content = '受控协作汇总完成') {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const id = `chatcmpl-${randomUUID()}`, send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  if (tool) {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  response.end('data: [DONE]\n\n')
}

async function readRequestJson(request) { let raw = ''; for await (const chunk of request) raw += chunk; return JSON.parse(raw || '{}') }

function seed(state, connectionValue) {
  const now = '2026-09-19T00:00:00.000Z', employeeIds = ['employee-lead', 'employee-a', 'employee-b']
  return { ...state,
    members: [
      { id: 'member-admin', loginName: 'admin', displayName: '管理员', role: 'admin', enabled: true, authRef: 'member-admin', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
      { id: 'member-owner', loginName: 'owner', displayName: '生产协调员', role: 'member', enabled: true, authRef: 'member-owner', sessionVersion: 1, employeeIds, createdAt: now, updatedAt: now },
      { id: 'member-peer', loginName: 'peer', displayName: '协作成员', role: 'member', enabled: true, authRef: 'member-peer', sessionVersion: 1, employeeIds: ['employee-b'], createdAt: now, updatedAt: now },
    ],
    modelRoutes: [{ id: 'model-zenmux', provider: 'zenmux', model: 'deepseek/deepseek-v4-pro', displayName: 'ZenMux DeepSeek', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
    skills: [{ id: 'skill-cycle-time-calculate', name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }, { id: 'skill-gearjob-work-order-read', name: '工单读取', capabilityId: 'gearjob-work-order-read', enabled: true }],
    connections: [connectionValue],
    employees: [
      { id: 'employee-lead', name: '协调负责人', description: '汇总协作结果', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
      { id: 'employee-a', name: '工单核对员', description: '读取工单事实', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [connectionValue.id], skillIds: ['skill-gearjob-work-order-read'] },
      { id: 'employee-b', name: '节拍核对员', description: '检索知识并换算', enabled: true, modelRouteId: 'model-zenmux', connectionIds: [], skillIds: ['skill-cycle-time-calculate'] },
    ],
  }
}
