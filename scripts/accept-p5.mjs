import assert from 'node:assert/strict'
import { appendFileSync, closeSync, constants, openSync, writeFileSync } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording } from './accept-p4-s1.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), script = fileURLToPath(import.meta.url)
const hostScript = join(root, 'scripts/accept-p4.mjs'), model = 'deepseek/deepseek-v4.1-flash'
const origin = 'http://127.0.0.1:34481', sourceId = 'kivo-synthetic-a', skillId = 'skill-kivo-tpm-record-read'
const types = ['repair', 'maintenance', 'inspection'], employeeIds = { a: 'p5-reader-a', b: 'p5-reader-b' }
const apps = { feishu: 'p5-feishu', weixin: 'channel-app-weixin' }, appId = 'cli_aaaaaaaaaaaaaaaa', tenant = 'synthetic-channel-tenant'
const requiredSteps = ['configuration', 'bind-feishu', 'bind-weixin', 'draft-lifecycle', 'daily', ...types.map(type => 'event-' + type), 'pause-and-advance', 'resume-baselines', ...types.map(type => 'reconcile-' + type), 'nonidentity-edit', 'isolation', 'normal-restart', 'backup-restore']
const messages = { create: '草稿已保存；启用后才开始跟进', edit: '规则已保存；既有工作、预算使用量和通知历史没有重算', enable: '规则已启用，已建立当前版本基线', resume: '规则已恢复，已建立新基线；暂停期间不补历史', pause: '规则已暂停；后续执行和待发通知将被阻止，已发送请求不能撤回' }

if (resolve(process.argv[1] ?? '') === script) {
  const options = argumentsFor(process.argv.slice(2))
  if (options.help) console.log(usage())
  else if (options['harness-check']) await harnessCheck()
  else await acceptance(options)
}

function argumentsFor(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, 'harness-check': { type: 'boolean' }, run: { type: 'boolean' },
    output: { type: 'string' }, fixture: { type: 'string' }, catalog: { type: 'string' }, candidate: { type: 'string' },
    'secret-root': { type: 'string' }, 'model-ref': { type: 'string' }, 'expected-head': { type: 'string' },
    'network-guard': { type: 'string' }, 'guard-sha256': { type: 'string' }, 'run-id': { type: 'string' },
  } })
  if (!args.length) return { help: true }
  assert.equal([values.help, values['harness-check'], values.run].filter(Boolean).length, 1, 'choose --help, --harness-check or --run')
  if (!values.run) { assert(Object.keys(values).every(key => ['help', 'harness-check'].includes(key)), 'runtime arguments require --run'); return values }
  for (const key of ['output', 'fixture', 'catalog', 'candidate', 'secret-root', 'network-guard']) {
    assert(values[key] && isAbsolute(values[key]), 'explicit absolute --' + key + ' is required')
    values[key] = resolve(values[key]); assert(!within(root, values[key]), key + ' must be outside the shared repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? ''), 'explicit --expected-head is required')
  assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''), 'explicit --guard-sha256 is required')
  assert.equal(values['model-ref'], 'ZENMUX_API_KEY', 'explicit model ref must match route ZENMUX_API_KEY')
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values['run-id'] ?? ''), 'explicit --run-id is required')
  return values
}
function usage() {
  return 'P5 Kivo 自动工作完整旅程；渠道为模拟验收。真实运行须 controller 另行 GO。\n\n纯检查：node scripts/accept-p5.mjs --harness-check\n\n' +
    '获准后：node scripts/accept-p5.mjs --run --output <仓库外新目录> --fixture <fixtures.json> --catalog <catalog.json> --candidate <冻结清单> --expected-head <完整HEAD> --secret-root <隔离0700目录> --model-ref ZENMUX_API_KEY --network-guard <已审guard> --guard-sha256 <已审SHA256> --run-id <本轮唯一ID>\n\n' +
    '固定 Web/event listener ' + origin + '，默认全部17步，无skip选项。真实人类HTTP及worker由独立operator按stdin回执门执行；不读取人类token、签名密钥或模型key正文，不轮换凭据、不发真实平台消息。产物：完整p5-automations.mp4、内嵌截图的离线index.html、observations.json。原始网络/state/stderr/秘密包只留private。'
}

async function acceptance(options) {
  const inputs = {}
  for (const key of ['fixture', 'catalog', 'candidate']) inputs[key] = await privateJson(options[key])
  const fixture = validateFixture(inputs.fixture.value, inputs.catalog.value), files = validateCandidate(inputs.candidate.value)
  const guardSha256 = hash(await readFile(options['network-guard'])); assert.equal(guardSha256, options['guard-sha256'], 'approved guard changed')
  const preflight = await snapshot(files, options['expected-head'])
  await privateDirectory(options['secret-root'])
  for (const ref of [options['model-ref'], ...fixture.instances.map(item => item.connection.credentialRef), fixture.eventSource.signingSecretRef]) await secretMetadata(options['secret-root'], ref)
  await availablePort(34481); await mkdir(options.output, { mode: 0o700 })
  const privateRoot = join(options.output, 'private'); await mkdir(privateRoot, { mode: 0o700 })
  const scratch = await mkdtemp(join(privateRoot, 'runtime-')); await chmod(scratch, 0o700)
  let stateFile = join(scratch, 'state.json'), dshHome = join(scratch, 'dsh'), secretRoot = options['secret-root']
  const authFile = join(scratch, 'auth.json'), auditFile = join(scratch, 'network.jsonl'), hostConfig = join(scratch, 'host.json')
  const caption = join(scratch, 'caption.txt'), video = join(options.output, 'p5-automations.mp4')
  const binding = { runId: options['run-id'], candidate: inputs.candidate.sha256, guardSha256 }
  const children = [], browsers = {}, sessions = {}, steps = [], facts = [], refs = { rules: {} }, oldFeishuSends = []
  const passwords = Object.fromEntries(['admin', 'a', 'b'].map(actor => [actor, randomBytes(24).toString('base64url')]))
  const wx = { id: 'synthetic-' + options['run-id'], ownerUserId: 'synthetic-p5-owner-a', token: 'SYNTHETIC_TOKEN_' + randomBytes(24).toString('hex') }
  const feishuRef = 'P5_' + hash(options['run-id']).slice(0, 24).toUpperCase() + '_FEISHU'
  const abort = new AbortController(), input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  let server, simulator, display, recording, recordingAt, failure, report, restarting = false, settle, simulatorClosed = false, operatorCleaned = false, ownedGroupsExited = false
  const operationSettled = new Promise(done => { settle = done })
  const cleanup = runCleanup({ children, browsers, recording: () => recording, operationSettled, removeAuth: () => rm(authFile, { force: true }), onFailure: error => { failure ??= error }, stopChild: stopGroup })
  const fail = error => { failure ??= error; abort.abort(error) }
  const operator = operatorChannel(input, { ...binding, producerRunId: fixture.producer.runId }, { onFailure: fail })
  const interrupts = interruptHandlers(process, (signal, force) => { fail(new Error('interrupted by ' + signal)); if (force) void cleanup.run(true) })
  try {
    const [{ createFileStore }, { initializeAuthFile }, { createILinkSimulator }] = await Promise.all([import('../src/store/file-store.mjs'), import('../src/auth.mjs'), import('./fixtures/ilink-server.mjs')])
    simulator = await createILinkSimulator({ holdMs: 100 }); simulator.addAccount(wx)
    await writeFile(hostConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(secretRoot, feishuRef), JSON.stringify({ appId, appSecret: 'synthetic_' + randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' })
    await writeFile(join(scratch, 'event-sources.json'), JSON.stringify({ version: 1, sources: [fixture.eventSource] }) + '\n', { mode: 0o600, flag: 'wx' })
    const store = createFileStore(stateFile), now = new Date().toISOString()
    await store.update(state => ({ ...state,
      members: ['admin', 'a', 'b'].map(actor => ({ id: actor, loginName: actor, displayName: actor === 'admin' ? '验收管理员' : '验收成员 ' + actor.toUpperCase(), role: actor === 'admin' ? 'admin' : 'member', enabled: true, authRef: actor, employeeIds: actor === 'admin' ? [] : [employeeIds[actor]], sessionVersion: 1, createdAt: now, updatedAt: now })),
      modelRoutes: [{ id: 'p5-model', provider: 'zenmux', model, displayName: 'ZenMux Flash', enabled: true, credentialRef: options['model-ref'] }],
      skills: [{ id: skillId, name: 'TPM 指定记录', capabilityId: 'kivo-tpm-record-read', enabled: true }],
      employees: ['a', 'b'].map(actor => ({ id: employeeIds[actor], name: 'TPM 核对员工 ' + actor.toUpperCase(), description: '隔离 synthetic TPM 自动工作', instructions: '按授权读取指定单据当前事实；保持来源、版本和时间，不写入业务系统。', enabled: true, modelRouteId: 'p5-model', connectionIds: [instance(actor).connection.id], skillIds: [skillId], revision: 1, createdAt: now, updatedAt: now })),
      connections: fixture.instances.map(item => ({ ...item.connection, enabled: true, skillIds: [skillId], revision: 1, status: 'untested', createdAt: now, updatedAt: now })),
      channelApps: ['feishu', 'weixin'].map(provider => ({ id: apps[provider], provider, providerAppId: provider === 'feishu' ? appId : 'ilink', providerTenantId: provider === 'feishu' ? tenant : 'personal', credentialRef: provider === 'feishu' ? feishuRef : null, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now })),
    }))
    await initializeAuthFile(authFile, passwords); server = await boot()
    const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
    await writeFile(caption, 'P5：渠道为模拟验收；真实人类HTTP、worker、MCP与Flash', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; await access(font)
    recording = watchRecording(launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', display + '.0', '-vf', 'pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=' + font + ':textfile=' + caption + ':reload=1:fontcolor=white:fontsize=24:x=20:y=h-54', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] }), fail)
    recordingAt = recording.state.startedAt
    for (const actor of ['admin', 'a', 'b']) { browsers[actor] = await browser(actor); await login(actor) }
    await journeys(); assertComplete(steps)
    assert.deepEqual(simulator.failures, []); assert(simulator.maxActivePolls(wx.id) <= 1, 'duplicate iLink consumer')
    for (const page of Object.values(browsers)) assert.deepEqual(page.errors, [], 'browser runtime error')
  } catch (error) { fail(error) }
  finally {
    try { if (!operatorCleaned) { await cleanOperator(); operatorCleaned = true } } catch (error) { failure ??= error }
    settle(); await cleanup.run()
    try { if (simulator) { await simulator.close(); simulatorClosed = true } } catch (error) { failure ??= error }
    operator.dispose(); input.close()
    const postflight = {}; let audit, coverage
    try {
      await assertStopped(children, authFile); ownedGroupsExited = true
      assert.equal(hash(await readFile(options['network-guard'])), guardSha256, 'approved guard changed')
      for (const key of ['fixture', 'catalog', 'candidate']) assert.equal((await privateJson(options[key])).sha256, inputs[key].sha256, 'input changed: ' + key)
      Object.assign(postflight, await snapshot(files, options['expected-head'])); assert.deepEqual(postflight, preflight)
      const rows = await jsonLines(auditFile)
      audit = networkAudit(rows, { ...binding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid), hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean) })
      for (const item of fixture.instances) assert(kivoRequests(rows, item.connection).length > 0, 'actual Kivo traffic missing: ' + item.instance)
      audit = { ...audit, kivoHttpRequests: fixture.instances.map(item => ({ instance: item.instance, count: kivoRequests(rows, item.connection).length })) }
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video])); coverage = recordingCoverage(recording.state, probe, steps)
      await command('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-']); if (!failure) assertComplete(steps)
    } catch (error) { failure ??= error }
    report = { ok: !failure, failure: publicFailure(failure), scope: 'synthetic / external-test；渠道为模拟验收。真实Web、人类HTTP→outbox→实际worker→签名webhook→当前MCP→DSH Flash→模拟渠道。', model,
      candidate: { manifestSha256: inputs.candidate.sha256, preflight, postflight }, inputHashes: { fixture: inputs.fixture.sha256, catalog: inputs.catalog.sha256 }, network: audit ?? null,
      cleanup: { ...cleanup.state, ownedGroupsExited, simulatorClosed, operatorCleaned }, media: coverage ? { video: 'p5-automations.mp4', ...coverage } : {}, steps, facts,
      evidenceBoundary: '仅断言本轮实际步骤；签名、确定性竞争、精确echo、预算并发、备份失败矩阵须结合同候选T1/T2证据，不以harness纯检查替代。' }
    try {
      let savedFailure
      do {
        savedFailure = failure; report.ok = !failure; report.failure = publicFailure(failure); Object.assign(report.cleanup, cleanup.state, interrupts.state)
        await writeFile(join(options.output, 'observations.json'), JSON.stringify({ ...report, steps: steps.map(({ screenshots, ...item }) => ({ ...item, screenshots: screenshots.map(({ image, ...shot }) => shot) })) }, null, 2) + '\n', { mode: 0o600 })
        await writeFile(join(options.output, 'index.html'), manual(report), { mode: 0o600 })
      } while (savedFailure !== failure)
    } finally { interrupts.dispose() }
  }
  console.log(JSON.stringify({ ok: report.ok, output: options.output, steps: steps.map(({ id, result }) => ({ id, result })), failure: report.failure, cleanup: report.cleanup }))
  if (!report.ok) process.exitCode = 1

  function instance(actor) { return fixture.instances.find(item => item.instance === actor) }
  function record(type) { return instance('a').records.find(item => item.recordType === type) }
  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.once('error', error => { child.spawnError = error }); children.push(child)
    child.stderr?.on('data', chunk => child.hostDiagnostics?.stderr(chunk)); return child
  }
  async function boot(channelsExpected = true) {
    const env = { ...systemEnvironment(), DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile,
      GENEWAY_PORT: '34481', GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'], GENEWAY_CONNECTION_CATALOG: options.catalog,
      NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href,
      GENEWAY_NETWORK_AUDIT_RUN_ID: binding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: binding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
      GENEWAY_CHANNEL_ACCEPT_HOST: '1', GENEWAY_CHANNEL_HOST_CONFIG: hostConfig }
    const child = launch(process.execPath, [hostScript, '--host'], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.auditRole = 'host'; child.auditFile = auditFile; child.auditBinding = binding; child.hostDiagnostics = captureHostDiagnostics(child, privateRoot, binding, fail)
    await poll(async () => { abort.signal.throwIfAborted(); if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned Host failed before ready'); try { return (await fetch(origin + '/', { signal: AbortSignal.timeout(3000) })).status === 200 } catch { return false } }, 'owned actual Host', 30_000)
    const identity = await ipc(child, 'snapshot'); assert.equal(identity.pid, child.pid); assert.equal(identity.address?.port, 34481); assert.equal(identity.address?.address, '127.0.0.1'); assert.equal(identity.sdkDispatcher, channelsExpected)
    return child
  }
  async function browser(actor) {
    const port = await freePort(), profile = join(scratch, 'chrome-' + actor)
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
    const child = launch('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', '--app=' + origin], { env: { ...systemEnvironment(), DISPLAY: display } })
    const target = await poll(async () => { abort.signal.throwIfAborted(); if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned browser failed'); try { return (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) })).json()).find(item => item.type === 'page' && item.url.startsWith(origin)) } catch { return false } }, 'owned browser CDP')
    const page = await connect(target, () => restarting), front = page.front; page.actor = actor
    page.front = async () => {
      for (const other of Object.values(browsers).filter(item => item !== page)) { const window = await other.send('Browser.getWindowForTarget'); await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } }) }
      const { width, height } = page.size(), window = await page.send('Browser.getWindowForTarget')
      await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } }); await front()
    }
    await page.viewport(1440, 900); await page.wait('Boolean(document.querySelector("#login-name"))'); await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button'); await page.wait('!document.querySelector("#app")?.classList.contains("hidden")')
    return page
  }
  async function login(actor) { const result = await request(actor, '/api/session', 'POST', { loginName: actor, password: passwords[actor] }); assert.equal(result.status, 200); sessions[actor] = { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken } }
  async function request(actor, path, method = 'GET', body) {
    const headers = { origin }, session = sessions[actor]
    if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.csrf }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })
    const text = await response.text(), value = text ? JSON.parse(text) : null
    assert(!/SYNTHETIC_TOKEN_|bot_token|context_token|BEGIN (?:RSA )?PRIVATE KEY/.test(JSON.stringify(value)), 'public API exposed secret content')
    return { status: response.status, body: value, cookie: response.headers.get('set-cookie') }
  }
  async function api(actor, path, method = 'GET', body) { const result = await request(actor, path, method, body); assert(result.status >= 200 && result.status < 300, method + ' ' + path + ' HTTP ' + result.status + ' ' + (result.body?.error?.code ?? '')); return result.body }
  async function disk() { return JSON.parse(await readFile(stateFile, 'utf8')) }
  async function detail(id) { return api('a', '/api/automations/' + encodeURIComponent(id)) }
  async function channels() { return api('a', '/api/channels') }
  async function reload(page, view) {
    await page.front(); const before = await page.evaluate('performance.timeOrigin'); await page.send('Page.reload')
    await page.wait('performance.timeOrigin !== ' + before + ' && !document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
    if (view) await page.nav(view)
  }
  async function openRule(page, id) {
    await page.front(); await page.nav('works')
    const result = await detail(id), selector = '#automation-list [data-open-automation="' + id + '"]'
    const current = await page.evaluate('document.querySelector("#automation-detail-card")?.dataset.automationRule === ' + js(id) + ' && Number(document.querySelector("#automation-detail-card")?.dataset.revision) === ' + result.rule.revision)
    if (!current) { await page.wait('Boolean(document.querySelector(' + js(selector) + '))'); await page.click(selector); await waitRuleRendered(page, result.rule) }
    return result
  }
  async function createRule(page, type, trigger, identityId, maxRuns) {
    const before = (await api('a', '/api/automations')).rules.map(item => item.id)
    await page.nav('works'); await page.click('#new-automation')
    await page.select('#automation-employee', employeeIds.a); await page.select('#automation-skill', skillId); await page.select('#automation-connection', instance('a').connection.id)
    await page.select('#automation-record-type', type); await page.fill('#automation-reference', record(type).reference); await page.select('#automation-trigger-kind', trigger.kind)
    if (trigger.kind === 'daily-time') await fillNativeTime(page, '#automation-time', trigger.time)
    else await page.select('#automation-source', sourceId)
    await page.fill('#automation-max-runs', String(maxRuns)); await page.select('#automation-notification', identityId)
    await page.click('#automation-save'); await waitMessage(page, messages.create)
    const created = (await api('a', '/api/automations')).rules.filter(item => !before.includes(item.id)); assert.equal(created.length, 1)
    const rule = created[0]; await waitRuleRendered(page, rule)
    assert.equal(rule.status, 'draft'); assert.equal(rule.usedRuns, 0); assert.equal(rule.objectId, null); assert.equal(rule.activationId, null)
    assert.equal(rule.employeeId, employeeIds.a); assert.equal(rule.connectionId, instance('a').connection.id)
    assert.deepEqual(rule.input, { recordType: type, reference: record(type).reference }); assert.equal(rule.trigger.kind, trigger.kind)
    return rule
  }
  async function action(page, id, kind) {
    const before = (await openRule(page, id)).rule
    await page.click('#automation-detail-card [data-rule-action="' + kind + '"]'); await waitMessage(page, messages[kind])
    const after = (await detail(id)).rule; await waitRuleRendered(page, after)
    assert(after.revision > before.revision); assert.equal(after.status, kind === 'pause' ? 'paused' : 'active'); return after
  }
  async function journeys() {
    await step('configuration', 'admin', '核对两实例连接与可信来源，再切换本轮回调', async page => {
      await page.nav('admin'); await page.click('#tab-connections')
      for (const item of fixture.instances) {
        const form = 'form[data-kind="connection"][data-id="' + item.connection.id + '"]'
        await page.click('details:has(' + form + ') > summary'); await page.click('[data-test-connection="' + item.connection.id + '"]')
        await page.wait('document.querySelector("#admin-message")?.innerText.includes("协议与固定只读工具目录测试通过")')
        assert.equal((await api('admin', '/api/admin/connections')).find(value => value.id === item.connection.id)?.status, 'ready')
      }
      for (const actor of ['a', 'b']) await reload(browsers[actor], 'works')
      const source = (await api('a', '/api/automations')).eventSource; assert.equal(source.reconcileIntervalSeconds, 60)
      for (const type of types) assert(source.sources.some(item => item.sourceId === sourceId && item.connectionId === instance('a').connection.id && item.status === 'available' && item.recordTypes.includes(type)))
      const switched = await operator.wait('switch-url', [['switch-url']])
      assert.equal(switched.endpointId, fixture.producer.endpointId); assert.equal(switched.path, '/api/events/kivo/' + sourceId); assert.equal(switched.urlHash, hash(origin + switched.path))
      assert.equal(switched.eightRulesUnchanged, true); assert.equal(switched.signingSecretUnchanged, true)
      facts.push({ kind: 'source-ready', sourceId, subscriptionCount: 8, reconcileIntervalSeconds: 60, endpointId: switched.endpointId })
    })
    for (const provider of ['feishu', 'weixin']) await step('bind-' + provider, 'a', '本人在Web绑定模拟' + (provider === 'feishu' ? '飞书' : '微信'), async page => { refs[provider] = await bind(page, provider) })
    await step('draft-lifecycle', 'a', '草稿取消和重开无隐式写入', async page => {
      await page.nav('works'); const before = await api('a', '/api/automations')
      await page.click('#new-automation'); await page.fill('#automation-reference', record('repair').reference); await page.click('#automation-close')
      assert.deepEqual(await api('a', '/api/automations'), before)
      await page.click('#new-automation'); assert.equal(await page.evaluate('document.querySelector("#automation-reference").value'), '')
      await page.click('#automation-close'); assert.equal((await api('a', '/api/automations')).rules.length, 0)
    })
    await step('daily', 'a', '每日真实到时，经当前MCP、Flash和飞书完成核对', async page => {
      const started = Date.now(), target = nextSafeMinute(new Date(started), 90_000), time = timeInZone(target, 'Asia/Shanghai')
      const draft = await createRule(page, 'repair', { kind: 'daily-time', time }, refs.feishu.identityId, 1)
      await page.viewport(390, 844); await page.front(); await page.noOverflow()
      const enabled = await action(page, draft.id, 'enable'); assertBaseline(enabled, record('repair'), revision(record('repair').currentRevision))
      assert(Date.now() < target.getTime(), 'UI activation missed the real scheduled minute')
      await page.viewport(1440, 900); await page.front()
      const closed = await closedOccurrence(draft.id, item => item.scheduledDate === dateInZone(target, 'Asia/Shanghai'), 'repair', revision(record('repair').currentRevision))
      assert.equal(closed.occurrence.event, null); assert.equal(closed.occurrence.occurrenceKey, draft.id + ':' + dateInZone(target, 'Asia/Shanghai'))
      const admitted = Date.parse(closed.work.acceptedAt); assert(admitted >= target.getTime() && admitted < target.getTime() + 60_000, 'daily admission outside real 60 second window')
      assert(target.getTime() - started >= 90_000); assert.equal((await detail(draft.id)).rule.usedRuns, 1)
      await showClosed(page, draft.id, closed); await action(page, draft.id, 'pause')
      facts.push({ kind: 'daily', scheduledAt: target.toISOString(), acceptedAt: closed.work.acceptedAt, productClockChanged: false, ...closed.safe })
    })
    for (const type of types) await step('event-' + type, 'a', '真实人类更新' + type + '，经outbox/worker/webhook闭合', async page => {
      const provider = type === 'maintenance' ? 'weixin' : 'feishu', draft = await createRule(page, type, { kind: 'kivo-record-update' }, refs[provider].identityId, 3)
      const enabled = await action(page, draft.id, 'enable'); assertBaseline(enabled, record(type), revision(record(type).currentRevision))
      refs.rules[type] = { id: draft.id, activationId: enabled.activationId, provider }
      const changed = await change('phase1', type, revision(record(type).currentRevision)), deliveries = await release(type, changed)
      const closed = await closedOccurrence(draft.id, item => item.event?.eventId === changed.eventId, type, revision(changed.afterRevision))
      assert.equal(closed.occurrence.event.sourceRevision, revision(changed.afterRevision)); assert.equal(closed.occurrence.activationId, enabled.activationId)
      await assertCanonical(changed, deliveries, draft.id, closed.occurrence.id); await showClosed(page, draft.id, closed)
      assert.equal((await detail(draft.id)).rule.usedRuns, 1)
      facts.push({ kind: 'supported-field', recordType: type, eventId: changed.eventId, eventOccurredAt: closed.occurrence.event.occurredAt, ...closed.safe })
    })
    await step('pause-and-advance', 'a', '暂停后合法推进同一对象，事件不创建工作', async page => {
      for (const type of types) await action(page, refs.rules[type].id, 'pause')
      const before = await workIdentity()
      for (const type of types) {
        const changed = await change('phase2', type, (await detail(refs.rules[type].id)).rule.handledRevision), deliveries = await release(type, changed)
        await assertCanonical(changed, deliveries, null, null); refs.rules[type].resumeRevision = revision(changed.afterRevision)
      }
      assert.deepEqual(await workIdentity(), before, 'paused rules created work')
      for (const type of types) { const value = await detail(refs.rules[type].id); assert.equal(value.rule.status, 'paused'); assert.equal(value.rule.usedRuns, 1) }
    })
    await step('resume-baselines', 'a', '明确恢复建立新基线，不补暂停历史', async page => {
      const before = await workIdentity()
      for (const type of types) {
        const previous = refs.rules[type], resumed = await action(page, previous.id, 'resume')
        assertBaseline(resumed, record(type), previous.resumeRevision); assert.notEqual(resumed.activationId, previous.activationId); previous.activationId = resumed.activationId; assert.equal(resumed.usedRuns, 1)
      }
      assert.deepEqual(await workIdentity(), before, 'resume backfilled paused history')
    })
    for (const type of types) await step('reconcile-' + type, 'a', '无事件字段变更由自然60秒对账闭合：' + type, async page => {
      const id = refs.rules[type].id, beforeInbox = (await disk()).automationInbox.map(item => item.id), changed = await change('archive', type, refs.rules[type].resumeRevision)
      assert.equal(changed.v2EventCount, 0); assert.equal(changed.eventId, null)
      const closed = await closedOccurrence(id, item => item.query?.sourceRevision === revision(changed.afterRevision), type, revision(changed.afterRevision))
      assert.equal(closed.occurrence.event, null); assert.equal(closed.occurrence.scheduledDate, null); assert(closed.occurrence.occurrenceKey.startsWith(id + ':kivo:'), 'compensation used a manual or daily claim')
      assert.deepEqual((await disk()).automationInbox.map(item => item.id), beforeInbox, 'unsupported archive unexpectedly arrived as webhook'); assert.equal((await detail(id)).rule.usedRuns, 2)
      await showClosed(page, id, closed)
      facts.push({ kind: 'unsupported-field-reconciliation', recordType: type, field: 'archivedAt', v2EventCount: 0, intervalSeconds: 60, manualCheckInvoked: false, ...closed.safe })
    })
    await step('nonidentity-edit', 'a', '编辑预算和通知身份，不重置版本或复活旧通知', async page => {
      const id = refs.rules.repair.id, before = (await openRule(page, id)).rule, previous = (await disk()).deliveries.map(item => ({ id: item.id, status: item.status }))
      await page.click('[data-edit-automation]')
      for (const selector of ['#automation-employee', '#automation-skill', '#automation-connection', '#automation-record-type', '#automation-trigger-kind']) assert.equal(await page.evaluate('document.querySelector(' + js(selector) + ').disabled'), true)
      assert.equal(await page.evaluate('document.querySelector("#automation-reference").readOnly'), true)
      await page.fill('#automation-max-runs', '4'); await page.select('#automation-notification', refs.weixin.identityId); await page.click('#automation-save'); await waitMessage(page, messages.edit)
      const after = (await detail(id)).rule; await waitRuleRendered(page, after); assert(after.revision > before.revision); assert.equal(after.maxRuns, 4); assert.equal(after.notificationIdentityId, refs.weixin.identityId)
      for (const key of ['activationId', 'baselineRevision', 'handledRevision', 'usedRuns', 'objectId']) assert.equal(after[key], before[key])
      assert.deepEqual((await disk()).deliveries.map(item => ({ id: item.id, status: item.status })), previous)
    })
    await step('isolation', 'b', '其他成员和普通管理员不可读取本人正文', async page => {
      await reload(page, 'works'); assert.equal((await api('b', '/api/automations')).rules.length, 0)
      for (const id of Object.values(refs.rules).map(item => item.id)) for (const actor of ['b', 'admin']) {
        assert.equal((await request(actor, '/api/automations/' + id)).status, 404)
        for (const item of (await detail(id)).occurrences.filter(item => item.workId)) assert.equal((await request(actor, '/api/works/' + item.workId)).status, 404)
      }
      assert.equal((await api('b', '/api/channels')).identities.length, 0); assert.equal(await page.evaluate('document.querySelectorAll("[data-open-automation]").length'), 0)
    })
    await step('normal-restart', 'a', '正常重启只读核对，不重复工作、模型或通知', async page => {
      const before = await replaySnapshot(); oldFeishuSends.push(...(await ipc(server, 'snapshot')).sent)
      restarting = true; await stopGroup(server); await availablePort(34481); server = await boot(); restarting = false
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await observeNoReplay(before, 65_000); await reload(page, 'works')
      const value = await openRule(page, refs.rules.inspection.id); assert.equal(value.rule.status, 'active'); assert.equal(value.rule.usedRuns, 2)
      facts.push({ kind: 'normal-restart', observationSeconds: 65, readOnlyMcpAllowed: true, workModelDeliveryReplayed: false })
    })
    await step('backup-restore', 'a', '备份恢复到新dataRoot后来源关闭、规则暂停', async page => {
      await cleanOperator(); operatorCleaned = true
      const before = await replaySnapshot(), previous = await disk(); oldFeishuSends.push(...(await ipc(server, 'snapshot')).sent)
      restarting = true; await stopGroup(server)
      const backup = join(scratch, 'backup'), secrets = join(scratch, 'secret-backup'), restored = join(scratch, 'restored'), restoredSecrets = join(scratch, 'restored-secrets')
      await transfer(['backup', '--output', backup, '--secret-output', secrets, '--secret-root', secretRoot])
      const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')); assert(manifest.entries.some(item => item.path === 'event-sources.json'), 'backup omitted source file')
      assert(!/SYNTHETIC_TOKEN_|bot_token|context_token|whsec_|BEGIN (?:RSA )?PRIVATE KEY/.test(await readFile(join(backup, 'state.json'), 'utf8')), 'ordinary backup leaked secret body')
      await transfer(['restore', '--input', backup, '--data-root', restored, '--secret-input', secrets, '--secret-root', restoredSecrets])
      stateFile = join(restored, 'state.json'); dshHome = join(restored, 'dsh'); secretRoot = restoredSecrets
      const state = await disk(), sources = JSON.parse(await readFile(join(restored, 'event-sources.json'), 'utf8'))
      assert(sources.sources.length && sources.sources.every(item => item.enabled === false)); assert(state.automationRules.every(item => ['paused', 'revoked'].includes(item.status))); assert(state.channelApps.every(item => !item.enabled))
      assert(state.automationInbox.every(item => item.targets.every(target => target.status !== 'pending')))
      for (const work of previous.works) assert.deepEqual(state.works.find(item => item.id === work.id).results, work.results)
      await availablePort(34481); server = await boot(false); restarting = false
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await observeNoReplay(before, 65_000); await reload(page, 'works'); const value = await openRule(page, refs.rules.repair.id)
      assert.equal(value.rule.status, 'paused'); assert.equal(value.eventSource.status, 'unavailable')
      facts.push({ kind: 'backup-restore', newDataRoot: true, sourcesDisabled: true, rulesPaused: true, channelsDisabled: true, noReplay: true })
    })
  }
  async function bind(page, provider) {
    await reload(page, 'channels')
    const before = (await channels()).linkCodes.map(item => item.id), selector = provider === 'feishu' ? '[data-issue-link="' + apps.feishu + '"]' : '[data-begin-weixin-binding="' + apps.weixin + '"]'
    await page.click(selector)
    const link = await poll(async () => { const created = (await channels()).linkCodes.filter(item => !before.includes(item.id) && item.channelAppId === apps[provider]); assert(created.length <= 1); return created[0] }, 'new owner binding')
    assert(!Object.hasOwn(link, 'code') && !Object.hasOwn(link, 'digest'), 'GET exposed code or digest')
    if (provider === 'feishu') {
      const selector = '#channel-app-' + apps.feishu + ' [data-link-code]'
      await page.wait('document.querySelectorAll(' + js(selector) + ').length === 1 && Boolean(document.querySelector(' + js(selector) + ')?.innerText.trim())')
      const code = await page.evaluate('document.querySelector(' + js(selector) + ').innerText.trim()')
      await ipc(server, 'feishu-event', feishuEvent('link-' + link.id, code))
    } else {
      await page.wait('document.querySelector("img.channel-qr")?.getAttribute("src")?.startsWith(' + js('/api/channels/weixin/bindings/' + link.id + '/qr') + ')')
      simulator.queueLogin(simulator.confirmedLogin(wx.id))
    }
    await poll(async () => (await channels()).linkCodes.find(item => item.id === link.id)?.status === 'matched', 'matched identity')
    // The real iLink path needs an inbound context. Before confirmation it must stay rejected and never run a model.
    if (provider === 'weixin') {
      const id = 'before-confirm-' + link.id
      simulator.push(wx.id, [{ message_id: id, from_user_id: wx.ownerUserId, to_user_id: wx.id, message_type: 1, message_state: 2, seq: 1, create_time_ms: Date.now(), context_token: 'SYNTHETIC_CONTEXT_' + options['run-id'], item_list: [{ type: 1, text_item: { text: '确认前不执行，请勿重放。' } }] }])
      await poll(async () => (await disk()).channelMessages.some(item => item.providerMessageId === id && ['rejected', 'unhandled'].includes(item.status)), 'durable pre-confirmation rejection')
      assert.equal((await disk()).works.length, 0)
    }
    await page.wait('Boolean(document.querySelector(' + js('[data-confirm-link="' + link.id + '"]') + '))')
    await page.select('#channel-employee-' + link.id, employeeIds.a); await page.click('[data-confirm-link="' + link.id + '"]')
    const identity = await poll(async () => (await channels()).identities.find(item => item.channelAppId === apps[provider] && item.status === 'active'), 'owner confirmation')
    await page.wait('document.querySelector("#channel-message")?.classList.contains("success") && document.querySelector("#channel-message")?.innerText === "已确认本人身份并开启会话；请在渠道重新发送确认前的消息" && Boolean(document.querySelector(' + js('[data-channel-identity="' + identity.id + '"]') + '))')
    assert(identity.activeConversationId); return { identityId: identity.id, conversationId: identity.activeConversationId }
  }
  async function change(phase, type, beforeRevision) {
    const changed = await operator.wait(type + '.' + phase, [[phase, type]])
    assertChange(changed, record(type), beforeRevision, phase); return changed
  }
  async function release(type, changed) {
    const value = await operator.wait('deliver-' + changed.traceId, [['release-worker'], ['readback']], { recordType: type, eventId: changed.eventId })
    assert.equal(value.release?.workerStopped, true)
    const worker = value.release.identity
    assert.equal(value.release.ownedRecordsVerified, true); assert.equal(worker?.runId, fixture.producer.runId); assert.equal(worker.superuser, false)
    assert(Number.isInteger(worker.pid) && worker.pid > 0); assertUuid(worker.databaseId); assert(/^kivo_event_/.test(worker.role)); assert.equal(worker.entry, 'apps/mes-worker/src/notifications/index.ts')
    assert.deepEqual([...worker.allowlist].sort(), ['mes.notification.business-event.v1', 'mes.notification.deliver.v1', 'mes.notification.evaluate.v1'])
    assert(value.release.executions.some(item => item.outboxId === changed.outboxId), 'actual worker did not claim the human business event')
    assert(value.release.results.every(item => item.failed === 0 && item.deadLettered === 0 && item.lostLease === 0))
    const current = value.readback?.records?.find(item => item.recordType === type && item.recordId === changed.recordId)
    assert(current, 'worker readback omitted the current record'); assert.equal(revision(current.revision), revision(changed.afterRevision))
    const deliveries = current.deliveries.filter(item => item.occurrence.episodeId === changed.eventId)
    assert(deliveries.length, 'actual worker has no delivery for this event')
    assert.deepEqual(deliveries.map(item => item.occurrence.ruleId).sort(), [...changed.matchedSubscriptionIds].sort(), 'actual captured subscription subset differs')
    for (const delivery of deliveries) {
      assert(fixture.eventSource.subscriptionIds.includes(delivery.occurrence.ruleId)); assertUuid(delivery.id)
      assert.equal(revision(delivery.occurrence.sourceRevision), revision(changed.afterRevision)); assert.equal(delivery.status, 'accepted')
      assert.equal(delivery.attemptCount, 1, 'normal chain unexpectedly retried delivery')
      assert.equal(delivery.attempts.length, 1)
      const attempt = delivery.attempts[0]; assert.equal(attempt.attemptNo, 1); assert(attempt.httpStatus >= 200 && attempt.httpStatus < 300); assert(/^[a-f0-9]{64}$/.test(attempt.wireBodySha256))
      const ackMs = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
      assert(Number.isFinite(ackMs) && ackMs >= 0 && ackMs < 10_000, 'real durable ACK exceeded 10 seconds')
    }
    return deliveries
  }
  async function assertCanonical(changed, deliveries, ruleId, occurrenceId) {
    const entry = await poll(async () => (await disk()).automationInbox.find(item => item.event.eventId === changed.eventId && item.event.sourceId === sourceId), 'durable actual webhook')
    assert.equal(entry.event.objectId, changed.recordId); assert.equal(entry.event.sourceRevision, revision(changed.afterRevision))
    for (const delivery of deliveries) assert(entry.deliveries.some(item => item.id === delivery.id && item.rawDigest === delivery.attempts[0].wireBodySha256), 'actual wire digest not durably accepted')
    assert.equal((await disk()).automationInbox.filter(item => item.event.eventId === changed.eventId && item.event.sourceId === sourceId).length, 1)
    if (ruleId) { const target = entry.targets.find(item => item.ruleId === ruleId); assert(target); assert.equal(target.status, 'settled'); assert.equal(target.occurrenceId, occurrenceId) }
    else { assert.equal(entry.ignoredReason, 'no-active-target'); assert.equal(entry.targets.length, 0) }
  }
  async function closedOccurrence(ruleId, predicate, type, sourceRevision) {
    return poll(async () => {
      abort.signal.throwIfAborted()
      const matches = (await detail(ruleId)).occurrences.filter(predicate); assert(matches.length <= 1, 'same target produced multiple occurrences')
      const occurrence = matches[0]; if (!occurrence) return false
      assert(occurrence.workId, 'positive journey skipped: ' + (occurrence.reason ?? occurrence.status))
      assert.equal(occurrence.query?.objectId, record(type).recordId); assert.equal(occurrence.query.recordType, type)
      assert.equal(occurrence.query.sourceInstance, instance('a').connection.sourceInstance); assert.equal(occurrence.query.sourceRevision, sourceRevision); assert(Number.isFinite(Date.parse(occurrence.query.queriedAt)))
      const work = await api('a', '/api/works/' + occurrence.workId)
      if (['accepted', 'running'].includes(work.status)) return false
      assert.equal(work.status, 'completed', 'native automatic work did not complete')
      const result = assertTyped(work, record(type), instance('a').connection, sourceRevision)
      if (!occurrence.deliveryId) return false
      const delivery = (await channels()).deliveries.find(item => item.id === occurrence.deliveryId)
      if (!delivery || ['pending', 'sending'].includes(delivery.status)) return false
      assert.equal(delivery.status, 'delivered'); assert.equal(delivery.workId, work.id); assert.equal(delivery.resultId, result.id)
      const provider = delivery.channelAppId === apps.feishu ? 'feishu' : 'weixin'; assert.equal(delivery.targetIdentityId, refs[provider].identityId)
      const sent = provider === 'feishu' ? [...oldFeishuSends, ...(await ipc(server, 'snapshot')).sent].filter(item => item.data.receive_id === 'chat-a').map(item => JSON.parse(item.data.content).text) : simulator.calls.filter(item => item.endpoint.endsWith('/sendmessage') && item.botId === wx.id).map(item => item.text)
      const texts = sent.filter(text => typeof text === 'string' && text.includes(work.id) && text.includes('/works/' + work.id)); assert.equal(texts.length, 1, 'actual transport notification missing or duplicated')
      return { occurrence, work, result, delivery, safe: { ruleId, occurrenceId: occurrence.id, workId: work.id, resultId: result.id, deliveryId: delivery.id, provider, sourceRevision, queryAt: occurrence.query?.queriedAt ?? result.payload.queriedAt, notificationSha256: hash(texts[0]) } }
    }, 'actual automatic work/current MCP/original channel delivery', 300_000)
  }
  async function showClosed(page, ruleId, value) {
    await openRule(page, ruleId); await page.click('#refresh-automations'); await waitRuleRendered(page, (await detail(ruleId)).rule)
    const selector = '[data-automation-occurrence="' + value.occurrence.id + '"]'
    await page.wait('document.querySelector(' + js(selector + ' .automation-query-facts') + ')?.innerText.includes(' + js(value.occurrence.query.sourceRevision) + ')')
    const text = await page.evaluate('document.querySelector(' + js(selector) + ').innerText')
    assert(text.includes(value.occurrence.query.queriedAt)); if (value.occurrence.event) assert(text.includes(value.occurrence.event.occurredAt))
    await page.wait('Boolean(document.querySelector(' + js(selector + ' [data-open-work="' + value.work.id + '"]') + '))')
    await page.click(selector + ' [data-open-work="' + value.work.id + '"]'); await page.wait('document.querySelector("#view-work")?.classList.contains("active")')
    const body = await page.evaluate('document.querySelector("#work-detail").innerText')
    assert(body.includes(record(value.result.payload.recordType).reference)); assert(body.includes(instance('a').connection.sourceInstance))
  }
  async function workIdentity() { return (await disk()).works.map(item => ({ id: item.id, status: item.status, executions: item.executions.map(value => value.id) })) }
  async function replaySnapshot() {
    const state = await disk(), rows = await jsonLines(auditFile)
    return { works: state.works.map(item => ({ id: item.id, status: item.status, results: item.results.map(value => value.id), executions: item.executions.map(value => value.id) })),
      modelRequests: rows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai').length, deliveries: state.deliveries.map(item => ({ id: item.id, status: item.status, attempts: item.attempts })),
      wxSends: simulator.calls.filter(item => item.endpoint.endsWith('/sendmessage')).length, feishuSends: oldFeishuSends.length + (await ipc(server, 'snapshot')).sent.length }
  }
  async function observeNoReplay(before, milliseconds) { const end = Date.now() + milliseconds; await poll(async () => { abort.signal.throwIfAborted(); assert.deepEqual(await replaySnapshot(), before); return Date.now() >= end }, 'bounded no-replay observation', milliseconds + 10_000) }
  async function cleanOperator() {
    const result = await operator.wait('cleanup', [['cleanup']])
    assert.equal(result.workerStopped, true); assert.equal(result.path, '/ack'); assert.equal(result.urlHash, hash(origin + '/ack')); assert.equal(result.ackListenerStarted, false)
    assert.equal(result.eightRulesUnchanged, true); assert.equal(result.signingSecretUnchanged, true)
    if (result.endpointId !== undefined) assert.equal(result.endpointId, fixture.producer.endpointId)
  }
  async function transfer(args) {
    const child = launch(process.execPath, [join(root, 'scripts/state-transfer.mjs'), ...args], { env: { ...systemEnvironment(), GENEWAY_STATE: stateFile, GENEWAY_DSH_HOME: dshHome, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'] }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.length > 32_000) fail(new Error('state transfer output exceeded bound')) })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); assert.equal(code, 0, 'actual state transfer failed'); return JSON.parse(output.trim())
  }
  async function step(id, actor, title, run) {
    abort.signal.throwIfAborted(); recording.assertRunning(); assert.equal(id, requiredSteps[steps.length])
    const page = browsers[actor], value = { id, actor, title, result: 'running', screenshots: [], startSeconds: (Date.now() - recordingAt) / 1000 }
    steps.push(value); console.error('[accept:p5] start ' + id); await page.front(); await writeFile(caption, steps.length + '. ' + title + '；渠道为模拟验收', { mode: 0o600 })
    try { await run(page); await page.noOverflow(); recording.assertRunning(); value.result = 'passed'; console.error('[accept:p5] passed ' + id) }
    catch (error) { value.result = 'failed'; value.failure = publicFailure(error); throw error }
    finally {
      try { await page.front(); const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), file = 'step-' + String(steps.length).padStart(2, '0') + '.png'; await writeFile(join(options.output, file), Buffer.from(shot.data, 'base64'), { mode: 0o600 }); value.screenshots.push({ file, image: shot.data, seconds: (Date.now() - recordingAt) / 1000 }) }
      finally { value.endSeconds = (Date.now() - recordingAt) / 1000 }
    }
  }
}

async function waitMessage(page, message) { await page.wait('document.querySelector("#automation-message")?.classList.contains("success") && document.querySelector("#automation-message")?.innerText === ' + js(message)) }
async function fillNativeTime(page, selector, value) {
  assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(value), 'native time requires HH:mm')
  const key = async (key, code, windowsVirtualKeyCode, text) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(text ? { text, unmodifiedText: text } : {}) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const first = async () => { for (let index = 0; index < 3; index++) await key('ArrowLeft', 'ArrowLeft', 37) }
  const digits = async text => { for (const digit of text) await key(digit, 'Digit' + digit, 48 + Number(digit), digit) }
  // This Chrome exposes separate hour, minute and AM/PM fields; insertText does not edit them.
  await page.click(selector); await first(); await key('Backspace', 'Backspace', 8)
  await digits(String(Number(value.slice(0, 2)) % 12 || 12).padStart(2, '0'))
  await first(); await key('ArrowRight', 'ArrowRight', 39); await key('Backspace', 'Backspace', 8); await digits(value.slice(3))
  await first(); await key('ArrowRight', 'ArrowRight', 39); await key('ArrowRight', 'ArrowRight', 39)
  const period = Number(value.slice(0, 2)) >= 12 ? 'p' : 'a'
  await key(period, 'Key' + period.toUpperCase(), period.toUpperCase().charCodeAt(0), period); await key('Tab', 'Tab', 9)
  assert.equal(await page.evaluate('document.querySelector(' + js(selector) + ').value'), value, 'native time field readback')
}
async function waitRuleRendered(page, rule) { await page.wait('document.querySelector("#automation-detail-card")?.dataset.automationRule === ' + js(rule.id) + ' && Number(document.querySelector("#automation-detail-card")?.dataset.revision) === ' + rule.revision) }
function assertBaseline(rule, record, sourceRevision) { assert.equal(rule.status, 'active'); assert.equal(rule.objectId, record.recordId); assert.equal(rule.baselineRevision, sourceRevision); assert.equal(rule.handledRevision, sourceRevision); assert(rule.activationId !== null && rule.activationId !== undefined) }
function assertChange(value, record, beforeRevision, phase) {
  assert.equal(value.instance, 'A'); assert.equal(value.recordType, record.recordType); assert.equal(value.recordId, record.recordId); assert.equal(value.reference, record.reference)
  assert.equal(value.stepId, record.recordType + '.' + phase); assert.equal(value.method, 'POST'); assert(value.status >= 200 && value.status < 300)
  assert.equal(revision(value.beforeRevision), beforeRevision); assert.equal(BigInt(revision(value.afterRevision)), BigInt(beforeRevision) + 1n)
  assert(typeof value.traceId === 'string' && value.traceId.length > 0); assert.equal(value.workerStarted, false)
  assert.equal(value.dbIdentity?.instance, 'A'); assert.equal(value.dbIdentity?.database, 'geneway_mcp_test_a'); assert.equal(value.dbIdentity?.port, 55381); assert.equal(value.dbIdentity?.origin, 'http://127.0.0.1:34381')
  if (phase === 'archive') { assert.equal(value.v2EventCount, 0); assert.equal(value.eventId, null); assert.equal(value.unsupportedField, 'archivedAt') }
  else {
    assert.equal(value.v2EventCount, 1); assertUuid(value.eventId); assertUuid(value.outboxId)
    const count = { repair: { phase1: 3, phase2: 2 }, maintenance: { phase1: 2, phase2: 1 }, inspection: { phase1: 2, phase2: 2 } }[record.recordType][phase]
    assert.equal(value.matchedSubscriptionIds?.length, count); assert.equal(new Set(value.matchedSubscriptionIds).size, count)
    assert(value.matchedSubscriptionIds.every(id => value.subscriptionIds.includes(id)))
  }
}
function assertTyped(work, record, connection, sourceRevision) {
  assert.equal(work.status, 'completed'); assert(work.executions.some(item => item.dshSessionRef), 'actual native session missing')
  const result = work.results.findLast(item => item.kind === 'kivo.tpm.observation'), payload = result?.payload
  assert(result, 'actual typed result missing'); assert.equal(payload.status, 'ok'); assert.equal(payload.mode, 'record'); assert.equal(payload.recordType, record.recordType); assert.equal(payload.records.length, 1)
  assert.equal(payload.records[0].id, record.recordId); assert.equal(payload.records[0].reference, record.reference); assert.equal(revision(payload.records[0].facts.revision), sourceRevision)
  assert.equal(payload.source.sourceInstance, connection.sourceInstance); assert.equal(payload.source.dataMode, 'synthetic'); assert.equal(payload.source.sourceEnvironment, 'external-test'); assert.equal(result.source.sourceInstance, connection.sourceInstance)
  assert(Number.isFinite(Date.parse(payload.queriedAt))); assert(payload.sources.length && payload.sources.every(item => item.traceId && Number.isFinite(Date.parse(item.queriedAt))), 'actual MCP trace/time missing')
  return result
}
function operatorChannel(input, binding, { timeoutMs = 300_000, announce = value => console.error(JSON.stringify(value)), onFailure = () => {} } = {}) {
  let pending, ended = false, failure
  const requested = new Set()
  const reject = error => { failure ??= error; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }; onFailure(error) }
  const onLine = line => {
    try {
      assert(Buffer.byteLength(line) <= 64 * 1024, 'operator receipt exceeds bound')
      const value = JSON.parse(line)
      assert(pending && value.kind === 'p5-operator-result' && value.runId === binding.runId && value.candidate === binding.candidate && value.stepId === pending.stepId, 'unexpected, duplicate or unbound operator result')
      assert(value.ok === true && value.receipt && typeof value.receipt === 'object', 'operator reported failure')
      assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization|secret|token)"\s*:|whsec_|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify(value.receipt)), 'operator receipt contains secret material')
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(value.receipt)
    } catch (error) { reject(error) }
  }
  const onClose = () => { ended = true; reject(new Error('operator input ended before required receipt')) }
  input.on('line', onLine); input.on('close', onClose); input.on('error', reject)
  return {
    wait(stepId, commands, expected = {}) {
      assert(!pending && !requested.has(stepId), 'operator step pending or already requested')
      if (ended || failure && stepId !== 'cleanup') return Promise.reject(failure ?? new Error('operator input closed'))
      requested.add(stepId)
      return new Promise((resolveReceipt, rejectReceipt) => { pending = { stepId, resolve: resolveReceipt, reject: rejectReceipt, timer: setTimeout(() => reject(new Error('operator receipt timed out')), timeoutMs) }; announce({ kind: 'p5-operator-request', runId: binding.runId, producerRunId: binding.producerRunId, candidate: binding.candidate, stepId, commands, expected }) })
    },
    dispose() { input.removeListener('line', onLine); input.removeListener('close', onClose); input.removeListener('error', reject); if (pending) reject(new Error('operator channel closed')) },
  }
}
async function ipc(child, method, input) {
  assert(child.connected && child.exitCode === null && child.signalCode === null, 'owned Host IPC closed')
  const id = randomBytes(12).toString('hex')
  return new Promise((resolveReply, reject) => {
    const finish = () => { clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit) }
    const onMessage = value => { if (value?.kind === 'channel-acceptance' && value.id === id) { finish(); value.ok ? resolveReply(value.value) : reject(new Error('owned transport IPC failed')) } }
    const onExit = () => { finish(); reject(new Error('owned Host exited during IPC')) }, timer = setTimeout(() => { finish(); reject(new Error('owned IPC timed out')) }, 20_000)
    child.on('message', onMessage); child.once('exit', onExit); child.send({ kind: 'channel-acceptance', id, method, input }, error => { if (error) { finish(); reject(error) } })
  })
}
function feishuEvent(id, text) { return { schema: '2.0', header: { event_id: 'event-' + id, event_type: 'im.message.receive_v1', app_id: appId, tenant_key: tenant, create_time: String(Date.now()) }, event: { sender: { sender_id: { open_id: 'open-a' }, sender_type: 'user', tenant_key: tenant }, message: { message_id: id, chat_id: 'chat-a', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()) } } } }

async function stopGroup(child, signal) {
  const request = child?.hostDiagnostics?.stopRequested(signal ?? 'SIGTERM')
  await stop(child, signal); child?.hostDiagnostics?.stopReturned(request, child.auditInterruption)
  if (!Number.isInteger(child?.pid)) return
  let forced = signal !== 'SIGKILL' && child.signalCode === 'SIGKILL'
  if (!gone(-child.pid)) { const request = child.hostDiagnostics?.stopRequested('SIGKILL', 'owned-group-residue'); const delivered = process.kill(-child.pid, 'SIGKILL'); child.hostDiagnostics?.stopReturned(request, { signalDelivered: delivered }); await poll(() => gone(-child.pid), 'owned group exit', 10_000); forced = true }
  if (child.hostDiagnostics) await poll(() => child.hostDiagnostics.closed, 'owned Host stderr close', 10_000)
  assert(!forced, 'owned process required forced cleanup')
}
function captureHostDiagnostics(child, directory, binding, onFailure, now = Date.now) {
  if (!Number.isInteger(child?.pid)) return
  const raw = join(directory, 'host-' + child.pid + '.stderr'), metadata = join(directory, 'host-' + child.pid + '.json'), limit = 8 * 1024 * 1024
  const state = { ...binding, pid: child.pid, processGroupId: child.pid, startedAt: now(), limitBytes: limit, bytesObserved: 0, bytesSaved: 0, truncated: false, stopRequests: [], observedExitAt: null, exitCode: null, exitSignal: null, closedAt: null }
  let fd, failed = false
  const persist = () => writeFileSync(metadata, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  const fail = () => { if (!failed) { failed = true; state.ioFailed = true; onFailure(new Error('private Host diagnostics I/O failed')) } }
  try { fd = openSync(raw, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(metadata, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch { if (fd !== undefined) closeSync(fd); throw new Error('private Host diagnostics initialization failed') }
  child.once('exit', (code, signal) => { Object.assign(state, { observedExitAt: now(), exitCode: code, exitSignal: signal }); try { persist() } catch { fail() } })
  child.once('close', () => { state.closedAt = now(); try { closeSync(fd); persist() } catch { fail() } })
  return {
    get closed() { return state.closedAt !== null },
    stderr(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), remaining = Math.max(0, limit - state.bytesSaved)
      state.bytesObserved += bytes.length; state.truncated ||= state.bytesObserved > limit
      if (!failed) { try { const saved = bytes.subarray(0, remaining); if (saved.length) appendFileSync(fd, saved); state.bytesSaved += saved.length; persist() } catch { fail() } }
      if (state.truncated && !failed) { failed = true; onFailure(new Error('private Host stderr exceeded 8 MiB')) }
    },
    stopRequested(signal, reason = 'shared-stop') { const value = { stopRequestedAt: now(), requestedSignal: signal, reason, wasAliveWhenRequested: child.exitCode === null && child.signalCode === null, signalDelivered: null }; state.stopRequests.push(value); try { persist() } catch { fail() }; return value },
    stopReturned(request, evidence) { if (!request) return; Object.assign(request, { returnedAt: now(), signalDelivered: typeof evidence?.signalDelivered === 'boolean' ? evidence.signalDelivered : null, observedEscalation: request.requestedSignal !== 'SIGKILL' && child.signalCode === 'SIGKILL' }); try { persist() } catch { fail() } },
  }
}
async function assertStopped(children, authFile) { for (const child of children) if (child.pid) assert(gone(child.pid) && gone(-child.pid), 'owned process/group remains'); await assert.rejects(access(authFile), { code: 'ENOENT' }) }
function gone(pid) { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
async function availablePort(port) { const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) }); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())) }

function validateFixture(value, catalog) {
  assert.equal(value.dataMode, 'synthetic'); assert.equal(value.sourceEnvironment, 'external-test'); assert.equal(value.instances?.length, 2); assert.equal(catalog.version, 1); assert(Array.isArray(catalog.targets))
  const refs = new Set(), fields = ['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
  for (const [index, item] of value.instances.entries()) {
    assert.equal(item.instance, ['a', 'b'][index]); const c = item.connection, url = new URL(c.baseUrl)
    assert.equal(c.kind, 'kivo-mcp'); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/api/v1/mes/mcp'); assert(!url.username && !url.password && !url.search && !url.hash); assert.equal(c.issuer, url.origin)
    assertUuid(c.clientId); assertRef(c.credentialRef); assert(!refs.has(c.credentialRef)); refs.add(c.credentialRef); assert.deepEqual(c.allowedObjectIds, [])
    assert.equal(c.sourceSystem, 'Kivo'); assert.equal(c.dataMode, 'synthetic'); assert.equal(c.sourceEnvironment, 'external-test'); assert.equal(c.evidenceMode, 'real-mcp-http')
    assert(catalog.targets.some(target => fields.every(key => target[key] === c[key])), 'connection differs from explicit catalog')
    if (item.instance === 'a') for (const type of types) { const records = item.records.filter(record => record.recordType === type); assert.equal(records.length, 1); assertUuid(records[0].recordId); assert(typeof records[0].reference === 'string' && records[0].reference.length > 0); assert.equal(revision(records[0].currentRevision), '0') }
  }
  const [a, b] = value.instances, source = value.eventSource; assert.notEqual(a.connection.baseUrl, b.connection.baseUrl); assert.notEqual(a.connection.sourceInstance, b.connection.sourceInstance)
  assert.equal(source.id, sourceId); assert.equal(source.connectionId, a.connection.id); assert.equal(source.resource, a.connection.baseUrl); assert.equal(source.sourceInstance, a.connection.sourceInstance); assert.equal(source.enabled, true)
  assertRef(source.signingSecretRef); assert(!refs.has(source.signingSecretRef) && source.signingSecretRef !== 'ZENMUX_API_KEY'); assert.equal(source.subscriptionIds?.length, 8); assert.equal(new Set(source.subscriptionIds).size, 8); source.subscriptionIds.forEach(assertUuid)
  const producer = value.producer; assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(producer?.runId ?? '')); assert.equal(producer.sourceId, sourceId); assert.equal(producer.resource, source.resource); assertUuid(producer.endpointId); assert.equal(producer.endpointBindingPhase, 'original')
  assert.deepEqual([...producer.subscriptionIds].sort(), [...source.subscriptionIds].sort())
  for (const record of a.records) assert(producer.records.some(item => ['recordType', 'recordId', 'reference'].every(key => item[key] === record[key]) && revision(item.currentRevision) === revision(record.currentRevision)), 'record differs from actual producer fixture')
  assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization|secret|token)"\s*:|whsec_|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify({ value, catalog })), 'fixture contains secret body')
  return value
}
function validateCandidate(value) {
  assert(Array.isArray(value.files) && value.files.length, 'candidate requires file hashes')
  const files = value.files.map(entry => { assert(typeof entry.path === 'string' && !entry.path.includes('..') && /^(src\/|plugins\/|config\/|web\/|vendor\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(entry.path)); assert(/^[a-f0-9]{64}$/.test(entry.sha256)); return entry })
  assert.equal(new Set(files.map(item => item.path)).size, files.length)
  for (const path of ['scripts/accept-p5.mjs', 'scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'scripts/state-transfer.mjs', 'src/server.mjs', 'src/automation-service.mjs', 'src/kivo-events.mjs', 'src/store/file-store.mjs', 'web/index.html']) assert(files.some(item => item.path === path), 'candidate missing ' + path)
  return files
}
async function snapshot(files, expectedHead) {
  const head = (await command('git', ['rev-parse', 'HEAD'])).trim(); assert.equal(head, expectedHead)
  const all = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'plugins', 'config', 'web', 'vendor', 'package.json', 'pnpm-lock.yaml', 'scripts/accept-p5.mjs', 'scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'scripts/state-transfer.mjs'])).split('\0').filter(Boolean).sort()
  assert(all.every(path => files.some(item => item.path === path)), 'candidate omits an actual loaded file')
  const hashes = Object.fromEntries(await Promise.all(all.map(async path => [path, hash(await readFile(join(root, path)))])))
  for (const file of files) assert.equal(hash(await readFile(join(root, file.path))), file.sha256, 'candidate mismatch: ' + file.path)
  const installed = {}
  for (const [name, version] of [['@deepseek-ai/dsh', '0.2.0-rc.2'], ['@deepseek-ai/dsh-sdk-client', '0.2.0-rc.2'], ['@deepseek-ai/dsh-tools', '0.2.0-rc.2'], ['@larksuiteoapi/node-sdk', '1.74.0']]) { const bytes = await readFile(join(root, 'node_modules', name, 'package.json')); assert.equal(JSON.parse(bytes).version, version); installed[name] = { version, packageJsonSha256: hash(bytes) } }
  return { head, files: hashes, installed }
}
async function privateJson(path) { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 511) === 384, 'explicit input must be owned regular 0600'); const bytes = await handle.readFile(); return { value: JSON.parse(bytes), sha256: hash(bytes) } } finally { await handle.close() } }
async function privateDirectory(path) { const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 511) === 448, 'directory must be owned nonsymlink 0700') }
async function secretMetadata(directory, ref) { assertRef(ref); const stat = await lstat(join(directory, ref)); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 511) === 384, 'explicit secret ref must be owned regular 0600') }
function assertRef(value) { assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value), 'invalid explicit secret ref') }
function assertUuid(value) { assert(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), 'UUID required') }
function revision(value) { if (Number.isSafeInteger(value) && value >= 0) return String(value); assert(typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value), 'invalid canonical revision'); return value }
function assertComplete(steps) { assert.equal(steps.length, requiredSteps.length); for (const [index, id] of requiredSteps.entries()) { assert.equal(steps[index].id, id); assert.equal(steps[index].result, 'passed', 'required journey failed: ' + id) } }
function kivoRequests(rows, connection) { const url = new URL(connection.baseUrl); return rows.filter(row => row.kind === 'fetch' && row.path === url.pathname && row.host === url.hostname && Number(row.port) === Number(url.port || 80)) }
function nextSafeMinute(now, minimumLeadMs) { return new Date(Math.ceil((now.getTime() + minimumLeadMs) / 60_000) * 60_000) }
function timeInZone(date, timeZone) { return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) }
function dateInZone(date, timeZone) { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(item => [item.type, item.value])); return parts.year + '-' + parts.month + '-' + parts.day }
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function within(parent, child) { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
async function jsonLines(path) { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function js(value) { return JSON.stringify(value) }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function publicFailure(error) { return error ? { name: /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name) ? error.name : 'Error', code: /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'ACCEPTANCE_FAILED', assertionSha256: hash(String(error.message)), locations: String(error.stack).split('\n').slice(1).flatMap(line => line.match(/(?:file:\/\/)?\/[^\s()]+\.mjs:\d+:\d+/g) ?? []).slice(0, 6) } : null }
function manual(report) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kivo自动工作操作说明</title><style>body{max-width:1080px;margin:32px auto;padding:0 24px;font:17px/1.7 system-ui;color:#172033;background:#f5f7fb}section{background:#fff;padding:24px;margin:24px 0;border:1px solid #dce2ed;border-radius:12px}img,video{max-width:100%;height:auto}.failed{border-color:#b23e26}code{overflow-wrap:anywhere}</style><h1>Kivo自动工作操作说明</h1><p><b>渠道为模拟验收</b>。' + esc(report.scope) + '</p><p>' + (report.ok ? '本轮列出的全部操作和审计通过。' : '本轮未通过；已完成和失败步骤如下。') + ' 候选：<code>' + esc(report.candidate.preflight.head) + '</code>。模型：ZenMux ' + esc(model) + '。</p><p>管理员先测试隔离Kivo连接并核对员工授权。成员在“我的工作”创建明确单据的自动工作草稿，选择每日上海时间或跟进单据新版本、累计次数和本人私聊通知。保存草稿不会执行，显式启用才建立当前版本基线。</p>' +
    (report.media.video ? '<p><a href="p5-automations.mp4">完整操作视频</a> · <a href="observations.json">检查记录</a></p><video controls preload="metadata" src="p5-automations.mp4"></video>' : '<p>本轮未取得通过完整性检查的视频。</p>') +
    report.steps.map((step, index) => '<section class="' + (step.result === 'passed' ? '' : 'failed') + '"><h2>' + (index + 1) + '. ' + esc(step.title) + '</h2><p>操作角色：' + (step.actor === 'admin' ? '管理员' : '成员 ' + esc(step.actor.toUpperCase())) + '；实际结果：' + esc(step.result === 'passed' ? '通过' : step.result === 'failed' ? '失败' : '未完成') + '。对应视频 ' + Math.floor(step.startSeconds) + '–' + Math.ceil(step.endSeconds ?? step.startSeconds) + ' 秒。</p>' + step.screenshots.map(shot => '<figure><img src="data:image/png;base64,' + shot.image + '" alt="' + esc(step.title) + '"><figcaption>' + esc(step.title) + '</figcaption></figure>').join('') + '</section>').join('') +
    '<section><h2>版本、暂停和恢复</h2><p>事件时间和版本描述上游变化，查询时间和版本描述当前实际读取；二者分别展示。每60秒核对当前状态，不补中间历史。暂停阻止后续执行及待发通知，已发送请求不能撤回。恢复会读取当前版本建立新基线，不补暂停期间历史。停止本次工作、暂停规则、取消待发通知分别操作。</p><p>建立工作才消耗次数，失败和停止不返还。启用后固定员工、目标、连接和触发类型，更换目标须新建草稿。修改预算、时间或通知目的地不重置使用量，也不复活旧通知。发送结果未知时先核对，不盲目重试。</p></section><section><h2>备份和记录范围</h2><p>恢复到新的数据目录后来源关闭、规则暂停、渠道关闭；先核对授权和秘密引用，再由维护者明确操作。本材料使用隔离synthetic数据和模拟渠道，不涉及真实联系人。</p><p>' + esc(report.evidenceBoundary) + '</p><p>网络记录关联本轮owned Host及官方SDK子进程；原始网络、state、模型内容和stderr保存在私有目录，不随本说明交付。实现、独立审查、完整阶段验收和用户验收分别记录。</p></section></html>'
}

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true }); assert.throws(() => argumentsFor(['--run']), /required/)
  assert.throws(() => argumentsFor(['--harness-check', '--fixture', '/tmp/f']), /require --run/); assert.throws(() => argumentsFor(['--harness-check', '--http-only']), /Unknown option/)
  const args = ['--run', '--output', '/tmp/p5-output', '--fixture', '/tmp/p5-fixture', '--catalog', '/tmp/p5-catalog', '--candidate', '/tmp/p5-candidate', '--secret-root', '/tmp/p5-secrets', '--model-ref', 'ZENMUX_API_KEY', '--expected-head', 'a'.repeat(40), '--network-guard', '/tmp/p5-guard.mjs', '--guard-sha256', 'b'.repeat(64), '--run-id', 'p5-pure']
  assert.equal(argumentsFor(args)['run-id'], 'p5-pure'); assert.throws(() => argumentsFor(args.map(value => value === '/tmp/p5-output' ? root + '/artifacts/p5' : value)), /outside/); assert.throws(() => argumentsFor(args.map(value => value === 'ZENMUX_API_KEY' ? '../key' : value)), /route/)
  const next = nextSafeMinute(new Date('2026-10-16T15:59:30.000Z'), 90_000)
  assert.equal(next.toISOString(), '2026-10-16T16:01:00.000Z'); assert.equal(timeInZone(next, 'Asia/Shanghai'), '00:01'); assert.equal(dateInZone(next, 'Asia/Shanghai'), '2026-10-17')
  assert.equal(requiredSteps.length, 17); const passed = requiredSteps.map(id => ({ id, result: 'passed' })); assertComplete(passed)
  assert.throws(() => assertComplete(passed.slice(1))); assert.throws(() => assertComplete(passed.map((item, index) => index === 4 ? { ...item, result: 'failed' } : item)))
  const source = await readFile(script, 'utf8'), runtime = source.slice(0, source.indexOf('async function harnessCheck('))
  for (const retired of ['readModelCredential(', 'prepareGearJob(', 'requestSubmit(', 'process.env.GENEWAY_GEARJOB']) assert(!runtime.includes(retired), 'retired entry remains')
  assert(runtime.includes("const child = launch(process.execPath, [hostScript, '--host']")); assert(runtime.includes('child.auditFile = auditFile; child.auditBinding = binding'))
  assert(runtime.includes('hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean)')); assert(!runtime.includes('GENEWAY_CHANNEL_CONTEXT_LOG:')); assert(!runtime.includes('GENEWAY_NETWORK_AUDIT_LOOPBACK_ONLY:'))
  await waitBudgetChecks(source); await fixtureChecks(); await operatorChecks(); await uiCompletionChecks(source); await showClosedChecks(source); await nativeTimeChecks(source); await diagnosticsChecks(source); await reportChecks(source)
  const html = manual({ ok: false, scope: '渠道为模拟验收', candidate: { preflight: { head: 'synthetic' } }, media: {}, evidenceBoundary: '<test>', steps: [{ title: '<record>', actor: 'a', result: 'failed', startSeconds: 0, endSeconds: 1, screenshots: [] }] })
  assert(html.includes('本轮未通过')); assert(html.includes('&lt;record&gt;')); assert(!/https?:\/\//.test(html)); assert(!html.includes('<test>'))
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', externalEffects: 0, checks: ['strict-entry', 'explicit-inputs', 'synthetic-fixture', 'current-object-revision', 'shanghai-clock', 'daily-wait-budget', 'required-steps', 'operator-binding-order', 'ui-completion', 'occurrence-work-render', 'native-time', 'private-diagnostics', 'interrupt-report', 'offline-html'], runtimeVerified: false }))
}
async function waitBudgetChecks(source) {
  const start = source.indexOf('  async function closedOccurrence('), end = source.indexOf('\n  async function showClosed(', start)
  const budget = source.slice(start, end).match(/'actual automatic work\/current MCP\/original channel delivery', ([\d_]+)\)/)?.[1]
  assert(budget, 'actual observation poll budget missing')
  const client = await readFile(join(root, 'plugins/kivo-tpm.mjs'), 'utf8'), work = await readFile(join(root, 'src/work-service.mjs'), 'utf8')
  const readMs = Number(client.match(/AbortSignal\.timeout\(options\.timeoutMs \?\? ([\d_]+)\)/)?.[1]?.replaceAll('_', ''))
  const workMs = Number(work.match(/new Date\(accepted\.getTime\(\) \+ ([\d_]+)\)\.toISOString\(\)/)?.[1]?.replaceAll('_', ''))
  const now = new Date('2026-10-16T00:00:30.001Z'), dailyWaitMs = nextSafeMinute(now, 90_000).getTime() - now.getTime(), noticeMs = 10_000
  assert.equal(dailyWaitMs, 149_999); assert.equal(readMs, 15_000); assert.equal(workMs, 120_000)
  assert(readMs < 60_000, 'example must retain the daily admission window')
  const requiredMs = dailyWaitMs + readMs + workMs + noticeMs
  assert(requiredMs > 240_000, 'counterexample must exceed the old observer budget')
  assert(Number(budget.replaceAll('_', '')) >= requiredMs, 'observer budget ends before a legally bounded daily work and notification')
}
async function fixtureChecks() {
  const uuid = index => '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
  const fixture = { dataMode: 'synthetic', sourceEnvironment: 'external-test', instances: ['a', 'b'].map((instance, index) => ({ instance, connection: { id: 'kivo-' + instance, kind: 'kivo-mcp', targetIdentity: instance, baseUrl: 'http://127.0.0.1:' + (34381 + index) + '/api/v1/mes/mcp', issuer: 'http://127.0.0.1:' + (34381 + index), clientId: uuid(index + 1), credentialRef: 'KIVO_' + instance.toUpperCase(), allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'synthetic-' + instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-mcp-http' }, records: types.map((recordType, type) => ({ recordType, recordId: uuid(10 + index * 10 + type), reference: recordType + '-synthetic-' + instance, currentRevision: '0' })) })) }
  const a = fixture.instances[0]; fixture.eventSource = { id: sourceId, connectionId: a.connection.id, resource: a.connection.baseUrl, sourceInstance: a.connection.sourceInstance, signingSecretRef: 'KIVO_P5_SIGNING', subscriptionIds: Array.from({ length: 8 }, (_, index) => uuid(100 + index)), enabled: true }
  fixture.producer = { runId: 'p5-pure', sourceId, resource: a.connection.baseUrl, endpointId: uuid(200), endpointBindingPhase: 'original', subscriptionIds: fixture.eventSource.subscriptionIds, records: a.records }
  const catalog = { version: 1, targets: fixture.instances.map(item => item.connection) }; validateFixture(fixture, catalog)
  for (const mutate of [value => { value.eventSource.resource = value.instances[1].connection.baseUrl }, value => { value.producer.runId = '' }, value => { value.instances[0].records[0].currentRevision = '1' }, value => { value.eventSource.subscriptionIds.pop() }, value => { value.eventSource.signingSecretRef = '../key' }]) { const copy = structuredClone(fixture); mutate(copy); assert.throws(() => validateFixture(copy, catalog)) }
  const record = a.records[0], changed = { stepId: 'repair.phase1', instance: 'A', ...record, method: 'POST', status: 200, traceId: 'human-request', beforeRevision: '0', afterRevision: '1', eventId: uuid(300), outboxId: uuid(301), v2EventCount: 1, subscriptionIds: fixture.eventSource.subscriptionIds, matchedSubscriptionIds: fixture.eventSource.subscriptionIds.slice(0, 3), workerStarted: false, dbIdentity: { instance: 'A', database: 'geneway_mcp_test_a', port: 55381, origin: 'http://127.0.0.1:34381' } }
  assertChange(changed, record, '0', 'phase1')
  for (const fields of [{ recordId: uuid(99) }, { beforeRevision: '1' }, { afterRevision: '2' }, { eventId: null }, { dbIdentity: { database: 'other' } }]) assert.throws(() => assertChange({ ...changed, ...fields }, record, '0', 'phase1'))
  assertChange({ ...changed, stepId: 'repair.archive', eventId: null, v2EventCount: 0, unsupportedField: 'archivedAt' }, record, '0', 'archive'); assert.throws(() => assertChange({ ...changed, stepId: 'repair.archive' }, record, '0', 'archive'))
  const { createFileStore, migrateState } = await import('../src/store/file-store.mjs')
  const empty = await createFileStore('/memory/not-opened', { readFile: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) } }).read()
  const source = await readFile(script, 'utf8'), start = source.indexOf('    await store.update(state => ({ ...state,'), end = source.indexOf('\n    await initializeAuthFile(', start)
  assert(start > 0 && end > start)
  let seeded
  const store = { update: async mutate => { seeded = migrateState(mutate(empty)) } }
  await Function('store', 'fixture', 'now', 'employeeIds', 'skillId', 'model', 'options', 'instance', 'apps', 'appId', 'tenant', 'feishuRef', 'return (async()=>{' + source.slice(start, end) + '})()')(store, fixture, '2026-10-16T00:00:00.000Z', employeeIds, skillId, model, { 'model-ref': 'ZENMUX_API_KEY' }, actor => fixture.instances.find(item => item.instance === actor), apps, appId, tenant, 'P5_SYNTHETIC_FEISHU')
  assert.equal(seeded.version, 11); assert.equal(seeded.works.length, 0); assert.deepEqual(seeded.members.find(item => item.id === 'a').employeeIds, [employeeIds.a])
}
async function operatorChecks() {
  const { EventEmitter } = await import('node:events'), binding = { runId: 'pure', candidate: 'a'.repeat(64) }
  for (const fields of [null, { candidate: 'b'.repeat(64) }, { runId: 'other' }, { stepId: 'future' }, { ok: false }, { receipt: { token: 'forbidden' } }]) {
    const input = new EventEmitter(), sent = [], channel = operatorChannel(input, binding, { announce: value => sent.push(value), timeoutMs: 1000 }), promise = channel.wait('repair.phase1', [['phase1', 'repair']])
    input.emit('line', JSON.stringify({ kind: 'p5-operator-result', ...binding, stepId: 'repair.phase1', ok: true, receipt: { status: 200 }, ...fields }))
    if (fields) { await assert.rejects(promise); await assert.rejects(channel.wait('next', [])) } else { assert.deepEqual(await promise, { status: 200 }); assert.throws(() => channel.wait('repair.phase1', []), /already/) }
    assert.equal(sent[0].stepId, 'repair.phase1'); channel.dispose()
  }
}
async function uiCompletionChecks(source) {
  const web = await readFile(join(root, 'web/index.html'), 'utf8')
  for (const [startText, endText] of [['    async function saveAutomationEditor(', '\n    function renderAutomations('], ['    async function automationAction(', '\n    async function stopAutomationWork(']]) {
    const start = web.indexOf(startText), end = web.indexOf(endText, start); assert(start > 0 && end > start)
    const body = web.slice(start, end); assert(body.includes("setMessage('automation-message'")); assert(body.includes('await reloadAll()')); assert(body.includes('await openAutomation(')); assert(body.includes("'success'"))
  }
  let message = { classList: { contains: () => false }, innerText: messages.create }, card = { dataset: { automationRule: 'old', revision: '1' } }
  const evaluate = expression => Function('document', 'return ' + expression)({ querySelector: selector => selector === '#automation-message' ? message : card })
  const page = { wait: async expression => { assert.equal(evaluate(expression), false, 'old document or old success falsely completed'); message = { classList: { contains: () => true }, innerText: messages.create }; card = { dataset: { automationRule: 'new', revision: '2' } }; assert.equal(evaluate(expression), true) } }
  await waitMessage(page, messages.create); card = { dataset: { automationRule: 'old', revision: '1' } }; await waitRuleRendered(page, { id: 'new', revision: 2 })
  const creator = source.slice(source.indexOf('  async function createRule('), source.indexOf('  async function action('))
  assert(creator.includes("await page.click('#automation-save'); await waitMessage(page, messages.create)"), 'UI creation must wait for its handler completion')
  const operatorSwitch = source.indexOf("operator.wait('switch-url'"); assert(operatorSwitch > source.indexOf('async function journeys('), 'endpoint must not switch during fixture initialization')
}
async function showClosedChecks(source) {
  const web = await readFile(join(root, 'web/index.html'), 'utf8'), s1 = await readFile(join(root, 'scripts/accept-p4-s1.mjs'), 'utf8')
  const parts = ['automationView', 'automationName', 'automationTriggerText', 'occurrenceText', 'deliveryCard'].map(name => { const at = web.indexOf('    function ' + name + '('); assert(at > 0); return web.slice(at, web.indexOf('\n', at)) })
  const renderAt = web.indexOf('    function renderAutomationDetail('); parts.push(web.slice(renderAt, web.indexOf('\n    async function openAutomation(', renderAt)))
  const render = Function('state', 'el', 'byId', 'esc', 'displayTime', 'labels', 'deliveryLabels', 'active', 'tpmTypeLabels', 'document', 'bindWorkLinks', 'bindDeliveryActions', parts.join('\n') + ';renderAutomationDetail()')
  const refreshSource = web.match(/const refresh=el\('refresh-automations'\);[^\n]+/)?.[0], clickExpression = s1.match(/const box = await evaluate\(`([^`]+)`\)/)?.[1]
  assert(refreshSource && clickExpression)
  const start = source.indexOf('  async function showClosed('), end = source.indexOf('\n  async function workIdentity(', start)
  for (const outcome of ['current-work', 'missing-work', 'other-work']) {
    const uuid = '00000000-0000-4000-8000-000000000000', workId = 'work-' + uuid, occurrenceId = 'occurrence-' + uuid, queriedAt = '2026-10-16T00:00:01.000Z'
    const occurrence = { id: occurrenceId, workId, deliveryId: 'delivery', event: null, scheduledDate: null, createdAt: queriedAt, query: { sourceRevision: '3', queriedAt } }
    const state = { authEpoch: 1, view: 'works', bootstrap: { employees: [], connections: [], works: [] }, channelApps: [], channels: { conversations: [], deliveries: [{ id: 'delivery', workId, status: 'delivered' }] }, automationDetail: { rule: { id: 'rule', revision: 3, status: 'active', trigger: { kind: 'kivo-record-update' }, input: { recordType: 'repair', reference: 'SYNTHETIC' }, usedRuns: 2, maxRuns: 3, handledRevision: '3', baselineRevision: '2' }, occurrences: [occurrence] } }
    const target = { innerHTML: '' }, refresh = {}; let release, pending, waited = false, clicked = false, queryReadyBeforeBootstrap = false, selectedNode
    const nodes = selector => {
      if (!selector.startsWith('[data-automation-occurrence="' + occurrenceId + '"] ')) return []
      const id = selector.match(/\[data-open-work="([^"]+)"\]/)?.[1]
      return [...target.innerHTML.matchAll(/data-open-work="([^"]+)"/g)].filter(match => match[1] === id).map(() => ({ getBoundingClientRect: () => ({ x: 20, y: 20, width: 100, height: 30 }), contains: value => value === selectedNode }))
    }
    const document = { querySelectorAll: selector => { const values = nodes(selector); selectedNode = values[0]; return values }, elementFromPoint: () => selectedNode, querySelector: selector => {
      if (selector === '#automation-detail-card') return { dataset: { automationRule: 'rule', revision: '3' } }
      if (selector === '#view-work') return { classList: { contains: () => clicked } }
      if (selector === '#work-detail') return { innerText: 'SYNTHETIC synthetic-a' }
      if (selector === '[data-automation-occurrence="' + occurrenceId + '"]') return { innerText: target.innerHTML.replace(/<[^>]*>/g, '') }
      if (selector === '[data-automation-occurrence="' + occurrenceId + '"] .automation-query-facts') return target.innerHTML.includes('automation-query-facts') ? { innerText: '3 ' + queriedAt } : null
      return nodes(selector)[0] ?? null
    } }
    const el = id => id === 'automation-detail' ? target : id === 'refresh-automations' ? refresh : null
    const paint = () => render(state, el, (items, id) => items?.find(item => item.id === id), esc, String, {}, {}, value => ['accepted', 'running'].includes(value), { repair: '维修' }, document, () => {}, () => {})
    paint(); assert(target.innerHTML.includes(queriedAt)); assert.equal(nodes('[data-automation-occurrence="' + occurrenceId + '"] [data-open-work="' + workId + '"]').length, 0)
    const reloadGate = new Promise(done => { release = done })
    Function('el', 'state', 'reloadAll', 'openAutomation', 'setMessage', refreshSource)(el, state, async () => { await reloadGate; state.bootstrap.works = outcome === 'missing-work' ? [] : [{ id: outcome === 'current-work' ? workId : 'other-work', status: 'completed' }] }, async id => { assert.equal(id, 'rule'); paint() }, () => {})
    const evaluate = expression => Function('document', 'innerWidth', 'innerHeight', 'return ' + expression)(document, 1440, 900)
    const page = { evaluate, click: async selector => { if (selector === '#refresh-automations') { pending = refresh.onclick(); return }; const box = evaluate(clickExpression.replace('${js(selector)}', js(selector))); assert(box.visible && !box.disabled && box.clickable); clicked = true }, wait: async expression => {
      let ready = evaluate(expression)
      if (expression.includes('automation-query-facts') && ready && !waited) queryReadyBeforeBootstrap = true
      if (!ready && expression.includes('data-open-work')) { waited = true; assert(queryReadyBeforeBootstrap); release(); await pending; ready = evaluate(expression) }
      assert(ready, 'expected occurrence work has not rendered')
    } }
    const run = Function('assert', 'openRule', 'waitRuleRendered', 'detail', 'js', 'record', 'instance', 'return ' + source.slice(start, end).trim())(assert, async () => state.automationDetail, waitRuleRendered, async () => state.automationDetail, js, () => ({ reference: 'SYNTHETIC' }), () => ({ connection: { sourceInstance: 'synthetic-a' } }))
    try {
      const action = run(page, 'rule', { occurrence, work: { id: workId }, result: { payload: { recordType: 'repair' } } })
      if (outcome === 'current-work') { await action; assert(waited && clicked && queryReadyBeforeBootstrap) }
      else { await assert.rejects(action, /has not rendered/); assert.equal(clicked, false) }
    } finally { release(); await pending }
  }
}
async function nativeTimeChecks(source) {
  const start = source.indexOf('  async function createRule('), end = source.indexOf('\n  async function action(', start)
  const caller = source.slice(start, end).match(/    if \(trigger\.kind === 'daily-time'\) [^\n]+/)?.[0]
  assert(caller, 'actual time input callsite missing')
  const run = Function('page', 'trigger', 'fillNativeTime', 'return (async()=>{' + caller + '})()')
  for (const time of ['13:27', '00:05', '12:40', '23:59', '08:00', '00:00', '12:00']) {
    const sent = [], page = { click: async selector => assert.equal(selector, '#automation-time'), fill: async () => { throw new Error('insertText does not edit native time segments') }, send: async (method, input) => { assert.equal(method, 'Input.dispatchKeyEvent'); sent.push(input) }, evaluate: async () => time }
    await run(page, { kind: 'daily-time', time }, fillNativeTime)
    assert.equal(sent.filter(item => item.type === 'keyDown' && item.text).map(item => item.text).join(''), String(Number(time.slice(0, 2)) % 12 || 12).padStart(2, '0') + time.slice(3) + (Number(time.slice(0, 2)) >= 12 ? 'p' : 'a'))
    assert.equal(sent.at(-2).key, 'Tab'); assert.equal(sent.at(-1).type, 'keyUp')
  }
  for (const value of ['24:00', '12:60', '1:05']) await assert.rejects(fillNativeTime({}, '#automation-time', value), /HH:mm/)
  await assert.rejects(fillNativeTime({ click: async () => {}, send: async () => {}, evaluate: async () => '08:00' }, '#automation-time', '13:27'), /readback/)
}
async function diagnosticsChecks(source) {
  const { EventEmitter } = await import('node:events'), start = source.indexOf('function captureHostDiagnostics('), end = source.indexOf('\nasync function assertStopped(', start)
  const compile = Function('join', 'constants', 'openSync', 'writeFileSync', 'appendFileSync', 'closeSync', source.slice(start, end) + '; return captureHostDiagnostics')
  const files = new Map(), collector = compile(join, constants, path => { files.set(path, Buffer.alloc(0)); return path }, (path, value) => files.set(path, Buffer.from(value)), (path, value) => files.set(path, Buffer.concat([files.get(path), value])), () => {})
  const child = Object.assign(new EventEmitter(), { pid: 987654321, exitCode: null, signalCode: null }), errors = [], capture = collector(child, '/memory', { runId: 'pure' }, error => errors.push(error))
  capture.stderr(Buffer.from('private body')); const request = capture.stopRequested('SIGTERM'); capture.stopReturned(request)
  child.emit('exit', 0, null); child.emit('close')
  const metadata = JSON.parse(files.get('/memory/host-' + child.pid + '.json')); assert.equal(metadata.bytesSaved, 12); assert.equal(metadata.stopRequests[0].signalDelivered, null); assert.equal(metadata.exitCode, 0); assert(capture.closed); assert.equal(errors.length, 0)
  const large = Object.assign(new EventEmitter(), { pid: 987654322, exitCode: null, signalCode: null }), bounded = collector(large, '/memory', {}, error => errors.push(error))
  bounded.stderr(Buffer.alloc(8 * 1024 * 1024 + 1)); assert.equal(errors.length, 1); large.emit('close')
  assert.equal(JSON.parse(files.get('/memory/host-' + large.pid + '.json')).truncated, true)
  const stopStart = source.indexOf('async function stopGroup('), stopEnd = source.indexOf('\nfunction captureHostDiagnostics(', stopStart)
  for (const mode of ['normal', 'residue', 'escalated']) {
    let alive = mode === 'residue', kills = 0
    const groupStop = Function('assert', 'stop', 'gone', 'process', 'poll', source.slice(stopStart, stopEnd) + '; return stopGroup')(assert, async () => {}, () => !alive, { kill: (pid, signal) => { assert.equal(pid, -987654323); assert.equal(signal, 'SIGKILL'); kills++; alive = false; return true } }, async check => assert(check()))
    const child = { pid: 987654323, exitCode: mode === 'escalated' ? null : 0, signalCode: mode === 'escalated' ? 'SIGKILL' : null }
    if (mode === 'normal') await groupStop(child)
    else await assert.rejects(groupStop(child), /forced cleanup/)
    assert.equal(kills, mode === 'residue' ? 1 : 0)
  }
}
async function reportChecks(source) {
  const block = source.match(/let savedFailure\n[\s\S]*?\} while \(savedFailure !== failure\)/)?.[0]; assert(block)
  const execute = Function('join', 'publicFailure', 'manual', 'return async function(injectAt) {let failure,writes=0;const files=new Map(),options={output:"/memory"},steps=[],cleanup={state:{}},interrupts={state:{}},report={ok:true,scope:"渠道为模拟验收",candidate:{preflight:{head:"pure"}},media:{},steps:[],cleanup:{}};const writeFile=async(path,text)=>{files.set(path,text);if(++writes===injectAt)failure=new Error("INTERRUPTED")};' + block + ';return {report,files,writes}}')(join, publicFailure, manual)
  for (const index of [1, 2]) { const result = await execute(index); assert.equal(result.report.ok, false); assert.equal(JSON.parse(result.files.get('/memory/observations.json')).ok, false); assert(result.files.get('/memory/index.html').includes('本轮未通过')); assert.equal(result.writes, 4) }
}
