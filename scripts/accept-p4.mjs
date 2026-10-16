import assert from 'node:assert/strict'
import { appendFileSync, closeSync, constants, openSync, writeFileSync } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording } from './accept-p4-s1.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const script = fileURLToPath(import.meta.url)
const model = 'deepseek/deepseek-v4.1-flash'
const readSkill = 'skill-kivo-tpm-record-read'
const agents = { a: 'channel-tpm-a', b: 'channel-tpm-b' }
const appIds = { feishu: 'channel-feishu', weixin: 'channel-app-weixin' }
const providerAppId = 'cli_aaaaaaaaaaaaaaaa'
const tenant = 'synthetic-channel-tenant'
const pairs = ['a', 'b'].flatMap(actor => ['feishu', 'weixin'].map(provider => ({ actor, provider, key: actor + '-' + provider })))
const requiredSteps = ['agents', ...pairs.map(pair => 'bind-' + pair.key), ...pairs.map(pair => 'work-' + pair.key), ...pairs.map(pair => 'rotate-' + pair.key), 'old-web-replies', 'channel-default', 'isolation-and-replay', 'delivery-outcomes', 'authorization', 'unlink-and-rebind', 'restart-and-restore']
const connectionFields = ['kind', 'targetIdentity', 'baseUrl', 'issuer', 'clientId', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']

if (process.env.GENEWAY_CHANNEL_CONTEXT_LOG && process.env.GENEWAY_CHANNEL_ACCEPT_HOST === '1' && resolve(process.argv[1] ?? '') === script) {
  assert(isAbsolute(process.env.GENEWAY_CHANNEL_CONTEXT_LOG), 'context log must be absolute')
  const canaries = JSON.parse(process.env.GENEWAY_CHANNEL_CANARIES)
  globalThis.fetch = observeContext(globalThis.fetch, canaries, value => appendFileSync(process.env.GENEWAY_CHANNEL_CONTEXT_LOG, JSON.stringify(value) + '\n', { mode: 0o600 }))
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--host') await channelHost()
  else {
    const options = argumentsFor(process.argv.slice(2))
    if (options.help) console.log(usage())
    else if (options['harness-check']) await harnessCheck()
    else await acceptance(options)
  }
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
    values[key] = resolve(values[key])
    assert(!within(root, values[key]), key + ' must be outside the shared repository')
  }
  assert(/^[a-f0-9]{40}$/.test(values['expected-head'] ?? ''), 'explicit --expected-head is required')
  assert(/^[a-f0-9]{64}$/.test(values['guard-sha256'] ?? ''), 'explicit --guard-sha256 is required')
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values['model-ref'] ?? ''), 'explicit --model-ref is required')
  assert.equal(values['model-ref'], 'ZENMUX_API_KEY', 'root must explicitly stage the approved model key under the product route ref ZENMUX_API_KEY')
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values['run-id'] ?? ''), 'explicit --run-id is required')
  return values
}
function usage() {
  return 'P4 渠道完整旅程验收；渠道为模拟验收。真实运行须 root 新 GO，不按时间自动启动。\n\n' +
    '纯检查：node scripts/accept-p4.mjs --harness-check\n\n' +
    '获准后：node scripts/accept-p4.mjs --run --output <仓库外新目录> --fixture <root明确fixtures.json> --catalog <root明确catalog.json> --candidate <冻结清单> --expected-head <完整HEAD> --secret-root <root明确隔离0700目录> --model-ref ZENMUX_API_KEY --network-guard <已审guard> --guard-sha256 <已审SHA256> --run-id <本轮唯一ID>\n\n' +
    '所有普通旅程均必须通过；无跳过失败的选项。真实浏览器、实际内置渠道、官方SDK、真实ZenMux ' + model + ' 与两个隔离synthetic Kivo实例。只读业务，不轮换Kivo密钥、不扫描秘密、不发送Lark。产物：p4-channels.mp4、离线中文index.html、observations.json。'
}

async function channelHost() {
  assert.equal(process.env.GENEWAY_CHANNEL_ACCEPT_HOST, '1', 'private acceptance Host mode requires its explicit runtime environment')
  assert.equal(process.env.GENEWAY_NETWORK_AUDIT_ROLE, 'host'); assert(process.env.NODE_OPTIONS?.includes('--import='), 'approved network guard is required')
  assert(process.send && process.env.GENEWAY_CHANNEL_HOST_CONFIG, 'owned IPC Host config is required')
  const config = await privateJson(process.env.GENEWAY_CHANNEL_HOST_CONFIG)
  const url = new URL(config.value.ilinkUrl)
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1')
  const [{ start }, { createWeixinApi }, { createFeishuSimulator }, Lark] = await Promise.all([
    import('../src/server.mjs'), import('../vendor/dsh-im/weixin/weixin-api.mjs'), import('./test-p4-channel-conversations.mjs'), import('@larksuiteoapi/node-sdk'),
  ])
  const platform = createFeishuSimulator()
  const server = await start({ feishuSdk: { ...Lark, Client: platform.Client, WSClient: platform.WSClient }, weixinApi: createWeixinApi({ testMode: true, testBaseUrl: url.href, timeoutMs: 3000, longPollTimeoutMs: 3000 }) })
  if (!server.listening) await new Promise((resolveListen, reject) => { server.once('listening', resolveListen); server.once('error', reject) })
  process.on('message', async message => {
    if (!message || message.kind !== 'channel-acceptance') return
    try {
      let value
      if (message.method === 'feishu-event') {
        assert(platform.dispatcher instanceof Lark.EventDispatcher, 'actual official EventDispatcher is missing')
        value = await platform.dispatcher.invoke(message.input, { needCheck: false })
      } else if (message.method === 'feishu-send-response') { platform.queueSend(message.input); value = true }
      else if (message.method === 'snapshot') value = { pid: process.pid, address: server.address(), sdkDispatcher: platform.dispatcher instanceof Lark.EventDispatcher, sent: platform.sent }
      else throw new Error('unknown acceptance IPC method')
      process.send({ kind: 'channel-acceptance', id: message.id, ok: true, value })
    } catch (error) { process.send({ kind: 'channel-acceptance', id: message.id, ok: false, error: safeFailure(error) }) }
  })
  process.send({ kind: 'channel-acceptance-ready', pid: process.pid })
}

async function acceptance(options) {
  const inputs = {}
  for (const key of ['fixture', 'catalog', 'candidate']) inputs[key] = await privateJson(options[key])
  const fixture = validateFixture(inputs.fixture.value, inputs.catalog.value), frozen = validateCandidate(inputs.candidate.value)
  const guardSha256 = hash(await readFile(options['network-guard']))
  assert.equal(guardSha256, options['guard-sha256'], 'approved guard changed')
  const preflight = await snapshot(frozen, options['expected-head'])
  const secretMetadata = await lstat(options['secret-root'])
  assert(secretMetadata.isDirectory() && !secretMetadata.isSymbolicLink() && (secretMetadata.mode & 0o777) === 0o700, 'root must prepare a private isolated 0700 secret root')
  await mkdir(options.output, { mode: 0o700 })
  const privateDirectory = join(options.output, 'private')
  await mkdir(privateDirectory, { mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-channel-accept-'))
  await chmod(scratch, 0o700)
  let stateFile = join(scratch, 'state.json'), dshHome = join(scratch, 'dsh'), secretRoot = options['secret-root']
  const authFile = join(scratch, 'auth.json'), contextFile = join(scratch, 'context.jsonl'), auditFile = join(scratch, 'network.jsonl'), hostConfig = join(scratch, 'host.json')
  const port = await freePort(), origin = 'http://127.0.0.1:' + port, children = [], browsers = {}, sessions = {}, steps = [], facts = [], hosts = []
  const passwords = Object.fromEntries(['admin', 'a', 'b'].map(actor => [actor, randomBytes(24).toString('base64url')]))
  const canaries = Object.fromEntries(pairs.map(pair => [pair.key, 'CONTEXT_' + randomBytes(12).toString('hex')]))
  const accounts = Object.fromEntries(['a', 'b'].map(actor => [actor, { id: 'synthetic-' + options['run-id'] + '-' + actor, ownerUserId: 'synthetic-wx-owner-' + actor, token: 'SYNTHETIC_TOKEN_' + randomBytes(24).toString('hex') }]))
  const feishuRef = 'P4_' + hash(options['run-id']).slice(0, 24).toUpperCase() + '_FEISHU', feishuSecret = join(options['secret-root'], feishuRef)
  const caption = join(scratch, 'caption.txt'), video = join(options.output, 'p4-channels.mp4')
  const auditBinding = { runId: options['run-id'], candidate: inputs.candidate.sha256, guardSha256 }
  const abort = new AbortController(), refs = {}, canaryContexts = []
  let server, simulator, recording, recordingAt, display, failure, report, restarting = false, settle, hostSnapshot, messageSequence = 0, simulatorClosed = false
  const operationSettled = new Promise(resolveSettled => { settle = resolveSettled })
  const cleanup = runCleanup({ children, browsers, recording: () => recording, operationSettled, removeAuth: () => rm(authFile, { force: true }), onFailure: error => { failure ??= error }, stopChild: stopGroup })
  const fail = error => { failure ??= error; abort.abort(error); void cleanup.run() }
  const interrupts = interruptHandlers(process, (signal, force) => { fail(new Error('interrupted by ' + signal)); void cleanup.run(force) })
  try {
    const [{ createFileStore }, { initializeAuthFile }, { createILinkSimulator }] = await Promise.all([import('../src/store/file-store.mjs'), import('../src/auth.mjs'), import('./fixtures/ilink-server.mjs')])
    simulator = await createILinkSimulator({ holdMs: 100 })
    for (const account of Object.values(accounts)) simulator.addAccount(account)
    await writeFile(hostConfig, JSON.stringify({ ilinkUrl: simulator.url }), { mode: 0o600, flag: 'wx' })
    await writeFile(feishuSecret, JSON.stringify({ appId: providerAppId, appSecret: 'synthetic_' + randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' })
    const store = createFileStore(stateFile), now = new Date().toISOString()
    await store.update(state => ({ ...state,
      members: ['admin', 'a', 'b'].map(actor => ({ id: actor, loginName: actor, displayName: actor === 'admin' ? '验收管理员' : '验收成员 ' + actor.toUpperCase(), role: actor === 'admin' ? 'admin' : 'member', enabled: true, authRef: actor, employeeIds: [], sessionVersion: 1, createdAt: now, updatedAt: now })),
      modelRoutes: [{ id: 'channel-model', provider: 'zenmux', model, displayName: 'ZenMux Flash', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
      skills: [{ id: readSkill, name: 'TPM 指定记录', capabilityId: 'kivo-tpm-record-read', enabled: true }],
      connections: fixture.instances.map(instance => ({ ...instance.connection, enabled: true, skillIds: [readSkill], revision: 1, status: 'untested', createdAt: now, updatedAt: now })),
      channelApps: ['feishu', 'weixin'].map(provider => ({ id: appIds[provider], provider, providerAppId: provider === 'feishu' ? providerAppId : 'ilink', providerTenantId: provider === 'feishu' ? tenant : 'personal', credentialRef: provider === 'feishu' ? feishuRef : null, enabled: true, allowedScopes: ['result'], revision: 1, status: 'active', createdAt: now, updatedAt: now })),
    }))
    await initializeAuthFile(authFile, passwords)
    server = await boot()
    const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim(); assert(/^:\d+$/.test(display))
    for (const actor of ['admin', 'a', 'b']) { browsers[actor] = await browser(actor); await login(actor) }
    await writeFile(caption, 'P4：渠道为模拟验收；模型与本地 synthetic Kivo 为真实只读路径', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; await access(font)
    const recorder = launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', display + '.0', '-vf', 'pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=' + font + ':textfile=' + caption + ':reload=1:fontcolor=white:fontsize=24:x=20:y=h-54', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] })
    recording = watchRecording(recorder, fail); recordingAt = recording.state.startedAt
    await pause(500); recording.assertRunning()

    await journeys()
    assertComplete(steps)
    hostSnapshot = await ipc(server, 'snapshot'); hosts.push(hostSnapshot)
    assert.deepEqual(simulator.failures, [], 'iLink simulator observed a protocol violation')
    for (const account of Object.values(accounts)) assert(simulator.maxActivePolls(account.id) <= 1, 'duplicate iLink account consumer')
    for (const page of Object.values(browsers)) assert.deepEqual(page.errors, [], 'browser runtime error')
  } catch (error) { fail(error) }
  finally {
    settle(); await cleanup.run()
    try { if (simulator) { await simulator.close(); simulatorClosed = true } } catch (error) { failure ??= error }
    try {
      await assertStopped(children, authFile)
      assert.equal(hash(await readFile(options['network-guard'])), guardSha256, 'approved guard changed during acceptance')
      for (const key of ['fixture', 'catalog', 'candidate']) assert.equal((await privateJson(options[key])).sha256, inputs[key].sha256, 'explicit ' + key + ' changed during acceptance')
      const postflight = await snapshot(frozen, options['expected-head']); assert.deepEqual(postflight, preflight, 'candidate changed during acceptance')
      const networkRows = await jsonLines(auditFile), audit = networkAudit(networkRows, { ...auditBinding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid), hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean) })
      for (const instance of fixture.instances) assert(kivoRequests(networkRows, { instances: [instance] }).length > 0, 'actual Kivo HTTP requests were not audited for ' + instance.instance)
      canaryContexts.push(...await jsonLines(contextFile))
      const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]))
      const coverage = recordingCoverage(recording.state, probe, steps)
      await command('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'])
      if (!failure) assertComplete(steps)
      report = { ok: !failure, failure: failure ? safeFailure(failure) : null, scope: '渠道为模拟验收；真实 Web/官方 SDK/native/ZenMux Flash 与两个隔离 synthetic Kivo 只读实例，本地非生产。', candidate: { manifestSha256: inputs.candidate.sha256, preflight, postflight }, inputHashes: { fixture: inputs.fixture.sha256, catalog: inputs.catalog.sha256 }, model, network: { ...audit, kivoHttpRequests: kivoRequests(networkRows, fixture).length }, cleanup: { ...cleanup.state, ownedGroupsExited: true, simulatorClosed }, media: { video: 'p4-channels.mp4', ...coverage }, steps, facts, transports: { feishu: hosts, weixin: simulator?.calls ?? [] }, context: canaryContexts }
    } catch (error) { failure ??= error }
    report ??= { ok: false, failure: safeFailure(failure), scope: '渠道为模拟验收；本轮未取得完整通过结果。', model, candidate: { manifestSha256: inputs.candidate.sha256, preflight }, cleanup: cleanup.state, media: {}, steps, facts }
    try {
      let savedFailure
      do {
        savedFailure = failure
        report.ok = !failure; report.failure = failure ? safeFailure(failure) : null
        Object.assign(report.cleanup, cleanup.state, interrupts.state)
        await writeFile(join(options.output, 'observations.json'), JSON.stringify({ ...report, steps: report.steps.map(step => ({ ...step, screenshots: step.screenshots.map(({ image, ...shot }) => shot) })) }, null, 2) + '\n', { mode: 0o600 })
        await writeFile(join(options.output, 'index.html'), manual(report), { mode: 0o600 })
      } while (savedFailure !== failure)
    } finally { interrupts.dispose() }
  }
  console.log(JSON.stringify({ ok: report.ok, scope: report.scope, output: options.output, steps: steps.map(step => ({ id: step.id, result: step.result })), failure: report.failure, cleanup: report.cleanup }))
  if (!report.ok) process.exitCode = 1

  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.stderrText = ''; child.stderr?.on('data', chunk => { child.stderrText = (child.stderrText + chunk).slice(-3000); child.hostDiagnostics?.stderr(chunk) })
    child.on('error', error => { child.spawnError = error }); children.push(child); return child
  }
  async function boot(channelsExpected = true) {
    const env = { ...systemEnvironment(), DSH_HOME: dshHome, GENEWAY_DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED',
      GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_PORT: String(port), GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin,
      GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'], GENEWAY_CONNECTION_CATALOG: options.catalog,
      NODE_OPTIONS: '--import=' + pathToFileURL(options['network-guard']).href,
      GENEWAY_NETWORK_AUDIT_RUN_ID: auditBinding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: auditBinding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
      GENEWAY_CHANNEL_ACCEPT_HOST: '1', GENEWAY_CHANNEL_HOST_CONFIG: hostConfig, GENEWAY_CHANNEL_CONTEXT_LOG: contextFile, GENEWAY_CHANNEL_CANARIES: JSON.stringify(canaries),
    }
    const child = launch(process.execPath, [script, '--host'], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); child.auditRole = 'host'
    child.auditFile = auditFile; child.auditBinding = auditBinding
    child.hostDiagnostics = captureHostDiagnostics(child, privateDirectory, auditBinding, fail)
    await poll(async () => {
      abort.signal.throwIfAborted()
      if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated actual product Host failed to start')
      try { return (await fetch(origin + '/', { signal: AbortSignal.timeout(3000) })).status === 200 } catch { return false }
    }, 'actual channel product Host', 30_000)
    const identity = await ipc(child, 'snapshot')
    assert.equal(identity.pid, child.pid); assert.equal(identity.address?.port, port); assert.equal(identity.address?.address, '127.0.0.1'); assert.equal(identity.sdkDispatcher, channelsExpected)
    return child
  }
  async function browser(actor) {
    const debugPort = await freePort(), profile = join(scratch, 'chrome-' + actor)
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
    const child = launch('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI', '--user-data-dir=' + profile, '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', '--app=' + origin], { env: { ...systemEnvironment(), DISPLAY: display } })
    const target = await poll(async () => {
      if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated browser exited before CDP')
      try { return (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(3000) })).json()).find(item => item.type === 'page' && item.url.startsWith(origin)) } catch { return false }
    }, 'isolated browser CDP')
    const page = await connect(target, () => restarting); page.actor = actor
    const front = page.front
    page.front = async () => {
      for (const other of Object.values(browsers).filter(value => value !== page)) { const window = await other.send('Browser.getWindowForTarget'); await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } }) }
      const { width, height } = page.size(), window = await page.send('Browser.getWindowForTarget')
      await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } }); await front()
    }
    await page.viewport(1440, 900); await page.wait('Boolean(document.querySelector("#login-name"))')
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait('!document.querySelector("#app")?.classList.contains("hidden")')
    return page
  }
  async function login(actor) { const result = await request(actor, '/api/session', 'POST', { loginName: actor, password: passwords[actor] }); assert.equal(result.status, 200); sessions[actor] = { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken } }
  async function request(actor, path, method = 'GET', body) {
    const headers = { origin }, session = sessions[actor]
    if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.csrf }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })
    const text = await response.text(), result = { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') }
    assert(!/SYNTHETIC_TOKEN_|bot_token|context_token|get_updates_buf/.test(JSON.stringify(result.body)), 'public API exposed a channel secret')
    return result
  }
  async function api(actor, path, method = 'GET', body) { const result = await request(actor, path, method, body); assert(result.status >= 200 && result.status < 300, method + ' ' + path + ' failed: ' + result.status + ' ' + JSON.stringify(result.body)); return result.body }
  async function denied(actor, path, method, body, statuses = [403, 404]) { const result = await request(actor, path, method, body); assert(statuses.includes(result.status), 'permission/validation denial missing'); return result }
  async function disk() { return JSON.parse(await readFile(stateFile, 'utf8')) }
  async function channelState(actor) { return api(actor, '/api/channels') }
  async function reload(page, view) {
    await page.front()
    const timeOrigin = await page.evaluate('performance.timeOrigin')
    await page.send('Page.reload')
    await page.wait('performance.timeOrigin !== ' + timeOrigin + ' && !document.querySelector("#app")?.classList.contains("hidden") && document.querySelector("#runtime-state")?.innerText.includes("已登录")')
    if (view) await page.nav(view)
  }
  async function refreshChannels(page) { await reload(page, 'channels') }

  async function journeys() {
    await step('agents', 'admin', '创建员工、核对连接与开放范围', async page => {
      await page.nav('admin'); await page.click('#tab-connections')
      for (const instance of fixture.instances) {
        const form = 'form[data-kind="connection"][data-id="' + instance.connection.id + '"]'
        await page.click('details:has(' + form + ') > summary')
        await page.click('[data-test-connection="' + instance.connection.id + '"]')
        await page.wait('document.querySelector("#admin-message")?.innerText.includes("协议与固定只读工具目录测试通过")')
        await poll(async () => (await api('admin', '/api/admin/connections')).find(item => item.id === instance.connection.id)?.status === 'ready', 'real Kivo MCP catalog test', 30_000)
      }
      await page.click('#tab-employees')
      for (const actor of ['a', 'b']) {
        const form = 'form[data-kind="employee"][data-id=""]', instance = fixture.instances.find(value => value.instance === actor)
        for (const [key, value] of Object.entries({ id: agents[actor], name: actor === 'a' ? 'A 专属 TPM 员工' : '公共 TPM 员工', description: '本地 synthetic TPM 渠道验收', instructions: '使用获准的产品工作工具处理交办。创建TPM指定记录查询时使用 skillId=' + readSkill + '、connectionId=' + instance.connection.id + '。缺少reference仍先创建同一waiting_input工作，明确缺项；用户提供精确workId后只补充继续该工作。不要猜其他工作或连接，不要直接虚构TPM结果。纯聊天简短回复；按要求长文时完整生成。' })) await page.fill(form + ' [name="' + key + '"]', value)
        await page.select(form + ' [name="modelRouteId"]', 'channel-model'); await page.check(form + ' [name="skillIds"][value="' + readSkill + '"]', true)
        await page.check(form + ' [name="connectionIds"][value="' + instance.connection.id + '"]', true)
        for (const member of actor === 'a' ? ['a'] : ['a', 'b']) await page.check(form + ' [name="memberIds"][value="' + member + '"]', true)
        await page.click(form + ' button.primary'); await page.wait('document.querySelector("#admin-message")?.innerText.includes("配置已保存并从服务端回读")'); await page.wait('Boolean(document.querySelector(' + JSON.stringify('form[data-kind="employee"][data-id="' + agents[actor] + '"]') + '))')
      }
      await setDefault(agents.a)
      for (const actor of ['a', 'b']) await reload(browsers[actor], 'channels')
      assert(!(await api('b', '/api/bootstrap')).employees.some(item => item.id === agents.a))
      await denied('b', '/api/conversations', 'POST', { employeeId: agents.a })
    }, '管理员创建 A 专属与公共员工；两个独立 Kivo 连接通过实际协议检查，B 看不到也用不了 A 专属员工。')

    for (const pair of pairs) await step('bind-' + pair.key, pair.actor, pair.actor.toUpperCase() + ' 自助绑定' + label(pair.provider), async page => {
      if (pair.provider === 'weixin') await page.viewport(390, 844)
      refs[pair.key] = await bind(pair, page)
      await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-channel-identity="' + refs[pair.key].identityId + '"]') + '))')
      assert.equal((await conversation(pair.actor, refs[pair.key].originalConversation)).turns.length, 0)
    }, '本人从我的渠道完成关联与确认；确认前消息持久拒绝且不补跑，新身份与空白会话仅归当前成员。')

    for (const pair of pairs) await step('work-' + pair.key, pair.actor, label(pair.provider) + '交办、补充后在 Web 继续同一工作', async page => {
      const ref = refs[pair.key], marker = 'P4_' + pair.actor.toUpperCase() + '_' + pair.provider.toUpperCase()
      const initial = await disk(), existing = initial.works.map(work => work.id)
      await inbound(pair, marker + '_CREATE', marker + '_CREATE 本会话验收代号是 ' + canaries[pair.key] + '。请先创建一个TPM维修记录查询工作：recordType=repair，尚未提供reference，请保留为等待补充，不要猜单号。反馈工作ID与缺少信息。')
      await inboundFinished(pair, marker + '_CREATE')
      const waiting = await poll(async () => {
        const values = (await disk()).works.filter(work => work.conversationId === ref.originalConversation && !existing.includes(work.id))
        assert(values.length <= 1, 'one channel assignment created multiple works')
        if (!values.length) return false
        assert.equal(values[0].status, 'waiting_input', 'missing reference did not produce an explicit waiting work'); return values[0]
      }, 'channel natural-language work creation', 30_000)
      ref.workId = waiting.id
      const record = fixtureRecord(pair.actor)
      await inbound(pair, marker + '_CONTINUE', marker + '_CONTINUE 请为工作 ' + waiting.id + ' 补充 input.reference=' + record.reference + '、recordType=repair，并继续同一工作，不要另建工作。')
      await inboundFinished(pair, marker + '_CONTINUE')
      const work = await completedWork(pair.actor, waiting.id)
      assertTyped(work, pair.actor)
      assert.equal((await disk()).works.filter(value => value.conversationId === ref.originalConversation).length, 1, 'supplement created another work')
      await openConversation(page, ref.originalConversation)
      await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-conversation-work="' + waiting.id + '"]') + '))')
      await page.click('[data-conversation-work="' + waiting.id + '"]')
      await page.wait('document.querySelector("#view-work")?.classList.contains("active")')
      assert((await page.evaluate('document.querySelector("#work-detail").innerText')).includes(record.reference), 'Web does not show the same record')
      const beforeResults = work.results.length, beforeReads = kivoRequests(await jsonLines(auditFile), fixture).length
      await page.fill('#follow-text', '只解释这个工作已保存的维修记录状态和来源，不刷新、不创建其他工作。'); await page.click('#follow-form button')
      const continued = await completedWork(pair.actor, waiting.id, beforeResults)
      assert.equal(continued.results.at(-1).kind, 'assistant.follow-up')
      assert.equal(kivoRequests(await jsonLines(auditFile), fixture).length, beforeReads, 'saved-fact follow-up unexpectedly refreshed Kivo')
      const resultId = continued.results.at(-1).id
      await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-create-delivery="' + waiting.id + '"][data-result="' + resultId + '"]') + '))')
      const before = await sendCount(pair)
      await page.click('[data-create-delivery="' + waiting.id + '"][data-result="' + resultId + '"]')
      const delivery = await poll(async () => (await disk()).deliveries.find(value => value.workId === waiting.id && value.resultId === resultId && value.status === 'delivered'), 'Web reply delivered through original transport', 30_000)
      assert.equal(delivery.targetIdentityId, ref.identityId); assert(await sendCount(pair) > before, 'original transport did not observe the Web reply')
      await assertOwnTarget(pair)
      facts.push({ kind: 'channel-work', actor: pair.actor, provider: pair.provider, identityId: ref.identityId, conversationId: ref.originalConversation, workId: work.id, recordId: record.recordId, sourceInstance: instance(pair.actor).connection.sourceInstance, resultId, deliveryId: delivery.id, observedAt: new Date().toISOString() })
      await assertContext(marker + '_CREATE', { [pair.key]: true })
    }, '渠道实际交办形成缺字段等待，精确补充继续原工作；真实模型与 Kivo 保存正确来源事实，Web 追问同工作并投回原渠道。')

    for (const pair of pairs) await step('rotate-' + pair.key, pair.actor, label(pair.provider) + '开启新会话并核对隔离', async page => {
      const ref = refs[pair.key], old = await conversation(pair.actor, ref.originalConversation), otherBefore = await activePointers()
      await inbound(pair, 'rotate-' + pair.key, '新会话')
      ref.activeConversation = await poll(async () => { const identity = await identityFor(pair); return identity.activeConversationId !== ref.originalConversation && identity.activeConversationId }, 'channel new conversation')
      const current = await conversation(pair.actor, ref.activeConversation)
      assert.equal(current.turns.length, 0); assert.equal(current.historyStatus, 'empty'); assert.notEqual(current.id, old.id)
      assert.equal((await conversation(pair.actor, old.id)).turns.length, old.turns.length)
      const after = await activePointers()
      for (const other of pairs.filter(value => value.key !== pair.key)) assert.equal(after[other.key], otherBefore[other.key], 'channel rotation changed another member/provider pointer')
      const marker = 'P4_' + pair.actor.toUpperCase() + '_' + pair.provider.toUpperCase() + '_CLEAN'
      await inbound(pair, marker, marker + ' 请用一句话介绍当前空白对话，不读取其他工作或其他对话。')
      await inboundFinished(pair, marker); await assertContext(marker, {})
      await refreshChannels(page); await page.wait('(()=>{const identity=document.querySelector(' + JSON.stringify('[data-channel-identity="' + ref.identityId + '"]') + ');return Boolean(identity?.querySelector(' + JSON.stringify('.channel-history [data-open-channel-conversation="' + old.id + '"]') + ') && identity.querySelector(' + JSON.stringify('.channel-history [data-open-channel-conversation="' + current.id + '"]') + '))})()')
      assert((await page.evaluate('document.querySelector("#channel-list").innerText')).includes('历史'))
      facts.push({ kind: 'channel-rotation', actor: pair.actor, provider: pair.provider, identityId: ref.identityId, before: old.id, after: current.id })
    }, '渠道新会话使用独立原生上下文，旧会话在本人 Web 历史保留；A/B 以及飞书/微信活动指针互不影响。')

    await step('old-web-replies', 'a', 'Web 继续旧对话并明确回复原渠道', async page => {
      for (const provider of ['feishu', 'weixin']) {
        const pair = pairFor('a', provider), ref = refs[pair.key], pointer = (await identityFor(pair)).activeConversationId
        const before = await sendCount(pair), turn = await webTurn(page, ref.originalConversation, 'P4_OLD_WEB_' + provider.toUpperCase() + ' 只用一句话说明如何从这段历史对话继续。')
        assert.equal(await sendCount(pair), before, 'Web continuation sent a channel reply without explicit action')
        await explicitReply(page, ref.originalConversation, turn.id)
        assert(await sendCount(pair) > before)
        assert.equal((await identityFor(pair)).activeConversationId, pointer, 'explicit old-session reply activated the old pointer')
      }
    }, '本人 Web 历史可以继续；发送前无渠道 I/O，明确回复后投原身份，渠道活动指针保持新会话。')

    await step('channel-default', 'admin', '全局默认与本人选择分别生效', async () => {
      const inherited = pairFor('a', 'feishu'), explicit = pairFor('a', 'weixin'), old = await identityFor(inherited), other = await identityFor(explicit)
      assert.equal(old.defaultEmployeeId, null); assert.equal(other.defaultEmployeeId, agents.a)
      await setDefault(agents.b)
      assert.equal((await identityFor(inherited)).activeConversationId, old.activeConversationId, 'admin edit eagerly changed existing conversation')
      await inbound(inherited, 'P4_DEFAULT_CHANGE', 'P4_DEFAULT_CHANGE 请用一句话说明你当前能如何帮助，不读取其他历史。')
      await inboundFinished(inherited, 'P4_DEFAULT_CHANGE')
      const next = await identityFor(inherited)
      assert.notEqual(next.activeConversationId, old.activeConversationId); assert.equal((await conversation('a', next.activeConversationId)).employeeId, agents.b)
      assert.equal((await identityFor(explicit)).activeConversationId, other.activeConversationId)
      await assertContext('P4_DEFAULT_CHANGE', {})
      const before = next.activeConversationId
      await refreshChannels(browsers.a); await browsers.a.select('#channel-employee-' + next.id, agents.a); await browsers.a.click('[data-new-channel-conversation="' + next.id + '"]')
      const selected = await poll(async () => { const value = await identityFor(inherited); return value.defaultEmployeeId === agents.a && value.activeConversationId !== before && value }, 'explicit member default changes conversation')
      assert.equal((await conversation('a', selected.activeConversationId)).turns.length, 0)
      await browsers.admin.front()
    }, '修改全局默认不改进行中的旧会话；下一条本人消息才为继承身份开启干净会话。本人明确选择保持独立，更换本人默认同时开启新会话。')

    await step('isolation-and-replay', 'b', '已知标识、重投及无效入站不能越界', async page => {
      const target = refs['a-feishu'], own = await channelState('b'), admin = await channelState('admin')
      assert(!own.identities.some(value => value.id === target.identityId)); assert(!admin.identities.some(value => value.id === target.identityId))
      for (const actor of ['b', 'admin']) {
        await denied(actor, '/api/conversations/' + target.originalConversation, 'GET')
        await denied(actor, '/api/works/' + target.workId, 'GET')
        await denied(actor, '/api/channels/identities/' + target.identityId + '/conversations', 'POST', {})
      }
      const state = await disk(), turn = state.conversations.find(value => value.id === target.originalConversation).turns[0]
      await denied('b', '/api/conversations/' + target.originalConversation + '/turns/' + turn.id + '/cancel', 'POST', {})
      await denied('b', '/api/channels/deliveries', 'POST', { requestId: 'wrong-owner', identityId: target.identityId, conversationId: target.originalConversation, turnId: turn.id })
      await denied('b', '/api/conversations', 'POST', { employeeId: agents.b, sessionId: 'foreign-session' }, [400])
      const before = await businessCounts(), message = state.channelMessages.find(value => value.providerMessageId === 'P4_A_FEISHU_CREATE')
      await inbound(pairFor('a', 'feishu'), message.providerMessageId, message.text)
      await inbound(pairFor('a', 'feishu'), message.providerMessageId, 'conflicting replacement text')
      const wx = pairFor('b', 'weixin')
      await inbound(wx, 'wx-outsider', '不可受理', { from_user_id: 'synthetic-outsider' })
      await inbound(wx, 'wx-non-text', '不可受理', { item_list: [{ type: 2, image_item: {} }] })
      await poll(async () => { const value = await disk(); return ['wx-outsider', 'wx-non-text'].every(id => value.channelMessages.some(item => item.providerMessageId === id && item.status === 'rejected')) }, 'durable unsupported/outsider dispositions')
      const earlier = weixinMessage(wx, 'wx-order-first', '非文本第一项', { item_list: [{ type: 2, image_item: {} }] }), later = weixinMessage(wx, 'wx-order-second', '非文本第二项', { item_list: [{ type: 2, image_item: {} }] })
      const cursor = simulator.push(accounts.b.id, [later, earlier])
      await poll(async () => { const value = await disk(); return [earlier, later].every(message => value.channelMessages.some(item => item.providerMessageId === message.message_id && item.status === 'rejected')) }, 'out-of-order batch durable dispositions')
      const ordered = (await disk()).channelMessages.map(value => value.providerMessageId)
      assert(ordered.indexOf(earlier.message_id) < ordered.indexOf(later.message_id), 'actual iLink batch was not ordered before durable admission')
      await poll(() => simulator.calls.some(value => value.botId === accounts.b.id && value.endpoint.endsWith('/getupdates') && value.cursorDigest === hash(cursor)), 'batch cursor follows durable dispositions')
      await ipc(server, 'feishu-event', feishuEvent('stranger', 'feishu-stranger', '不应取得私有工作'))
      await ipc(server, 'feishu-event', feishuEvent('b', 'feishu-echo', '平台回声', { sender_type: 'app' }))
      assert.deepEqual(await businessCounts(), before, 'duplicate/rejected channel events re-executed business')
      assert((await disk()).channelMessages.some(item => JSON.stringify(item).includes('OFFICIAL_ID_CONFLICT')))
      const groupBefore = (await ipc(server, 'snapshot')).sent.length
      await ipc(server, 'feishu-event', feishuEvent('b', 'feishu-group-private', 'P4_GROUP_PRIVATE @_user_1 请查询工作 ' + target.workId + ' 的结果，不要新建工作。', { chat_type: 'group', chat_id: 'synthetic-group', mentions: [{ key: '@_user_1', id: { open_id: 'fixture-bot' } }] }))
      await inboundFinished(pairFor('b', 'feishu'), 'feishu-group-private')
      const sent = (await ipc(server, 'snapshot')).sent.slice(groupBefore), grouped = sent.filter(value => value.data.receive_id === 'synthetic-group')
      assert(grouped.length && grouped.every(value => !Object.values(canaries).some(canary => value.data.content.includes(canary)) && !value.data.content.includes(fixtureRecord('a').recordId)), 'private result appeared in group output')
      assert(sent.some(value => value.data.receive_id === 'chat-b'), 'group sender did not receive private feedback')
      assert(sent.filter(value => value.data.receive_id === 'chat-b').every(value => !value.data.content.includes(fixtureRecord('a').recordId) && !value.data.content.includes(canaries['a-feishu'])), 'group sender received another member private facts')
      assert.equal((await disk()).works.length, before.works); assert.equal((await businessCounts()).executions, before.executions)
      await refreshChannels(page)
    }, 'B 与管理员不能读写 A 正文或原生会话；稳定消息重投不重执，冲突、非主人、非文本和陌生人不能创建业务。')

    await deliveryOutcomes()
    await authorization()
    await unlinkAndRebind()
    await restartAndRestore()
  }

  async function bind(pair, page) {
    assert.equal(page.actor, pair.actor, 'binding page must belong to the authenticated owner')
    await refreshChannels(page)
    const before = (await channelState(pair.actor)).linkCodes.map(value => value.id)
    const selector = pair.provider === 'feishu' ? '[data-issue-link="' + appIds.feishu + '"]' : '[data-begin-weixin-binding="' + appIds.weixin + '"]'
    await page.wait('Boolean(document.querySelector(' + JSON.stringify(selector) + '))'); await page.click(selector)
    const link = await poll(async () => {
      const created = (await channelState(pair.actor)).linkCodes.filter(value => !before.includes(value.id) && value.channelAppId === appIds[pair.provider])
      assert(created.length <= 1, 'one binding click created multiple owner link IDs')
      return created[0]
    }, 'new owner binding')
    assert(!Object.hasOwn(link, 'code') && !Object.hasOwn(link, 'digest'), 'GET binding metadata must hide the once-visible code and digest')
    if (pair.provider === 'feishu') {
      const codeSelector = '#channel-app-' + appIds.feishu + ' [data-link-code]'
      await page.wait('document.querySelectorAll(' + JSON.stringify(codeSelector) + ').length === 1 && Boolean(document.querySelector(' + JSON.stringify(codeSelector) + ')?.innerText.trim())')
      const code = await page.evaluate('document.querySelector(' + JSON.stringify(codeSelector) + ')?.innerText.trim()')
      assert(typeof code === 'string' && code.length > 0, 'current owner link code must be visible in its app')
      await inbound(pair, 'link-' + link.id, code)
    } else {
      await page.wait('Boolean(document.querySelector("img.channel-qr"))')
      const qr = await page.evaluate('document.querySelector("img.channel-qr").getAttribute("src")')
      assert(qr.startsWith('/api/channels/weixin/bindings/' + link.id + '/qr'), 'QR must come through the authenticated owner route')
      await denied(pair.actor === 'a' ? 'b' : 'a', '/api/channels/weixin/bindings/' + link.id + '/qr', 'GET')
      simulator.queueLogin(simulator.confirmedLogin(accounts[pair.actor].id))
    }
    await poll(async () => (await channelState(pair.actor)).linkCodes.find(value => value.id === link.id)?.status === 'matched', 'matched owner identity')
    const pendingId = 'before-confirm-' + link.id, count = await businessCounts()
    await inbound(pair, pendingId, '确认前消息不应执行，确认后我会重新发送。')
    await poll(async () => (await disk()).channelMessages.some(value => value.providerMessageId === pendingId && ['rejected', 'unhandled'].includes(value.status)), 'durable pre-confirmation rejection')
    await denied(pair.actor === 'a' ? 'b' : 'a', '/api/channels/link-codes/' + link.id + '/confirm', 'POST', {})
    const employee = pair.key === 'a-feishu' ? '' : agents[pair.actor]
    await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-confirm-link="' + link.id + '"]') + '))')
    await page.select('#channel-employee-' + link.id, employee); await page.click('[data-confirm-link="' + link.id + '"]')
    const identity = await poll(async () => (await channelState(pair.actor)).identities.find(value => value.channelAppId === appIds[pair.provider] && value.status === 'active'), 'Web confirms owner identity')
    assert(identity.activeConversationId, 'binding did not create a member conversation')
    assert.deepEqual(await businessCounts(), { ...count, conversations: count.conversations + 1 }, 'confirmation replayed a pre-confirmation business message')
    return { identityId: identity.id, originalConversation: identity.activeConversationId, activeConversation: identity.activeConversationId }
  }
  async function setDefault(employeeId) {
    const page = browsers.admin
    await page.front(); await page.nav('admin'); await page.click('#tab-channelApps'); await page.select('#channel-default-employee', employeeId); await page.click('#channel-default-form button')
    await page.wait('document.querySelector(' + JSON.stringify('#channel-default-employee option[value="' + employeeId + '"]') + ')?.defaultSelected && document.querySelector("#admin-message")?.innerText.includes("渠道默认员工已保存，既有对话保持原员工")')
    await poll(async () => (await api('admin', '/api/admin/channel-defaults')).defaultChannelEmployeeId === employeeId, 'global channel default')
  }
  function instance(actor) { return fixture.instances.find(value => value.instance === actor) }
  function fixtureRecord(actor) { return instance(actor).records.find(value => value.recordType === 'repair') }
  function pairFor(actor, provider) { return pairs.find(pair => pair.actor === actor && pair.provider === provider) }
  async function identityFor(pair) { const value = (await channelState(pair.actor)).identities.find(identity => identity.id === refs[pair.key]?.identityId); assert(value, 'owner identity missing'); return value }
  async function activePointers() { const values = await Promise.all(pairs.map(async pair => [pair.key, (await identityFor(pair)).activeConversationId])); return Object.fromEntries(values) }
  async function conversation(actor, id) { return api(actor, '/api/conversations/' + encodeURIComponent(id)) }
  async function openConversation(page, id) {
    await reload(page, 'conversations'); await page.click('#reload-conversations')
    await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-open-conversation="' + id + '"]') + '))'); await page.click('[data-open-conversation="' + id + '"]')
    await page.wait('document.querySelector("#conversation-detail")?.dataset.conversationId===' + JSON.stringify(id))
  }
  async function webTurn(page, id, text) {
    await openConversation(page, id)
    const before = (await conversation(page.actor, id)).turns.map(value => value.id)
    await page.fill('#conversation-text', text); await page.click('#send-conversation-turn')
    const turnId = await poll(async () => (await conversation(page.actor, id)).turns.find(value => !before.includes(value.id))?.id, 'Web turn accepted')
    const turn = await completedTurn(page.actor, id, turnId)
    await page.wait('document.querySelector(' + JSON.stringify('[data-conversation-turn="' + turnId + '"]') + ')?.innerText.includes("已回复")')
    return turn
  }
  async function completedTurn(actor, id, turnId) {
    return poll(async () => {
      const turn = (await conversation(actor, id)).turns.find(value => value.id === turnId)
      if (!turn || ['accepted', 'running'].includes(turn.status)) return false
      assert.equal(turn.status, 'completed', 'actual channel/Web model turn did not complete'); assert(turn.assistantText, 'native assistant history is empty'); return turn
    }, 'actual Flash conversation turn', 180_000)
  }
  async function completedWork(actor, id, previousResults = -1) {
    return poll(async () => {
      const work = await api(actor, '/api/works/' + encodeURIComponent(id))
      if (['accepted', 'running'].includes(work.status) || work.results.length <= previousResults) return false
      assert.equal(work.status, 'completed', 'actual Kivo work did not complete'); assert(work.executions.some(value => value.dshSessionRef), 'actual native work Session was not linked'); return work
    }, 'actual native/Kivo work completion', 180_000)
  }
  function assertTyped(work, actor) {
    const result = work.results.findLast(value => value.kind === 'kivo.tpm.observation'), expected = fixtureRecord(actor)
    assert(result, 'actual Kivo typed observation missing')
    const payload = result.payload
    assert.equal(payload.status, 'ok'); assert.equal(payload.mode, 'record'); assert.equal(payload.recordType, 'repair'); assert.equal(payload.records.length, 1)
    assert.equal(payload.records[0].id, expected.recordId); assert.equal(payload.records[0].reference, expected.reference); assert.equal(payload.records[0].rawStatus, expected.rawStatus)
    assert.equal(payload.source.sourceInstance, instance(actor).connection.sourceInstance); assert.equal(payload.source.dataMode, 'synthetic'); assert.equal(payload.source.sourceEnvironment, 'external-test')
    assert.equal(result.source.sourceInstance, payload.source.sourceInstance); assert(Number.isFinite(Date.parse(payload.queriedAt)))
    assert(payload.sources.length && payload.sources.every(value => value.traceId && value.queriedAt), 'real MCP trace/time readback missing')
  }
  async function inbound(pair, id, text, extra = {}) {
    if (pair.provider === 'feishu') return ipc(server, 'feishu-event', feishuEvent(pair.actor, id, text, extra))
    simulator.push(accounts[pair.actor].id, [weixinMessage(pair, id, text, extra)])
  }
  function weixinMessage(pair, id, text, extra = {}) {
    const account = accounts[pair.actor], sequence = ++messageSequence
    return { message_id: id, from_user_id: account.ownerUserId, to_user_id: account.id, message_type: 1, message_state: 2, seq: sequence, create_time_ms: 1792022400000 + sequence, context_token: 'SYNTHETIC_CONTEXT_' + options['run-id'] + '_' + id, item_list: [{ type: 1, text_item: { text } }], ...extra }
  }
  async function inboundFinished(pair, id) {
    const message = await poll(async () => { const value = (await disk()).channelMessages.find(item => item.providerMessageId === id); if (!value || value.status === 'reserved') return false; assert.equal(value.status, 'accepted', 'channel natural text rejected'); assert(value.turnId); return value }, 'actual transport durable turn admission')
    const turn = await completedTurn(pair.actor, message.memberConversationId, message.turnId)
    await poll(async () => (await disk()).deliveries.some(value => value.sourceRef?.turnId === turn.id && value.status === 'delivered'), 'actual channel feedback', 30_000)
    return turn
  }
  async function explicitReply(page, conversationId, turnId, status = 'delivered') {
    await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-reply-conversation-turn="' + turnId + '"]') + '))')
    await page.click('[data-reply-conversation-turn="' + turnId + '"]')
    const delivery = await poll(async () => (await disk()).deliveries.find(value => value.sourceRef?.conversationId === conversationId && value.sourceRef.turnId === turnId && value.status === status), 'explicit channel reply ' + status, 30_000)
    await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-delivery="' + delivery.id + '"]') + '))')
    return delivery
  }
  async function sendCount(pair) {
    if (pair.provider === 'weixin') return simulator.calls.filter(value => value.botId === accounts[pair.actor].id && value.endpoint.endsWith('/sendmessage')).length
    return (await ipc(server, 'snapshot')).sent.filter(value => value.data.receive_id === 'chat-' + pair.actor).length
  }
  async function assertOwnTarget(pair) {
    if (pair.provider === 'weixin') assert(simulator.calls.filter(value => value.botId === accounts[pair.actor].id && value.endpoint.endsWith('/sendmessage')).every(value => value.toUserId === accounts[pair.actor].ownerUserId))
    else assert((await ipc(server, 'snapshot')).sent.every(value => ['chat-a', 'chat-b'].includes(value.data.receive_id)), 'private result targeted a foreign/group conversation')
  }
  async function businessCounts() {
    const state = await disk()
    return { conversations: state.conversations.length, turns: state.conversations.reduce((count, value) => count + value.turns.length, 0), works: state.works.length, executions: state.works.reduce((count, value) => count + value.executions.length, 0) }
  }
  async function assertContext(label, expected) {
    const rows = (await jsonLines(contextFile)).filter(value => value.labels.includes(label))
    assert(rows.length, 'no actual Host model request observed for ' + label)
    for (const row of rows) { assert.equal(row.model, model); for (const pair of pairs) assert.equal(row.canaries[pair.key], expected[pair.key] ?? false, label + ' leaked/reused context: ' + pair.key) }
  }

  async function deliveryOutcomes() {
    await step('delivery-outcomes', 'a', '失败可明确重试，未知和分段进展不盲重发', async page => {
      const feishu = pairFor('a', 'feishu'), wx = pairFor('a', 'weixin'), feishuRef = refs[feishu.key], wxRef = refs[wx.key]
      const turn = await webTurn(page, feishuRef.originalConversation, 'P4_FEISHU_FAILURE 请用一句话说明工作结果已经保存在Web，不运行新工作。')
      await ipc(server, 'feishu-send-response', { code: 403 })
      const failed = await explicitReply(page, feishuRef.originalConversation, turn.id, 'failed'), baseline = await businessCounts()
      await capture(page, '飞书明确失败，显示本人可重试的发送状态')
      await page.click('#view-conversations.active [data-delivery="' + failed.id + '"] [data-retry-delivery="' + failed.id + '"]')
      await poll(async () => (await disk()).deliveries.find(value => value.id === failed.id)?.status === 'delivered', 'explicit known-failure retry')
      assert.deepEqual(await businessCounts(), baseline, 'retry reran model/business')
      await page.wait('document.querySelector(' + JSON.stringify('[data-delivery="' + failed.id + '"]') + ')?.innerText.includes("已发送")'); await capture(page, '明确重试后已发送，员工和工作没有重跑')
      const long = await webTurn(page, wxRef.originalConversation, 'P4_WEIXIN_LONG 为离线培训写至少2600个汉字的连贯说明，讲解如何清楚记录和核对工作进展；不调用工作工具，不省略正文。')
      assert(long.assistantText.length > 1800, 'actual model reply is too short to test real iLink segmentation')
      simulator.queueSend(accounts.a.id, { ret: 0 }, { drop: true })
      const unknown = await explicitReply(page, wxRef.originalConversation, long.id, 'unknown')
      assert.equal(unknown.sendProgress.acknowledgedParts.length, 1); assert(unknown.sendProgress.totalParts > 1)
      const count = await sendCount(wx), counts = await businessCounts()
      await denied('a', '/api/channels/deliveries/' + unknown.id + '/retry', 'POST', {}, [409])
      assert.equal(await page.evaluate('Boolean(document.querySelector(' + JSON.stringify('[data-retry-delivery="' + unknown.id + '"]') + '))'), false)
      await pause(1500); assert.equal(await sendCount(wx), count, 'unknown delivery was blindly resent'); assert.deepEqual(await businessCounts(), counts)
      for (const [name, response] of [['context-expired', { ret: 0, errcode: 400, errmsg: 'context_expired' }], ['platform-refused', { ret: 403 }]]) {
        simulator.queueSend(accounts.a.id, response)
        const result = await api('a', '/api/channels/deliveries', 'POST', { requestId: options['run-id'] + '-' + name, identityId: wxRef.identityId, conversationId: wxRef.originalConversation, turnId: long.id })
        assert.equal(result.delivery.status, 'failed', name + ' was not reported accurately')
      }
      assert.deepEqual(await businessCounts(), counts)
      refs.unknownDelivery = unknown.id; facts.push({ kind: 'delivery-outcomes', failedThenRetried: failed.id, unknown: unknown.id, acknowledgedParts: 1, totalParts: unknown.sendProgress.totalParts, businessReruns: 0 })
      await page.click('#refresh-conversation')
    }, '已知失败经本人操作重试且不重跑业务；分段未知保留已确认部分、拒绝重试；上下文过期和平台拒发显示失败。')
  }

  async function authorization() {
    await step('authorization', 'a', '生成后撤权，首次发送与重试均零平台调用', async page => {
      const pair = pairFor('a', 'weixin'), ref = refs[pair.key], turn = await webTurn(page, ref.originalConversation, 'P4_AUTHORIZATION 请用一句话说明回复会在发送时核对当前授权，不运行工作。')
      const before = await sendCount(pair), baseline = await businessCounts()
      await editAgent(agents.a, false)
      const requestId = options['run-id'] + '-revoked'
      const result = await request('a', '/api/channels/deliveries', 'POST', { requestId, identityId: ref.identityId, conversationId: ref.originalConversation, turnId: turn.id })
      const delivery = blockedDelivery(result, (await disk()).deliveries, requestId)
      assert.equal((await channelState('a')).deliveries.find(value => value.id === delivery.id)?.status, 'blocked'); assert.equal(await sendCount(pair), before)
      const retry = await request('a', '/api/channels/deliveries/' + delivery.id + '/retry', 'POST', {})
      assert.equal(blockedDelivery(retry, (await disk()).deliveries, requestId).id, delivery.id)
      assert.equal(await sendCount(pair), before); assert.deepEqual(await businessCounts(), baseline)
      await page.front(); await page.click('#refresh-conversation'); await page.wait('document.querySelector("#conversation-read-only")?.innerText.includes("员工")'); await capture(page, '生成后员工停用，待发送回复被阻断')
      await editAgent(agents.a, true)
      await pause(1500); assert.equal(await sendCount(pair), before, 'restoring Agent permission auto-sent an old delivery')
      await openConversation(page, ref.originalConversation)
      await page.click('#view-conversations.active [data-delivery="' + delivery.id + '"] [data-retry-delivery="' + delivery.id + '"]')
      await poll(async () => (await disk()).deliveries.find(value => value.id === delivery.id)?.status === 'delivered', 'explicit retry after restored current permission')
      assert.deepEqual(await businessCounts(), baseline)
      const memberPair = pairFor('b', 'feishu'), memberRef = refs[memberPair.key], memberPage = browsers.b
      const generated = await webTurn(memberPage, memberRef.originalConversation, 'P4_MEMBER_REVOKE 请用一句话说明权限失效后应回到Web重新确认，不执行工作。')
      const beforeMember = await sendCount(memberPair), beforeBusiness = await businessCounts()
      await editMember('b', false)
      await denied('b', '/api/channels/deliveries', 'POST', { requestId: options['run-id'] + '-member-revoked', identityId: memberRef.identityId, conversationId: memberRef.originalConversation, turnId: generated.id }, [401, 403])
      await inbound(memberPair, 'member-disabled-inbound', '停用成员不能继续执行。')
      await poll(async () => (await disk()).channelMessages.some(value => value.providerMessageId === 'member-disabled-inbound' && value.status === 'rejected'), 'disabled member durable inbound denial')
      assert.equal(await sendCount(memberPair), beforeMember); assert.deepEqual(await businessCounts(), beforeBusiness)
      await editMember('b', true); await login('b')
      await memberPage.front()
      const timeOrigin = await memberPage.evaluate('performance.timeOrigin')
      await memberPage.send('Page.reload'); await memberPage.wait('performance.timeOrigin !== ' + timeOrigin + ' && Boolean(document.querySelector("#login-name")) && !document.querySelector("#login-shell")?.classList.contains("hidden")')
      await memberPage.fill('#login-name', 'b'); await memberPage.fill('#login-password', passwords.b); await memberPage.click('#login-button'); await memberPage.wait('!document.querySelector("#app")?.classList.contains("hidden")')
      await pause(1200); assert.equal(await sendCount(memberPair), beforeMember, 'restoring member auto-sent old content')
      await page.front(); await page.click('#refresh-conversation')
      facts.push({ kind: 'send-time-authorization', deliveryId: delivery.id, firstSendPlatformCalls: 0, revokedRetryPlatformCalls: 0, restoredAutomaticallySent: false })
    }, '回复生成后停用员工会阻断首次发送及重试，平台调用数保持不变；恢复权限后仍须本人明确重试。')
  }
  async function editAgent(id, enabled) {
    const page = browsers.admin, form = 'form[data-kind="employee"][data-id="' + id + '"]'
    await page.front(); await page.nav('admin'); await page.click('#tab-employees'); await page.check(form + ' [name="enabled"]', enabled); await page.click(form + ' button.primary')
    await page.wait('document.querySelector("#admin-message")?.innerText.includes("配置已保存并从服务端回读")')
    await poll(async () => (await api('admin', '/api/admin/employees')).find(value => value.id === id)?.enabled === enabled, 'Agent enablement change')
  }
  async function editMember(id, enabled) {
    const page = browsers.admin, form = 'form[data-kind="member"][data-id="' + id + '"]'
    await page.front(); await page.nav('admin'); await page.click('#tab-members'); await page.check(form + ' [name="enabled"]', enabled); await page.click(form + ' button.primary')
    await page.wait('document.querySelector("#admin-message")?.innerText.includes("配置已保存并从服务端回读")')
    await poll(async () => (await api('admin', '/api/admin/members')).find(value => value.id === id)?.enabled === enabled, 'member enablement change')
  }

  async function unlinkAndRebind() {
    await step('unlink-and-rebind', 'a', '账号失效、解绑与晚到扫码不会复活旧身份', async page => {
      const stale = pairFor('b', 'weixin'), staleRef = refs[stale.key]
      simulator.queuePoll(accounts.b.id, { ret: -14 })
      await poll(async () => (await identityFor(stale)).status === 'rebind-required', 'actual stale iLink token requires rebinding')
      await poll(() => simulator.activePolls(accounts.b.id) === 0, 'stale iLink polling stops')
      const polls = pollCount('b'); await pause(1400); assert.equal(pollCount('b'), polls, 'invalidated account reconnected automatically')
      assert.equal((await identityFor(stale)).id, staleRef.identityId)
      const pair = pairFor('a', 'weixin'), old = refs[pair.key], before = await sendCount(pair)
      await page.viewport(390, 844); await refreshChannels(page); await page.click('[data-unlink="' + old.identityId + '"]')
      await poll(async () => (await channelState('a')).identities.find(value => value.id === old.identityId)?.status === 'unlinked', 'owner unlinks iLink identity')
      await poll(() => simulator.activePolls(accounts.a.id) === 0, 'unlinked iLink polling stops')
      await page.wait('document.querySelector(' + JSON.stringify('[data-channel-identity="' + old.identityId + '"]') + ')?.querySelector(".record-title .pill")?.innerText === "已解绑" && document.querySelector(' + JSON.stringify('[data-begin-weixin-binding="' + appIds.weixin + '"]') + ')?.disabled === false')
      const business = await businessCounts()
      await inbound(pair, 'after-unlink', '解绑后不应执行，也不应重放旧消息。'); await pause(1300)
      assert.deepEqual(await businessCounts(), business); assert.equal(await sendCount(pair), before)
      await denied('a', '/api/channels/identities/' + old.identityId + '/conversations', 'POST', {}, [400, 403, 404, 409])

      const links = (await channelState('a')).linkCodes.map(value => value.id), qrPolls = simulator.calls.filter(value => value.endpoint.endsWith('/get_qrcode_status')).length
      simulator.queueLogin({ value: simulator.confirmedLogin(accounts.a.id), delayMs: 900 })
      await page.click('[data-begin-weixin-binding="' + appIds.weixin + '"]')
      const pending = await poll(async () => (await channelState('a')).linkCodes.find(value => !links.includes(value.id)), 'new cancellable QR binding')
      await poll(() => simulator.calls.filter(value => value.endpoint.endsWith('/get_qrcode_status')).length > qrPolls, 'actual QR poll enters delayed login')
      await page.wait('Boolean(document.querySelector(' + JSON.stringify('[data-cancel-weixin-binding="' + pending.id + '"]') + '))'); await page.click('[data-cancel-weixin-binding="' + pending.id + '"]')
      await poll(async () => (await channelState('a')).linkCodes.find(value => value.id === pending.id)?.status === 'cancelled', 'owner cancellation persisted')
      await pause(1100)
      assert(!(await channelState('a')).identities.some(value => value.channelAppId === appIds.weixin && value.status === 'active'), 'late QR result activated a cancelled binding')
      refs[pair.key] = await bind(pair, page)
      assert.notEqual(refs[pair.key].identityId, old.identityId); assert.notEqual(refs[pair.key].originalConversation, old.originalConversation)
      refs.unlinkedIdentityId = old.identityId
      await inbound(pair, 'P4_REBOUND_A_WEIXIN', 'P4_REBOUND_A_WEIXIN 这是新绑定后的第一条消息，请用一句话介绍，不读取历史。')
      await inboundFinished(pair, 'P4_REBOUND_A_WEIXIN'); await assertContext('P4_REBOUND_A_WEIXIN', {})
      assert.equal((await channelState('a')).identities.find(value => value.id === old.identityId).status, 'unlinked')
      assert.equal((await disk()).deliveries.find(value => value.id === refs.unknownDelivery).status, 'unknown')
      await refreshChannels(page)
      facts.push({ kind: 'identity-lifecycle', invalidatedIdentity: staleRef.identityId, unlinkedIdentity: old.identityId, reboundIdentity: refs[pair.key].identityId, cancelledBinding: pending.id })
    }, '失效和解绑立即停止轮询与投递；取消后的晚到扫码不能激活。重绑使用新身份和空白会话，旧 unknown 不重发。')
  }
  function pollCount(actor) { return simulator.calls.filter(value => value.botId === accounts[actor].id && value.endpoint.endsWith('/getupdates')).length }

  async function restartAndRestore() {
    await step('restart-and-restore', 'a', '手机停止、正常重启与受限备份恢复', async page => {
      await page.viewport(390, 844)
      const id = (await identityFor(pairFor('a', 'feishu'))).activeConversationId
      await openConversation(page, id)
      const before = (await conversation('a', id)).turns.map(value => value.id), worksBefore = (await disk()).works.map(value => ({ id: value.id, status: value.status, results: value.results }))
      await page.fill('#conversation-text', 'P4_MOBILE_STOP 请写四千字的工作记录培训材料，不调用工作工具。'); await page.click('#send-conversation-turn')
      const turn = await poll(async () => (await conversation('a', id)).turns.find(value => !before.includes(value.id) && ['accepted', 'running'].includes(value.status)), 'mobile active conversation turn')
      await page.wait('document.querySelector("#stop-conversation-turn")?.disabled===false'); await page.click('#stop-conversation-turn')
      await poll(async () => (await conversation('a', id)).turns.find(value => value.id === turn.id)?.status === 'cancelled', 'mobile stop selected turn')
      assert.deepEqual((await disk()).works.map(value => ({ id: value.id, status: value.status, results: value.results })), worksBefore)
      await capture(page, '手机停止当前回复，已保存工作保持原状态')

      const baseline = await disk(), business = await businessCounts(), counts = { wx: await sendCount(pairFor('a', 'weixin')), model: modelRequests(await jsonLines(auditFile)), kivo: kivoRequests(await jsonLines(auditFile), fixture).length }
      hosts.push(await ipc(server, 'snapshot')); restarting = true; await stopGroup(server); server = await boot(); restarting = false
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await pause(1300)
      assert.deepEqual(await businessCounts(), business, 'normal startup replayed a business turn/work')
      assert.equal(modelRequests(await jsonLines(auditFile)), counts.model, 'normal startup replayed a model request')
      assert.equal(kivoRequests(await jsonLines(auditFile), fixture).length, counts.kivo, 'normal startup replayed a Kivo request')
      assert.equal(await sendCount(pairFor('a', 'weixin')), counts.wx)
      assert.equal((await ipc(server, 'snapshot')).sent.length, 0, 'normal startup replayed a Feishu delivery')
      assert.deepEqual((await disk()).conversations.map(value => ({ id: value.id, sessions: value.sessions, turns: value.turns.map(turn => ({ id: turn.id, status: turn.status })) })), baseline.conversations.map(value => ({ id: value.id, sessions: value.sessions, turns: value.turns.map(turn => ({ id: turn.id, status: turn.status })) })))
      await openConversation(page, refs['a-weixin'].originalConversation); await page.wait('document.querySelector("#conversation-history-status")?.innerText.includes("历史已读取")')
      await capture(page, '正常重启后本人原生历史可回读，无模型或渠道重放')
      hosts.push(await ipc(server, 'snapshot')); restarting = true; await stopGroup(server)

      const backup = join(scratch, 'backup'), privateBackup = join(scratch, 'private-backup'), restored = join(scratch, 'restored'), restoredSecrets = join(scratch, 'restored-secrets')
      const backupResult = await transfer(['backup', '--output', backup, '--secret-output', privateBackup, '--secret-root', secretRoot])
      const ordinary = await readFile(join(backup, 'state.json'), 'utf8'), manifest = await readFile(join(backup, 'manifest.json'), 'utf8')
      assert(!/SYNTHETIC_TOKEN_|SYNTHETIC_CONTEXT_|BEGIN (?:RSA )?PRIVATE KEY|bot_token|context_token/.test(ordinary + manifest), 'ordinary backup leaked a secret body')
      assert((await lstat(privateBackup)).isDirectory() && ((await lstat(privateBackup)).mode & 0o777) === 0o700)
      const restoredResult = await transfer(['restore', '--input', backup, '--data-root', restored, '--secret-input', privateBackup, '--secret-root', restoredSecrets])
      const beforeRestore = await disk()
      stateFile = join(restored, 'state.json'); dshHome = join(restored, 'dsh'); secretRoot = restoredSecrets
      const restoredState = await disk()
      assert(restoredState.channelApps.every(value => !value.enabled && value.status === 'disabled'))
      assert.equal(restoredState.channelIdentities.find(value => value.id === refs.unlinkedIdentityId).status, 'unlinked')
      assert.equal(restoredState.deliveries.find(value => value.id === refs.unknownDelivery).status, 'unknown')
      for (const work of beforeRestore.works) assert.deepEqual(restoredState.works.find(value => value.id === work.id).results, work.results, 'restoration changed saved business facts')
      const pollBaseline = ['a', 'b'].map(pollCount), sends = ['a', 'b'].map(actor => simulator.calls.filter(value => value.botId === accounts[actor].id && value.endpoint.endsWith('/sendmessage')).length)
      server = await boot(false); restarting = false
      for (const actor of ['admin', 'a', 'b']) await login(actor)
      await pause(1400)
      assert.deepEqual(['a', 'b'].map(pollCount), pollBaseline, 'restore reopened a closed external poller')
      assert.deepEqual(['a', 'b'].map(actor => simulator.calls.filter(value => value.botId === accounts[actor].id && value.endpoint.endsWith('/sendmessage')).length), sends, 'restore resent an iLink delivery')
      assert.equal((await ipc(server, 'snapshot')).sent.length, 0, 'restore resent a Feishu delivery')
      assert.deepEqual(await businessCounts(), business, 'restore automatically executed a business message')
      assert.equal(modelRequests(await jsonLines(auditFile)), counts.model, 'restore replayed a model request')
      assert.equal(kivoRequests(await jsonLines(auditFile), fixture).length, counts.kivo, 'restore replayed a Kivo request')
      await openConversation(page, refs['a-weixin'].originalConversation)
      await page.wait('document.querySelector("#conversation-history-status")?.innerText.includes("历史已读取")')
      await refreshChannels(page); await page.wait('document.querySelector("#channel-list")?.innerText.includes("暂不可用")')
      assert.equal(await page.evaluate('Boolean(document.querySelector("[data-unlink]:not([disabled])"))'), true, 'maintenance disappeared when transports disabled')
      facts.push({ kind: 'backup-restore', backup: backupResult, restore: restoredResult, nativeHistoryReadable: true, externalIntakeDisabled: true, automaticBusinessExecutions: 0, automaticResends: 0, oldUnlinkedIdentityRevived: false })
    }, '390×844 可停止选定回复而不误停工作；正常重启保留原生历史。普通备份不含秘密，受限秘密单独配对；恢复后渠道关闭、旧身份不复活、业务与投递不重放。')
  }
  async function transfer(args) {
    const child = launch(process.execPath, [join(root, 'scripts/state-transfer.mjs'), ...args], { env: { ...systemEnvironment(), GENEWAY_STATE: stateFile, GENEWAY_DSH_HOME: dshHome, GENEWAY_MODEL_CREDENTIAL_REF: options['model-ref'] }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk; assert(output.length < 32_000, 'unexpected transfer output') })
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)) })
    assert.equal(code, 0, 'actual state-transfer command failed')
    return JSON.parse(output.trim())
  }
  async function capture(page, title) {
    await page.front(); await pause(400)
    const value = steps.at(-1), shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), file = 'step-' + String(steps.length).padStart(2, '0') + '-' + (value.screenshots.length + 1) + '.png'
    await writeFile(join(options.output, file), Buffer.from(shot.data, 'base64'), { mode: 0o600 }); value.screenshots.push({ file, image: shot.data, label: title, seconds: (Date.now() - recordingAt) / 1000 })
  }
  async function step(id, actor, title, action, expected) {
    abort.signal.throwIfAborted(); recording.assertRunning()
    const page = browsers[actor], value = { id, actor, title, action: title, control: stepControl(id), expected, result: 'running', screenshots: [], startSeconds: (Date.now() - recordingAt) / 1000 }
    steps.push(value); await page.front(); await writeFile(caption, String(steps.length) + '. ' + title + '；渠道为模拟验收', { mode: 0o600 }); await pause(400)
    try { await action(page); await page.noOverflow(); recording.assertRunning(); value.result = 'passed'; value.observed = expected }
    catch (error) { value.result = 'failed'; value.observed = safeFailure(error); throw error }
    finally {
      await pause(700)
      try { await capture(page, title) }
      catch (error) { value.result = 'failed'; value.observed = '截图未生成：' + safeFailure(error); throw error }
      finally { value.endSeconds = (Date.now() - recordingAt) / 1000 }
    }
  }
}

async function ipc(child, method, input) {
  assert(child.connected && child.exitCode === null && child.signalCode === null, 'owned acceptance Host IPC is closed')
  const id = randomBytes(12).toString('hex')
  return new Promise((resolveReply, reject) => {
    const finish = error => { clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit); error ? reject(error) : undefined }
    const onMessage = message => { if (message?.kind === 'channel-acceptance' && message.id === id) { finish(); message.ok ? resolveReply(message.value) : reject(new Error(message.error)) } }
    const onExit = () => finish(new Error('acceptance Host exited during transport request'))
    const timer = setTimeout(() => finish(new Error('acceptance transport IPC timeout')), 20_000)
    child.on('message', onMessage); child.once('exit', onExit); child.send({ kind: 'channel-acceptance', id, method, input }, error => { if (error) finish(error) })
  })
}
async function stopGroup(child, signal) {
  const request = child?.hostDiagnostics?.stopRequested(signal ?? 'SIGTERM')
  await stop(child, signal)
  child?.hostDiagnostics?.stopReturned(request, child.auditInterruption)
  if (!Number.isInteger(child?.pid)) return
  const remains = () => { try { process.kill(-child.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  if (remains()) {
    const fallback = child.hostDiagnostics?.stopRequested('SIGKILL', 'owned-group-residue')
    try { const delivered = process.kill(-child.pid, 'SIGKILL'); child.hostDiagnostics?.stopReturned(fallback, { signalDelivered: delivered }) }
    catch (error) { child.hostDiagnostics?.stopReturned(fallback, { signalDelivered: false, errorCode: error.code }); throw error }
    await poll(() => !remains(), 'owned process group exit', 10_000)
  }
  if (child.hostDiagnostics) await poll(() => child.hostDiagnostics.closed, 'owned Host stderr close', 10_000)
}
function captureHostDiagnostics(child, directory, binding, onFailure, now = Date.now) {
  if (!Number.isInteger(child?.pid)) return
  assert.equal(child.auditRole, 'host')
  const raw = join(directory, 'host-' + child.pid + '.stderr'), metadata = join(directory, 'host-' + child.pid + '.json'), limit = 8 * 1024 * 1024
  const state = { ...binding, pid: child.pid, processGroupId: child.pid, startedAt: now(), limitBytes: limit, bytesObserved: 0, bytesSaved: 0, truncated: false, stopRequests: [], observedExitAt: null, exitCode: null, exitSignal: null, closedAt: null }
  let fd, failed = false
  const persist = () => writeFileSync(metadata, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  const failure = () => { if (!failed) { failed = true; state.ioFailed = true; onFailure(new Error('private Host diagnostics I/O failed')) } }
  try {
    fd = openSync(raw, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(metadata, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch { if (fd !== undefined) closeSync(fd); throw new Error('private Host diagnostics initialization failed') }
  child.once('exit', (code, signal) => { Object.assign(state, { observedExitAt: now(), exitCode: code, exitSignal: signal }); try { persist() } catch { failure() } })
  child.once('close', () => { state.closedAt = now(); try { closeSync(fd) } catch { failure() } try { persist() } catch { failure() } })
  return {
    get closed() { return state.closedAt !== null },
    stderr(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), remaining = limit - state.bytesSaved
      state.bytesObserved += bytes.length; state.truncated ||= state.bytesObserved > limit
      if (!failed) { try { const saved = bytes.subarray(0, Math.max(0, remaining)); if (saved.length) appendFileSync(fd, saved); state.bytesSaved += saved.length; persist() } catch { failure() } }
    },
    stopRequested(signal, reason = 'shared-stop') {
      const request = { stopRequestedAt: now(), requestedSignal: signal, reason, wasAliveWhenRequested: child.exitCode === null && child.signalCode === null, signalDelivered: null }
      state.stopRequests.push(request); try { persist() } catch { failure() }; return request
    },
    stopReturned(request, evidence) {
      if (!request) return
      Object.assign(request, { returnedAt: now(), signalDelivered: typeof evidence?.signalDelivered === 'boolean' ? evidence.signalDelivered : null, observedEscalation: request.requestedSignal !== 'SIGKILL' && child.signalCode === 'SIGKILL' })
      if (evidence?.errorCode) request.errorCode = String(evidence.errorCode).replace(/[^A-Z0-9_]/g, '').slice(0, 80)
      try { persist() } catch { failure() }
    },
  }
}
async function assertStopped(children, authFile) {
  for (const child of children) if (child.pid) for (const pid of [child.pid, -child.pid]) {
    try { process.kill(pid, 0); assert.fail('owned acceptance process/group remains alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await assert.rejects(access(authFile), { code: 'ENOENT' })
}

function feishuEvent(actor, id, text, extra = {}) {
  const { sender_type = 'user', ...message } = extra
  return { schema: '2.0', header: { event_id: 'event-' + id, event_type: 'im.message.receive_v1', app_id: providerAppId, tenant_key: tenant, create_time: '1792022400000' },
    event: { sender: { sender_id: { open_id: 'open-' + actor }, sender_type, tenant_key: tenant }, message: { message_id: id, chat_id: 'chat-' + actor, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: '1792022400000', ...message } },
  }
}
function label(provider) { return provider === 'weixin' ? '微信' : '飞书' }
function kivoRequests(rows, fixture) {
  return rows.filter(row => row.kind === 'fetch' && row.path === '/api/v1/mes/mcp' && fixture.instances.some(instance => { const url = new URL(instance.connection.baseUrl); return row.host === url.hostname && Number(row.port) === Number(url.port || 80) }))
}
function modelRequests(rows) { return rows.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai').length }
function blockedDelivery(response, deliveries, requestId) {
  assert.equal(response.status, 403, 'revoked delivery must return HTTP 403')
  assert.equal(response.body?.error?.code, 'DELIVERY_FORBIDDEN', 'revoked delivery must preserve its error code')
  const matched = deliveries.filter(value => value.requestId === requestId)
  assert.equal(matched.length, 1, 'revoked request must identify exactly one persisted delivery')
  assert.equal(matched[0].status, 'blocked'); assert.equal(matched[0].error?.code, 'DELIVERY_FORBIDDEN')
  return matched[0]
}
function stepControl(id) {
  if (id === 'agents') return '管理配置 → 连接 → 测试连接；员工 → 创建员工；渠道应用 → 渠道默认员工'
  if (id.startsWith('bind-')) return '我的渠道 → ' + (id.endsWith('weixin') ? '微信扫码绑定 → 确认本人身份' : '生成一次性关联码 → 私聊机器人 → 确认本人身份')
  if (id.startsWith('work-')) return '渠道私聊交办 → 精确补充工作 → 我的对话 → 关联工作 → 追问 → 回复原渠道'
  if (id.startsWith('rotate-')) return '渠道发送“新会话” → 我的渠道 → 本人历史对话'
  return {
    'old-web-replies': '我的对话 → 历史对话 → 发送 → 已完成回复下的“回复原渠道”',
    'channel-default': '管理配置 → 渠道默认员工；我的渠道 → 选择员工 → 按所选员工开启新会话',
    'isolation-and-replay': '本人登录及已知对象的接口权限检查；模拟渠道重投、非主人、非文本和群 @',
    'delivery-outcomes': '我的对话 → 已完成回复 → 回复原渠道；发送失败 → 重试',
    authorization: '管理配置 → 员工或成员启用状态；已完成回复 → 本人明确发送或重试',
    'unlink-and-rebind': '我的渠道 → 解绑；微信扫码绑定 → 取消绑定或确认本人身份',
    'restart-and-restore': '手机我的对话 → 停止本次回复；隔离实例备份恢复 → 本人历史与我的渠道',
  }[id]
}
function manual(report) {
  const complete = report.ok ? '本轮所列操作与自动检查通过。' : '本轮未通过：' + esc(report.failure ?? '必需旅程尚未完成') + '。'
  const cleanup = report.cleanup.ownedGroupsExited === true && report.cleanup.authRemoved === true && report.cleanup.simulatorClosed === true ? '本轮隔离服务和模拟器已关闭，临时登录凭据已删除。' : '本轮隔离资源清理尚未全部确认，请先查看实际检查记录。'
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>多渠道交办与会话操作说明</title><style>body{max-width:1080px;margin:32px auto;padding:0 24px;font:17px/1.7 system-ui;color:#172033;background:#f5f7fb}section{background:#fff;padding:24px;margin:24px 0;border:1px solid #dce2ed;border-radius:12px}img,video{max-width:100%;height:auto}.failed{border-color:#c34d31;background:#fff3ee}code{overflow-wrap:anywhere}figcaption,small{color:#4b5563}a{color:#165ea8}</style><h1>多渠道交办与会话操作说明</h1><p>' + esc(report.scope) + '</p><p>' + complete + '模型：ZenMux ' + esc(model) + '。候选：<code>' + esc(report.candidate.preflight.head) + '</code>。</p><p>适用角色为管理员与隔离验收成员 A、B。开始前由维护者准备本轮独立账号、已授权员工及两个 synthetic Kivo 只读连接；飞书和微信均为模拟渠道，不涉及真实成员账号。管理员维护配置，成员从本人登录入口完成绑定、交办、补充与回复。</p><p>' + cleanup + '</p>' +
    (report.media.video ? '<p><a href="p4-channels.mp4">完整操作视频</a> · <a href="observations.json">实际检查记录</a></p><video controls preload="metadata" src="p4-channels.mp4"></video>' : '<p>本轮尚未取得完整可交付的视频。已完成与失败步骤如下；请先解决可见差异，再重新验收。</p>') +
    report.steps.map((step, index) => '<section class="' + (step.result === 'passed' ? '' : 'failed') + '"><h2>' + (index + 1) + '. ' + esc(step.title) + '</h2><p><b>角色：</b>' + (step.actor === 'admin' ? '管理员' : '成员 ' + esc(step.actor.toUpperCase())) + '。<b>入口：</b>' + esc(step.control) + '。</p><p><b>操作：</b>' + esc(step.action) + '。</p><p><b>' + (step.result === 'passed' ? '确认结果：' : '实际差异：') + '</b>' + esc(step.observed ?? '本步未取得结果') + '</p>' + step.screenshots.map(shot => '<figure><img src="data:image/png;base64,' + shot.image + '" alt="' + esc(shot.label) + '"><figcaption>' + esc(shot.label) + '</figcaption></figure>').join('') + '<p>对应视频 ' + Math.floor(step.startSeconds) + '–' + Math.ceil(step.endSeconds ?? step.startSeconds) + ' 秒。</p></section>').join('') +
    '<section><h2>发送失败与恢复</h2><p>已知失败先查看原因，修复当前权限或连接后再明确重试。消息重试只发送已保存内容，不重新执行工作。“待核对”表示平台效果未知，不重复发送；微信已确认的分段保持原进展。解绑或账号失效后须本人重新绑定，新身份使用新的会话。恢复备份默认关闭渠道，先核对归属和凭据，再重新启用或绑定；旧投递与未完成入站不会自动重放。</p><p>“已发送至会话”仅表示平台确认发送，不表示对方已读。复杂配置、来源核对及历史继续可在本人 Web 完成。渠道新会话、默认员工和 Web 历史对话的归属分别维护，明确回复旧对话不会切换渠道当前会话。</p></section><section><h2>记录范围</h2><p>本材料记录本次实际浏览器操作、实际渠道通道收发、原生模型执行与本地 synthetic Kivo 只读结果。网络记录关联本轮 Host 与其官方 SDK 子进程，覆盖选定 Node 网络和启动 API；不代表整台机器或其他进程。完整 P4 还须结合 Kivo、S1 及独立审查的同候选结果，本材料不替代用户最终验收。</p></section></html>'
}

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true })
  assert.throws(() => argumentsFor(['--harness-check', '--http-only']), /Unknown option/)
  assert.throws(() => argumentsFor(['--harness-check', '--fixture', '/tmp/fixture']), /require --run/)
  assert.throws(() => argumentsFor(['--run']), /required/)
  const args = ['--run', '--output', '/tmp/channel-output', '--fixture', '/tmp/fixture.json', '--catalog', '/tmp/catalog.json', '--candidate', '/tmp/candidate.json', '--secret-root', '/tmp/channel-secrets', '--model-ref', 'ZENMUX_API_KEY', '--expected-head', 'a'.repeat(40), '--network-guard', '/tmp/guard.mjs', '--guard-sha256', 'b'.repeat(64), '--run-id', 'pure-harness-check']
  assert.equal(argumentsFor(args)['model-ref'], 'ZENMUX_API_KEY')
  assert.throws(() => argumentsFor(args.map(value => value === '/tmp/channel-output' ? join(root, 'var/check') : value)), /outside/)
  assert.throws(() => argumentsFor(args.map(value => value === 'ZENMUX_API_KEY' ? '../model.key' : value)), /ref/)
  assert.throws(() => argumentsFor(args.map(value => value === 'ZENMUX_API_KEY' ? 'other-model.key' : value)), /route ref/)
  await revokedDeliveryCheck()
  await interruptedReportCheck()
  await forceStopCallerCheck()
  await entryPauseCheck()
  await reloadDocumentChecks()
  await adminMutationChecks()
  await unlinkRenderChecks()
  await feishuBindingCodeChecks()
  await rotationHistoryChecks()
  await hostDiagnosticsCheck()
  await retryScopeChecks()
  const fixture = syntheticFixture(), catalog = { version: 1, targets: fixture.instances.map(value => Object.fromEntries(connectionFields.map(key => [key, value.connection[key]]))) }
  assert.equal(validateFixture(fixture, catalog), fixture)
  const rows = [
    { kind: 'fetch', host: '127.0.0.1', port: 39000, path: '/api/v1/mes/mcp' },
    { kind: 'fetch', host: '127.0.0.1', port: 39001, path: '/api/v1/mes/mcp' },
    { kind: 'fetch', host: '127.0.0.1', port: 39000, path: 'other' },
    { kind: 'fetch', host: 'zenmux.ai', port: 443, path: '/api/v1/mes/mcp' },
  ]
  assert.equal(kivoRequests(rows, fixture).length, 2); assert.equal(kivoRequests(rows, { instances: [fixture.instances[0]] }).length, 1)
  const wrong = structuredClone(fixture); wrong.instances[1].connection.baseUrl = wrong.instances[0].connection.baseUrl
  assert.throws(() => validateFixture(wrong, catalog))
  assert.throws(() => validateFixture({ ...fixture, dataMode: 'production' }, catalog))
  assert.throws(() => validateFixture({ ...fixture, accessToken: 'forbidden' }, catalog), /secret bodies/)
  const paths = ['scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'src/server.mjs', 'src/channel-service.mjs', 'src/conversation-service.mjs', 'src/collaboration-runner.mjs', 'web/index.html']
  const candidate = { files: paths.map(path => ({ path, sha256: 'a'.repeat(64) })) }
  assert.equal(validateCandidate(candidate).length, paths.length)
  assert.throws(() => validateCandidate({ files: candidate.files.slice(1) }), /missing/)
  assert.throws(() => validateCandidate({ files: [...candidate.files, { path: 'src/../../outside', sha256: 'a'.repeat(64) }] }))
  const completed = requiredSteps.map(id => ({ id, result: 'passed' }))
  assertComplete(completed); assert.throws(() => assertComplete(completed.slice(1)), /did not pass/)
  assert.throws(() => assertComplete(completed.map((step, index) => index ? step : { ...step, result: 'failed' })), /did not pass/)
  const canaries = Object.fromEntries(pairs.map(pair => [pair.key, pair.key + '-synthetic-marker'])), context = []
  let calls = 0
  const observed = observeContext(async () => { calls += 1; return new Response('{}') }, canaries, value => context.push(value))
  await observed('https://zenmux.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'P4_A_FEISHU_CREATE ' + canaries['a-feishu'] }], tools: [{ type: 'function', function: { name: 'geneway_work_create' } }] }) })
  assert.equal(calls, 1); assert.deepEqual(context[0].labels, ['P4_A_FEISHU_CREATE']); assert.equal(context[0].canaries['a-feishu'], true); assert.equal(context[0].canaries['b-feishu'], false)
  assert.equal(JSON.stringify(context).includes(canaries['a-feishu']), false, 'observer must only record presence flags')
  await assert.rejects(observed('https://zenmux.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'wrong', messages: [] }) }), /route/)
  await assert.rejects(observed('https://zenmux.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [], tools: [{ function: { name: 'arbitrary_write_tool' } }] }) }), /non-product/)
  const [{ createFeishuSimulator }, Lark] = await Promise.all([import('./test-p4-channel-conversations.mjs'), import('@larksuiteoapi/node-sdk')])
  const platform = createFeishuSimulator(); assert.equal(platform.dispatcher, undefined); assert.deepEqual(platform.sent, [])
  let invoked = false
  const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({ 'im.message.receive_v1': () => { invoked = true } })
  await dispatcher.invoke(feishuEvent('a', 'pure-event', 'synthetic'), { needCheck: false }); assert.equal(invoked, true)
  const client = new platform.Client(); platform.queueSend({ code: 403 }); assert.equal((await client.im.v1.message.create({ data: { receive_id: 'chat-a' } })).code, 403)
  const report = { ok: false, failure: '<script>unsafe</script>', scope: '渠道为模拟验收', candidate: { preflight: { head: 'a'.repeat(40) } }, cleanup: {}, media: {}, steps: [{ id: 'agents', actor: 'admin', title: '<script>', control: '后台', action: '创建员工', expected: '通过', observed: '<img>', result: 'failed', screenshots: [], startSeconds: 0, endSeconds: 1 }] }
  const html = manual(report)
  assert(!html.includes('<script>')); assert(html.includes('&lt;script&gt;')); assert(html.includes('渠道为模拟验收')); assert(html.includes('清理尚未全部确认')); assert(!html.includes('<video'))
  report.ok = true; report.cleanup = { ownedGroupsExited: true, authRemoved: true, simulatorClosed: true }; report.media.video = 'p4-channels.mp4'
  assert(manual(report).includes('src="p4-channels.mp4"')); assert(manual(report).includes('临时登录凭据已删除'))
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', checks: ['explicit-run-and-input-boundary', 'revoked-delivery-403-and-durable-blocked', 'interrupt-during-either-report-write-removes-pass', 'host-caller-and-forced-stop-audit-binding', 'entry-first-pause-initialized-before-top-level-await', 'reload-waits-for-new-document-and-original-login-state', 'admin-mutations-wait-for-render-completion', 'unlink-render-before-next-QR-binding', 'feishu-once-visible-code-and-private-GET-metadata', 'rotation-waits-for-old-and-current-history-controls', 'owned-Host-private-byte-stderr-and-stop-metadata', 'retry-controls-scoped-to-current-conversation', 'two-isolated-synthetic-Kivo-bindings', 'model-route-ref-consistency', 'frozen-candidate-required-files', 'all-required-journeys-fail-closed', 'observer-actual-route-and-tool-boundary', 'official-SDK-EventDispatcher-and-transport-factory-import', 'offline-Chinese-HTML-escaping-and-relative-video'], serverStarts: 0, browserStarts: 0, nativeStarts: 0, modelRequests: 0, kivoRequests: 0, realSecretReads: 0 }))
}
async function retryScopeChecks(source) {
  source ??= await readFile(script, 'utf8')
  const web = await readFile(join(root, 'web/index.html'), 'utf8'), s1 = await readFile(join(root, 'scripts/accept-p4-s1.mjs'), 'utf8')
  const calls = source.split('\n').filter(line => line.trim().startsWith('await page.click(') && line.includes('data-retry-delivery='))
  assert.equal(calls.length, 2, 'both actual retry callsites required')
  const render = web.slice(web.indexOf('    function channelEmployeeSelect('), web.indexOf('    async function channelAction(')), click = s1.slice(s1.indexOf('    async click(selector) {'), s1.indexOf('    async fill(selector,'))
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const call of calls) for (const mode of ['ready', 'missing-current', 'duplicate-current', 'hidden-current']) {
    const delivery = { id: 'retry-delivery', channelAppId: 'app', status: 'failed', sourceRef: { kind: 'conversation-turn', conversationId: 'conversation', turnId: 'turn' } }
    const state = { view: 'conversations', channelDrafts: {}, conversations: [], bootstrap: { employees: [] }, channelApps: [{ id: 'app', provider: 'feishu', runtimeStatus: 'ready' }], channels: { identities: [], conversations: [], deliveries: [delivery], linkCodes: [] } }, nodes = { 'channel-list': {}, 'channel-attention': {} }
    const frontend = Function('state', 'el', 'document', 'esc', 'byId', 'displayTime', 'bindDeliveryActions', 'deliveryLabels', 'conversationDraft', render + ';return {renderChannels,conversationReplyControls}')(
      state, id => nodes[id], { querySelectorAll: () => [] }, esc, (items, id) => items?.find(item => item.id === id), () => '', () => {}, { failed: '发送失败' }, () => ({}),
    )
    frontend.renderChannels()
    const current = frontend.conversationReplyControls({ id: 'conversation', channelIdentityId: 'identity' }, { id: 'turn', status: 'completed', assistantText: 'synthetic' })
    const controls = (html, visible) => [...html.matchAll(/data-retry-delivery="([^"]+)"/g)].map(match => ({ id: match[1], disabled: false, getBoundingClientRect: () => ({ x: 100, y: 100, width: visible ? 80 : 0, height: visible ? 20 : 0 }), contains(hit) { return hit === this } }))
    const hidden = controls(nodes['channel-attention'].innerHTML, false), shown = controls(mode === 'missing-current' ? '' : mode === 'duplicate-current' ? current + current : current, mode !== 'hidden-current')
    assert.equal(hidden.length, 1, 'actual hidden channel render must retain the duplicate')
    let clicks = 0
    const document = {
      querySelectorAll(selector) {
        if (selector === '[data-retry-delivery="retry-delivery"]') return [...hidden, ...shown]
        assert.equal(selector, '#view-conversations.active [data-delivery="retry-delivery"] [data-retry-delivery="retry-delivery"]')
        return shown
      },
      elementFromPoint: () => shown[0],
    }
    const evaluate = expression => Function('document', 'innerWidth', 'innerHeight', 'return (' + expression + ')')(document, 1440, 900)
    const page = { click: Function('evaluate', 'send', 'assert', 'pause', 'js', 'return ({' + click + '}).click')(evaluate, async (method, value) => { assert.equal(method, 'Input.dispatchMouseEvent'); if (value.type === 'mouseReleased') { assert.equal(value.x, 140); assert.equal(value.y, 110); clicks += 1 } }, assert, async () => {}, JSON.stringify) }
    const task = new AsyncFunction('page', 'failed', 'delivery', call)(page, delivery, delivery)
    if (mode === 'ready') { await task; assert.equal(clicks, 1) }
    else { await assert.rejects(task, mode === 'hidden-current' ? /control hidden or disabled/ : /expected one visible control: [02]/); assert.equal(clicks, 0) }
  }
}
async function hostDiagnosticsCheck() {
  const source = await readFile(script, 'utf8'), listener = source.match(/child\.stderrText = ''; child\.stderr\?\.on\('data', chunk => \{[^\n]+\}\)/)?.[0], caller = source.match(/child\.hostDiagnostics = captureHostDiagnostics\([^\n]+\)/)?.[0]
  assert(listener && caller, 'actual Host collector and existing stderr listener required')
  const privateDirectory = await mkdtemp(join(tmpdir(), 'geneway-host-diagnostics-')), binding = { runId: 'synthetic-diagnostics', candidate: 'a'.repeat(64), guardSha256: 'b'.repeat(64) }, failures = []
  const stopSource = source.slice(source.indexOf('async function stopGroup('), source.indexOf('function captureHostDiagnostics('))
  let clock = 0
  const makeChild = pid => {
    const child = Object.assign(new EventEmitter(), { pid, auditRole: 'host', exitCode: null, signalCode: null, stderr: new EventEmitter() })
    Function('child', listener)(child)
    Function('child', 'captureHostDiagnostics', 'privateDirectory', 'auditBinding', 'fail', caller)(child, (owned, directory, audit, fail) => captureHostDiagnostics(owned, directory, audit, fail, () => ++clock), privateDirectory, binding, error => failures.push(error.message))
    return child
  }
  try {
    assert.equal((await lstat(privateDirectory)).mode & 0o777, 0o700)
    const child = makeChild(432100011), bytes = Buffer.from([0xff, 0, 13, 10, 65]), tail = Buffer.from('SYNTHETIC_PRIVATE_STDERR')
    child.stderr.emit('data', bytes)
    const stopObserved = Function('stop', 'process', 'poll', stopSource + ';return stopGroup')(async owned => { owned.exitCode = 1; owned.emit('exit', 1, null) }, { kill() { throw Object.assign(new Error('synthetic absent'), { code: 'ESRCH' }) } }, async (check, label) => { assert.equal(label, 'owned Host stderr close'); assert.equal(check(), false); child.stderr.emit('data', tail); child.emit('close', 1, null); assert(check()) })
    await stopObserved(child)
    assert.deepEqual(await readFile(join(privateDirectory, 'host-' + child.pid + '.stderr')), Buffer.concat([bytes, tail]))
    const metadata = JSON.parse(await readFile(join(privateDirectory, 'host-' + child.pid + '.json'), 'utf8'))
    assert.equal(metadata.truncated, false); assert.equal(metadata.exitCode, 1); assert.equal(metadata.exitSignal, null); assert(metadata.closedAt > metadata.observedExitAt)
    assert.equal(metadata.stopRequests[0].requestedSignal, 'SIGTERM'); assert.equal(metadata.stopRequests[0].signalDelivered, null); assert(metadata.stopRequests[0].stopRequestedAt < metadata.observedExitAt)
    const capped = makeChild(432100012), limit = 8 * 1024 * 1024
    capped.stderr.emit('data', Buffer.alloc(limit, 97))
    assert.equal(JSON.parse(await readFile(join(privateDirectory, 'host-' + capped.pid + '.json'), 'utf8')).truncated, false)
    capped.stderr.emit('data', Buffer.from('overflow')); capped.exitCode = 0; capped.emit('exit', 0, null)
    let alive = true
    const stopResidue = Function('stop', 'process', 'poll', stopSource + ';return stopGroup')(async () => {}, { kill(pid, signal) { assert.equal(pid, -capped.pid); if (signal === 'SIGKILL') { alive = false; return true } if (alive) return true; throw Object.assign(new Error('synthetic absent'), { code: 'ESRCH' }) } }, async (check, label) => { if (label === 'owned Host stderr close') { assert.equal(check(), false); capped.emit('close', 0, null) } assert(await check()) })
    await stopResidue(capped)
    const cappedRaw = join(privateDirectory, 'host-' + capped.pid + '.stderr'), cappedMeta = join(privateDirectory, 'host-' + capped.pid + '.json'), cappedState = JSON.parse(await readFile(cappedMeta, 'utf8'))
    assert.deepEqual(await readFile(cappedRaw), Buffer.alloc(limit, 97)); assert.equal(cappedState.bytesSaved, limit); assert.equal(cappedState.bytesObserved, limit + 8); assert.equal(cappedState.truncated, true)
    assert.equal(cappedState.stopRequests[1].reason, 'owned-group-residue'); assert.equal(cappedState.stopRequests[1].signalDelivered, true)
    for (const file of [cappedRaw, cappedMeta, join(privateDirectory, 'host-' + child.pid + '.stderr'), join(privateDirectory, 'host-' + child.pid + '.json')]) assert.equal((await lstat(file)).mode & 0o777, 0o600)
    const nonHost = Object.assign(new EventEmitter(), { pid: 432100013, stderr: new EventEmitter() }); Function('child', listener)(nonHost); nonHost.stderr.emit('data', tail)
    await assert.rejects(access(join(privateDirectory, 'host-' + nonHost.pid + '.stderr')), { code: 'ENOENT' }); assert.equal(makeChild(undefined).hostDiagnostics, undefined)
    const rejectedStop = Function('stop', 'process', 'poll', stopSource + ';return stopGroup')(async () => { throw new Error('SYNTHETIC_STOP_FAILED') }, {}, poll)
    await assert.rejects(rejectedStop(child), /SYNTHETIC_STOP_FAILED/)
    assert.deepEqual(failures, [])
    child.stderr.emit('data', bytes); assert.deepEqual(failures, ['private Host diagnostics I/O failed'])
    const publicReport = source.slice(source.indexOf('      report = { ok:'), source.indexOf('\n  console.log(JSON.stringify({ ok: report.ok'))
    assert(!/hostDiagnostics|privateDirectory|stderrText/.test(publicReport), 'private stderr must not enter public reports')
  } finally { await rm(privateDirectory, { recursive: true, force: true }) }
}
async function rotationHistoryChecks(source) {
  source ??= await readFile(script, 'utf8')
  const web = await readFile(join(root, 'web/index.html'), 'utf8'), rotation = source.indexOf("    for (const pair of pairs) await step('rotate-'")
  const start = source.indexOf('      await refreshChannels(page); await page.wait(', rotation), end = source.indexOf('\n      facts.push(', start)
  assert(rotation >= 0 && start > rotation && end > start, 'actual rotation history checks required')
  const render = web.slice(web.indexOf('    function channelEmployeeSelect('), web.indexOf('    function deliveryCard(')), show = web.slice(web.indexOf('    function show(view,'), web.indexOf('    async function routeFromUrl(')), load = web.slice(web.indexOf('    async function loadConversations('), web.indexOf('    async function openConversation('))
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const mode of ['delayed', 'missing-old', 'missing-current']) {
    let release, readDone
    const reading = new Promise(resolveRead => { release = resolveRead }), loaded = new Promise(resolveLoaded => { readDone = resolveLoaded })
    const state = { authEpoch: 1, session: { id: 'a' }, view: 'channels', conversationListRequest: 0, workSelection: 0, channelDrafts: {}, conversations: [], bootstrap: { employees: [] }, channelApps: [{ id: 'app', provider: 'feishu', runtimeStatus: 'ready' }], channels: { deliveries: [], linkCodes: [], identities: [{ id: 'identity', channelAppId: 'app', status: 'active', activeConversationId: 'current', externalIdentity: 'synthetic' }] } }
    const nodes = { 'channel-list': { innerHTML: '' }, 'channel-attention': { innerHTML: '' }, 'top-title': {} }, document = { querySelectorAll: () => [], querySelector: () => ({ scrollTop: 0 }) }
    const frontend = Function('state', 'el', 'document', 'esc', 'byId', 'displayTime', 'bindDeliveryActions', 'api', 'renderConversationCreateOptions', 'renderConversationList', 'setMessage', 'startChannelPolling', 'titles', render + '\n' + load + '\n' + show + ';return {renderChannels,show}')(
      state, id => nodes[id], document, esc, (items, id) => items?.find(item => item.id === id), () => '', () => {}, async path => { if (path.startsWith('/api/conversations')) { await reading; return { conversations: ['old', 'current'].filter(id => mode !== 'missing-' + id).map(id => ({ id, channelIdentityId: 'identity', title: id, updatedAt: '2026-10-16T00:00:00Z' })) } } return state.bootstrap }, () => {}, () => {}, () => readDone(), () => {}, { channels: '我的渠道' },
    )
    frontend.renderChannels()
    document.querySelector = selector => selector === '#channel-list' ? { innerText: nodes['channel-list'].innerHTML.replace(/<[^>]*>/g, '') } : nodes['channel-list'].innerHTML.includes('data-channel-identity="identity"') ? { querySelector: target => { const history = nodes['channel-list'].innerHTML.match(/<details class="channel-history">([\s\S]*?)<\/details>/)?.[1] ?? '', id = target.match(/data-open-channel-conversation="([^"]+)"/)?.[1]; return id && history.includes('data-open-channel-conversation="' + id + '"') ? {} : null } } : null
    const evaluate = expression => Function('document', 'return (' + expression + ')')(document)
    const page = { async wait(expression) { if (evaluate(expression)) return; release(); await loaded; await Promise.resolve(); assert(evaluate(expression), 'both exact history controls must be rendered') }, async evaluate(expression) { return evaluate(expression) } }
    const task = new AsyncFunction('page', 'refreshChannels', 'ref', 'old', 'current', 'assert', source.slice(start, end))(page, async () => frontend.show('channels', false), { identityId: 'identity' }, { id: 'old' }, { id: 'current' }, assert)
    if (mode === 'delayed') await task
    else await assert.rejects(task, /both exact history controls must be rendered/)
  }
}
async function feishuBindingCodeChecks(source) {
  source ??= await readFile(script, 'utf8')
  const { createChannelService } = await import('../src/channel-service.mjs'), web = await readFile(join(root, 'web/index.html'), 'utf8'), server = await readFile(join(root, 'src/server.mjs'), 'utf8')
  const start = source.indexOf('  async function bind(pair, page)'), end = source.indexOf("    await poll(async () => (await channelState(pair.actor)).linkCodes.find(value => value.id === link.id)?.status === 'matched'", start)
  const code = source.slice(start + '  async function bind(pair, page) {'.length, end), render = web.slice(web.indexOf('    function channelEmployeeSelect('), web.indexOf('    function deliveryCard('))
  assert(start >= 0 && end > start, 'actual Feishu binding entry required')
  const action = web.match(/    async function channelAction\(operation,message\)\{[^\n]+/)[0], issue = web.match(/    async function issueLink\(channelAppId\)\{[^\n]+/)[0]
  const safeLink = Function(server.slice(server.indexOf('function safeLink('), server.indexOf('function safeChannelState(')) + ';return safeLink')()
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const mode of ['visible', 'stale-plain', 'duplicate-new', 'foreign-page']) {
    let sequence = 0, pending, issued, sent = 0
    let data = { members: [{ id: 'a', enabled: true }], channelApps: [{ id: appIds.feishu, provider: 'feishu', enabled: true, status: 'active', allowedScopes: ['result'] }], linkCodes: [], channelIdentities: [], channelConversations: [], works: [], channelMessages: [], deliveries: [] }
    const service = createChannelService({ store: { read: async () => data, update: async mutate => { data = await mutate(data); return data } }, idFactory: () => String(++sequence), randomBytesFactory: size => Buffer.alloc(size, sequence + 1) })
    const channelState = async () => { const value = await service.memberChannelState({ id: 'a' }); return { ...value, linkCodes: value.linkCodes.map(safeLink) } }
    const state = { authEpoch: 1, view: 'channels', channelDrafts: {}, conversations: [], bootstrap: { employees: [] }, channelApps: [{ id: appIds.feishu, provider: 'feishu', runtimeStatus: 'ready' }], channels: await channelState() }
    const nodes = { 'channel-list': { innerHTML: '' }, 'channel-attention': { innerHTML: '' } }, document = { querySelectorAll: () => [] }
    const frontend = Function('state', 'el', 'document', 'esc', 'byId', 'displayTime', 'bindDeliveryActions', 'api', 'reloadAll', 'loadConversations', 'startChannelPolling', 'setMessage', render + '\n' + action + '\n' + issue + ';return {renderChannels,issueLink}')(
      state, id => nodes[id], document, esc, (items, id) => items?.find(item => item.id === id), () => '', () => {}, async () => { issued = await service.issueLinkCode({ id: 'a' }, { channelAppId: appIds.feishu }); if (mode === 'duplicate-new') await service.issueLinkCode({ id: 'a' }, { channelAppId: appIds.feishu }); return issued }, async () => { state.channels = await channelState(); if (mode === 'stale-plain') state.linkCodePlain.id = 'stale' }, async () => {}, () => {}, () => {},
    )
    frontend.renderChannels()
    document.querySelectorAll = selector => {
      if (selector === '[data-issue-link="' + appIds.feishu + '"]') return nodes['channel-list'].innerHTML.includes('data-issue-link="' + appIds.feishu + '"') ? [{}] : []
      if (selector !== '#channel-app-' + appIds.feishu + ' [data-link-code]') return []
      const section = nodes['channel-list'].innerHTML.match(new RegExp('<section class="section" id="channel-app-' + appIds.feishu + '"[^>]*>([\\s\\S]*?)</section>'))?.[1] ?? ''
      return [...section.matchAll(/data-link-code>([^<]*)<\/div>/g)].map(match => ({ innerText: match[1] }))
    }
    document.querySelector = selector => document.querySelectorAll(selector)[0] ?? null
    const evaluate = expression => Function('document', 'return (' + expression + ')')(document)
    const page = { actor: mode === 'foreign-page' ? 'b' : 'a', async click(selector) { assert.equal(selector, '[data-issue-link="' + appIds.feishu + '"]'); pending = frontend.issueLink(appIds.feishu); if (mode === 'duplicate-new') await pending }, async wait(expression) { if (pending) await pending; assert(evaluate(expression), 'current once-visible code unavailable') }, async evaluate(expression) { return evaluate(expression) } }
    const task = new AsyncFunction('pair', 'page', 'refreshChannels', 'channelState', 'appIds', 'poll', 'assert', 'inbound', code)({ actor: 'a', provider: 'feishu' }, page, async () => {}, channelState, appIds, async check => { const value = await check(); assert(value); return value }, assert, async (_pair, id, value) => { assert.equal(id, 'link-' + issued.id); assert.equal(value === issued.code, true, 'inbound must use the once-visible code'); sent += 1 })
    if (mode === 'visible') { await task; assert.equal(sent, 1) } else { await assert.rejects(task, mode === 'stale-plain' ? /current once-visible code unavailable/ : mode === 'duplicate-new' ? /multiple owner link IDs/ : /authenticated owner/); assert.equal(sent, 0) }
    for (const link of (await channelState()).linkCodes) { assert.equal(Object.hasOwn(link, 'code'), false); assert.equal(Object.hasOwn(link, 'digest'), false) }
    if (pending) await pending
  }
}
async function unlinkRenderChecks(source) {
  source ??= await readFile(script, 'utf8')
  const web = await readFile(join(root, 'web/index.html'), 'utf8'), start = source.indexOf("      await page.viewport(390, 844); await refreshChannels(page); await page.click('[data-unlink=")
  const clicked = source.indexOf("await page.click('[data-unlink=", start), end = source.indexOf('\n      const business =', clicked), next = source.indexOf("      await page.click('[data-begin-weixin-binding=", end)
  assert(start >= 0 && clicked > start && end > clicked && next > end, 'actual unlink and next QR entry required')
  const code = source.slice(clicked, end) + '\n' + source.slice(next, source.indexOf('\n', next)), render = web.slice(web.indexOf('    function channelEmployeeSelect('), web.indexOf('    function deliveryCard('))
  const action = web.match(/    async function channelAction\(operation,message\)\{[^\n]+/)[0], unlink = web.match(/    async function unlinkChannel\(identityId\)\{[^\n]+/)[0]
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const mode of ['delayed', 'not-refreshed', 'disabled']) {
    let backend = 'active', pending, release, begins = 0
    const state = { authEpoch: 1, view: 'channels', channelDrafts: {}, conversations: [], bootstrap: { employees: [] }, channelApps: [{ id: 'wx', provider: 'weixin', runtimeStatus: mode === 'disabled' ? 'unavailable' : 'ready' }], channels: { deliveries: [], linkCodes: [], identities: [{ id: 'old', channelAppId: 'wx', status: 'active', runtimeState: 'connected', externalIdentity: 'synthetic' }] } }
    const nodes = { 'channel-list': { innerHTML: '' }, 'channel-attention': { innerHTML: '' } }, document = { querySelectorAll: () => [] }
    const frontend = Function('state', 'el', 'document', 'esc', 'byId', 'displayTime', 'bindDeliveryActions', 'api', 'reloadAll', 'loadConversations', 'startChannelPolling', 'setMessage', render + '\n' + action + '\n' + unlink + ';return {renderChannels,unlinkChannel}')(
      state, id => nodes[id], document, esc, (items, id) => items?.find(item => item.id === id), () => '', () => {}, async () => { backend = 'unlinked' }, async () => { await new Promise(resolveReload => { release = resolveReload }); if (mode !== 'not-refreshed') state.channels.identities[0].status = backend }, async () => {}, () => {}, () => {},
    )
    frontend.renderChannels()
    document.querySelector = selector => {
      if (selector.startsWith('[data-channel-identity=')) return { querySelector: () => ({ innerText: nodes['channel-list'].innerHTML.match(/data-channel-identity="old"[\s\S]*?<span class="pill [^"]*">([^<]+)/)?.[1] }) }
      const button = nodes['channel-list'].innerHTML.match(/<button[^>]*data-begin-weixin-binding="wx"[^>]*>/)?.[0]
      return button ? { disabled: /\bdisabled\b/.test(button) } : null
    }
    const evaluate = expression => Function('document', 'return (' + expression + ')')(document)
    const page = { async click(selector) { if (selector.startsWith('[data-unlink=')) pending = frontend.unlinkChannel('old'); else { assert(document.querySelector(selector)?.disabled === false, 'QR clicked before unlink rendered'); begins += 1 } }, async wait(expression) { assert.equal(evaluate(expression), false, 'old active DOM must not satisfy unlink readiness'); release(); await pending; assert(evaluate(expression), 'unlink UI or QR button unavailable') } }
    const task = new AsyncFunction('page', 'old', 'channelState', 'poll', 'simulator', 'accounts', 'appIds', code)(page, { identityId: 'old' }, async () => ({ identities: [{ id: 'old', status: backend }] }), async check => assert(await check()), { activePolls: () => 0 }, { a: { id: 'synthetic' } }, { weixin: 'wx' })
    if (mode === 'delayed') { await task; assert.equal(begins, 1) } else { await assert.rejects(task, /unlink UI or QR button unavailable/); assert.equal(begins, 0) }
  }
}
async function adminMutationChecks(source) {
  source ??= await readFile(script, 'utf8')
  const web = await readFile(join(root, 'web/index.html'), 'utf8'), take = (text, start, end) => { const a = text.indexOf(start), b = text.indexOf(end, a + start.length); assert(a >= 0 && b > a, start); return text.slice(a, b) }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor, passed = '协议与固定只读工具目录测试通过', saved = '配置已保存并从服务端回读', defaultSaved = '渠道默认员工已保存，既有对话保持原员工'
  const loop = take(source, '      for (const instance of fixture.instances) {', "      await page.click('#tab-employees')"), test = web.match(/    async function testConnection\(connectionId\)\{[^\n]+\}/)[0]
  for (const denied of [false, true]) {
    let message = passed, pending, release, tests = 0
    const opened = new Set(), ready = new Set(), flush = async () => { release(); await pending; pending = null }
    const frontend = Function('api', 'loadAdmin', 'reloadAll', 'setMessage', test + '; return testConnection')(
      async path => { tests += 1; if (denied) throw new Error('SYNTHETIC_DENIED'); ready.add(path.split('/').at(-2)); return {} }, async () => { await new Promise(resolveLoad => { release = resolveLoad }); opened.clear() }, async () => {}, (_target, text) => { message = text },
    )
    const page = {
      async click(selector) { const id = selector.match(/data-id="([^"]+)"/)?.[1] ?? selector.match(/data-test-connection="([^"]+)"/)?.[1]; if (selector.endsWith('> summary')) { opened.add(id); if (pending) await flush(); return } assert(opened.has(id), 'next connection details collapsed before test click'); pending = frontend(id); assert.equal(message, '正在执行只读连接测试…') },
      async wait(expression) { assert(expression.includes(passed)); assert.equal(message, '正在执行只读连接测试…'); await flush(); assert(message.includes(passed), 'test completion missing') },
    }
    const pendingLoop = new AsyncFunction('page', 'fixture', 'poll', 'api', loop)(page, { instances: ['a', 'b'].map(id => ({ connection: { id } })) }, async check => assert(await check()), async () => [...ready].map(id => ({ id, status: 'ready' })))
    if (denied) { await assert.rejects(pendingLoop); assert.equal(tests, 1) } else { await pendingLoop; assert.equal(tests, 2); assert.equal(pending, null) }
  }
  const save = take(web, '    async function saveAdminForm(', '    async function testConnection(')
  const creation = take(source, "        await page.click(form + ' button.primary')", '\n      }\n      await setDefault(agents.a)')
  const saveCalls = [['employee', creation], ['employee', take(source, '  async function editAgent(', '  async function editMember(') + '; await editAgent("synthetic", false)'], ['member', take(source, '  async function editMember(', '\n\n  async function unlinkAndRebind(') + '; await editMember("synthetic", false)']]
  for (const [kind, code] of saveCalls) {
    let message = saved, pending, release, persisted = false, finished = false, writes = 0
    const form = { dataset: { kind, id: code === creation ? '' : 'synthetic', revision: '1', expectedEmployeeIds: '[]' }, elements: Object.fromEntries(['id', 'name', 'description', 'instructions', 'modelRouteId', 'displayName', 'role', 'enabled'].map(key => [key, { value: 'synthetic', checked: false }])), querySelector: () => ({}) }
    const frontend = Function('api', 'loadAdmin', 'reloadAll', 'setMessage', 'selected', save + '; return saveAdminForm')(
      async () => { assert.equal(message, '正在保存…'); writes += 1; persisted = true; return {} }, async () => { await new Promise(resolveLoad => { release = resolveLoad }) }, async () => {}, (target, text) => { if (target === 'admin-message') { message = text; if (text === saved) finished = true } }, () => [],
    )
    const page = { async front() {}, async nav() {}, async check() {}, async click(selector) { if (selector.endsWith('button.primary')) { pending = frontend({ preventDefault() {}, currentTarget: form }); assert.equal(message, '正在保存…') } }, async wait(expression) { release(); await pending; const document = { querySelector: selector => selector === '#admin-message' ? { innerText: message } : persisted ? {} : null }; assert(Function('document', 'return (' + expression + ')')(document)) } }
    await new AsyncFunction('page', 'form', 'agents', 'actor', 'browsers', 'poll', 'api', code)(page, 'form.synthetic', { a: 'synthetic' }, 'a', { admin: page }, async check => assert(await check()), async () => persisted ? [{ id: 'synthetic', enabled: false }] : [])
    assert.equal(finished, true, 'save caller returned before its admin render completed'); assert.equal(writes, 1)
  }
  const defaultLine = web.match(/    function renderChannelApps\(\)\{[^\n]+/)[0], defaultHandler = defaultLine.slice(defaultLine.indexOf("el('channel-default-form').onsubmit=") + "el('channel-default-form').onsubmit=".length, -1)
  const defaultCall = take(source, '  async function setDefault(employeeId)', '  function instance(actor)') + '; await setDefault("next")'
  for (const wrongOption of [false, true]) {
    let message = defaultSaved, selected = 'old', persisted = 'old', rendered = 'old', pending, releaseLoad, releaseReload, atReload, loaded = false, renders = 0
    const loading = new Promise(resolveLoad => { releaseLoad = resolveLoad }), reloading = new Promise(resolveReload => { releaseReload = resolveReload }), reachedReload = new Promise(resolveReached => { atReload = resolveReached })
    const frontend = Function('api', 'loadAdmin', 'reloadAll', 'setMessage', 'state', 'el', 'return ' + defaultHandler)(async (_path, options) => { persisted = options.body.defaultChannelEmployeeId; return {} }, async () => { await loading; rendered = wrongOption ? 'wrong' : persisted; loaded = true; renders += 1 }, async () => { atReload(); await reloading }, (_target, text) => { message = text }, { authEpoch: 1 }, () => ({ value: selected }))
    const document = { querySelector: selector => selector === '#admin-message' ? { innerText: message } : { defaultSelected: rendered === 'next' } }, evaluate = expression => Function('document', 'return (' + expression + ')')(document)
    const page = { async front() {}, async nav() {}, async select(_selector, value) { selected = value }, async click(selector) { if (selector === '#channel-default-form button') pending = frontend({ preventDefault() {} }) }, async wait(expression) { if (evaluate(expression)) return; releaseLoad(); await reachedReload; if (evaluate(expression)) return; releaseReload(); await pending; assert(evaluate(expression), 'new default option missing') } }
    try {
      const task = new AsyncFunction('browsers', 'poll', 'api', defaultCall)({ admin: page }, async check => assert(await check()), async () => ({ defaultChannelEmployeeId: persisted }))
      if (wrongOption) await assert.rejects(task, /new default option missing/)
      else { await task; assert.equal(loaded, true, 'default caller accepted old success before admin render'); assert.equal(rendered, 'next') }
    } finally { releaseLoad(); releaseReload(); await pending }
    assert.equal(renders, 1); assert.equal(message, defaultSaved); assert.notEqual(message, saved, 'late default completion cannot acknowledge a saveAdminForm submission')
  }
}
async function reloadDocumentChecks(source) {
  source ??= await readFile(script, 'utf8')
  const helperStart = source.indexOf('  async function reload(page, view)'), helperEnd = source.indexOf('\n  async function refreshChannels(', helperStart)
  const marker = "      await editMember('b', true); await login('b')", memberStart = source.indexOf(marker) + marker.length, memberEnd = source.indexOf('\n      await memberPage.fill(', memberStart)
  assert(helperStart >= 0 && helperEnd > helperStart && memberStart >= marker.length && memberEnd > memberStart, 'actual reload paths required')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const [target, code] of [['app', source.slice(helperStart, helperEnd) + '; await reload(page, "channels")'], ['login', source.slice(memberStart, memberEnd)]]) {
    for (const mode of ['ready', 'no-commit', 'not-ready']) {
      let timeOrigin = 100, ready = true, reloads = 0, fronts = 0, navigations = 0
      const document = { querySelector(selector) { return ready ? { classList: { contains: () => selector === '#app' ? target === 'login' : target !== 'login' }, innerText: target === 'app' ? '已登录 · 成员' : '' } : null } }
      const evaluate = expression => Function('performance', 'document', 'return (' + expression + ')')({ timeOrigin }, document)
      const page = {
        async front() { fronts += 1 }, async evaluate(expression) { assert.equal(expression, 'performance.timeOrigin'); return timeOrigin },
        async send(method) { assert.equal(method, 'Page.reload'); reloads += 1 },
        async wait(expression) {
          for (let index = 0; index < 3; index += 1) {
            if (evaluate(expression)) return
            if (mode !== 'no-commit') { timeOrigin = 200; ready = mode === 'ready' }
          }
          throw new Error('SYNTHETIC_RELOAD_NOT_READY')
        },
        async nav(view) { assert.equal(view, 'channels'); assert.equal(timeOrigin, 200, 'navigation used the old document'); navigations += 1 },
      }
      const pending = new AsyncFunction('page', 'memberPage', code)(page, page)
      if (mode === 'ready') { await pending; assert.equal(timeOrigin, 200, 'login used the old document'); assert.equal(navigations, target === 'app' ? 1 : 0) }
      else { await assert.rejects(pending, /SYNTHETIC_RELOAD_NOT_READY/); assert.equal(navigations, 0) }
      assert.equal(fronts, 1); assert.equal(reloads, 1)
    }
  }
}
async function entryPauseCheck() {
  const source = await readFile(script, 'utf8'), start = source.indexOf('if (process.argv[1] && resolve(process.argv[1]) === script) {'), end = source.indexOf('\nfunction argumentsFor(', start)
  const firstPause = source.match(/    await pause\(500\); recording\.assertRunning\(\)/)?.[0], declaration = source.match(/^(?:const pause =|function pause\()[^\n]+$/m)?.[0]
  assert(start >= 0 && end > start && firstPause && declaration, 'actual entry, first pause and declaration required')
  const legacy = declaration.replace('function pause(ms) { return ', 'const pause = ms => ').replace(/ }$/, '')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  for (const [index, statement] of [declaration, legacy].entries()) {
    const timers = []; let recordingAssertions = 0
    const execute = new AsyncFunction('process', 'resolve', 'script', 'argumentsFor', 'harnessCheck', 'channelHost', 'recording', 'setTimeout', source.slice(start, end) + '\nasync function acceptance(){\n' + firstPause + '\n}\n' + statement)
    const pending = execute({ argv: ['node', '/synthetic/accept-p4.mjs', '--run'] }, value => value, '/synthetic/accept-p4.mjs', () => ({ run: true }), () => assert.fail('unexpected pure branch'), () => assert.fail('unexpected host branch'), { assertRunning() { recordingAssertions += 1 } }, (callback, ms) => { timers.push(ms); callback() })
    if (index === 0) { await pending; assert.deepEqual(timers, [500]); assert.equal(recordingAssertions, 1) }
    else { await assert.rejects(pending, { name: 'ReferenceError', message: "Cannot access 'pause' before initialization" }); assert.deepEqual(timers, []); assert.equal(recordingAssertions, 0) }
  }
}
async function forceStopCallerCheck() {
  const source = await readFile(script, 'utf8'), caller = source.match(/const child = launch\(process.execPath, \[script, '--host'\][^\n]+\n\s*child\.auditFile = auditFile; child\.auditBinding = auditBinding/)?.[0]
  assert(caller, 'actual Host caller must supply forced-stop audit inputs')
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-channel-stop-check-')), auditFile = join(scratch, 'audit.jsonl')
  const auditBinding = { runId: 'synthetic-force-stop', candidate: 'a'.repeat(64), guardSha256: 'b'.repeat(64) }
  const originalKill = process.kill
  let signalAttempts = 0
  try {
    await writeFile(auditFile, '', { mode: 0o600 })
    const child = Function('launch', 'process', 'script', 'env', 'auditFile', 'auditBinding', caller + '; return child')(
      () => Object.assign(new EventEmitter(), { pid: 432100000, exitCode: null, signalCode: null }), process, script, {}, auditFile, auditBinding)
    process.kill = (pid, signal) => {
      assert([child.pid, -child.pid].includes(pid), 'force-stop check may touch only its synthetic PID/group')
      if (signal === 0) throw Object.assign(new Error('synthetic process absent'), { code: 'ESRCH' })
      assert.equal(pid, -child.pid); assert.equal(signal, 'SIGKILL'); signalAttempts += 1
      child.signalCode = signal; child.emit('exit', null, signal); return true
    }
    await stopGroup(child, 'SIGKILL')
    assert.equal(signalAttempts, 1); assert.equal(child.auditFile, auditFile); assert.equal(child.auditBinding, auditBinding)
    assert.equal(child.auditInterruption.runId, auditBinding.runId); assert.equal(child.auditInterruption.auditRowsBeforeSignal, 0)
    assert.equal(child.auditInterruption.observedSignal, 'SIGKILL'); assert.equal(child.auditInterruption.groupExited, true)
    const auditCall = source.match(/networkAudit\(networkRows, \{[^\n]+\}\)/)?.[0]
    assert(auditCall?.includes('hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean)'), 'actual audit consumer must receive observed interruptions')
  } finally { process.kill = originalKill; await rm(scratch, { recursive: true, force: true }) }
}
async function revokedDeliveryCheck() {
  const { createChannelService } = await import('../src/channel-service.mjs')
  const pending = { id: 'revoked-delivery', requestId: 'unique-revoked-request', channelAppId: 'app', targetIdentityId: 'identity', targetConversationId: 'endpoint', contentKey: 'conversation.reply', contentScope: 'result', sourceRef: { kind: 'conversation-turn', conversationId: 'conversation', turnId: 'turn' }, status: 'pending', attempts: 0 }
  let state = {
    channelApps: [{ id: 'app', provider: 'feishu', enabled: true, status: 'active', allowedScopes: ['result'] }],
    channelIdentities: [{ id: 'identity', channelAppId: 'app', memberId: 'a', status: 'active' }],
    channelConversations: [{ id: 'endpoint', channelAppId: 'app', identityId: 'identity', memberId: 'a', type: 'private', status: 'active', allowedScopes: ['result'] }],
    conversations: [{ id: 'conversation', ownerMemberId: 'a', employeeId: 'agent', channelIdentityId: 'identity', turns: [{ id: 'turn', status: 'completed' }] }],
    members: [{ id: 'a', enabled: true, employeeIds: ['agent'] }], employees: [{ id: 'agent', enabled: false }], works: [], skills: [], connections: [], deliveries: [pending],
  }
  const service = createChannelService({ store: { read: async () => state, update: async mutate => { state = await mutate(state); return state } } })
  const response = { status: 403, body: { error: { code: 'DELIVERY_FORBIDDEN', status: 403 } } }
  await assert.rejects(service.authorizeDelivery({ deliveryId: pending.id }), { code: 'DELIVERY_FORBIDDEN' })
  assert.equal(blockedDelivery(response, state.deliveries, pending.requestId).id, pending.id)
  await assert.rejects(service.authorizeDelivery({ deliveryId: pending.id, retry: true }), { code: 'DELIVERY_FORBIDDEN' })
  assert.equal(blockedDelivery(response, state.deliveries, pending.requestId).id, pending.id)
  assert.throws(() => blockedDelivery({ ...response, status: 200 }, state.deliveries, pending.requestId), /403/)
  assert.throws(() => blockedDelivery({ status: 403, body: { error: { code: 'OTHER' } } }, state.deliveries, pending.requestId), /error code/)
  assert.throws(() => blockedDelivery(response, state.deliveries, 'another-request'), /exactly one/)
  assert.throws(() => blockedDelivery(response, [...state.deliveries, state.deliveries[0]], pending.requestId), /exactly one/)
  assert.throws(() => blockedDelivery(response, [pending], pending.requestId), /blocked/)
}
async function interruptedReportCheck() {
  const source = await readFile(script, 'utf8'), block = source.match(/let savedFailure\n[\s\S]*?\} while \(savedFailure !== failure\)/)?.[0]
  assert(block, 'actual report persistence block is missing')
  const execute = Function('join', 'manual', 'safeFailure', 'return async function(injectAt) { let failure, writes = 0; const files = new Map(), options = {output:"/memory"}, cleanup = {state:{}}, interrupts = {state:{}}, report = {ok:true,scope:"渠道为模拟验收",candidate:{preflight:{head:"synthetic"}},cleanup:{},media:{},steps:[]}; const writeFile = async (path,text) => { files.set(path,text); if (++writes === injectAt) { failure = new Error("SYNTHETIC_INTERRUPT"); interrupts.state.interruptedBy = "SIGINT"; } }; ' + block + '; return {report,files,writes}; }')(join, manual, safeFailure)
  for (const injectAt of [1, 2]) {
    const { report, files, writes } = await execute(injectAt)
    assert.equal(report.ok, false); assert.equal(JSON.parse(files.get('/memory/observations.json')).ok, false)
    assert(files.get('/memory/index.html').includes('本轮未通过')); assert(!files.get('/memory/index.html').includes('本轮所列操作与自动检查通过'))
    assert.equal(report.cleanup.interruptedBy, 'SIGINT'); assert.equal(writes, 4, 'both artifacts must be rewritten after an in-flight interrupt')
  }
  const normal = await execute(0); assert.equal(normal.report.ok, true); assert.equal(normal.writes, 2)
}
function syntheticFixture() {
  return { dataMode: 'synthetic', sourceEnvironment: 'external-test', instances: ['a', 'b'].map((instance, index) => ({ instance,
    connection: { id: 'kivo-' + instance, kind: 'kivo-mcp', targetIdentity: 'kivo-' + instance, baseUrl: 'http://127.0.0.1:' + (39000 + index) + '/api/v1/mes/mcp', issuer: 'http://127.0.0.1:' + (39000 + index), clientId: '00000000-0000-4000-8000-00000000000' + index, credentialRef: 'KIVO_' + instance.toUpperCase(), allowedObjectIds: [], sourceSystem: 'Kivo', sourceInstance: 'synthetic-' + instance, sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-mcp-http' },
    records: [{ recordType: 'repair', recordId: instance + '-record', reference: 'SYNTHETIC-REPAIR-1', rawStatus: 'pending' }],
  })) }
}

function validateFixture(fixture, catalog) {
  assert.equal(fixture.dataMode, 'synthetic'); assert.equal(fixture.sourceEnvironment, 'external-test')
  assert.equal(fixture.instances?.length, 2); assert.equal(catalog.version, 1); assert(Array.isArray(catalog.targets))
  const refs = new Set()
  for (const [index, instance] of fixture.instances.entries()) {
    assert.equal(instance.instance, ['a', 'b'][index])
    const connection = instance.connection, url = new URL(connection.baseUrl)
    assert.equal(connection.kind, 'kivo-mcp'); assert.equal(url.protocol, 'http:')
    assert(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash)
    assert.equal(url.pathname, '/api/v1/mes/mcp'); assert.equal(connection.issuer, url.origin)
    assert(/^[0-9a-f-]{36}$/.test(connection.clientId)); assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connection.credentialRef)); assert(!refs.has(connection.credentialRef)); refs.add(connection.credentialRef)
    assert.deepEqual(connection.allowedObjectIds, [], 'only the pre-approved machine scope may govern objects')
    assert.equal(connection.dataMode, 'synthetic'); assert.equal(connection.sourceEnvironment, 'external-test'); assert.equal(connection.evidenceMode, 'real-mcp-http')
    assert(catalog.targets.some(target => connectionFields.every(key => target[key] === connection[key])), 'connection differs from explicit catalog')
    const record = instance.records?.find(value => value.recordType === 'repair')
    assert(record?.recordId && record.reference && record.rawStatus, 'explicit repair fixture is missing')
  }
  assert.notEqual(fixture.instances[0].connection.baseUrl, fixture.instances[1].connection.baseUrl, 'two actual Kivo instances required')
  assert.notEqual(fixture.instances[0].connection.sourceInstance, fixture.instances[1].connection.sourceInstance)
  const records = fixture.instances.map(instance => instance.records.find(value => value.recordType === 'repair'))
  assert.equal(records[0].reference, records[1].reference); assert.notEqual(records[0].recordId, records[1].recordId)
  assert(!/"(?:privateKey|machinePrivateKey|accessToken|apiKey|password|authorization)"\s*:|BEGIN (?:RSA )?PRIVATE KEY|Bearer /i.test(JSON.stringify({ fixture, catalog })), 'fixture must not contain secret bodies')
  return fixture
}
function validateCandidate(value) {
  assert(Array.isArray(value.files) && value.files.length, 'candidate requires file hashes')
  const files = value.files.map(entry => {
    assert(typeof entry.path === 'string' && !entry.path.includes('..') && /^(src\/|plugins\/|config\/|web\/|vendor\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(entry.path), 'candidate path is invalid')
    assert(/^[a-f0-9]{64}$/.test(entry.sha256)); return entry
  })
  assert.equal(new Set(files.map(value => value.path)).size, files.length)
  for (const file of ['scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'src/server.mjs', 'src/channel-service.mjs', 'src/conversation-service.mjs', 'src/collaboration-runner.mjs', 'web/index.html']) assert(files.some(value => value.path === file), 'candidate missing ' + file)
  return files
}
async function snapshot(files, expectedHead) {
  const head = (await command('git', ['rev-parse', 'HEAD'])).trim(); assert.equal(head, expectedHead, 'HEAD differs from frozen candidate')
  const all = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'plugins', 'config', 'web', 'vendor', 'package.json', 'pnpm-lock.yaml', 'scripts/accept-p4.mjs', 'scripts/accept-p4-s1.mjs', 'scripts/test-p4-channel-conversations.mjs', 'scripts/fixtures/ilink-server.mjs', 'scripts/state-transfer.mjs'])).split('\0').filter(Boolean).sort()
  assert(all.every(path => files.some(value => value.path === path)), 'frozen candidate omits a loaded product/harness file')
  const hashes = Object.fromEntries(await Promise.all(all.map(async file => [file, hash(await readFile(join(root, file)))])))
  for (const file of files) assert.equal(hash(await readFile(join(root, file.path))), file.sha256, 'candidate mismatch: ' + file.path)
  const installed = {}
  for (const [name, expected] of [['@deepseek-ai/dsh', '0.2.0-rc.2'], ['@deepseek-ai/dsh-sdk-client', '0.2.0-rc.2'], ['@deepseek-ai/dsh-tools', '0.2.0-rc.2'], ['@larksuiteoapi/node-sdk', '1.74.0']]) {
    const bytes = await readFile(join(root, 'node_modules', name, 'package.json')), metadata = JSON.parse(bytes)
    assert.equal(metadata.version, expected, 'installed official SDK version differs'); installed[name] = { version: metadata.version, packageJsonSha256: hash(bytes) }
  }
  return { head, files: hashes, installed }
}
async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const metadata = await file.stat(); assert(metadata.isFile() && (metadata.mode & 0o777) === 0o600, 'explicit input must be regular 0600'); const bytes = await file.readFile(); return { value: JSON.parse(bytes), sha256: hash(bytes) } }
  finally { await file.close() }
}
function observeContext(previous, canaries, record) {
  assert.deepEqual(Object.keys(canaries).sort(), pairs.map(pair => pair.key).sort())
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url)
    if (url.hostname === 'zenmux.ai' && url.pathname === '/api/v1/chat/completions') {
      const body = await request.clone().json(), text = JSON.stringify(body.messages ?? []), current = JSON.stringify(body.messages?.findLast(value => value.role === 'user') ?? {})
      assert.equal(body.model, model, 'unexpected model route')
      const tools = (body.tools ?? []).map(value => value.function?.name ?? value.name)
      assert(tools.every(name => /^geneway_work_(create|continue|follow_up|status|stop)$/.test(name)), 'chat exposes a non-product or write tool')
      record({ pid: process.pid, model: body.model, labels: [...new Set(current.match(/P4_[A-Z_]+/g) ?? [])], canaries: Object.fromEntries(Object.entries(canaries).map(([key, value]) => [key, text.includes(value)])), tools })
    }
    return previous(input, init)
  }
}
function assertComplete(steps) {
  for (const id of requiredSteps) assert.equal(steps.filter(step => step.id === id && step.result === 'passed').length, 1, 'required journey did not pass: ' + id)
  assert.equal(steps.length, requiredSteps.length, 'unexpected or duplicate journey step')
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function within(parent, child) { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
async function jsonLines(file) { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]) }
function safeFailure(error) { return String(error?.code ?? error?.name ?? 'ACCEPTANCE_FAILED') + ': ' + String(error?.message ?? error).split('\n')[0].replace(/Bearer\s+\S+|(?:sk|sk-zm)-[A-Za-z0-9_-]+/gi, '[已隐藏]') }
function pause(ms) { return new Promise(resolvePause => setTimeout(resolvePause, ms)) }
