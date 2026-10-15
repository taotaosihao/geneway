import assert from 'node:assert/strict'
import { appendFileSync, constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording } from './accept-p4-s1.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const model = 'deepseek/deepseek-v4.1-flash'
const readSkill = 'skill-kivo-tpm-record-read', listSkill = 'skill-kivo-tpm-record-list'
const active = ['accepted', 'running']
const tools = ['geneway_kivo_tpm_read_record', 'geneway_kivo_tpm_list_records', 'geneway_calculate_cycle_time', 'geneway_knowledge_search', 'geneway_knowledge_submit_references', 'geneway_collaboration_submit_summary', 'structured_output']
const ids = { a: 'k0-facts-a', b: 'k0-facts-b', lead: 'k0-lead', check: 'k0-check' }
const connectionFields = ['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
const httpSteps = ['configuration', 'legacy-history', 'waiting-and-continue', 'two-instance-interleave', 'record-and-list-catalog', 'follow-up-and-latest', 'current-authorization', 'credential-rotation', 'organization-scope-change', 'j6-handoff-plan-and-continue', 'j6-knowledge-revocation', 'restart-history']
const webSteps = ['web-admin', 'web-legacy-history', 'web-waiting-and-query', 'web-follow-up-and-latest', 'web-j6', 'mobile-query-and-stop']
const barrierLabels = ['update-a-observation', 'restore-a-observation', 'rotate-a-key', 'install-a-key', 'scope-empty-a', 'restore-scope-a']
const titles = {
  configuration: '配置两实例、员工与成员授权', 'legacy-history': '旧来源事实与原生文件只读保留，拒绝新增执行', 'waiting-and-continue': '缺少记录标识时等待，重启后补充同一工作',
  'two-instance-interleave': '两成员交错读取同号记录', 'record-and-list-catalog': '核对 TPM 详情、设备与有限列表',
  'follow-up-and-latest': '区分已保存事实、追问和最新观察', 'current-authorization': '停用连接和撤销员工授权立即生效',
  'credential-rotation': '旧密钥拒绝，新引用明确绑定后恢复', 'organization-scope-change': '组织范围为空与正常零结果明确区分',
  'j6-handoff-plan-and-continue': '事实交接、计划调整与补充后汇总', 'j6-knowledge-revocation': '撤销维护标准后不再展示失效内容',
  'restart-history': '重启后历史事实和原生谱系保留', 'web-admin': '管理员查看并测试两实例连接', 'web-legacy-history': '读取构造迁移夹具中的旧来源结果和执行历史',
  'web-waiting-and-query': '桌面创建查询、等待和补充', 'web-follow-up-and-latest': '桌面追问、查询最新与历史来源',
  'web-j6': '在界面创建、调整并完成 TPM 协作', 'mobile-query-and-stop': '手机查询来源并精确停止一项工作',
}

if (process.env.GENEWAY_KIVO_OBSERVER === '1' && resolve(process.argv[1] ?? '') === join(root, 'src/server.mjs')) {
  const file = process.env.GENEWAY_KIVO_CONTEXT_LOG
  assert(file && isAbsolute(file), 'Kivo observer requires an absolute private log')
  globalThis.fetch = observeContext(globalThis.fetch, {
    a: process.env.GENEWAY_KIVO_RECORD_A, b: process.env.GENEWAY_KIVO_RECORD_B, standard: process.env.GENEWAY_KIVO_STANDARD, webStandard: process.env.GENEWAY_KIVO_WEB_STANDARD,
  }, value => appendFileSync(file, JSON.stringify({ pid: process.pid, ...value }) + '\n', { mode: 0o600 }))
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = argumentsFor(process.argv.slice(2))
  if (options.help) console.log(usage())
  else if (options['harness-check']) await harnessCheck()
  else await acceptance(options)
}

function argumentsFor(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, 'harness-check': { type: 'boolean' }, run: { type: 'boolean' }, 'http-only': { type: 'boolean' },
    output: { type: 'string' }, fixture: { type: 'string' }, catalog: { type: 'string' }, candidate: { type: 'string' },
    'expected-head': { type: 'string' }, 'network-guard': { type: 'string' }, 'guard-sha256': { type: 'string' },
  } })
  if (!args.length) return { help: true }
  assert.equal([values.help, values['harness-check'], values.run].filter(Boolean).length, 1, 'choose --help, --harness-check or --run')
  if (!values.run) { assert(!Object.keys(values).some(key => !['help', 'harness-check'].includes(key)), 'runtime arguments require --run'); return values }
  for (const key of ['output', 'fixture', 'catalog', 'candidate', 'network-guard']) {
    assert(values[key], 'explicit --' + key + ' is required')
    values[key] = resolve(values[key])
    assert(!within(root, values[key]), key + ' must be outside the shared repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? ''), 'explicit --expected-head is required')
  assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''), 'explicit --guard-sha256 is required')
  return values
}
function usage() {
  return 'Kivo TPM 有界验收；真实运行须 controller 新 GO。\n\n' +
    '纯检查：node scripts/accept-p4-kivo.mjs --harness-check\n\n' +
    '获准后：node scripts/accept-p4-kivo.mjs --run --output <新目录> --fixture <root给定fixtures.json> --catalog <root给定connection-catalog.json> --candidate <新冻结清单> --expected-head <完整HEAD> --network-guard <已审guard> --guard-sha256 <已审SHA256>\n' +
    '--http-only 仅运行 HTTP/native 支持旅程，不代表普通 UI 或完整 K0 验收。默认还执行真实桌面/手机操作并生成 p4-kivo.mp4、离线 index.html 和 observations.json。\n' +
    '模型固定 ZenMux ' + model + '；凭据只由 server 从项目 var/secrets 的明确 ref 读取。脚本不读取 Kivo 私有配置、不改上游 fixture/账号、不发送 Lark。\n'
}

async function acceptance(options) {
  const inputs = {}
  for (const key of ['fixture', 'catalog', 'candidate']) inputs[key] = await privateJson(options[key])
  const fixture = validateFixture(inputs.fixture.value, inputs.catalog.value)
  const frozen = validateCandidate(inputs.candidate.value)
  const guardSha256 = hash(await readFile(options['network-guard']))
  assert.equal(guardSha256, options['guard-sha256'], 'approved guard changed')
  const preflight = await snapshot(frozen, options['expected-head'])
  const lifecycle = await lifecycleEvidence(fixture.lifecycleEvidence, preflight)
  const legacyInput = await privateJson(fixture.legacyFixture.file)
  assert.equal(legacyInput.sha256, fixture.legacyFixture.sha256, 'legacy fixture manifest changed')
  const legacy = validateLegacy(legacyInput.value, dirname(fixture.legacyFixture.file))
  await mkdir(options.output, { mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-kivo-accept-'))
  await chmod(scratch, 0o700)
  const stateFile = join(scratch, 'state.json'), authFile = join(scratch, 'auth.json'), dshHome = join(scratch, 'dsh')
  const auditFile = join(scratch, 'network.jsonl'), contextFile = join(scratch, 'context.jsonl')
  const port = await freePort(), origin = 'http://127.0.0.1:' + port
  const passwords = Object.fromEntries(['admin', 'a', 'b'].map(id => [id, randomBytes(24).toString('base64url')]))
  const standard = 'K0_STANDARD_' + randomBytes(12).toString('hex')
  const webStandard = 'K0_WEB_STANDARD_' + randomBytes(12).toString('hex')
  const children = [], browsers = {}, sessions = {}, steps = [], checks = [], refs = {}
  const abort = new AbortController()
  let server, store, display, recording, recordingAt, failure, postflight, report, currentPage, restarting = false, settle, legacyRead = []
  const operationSettled = new Promise(resolveSettled => { settle = resolveSettled })
  const cleanup = runCleanup({ children, browsers, recording: () => recording, operationSettled,
    removeAuth: () => rm(authFile, { force: true }), onFailure: error => { failure ??= error }, stopChild: stopGroup,
  })
  const fail = error => { failure ??= error; abort.abort(error); void cleanup.run() }
  const interrupts = interruptHandlers(process, (signal, force) => { fail(new Error('interrupted by ' + signal)); void cleanup.run(force) })
  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  const operator = operatorBarriers(input, { signal: abort.signal, onFailure: fail, onWaiting: label => console.error('[accept:p4-kivo] waiting for operator: ' + label) })
  const caption = join(scratch, 'caption.txt'), video = join(options.output, 'p4-kivo.mp4')
  const auditBinding = { runId: 'p4-kivo-' + randomBytes(12).toString('hex'), candidate: inputs.candidate.sha256, guardSha256 }
  const env = runtimeEnvironment({ scratch, stateFile, authFile, dshHome, origin, auditFile, contextFile, fixture, standard, webStandard, guard: options['network-guard'], catalog: options.catalog, auditBinding })
  try {
    const { createFileStore } = await import('../src/store/file-store.mjs')
    const { initializeAuthFile } = await import('../src/auth.mjs')
    store = createFileStore(stateFile)
    legacyRead = await copyLegacy(legacy, dshHome, abort.signal)
    const now = new Date().toISOString()
    await store.update(state => ({ ...state, ...legacy.seed, members: ['admin', 'a', 'b'].map(id => ({
      id, loginName: id, displayName: id === 'admin' ? '验收管理员' : '验收成员 ' + id.toUpperCase(), role: id === 'admin' ? 'admin' : 'member',
      enabled: true, authRef: id, employeeIds: id === 'a' ? legacy.seed.employees.map(value => value.id) : [], sessionVersion: 1, createdAt: now, updatedAt: now,
    })) }))
    await initializeAuthFile(authFile, passwords)
    server = await boot()
    for (const actor of ['admin', 'a', 'b']) await login(actor)
    await step('configuration', async () => {
      await api('admin', '/api/admin/model-routes', 'POST', { id: 'k0-model', provider: 'zenmux', model, displayName: 'ZenMux Flash', credentialRef: 'ZENMUX_API_KEY', enabled: true })
      for (const id of [readSkill, listSkill, 'skill-cycle-time-calculate']) await api('admin', '/api/admin/skills', 'POST', { id, name: id === readSkill ? 'TPM 指定记录' : id === listSkill ? 'TPM 列表' : '节拍计算', capabilityId: id.slice(6), enabled: true })
      for (const instance of fixture.instances) {
        await api('admin', '/api/admin/connections', 'POST', { ...instance.connection, enabled: true, skillIds: [readSkill, listSkill] })
        const tested = await api('admin', '/api/admin/connections/' + instance.connection.id + '/test', 'POST', {})
        assert.equal(tested.ok, true)
        assert.equal((await api('admin', '/api/admin/connections')).find(value => value.id === instance.connection.id).status, 'ready')
      }
      for (const [label, name, actor, connection] of [['a', '事实员工 A', 'a', 'a'], ['b', '事实员工 B', 'b', 'b'], ['lead', 'TPM 核对负责人', 'a', 'a'], ['check', '维护标准核对员', 'a', 'a']]) {
        await api('admin', '/api/admin/employees', 'POST', { id: ids[label], name, description: '隔离 synthetic TPM 验收', instructions: '仅使用本次获准事实与知识。区分未知和缺项，禁止写操作。', modelRouteId: 'k0-model', enabled: true, skillIds: [readSkill, listSkill], connectionIds: [instance(connection).connection.id], memberIds: [actor] })
      }
      const bootstrap = await api('b', '/api/bootstrap')
      assert(!bootstrap.employees.some(employee => employee.id === ids.a))
      await rejected('b', '/api/admin/employees', 'GET', undefined, [403])
    })
    await step('legacy-history', async () => {
      const baseline = await store.read(), nativeBefore = await sessionFiles(dshHome), networkBefore = await jsonLines(auditFile)
      for (const historical of legacy.seed.works) {
        const work = await get('a', historical.id)
        assert.equal(work.retired, true)
        for (const key of ['input', 'results', 'executions', 'actions', 'acceptedAt']) assert.deepEqual(work[key], historical[key], 'constructed old typed/source/time/native references changed')
        await rejected('b', path(work.id), 'GET', undefined, [404])
        await rejected('admin', path(work.id), 'GET', undefined, [404])
        for (const [action, input] of [['continue', { input: {} }], ['refresh', {}], ['follow-up', { text: '只读旧事实' }]]) await rejected('a', path(work.id, action), 'POST', { ...input, clientRequestId: 'legacy-' + work.id + '-' + action }, [409], 'CAPABILITY_RETIRED')
        await rejected('a', '/api/works', 'POST', { employeeId: historical.employeeId, skillId: historical.skillId, connectionId: historical.connectionId, input: historical.input, clientRequestId: 'legacy-new-' + work.id }, [403], 'FORBIDDEN')
      }
      assert.deepEqual(await store.read(), baseline, 'legacy denial appended product state')
      assert.deepEqual(await sessionFiles(dshHome), nativeBefore, 'legacy denial appended or changed native Session files')
      assert.deepEqual(await jsonLines(auditFile), networkBefore, 'legacy denial reached model or business transport')
      checks.push({ id: 'constructed-migration-readonly', originalTypedStateAvailable: false, workIds: legacy.seed.works.map(value => value.id), sessions: legacy.sessions.map(value => ({ sha256: value.sha256, eventCount: value.eventCount, sessionRefHash: hash(value.sessionRef) })), noNewState: true, noNewSessionBytes: true, noOutboundCalls: true })
    })
    await step('waiting-and-continue', async () => {
      const work = await create('a', 'a', 'repair', undefined, 'K0_HTTP_WAIT')
      assert.equal(work.status, 'waiting_input'); assert.equal(work.executions.length, 0)
      refs.waiting = work.id
      await restart()
      const continued = await api('a', path(work.id, 'continue'), 'POST', { input: { reference: record('a', 'repair').reference }, clientRequestId: 'k0-http-continue' })
      assert.equal(continued.id, work.id)
      const done = await completed('a', work.id); assertObservation(done, 'a', 'repair')
      const count = done.executions.length
      await api('a', path(work.id, 'continue'), 'POST', { input: { reference: record('a', 'repair').reference }, clientRequestId: 'k0-http-continue' })
      assert.equal((await get('a', work.id)).executions.length, count)
    })
    await step('two-instance-interleave', async () => {
      for (const actor of ['a', 'b', 'a', 'b']) {
        const work = await create(actor, actor, 'repair', record(actor, 'repair').reference, 'K0_HTTP_INTERLEAVE')
        assertObservation(await completed(actor, work.id), actor, 'repair')
        refs[actor] = work.id
      }
      await rejected('b', path(refs.a), 'GET', undefined, [404])
      await rejected('admin', path(refs.a), 'GET', undefined, [404])
      await rejected('a', '/api/works', 'POST', body('a', 'repair', record('a', 'repair').reference, { connectionId: instance('b').connection.id }), [403, 404])
      const state = await store.read()
      const aSessions = workSessions(state.works.find(work => work.id === refs.a))
      const bSessions = workSessions(state.works.find(work => work.id === refs.b))
      assert(aSessions.length && bSessions.length && !aSessions.some(value => bSessions.includes(value)), 'native Sessions crossed members')
      checks.push({ id: 'native-member-isolation', a: aSessions.map(hash), b: bSessions.map(hash) })
    })
    await step('record-and-list-catalog', async () => {
      for (const item of instance('a').records) {
        const actor = 'a'
        const work = await create(actor, actor, item.recordType, item.reference, 'K0_HTTP_RECORD')
        assertObservation(await completed(actor, work.id), actor, item.recordType)
      }
      for (const type of ['repair', 'maintenance', 'inspection', 'exception', 'plan']) {
        const work = await api('a', '/api/works', 'POST', { ...body('a', type), skillId: listSkill, capabilityId: 'kivo-tpm-record-list', input: { recordType: type, filters: { page: 1, pageSize: 1, keyword: type === 'plan' ? undefined : record('a', type).reference } }, goal: 'K0_HTTP_LIST' })
        const result = observation(await completed('a', work.id))
        assert.equal(result.payload.mode, 'list'); assert.equal(result.payload.pagination?.pageSize, 1)
        assert.equal(result.source.sourceInstance, instance('a').connection.sourceInstance)
        assert(result.payload.records.some(value => value.id === record('a', type).recordId))
      }
      await rejected('a', '/api/works', 'POST', { ...body('a', 'repair', record('a', 'repair').reference), input: { recordType: 'repair', reference: 'R', url: 'http://untrusted.invalid' } }, [400])
      await rejected('a', '/api/works', 'POST', { ...body('a', 'repair'), skillId: listSkill, capabilityId: 'kivo-tpm-record-list', input: { recordType: 'repair', filters: { pageSize: 101 } } }, [400])
    })
    await step('follow-up-and-latest', async () => {
      const before = await get('a', refs.a), facts = before.results.filter(value => value.kind === 'kivo.tpm.observation')
      const sourceRequests = (await jsonLines(auditFile)).filter(value => value.kind === 'fetch' && value.path === '/api/v1/mes/mcp').length
      await api('a', path(refs.a, 'follow-up'), 'POST', { text: '请解释已经保存的状态、设备和来源时间；不要查询最新。', clientRequestId: 'k0-http-follow' })
      const followed = await completed('a', refs.a)
      assert.equal(followed.results.filter(value => value.kind === 'kivo.tpm.observation').length, facts.length)
      assert(followed.results.some(value => value.kind === 'assistant.follow-up' && value.explanation))
      assert.equal((await jsonLines(auditFile)).filter(value => value.kind === 'fetch' && value.path === '/api/v1/mes/mcp').length, sourceRequests, 'saved-fact follow-up queried Kivo')
      if (options['http-only']) { assertDeviceName(facts.at(-1), false); await operator.wait('update-a-observation') }
      await api('a', path(refs.a, 'refresh'), 'POST', { clientRequestId: 'k0-http-latest' })
      const latest = await completed('a', refs.a), saved = latest.results.filter(value => value.kind === 'kivo.tpm.observation')
      assert.equal(saved.length, facts.length + 1); assert.deepEqual(saved.slice(0, -1), facts)
      assertObservation(latest, 'a', 'repair')
      assert.notEqual(saved.at(-1).id, facts.at(-1).id)
      if (options['http-only']) {
        assertDeviceName(saved.at(-1), true)
        await operator.wait('restore-a-observation')
        await api('a', path(refs.a, 'refresh'), 'POST', { clientRequestId: 'k0-http-restored-observation' })
        const restored = (await completed('a', refs.a)).results.filter(value => value.kind === 'kivo.tpm.observation')
        assert.deepEqual(restored.slice(0, -1), saved); assertDeviceName(restored.at(-1), false)
        operator.recovered('restore-a-observation')
      }
    })
    if (!options['http-only']) await browserJourney()
    await step('current-authorization', async () => {
      const connection = (await api('admin', '/api/admin/connections')).find(value => value.id === instance('a').connection.id)
      await api('admin', '/api/admin/connections/' + connection.id, 'PATCH', { enabled: false })
      await rejected('a', '/api/works', 'POST', body('a', 'repair', record('a', 'repair').reference), [403, 409])
      assertObservation(await completed('b', (await create('b', 'b', 'repair', record('b', 'repair').reference, 'K0_HTTP_B_UNAFFECTED')).id), 'b', 'repair')
      await api('admin', '/api/admin/connections/' + connection.id, 'PATCH', { enabled: true })
      await api('admin', '/api/admin/connections/' + connection.id + '/test', 'POST', {})
      const employee = (await api('admin', '/api/admin/employees')).find(value => value.id === ids.a)
      await api('admin', '/api/admin/employees/' + ids.a, 'PATCH', { expectedRevision: employee.revision, memberIds: [] })
      assert((await api('a', '/api/session')).member)
      await rejected('a', '/api/works', 'POST', body('a', 'repair', record('a', 'repair').reference), [403, 404])
      const current = (await api('admin', '/api/admin/employees')).find(value => value.id === ids.a)
      await api('admin', '/api/admin/employees/' + ids.a, 'PATCH', { expectedRevision: current.revision, memberIds: ['a'] })
    })
    await step('credential-rotation', async () => {
      await operator.wait('rotate-a-key')
      const denied = await terminal('a', (await create('a', 'a', 'repair', record('a', 'repair').reference, 'K0_OLD_KEY_REJECT')).id)
      assert.equal(denied.status, 'failed', 'old Kivo private key remained usable after upstream rotation')
      assert.equal(denied.executions.at(-1).error?.code, 'FORBIDDEN', 'old-key negative did not fail at authorization')
      assert.equal(denied.results.length, 0)
      checks.push({ id: 'old-key-authorization-rejected', workId: denied.id, executionId: denied.executions.at(-1).id, code: denied.executions.at(-1).error.code })
      assertObservation(await completed('b', (await create('b', 'b', 'repair', record('b', 'repair').reference, 'K0_ROTATION_B_UNAFFECTED')).id), 'b', 'repair')
      await operator.wait('install-a-key')
      const rotated = rotationTarget(fixture, inputs.catalog.value)
      const oldSession = (await store.read()).works.find(work => work.id === refs.a).executions.findLast(value => value.dshSessionRef)?.dshSessionRef
      assert(oldSession, 'previous native Session missing before rebind')
      if (options['http-only']) {
        await api('admin', '/api/admin/connections/' + instance('a').connection.id, 'PATCH', { credentialRef: rotated.credentialRef })
        await api('admin', '/api/admin/connections/' + instance('a').connection.id + '/test', 'POST', {})
      } else {
        await ensureBrowser(); await browserLogin('admin'); await front(browsers.admin); await browsers.admin.nav('admin'); await browsers.admin.click('#tab-connections')
        const form = await openConnection(browsers.admin, instance('a').connection.id)
        await browsers.admin.fill(form + ' [name="credentialRef"]', rotated.credentialRef)
        await browsers.admin.click(form + ' button.btn.primary')
        await wait(async () => (await api('admin', '/api/admin/connections')).find(value => value.id === instance('a').connection.id).credentialRef === rotated.credentialRef, 'explicit new credential reference')
        await browsers.admin.wait('document.querySelector("#admin-message")?.innerText.includes("配置已保存并从服务端回读")')
        await openConnection(browsers.admin, instance('a').connection.id)
        assert.equal(await browsers.admin.evaluate('document.querySelector(' + JSON.stringify(form + ' [name="credentialRef"]') + ')?.value'), rotated.credentialRef, 'new credential reference missing from refreshed form')
        await browsers.admin.click('[data-test-connection="' + instance('a').connection.id + '"]')
        await browsers.admin.wait('document.querySelector("#admin-message")?.innerText.includes("协议与固定只读工具目录测试通过")')
        await wait(async () => (await api('admin', '/api/admin/connections')).find(value => value.id === instance('a').connection.id).status === 'ready', 'new credential connection test')
        await shot('管理员明确改绑新凭据引用并通过连接检查')
      }
      assertObservation(await completed('a', (await create('a', 'a', 'repair', record('a', 'repair').reference, 'K0_NEW_KEY_ACCEPT')).id), 'a', 'repair')
      await api('a', path(refs.a, 'refresh'), 'POST', { clientRequestId: 'k0-rotated-refresh' })
      assertObservation(await completed('a', refs.a), 'a', 'repair')
      assert.notEqual((await store.read()).works.find(work => work.id === refs.a).executions.at(-1).dshSessionRef, oldSession, 'new credential binding reused old native Session')
      operator.recovered('install-a-key')
    })
    await step('organization-scope-change', async () => {
      await operator.wait('scope-empty-a')
      const empty = await completed('a', (await create('a', 'a', 'repair', record('a', 'repair').reference, 'K0_SCOPE_EMPTY_RECORD')).id)
      assertEmptyScope(observation(empty))
      const list = await api('a', '/api/works', 'POST', { ...body('a', 'repair'), skillId: listSkill, capabilityId: 'kivo-tpm-record-list', input: { recordType: 'repair', filters: {} }, goal: 'K0_SCOPE_EMPTY_LIST' })
      assertEmptyScope(observation(await completed('a', list.id)))
      assertObservation(await completed('b', (await create('b', 'b', 'repair', record('b', 'repair').reference, 'K0_SCOPE_B_UNAFFECTED')).id), 'b', 'repair')
      await operator.wait('restore-scope-a')
      assertObservation(await completed('a', (await create('a', 'a', 'repair', record('a', 'repair').reference, 'K0_SCOPE_RESTORED')).id), 'a', 'repair')
      const none = await api('a', '/api/works', 'POST', { ...body('a', 'repair'), skillId: listSkill, capabilityId: 'kivo-tpm-record-list', input: { recordType: 'repair', filters: { keyword: 'K0_NO_RECORD_' + randomBytes(12).toString('hex') } }, goal: 'K0_NORMAL_EMPTY_COLLECTION' })
      const value = observation(await completed('a', none.id)).payload
      assert.equal(value.status, 'ok'); assert.deepEqual(value.records, []); assert.equal(value.pagination.total, 0)
      operator.recovered('restore-scope-a')
    })
    await step('j6-handoff-plan-and-continue', async () => {
      const material = await createStandard()
      refs.standard = material.id
      const work = await api('a', '/api/works', 'POST', collaboration())
      refs.collaboration = work.id
      await waiting(work.id)
      const changed = await api('a', path(work.id, 'plan'), 'PATCH', { expectedRevision: 1, items: [{ id: 'k0-check', goal: '按维护标准核对计划和前序维修事实的缺项', employeeId: ids.check }] })
      assert.equal(changed.plan.revision, 2)
      await rejected('a', path(work.id, 'plan'), 'PATCH', { expectedRevision: 1, items: [{ id: 'k0-check', goal: '过期草稿' }] }, [409])
      const childrenBefore = (await store.read()).works.filter(value => value.rootWorkId === work.id)
      const aCount = childrenBefore.find(value => value.planItemId === 'k0-read').executions.length
      await api('a', path(work.id, 'continue'), 'POST', { inputs: { 'k0-check': { reference: record('a', 'plan').reference } }, clientRequestId: 'k0-j6-continue' })
      await assertCollaboration(await completed('a', work.id), material.id)
      assert.equal((await store.read()).works.find(value => value.rootWorkId === work.id && value.planItemId === 'k0-read').executions.length, aCount)
      const contexts = await jsonLines(contextFile)
      assert(contexts.some(value => value.httpCheckStep && value.hasA && value.hasHttpStandard), 'B actual Host request did not contain A handoff and authorized standard')
      assert(contexts.filter(value => value.readStep).every(value => !value.hasStandard), 'A inherited B private knowledge')
    })
    await step('j6-knowledge-revocation', async () => {
      const material = await api('a', '/api/knowledge/' + refs.standard)
      await api('a', '/api/knowledge/' + material.id, 'PATCH', { expectedRevision: material.revision, employeeIds: [ids.lead] })
      const work = await get('a', refs.collaboration)
      assert.equal(work.collaboration.status, 'stale')
      assert(!JSON.stringify(work).includes(standard), 'revoked knowledge remained in work projection')
      assert.deepEqual(await api('b', '/api/knowledge/search', 'POST', { employeeId: ids.b, query: standard }), [])
      await rejected('b', path(refs.collaboration), 'GET', undefined, [404])
      const current = await api('a', '/api/knowledge/' + material.id)
      await api('a', '/api/knowledge/' + material.id, 'PATCH', { expectedRevision: current.revision, employeeIds: [ids.lead, ids.check] })
      assert.equal((await get('a', refs.collaboration)).collaboration.status, 'stale')
    })
    await step('restart-history', async () => {
      const before = await get('a', refs.a), sessionsBefore = workSessions((await store.read()).works.find(value => value.id === refs.a))
      await restart()
      const after = await get('a', refs.a)
      assert.deepEqual(after.results, before.results)
      assert.deepEqual(workSessions((await store.read()).works.find(value => value.id === refs.a)), sessionsBefore)
      checks.push({ id: 'restart-native-lineage', sessions: sessionsBefore.map(hash) })
    })
  } catch (error) { failure ??= error }
  finally {
    settle(); await cleanup.run()
    try { await assertStopped(children, authFile) }
    catch (error) { cleanup.state.authRemoved = false; cleanup.state.allOwnedProcessesExited = false; failure ??= error }
    try {
      postflight = await snapshot(frozen, options['expected-head'])
      assert.deepEqual(postflight, preflight, 'candidate changed during acceptance')
      for (const key of ['fixture', 'catalog', 'candidate']) assert.equal(hash(await readFile(options[key])), inputs[key].sha256, key + ' changed during acceptance')
      assert.equal(hash(await readFile(options['network-guard'])), guardSha256, 'guard changed during acceptance')
      for (const descriptor of Object.values(fixture.lifecycleEvidence)) assert.equal(hash(await readFile(descriptor.file)), descriptor.sha256, 'lifecycle evidence changed during acceptance')
      assert.equal(hash(await readFile(fixture.legacyFixture.file)), fixture.legacyFixture.sha256, 'legacy fixture changed during acceptance')
      for (const session of legacy.sessions) assert.equal(hash(await readFile(session.file)), session.sha256, 'legacy source Session changed during acceptance')
    } catch (error) { failure ??= error }
    const network = await jsonLines(auditFile), contexts = await jsonLines(contextFile)
    let audited = { ok: false, scope: 'selected-node-sdk-and-network-apis' }
    try {
      audited = networkAudit(network, { ...auditBinding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid), hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean) })
      assert(network.filter(value => value.kind === 'fetch' && value.host === 'zenmux.ai').every(value => (value.toolNames ?? []).every(name => tools.includes(name))), 'unexpected SDK or Host model-visible tool')
    } catch (error) { failure ??= error }
    report = {
      ok: !failure, mode: options['http-only'] ? 'http-native-supporting' : 'web-and-http-native', dataMode: 'synthetic', sourceEnvironment: 'external-test',
      scope: '本轮仅 Kivo synthetic TPM 只读旅程；渠道为模拟验收。完整 K0 仍须结合独立生命周期、旧历史、上游撤权与协议证据。',
      fullK0Acceptance: false, remainingEvidence: ['in-flight authorization races and Kivo protocol/security supporting evidence must be assessed with the same candidate'],
      candidate: { preflight, postflight, manifestSha256: inputs.candidate.sha256 }, inputs: { fixtureSha256: inputs.fixture.sha256, catalogSha256: inputs.catalog.sha256, supportingBasis: fixture.basis },
      model: { provider: 'zenmux', model }, instrumentation: { ...auditBinding, scope: audited.scope, sdkLaunchCorrelationRequired: true, wholeMachineCoverage: false, contextMarkerScope: 'Host model requests only' },
      lifecycleSupporting: lifecycle, legacy: { bindingMode: legacy.bindingMode, manifestSha256: legacyInput.sha256, originalTypedStateAvailable: false, originalOwnerWorkMappingAvailable: false, constructedFields: legacy.constructedFields, queriedAtLimit: legacy.projectionQueriedAtSource, nativeReadMethod: 'rc.2 official historical codec strict read; not a work native-history product API', nativeReads: legacyRead },
      steps, checks, incomplete: [...httpSteps, ...(options['http-only'] ? [] : webSteps)].filter(id => !steps.some(value => value.id === id && value.passed)),
      network: { ...audited, records: network.length, pids: [...new Set(network.map(value => value.pid))], blocked: network.filter(value => value.permitted === false).length }, context: contexts,
      browser: Object.fromEntries(Object.entries(browsers).map(([actor, page]) => [actor, { viewport: page.size(), errors: page.errors, unexpectedResponses: page.responses.filter(value => value.status >= 500 && !value.duringRestart) }])),
      operator: operator.state, cleanup: { ...cleanup.state, ...interrupts.state, privateRuntime: scratch, ownedPids: children.map(value => value.pid).filter(Number.isInteger) }, failure: failure ? safeFailure(failure) : null,
      media: { video: recording ? 'p4-kivo.mp4' : null, recorder: recording?.state ?? null },
    }
    if (report.incomplete.length || Object.values(report.browser).some(page => page.errors.length || page.unexpectedResponses.length)) { failure ??= new Error('required journey or browser checks did not pass'); report.ok = false }
    if (recording) {
      try {
        await command('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], abort.signal)
        const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], abort.signal))
        const stream = probe.streams.find(value => value.codec_type === 'video')
        report.media = { ...report.media, ...recordingCoverage(recording.state, probe, steps), codec: stream.codec_name, width: stream.width, height: stream.height, sha256: hash(await readFile(video)) }
      } catch (error) { failure ??= error }
    }
    try {
      let savedFailure
      do {
        savedFailure = failure; report.ok = !failure; report.failure = failure ? safeFailure(failure) : null
        Object.assign(report.cleanup, cleanup.state, interrupts.state)
        await writeFile(join(options.output, 'index.html'), manual(report), { mode: 0o600 })
        await writeFile(join(options.output, 'observations.json'), JSON.stringify(report, (key, value) => key === 'image' ? undefined : value, 2) + '\n', { mode: 0o600 })
      } while (savedFailure !== failure)
    } finally { operator.dispose(); input.close(); interrupts.dispose() }
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, fullK0Acceptance: false, output: options.output, passed: steps.filter(value => value.passed).length, incomplete: report.incomplete, failure: report.failure }))
  }
  if (failure) process.exitCode ||= 1

  function instance(actor) { return fixture.instances.find(value => value.instance === actor) }
  function record(actor, type) { return instance(actor).records.find(value => value.recordType === type) }
  function body(actor, type, reference, extra = {}) {
    return { employeeId: ids[actor], skillId: readSkill, capabilityId: 'kivo-tpm-record-read', connectionId: instance(actor).connection.id, input: { recordType: type, ...(reference ? { reference } : {}) }, clientRequestId: randomBytes(12).toString('hex'), ...extra }
  }
  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.on('error', error => { child.spawnError = error })
    child.stderr?.resume()
    children.push(child); return child
  }
  async function boot() {
    const child = launch(process.execPath, [join(root, 'src/server.mjs')], { env })
    child.auditRole = 'host'
    child.auditFile = auditFile; child.auditBinding = auditBinding
    await wait(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server exited'); try { return (await fetch(origin + '/', { signal: requestSignal() })).status === 200 } catch { return false } }, 'server startup')
    return child
  }
  async function restart() { restarting = true; try { await stopGroup(server); server = await boot() } finally { restarting = false } }
  function requestSignal() { return AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) }
  async function wait(check, label, timeout = 30_000) { return poll(async () => { abort.signal.throwIfAborted(); return check() }, label, timeout) }
  async function login(actor) {
    const response = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: actor, password: passwords[actor] }), signal: requestSignal() })
    assert.equal(response.status, 200, 'synthetic login failed')
    const value = await response.json()
    sessions[actor] = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: value.csrfToken }
  }
  async function response(actor, url, method = 'GET', value) {
    const session = sessions[actor], headers = { origin, cookie: session.cookie, 'x-csrf-token': session.csrf }
    if (value !== undefined) headers['content-type'] = 'application/json'
    const result = await fetch(origin + url, { method, headers, body: value === undefined ? undefined : JSON.stringify(value), signal: requestSignal() })
    return { status: result.status, body: await result.json() }
  }
  async function api(actor, url, method, value) {
    const result = await response(actor, url, method, value)
    const code = String(result.body?.error?.code ?? result.body?.code ?? 'unknown').replace(/[^A-Z0-9_]/g, '').slice(0, 80)
    assert(result.status >= 200 && result.status < 300, 'product API rejected ' + (method ?? 'GET') + ' ' + surface(url) + ' HTTP ' + result.status + ' code ' + code)
    return result.body
  }
  async function rejected(actor, url, method, value, statuses, code) {
    const result = await response(actor, url, method, value)
    assert(statuses.includes(result.status), 'negative ' + method + ' ' + surface(url) + ' returned HTTP ' + result.status + ', expected ' + statuses.join('/'))
    if (code) assert.equal(result.body.error?.code, code, 'negative did not reach its expected boundary')
    checks.push({ actor, method, surface: surface(url), status: result.status, ...(code ? { code } : {}) })
  }
  function get(actor, id) { return api(actor, path(id)) }
  function create(actor, employee, type, reference, goal) { return api(actor, '/api/works', 'POST', { ...body(employee, type, reference), goal }) }
  async function completed(actor, id) {
    const work = await terminal(actor, id); assert.equal(work.status, 'completed', 'native work did not complete'); return work
  }
  function terminal(actor, id) { return wait(async () => { const work = await get(actor, id); return active.includes(work.status) ? false : work }, 'native work completion', 360_000) }
  async function waiting(id) { return wait(async () => { const work = await get('a', id); assert(!['failed', 'cancelled'].includes(work.status), 'collaboration failed before waiting'); return work.status === 'waiting_input' ? work : false }, 'collaboration waiting', 360_000) }
  function assertObservation(work, actor, type) { validateObservation(observation(work), instance(actor), type); return work }
  function collaboration() {
    return { workType: 'collaboration', employeeId: ids.lead, skillId: readSkill, connectionId: instance('a').connection.id, goal: 'K0_J6 核对维修事实与维护计划，并按获准标准列出缺项', clientRequestId: randomBytes(12).toString('hex'), items: [
      { id: 'k0-read', employeeId: ids.a, skillId: readSkill, connectionId: instance('a').connection.id, goal: '取得明确维修单事实，不读取核对员私有标准', input: { recordType: 'repair', reference: record('a', 'repair').reference } },
      { id: 'k0-check', employeeId: ids.check, skillId: readSkill, connectionId: instance('a').connection.id, goal: '查询维护计划并结合前序事实与标准核对缺项', input: { recordType: 'plan' }, knowledgeQuery: standard, dependsOn: ['k0-read'] },
    ] }
  }
  function createStandard() {
    return api('a', '/api/knowledge', 'POST', { employeeIds: [ids.lead, ids.check], title: '合成维护核对标准', body: standard + '：核对维修状态、设备、维护计划以及负责人和完成时间；源未提供的字段明确列为缺项，不填造事实。', format: 'text', sourceLabel: 'synthetic 验收标准', authorizationBasis: '验收成员明确导入' })
  }
  async function assertCollaboration(work, knowledgeId, itemIds = ['k0-read', 'k0-check']) {
    const state = await store.read(), children = state.works.filter(value => value.rootWorkId === work.id)
    assert.equal(children.length, 2)
    const a = children.find(value => value.planItemId === itemIds[0]), b = children.find(value => value.planItemId === itemIds[1])
    assertObservation(a, 'a', 'repair'); assertObservation(b, 'a', 'plan')
    assert(b.results.some(value => value.knowledgeDependencyRefs?.some(ref => ref.knowledgeId === knowledgeId)), 'B did not persist its authorized standard reference')
    assert.equal(a.results.some(value => value.knowledgeDependencyRefs?.length), false)
    const handoffs = work.handoffs.filter(value => value.status === 'current')
    assert.equal(handoffs.length, 2)
    const summary = work.results.findLast(value => value.kind === 'assistant.collaboration-summary')
    assert(summary?.explanation && summary.knowledgeDependencyRefs?.some(ref => ref.knowledgeId === knowledgeId))
    assert.deepEqual([...summary.payload.resultRefs].sort(), handoffs.flatMap(value => value.resultRefs).sort())
    checks.push({ id: 'j6-current-handoff', workId: work.id, resultRefs: summary.payload.resultRefs, nativeSessions: children.flatMap(workSessions).map(hash) })
  }
  async function step(id, operation) {
    abort.signal.throwIfAborted(); recording?.assertRunning()
    const entry = { id, title: titles[id], passed: false, startSeconds: recordingAt ? (Date.now() - recordingAt) / 1000 : null, screenshots: [] }
    steps.push(entry); console.error('[accept:p4-kivo] start ' + id)
    if (recording) await writeFile(caption, 'Kivo TPM：' + entry.title + '；synthetic 数据，渠道为模拟验收', { mode: 0o600 })
    try { await operation(); abort.signal.throwIfAborted(); recording?.assertRunning(); entry.passed = true; console.error('[accept:p4-kivo] pass ' + id) }
    catch (error) { failure ??= error; throw error }
    finally {
      if (recording && currentPage && (webSteps.includes(id) || id === 'credential-rotation')) { try { await shot(entry.title) } catch (error) { fail(error); entry.passed = false } }
      entry.endSeconds = recordingAt ? (Date.now() - recordingAt) / 1000 : null
    }
  }
  async function browserJourney() {
    await ensureBrowser()
    await step('web-admin', async () => {
      await browserLogin('admin'); await front(browsers.admin); await browsers.admin.nav('admin'); await browsers.admin.click('#tab-connections')
      for (const value of fixture.instances) {
        await openConnection(browsers.admin, value.connection.id)
        await browsers.admin.click('[data-test-connection="' + value.connection.id + '"]')
        await browsers.admin.wait('document.querySelector("#admin-message")?.innerText.includes("协议与固定只读工具目录测试通过")')
        await wait(async () => (await api('admin', '/api/admin/connections')).find(item => item.id === value.connection.id).lastTest?.ok, 'visible connection test')
      }
      await browsers.admin.noOverflow()
    })
    await step('web-legacy-history', async () => {
      const page = browsers.a
      await browserLogin('a'); await front(page); await page.nav('works')
      const work = legacy.seed.works[0], result = work.results[0]
      await page.click('#all-work-cards [data-open-work="' + work.id + '"]')
      await page.wait('Boolean(document.querySelector("#work-retired-note") && !document.querySelector("#work-retired-note").classList.contains("hidden"))')
      const text = await page.evaluate('document.querySelector("#work-detail").innerText')
      for (const value of [result.payload.workOrderId, result.payload.status, result.source.sourceInstance, result.source.sourceTime, '执行历史']) assert(text.includes(value), 'old typed/source/time/history missing in ordinary UI')
      assert.equal(await page.evaluate('Boolean(document.querySelector("#refresh-work") || document.querySelector("#follow-form") || document.querySelector("#continue-form"))'), false, 'retired UI exposed new execution')
      await page.noOverflow()
    })
    await step('web-waiting-and-query', async () => {
      const page = browsers.a
      await browserLogin('a'); await front(page); await singleForm(page, 'a', 'repair', '', '桌面维修事实核对')
      refs.web = await submit(page, 'a', '桌面维修事实核对')
      assert.equal((await get('a', refs.web)).status, 'waiting_input')
      await page.wait('Boolean(document.querySelector("#continue-tpm-reference"))')
      await shot('缺少维修单号，原工作等待补充')
      await page.fill('#continue-tpm-reference', record('a', 'repair').reference)
      const beforeContinue = await get('a', refs.web), priorExecutions = new Set(beforeContinue.executions.map(value => value.id)), responseStart = page.responses.length
      await page.click('#continue-form button')
      await wait(async () => {
        assert(!page.responses.slice(responseStart).some(value => value.path === '/api/works/:id/continue' && value.status >= 400), 'UI continue request rejected')
        const latest = await get('a', refs.web), admitted = latest.executions.filter(value => !priorExecutions.has(value.id))
        assert.equal(latest.id, refs.web, 'UI continue work differs')
        if (!admitted.length) return false
        assert.equal(admitted.length, 1, 'UI continue created duplicate executions')
        assert.equal(admitted[0].operation, 'continue', 'UI continue operation differs')
        const expected = { recordType: 'repair', reference: record('a', 'repair').reference }
        assert.deepEqual(latest.input, expected, 'UI continue work input differs')
        assert.deepEqual(admitted[0].input, expected, 'UI continue execution input differs')
        return true
      }, 'UI continue accepted')
      assertObservation(await completed('a', refs.web), 'a', 'repair')
      await visibleObservation(page, refs.web); await page.noOverflow()
    })
    await step('web-follow-up-and-latest', async () => {
      const page = browsers.a, before = await get('a', refs.web), prior = before.results.filter(value => value.kind === 'kivo.tpm.observation')
      const sourceRequests = (await jsonLines(auditFile)).filter(value => value.kind === 'fetch' && value.path === '/api/v1/mes/mcp').length
      assertDeviceName(prior.at(-1), false)
      await front(page); await page.fill('#follow-text', '解释当前已保存的状态、设备和来源时间，不查询最新。'); await page.click('#follow-form button')
      await wait(async () => (await get('a', refs.web)).executions.length > before.executions.length, 'UI follow-up accepted')
      const followed = await completed('a', refs.web)
      assert.equal(followed.results.filter(value => value.kind === 'kivo.tpm.observation').length, prior.length)
      assert.equal((await jsonLines(auditFile)).filter(value => value.kind === 'fetch' && value.path === '/api/v1/mes/mcp').length, sourceRequests, 'UI saved-fact follow-up queried Kivo')
      await operator.wait('update-a-observation')
      await page.wait('Boolean(document.querySelector("#refresh-work") && !document.querySelector("#refresh-work").disabled)')
      await page.click('#refresh-work')
      await wait(async () => (await get('a', refs.web)).executions.length > followed.executions.length, 'UI latest accepted')
      const latest = await completed('a', refs.web)
      const changed = latest.results.filter(value => value.kind === 'kivo.tpm.observation')
      assert.deepEqual(changed.slice(0, -1), prior); assertDeviceName(changed.at(-1), true)
      await visibleObservation(page, refs.web)
      assert.equal(await page.evaluate('document.querySelectorAll("#work-detail [data-tpm-result]").length'), 2)
      await shot('新观察保存设备名称变更，旧观察仍保持原名')
      await operator.wait('restore-a-observation')
      await page.click('#refresh-work')
      await wait(async () => (await get('a', refs.web)).executions.length > latest.executions.length, 'UI restored-source refresh accepted')
      const restored = (await completed('a', refs.web)).results.filter(value => value.kind === 'kivo.tpm.observation')
      assert.deepEqual(restored.slice(0, -1), changed); assertDeviceName(restored.at(-1), false)
      operator.recovered('restore-a-observation')
      await visibleObservation(page, refs.web)
      assert.equal(await page.evaluate('document.querySelectorAll("#work-detail [data-tpm-result]").length'), 3)
      await page.noOverflow()
    })
    await step('web-j6', async () => {
      const page = browsers.a, query = webStandard
      await front(page); await page.nav('knowledge')
      for (const [selector, value] of [['#knowledge-title', '界面导入的维护核对标准'], ['#knowledge-source', 'synthetic 维护标准'], ['#knowledge-authorization', '验收成员明确导入'], ['#knowledge-body', query + '：核对维修状态、设备、维护计划、负责人和完成时间。未提供的字段明确列为缺项，不填造事实。']]) await page.fill(selector, value)
      for (const employee of [ids.lead, ids.check]) await page.check('[name="knowledgeEmployeeIds"][value="' + employee + '"]', true)
      await page.click('#knowledge-form button')
      const material = await wait(async () => (await api('a', '/api/knowledge')).find(value => value.title === '界面导入的维护核对标准'), 'UI imported standard')
      await page.nav('home'); await page.select('#work-mode', 'collaboration')
      await page.select('#work-employee', ids.lead); await page.select('#work-skill', readSkill); await page.select('#work-connection', instance('a').connection.id)
      const goal = '维修事实与维护计划的标准核对'
      await page.fill('#work-goal', goal)
      for (const [prefix, employee, type, reference, itemGoal] of [
        ['collab-a', ids.a, 'repair', record('a', 'repair').reference, '取得维修单事实并交接给核对员'],
        ['collab-b', ids.check, 'plan', '', '核对前序事实、维护计划与获准标准的缺项'],
      ]) {
        await page.select('#' + prefix + '-employee', employee); await page.select('#' + prefix + '-skill', readSkill); await page.select('#' + prefix + '-connection', instance('a').connection.id)
        await page.fill('#' + prefix + '-goal', itemGoal); await page.select('#' + prefix + '-tpm-record-type', type); await page.fill('#' + prefix + '-tpm-reference', reference)
      }
      await page.fill('#collab-b-knowledge-query', query); await page.check('#collab-b-depends-on-a', true)
      const id = await submit(page, 'a', goal)
      await waiting(id)
      await page.wait('Boolean(document.querySelector("#plan-goal-step-b") && document.querySelector("#collaboration-input-step-b-reference"))')
      await shot('前序维修事实已完成，计划标识待补充且未执行项可修改')
      await page.fill('#plan-goal-step-b', '结合当前维修事实与维护标准列出计划缺项'); await page.click('#save-plan')
      await wait(async () => (await get('a', id)).plan.revision === 2, 'UI plan revision')
      await page.wait('document.querySelector("#work-message")?.innerText.includes("计划已更新")')
      await page.fill('#collaboration-input-step-b-reference', record('a', 'plan').reference)
      const beforeContinue = await get('a', id), priorExecutions = new Set(beforeContinue.executions.map(value => value.id)), responseStart = page.responses.length
      try {
        await page.click('#collaboration-continue-form button')
        await wait(async () => {
          assert(!page.responses.slice(responseStart).some(value => value.path === '/api/works/:id/continue' && value.status >= 400), 'UI collaboration continue request rejected')
          const latest = await get('a', id), admitted = latest.executions.filter(value => !priorExecutions.has(value.id) && value.operation === 'collaboration-continue')
          if (!admitted.length) return false
          assert.equal(admitted.length, 1, 'UI collaboration continue created duplicate executions')
          assert.equal(latest.collaboration.generation, beforeContinue.collaboration.generation + 1, 'UI collaboration continue generation differs')
          assert.equal(admitted[0].generation, latest.collaboration.generation)
          assert.equal(admitted[0].planRevision, beforeContinue.plan.revision)
          const childId = beforeContinue.plan.items.find(value => value.id === 'step-b').childWorkId
          const child = (await store.read()).works.find(value => value.id === childId)
          assert(child?.input?.reference === record('a', 'plan').reference, 'UI collaboration continue lost the expected reference')
          assert(child.executions.some(value => value.operation === 'collaboration-continue-child' && value.generation === admitted[0].generation), 'UI collaboration continue child was not admitted')
          return true
        }, 'UI collaboration continue accepted')
      } catch (error) {
        const ui = await page.evaluate(`(()=>{const form=document.querySelector('#collaboration-continue-form'),field=document.querySelector('#collaboration-input-step-b-reference'),message=document.querySelector('#work-message');return {formPresent:Boolean(form),referencePresent:Boolean(field?.value),referenceMatches:field?.value===${JSON.stringify(record('a', 'plan').reference)},submitting:message?.textContent==='正在提交…',errorVisible:Boolean(message?.classList.contains('error'))}})()`).catch(() => ({ unavailable: true }))
        checks.push({ id: 'web-j6-continue-failure', ui, httpStatuses: page.responses.slice(responseStart).filter(value => value.path === '/api/works/:id/continue').map(value => value.status) })
        throw error
      }
      const done = await completed('a', id)
      await assertCollaboration(done, material.id, ['step-a', 'step-b'])
      assert((await jsonLines(contextFile)).some(value => value.webCheckStep && value.hasA && value.hasWebStandard), 'Web B request lacked A facts or the Web-imported standard')
      await page.wait('document.querySelectorAll("#work-detail [data-tpm-result]").length === 2')
      await page.wait('Boolean(document.querySelector("#work-detail [data-open-reference]"))')
      assert.equal((await get('a', id)).plan.items.find(value => value.id === 'step-b').goal, '结合当前维修事实与维护标准列出计划缺项')
      await page.noOverflow()
    })
    await step('mobile-query-and-stop', async () => {
      const page = browsers.b
      await front(page); await page.viewport(390, 844); await browserLogin('b')
      await singleForm(page, 'b', 'inspection', record('b', 'inspection').reference, '手机点检来源核对')
      const viewed = await submit(page, 'b', '手机点检来源核对')
      assertObservation(await completed('b', viewed), 'b', 'inspection')
      await visibleObservation(page, viewed); await page.noOverflow(); await shot('手机读取点检事实、关联设备和历史来源')
      await front(browsers.a); await singleForm(browsers.a, 'a', 'repair', record('a', 'repair').reference, '独立维修查询 W2')
      await front(page); await singleForm(page, 'b', 'repair', record('b', 'repair').reference, '手机停止维修查询 W1')
      const w1 = await submit(page, 'b', '手机停止维修查询 W1')
      await front(browsers.a); const w2 = await submit(browsers.a, 'a', '独立维修查询 W2')
      await front(page)
      assert(active.includes((await get('b', w1)).status) && active.includes((await get('a', w2)).status), 'both UI works must still be active before the stop')
      await page.click('#cancel-work')
      await wait(async () => (await get('b', w1)).status === 'cancelled', 'mobile exact cancellation')
      assertObservation(await completed('a', w2), 'a', 'repair')
      assert.equal((await get('b', w1)).status, 'cancelled')
      await page.wait('document.querySelector("#work-sub")?.innerText.includes("已停止")')
      await page.noOverflow()
      checks.push({ id: 'actual-concurrent-stop', stopped: w1, independent: w2 })
    })
  }
  async function ensureBrowser() {
    if (recording) return
    const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
    for (const actor of ['admin', 'a', 'b']) {
      const profile = join(scratch, 'chrome-' + actor), debugPort = await freePort()
      await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
      await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
      const child = launch('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI', '--user-data-dir=' + profile, '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--app=' + origin], { env: { ...systemEnvironment(), DISPLAY: display } })
      const target = await wait(async () => { if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated Chrome exited'); try { return (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: requestSignal() })).json()).find(value => value.type === 'page' && value.url.startsWith(origin)) } catch { return false } }, 'isolated CDP')
      browsers[actor] = await connect(target, () => restarting); await browsers[actor].viewport(1440, 900)
    }
    await writeFile(caption, 'Kivo TPM：真实 Web 操作；synthetic 数据，渠道为模拟验收', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; await access(font)
    const recorder = launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', display + '.0', '-vf', 'pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=' + font + ':textfile=' + caption + ':reload=1:fontcolor=white:fontsize=24:x=20:y=h-54', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] })
    recording = watchRecording(recorder, fail); recordingAt = recording.state.startedAt
    if (steps.at(-1)?.startSeconds === null) steps.at(-1).startSeconds = 0
    await new Promise(resolvePause => setTimeout(resolvePause, 500)); recording.assertRunning()
  }
  async function front(page) {
    for (const other of Object.values(browsers)) if (other !== page) {
      const window = await other.send('Browser.getWindowForTarget'); await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } })
    }
    const { width, height } = page.size(), window = await page.send('Browser.getWindowForTarget')
    await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } })
    await page.front(); currentPage = page
  }
  async function browserLogin(actor) {
    const page = browsers[actor]; await front(page)
    if (await page.evaluate('Boolean(document.querySelector("#app") && !document.querySelector("#app").classList.contains("hidden"))')) return
    await page.wait('Boolean(document.querySelector("#login-name"))')
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait('!document.querySelector("#app").classList.contains("hidden")')
  }
  async function openConnection(page, id) {
    const form = 'form.admin-form[data-kind="connection"][data-id="' + id + '"]'
    const card = 'details:has(> ' + form + ')'
    if (!await page.evaluate('document.querySelector(' + JSON.stringify(card) + ')?.open')) await page.click(card + ' > summary')
    return form
  }
  async function singleForm(page, actor, type, reference, goal) {
    await page.nav('home'); await page.select('#work-mode', 'single')
    await page.select('#work-employee', ids[actor]); await page.select('#work-skill', readSkill); await page.select('#work-connection', instance(actor).connection.id)
    await page.fill('#work-goal', goal); await page.select('#work-tpm-record-type', type); await page.fill('#work-tpm-reference', reference)
  }
  async function submit(page, actor, goal) {
    const before = new Set((await api(actor, '/api/bootstrap')).works.map(value => value.id))
    await page.click('#submit-work'); await page.wait('document.querySelector("#view-work").classList.contains("active")')
    return wait(async () => (await api(actor, '/api/bootstrap')).works.find(value => !before.has(value.id) && value.goal === goal && value.workType !== 'collaboration-child')?.id, 'UI-created product work')
  }
  async function visibleObservation(page, id) {
    const result = observation(await get(page === browsers.b ? 'b' : 'a', id))
    await page.wait('Boolean(document.querySelector(\'[data-tpm-result="' + result.id + '"]\'))')
    const text = await page.evaluate('document.querySelector(\'[data-tpm-result="' + result.id + '"]\').innerText')
    for (const value of [result.payload.records[0].reference, result.payload.records[0].statusLabel, result.source.sourceInstance, result.payload.queriedAt]) assert(text.includes(value), 'UI source/fact projection missing')
    if (!result.source.sourceTime) assert(text.includes('来源时间：未提供'), 'missing source time was not explicit')
    if (result.payload.records[0].schedule.overdue === null) assert(text.includes('未判断逾期'), 'unknown baseline was not explicit')
  }
  async function shot(label) {
    if (!recording || !currentPage) return
    recording.assertRunning()
    const capture = await currentPage.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const entry = steps.at(-1), file = 'step-' + steps.length + '-' + (entry.screenshots.length + 1) + '.png'
    await writeFile(join(options.output, file), Buffer.from(capture.data, 'base64'), { mode: 0o600 })
    entry.screenshots.push({ file, label, image: capture.data, seconds: (Date.now() - recordingAt) / 1000 })
  }
}

function runtimeEnvironment({ scratch, stateFile, authFile, dshHome, origin, auditFile, contextFile, fixture, standard, webStandard, guard, catalog, auditBinding }) {
  return { ...systemEnvironment(), DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED',
    GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_PORT: new URL(origin).port, GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin,
    GENEWAY_SECRET_ROOT: join(root, 'var/secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'zenmux-p4-model.key', GENEWAY_CONNECTION_CATALOG: catalog,
    NODE_OPTIONS: '--import=' + pathToFileURL(guard).href + ' --import=' + pathToFileURL(fileURLToPath(import.meta.url)).href,
    GENEWAY_NETWORK_AUDIT_RUN_ID: auditBinding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: auditBinding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
    GENEWAY_KIVO_OBSERVER: '1', GENEWAY_KIVO_CONTEXT_LOG: contextFile,
    GENEWAY_KIVO_RECORD_A: fixture.instances[0].records.find(value => value.recordType === 'repair').recordId,
    GENEWAY_KIVO_RECORD_B: fixture.instances[1].records.find(value => value.recordType === 'repair').recordId, GENEWAY_KIVO_STANDARD: standard,
    ...(webStandard ? { GENEWAY_KIVO_WEB_STANDARD: webStandard } : {}),
  }
}
function observeContext(previous, markers, record) {
  assert(markers.a && markers.b && markers.standard, 'synthetic context markers required')
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url)
    if (url.hostname === 'zenmux.ai' && url.pathname === '/api/v1/chat/completions') {
      const body = await request.clone().json(), text = JSON.stringify(body.messages ?? []), current = JSON.stringify(body.messages?.findLast(value => value.role === 'user') ?? {})
      const hasHttpStandard = text.includes(markers.standard), hasWebStandard = Boolean(markers.webStandard && text.includes(markers.webStandard))
      record({ model: body.model, readStep: /SCENARIO:(?:k0-read|step-a)\b/.test(current), checkStep: /SCENARIO:(?:k0-check|step-b)\b/.test(current), httpCheckStep: current.includes('SCENARIO:k0-check'), webCheckStep: current.includes('SCENARIO:step-b'), hasA: text.includes(markers.a), hasB: text.includes(markers.b), hasStandard: hasHttpStandard || hasWebStandard, hasHttpStandard, hasWebStandard, tools: (body.tools ?? []).map(value => value.function?.name ?? value.name) })
      assert.equal(body.model, model, 'unexpected model route')
      assert((body.tools ?? []).every(value => tools.includes(value.function?.name ?? value.name)), 'unexpected model-visible tool')
    }
    return previous(input, init)
  }
}
function validateFixture(fixture, catalog) {
  assert.equal(fixture.dataMode, 'synthetic'); assert.equal(fixture.sourceEnvironment, 'external-test')
  assert(/^[a-f0-9]{40}$/.test(fixture.basis?.kivoCommit ?? '')); assert(/^[a-f0-9]{64}$/.test(fixture.basis?.supportingProbeSha256 ?? ''))
  assert.equal(fixture.instances?.length, 2); assert.equal(catalog.version, 1); assert.equal(catalog.targets?.length, 3, 'catalog must pre-register the explicit rotated A reference')
  const refs = new Set()
  for (const [index, instance] of fixture.instances.entries()) {
    assert.equal(instance.instance, ['a', 'b'][index])
    const connection = instance.connection, url = new URL(connection.baseUrl)
    assert.equal(connection.kind, 'kivo-mcp'); assert.equal(connection.issuer, url.origin)
    assert.equal(url.protocol, 'http:'); assert(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    assert(!url.username && !url.password && !url.search && !url.hash); assert.equal(url.pathname, '/api/v1/mes/mcp')
    assert(/^[0-9a-f-]{36}$/.test(connection.clientId)); assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connection.credentialRef)); assert(!refs.has(connection.credentialRef)); refs.add(connection.credentialRef)
    assert.equal(connection.dataMode, 'synthetic'); assert.equal(connection.sourceEnvironment, 'external-test'); assert.equal(connection.evidenceMode, 'real-mcp-http'); assert.deepEqual(connection.allowedObjectIds, [])
    assert(catalog.targets.some(target => connectionFields.every(key => target[key] === connection[key])), 'fixture connection not in exact catalog')
    assert.equal(instance.records?.length, 6)
    assert.deepEqual(instance.records.map(value => value.recordType).sort(), ['repair', 'maintenance', 'inspection', 'exception', 'plan', 'device'].sort())
    for (const value of instance.records) { assert(value.reference && value.recordId && value.rawStatus); assert(!/[/\\?#\u0000-\u001f]/.test(value.reference)) }
  }
  assert.notEqual(fixture.instances[0].connection.baseUrl, fixture.instances[1].connection.baseUrl)
  assert.notEqual(fixture.instances[0].connection.sourceInstance, fixture.instances[1].connection.sourceInstance)
  rotationTarget(fixture, catalog)
  assert(fixture.lifecycleEvidence && Object.keys(fixture.lifecycleEvidence).sort().join(',') === 'after,before,result', 'explicit same-Host lifecycle evidence is required')
  for (const descriptor of Object.values(fixture.lifecycleEvidence)) {
    assert(descriptor && isAbsolute(descriptor.file) && !within(root, descriptor.file) && /^[a-f0-9]{64}$/.test(descriptor.sha256 ?? ''), 'lifecycle evidence needs an explicit outside-repo file/hash')
  }
  assert(fixture.legacyFixture && isAbsolute(fixture.legacyFixture.file) && !within(root, fixture.legacyFixture.file) && /^[a-f0-9]{64}$/.test(fixture.legacyFixture.sha256 ?? ''), 'explicit outside-repo legacy fixture file/hash is required')
  for (const type of ['repair', 'maintenance', 'inspection', 'exception']) {
    const a = fixture.instances[0].records.find(value => value.recordType === type), b = fixture.instances[1].records.find(value => value.recordType === type)
    assert.equal(a.reference, b.reference); assert.notEqual(a.recordId, b.recordId)
  }
  assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization)"\s*:|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify({ fixture, catalog })), 'secret body is not a fixture input')
  return fixture
}
function rotationTarget(fixture, catalog) {
  const a = fixture.instances[0].connection
  const target = catalog.targets.find(value => value.credentialRef === 'kivo-p4-a-rotated.pem')
  assert(target && connectionFields.filter(key => key !== 'credentialRef').every(key => target[key] === a[key]), 'rotated reference must keep the exact A machine identity/resource')
  assert.notEqual(target.credentialRef, a.credentialRef)
  return target
}
function assertEmptyScope(result) {
  assert.equal(result.payload.status, 'scope_empty'); assert.deepEqual(result.payload.records, [])
  assert.equal(result.payload.linkedDevice, null); assert.equal(result.payload.pagination, null)
}
function assertDeviceName(result, changed) {
  const name = result.payload.linkedDevice?.facts?.name
  if (changed) assert(/^Synthetic device a \[refresh [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]$/.test(name), 'latest observation did not contain the acknowledged synthetic device change')
  else assert.equal(name, 'Synthetic device a', 'original or restored device name did not match')
}
function operatorBarriers(input, { signal, onFailure, onWaiting = () => {}, timeoutMs = 300_000 }) {
  const state = { phase: 'idle', current: null, acknowledged: [], pendingRecovery: [] }
  let pending, failure, ended = false
  const reject = error => {
    if (failure) return
    failure = error; state.phase = 'failed'
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
    onFailure(error)
  }
  const line = value => {
    if (failure) return
    if (!pending || value !== state.current) { reject(new Error('operator acknowledgement was unexpected, duplicate or out of order')); return }
    const accepted = state.current
    state.acknowledged.push({ label: accepted, at: new Date().toISOString() })
    if (accepted === 'update-a-observation') state.pendingRecovery.push('restore-a-observation')
    if (accepted === 'rotate-a-key') state.pendingRecovery.push('install-a-key')
    if (accepted === 'scope-empty-a') state.pendingRecovery.push('restore-scope-a')
    state.phase = 'acknowledged'; state.current = null
    const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve()
  }
  const close = () => { ended = true; if (state.acknowledged.length < barrierLabels.length) reject(new Error('operator input ended before all required acknowledgements')) }
  const abort = () => reject(new Error('operator barrier aborted'))
  input.on('line', line); input.on('close', close); input.on('error', reject); signal.addEventListener('abort', abort, { once: true })
  return {
    state,
    wait(label) {
      if (failure) return Promise.reject(failure)
      if (ended || signal.aborted) return Promise.reject(new Error('operator barrier is unavailable'))
      assert(!pending && label === barrierLabels[state.acknowledged.length], 'operator barrier sequence is fixed')
      state.phase = 'waiting'; state.current = label
      const promise = new Promise((resolveAck, rejectAck) => {
        pending = { resolve: resolveAck, reject: rejectAck, timer: setTimeout(() => reject(new Error('operator acknowledgement timed out')), timeoutMs) }
      })
      onWaiting(label)
      return promise
    },
    recovered(label) {
      assert(state.acknowledged.some(value => value.label === label), 'recovery requires an acknowledged operation and product readback')
      state.pendingRecovery = state.pendingRecovery.filter(value => value !== label)
    },
    dispose() { input.removeListener('line', line); input.removeListener('close', close); input.removeListener('error', reject); signal.removeEventListener('abort', abort); if (pending) reject(new Error('operator barrier closed before acknowledgement')) },
  }
}
function validateCandidate(value) {
  assert(Array.isArray(value.files) && value.files.length, 'candidate requires file hashes')
  const files = value.files.map(entry => {
    assert(typeof entry.path === 'string' && !entry.path.includes('..') && /^(src\/|plugins\/|config\/|web\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(entry.path), 'candidate path outside product')
    assert(/^[a-f0-9]{64}$/.test(entry.sha256)); return entry
  })
  assert.equal(new Set(files.map(value => value.path)).size, files.length)
  for (const file of ['scripts/accept-p4-kivo.mjs', 'scripts/accept-p4-s1.mjs', 'src/server.mjs', 'web/index.html', 'src/collaboration-runner.mjs']) assert(files.some(value => value.path === file), 'candidate missing ' + file)
  return files
}
async function snapshot(files, expectedHead) {
  const head = (await command('git', ['rev-parse', 'HEAD'])).trim(); assert.equal(head, expectedHead, 'HEAD differs from approved candidate')
  const all = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'web', 'plugins', 'config', 'package.json', 'pnpm-lock.yaml', 'scripts/accept-p4-s1.mjs', 'scripts/accept-p4-kivo.mjs'])).split('\0').filter(Boolean).sort()
  const hashes = Object.fromEntries(await Promise.all(all.map(async file => [file, hash(await readFile(join(root, file)))])))
  for (const file of files) assert.equal(hash(await readFile(join(root, file.path))), file.sha256, 'candidate mismatch: ' + file.path)
  const installedSdk = {}
  for (const name of ['dsh', 'dsh-sdk-client', 'dsh-tools']) {
    const bytes = await readFile(join(root, 'node_modules/@deepseek-ai', name, 'package.json')), value = JSON.parse(bytes)
    assert.equal(value.version, '0.2.0-rc.2', 'current installed SDK version differs')
    installedSdk[name] = { version: value.version, packageJsonSha256: hash(bytes) }
  }
  return { head, files: hashes, installedSdk }
}
async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const meta = await file.stat(); assert(meta.isFile() && (meta.mode & 0o777) === 0o600, 'explicit input must be a regular 0600 file'); const bytes = await file.readFile(); return { value: JSON.parse(bytes), sha256: hash(bytes) } }
  finally { await file.close() }
}
async function lifecycleEvidence(descriptors, candidate) {
  const values = {}
  for (const key of ['result', 'before', 'after']) {
    const file = await open(descriptors[key].file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      assert((await file.stat()).isFile(), 'lifecycle evidence must be a regular file')
      const bytes = await file.readFile(); assert.equal(hash(bytes), descriptors[key].sha256, 'lifecycle evidence hash mismatch')
      values[key] = JSON.parse(bytes)
    } finally { await file.close() }
  }
  return validateLifecycle(values, candidate, descriptors)
}
function validateLegacy(value, directory) {
  assert.equal(value.version, 1); assert.equal(value.bindingMode, 'constructed-migration-binding')
  assert.equal(value.dataMode, 'synthetic'); assert.equal(value.sourceEnvironment, 'external-test'); assert.equal(value.ownerMemberId, 'a')
  assert.equal(value.originalTypedStateAvailable, false); assert.equal(value.originalOwnerWorkMappingAvailable, false)
  assert.equal(value.toolResultHashAlgorithm, 'sha256-json-stringify'); assert.equal(value.nativeToolResultHasCurrentSuccessEnvelope, false)
  assert(Array.isArray(value.constructedFields) && value.constructedFields.includes('queriedAt') && value.constructedFields.includes('ownerMemberId'))
  assert(value.projectionQueriedAtSource, 'constructed query-time basis is required')
  assert.equal(Object.keys(value.seed).sort().join(','), 'connections,employees,skills,works')
  for (const key of ['employees', 'skills', 'connections', 'works']) assert(Array.isArray(value.seed[key]) && value.seed[key].length)
  assert.equal(value.sessions?.length, 2); assert.equal(value.seed.works.length, 2)
  assert.equal(new Set(value.sessions.map(session => session.sessionRef)).size, 2)
  assert.equal(new Set(value.seed.works.map(work => work.id)).size, 2)
  for (const session of value.sessions) {
    const match = /^sessions\/[^/.][^/]*\/(session-[a-f0-9]{32})\/session\.v3\.jsonl\.zstd$/.exec(session.relativePath)
    assert(match && match[1] === session.sessionRef && !session.relativePath.includes('..'), 'legacy Session destination must be its exact v3 relative path')
    assert(isAbsolute(session.file) && within(directory, session.file) && !within(root, session.file), 'legacy input must be an explicit fixture file')
    assert(/^[a-f0-9]{64}$/.test(session.sha256) && /^[a-f0-9]{64}$/.test(session.toolResultSha256) && Number.isSafeInteger(session.eventCount) && session.eventCount > 0)
  }
  assert(value.seed.connections.every(connection => connection.kind === 'gearjob-rest' && connection.enabled === false && connection.dataMode === 'synthetic' && connection.sourceEnvironment === 'external-test'), 'legacy transport must remain disabled and synthetic')
  for (const work of value.seed.works) {
    assert(work.id.startsWith('k0-legacy-') && work.ownerMemberId === 'a' && work.capabilityId === 'gearjob-work-order-read' && work.status === 'completed')
    assert(value.seed.employees.some(employee => employee.id === work.employeeId && employee.modelRouteId === 'k0-model'))
    assert(value.seed.skills.some(skill => skill.id === work.skillId && skill.capabilityId === work.capabilityId))
    assert(value.seed.connections.some(connection => connection.id === work.connectionId))
    assert.equal(work.results.length, 1); assert.equal(work.executions.length, 1)
    const result = work.results[0]
    assert.equal(result.kind, 'gearjob.work-order.observation'); assert.equal(result.source.sourceSystem, 'GearJob'); assert.equal(result.source.dataMode, 'synthetic'); assert.equal(result.source.sourceEnvironment, 'external-test')
    assert(value.sessions.some(session => session.sessionRef === result.dshSessionRef && session.sessionRef === work.executions[0].dshSessionRef))
  }
  assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization)"\s*:|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify(value)), 'legacy fixture must not contain credentials')
  return value
}
async function copyLegacy(legacy, dshHome, signal) {
  const dshRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const persistenceRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
  const { historicalSessionFormatCatalog } = await import(pathToFileURL(persistenceRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const evidence = []
  for (const session of legacy.sessions) {
    signal.throwIfAborted()
    const file = await open(session.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try { assert((await file.stat()).isFile()); bytes = await file.readFile(); assert.equal(hash(bytes), session.sha256, 'legacy Session source differs') }
    finally { await file.close() }
    const target = join(dshHome, session.relativePath)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    const rows = (await command('/home/linuxbrew/.linuxbrew/bin/zstd', ['-d', '-c', '--', target], signal)).trimEnd().split('\n').map(line => JSON.parse(line))
    const reader = historicalSessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
    for (const row of rows.slice(1)) reader.decodeRow(row)
    const artifact = reader.finish()
    assert.equal(artifact.header.version, 3); assert.equal(artifact.events.length, session.eventCount)
    const texts = artifact.events.filter(event => event.type === 'tool/result').flatMap(event => event.data.message.content.filter(part => part.type === 'tool-result').map(part => part.content.filter(item => item.type === 'text').map(item => item.text).join('\n')))
    let fact
    for (const text of texts) {
      let value
      try { value = JSON.parse(text) } catch { continue }
      if (hash(JSON.stringify(value)) === session.toolResultSha256) fact = value
    }
    assert(fact, 'legacy native tool JSON differs')
    const projection = legacy.seed.works.find(work => work.results[0].dshSessionRef === session.sessionRef).results[0].payload
    for (const key of ['workOrderId', 'status', 'unit', 'plannedQuantity', 'completedQuantity', 'sourceRecordId', 'sourceRevision', 'sourceTime', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode']) assert.deepEqual(projection[key], fact[key], 'constructed typed projection changed an original fact')
    assert.equal(hash(await readFile(target)), session.sha256, 'strict codec read changed Session bytes')
    evidence.push({ sessionRefHash: hash(session.sessionRef), sha256: session.sha256, version: artifact.header.version, eventCount: artifact.events.length, toolResultSha256: session.toolResultSha256 })
  }
  return evidence
}
async function sessionFiles(dshHome) {
  const files = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else { assert(entry.isFile(), 'isolated Session tree must not contain links'); files[relative(dshHome, path)] = hash(await readFile(path)) }
    }
  }
  await visit(join(dshHome, 'sessions'))
  return files
}
function validateLifecycle(values, candidate, descriptors) {
  assert.deepEqual(values.before, values.after, 'lifecycle producer candidate changed during its run')
  const affected = ['src/collaboration-runner.mjs', 'plugins/kivo-tpm.mjs', 'config/p1-runtime.patch.yml']
  for (const path of affected) {
    const binding = values.before.find(value => value.path === path)
    assert(binding && binding.sha256 === candidate.files[path], 'same-Host lifecycle code differs from this candidate')
  }
  for (const key of ['ok', 'nativeSdk', 'nativeSharedHost', 'sameHost', 'pluginDisposeAbortsIo', 'chatAfterDispose']) assert.equal(values.result[key], true, 'lifecycle producer did not prove ' + key)
  assert.deepEqual([...values.result.toolsAfterRemount].sort(), ['geneway_kivo_tpm_list_records', 'geneway_kivo_tpm_read_record'])
  assert.equal(values.result.realProviderRequests, 0); assert.equal(values.result.realKivoRequests, 0); assert.equal(values.result.dataMode, 'synthetic')
  return { source: 'controlled-native-same-Host', artifacts: descriptors, codeBindings: values.before.filter(value => affected.includes(value.path)), producerRuntime: values.before.find(value => value.path === 'scripts/test-kivo-runtime.mjs'), sameHost: true, pluginDisposeAbortsIo: true, chatAfterDispose: true, toolsAfterRemount: values.result.toolsAfterRemount,
    scope: 'Only recorded unchanged shared-Host/plugin/config code; not all final core files or real Kivo/Flash acceptance',
    dependencyLimit: 'Only the three code bindings above are required to match this acceptance; other recorded dependency hashes are supporting evidence' }
}
function validateObservation(result, instance, type) {
  assert.equal(result.kind, 'kivo.tpm.observation')
  const value = result.payload, expected = instance.records.find(record => record.recordType === type)
  assert.equal(value.status, 'ok'); assert.equal(value.mode, 'record'); assert.equal(value.recordType, type); assert.equal(value.records.length, 1)
  assert.equal(value.records[0].id, expected.recordId); assert.equal(value.records[0].reference, expected.reference); assert.equal(value.records[0].rawStatus, expected.rawStatus)
  assert.equal(value.linkedDevice?.id ?? null, expected.linkedDeviceId)
  assert.equal(value.source.sourceInstance, instance.connection.sourceInstance); assert.equal(value.source.dataMode, 'synthetic')
  assert.equal(result.source.sourceInstance, value.source.sourceInstance)
  assert(Number.isFinite(Date.parse(value.queriedAt))); assert(value.sources.every(source => source.traceId && source.queriedAt))
}
function observation(work) { const value = work.results.findLast(result => result.kind === 'kivo.tpm.observation'); assert(value, 'native typed observation missing'); return value }
function workSessions(work) { return [...new Set(work.executions.map(value => value.dshSessionRef).filter(Boolean))].sort() }
async function assertStopped(children, auth) {
  for (const child of children) if (child.pid) for (const pid of [child.pid, -child.pid]) {
    try { process.kill(pid, 0); assert.fail('owned process/group remains alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await assert.rejects(access(auth), { code: 'ENOENT' })
}
async function stopGroup(child, signal, close = stop, kill = (pid, value) => process.kill(pid, value)) {
  await close(child, signal)
  if (!Number.isInteger(child?.pid)) return
  const remains = () => { try { kill(-child.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  // An exited parent can leave its SDK children in the owned detached group.
  if (remains()) { kill(-child.pid, 'SIGKILL'); await poll(() => !remains(), 'owned process group exit', 10_000) }
}
async function jsonLines(file) { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function path(id, action) { return '/api/works/' + encodeURIComponent(id) + (action ? '/' + action : '') }
function surface(path) { return path.replace(/(\/api\/(?:works|knowledge|conversations)\/)[^/]+/g, '$1:id') }
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function within(parent, child) { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
function safeFailure(error) {
  if (error?.generatedMessage) return '验收断言未通过，请按最后执行步骤核对。'
  if (error?.code && error.code !== 'ERR_ASSERTION') return '验收失败（' + String(error.code).replace(/[^A-Z0-9_]/g, '').slice(0, 80) + '）'
  return String(error?.message ?? '验收失败').split('\n')[0].replace(/(?:Bearer\s+\S+|-----BEGIN.*)/g, '[已隐藏]').slice(0, 240)
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]) }
function manual(report) {
  const cleanup = (report.cleanup?.allOwnedProcessesExited === true ? '本轮隔离服务已关闭。' : '本轮进程退出尚未确认。') + (report.cleanup?.authRemoved === true ? '临时登录凭据已删除。' : '临时凭据清理尚未确认。')
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kivo TPM 操作与验收说明</title><style>body{max-width:1080px;margin:32px auto;padding:0 24px;font:17px/1.7 system-ui;color:#172033;background:#f5f7fb}section{background:white;padding:24px;margin:24px 0;border:1px solid #dce2ed;border-radius:12px}img,video{max-width:100%;height:auto}.failed{background:#fff1ed}code{overflow-wrap:anywhere}</style><h1>Kivo TPM 操作与验收说明</h1><p>' + esc(report.scope) + '</p><p>候选：<code>' + esc(report.candidate.preflight.head) + '</code>。模型：' + esc(model) + '。' + (report.ok ? '本轮所列旅程检查通过。' : '本轮尚未通过：' + esc(report.failure || '必需步骤未完成') + '。详见实际检查记录。') + '本材料不单独宣称完整 K0 验收完成。</p><p>' + cleanup + '</p><p><a href="observations.json">实际检查记录</a></p>' + (report.media.video ? '<p><a href="p4-kivo.mp4">完整操作视频</a></p><video controls preload="metadata" src="p4-kivo.mp4"></video>' : '<p>' + (report.mode === 'http-native-supporting' ? '本轮为 HTTP/native 支持验证，未运行浏览器或录制视频。' : '本轮未取得录制文件，请先核对失败步骤。') + '</p>') +
    report.steps.map(step => '<section class="' + (step.passed ? '' : 'failed') + '"><h2>' + esc(step.title ?? step.id) + '</h2><p>' + (step.passed ? '已取得本步实际通过结果。' : '本步未达到预期，需复核后重新验收。') + '</p>' + step.screenshots.map(shot => '<figure><img src="data:image/png;base64,' + shot.image + '" alt="' + esc(shot.label) + '"><figcaption>' + esc(shot.label) + '</figcaption></figure>').join('') + (step.startSeconds === null ? '' : '<p>对应视频 ' + Math.floor(step.startSeconds) + '–' + Math.ceil(step.endSeconds ?? step.startSeconds) + ' 秒。</p>') + '</section>').join('') +
    (report.operator?.pendingRecovery.length ? '<section class="failed"><h2>尚待产品回读确认的上游恢复</h2><p>' + esc(report.operator.pendingRecovery.join('、')) + '。已确认的屏障见检查记录；请维护者先核对是否仍需恢复。本脚本不会自动修改 Kivo 或重复上游操作。</p></section>' : '') +
    '<section><h2>历史兼容范围</h2><p>旧来源检查使用两份真实旧 Session 的原字节，typed 投影沿用旧领域格式。成员、工作与原生引用的关联为本次明确构造；原 typed state 与原成员映射没有备份，本材料不证明原历史 state 恢复。夹具查询时间是构造选择，原来源时间与业务事实保持原值。原生读回使用当前官方历史 codec，不冒充产品中的工作原生历史接口。</p></section>' +
    '<section><h2>范围与后续核对</h2><p>选择当前获准员工、Skill 和 Kivo 连接创建查询；缺少标识时从原工作补充继续。“追问”解释已保存事实，“查询最新”追加观察；翻页预填新工作并保留原页历史。停止只作用于选定工作，既有来源和结果保留。业务数据均为两个独立实例中的 synthetic 记录。</p><p>本轮审计要求共享 Host 与其精确官方 SDK 子进程的启动、预载就绪、实际模型请求及退出能够按运行、候选和父子 PID 关联；缺失时本轮不通过。该记录仅覆盖所选 Node 启动与网络 API，不代表整台机器或其他子进程；Host 上的合成上下文标志也不代替 SDK 子进程审计。生命周期、旧历史和上游安全检查须结合各自证据评估。</p></section></html>'
}

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true })
  assert.throws(() => argumentsFor(['--run']), /required/)
  assert.throws(() => argumentsFor(['--harness-check', '--http-only']), /require/)
  assert.equal(new Set([...httpSteps, ...webSteps]).size, httpSteps.length + webSteps.length)
  assert.equal(typeof connect, 'function'); assert.equal(typeof firstLine, 'function'); assert.equal(typeof watchRecording, 'function')
  const marker = { a: 'RECORD_A_ONLY', b: 'RECORD_B_ONLY', standard: 'HTTP_STANDARD_ONLY', webStandard: 'WEB_STANDARD_ONLY' }, records = []
  let calls = 0
  const observed = observeContext(async () => { calls += 1; return new Response('{}') }, marker, value => records.push(value))
  const request = (messages, visibleTools = []) => ({ method: 'POST', headers: { authorization: 'Bearer SYNTHETIC_SECRET' }, body: JSON.stringify({ model, messages, tools: visibleTools.map(name => ({ function: { name } })) }) })
  await observed('https://zenmux.ai/api/v1/chat/completions', request([{ role: 'user', content: 'SCENARIO:k0-check RECORD_A_ONLY HTTP_STANDARD_ONLY' }], ['geneway_knowledge_search']))
  assert.equal(calls, 1); assert.equal(records[0].hasA, true); assert.equal(records[0].hasB, false); assert.equal(records[0].hasStandard, true); assert.equal(records[0].checkStep, true)
  assert.equal(records[0].hasHttpStandard, true); assert.equal(records[0].hasWebStandard, false)
  await observed('https://zenmux.ai/api/v1/chat/completions', request([{ role: 'user', content: 'SCENARIO:step-b RECORD_A_ONLY WEB_STANDARD_ONLY' }]))
  assert.equal(calls, 2); assert.equal(records[1].webCheckStep, true); assert.equal(records[1].hasWebStandard, true); assert.equal(records[1].hasHttpStandard, false)
  assert(!JSON.stringify(records).includes(marker.a)); assert(!JSON.stringify(records).includes('SYNTHETIC_SECRET'))
  await assert.rejects(observed('https://zenmux.ai/api/v1/chat/completions', request([], ['tpm.repair.create'])), /unexpected model-visible tool/)
  await assert.rejects(observed('https://zenmux.ai/api/v1/chat/completions', { ...request([]), body: JSON.stringify({ model: 'wrong-model', messages: [] }) }), /unexpected model route/)
  assert.equal(calls, 2)
  const html = manual({ ok: false, scope: '<script>unsafe</script>', candidate: { preflight: { head: 'synthetic' } }, cleanup: { authRemoved: false, allOwnedProcessesExited: false }, media: { video: 'p4-kivo.mp4' }, steps: [{ id: 'synthetic', passed: true, screenshots: [{ image: 'c3ludGhldGlj', label: '合成图' }], startSeconds: 1, endSeconds: 2 }] })
  assert(!html.includes('<script>')); assert(!/(?:src|href)="https?:/.test(html)); assert(html.includes('data:image/png;base64,c3ludGhldGlj')); assert(html.includes('href="p4-kivo.mp4"')); assert(!html.includes('已关闭')); assert(!html.includes('凭据已删除'))
  await barrierChecks()
  await webContinueChecks()
  await webSingleContinueChecks()
  await webCredentialRotationChecks()
  await knowledgeRevocationChecks()
  const signals = []; let alive = true
  await stopGroup({ pid: 12345, exitCode: 1 }, undefined, async () => {}, (pid, signal) => {
    assert.equal(pid, -12345); signals.push(signal)
    if (signal === 'SIGKILL') alive = false
    else if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  assert.deepEqual(signals, [0, 'SIGKILL', 0])
  const fixture = syntheticFixture(), catalog = { version: 1, targets: fixture.instances.map(value => Object.fromEntries(connectionFields.map(key => [key, value.connection[key]]))) }
  catalog.targets.push({ ...catalog.targets[0], credentialRef: 'kivo-p4-a-rotated.pem' })
  validateFixture(fixture, catalog)
  for (const change of [
    value => { value.instances[0].connection.dataMode = 'production' },
    value => { value.instances[1].connection.baseUrl = value.instances[0].connection.baseUrl },
    value => { value.instances[0].connection.allowedObjectIds = ['R-1'] },
    value => { value.machinePrivateKey = 'SYNTHETIC_SECRET' },
  ]) { const invalid = structuredClone(fixture); change(invalid); assert.throws(() => validateFixture(invalid, catalog)) }
  const swapped = structuredClone(catalog); swapped.targets[2].clientId = fixture.instances[1].connection.clientId
  assert.throws(() => validateFixture(fixture, swapped), /exact A machine/)
  assert.throws(() => validateCandidate({ files: [{ path: '../var/secrets/key', sha256: 'a'.repeat(64) }] }), /outside/)
  const auditBinding = { runId: 'kivo-pure-check', candidate: 'a'.repeat(64), guardSha256: 'b'.repeat(64) }
  const env = runtimeEnvironment({ scratch: '/tmp/kivo-pure', stateFile: '/tmp/kivo-pure/state.json', authFile: '/tmp/kivo-pure/auth.json', dshHome: '/tmp/kivo-pure/dsh', origin: 'http://127.0.0.1:3003', auditFile: '/tmp/kivo-pure/network.jsonl', contextFile: '/tmp/kivo-pure/context.jsonl', fixture, standard: 'SYNTHETIC_STANDARD', guard: '/tmp/approved-guard.mjs', catalog: '/tmp/exact-catalog.json', auditBinding })
  assert.equal(env.GENEWAY_SECRET_ROOT, join(root, 'var/secrets')); assert.equal(env.GENEWAY_MODEL_CREDENTIAL_REF, 'zenmux-p4-model.key')
  assert.equal(env.DSH_HOME, env.GENEWAY_DSH_HOME); assert(!within(root, env.GENEWAY_AUTH_FILE))
  assert.equal(env.GENEWAY_NETWORK_AUDIT_ROLE, 'host'); assert.equal(env.GENEWAY_NETWORK_AUDIT_CANDIDATE, auditBinding.candidate)
  assert(!Object.keys(env).some(key => /GEARJOB|HIVE|FEISHU|ZENMUX_API_KEY|MACHINE_PRIVATE|ACCESS_TOKEN/.test(key)))
  const bindings = ['src/collaboration-runner.mjs', 'plugins/kivo-tpm.mjs', 'config/p1-runtime.patch.yml'].map(path => ({ path, sha256: 'a'.repeat(64) }))
  const evidence = { before: bindings, after: structuredClone(bindings), result: { ok: true, nativeSdk: true, nativeSharedHost: true, sameHost: true, pluginDisposeAbortsIo: true, chatAfterDispose: true, toolsAfterRemount: ['geneway_kivo_tpm_list_records', 'geneway_kivo_tpm_read_record'], realProviderRequests: 0, realKivoRequests: 0, dataMode: 'synthetic' } }
  const bound = { files: Object.fromEntries(bindings.map(value => [value.path, value.sha256])) }
  validateLifecycle(evidence, bound, fixture.lifecycleEvidence)
  assert.throws(() => validateLifecycle({ ...evidence, result: { ...evidence.result, pluginDisposeAbortsIo: false } }, bound, fixture.lifecycleEvidence), /did not prove/)
  assert.throws(() => validateLifecycle(evidence, { files: {} }, fixture.lifecycleEvidence), /differs/)
  const legacy = syntheticLegacy()
  validateLegacy(legacy, '/tmp/kivo-pure-legacy')
  for (const change of [
    value => { value.originalTypedStateAvailable = true },
    value => { value.seed.members = [] },
    value => { value.sessions[0].relativePath = '../session.v3.jsonl.zstd' },
    value => { value.seed.connections[0].enabled = true },
    value => { value.seed.works[0].ownerMemberId = 'b' },
    value => { value.seed.works[0].results[0].dshSessionRef = 'unbound-native' },
  ]) { const invalid = structuredClone(legacy); change(invalid); assert.throws(() => validateLegacy(invalid, '/tmp/kivo-pure-legacy')) }
  assertDeviceName({ payload: { linkedDevice: { facts: { name: 'Synthetic device a' } } } }, false)
  assertDeviceName({ payload: { linkedDevice: { facts: { name: 'Synthetic device a [refresh 00000000-0000-4000-8000-000000000001]' } } } }, true)
  assert.throws(() => assertDeviceName({ payload: { linkedDevice: { facts: { name: 'Synthetic device a' } } } }, true), /acknowledged/)
  assert.equal(safeFailure(Object.assign(new Error('PRIVATE_NATIVE_ID'), { generatedMessage: true })), '验收断言未通过，请按最后执行步骤核对。')
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', checks: ['S1-import-safe', 'explicit-input-boundaries', 'fixture-and-exact-rotation-binding', 'HTTP-and-Web-context-separation', 'wrong-model-and-write-tool-rejection', 'same-Host-evidence-binding', 'constructed-legacy-binding-disabled-transport-and-exact-files', 'changed-and-restored-observation', 'owned-orphan-group-cleanup', 'offline-escaping-and-cleanup-prose', 'operator-label-order-duplicate-EOF-timeout-abort-and-recovery', 'web-collaboration-delayed-admission-and-rejected-or-lost-reference', 'web-single-continue-durable-execution-input-and-http-denials', 'web-credential-save-completion-before-visible-test', 'knowledge-checker-revocation-and-stale-restoration'], nativeStarts: 0, modelRequests: 0, browserStarts: 0, serverStarts: 0, kivoRequests: 0, realSecretReads: 0 }))

  async function knowledgeRevocationChecks() {
    const { createKnowledgeService, canUseKnowledgeMaterial, currentKnowledgeReference } = await import('../src/knowledge-service.mjs')
    const { createWorkService } = await import('../src/work-service.mjs')
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8'), start = source.indexOf("      const material = await api('a', '/api/knowledge/' + refs.standard)"), end = source.indexOf("\n    })\n    await step('restart-history'", start)
    assert(start >= 0 && end > start)
    const standard = 'SYNTHETIC_REVOKED_STANDARD', owner = { id: 'a' }
    let state = { members: [{ id: 'a', enabled: true, employeeIds: [ids.a, ids.lead, ids.check] }, { id: 'b', enabled: true, employeeIds: [ids.b] }], employees: Object.values(ids).map(id => ({ id, enabled: true })), knowledgeMaterials: [], works: [] }
    const store = { async read() { return structuredClone(state) }, async update(apply) { state = await apply(structuredClone(state)); return structuredClone(state) } }
    const knowledge = createKnowledgeService({ store, idFactory: () => 'synthetic' }), work = createWorkService({ store })
    const material = await knowledge.createMaterial(owner, { employeeIds: [ids.lead, ids.check], title: '合成标准', body: standard, format: 'text', sourceLabel: 'synthetic', authorizationBasis: 'synthetic' })
    const found = (await knowledge.search(owner, { employeeId: ids.check, query: standard }))[0], ref = { knowledgeId: found.knowledgeId, revision: found.revision, segmentId: found.segmentId }
    const base = (id, employeeId) => ({ id, ownerMemberId: 'a', employeeId, status: 'completed', results: [], executions: [], actions: [] })
    state.works = [
      { ...base('root', ids.lead), collaboration: { status: 'completed' }, plan: { items: [{ id: 'check', childWorkId: 'child' }] }, handoffs: [{ childWorkId: 'child', status: 'current', knowledgeRefs: [ref] }], results: [{ kind: 'assistant.collaboration-summary', explanation: standard, payload: { text: standard }, knowledgeDependencyRefs: [ref] }] },
      { ...base('child', ids.check), rootWorkId: 'root', knowledgeQuery: standard, results: [{ kind: 'kivo.tpm.observation', explanation: standard, payload: { text: standard }, knowledgeDependencyRefs: [ref] }] },
    ]
    const initial = JSON.stringify(state)
    await assert.rejects(knowledge.updateMaterial(owner, material.id, { expectedRevision: 1, employeeIds: [] }), { code: 'INVALID_REQUEST', status: 400 }); assert.equal(JSON.stringify(state), initial)
    let patches = 0
    const api = async (actor, url, method = 'GET', body) => {
      if (url === '/api/knowledge/search') return knowledge.search({ id: actor }, body)
      assert.equal(actor, 'a'); assert.equal(url, '/api/knowledge/' + material.id)
      if (method === 'PATCH') { const updated = await knowledge.updateMaterial(owner, material.id, body); if (++patches === 1) { assert.equal(canUseKnowledgeMaterial(state, updated, 'a', ids.check), false); assert.equal(canUseKnowledgeMaterial(state, updated, 'a', ids.lead), true); await assert.rejects(knowledge.readMaterial(owner, material.id, { employeeId: ids.check }), { code: 'NOT_FOUND', status: 404 }); assert.deepEqual(await knowledge.search(owner, { employeeId: ids.check, query: standard }), []); assert(!JSON.stringify((await work.getWork(owner, 'child')).value).includes(standard)) } return updated }
      return knowledge.getMaterial(owner, material.id)
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await new AsyncFunction('api', 'refs', 'get', 'assert', 'standard', 'ids', 'path', 'rejected', source.slice(start, end))(api, { standard: material.id, collaboration: 'root' }, async (actor, id) => (await work.getWork({ id: actor }, id)).value, assert, standard, ids, path, async (actor, url, method, body, statuses) => { assert.equal(url, path('root')); assert.equal(method, 'GET'); assert(statuses.includes((await work.getWork({ id: actor }, 'root')).error.status)) })
    assert.equal(patches, 2); assert.equal(currentKnowledgeReference(state, ref, 'a', ids.check), undefined)
    assert.equal((await knowledge.search(owner, { employeeId: ids.check, query: standard }))[0].revision, 3); assert.deepEqual(state.members.find(member => member.id === 'b').employeeIds, [ids.b])
    await work.close()
  }

  async function webCredentialRotationChecks() {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8'), web = await readFile(join(root, 'web/index.html'), 'utf8')
    const take = (text, start, end) => { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, start); return text.slice(a, b) }
    const body = take(source, '        const form = await openConnection(browsers.admin', "      }\n      assertObservation(await completed('a'")
    const formActions = take(web, '    async function saveAdminForm(', '    async function disableSkill(')
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    for (const scenario of ['delayed-save', 'previous-success', 'wrong-readback', 'http-400', 'http-403', 'without-completion-wait']) {
      const saved = '配置已保存并从服务端回读', passed = '协议与固定只读工具目录测试通过', id = 'synthetic-a', newRef = 'synthetic-next.pem'
      let message = scenario === 'previous-success' ? saved : '', persistedRef = 'synthetic-old.pem', domRef, savePromise, testPromise, releasePatch, saveComplete = false, loaded = false, reloaded = false, tests = 0, saves = 0
      const patchDone = new Promise(resolvePatch => { releasePatch = resolvePatch })
      const fields = ['name', 'kind', 'targetIdentity', 'baseUrl', 'credentialRef', 'issuer', 'clientId', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'enabled']
      const form = { dataset: { kind: 'connection', id }, elements: Object.fromEntries(fields.map(key => [key, { value: 'synthetic', checked: true }])) }
      const api = async (path, options = {}) => {
        if (options.method === 'PATCH') {
          assert.equal(message, '正在保存…', 'current submit must replace any previous success before committing')
          if (scenario.startsWith('http-')) throw Object.assign(new Error('synthetic save rejected'), { status: Number(scenario.slice(5)) })
          persistedRef = options.body.credentialRef; await patchDone; return {}
        }
        if (path.endsWith('/test')) { tests += 1; return { ok: true } }
        return [{ id, credentialRef: persistedRef, status: tests ? 'ready' : 'unknown' }]
      }
      const frontend = new Function('api', 'loadAdmin', 'reloadAll', 'setMessage', 'selected', formActions + '\nreturn {saveAdminForm,testConnection}')(
        api, async () => { loaded = true; domRef = scenario === 'wrong-readback' ? 'synthetic-wrong.pem' : persistedRef }, async () => { assert(loaded); reloaded = true },
        (_target, text) => { message = text; if (text === saved) { assert(loaded && reloaded); saveComplete = true } }, () => [],
      )
      const page = {
        async fill(_selector, value) { form.elements.credentialRef.value = domRef = value },
        async click(selector) { if (selector.endsWith('button.btn.primary')) { saves += 1; savePromise = frontend.saveAdminForm({ preventDefault() {}, currentTarget: form }); if (!scenario.startsWith('http-')) assert.equal(message, '正在保存…'); return } assert(saveComplete, 'test click raced pending save render'); testPromise = frontend.testConnection(id) },
        async evaluate() { return domRef },
        async wait(expression) { if (expression.includes(saved)) { assert.equal(message, '正在保存…'); assert(!saveComplete); releasePatch(); await savePromise; assert(saveComplete && loaded && reloaded); assert.equal(message, saved) } else { await testPromise; assert(message.includes(passed), 'test success missing') } },
      }
      const candidateBody = scenario === 'without-completion-wait' ? body.split('\n').filter(line => !line.includes(saved) && !line.includes('new credential reference missing from refreshed form')).join('\n') : body
      let failure
      try { await new AsyncFunction('openConnection', 'browsers', 'instance', 'rotated', 'wait', 'api', 'shot', 'assert', candidateBody)(async () => 'form.synthetic', { admin: page }, () => ({ connection: { id } }), { credentialRef: newRef }, async (check, label) => { assert(await check(), 'predicate not reached: ' + label) }, async (_actor, path) => api(path), async () => {}, assert) } catch (error) { failure = error }
      assert.equal(saves, 1, 'never retry the save click')
      if (['delayed-save', 'previous-success'].includes(scenario)) { assert.ifError(failure); assert.equal(tests, 1); assert(message.includes(passed)) }
      else { assert(failure, scenario + ' must not pass'); assert.equal(tests, 0); assert.match(failure.message, scenario === 'wrong-readback' ? /new credential reference missing/ : scenario.startsWith('http-') ? /explicit new credential reference/ : /pending save render/) }
    }
  }

  async function webSingleContinueChecks() {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
    const start = source.indexOf("      await page.fill('#continue-tpm-reference'")
    const end = source.indexOf('      await visibleObservation(page, refs.web)', start)
    assert(start > 0 && end > start, 'check the actual single-work Web continue call site')
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)('page', 'record', 'get', 'completed', 'wait', 'refs', 'assertObservation', 'assert', source.slice(start, end))
    for (const scenario of ['delayed', 'completed-before-read', 'http-400', 'http-403', 'wrong-work-input', 'wrong-execution-input', 'wrong-operation', 'old-execution-only']) {
      const refs = { web: 'synthetic-single' }, input = { recordType: 'repair', reference: 'SYNTHETIC-REPAIR' }
      const prior = { id: 'prior', operation: 'continue', input }
      let work = { id: refs.web, status: 'waiting_input', input: { recordType: 'repair' }, executions: scenario === 'old-execution-only' ? [prior] : [] }
      let clicks = 0, readsBeforeAdmission = 0, completedCalls = 0, observations = 0
      const page = {
        responses: [],
        async fill(selector, value) { assert.equal(selector, '#continue-tpm-reference'); assert.equal(value, input.reference) },
        async click(selector) { assert.equal(selector, '#continue-form button'); clicks += 1 },
      }
      const publish = () => {
        if (scenario.startsWith('http-')) { page.responses.push({ path: '/api/works/:id/continue', status: Number(scenario.slice(5)) }); return }
        const execution = { id: 'new-continue', operation: scenario === 'wrong-operation' ? 'follow-up' : 'continue', input: scenario === 'wrong-execution-input' ? { ...input, reference: 'WRONG' } : input }
        work = { ...work, status: scenario === 'completed-before-read' ? 'completed' : 'accepted', input: scenario === 'wrong-work-input' ? { ...input, reference: 'WRONG' } : input, executions: scenario === 'old-execution-only' ? [prior] : [...work.executions, execution] }
      }
      const wait = async check => {
        for (let count = 0; count < 5; count += 1) {
          const accepted = await check(); if (accepted) return accepted
          assert.equal(completedCalls, 0, 'do not read completion before single-work admission')
          readsBeforeAdmission += 1
          if (readsBeforeAdmission === 2) publish()
        }
        throw new Error('synthetic UI continue not accepted')
      }
      const completed = async (actor, id) => {
        completedCalls += 1; assert.equal(actor, 'a'); assert.equal(id, refs.web)
        assert.notEqual(work.status, 'waiting_input', 'native work did not complete')
        return { ...work, status: 'completed' }
      }
      const observe = (value, actor, type) => { observations += 1; assert.equal(value.id, refs.web); assert.equal(value.status, 'completed'); assert.equal(actor, 'a'); assert.equal(type, 'repair') }
      const pending = execute(page, () => input, async () => structuredClone(work), completed, wait, refs, observe, assert)
      if (['delayed', 'completed-before-read'].includes(scenario)) {
        await pending; assert.equal(completedCalls, 1); assert.equal(observations, 1)
      } else {
        const expected = scenario.startsWith('http-') ? /UI continue request rejected/ : scenario === 'wrong-work-input' ? /UI continue work input differs/ : scenario === 'wrong-execution-input' ? /UI continue execution input differs/ : scenario === 'wrong-operation' ? /UI continue operation differs/ : /synthetic UI continue not accepted/
        await assert.rejects(pending, expected); assert.equal(completedCalls, 0); assert.equal(observations, 0)
      }
      assert.equal(readsBeforeAdmission, scenario === 'old-execution-only' ? 5 : 2)
      assert.equal(clicks, 1, 'single-work continue must never retry the click')
    }
  }

  async function webContinueChecks() {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
    const start = source.indexOf("      await page.fill('#collaboration-input-step-b-reference'")
    const end = source.indexOf('      await assertCollaboration(done, material.id', start)
    assert(start > 0 && end > start, 'check the actual Web continue call site')
    const execute = new (Object.getPrototypeOf(async function () {}).constructor)('page', 'record', 'get', 'completed', 'wait', 'store', 'id', 'checks', 'assert', source.slice(start, end) + '\nreturn done')
    for (const scenario of ['delayed', 'completed-before-read', 'rejected', 'wrong-reference', 'redraw-empty']) {
      const id = 'synthetic-root', reference = '00000000-0000-4000-8000-000000000001', diagnostics = []
      let work = { id, status: 'waiting_input', collaboration: { generation: 1 }, plan: { revision: 2, items: [{ id: 'step-b', childWorkId: 'synthetic-child' }] }, executions: [{ id: 'initial', operation: 'collaboration-root', generation: 1 }] }
      const child = { id: 'synthetic-child', input: { recordType: 'plan' }, executions: [] }
      let clicks = 0, readsBeforeAdmission = 0, completedCalls = 0
      const page = {
        responses: [],
        async fill(selector, value) { assert.equal(selector, '#collaboration-input-step-b-reference'); assert.equal(value, reference) },
        async click(selector) { assert.equal(selector, '#collaboration-continue-form button'); clicks += 1 },
        async evaluate() { return { formPresent: true, referencePresent: scenario !== 'redraw-empty', referenceMatches: !['wrong-reference', 'redraw-empty'].includes(scenario), submitting: false, errorVisible: scenario === 'rejected' } },
      }
      const publish = () => {
        if (scenario === 'rejected') { page.responses.push({ path: '/api/works/:id/continue', status: 403 }); return }
        work = { ...work, status: scenario === 'completed-before-read' ? 'completed' : 'accepted', collaboration: { generation: 2 }, executions: [...work.executions, { id: 'continued', operation: 'collaboration-continue', generation: 2, planRevision: 2 }] }
        child.input = { recordType: 'plan', ...(scenario === 'redraw-empty' ? {} : { reference: scenario === 'wrong-reference' ? 'SYNTHETIC_SECRET' : reference }) }
        child.executions.push({ id: 'continued-child', operation: 'collaboration-continue-child', generation: 2 })
      }
      const wait = async check => {
        for (let count = 0; count < 5; count += 1) {
          const value = await check(); if (value) return value
          assert.equal(completedCalls, 0, 'must not ask for completion before durable admission')
          readsBeforeAdmission += 1
          if (readsBeforeAdmission === 2) publish()
        }
        throw new Error('synthetic Web continue was not accepted')
      }
      const completed = async () => {
        completedCalls += 1
        assert.notEqual(work.status, 'waiting_input', 'native work did not complete')
        assert.equal(work.collaboration.generation, 2)
        assert.equal(child.input.reference, reference)
        return { ...work, status: 'completed' }
      }
      const pending = execute(page, () => ({ reference }), async () => structuredClone(work), completed, wait, { read: async () => ({ works: [work, child] }) }, id, diagnostics, assert)
      if (['delayed', 'completed-before-read'].includes(scenario)) {
        assert.equal((await pending).status, 'completed'); assert.equal(readsBeforeAdmission, 2); assert.equal(completedCalls, 1)
      } else {
        await assert.rejects(pending, scenario === 'rejected' ? /UI collaboration continue request rejected/ : /UI collaboration continue lost the expected reference/)
        assert.equal(completedCalls, 0); assert.equal(diagnostics.length, 1)
        assert.equal(diagnostics[0].ui.referenceMatches, scenario === 'rejected')
        assert(!JSON.stringify(diagnostics).includes('SYNTHETIC_SECRET'), 'failure diagnostics must not contain input or response bodies')
        if (scenario === 'rejected') assert.deepEqual(diagnostics[0].httpStatuses, [403])
        if (scenario === 'redraw-empty') assert.equal(diagnostics[0].ui.referencePresent, false)
      }
      assert.equal(clicks, 1, 'never retry the user submit')
    }
  }

  async function barrierChecks() {
    const input = new EventEmitter(), errors = [], controller = new AbortController()
    const barriers = operatorBarriers(input, { signal: controller.signal, onFailure: error => errors.push(error) })
    for (const label of barrierLabels) { const pending = barriers.wait(label); input.emit('line', label); await pending }
    assert.equal(barriers.state.acknowledged.length, 6)
    assert.deepEqual(barriers.state.pendingRecovery, ['restore-a-observation', 'install-a-key', 'restore-scope-a'])
    barriers.recovered('restore-a-observation'); barriers.recovered('install-a-key'); barriers.recovered('restore-scope-a'); assert.deepEqual(barriers.state.pendingRecovery, [])
    barriers.dispose(); assert.deepEqual(errors, [])
    for (const scenario of ['wrong', 'duplicate', 'EOF', 'abort', 'timeout']) {
      const source = new EventEmitter(), controller = new AbortController(), failures = []
      const current = operatorBarriers(source, { signal: controller.signal, onFailure: error => failures.push(error), timeoutMs: scenario === 'timeout' ? 5 : 1000 })
      const waiting = current.wait('update-a-observation')
      if (scenario === 'duplicate') {
        source.emit('line', 'update-a-observation'); await waiting; source.emit('line', 'update-a-observation')
        await assert.rejects(current.wait('restore-a-observation'))
        assert.equal(current.state.acknowledged.length, 1)
      } else {
        const rejected = assert.rejects(waiting)
        if (scenario === 'wrong') source.emit('line', 'install-a-key')
        if (scenario === 'EOF') source.emit('close')
        if (scenario === 'abort') controller.abort()
        await rejected; assert.equal(current.state.acknowledged.length, 0)
      }
      assert.equal(current.state.phase, 'failed'); assert.equal(failures.length, 1); current.dispose()
    }
  }
}
function syntheticFixture() {
  const instances = ['a', 'b'].map((instance, index) => ({
    instance, connection: { id: 'kivo-' + instance, name: '合成 ' + instance, kind: 'kivo-mcp', targetIdentity: 'http://127.0.0.1:' + (3001 + index), baseUrl: 'http://127.0.0.1:' + (3001 + index) + '/api/v1/mes/mcp', issuer: 'http://127.0.0.1:' + (3001 + index), clientId: '00000000-0000-4000-8000-00000000000' + index, credentialRef: 'kivo-p4-' + instance + '.pem', sourceSystem: 'Kivo', sourceInstance: 'synthetic-' + instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-mcp-http', allowedObjectIds: [] },
    records: ['repair', 'maintenance', 'inspection', 'exception', 'plan', 'device'].map((recordType, type) => ({ recordType, reference: type < 4 ? 'SAME-' + recordType : '00000000-0000-4000-8000-0000000000' + index + type, recordId: instance + '-' + type, rawStatus: 'synthetic', linkedDeviceId: type < 3 ? instance + '-5' : null })),
  }))
  return { dataMode: 'synthetic', sourceEnvironment: 'external-test', basis: { kivoCommit: 'a'.repeat(40), supportingProbeSha256: 'b'.repeat(64) }, instances,
    lifecycleEvidence: Object.fromEntries(['result', 'before', 'after'].map(key => [key, { file: '/tmp/synthetic-lifecycle-' + key + '.json', sha256: 'c'.repeat(64) }])),
    legacyFixture: { file: '/tmp/kivo-pure-legacy/manifest.json', sha256: 'd'.repeat(64) } }
}
function syntheticLegacy() {
  const sessions = [1, 2].map(index => { const sessionRef = 'session-' + String(index).repeat(32); return { sessionRef, relativePath: 'sessions/project/' + sessionRef + '/session.v3.jsonl.zstd', file: '/tmp/kivo-pure-legacy/' + index + '.zstd', sha256: 'a'.repeat(64), toolResultSha256: 'b'.repeat(64), eventCount: 1 } })
  return { version: 1, bindingMode: 'constructed-migration-binding', dataMode: 'synthetic', sourceEnvironment: 'external-test', ownerMemberId: 'a', originalTypedStateAvailable: false, originalOwnerWorkMappingAvailable: false, toolResultHashAlgorithm: 'sha256-json-stringify', nativeToolResultHasCurrentSuccessEnvelope: false, constructedFields: ['ownerMemberId', 'queriedAt'], projectionQueriedAtSource: 'synthetic self-check only', sessions, seed: {
    employees: [{ id: 'k0-legacy-agent', modelRouteId: 'k0-model' }], skills: [{ id: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read' }],
    connections: [{ id: 'legacy', kind: 'gearjob-rest', enabled: false, dataMode: 'synthetic', sourceEnvironment: 'external-test' }],
    works: sessions.map((session, index) => ({ id: 'k0-legacy-' + index, ownerMemberId: 'a', employeeId: 'k0-legacy-agent', skillId: 'skill-gearjob-work-order-read', capabilityId: 'gearjob-work-order-read', connectionId: 'legacy', status: 'completed', results: [{ kind: 'gearjob.work-order.observation', dshSessionRef: session.sessionRef, source: { sourceSystem: 'GearJob', dataMode: 'synthetic', sourceEnvironment: 'external-test' } }], executions: [{ dshSessionRef: session.sessionRef }] })),
  } }
}
