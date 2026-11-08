import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, cp, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-control-native-'), apiRoot = join(directory, 'api'), children = [], captures = [], errors = []
const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-CWwNtz'
const flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let origin, session, provider, store, workId, releaseReview, reachedReview, browser, originalQuestionId
const reviewGate = new Promise(resolve => { releaseReview = resolve }), reviewReached = new Promise(resolve => { reachedReview = resolve })
const mode = process.argv.includes('--before-idle-death') ? 'parent-death' : process.argv.includes('--manual-budget') ? 'manual-budget' : process.argv.includes('--overlap') ? 'browser-overlap' : process.argv.includes('--paused-question') ? 'paused-question' : process.argv.includes('--idle-intent') ? 'idle-intent' : process.argv.includes('--idle-ordinary') ? 'idle-ordinary' : 'browser-pending'
let reviewHeld = false, heldResponseClosed = false
try {
  await mkdir(apiRoot); const old = JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')); store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(() => structuredClone(old)); await cp(join(sourceRoot, 'artifacts'), join(apiRoot, 'artifacts'), { recursive: true })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-manual-native', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.headers.authorization, 'Bearer synthetic-manual-native')
      const index = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[index].content), tail = body.messages.slice(index + 1).filter(row => row.role === 'tool'), review = input.includes('当前附加意图判断用途') || !!body.tools?.length && body.tools.every(row=>row.function.name.includes('intent'))
      const capture = { body, review, tool: null, capturedAt: new Date().toISOString() }; captures.push(capture)
      let tool, parameters, content
      if(review&&mode==='manual-budget'&&!reviewHeld){reviewHeld=true;reachedReview();tool='geneway_intent_context';parameters={clientRequestId:'manual-budget-original-intent-context'}}
      else if (review && mode === 'paused-question' && !reviewHeld) { reviewHeld = true; reachedReview(); tool = 'geneway_ask_intent'; parameters = { clientRequestId: 'question-before-manual-pause', text: '请明确恢复后先核对哪项记录？' } }
      else if ((review || mode === 'idle-ordinary') && !reviewHeld) { reviewHeld = true; response.once('close',()=>{heldResponseClosed=true}); reachedReview(); await reviewGate; content = '本轮已收到人工暂停，请保留当前请求，等待用户明确解除。' }
      else if (review) {
        assert(body.tools.every(row => row.function.name.includes('intent')))
        if (!tail.length) { tool = 'geneway_intent_context'; parameters = { clientRequestId: 'manual-context-' + captures.length } }
        else { const context = JSON.parse(flatten(tail.at(-1).content)); tool = 'geneway_accept_intent'; parameters = { clientRequestId: 'manual-accept-' + captures.length, expectedInstructionRevision: context.currentWork.instructionRevision } }
      } else if (input.includes('人工暂停期间') || !['browser-pending','browser-overlap'].includes(mode) && reviewHeld) {
        if (!tail.length) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: '已在原Session消费解除后当前正式要求；未生成文件。' } }
        else content = '已完成本轮获准核对。'
      } else content = '原工作已进入受控等待，保留既有上下文。'
      capture.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'manual-tool-' + captures.length, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] } : { role: 'assistant', content }
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = reservePort(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  const apiOut = [], apiErr = []; api.stdout.on('data', bytes => apiOut.push(bytes)); api.stderr.on('data', bytes => apiErr.push(bytes))
  await until(async () => { try { return (await fetch(origin)).ok } catch { return false } })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  await command('/api/admin/employees/coordinator', { expectedRevision: 1, placement: { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }, 'PATCH')
  const budget = { workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: mode === 'manual-budget' ? 1 : 20, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: old.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await command('/api/admin/budget-policies/manual-native', { ...budget, clientRequestId: 'policy', expectedRevision: null }, 'PUT')
  const hostRoot = join(directory, 'cloud'); await mkdir(hostRoot)
  const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: 'pair-cloud', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(hostRoot, 'profile.json')
  await writeFile(profile, JSON.stringify({ root: hostRoot, origin, pairing, maxActiveLoops: 1 }), { mode: 0o600 })
  const host = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: hostRoot }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(host)
  const hostOut = [], hostErr = []; host.stdout.on('data', bytes => hostOut.push(bytes)); host.stderr.on('data', bytes => hostErr.push(bytes)); host.on('message', message => { if (message.kind === 'host-error') errors.push(message.code) })
  await new Promise((resolve, reject) => { host.on('message', message => { if (message.kind === 'ready') resolve() }); host.once('exit', code => reject(Error('Host startup exit ' + code))) })
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'coordinator', budgetPolicyId: 'manual-native', goal: '人工控制原生验收：沿原上下文核对，不生成新文件。', clientRequestId: 'create' }); workId = work.id
  if (mode !== 'idle-ordinary') await until(async () => captures.length === 1 && (await store.read()).modelRequests.filter(row => row.work_id === workId).every(row => row.outcome === 'completed'))
  const thread = await command('/api/interaction/threads', { clientRequestId: 'thread' })
  if (mode !== 'idle-ordinary') {
    const source = await command(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'initial-source', sourceEventId: 'initial-source', version: 1, expectedThreadRevision: 1, routingPolicyId: null, text: '请原处理者判断这项人工控制前请求。' }), catalog = await get('/api/interaction/directory')
    await command(`/api/interaction/threads/${thread.id}/selection`, { clientRequestId: 'choose-work', intentId: source.intentId, expectedRouteRevision: 1, targetWorkId: workId, candidateVersion: catalog.candidateVersion, offset: 0 })
  }
  let beforeBudgetPause
  if(mode==='manual-budget'){
    await until(async()=>{const state=await store.read();return state.budgetHolds.some(row=>row.work_id===workId&&row.idleAt)})
    beforeBudgetPause=await store.read();await writeFile(join(directory,'before-pause.json'),JSON.stringify(beforeBudgetPause,null,2));assert.equal(captures.length,1)
    await command(`/api/works/${workId}/multisite/pause`,{clientRequestId:'pause-budget-hold',scope:{kind:'work'},expectedControlGeneration:0})
    await until(async()=>(await store.read()).manualControls[0]?.holders.every(row=>row.idleAt))
    await command(`/api/works/${workId}/multisite/resume`,{clientRequestId:'resume-with-budget-still-held',scope:{kind:'work'},expectedControlGeneration:1})
    await until(async()=>(await store.read()).manualControls[1]?.holders.every(row=>row.releasedAt))
    const stillBudget=await store.read();assert.equal(stillBudget.budgetHolds[0].state,'waiting');assert.equal(captures.length,1);assert.equal(stillBudget.multisite.messages.filter(row=>row.kind==='manual_resume').length,0);await writeFile(join(directory,'manual-released-budget-still-waiting.json'),JSON.stringify(stillBudget,null,2))
    const workBudget=stillBudget.works.find(row=>row.id===workId).modelRequestBudget
    await command(`/api/admin/works/${workId}/budget`,{clientRequestId:'adjust-after-manual-release',expectedRevision:workBudget.budgetRevision,reason:'显式模拟原生验收：解除人工原因不增加预算；现另调同Work限额',limits:{...workBudget.limits,maxModelRequests:20},executionDeadlineAt:workBudget.executionDeadlineAt})
  }
  await reviewReached
  if (mode === 'paused-question') await until(async () => (await store.read()).intentQuestions.some(row => row.state === 'open'))
  const before = beforeBudgetPause ?? await store.read(); if(!beforeBudgetPause)await writeFile(join(directory, 'before-pause.json'), JSON.stringify(before, null, 2))
  if(mode==='parent-death'){
    await command(`/api/works/${workId}/multisite/pause`,{clientRequestId:'pause-before-parent-death',scope:{kind:'work'},expectedControlGeneration:0})
    await until(async()=>{const state=await store.read();return state.multisite.outbox.some(row=>row.command.operation==='manual_pause'&&row.acceptedAt)})
    const beforeDeath=await store.read(),localBefore=JSON.parse(await readFile(join(hostRoot,'host-journal.json'),'utf8')),oldWorkers=await runtimeWorkers(host.pid)
    assert.equal(oldWorkers.length,1);assert.equal(beforeDeath.manualControls[0].holders[0].idleAt,null);assert(!localBefore.inbox.find(row=>row.command.operation==='manual_pause').manualIdleAt)
    const firstParentPid=host.pid;host.kill('SIGKILL');const killed=await new Promise(resolve=>host.once('exit',(code,signal)=>resolve({code,signal})));assert.equal(killed.signal,'SIGKILL')
    await until(async()=>heldResponseClosed&&(await Promise.all(oldWorkers.map(row=>processState(row.pid)))).every(state=>['absent','Z'].includes(state)))
    releaseReview()
    const restarted=fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs',import.meta.url)),[profile],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:hostRoot},execArgv:[],stdio:['ignore','pipe','pipe','ipc']});children.push(restarted)
    const restartOut=[],restartErr=[];restarted.stdout.on('data',bytes=>restartOut.push(bytes));restarted.stderr.on('data',bytes=>restartErr.push(bytes));restarted.on('message',message=>{if(message.kind==='host-error')errors.push(message.code)})
    await new Promise((resolve,reject)=>{restarted.on('message',message=>{if(message.kind==='ready')resolve()});restarted.once('exit',code=>reject(Error('restart exit '+code)))})
    await until(async()=>(await store.read()).multisite.attempts.find(row=>row.work_id===workId).status==='unknown')
    const unknown=await store.read(),attempt=unknown.multisite.attempts.find(row=>row.work_id===workId)
    assert.equal(unknown.works.find(row=>row.id===workId).status,'interrupted');assert.equal(attempt.session_id,before.multisite.attempts.find(row=>row.work_id===workId).session_id);assert.deepEqual(unknown.modelRequests,beforeDeath.modelRequests);assert.equal(unknown.manualControls[0].holders[0].idleAt,null)
    await command(`/api/works/${workId}/multisite/resume`,{clientRequestId:'release-does-not-revive-unknown',scope:{kind:'work'},expectedControlGeneration:1})
    const releasedUnknown=await store.read(),view=await get('/api/works/'+workId);assert.equal(view.multisite.manualControls[0].uncertain,true);assert.equal(view.multisite.manualControls[0].canWake,false);assert.equal(releasedUnknown.manualControls[1].holders[0].releasedAt,null);assert.equal(releasedUnknown.multisite.messages.filter(row=>row.kind==='manual_resume').length,0);assert.deepEqual(releasedUnknown.modelRequests,beforeDeath.modelRequests);assert.equal(captures.length,2)
    const beforeStopWorkers=await runtimeWorkers(restarted.pid);assert.equal(beforeStopWorkers.length,0)
    for(const[name,value]of Object.entries({'before-death':beforeDeath,'local-before-death':localBefore,'after-restart-unknown':unknown,'unknown-after-user-release':releasedUnknown}))await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2))
    await command(`/api/works/${workId}/multisite/cancel`,{clientRequestId:'stop-unknown-manual-holder'});await until(async()=>(await store.read()).works.find(row=>row.id===workId).status==='cancelled')
    const final=await store.read();assert.deepEqual(final.modelRequests,beforeDeath.modelRequests);assert.equal(final.manualControls[0].holders[0].idleAt,null);assert(final.multisite.receipts.some(row=>row.event.work_id===workId&&row.event.kind==='stopped'&&row.event.stop_evidence==='idle_after_cancel'))
    await writeFile(join(directory,'death-process-observations.json'),JSON.stringify({firstParentPid,killed,restartedParentPid:restarted.pid,oldWorkers,beforeStopWorkers,afterStopWorkers:await runtimeWorkers(restarted.pid),heldUpstreamClosedBeforeRelease:heldResponseClosed},null,2));await writeFile(join(directory,'restart.stdout.txt'),Buffer.concat(restartOut));await writeFile(join(directory,'restart.stderr.txt'),Buffer.concat(restartErr))
    const result={result:'passed',directory,mode,workId,actualProviderForwards:captures.length,firstParentPid,newParentPid:restarted.pid,realSigkillAfterControlAckBeforeIdle:true,noFabricatedIdleOrAutomaticResume:true,unknownLedgerAndOriginalSessionPreserved:true,userReleaseDoesNotReviveUnknown:true,actualStopOnlyCleanup:true,boundary:'actual production API/remote parents/official DSH; only this fixture parent SIGKILL; old worker really exited and upstream closed; restart performs no execution worker/model before explicit stop, stop-only old Session cleanup is permitted; no OS reboot/physical outage claim'};await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
  }else{
  if (['browser-pending','browser-overlap'].includes(mode)) {
  const uiConfig = join(directory, 'ui-config.json'); await writeFile(uiConfig, JSON.stringify({ workId, threadId: thread.id, stateFile: join(apiRoot, 'state.json'), text: '人工暂停期间保存的新要求：恢复后由原处理者核对当前这项记录。', ...(mode === 'browser-overlap' ? {pauseScopes:[{kind:'work'},{kind:'agent',agentId:'coordinator'}],resumeScopes:[{kind:'work'},{kind:'agent',agentId:'coordinator'}]} : {}) }))
  console.log(JSON.stringify({ stage: 'actual review request in flight; starting dual-context manual UI', directory, origin, pid: process.pid, parents: children.map(child => child.pid) }))
  const driver = fork(fileURLToPath(new URL('./probe-manual-control-ui.mjs', import.meta.url)), [origin, uiConfig], { cwd: process.cwd(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(driver)
  const uiOut = [], uiErr = []; driver.stdout.on('data', bytes => uiOut.push(bytes)); driver.stderr.on('data', bytes => uiErr.push(bytes)); driver.on('message', message => {
    if(message.kind!=='manual-ui-phase')return
    if(message.phase==='pausing-observed')releaseReview()
    if(message.phase==='work-released-agent-paused')void(async()=>{const state=await store.read(),workControl=state.manualControls.filter(row=>row.scope.kind==='work').at(-1),agentControl=state.manualControls.filter(row=>row.scope.kind==='agent').at(-1);assert.equal(workControl.generation,2);assert(workControl.holders.length&&workControl.holders.every(row=>row.releasedAt));assert.equal(agentControl.generation,1);assert.equal(agentControl.action,'pause');assert(agentControl.holders.every(row=>row.idleAt));assert(workControl.holders.every(row=>!row.resumeCommandId&&!row.resumeConsumedAt));assert.equal(state.modelRequests.filter(row=>row.work_id===workId).length,before.modelRequests.filter(row=>row.work_id===workId).length);await writeFile(join(directory,'overlap-work-released-agent-paused.json'),JSON.stringify(state,null,2));driver.send({kind:'manual-ui-ack',phase:'work-released-agent-paused'})})().catch(cause=>{errors.push(cause.stack);driver.kill('SIGTERM')})
  })
  const uiExit = await new Promise(resolve => driver.once('exit', resolve)); await writeFile(join(directory, 'ui.stdout.txt'), Buffer.concat(uiOut)); await writeFile(join(directory, 'ui.stderr.txt'), Buffer.concat(uiErr)); assert.equal(uiExit, 0, Buffer.concat(uiErr).toString('utf8'))
  } else if(mode!=='manual-budget') {
    const pause = await command(`/api/works/${workId}/multisite/pause`, { clientRequestId: 'pause-empty', scope: { kind: 'work' }, expectedControlGeneration: 0 }); assert.equal(pause.stage, 'pausing')
    releaseReview()
    await until(async () => (await store.read()).manualControls[0]?.holders.every(row => row.idleAt))
    const paused = await store.read()
    await writeFile(join(directory, 'paused-before-release.json'), JSON.stringify(paused, null, 2))
    if (mode === 'paused-question') {
      const question = paused.intentQuestions.find(row => row.state === 'open'); assert(question); originalQuestionId = question.id
      const { chromium } = await import('/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs'); browser = await chromium.launch({headless:true}); const page = await browser.newPage({viewport:{width:390,height:844}})
      await page.goto(origin); await page.locator('#login-name').fill('owner'); await page.locator('#login-password').fill('synthetic owner password'); await page.locator('#login-form button').click(); await page.locator('#open-interaction').waitFor()
      await page.goto(origin+'/?view=interaction&thread='+encodeURIComponent(thread.id)); await page.locator('[data-interaction-answer="'+question.id+'"]').waitFor()
      await page.screenshot({path:join(directory,'paused-open-question-mobile.png'),fullPage:true})
      await page.locator('[data-interaction-answer="'+question.id+'"]').click(); await page.locator('#interaction-text').fill('人工暂停期间回答：请先核对当前这项记录。')
      const saved = page.waitForResponse(response=>response.url().endsWith('/events')&&response.request().method()==='POST'); await page.locator('#interaction-submit').click(); assert.equal((await saved).status(),200)
      const queued = await store.read(), currentQuestion = queued.intentQuestions.find(row=>row.id===question.id), intent=queued.workIntents.find(row=>row.id===question.intentId), subscription=queued.contextSubscriptions.find(row=>row.id===intent.handlerSubscriptionId)
      assert.equal(currentQuestion.state,'answered'); assert.equal(subscription.lifecycle,'paused'); assert.equal(subscription.ingestedAt,null); assert.equal(queued.works.find(row=>row.id===workId).instructionRevision,1); assert.equal(captures.length,2)
      await writeFile(join(directory,'paused-question-answer-queued.json'),JSON.stringify(queued,null,2)); await page.reload(); await page.locator('[data-manual-wait]').waitFor(); await page.screenshot({path:join(directory,'paused-answer-queued-mobile.png'),fullPage:true}); await browser.close(); browser=undefined
    }
    await command(`/api/works/${workId}/multisite/resume`, { clientRequestId: 'resume-empty', scope: { kind: 'work' }, expectedControlGeneration: 1 })
    console.log(JSON.stringify({ stage: 'native exact empty resume released', mode, directory, origin, pid: process.pid, parents: children.map(child => child.pid) }))
  }
  await until(async () => { const state = await store.read(); return state.works.find(row => row.id === workId).instructionRevision === (mode === 'idle-ordinary' ? 1 : 2) && state.multisite.attempts.find(row => row.work_id === workId)?.report?.state === 'ready' && state.modelRequests.filter(row => row.work_id === workId).every(row => row.outcome === 'completed') })
  const after = await store.read(), original = before.multisite.attempts.find(row => row.work_id === workId), current = after.multisite.attempts.find(row => row.work_id === workId), ledger = after.modelRequests.filter(row => row.work_id === workId)
  assert.equal(current.session_id, original.session_id); assert.equal(current.attempt_id, original.attempt_id); assert.deepEqual(captures.map(row => digest(row.body)).sort(), ledger.map(row => row.bodyDigest).sort()); assert(ledger.some(row => row.manualResumeCommandId && row.manualFence.workGeneration === 2)); if (mode !== 'idle-ordinary') assert(ledger.some(row => row.purpose === 'intent_review' && row.manualFence.workGeneration === 2)); if (['browser-pending','browser-overlap'].includes(mode)) assert(captures.some(row => JSON.stringify(row.body).includes('人工暂停期间保存的新要求')))
  assert(after.manualControls.filter(row=>row.action==='pause').every(control=>control.holders.every(row=>row.idleAt&&row.idleEvidence==='idle_and_flushed'))); assert(after.manualControls.filter(row=>row.action==='resume').every(control=>control.holders.every(row=>row.releasedAt&&row.resumeConsumedAt))); if(mode==='browser-overlap'){const commands=after.manualControls.filter(row=>row.action==='resume').flatMap(row=>row.holders.map(holder=>holder.resumeCommandId));assert.equal(new Set(commands).size,1);assert(ledger.some(row=>row.manualFence.workGeneration===2&&row.manualFence.agentGeneration===2))}; assert.equal(after.routingRequests.length, 0)
  if (mode === 'paused-question') { const question=after.intentQuestions.find(row=>row.id===originalQuestionId); assert.equal(question.state,'answered'); assert(after.workIntents.find(row=>row.id===question.intentId).state==='accepted'); assert(captures.some(row=>JSON.stringify(row.body).includes('人工暂停期间回答：请先核对当前这项记录。'))) }
  if(mode==='manual-budget'){assert.equal(after.budgetHolds[0].state,'resumed');assert(!ledger.some(row=>row.id===beforeBudgetPause.budgetHolds[0].requestId));assert.equal(after.manualControls[1].holders[0].resumeCommandId,after.budgetHolds[0].resumeCommandId)}
  await writeFile(join(directory, 'after-resume.json'), JSON.stringify(after, null, 2))
  await command(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'cancel' }); await until(async () => (await store.read()).works.find(row => row.id === workId).status === 'cancelled')
  await writeFile(join(directory, 'api.stdout.txt'), Buffer.concat(apiOut)); await writeFile(join(directory, 'api.stderr.txt'), Buffer.concat(apiErr)); await writeFile(join(directory, 'host.stdout.txt'), Buffer.concat(hostOut)); await writeFile(join(directory, 'host.stderr.txt'), Buffer.concat(hostErr))
  const result = { result: 'passed', directory, mode, workId, threadId: thread.id, actualProviderForwards: captures.length, actualTools: captures.map(row => row.tool).filter(Boolean), originalSession: original.session_id, sameAttemptSessionAfterExplicitRelease: true, officialIdleAndFlushedReceipt: true, actualTwoContextWebPauseMessageResume: ['browser-pending','browser-overlap'].includes(mode) ? true : null, actualAgentAndWorkOverlapSeparateRelease: mode === 'browser-overlap' ? true : null, actualCurrentIntentPurposeThenAcceptedInput: mode !== 'idle-ordinary' ? true : null, actualEmptyResumeFreshMessage: ['idle-intent','idle-ordinary'].includes(mode) ? true : null, pausedOriginalQuestionAnsweredAndReleasedOnce: mode === 'paused-question' ? true : null, actualManualBudgetIndependentReleaseAndExactIntentResume: mode === 'manual-budget' ? true : null, boundary: 'actual production API, durable paired remote Node parent and official native DSH, real dual-context desktop/mobile browser only in browser modes and mobile Q answer only in paused-question mode, controlled synthetic provider/price fixture; no physical deployment or field/model-quality claim' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack, errors }, null, 2)); throw cause }
finally {
  releaseReview(); await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  if (store) await writeFile(join(directory, 'state-final.json'), JSON.stringify(await store.read(), null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(captures, null, 2));await writeFile(join(directory,'observed-errors.json'),JSON.stringify(errors,null,2)); console.log('Manual native root:', directory)
}
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function get(path) { const response = await fetch(origin + path, { headers: { cookie: session.cookie } }); assert(response.ok); return response.json() }
async function until(test) { const deadline = Date.now() + 45000; while (!await test()) { assert(Date.now() < deadline, 'Manual native timeout: ' + errors.slice(-4)); await new Promise(resolve => setTimeout(resolve, 100)) } }

async function processState(pid){try{const value=await readFile('/proc/'+pid+'/stat','utf8');return value.slice(value.lastIndexOf(')')+2).split(' ')[0]}catch(cause){if(cause.code==='ENOENT')return 'absent';throw cause}}
async function runtimeWorkers(parentPid){let text;try{text=await readFile(`/proc/${parentPid}/task/${parentPid}/children`,'utf8')}catch(cause){if(cause.code==='ENOENT')return [];throw cause}const result=[];for(const pid of text.trim().split(/\s+/).filter(Boolean).map(Number)){try{const cmd=await readFile('/proc/'+pid+'/cmdline','utf8');if(cmd.includes('packages/agent-host/runtime-worker.mjs'))result.push({pid,state:await processState(pid),cwd:await readlink('/proc/'+pid+'/cwd')})}catch(cause){if(cause.code!=='ENOENT')throw cause}}return result}
