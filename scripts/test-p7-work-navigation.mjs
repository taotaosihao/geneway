import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { newConversationRecord } from '../src/conversation-service.mjs'
import { createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { connection, createCompletedCorrelationTree } from './fixtures/kivo-device-correlation.mjs'
import { connect, firstLine, freePort, poll } from './accept-p4-s1.mjs'
import { openP7Work, stopOwned, validateP7Environment } from './accept-p7.mjs'
import { environment } from '/home/gewu/.codex/workflow/artifacts/20260919-006-geneway-dsh-greenfield/p7-acceptance/j10-chrome-env-diagnostic02/environment.mjs'

await validateP7Environment(environment)
const temp = await mkdtemp(join(tmpdir(), 'geneway-work-navigation-')), authPath = join(temp, 'auth.json')
const store = createFileStore(join(temp, 'state.json')), origin = 'http://127.0.0.1:' + await freePort()
const at = new Date().toISOString(), capability = 'kivo-tpm-device-correlate', skill = 'skill-' + capability
const children = [], pages = [], checks = [], sessions = {}, requests = [], httpRequests = []
const testIdentity = await identity(process.pid)
let server, service, failure, modelCalls = 0, externalCalls = 0
const previousFetch = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  if (url.hostname !== '127.0.0.1') { externalCalls++; throw new Error('navigation test forbids external traffic') }
  assert(url.origin === origin || children.some(child => child.debugOrigin === url.origin), 'unexpected loopback target')
  return previousFetch(input, options)
}
const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
async function identity(pid) {
  const text = await readFile('/proc/' + pid + '/stat', 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/)
  return { pid, startTicks: fields[19], processGroupId: Number(fields[2]) }
}
async function launch(executable, args, extra = {}) {
  const child = spawn(executable, args, { env: environment, detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
  children.push(child); child.stderrText = ''
  child.stderr.on('data', chunk => { child.stderrText = (child.stderrText + chunk).slice(-3000) })
  child.on('error', error => { child.spawnError = error })
  child.identity = await identity(child.pid)
  return child
}
async function request(actor, path, method = 'GET', body) {
  const session = sessions[actor]
  requests.push({ actor, path, method })
  const response = await fetch(origin + path, { method, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') }
}
async function readWork(actor, id) { const result = await request(actor, '/api/works/' + encodeURIComponent(id)); assert.equal(result.status, 200); return result.body }
async function reload(page) {
  await page.front(); const before = await page.evaluate('performance.timeOrigin'); await page.send('Page.reload')
  await page.wait('performance.timeOrigin !== ' + before + ' && !document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
  await page.nav('works')
}
const open = (page, actor, id) => openP7Work(page, id, { readWork: id => readWork(actor, id), reload })
async function loginPage(page, actor) {
  await page.wait('Boolean(document.querySelector("#login-name"))')
  await page.fill('#login-name', actor); await page.fill('#login-password', actor + ' navigation password'); await page.click('#login-button')
  await page.wait('!document.querySelector("#app").classList.contains("hidden") && document.querySelector("#runtime-state").innerText.includes("已登录")')
  const session = await request(actor, '/api/session', 'POST', { loginName: actor, password: actor + ' navigation password' }); assert.equal(session.status, 200)
  sessions[actor] = { cookie: session.cookie.split(';')[0], csrf: session.body.csrfToken }
}
try {
  await store.update(state => {
    const next = { ...state,
      members: ['a', 'b', 'admin'].map(id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, sessionVersion: 1, employeeIds: ['leader', 'agent'] })),
      employees: ['leader', 'agent'].map(id => ({ id, name: id, enabled: true, revision: 1, instructions: '', skillIds: [skill, 'skill-cycle-time-calculate'], connectionIds: [connection.id], modelRouteId: 'model' })),
      skills: [{ id: skill, name: '设备关联', enabled: true, capabilityId: capability }, { id: 'skill-cycle-time-calculate', name: '节拍', enabled: true, capabilityId: 'cycle-time-calculate' }],
      modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }], connections: [connection],
    }
    next.conversations = [newConversationRecord(next, { id: 'a' }, { id: 'navigation-conversation', employeeId: 'leader' }, at)]
    return next
  })
  const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
  service = createWorkService({ store, connectionCatalog: catalog, runner: { configured: true, async run() { modelCalls++; assert.fail('navigation must not execute a model') }, async close() {} }, collaborationRunner: { async run() {}, async close() {} } })
  const tree = await createCompletedCorrelationTree({ store, workService: service, actor: { id: 'a' }, conversationId: 'navigation-conversation', leaderEmployeeId: 'leader', childEmployeeId: 'agent', at })
  const ordinary = {}
  for (const actor of ['a', 'b']) {
    const result = await service.createWork({ id: actor }, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60 }, clientRequestId: 'navigation-' + actor })
    assert(result.ok); ordinary[actor] = result.value.id
  }
  const baseline = await store.read(), counts = () => store.read().then(state => state.works.map(work => ({ id: work.id, actions: work.actions.length, executions: work.executions.length })))
  const before = await counts()
  await initializeAuthFile(authPath, Object.fromEntries(['a', 'b', 'admin'].map(id => [id, id + ' navigation password'])))
  server = createGenewayServer({ service, store, auth: createAuthRuntime({ filePath: authPath }), trustedOrigin: origin, index: await readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    conversationService: { async listConversations() { return [] } }, knowledge: { async listShareTargets() { return { members: [], employees: [] } }, async listMaterials() { return [] } }, collaborationRunner: { isKnowledgeEnabled: () => true } })
  server.on('request', req => httpRequests.push({ method: req.method, path: new URL(req.url, origin).pathname }))
  await new Promise((done, fail) => { server.once('error', fail); server.listen(new URL(origin).port, '127.0.0.1', done) })
  for (const actor of ['a', 'b', 'admin']) {
    const login = await request(actor, '/api/session', 'POST', { loginName: actor, password: actor + ' navigation password' }); assert.equal(login.status, 200)
    sessions[actor] = { cookie: login.cookie.split(';')[0], csrf: login.body.csrfToken }
  }
  for (const actor of ['b', 'admin']) for (const id of [tree.root.id, tree.child.id]) assert.equal((await request(actor, '/api/works/' + id)).status, 404)
  const xvfb = await launch('/usr/bin/Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
  const profile = join(temp, 'chrome'), port = await freePort()
  await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
  await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
  const child = await launch('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints', '--password-store=basic', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', '--app=' + origin], { env: { ...environment, DISPLAY: display } })
  child.debugOrigin = 'http://127.0.0.1:' + port
  const target = await poll(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('navigation Chrome failed: ' + child.stderrText); try { return (await (await fetch(child.debugOrigin + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith(origin)) } catch { return false } }, 'navigation Chrome', 20000)
  const page = await connect(target, () => false); pages.push(page)
  await loginPage(page, 'a')
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.viewport(width, height)
    await open(page, 'a', ordinary.a); await page.noOverflow()
    await open(page, 'a', tree.root.id); await page.noOverflow()
    await reload(page)
    assert.equal(await page.evaluate('document.querySelectorAll(' + JSON.stringify('#all-work-cards [data-open-work="' + tree.child.id + '"]') + ').length'), 0)
    await open(page, 'a', tree.child.id); await page.noOverflow()
    await open(page, 'a', tree.child.id)
    await reload(page); await open(page, 'a', tree.child.id)
    await open(page, 'a', ordinary.a); await open(page, 'a', tree.child.id)
    await page.click('#view-work.active [data-work-parent] [data-open-work="' + tree.root.id + '"]')
    await page.wait('state.currentWork?.id === ' + JSON.stringify(tree.root.id))
    await open(page, 'a', tree.child.id)
    await page.click('#repair-open'); await page.wait('Boolean(document.querySelector("#repair-form"))')
    await page.click('#repair-close'); await page.wait('!document.querySelector("#repair-form")')
    await page.click('#repair-open'); await page.wait('Boolean(document.querySelector("#repair-form"))'); await page.noOverflow()
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(temp, 'navigation-' + width + '.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
    await page.click('#repair-close'); assert.deepEqual(await counts(), before)
    checks.push({ width, height, oldChildSelectorMatches: 0, ordinaryRootChild: true, repeatedChild: true, reloadAndOtherDetail: true, backToRoot: true, repairOpenCancelReopenNoNewActions: true })
  }
  for (const change of [{ planItemId: 'wrong-item' }, { parentWorkId: 'wrong-root' }, { ownerMemberId: 'b' }]) {
    let clicks = 0
    await assert.rejects(openP7Work({ ...page, async click() { clicks++; assert.fail('wrong association must not click') } }, tree.child.id, { reload, async readWork(id) { const value = await readWork('a', id); return id === tree.child.id ? { ...value, ...change } : value } }))
    assert.equal(clicks, 0)
  }
  for (const actor of ['b', 'admin', 'a']) {
    await page.viewport(1440, 900); await page.click('#logout'); await page.wait('!document.querySelector("#login-shell").classList.contains("hidden")'); await loginPage(page, actor)
    if (actor === 'a') await open(page, actor, tree.child.id)
    else {
      let clicks = 0
      await assert.rejects(openP7Work({ ...page, async click() { clicks++ } }, tree.child.id, { readWork: id => readWork(actor, id), reload }))
      assert.equal(clicks, 0)
      await page.nav('works'); assert.equal(await page.evaluate('document.querySelectorAll(' + JSON.stringify('[data-open-work="' + tree.root.id + '"]') + ').length'), 0)
      if (actor === 'b') await open(page, actor, ordinary.b)
    }
    await page.noOverflow()
  }
  assert.deepEqual(page.errors, []); assert.equal(modelCalls, 0); assert.equal(externalCalls, 0)
  assert.deepEqual(await counts(), before)
  assert.deepEqual((await store.read()).works, baseline.works)
  assert.equal(requests.filter(item => item.method !== 'GET' && item.path !== '/api/session').length, 0)
  assert.equal(httpRequests.filter(item => item.method !== 'GET' && item.path !== '/api/session').length, 0)
} catch (error) { failure = error }
finally {
  for (const page of pages) page.socket.close()
  const cleanup = []
  for (const child of [...children].reverse()) {
    try { await stopOwned(child); assert(gone(child.pid) && gone(-child.pid)) } catch (error) { failure ??= error }
    cleanup.push({ ...child.identity, exitCode: child.exitCode, signalCode: child.signalCode, pidGone: gone(child.pid), groupGone: gone(-child.pid) })
  }
  if (server) await new Promise(done => server.close(done))
  await service?.close(); globalThis.fetch = previousFetch
  await rm(authPath, { force: true }); await rm(join(temp, 'chrome'), { recursive: true, force: true })
  const report = { ok: !failure, temp, testIdentity, serverClosed: !server?.listening, checks, cleanup, modelCalls, externalCalls, businessHttpWrites: httpRequests.filter(item => item.method !== 'GET' && item.path !== '/api/session').length, failure: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null }
  await writeFile(join(temp, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
  if (failure) process.exitCode = 1
}
