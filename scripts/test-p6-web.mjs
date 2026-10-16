import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script, createContext, runInContext } from 'node:vm'
import { correlationFixture, connection, now } from './fixtures/kivo-device-correlation.mjs'
import { createActionService } from '../src/action-service.mjs'

assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--harness-check', 'pure checks only; optional --harness-check')
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const definitions = script.slice(script.indexOf('    const titles='), script.indexOf("    el('login-form').onsubmit="))
const cap = 'kivo-tpm-device-correlate', skill = 'skill-' + cap, result = { id: 'result-a', kind: 'kivo.tpm.device-correlation', input: { recordType: 'repair', reference: 'R-1' }, payload: correlationFixture(), explanation: '程序核对同一设备的两类来源。' }
const work = { id: 'work-a', ownerMemberId: 'owner', employeeId: 'agent', skillId: skill, capabilityId: cap, connectionId: connection.id, status: 'completed', input: result.input, results: [result], actions: [], executions: [], requiredInputs: [], acceptedAt: now }
const domain = { members: [{ id: 'owner', enabled: true, employeeIds: ['agent'], role: 'member' }], employees: [{ id: 'agent', enabled: true, skillIds: [skill], connectionIds: [connection.id], modelRouteId: 'model', revision: 1 }], skills: [{ id: skill, capabilityId: cap, enabled: true }], modelRoutes: [{ id: 'model', enabled: true, provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY' }], connections: [connection], works: [structuredClone(work)] }
const store = { async read() { return structuredClone(domain) }, async update(mutate) { Object.assign(domain, await mutate(structuredClone(domain))) } }
const catalog = [Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].map(key => [key, connection[key]]))]
const actions = createActionService({ store, clock: () => now, connectionCatalog: catalog, adapter: { dispatch() { assert.fail('UI fixture must not dispatch') } } })
const preview = await actions.createPreview({ id: 'owner' }, work.id, { reason: '核对设备', description: '合成维修说明\n保留换行', clientRequestId: 'pure-preview' })
assert.equal(preview.intent.kind, 'kivo.tpm.repair.create')

function ui(current = { ...work, actions: [preview] }) {
  const nodes = new Map(), calls = [], timers = [], decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const attrs = value => Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(item => [item[1], decode(item[2] ?? '')]))
  const matches = (node, selector) => selector[0] === '.' ? node.className.split(/\s+/).includes(selector.slice(1)) : selector[0] === '#' ? node.id === selector.slice(1) : [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => Object.hasOwn(node.attributes, key) && (value === undefined || node.attributes[key] === value)) && selector.includes('[')
  let serial = 0, identifier = 0, document
  function element(id, attributes = {}, owner = null) {
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean))
    const node = { id, owner, attributes, dataset: Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])), value: attributes.value || '', disabled: Object.hasOwn(attributes, 'disabled'), textContent: '', selectionStart: 0, className: attributes.class || '', children: [], focus() { document.activeElement = this }, reset() {}, setAttribute(key, value) { this.attributes[key] = value }, removeAttribute(key) { delete this.attributes[key] }, setSelectionRange() {}, querySelectorAll(selector) { return [...nodes.values()].filter(value => matches(value, selector)) }, classList: { toggle(key, on = !classes.has(key)) { on ? classes.add(key) : classes.delete(key) }, contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) } }
    let content = ''
    Object.defineProperty(node, 'innerHTML', { get: () => content, set(value) {
      for (const [key, child] of nodes) if (child.owner === id) nodes.delete(key)
      content = value
      for (const match of value.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)) {
        const values = attrs(match[2]), key = values.id || 'anonymous-' + serial++, child = element(key, values, id)
        if (match[1] === 'textarea') child.value = decode(value.slice(match.index + match[0].length).split('</textarea>')[0])
        nodes.set(key, child)
      }
    } })
    nodes.set(id, node); return node
  }
  document = { activeElement: null, getElementById: id => nodes.get(id) || null, querySelectorAll: selector => [...nodes.values()].filter(node => matches(node, selector)), querySelector: selector => [...nodes.values()].find(node => matches(node, selector)) || null }
  document.body = element('body'); document.body.innerHTML = html.split('<script>')[0]
  const state = { session: { id: 'owner', displayName: '合成成员' }, csrf: 'pure-csrf', authEpoch: 1, workSelection: 1, currentWork: structuredClone(current), view: 'work', poll: null, planDrafts: {}, repairDrafts: {}, channels: { deliveries: [], workChannels: [], conversations: [], identities: [] }, channelApps: [], bootstrap: { employees: [{ id: 'agent', name: '关联员工', enabled: true, skillIds: [skill], connectionIds: [connection.id] }], connections: [connection], skills: [{ id: skill, name: '关联分析', capabilityId: cap, enabled: true }], capabilities: [{ id: cap, requiresConnection: true, connectionKind: 'kivo-mcp' }], works: [structuredClone(current)] } }
  let server = structuredClone(current), response
  const box = createContext({ state, document, structuredClone, URLSearchParams, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return Date.parse(now) } }, crypto: { randomUUID: () => 'ui-request-' + ++identifier }, setInterval: fn => { const timer = { fn }; timers.push(timer); return timer }, clearInterval() {}, setTimeout() {}, history: { replaceState() {} }, location: { search: '' }, fetch: async (path, options = {}) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body), call = { path, method: options.method || 'GET', body, headers: options.headers }; calls.push(call)
    if (response) { const value = await response(call); if (value !== undefined) return value }
    return { ok: true, json: async () => structuredClone(path === '/api/channels' ? state.channels : server) }
  } })
  runInContext(definitions, box)
  const run = code => runInContext(code, box), render = () => run('renderWork()'), posts = () => calls.filter(call => call.method === 'POST')
  render()
  return { box, state, document, nodes, calls, timers, run, render, posts, node: id => nodes.get(id), get server() { return server }, set server(value) { server = structuredClone(value) }, set response(value) { response = value }, choose(key, value) { const node = nodes.get('repair-' + key); node.value = value; node.oninput({ target: node }) } }
}
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) })
const plain = value => JSON.parse(JSON.stringify(value))
const event = { preventDefault() {} }
const checks = []

{
  const page = ui()
  assert.equal(page.run('tpmMode("kivo-tpm-device-correlate")'), 'correlation')
  const fields = page.run('tpmInputFields("work-tpm","correlation")')
  assert.match(fields, /record-type/); assert.match(fields, /reference/)
  for (const type of ['repair', 'maintenance', 'inspection']) assert.match(fields, new RegExp('value="' + type + '"'))
  for (const type of ['plan', 'device', 'exception']) assert.doesNotMatch(fields, new RegExp('value="' + type + '"'))
  page.node('work-tpm-fields').innerHTML = fields
  page.node('work-tpm-record-type').value = 'maintenance'; page.node('work-tpm-reference').value = 'M-2'
  assert.deepEqual(plain(page.run('readTpmInput("work-tpm","correlation")')), { recordType: 'maintenance', reference: 'M-2' })
  assert.match(page.run('continueFields({...state.currentWork,status:"waiting_input"})'), /continue-tpm-reference/)
  assert.match(page.node('work-detail').innerHTML, /data-correlation-result="result-a"/)
  for (const text of ['单据设备 UUID', '台账设备 UUID', '监控设备 UUID', '来源质量未提供', '来源接收时间未提供', '采样龄（本次查询）', '非源接收时间', '未判断逾期']) assert(page.node('work-detail').innerHTML.includes(text), text)
  for (const type of ['repair', 'maintenance', 'inspection']) {
    page.box.sample = { ...result, payload: correlationFixture({ recordType: type }) }; assert.match(page.run('resultCard(sample)'), /设备关联/)
  }
  page.box.sample = { ...result, payload: correlationFixture({ sampleAt: '2026-10-16T09:55:00.000Z' }) }
  assert.match(page.run('resultCard(sample)'), /采样已陈旧/); page.state.currentWork.results = [page.box.sample]; assert.equal(page.run('repairControls(state.currentWork).preview'), false)
  page.box.sample = { ...result, payload: correlationFixture({ sampleAt: '2026-10-16T10:00:06.000Z' }) }; page.state.currentWork.results = [page.box.sample]; assert.equal(page.run('repairControls(state.currentWork).preview'), false)
  page.box.sample = { ...result, payload: correlationFixture({ monitor: { current: { status: 'empty', trusted: false, recordTs: null, snapshot: null } } }) }; page.state.currentWork.results = [page.box.sample]
  assert.equal(page.run('repairControls(state.currentWork).preview'), false); assert.match(page.run('resultCard(sample)'), /报警事实未知/); assert.match(page.run('resultCard(sample)'), /缺少采样时间/)
  const unsafe = structuredClone(result); unsafe.payload.device.name = '<img src=x onerror=alert(1)>'; page.box.sample = unsafe
  assert.match(page.run('resultCard(sample)'), /&lt;img/); assert.doesNotMatch(page.run('resultCard(sample)'), /<img/)
  checks.push('typed-correlation-input-source-time-unknown-escaping')
}
{
  const start = script.indexOf("    el('work-form').onsubmit="), end = script.indexOf("    el('knowledge-file').onchange=", start)
  assert(start > 0 && end > start)
  for (const type of ['repair', 'maintenance', 'inspection']) {
    const page = ui(); page.state.view = 'home'; page.node('work-employee').value = 'agent'; page.node('work-skill').value = skill; page.node('work-mode').value = 'single'; page.run('updateCreateOptions()')
    page.node('work-connection').value = connection.id; page.node('work-tpm-record-type').value = type; page.node('work-tpm-reference').value = type + '-explicit'
    page.run('reloadAll=async()=>{};openWork=async id=>{globalThis.openedWork=id}')
    page.response = async call => call.method === 'POST' ? response({ ...work, id: 'new-work' }) : undefined
    runInContext(script.slice(start, end), page.box); await page.node('work-form').onsubmit(event)
    assert.equal(page.posts().length, 1); assert.equal(page.posts()[0].path, '/api/works'); assert.deepEqual(page.posts()[0].body.input, { recordType: type, reference: type + '-explicit' }); assert.equal(page.posts()[0].body.connectionId, connection.id); assert.equal(page.posts()[0].body.capabilityId, cap); assert.equal(page.box.openedWork, 'new-work')
  }
  const page = ui({ ...work, status: 'waiting_input', input: { recordType: 'repair' }, results: [], actions: [] })
  page.node('continue-tpm-record-type').value = 'inspection'; page.node('continue-tpm-reference').value = 'INS-explicit'
  page.run('reloadAll=async()=>{};const originalRunWorkAction=runWorkAction;runWorkAction=(operation,body)=>globalThis.lastContinue=originalRunWorkAction(operation,body)')
  page.node('continue-form').onsubmit(event); await page.box.lastContinue
  assert.match(page.posts()[0].path, /\/continue$/); assert.deepEqual(page.posts()[0].body.input, { recordType: 'inspection', reference: 'INS-explicit' })
  checks.push('ordinary-work-and-continue-actual-submit')
}
{
  const page = ui(); page.node('repair-open').onclick(); page.choose('reason', '本地原因'); page.choose('description', '本地描述\n第二行')
  assert.equal(page.posts().length, 0); assert.equal(page.run('repairControls(state.currentWork,state.currentWork.actions[0]).approve'), false)
  page.render(); assert.equal(page.node('repair-reason').value, '本地原因'); assert.equal(page.node('repair-description').value, '本地描述\n第二行')
  page.node('repair-close').onclick(); assert.equal(page.posts().length, 0)
  page.run('openRepairEditor(state.currentWork.actions[0].id)'); assert.equal(page.node('repair-description').value, preview.preview.payload.description)
  page.run('closeRepairEditor()'); await page.node('repair-refresh').onclick(); assert.equal(page.posts().length, 0)
  page.run('openRepairEditor()'); page.choose('reason', '轮询草稿'); page.choose('description', '不能被刷新覆盖')
  page.state.currentWork.status = 'running'; page.server = page.state.currentWork; page.run('startPolling()'); await page.timers.at(-1).fn()
  assert.equal(page.node('repair-reason').value, '轮询草稿'); assert.equal(page.node('repair-description').value, '不能被刷新覆盖')
  page.run('showLogin()'); assert.deepEqual(Object.keys(page.state.repairDrafts), []); assert.equal(page.node('work-detail').innerHTML, ''); assert.equal(page.posts().length, 0)
  checks.push('local-close-reopen-readonly-refresh-poll-draft')
}
{
  const page = ui(); page.node('repair-open').onclick(); page.choose('reason', '  Unicode 维修🛠  '); page.choose('description', '说明\n\t补充')
  let release
  page.response = async call => { if (call.method !== 'POST') return; await new Promise(done => { release = done }); const saved = { ...structuredClone(preview), id: 'action-new', preview: { ...structuredClone(preview.preview), payload: { ...preview.preview.payload, reason: call.body.reason, description: call.body.description } } }; page.server.actions.push(saved); return response(saved) }
  const first = page.run('submitRepair("preview")'); await page.run('submitRepair("preview")'); assert.equal(page.posts().length, 1)
  const body = page.posts()[0].body; assert.deepEqual(Object.keys(body).sort(), ['clientRequestId', 'description', 'reason']); assert.equal(body.reason, 'Unicode 维修🛠'); assert.equal(body.description, '说明\n\t补充'); assert.equal(page.posts()[0].headers['x-csrf-token'], 'pure-csrf')
  release(); await first; assert.equal(page.run('repairDraft(state.currentWork.id).open'), false); assert.match(page.node('repair-message').textContent || page.node('work-detail').innerHTML, /预览已保存/)
  page.run('openRepairEditor()'); page.choose('reason', 'x'.repeat(2001)); page.choose('description', 'safe'); await page.run('submitRepair("preview")'); assert.equal(page.posts().length, 1)
  page.choose('reason', 'bad\u0001'); await page.run('submitRepair("preview")'); assert.equal(page.posts().length, 1)
  checks.push('preview-whitelist-trim-unicode-local-validation-doubleclick')
}
{
  const page = ui(); let release
  page.response = async call => { if (call.method !== 'POST') return; await new Promise(done => { release = done }); const saved = { ...structuredClone(preview), decision: { kind: 'approved', decidedAt: now }, attempt: { preparedAt: now, unknownAt: now, unknownReason: 'UPSTREAM_TIMEOUT' } }; page.server.actions = [saved]; return response(saved) }
  const id = JSON.stringify(preview.id), first = page.run('submitRepair("approve",' + id + ')'); await page.run('submitRepair("approve",' + id + ')')
  assert.equal(page.posts().length, 1); assert.deepEqual(Object.keys(page.posts()[0].body).sort(), ['clientRequestId', 'expectedRevision', 'previewDigest']); assert.equal(page.posts()[0].body.previewDigest, preview.preview.digest); assert.equal(page.posts()[0].body.expectedRevision, preview.preview.expectedRevision)
  release(); await first; assert.match(page.node('work-detail').innerHTML, /创建结果待核对/); assert.match(page.node('work-detail').innerHTML, /再次核对/); assert.doesNotMatch(page.node('work-detail').innerHTML, /data-repair-operation="approve"/)
  assert.match(page.node('repair-message').className, /error/, 'HTTP 200 with unknown facts is not creation success')
  await page.run('submitRepair("approve",' + id + ')'); assert.equal(page.posts().length, 1)
  page.response = async call => call.method === 'POST' ? response(page.server.actions[0]) : undefined
  await page.run('submitRepair("reconcile",' + id + ')'); assert.deepEqual(page.posts()[1].body, {}); assert.match(page.posts()[1].path, /\/reconcile$/)
  assert.match(page.node('work-detail').innerHTML, /转人工核对/); assert.doesNotMatch(page.node('work-detail').innerHTML, /维修单已创建/)
  checks.push('approve-snapshot-singleflight-unknown-readonly-reconcile')
}
{
  for (const operation of ['reject', 'revoke']) {
    const action = structuredClone(preview); if (operation === 'revoke') action.decision = { kind: 'approved', decidedAt: now }
    const page = ui({ ...work, actions: [action] }); page.response = async call => { if (call.method !== 'POST') return; const saved = { ...action, decision: operation === 'reject' ? { kind: 'rejected', decidedAt: now } : { ...action.decision, invalidatedAt: now, invalidationReason: 'OWNER_REVOKED' } }; page.server.actions = [saved]; return response(saved) }
    await page.run('submitRepair(' + JSON.stringify(operation) + ',' + JSON.stringify(action.id) + ')'); assert.equal(page.posts().length, 1); assert.match(page.posts()[0].path, new RegExp('/' + operation + '$')); assert.equal(page.server.actions[0].attempt, null)
  }
  for (const status of [403, 409]) {
    const page = ui(); page.response = async call => call.method === 'POST' ? response({ error: { code: status === 403 ? 'FORBIDDEN' : 'REVISION_CONFLICT', message: 'safe error' } }, status) : undefined
    await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.match(page.node('work-detail').innerHTML, status === 403 ? /当前权限已失效/ : /来源事实已变化/); assert.doesNotMatch(page.node('work-detail').innerHTML, /维修单已创建/); assert.equal(page.posts().length, 1)
    await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.posts().length, 2); assert.equal(page.posts()[0].body.clientRequestId, page.posts()[1].body.clientRequestId, 'explicit retry keeps the same action request identity')
  }
  for (const change of ['agent', 'connection', 'skill']) { const page = ui(); if (change === 'agent') page.state.bootstrap.employees[0].enabled = false; if (change === 'connection') page.state.bootstrap.connections[0] = { ...connection, enabled: false }; if (change === 'skill') page.state.bootstrap.skills[0].enabled = false; await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.posts().length, 0) }
  for (const actor of ['peer', 'admin']) { const page = ui(); page.state.session.id = actor; page.render(); assert.equal(page.node('repair-open'), undefined); await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.posts().length, 0) }
  for (const change of ['rejected', 'revoked', 'invalidated', 'no-effect']) {
    const action = structuredClone(preview); action.decision = change === 'invalidated' ? { kind: 'approved', invalidatedAt: now } : { kind: change }
    if (change === 'no-effect') action.attempt = { preparedAt: now, noEffectAt: now, noEffectReason: 'CONFIRMED_NO_EFFECT' }
    const page = ui({ ...work, actions: [action] }); await page.run('submitRepair("approve",' + JSON.stringify(action.id) + ')'); assert.equal(page.posts().length, 0)
  }
  const expired = structuredClone(preview); expired.preview.expiresAt = now; const page = ui({ ...work, actions: [expired] }); await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.posts().length, 0); assert.match(page.node('work-detail').innerHTML, /预览已过期/)
  checks.push('reject-revoke-permission-conflict-expiry-no-create')
}
{
  for (const broken of ['json', 'empty', 'partial', 'different-action', 'different-intent', 'incomplete-receipt']) {
    const page = ui(), before = structuredClone(page.state.currentWork.actions)
    page.response = async call => {
      if (call.method !== 'POST') throw new TypeError('Failed to fetch')
      if (broken === 'json') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }
      return response(broken === 'empty' ? {} : broken === 'partial' ? { id: preview.id, intent: { kind: preview.intent.kind } } : { ...structuredClone(preview), ...(broken === 'different-action' ? { id: 'action-other' } : broken === 'different-intent' ? { intent: { kind: 'unexpected.action' } } : { receipt: {} }) })
    }
    await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')')
    assert.deepEqual(page.state.currentWork.actions, before, 'invalid response must not replace or append action facts')
    assert.equal(page.run('repairDraft("work-a").uncertainAction'), preview.id); assert.equal(page.node('repair-refresh').disabled, false)
    assert.equal(page.posts().length, 1); assert.equal(page.calls.filter(call => call.method === 'GET').length, 1, 'reject malformed POST facts before the normal follow-up GET')
    const requestId = page.posts()[0].body.clientRequestId
    for (const operation of ['approve', 'reject', 'revoke', 'preview']) await page.run('submitRepair(' + JSON.stringify(operation) + ',' + JSON.stringify(preview.id) + ')')
    assert.equal(page.posts().length, 1); assert.equal(page.run('Object.values(repairDraft("work-a").requests)[0]'), requestId)
    page.response = undefined; await page.run('submitRepair("refresh")'); assert.equal(page.run('repairDraft("work-a").uncertainAction'), preview.id, 'unchanged preview does not prove an unconfirmed approval had no effect')
    page.server.actions = [{ ...structuredClone(preview), decision: { kind: 'approved', decidedAt: now }, attempt: { preparedAt: now, unknownAt: now } }]
    await page.run('submitRepair("refresh")'); assert.equal(page.run('repairStatus(state.currentWork.actions[0])'), 'unknown'); assert.equal(page.posts().length, 1)
  }
  for (const broken of ['json', 'empty']) {
    const page = ui(), saved = { ...structuredClone(preview), decision: { kind: 'approved', decidedAt: now }, attempt: { preparedAt: now, unknownAt: now } }; let gets = 0
    page.response = async call => {
      if (call.method === 'POST') { page.server.actions = [saved]; return response(saved) }
      if (++gets === 1) return broken === 'empty' ? response({}) : { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }
      throw new TypeError('Failed to fetch')
    }
    await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.state.currentWork.id, work.id); assert.deepEqual(plain(page.state.currentWork.actions), [saved]); assert.equal(page.posts().length, 1); assert.match(page.node('work-detail').innerHTML, /创建结果待核对/)
  }
  for (const broken of ['json', 'empty']) {
    const page = ui(), before = structuredClone(page.state.currentWork.actions); let release, wrote = false
    page.response = async call => {
      if (call.method !== 'POST') { if (wrote) throw new TypeError('Failed to fetch'); return }
      await new Promise(done => { release = done }); wrote = true
      return broken === 'empty' ? response({}) : { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }
    }
    const pending = page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); page.run('show("works")'); await page.run('openWork("work-a")'); release(); await pending
    assert.deepEqual(page.state.currentWork.actions, before); assert.equal(page.run('repairDraft("work-a").uncertainAction'), preview.id); assert.equal(page.posts().length, 1); assert.equal(page.node('repair-refresh').disabled, false)
    await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')'); assert.equal(page.posts().length, 1)
  }
  const page = ui(); page.response = async () => ({ ok: true, status: 204, json: async () => assert.fail('204 does not have a JSON body') })
  assert.deepEqual(plain(await page.run('api("/api/session",{method:"DELETE",body:{}})')), {})
  page.response = async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError('truncated unauthorized body') } })
  await assert.rejects(page.run('api("/api/session")'), error => error.status === 401); assert.equal(page.state.session, null)
  checks.push('unconfirmed-json-and-action-facts-preserve-snapshot-readonly-204')
}
{
  for (const destination of ['same-work', 'other-work', 'auth']) {
    const page = ui(); let releaseWrite, releaseRead, notifyRead, wrote = false
    const readStarted = new Promise(done => { notifyRead = done })
    page.response = async call => {
      if (call.method === 'POST') {
        await new Promise(done => { releaseWrite = done })
        const saved = { ...structuredClone(preview), decision: { kind: 'approved', decidedAt: now }, attempt: { preparedAt: now, unknownAt: now, unknownReason: 'UPSTREAM_TIMEOUT' } }
        page.server.actions = [saved]; wrote = true; return response(saved)
      }
      if (wrote && call.path === '/api/works/work-a' && destination !== 'same-work') {
        const saved = structuredClone(page.server); notifyRead(); await new Promise(done => { releaseRead = done }); return response(saved)
      }
    }
    const pending = page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')')
    page.run('show("works")'); await page.run('openWork("work-a")'); assert.equal(page.node('repair-refresh').disabled, true)
    releaseWrite()
    if (destination === 'same-work') {
      await pending; assert.equal(page.run('repairDraft("work-a").pending'), false); assert.equal(page.node('repair-refresh').disabled, false, 'reopened work must leave its old busy rendering')
      assert.equal(page.run('repairStatus(state.currentWork.actions[0])'), 'unknown'); assert.match(page.node('work-detail').innerHTML, /data-repair-status="unknown"/)
      assert.equal(page.calls.filter(call => call.method === 'GET' && call.path === '/api/works/work-a').length, 2, 'reopen is followed by a current-lifecycle read')
    } else {
      await readStarted
      if (destination === 'other-work') { page.server = { ...work, id: 'work-b', actions: [] }; await page.run('openWork("work-b")') } else page.run('showLogin()')
      const before = structuredClone(page.state.currentWork); releaseRead(); await pending; assert.deepEqual(page.state.currentWork, before, 'refresh response must not overwrite a new work or auth lifecycle')
    }
    assert.equal(page.posts().length, 1, 'reopened lifecycle only refreshes with GET, never approves or retries')
  }
  checks.push('pending-leave-reopen-current-read-late-read-isolation')
}
{
  for (const change of ['work', 'selection', 'auth']) {
    const page = ui(); let release
    page.response = async call => { if (call.method !== 'POST') return; await new Promise(done => { release = done }); return response({ ...preview, decision: { kind: 'approved' }, attempt: { preparedAt: now, unknownAt: now } }) }
    const first = page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')')
    if (change === 'work') page.state.currentWork = { ...structuredClone(work), id: 'work-b', actions: [] }
    if (change === 'selection') page.state.workSelection++
    if (change === 'auth') { page.state.authEpoch++; page.state.repairDrafts = {} }
    const before = structuredClone(page.state.currentWork); release(); await first; assert.deepEqual(page.state.currentWork, before); assert.equal(page.calls.length, change === 'selection' ? 2 : 1)
  }
  const receipt = { ...structuredClone(preview), decision: { kind: 'approved', memberId: 'owner', previewDigest: preview.preview.digest, decidedAt: now }, attempt: { previewDigest: preview.preview.digest, preparedAt: now }, receipt: { previewDigest: preview.preview.digest, upstreamRecordId: '00000000-0000-4000-8000-000000000099', orderNo: preview.preview.payload.orderNo, deviceId: preview.preview.payload.deviceId, status: 'repairing', creation: { actorKind: 'machine', machineAccountId: connection.clientId, traceId: preview.id, revision: '0' }, currentRevision: '2', replayed: true, queriedAt: now, recordedAt: now } }
  const page = ui(); page.response = async call => { if (call.method !== 'POST') return; page.server.actions = [receipt]; return response(receipt) }
  await page.run('submitRepair("approve",' + JSON.stringify(preview.id) + ')')
  for (const text of ['维修单已创建', '0 / 2', '可能已经流转', '未新增第二张', receipt.receipt.upstreamRecordId, preview.preview.payload.orderNo]) assert(page.node('work-detail').innerHTML.includes(text), text)
  assert.doesNotMatch(page.node('work-detail').innerHTML, /data-repair-operation="(?:approve|reconcile)"/)
  const dedup = ui({ ...work, actions: [receipt, { ...structuredClone(preview), id: 'unrelated-preview' }] }); dedup.response = async call => call.method === 'POST' ? response(receipt) : undefined
  dedup.node('repair-open').onclick(); dedup.choose('reason', preview.preview.payload.reason); dedup.choose('description', preview.preview.payload.description); await dedup.run('submitRepair("preview")')
  assert.match(dedup.node('work-detail').innerHTML, /维修单已有可靠创建回执/, 'feedback follows the actual response action ID, not the last action')
  assert.match(html, /min-height:44px/); assert.match(html, /padding:23px 16px 136px/); assert.match(html, /repair-copy\{white-space:pre-wrap;overflow-wrap:anywhere\}/); assert.match(html, /for="repair-reason"/); assert.match(html, /id="repair-message" role="status" aria-live="polite"/)
  checks.push('late-response-work-selection-auth-receipt-mobile-markup')
}
const routes = [
  { id: 'route-glm', provider: 'zenmux', model: 'z-ai/glm-5.3-flash', displayName: '显式 GLM', credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens: 2048 }, enabled: true },
  { id: 'route-deepseek', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', displayName: '默认 DeepSeek', credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens: 4096 }, enabled: true }
]
const runtime = { modelRouteId: 'route-deepseek', provider: 'zenmux', model: routes[1].model, parameters: { maxOutputTokens: 4096 }, requestCount: 4, requestLimit: 4, startedAt: now, completedAt: now, durationMs: 0, usage: { inputTokens: 23, outputTokens: null, totalTokens: null, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null }, terminationReason: 'BUDGET_EXHAUSTED' }
const adminConfig = () => ({ members: [], employees: [], connections: [], skills: [], modelRoutes: structuredClone(routes), channelApps: [] })
{
  const page = ui(); page.state.admin = adminConfig(); page.box.route = routes[0]
  const create = page.run('modelRouteForm()'), edit = page.run('modelRouteForm(route)')
  page.box.reservedRoute = { ...routes[0], id: 'create' }; const combined = page.run('modelRouteForm(reservedRoute)') + create, ids = [...combined.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
  assert.equal(new Set(ids).size, ids.length, 'existing route create and new form must have distinct HTML IDs'); assert.match(combined, /data-id="create"/, 'business ID remains unchanged')
  for (const [, target] of combined.matchAll(/\sfor="([^"]+)"/g)) assert.equal(ids.filter(id => id === target).length, 1, 'each label resolves to exactly one control')
  assert.match(create, /value="deepseek\/deepseek-v4\.1-flash" selected/); assert.match(create, /value="z-ai\/glm-5\.3-flash"/)
  assert.match(create, /name="maxOutputTokens" type="number" min="1" max="4096" step="1" value="4096" required/)
  assert.match(edit, /value="z-ai\/glm-5\.3-flash" selected/); assert.match(edit, /name="maxOutputTokens"[^>]*value="2048"/)
  assert.match(page.run('employeeForm()'), /value="route-deepseek" selected/); assert.doesNotMatch(page.run('employeeForm()'), /value="route-glm" selected/)
  page.box.employee = { id: 'agent', name: '关联员工', modelRouteId: 'route-glm' }; assert.match(page.run('employeeForm(employee)'), /value="route-glm" selected/)
  page.state.admin.modelRoutes[0].enabled = false; assert.match(page.run('employeeForm(employee)'), /value="route-glm" selected disabled/)
  page.state.admin.modelRoutes = [routes[1]]; assert.match(page.run('employeeForm(employee)'), /value="route-glm" selected disabled>原模型路由已不可用/)
  page.run('loadAdmin=async()=>{};reloadAll=async()=>{}')
  for (const [id, model, maxOutputTokens] of [['', routes[0].model, 1], ['route-glm', routes[0].model, 4096]]) {
    page.box.form = { dataset: { kind: 'modelRoute', id }, elements: Object.fromEntries(Object.entries({ id: 'new-route', model, maxOutputTokens, displayName: '模型配置', provider: 'ignored', credentialRef: 'ignored' }).map(([key, value]) => [key, { value: String(value) }])) }; page.box.form.elements.enabled = { checked: true }
    page.response = async call => call.method !== 'GET' ? response({}) : undefined
    await page.run('saveAdminForm({preventDefault(){},currentTarget:form})')
    const saved = page.calls.at(-1); assert.equal(saved.path, '/api/admin/model-routes' + (id ? '/' + id : '')); assert.equal(saved.method, id ? 'PATCH' : 'POST')
    assert.deepEqual(saved.body, { provider: 'zenmux', model, displayName: '模型配置', enabled: true, credentialRef: 'ZENMUX_API_KEY', parameters: { maxOutputTokens }, ...(id ? {} : { id: 'new-route' }) })
  }
  const count = page.calls.length
  for (const value of ['0', '4097', '1.5', '']) { page.box.form.elements.maxOutputTokens.value = value; await page.run('saveAdminForm({preventDefault(){},currentTarget:form})') }
  page.box.form.elements.maxOutputTokens.value = '4096'; page.box.form.elements.model.value = 'unapproved/model'; await page.run('saveAdminForm({preventDefault(){},currentTarget:form})'); assert.equal(page.calls.length, count)
  checks.push('fixed-two-model-route-create-edit-output-range-explicit-employee-selection')
}
{
  const page = ui({ ...work, executions: [{ id: 'execution-a', operation: 'create', status: 'failed', runtime }, { id: 'legacy', operation: 'create', status: 'completed' }] })
  page.state.bootstrap.employees[0].modelRouteId = routes[0].id; page.render()
  const detail = page.node('work-detail').innerHTML
  assert.match(detail, /deepseek\/deepseek-v4\.1-flash/); assert.doesNotMatch(detail, /z-ai\/glm-5\.3-flash/); assert.match(detail, /请求 4 \/ 4/); assert.match(detail, /已达到请求预算/)
  assert.match(detail, /缓存读取 tokens<\/span><span>0<\/span>/); assert.match(detail, /耗时（毫秒）<\/span><span>0<\/span>/)
  assert.match(detail, /输出 tokens<\/span><span>未知<\/span>/); assert.match(detail, /总 tokens<\/span><span>未知<\/span>/); assert.match(detail, /未提供可信计费数据/); assert.match(detail, /data-runtime-unknown/)
  page.box.runtime = { ...runtime, requestCount: null, startedAt: null, completedAt: null, durationMs: null, terminationReason: null }; assert.match(page.run('runtimeFacts(runtime)'), /请求 未知 \/ 4/)
  page.state.conversationDrafts = {}; page.state.view = 'conversations'; page.state.currentConversation = { id: 'conversation-a', title: '本人对话', employeeId: 'agent', employeeName: '关联员工', historyStatus: 'available', turns: [{ id: 'turn-a', status: 'completed', userText: '本人问题', assistantText: '本人回复', runtime: { ...runtime, modelRouteId: routes[0].id, model: routes[0].model, requestCount: 1, requestLimit: 6, terminationReason: null } }], relatedWorks: [] }
  page.run('renderConversation()'); assert.match(page.node('conversation-turns').innerHTML, /z-ai\/glm-5\.3-flash/); assert.match(page.node('conversation-turns').innerHTML, /请求 1 \/ 6/)
  page.state.currentConversation.turns[0].runtime = null; page.run('renderConversation()'); assert.match(page.node('conversation-turns').innerHTML, /data-runtime-unknown/); assert.equal(page.calls.length, 0)
  checks.push('own-execution-and-turn-runtime-snapshots-null-unknown-known-zero-no-aggregation')
}
{
  const metadata = { capacity: { active: 2, limit: 4 }, executions: [{ workId: 'other-work-id', executionId: 'exec-id', employeeId: 'agent', status: 'failed', errorCode: 'BUDGET_EXHAUSTED', runtime, goal: 'PRIVATE_BODY_CANARY', input: { reference: 'PRIVATE_BODY_CANARY' }, result: 'PRIVATE_BODY_CANARY' }], turns: [{ conversationId: 'other-conversation-id', turnId: 'turn-id', employeeId: 'agent', status: 'completed', runtime: null, userText: 'PRIVATE_BODY_CANARY', assistantText: 'PRIVATE_BODY_CANARY' }] }
  const page = ui(); page.state.session.role = 'admin'; page.state.view = 'admin'; page.state.admin = adminConfig(); let release
  page.response = async call => { assert.equal(call.path, '/api/admin/runtime'); await new Promise(done => { release = done }); return response(metadata) }
  const pending = page.run('loadAdminRuntime()'); await page.run('loadAdminRuntime()'); assert.equal(page.calls.length, 1); assert.equal(page.node('refresh-admin-runtime').disabled, true)
  release(); await pending; const panel = page.node('config-runtime').innerHTML
  for (const value of ['2 / 4', 'other-work-id', 'exec-id', 'other-conversation-id', 'BUDGET_EXHAUSTED', runtime.model]) assert(panel.includes(value), value)
  assert.doesNotMatch(panel, /PRIVATE_BODY_CANARY|data-open-work|data-conversation-work/); assert.equal(page.node('refresh-admin-runtime').disabled, false); assert.equal(page.posts().length, 0)
  page.run('showLogin()'); assert.equal(page.node('config-runtime').innerHTML, '')
  for (const change of ['view', 'admin-object', 'role', 'auth']) {
    const current = ui(); current.state.session.role = 'admin'; current.state.view = 'admin'; const old = current.state.admin = adminConfig(); let finish
    current.response = async () => { await new Promise(done => { finish = done }); return response(metadata) }; const reading = current.run('loadAdminRuntime()')
    if (change === 'view') current.run('show("works")'); if (change === 'admin-object') current.state.admin = adminConfig(); if (change === 'role') current.state.session.role = 'member'; if (change === 'auth') current.run('showLogin()')
    finish(); await reading; assert.equal(old.runtime, undefined); assert.equal(old.runtimePending, false); assert.equal(current.posts().length, 0)
    if (change === 'view') { current.run('show("admin")'); assert.equal(current.node('refresh-admin-runtime').disabled, false) }
  }
  const member = ui(); member.state.admin = adminConfig(); member.state.view = 'admin'; await member.run('loadAdminRuntime()'); member.run('renderAdminRuntime()'); assert.equal(member.calls.length, 0); assert.equal(member.node('config-runtime').innerHTML, '')
  checks.push('admin-dedicated-metadata-endpoint-whitelist-singleflight-auth-navigation-isolation')
}
{
  const root = { ...work, id: 'root-a', workType: 'collaboration', results: [], actions: [], plan: { revision: 1, items: [{ id: 'step-a', goal: '核对设备', employeeId: 'agent', status: 'completed', childWorkId: work.id }] }, collaboration: { generation: 1, status: 'completed' }, executions: [{ id: 'root-exec', operation: 'collaboration-root', status: 'completed', runtime: { ...runtime, requestCount: 9, requestLimit: 12, terminationReason: null } }] }
  const child = { ...work, rootWorkId: root.id, workType: 'collaboration-child', planItemId: 'step-a', actions: [preview], executions: [{ id: 'child-exec', operation: 'collaboration-child', status: 'completed', runtime: { ...runtime, requestCount: 2, requestLimit: 6, terminationReason: null } }] }
  const page = ui(root); page.state.bootstrap.works = [root, child]; page.render(); assert.match(page.node('work-detail').innerHTML, /data-collaboration-item="step-a"/); assert.match(page.node('work-detail').innerHTML, /请求 9 \/ 12/); assert.doesNotMatch(page.node('work-detail').innerHTML, /id="repair-actions"/)
  page.response = async call => response(call.path.endsWith('/' + child.id) ? child : root)
  await page.document.querySelector('[data-open-work="' + child.id + '"]').onclick(); assert.equal(page.state.currentWork.id, child.id); assert.match(page.node('work-detail').innerHTML, /data-work-parent/); assert.match(page.node('work-detail').innerHTML, /id="repair-actions"/); assert.match(page.node('work-detail').innerHTML, /请求 2 \/ 6/)
  await page.document.querySelector('[data-open-work="' + root.id + '"]').onclick(); assert.equal(page.state.currentWork.id, root.id); assert.deepEqual(page.calls.map(call => call.path), ['/api/works/' + child.id, '/api/works/' + root.id]); assert.equal(page.posts().length, 0)
  for (const works of [[root], [root, { ...child, ownerMemberId: 'peer' }]]) { page.state.bootstrap.works = works; page.render(); assert.equal(page.document.querySelector('[data-open-work="' + child.id + '"]'), null) }
  page.state.currentWork = child; page.state.bootstrap.works = [{ ...root, ownerMemberId: 'peer' }, child]; page.render(); assert.equal(page.document.querySelector('[data-open-work="' + root.id + '"]'), null)
  page.state.currentWork = root; page.state.bootstrap.works = [root, child]; page.render(); let release
  page.response = async () => { await new Promise(done => { release = done }); return response(child) }; const opening = page.document.querySelector('[data-open-work="' + child.id + '"]').onclick(); page.run('show("works")'); release(); await opening; assert.equal(page.state.view, 'works'); assert.equal(page.state.currentWork.id, root.id); assert.equal(page.posts().length, 0)
  checks.push('collaboration-plan-child-action-parent-navigation-owner-scope-late-get-isolation')
}
console.log(JSON.stringify({ ok: true, checks, networkCalls: 0, browserRuns: 0, nativeRuns: 0, modelCalls: 0, runtimeVerified: false }))
