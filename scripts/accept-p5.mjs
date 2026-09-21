import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createNodeServer } from 'node:http'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeConfig, readSettings, validateRuntimeConfig } from '../src/runtime-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifactRoot = resolve(root, 'artifacts', 'p5-acceptance')
const FEISHU_CREDENTIAL_REF = 'FEISHU_P5_SECRET'
const EVENT_HOST = '172.20.0.1'
const EVENT_PORT = 39471
const EVENT_SOURCE_ID = 'gearjob:dev.localhost'
const EVENT_SOURCE_ADDRESS = '172.20.0.5'
const GEARJOB_COMMIT = '9ea23fc0b0318a16ae0e60e3844f1263a3726aeb'
const harnessCheck = process.argv.includes('--harness-check')
const options = parseArgs(process.argv.slice(2))

if (harnessCheck) {
  await checkHarness()
  console.log(JSON.stringify({ ok: true, mode: 'harness-check', externalEffects: 0, checks: ['args', 'paths', 'absolute-outside', 'permissions', 'fixtures', 'enrollment', 'runtime-config', 'event-runtime', 'real-frappe-save', 'replay-conflict-window', 'restart-revocation', 'queue-isolation', 'tracked-clean-preflight', 'secret-scan', 'best-effort-cleanup-injection', 'media-plan', 'material-manifest', 'lark-readback', 'combined-verdict'] }))
} else {
  await formalAcceptance(options)
}

async function formalAcceptance(input) {
  const candidate = await capture('git', ['rev-parse', 'HEAD'])
  await assertFrozen(candidate)
  let config
  try { config = await validateFormal(input) } catch (error) {
    if (/enrollment/i.test(error?.message ?? '')) { console.error(JSON.stringify({ ok: false, status: 'needs-operator-link', candidate, externalEffects: 0, reason: 'verified member↔identity↔private conversation enrollment is required before formal mode' })); process.exitCode = 2; return }
    throw error
  }
  await runBoundedP5Tests(candidate)
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-p5-accept-'))
  const stage = await mkdtemp(join(tmpdir(), 'geneway-p5-stage-'))
  await chmod(scratch, 0o700)
  await chmod(stage, 0o700)
  const paths = fixturePaths(scratch)
  const artifacts = artifactPaths(config.record)
  const display = process.env.GENEWAY_ACCEPT_DISPLAY ?? ':98'
  const port = await freePort(), cdpPort = await freePort(), origin = `http://127.0.0.1:${port}`
  const adminPassword = randomBytes(24).toString('base64url'), ownerPassword = randomBytes(24).toString('base64url')
  const secrets = [...config.secretNeedles, adminPassword, ownerPassword]
  const timers = new Set()
  let server, chrome, xvfb, recorder, browser, sentReceipt, prepared, failure, cleanupError, gearJob
  try {
    try {
      const enrollment = await readbackEnrollment(config)
      config.enrollment = enrollment.enrollment
      sentReceipt = enrollment.receipt
      await createFixture(paths, config, adminPassword, ownerPassword)
      gearJob = await prepareGearJob(config, paths)
      xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
      await alive(xvfb, 'Xvfb')
      try { server = await startServer(paths, origin, port, config) } catch (error) { server = error.process ?? server; throw error }
      chrome = spawn('google-chrome', chromeArgs(paths.chrome, cdpPort, origin), { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'ignore', 'pipe'] })
      await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20_000)
      browser = await connectBrowser(cdpPort, origin)
      await configureProduct(browser, config, adminPassword, ownerPassword)
      await assertBrowserSurfaceClean(browser, secrets, 'pre-recording')
      recorder = startRecorder(display, join(stage, basename(config.record)))
      await alive(recorder.process, 'ffmpeg')
      const restartRuntime = async () => {
        await browser.send('Page.navigate', { url: 'about:blank' })
        await browser.waitFor(`location.href==='about:blank'`)
        await stop(server, 'SIGINT'); server = undefined
        try { server = await startServer(paths, origin, port, config) } catch (error) { server = error.process ?? server; throw error }
        await browser.send('Page.navigate', { url: origin })
        await browser.waitFor(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'&&!document.querySelector('#app').classList.contains('hidden')`)
      }
      const journey = await runCombinedJourney(browser, config, gearJob, restartRuntime, { stage, framesDir: join(stage, basename(artifacts.frames)), timers, recordingStartedAt: recorder.startedAt })
      await assertBrowserSurfaceClean(browser, secrets, 'post-journey')
      await stopRecorder(recorder); recorder = undefined
      const evidence = await readback(paths.state, paths.dsh, journey, config)
      const platform = []
      for (const item of evidence.deliveries) {
        const expectedText = expectedDeliveryText(item.work, item.result)
        sentReceipt = { messageId: shortHash(item.delivery.providerMessageId), chatId: shortHash(item.conversation.providerConversationId), textSha256: sha256(expectedText), deleted: false, msgType: 'unknown' }
        platform.push(await verifyLark(config, item.delivery.providerMessageId, item.conversation.providerConversationId, expectedText))
      }
      assert.equal(browser.errors.console.length, 0); assert.equal(browser.errors.page.length, 0); assert.equal(browser.errors.network.length, 0)
      const media = await finishMedia(join(stage, basename(config.record)), join(stage, basename(artifacts.cover)), join(stage, basename(artifacts.frames)), journey.steps)
      const report = { ...buildReport(candidate, config, journey, evidence, platform, media, gearJob), reportFile: basename(artifacts.report) }
      await writeFile(join(stage, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      await writeFile(join(stage, basename(artifacts.report)), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      await writeFile(join(stage, 'index.html'), manual(report), { mode: 0o600 })
      await verifyOfflineBundle(stage, report)
      await scanLeaks([stage], secrets)
      prepared = { report, evidence, journey, media }
    } catch (error) {
      sentReceipt ||= error.receipt
      failure = error
    }
  } finally {
    try { await cleanupGearJob(gearJob) } catch (error) { cleanupError = error }
    try { await cleanupRuntime({ browser, recorder, chrome, server, xvfb, timers, scratch, paths }) } catch (error) { cleanupError ??= error }
  }
  if (!failure && !cleanupError) {
    try {
      await assertPortAvailable(EVENT_HOST, EVENT_PORT)
      prepared.report.gearJob.cleanup = gearJob.cleanup
      prepared.report.gearJob.webhookRequestLogs = gearJob.requestLogs
      await writeFile(join(stage, 'report.json'), JSON.stringify(prepared.report, null, 2) + '\n', { mode: 0o600 })
      await writeFile(join(stage, basename(artifacts.report)), JSON.stringify(prepared.report, null, 2) + '\n', { mode: 0o600 })
      await writeFile(join(stage, 'index.html'), manual(prepared.report), { mode: 0o600 })
      await assertCandidateTerminal(candidate)
      await scanLeaks([stage], secrets)
      await verifyOfflineBundle(stage, prepared.report)
      await promoteStage(stage, artifacts)
      await scanLeaks(Object.values(artifacts), secrets)
      await assertCandidateTerminal(candidate)
      await rm(stage, { recursive: true, force: true }); await assertRemoved(stage)
    } catch (error) { failure = error }
  }
  if (failure || cleanupError) {
    const reason = failure ?? cleanupError
    if (sentReceipt) await preserveFailureReceipt(candidate, config, sentReceipt, reason)
    await rm(stage, { recursive: true, force: true })
    console.error(JSON.stringify({ ok: false, status: 'evidence-pending', candidate, reason: redact(reason?.message ?? reason), materials: sentReceipt ? 'delivery-receipt-preserved' : 'not-sent' }))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify({ ok: true, status: 'evidence-pending', candidate, verdict: prepared.report.verdict, report: artifacts.report, video: artifacts.video, manual: artifacts.manual, materials: 'evidence-ready/pending-delivery', note: 'T7a and T7b business passed on one candidate; operation materials remain evidence-ready/pending delivery and are independently reviewed and delivered by the controller.' }))
}

async function configureProduct(browser, config, adminPassword, ownerPassword) {
  const { evaluate, waitFor } = browser
  await waitFor(`Boolean(document.querySelector('#login-name'))`)
  await login(evaluate, waitFor, 'admin', adminPassword)
  const configured = await evaluate(`(async()=>{
    const route=await api('/api/admin/model-routes',{method:'POST',body:{id:'model-zenmux',provider:'zenmux',model:'deepseek/deepseek-v4-pro',displayName:'ZenMux DeepSeek V4 Pro',enabled:true,credentialRef:'ZENMUX_API_KEY'}})
    const skill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-gearjob-work-order-read',name:'GearJob 工单只读',capabilityId:'gearjob-work-order-read',enabled:true}})
    const connection=await api('/api/admin/connections',{method:'POST',body:{id:'connection-p5',name:'GearJob 外部测试',kind:'gearjob-rest',targetIdentity:'gearjob-p5',baseUrl:${JSON.stringify(config.gearJobUrl)},hostHeader:${JSON.stringify(config.gearJobHost)},credentialRef:'gearjob.json',allowedObjectIds:[${JSON.stringify(config.workOrderId)}],sourceSystem:'GearJob',sourceInstance:'dev.localhost',sourceEnvironment:'external-test',dataMode:'synthetic',evidenceMode:'real-frappe-rest',enabled:true,skillIds:[skill.id]}})
    const employee=await api('/api/admin/employees',{method:'POST',body:{id:'employee-p5',name:'工单核对员',description:'真实定时核对测试工单',enabled:true,modelRouteId:route.id,connectionIds:[connection.id],skillIds:[skill.id]}})
    await api('/api/admin/members/member-user',{method:'PATCH',body:{displayName:'验收成员',role:'member',enabled:true,employeeIds:[employee.id]}})
    await api('/api/admin/channel-apps',{method:'POST',body:{id:'app-feishu-p5',provider:'feishu',providerAppId:${JSON.stringify(config.feishuAppId)},providerTenantId:${JSON.stringify(config.feishuTenantId)},credentialRef:${JSON.stringify(FEISHU_CREDENTIAL_REF)},enabled:true,allowedScopes:['result']}})
    return api('/api/admin/connections/'+connection.id+'/test',{method:'POST',body:{}})
  })()`)
  assert.equal(configured.ok, true)
  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`!document.querySelector('#login-shell').classList.contains('hidden')`)
  await login(evaluate, waitFor, 'member', ownerPassword)
  await waitFor(`state.channels.conversations.some(item=>item.id===${JSON.stringify(config.enrollment.conversationId)}&&item.identityId===${JSON.stringify(config.enrollment.identityId)}&&item.type==='private'&&item.status==='active')`)
}

async function runCombinedJourney(browser, config, gearJob, restartRuntime, { stage, framesDir, timers, recordingStartedAt }) {
  const { send, evaluate, waitFor } = browser
  const steps = [], screenshots = framesDir, elapsed = () => (Date.now() - recordingStartedAt) / 1000
  await mkdir(screenshots, { recursive: true, mode: 0o700 })
  const captureStep = async (id, action, purpose, expected, observedExpression) => {
    const startSeconds = elapsed(), image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const file = join(screenshots, `step-${id}.png`); await writeFile(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    const observed = await evaluate(observedExpression); steps.push({ id, action, purpose, expected, observed, startSeconds, endSeconds: elapsed(), image: `${basename(screenshots)}/step-${id}.png` })
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await pointerClick(browser, '[data-view="works"]'); await pointerClick(browser, '#new-automation'); await waitFor(`!document.querySelector('#automation-form').classList.contains('hidden')`)
  const formReadyAt = Date.now(), target = nextSafeMinute(new Date(formReadyAt), 90_000), time = timeInZone(target, 'Asia/Shanghai'), targetIso = target.toISOString()
  await evaluate(`(()=>{const binding=document.querySelector('#automation-binding');binding.value=binding.querySelector('option:not([value=""])').value;binding.dispatchEvent(new Event('input'));const notice=document.querySelector('#automation-notification');notice.value=notice.querySelector('option:not([value=""])').value;notice.dispatchEvent(new Event('input'));const order=document.querySelector('#automation-order');order.value=${JSON.stringify(config.workOrderId)};order.dispatchEvent(new Event('input'));const time=document.querySelector('#automation-time');time.value=${JSON.stringify(time)};time.dispatchEvent(new Event('input'));const budget=document.querySelector('#automation-budget');budget.value='1';budget.dispatchEvent(new Event('input'));document.querySelector('#automation-form').requestSubmit()})()`)
  await waitFor(`state.automationDetail?.rule?.workOrderId===${JSON.stringify(config.workOrderId)}&&state.automationDetail.rule.status==='draft'`)
  const ruleId = await evaluate(`state.automationDetail.rule.id`)
  await captureStep('01', '创建每日规则草稿', '验证表单可保存并绑定目标', 'draft + daily-time + Asia/Shanghai', `(()=>{const rule=state.automationDetail.rule;return {status:rule.status,kind:rule.trigger.kind,time:rule.trigger.time,timeZone:rule.trigger.timeZone,targetIso:${JSON.stringify(targetIso)}}})()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.querySelector('[data-rule-action="enable"]').scrollIntoView({block:'center'})`)
  const mobileFacts = await mobilePreflightCheck(browser, '[data-rule-action="enable"]')
  await captureStep('02', '390px 启用前几何、导航遮挡、焦点与可访问性检查', '确认真实移动端操作目标可见可操作', 'button visible, unobscured, focusable, AX exposed', `(${JSON.stringify(mobileFacts)})`)
  await tap(browser, '[data-rule-action="enable"]')
  await waitFor(`state.automationDetail?.rule?.id===${JSON.stringify(ruleId)}&&state.automationDetail.rule.status==='active'`)
  await captureStep('03', '390px 真实触摸启用规则', '验证移动端触摸路径改变规则状态', 'active and no horizontal overflow', `(()=>({status:state.automationDetail.rule.status,overflow:document.documentElement.scrollWidth<=390}))()`)
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    const done = await evaluate(`reloadAll().then(()=>openAutomation(${JSON.stringify(ruleId)})).then(()=>{const item=state.automationDetail?.occurrences?.find(value=>value.workId),work=item&&state.bootstrap.works.find(value=>value.id===item.workId),delivery=item&&state.channels.deliveries.find(value=>value.id===item.deliveryId);return work?.status==='completed'&&delivery?.status==='delivered'})`)
    if (done) break
    await delay(2_000, timers)
  }
  assert.equal(await evaluate(`(()=>{const item=state.automationDetail?.occurrences?.find(value=>value.workId),work=item&&state.bootstrap.works.find(value=>value.id===item.workId),delivery=item&&state.channels.deliveries.find(value=>value.id===item.deliveryId);return work?.status==='completed'&&delivery?.status==='delivered'})()`), true)
  await captureStep('04', '真实墙钟触发并完成主链', '验证每日调度、GearJob、ZenMux、飞书结果链闭合', 'completed + delivered', `(()=>{const item=state.automationDetail.occurrences.find(value=>value.workId),work=state.bootstrap.works.find(value=>value.id===item.workId),delivery=state.channels.deliveries.find(value=>value.id===item.deliveryId);return {status:work.status,deliveryStatus:delivery.status,scheduledDate:item.scheduledDate}})()`)
  assert.ok(Date.parse(targetIso) - formReadyAt >= 90_000)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const publicFacts = await evaluate(`(()=>{const occurrence=state.automationDetail.occurrences.find(item=>item.workId),work=state.bootstrap.works.find(item=>item.id===occurrence.workId),result=work.results.at(-1),delivery=state.channels.deliveries.find(item=>item.id===occurrence.deliveryId);return {ruleId:state.automationDetail.rule.id,occurrenceId:occurrence.id,scheduledDate:occurrence.scheduledDate,workId:work.id,executionId:work.executions.at(-1)?.id,resultId:result.id,deliveryId:delivery.id,targetConversationId:delivery.targetConversationId,source:result.source,payload:result.payload,resultKind:result.kind,toolName:result.toolName,dshSessionRef:result.dshSessionRef,dshEventCount:work.executions.at(-1)?.dshEventCount,deliveryStatus:delivery.status}})()`)
  assert.equal(publicFacts.source.sourceRecordId, `Work Order:${config.workOrderId}`); assert.equal(publicFacts.source.dataMode, 'synthetic')
  assert.ok(Math.abs(Date.parse(localDateTimeIso(publicFacts.scheduledDate, time)) - Date.parse(targetIso)) <= 60_000)
  const daily = { ruleId, targetIso, formReadyAt, public: publicFacts }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await pointerClick(browser, '#new-automation')
  await evaluate(`(()=>{const binding=document.querySelector('#automation-binding');binding.value=binding.querySelector('option:not([value=""])').value;binding.dispatchEvent(new Event('input'));const notice=document.querySelector('#automation-notification');notice.value=notice.querySelector('option:not([value=""])').value;notice.dispatchEvent(new Event('input'));const order=document.querySelector('#automation-order');order.value=${JSON.stringify(config.workOrderId)};order.dispatchEvent(new Event('input'));const trigger=document.querySelector('#automation-trigger');trigger.value='gearjob-work-order-update';trigger.dispatchEvent(new Event('input'));const budget=document.querySelector('#automation-budget');budget.value='3';budget.dispatchEvent(new Event('input'));document.querySelector('#automation-form').requestSubmit()})()`)
  await waitFor(`state.automationDetail?.rule?.workOrderId===${JSON.stringify(config.workOrderId)}&&state.automationDetail.rule.trigger.kind==='gearjob-work-order-update'&&state.automationDetail.rule.status==='draft'`)
  const eventRuleId = await evaluate(`state.automationDetail.rule.id`)
  assert.equal(await evaluate(`!document.querySelector('#automation-detail #automation-edit-time')&&!document.querySelector('#automation-detail [data-check-now]')`), true)
  await evaluate(`document.querySelector('[data-rule-action="enable"]').scrollIntoView({block:'center'})`)
  const eventEnableFacts = await mobilePreflightCheck(browser, '[data-rule-action="enable"]')
  await tap(browser, '[data-rule-action="enable"]')
  await waitFor(`state.automationDetail?.rule?.id===${JSON.stringify(eventRuleId)}&&state.automationDetail.rule.status==='active'`)
  await captureStep('05', '390px 创建并启用 GearJob 事件规则', '验证真实移动端可配置事件来源并开始等待 after-commit Webhook', 'active + event source ready + no daily control', `(()=>({status:state.automationDetail.rule.status,kind:state.automationDetail.rule.trigger.kind,sourceId:state.automationDetail.rule.trigger.sourceId,overflow:document.documentElement.scrollWidth<=390,enablePreflight:${JSON.stringify(eventEnableFacts)}}))()`)
  await startGearJobWorker(gearJob)
  const first = await saveGearJobWorkOrder(gearJob)
  await waitForEventCompletions(browser, eventRuleId, 1, timers)
  await evaluate(`openAutomation(${JSON.stringify(eventRuleId)})`)
  await captureStep('06', 'Frappe 正常保存提交触发事件主链', '验证 after-commit Webhook、GearJob 重读、DSH、ZenMux 和飞书闭环', 'one event occurrence + completed work + delivered result', `(()=>{const items=state.automationDetail.occurrences.filter(item=>item.event&&item.workId),item=items[0],work=state.bootstrap.works.find(value=>value.id===item.workId),delivery=state.channels.deliveries.find(value=>value.id===item.deliveryId);return {occurrences:items.length,sourceRevision:item.event.sourceRevision,status:work.status,deliveryStatus:delivery.status}})()`)
  const firstEvent = await evaluate(`state.automationDetail.occurrences.find(item=>item.event?.sourceRevision===${JSON.stringify(first.modified)}).event`)
  const raw = gearJobBody(config.workOrderId, first.modified)
  assert.equal(sha256(raw), firstEvent.digest, 'reconstructed raw body must equal Frappe webhook bytes')
  const beforeReplay = await eventCounts(browser, eventRuleId)
  assert.equal((await postGearJobEvent(gearJob, raw)).status, 200)
  assert.deepEqual(await eventCounts(browser, eventRuleId), beforeReplay)
  const conflict = Buffer.from(raw.toString('utf8').replace('{"source"', '{ "source"'))
  assert.equal((await postGearJobEvent(gearJob, conflict)).status, 409)
  assert.deepEqual(await eventCounts(browser, eventRuleId), beforeReplay)
  await evaluate(`document.querySelector('[data-rule-action="pause"]').scrollIntoView({block:'center'})`)
  await mobilePreflightCheck(browser, '[data-rule-action="pause"]')
  await tap(browser, '[data-rule-action="pause"]')
  await waitFor(`state.automationDetail?.rule?.status==='paused'`)
  await evaluate(`document.querySelector('[data-rule-action="resume"]').scrollIntoView({block:'center'})`)
  await mobilePreflightCheck(browser, '[data-rule-action="resume"]')
  await tap(browser, '[data-rule-action="resume"]')
  await waitFor(`state.automationDetail?.rule?.status==='active'`)
  const old = gearJobBody(config.workOrderId, gearJob.originalModified)
  assert.equal((await postGearJobEvent(gearJob, old)).status, 200)
  await waitFor(`reloadAll().then(()=>openAutomation(${JSON.stringify(eventRuleId)})).then(()=>state.automationDetail.occurrences.some(item=>item.event?.sourceRevision===${JSON.stringify(gearJob.originalModified)}&&item.status==='skipped'&&item.reason==='before-active-window'&&!item.workId))`)
  await captureStep('07', '暂停并恢复后拒绝旧事件', '验证 active window 不把暂停期间旧事实补跑为工作', 'skipped before-active-window + no work', `(()=>{const item=state.automationDetail.occurrences.find(value=>value.event?.sourceRevision===${JSON.stringify(gearJob.originalModified)});return {status:item.status,reason:item.reason,workCreated:Boolean(item.workId),ruleStatus:state.automationDetail.rule.status}})()`)
  const second = await saveGearJobWorkOrder(gearJob)
  assert.ok(first.modified < second.modified)
  await waitForEventCompletions(browser, eventRuleId, 2, timers)
  await evaluate(`openAutomation(${JSON.stringify(eventRuleId)})`)
  await captureStep('08', '恢复后新 Frappe 保存再次触发', '验证新 source revision 被正常受理且没有复用旧工作', 'two distinct completed works and deliveries', `(()=>{const items=state.automationDetail.occurrences.filter(item=>item.event&&item.workId),works=items.map(item=>state.bootstrap.works.find(value=>value.id===item.workId)),deliveries=items.map(item=>state.channels.deliveries.find(value=>value.id===item.deliveryId));return {accepted:items.length,sourceRevisions:items.map(item=>item.event.sourceRevision),workStatuses:works.map(item=>item.status),deliveryStatuses:deliveries.map(item=>item.status)}})()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const beforeRestart = await eventCounts(browser, eventRuleId)
  await restartRuntime()
  await pointerClick(browser, '[data-view="works"]')
  await evaluate(`openAutomation(${JSON.stringify(eventRuleId)})`)
  await waitFor(`state.automationDetail?.rule?.id===${JSON.stringify(eventRuleId)}&&state.automationDetail.rule.status==='active'`)
  assert.deepEqual(await eventCounts(browser, eventRuleId), beforeRestart)
  assert.equal((await postGearJobEvent(gearJob, raw)).status, 200)
  assert.deepEqual(await eventCounts(browser, eventRuleId), beforeRestart)
  await captureStep('09', '正常重启并重投已受理事件', '验证同一 state 的历史、活动规则和去重事实在正常重启后保持', 'history retained + active + replay 200 + no new work', `(()=>({status:state.automationDetail.rule.status,occurrences:state.automationDetail.occurrences.length,works:state.automationDetail.occurrences.filter(item=>item.workId).length}))()`)
  const revokeClick = pointerClick(browser, '[data-rule-action="revoke"]')
  await browser.waitForDialog()
  await send('Page.handleJavaScriptDialog', { accept: true })
  await revokeClick
  await waitFor(`state.automationDetail?.rule?.status==='revoked'`)
  const beforeRevokedSave = await eventCounts(browser, eventRuleId)
  const third = await saveGearJobWorkOrder(gearJob)
  assert.ok(second.modified < third.modified)
  await waitGearJobRequestLogs(gearJob, 3, 30_000)
  assert.deepEqual(await eventCounts(browser, eventRuleId), beforeRevokedSave)
  await captureStep('10', '撤销规则后再次正常保存工单', '验证真实 Webhook 仍到达但已撤销规则不产生 occurrence、work 或 delivery', 'revoked + webhook ignored + zero new business records', `(()=>({status:state.automationDetail.rule.status,occurrences:state.automationDetail.occurrences.length,works:state.automationDetail.occurrences.filter(item=>item.workId).length,deliveries:state.automationDetail.occurrences.filter(item=>item.deliveryId).length}))()`)
  gearJob.completedJourney = true
  return { ruleId, targetIso, formReadyAt, daily, event: { ruleId: eventRuleId, firstModified: first.modified, secondModified: second.modified, thirdModified: third.modified, replayStatus: 200, conflictStatus: 409, restartReplayStatus: 200, revokedSaveIgnored: true, oldModified: gearJob.originalModified }, steps, public: publicFacts }
}

async function waitForEventCompletions(browser, ruleId, count, timers) {
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    const done = await browser.evaluate(`reloadAll().then(()=>openAutomation(${JSON.stringify(ruleId)})).then(()=>{const items=state.automationDetail?.occurrences?.filter(item=>item.event&&item.workId)||[];return items.filter(item=>state.bootstrap.works.find(value=>value.id===item.workId)?.status==='completed'&&state.channels.deliveries.find(value=>value.id===item.deliveryId)?.status==='delivered').length>=${count}})`)
    if (done) return
    await delay(2_000, timers)
  }
  throw new Error(`event work did not complete: ${count}`)
}

async function eventCounts(browser, ruleId) { await browser.evaluate(`reloadAll().then(()=>openAutomation(${JSON.stringify(ruleId)}))`); return browser.evaluate(`(()=>{const items=state.automationDetail.occurrences;return {occurrences:items.length,works:items.filter(item=>item.workId).length}})()`) }
function gearJobBody(workOrderId, modified) { return Buffer.from(JSON.stringify({ source: EVENT_SOURCE_ID, event: 'on_update', doctype: 'Work Order', name: workOrderId, modified }).replaceAll('":', '": ').replaceAll(',"', ', "')) }
async function postGearJobEvent(context, body) {
  const code = `import base64,hashlib,hmac,os,urllib.request,urllib.error\nbody=base64.b64decode(os.environ['GW_BODY'])\nsecret=open(os.environ['GW_SECRET_FILE'],'rb').read().strip()\nsignature=base64.b64encode(hmac.new(secret,body,hashlib.sha256).digest()).decode()\nrequest=urllib.request.Request('http://172.20.0.1:39471/p5/gearjob/work-order',data=body,headers={'Content-Type':'application/json','X-Frappe-Webhook-Signature':signature},method='POST')\ntry:\n print(urllib.request.urlopen(request,timeout=5).status)\nexcept urllib.error.HTTPError as error:\n print(error.code)`
  const status = Number(await capture('docker', ['exec', '-e', `GW_BODY=${body.toString('base64')}`, '-e', `GW_SECRET_FILE=${context.containerSecret}`, 'deploy-frappe-1', 'python', '-c', code]))
  return { status }
}
async function gearJobRequestLogs(context) { const output = await gearJobConsole(`
import json, os, frappe
logs=frappe.get_all('Webhook Request Log',filters={'webhook':os.environ['GW_WEBHOOK']},fields=['response','error'])
print('GW_ACCEPT_LOGS ' + json.dumps({'count':len(logs),'accepted':sum(bool(row.response) and json.loads(row.response).get('status') == 'accepted' for row in logs),'errors':sum(bool(row.error) for row in logs)}))
`, { GW_WEBHOOK: context.webhook }); return parseConsoleJson(output, 'GW_ACCEPT_LOGS ') }
async function waitGearJobRequestLogs(context, count, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const summary = await gearJobRequestLogs(context); if (summary.count >= count) return summary; await new Promise(resolveWait => setTimeout(resolveWait, 250)) } throw new Error(`GearJob Webhook Request Log did not reach ${count}`) }

async function readback(statePath, dshPath, journey, config) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const rule = state.automationRules.find(item => item.id === journey.daily.ruleId)
  const occurrence = state.automationOccurrences.find(item => item.ruleId === rule?.id && item.workId)
  const work = state.works.find(item => item.id === occurrence?.workId)
  const result = work?.results?.at(-1)
  const execution = work?.executions?.find(item => item.resultId === result?.id) ?? work?.executions?.at(-1)
  const delivery = state.deliveries.find(item => item.id === occurrence?.deliveryId)
  const conversation = state.channelConversations.find(item => item.id === delivery?.targetConversationId)
  const route = state.modelRoutes.find(item => item.id === state.employees.find(employee => employee.id === work?.employeeId)?.modelRouteId)
  const connection = state.connections.find(item => item.id === work?.connectionId)
  assert.ok(rule && occurrence && work && result && execution && delivery && conversation && route && connection)
  assert.equal(rule.maxRuns, 1); assert.equal(rule.trigger.kind, 'daily-time'); assert.equal(rule.trigger.timeZone, 'Asia/Shanghai'); assert.equal(work.status, 'completed'); assert.equal(delivery.status, 'delivered')
  assert.equal(result.kind, 'gearjob.work-order.observation'); assert.equal(result.toolName, 'geneway_gearjob_read_work_order')
  assert.equal(result.source.sourceRecordId, `Work Order:${config.workOrderId}`); assert.equal(result.source.sourceSystem, 'GearJob'); assert.equal(result.source.sourceEnvironment, 'external-test'); assert.equal(result.source.dataMode, 'synthetic'); assert.equal(result.source.evidenceMode, 'real-frappe-rest')
  assert.equal(result.payload.plannedQuantity, 10); assert.equal(result.payload.completedQuantity, 4); assert.equal(result.payload.unit, 'Nos'); assert.ok(result.dshSessionRef); assert.ok(Number.isInteger(execution.dshEventCount) && execution.dshEventCount > 0)
  assert.equal(connection.sourceSystem, 'GearJob'); assert.equal(connection.sourceEnvironment, 'external-test'); assert.equal(connection.dataMode, 'synthetic'); assert.equal(connection.evidenceMode, 'real-frappe-rest')
  assert.equal(route.provider, config.runtime.model.provider); assert.equal(route.model, config.runtime.model.model); assert.equal(route.provider, 'zenmux'); assert.equal(route.model, 'deepseek/deepseek-v4-pro')
  assert.match(delivery.providerMessageId, /^om_/)
  const dsh = await dshEvidence(dshPath, result.dshSessionRef); assert.ok(dsh.sessionCount >= 1 && dsh.eventCount >= execution.dshEventCount)
  assert.ok(Math.abs(Date.parse(localDateTimeIso(occurrence.scheduledDate, rule.trigger.time)) - Date.parse(journey.targetIso)) <= 60_000)
  assert.ok(Date.parse(journey.targetIso) - journey.formReadyAt >= 90_000)
  const eventRule = state.automationRules.find(item => item.id === journey.event.ruleId)
  const eventOccurrences = state.automationOccurrences.filter(item => item.ruleId === eventRule?.id)
  const accepted = eventOccurrences.filter(item => item.workId).sort((left, right) => left.event.sourceRevision.localeCompare(right.event.sourceRevision))
  const skipped = eventOccurrences.find(item => item.event?.sourceRevision === journey.event.oldModified)
  assert.ok(eventRule); assert.equal(eventRule.trigger.kind, 'gearjob-work-order-update'); assert.equal(eventRule.trigger.sourceId, EVENT_SOURCE_ID); assert.equal(eventRule.status, 'revoked')
  assert.equal(accepted.length, 2); assert.deepEqual(accepted.map(item => item.event.sourceRevision), [journey.event.firstModified, journey.event.secondModified]); assert.ok(accepted.every(item => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(item.event.sourceRevision)))
  assert.ok(skipped); assert.equal(skipped.status, 'skipped'); assert.equal(skipped.reason, 'before-active-window'); assert.equal(skipped.workId, null)
  const eventDeliveries = []
  for (const item of accepted) {
    const eventWork = state.works.find(value => value.id === item.workId)
    const eventResult = eventWork?.results?.at(-1)
    const eventExecution = eventWork?.executions?.find(value => value.resultId === eventResult?.id) ?? eventWork?.executions?.at(-1)
    const eventDelivery = state.deliveries.find(value => value.id === item.deliveryId)
    const eventConversation = state.channelConversations.find(value => value.id === eventDelivery?.targetConversationId)
    assert.ok(eventWork && eventResult && eventExecution && eventDelivery && eventConversation)
    assert.equal(eventWork.status, 'completed'); assert.equal(eventDelivery.status, 'delivered'); assert.equal(eventResult.kind, 'gearjob.work-order.observation'); assert.equal(eventResult.toolName, 'geneway_gearjob_read_work_order'); assert.equal(eventResult.source.sourceRecordId, `Work Order:${config.workOrderId}`); assert.equal(eventResult.source.sourceRevision, item.event.sourceRevision); assert.equal(eventResult.source.sourceEnvironment, 'external-test'); assert.equal(eventResult.source.dataMode, 'synthetic'); assert.ok(eventResult.dshSessionRef); assert.ok(eventExecution.dshEventCount > 0)
    const eventDsh = await dshEvidence(dshPath, eventResult.dshSessionRef); assert.ok(eventDsh.sessionCount >= 1 && eventDsh.eventCount >= eventExecution.dshEventCount)
    eventDeliveries.push({ occurrence: item, work: eventWork, result: eventResult, execution: eventExecution, delivery: eventDelivery, conversation: eventConversation, dsh: eventDsh })
  }
  return { rule, occurrence, work, execution, result, delivery, conversation, route, dsh, event: { rule: eventRule, occurrences: eventOccurrences, accepted: eventDeliveries, skipped }, deliveries: [{ occurrence, work, result, execution, delivery, conversation, dsh }, ...eventDeliveries] }
}

async function verifyLark(config, messageId, chatId, expectedText) {
  const raw = await capture('lark-cli', ['im', '+messages-mget', '--profile', config.larkProfile, '--as', 'bot', '--message-ids', messageId, '--no-reactions', '--format', 'json'])
  const value = JSON.parse(raw), messages = findObjects(value, item => item.message_id === messageId || item.messageId === messageId)
  assert.equal(messages.length, 1)
  const message = messages[0], text = stringValue(message, ['text', 'content']), foundChat = stringValue(message, ['chat_id', 'chatId']), msgType = stringValue(message, ['msg_type', 'msgType', 'message_type'])
  assert.ok(text); assert.equal(foundChat, chatId); assert.equal(msgType, 'text'); assert.notEqual(message.deleted, true); assert.equal(sha256(text), sha256(expectedText))
  return { total: 1, msgType: 'text', textSha256: sha256(expectedText), deleted: false, chatMatch: true, messageId: shortHash(messageId), chatId: shortHash(chatId), idempotency: 'provider-message-id-readback' }
}

async function finishMedia(video, cover, framesDir, steps) {
  await run('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'])
  const probe = JSON.parse(await capture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-show_entries', 'format=duration', '-of', 'json', video]))
  const stream = probe.streams?.[0]
  assert.equal(stream?.codec_name, 'h264'); assert.equal(stream?.pix_fmt, 'yuv420p'); assert.equal(stream?.width, 1440); assert.equal(stream?.height, 900); assert.ok(Number(probe.format?.duration) > 0)
  const screenshots = (await listFiles(framesDir)).sort(); assert.equal(screenshots.length, steps.length); assert.ok(screenshots.every(path => path.endsWith('.png'))); await copyFile(screenshots[0], cover); await chmod(cover, 0o600)
  for (const image of screenshots) await run('ffmpeg', ['-v', 'error', '-i', image, '-f', 'null', '-'])
  return { video: basename(video), cover: basename(cover), steps: screenshots.map(path => relative(dirname(video), path)), codec: 'h264', width: 1440, height: 900, fullDecode: true, pixelSecretBoundary: 'PNG bytes are not proof of pixel secrecy; DOM/AX/text checks ran before and after recording.' }
}

async function createFixture(paths, config, adminPassword, ownerPassword) {
  for (const path of [paths.root, paths.secrets, paths.dsh, paths.chrome]) await mkdir(path, { recursive: true, mode: 0o700 })
  await copyFile(config.gearJobCredential, join(paths.secrets, 'gearjob.json')); await chmod(join(paths.secrets, 'gearjob.json'), 0o600)
  await copyFile(config.feishuCredential, join(paths.secrets, FEISHU_CREDENTIAL_REF)); await chmod(join(paths.secrets, FEISHU_CREDENTIAL_REF), 0o600)
  await writeFile(paths.catalog, JSON.stringify({ version: 1, targets: [{ kind: 'gearjob-rest', targetIdentity: 'gearjob-p5', baseUrl: config.gearJobUrl, hostHeader: config.gearJobHost, credentialRef: 'gearjob.json', sourceSystem: 'GearJob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' }] }) + '\n', { mode: 0o600 })
  await run(process.execPath, ['scripts/init-p2-auth.mjs', '--mode', 'bootstrap', '--state', paths.state, '--auth', paths.auth], { env: { ...process.env, GENEWAY_ADMIN_PASSWORD: adminPassword, GENEWAY_MEMBER_PASSWORD: ownerPassword } })
  await seedEnrollment(paths.state, config.enrollment, config.feishuAppId, config.feishuTenantId)
  await writeFile(paths.eventSecret, randomBytes(48).toString('base64url'), { mode: 0o600 })
  for (const path of [paths.state, paths.auth, paths.catalog, join(paths.secrets, 'gearjob.json'), join(paths.secrets, FEISHU_CREDENTIAL_REF)]) assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(paths.eventSecret)).mode & 0o777, 0o600)
}

async function prepareGearJob(config, paths) {
  const runId = `geneway-p5-${Date.now()}-${process.pid}`
  const context = { runId, workOrderId: config.workOrderId, webhook: `Geneway P5 Acceptance ${runId}`, secretFile: paths.eventSecret, containerSecret: `/tmp/${runId}.secret`, workerPid: `/tmp/${runId}.worker.pid`, workerLog: `/tmp/${runId}.worker.log`, defaultBefore: '', longBefore: '', prepared: false, workerStarted: false }
  try {
    assert.equal(await capture('git', ['rev-parse', 'HEAD'], { cwd: '/home/gewu/work/gearjob' }), GEARJOB_COMMIT)
    assert.equal(await capture('docker', ['exec', 'deploy-frappe-1', 'git', '-C', '/workspace/gearjob', 'rev-parse', 'HEAD']), GEARJOB_COMMIT)
    await run('git', ['diff', '--quiet', '--exit-code'], { cwd: '/home/gewu/work/gearjob' })
    await run('git', ['diff', '--cached', '--quiet', '--exit-code'], { cwd: '/home/gewu/work/gearjob' })
    await run('docker', ['exec', 'deploy-frappe-1', 'git', '-C', '/workspace/gearjob', 'diff', '--quiet', '--exit-code'])
    await run('docker', ['exec', 'deploy-frappe-1', 'git', '-C', '/workspace/gearjob', 'diff', '--cached', '--quiet', '--exit-code'])
    const networks = JSON.parse(await capture('docker', ['inspect', 'deploy-frappe-1', '--format', '{{json .NetworkSettings.Networks}}']))
    const network = Object.values(networks).find(item => item.IPAddress === EVENT_SOURCE_ADDRESS && item.Gateway === EVENT_HOST)
    assert.ok(network, 'GearJob Docker bridge identity drifted')
    context.defaultBefore = await redisQueue('default')
    context.longBefore = await redisQueue('long')
    assert.equal(context.longBefore, '', 'dedicated long queue must be empty before acceptance')
    await run('docker', ['cp', paths.eventSecret, `deploy-frappe-1:${context.containerSecret}`])
    await run('docker', ['exec', 'deploy-frappe-1', 'chmod', '600', context.containerSecret])
    context.webhookMayExist = true
    const output = await gearJobConsole(`
import json, os, frappe
from pathlib import Path
frappe.set_user('Administrator')
name = os.environ['GW_WO']
webhook_name = os.environ['GW_WEBHOOK']
assert frappe.db.exists('Work Order', name)
assert not frappe.db.exists('Webhook', webhook_name)
doc = frappe.get_doc('Work Order', name)
secret = Path(os.environ['GW_SECRET_FILE']).read_text().strip()
webhook = frappe.get_doc({'doctype':'Webhook','name':webhook_name,'webhook_doctype':'Work Order','webhook_docevent':'on_update','enabled':1,'condition':f'doc.name == {name!r}','request_url':'http://172.20.0.1:39471/p5/gearjob/work-order','timeout':5,'background_jobs_queue':'long','request_method':'POST','request_structure':'JSON','enable_security':1,'webhook_secret':secret,'webhook_headers':[{'key':'Content-Type','value':'application/json'}],'webhook_json':'{"source":"gearjob:dev.localhost","event":"on_update","doctype":"Work Order","name":"{{ doc.name }}","modified":"{{ doc.modified }}"}'})
webhook.insert(ignore_permissions=True)
frappe.db.commit()
print('GW_ACCEPT_SETUP ' + json.dumps({'workOrder':name,'webhook':webhook.name,'originalQty':float(doc.qty),'originalModified':str(doc.modified),'timezone':frappe.get_system_settings('time_zone')}))
`, { GW_WO: config.workOrderId, GW_WEBHOOK: context.webhook, GW_SECRET_FILE: context.containerSecret })
    const setup = parseConsoleJson(output, 'GW_ACCEPT_SETUP ')
    assert.equal(setup.workOrder, config.workOrderId); assert.equal(setup.webhook, context.webhook); assert.equal(setup.timezone, 'Asia/Chongqing'); assert.match(setup.originalModified, /\.\d{6}$/)
    Object.assign(context, setup, { prepared: true })
    return context
  } catch (error) {
    await cleanupGearJob(context).catch(() => undefined)
    throw error
  }
}

async function startGearJobWorker(context) {
  context.workerLaunchAttempted = true
  await run('docker', ['exec', '-d', '-e', `GW_PID_FILE=${context.workerPid}`, '-e', `GW_LOG_FILE=${context.workerLog}`, 'deploy-frappe-1', 'bash', '-lc', 'echo $$ > "$GW_PID_FILE"; cd /workspace/development/frappe-bench; exec bench --site dev.localhost worker --queue long > "$GW_LOG_FILE" 2>&1'])
  for (let index = 0; index < 100; index += 1) {
    const ready = await capture('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test -s "$1" && kill -0 "$(cat "$1")" && echo ready', 'sh', context.workerPid]).catch(() => '')
    if (ready === 'ready') { context.workerStarted = true; return }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('GearJob long worker failed to start')
}

async function saveGearJobWorkOrder(context, delta = 1) {
  const output = await gearJobConsole(`
import json, os, frappe
frappe.set_user('Administrator')
doc = frappe.get_doc('Work Order', os.environ['GW_WO'])
doc.qty = float(doc.qty) + float(os.environ['GW_DELTA'])
doc.save(ignore_permissions=True)
frappe.db.commit()
print('GW_ACCEPT_UPDATE ' + json.dumps({'modified':str(doc.modified),'qty':float(doc.qty)}))
`, { GW_WO: context.workOrderId, GW_DELTA: String(delta) })
  const update = parseConsoleJson(output, 'GW_ACCEPT_UPDATE ')
  assert.match(update.modified, /\.\d{6}$/)
  context.lastModified = update.modified
  return update
}

async function cleanupGearJob(context) {
  if (!context) return
  const hasDatabaseState = context.prepared || context.webhookMayExist
  await bestEffortCleanup([
    async () => {
      if (!hasDatabaseState) return
      await gearJobConsole(`
import os, frappe
frappe.set_user('Administrator')
webhook = os.environ['GW_WEBHOOK']
if frappe.db.exists('Webhook', webhook): frappe.delete_doc('Webhook', webhook, ignore_permissions=True, force=True)
frappe.db.commit()
print('GW_ACCEPT_WEBHOOK_REMOVED')
`, { GW_WEBHOOK: context.webhook })
    },
    async () => { if (context.workerLaunchAttempted) await waitQueueEmpty('long', 30_000) },
    async () => { if (context.workerLaunchAttempted) await run('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test ! -s "$1" || kill -TERM "$(cat "$1")" 2>/dev/null || true', 'sh', context.workerPid]) },
    async () => {
      if (!context.workerLaunchAttempted) return
      for (let index = 0; index < 100; index += 1) {
        const running = await capture('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test -s "$1" && kill -0 "$(cat "$1")" 2>/dev/null && echo yes || true', 'sh', context.workerPid])
        if (!running) return
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
      await run('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test ! -s "$1" || kill -KILL "$(cat "$1")" 2>/dev/null || true', 'sh', context.workerPid])
      const running = await capture('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test -s "$1" && kill -0 "$(cat "$1")" 2>/dev/null && echo yes || true', 'sh', context.workerPid])
      assert.equal(running, '', 'GearJob long worker did not stop')
    },
    async () => {
      if (!context.workerLaunchAttempted) return
      const log = await capture('docker', ['exec', 'deploy-frappe-1', 'sh', '-lc', 'test -f "$1" && cat "$1" || true', 'sh', context.workerLog])
      const queued = (await redisQueue('long')).split('\n').filter(Boolean)
      context.jobIds = [...new Set([...log.matchAll(/\((dev\.localhost\|\|[0-9a-f-]{36})\)/g)].map(match => match[1]).concat(queued))]
      await cleanupRqJobs(context.jobIds)
    },
    async () => {
      if (!hasDatabaseState) return
      const summaryOutput = await gearJobConsole(`
import json, os, frappe
frappe.set_user('Administrator')
webhook = os.environ['GW_WEBHOOK']
name = os.environ['GW_WO']
logs = frappe.get_all('Webhook Request Log', filters={'webhook':webhook}, fields=['response','error'])
print('GW_ACCEPT_LOGS ' + json.dumps({'count':len(logs),'accepted':sum(bool(row.response) and json.loads(row.response).get('status') == 'accepted' for row in logs),'errors':sum(bool(row.error) for row in logs)}))
if frappe.db.exists('Webhook', webhook): frappe.delete_doc('Webhook', webhook, ignore_permissions=True, force=True)
for row in frappe.get_all('Webhook Request Log', filters={'webhook':webhook}, pluck='name'): frappe.delete_doc('Webhook Request Log', row, ignore_permissions=True, force=True)
if os.environ.get('GW_ORIGINAL_QTY') and frappe.db.exists('Work Order', name):
    doc = frappe.get_doc('Work Order', name)
    if float(doc.qty) != float(os.environ['GW_ORIGINAL_QTY']):
        doc.qty = float(os.environ['GW_ORIGINAL_QTY'])
        doc.save(ignore_permissions=True)
frappe.db.commit()
print('GW_ACCEPT_CLEANUP_OK')
`, { GW_WEBHOOK: context.webhook, GW_WO: context.workOrderId, GW_ORIGINAL_QTY: context.originalQty === undefined ? '' : String(context.originalQty) })
      context.requestLogs = parseConsoleJson(summaryOutput, 'GW_ACCEPT_LOGS ')
      if (context.completedJourney) assert.deepEqual(context.requestLogs, { count: 3, accepted: 2, errors: 0 })
    },
    async () => { await run('docker', ['exec', 'deploy-frappe-1', 'rm', '-f', context.containerSecret, context.workerPid, context.workerLog]) },
    async () => {
      if (!context.prepared) return
      assert.equal(await redisQueue('default'), context.defaultBefore, 'default queue IDs changed')
      assert.equal(await redisQueue('long'), '', 'long queue is not empty after acceptance')
    },
    async () => {
      if (!context.prepared) return
      const output = await gearJobConsole(`
import json, os, frappe
print('GW_ACCEPT_POST ' + json.dumps({'webhook':bool(frappe.db.exists('Webhook',os.environ['GW_WEBHOOK'])),'logs':frappe.db.count('Webhook Request Log',{'webhook':os.environ['GW_WEBHOOK']}),'qty':float(frappe.db.get_value('Work Order',os.environ['GW_WO'],'qty'))}))
`, { GW_WEBHOOK: context.webhook, GW_WO: context.workOrderId })
      const post = parseConsoleJson(output, 'GW_ACCEPT_POST ')
      assert.deepEqual(post, { webhook: false, logs: 0, qty: context.originalQty })
    },
  ])
  if (context.prepared) context.cleanup = { webhookRemoved: true, requestLogsRemoved: true, workOrderQuantityRestored: true, sourceRevisionAdvancedByAcceptance: true, workerStopped: true, generatedJobsRemoved: context.jobIds?.length ?? 0, secretRemoved: true, listenerStoppedByRuntimeCleanup: true, defaultQueueIdsUnchanged: true, longQueueEmpty: true }
}

async function bestEffortCleanup(actions) { let firstError; for (const action of actions) { try { await action() } catch (error) { firstError ??= error } } if (firstError) throw firstError }

async function gearJobConsole(code, env = {}) {
  const args = ['exec', '-i']
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`)
  args.push('deploy-frappe-1', 'bash', '-lc', 'cd /workspace/development/frappe-bench && bench --site dev.localhost console')
  return capture('docker', args, { input: `exec(${JSON.stringify(code)})\nexit()\n` })
}

function parseConsoleJson(output, marker) { const line = output.split(/\r?\n/).find(value => value.includes(marker)); if (!line) throw new Error(`GearJob console marker missing: ${marker.trim()}`); return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) }
async function redisQueue(name) { return capture('docker', ['exec', 'deploy-redis-queue-1', 'redis-cli', '--raw', 'LRANGE', `rq:queue:workspace-development-frappe-bench:${name}`, '0', '-1']) }
async function waitQueueEmpty(name, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await redisQueue(name) === '') return; await new Promise(resolveWait => setTimeout(resolveWait, 250)) } throw new Error(`${name} queue did not drain`) }
async function cleanupRqJobs(ids) { const queue = 'rq:queue:workspace-development-frappe-bench:long'; for (const id of ids) { await run('docker', ['exec', 'deploy-redis-queue-1', 'redis-cli', 'LREM', queue, '0', id]); await run('docker', ['exec', 'deploy-redis-queue-1', 'redis-cli', 'DEL', `rq:job:${id}`]); const keys = (await capture('docker', ['exec', 'deploy-redis-queue-1', 'redis-cli', '--scan', '--pattern', 'rq:*long*'])).split('\n').filter(key => key && key !== queue); for (const key of keys) await run('docker', ['exec', 'deploy-redis-queue-1', 'redis-cli', 'ZREM', key, id]).catch(() => undefined) } }

async function seedEnrollment(statePath, enrollment, providerAppId, providerTenantId) {
  const state = JSON.parse(await readFile(statePath, 'utf8')), now = new Date().toISOString()
  state.channelApps = [...(state.channelApps ?? []), { id: enrollment.channelAppId, provider: 'feishu', providerAppId, providerTenantId, credentialRef: FEISHU_CREDENTIAL_REF, enabled: true, allowedScopes: ['result'], revision: 1, status: 'unavailable', createdAt: now, updatedAt: now }]
  state.channelIdentities = [...(state.channelIdentities ?? []), { id: enrollment.identityId, channelAppId: enrollment.channelAppId, providerUserId: enrollment.providerUserId, memberId: enrollment.memberId, verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }]
  state.channelConversations = [...(state.channelConversations ?? []), { id: enrollment.conversationId, channelAppId: enrollment.channelAppId, providerConversationId: enrollment.providerConversationId, identityId: enrollment.identityId, memberId: enrollment.memberId, type: 'private', allowedScopes: ['result'], verificationMethod: 'link-code', status: 'active', revision: 1, createdAt: now, updatedAt: now }]
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

async function startServer(paths, origin, port, config) {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, GENEWAY_PORT: String(port), GENEWAY_STATE: paths.state, GENEWAY_AUTH_FILE: paths.auth, GENEWAY_CONNECTION_CATALOG: paths.catalog, GENEWAY_SECRET_ROOT: paths.secrets, GENEWAY_DSH_HOME: paths.dsh, GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_GEARJOB_BASE_URL: config.gearJobUrl, GENEWAY_GEARJOB_CREDENTIAL_FILE: join(paths.secrets, 'gearjob.json'), GENEWAY_GEARJOB_ALLOWED_WORK_ORDER: config.workOrderId, GENEWAY_GEARJOB_HOST_HEADER: config.gearJobHost, GENEWAY_GEARJOB_TARGET_IDENTITY: 'gearjob-p5', GENEWAY_GEARJOB_EVENT_SECRET_FILE: paths.eventSecret, GENEWAY_GEARJOB_EVENT_SOURCE_ID: EVENT_SOURCE_ID, GENEWAY_GEARJOB_EVENT_SOURCE_ADDRESS: EVENT_SOURCE_ADDRESS, GENEWAY_GEARJOB_EVENT_HOST: EVENT_HOST, GENEWAY_GEARJOB_EVENT_PORT: String(EVENT_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4_000) })
  for (let index = 0; index < 200; index += 1) { if (child.exitCode !== null) throw Object.assign(new Error(`Geneway failed: ${redact(error)}`), { process: child }); try { if ((await fetch(origin)).ok) return child } catch {}; await new Promise(resolveWait => setTimeout(resolveWait, 100)) }
  throw Object.assign(new Error('Geneway startup timed out'), { process: child })
}

async function connectBrowser(port, origin) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find(item => item.type === 'page' && item.url.startsWith(origin)) ?? targets.find(item => item.type === 'page')
  if (!target) throw new Error('Chrome page target unavailable')
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0, dialogOpen = false, dialogWaiter
  const errors = { console: [], page: [], network: [] }
  await new Promise((resolveOpen, rejectOpen) => { socket.onopen = resolveOpen; socket.onerror = rejectOpen })
  socket.onmessage = event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (request) { pending.delete(message.id); return message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) } if (message.method === 'Page.javascriptDialogOpening') { dialogOpen = true; dialogWaiter?.(); dialogWaiter = undefined } if (message.method === 'Runtime.exceptionThrown') errors.page.push('exception'); if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.console.push('console'); if (message.method === 'Network.loadingFailed' && !message.params.canceled) errors.network.push('network') }
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => { const id = ++sequence; pending.set(id, { resolve: resolveSend, reject: rejectSend }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error('browser evaluation failed'); return result.result.value }
  const waitFor = async (expression, timeout = 30_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await evaluate(expression).catch(() => false)) return; await new Promise(resolveWait => setTimeout(resolveWait, 250)) } throw new Error(`browser wait timed out: ${redact(expression.slice(0, 120))}`) }
  const waitForDialog = async (timeout = 5_000) => { if (dialogOpen) { dialogOpen = false; return } await Promise.race([new Promise(resolveDialog => { dialogWaiter = () => { dialogOpen = false; resolveDialog() } }), new Promise((_resolve, rejectDialog) => setTimeout(() => rejectDialog(new Error('browser dialog timed out')), timeout))]) }
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable'); await send('Accessibility.enable'); await send('Page.navigate', { url: origin }); await waitFor(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`)
  return { socket, send, evaluate, waitFor, waitForDialog, errors }
}

async function login(evaluate, waitFor, name, password) {
  await evaluate(`document.querySelector('#login-name').value=${JSON.stringify(name)};document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-button').click()`)
  await waitFor(`!document.querySelector('#app').classList.contains('hidden')`)
}

async function validateFormal(input) {
  const record = await validateRecord(input.record), feishuCredential = await privateFile(input.feishuCredential, 'Feishu credential'), gearJobCredential = await privateFile(input.gearJobCredential, 'GearJob credential')
  for (const [name, value, pattern] of [['--feishu-app-id', input.feishuAppId, /^cli_[0-9a-fA-F]{16}$/], ['--feishu-tenant-id', input.feishuTenantId, /^[A-Za-z0-9._-]{2,128}$/], ['--lark-profile', input.larkProfile, /^[A-Za-z0-9._-]{1,128}$/], ['--enrollment-user-id', input.enrollmentUserId, /^ou_[A-Za-z0-9_-]{4,128}$/], ['--enrollment-message-id', input.enrollmentMessageId, /^om_[A-Za-z0-9_-]{4,128}$/], ['--enrollment-chat-id', input.enrollmentChatId, /^oc_[A-Za-z0-9_-]{4,128}$/], ['--work-order-id', input.workOrderId, /^[A-Za-z0-9._/-]{1,140}$/]]) if (!pattern.test(value ?? '')) throw new Error(`${name} is required or invalid`)
  await assertLarkProfileApp(input.larkProfile, input.feishuAppId)
  const credential = JSON.parse(await readFile(feishuCredential, 'utf8'))
  if (credential.appId !== input.feishuAppId || typeof credential.appSecret !== 'string' || !credential.appSecret.trim()) throw new Error('Feishu credential/appId mismatch')
  const runtimeEnv = { ...process.env, GENEWAY_GEARJOB_BASE_URL: input.gearJobUrl ?? process.env.GENEWAY_GEARJOB_BASE_URL, GENEWAY_GEARJOB_CREDENTIAL_FILE: gearJobCredential, GENEWAY_GEARJOB_ALLOWED_WORK_ORDER: input.workOrderId, GENEWAY_GEARJOB_HOST_HEADER: input.gearJobHost ?? process.env.GENEWAY_GEARJOB_HOST_HEADER, GENEWAY_GEARJOB_TARGET_IDENTITY: input.gearJobTargetIdentity ?? process.env.GENEWAY_GEARJOB_TARGET_IDENTITY }
  const runtime = readRuntimeConfig(runtimeEnv, root); await validateRuntimeConfig(runtime)
  if (!runtime.source.configured) throw new Error(`GearJob runtime config is not configured: ${runtime.source.error ?? 'unknown'}`)
  if (runtime.model.provider !== 'zenmux' || runtime.model.model !== 'deepseek/deepseek-v4-pro' || !runtime.model.configured) throw new Error('runtime settings must configure ZenMux DeepSeek V4 Pro through actual settings env')
  if (process.env.GENEWAY_GEARJOB_BASE_URL && process.env.GENEWAY_GEARJOB_BASE_URL !== runtime.source.baseUrl) throw new Error('conflicting GearJob base URL sources')
  if (process.env.GENEWAY_GEARJOB_CREDENTIAL_FILE && resolve(process.env.GENEWAY_GEARJOB_CREDENTIAL_FILE) !== resolve(gearJobCredential)) throw new Error('conflicting GearJob credential sources')
  const gearRaw = await readFile(gearJobCredential, 'utf8'), settings = readSettings(process.env), settingsToken = settings?.env?.ANTHROPIC_AUTH_TOKEN
  let gearValue; try { gearValue = JSON.parse(gearRaw) } catch { gearValue = gearRaw }
  const secretNeedles = [...stringsFrom(credential), ...stringsFrom(gearValue), gearRaw, settingsToken, process.env.ZENMUX_API_KEY].filter(value => typeof value === 'string' && value.length >= 8)
  return { ...input, record, feishuCredential, gearJobCredential, gearJobUrl: runtime.source.baseUrl, gearJobHost: runtime.source.hostHeader ?? new URL(runtime.source.baseUrl).hostname, runtime, secretNeedles: [...new Set(secretNeedles)] }
}

async function assertLarkProfileApp(profile, expectedAppId) { const raw = await capture('lark-cli', ['profile', 'list']); const value = JSON.parse(raw), entries = Array.isArray(value) ? value : value.profiles ?? value.data?.profiles ?? []; const selected = entries.find(item => item?.name === profile || item?.profile === profile || item?.id === profile); const appIds = [...new Set(findObjects(selected ?? value, item => item && (item.name === profile || item.profile === profile || item.id === profile || item.appId || item.app_id || item.providerAppId)).flatMap(item => [item.appId, item.app_id, item.providerAppId]).filter(Boolean))]; if (appIds.length !== 1 || appIds[0] !== expectedAppId) throw new Error('lark profile appId does not match --feishu-app-id') }
async function readbackEnrollment(config) {
  const text = 'Geneway P5 T7a 验收关联核验：本消息仅用于 provider readback，不代表最终用户验收。请勿发送凭据、关联码或其他秘密。'
  const receipt = await verifyLark(config, config.enrollmentMessageId, config.enrollmentChatId, text)
  const raw = await capture('lark-cli', ['im', 'chats', 'get', '--profile', config.larkProfile, '--as', 'bot', '--params', JSON.stringify({ chat_id: config.enrollmentChatId }), '--format', 'json'])
  const value = JSON.parse(raw), chat = value?.data
  assert.equal(value?.code, 0); assert.equal(chat?.chat_mode, 'p2p'); assert.equal(chat?.chat_status, 'normal'); assert.equal(chat?.owner_id, config.enrollmentUserId); assert.equal(chat?.owner_id_type, 'open_id'); assert.equal(chat?.tenant_key, config.feishuTenantId)
  const suffix = sha256(`${config.enrollmentUserId}\0${config.enrollmentChatId}`).slice(0, 16)
  return { receipt: { ...receipt, enrollmentReadback: 'message+p2p-chat' }, enrollment: { memberId: 'member-user', channelAppId: 'app-feishu-p5', identityId: `identity-${suffix}`, conversationId: `conversation-${suffix}`, providerUserId: config.enrollmentUserId, providerConversationId: config.enrollmentChatId, verificationMethod: 'lark-cli-direct-message', verificationRef: shortHash(config.enrollmentMessageId), verifiedAt: new Date().toISOString() } }
}

function parseArgs(argv) { const result = {}; for (let index = 0; index < argv.length; index += 1) { if (!argv[index].startsWith('--') || argv[index] === '--' || argv[index] === '--harness-check') continue; const key = argv[index].slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase()); result[key] = argv[++index] } return result }
function safeRecord(value) { if (typeof value !== 'string' || !value.toLowerCase().endsWith('.mp4')) throw new Error('--record <mp4> is required'); const path = resolve(root, value); if (!isWithin(artifactRoot, path) || path === artifactRoot) throw new Error('--record must stay under the repository artifacts/p5-acceptance root'); return path }
async function validateRecord(value) { const path = safeRecord(value); if (dirname(path) !== artifactRoot) throw new Error('--record must be a file directly under artifacts/p5-acceptance'); const artifacts = artifactPaths(path); for (const target of [artifacts.video, artifacts.report, artifacts.manual, artifacts.cover, failureReceiptPath(path)]) await ensurePromotionTarget(target); await ensurePromotionTarget(artifacts.frames, true); return path }
async function privateFile(value, label) { if (!value || !isAbsolute(value)) throw new Error(`${label} path must be absolute`); const path = resolve(value), info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error(`${label} must be a non-symlink 0600 regular file`); return path }
function artifactPaths(record) { const dir = dirname(record), stem = basename(record).replace(/\.mp4$/i, ''); return { root: artifactRoot, video: record, report: join(dir, `${stem}.report.json`), manual: join(dir, `${stem}.html`), cover: join(dir, `${stem}.png`), frames: join(dir, `${stem}-frames`) } }
function fixturePaths(path) { return { root: path, state: join(path, 'state.json'), auth: join(path, 'auth.json'), catalog: join(path, 'connections.json'), secrets: join(path, 'secrets'), eventSecret: join(path, 'gearjob-event.secret'), dsh: join(path, 'dsh'), chrome: join(path, 'chrome'), lock: join(path, '.geneway-automation.lock') } }
function chromeArgs(profile, port, origin) { return ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--password-store=basic', '--window-size=1440,900', '--window-position=0,0', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--app=${origin}`] }
function startRecorder(display, path) { return { process: spawn('ffmpeg', ['-y', '-video_size', '1440x900', '-framerate', '25', '-f', 'x11grab', '-i', `${display}.0`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', path], { stdio: ['pipe', 'ignore', 'pipe'] }), startedAt: Date.now() } }
async function stopRecorder(recorder) { if (!recorder?.process || recorder.process.exitCode !== null) return; recorder.process.stdin.write('q'); const code = await new Promise(resolveExit => recorder.process.once('exit', resolveExit)); if (code !== 0) throw new Error('ffmpeg failed') }
async function assertFrozen(candidate) { assert.equal(await capture('git', ['rev-parse', 'HEAD']), candidate); const dirty = (await capture('git', ['status', '--porcelain'])).split('\n').filter(Boolean).filter(line => !/^\?\? doc\/plans\/2026-09-18-geneway-dsh-greenfield\/ui-sketches/.test(line)); if (dirty.length) throw new Error(`formal acceptance requires a clean frozen candidate: ${dirty.join(', ')}`) }
async function assertCandidateTerminal(candidate) { assert.equal(await capture('git', ['rev-parse', 'HEAD']), candidate); const dirty = (await capture('git', ['status', '--porcelain'])).split('\n').filter(Boolean).filter(line => !/^\?\? doc\/plans\/2026-09-18-geneway-dsh-greenfield\/ui-sketches/.test(line)); if (dirty.length) throw new Error(`candidate changed during acceptance: ${dirty.join(', ')}`) }
async function runBoundedP5Tests(candidate) { await run('pnpm', ['test:p5']); await assertCandidateTerminal(candidate) }
async function cleanupRuntime({ browser, recorder, chrome, server, xvfb, timers, scratch, paths }) { try { await closeBrowser(browser) } finally { try { await stopTimers(timers) } finally { try { await stopRecorder(recorder) } finally { try { await stop(chrome, 'SIGTERM') } finally { try { await stop(server, 'SIGINT') } finally { try { await stop(xvfb, 'SIGTERM') } finally { let sweepError; try { await terminalScratchSweep(scratch, paths) } catch (error) { sweepError = error } finally { await rm(paths.secrets, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); await assertRemoved(scratch) } if (sweepError) throw sweepError } } } } } } }
async function terminalScratchSweep(scratch, paths) { await reacquireLock(paths.lock); const candidates = [...await listFiles(scratch), ...await listFiles(paths.dsh)]; const residual = candidates.filter(path => /(?:execution[-_.]?(?:grant|request)|(?:grant|request)[-_.]|\.tmp$)/i.test(basename(path))); assert.equal(residual.length, 0, `runtime residuals remained: ${residual.join(', ')}`) }
async function reacquireLock(path) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await run('/usr/bin/flock', ['--nonblock', path, 'true']) }
async function assertRemoved(path) { await assert.rejects(stat(path), error => error.code === 'ENOENT') }
async function stopTimers(timers) { for (const timer of timers) clearTimeout(timer); timers.clear() }
async function closeBrowser(browser) { if (!browser?.socket) return; if (browser.socket.readyState === WebSocket.OPEN) browser.socket.close(); await new Promise(resolveClose => { if (browser.socket.readyState === WebSocket.CLOSED) return resolveClose(); const timer = setTimeout(resolveClose, 2_000); browser.socket.addEventListener('close', () => { clearTimeout(timer); resolveClose() }, { once: true }) }) }
async function assertNoSymlinkPath(path, boundary) { let current = resolve(path); const stopAt = resolve(boundary); while (isWithin(stopAt, current)) { try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error(`symlink path is not allowed: ${current}`) } catch (error) { if (error.code !== 'ENOENT') throw error } if (current === stopAt) break; const next = dirname(current); if (next === current) break; current = next } }
async function ensurePromotionTarget(path, directory = false) { await assertNoSymlinkPath(path, artifactRoot); try { await lstat(path); throw new Error(`artifact target must be a fresh non-existing ${directory ? 'directory' : 'regular file'}`) } catch (error) { if (error.code !== 'ENOENT') throw error } }
async function promoteStage(stage, artifacts) { await mkdir(artifacts.root, { recursive: true, mode: 0o700 }); await chmod(artifacts.root, 0o700); for (const path of [artifacts.video, artifacts.report, artifacts.manual, artifacts.cover]) await ensurePromotionTarget(path); await ensurePromotionTarget(artifacts.frames, true); await rename(join(stage, basename(artifacts.video)), artifacts.video); await rename(join(stage, 'report.json'), artifacts.report); await rename(join(stage, 'index.html'), artifacts.manual); await rename(join(stage, basename(artifacts.cover)), artifacts.cover); await rename(join(stage, basename(artifacts.frames)), artifacts.frames) }
function failureReceiptPath(record) { return join(artifactRoot, `${basename(record).replace(/\.mp4$/i, '')}.failure.receipt.json`) }
async function preserveFailureReceipt(candidate, config, receipt, error) { const path = failureReceiptPath(config.record); await mkdir(artifactRoot, { recursive: true, mode: 0o700 }); await ensurePromotionTarget(path); const value = { format: 'geneway-p5-failure-receipt', candidate, createdAt: new Date().toISOString(), status: 'evidence-pending', reason: redact(error?.message ?? error), providerMessageId: receipt.messageId, chatId: receipt.chatId, textSha256: receipt.textSha256, deleted: receipt.deleted, msgType: receipt.msgType }; const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path) }
async function browserSurface(browser) { const dom = await browser.evaluate(`(()=>{const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};return {text:document.body.innerText,values:[...document.querySelectorAll('input,textarea')].map(item=>item.value).filter(Boolean),nodes:[...document.body.querySelectorAll('*')].filter(element=>!element.closest('script,style')&&visible(element)).map(element=>({tag:element.tagName,text:(element.innerText||'').slice(0,500),aria:element.getAttribute('aria-label')||'',value:'value'in element?element.value:''}))}})()`); const tree = await browser.send('Accessibility.getFullAXTree'); return { dom, ax: { nodes: (tree.nodes ?? []).filter(node => node.ignored !== true) } } }
async function assertBrowserSurfaceClean(browser, secrets, phase) { const surface = await browserSurface(browser), serialized = JSON.stringify(surface); for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) assert.equal(serialized.includes(secret), false, `${phase} browser surface contains a credential`); assert.doesNotMatch(`${surface.dom.text}\n${surface.dom.values.join('\n')}\n${JSON.stringify(surface.dom.nodes)}\n${JSON.stringify(surface.ax)}`, /关联码|link.?code|csrf|cookie|bearer\s|api[_ -]?key/i, `${phase} browser surface contains sensitive transport material`) }
async function pointerClick(browser, selector) { const box = await browser.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); if (!box) throw new Error(`pointer target unavailable: ${selector}`); await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }); await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }); await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }) }
async function tap(browser, selector) { const box = await browser.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); if (!box) throw new Error(`touch target unavailable: ${selector}`); await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }] }); await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
async function mobilePreflightCheck(browser, selector) { const facts = await browser.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),r=target?.getBoundingClientRect(),nav=document.querySelector('nav,.nav,[role="navigation"]'),n=nav?.getBoundingClientRect(),style=target&&getComputedStyle(target);return {exists:Boolean(target),visible:Boolean(r&&r.width&&r.height&&style.display!=='none'&&style.visibility!=='hidden'),inside:Boolean(r&&r.left>=0&&r.top>=0&&r.right<=390&&r.bottom<=844),navOverlap:Boolean(r&&n&&!(r.right<=n.left||r.left>=n.right||r.bottom<=n.top||r.top>=n.bottom)),focusable:Boolean(target&&target.matches('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')),disabled:Boolean(target?.disabled)}})()`); assert.deepEqual(facts, { exists: true, visible: true, inside: true, navOverlap: false, focusable: true, disabled: false }); const ax = await browser.send('Accessibility.getFullAXTree'); assert.ok((ax.nodes ?? []).some(node => node.role?.value === 'button' && node.name?.value)); return facts }
async function delay(ms, timers) { await new Promise(resolveDelay => { const timer = setTimeout(() => { timers.delete(timer); resolveDelay() }, ms); timers.add(timer) }) }
async function scanLeaks(targets, secrets) { const needles = secrets.filter(value => typeof value === 'string' && value.length >= 8).map(value => Buffer.from(value)); for (const path of targets) for (const file of await listFiles(path)) { const bytes = await readFile(file); for (const needle of needles) if (bytes.includes(needle)) throw new Error(`secret leak detected in ${basename(file)}`) } }
async function listFiles(path) { try { const info = await lstat(path); if (info.isSymbolicLink()) throw new Error(`symlink is not an artifact: ${path}`); if (info.isFile()) return [path]; if (!info.isDirectory()) return []; const names = await readdir(path, { recursive: true, withFileTypes: true }); return names.filter(item => item.isFile()).map(item => join(item.parentPath ?? item.path, item.name)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function isWithin(parent, candidate) { const child = relative(resolve(parent), resolve(candidate)); return child === '' || (!child.startsWith('..') && !isAbsolute(child)) }
async function dshEvidence(path, sessionRef) { const files = await listFiles(path), sessions = files.filter(file => file.split('/').includes(sessionRef) || basename(file).includes(sessionRef)); const contents = await Promise.all(sessions.map(async file => file.endsWith('.zstd') ? capture('zstd', ['-dc', file]) : file.endsWith('.gz') ? capture('gzip', ['-dc', file]) : readFile(file, 'utf8'))); return { sessionCount: sessions.length, eventCount: contents.reduce((sum, raw) => sum + raw.split(/\r?\n/).filter(Boolean).length, 0), sessionHash: sessions[0] ? shortHash(sessions[0]) : undefined } }
function manual(report) { const materials = report.verdict?.materials === 'passed' ? 'passed' : 'evidence-ready/pending delivery'; return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Geneway P5 组合验收</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:auto;padding:32px;color:#17352c}section{border:1px solid #ccdcd3;border-radius:12px;padding:18px;margin:18px 0}img{max-width:100%;height:auto}dt{font-weight:700}</style><h1>P5 定时与事件自动工作组合验收</h1><p>结论：T7a 与 T7b business passed；P5 conditional，待独立复核与材料交付；操作材料 ${materials}。P4 企业微信与真人最终验收仍 deferred。</p><p><a href="${basename(report.media.video)}">验收视频</a> · <a href="${basename(report.media.cover)}">封面</a> · <a href="${escapeHtml(report.reportFile ?? 'report.json')}">报告</a></p>${report.journey.steps.map(step => `<section><h2>步骤 ${escapeHtml(step.id)}：${escapeHtml(step.action)}</h2><dl><dt>目的</dt><dd>${escapeHtml(step.purpose)}</dd><dt>预期</dt><dd>${escapeHtml(step.expected)}</dd><dt>观察</dt><dd>${escapeHtml(JSON.stringify(step.observed))}</dd><dt>视频时间段</dt><dd>${step.startSeconds.toFixed(3)}s–${step.endSeconds.toFixed(3)}s</dd></dl><img src="${escapeHtml(step.image)}" alt="${escapeHtml(step.action)}"></section>`).join('')}</html>` }
async function verifyOfflineBundle(stage, report) { const html = await readFile(join(stage, 'index.html'), 'utf8'); const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]); assert.equal(links.some(link => /^[a-z]+:|^\/\//i.test(link)), false); const files = await listFiles(stage); for (const link of links) { const target = resolve(stage, link); assert.ok(isWithin(stage, target), `offline link escapes stage: ${link}`); const info = await lstat(target); assert.equal(info.isFile(), true, `offline link missing: ${link}`); if (/\.png$/i.test(target) || /\.mp4$/i.test(target)) await run('ffmpeg', ['-v', 'error', '-i', target, '-f', 'null', '-']) } assert.ok(files.some(file => file.endsWith('.mp4'))); assert.equal(report.media.steps.length, report.journey.steps.length); const movable = await mkdtemp(join(tmpdir(), 'geneway-p5-bundle-')); try { for (const file of files) { const target = join(movable, relative(stage, file)); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(file, target) } for (const link of links) assert.equal(await access(join(movable, link)).then(() => true).catch(() => false), true) } finally { await rm(movable, { recursive: true, force: true }) } }
function stringsFrom(value, found = []) { if (typeof value === 'string') found.push(value); else if (Array.isArray(value)) for (const item of value) stringsFrom(item, found); else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsFrom(item, found); return found }
async function checkHarness() {
  const scratch = await mkdtemp(join(tmpdir(), 'geneway-p5-harness-check-')); try { await chmod(scratch, 0o700); const paths = fixturePaths(scratch); await mkdir(paths.secrets, { recursive: true, mode: 0o700 }); await writeFile(paths.state, '{}', { mode: 0o600 }); assert.equal((await stat(paths.state)).mode & 0o777, 0o600); assert.deepEqual(parseArgs(['--', '--record', 'artifacts/p5-acceptance/demo.mp4', '--lark-profile', 'safe', '--enrollment-user-id', 'ou_test', '--enrollment-message-id', 'om_test', '--enrollment-chat-id', 'oc_test']), { record: 'artifacts/p5-acceptance/demo.mp4', larkProfile: 'safe', enrollmentUserId: 'ou_test', enrollmentMessageId: 'om_test', enrollmentChatId: 'oc_test' }); assert.match(FEISHU_CREDENTIAL_REF, /^[A-Z][A-Z0-9_]{2,127}$/); assert.doesNotMatch(readbackEnrollment.toString(), /messages-send/); assert.match(readbackEnrollment.toString(), /messages-mget|verifyLark/); assert.match(readbackEnrollment.toString(), /chat_mode.*p2p/); assert.match(startServer.toString(), /GENEWAY_GEARJOB_EVENT_SECRET_FILE.*EVENT_SOURCE_ID.*EVENT_SOURCE_ADDRESS.*EVENT_HOST.*EVENT_PORT/); assert.match(prepareGearJob.toString(), /GEARJOB_COMMIT.*diff.*--cached.*deploy-frappe-1.*Asia\/Chongqing/s); assert.match(saveGearJobWorkOrder.toString(), /doc\.save\(ignore_permissions=True\).*frappe\.db\.commit\(\)/s); const combinedSource = runCombinedJourney.toString(); for (const pattern of [/restartRuntime/, /restartReplayStatus/, /data-rule-action=\\?"revoke/, /thirdModified/]) assert.match(combinedSource, pattern); assert.match(cleanupGearJob.toString(), /bestEffortCleanup.*default queue IDs changed.*long queue is not empty.*GW_ACCEPT_POST/s); const cleanupEffects = []; await assert.rejects(bestEffortCleanup([async () => { cleanupEffects.push('early'); throw new Error('injected-cleanup-failure') }, async () => { cleanupEffects.push('worker-stop') }, async () => { cleanupEffects.push('secret-remove') }]), /injected-cleanup-failure/); assert.deepEqual(cleanupEffects, ['early', 'worker-stop', 'secret-remove']); assert.ok(safeRecord('artifacts/p5-acceptance/demo.mp4').endsWith('.mp4')); assert.throws(() => safeRecord('/tmp/escape.mp4')); assert.throws(() => safeRecord('../escape.mp4')); await assert.rejects(validateRecord('artifacts/p5-acceptance/nested/demo.mp4'), /directly under/); assert.match(validateRecord.toString(), /artifacts\.video.*artifacts\.report.*artifacts\.manual.*artifacts\.cover.*failureReceiptPath/); assert.match(ensurePromotionTarget.toString(), /fresh non-existing/); const canary = 'HARNESS_SECRET_CANARY'; const clean = join(scratch, 'clean.txt'); await writeFile(clean, 'safe', { mode: 0o600 }); await scanLeaks([clean], [canary]); const dirty = join(scratch, 'dirty.txt'); await writeFile(dirty, canary, { mode: 0o600 }); await assert.rejects(scanLeaks([dirty], [canary]), /secret leak/); assert.deepEqual(fixturePaths('/tmp/p5').eventSecret, '/tmp/p5/gearjob-event.secret'); assert.deepEqual(chromeArgs('/tmp/profile', 9222, 'http://127.0.0.1:3471').some(value => value.includes('9222')), true); assert.ok(nextSafeMinute(new Date(0), 90_000).getTime() >= 90_000); const report = { media: { video: 'demo.mp4', cover: 'demo.png', steps: ['screenshots/step-01.png'] }, journey: { steps: [{ id: '01', action: 'x', purpose: 'y', expected: 'z', observed: {}, startSeconds: 0, endSeconds: 1, image: 'screenshots/step-01.png' }] } }; assert.match(manual(report), /screenshots\/step-01\.png/); assert.equal(report.verdict?.materials, undefined); const verdict = { t7a: 'business-passed', t7b: 'business-passed', p5: 'conditional', materials: 'evidence-ready/pending-delivery' }; assert.equal(verdict.t7a, 'business-passed'); assert.equal(verdict.t7b, 'business-passed'); assert.notEqual(verdict.p5, 'passed'); assert.equal(verdict.materials, 'evidence-ready/pending-delivery') } finally { await rm(scratch, { recursive: true, force: true }); await assert.rejects(stat(scratch), error => error.code === 'ENOENT') }
}
function findObjects(value, predicate, found = []) { if (Array.isArray(value)) for (const item of value) findObjects(item, predicate, found); else if (value && typeof value === 'object') { if (predicate(value)) found.push(value); for (const item of Object.values(value)) findObjects(item, predicate, found) } return found }
function stringValue(value, keys) { for (const key of keys) if (typeof value?.[key] === 'string') { try { const parsed = JSON.parse(value[key]); return typeof parsed?.text === 'string' ? parsed.text : value[key] } catch { return value[key] } } return '' }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function shortHash(value) { return `sha256:${sha256(value).slice(0, 16)}` }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function redact(value) { return String(value).replace(/(?:password|token|secret|cookie|csrf|authorization|link.?code)[^\s]*/gi, '[redacted]') }
function nextSafeMinute(now, marginMs) { const target = new Date(Math.ceil((now.getTime() + marginMs) / 60_000) * 60_000); if (target.getTime() - now.getTime() < marginMs) target.setTime(target.getTime() + 60_000); return target }
function timeInZone(value, timeZone) { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(value).filter(item => item.type === 'hour' || item.type === 'minute').map(item => [item.type, item.value])); return `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` }
function localDateTimeIso(date, time) { return new Date(Date.parse(`${date}T${time}:00.000Z`) - 8 * 60 * 60_000).toISOString() }
function expectedDeliveryText(work, result) { const fact = result.payload ?? {}, source = result.source ?? fact; return [`工单：${fact.workOrderId ?? work.input?.workOrderId ?? '未知'}`, `状态：${fact.status ?? work.status}`, `计划/完成量：${fact.plannedQuantity ?? '未知'}/${fact.completedQuantity ?? '未知'}${fact.unit ? ` ${fact.unit}` : ''}`, `来源：${source.sourceSystem ?? '未知'} / ${source.sourceInstance ?? '未知'} / ${source.sourceEnvironment ?? '未知'} / ${source.dataMode ?? '未知'} / ${source.evidenceMode ?? '未知'}`, `Web：/works/${encodeURIComponent(work.id)}`].join('\n') }
function buildReport(candidate, config, journey, evidence, platform, media, gearJob) {
  const eventReadback = evidence.event.accepted.map((item, index) => ({ occurrenceIdHash: shortHash(item.occurrence.id), workIdHash: shortHash(item.work.id), resultIdHash: shortHash(item.result.id), deliveryIdHash: shortHash(item.delivery.id), sourceRevision: item.occurrence.event.sourceRevision, digestHash: shortHash(item.occurrence.event.digest), dshSession: shortHash(item.result.dshSessionRef), dshEventCount: item.execution.dshEventCount, dshSessionFiles: item.dsh.sessionCount, providerMessageId: platform[index + 1].messageId }))
  return { format: 'geneway-p5-combined-report', version: 3, createdAt: new Date().toISOString(), candidate, verdict: { t7a: 'business-passed', t7b: 'business-passed', p5: 'conditional', materials: 'evidence-ready/pending-delivery', p4: 'deferred-wecom-and-final-user-acceptance', claim: 'T7a daily timer and T7b real Frappe after-commit event passed on the same frozen candidate, including normal restart and revocation; P5 final PASS remains pending independent review and material delivery.' }, fixture: { workOrderIdHash: shortHash(config.workOrderId), sourceEnvironment: evidence.result.source.sourceEnvironment, dataMode: evidence.result.source.dataMode, production: false }, enrollment: { status: 'provider-readback', verificationMethod: 'lark-cli-direct-message', memberIdHash: shortHash(evidence.rule.ownerMemberId), identityHash: shortHash(config.enrollment.providerUserId), conversationHash: shortHash(config.enrollment.providerConversationId), verificationRefHash: shortHash(config.enrollment.verificationRef), finalUserAssociation: 'not-claimed' }, journey: { scheduledDate: evidence.occurrence.scheduledDate, targetIso: journey.targetIso, dailyRuleIdHash: shortHash(evidence.rule.id), eventRuleIdHash: shortHash(evidence.event.rule.id), steps: sanitizeJourneySteps(journey.steps) }, readback: { daily: { occurrenceIdHash: shortHash(evidence.occurrence.id), workIdHash: shortHash(evidence.work.id), executionIdHash: shortHash(evidence.execution.id), resultIdHash: shortHash(evidence.result.id), deliveryIdHash: shortHash(evidence.delivery.id), scheduledIso: localDateTimeIso(evidence.occurrence.scheduledDate, evidence.rule.trigger.time), dshSession: shortHash(evidence.result.dshSessionRef), dshEventCount: evidence.execution.dshEventCount, providerMessageId: platform[0].messageId }, event: { accepted: eventReadback, replay: { status: journey.event.replayStatus, newWork: false }, conflictingDigest: { status: journey.event.conflictStatus, newWork: false }, beforeActiveWindow: { sourceRevision: journey.event.oldModified, status: evidence.event.skipped.status, reason: evidence.event.skipped.reason, workCreated: false }, restart: { historyRetained: true, ruleStatus: 'active', replayStatus: journey.event.restartReplayStatus, newWork: false }, revocation: { ruleStatus: evidence.event.rule.status, sourceRevision: journey.event.thirdModified, webhookIgnored: journey.event.revokedSaveIgnored, newOccurrence: false, newWork: false, newDelivery: false }, sourcePrecision: 'six-microsecond-digits', sourceTimezone: 'Asia/Chongqing/+08:00' }, resultKind: evidence.result.kind, toolName: evidence.result.toolName, source: { ...evidence.result.source, sourceRecordId: shortHash(evidence.result.source.sourceRecordId) }, payload: { plannedQuantity: evidence.result.payload.plannedQuantity, completedQuantity: evidence.result.payload.completedQuantity, unit: evidence.result.payload.unit }, modelRoute: { provider: evidence.route.provider, model: evidence.route.model } }, gearJob: { commit: GEARJOB_COMMIT, container: 'deploy-frappe-1', site: 'dev.localhost', bridge: `${EVENT_SOURCE_ADDRESS}->${EVENT_HOST}:${EVENT_PORT}`, queue: 'long', defaultQueueIdsBeforeHash: shortHash(gearJob.defaultBefore), longQueueInitiallyEmpty: gearJob.longBefore === '', runtimeCompatibilityPatch: false, webhookRequestLogs: gearJob.requestLogs, cleanup: null }, platform, browser: { consoleErrors: 0, pageErrors: 0, networkErrors: 0, sensitiveSurface: 'DOM/AX/text pre/post checks; screenshot raw bytes are not pixel proof' }, media, delivery: { materialsSent: false, note: '业务消息已逐条 Lark provider readback；组合操作材料待主控独立复核后交付。' } }
}
function sanitizeJourneySteps(steps) { return steps.map(step => ({ ...step, observed: sanitizeValue(step.observed) })) }
function sanitizeValue(value, key = '') { if (typeof value === 'string') return /(?:id|order|conversation|chat|message|session|target)/i.test(key) ? shortHash(value) : value; if (Array.isArray(value)) return value.map(item => sanitizeValue(item, key)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)])); return value }
async function alive(child, label) { await new Promise(resolveWait => setTimeout(resolveWait, 500)); if (child.exitCode !== null) throw new Error(`${label} failed to start`) }
async function waitHttp(url, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return } catch {}; await new Promise(resolveWait => setTimeout(resolveWait, 100)) } throw new Error(`timeout waiting for ${url}`) }
async function stop(child, signal) { if (!child || child.exitCode !== null) return; child.kill(signal); await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 10_000))]); if (child.exitCode === null) child.kill('SIGKILL') }
async function capture(command, args, options = {}) { const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk }); if (options.input !== undefined) child.stdin.end(options.input); const code = await new Promise(resolveExit => child.once('exit', resolveExit)); if (code !== 0) throw new Error(`${command} failed: ${redact(stderr)}`); return stdout.trim() }
async function run(command, args, options = {}) { await capture(command, args, options) }
async function freePort() { const server = createNodeServer(); await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen)); const port = server.address().port; await new Promise(resolveClose => server.close(resolveClose)); return port }
async function assertPortAvailable(host, port) { const server = createNodeServer(); await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, host, resolveListen) }); await new Promise(resolveClose => server.close(resolveClose)) }
