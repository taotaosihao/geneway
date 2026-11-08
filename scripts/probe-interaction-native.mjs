import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { fork, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { digest, binding } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-native-'), apiRoot = join(directory, 'api'), captures = [], errors = [], children = []
const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-CWwNtz'
const flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let origin, session, provider, browser, store, old, workId, alternateWorkId, observerStarted = false, observerRead = false, releaseObserver
const observerGate = new Promise(resolve => { releaseObserver = resolve })
try {
  await mkdir(apiRoot); old = JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')); store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(() => structuredClone(old)); await cp(join(sourceRoot, 'artifacts'), join(apiRoot, 'artifacts'), { recursive: true })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-interaction-native', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.headers.authorization, 'Bearer synthetic-interaction-native')
      const index = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[index].content), tail = body.messages.slice(index + 1).filter(row => row.role === 'tool'), review = input.includes('当前附加意图判断用途') || !!body.tools?.length && body.tools.every(tool=>tool.function.name.includes('intent')), answered = input.includes('用户对本意图独立问题的回答')
      const reviewSource=review?flatten(body.messages.findLast(row=>row.role==='user'&&flatten(row.content).includes('当前附加意图判断用途')).content):input,reviewIdentity=review?JSON.parse(reviewSource.split('当前附加意图判断用途（不是正式业务Input）：')[1].split('。只准')[0]).intentFence.intentId:null
      let tool, parameters, content
      if(input.includes('CONTEXT_OBSERVER')){
        if(!tail.length){observerStarted=true;await observerGate;tool='geneway_intent_context';parameters={clientRequestId:'observer-context'}}
        else if(tail.length===1){const value=JSON.parse(flatten(tail[0].content));assert(value.contexts.some(row=>row.role==='context'&&!row.mayReply&&!row.mayHandle&&row.sourceEvent.text.includes('观察职责测试')));observerRead=true;tool='geneway_reply_intent';parameters={clientRequestId:'observer-forbidden-reply',intentId:value.contexts.find(row=>row.sourceEvent.text.includes('观察职责测试')).intentId,text:'观察者不得冒责任人回复'}}
        else if(tail.length===2){tool='geneway_multisite_report';parameters={state:'ready',summary:'仅观察附加请求，回复权限已被真实工具门拒绝。'}}
        else content='观察完成，未承担或回复该事项。'
      }
      else if (!body.tools?.length) { const routing=JSON.parse(body.messages.at(-1).content);content=JSON.stringify(routing.text.includes('观察职责测试')?{action:'clarify',targetWorkId:null,reason:'请明确该独立事项',question:'请选择目标工作。'}:routing.text.includes('交回测试')?{action:'attach',targetWorkId:alternateWorkId,reason:'此独立请求转交另一实际工作负责人判断',question:null}:{ action: 'create_proposal', targetWorkId: old.works.find(work => work.status === 'completed').id, reason: '应明确新建关联工作，保留已完成成果', question: null }) }
      else if (review) {
        assert(body.tools.every(tool => tool.function.name.startsWith('geneway_') && /intent/.test(tool.function.name)))
        if (!tail.length) { tool = 'geneway_intent_context'; parameters = { clientRequestId: 'native-context-' + reviewIdentity + '-' + (answered ? 'answered' : 'question') } }
        else if(input.includes('观察职责测试')){await until(async()=>observerRead);tool='geneway_handback_intent';parameters={clientRequestId:'context-handler-handback-' + reviewIdentity,reason:'本次仅观察职责，不将附加事项自动受理为业务要求'}}
        else if(input.includes('交回测试')){tool='geneway_handback_intent';parameters={clientRequestId:'native-handback-' + reviewIdentity,reason:'该独立事项不属于当前职责，请明确其他安排'}}
        else if (!answered) { tool = 'geneway_ask_intent'; parameters = { clientRequestId: 'native-intent-question-' + reviewIdentity, text: '请明确本次先核对哪一项已发布记录？' } }
        else { const context = JSON.parse(flatten(tail.at(-1).content)); tool = 'geneway_accept_intent'; parameters = { clientRequestId: 'native-accept-' + reviewIdentity, expectedInstructionRevision: context.currentWork.instructionRevision } }
      } else if(input.startsWith('为观察测试')){if(!tail.length){tool='geneway_delegate';parameters={clientRequestId:'create-observer',instructionRevision:3,targetAgentId:'desktop-data',goal:'CONTEXT_OBSERVER: 仅通过只读上下文观察，不承担或回复附加事项。',requestedCapabilityId:'analysis.classify.v1',resourceRefs:[],resultSchema:'geneway.analysis-result/1'}}else if(tail.length===1){tool='geneway_multisite_report';parameters={state:'ready',summary:'已建立独立只读观察执行，原工作要求继续保留。'}}else content='等候新的明确要求。'}
      else if (input.includes('本次补充')) {
        const last=tail.length?JSON.parse(flatten(tail.at(-1).content)):null,context=tail.map(row=>{try{return JSON.parse(flatten(row.content))}catch{return null}}).find(row=>row?.contexts)?.contexts.find(row=>row.role==='handle'&&row.sourceEvent.text.includes('本次补充'))
        if(!tail.length){tool='geneway_intent_context';parameters={clientRequestId:'accepted-intent-context'}}
        else if(last?.contexts){assert(context);tool='geneway_split_intent';parameters={clientRequestId:'split-accepted-input',intentId:context.intentId,inputId:context.acceptedInputId,reason:'已受理要求保留；后续独立核对事项需要用户明确定位。'}}
        else if(last?.splitIntentId){tool='geneway_reply_intent';parameters={clientRequestId:'accepted-intent-reply',intentId:context.intentId,text:'原正式要求已保留，独立事项已另列待定位。'}}
        else if(last?.replyId){tool='geneway_multisite_report';parameters={state:'ready',summary:'已消费当前要求并保留原效果，独立事项待明确定位。'}}
        else content='本轮获准处理已结束。'
      }
      else if (!tail.length) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: input.includes('本次补充') ? '已实际消费受理后的新要求，保留原成果。' : '已读取原成果护罩松动、张工记录与来源关联；尚未生成新文件。' } }
      else content = '已完成本轮获准核对，等待新的明确要求。'
      captures.push({ body, tool: tool ?? null, review, answered })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native-tool-' + captures.length, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] } : { role: 'assistant', content }
      response.write('data: ' + JSON.stringify({ id: 'interaction-' + captures.length, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n'); response.end()
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = reservePort(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  api.stdout.on('data', bytes => { void writeFile(join(directory, 'api-last-stdout.txt'), bytes) }); api.stderr.on('data', bytes => errors.push(bytes.toString()))
  await until(async () => { try { return (await fetch(origin)).ok } catch { return false } })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  for (const [agentId, capability] of [['coordinator', 'collaboration.coordinate.v1'], ['analysis', 'analysis.classify.v1'],...(process.argv.includes('--context')?[['desktop-data','analysis.classify.v1']]:[])]) await command('/api/admin/employees/' + agentId, { expectedRevision: 1, placement: { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: [capability], resourceRefs: [] }, delegation: agentId==='coordinator'&&process.argv.includes('--context')?{agentIds:['desktop-data'],capabilityIds:['analysis.classify.v1'],resourceRefs:[]}:{ agentIds: [], capabilityIds: [], resourceRefs: [] } } }, 'PATCH')
  const modelPrices = old.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })), budget = { workspaceId: 'local', coordinatorAgentId: 'analysis', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 3, maxReservedTokens: 262144, maxReservedCostMicros: 1000 }, executionTimeoutMs: 120000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices }
  await command('/api/admin/routing-policies/test-router', { clientRequestId: 'native-router-policy', expectedRevision: null, workspaceId: 'local', routerAgentId: 'analysis', routerNodeId: 'cloud', enabled: true, maxOutputTokens: 1024, budget }, 'PUT')
  await command('/api/admin/budget-policies/native-continuation', { ...budget, clientRequestId: 'native-work-policy', expectedRevision: null, coordinatorAgentId: 'coordinator', limits: { maxModelRequests: process.argv.includes('--ordinary-budget') ? 1 : process.argv.includes('--review-budget') ? 2 : 24, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000 }, 'PUT')
  const hostRoot = join(directory, 'cloud'); await mkdir(hostRoot)
  const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: 'pair-native-cloud', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['analysis', 'coordinator',...(process.argv.includes('--context')?['desktop-data']:[])], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(hostRoot, 'profile.json')
  await writeFile(profile, JSON.stringify({ root: hostRoot, origin, pairing, maxActiveLoops: process.argv.includes('--handback')||process.argv.includes('--context') ? 2 : 1 }), { mode: 0o600 })
  const host = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: hostRoot }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(host)
  host.stderr.on('data', bytes => errors.push(bytes.toString())); host.stdout.on('data', bytes => { void writeFile(join(directory, 'host-last-stdout.txt'), bytes) })
  await new Promise((resolve, reject) => { host.on('message', message => { if (message.kind === 'ready') resolve(); if (message.kind === 'host-error') errors.push(message.code) }); host.once('exit', code => reject(Error('Host startup exit ' + code))) })
  const config = join(directory, 'ui-config.json'); await writeFile(config, JSON.stringify({ scenario: 'continuation', routingPolicyId: 'test-router', sourceGoal: old.works[0].goal, goal: '读取已发布成果后核对后续安排', employeeId: 'coordinator', budgetPolicyId: 'native-continuation', dueDate: null, previewValues: ['护罩松动', '张工'] }))
  console.log(JSON.stringify({ stage: 'native API and durable paired Host ready; starting real Web continuation', directory, origin, pid: process.pid, parents: children.map(child => child.pid) }))
  const driver = spawn(process.execPath, ['scripts/probe-interaction-ui.mjs', origin, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }), output = [], diagnostic = []
  driver.stdout.on('data', bytes => output.push(bytes)); driver.stderr.on('data', bytes => diagnostic.push(bytes)); assert.equal(await new Promise(resolve => driver.once('exit', resolve)), 0, Buffer.concat(diagnostic).toString('utf8'))
  await writeFile(join(directory, 'ui-driver-stdout.txt'), Buffer.concat(output)); await writeFile(join(directory, 'ui-driver-stderr.txt'), Buffer.concat(diagnostic))
  const state = await store.read(), linked = state.workContinuations.at(-1); workId = linked.workId
  if(process.argv.includes('--ordinary-budget')){
    await until(async()=>{const current=await store.read();return current.budgetHolds.some(row=>row.work_id===workId&&row.state==='waiting'&&row.idleAt)})
    const held=await store.read();await writeFile(join(directory,'ordinary-budget-before-adjust.json'),JSON.stringify(held,null,2));await command(`/api/admin/works/${workId}/budget`,{clientRequestId:'adjust-ordinary-budget',expectedRevision:1,reason:'显式测试：普通用途同Work/Session安全续行',limits:{maxModelRequests:24,maxReservedTokens:2000000,maxReservedCostMicros:1000},executionDeadlineAt:held.works.find(row=>row.id===workId).modelRequestBudget.executionDeadlineAt})
  }
  await until(async () => { const current = await store.read(); return current.multisite.attempts.find(row => row.work_id === workId)?.report?.state === 'ready' && current.modelRequests.filter(row => row.work_id === workId).length === (process.argv.includes('--ordinary-budget')?3:2) && current.modelRequests.every(row => row.outcome !== 'unknown') })
  const initial = await store.read(); await writeFile(join(directory, 'native-initial.json'), JSON.stringify(initial, null, 2))
  const firstBody = captures.find(row => row.body.tools?.length).body; assert(JSON.stringify(firstBody).includes('护罩松动')); assert(JSON.stringify(firstBody).includes('张工')); assert(JSON.stringify(firstBody).includes(linked.sourceWorkId)); assert(JSON.stringify(firstBody).includes(linked.context.artifact.artifactId))
  assert.equal(initial.works.find(row => row.id === workId).goal, '读取已发布成果后核对后续安排')
  if (!process.argv.includes('--continuation-only')&&!process.argv.includes('--ordinary-budget')) {
    const { chromium } = await import('/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs'); browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(origin); await page.locator('#login-name').fill('owner'); await page.locator('#login-password').fill('synthetic owner password'); await page.locator('#login-form button').click(); await page.locator('#open-interaction').waitFor()
    // The durable Thread ID comes from the actual continuation intent, never from a model guess.
    const intent = initial.workIntents.find(row => row.id === linked.intentId), threadId = intent.threadId
    await page.goto(origin + '/?thread=' + threadId); await page.locator('#interaction-text').waitFor(); await page.locator('#interaction-text').fill('本次补充先判断职责；请向我确认后再正式接受。'); await page.locator('#interaction-submit').click()
    if(process.argv.includes('--review-budget')){
      await until(async()=>{const current=await store.read();return current.budgetHolds.some(row=>row.work_id===workId&&row.state==='waiting'&&row.idleAt)})
      const held=await store.read();await writeFile(join(directory,'intent-budget-before-adjust.json'),JSON.stringify(held,null,2));await command(`/api/admin/works/${workId}/budget`,{clientRequestId:'adjust-intent-review-budget',expectedRevision:1,reason:'显式测试：同Work为受限意图判断补充额度',limits:{maxModelRequests:24,maxReservedTokens:2000000,maxReservedCostMicros:1000},executionDeadlineAt:held.works.find(row=>row.id===workId).modelRequestBudget.executionDeadlineAt})
    }
    await page.locator('[data-interaction-answer]').first().waitFor({ timeout: 30000 }); await page.screenshot({ path: join(directory, 'intent-question-mobile.png'), fullPage: true })
    if(process.argv.includes('--source-edit')){
      const before=await store.read(),oldQuestion=before.intentQuestions.find(row=>row.state==='open'),oldIntent=before.workIntents.find(row=>row.id===oldQuestion.intentId),source=before.sourceEvents.find(row=>row.id===oldIntent.sourceEventId),thread=before.webThreads.find(row=>row.id===oldIntent.threadId),identity=JSON.parse(await readFile(join(hostRoot,'node-identity.json'),'utf8')),client=createRemoteClient({origin,identity}),execution=binding(before.multisite.attempts.find(row=>row.work_id===workId)),commandRow=before.multisite.outbox.find(row=>row.command.operation==='intent_review'&&row.command.parameters.intentFence.intentId===oldIntent.id),oldToken=await client.issueIntentReview(execution,commandRow.id)
      await writeFile(join(directory,'source-edit-before.json'),JSON.stringify(before,null,2))
      await command(`/api/interaction/threads/${thread.id}/events`,{clientRequestId:'native-source-edit',sourceEventId:source.sourceEventId,version:2,expectedThreadRevision:thread.revision,text:'本次补充已编辑为当前第二版，请先向用户确认后再正式接受。'})
      await assert.rejects(client.command(execution,'accept_intent',{clientRequestId:'old-source-late-accept',intentFence:commandRow.command.parameters.intentFence,expectedInstructionRevision:1}),{code:'FORBIDDEN'})
      const denied=await fetch(origin+'/internal/model/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+oldToken.token,'content-type':'application/json'},body:JSON.stringify(captures.find(row=>row.review).body)});assert.equal(denied.status,403)
      await until(async()=>{const current=await store.read();return current.intentQuestions.some(row=>row.id!==oldQuestion.id&&row.state==='open')&&current.intentQuestions.find(row=>row.id===oldQuestion.id)?.controlConsumedAt})
      const after=await store.read();assert.equal(after.works.find(row=>row.id===workId).instructionRevision,1);assert.equal(after.intentQuestions.find(row=>row.id===oldQuestion.id).state,'superseded');assert(captures.some(row=>JSON.stringify(row.body).includes('本次补充已编辑为当前第二版')));await writeFile(join(directory,'source-edit-after.json'),JSON.stringify(after,null,2));await page.reload();await page.locator('[data-interaction-answer]').first().waitFor()
    }
    const question = (await store.read()).intentQuestions.find(row => row.state === 'open'); assert(question)
    await page.locator('[data-interaction-answer]').first().click(); await page.locator('#interaction-text').fill('请先核对护罩松动的后续安排。'); await page.locator('#interaction-submit').click()
    await until(async () => { const current = await store.read(); return current.workIntents.find(row => row.id === question.intentId)?.state === 'accepted' && current.multisite.attempts.find(row => row.work_id === workId)?.observed_revision === 2 && current.modelRequests.filter(row => row.work_id === workId).length >= 11 && current.workIntents.some(row=>row.splitFromIntentId===question.intentId) && current.intentReplies.some(row=>row.intentId===question.intentId&&row.state==='sent') && current.modelRequests.filter(row => row.work_id === workId).every(row => row.outcome === 'completed') })
    await page.reload(); await page.locator('[data-interaction-intent]').last().waitFor(); await page.screenshot({ path: join(directory, 'intent-accepted-mobile.png'), fullPage: true }); await browser.close(); browser = undefined
  }
  if(process.argv.includes('--context')){
    await command(`/api/works/${workId}/multisite/inputs`,{clientRequestId:'observe-independent-input',expectedInstructionRevision:2,text:'为观察测试建立独立只读观察角色；原先正式要求及效果保留。'})
    await until(async()=>observerStarted)
    const before=await store.read(),intent=before.workIntents.find(row=>row.id===linked.intentId),thread=before.webThreads.find(row=>row.id===intent.threadId),attached=await command(`/api/interaction/threads/${thread.id}/events`,{clientRequestId:'observe-attached-source',sourceEventId:'observe-attached-source',version:1,expectedThreadRevision:thread.revision,text:'观察职责测试：这项附加请求仅供有权观察者了解，不授予其回复责任。'})
    releaseObserver()
    await until(async()=>{const current=await store.read();return observerRead&&current.multisite.attempts.find(row=>row.agent_id==='desktop-data'&&row.work_id===workId)?.report?.state==='ready'&&current.intentHandbacks.some(row=>row.intentId===attached.intentId)&&current.modelRequests.slice(old.modelRequests.length).every(row=>row.outcome==='completed')})
    const current=await store.read(),observer=current.multisite.attempts.find(row=>row.agent_id==='desktop-data'&&row.work_id===workId),journal=JSON.parse(await readFile(join(hostRoot,'host-journal.json'),'utf8'));assert(!journal.inbox.some(row=>row.command.operation==='intent_review'&&row.command.attempt_id===observer.attempt_id));assert(!current.intentReplies.some(row=>row.intentId===attached.intentId&&row.handlerBinding.attempt_id===observer.attempt_id));await writeFile(join(directory,'context-observer.json'),JSON.stringify({before,current,intentId:attached.intentId,observerAttemptId:observer.attempt_id,noIntentWakeToContext:true,contextReplyRejected:true},null,2))
  }
  if(process.argv.includes('--handback')){
    const alternate=await command('/api/works',{workType:'multisite',employeeId:'analysis',goal:'独立工作负责人核对职责范围，未明确受理前不得替另一工作执行。',clientRequestId:'native-alternate-work'});alternateWorkId=alternate.id
    await until(async()=>{const state=await store.read();return state.multisite.attempts.find(row=>row.work_id===alternateWorkId)?.report?.state==='ready'&&state.modelRequests.filter(row=>row.work_id===alternateWorkId).every(row=>row.outcome==='completed')})
    const before=await store.read(),linkedIntent=before.workIntents.find(row=>row.id===linked.intentId),thread=before.webThreads.find(row=>row.id===linkedIntent.threadId),inputIds=before.multisite.inputs.filter(row=>row.workId===workId).map(row=>row.id)
    const created=await command(`/api/interaction/threads/${thread.id}/events`,{clientRequestId:'native-handback-source',sourceEventId:'native-handback-source',version:1,expectedThreadRevision:thread.revision,text:'交回测试：请判断这项独立请求是否属于本工作，不属于请明确交回。'})
    await until(async()=>{const current=await store.read();return current.intentHandbacks.filter(row=>row.intentId===created.intentId).length===2&&current.workIntents.find(row=>row.id===created.intentId)?.state==='clarify'})
    const after=await store.read();assert.deepEqual(after.multisite.inputs.filter(row=>row.workId===workId).map(row=>row.id),inputIds);assert.equal(after.works.find(row=>row.id===workId).instructionRevision,2);assert.equal(new Set(after.intentHandbacks.filter(row=>row.intentId===created.intentId).map(row=>row.handlerBinding.attempt_id)).size,2);assert(after.contextSubscriptions.filter(row=>row.intentId===created.intentId).every(row=>row.lifecycle==='released'));await writeFile(join(directory,'two-handbacks.json'),JSON.stringify({before,after,intentId:created.intentId},null,2))
  }
  const final = await store.read(), ledger = final.modelRequests.slice(old.modelRequests.length)
  assert.deepEqual(captures.map(row => digest(row.body)).sort(), ledger.map(row => row.bodyDigest).sort()); for (const original of old.works) assert.deepEqual(final.works.find(row => row.id === original.id), original)
  assert.deepEqual(errors, []); await command(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'stop-native-interaction' }); await until(async () => (await store.read()).works.find(row => row.id === workId).status === 'cancelled');if(alternateWorkId){await command(`/api/works/${alternateWorkId}/multisite/cancel`,{clientRequestId:'stop-alternate'});await until(async()=>(await store.read()).works.find(row=>row.id===alternateWorkId).status==='cancelled')}
  await writeFile(join(directory, 'result.json'), JSON.stringify({ result: 'passed', directory, workId, threadId: final.workIntents.find(row => row.id === linked.intentId).threadId, actualProviderForwards: captures.length, actualTools: captures.map(row => row.tool).filter(Boolean), sourceFactsUnchanged: true, actualBusinessSourceInNativeModel: true, actualQuestionAndAccept: !process.argv.includes('--continuation-only')&&!process.argv.includes('--ordinary-budget'),actualOrdinaryBudgetResume:process.argv.includes('--ordinary-budget'),actualTwoHandbacks: process.argv.includes('--handback'),actualContextObserver: process.argv.includes('--context'),actualSourceEditControl:process.argv.includes('--source-edit'), acceptedInputSplitPreservesOriginal: final.workIntents.some(row=>row.splitFromIntentId), acceptedReplyActuallySent: final.intentReplies.some(row=>row.state==='sent'), explicitWorkBudgetLimit: final.works.find(row=>row.id===workId).modelRequestBudget.limits?.maxModelRequests ?? 12, nativeSession: final.multisite.attempts.find(row => row.work_id === workId).session_id, boundary: 'real production API, actual Web continuation of one Work, independent durable paired Node parent/native DSH; synthetic provider; actual intent question/accept only when enabled, not full handback/context/scope matrix' }, null, 2))
  console.log(JSON.stringify({ stage: 'passed', directory, forwards: captures.length }))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, errors }, null, 2)); throw cause }
finally {
  releaseObserver();await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  if (store) await writeFile(join(directory, 'state-final.json'), JSON.stringify(await store.read(), null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(captures, null, 2)); console.log('Interaction native root:', directory)
}
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function until(test) { const deadline = Date.now() + 45000; while (!await test()) { assert(Date.now() < deadline, 'Interaction native timeout: ' + errors.slice(-4)); await new Promise(resolve => setTimeout(resolve, 100)) } }
