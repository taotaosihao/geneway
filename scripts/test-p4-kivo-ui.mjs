import assert from 'node:assert/strict'
import { createServer as createNodeServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Script, createContext, runInContext } from 'node:vm'
import { createAuthRuntime, initializeAuthFile } from '../src/auth.mjs'
import { getCapability, listCapabilities, parseCapabilityToolResult } from '../src/capabilities.mjs'
import { readConnectionCatalog } from '../src/connection-catalog.mjs'
import { normalizeTpmInput, normalizeTpmObservation, TPM_FILTERS, tpmSourcePath, tpmToolRequest } from '../src/domain/tpm.mjs'
import { createChannelRuntime, createGenewayServer } from '../src/server.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const index = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
const script = index.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const temp = await mkdtemp(join(tmpdir(), 'geneway-kivo-ui-'))
const now = '2026-10-15T14:00:00.000Z', read = 'kivo-tpm-record-read', list = 'kivo-tpm-record-list'
const deviceId = '00000000-0000-4000-8000-000000000001'
const connection = { id: 'kivo', name: '受控 Kivo', kind: 'kivo-mcp', targetIdentity: 'controlled-kivo', baseUrl: 'http://127.0.0.1:41001/api/v1/mes/mcp', issuer: 'http://127.0.0.1:41001', clientId: '00000000-0000-4000-8000-000000000003', credentialRef: 'machine.pem', allowedObjectIds: [], enabled: true, status: 'ready', revision: 1, skillIds: [read, list].map(id => 'skill-' + id), sourceSystem: 'Kivo', sourceInstance: 'controlled', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' }
const legacy = { id: 'legacy', name: '旧连接', kind: 'gearjob-rest', targetIdentity: 'old', baseUrl: 'http://127.0.0.1:41002', credentialRef: 'legacy-key', allowedObjectIds: ['WO-OLD'], enabled: true, status: 'ready', revision: 1, skillIds: ['skill-gearjob-work-order-read'], sourceSystem: 'GearJob', sourceInstance: 'old', sourceEnvironment: 'controlled-test', dataMode: 'synthetic', evidenceMode: 'controlled-domain' }
const caps = ['cycle-time-calculate', read, list, 'gearjob-work-order-read'].map(id => getCapability(id))
const skills = caps.map(cap => ({ id: cap.skillId, name: cap.id, capabilityId: cap.id, enabled: true }))
const employee = { id: 'agent', name: '查询员工', enabled: true, revision: 1, instructions: '', modelRouteId: 'model', skillIds: skills.map(item => item.id), connectionIds: [connection.id, legacy.id] }
const store = createFileStore(join(temp, 'state.json')), calls = []
let server, origin, service, scopeEmpty = false, tester
try {
  await checkStartup()
  const catalogFile = join(temp, 'targets.json')
  const target = value => Object.fromEntries(['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode'].filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  await writeFile(catalogFile, JSON.stringify({ version: 1, targets: [target(connection), { ...target(connection), credentialRef: 'machine-rotated.pem' }, target(legacy)] }), { mode: 0o600 })
  const catalog = await readConnectionCatalog(catalogFile, process.cwd())
  await store.update(state => ({ ...state, members: ['a', 'b', 'admin'].map(id => ({ id, loginName: id, displayName: id, role: id === 'admin' ? 'admin' : 'member', authRef: id, enabled: true, sessionVersion: 1, employeeIds: id === 'a' ? [employee.id, 'peer-agent'] : [] })), employees: [employee, { ...employee, id: 'peer-agent', name: '协作员工' }], skills, connections: [connection, legacy], modelRoutes: [{ id: 'model', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }] }))
  const runner = { configured: true, async run(options) {
    calls.push(structuredClone(options))
    const mode = options.capabilityId === read ? 'record' : 'list', observation = observe(mode, options.input, options.grant.connection, scopeEmpty)
    return { result: parseCapabilityToolResult(options.capabilityId, { ok: true, observation }, options.input), explanation: '受控查询结果', dshSessionRef: 'synthetic-session-' + calls.length, contextConfirmationRefs: options.sessionMetadata.confirmationRefs, continuity: 'new' }
  }, async cancel() { return true }, async close() {} }
  const collaborationCalls = []
  const collaborationRunner = { async run(id) { collaborationCalls.push(id); await store.update(state => ({ ...state, works: state.works.map(work => work.id === id && work.plan.items.every(item => item.status === 'waiting_input') ? { ...work, status: 'waiting_input', collaboration: { ...work.collaboration, status: 'waiting_input' }, executions: work.executions.map(execution => ({ ...execution, status: 'waiting_input', completedAt: now })) } : work) })) }, async cancel() { return true }, async close() {} }
  service = createWorkService({ store, runner, collaborationRunner, connectionCatalog: catalog, clock: () => now, connectionTester: (...args) => tester(...args) })
  const authFile = join(temp, 'auth.json')
  await initializeAuthFile(authFile, { a: 'a controlled password', b: 'b controlled password', admin: 'admin controlled password' })
  const probe = createNodeServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  origin = `http://127.0.0.1:${port}`
  server = createGenewayServer({ service, store, auth: createAuthRuntime({ filePath: authFile }), index, trustedOrigin: origin })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const a = await login('a'), b = await login('b'), admin = await login('admin')
  const bootstrap = await request('/api/bootstrap', { session: a })
  assert.equal(bootstrap.status, 200)
  const adminBootstrap = await request('/api/bootstrap', { session: admin })
  assert.equal(adminBootstrap.status, 200)
  for (const key of ['employees', 'connections', 'skills', 'works']) assert.deepEqual(adminBootstrap.body[key], [], 'unassigned admins have no member business scope')
  const adminSkills = await request('/api/admin/skills', { session: admin })
  assert.equal(adminSkills.status, 200)
  assert.deepEqual((await request('/api/bootstrap', { session: b })).body.capabilities, [], 'member capability metadata remains limited to assigned skills')
  assert.equal(calls.length, 0)
  await checkUi(bootstrap.body, adminBootstrap.body, adminSkills.body)
  assert.deepEqual(adminBootstrap.body.capabilities.map(item => item.id), listCapabilities().map(item => item.id), 'admins configure the fixed capability catalog without business grants')
  for (const capabilities of [bootstrap.body.capabilities, adminBootstrap.body.capabilities]) for (const capability of capabilities) {
    assert.equal(capability.connectionKind, getCapability(capability.id).connectionKind)
    assert.equal(capability.retired, getCapability(capability.id).retired)
  }
  const body = { employeeId: employee.id, skillId: getCapability(read).skillId, capabilityId: read, connectionId: connection.id, clientRequestId: 'partial-http', input: { recordType: 'repair' } }
  assert.equal((await request('/api/works', { method: 'POST', session: a, csrf: '', json: body })).status, 403)
  assert.equal((await request('/api/works', { method: 'POST', session: a, originHeader: 'http://evil.invalid', json: body })).status, 403)
  assert.equal((await request('/api/works', { method: 'POST', session: b, json: body })).status, 403)
  const beforeAdminCreate = await store.read()
  const adminCreate = await request('/api/works', { method: 'POST', session: admin, json: { ...body, clientRequestId: 'unassigned-admin', input: { recordType: 'repair', reference: 'R-1' } } })
  assert.equal(adminCreate.status, 403); assert.equal(adminCreate.body.error.code, 'FORBIDDEN')
  assert.deepEqual(await store.read(), beforeAdminCreate, 'static admin metadata does not grant execution or create facts')
  assert.equal(calls.length, 0)
  const missing = await request('/api/works', { method: 'POST', session: a, json: body })
  assert.equal(missing.status, 200)
  assert.equal(missing.body.status, 'waiting_input')
  assert.deepEqual(missing.body.requiredInputs, ['reference'])
  assert.equal(calls.length, 0, 'missing reference must not execute a query')
  const continued = await request('/api/works/' + missing.body.id + '/continue', { method: 'POST', session: a, json: { input: { reference: 'R-1' }, clientRequestId: 'continue-http' } })
  assert.equal(continued.status, 200)
  const completed = await waitWork(a, missing.body.id)
  assert.equal(completed.results[0].kind, 'kivo.tpm.observation')
  assert.equal(completed.results[0].payload.records[0].rawStatus, 'reported')
  assert.equal(completed.results[0].payload.linkedDevice.id, deviceId)
  assert.equal((await request('/api/works/' + missing.body.id, { session: admin })).status, 404, 'admin has no member work body privilege')
  assert.equal((await request('/api/works/' + missing.body.id, { session: b })).status, 404)
  const publicConnection = (await request('/api/bootstrap', { session: a })).body.connections.find(item => item.id === connection.id)
  for (const key of ['credentialRef', 'clientId', 'issuer', 'baseUrl']) assert.equal(publicConnection[key], undefined)
  for (const input of [{ recordType: 'repair', reference: 'R-1', tool: 'arbitrary' }, { recordType: 'repair', reference: '/api/arbitrary' }, { recordType: 'repair', filters: { query: 'arbitrary' } }, { recordType: 'repair', filters: { severity: 'blocking' } }, { recordType: '__proto__', filters: { page: 1 } }]) {
    const result = await request('/api/works', { method: 'POST', session: a, json: { ...body, capabilityId: list, skillId: getCapability(list).skillId, clientRequestId: 'invalid-' + JSON.stringify(input), input } })
    assert.equal(result.status, 400)
  }
  for (const extra of [{ toolName: 'tpm.repair.list' }, { ownerMemberId: 'b' }, { nativeSessionId: 'native' }, { credentialRef: 'machine.pem' }, { token: 'forbidden' }]) assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...body, ...extra } })).status, 400)
  const countBeforeRetired = calls.length
  assert.equal((await request('/api/works', { method: 'POST', session: a, json: { ...body, capabilityId: 'gearjob-work-order-read', skillId: 'skill-gearjob-work-order-read', connectionId: legacy.id, clientRequestId: 'retired-http', input: { workOrderId: 'WO-OLD' } } })).status, 409)
  assert.equal(calls.length, countBeforeRetired)
  const listBody = { ...body, capabilityId: list, skillId: getCapability(list).skillId, clientRequestId: 'list-http', input: { recordType: 'repair', filters: { page: 1, pageSize: 20, status: 'reported' } } }
  const listed = await request('/api/works', { method: 'POST', session: a, json: listBody })
  assert.equal(listed.status, 200)
  const normalZero = await waitWork(a, listed.body.id)
  assert.equal(normalZero.results[0].payload.status, 'ok')
  assert.equal(normalZero.results[0].payload.pagination.total, 0)
  const frozen = structuredClone(normalZero.results)
  scopeEmpty = true
  const scoped = await request('/api/works', { method: 'POST', session: a, json: { ...listBody, clientRequestId: 'scope-empty-http' } })
  const scopedWork = await waitWork(a, scoped.body.id)
  assert.equal(scopedWork.results[0].payload.status, 'scope_empty')
  assert.equal(scopedWork.results[0].payload.pagination, null)
  assert.deepEqual((await request('/api/works/' + normalZero.id, { session: a })).body.results, frozen)
  const collaborationBody = { employeeId: employee.id, skillId: getCapability(read).skillId, capabilityId: read, connectionId: connection.id, goal: '协作核对维修与维护依据', clientRequestId: 'collaboration-http', workType: 'collaboration', items: [
    { id: 'step-a', employeeId: employee.id, skillId: getCapability(read).skillId, capabilityId: read, connectionId: connection.id, goal: '读取维修事实', input: { recordType: 'repair' } },
    { id: 'step-b', employeeId: 'peer-agent', skillId: getCapability(read).skillId, capabilityId: read, connectionId: connection.id, goal: '结合维护标准读取计划', input: { recordType: 'plan' }, knowledgeQuery: '维护标准 合成关键词', dependsOn: ['step-a'] },
  ] }
  const collaborationCreated = await request('/api/works', { method: 'POST', session: a, json: collaborationBody })
  assert.equal(collaborationCreated.status, 200)
  const collaborationId = collaborationCreated.body.id
  await store.read() // Drain the controlled runner's waiting-input fixture transaction.
  const collaborative = (await request('/api/works/' + collaborationId, { session: a })).body
  assert.equal(collaborative.plan.items[1].employeeId, 'peer-agent')
  const patched = await request('/api/works/' + collaborationId + '/plan', { method: 'PATCH', session: a, json: { expectedRevision: 1, items: [{ id: 'step-b', goal: '按当前维护标准核对计划', employeeId: employee.id }] } })
  assert.equal(patched.status, 200); assert.equal(patched.body.plan.revision, 2)
  assert.equal((await request('/api/works/' + collaborationId + '/plan', { method: 'PATCH', session: a, json: { expectedRevision: 1, items: [{ id: 'step-b', goal: '旧草稿' }] } })).status, 409)
  assert.equal((await request('/api/works/' + collaborationId + '/continue', { method: 'POST', session: a, json: { clientRequestId: 'bad-reference', inputs: { 'step-a': { reference: 123 }, 'step-b': { reference: deviceId } } } })).status, 400)
  const resumed = await request('/api/works/' + collaborationId + '/continue', { method: 'POST', session: a, json: { clientRequestId: 'collaboration-continue', inputs: { 'step-a': { reference: 'R-1' }, 'step-b': { reference: deviceId } } } })
  assert.equal(resumed.status, 200)
  const childB = (await store.read()).works.find(item => item.parentWorkId === collaborationId && item.planItemId === 'step-b')
  assert.deepEqual(childB.input, { recordType: 'plan', reference: deviceId })
  assert.equal(childB.knowledgeQuery, '维护标准 合成关键词')
  assert.equal(collaborationCalls.length, 2)
  const config = { ...connection, id: 'new-kivo' }; delete config.status; delete config.revision
  assert.equal((await request('/api/admin/connections', { method: 'POST', session: a, json: config })).status, 403)
  assert.equal((await request('/api/admin/connections', { method: 'POST', session: admin, json: { ...config, privateKey: 'forbidden' } })).status, 400)
  const created = await request('/api/admin/connections', { method: 'POST', session: admin, json: config })
  assert.equal(created.status, 200)
  assert.equal(created.body.status, 'unknown')
  assert.equal(created.body.issuer, connection.issuer)
  assert.equal(created.body.clientId, connection.clientId)
  assert.deepEqual(created.body.allowedObjectIds, [])
  for (const patch of [{ issuer: 'http://different.invalid' }, { clientId: '00000000-0000-4000-8000-000000000099' }, { baseUrl: connection.baseUrl + '/' }, { allowedObjectIds: ['R-1'] }]) assert.equal((await request('/api/admin/connections/new-kivo', { method: 'PATCH', session: admin, json: patch })).status, 400)
  let io = 0
  tester = async (candidate, { authorize }) => { assert.equal(candidate.status, 'unknown'); await authorize(); io++; return 'MCP 2026-07-28；工具目录：11 项。目录成功不代表对象范围非空。' }
  const tested = await request('/api/admin/connections/new-kivo/test', { method: 'POST', session: admin, json: {} })
  assert.equal(tested.status, 200)
  assert.equal(tested.body.ok, true)
  assert.match(tested.body.detail, /2026-07-28/)
  assert.equal(io, 1)
  const rotated = await request('/api/admin/connections/new-kivo', { method: 'PATCH', session: admin, json: { credentialRef: 'machine-rotated.pem' } })
  assert.equal(rotated.body.status, 'unknown')
  assert.equal(rotated.body.revision, 2)
  tester = async (_candidate, { authorize }) => { await authorize(); io++; await store.update(state => ({ ...state, connections: state.connections.map(item => item.id === 'new-kivo' ? { ...item, enabled: false, revision: item.revision + 1 } : item) })); await authorize(); io++; return 'must not be ready' }
  assert.equal((await request('/api/admin/connections/new-kivo/test', { method: 'POST', session: admin, json: {} })).status, 403)
  assert.equal(io, 2, 'revoked connection must block the next controlled I/O')
  assert.notEqual((await store.read()).connections.find(item => item.id === 'new-kivo').status, 'ready')
  console.log('Kivo UI/API checks passed: real HTTP auth/CSRF/strict input/admin projection, controlled runner/tester, actual Web helpers and startup wiring; no native/model/upstream/browser acceptance')
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  await service?.close()
  await rm(temp, { recursive: true, force: true })
}

function between(source, start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return source.slice(a, b) }
function observe(mode, input, boundConnection = connection, emptyScope = false) {
  const source = { system: 'kivo', path: tpmSourcePath(tpmToolRequest(mode, input)), queriedAt: now, traceId: 'controlled-trace' }
  const record = { id: 'repair-id', orderNo: input.reference, deviceId, status: 'reported', assigneeDisplayName: '负责人甲', createdAt: '2026-10-15 08:00:00', updatedAt: now }
  return normalizeTpmObservation({ mode, input, connection: boundConnection, result: { status: emptyScope ? 'scope_empty' : 'ok', source, value: emptyScope ? null : mode === 'record' ? record : { page: input.filters.page ?? 1, pageSize: input.filters.pageSize ?? 20, total: 0, items: [] } }, ...(mode === 'record' && !emptyScope ? { deviceResult: { status: 'ok', source: { ...source, path: '/api/v1/mes/equipment/ledger/devices/' + deviceId }, value: { id: deviceId, name: '设备甲', lifecycleStatus: 'active' } } } : {}) })
}
async function login(name) { const result = await request('/api/session', { method: 'POST', originHeader: origin, json: { loginName: name, password: name + ' controlled password' } }); assert.equal(result.status, 200); return { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken } }
async function request(path, { method = 'GET', session, json, csrf, originHeader } = {}) {
  const headers = {}; if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = csrf ?? session.csrf }; if (originHeader || session) headers.origin = originHeader ?? origin; if (json !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(origin + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), text = await response.text()
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
}
async function waitWork(session, id) { for (let attempt = 0; attempt < 200; attempt++) { const response = await request('/api/works/' + id, { session }); assert.equal(response.status, 200); if (response.body.status === 'failed') assert.fail(JSON.stringify(response.body.executions.at(-1).error)); if (response.body.status === 'completed') return response.body; await new Promise(resolve => setTimeout(resolve, 2)) }; assert.fail('controlled work did not complete') }

async function checkUi(bootstrap, adminBootstrap, adminSkills) {
  const elements = new Map(), calls = []
  function node(id) {
    if (elements.has(id)) return elements.get(id)
    const classes = new Set(), item = { id, value: '', dataset: {}, disabled: false, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name) }, add(name) { classes.add(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } }, focus() { box.document.activeElement=item }, reset() {}, querySelector() { return null }, contains(other) { for(let parent=other?.parent;parent;parent=parent.parent)if(parent===item)return true;return false }, querySelectorAll(selector) { return selector==='input[id],select[id]'?[...elements.values()].filter(child=>item.contains(child)&&['input','select'].includes(child.tag)):[] } }
    let html = ''
    Object.defineProperty(item, 'innerHTML', { get: () => html, set(value) { html = value; for (const child of [...elements.values()]) if(item.contains(child))elements.delete(child.id)
      const stack=[{tag:'',parent:item}]
      for (const match of value.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/g)) {
        const [,closing,tag,attrs]=match
        if(stack.at(-1).tag==='script'&&!(closing&&tag==='script'))continue
        if(closing){const last=stack.findLastIndex(entry=>entry.tag===tag);if(last>0)stack.length=last;continue}
        const childId=attrs.match(/\bid="([^"]+)"/)?.[1],parent=stack.at(-1).parent,child=childId?node(childId):null
        if(!['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(tag))stack.push({tag,parent:child||parent})
        if(!child)continue
        child.parent=parent;child.tag=tag;const content=tag==='select'?value.slice(match.index+match[0].length,value.indexOf('</select>',match.index)):'';child.disabled=/\bdisabled\b/.test(attrs)
        if (tag === 'select') { const options = [...content.matchAll(/<option value="([^"]*)"([^>]*)>/g)]; child.value = (options.find(option => /\bselected\b/.test(option[2])) ?? options[0])?.[1] ?? '' }
        else child.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? ''
      }
    } })
    elements.set(id, item); return item
  }
  const state = { authEpoch: 1, view: 'work', session: bootstrap.member, bootstrap: structuredClone(bootstrap), admin: { skills: structuredClone(adminSkills) }, workConversation: null, conversations: [], channels: { deliveries: [] }, knowledge: [], planDrafts: {}, currentWork: null }
  node('fixture').innerHTML = index
  node('work-form').reset=()=>{node('work-mode').value='single';for(const id of ['work-tpm-fields','collab-a-tpm-fields','collab-b-tpm-fields']){node(id).innerHTML='';delete node(id).dataset.mode}}
  const box = createContext({ state, document: { getElementById: id => elements.get(id) ?? null, querySelectorAll: () => [] }, structuredClone, Date: new Proxy(Date, { get(target, key) { if(key==='now')return ()=>{throw new Error('stored TPM facts must not be recomputed from current time')};return target[key] } }), crypto: { randomUUID: () => 'ui-request' }, setMessage() {}, renderWorkConversationLink() {}, workChannelPanel: () => '', bindDeliveryActions() {}, api: async (...args) => { calls.push(args) }, loadAdmin: async () => {}, reloadAll: async () => {}, show: view => { state.view = view }, requestId: () => 'ui-request' })
  runInContext(between(script, '    function checks(', '    function renderAdmin(') + between(script, '    const titles=', '    async function api(') + between(script, '    function renderWorkConversationContext(', '    function workName(') + between(script, '    function tpmRecordCard(', '    function currentPlanDraft(') + between(script, '    function currentPlanDraft(', '    function focusAfterContinue(') + between(script, '    function connectionForm(', '    function renderConnections(') + between(script, '    async function saveAdminForm(', '    async function testConnection('), box)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(tpmFilterKeys)', box)), TPM_FILTERS)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(capabilitiesFor(state.bootstrap.employees[0]).map(item=>item.capability.id))', box)), ['cycle-time-calculate', read, list])
  node('work-tpm-fields')
  runInContext("document.getElementById('work-tpm-fields').innerHTML=tpmInputFields('work-tpm','list',{recordType:'inspection',filters:{page:2,pageSize:20,status:'pending',tab:'overdue'}})", box)
  let input = JSON.parse(runInContext("JSON.stringify(readTpmInput('work-tpm','list'))", box))
  assert.deepEqual(normalizeTpmInput('list', input).input, { recordType: 'inspection', filters: { page: 2, pageSize: 20, status: 'pending', tab: 'overdue' } })
  assert.equal(elements.has('work-tpm-reference'), false)
  runInContext("document.getElementById('work-tpm-fields').innerHTML=tpmInputFields('work-tpm','record',{recordType:'plan',reference:'00000000-0000-4000-8000-000000000001'})", box)
  input = JSON.parse(runInContext("JSON.stringify(readTpmInput('work-tpm','record'))", box))
  assert.equal(normalizeTpmInput('record', input).ok, true)
  const normal = { id: 'zero', kind: 'kivo.tpm.observation', input: { recordType: 'repair', filters: {} }, payload: observe('list', { recordType: 'repair', filters: {} }), createdAt: now, source: connection }
  box.result = normal
  const zeroHtml = runInContext('tpmResultCard(result)', box)
  assert.match(zeroHtml, /当前条件下没有记录/); assert.doesNotMatch(zeroHtml, /对象范围为空/)
  box.result = { ...normal, payload: observe('list', normal.input, connection, true) }
  assert.match(runInContext('tpmResultCard(result)', box), /机器账号当前没有可用对象范围/)
  box.result = { ...normal, input: { recordType: 'repair', reference: 'R-1' }, payload: observe('record', { recordType: 'repair', reference: 'R-1' }) }
  const html = runInContext('tpmResultCard(result)', box)
  for (const value of ['reported', '已报修', '负责人甲', '2026-10-15 08:00:00', '无计划基线，未判断逾期', '部分来源时间缺少明确时区', 'controlled-trace']) assert.ok(html.includes(value), value)
  assert.match(runInContext('connectionForm()', box), /name="issuer"/)
  assert.match(runInContext('connectionForm()', box), /name="clientId"/)
  assert.match(runInContext('connectionForm()', box), /对象范围由Kivo机器账号控制/)
  for (const capability of [read, list]) assert.match(runInContext('connectionForm()', box), new RegExp('name="skillIds" value="skill-' + capability + '"'), 'HTTP bootstrap must retain TPM Skill choices in the connection form')
  state.bootstrap = structuredClone(adminBootstrap)
  for (const capability of [read, list]) assert.match(runInContext('connectionForm()', box), new RegExp('name="skillIds" value="skill-' + capability + '"'), 'unassigned admin HTTP bootstrap must support configuration Skill choices')
  state.bootstrap = structuredClone(bootstrap)
  assert.doesNotMatch(runInContext('connectionForm()', box), /name="(?:allowedObjectIds|hostHeader|privateKey|token)"/)
  box.connection = connection; box.legacy = legacy
  assert.match(runInContext('connectionForm(connection)', box), /name="baseUrl"[^>]*readonly/)
  assert.doesNotMatch(runInContext('connectionForm(legacy)', box), /admin-form|data-test-connection/)
  assert.match(runInContext('connectionForm(legacy)', box), /data-disable-connection/)
  const form = { dataset: { kind: 'connection', id: '' }, elements: Object.fromEntries(Object.entries({ ...connection, enabled: true }).map(([key, value]) => [key, { value, checked: value === true }])), querySelectorAll: () => connection.skillIds.map(value => ({ value })) }
  box.form = form
  runInContext(between(script, '    function selected(', '    function renderAdmin('), box)
  await runInContext('saveAdminForm({preventDefault(){},currentTarget:form})', box)
  assert.equal(calls[0][0], '/api/admin/connections')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), { name: connection.name, kind: 'kivo-mcp', targetIdentity: connection.targetIdentity, baseUrl: connection.baseUrl, credentialRef: connection.credentialRef, issuer: connection.issuer, clientId: connection.clientId, allowedObjectIds: [], sourceSystem: connection.sourceSystem, sourceInstance: connection.sourceInstance, sourceEnvironment: connection.sourceEnvironment, dataMode: connection.dataMode, evidenceMode: connection.evidenceMode, enabled: true, skillIds: connection.skillIds, id: connection.id })
  for (const id of ['work-detail', 'work-retired-note', 'work-sub']) node(id)
  box.workName = () => '历史工作'; box.nextStep = () => '只读历史'
  state.currentWork = { id: 'old-work', retired: true, capabilityId: 'gearjob-work-order-read', employeeId: employee.id, skillId: legacy.skillIds[0], connectionId: legacy.id, status: 'running', input: { workOrderId: 'WO-OLD' }, results: [], executions: [] }
  runInContext('renderWork()', box)
  assert.doesNotMatch(node('work-detail').innerHTML, /id="(?:refresh-work|continue-form|follow-form)"/)
  assert.equal(node('cancel-work').disabled, false)
  assert.equal(node('work-retired-note').classList.contains('hidden'), false)
  // Drive the rendered work link through the actual navigation and result helpers.
  const navigationWork = { id: 'work/navigation', employeeId: employee.id, skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: '打开已保存工作', status: 'completed', retired: false, input: { availableSeconds: 120, quantity: 2 }, results: [{ id: 'navigation-result', kind: 'manufacturing.takt', payload: { availableSeconds: 120, quantity: 2, secondsPerUnit: 60, unit: 'seconds/unit' }, createdAt: now }], executions: [] }
  const navigationLinks = [], navigationHistory = [], previousApi = box.api
  state.bootstrap.works = [navigationWork]; state.workSelection = 0; state.conversationReadRequest = 0; state.view = 'works'
  box.document.querySelectorAll = selector => selector === '.page' ? [...elements.values()].filter(item => item.id.startsWith('view-')) : selector === '[data-open-work]' ? navigationLinks : []
  box.document.querySelector = selector => { assert.equal(selector, '.content'); return node('content') }
  box.URLSearchParams = URLSearchParams; box.history = { replaceState(_state, _title, path) { navigationHistory.push(path) } }
  box.api = async path => { assert.equal(path, '/api/works/work%2Fnavigation'); return structuredClone(navigationWork) }
  runInContext(between(script, '    function workName(', '    function renderEmployees(') + between(script, '    function show(', '    async function routeFromUrl(') + between(script, '    async function createDelivery(', '    function sourceCard(') + between(script, '    function startPolling(', '    function startChannelPolling(') + between(script, '    function stopPolling(', '    function confirmationCard('), box)
  runInContext('renderWorkLists()', box)
  const workLink = node('all-work-cards').innerHTML.match(/data-open-work="([^"]+)"/)
  assert.equal(workLink?.[1], navigationWork.id)
  navigationLinks.push({ dataset: { openWork: workLink[1] } }); runInContext('bindWorkLinks()', box)
  await navigationLinks[0].onclick()
  assert.equal(state.currentWork.id, navigationWork.id); assert.equal(state.view, 'work')
  assert.equal(node('view-work').classList.contains('active'), true)
  assert.match(node('work-detail').innerHTML, /60 秒\/件/)
  assert.equal(navigationHistory.at(-1), '?view=work&work=work%2Fnavigation')
  box.api = previousApi
  assert.ok(index.includes('id="quantity"') && index.includes('id="available-seconds"'))
  assert.doesNotMatch(index, /id="(?:automation-form|new-automation|gearjob-input)"/)
  // Drive the existing collaborative form helpers, then the real continuation handler.
  for(const prefix of ['collab-a','collab-b']){node(prefix+'-employee').value=employee.id}
  node('work-employee').value=employee.id;node('work-mode').value='collaboration';runInContext('updateCreateOptions()',box)
  node('work-skill').value=getCapability(read).skillId;node('collab-a-skill').value=getCapability(read).skillId;node('collab-b-skill').value=getCapability(read).skillId;runInContext('updateCreateOptions()',box)
  for (const prefix of ['collab-a', 'collab-b']) assert.match(node(prefix+'-connection').innerHTML, /value="kivo"/, 'HTTP bootstrap must retain the authorized TPM connection in each collaborative card')
  for(const prefix of ['collab-a','collab-b']){node(prefix+'-connection').value=connection.id;node(prefix+'-tpm-record-type').value=prefix==='collab-a'?'repair':'plan';node(prefix+'-tpm-reference').value=prefix==='collab-a'?'R-1':deviceId}
  node('collab-b-knowledge-query').value='维护标准 合成关键词';node('collab-b-depends-on-a').checked=true;node('work-connection').value=connection.id;node('work-goal').value='协作核对维修与维护标准'
  const itemA=JSON.parse(runInContext("JSON.stringify(readCollaborationItem('collab-a','step-a'))",box)),itemB=JSON.parse(runInContext("JSON.stringify(readCollaborationItem('collab-b','step-b'))",box))
  assert.deepEqual(itemA.input,{recordType:'repair',reference:'R-1'});assert.deepEqual(itemB.input,{recordType:'plan',reference:deviceId});assert.equal(itemB.knowledgeQuery,'维护标准 合成关键词')
  runInContext(between(script,"    el('work-form').onsubmit=", "    el('knowledge-file').onchange="),box)
  state.view='home';box.openWork=async()=>{};calls.length=0;box.api=async(...args)=>{calls.push(args);return {id:'collaboration-created'}}
  await node('work-form').onsubmit({preventDefault(){}})
  const creation=JSON.parse(JSON.stringify(calls[0][1].body));assert.equal(creation.workType,'collaboration');assert.equal(creation.connectionId,connection.id);assert.deepEqual(creation.items[1].dependsOn,['step-a']);assert.equal(creation.input,undefined)
  const childA={id:'child-a',rootWorkId:'collaboration',planItemId:'step-a',employeeId:employee.id,skillId:getCapability(read).skillId,connectionId:connection.id,capabilityId:read,goal:'读取维修事实',status:'completed',input:itemA.input,requiredInputs:[],results:[],executions:[{status:'completed'}]}
  const childB={...childA,id:'child-b',planItemId:'step-b',goal:'结合维护标准核对计划',status:'waiting_input',input:{recordType:'plan'},requiredInputs:['reference'],executions:[]}
  const root={id:'collaboration',employeeId:employee.id,skillId:getCapability(read).skillId,connectionId:connection.id,capabilityId:read,workType:'collaboration',goal:'协作核对',status:'waiting_input',retired:false,collaboration:{status:'waiting_input',generation:1},plan:{revision:3,items:[{id:'step-a',childWorkId:childA.id,goal:childA.goal,employeeId:employee.id,status:'completed',dependsOn:[]},{id:'step-b',childWorkId:childB.id,goal:childB.goal,employeeId:employee.id,status:'waiting_input',dependsOn:['step-a']}]},results:[],executions:[],handoffs:[]}
  state.bootstrap.works=[root,childA,childB];state.currentWork=root;state.view='work';calls.length=0;box.runWorkAction=(action,body)=>calls.push({action,body});runInContext('renderWork()',box)
  assert.match(node('work-detail').innerHTML,/id="collaboration-input-step-b-reference"/)
  assert.doesNotMatch(node('work-detail').innerHTML,/id="collaboration-input-step-b-reference"[^>]*type="number"/)
  node('collaboration-input-step-b-reference').value=deviceId;node('collaboration-continue-form').onsubmit({preventDefault(){}})
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{action:'continue',body:{clientRequestId:'ui-request',inputs:{'step-b':{recordType:'plan',reference:deviceId}}}})
  calls.length=0;box.api=async(...args)=>{calls.push(args);return structuredClone(root)}
  await runInContext("savePlan(state.currentWork,{baseRevision:3,items:{'step-b':{goal:'按新维护标准核对',employeeId:'agent'}}})",box)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['/api/works/collaboration/plan',{method:'PATCH',body:{expectedRevision:3,items:[{id:'step-b',goal:'按新维护标准核对',employeeId:'agent'}]}}])
  await checkWorkPolling({box,state,node,bootstrap,root,children:[childA,childB]})
  // Pagination only pre-fills a new immutable query; it never issues a request.
  const pageResult={...normal,payload:{...normal.payload,pagination:{page:1,pageSize:20,total:21}}},pageWork={id:'paged',employeeId:employee.id,skillId:getCapability(list).skillId,connectionId:connection.id,capabilityId:list,status:'completed',retired:false,goal:'原列表查询'}
  box.pageResult=pageResult;box.pageWork=pageWork;calls.length=0;runInContext('prefillTpmPage(pageWork,pageResult,2)',box)
  assert.equal(calls.length,0);assert.equal(state.view,'home');assert.equal(node('work-mode').value,'single');assert.equal(node('work-tpm-page').value,'2');assert.deepEqual(pageResult.input,{recordType:'repair',filters:{}})
  console.log('Actual Web helper checks passed: real HTTP bootstrap feeds fixed TPM forms, connection Skill and collaborative connection choices, typed scope/time/status display, collaborative creation/plan/reference continuation, explicit new-query pagination, retired controls and live cycle selectors (VM DOM fixture; not browser acceptance)')
}

async function checkWorkPolling({box,state,node,bootstrap,root,children}) {
  const names=['api','reloadAll','openWork','runWorkAction','focusAfterContinue','setMessage','loadKnowledge','renderCreate','renderConversationCreateOptions','renderAutomations','renderEmployees','renderConfirmations','renderKnowledge','renderChannels','setInterval','clearInterval'],saved=Object.fromEntries(names.map(name=>[name,box[name]])),timers=new Map()
  let nextTimer=0
  const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
  const copy=value=>structuredClone(value),field=()=>node('collaboration-input-step-b-reference'),readInput=()=>JSON.parse(runInContext("JSON.stringify(readTpmInput('collaboration-input-step-b','record'))",box))
  box.setInterval=callback=>{const id=++nextTimer;timers.set(id,callback);return id};box.clearInterval=id=>timers.delete(id)
  for(const name of ['loadKnowledge','renderCreate','renderConversationCreateOptions','renderAutomations','renderEmployees','renderConfirmations','renderKnowledge','renderChannels'])box[name]=()=>{}
  runInContext(between(script,'    function setMessage(','    function showLogin(')+between(script,'    async function reloadAll(','    async function loadKnowledge(')+between(script,'    async function openWork(','    function sourceCard(')+between(script,'    function focusAfterContinue(','    function startPolling('),box)
  const setup=({listInput=false}={})=>{
    runInContext('stopPolling()',box);state.view='work';state.workSelection++;state.planDrafts={};state.channels={deliveries:[]};box.document.activeElement=null
    const current=copy(root);current.status='running';current.collaboration.status='running';current.plan.revision=1
    const latest=copy(current);latest.status='waiting_input';latest.collaboration.status='waiting_input';latest.plan.revision=2
    const waitingChildren=copy(children);if(listInput){waitingChildren[1].capabilityId=list;waitingChildren[1].input={recordType:'repair',filters:{page:1,pageSize:20}}}
    state.currentWork=current;state.bootstrap={...copy(bootstrap),works:[copy(current),...waitingChildren]};runInContext('renderWork()',box)
    const requests=[]
    let workResponse=()=>copy(latest),planResponse=()=>copy(latest),actionResponse=()=>copy(latest),bootstrapResponse=()=>({...copy(bootstrap),works:[copy(latest),...copy(waitingChildren)]})
    box.api=async(path,options)=>{
      requests.push(path)
      if(path==='/api/works/'+current.id+'/plan')return planResponse()
      if(path==='/api/works/'+current.id&&!options)return workResponse()
      if(['/continue','/recheck','/cancel'].some(action=>path==='/api/works/'+current.id+action))return actionResponse()
      if(path==='/api/bootstrap')return bootstrapResponse()
      if(path==='/api/channels')return {deliveries:[]}
      if(path==='/api/automations')return {rules:[],occurrences:[],eventSource:{}}
      if(path==='/api/confirmations'||path==='/api/channels/apps')return []
      throw new Error('unexpected controlled UI API '+path)
    }
    return {current,latest,requests,work:fn=>{workResponse=fn},plan:fn=>{planResponse=fn},action:fn=>{actionResponse=fn},bootstrap:fn=>{bootstrapResponse=fn}}
  }
  const save=()=>runInContext("(()=>{const draft=currentPlanDraft(state.currentWork);draft.items['step-b'].goal='本地计划草稿';draft.dirty=true;return savePlan(state.currentWork,draft)})()",box)
  try {
    for(const revision of [1,2]){
      const fixture=setup(),response=deferred(),patch=deferred();fixture.work(()=>response.promise);fixture.plan(()=>patch.promise);runInContext('startPolling()',box);const pending=timers.get(state.poll)()
      const saving=save();field().value='typed-during-save';patch.resolve(copy(fixture.latest));await saving;assert.equal(field().value,'typed-during-save')
      field().value=deviceId;const savedField=field();response.resolve(copy(revision===1?fixture.current:fixture.latest));await pending
      assert.equal(state.currentWork.plan.revision,2,'pre-save poll cannot overwrite the saved plan')
      assert.equal(field(),savedField,'even a same-revision invalidated poll cannot redraw the form');assert.equal(field().value,deviceId);assert.equal(state.poll,null)
    }
    let fixture=setup(),response=deferred();fixture.work(()=>response.promise);runInContext('startPolling()',box);let pending=timers.get(state.poll)()
    node('cancel-work').focus();node('collaboration-input-step-b-record-type').value='repair';node('collaboration-input-step-b-record-type').onchange();field().value='R-local';field().selectionStart=3;field().setSelectionRange=(start,end)=>{field().selectionStart=start;field().selectionEnd=end};field().focus()
    const progress=copy(fixture.current);progress.collaboration.requestCount=2;response.resolve(progress);await pending
    assert.equal(state.currentWork.collaboration.requestCount,2,'active progress still refreshes');assert.equal(timers.size,1)
    assert.deepEqual(readInput(),{recordType:'repair',reference:'R-local'});assert.match(node('collaboration-input-step-b-fields').innerHTML,/单号或明确 ID/);assert.equal(box.document.activeElement,field())
    // New server generations and selections never inherit the previous supplement.
    state.currentWork=copy(fixture.current);state.currentWork.collaboration.generation=2;state.bootstrap.works[2].input={reference:'SERVER-NEW'};runInContext('renderWork()',box)
    assert.equal(field().value,'SERVER-NEW');field().value='local-before-switch';state.workSelection++;runInContext('renderWork()',box);assert.equal(field().value,'SERVER-NEW')
    field().value='local-before-login';state.authEpoch++;runInContext('renderWork()',box);assert.equal(field().value,'SERVER-NEW')
    field().value='local-before-other-work';state.currentWork.id='other';state.bootstrap.works=state.bootstrap.works.map(work=>({...work,rootWorkId:work.rootWorkId?'other':undefined}));runInContext('renderWork()',box);assert.equal(field().value,'SERVER-NEW')
    fixture=setup({listInput:true});response=deferred();fixture.work(()=>response.promise);runInContext('startPolling()',box);pending=timers.get(state.poll)()
    node('collaboration-input-step-b-record-type').value='exception';node('collaboration-input-step-b-record-type').onchange();node('collaboration-input-step-b-severity').value='blocking';node('collaboration-input-step-b-page').value=''
    response.resolve(copy(fixture.current));await pending
    assert.equal(node('collaboration-input-step-b-record-type').value,'exception');assert.equal(node('collaboration-input-step-b-severity').value,'blocking');assert.equal(node('collaboration-input-step-b-page').value,'');assert.equal(box.document.getElementById('collaboration-input-step-b-deviceId'),null)
    for(const status of [503,409]){
      fixture=setup();const oldRead=deferred(),patch=deferred();fixture.work(()=>oldRead.promise);fixture.plan(()=>patch.promise);runInContext('startPolling()',box);const oldTimer=state.poll;pending=timers.get(oldTimer)()
      const saving=save();assert.equal(state.poll,null,'plan save suspends the current interval');field().value='during-save'
      oldRead.resolve(copy(fixture.current));await pending;assert.equal(field().value,'during-save','old reads stay invalid during save')
      fixture.work(()=>copy({...fixture.current,plan:{...fixture.current.plan,revision:2}}));patch.reject(Object.assign(new Error('保存失败'),{status}));await saving
      assert.ok(state.poll&&state.poll!==oldTimer,'failed save resumes polling for the same active work');assert.match(node('work-message').textContent,/保存失败/);assert.equal(field().value,'during-save')
      if(status===409)assert.match(node('work-detail').innerHTML,/本地草稿仍保留/)
      const resumed=timers.get(state.poll);await resumed();assert.equal(state.currentWork.plan.revision,2)
    }
    for(const action of ['continue','recheck','cancel']){
      fixture=setup();const read=deferred(),mutation=deferred(),refresh=deferred(),refreshStarted=deferred();fixture.work(()=>read.promise);fixture.action(()=>mutation.promise);fixture.bootstrap(()=>{refreshStarted.resolve();return refresh.promise});runInContext('startPolling()',box);pending=timers.get(state.poll)()
      field().value='old-generation-draft';const acting=runInContext("runWorkAction('"+action+"',{})",box)
      const next=copy(fixture.current);if(action==='cancel'){next.status='cancelled';next.collaboration.status='cancelled'}else next.collaboration.generation=2
      mutation.resolve(next);await refreshStarted.promise
      if(action!=='cancel')assert.notEqual(field().value,'old-generation-draft','new execution generation cannot inherit local supplement')
      if(action==='continue')assert.equal(box.document.activeElement,node('cancel-work'),'continue keeps its stop-control focus')
      read.resolve(copy(fixture.current));await pending;refresh.resolve({...copy(bootstrap),works:[copy(next),...copy(children)]});await acting
      assert.equal(state.currentWork.collaboration.generation,next.collaboration.generation,'pre-action poll cannot overwrite a new generation');assert.equal(state.currentWork.status,next.status,'pre-stop poll cannot reopen a stopped work')
    }
    fixture=setup();fixture.action(()=>{throw new Error('提交失败')});runInContext('startPolling()',box);const failedTimer=state.poll
    await runInContext("runWorkAction('continue',{})",box);assert.ok(state.poll&&state.poll!==failedTimer);assert.equal(node('work-message').textContent,'提交失败')
    for(const change of ['selection','login','view','work']){
      fixture=setup();response=deferred();fixture.work(()=>response.promise);runInContext('startPolling()',box);pending=timers.get(state.poll)();field().value='isolated-input'
      if(change==='selection')state.workSelection++
      if(change==='login')state.authEpoch++
      if(change==='view')state.view='home'
      if(change==='work')state.currentWork={...copy(fixture.current),id:'other'}
      const selected=state.currentWork;response.resolve(copy(fixture.latest));await pending
      assert.equal(state.currentWork,selected,'late poll must not cross '+change);assert.equal(field().value,'isolated-input')
    }
    for(const operation of ['plan','continue'])for(const change of ['selection','login','view','work']){
      fixture=setup();const patch=deferred();if(operation==='plan')fixture.plan(()=>patch.promise);else fixture.action(()=>patch.promise);const saving=operation==='plan'?save():runInContext("runWorkAction('continue',{})",box)
      if(change==='selection'){state.workSelection++;state.currentWork=copy(fixture.latest);state.currentWork.plan.revision=9;runInContext('renderWork()',box)}
      if(change==='login')state.authEpoch++
      if(change==='view')state.view='home'
      if(change==='work')state.currentWork={...copy(fixture.current),id:'other'}
      const selected=state.currentWork;patch.resolve(copy(fixture.latest));await saving
      assert.equal(state.currentWork,selected,'late '+operation+' response must not cross '+change);assert.equal(state.poll,null,'late operation must not restart another lifecycle')
    }
    // A completed single work already exposes its follow-up while bootstrap is pending.
    fixture=setup()
    const single={id:fixture.current.id,employeeId:root.employeeId,skillId:'skill-cycle-time-calculate',capabilityId:'cycle-time-calculate',goal:'普通节拍工作',status:'running',input:{availableSeconds:60,quantity:1},results:[],executions:[]},singleCompleted={...copy(single),status:'completed',results:[{id:'single-takt',kind:'manufacturing.takt',payload:{availableSeconds:60,quantity:1,secondsPerUnit:60,unit:'seconds/unit'},createdAt:now}]},singleRefresh=deferred(),singleRefreshStarted=deferred()
    state.currentWork=single;state.bootstrap.works=[copy(single)];runInContext('renderWork()',box)
    fixture.work(()=>copy(singleCompleted));fixture.bootstrap(()=>{singleRefreshStarted.resolve();return singleRefresh.promise});runInContext('startPolling()',box);pending=timers.get(state.poll)();await singleRefreshStarted.promise
    const followUp=node('follow-text');followUp.value='保留未提交的追问';followUp.focus();singleRefresh.resolve({...copy(bootstrap),works:[copy(singleCompleted)]});await pending
    assert.equal(node('follow-text'),followUp,'single terminal reload does not need another detail render');assert.equal(node('follow-text').value,'保留未提交的追问');assert.equal(fixture.requests.length,7);assert.equal(state.poll,null)
    // The last root response precedes the complete child snapshot in bootstrap.
    const observation=(id,type)=>({id,kind:'kivo.tpm.observation',payload:{mode:'record',recordType:type,status:'ok',records:[{id,reference:type==='plan'?deviceId:'R-1',rawStatus:type==='plan'?'active':'reported',status:type==='plan'?'active':'reported',statusLabel:type==='plan'?'启用':'已报修',schedule:{overdue:null,reason:'no_plan_baseline'}}],linkedDevice:null,pagination:null,queriedAt:now,sources:[]}})
    for(const change of [null,'selection','login','view','work','generation']){
      fixture=setup();fixture.current.collaboration.generation=2;fixture.current.plan.revision=2
      const a={...copy(children[0]),results:[observation('terminal-a','repair')]},b={...copy(children[1]),status:'running',results:[]}
      state.bootstrap.works=[copy(fixture.current),a,b];runInContext('renderWork()',box)
      const completed=copy(fixture.current);completed.status='completed';completed.collaboration.status='completed';completed.plan.items[1].status='completed';completed.results=[{id:'terminal-summary',kind:'assistant.collaboration-summary',explanation:'协作汇总已保存'}]
      const completedB={...copy(b),status:'completed',results:[{...observation('terminal-b','plan'),knowledgeDependencyRefs:[{knowledgeId:'terminal-standard',revision:1,segmentId:'p1-c1'}]}]},full={...copy(bootstrap),works:[completed,a,completedB]},refresh=deferred(),refreshStarted=deferred()
      fixture.work(()=>copy(completed));fixture.bootstrap(()=>{refreshStarted.resolve();return refresh.promise})
      const timerCount=nextTimer;runInContext('startPolling()',box);pending=timers.get(state.poll)();await refreshStarted.promise
      const staleDom=node('work-detail').innerHTML;assert.equal([...staleDom.matchAll(/data-tpm-result="/g)].length,1)
      if(change==='selection')state.workSelection++
      if(change==='login')state.authEpoch++
      if(change==='view')state.view='home'
      if(change==='work')state.currentWork={...copy(completed),id:'other'}
      if(change==='generation')state.currentWork={...copy(completed),collaboration:{...completed.collaboration,generation:3}}
      refresh.resolve(copy(full));await pending
      if(change)assert.equal(node('work-detail').innerHTML,staleDom,'terminal reload must not redraw after '+change)
      else{
        assert.equal(state.bootstrap.works.find(work=>work.id===b.id).results.length,1)
        assert.equal([...node('work-detail').innerHTML.matchAll(/data-tpm-result="/g)].length,2,'terminal DOM must include both fresh child observations')
        assert.match(node('work-detail').innerHTML,/data-open-reference="terminal-standard"/)
      }
      assert.equal(fixture.requests.length,7);assert.equal(fixture.requests.filter(path=>path==='/api/bootstrap').length,1);assert.equal(fixture.requests.filter(path=>path==='/api/works/'+fixture.current.id).length,1);assert.equal(nextTimer,timerCount+1);assert.equal(state.poll,null)
    }
    fixture=setup();response=deferred();fixture.work(()=>response.promise);runInContext('startPolling()',box);pending=timers.get(state.poll)();runInContext('stopPolling()',box);field().value='stopped-local';const stopped=state.currentWork;response.resolve(copy(fixture.latest));await pending;assert.equal(state.currentWork,stopped);assert.equal(field().value,'stopped-local')
    console.log('Actual work read lifecycle passed: old/same-revision deferred polls, saved/failed plans, live input/type/progress, generation/selection/login isolation and stopped reads (manual timers; no browser)')
  } finally {runInContext('stopPolling()',box);Object.assign(box,saved);state.bootstrap=copy(bootstrap);state.view='work'}
}

async function checkStartup() {
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  const start = between(source, 'export async function start(', 'export function createGenewayServer(').replace(/^export /, '')
  let tester, feishuOptions, weixinOptions, conversationOptions, fanoutError, pluginCalls = 0, authorizations = 0
  const config = { dshHome: '/outside/data/dsh', dataRoot: '/outside/data', secretRoot: '/outside/data/secrets', stateFile: '/outside/data/state.json', connectionCatalogFile: '/outside/targets.json' }
  const sharedCatalog=Object.freeze([]),controlledStore={async read(){return {deliveries:[{id:'reply',channelAppId:'wx'}],channelApps:[{id:'wx',provider:'weixin'}]}}}
  const unusedLegacy = () => { assert.fail('retired GearJob event configuration/receiver must not be constructed') }
  const box = createContext({ root: '/repository', resolve, relative, sep, join, URL, positivePort: Number, process: { env: { GENEWAY_AUTH_FILE: '/outside/auth.json', GENEWAY_GEARJOB_EVENT_CONFIG: '/must-not-read' }, once() {} }, console: { log() {} }, readRuntimeConfig: () => config, createFileStore: () => controlledStore, readConnectionCatalog: async () => sharedCatalog, readGearJobEventRuntimeConfig: unusedLegacy, createGearJobEventReceiver: unusedLegacy, createDshRunner: () => ({}), createCollaborationRunner: options => { assert.equal(options.connectionCatalog,sharedCatalog);assert.equal(typeof options.getWorkService,'function');return { getKnowledgeService: () => ({}) } }, createWorkService(options) { tester = options.connectionTester; return {} }, createConversationService: options => { conversationOptions=options;assert.equal(options.connectionCatalog,sharedCatalog);return { async ensureReady() {} } }, createAuthRuntime: () => ({}), readFile: async () => index, createAutomationService: () => ({}), createAutomationRuntime: () => ({ async start() {}, ownsLock: () => true }), createChannelRuntime, createChannelSecretStore: () => ({}), createWeixinChannelRuntime: options => { weixinOptions=options;return { async sendDelivery(){if(fanoutError)throw fanoutError}, async start() {}, async close() {}, async sync() {}, isAvailable: () => false } }, createChannelService: options => { assert.equal(options.connectionCatalog,sharedCatalog);return { async recover() {}, async ensureConversationDeliveries(){return {deliveries:[{id:'reply',status:'pending'}]}}, async ensureAutomationDeliveries() { return { deliveries: [] } } } }, createFeishuRuntime: options => { feishuOptions=options;return { async start() {} } }, createGenewayServer: () => ({ listen() {} }), async testKivoTpmConnection(options) { pluginCalls++; assert.equal(options.connection, connection); assert.equal(options.secretRoot, config.secretRoot); await options.authorize(); await options.authorize(); return { protocolVersion: '2026-07-28', toolNames: ['tpm.repair.get', 'tpm.repair.list'] } } })
  runInContext(start, box); await runInContext('start()', box)
  assert.equal(feishuOptions.sdk,undefined);assert.equal(weixinOptions.api,undefined)
  assert.equal(feishuOptions.recover,false);assert.equal(feishuOptions.flushOnStart,false)
  box.injectedSdk={synthetic:'feishu'};box.injectedApi={synthetic:'weixin'}
  await runInContext('start({feishuSdk:injectedSdk,weixinApi:injectedApi})',box)
  assert.equal(feishuOptions.sdk,box.injectedSdk);assert.equal(weixinOptions.api,box.injectedApi)
  for(const code of ['INVALID_STATE','DELIVERY_FORBIDDEN']){fanoutError=Object.assign(new Error('expected durable competition'),{code});await conversationOptions.onTurnTerminal({conversationId:'c',turnId:'t'})}
  fanoutError=Object.assign(new Error('real durability failure'),{code:'CHANNEL_SECRET_WRITE_FAILED'})
  await assert.rejects(conversationOptions.onTurnTerminal({conversationId:'c',turnId:'t'}),{code:'CHANNEL_SECRET_WRITE_FAILED'});fanoutError=null
  const authorize = async () => { authorizations++ }
  assert.match(await tester(connection, { authorize }), /MCP 2026-07-28；工具目录：tpm.repair.get、tpm.repair.list。目录测试通过不代表机器账号对象范围非空/)
  assert.equal(authorizations, 2)
  await assert.rejects(tester(legacy, { authorize }), { code: 'CAPABILITY_RETIRED' })
  assert.equal(pluginCalls, 1)
  assert.equal(box.process.env.DSH_HOME, config.dshHome)
  console.log('Actual startup wiring checks passed: Kivo test authorize propagation and safe directory summary, shared trusted catalog/provider injection defaults, no GearJob event config/receiver (controlled factories; no product startup)')
}
