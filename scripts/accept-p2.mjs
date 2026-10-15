import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { startControlledGearJob } from './p2-controlled-gearjob.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const endpoint = process.env.GENEWAY_ACCEPT_CDP_ENDPOINT ?? 'http://127.0.0.1:9223'
const display = process.env.GENEWAY_ACCEPT_DISPLAY ?? ':97'
const port = Number(process.env.GENEWAY_ACCEPT_PORT ?? await freePort())
const appUrl = `http://127.0.0.1:${port}`
const workOrderId = process.env.GENEWAY_ACCEPT_WORK_ORDER_ID ?? 'WO-26-00096'
const gearJobUrl = process.env.GENEWAY_ACCEPT_GEARJOB_URL ?? 'http://127.0.0.1:8100'
const gearJobHost = process.env.GENEWAY_ACCEPT_GEARJOB_HOST ?? 'dev.localhost'
const gearJobContainer = process.env.GENEWAY_ACCEPT_GEARJOB_CONTAINER ?? 'deploy-frappe-1'
const gearJobSite = process.env.GENEWAY_ACCEPT_GEARJOB_SITE ?? 'dev.localhost'
const gearJobCredential = resolve(process.env.GENEWAY_ACCEPT_GEARJOB_CREDENTIAL ?? '/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/private/geneway-p1/service-credential.json')
const scratch = await mkdtemp(join(tmpdir(), 'geneway-p2-accept-'))
const statePath = join(scratch, 'state.json')
const authPath = join(scratch, 'private', 'auth.json')
const secretRoot = join(scratch, 'secrets')
const connectionCatalogPath = join(scratch, 'connection-catalog.json')
const dshHome = join(scratch, 'dsh')
const adminPassword = randomBytes(24).toString('base64url')
const memberPassword = randomBytes(24).toString('base64url')
const controlledAuthorization = randomBytes(32).toString('base64url')
const controlledControlAuthorization = randomBytes(32).toString('base64url')
const restoredAdminPassword = randomBytes(24).toString('base64url')
const restoredMemberPassword = randomBytes(24).toString('base64url')
const backupPath = join(scratch, 'backup')
const restoredRoot = join(scratch, 'restored')
const restoredAuthPath = join(scratch, 'restored-private', 'auth.json')
const missingSecretRoot = join(scratch, 'restored-empty-secrets')
const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GENEWAY_ACCEPT_PORT is invalid')
if (!workOrderId.trim()) throw new Error('GENEWAY_ACCEPT_WORK_ORDER_ID is empty')
if (recordIndex >= 0 && (!recordPath || recordPath.startsWith('-') || !recordPath.toLowerCase().endsWith('.mp4'))) throw new Error('--record requires an MP4 output path')

let server
let controlled
let recorder
let socket
let browserRuntime
const browserErrors = []
const networkErrors = []

try {
  await mkdir(secretRoot, { recursive: true, mode: 0o700 })
  await copyFile(gearJobCredential, join(secretRoot, 'gearjob-a.json'))
  await chmod(join(secretRoot, 'gearjob-a.json'), 0o600)
  await writeFile(join(secretRoot, 'controlled-b.txt'), `token ${controlledAuthorization}`, { mode: 0o600 })
  await writeFile(join(secretRoot, 'controlled-control.txt'), `token ${controlledControlAuthorization}`, { mode: 0o600 })
  await run(process.execPath, ['scripts/init-p2-auth.mjs', '--mode', 'bootstrap', '--state', statePath, '--auth', authPath], {
    env: { ...process.env, GENEWAY_ADMIN_PASSWORD: adminPassword, GENEWAY_MEMBER_PASSWORD: memberPassword },
  })
  await setProduced(3)
  controlled = await startControlledGearJob({ env: {
    ...process.env,
    GENEWAY_P2_CONTROLLED_WORK_ORDER_ID: workOrderId,
    GENEWAY_P2_CONTROLLED_SOURCE_CREDENTIAL_FILE: join(secretRoot, 'controlled-b.txt'),
    GENEWAY_P2_CONTROLLED_CONTROL_CREDENTIAL_FILE: join(secretRoot, 'controlled-control.txt'),
    GENEWAY_P2_CONTROLLED_ENABLE: 'true',
  } })
  await writeFile(connectionCatalogPath, JSON.stringify({ version: 1, targets: [
    { kind: 'gearjob-rest', targetIdentity: 'gearjob-dev-a', baseUrl: gearJobUrl, hostHeader: gearJobHost, credentialRef: 'gearjob-a.json', sourceSystem: 'GearJob', sourceInstance: 'dev.localhost', sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest' },
    { kind: 'gearjob-rest', targetIdentity: 'controlled-b', baseUrl: controlled.address, credentialRef: 'controlled-b.txt', sourceSystem: 'Frappe-compatible controlled source', sourceInstance: 'controlled-b', sourceEnvironment: 'controlled-test', dataMode: 'synthetic-controlled', evidenceMode: 'controlled-frappe-compatible' },
  ] }, null, 2) + '\n', { mode: 0o600 })
  if ((await stat(connectionCatalogPath)).mode % 0o1000 !== 0o600) throw new Error('connection catalog mode is not 0600')
  server = await startServer()
  browserRuntime = await ensureBrowser()
  if (recordPath) recorder = await startRecorder(resolve(recordPath))
  const browser = await connectBrowser()
  socket = browser.socket
  const { send, evaluate, waitFor } = browser

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await pause(2_000)
  await login(send, evaluate, waitFor, 'admin', adminPassword, 'admin')
  await pause(2_000)

  const configured = await evaluate(`(async()=>{
    const route=await api('/api/admin/model-routes',{method:'POST',body:{id:'model-zenmux',provider:'zenmux',model:'deepseek/deepseek-v4.1-flash',displayName:'ZenMux · DeepSeek V4.1 Flash',enabled:true,credentialRef:'ZENMUX_API_KEY'}})
    const gearSkill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-gearjob-work-order-read',name:'GearJob 工单只读',capabilityId:'gearjob-work-order-read',enabled:true}})
    const cycleSkill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-cycle-time-calculate',name:'节拍换算',capabilityId:'cycle-time-calculate',enabled:true}})
    const a=await api('/api/admin/connections',{method:'POST',body:{id:'connection-a',name:'GearJob 外部测试 A',kind:'gearjob-rest',targetIdentity:'gearjob-dev-a',baseUrl:${JSON.stringify(gearJobUrl)},hostHeader:${JSON.stringify(gearJobHost)},credentialRef:'gearjob-a.json',allowedObjectIds:[${JSON.stringify(workOrderId)}],sourceSystem:'GearJob',sourceInstance:'dev.localhost',sourceEnvironment:'external-test',dataMode:'synthetic',evidenceMode:'real-frappe-rest',enabled:true,skillIds:[gearSkill.id]}})
    const b=await api('/api/admin/connections',{method:'POST',body:{id:'connection-b',name:'Frappe-compatible 受控 B',kind:'gearjob-rest',targetIdentity:'controlled-b',baseUrl:${JSON.stringify(controlled.address)},credentialRef:'controlled-b.txt',allowedObjectIds:[${JSON.stringify(workOrderId)}],sourceSystem:'Frappe-compatible controlled source',sourceInstance:'controlled-b',sourceEnvironment:'controlled-test',dataMode:'synthetic-controlled',evidenceMode:'controlled-frappe-compatible',enabled:true,skillIds:[gearSkill.id]}})
    const employeeA=await api('/api/admin/employees',{method:'POST',body:{id:'employee-a',name:'工单助理 A',description:'读取 GearJob 外部测试 A',enabled:true,modelRouteId:route.id,connectionIds:[a.id],skillIds:[gearSkill.id]}})
    const employeeB=await api('/api/admin/employees',{method:'POST',body:{id:'employee-b',name:'生产助理 B',description:'读取受控 B 并执行节拍换算',enabled:true,modelRouteId:route.id,connectionIds:[b.id],skillIds:[gearSkill.id,cycleSkill.id]}})
    const member=(await api('/api/admin/members')).find(item=>item.id==='member-user')
    await api('/api/admin/members/member-user',{method:'PATCH',body:{expectedEmployeeIds:member.employeeIds,employeeIds:[employeeA.id,employeeB.id]}})
    await reloadAll();await loadAdmin();show('admin')
    return {route:route.id,skills:[gearSkill.id,cycleSkill.id],connections:[a.id,b.id],employees:[employeeA.id,employeeB.id]}
  })()`)
  if (configured.skills.length !== 2 || configured.connections.length !== 2 || configured.employees.length !== 2) throw new Error('admin configuration did not create the P2 graph')
  await showAdminTab(evaluate, waitFor, 'members')
  await showAdminTab(evaluate, waitFor, 'employees')
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-a')
  await evaluate(`document.querySelector('[data-test-connection="connection-a"]').click()`)
  await waitFor(`['ready','error'].includes(state.admin?.connections?.find(item=>item.id==='connection-a')?.status)`, 30_000)
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-b')
  await evaluate(`document.querySelector('[data-test-connection="connection-b"]').click()`)
  await waitFor(`['ready','error'].includes(state.admin?.connections?.find(item=>item.id==='connection-b')?.status)`, 30_000)
  const connectionTests = await evaluate(`state.admin.connections.map(item=>({id:item.id,status:item.status,ok:item.lastTest?.ok,code:item.lastTest?.code,message:item.lastTest?.message,evidenceMode:item.evidenceMode,dataMode:item.dataMode}))`)
  if (connectionTests.some(item => item.status !== 'ready' || item.ok !== true)) throw new Error(`connection test failed: ${JSON.stringify(connectionTests)}`)
  await evaluate(`setMessage('admin-message','连接 A / Frappe-compatible 受控 B：只读测试均成功，状态可用','success')`)
  await showAdminTab(evaluate, waitFor, 'connections')
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-a')
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-b')
  await showAdminTab(evaluate, waitFor, 'skills')
  await showAdminTab(evaluate, waitFor, 'modelRoutes')
  let adminCookie = await sessionCookie(send)

  await clearSessionCookie(send)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'member', memberPassword, 'member')
  const memberBoundary = await evaluate(`(async()=>{let adminStatus;try{await api('/api/admin/members');adminStatus=200}catch(error){adminStatus=error.status;show('home');setMessage('home-message','普通成员访问管理配置：服务端拒绝（HTTP '+error.status+'）','error')}return {adminStatus,visibleAdmin:document.querySelectorAll('.admin-only:not(.hidden)').length,role:state.session.role}})()`)
  if (memberBoundary.role !== 'member' || memberBoundary.adminStatus !== 403 || memberBoundary.visibleAdmin !== 0) throw new Error('member admin boundary failed')
  await pause()

  await evaluate(`show('confirmations');document.querySelector('#confirmation-employee').value='employee-a';document.querySelector('#confirmation-label').value='班次';document.querySelector('#confirmation-value').value='白班';document.querySelector('#confirmation-form').requestSubmit()`)
  await waitFor(`state.confirmations?.length===1 && state.confirmations[0].revision===1`)
  const confirmationId = await evaluate(`state.confirmations[0].id`)
  await pause()

  const oldSummaryMarker = '旧摘要标记-P2-不得进入撤销后 successor'
  await createWork(evaluate, waitFor, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', goal: oldSummaryMarker })
  await waitFor(`state.currentWork?.status==='waiting_input' && state.currentWork.executions.length===0`)
  const waitingId = await evaluate(`state.currentWork.id`)
  await pause()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='waiting_input'`)
  await pause()
  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await stopServer(server)
  server = await startServer()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'member', memberPassword, 'member')
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='waiting_input'`)
  await pause()
  await evaluate(`document.querySelector('#continue-order').value=${JSON.stringify(workOrderId)};document.querySelector('#continue-form').requestSubmit()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='completed'`, 180_000)
  const initialA = await gearResult(evaluate, waitingId, 1)
  if (initialA.ratio !== 0.3 || initialA.completed !== 3 || initialA.confirmations?.[0]?.revision !== 1 || initialA.evidenceMode !== 'real-frappe-rest') throw new Error(`real A initial result failed: ${JSON.stringify(initialA)}`)
  const initialSourceCopy = await evaluate(`({visible:document.querySelector('#work-detail').innerText.includes('GearJob 外部测试 A')&&document.querySelector('#work-detail').innerText.includes('非生产'),evidence:state.currentWork.results.at(-1).source.evidenceMode})`)
  if (!initialSourceCopy.visible || initialSourceCopy.evidence !== 'real-frappe-rest') throw new Error('real A source/evidence copy failed')
  await pause()

  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-b', workOrderId })
  await waitFor(`state.currentWork?.status==='completed'`, 180_000)
  const controlledId = await evaluate(`state.currentWork.id`)
  const initialB = await gearResult(evaluate, controlledId, 1)
  if (initialB.ratio !== 0.7 || initialB.completed !== 7 || initialB.dataMode !== 'synthetic-controlled' || initialB.evidenceMode !== 'controlled-frappe-compatible') throw new Error(`controlled B initial result failed: ${JSON.stringify(initialB)}`)
  await pause()

  await evaluate(`show('confirmations');const form=document.querySelector('[data-confirmation=${JSON.stringify(confirmationId)}]');form.elements.label.value='班次';form.elements.value.value='夜班';form.requestSubmit()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(confirmationId)})?.revision===2`)
  await pause()
  await setProduced(4)
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)});document.querySelector('#refresh-work').click()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`, 180_000)
  const refreshedA = await gearResult(evaluate, waitingId, 2)
  if (refreshedA.ratio !== 0.4 || refreshedA.completed !== 4 || refreshedA.confirmations?.[0]?.revision !== 2 || refreshedA.session === initialA.session || refreshedA.continuedFrom !== initialA.session || refreshedA.continuity !== 'successor') throw new Error(`real A refresh/confirmation successor failed: ${JSON.stringify(refreshedA)}`)
  await pause()

  await evaluate(`(async()=>{await openWork(${JSON.stringify(controlledId)});document.querySelector('#refresh-work').click()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`, 180_000)
  const controlledB = await gearResult(evaluate, controlledId, 2)
  if (controlledB.ratio !== 0.7 || controlledB.completed !== 7 || controlledB.dataMode !== 'synthetic-controlled' || controlledB.evidenceMode !== 'controlled-frappe-compatible') throw new Error(`controlled B refresh result failed: ${JSON.stringify(controlledB)}`)
  const controlledCopy = await evaluate(`({visible:document.querySelector('#work-detail').innerText.includes('Frappe-compatible 受控 B')&&document.querySelector('#work-detail').innerText.includes('非生产'),gearjobClaim:document.querySelector('#work-detail').innerText.includes('GearJob 外部测试 B')})`)
  if (!controlledCopy.visible || controlledCopy.gearjobClaim) throw new Error('controlled B source copy is misleading')
  const isolation = await evaluate(`(async()=>{const a=await api('/api/works/'+${JSON.stringify(waitingId)}),b=await api('/api/works/'+${JSON.stringify(controlledId)});return {sequence:['A','B','A','B'],a:{connectionId:a.connectionId,completed:a.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).payload.completedQuantity,instance:a.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).source.sourceInstance},b:{connectionId:b.connectionId,completed:b.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).payload.completedQuantity,instance:b.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).source.sourceInstance}}})()`)
  if (isolation.a.connectionId === isolation.b.connectionId || isolation.a.completed !== 4 || isolation.b.completed !== 7 || isolation.a.instance === isolation.b.instance) throw new Error(`A/B isolation failed: ${JSON.stringify(isolation)}`)
  await pause()

  const oldFollowUpMarker = '旧确认追问：请说明当前结论。'
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)});document.querySelector('#follow-text').value=${JSON.stringify(oldFollowUpMarker)};document.querySelector('#follow-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').length===1`, 180_000)
  const prohibitedContext = await evaluate(`(()=>{const results=state.currentWork.results;return {confirmationValues:['白班','夜班'],followUps:results.filter(item=>item.kind==='assistant.follow-up').flatMap(item=>[item.payload?.text,item.explanation]).filter(Boolean),explanations:results.filter(item=>item.kind!=='assistant.follow-up').map(item=>item.explanation).filter(Boolean),summaries:[${JSON.stringify(oldSummaryMarker)}]}})()`)
  await pause()

  await evaluate(`show('confirmations');document.querySelector('[data-revoke=${JSON.stringify(confirmationId)}]').click()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(confirmationId)})?.status==='revoked'`)
  const revokedRevision = await evaluate(`state.confirmations.find(item=>item.id===${JSON.stringify(confirmationId)}).revision`)
  if (revokedRevision !== 3) throw new Error('confirmation revoke did not produce revision 3')
  await evaluate(`document.querySelector('#confirmation-list details')?.setAttribute('open','')`)
  await pause()
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)});document.querySelector('#follow-text').value='当前结论来自哪个来源记录？';document.querySelector('#follow-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').length===2`, 180_000)
  const followed = await evaluate(`(()=>{const result=state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').at(-1),execution=state.currentWork.executions.at(-1);return {session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,confirmations:execution.contextConfirmationRefs,resultId:execution.resultId,actualResultId:result.id}})()`)
  if (followed.session === refreshedA.session || followed.continuedFrom !== refreshedA.session || followed.continuity !== 'successor' || followed.confirmations.length !== 0 || followed.resultId !== followed.actualResultId) throw new Error(`revoked confirmation follow-up failed: ${JSON.stringify(followed)}`)
  await pause()

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)') && innerWidth===390`)
  await pause()
  await login(send, evaluate, waitFor, 'member', memberPassword, 'member')
  const mobileLogin = await evaluate(`({role:state.session?.role,innerWidth,scrollWidth:document.documentElement.scrollWidth,mobileNav:!!document.querySelector('.mobile-nav .nav:not(.hidden)')})`)
  if (JSON.stringify(mobileLogin) !== JSON.stringify({ role: 'member', innerWidth: 390, scrollWidth: 390, mobileNav: true })) throw new Error(`mobile member login failed: ${JSON.stringify(mobileLogin)}`)
  await pause()
  const workCountBeforeInvalid = await evaluate(`state.bootstrap.works.length`)
  await evaluate(`(()=>{show('home');const employee=document.querySelector('#work-employee');employee.value='employee-b';employee.dispatchEvent(new Event('change',{bubbles:true}));const skill=document.querySelector('#work-skill');skill.value='skill-cycle-time-calculate';skill.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#available-seconds').value='3600';document.querySelector('#quantity').value='0';document.querySelector('#work-form').requestSubmit()})()`)
  await waitFor(`document.querySelector('#home-message').classList.contains('error') && document.querySelector('#home-message').textContent.length>0`)
  const invalidCycle = await evaluate(`({message:document.querySelector('#home-message').textContent,works:state.bootstrap.works.length})`)
  if (invalidCycle.works !== workCountBeforeInvalid) throw new Error('invalid cycle input created a work')
  await pause()

  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', availableSeconds: 3600 })
  await waitFor(`state.currentWork?.status==='waiting_input' && state.currentWork.requiredInputs.includes('quantity')`)
  const mobileWaitingId = await evaluate(`state.currentWork.id`)
  await pause()
  await evaluate(`show('attention');document.querySelector('#attention-cards [data-open-work=${JSON.stringify(mobileWaitingId)}]').click()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(mobileWaitingId)} && state.currentWork.status==='waiting_input'`)
  await pause()
  await evaluate(`document.querySelector('#continue-seconds').value='3600';document.querySelector('#continue-quantity').value='60';document.querySelector('#continue-form').requestSubmit()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(mobileWaitingId)} && state.currentWork.status==='completed'`, 180_000)
  await pause()
  await evaluate(`document.querySelector('#refresh-work').click()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='manufacturing.takt').length===2`, 180_000)
  const cycle = await evaluate(`(()=>{const result=state.currentWork.results.filter(item=>item.kind==='manufacturing.takt').at(-1);return {id:state.currentWork.id,secondsPerUnit:result?.payload?.secondsPerUnit,unit:result?.payload?.unit,results:state.currentWork.results.filter(item=>item.kind==='manufacturing.takt').length,visible:document.querySelector('#work-detail').innerText.includes('60 秒/件'),stopScope:document.querySelector('#work-detail').innerText.includes('只停止当前执行'),innerWidth,scrollWidth:document.documentElement.scrollWidth,mobileNav:!!document.querySelector('.mobile-nav .nav:not(.hidden)')}})()`)
  if (cycle.secondsPerUnit !== 60 || cycle.unit !== 'seconds/unit' || cycle.results !== 2 || !cycle.visible || !cycle.stopScope || cycle.innerWidth !== 390 || cycle.scrollWidth > 390 || !cycle.mobileNav) throw new Error(`mobile cycle action failed: ${JSON.stringify(cycle)}`)
  await pause()

  await evaluate(`show('confirmations');document.querySelector('#confirmation-employee').value='employee-b';document.querySelector('#confirmation-label').value='手机班组';document.querySelector('#confirmation-value').value='移动端 revision 1';document.querySelector('#confirmation-form').requestSubmit()`)
  await waitFor(`state.confirmations?.some(item=>item.employeeId==='employee-b'&&item.revision===1&&item.status==='active')`)
  const mobileConfirmationId = await evaluate(`state.confirmations.find(item=>item.employeeId==='employee-b'&&item.status==='active').id`)
  await evaluate(`document.querySelector('[data-confirmation=${JSON.stringify(mobileConfirmationId)}]').scrollIntoView({block:'start'})`)
  await pause()
  await evaluate(`(()=>{const form=document.querySelector('[data-confirmation=${JSON.stringify(mobileConfirmationId)}]');form.elements.value.value='移动端 revision 2';form.requestSubmit()})()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(mobileConfirmationId)})?.revision===2`)
  await evaluate(`document.querySelector('[data-confirmation=${JSON.stringify(mobileConfirmationId)}]').scrollIntoView({block:'start'})`)
  await pause()
  await evaluate(`document.querySelector('[data-revoke=${JSON.stringify(mobileConfirmationId)}]').click()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(mobileConfirmationId)})?.status==='revoked'`)
  const mobileConfirmation = await evaluate(`(()=>{const item=state.confirmations.find(value=>value.id===${JSON.stringify(mobileConfirmationId)}),details=document.querySelector('#confirmation-list details');details?.setAttribute('open','');details?.scrollIntoView({block:'start'});return {revisions:[1,2,item.revision],status:item.status,employeeId:item.employeeId}})()`)
  if (JSON.stringify(mobileConfirmation) !== JSON.stringify({ revisions: [1, 2, 3], status: 'revoked', employeeId: 'employee-b' })) throw new Error(`mobile confirmation journey failed: ${JSON.stringify(mobileConfirmation)}`)
  await pause()
  await evaluate(`(async()=>{await openWork(${JSON.stringify(mobileWaitingId)})})()`)
  await pause()

  await controlB({ delayMs: 30_000 })
  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-b', workOrderId })
  await waitFor(`['accepted','running'].includes(state.currentWork?.status)`)
  const w1Id = await evaluate(`state.currentWork.id`)
  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', availableSeconds: 1200, quantity: 20 })
  const w2Id = await evaluate(`state.currentWork.id`)
  const w1BeforeCancel = await evaluate(`(async()=>await api('/api/works/'+${JSON.stringify(w1Id)}))()`)
  if (!['accepted', 'running'].includes(w1BeforeCancel.status)) throw new Error(`W1 was not cancellable while W2 was active: ${w1BeforeCancel.status}`)
  await evaluate(`(async()=>{await openWork(${JSON.stringify(w1Id)})})()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(w1Id)} && ['accepted','running'].includes(state.currentWork.status)`)
  const mobileStopSurface = await evaluate(`({innerWidth,stopScope:document.querySelector('#work-detail').innerText.includes('只停止当前执行'),buttonEnabled:document.querySelector('#cancel-work')?.disabled===false})`)
  if (mobileStopSurface.innerWidth !== 390 || !mobileStopSurface.stopScope || !mobileStopSurface.buttonEnabled) throw new Error(`mobile stop controls unavailable: ${JSON.stringify(mobileStopSurface)}`)
  await pause()
  await evaluate(`document.querySelector('#cancel-work').click()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(w1Id)} && state.currentWork.status==='cancelled'`, 60_000)
  const mobileStop = await evaluate(`innerWidth===390 && state.currentWork.status==='cancelled'`)
  if (!mobileStop) throw new Error('W1 was not stopped from the 390px UI')
  await controlB({ delayMs: 0 })
  await pause()
  await evaluate(`(async()=>{await openWork(${JSON.stringify(w2Id)})})()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(w2Id)} && state.currentWork.status==='completed'`, 180_000)
  await pause()
  const w1w2 = await evaluate(`(async()=>{const w1=await api('/api/works/'+${JSON.stringify(w1Id)}),w2=await api('/api/works/'+${JSON.stringify(w2Id)});show('works');return {w1:w1.status,w2:w2.status}})()`)
  if (w1w2.w1 !== 'cancelled' || w1w2.w2 !== 'completed') throw new Error(`W1/W2 isolation failed: ${JSON.stringify(w1w2)}`)
  await pause()
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  let memberCookie = await sessionCookie(send)
  await useSessionCookie(send, adminCookie)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.session?.role==='admin'`)
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-a')
  await evaluate(`(()=>{const form=document.querySelector('form[data-kind="connection"][data-id="connection-a"]');form.elements.enabled.checked=false;form.requestSubmit()})()`)
  await waitFor(`state.admin?.connections?.find(item=>item.id==='connection-a')?.enabled===false`)
  await pause()
  adminCookie = await sessionCookie(send)

  await useSessionCookie(send, memberCookie)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.session?.role==='member'`)
  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-b', workOrderId })
  await waitFor(`state.currentWork?.status==='completed'`, 180_000)
  const bAfterADisabledId = await evaluate(`state.currentWork.id`)
  await pause()
  const aRejected = await evaluate(`(async()=>{show('home');const before=state.bootstrap.works.length;try{await api('/api/works',{method:'POST',body:{employeeId:'employee-a',skillId:'skill-gearjob-work-order-read',capabilityId:'gearjob-work-order-read',connectionId:'connection-a',workOrderId:${JSON.stringify(workOrderId)},clientRequestId:'disabled-a-'+Date.now()}});return {status:200}}catch(error){setMessage('home-message','连接 A 已禁用：服务端拒绝新派发（HTTP '+error.status+'，模型未调用）','error');return {status:error.status,code:error.code,before,after:state.bootstrap.works.length}}})()`)
  if (aRejected.status !== 403 || aRejected.before !== aRejected.after) throw new Error(`disabled A dispatch was not rejected before model: ${JSON.stringify(aRejected)}`)
  await pause()

  memberCookie = await sessionCookie(send)
  const staleMemberCsrf = await evaluate(`state.csrf`)
  await useSessionCookie(send, adminCookie)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.session?.role==='admin'`)
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-a')
  await evaluate(`(()=>{const form=document.querySelector('form[data-kind="connection"][data-id="connection-a"]');form.elements.enabled.checked=true;form.requestSubmit()})()`)
  await waitFor(`state.admin?.connections?.find(item=>item.id==='connection-a')?.enabled===true`)
  await evaluate(`document.querySelector('[data-test-connection="connection-a"]').click()`)
  await waitFor(`state.admin?.connections?.find(item=>item.id==='connection-a')?.status==='ready'`, 30_000)
  await pause()

  const ownerIsolation = await evaluate(`(async()=>{const response=await fetch('/api/works/'+${JSON.stringify(waitingId)});setMessage('admin-message','管理员不能读取成员私有工作（HTTP '+response.status+'）','error');return {status:response.status,visibleWorks:state.bootstrap.works.length}})()`)
  if (ownerIsolation.status !== 404 || ownerIsolation.visibleWorks !== 0) throw new Error(`owner isolation failed: ${JSON.stringify(ownerIsolation)}`)
  await pause()

  await showAdminTab(evaluate, waitFor, 'members')
  await evaluate(`(()=>{const form=document.querySelector('form[data-kind="member"][data-id="member-user"]');form.elements.enabled.checked=false;form.requestSubmit()})()`)
  await waitFor(`state.admin?.members?.find(item=>item.id==='member-user')?.enabled===false`)
  adminCookie = await sessionCookie(send)
  await useSessionCookie(send, memberCookie)
  const disabledMember = await evaluate(`(async()=>{const response=await fetch('/api/works',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':${JSON.stringify(staleMemberCsrf)}},body:JSON.stringify({employeeId:'employee-b',skillId:'skill-cycle-time-calculate',capabilityId:'cycle-time-calculate',availableSeconds:60,quantity:1,clientRequestId:'disabled-member-'+Date.now()})});setMessage('admin-message','成员已禁用：旧会话与新派发均被服务端拒绝（HTTP '+response.status+'）','error');return {status:response.status}})()`)
  if (disabledMember.status !== 401) throw new Error(`disabled member session remained usable: ${JSON.stringify(disabledMember)}`)
  await pause()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await pause()

  await useSessionCookie(send, adminCookie)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.session?.role==='admin'`)
  await showAdminTab(evaluate, waitFor, 'members')
  await evaluate(`(()=>{const form=document.querySelector('form[data-kind="member"][data-id="member-user"]');form.elements.enabled.checked=true;form.requestSubmit()})()`)
  await waitFor(`state.admin?.members?.find(item=>item.id==='member-user')?.enabled===true`)
  await pause()
  await clearSessionCookie(send)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'member', memberPassword, 'member')

  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', availableSeconds: 1800 })
  await waitFor(`state.currentWork?.status==='waiting_input' && state.currentWork.requiredInputs.includes('quantity')`)
  const restoreWaitingId = await evaluate(`state.currentWork.id`)
  await evaluate(`show('works')`)
  await pause()
  const beforeBackupState = JSON.parse(await readFile(statePath, 'utf8'))
  const preBackupCookie = await sessionCookie(send)
  await evaluate(`(async()=>{await openWork(${JSON.stringify(restoreWaitingId)});setMessage('work-message','即将停止服务，执行 v4 校验备份与独立恢复…','success')})()`)
  await pause()
  const controlledCallsBeforeRestore = (await controlStateB()).callCount
  await stopServer(server)
  server = undefined
  const transfer = await backupAndRestore(beforeBackupState, [adminCookie, memberCookie, preBackupCookie, staleMemberCsrf], { sessionId: followed.session, markers: prohibitedContext })
  await run(process.execPath, ['scripts/init-p2-auth.mjs', '--mode', 'rekey', '--state', join(restoredRoot, 'state.json'), '--auth', restoredAuthPath], {
    env: { ...process.env, GENEWAY_ADMIN_PASSWORD: restoredAdminPassword, GENEWAY_MEMBER_PASSWORD: restoredMemberPassword },
  })
  const afterRekeyState = JSON.parse(await readFile(join(restoredRoot, 'state.json'), 'utf8'))
  if (JSON.stringify(afterRekeyState.members) !== JSON.stringify(beforeBackupState.members)) throw new Error('auth rekey changed product membership facts')
  await mkdir(missingSecretRoot, { mode: 0o700 })
  server = await startServer({ state: join(restoredRoot, 'state.json'), auth: restoredAuthPath, dsh: join(restoredRoot, 'dsh'), secret: missingSecretRoot })
  await clearSessionCookie(send)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'member', restoredMemberPassword, 'member')
  const restoredMember = await evaluate(`({works:state.bootstrap.works.length,hasA:state.bootstrap.works.some(item=>item.id===${JSON.stringify(waitingId)}),hasWaiting:state.bootstrap.works.some(item=>item.id===${JSON.stringify(restoreWaitingId)}&&item.status==='waiting_input'),confirmation:state.confirmations.find(item=>item.id===${JSON.stringify(confirmationId)})?.status,employees:state.bootstrap.employees.length,connections:state.bootstrap.connections.length,skills:state.bootstrap.skills.length})`)
  if (!restoredMember.hasA || !restoredMember.hasWaiting || restoredMember.confirmation !== 'revoked' || restoredMember.employees !== 2 || restoredMember.connections !== 2 || restoredMember.skills !== 2) throw new Error(`restored member state mismatch: ${JSON.stringify(restoredMember)}`)
  const controlledCallsAfterRestore = (await controlStateB()).callCount
  if (controlledCallsAfterRestore !== controlledCallsBeforeRestore) throw new Error('restored startup replayed a controlled-source effect')
  await evaluate(`show('works')`)
  await pause()
  await evaluate(`show('confirmations');document.querySelector('#confirmation-list details')?.setAttribute('open','')`)
  await pause()
  await evaluate(`(async()=>{await openWork(${JSON.stringify(restoreWaitingId)})})()`)
  await pause()

  await createWork(evaluate, waitFor, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a', workOrderId })
  await waitFor(`state.currentWork?.status==='failed'`, 180_000)
  const missingSecretDispatch = await evaluate(`({status:state.currentWork.status,code:state.currentWork.executions.at(-1)?.error?.code,historicalA:state.bootstrap.works.some(item=>item.id===${JSON.stringify(waitingId)})})`)
  if (missingSecretDispatch.status !== 'failed' || missingSecretDispatch.code !== 'SOURCE_NOT_CONFIGURED' || !missingSecretDispatch.historicalA) throw new Error(`missing-secret restore boundary failed: ${JSON.stringify(missingSecretDispatch)}`)
  await pause()
  await stopServer(server)
  server = await startServer({ state: join(restoredRoot, 'state.json'), auth: restoredAuthPath, dsh: join(restoredRoot, 'dsh'), secret: secretRoot })

  await clearSessionCookie(send)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'admin', restoredAdminPassword, 'admin')
  const restoredAdmin = await evaluate(`(async()=>{await loadAdmin();show('admin');return {members:state.admin.members.length,employees:state.admin.employees.length,connections:state.admin.connections.length,skills:state.admin.skills.length,routes:state.admin.modelRoutes.length,aReady:state.admin.connections.find(item=>item.id==='connection-a')?.status}})()`)
  if (JSON.stringify(restoredAdmin) !== JSON.stringify({ members: 2, employees: 2, connections: 2, skills: 2, routes: 1, aReady: 'ready' })) throw new Error(`restored admin config mismatch: ${JSON.stringify(restoredAdmin)}`)
  await showAdminTab(evaluate, waitFor, 'members')
  await showAdminTab(evaluate, waitFor, 'connections', 'connection-a')

  await clearSessionCookie(send)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(send, evaluate, waitFor, 'member', restoredMemberPassword, 'member')
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)})})()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && document.querySelector('#work-detail').innerText.includes('40%')`)
  await pause()

  const unexpectedNetwork = networkErrors.filter(item => !expectedNetworkFailure(item, waitingId))
  if (browserErrors.length) throw new Error(`browser emitted ${browserErrors.length} error(s): ${browserErrors[0]}`)
  if (unexpectedNetwork.length) throw new Error(`browser emitted ${unexpectedNetwork.length} unexpected network error(s): ${JSON.stringify(unexpectedNetwork[0])}`)
  let receiptFile
  if (recordPath) {
    const videoPath = resolve(recordPath)
    const pngPath = videoPath.replace(/\.mp4$/i, '') + '.png'
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(pngPath, Buffer.from(shot.data, 'base64'))
    await stopRecorder(recorder)
    recorder = undefined
    if ((await stat(videoPath)).size < 1_024) throw new Error('recorded MP4 is unexpectedly empty')
    const media = await mediaEvidence(videoPath, pngPath)
    const receipt = {
      format: 'geneway-p2-acceptance-receipt', version: 1, candidate: await gitHead(), createdAt: new Date().toISOString(), artifacts: media,
      assertions: {
        configuration: { members: 2, employees: configured.employees.length, connections: configured.connections.length, skills: configured.skills.length, modelRoutes: 1, connectionTests: connectionTests.map(item => ({ id: item.id, status: item.status, ok: item.ok })) },
        sources: { a: { initialRatio: initialA.ratio, refreshedRatio: refreshedA.ratio, evidenceMode: initialA.evidenceMode }, b: { initialRatio: initialB.ratio, refreshedRatio: controlledB.ratio, evidenceMode: controlledB.evidenceMode }, sequence: isolation.sequence },
        confirmation: { revisions: [1, 2, revokedRevision], status: 'revoked', successor: followed.continuity === 'successor', successorContextRefs: followed.confirmations.length, sessionScan: transfer.sessionScan },
        waiting: { desktopRestartAndRelogin: true, desktopExecutionsBeforeContinue: 0, mobileExplicitContinue: cycle.secondsPerUnit === 60, retainedAfterRestore: restoredMember.hasWaiting },
        mobile: { login: mobileLogin, width: cycle.innerWidth, scrollWidth: cycle.scrollWidth, invalidInputRejected: invalidCycle.works === workCountBeforeInvalid, refreshResults: cycle.results, stopScopeVisible: cycle.stopScope, confirmation: mobileConfirmation, mobileStop },
        concurrency: w1w2,
        disable: { aDispatchStatus: aRejected.status, bRemainedUsable: Boolean(bAfterADisabledId), staleMemberDispatchStatus: disabledMember.status, memberRelogin: true },
        restore: { entries: transfer.entries, sessionRefs: transfer.sessionRefs, hashes: transfer.hashVerified, permissions: transfer.modesVerified, secretMatches: transfer.secretMatches, membershipUnchanged: transfer.membershipUnchanged, noAutomaticReplay: controlledCallsAfterRestore === controlledCallsBeforeRestore, missingSecretDispatch, visibleMemberState: restoredMember, visibleAdminState: restoredAdmin },
        browser: { runtimeConsoleErrors: browserErrors.length, unexpectedNetworkErrors: unexpectedNetwork.length },
      },
    }
    receiptFile = videoPath.replace(/\.mp4$/i, '') + '.receipt.json'
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  }
  console.log(JSON.stringify({
    candidate: await gitHead(), workOrderId,
    configured, connectionTests,
    confirmation: { revisions: [1, 2, revokedRevision], status: 'revoked' },
    waiting: { id: waitingId, restartAndRelogin: true, executionsBeforeContinue: 0 },
    realA: { initial: initialA, refreshed: refreshedA, visibleSourceCopy: initialSourceCopy.visible },
    controlledB: { id: controlledId, initial: { ratio: initialB.ratio, completed: initialB.completed }, refreshed: { ratio: controlledB.ratio, completed: controlledB.completed }, dataMode: controlledB.dataMode, evidenceMode: controlledB.evidenceMode, visibleSourceCopy: controlledCopy.visible },
    isolation, followed, mobileLogin, cycle, invalidCycle, mobileWaitingId, mobileConfirmation, mobileStop, w1w2, bAfterADisabledId, aRejected, disabledMember,
    memberBoundary, ownerIsolation, transfer, missingSecretDispatch, noAutomaticReplay: controlledCallsAfterRestore === controlledCallsBeforeRestore, restoredMember, restoredAdmin,
    browserErrors: browserErrors.length, networkErrors: unexpectedNetwork.length,
    recordPath: recordPath ? resolve(recordPath) : undefined, receipt: receiptFile ? basename(receiptFile) : undefined,
  }))
} finally {
  socket?.close()
  if (server) await stopServer(server).catch(() => undefined)
  await controlled?.close().catch(() => undefined)
  if (recorder) await stopRecorder(recorder).catch(() => undefined)
  await stopBrowserRuntime(browserRuntime)
  await rm(scratch, { recursive: true, force: true })
}

async function login(send, evaluate, waitFor, loginName, password, role) {
  await evaluate(`(()=>{document.querySelector('#login-name').value=${JSON.stringify(loginName)};document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()})()`)
  await waitFor(`state.session?.loginName===${JSON.stringify(loginName)} && state.session?.role===${JSON.stringify(role)}`, 30_000)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
}

async function showAdminTab(evaluate, waitFor, name, connectionId) {
  await evaluate(`(()=>{show('admin');const tab=document.querySelector('[data-config=${JSON.stringify(name)}]');tab.click();const panel=document.querySelector('#config-${name}');panel.scrollIntoView({block:'start'});if(${JSON.stringify(name)}==='connections')document.querySelectorAll('#config-connections details').forEach(item=>item.open=false);if(${JSON.stringify(connectionId ?? '')}){const form=document.querySelector('form[data-kind="connection"][data-id=${JSON.stringify(connectionId ?? '')}]');const details=form?.closest('details');if(details){details.open=true;details.scrollIntoView({block:'start'})}}})()`)
  await waitFor(`document.querySelector('#config-${name}').classList.contains('active')`)
  await pause()
}

async function sessionCookie(send) {
  const { cookies } = await send('Network.getAllCookies')
  const cookie = cookies.find(item => item.name === 'geneway_session' && item.domain === '127.0.0.1')
  if (!cookie?.value) throw new Error('browser session cookie is unavailable')
  return cookie.value
}

async function useSessionCookie(send, value) {
  const result = await send('Network.setCookie', { name: 'geneway_session', value, url: appUrl, httpOnly: true, sameSite: 'Strict' })
  if (result.success !== true) throw new Error('browser session cookie switch failed')
}

async function clearSessionCookie(send) {
  await send('Network.deleteCookies', { name: 'geneway_session', url: appUrl })
}

async function controlB(body) {
  const response = await fetch(`${controlled.address}/__control/update`, {
    method: 'POST',
    headers: { authorization: `token ${controlledControlAuthorization}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`controlled B update failed (${response.status})`)
  return response.json()
}

async function controlStateB() {
  const response = await fetch(`${controlled.address}/__control/state`, { headers: { authorization: `token ${controlledControlAuthorization}` } })
  if (!response.ok) throw new Error(`controlled B state read failed (${response.status})`)
  return response.json()
}

async function backupAndRestore(beforeState, browserSecrets, successor) {
  const candidate = await gitHead()
  const backupRun = JSON.parse(await runCapture(process.execPath, ['scripts/state-transfer.mjs', 'backup', '--output', backupPath], {
    env: { ...process.env, GENEWAY_STATE: statePath, GENEWAY_DSH_HOME: dshHome, GENEWAY_CANDIDATE: candidate },
  }))
  const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'))
  if (manifest.candidate !== candidate || manifest.version !== 2 || manifest.schema.stateVersion !== 4 || backupRun.entries !== manifest.entries.length) throw new Error('backup manifest summary mismatch')
  const settingsPath = process.env.GENEWAY_ZENMUX_SETTINGS_FILE ?? join(process.env.HOME ?? dirname(root), '.claude', 'settings.json')
  const auth = JSON.parse(await readFile(authPath, 'utf8'))
  const markers = [
    adminPassword, memberPassword, controlledAuthorization, controlledControlAuthorization,
    ...browserSecrets,
    ...collectStrings(JSON.parse(await readFile(gearJobCredential, 'utf8'))),
    ...collectStrings(auth),
  ]
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    markers.push(...['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ZENMUX_API_KEY'].flatMap(key => collectStrings(settings?.env?.[key])))
  } catch {}
  const uniqueMarkers = [...new Set(markers.filter(value => typeof value === 'string' && value.length >= 8))]
  let bytes = 0
  for (const entry of manifest.entries) {
    if (entry.path !== 'state.json' && !/^dsh\/sessions\/.+\/session\.v\d+\.jsonl(?:\.(?:gz|zstd))?$/.test(entry.path)) throw new Error(`backup contains disallowed entry: ${entry.path}`)
    const path = join(backupPath, ...entry.path.split('/'))
    const content = await readFile(path)
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256 || (await stat(path)).mode % 0o1000 !== 0o600) throw new Error(`backup entry verification failed: ${entry.path}`)
    if (uniqueMarkers.some(marker => content.includes(Buffer.from(marker)))) throw new Error(`backup contains a secret marker: ${entry.path}`)
    bytes += content.length
  }
  const manifestBytes = await readFile(join(backupPath, 'manifest.json'))
  if (uniqueMarkers.some(marker => manifestBytes.includes(Buffer.from(marker)))) throw new Error('backup manifest contains a secret marker')
  const sessionEntry = manifest.entries.find(entry => entry.path.includes(`/${successor.sessionId}/`))
  if (!sessionEntry) throw new Error('successor session is absent from the backup manifest')
  let sessionBytes = await readFile(join(backupPath, ...sessionEntry.path.split('/')))
  if (sessionEntry.path.endsWith('.zstd')) sessionBytes = zstdDecompressSync(sessionBytes)
  else if (sessionEntry.path.endsWith('.gz')) sessionBytes = gunzipSync(sessionBytes)
  const sessionText = sessionBytes.toString('utf8')
  const successorMarkers = [...new Set(Object.values(successor.markers).flat().filter(value => typeof value === 'string' && value.length))]
  const successorHits = successorMarkers.filter(marker => sessionText.includes(marker))
  if (successorHits.length) throw new Error(`successor session retained ${successorHits.length} prohibited context marker(s)`)
  const sessionScan = { entry: sessionEntry.path, sha256: sessionEntry.sha256, bytes: sessionEntry.bytes, markers: successorMarkers.length, hits: 0 }
  await assertTransferModes(backupPath, manifest.entries, true)
  const restoreRun = JSON.parse(await runCapture(process.execPath, ['scripts/state-transfer.mjs', 'restore', '--input', backupPath, '--data-root', restoredRoot]))
  if (restoreRun.entries !== manifest.entries.length || restoreRun.sessionRefs !== backupRun.sessionRefs) throw new Error('restore summary mismatch')
  await assertTransferModes(restoredRoot, manifest.entries, false)
  const restoredState = JSON.parse(await readFile(join(restoredRoot, 'state.json'), 'utf8'))
  if (JSON.stringify(restoredState.members) !== JSON.stringify(beforeState.members)) throw new Error('restore changed product membership facts')
  return { candidate, entries: manifest.entries.length, bytes, sessionRefs: backupRun.sessionRefs, hashVerified: true, modesVerified: true, secretMatches: 0, membershipUnchanged: true, sessionScan }
}

async function assertTransferModes(base, entries, manifest) {
  if ((await stat(base)).mode % 0o1000 !== 0o700) throw new Error('transfer root mode is not 0700')
  const directories = new Set([base])
  for (const entry of entries) {
    const path = join(base, ...entry.path.split('/'))
    if ((await stat(path)).mode % 0o1000 !== 0o600) throw new Error(`transfer file mode is not 0600: ${entry.path}`)
    let parent = dirname(path)
    while (parent.startsWith(`${base}/`)) { directories.add(parent); parent = dirname(parent) }
  }
  if (manifest && (await stat(join(base, 'manifest.json'))).mode % 0o1000 !== 0o600) throw new Error('manifest mode is not 0600')
  for (const path of directories) if ((await stat(path)).mode % 0o1000 !== 0o700) throw new Error('transfer directory mode is not 0700')
}

function collectStrings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  return value && typeof value === 'object' ? Object.values(value).flatMap(collectStrings) : []
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
async function mediaEvidence(videoPath, pngPath) {
  const [video, png, probeText] = await Promise.all([
    readFile(videoPath),
    readFile(pngPath),
    runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', videoPath]),
  ])
  const probe = JSON.parse(probeText), stream = probe.streams?.[0]
  if (!stream?.width || !stream?.height || !Number.isFinite(Number(probe.format?.duration))) throw new Error('recorded MP4 metadata is incomplete')
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') throw new Error('recorded cover is not a PNG')
  return {
    video: { file: basename(videoPath), sha256: sha256(video), bytes: video.length, width: stream.width, height: stream.height, durationSeconds: Number(probe.format.duration) },
    cover: { file: basename(pngPath), sha256: sha256(png), bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
  }
}
function pause(ms = 1_700) { return new Promise(resolvePause => setTimeout(resolvePause, ms)) }

async function createWork(evaluate, waitFor, options) {
  const previousId = await evaluate(`state.currentWork?.id??null`)
  const preflight = await evaluate(`(()=>{show('home');const employee=document.querySelector('#work-employee');employee.value=${JSON.stringify(options.employeeId)};employee.dispatchEvent(new Event('change',{bubbles:true}));const skill=document.querySelector('#work-skill');skill.value=${JSON.stringify(options.skillId)};skill.dispatchEvent(new Event('change',{bubbles:true}));const connection=document.querySelector('#work-connection');if(${JSON.stringify(options.connectionId ?? '')})connection.value=${JSON.stringify(options.connectionId ?? '')};document.querySelector('#work-goal').value=${JSON.stringify(options.goal ?? '')};document.querySelector('#work-order-id').value=${JSON.stringify(options.workOrderId ?? '')};document.querySelector('#available-seconds').value=${JSON.stringify(options.availableSeconds ?? '')};document.querySelector('#quantity').value=${JSON.stringify(options.quantity ?? '')};const result={employee:employee.value,skill:skill.value,connection:connection.value,submitDisabled:document.querySelector('#submit-work').disabled,connectionOptions:[...connection.options].map(item=>({value:item.value,disabled:item.disabled,text:item.textContent}))};document.querySelector('#work-form').requestSubmit();return result})()`)
  if (preflight.employee !== options.employeeId || preflight.skill !== options.skillId || (options.connectionId && preflight.connection !== options.connectionId) || preflight.submitDisabled) throw new Error(`work form preflight failed: ${JSON.stringify(preflight)}`)
  await waitFor(`(state.currentWork?.id!==${JSON.stringify(previousId)} && state.currentWork?.employeeId===${JSON.stringify(options.employeeId)} && state.currentWork?.skillId===${JSON.stringify(options.skillId)}) || document.querySelector('#home-message').classList.contains('error')`)
  const outcome = await evaluate(`({id:state.currentWork?.id,message:document.querySelector('#home-message').textContent,error:document.querySelector('#home-message').classList.contains('error')})`)
  if (outcome.error) throw new Error(`work creation failed: ${outcome.message}`)
}

async function gearResult(evaluate, workId, count) {
  return evaluate(`(()=>{const results=state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation'),result=results.at(-1),execution=state.currentWork.executions.at(-1);if(state.currentWork.id!==${JSON.stringify(workId)}||results.length!==${count})return null;return {ratio:result.payload.completion?.ratio,completed:result.payload.completedQuantity,session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,confirmations:execution.contextConfirmationRefs,resultId:execution.resultId,actualResultId:result.id,dataMode:result.source.dataMode,evidenceMode:result.source.evidenceMode}})()`)
}

async function startServer(paths = {}) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      GENEWAY_PORT: String(port),
      GENEWAY_STATE: paths.state ?? statePath,
      GENEWAY_AUTH_FILE: paths.auth ?? authPath,
      GENEWAY_CONNECTION_CATALOG: connectionCatalogPath,
      GENEWAY_SECRET_ROOT: paths.secret ?? secretRoot,
      GENEWAY_DSH_HOME: paths.dsh ?? dshHome,
      GENEWAY_TRUSTED_ORIGIN: appUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let failure = ''
  child.stderr.on('data', chunk => { failure = (failure + chunk).slice(-8_000) })
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Geneway failed to start: ${failure.trim()}`)
    try { if ((await fetch(`${appUrl}/`)).ok) return child } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill('SIGINT')
  throw new Error('Geneway start timed out')
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGINT')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Geneway shutdown timed out')), 20_000)),
  ])
}

async function setProduced(quantity) {
  await run('docker', ['exec', '-w', '/workspace/development/frappe-bench', gearJobContainer, 'bench', '--site', gearJobSite, 'execute', 'frappe.db.set_value', JSON.stringify('Work Order'), JSON.stringify(workOrderId), JSON.stringify('produced_qty'), String(quantity)])
}

async function connectBrowser() {
  const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' }).then(async response => {
    if (!response.ok) throw new Error(`Chrome CDP target creation failed (${response.status})`)
    return response.json()
  })
  const browserSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => { browserSocket.onopen = resolveOpen; browserSocket.onerror = rejectOpen })
  let sequence = 0
  const pending = new Map()
  const requests = new Map()
  browserSocket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(`runtime exception: ${message.params?.exceptionDetails?.text ?? 'unknown'}`)
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params?.type)) browserErrors.push(`console ${message.params.type}: ${message.params?.args?.map(item => item.value ?? item.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level) && !String(message.params?.entry?.text).startsWith('Failed to load resource:')) browserErrors.push(`log ${message.params.entry.level}: ${message.params?.entry?.text ?? 'unknown'} ${message.params?.entry?.url ?? ''}`.trim())
    if (message.method === 'Network.requestWillBeSent') requests.set(message.params.requestId, { url: message.params.request.url, method: message.params.request.method })
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) networkErrors.push({ ...requests.get(message.params.requestId), status: message.params.response.status })
    if (message.method === 'Network.loadingFailed' && !message.params.canceled) networkErrors.push({ ...requests.get(message.params.requestId), error: message.params.errorText })
  }
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = ++sequence
    pending.set(id, { resolve: resolveSend, reject: rejectSend })
    browserSocket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 400))
    }
    throw new Error(`Timed out waiting for browser condition: ${redactExpression(expression)}`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Page.bringToFront')
  return { socket: browserSocket, send, evaluate, waitFor }
}

function expectedNetworkFailure(item, privateWorkId) {
  if (item.status === 401 && item.url?.endsWith('/api/session')) return true
  if (item.status === 403 && item.url?.endsWith('/api/admin/members')) return true
  if (item.status === 404 && item.url?.endsWith(`/api/works/${privateWorkId}`)) return true
  if (item.status === 404 && item.method === 'GET' && /\/api\/works\/work-[0-9a-f-]+$/.test(item.url ?? '')) return true
  if ([400, 401, 403].includes(item.status) && item.method === 'POST' && item.url?.endsWith('/api/works')) return true
  return false
}

async function ensureBrowser() {
  try { if ((await fetch(`${endpoint}/json/version`)).ok) return undefined } catch {}
  const endpointUrl = new URL(endpoint)
  if (endpointUrl.protocol !== 'http:' || endpointUrl.hostname !== '127.0.0.1' || endpointUrl.pathname !== '/' || endpointUrl.search || endpointUrl.hash) throw new Error(`Chrome CDP endpoint must be loopback HTTP: ${endpoint}`)
  const debuggingPort = Number(endpointUrl.port || 80)
  if (!Number.isInteger(debuggingPort) || debuggingPort < 1 || debuggingPort > 65535) throw new Error(`Chrome CDP port is invalid: ${endpoint}`)
  let xvfb
  if (!(await pathExists(`/tmp/.X11-unix/X${display.replace(/^:/, '')}`))) {
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
    if (xvfb.exitCode !== null) throw new Error('Xvfb failed to start')
  }
  const chromeProfile = join(scratch, 'chrome')
  await mkdir(join(chromeProfile, 'Default'), { recursive: true, mode: 0o700 })
  await writeFile(join(chromeProfile, 'Default', 'Preferences'), JSON.stringify({
    credentials_enable_service: false,
    intl: { accept_languages: 'zh-CN,zh,en-US,en' },
    profile: { password_manager_enabled: false },
    translate: { enabled: false },
  }), { mode: 0o600 })
  const chrome = spawn('google-chrome', [
    '--no-sandbox', '--test-type', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-infobars', '--disable-translate', '--hide-crash-restore-bubble',
    '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,Translate,TranslateUI,OptimizationHints,ChromeWhatsNewUI,SidePanelPinning,SidePanelJourneys',
    '--lang=zh-CN', '--accept-lang=zh-CN,zh,en-US,en',
    '--window-size=1440,900', '--window-position=0,0', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${chromeProfile}`, 'about:blank',
  ], { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeError = ''
  chrome.stderr.on('data', chunk => { chromeError = (chromeError + chunk).slice(-4_000) })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (chrome.exitCode !== null) throw new Error(`Chrome failed to start: ${chromeError.trim()}`)
    try { if ((await fetch(`${endpoint}/json/version`)).ok) return { chrome, xvfb } } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  chrome.kill('SIGTERM')
  xvfb?.kill('SIGTERM')
  throw new Error('Chrome CDP start timed out')
}

async function stopBrowserRuntime(runtime) {
  for (const child of [runtime?.chrome, runtime?.xvfb]) {
    if (!child || child.exitCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 3_000))])
  }
}

async function startRecorder(path) {
  await mkdir(dirname(path), { recursive: true })
  const child = spawn('ffmpeg', ['-y', '-video_size', '1440x900', '-framerate', '25', '-f', 'x11grab', '-i', `${display}.0`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', path], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-8_000) })
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  if (child.exitCode !== null) throw new Error(`ffmpeg failed to start: ${error.trim()}`)
  child.recordingError = () => error
  return child
}

async function stopRecorder(child) {
  if (child.exitCode === null) child.stdin.write('q')
  const code = child.exitCode ?? await new Promise(resolveExit => child.once('exit', resolveExit))
  if (code !== 0) throw new Error(`ffmpeg failed: ${child.recordingError?.().trim() ?? `exit ${code}`}`)
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: options.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-8_000) })
  const code = await new Promise(resolveExit => child.once('exit', resolveExit))
  if (code !== 0) throw new Error(`${command} failed: ${error.trim()}`)
}

async function runCapture(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-8_000) })
  const code = await new Promise(resolveExit => child.once('exit', resolveExit))
  if (code !== 0) throw new Error(`${command} failed: ${error.trim()}`)
  return output.trim()
}

async function freePort() {
  const probe = createNodeServer()
  await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen))
  const candidate = probe.address().port
  await new Promise(resolveClose => probe.close(resolveClose))
  return candidate
}

async function pathExists(path) {
  try { await import('node:fs/promises').then(({ stat }) => stat(path)); return true } catch { return false }
}

function redactExpression(expression) {
  return expression.length > 240 ? `${expression.slice(0, 240)}…` : expression
}

async function gitHead() {
  const child = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  await new Promise(resolveExit => child.once('exit', resolveExit))
  return output.trim()
}
