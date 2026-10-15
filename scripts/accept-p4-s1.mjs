import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const model = 'deepseek/deepseek-v4.1-flash'
const agentIds = { private: 's1-private-agent', shared: 's1-shared-agent' }
const instructionMarkers = { old: '【执行指令甲】', next: '【执行指令乙】' }
const skillId = 'skill-cycle-time-calculate'
const active = ['accepted', 'running']
const steps = [
  ['private-agent', '管理员创建仅向 A 开放的员工', 'admin', '后台 → 员工 → 新建员工', '员工仅向成员 A 开放。'],
  ['shared-agent-mobile', '手机后台创建公共员工', 'admin', '390×844 后台 → 员工 → 新建员工', '公共员工同时向 A、B 开放，页面没有横向溢出。'],
  ['a-private-chat', 'A 使用专属员工', 'a', '我的对话 → 新建对话 → 发送', 'A 能创建对话并取得真实模型回复。'],
  ['a-shared-chat', 'A 在公共员工会话发送验收代号', 'a', '我的对话 → 新建对话 → 发送', '回复包含 A 的验收代号，请求上下文不含 B 的代号。'],
  ['a-clean-context', 'A 新建第二个公共员工会话', 'a', '我的对话 → 新建对话 → 发送', '新会话请求不含 A、B 之前的验收代号。'],
  ['b-isolation', 'B 只能选择获准员工', 'b', '我的对话 → 对话员工', 'B 看不到专属员工，直接 API 也不能使用它。'],
  ['b-shared-chat', 'B 在公共员工会话发送不同代号', 'b', '我的对话 → 新建对话 → 发送', 'B 的真实回复和请求上下文不含 A 的代号。'],
  ['b-clean-context', 'B 新建第二个公共员工会话', 'b', '我的对话 → 新建对话 → 发送', 'B 的新会话请求不含 A、B 之前的验收代号。'],
  ['instruction-freeze', '编辑指令时保留正在执行的定义', 'admin', 'A 发出长回复后，后台保存新指令', '保存时旧回复仍在运行，完成的回复使用指令甲。'],
  ['instruction-next-turn', '新回复采用新指令', 'a', '原公共员工对话 → 发送', '新请求和回复使用指令乙。'],
  ['authorization-change', '撤权立即生效且无需重新登录', 'a', '后台移出 A → A 刷新对话', 'A 登录仍有效，旧历史只读，新派发被拒；加回后恢复可用。'],
  ['related-works', '同一对话中的工作独立停止', 'a', '在此对话交办工作 → 关联工作 → 停止本次', 'W1 已停止，W2 不被停止且完成正确节拍计算。'],
  ['known-id-isolation', '已知标识不能绕过正文权限', 'b', 'B 与管理员登录入口及直接 API 负例', '对话、工作、原生标识、历史和导出均不能取得 A 正文。'],
  ['restart-history', '重启后恢复本人历史和关联', 'a', '中断本轮隔离服务 → 重启 → 我的对话', '活动回复变为中断，已完成历史、对话谱系和关联工作保留。'],
  ['mobile-chat', '手机新建对话、发送并读取历史', 'a', '390×844 我的对话 → 新建 → 发送 → 刷新历史', '真实回复可读，历史状态可用，手机没有横向溢出。'],
  ['mobile-stop', '手机停止本次回复并归档', 'a', '发送 → 停止本次回复 → 归档对话', '本次回复已停止，既有回复保留，归档后只读。'],
].map(([id, title, actor, control, expected]) => ({ id, title, actor, control, expected }))

// The preload observes only this isolated server's synthetic chat markers, never message bodies or credentials.
if (process.env.GENEWAY_S1_OBSERVER === '1' && resolve(process.argv[1] ?? '') === join(root, 'src/server.mjs')) {
  const logfile = process.env.GENEWAY_S1_CONTEXT_AUDIT_LOG
  assert(logfile && isAbsolute(logfile), 'S1 context audit requires its own absolute log path')
  globalThis.fetch = contextObserver(globalThis.fetch, {
    a: process.env.GENEWAY_S1_CANARY_A,
    b: process.env.GENEWAY_S1_CANARY_B,
  }, value => appendFileSync(logfile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }))
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = argumentsFor(process.argv.slice(2))
  if (options.help) console.log(usage())
  else if (options['harness-check']) await harnessCheck()
  else await acceptance(options)
}

export { command, connect, firstLine, freePort, interruptHandlers, networkAudit, poll, recordingCoverage, runCleanup, stop, systemEnvironment, watchRecording }

function argumentsFor(args) {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, 'harness-check': { type: 'boolean' }, run: { type: 'boolean' }, output: { type: 'string' }, 'network-guard': { type: 'string' } } })
  if (!args.length) return { help: true }
  assert([values.help, values['harness-check'], values.run].filter(Boolean).length === 1, 'choose exactly one of --help, --harness-check, --run')
  if (values.run) {
    assert(values.output && values['network-guard'], '--run requires --output <new-directory> and --network-guard <approved-guard.mjs>')
    values.output = resolve(values.output)
    values['network-guard'] = resolve(values['network-guard'])
    assert(!within(root, values.output), 'acceptance artifacts must stay outside the shared repository')
  } else assert(!values.output && !values['network-guard'], 'output and network guard apply only to --run')
  return values
}

function usage() {
  return `P4-S1 独立验收（真实执行须先由 controller 明确准许）\n\n纯检查：\n  node scripts/accept-p4-s1.mjs --harness-check\n\n获准后执行：\n  node scripts/accept-p4-s1.mjs --run --output /tmp/geneway-p4-s1-<本次编号> --network-guard <已批准的 guard-real.mjs>\n\n只使用本轮隔离账号、产品状态、DSH_HOME 和 Chrome profile。真实外发仅为 ZenMux ${model}；无业务连接或真实渠道。产物为 p4-s1.mp4、index.html 与 observations.json；本脚本不发送 Lark。`
}

async function acceptance(options) {
  const output = options.output
  await access(options['network-guard'])
  const metadata = await stat(join(root, 'var/secrets/zenmux-p4-model.key'))
  assert(metadata.isFile() && (metadata.mode & 0o077) === 0, 'the approved model credential must be a private regular file')
  await mkdir(output, { mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-s1-runtime-'))
  await chmod(scratch, 0o700)
  const stateFile = join(scratch, 'state.json'), authFile = join(scratch, 'auth.json'), dshHome = join(scratch, 'dsh')
  const auditFile = join(scratch, 'network-audit.jsonl'), contextFile = join(scratch, 'chat-context.jsonl')
  const canaries = { a: `MEMBER_A_${randomBytes(10).toString('hex')}`, b: `MEMBER_B_${randomBytes(10).toString('hex')}` }
  const passwords = Object.fromEntries(['admin', 'a', 'b'].map(id => [id, randomBytes(24).toString('base64url')]))
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  const candidate = await candidateState(), guardSha256 = hash(await readFile(options['network-guard'])), children = [], browsers = {}, sessions = {}, observations = [], apiChecks = new Map()
  const auditBinding = { runId: 'p4-s1-' + randomBytes(12).toString('hex'), candidate: hash(JSON.stringify(candidate)), guardSha256 }
  const serverEnv = runtimeEnvironment({ scratch, stateFile, authFile, dshHome, origin, auditFile, contextFile, canaries, guard: options['network-guard'], auditBinding })
  let server, xvfb, recorder, recording, display, recordingAt, stoppedAt, failure, report, restarting = false
  const abort = new AbortController()
  let settleOperation
  const operationSettled = new Promise(resolveSettled => { settleOperation = resolveSettled })
  const cleanup = runCleanup({ children, browsers, recording: () => recording, operationSettled,
    removeAuth: () => rm(authFile, { force: true }), onFailure: error => { failure ??= error },
  })
  const interrupts = interruptHandlers(process, (signal, force) => {
    failRun(new Error(`acceptance interrupted by ${signal}`))
    void cleanup.run(force)
  })
  const caption = join(scratch, 'caption.txt'), video = join(output, 'p4-s1.mp4')
  const refs = {}, turns = {}
  try {
    // Importing product modules happens only after the explicit --run boundary.
    const { createFileStore } = await import('../src/store/file-store.mjs')
    const { initializeAuthFile } = await import('../src/auth.mjs')
    const store = createFileStore(stateFile), now = new Date().toISOString()
    await store.update(state => ({ ...state,
      members: ['admin', 'a', 'b'].map(id => ({ id, loginName: id, displayName: id === 'admin' ? '验收管理员' : `验收成员 ${id.toUpperCase()}`, role: id === 'admin' ? 'admin' : 'member', enabled: true, authRef: id, employeeIds: [], sessionVersion: 1, createdAt: now, updatedAt: now })),
      modelRoutes: [{ id: 's1-model', provider: 'zenmux', model, displayName: 'ZenMux DeepSeek V4.1 Flash', enabled: true, credentialRef: 'ZENMUX_API_KEY' }],
      skills: [{ id: skillId, name: '节拍换算', capabilityId: 'cycle-time-calculate', enabled: true }],
    }))
    await initializeAuthFile(authFile, passwords)
    abort.signal.throwIfAborted()
    await writeFile(join(scratch, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
    server = await bootServer()
    xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x980x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    display = ':' + (await firstLine(xvfb.stdio[3], xvfb)).trim()
    assert(/^:\d+$/.test(display), 'Xvfb did not allocate a private display')
    for (const actor of ['admin', 'a', 'b']) {
      browsers[actor] = await browser(actor)
      sessions[actor] = await apiLogin(actor)
    }
    browsers.aWork = await browser('a', 'a-work')
    await writeFile(caption, 'P4-S1 Web：后台员工与成员会话；渠道为模拟验收', { mode: 0o600 })
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
    await access(font)
    recorder = launch('ffmpeg', ['-n', '-f', 'x11grab', '-framerate', '20', '-video_size', '1440x980', '-i', `${display}.0`, '-vf', `pad=iw:ih+80:0:0:color=0x111827,drawtext=fontfile=${font}:textfile=${caption}:reload=1:fontcolor=white:fontsize=24:x=20:y=h-54`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] })
    recording = watchRecording(recorder, failRun)
    recordingAt = recording.state.startedAt
    await pause(500)
    recording.assertRunning()

    await step('private-agent', 'admin', async page => {
      await page.nav('admin'); await page.click('#tab-employees')
      await createAgent(page, agentIds.private, 'A 专属员工', ['a'])
      const employees = (await api('admin', '/api/admin/employees')).body
      assert.deepEqual(employees.find(item => item.id === agentIds.private).memberIds, ['a'])
    })
    await step('shared-agent-mobile', 'admin', async page => {
      await page.viewport(390, 844)
      await createAgent(page, agentIds.shared, '公共员工', ['a', 'b'])
      assert.deepEqual((await api('admin', '/api/admin/employees')).body.find(item => item.id === agentIds.shared).memberIds.sort(), ['a', 'b'])
      await page.noOverflow()
    })
    await browsers.admin.viewport(1440, 900)
    await step('a-private-chat', 'a', async page => {
      refs.private = await createConversation(page, agentIds.private, 'A 的专属对话')
      turns.private = await send(page, refs.private, 'S1_PRIVATE_CHAT 请用一句话介绍你能如何帮助整理工作。')
      assert((await completed(refs.private, turns.private)).assistantText)
    })
    await step('a-shared-chat', 'a', async page => {
      refs.a = await createConversation(page, agentIds.shared, 'A 的公共员工对话')
      turns.a = await send(page, refs.a, `S1_A_FIRST 本对话的验收代号是 ${canaries.a}，请原样复述该代号。`)
      const turn = await completed(refs.a, turns.a)
      assert(turn.assistantText.includes(canaries.a)); assert(!turn.assistantText.includes(canaries.b))
      await context('S1_A_FIRST', { hasA: true, hasB: false })
    })
    await step('a-clean-context', 'a', async page => {
      refs.a2 = await createConversation(page, agentIds.shared, 'A 的第二个对话')
      const id = await send(page, refs.a2, 'S1_A_CLEAN 如果本对话之前的消息中有验收代号，请复述；没有则回复“当前对话未提供代号”。')
      const turn = await completed(refs.a2, id)
      assert(!turn.assistantText.includes(canaries.a)); assert(!turn.assistantText.includes(canaries.b))
      await context('S1_A_CLEAN', { hasA: false, hasB: false })
    })
    await step('b-isolation', 'b', async page => {
      await page.nav('conversations'); await page.click('#reload-conversations')
      await page.wait(`document.querySelector('#conversation-employee option[value="${agentIds.shared}"]')`)
      assert.equal(await page.evaluate(`Boolean(document.querySelector('#conversation-employee option[value="${agentIds.private}"]'))`), false)
      const result = await api('b', '/api/conversations', 'POST', { employeeId: agentIds.private, title: '不得创建' })
      assert([403, 404].includes(result.status))
    })
    await step('b-shared-chat', 'b', async page => {
      refs.b = await createConversation(page, agentIds.shared, 'B 的公共员工对话')
      turns.b = await send(page, refs.b, `S1_B_FIRST 本对话的验收代号是 ${canaries.b}，请原样复述该代号。`)
      const turn = await completed(refs.b, turns.b, 'b')
      assert(turn.assistantText.includes(canaries.b)); assert(!turn.assistantText.includes(canaries.a))
      await context('S1_B_FIRST', { hasA: false, hasB: true })
    })
    await step('b-clean-context', 'b', async page => {
      refs.b2 = await createConversation(page, agentIds.shared, 'B 的第二个对话')
      const id = await send(page, refs.b2, 'S1_B_CLEAN 如果本对话之前的消息中有验收代号，请复述；没有则回复“当前对话未提供代号”。')
      const turn = await completed(refs.b2, id, 'b')
      assert(!turn.assistantText.includes(canaries.a)); assert(!turn.assistantText.includes(canaries.b))
      await context('S1_B_CLEAN', { hasA: false, hasB: false })
    })
    await step('instruction-freeze', 'admin', async page => {
      await open(browsers.a, refs.a)
      turns.freeze = await send(browsers.a, refs.a, 'S1_INSTRUCTION_FREEZE 请连续写一篇约四千字的制造业协作培训说明，开头保留当前执行指令标记。')
      assert(active.includes((await detail(refs.a)).turns.find(item => item.id === turns.freeze).status), 'the old turn must still be active before editing')
      const frozenDefinition = (await store.read()).conversations.find(item => item.id === refs.a).turns.find(item => item.id === turns.freeze).definition
      assert.equal(frozenDefinition.instructions, instructions(instructionMarkers.old))
      await page.front(); await page.nav('admin'); await page.click('#tab-employees')
      const form = employeeForm(agentIds.shared)
      await page.fill(`${form} [name="instructions"]`, instructions(instructionMarkers.next))
      await page.click(`${form} button[type="submit"],${form} button:not([type])`)
      await page.wait(`document.querySelector('#admin-message')?.innerText.includes('配置已保存')`)
      assert.equal((await api('admin', '/api/admin/employees')).body.find(item => item.id === agentIds.shared).instructions, instructions(instructionMarkers.next))
      assert(active.includes((await detail(refs.a)).turns.find(item => item.id === turns.freeze).status), 'the edit finished after the old turn; the in-flight case was not covered')
      await capture(page, '后台已保存指令乙，旧回复仍在运行')
      const turn = await completed(refs.a, turns.freeze)
      assert(turn.assistantText.includes(instructionMarkers.old)); assert(!turn.assistantText.includes(instructionMarkers.next))
      assert.deepEqual((await store.read()).conversations.find(item => item.id === refs.a).turns.find(item => item.id === turns.freeze).definition, frozenDefinition)
      await context('S1_INSTRUCTION_FREEZE', { oldInstruction: true, nextInstruction: false })
      await browsers.a.front(); await pause(500); await capture(browsers.a, '正在进行的回复按指令甲完成')
      await page.front()
    })
    await step('instruction-next-turn', 'a', async page => {
      await open(page, refs.a)
      const id = await send(page, refs.a, `S1_AFTER_EDIT 当前执行指令已更新，本轮验收代号重新提供为 ${canaries.a}。请用一句话复述该代号并保留当前指令标记。`)
      const turn = await completed(refs.a, id)
      assert(turn.assistantText.includes(instructionMarkers.next)); assert(!turn.assistantText.includes(instructionMarkers.old))
      assert(turn.assistantText.includes(canaries.a))
      await context('S1_AFTER_EDIT', { hasA: true, hasB: false, nextInstruction: true })
    })
    await step('authorization-change', 'a', async page => {
      await open(page, refs.private)
      const beforeLoginPosts = page.loginPosts()
      await setPrivateAccess(false)
      await page.front(); await page.click('#reload-conversations'); await page.click('#refresh-conversation')
      await page.wait(`document.querySelector('#conversation-read-only')?.innerText.includes('使用权限')`)
      assert.equal((await api('a', '/api/session')).status, 200)
      assert.equal((await detail(refs.private)).readOnlyReason, 'AGENT_ACCESS_REVOKED')
      assert([403, 404, 409].includes((await api('a', conversationPath(refs.private) + '/turns', 'POST', { text: '撤权后不得派发', clientRequestId: 's1-revoked-turn' })).status))
      assert.equal(await page.evaluate(`Boolean(document.querySelector('#send-conversation-turn')?.disabled)`), true)
      assert.equal(page.loginPosts(), beforeLoginPosts)
      await setPrivateAccess(true)
      await page.front(); await page.click('#reload-conversations'); await page.click('#refresh-conversation')
      await page.wait(`document.querySelector('#conversation-read-only')?.classList.contains('hidden')`)
      assert.equal((await api('a', '/api/session')).status, 200)
      assert.equal(page.loginPosts(), beforeLoginPosts)
    })
    await step('related-works', 'a', async page => {
      await open(page, refs.a)
      await prepareWork(page, 'W1 节拍计算', '601')
      await open(browsers.aWork, refs.a)
      await prepareWork(browsers.aWork, 'W2 节拍计算', '600')
      refs.w1 = await submitWork(page, 'W1 节拍计算')
      refs.w2 = await submitWork(browsers.aWork, 'W2 节拍计算')
      const w1 = (await api('a', '/api/works/' + encodeURIComponent(refs.w1))).body
      const beforeW2 = (await api('a', '/api/works/' + encodeURIComponent(refs.w2))).body
      assert.equal(w1.conversationId, refs.a)
      assert(active.includes(w1.status), 'W1 finished before the stop; the running cancellation case was not covered')
      assert(active.includes(beforeW2.status), 'W2 finished before the W1 stop; concurrent independent execution was not covered')
      await page.front()
      await page.click('#cancel-work')
      await poll(async () => (await api('a', '/api/works/' + encodeURIComponent(refs.w1))).body.status === 'cancelled', 'W1 cancellation')
      const w2 = await poll(async () => {
        const work = (await api('a', '/api/works/' + encodeURIComponent(refs.w2))).body
        assert.notEqual(work.status, 'cancelled', 'stopping W1 cancelled W2')
        assert.notEqual(work.status, 'failed', 'W2 failed')
        return work.status === 'completed' ? work : false
      }, 'W2 real model completion', 180_000)
      assert.equal(w2.conversationId, refs.a)
      assert.equal(w2.results.find(result => result.kind === 'manufacturing.takt').payload.secondsPerUnit, 60)
      await open(page, refs.a)
      await page.wait(`document.querySelectorAll('[data-conversation-work]').length===2`)
    })
    await step('known-id-isolation', 'b', async page => {
      const nativeIds = nativeReferences((await store.read()).conversations.find(item => item.id === refs.a))
      assert(nativeIds.length, 'the owned conversation has no native Session lineage')
      for (const actor of ['admin', 'b']) {
        for (const [path, method, body] of [
          [conversationPath(refs.a), 'GET'],
          [conversationPath(refs.a), 'PATCH', { title: '不得修改' }],
          [conversationPath(refs.a) + '/turns', 'POST', { text: '不得读取或继续', clientRequestId: `s1-known-id-${actor}` }],
          [conversationPath(refs.a) + '/turns/' + encodeURIComponent(turns.a) + '/cancel', 'POST', {}],
          ['/api/works/' + encodeURIComponent(refs.w2), 'GET'],
          ['/api/works/' + encodeURIComponent(refs.w2) + '/cancel', 'POST', {}],
          [conversationPath(refs.a) + '/history', 'GET'],
          [conversationPath(refs.a) + '/export', 'GET'],
          ['/api/sessions/' + encodeURIComponent(nativeIds[0]), 'GET'],
          [conversationPath(nativeIds[0]), 'GET'],
        ]) {
          const result = await api(actor, path, method, body)
          assert.equal(result.status, 404, `${actor} ${method} owned-object negative`)
          assert(!JSON.stringify(result.body).includes(canaries.a))
        }
        assert.equal((await api(actor, '/api/conversations', 'POST', { employeeId: agentIds.shared, nativeSessionId: nativeIds[0] })).status, 400)
        for (const path of ['/api/conversations?includeArchived=true', '/api/bootstrap', '/api/confirmations']) {
          const result = await api(actor, path)
          assert.equal(result.status, 200)
          assert(!JSON.stringify(result.body).includes(canaries.a)); assert(!JSON.stringify(result.body).includes(refs.a))
        }
        const searched = await api(actor, '/api/knowledge/search', 'POST', { employeeId: agentIds.shared, query: canaries.a })
        assert([200, 403, 404].includes(searched.status)); assert(!JSON.stringify(searched.body).includes(canaries.a))
      }
      await page.front(); await page.nav('conversations'); await page.click('#reload-conversations')
      assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-open-conversation="${refs.a}"]'))`), false)
    })
    await step('restart-history', 'a', async page => {
      await open(page, refs.a2)
      turns.interrupted = await send(page, refs.a2, 'S1_RESTART_INTERRUPT 请写一篇四千字的岗位培训说明。')
      await poll(async () => (await detail(refs.a2)).turns.find(item => item.id === turns.interrupted)?.status === 'running', 'running turn before restart')
      const before = nativeReferences((await store.read()).conversations.find(item => item.id === refs.a))
      restarting = true
      await stop(server, 'SIGKILL'); server = await bootServer()
      await page.send('Page.reload', { ignoreCache: true }); await page.wait(`!document.querySelector('#app')?.classList.contains('hidden')`)
      await open(page, refs.a2)
      await poll(async () => (await detail(refs.a2)).turns.find(item => item.id === turns.interrupted)?.status === 'interrupted', 'interrupted recovery')
      await open(page, refs.a); await page.click('#refresh-conversation')
      const history = await detail(refs.a)
      assert.equal(history.historyStatus, 'available')
      assert(history.turns.find(item => item.id === turns.a).assistantText.includes(canaries.a))
      assert.equal(history.relatedWorks.length, 2)
      assert.equal(hash(JSON.stringify(nativeReferences((await store.read()).conversations.find(item => item.id === refs.a)))), hash(JSON.stringify(before)), 'native Session lineage changed unexpectedly')
      const id = await send(page, refs.a, 'S1_AFTER_RESTART 请复述执行指令更新后重新提供的验收代号。')
      assert((await completed(refs.a, id)).assistantText.includes(canaries.a))
      await context('S1_AFTER_RESTART', { hasA: true, hasB: false, nextInstruction: true })
      restarting = false
    })
    await step('mobile-chat', 'a', async page => {
      await page.viewport(390, 844)
      refs.mobile = await createConversation(page, agentIds.shared, '手机验收对话')
      const id = await send(page, refs.mobile, 'S1_MOBILE_CHAT 请用一句话介绍如何查看当前对话历史。')
      assert((await completed(refs.mobile, id)).assistantText)
      await page.click('#refresh-conversation')
      await page.wait(`document.querySelector('#conversation-history-status')?.innerText==='历史已读取'`)
      await page.fill('#conversation-title-input', '手机对话历史'); await page.click('#rename-conversation')
      await page.wait(`document.querySelector('#conversation-title')?.innerText==='手机对话历史'`)
      await context('S1_MOBILE_CHAT', { hasA: false, hasB: false, nextInstruction: true })
      await page.noOverflow()
    })
    await step('mobile-stop', 'a', async page => {
      turns.mobile = await send(page, refs.mobile, 'S1_MOBILE_STOP 请连续写四千字的制造业培训材料。')
      await page.wait(`!document.querySelector('#stop-conversation-turn')?.disabled`)
      await page.click('#stop-conversation-turn')
      await poll(async () => (await detail(refs.mobile)).turns.find(item => item.id === turns.mobile)?.status === 'cancelled', 'mobile turn cancellation')
      await page.click('#refresh-conversation'); await page.click('#archive-conversation')
      await page.wait(`document.querySelector('#conversation-read-only')?.innerText.includes('已归档')`)
      assert.equal((await detail(refs.mobile)).readOnlyReason, 'CONVERSATION_ARCHIVED')
      assert((await detail(refs.mobile)).turns.some(item => item.status === 'completed' && item.assistantText))
      await page.noOverflow()
    })
    assert.deepEqual(await candidateState(abort.signal), candidate, 'product candidate changed during acceptance')
    assert.equal(hash(await readFile(options['network-guard'])), guardSha256, 'approved network guard changed during acceptance')
    assert.equal(observations.filter(item => item.result === 'passed').length, steps.length)
  } catch (error) {
    failure ??= error
  } finally {
    stoppedAt = Date.now()
    settleOperation()
    await cleanup.run()
    const network = await jsonLines(auditFile), chat = await jsonLines(contextFile)
    const finalState = await readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { failure ??= error; return { conversations: [] } })
    let audited = { ok: false, scope: 'selected-node-sdk-and-network-apis' }
    try { audited = networkAudit(network, { ...auditBinding, hostPids: children.filter(child => child.auditRole === 'host').map(child => child.pid), hostInterruptions: children.map(child => child.auditInterruption).filter(Boolean) }) }
    catch (error) { failure ??= error }
    report = {
      ok: !failure, dataMode: 'synthetic', sourceEnvironment: 'isolated-local', entrypoint: 'node src/server.mjs', candidate, model: { provider: 'zenmux', model, chatAuditPids: [...new Set(chat.map(item => item.pid))], chatRequests: chat.length, workChildAudit: audited.sdkChildren ?? [] },
      nativeLineage: Object.fromEntries((finalState.conversations ?? []).map(item => [item.id, nativeReferences(item).map(hash)])),
      scope: '渠道为模拟验收；本视频覆盖 S1 Web；无 GearJob、Hive、Kivo 或真实渠道连接。',
      steps: observations, incomplete: steps.filter(step => !observations.some(item => item.id === step.id && item.result === 'passed')).map(step => step.id),
      instrumentation: { ...auditBinding, scope: audited.scope, sdkLaunchCorrelationRequired: true, wholeMachineCoverage: false }, apiChecks: [...apiChecks.values()], network: { ...audited, pids: [...new Set(network.map(item => item.pid))], records: network.length, blocked: network.filter(item => item.permitted === false).length }, chatContext: chat,
      browser: Object.fromEntries(Object.entries(browsers).map(([actor, page]) => [actor, { viewport: page.size(), errors: page.errors, unexpectedResponses: page.responses.filter(item => item.status >= 500 && !item.duringRestart), loginPosts: page.loginPosts() }])),
      cancellation: { bothWorksActiveBeforeStop: observations.some(item => item.id === 'related-works' && item.result === 'passed'), w2SecondsPerUnit: refs.w2 && observations.some(item => item.id === 'related-works' && item.result === 'passed') ? 60 : null },
      media: { video: 'p4-s1.mp4', seconds: recordingAt ? (stoppedAt - recordingAt) / 1000 : 0, recorder: recording?.state ?? null },
      failure: failure ? safeFailure(failure, passwords) : null, cleanup: { ...cleanup.state, ...interrupts.state, privateRuntime: scratch, ownedPids: children.map(child => child.pid).filter(Number.isInteger) },
    }
    if (!failure && Object.values(report.browser).some(page => page.errors.length || page.unexpectedResponses.length)) {
      failure = new Error('unexpected browser errors or HTTP 5xx responses were observed'); report.ok = false; report.failure = failure.message
    }
    if (recordingAt) {
      try {
        await command('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], abort.signal)
        const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], abort.signal))
        const stream = probe.streams.find(item => item.codec_type === 'video')
        const coverage = recordingCoverage(recording.state, probe, observations)
        report.media = { ...report.media, ...coverage, codec: stream.codec_name, width: stream.width, height: stream.height, sha256: hash(await readFile(video)) }
      } catch (error) { failure ??= error; report.ok = false; report.failure = safeFailure(failure, passwords) }
    }
    try {
      let savedFailure
      do {
        savedFailure = failure
        report.ok = !failure; report.failure = failure ? safeFailure(failure, passwords) : null
        Object.assign(report.cleanup, cleanup.state, interrupts.state)
        await writeFile(join(output, 'index.html'), manual(report), { mode: 0o600 })
        await writeFile(join(output, 'observations.json'), JSON.stringify(report, (key, value) => key === 'image' ? undefined : value, 2) + '\n', { mode: 0o600 })
      } while (savedFailure !== failure)
    } catch (error) {
      failure ??= error; report.ok = false; report.failure = safeFailure(failure, passwords)
      await writeFile(join(output, 'observations.json'), JSON.stringify(report, (key, value) => key === 'image' ? undefined : value, 2) + '\n', { mode: 0o600 }).catch(() => undefined)
    } finally { interrupts.dispose() }
    console.log(JSON.stringify({ ok: report.ok, output, passed: observations.filter(item => item.result === 'passed').length, required: steps.length, privateRuntime: scratch, error: report.failure }, null, 2))
  }
  if (failure) process.exitCode ||= 1

  function failRun(error) {
    failure ??= error
    abort.abort(failure)
    void cleanup.run()
  }

  function launch(executable, args, extra = {}) {
    abort.signal.throwIfAborted()
    const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra })
    child.stderrText = ''; child.stderr?.on('data', chunk => { child.stderrText = (child.stderrText + chunk).slice(-3000) })
    child.on('error', error => { child.spawnError = error })
    children.push(child)
    return child
  }
  async function bootServer() {
    const child = launch(process.execPath, [join(root, 'src/server.mjs')], { env: serverEnv })
    child.auditRole = 'host'
    child.auditFile = auditFile; child.auditBinding = auditBinding
    await poll(async () => {
      abort.signal.throwIfAborted()
      if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server failed to start')
      try { return (await fetch(origin + '/', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })).status === 200 } catch { return false }
    }, 'isolated server startup', 30_000)
    return child
  }
  async function browser(actor, name = actor) {
    const debugPort = await freePort(), profile = join(scratch, 'chrome-' + name)
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false }, translate: { enabled: false } }), { mode: 0o600 })
    const child = launch('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--new-window', '--no-default-browser-check', '--ozone-platform=x11', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--hide-crash-restore-bubble', '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,930', '--window-position=0,0', `--app=${origin}`], { env: { ...systemEnvironment(), DISPLAY: display } })
    const target = await poll(async () => {
      abort.signal.throwIfAborted()
      if (child.spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('isolated Chrome exited before CDP startup')
      try { return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })).json()).find(item => item.type === 'page' && item.url.startsWith(origin)) } catch { return false }
    }, 'isolated Chrome CDP', 20_000)
    const page = await connect(target, () => restarting)
    page.actor = actor
    const front = page.front
    page.front = async () => {
      for (const other of Object.values(browsers).filter(other => other !== page)) {
        const window = await other.send('Browser.getWindowForTarget')
        await other.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: 1600, top: 0 } })
      }
      const { width, height } = page.size()
      const window = await page.send('Browser.getWindowForTarget')
      await page.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } })
      await front()
    }
    await page.viewport(1440, 900)
    await page.wait(`Boolean(document.querySelector('#login-name'))`)
    await page.fill('#login-name', actor); await page.fill('#login-password', passwords[actor]); await page.click('#login-button')
    await page.wait(`!document.querySelector('#app')?.classList.contains('hidden') && document.querySelector('#runtime-state')?.innerText.includes('已登录')`)
    return page
  }
  async function apiLogin(actor) {
    const result = await api(actor, '/api/session', 'POST', { loginName: actor, password: passwords[actor] })
    assert.equal(result.status, 200)
    return { cookie: result.cookie.split(';')[0], csrf: result.body.csrfToken }
  }
  async function api(actor, path, method = 'GET', body) {
    const session = sessions[actor], headers = { origin }
    if (session) { headers.cookie = session.cookie; headers['x-csrf-token'] = session.csrf }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })
    const text = await response.text(), result = { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') }
    if (path !== '/api/session') {
      const surface = apiSurface(path), key = `${actor}|${method}|${response.status}|${surface}`
      const check = apiChecks.get(key) ?? { actor, method, status: response.status, surface, count: 0 }
      check.count += 1; apiChecks.set(key, check)
    }
    return result
  }
  async function detail(id, actor = 'a') {
    const result = await api(actor, conversationPath(id)); assert.equal(result.status, 200)
    assertPublicConversation(result.body)
    return result.body
  }
  async function createAgent(page, id, name, members) {
    const form = employeeForm('')
    for (const [field, value] of Object.entries({ id, name, description: '本地合成验收员工', instructions: instructions(instructionMarkers.old) })) await page.fill(`${form} [name="${field}"]`, value)
    await page.select(`${form} [name="modelRouteId"]`, 's1-model')
    await page.check(`${form} [name="skillIds"][value="${skillId}"]`, true)
    for (const member of members) await page.check(`${form} [name="memberIds"][value="${member}"]`, true)
    await page.click(`${form} button:not([type]),${form} button[type="submit"]`)
    await page.wait(`Boolean(document.querySelector(${js(employeeForm(id))}))`)
  }
  async function createConversation(page, employee, title) {
    await page.nav('conversations'); await page.click('#reload-conversations')
    await page.wait(`Boolean(document.querySelector('#conversation-employee option[value="${employee}"]'))`)
    await page.select('#conversation-employee', employee); await page.fill('#conversation-new-title', title); await page.click('#create-conversation')
    await page.wait(`document.querySelector('#conversation-title')?.innerText===${js(title)}`)
    const id = await page.evaluate(`document.querySelector('#conversation-detail').dataset.conversationId`)
    assert.equal((await detail(id, page.actor ?? 'a')).historyStatus, 'empty')
    return id
  }
  async function send(page, id, text) {
    const actor = page.actor ?? 'a', before = (await detail(id, actor)).turns.map(item => item.id)
    await page.fill('#conversation-text', text); await page.click('#send-conversation-turn')
    return poll(async () => (await detail(id, actor)).turns.find(item => !before.includes(item.id))?.id, 'accepted product turn', 30_000)
  }
  async function completed(id, turnId, actor = 'a') {
    const turn = await poll(async () => {
      const item = (await detail(id, actor)).turns.find(item => item.id === turnId)
      if (!item || active.includes(item.status)) return false
      assert.equal(item.status, 'completed', 'real model turn did not complete')
      assert(item.assistantText, 'completed native history has no assistant text')
      return item
    }, 'real Flash reply', 180_000)
    await browsers[actor].wait(`document.querySelector('[data-conversation-turn="${turnId}"]')?.innerText.includes('已回复')`)
    return turn
  }
  async function open(page, id) {
    await page.front(); await page.nav('conversations'); await page.click('#reload-conversations')
    await page.wait(`Boolean(document.querySelector('[data-open-conversation="${id}"]'))`)
    await page.click(`[data-open-conversation="${id}"]`)
    await page.wait(`document.querySelector('#conversation-detail')?.dataset.conversationId===${js(id)}`)
  }
  async function context(label, expected) {
    const records = (await jsonLines(contextFile)).filter(item => item.currentLabels.includes(label))
    assert(records.length, `no actual Host model request observed for ${label}`)
    for (const record of records) for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `${label} ${key}`)
    assert(records.every(item => item.model === model && item.toolCount === 0), 'chat must use the fixed real route with no business tools')
  }
  async function setPrivateAccess(allowed) {
    const page = browsers.admin, form = employeeForm(agentIds.private)
    await page.front(); await page.nav('admin'); await page.click('#tab-employees')
    await page.check(`${form} [name="memberIds"][value="a"]`, allowed)
    await page.click(`${form} button:not([type]),${form} button[type="submit"]`)
    await poll(async () => (await api('admin', '/api/admin/employees')).body.find(item => item.id === agentIds.private).memberIds.includes('a') === allowed, 'employee access update')
  }
  async function prepareWork(page, goal, seconds) {
    await page.click('#conversation-new-work')
    await page.wait(`!document.querySelector('#work-conversation-context')?.classList.contains('hidden')`)
    await page.select('#work-skill', skillId); await page.fill('#work-goal', goal)
    await page.fill('#quantity', '10'); await page.fill('#available-seconds', seconds)
  }
  async function submitWork(page, goal) {
    await page.front()
    await page.click('#submit-work')
    await page.wait(`document.querySelector('#view-work')?.classList.contains('active')`)
    return poll(async () => (await api('a', '/api/bootstrap')).body.works.find(item => item.goal === goal)?.id, 'related product work')
  }
  async function step(id, actor, action) {
    abort.signal.throwIfAborted(); recording.assertRunning()
    const definition = steps.find(item => item.id === id), page = browsers[actor]
    const observation = { ...definition, startSeconds: (Date.now() - recordingAt) / 1000, result: 'running' }
    observations.push(observation)
    await writeFile(caption, `${observations.length}. ${definition.title}；${actor === 'admin' ? '管理员' : '成员 ' + actor.toUpperCase()}`, { mode: 0o600 })
    await page.front(); await pause(400)
    try { await action(page); await page.noOverflow(); recording.assertRunning(); observation.result = 'passed'; observation.observed = definition.expected }
    catch (error) { observation.result = 'failed'; observation.observed = safeFailure(error, passwords); throw error }
    finally {
      await pause(500)
      observation.endSeconds = (Date.now() - recordingAt) / 1000
      try { await capture(page, definition.title) }
      catch (error) {
        observation.captureError = safeFailure(error, passwords)
        if (observation.result === 'passed') { observation.result = 'failed'; observation.observed = '本步截图未能生成：' + observation.captureError; throw error }
      }
    }
  }
  async function capture(page, label) {
    const observation = observations.at(-1)
    observation.screenshots ??= []
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = `step-${String(observations.length).padStart(2, '0')}-${observation.screenshots.length + 1}.png`
    await writeFile(join(output, file), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
    observation.screenshots.push({ file, label, image: screenshot.data, seconds: (Date.now() - recordingAt) / 1000 })
  }
}

function systemEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]))
}
function runtimeEnvironment({ scratch, stateFile, authFile, dshHome, origin, auditFile, contextFile, canaries, guard, auditBinding }) {
  return { ...systemEnvironment(), DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED', GENEWAY_DSH_HOME: dshHome,
    GENEWAY_STATE: stateFile, GENEWAY_AUTH_FILE: authFile, GENEWAY_PORT: new URL(origin).port, GENEWAY_HOST: '127.0.0.1', GENEWAY_TRUSTED_ORIGIN: origin,
    GENEWAY_CONNECTION_CATALOG: join(scratch, 'connection-catalog.json'), GENEWAY_SECRET_ROOT: join(root, 'var/secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'zenmux-p4-model.key',
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href} --import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`,
    GENEWAY_NETWORK_AUDIT_RUN_ID: auditBinding.runId, GENEWAY_NETWORK_AUDIT_CANDIDATE: auditBinding.candidate, GENEWAY_NETWORK_AUDIT_LOG: auditFile, GENEWAY_NETWORK_AUDIT_ROLE: 'host',
    GENEWAY_S1_OBSERVER: '1', GENEWAY_S1_CONTEXT_AUDIT_LOG: contextFile, GENEWAY_S1_CANARY_A: canaries.a, GENEWAY_S1_CANARY_B: canaries.b,
  }
}

function contextObserver(previous, canaries, record) {
  assert(canaries.a && canaries.b, 'synthetic canaries are required')
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url)
    if (url.hostname === 'zenmux.ai' && url.pathname === '/api/v1/chat/completions') {
      const body = await request.clone().json(), messages = JSON.stringify(body.messages ?? [])
      const current = JSON.stringify(body.messages?.findLast(item => item.role === 'user') ?? {})
      record({ model: body.model, currentLabels: [...new Set(current.match(/S1_[A-Z_]+/g) ?? [])], messageCount: body.messages?.length ?? 0,
        hasA: messages.includes(canaries.a), hasB: messages.includes(canaries.b), oldInstruction: messages.includes(instructionMarkers.old), nextInstruction: messages.includes(instructionMarkers.next), toolCount: body.tools?.length ?? 0 })
    }
    return previous(input, init)
  }
}

async function connect(target, isRestarting) {
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), errors = [], responses = []
  let sequence = 0, width = 1440, height = 900, loginCount = 0
  await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const entry = pending.get(message.id); pending.delete(message.id)
      if (entry) { clearTimeout(entry.timeout); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result) }
    } else if (message.method === 'Runtime.exceptionThrown') errors.push({ kind: 'exception', text: message.params.exceptionDetails.text })
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error' && !isRestarting()) errors.push({ kind: 'console', text: message.params.args.map(item => item.value ?? item.description).join(' ') })
    else if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'POST' && new URL(message.params.request.url).pathname === '/api/session') loginCount += 1
    else if (message.method === 'Network.responseReceived') { const response = message.params.response; responses.push({ path: apiSurface(new URL(response.url).pathname), status: response.status, duringRestart: isRestarting() }) }
  })
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('isolated CDP socket closed')) } pending.clear() })
  const send = (method, params = {}) => new Promise((resolveResult, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('isolated CDP socket closed')); return }
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20_000)
    pending.set(id, { resolve: resolveResult, reject, timeout }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  }
  const page = {
    socket, send, evaluate, errors, responses, loginPosts: () => loginCount, size: () => ({ width, height }),
    front: async () => { await send('Page.bringToFront'); await send('Target.activateTarget', { targetId: target.id }) },
    wait: expression => poll(async () => evaluate(expression), 'visible state: ' + expression, 20_000),
    async viewport(nextWidth, nextHeight) {
      width = nextWidth; height = nextHeight
      const window = await send('Browser.getWindowForTarget')
      await send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal', left: width === 390 ? 525 : 0, top: 0, width, height: height + 30 } })
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 })
      await send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 })
      await pause(200)
    },
    async nav(view) { await page.click(`${width === 390 ? '.mobile-nav' : '.sidebar'} [data-view="${view}"]`); await page.wait(`document.querySelector('#view-${view}')?.classList.contains('active')`) },
    async click(selector) {
      let point
      for (let index = 0; index < 20; index += 1) {
        const box = await evaluate(`(()=>{const nodes=[...document.querySelectorAll(${js(selector)})];if(nodes.length!==1)throw new Error('expected one visible control: '+nodes.length);const node=nodes[0],r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,w:innerWidth,h:innerHeight,visible:r.width>0&&r.height>0,disabled:!!node.disabled,clickable:node.contains(hit)}})()`)
        assert(box.visible && !box.disabled, 'control hidden or disabled: ' + selector)
        if (box.clickable && box.x > 0 && box.x < box.w && box.y > 0 && box.y < box.h) { point = { x: box.x, y: box.y }; break }
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.min(box.w - 20, Math.max(20, box.x)), y: box.h / 2, deltaX: 0, deltaY: box.y - box.h / 2 })
        await pause(100)
      }
      assert(point, 'control cannot be reached by visible scrolling: ' + selector)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await pause(100)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    },
    async fill(selector, value) {
      await page.click(selector)
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
      await send('Input.insertText', { text: value })
      assert.equal(await evaluate(`document.querySelector(${js(selector)}).value`), value, 'typed field readback')
    },
    async check(selector, checked) { if (await evaluate(`document.querySelector(${js(selector)}).checked`) !== checked) await page.click(selector); assert.equal(await evaluate(`document.querySelector(${js(selector)}).checked`), checked) },
    async select(selector, value) {
      const options = await evaluate(`[...document.querySelector(${js(selector)}).options].map(option=>({value:option.value,disabled:option.disabled}))`)
      const index = options.findIndex(option => option.value === value && !option.disabled); assert(index >= 0, 'select option unavailable')
      await page.click(selector)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
      for (let at = 0; at < index; at += 1) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
      }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await page.wait(`document.querySelector(${js(selector)}).value===${js(value)}`)
    },
    async noOverflow() { const measured = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`); assert.equal(measured.width, width); assert(measured.scroll <= width + 1, 'horizontal overflow') },
  }
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await send(method)
  return page
}

function watchRecording(child, onFailure, now = Date.now) {
  const state = { pid: child.pid, startedAt: now(), stopRequestedAt: null, exitedAt: null, exitCode: null, signal: null, unexpectedExit: false }
  let failure, finishPromise
  const fail = error => { if (!failure) { failure = error; onFailure(error) } }
  const ended = new Promise(resolveEnded => {
    child.once('exit', (code, signal) => {
      Object.assign(state, { exitedAt: now(), exitCode: code, signal, unexpectedExit: state.stopRequestedAt === null })
      if (state.unexpectedExit) fail(new Error('recorder exited before the recording stop was requested'))
      else if (code !== 0 || signal !== null) fail(new Error('recorder did not exit normally after the recording stop'))
      resolveEnded()
    })
    child.once('error', error => { fail(error); resolveEnded() })
  })
  child.stdin?.on('error', fail)
  const assertRunning = () => {
    if (failure) throw failure
    assert(state.stopRequestedAt === null && child.exitCode === null && child.signalCode === null && !child.spawnError, 'recorder is not running')
  }
  return {
    state, assertRunning,
    finish() {
      finishPromise ??= Promise.resolve().then(async () => {
        assertRunning()
        state.stopRequestedAt = now()
        child.stdin.end('q\n')
        let timer
        const exited = await Promise.race([ended.then(() => true), new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), 10_000) })])
        clearTimeout(timer)
        if (!exited) fail(new Error('recorder did not finish within the recording stop timeout'))
        if (failure) throw failure
        return state
      })
      return finishPromise
    },
  }
}

function recordingCoverage(recording, probe, observations) {
  assert(recording.stopRequestedAt !== null && recording.exitedAt !== null && !recording.unexpectedExit, 'recording did not cover a normally closed window')
  assert(recording.exitCode === 0 && recording.signal === null, 'recording did not exit normally')
  const video = probe.streams.find(stream => stream.codec_type === 'video')
  assert.equal(video?.codec_name, 'h264')
  const duration = Math.min(Number(probe.format.duration), Number(video.duration))
  const expectedCoverageSeconds = Math.max((recording.stopRequestedAt - recording.startedAt) / 1000, ...observations.flatMap(step => [step.endSeconds ?? 0, ...(step.screenshots ?? []).map(shot => shot.seconds ?? 0)]))
  const coverageToleranceSeconds = 0.75
  assert(Number.isFinite(duration) && duration > 1, 'recording duration is unavailable or too short')
  assert(duration + coverageToleranceSeconds >= expectedCoverageSeconds, 'recording does not cover the final operation and screenshot')
  return { duration, expectedCoverageSeconds, coverageToleranceSeconds }
}

function networkAudit(rows, { runId, candidate, guardSha256, hostPids, hostInterruptions = [] }) {
  assert(rows.length && hostPids.length && hostPids.every(pid => Number.isInteger(pid) && pid > 0), 'network audit has no owned Host')
  for (const row of rows) {
    assert(row.runId === runId && row.candidate === candidate && row.guardSha256 === guardSha256, 'network audit binding differs')
    assert(Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid) && row.ppid > 0, 'network audit PID is invalid')
    assert(['host', 'sdk'].includes(row.role), 'network audit role is invalid')
    assert(row.permitted !== false && !row.sessionLogAttached && !row.credentialInPayload, 'network audit recorded a blocked or unsafe request')
    if (row.kind === 'fetch' && row.host === 'zenmux.ai') assert(row.model === model && row.permitted === true && !row.unexpectedBodyFields, 'model audit route or fields differ')
    if (row.role === 'host') assert(hostPids.includes(row.pid), 'network audit Host is not owned by this run')
  }
  const interruptions = new Map(), hosts = []
  for (const evidence of hostInterruptions) {
    assert(evidence.runId === runId && evidence.candidate === candidate && evidence.guardSha256 === guardSha256, 'Host interruption binding differs')
    assert(hostPids.includes(evidence.pid) && evidence.processGroupId === evidence.pid && !interruptions.has(evidence.pid), 'Host interruption ownership is invalid')
    assert(evidence.requestedSignal === 'SIGKILL' && evidence.signalDelivered === true && evidence.observedExitCode === null && evidence.observedSignal === 'SIGKILL', 'Host interruption lacks the observed requested SIGKILL')
    assert(evidence.pidExited === true && evidence.groupExited === true, 'interrupted Host PID or owned process group remains')
    assert(Number.isInteger(evidence.auditRowsBeforeSignal) && evidence.auditRowsBeforeSignal > 0 && evidence.auditRowsBeforeSignal <= rows.length, 'Host interruption audit boundary is invalid')
    assert(Number.isFinite(evidence.requestedAt) && evidence.observedExitAt >= evidence.requestedAt && evidence.checkedAt >= evidence.observedExitAt, 'Host interruption observation times are invalid')
    const before = rows.slice(0, evidence.auditRowsBeforeSignal)
    assert(before.some(row => row.kind === 'guard-ready' && row.role === 'host' && row.pid === evidence.pid), 'Host interruption precedes its guard readiness')
    const pids = before.filter(row => row.kind === 'sdk-spawn' && row.role === 'host' && row.pid === evidence.pid && row.parentPid === evidence.pid).map(row => row.childPid).sort((a, b) => a - b)
    assert.deepEqual([...evidence.sdkPidsExited].sort((a, b) => a - b), pids, 'Host interruption did not verify the exact prior SDK PIDs')
    interruptions.set(evidence.pid, evidence)
  }
  for (const pid of hostPids) {
    const own = rows.filter(row => row.role === 'host' && row.pid === pid)
    assert.equal(own.filter(row => row.kind === 'guard-ready').length, 1, 'Host guard readiness missing or duplicated')
    const exited = own.filter(row => row.kind === 'process-exit'), interruption = interruptions.get(pid)
    if (interruption) {
      assert.equal(exited.length, 0, 'interrupted Host must not be presented as a normal guard exit')
      hosts.push({ pid, outcome: 'harness-observed-SIGKILL', interruption })
    } else {
      assert.equal(exited.length, 1, 'Host process exit audit missing or duplicated')
      assert.equal(exited[0].code, 0, 'owned Host did not exit normally')
      hosts.push({ pid, outcome: 'normal-guard-exit', exitCode: exited[0].code })
    }
  }
  const sdkChildren = [], spawns = rows.filter(row => row.kind === 'sdk-spawn')
  assert(spawns.length, 'no actual SDK work launch was audited')
  for (const spawn of spawns) {
    assert(spawn.role === 'host' && spawn.parentPid === spawn.pid && Number.isInteger(spawn.childPid) && spawn.childPid > 0, 'SDK spawn ownership is invalid')
    assert.equal(spawns.filter(row => row.childPid === spawn.childPid).length, 1, 'SDK child PID was reused in the audit')
    const child = rows.filter(row => row.role === 'sdk' && row.pid === spawn.childPid)
    assert(child.every(row => row.ppid === spawn.parentPid), 'SDK child parent differs from its launch')
    const exits = rows.filter(row => row.kind === 'sdk-exit' && row.role === 'host' && row.pid === spawn.parentPid && row.parentPid === spawn.parentPid && row.childPid === spawn.childPid)
    const interruption = interruptions.get(spawn.parentPid)
    const groupInterrupted = exits.length === 0 && interruption && rows.indexOf(spawn) < interruption.auditRowsBeforeSignal && interruption.sdkPidsExited.includes(spawn.childPid)
    assert(exits.length === 1 || groupInterrupted, 'SDK parent exit correlation missing or duplicated')
    const exited = exits[0]
    if (exited) assert(Number.isInteger(exited.code) && exited.signal === null || exited.code === null && typeof exited.signal === 'string', 'SDK exit status is invalid')
    const ready = child.filter(row => row.kind === 'guard-ready')
    const fetches = child.filter(row => row.kind === 'fetch' && row.host === 'zenmux.ai')
    const failedBeforeReady = ready.length === 0 && child.length === 0 && exited && (Number.isInteger(exited.code) && exited.code !== 0 || exited.signal !== null)
    assert(ready.length === 1 || failedBeforeReady, 'SDK guard readiness missing or duplicated')
    assert(!fetches.length || ready.length === 1, 'SDK model request lacks guard readiness')
    sdkChildren.push({ parentPid: spawn.parentPid, pid: spawn.childPid, ready: ready.length === 1, modelFetches: fetches.length, parentExitObserved: Boolean(exited), exitCode: exited?.code ?? null, signal: exited?.signal ?? null,
      exitEvidence: groupInterrupted ? 'harness-observed-parent-and-owned-group-SIGKILL' : 'Host-guard-sdk-exit', outcome: failedBeforeReady ? 'failed-before-ready' : fetches.length ? 'model-request-observed' : 'no-model-request-observed' })
  }
  assert(rows.filter(row => row.role === 'sdk').every(row => spawns.some(spawn => spawn.childPid === row.pid && spawn.parentPid === row.ppid)), 'SDK audit row has no owned launch')
  assert(rows.filter(row => row.kind === 'sdk-exit').every(row => spawns.some(spawn => spawn.parentPid === row.pid && spawn.childPid === row.childPid)), 'SDK exit has no owned launch')
  assert(sdkChildren.some(child => child.modelFetches > 0), 'no actual SDK work model request was audited')
  return { ok: true, scope: 'selected-node-sdk-and-network-apis', hostPids, hosts, hostModelFetches: rows.filter(row => row.role === 'host' && row.kind === 'fetch' && row.host === 'zenmux.ai').length, sdkChildren,
    limitation: 'Only selected Node Host/SDK launch and network APIs; not whole-machine or other subprocess coverage' }
}

function interruptHandlers(host, interrupt) {
  const state = { interruptedBy: null, forced: false }
  let count = 0
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    if (count >= 2) return
    count += 1; state.interruptedBy ??= signal; state.forced = count === 2
    host.exitCode = state.interruptedBy === 'SIGINT' ? 130 : 143
    interrupt(state.interruptedBy, state.forced)
  }]))
  for (const [signal, handler] of Object.entries(handlers)) host.on(signal, handler)
  return { state, dispose() { for (const [signal, handler] of Object.entries(handlers)) host.removeListener(signal, handler) } }
}

function runCleanup({ children, browsers, recording, operationSettled, removeAuth, onFailure, stopChild = stop }) {
  const state = { authRemoved: false, allOwnedProcessesExited: false }
  let promise, forced = false
  return {
    state,
    run(force = false) {
      promise ??= Promise.resolve().then(async () => {
        try { await recording()?.finish() } catch (error) { onFailure(error) }
        for (const page of Object.values(browsers)) { try { page.socket.close() } catch (error) { onFailure(error) } }
        const stopped = await Promise.allSettled([...children].reverse().map(child => stopChild(child)))
        for (const result of stopped) if (result.status === 'rejected') onFailure(result.reason)
        // An in-flight auth initializer must finish before its file is removed.
        await operationSettled
        try { await removeAuth(); state.authRemoved = true } catch (error) { onFailure(error) }
        state.allOwnedProcessesExited = children.every(child => !child.pid || child.exitCode !== null || child.signalCode !== null)
        if (!state.allOwnedProcessesExited) onFailure(new Error('owned acceptance processes remain alive after cleanup'))
      })
      if (force && !forced) {
        forced = true
        for (const child of children) void Promise.resolve().then(() => stopChild(child, 'SIGKILL')).catch(onFailure)
      }
      return promise
    },
  }
}

async function candidateState(signal) {
  const files = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'web', 'plugins', 'config', 'package.json', 'pnpm-lock.yaml', 'scripts/accept-p4-s1.mjs'], signal)).split('\0').filter(Boolean).sort()
  return { head: (await command('git', ['rev-parse', 'HEAD'], signal)).trim(), files: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))]))) }
}
async function command(executable, args, signal) {
  signal?.throwIfAborted()
  const child = spawn(executable, args, { cwd: root, env: systemEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], signal })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  assert.equal(code, 0, `${executable} failed: ${stderr}`)
  return stdout
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) return
  const interruption = child.auditRole === 'host' && signal === 'SIGKILL' ? {
    ...child.auditBinding, pid: child.pid, processGroupId: child.pid, requestedSignal: signal,
    auditRowsBeforeSignal: 0, sdkPidsExited: [],
  } : null
  let priorSdkPids = []
  if (interruption) {
    const rows = await jsonLines(child.auditFile)
    interruption.auditRowsBeforeSignal = rows.length
    priorSdkPids = rows.filter(row => row.kind === 'sdk-spawn' && row.role === 'host' && row.pid === child.pid && row.parentPid === child.pid).map(row => row.childPid)
    assert(child.exitCode === null && child.signalCode === null, 'Host exited before its hard-restart signal')
  }
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  let delivered = false
  if (interruption) interruption.requestedAt = Date.now()
  try { delivered = process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  let timeout
  const completed = await Promise.race([exited.then(() => true), new Promise(resolveTimeout => { timeout = setTimeout(() => resolveTimeout(false), 10_000) })])
  clearTimeout(timeout)
  if (!completed) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } await exited }
  if (interruption) {
    Object.assign(interruption, { signalDelivered: delivered, observedExitCode: child.exitCode, observedSignal: child.signalCode, observedExitAt: Date.now() })
    assert(delivered && child.exitCode === null && child.signalCode === 'SIGKILL', 'hard restart did not observe its requested Host SIGKILL')
    const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
    await poll(() => [child.pid, -child.pid, ...priorSdkPids].every(gone), 'interrupted owned Host group and SDK PID exit', 10_000)
    Object.assign(interruption, { pidExited: true, groupExited: true, sdkPidsExited: priorSdkPids, checkedAt: Date.now() })
    child.auditInterruption = interruption
  }
}
async function firstLine(stream, child) {
  let text = ''
  return poll(async () => {
    if (child.spawnError || child.exitCode !== null) throw new Error('Xvfb exited before display allocation')
    text += stream.read()?.toString() ?? ''
    return text.includes('\n') ? text.split('\n')[0] : false
  }, 'private Xvfb display', 10_000)
}
async function freePort() {
  const server = createServer(); await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port; await new Promise(resolveClose => server.close(resolveClose)); return port
}
async function poll(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100) }
  throw new Error('wait timed out: ' + label)
}
async function jsonLines(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
function nativeReferences(conversation) {
  return [...new Set((conversation?.sessions ?? []).map(session => session.id))].sort()
}
function assertPublicConversation(value) {
  const serialized = JSON.stringify(value)
  assert(!/"(?:dshSessionRef|nativeSessionId|sessionId|ownerMemberId|agentSnapshot|instructions)"\s*:/.test(serialized), 'conversation DTO exposes a server-only binding')
  assert(Array.isArray(value.turns) && Array.isArray(value.relatedWorks))
}
function instructions(marker) { return `你是制造业工作助手。每次回复必须以 ${marker} 开头；不要引用其他成员或其他对话内容。简短问题请简短回答，用户明确要求长文时按要求写长文。节拍工作必须使用获准的节拍工具结果，不编造结果。` }
function employeeForm(id) { return `form[data-kind="employee"][data-id="${id}"]` }
function conversationPath(id) { return '/api/conversations/' + encodeURIComponent(id) }
function apiSurface(path) {
  const parts = path.split('?')[0].split('/')
  if (parts[1] === 'api' && ['conversations', 'works', 'sessions'].includes(parts[2])) { if (parts[3]) parts[3] = ':id'; if (parts[4] === 'turns' && parts[5]) parts[5] = ':turn' }
  return parts.join('/')
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function within(parent, child) { const path = relative(parent, child); return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)) }
function js(value) { return JSON.stringify(value) }
function pause(ms) { return new Promise(resolvePause => setTimeout(resolvePause, ms)) }
function safeFailure(error, passwords) { let message = String(error.message ?? error); for (const password of Object.values(passwords)) message = message.replaceAll(password, '[已隐藏]'); return message }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]) }
function clock(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` }
function manual(report) {
  const cleanupText = (report.cleanup?.allOwnedProcessesExited === true ? '本轮隔离服务已关闭。' : '本轮隔离服务的退出状态尚未确认，需由维护者核对。') + (report.cleanup?.authRemoved === true ? '临时登录凭据已删除。' : '本轮登录凭据的清理尚未确认，需由维护者核对。')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geneway S1 Web 操作与验收说明</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:17px/1.7 system-ui,sans-serif;color:#172033;background:#f5f7fb}h1,h2{line-height:1.4}section{background:white;border:1px solid #dce2ed;border-radius:14px;padding:24px;margin:24px 0}video,img{max-width:100%;height:auto;border-radius:8px}code{overflow-wrap:anywhere}.result{padding:12px;background:#edf6ee}.failed{background:#fff1ed}a{color:#1949a8}</style><h1>Geneway S1 Web 操作与验收说明</h1><p>渠道为模拟验收；本视频覆盖 S1 Web。所有账号、对话和节拍输入均为本机隔离的 synthetic 验收数据，不连接生产业务或真实成员渠道。</p><p>模型：ZenMux ${escape(report.model.model)}。候选：<code>${escape(report.candidate.head)}</code>；相关文件的 SHA-256 见同目录 observations.json。界面以桌面 1440×900、手机 390×844 实际操作。</p><p class="result ${report.ok ? '' : 'failed'}">本轮${report.ok ? '已完成脚本列出的 S1 检查，用户最终验收另行确认。' : '尚未通过，需修复未完成步骤后复验；具体原因见同目录检查记录。'}</p><p><a href="p4-s1.mp4">打开完整操作视频</a> · <a href="observations.json">查看实际检查记录</a></p><video controls preload="metadata" src="p4-s1.mp4"></video><section><h2>开始前</h2><p>管理员在后台维护员工、执行指令和开放成员；成员只能使用当前获准员工。登录后进入“我的对话”，选择员工即可新建空白上下文的对话。历史仅本人可读，工作在关联对话中保留独立执行和停止入口。</p><p>本说明使用一次性验收账号。${cleanupText}复验需由获准维护者重新运行验收入口。视频、截图及本说明可离线查看，无需外部字体或网络。</p></section>${report.steps.map((step, index) => `<section><h2>${index + 1}. ${escape(step.title)}</h2><p>操作身份：${escape(step.actor === 'admin' ? '管理员' : '成员 ' + step.actor.toUpperCase())}。入口：${escape(step.control)}。</p><p class="result ${step.result === 'passed' ? '' : 'failed'}">${escape(step.result === 'passed' ? step.observed : '本步未达到预期：' + step.expected + ' 当前尚未取得通过结果；具体原因见同目录检查记录。')}</p>${step.screenshots?.length ? step.screenshots.map(shot => `<figure><img alt="${escape(shot.label)}" src="data:image/png;base64,${shot.image}"><figcaption>${escape(shot.label)}</figcaption></figure>`).join('') : '<p>本步未取得可用截图。</p>'}<p>对应视频 ${clock(step.startSeconds)}–${clock(step.endSeconds ?? step.startSeconds)}。</p></section>`).join('')}${report.incomplete.length ? `<section class="failed"><h2>未完成的步骤</h2><p>${escape(report.incomplete.map(id => steps.find(step => step.id === id)?.title).join('；'))}</p></section>` : ''}<section><h2>结果确认与恢复</h2><p>回复结束后可点“刷新历史”读取已完成内容。员工撤权、停用或对话归档时，旧历史按页面原因保持只读；不要重新创建对话来绕过授权。停止本次回复只影响该回复，停止工作只影响选定工作。若服务中断，当前回复显示“回复中断”，已有结果保留；历史不可用时先刷新历史，不把缺失历史当成新的空白上下文。</p><p>本次 W1、W2 分别使用 601 秒、600 秒与 10 件的独立输入；两项工作仍在执行时停止 W1，再核对 W2 的节拍结果为 60 秒/件。本轮要求共享 Host 与其精确官方 SDK 子进程具有同一运行和候选绑定，父进程启动记录、子进程预载就绪、实际模型请求及退出须能够关联；缺失时本轮不通过。正常退出依据 guard 日志核对；强制重启的 SIGKILL 单独依据实际信号、PID 和自有进程组消失证据核对，不填造正常退出日志或 SDK 自身退出状态。实际子进程数量和请求数见检查记录。该审计仅覆盖所选 Node 启动与网络 API，不代表整台机器或其他子进程的网络覆盖。</p></section></html>`
}

async function harnessCheck() {
  assert.deepEqual(argumentsFor([]), { help: true })
  assert.throws(() => argumentsFor(['--run']), /requires/)
  assert.throws(() => argumentsFor(['--run', '--output', join(root, 'artifacts'), '--network-guard', '/tmp/approved.mjs']), /outside/)
  assert.throws(() => argumentsFor(['--run', '--harness-check']), /exactly one/)
  assert.equal(new Set(steps.map(step => step.id)).size, steps.length)
  const binding = { runId: 's1-pure-check', candidate: 'a'.repeat(64), guardSha256: 'b'.repeat(64) }
  const env = runtimeEnvironment({ scratch: '/tmp/s1-check', stateFile: '/tmp/s1-check/state.json', authFile: '/tmp/s1-check/auth.json', dshHome: '/tmp/s1-check/dsh', origin: 'http://127.0.0.1:12345', auditFile: '/tmp/s1-check/network.jsonl', contextFile: '/tmp/s1-check/context.jsonl', canaries: { a: 'A_ONLY', b: 'B_ONLY' }, guard: '/tmp/approved.mjs', auditBinding: binding })
  assert.equal(env.GENEWAY_SECRET_ROOT, join(root, 'var/secrets'))
  assert.equal(env.GENEWAY_MODEL_CREDENTIAL_REF, 'zenmux-p4-model.key')
  assert.equal(env.DSH_HOME, env.GENEWAY_DSH_HOME)
  assert.equal(env.GENEWAY_NETWORK_AUDIT_ROLE, 'host'); assert.equal(env.GENEWAY_NETWORK_AUDIT_RUN_ID, binding.runId); assert.equal(env.GENEWAY_NETWORK_AUDIT_CANDIDATE, binding.candidate)
  assert(!Object.keys(env).some(key => /GEARJOB|FEISHU|HIVE|KIVO|ZENMUX_API_KEY/.test(key)))
  assert(!within(root, env.GENEWAY_AUTH_FILE))
  const records = [], credential = 'synthetic-credential-must-never-be-recorded'
  let forwarded = 0
  const observed = contextObserver(async () => { forwarded += 1; return new Response('{}') }, { a: 'A_ONLY', b: 'B_ONLY' }, record => records.push(record))
  await observed('https://zenmux.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: instructionMarkers.old }, { role: 'user', content: 'S1_A_FIRST A_ONLY' }] }) })
  await observed('https://zenmux.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'S1_A_CLEAN' }] }) })
  assert.equal(forwarded, 2); assert.equal(records[0].hasA, true); assert.equal(records[0].hasB, false)
  assert.equal(records[1].hasA, false); assert.equal(records[1].hasB, false)
  assert.deepEqual(records[1].currentLabels, ['S1_A_CLEAN'])
  assert(!JSON.stringify(records).includes(credential)); assert(!JSON.stringify(records).includes('A_ONLY'))
  assertPublicConversation({ turns: [], relatedWorks: [] })
  assert.throws(() => assertPublicConversation({ turns: [], relatedWorks: [], dshSessionRef: 'private' }), /server-only/)
  assert.deepEqual(nativeReferences({ sessions: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), ['a', 'b'])
  assert.equal(apiSurface('/api/sessions/native-private-ref'), '/api/sessions/:id')
  assert.equal(apiSurface('/api/conversations/private/turns/private-turn/cancel'), '/api/conversations/:id/turns/:turn/cancel')
  const html = manual({ ok: true, model: { model }, candidate: { head: 'synthetic-candidate' }, incomplete: [], steps: [{ ...steps[0], result: 'passed', observed: '<script>untrusted title</script>', screenshots: [{ label: '合成检查图', image: 'c3ludGhldGlj' }], startSeconds: 1, endSeconds: 3 }] })
  assert(html.includes('src="data:image/png;base64,c3ludGhldGlj"')); assert(html.includes('href="p4-s1.mp4"'))
  assert(!html.includes('<script>')); assert(!/(?:src|href)="https?:/.test(html)); assert(html.includes('渠道为模拟验收'))
  for (const cleanup of [{ authRemoved: false, allOwnedProcessesExited: false }, undefined]) {
    const failed = manual({ ok: false, cleanup, model: { model }, candidate: { head: 'synthetic-candidate' }, incomplete: [], steps: [] })
    assert(!failed.includes('本轮隔离服务已关闭')); assert(!failed.includes('登录凭据已删除'))
    assert(failed.includes('退出状态尚未确认')); assert(failed.includes('登录凭据的清理尚未确认'))
  }
  networkChecks()
  await recordingChecks()
  await interruptCleanupChecks()
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', requiredSteps: steps.length, checks: ['explicit-run-boundary', 'environment-and-credential-reference', 'synthetic-context-observer', 'public-dto', 'native-reference-deduplication', 'offline-guide-escaping', 'cleanup-prose-follows-observed-state', 'recorder-early-and-abnormal-exit', 'recording-duration-and-last-screenshot-coverage', 'signal-cleanup-idempotence-and-escalation', 'auth-initializer-drain-and-cleanup-failure', 'Host-SDK-ready-fetch-exit-correlation-and-cancel-before-fetch', 'observed-hard-restart-and-bounded-SDK-parent-exit-gap'], nativeStarts: 0, modelRequests: 0, browserStarts: 0, serverStarts: 0, realSecretReads: 0 }, null, 2))

  function networkChecks() {
    const host = value => ({ ...binding, pid: 123, ppid: 100, role: 'host', ...value })
    const sdk = value => ({ ...binding, pid: 456, ppid: 123, role: 'sdk', ...value })
    const rows = [host({ kind: 'guard-ready' }), host({ kind: 'sdk-spawn', parentPid: 123, childPid: 456 }), sdk({ kind: 'guard-ready' }), sdk({ kind: 'fetch', host: 'zenmux.ai', model, permitted: true }), sdk({ kind: 'process-exit', code: 0 }), host({ kind: 'sdk-exit', parentPid: 123, childPid: 456, code: 0, signal: null }), host({ kind: 'process-exit', code: 0 })]
    assert.equal(networkAudit(rows, { ...binding, hostPids: [123] }).sdkChildren[0].modelFetches, 1)
    for (const change of [
      value => value.filter(row => !(row.role === 'sdk' && row.kind === 'guard-ready')),
      value => value.map(row => row.role === 'sdk' ? { ...row, ppid: 999 } : row),
      value => value.map(row => ({ ...row, candidate: 'c'.repeat(64) })),
      value => value.filter(row => row.kind !== 'sdk-exit'),
      value => value.filter(row => !(row.role === 'host' && row.kind === 'process-exit')),
    ]) assert.throws(() => networkAudit(change(structuredClone(rows)), { ...binding, hostPids: [123] }))
    const cancelled = [...rows, host({ kind: 'sdk-spawn', parentPid: 123, childPid: 457 }), sdk({ kind: 'guard-ready', pid: 457 }), host({ kind: 'sdk-exit', parentPid: 123, childPid: 457, code: null, signal: 'SIGTERM' })]
    assert.equal(networkAudit(cancelled, { ...binding, hostPids: [123] }).sdkChildren[1].outcome, 'no-model-request-observed')
    const failed = [...rows, host({ kind: 'sdk-spawn', parentPid: 123, childPid: 458 }), host({ kind: 'sdk-exit', parentPid: 123, childPid: 458, code: 1, signal: null })]
    assert.equal(networkAudit(failed, { ...binding, hostPids: [123] }).sdkChildren[1].outcome, 'failed-before-ready')
    assert.equal(networkAudit([...rows, host({ pid: 124, kind: 'guard-ready' }), host({ pid: 124, kind: 'process-exit', code: 0 })], { ...binding, hostPids: [123, 124] }).hostPids.length, 2)
    const prefix = rows.filter(row => !['process-exit', 'sdk-exit'].includes(row.kind))
    const hardRestart = [...prefix, host({ pid: 124, kind: 'guard-ready' }), host({ pid: 124, kind: 'process-exit', code: 0 })]
    const evidence = { ...binding, pid: 123, processGroupId: 123, requestedSignal: 'SIGKILL', signalDelivered: true, observedExitCode: null, observedSignal: 'SIGKILL', pidExited: true, groupExited: true, sdkPidsExited: [456], auditRowsBeforeSignal: prefix.length, requestedAt: 1, observedExitAt: 2, checkedAt: 3 }
    const restarted = options => networkAudit(hardRestart, { ...binding, hostPids: [123, 124], hostInterruptions: [evidence], ...options })
    assert.throws(() => restarted({ hostInterruptions: [] }), /Host process exit/)
    const interrupted = restarted()
    assert.equal(interrupted.hosts[0].outcome, 'harness-observed-SIGKILL')
    assert.equal(interrupted.hosts[1].outcome, 'normal-guard-exit')
    assert.equal(interrupted.sdkChildren[0].parentExitObserved, false)
    assert.equal(interrupted.sdkChildren[0].exitCode, null); assert.equal(interrupted.sdkChildren[0].signal, null)
    for (const change of [
      value => { value.candidate = 'c'.repeat(64) }, value => { value.runId = 'other-run' }, value => { value.guardSha256 = 'c'.repeat(64) }, value => { value.pid = 999 },
      value => { value.observedSignal = 'SIGTERM' }, value => { value.observedExitCode = 0 },
      value => { value.signalDelivered = false }, value => { value.groupExited = false }, value => { value.pidExited = false },
      value => { value.sdkPidsExited = [] }, value => { value.auditRowsBeforeSignal = 1 },
    ]) { const invalid = structuredClone(evidence); change(invalid); assert.throws(() => restarted({ hostInterruptions: [invalid] })) }
    const late = [...hardRestart, host({ kind: 'sdk-spawn', parentPid: 123, childPid: 789 }), sdk({ kind: 'guard-ready', pid: 789 })]
    assert.throws(() => networkAudit(late, { ...binding, hostPids: [123, 124], hostInterruptions: [evidence] }), /SDK parent exit/)
    assert.throws(() => networkAudit(hardRestart.filter(row => !(row.pid === 124 && row.kind === 'process-exit')), { ...binding, hostPids: [123, 124], hostInterruptions: [evidence] }), /Host process exit/)
    assert.throws(() => networkAudit(hardRestart.filter(row => !(row.role === 'sdk' && row.kind === 'guard-ready')), { ...binding, hostPids: [123, 124], hostInterruptions: [evidence] }), /SDK guard readiness/)
  }

  function childFixture() {
    return Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, stdin: Object.assign(new EventEmitter(), { end: () => undefined }) })
  }
  function exitFixture(child, code, signal = null) { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal) }
  async function recordingChecks() {
    for (const [code, signal] of [[0, null], [255, null], [null, 'SIGINT']]) {
      const child = childFixture(), errors = [], watched = watchRecording(child, error => errors.push(error))
      exitFixture(child, code, signal)
      assert.equal(errors.length, 1); assert.equal(watched.state.unexpectedExit, true)
      assert.throws(watched.assertRunning, /before the recording stop/)
      await assert.rejects(watched.finish(), /before the recording stop/)
    }
    let time = 10_000
    const child = childFixture(), errors = [], watched = watchRecording(child, error => errors.push(error), () => time)
    child.stdin.end = text => { assert.equal(text, 'q\n'); queueMicrotask(() => { time = 20_100; exitFixture(child, 0) }) }
    time = 20_000
    await watched.finish(); assert.equal(errors.length, 0); assert.equal(watched.state.exitCode, 0)
    const probe = seconds => ({ format: { duration: String(seconds) }, streams: [{ codec_type: 'video', codec_name: 'h264', duration: String(seconds) }] })
    assert.equal(recordingCoverage(watched.state, probe(10), [{ endSeconds: 9.8 }]).expectedCoverageSeconds, 10)
    assert.throws(() => recordingCoverage(watched.state, probe(2), [{ endSeconds: 9.8 }]), /does not cover/)
    assert.throws(() => recordingCoverage(watched.state, probe(10), [{ endSeconds: 9.8, screenshots: [{ seconds: 12 }] }]), /does not cover/)
    const abnormal = childFixture(), abnormalErrors = [], bad = watchRecording(abnormal, error => abnormalErrors.push(error))
    abnormal.stdin.end = () => queueMicrotask(() => exitFixture(abnormal, 1))
    await assert.rejects(bad.finish(), /did not exit normally/); assert.equal(abnormalErrors.length, 1)
  }
  async function interruptCleanupChecks() {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const host = new EventEmitter(), children = [childFixture(), childFixture()], calls = [], errors = [], abort = new AbortController()
      let settle, authInitializerDone = false, removed = 0, socketsClosed = 0, recordingStops = 0
      const operationSettled = new Promise(resolveSettled => { settle = resolveSettled })
      const cleanup = runCleanup({ children, browsers: { a: { socket: { close() { socketsClosed += 1 } } } },
        recording: () => ({ async finish() { recordingStops += 1 } }), operationSettled,
        removeAuth: async () => { assert(authInitializerDone); removed += 1 }, onFailure: error => errors.push(error),
        stopChild: async (child, requested = 'SIGTERM') => { assert(children.includes(child)); calls.push(requested); child.exitCode = 0 },
      })
      const interrupts = interruptHandlers(host, (received, force) => { abort.abort(new Error(received)); void cleanup.run(force) })
      host.emit(signal)
      const first = cleanup.run(); assert.equal(first, cleanup.run())
      await Promise.resolve(); assert.equal(removed, 0)
      host.emit(signal); host.emit(signal)
      authInitializerDone = true; settle()
      await first
      assert.equal(host.exitCode, signal === 'SIGINT' ? 130 : 143); assert.equal(abort.signal.aborted, true)
      assert.equal(interrupts.state.forced, true); assert.equal(calls.filter(value => value === 'SIGKILL').length, children.length)
      assert.equal(recordingStops, 1); assert.equal(removed, 1); assert.equal(socketsClosed, 1)
      assert.equal(cleanup.state.authRemoved, true); assert.equal(cleanup.state.allOwnedProcessesExited, true); assert.deepEqual(errors, [])
      interrupts.dispose(); assert.equal(host.listenerCount('SIGINT'), 0); assert.equal(host.listenerCount('SIGTERM'), 0)
    }
    const authFailure = new Error('synthetic auth cleanup failure')
    let failed
    const cleanup = runCleanup({ children: [], browsers: {}, recording: () => undefined, operationSettled: Promise.resolve(), removeAuth: async () => { throw authFailure }, onFailure: error => { failed ??= error } })
    await cleanup.run()
    assert.equal(failed, authFailure); assert.equal(cleanup.state.authRemoved, false); assert.equal(!failed, false)
  }
}
