import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const dshHome = join(scratch, 'dsh')
const adminPassword = randomBytes(24).toString('base64url')
const memberPassword = randomBytes(24).toString('base64url')
const controlledAuthorization = randomBytes(32).toString('base64url')
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
  await run(process.execPath, ['scripts/init-p2-auth.mjs', '--mode', 'bootstrap', '--state', statePath, '--auth', authPath], {
    env: { ...process.env, GENEWAY_ADMIN_PASSWORD: adminPassword, GENEWAY_MEMBER_PASSWORD: memberPassword },
  })
  await setProduced(3)
  controlled = await startControlledGearJob({ env: {
    ...process.env,
    GENEWAY_P2_CONTROLLED_WORK_ORDER_ID: workOrderId,
    GENEWAY_P2_CONTROLLED_SOURCE_CREDENTIAL_FILE: join(secretRoot, 'controlled-b.txt'),
  } })
  server = await startServer()
  browserRuntime = await ensureBrowser()
  if (recordPath) recorder = await startRecorder(resolve(recordPath))
  const browser = await connectBrowser()
  socket = browser.socket
  const { send, evaluate, waitFor } = browser

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'admin', adminPassword, 'admin')

  const configured = await evaluate(`(async()=>{
    const route=await api('/api/admin/model-routes',{method:'POST',body:{id:'model-zenmux',provider:'zenmux',model:'deepseek/deepseek-v4-pro',displayName:'ZenMux · DeepSeek V4 Pro',enabled:true,credentialRef:'ZENMUX_API_KEY'}})
    const gearSkill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-gearjob-work-order-read',name:'GearJob 工单只读',capabilityId:'gearjob-work-order-read',enabled:true}})
    const cycleSkill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-cycle-time-calculate',name:'节拍换算',capabilityId:'cycle-time-calculate',enabled:true}})
    const a=await api('/api/admin/connections',{method:'POST',body:{id:'connection-a',name:'GearJob 外部测试 A',kind:'gearjob-rest',targetIdentity:'gearjob-dev-a',baseUrl:${JSON.stringify(gearJobUrl)},hostHeader:${JSON.stringify(gearJobHost)},credentialRef:'gearjob-a.json',allowedObjectIds:[${JSON.stringify(workOrderId)}],sourceSystem:'GearJob',sourceInstance:'dev.localhost',sourceEnvironment:'external-test',dataMode:'synthetic',evidenceMode:'real-frappe-rest',enabled:true,skillIds:[gearSkill.id]}})
    const b=await api('/api/admin/connections',{method:'POST',body:{id:'connection-b',name:'Frappe-compatible 受控 B',kind:'gearjob-rest',targetIdentity:'controlled-b',baseUrl:${JSON.stringify(controlled.address)},credentialRef:'controlled-b.txt',allowedObjectIds:[${JSON.stringify(workOrderId)}],sourceSystem:'Frappe-compatible controlled source',sourceInstance:'controlled-b',sourceEnvironment:'controlled-test',dataMode:'synthetic-controlled',evidenceMode:'controlled-frappe-compatible',enabled:true,skillIds:[gearSkill.id]}})
    const employeeA=await api('/api/admin/employees',{method:'POST',body:{id:'employee-a',name:'工单助理 A',description:'读取 GearJob 外部测试 A',enabled:true,modelRouteId:route.id,connectionIds:[a.id],skillIds:[gearSkill.id]}})
    const employeeB=await api('/api/admin/employees',{method:'POST',body:{id:'employee-b',name:'生产助理 B',description:'读取受控 B 并执行节拍换算',enabled:true,modelRouteId:route.id,connectionIds:[b.id],skillIds:[gearSkill.id,cycleSkill.id]}})
    await api('/api/admin/members/member-user',{method:'PATCH',body:{employeeIds:[employeeA.id,employeeB.id]}})
    await reloadAll();await loadAdmin();show('admin')
    document.querySelector('[data-config="connections"]').click()
    return {route:route.id,skills:[gearSkill.id,cycleSkill.id],connections:[a.id,b.id],employees:[employeeA.id,employeeB.id]}
  })()`)
  if (configured.skills.length !== 2 || configured.connections.length !== 2 || configured.employees.length !== 2) throw new Error('admin configuration did not create the P2 graph')
  await waitFor(`state.admin?.connections?.length===2 && document.querySelector('[data-test-connection="connection-a"]')`)
  await evaluate(`document.querySelector('[data-test-connection="connection-a"]').click()`)
  await waitFor(`['ready','error'].includes(state.admin?.connections?.find(item=>item.id==='connection-a')?.status)`, 30_000)
  await evaluate(`document.querySelector('[data-test-connection="connection-b"]').click()`)
  await waitFor(`['ready','error'].includes(state.admin?.connections?.find(item=>item.id==='connection-b')?.status)`, 30_000)
  const connectionTests = await evaluate(`state.admin.connections.map(item=>({id:item.id,status:item.status,ok:item.lastTest?.ok,code:item.lastTest?.code,message:item.lastTest?.message,evidenceMode:item.evidenceMode,dataMode:item.dataMode}))`)
  if (connectionTests.some(item => item.status !== 'ready' || item.ok !== true)) throw new Error(`connection test failed: ${JSON.stringify(connectionTests)}`)

  await evaluate(`show('home');document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'member', memberPassword, 'member')
  const memberBoundary = await evaluate(`(async()=>{let adminStatus;try{await api('/api/admin/members');adminStatus=200}catch(error){adminStatus=error.status}return {adminStatus,visibleAdmin:document.querySelectorAll('.admin-only:not(.hidden)').length,role:state.session.role}})()`)
  if (memberBoundary.role !== 'member' || memberBoundary.adminStatus !== 403 || memberBoundary.visibleAdmin !== 0) throw new Error('member admin boundary failed')

  await evaluate(`show('confirmations');document.querySelector('#confirmation-employee').value='employee-a';document.querySelector('#confirmation-label').value='班次';document.querySelector('#confirmation-value').value='白班';document.querySelector('#confirmation-form').requestSubmit()`)
  await waitFor(`state.confirmations?.length===1 && state.confirmations[0].revision===1`)
  const confirmationId = await evaluate(`state.confirmations[0].id`)

  await createWork(evaluate, waitFor, { employeeId: 'employee-a', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-a' })
  await waitFor(`state.currentWork?.status==='waiting_input' && state.currentWork.executions.length===0`)
  const waitingId = await evaluate(`state.currentWork.id`)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='waiting_input'`)
  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await stopServer(server)
  server = await startServer()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'member', memberPassword, 'member')
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='waiting_input'`)
  await evaluate(`document.querySelector('#continue-order').value=${JSON.stringify(workOrderId)};document.querySelector('#continue-form').requestSubmit()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && state.currentWork.status==='completed'`, 180_000)
  const initialA = await gearResult(evaluate, waitingId, 1)
  if (initialA.ratio !== 0.3 || initialA.completed !== 3 || initialA.confirmations?.[0]?.revision !== 1 || initialA.evidenceMode !== 'real-frappe-rest') throw new Error(`real A initial result failed: ${JSON.stringify(initialA)}`)
  const initialSourceCopy = await evaluate(`({visible:document.querySelector('#work-detail').innerText.includes('GearJob 外部测试 A')&&document.querySelector('#work-detail').innerText.includes('非生产'),evidence:state.currentWork.results.at(-1).source.evidenceMode})`)
  if (!initialSourceCopy.visible || initialSourceCopy.evidence !== 'real-frappe-rest') throw new Error('real A source/evidence copy failed')

  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-gearjob-work-order-read', connectionId: 'connection-b', workOrderId })
  await waitFor(`state.currentWork?.status==='completed'`, 180_000)
  const controlledId = await evaluate(`state.currentWork.id`)
  const initialB = await gearResult(evaluate, controlledId, 1)
  if (initialB.ratio !== 0.7 || initialB.completed !== 7 || initialB.dataMode !== 'synthetic-controlled' || initialB.evidenceMode !== 'controlled-frappe-compatible') throw new Error(`controlled B initial result failed: ${JSON.stringify(initialB)}`)

  await evaluate(`show('confirmations');const form=document.querySelector('[data-confirmation=${JSON.stringify(confirmationId)}]');form.elements.label.value='班次';form.elements.value.value='夜班';form.requestSubmit()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(confirmationId)})?.revision===2`)
  await setProduced(4)
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)});document.querySelector('#refresh-work').click()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`, 180_000)
  const refreshedA = await gearResult(evaluate, waitingId, 2)
  if (refreshedA.ratio !== 0.4 || refreshedA.completed !== 4 || refreshedA.confirmations?.[0]?.revision !== 2 || refreshedA.session === initialA.session || refreshedA.continuedFrom !== initialA.session || refreshedA.continuity !== 'successor') throw new Error(`real A refresh/confirmation successor failed: ${JSON.stringify(refreshedA)}`)

  await evaluate(`(async()=>{await openWork(${JSON.stringify(controlledId)});document.querySelector('#refresh-work').click()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`, 180_000)
  const controlledB = await gearResult(evaluate, controlledId, 2)
  if (controlledB.ratio !== 0.7 || controlledB.completed !== 7 || controlledB.dataMode !== 'synthetic-controlled' || controlledB.evidenceMode !== 'controlled-frappe-compatible') throw new Error(`controlled B refresh result failed: ${JSON.stringify(controlledB)}`)
  const controlledCopy = await evaluate(`({visible:document.querySelector('#work-detail').innerText.includes('Frappe-compatible 受控 B')&&document.querySelector('#work-detail').innerText.includes('非生产'),gearjobClaim:document.querySelector('#work-detail').innerText.includes('GearJob 外部测试 B')})`)
  if (!controlledCopy.visible || controlledCopy.gearjobClaim) throw new Error('controlled B source copy is misleading')
  const isolation = await evaluate(`(async()=>{const a=await api('/api/works/'+${JSON.stringify(waitingId)}),b=await api('/api/works/'+${JSON.stringify(controlledId)});return {sequence:['A','B','A','B'],a:{connectionId:a.connectionId,completed:a.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).payload.completedQuantity,instance:a.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).source.sourceInstance},b:{connectionId:b.connectionId,completed:b.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).payload.completedQuantity,instance:b.results.filter(item=>item.kind==='gearjob.work-order.observation').at(-1).source.sourceInstance}}})()`)
  if (isolation.a.connectionId === isolation.b.connectionId || isolation.a.completed !== 4 || isolation.b.completed !== 7 || isolation.a.instance === isolation.b.instance) throw new Error(`A/B isolation failed: ${JSON.stringify(isolation)}`)

  await evaluate(`show('confirmations');document.querySelector('[data-revoke=${JSON.stringify(confirmationId)}]').click()`)
  await waitFor(`state.confirmations?.find(item=>item.id===${JSON.stringify(confirmationId)})?.status==='revoked'`)
  const revokedRevision = await evaluate(`state.confirmations.find(item=>item.id===${JSON.stringify(confirmationId)}).revision`)
  if (revokedRevision !== 3) throw new Error('confirmation revoke did not produce revision 3')
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)});document.querySelector('#follow-text').value='当前结论来自哪个来源记录？';document.querySelector('#follow-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').length===1`, 180_000)
  const followed = await evaluate(`(()=>{const result=state.currentWork.results.find(item=>item.kind==='assistant.follow-up');const execution=state.currentWork.executions.at(-1);return {session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,confirmations:execution.contextConfirmationRefs,resultId:execution.resultId,actualResultId:result.id}})()`)
  if (followed.session === refreshedA.session || followed.continuedFrom !== refreshedA.session || followed.continuity !== 'successor' || followed.confirmations.length !== 0 || followed.resultId !== followed.actualResultId) throw new Error(`revoked confirmation follow-up failed: ${JSON.stringify(followed)}`)

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await createWork(evaluate, waitFor, { employeeId: 'employee-b', skillId: 'skill-cycle-time-calculate', availableSeconds: 3600, quantity: 60 })
  await waitFor(`state.currentWork?.status==='completed'`, 180_000)
  const cycle = await evaluate(`(()=>{const result=state.currentWork.results.find(item=>item.kind==='manufacturing.takt');return {id:state.currentWork.id,secondsPerUnit:result?.payload?.secondsPerUnit,unit:result?.payload?.unit,visible:document.querySelector('#work-detail').innerText.includes('60 秒/件'),innerWidth,scrollWidth:document.documentElement.scrollWidth,mobileNav:!!document.querySelector('.mobile-nav .nav:not(.hidden)')}})()`)
  if (cycle.secondsPerUnit !== 60 || cycle.unit !== 'seconds/unit' || !cycle.visible || cycle.innerWidth !== 390 || cycle.scrollWidth > 390 || !cycle.mobileNav) throw new Error(`mobile cycle action failed: ${JSON.stringify(cycle)}`)

  await evaluate(`show('home');document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'admin', adminPassword, 'admin')
  const ownerIsolation = await evaluate(`(async()=>{const response=await fetch('/api/works/'+${JSON.stringify(waitingId)});return {status:response.status,visibleWorks:state.bootstrap.works.length}})()`)
  if (ownerIsolation.status !== 404 || ownerIsolation.visibleWorks !== 0) throw new Error(`owner isolation failed: ${JSON.stringify(ownerIsolation)}`)

  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'member', memberPassword, 'member')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async()=>{await openWork(${JSON.stringify(waitingId)})})()`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(waitingId)} && document.querySelector('#work-detail').innerText.includes('40%')`)
  await new Promise(resolve => setTimeout(resolve, 1_000))

  const unexpectedNetwork = networkErrors.filter(item => !expectedNetworkFailure(item, waitingId))
  if (browserErrors.length) throw new Error(`browser emitted ${browserErrors.length} error(s): ${browserErrors[0]}`)
  if (unexpectedNetwork.length) throw new Error(`browser emitted ${unexpectedNetwork.length} unexpected network error(s): ${JSON.stringify(unexpectedNetwork[0])}`)
  if (recordPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(resolve(recordPath).replace(/\.mp4$/i, '') + '.png', Buffer.from(shot.data, 'base64'))
    await stopRecorder(recorder)
    recorder = undefined
    if ((await stat(resolve(recordPath))).size < 1_024) throw new Error('recorded MP4 is unexpectedly empty')
  }
  console.log(JSON.stringify({
    candidate: await gitHead(), workOrderId,
    configured, connectionTests,
    confirmation: { revisions: [1, 2, revokedRevision], status: 'revoked' },
    waiting: { id: waitingId, restartAndRelogin: true, executionsBeforeContinue: 0 },
    realA: { initial: initialA, refreshed: refreshedA, visibleSourceCopy: initialSourceCopy.visible },
    controlledB: { id: controlledId, initial: { ratio: initialB.ratio, completed: initialB.completed }, refreshed: { ratio: controlledB.ratio, completed: controlledB.completed }, dataMode: controlledB.dataMode, evidenceMode: controlledB.evidenceMode, visibleSourceCopy: controlledCopy.visible },
    isolation, followed, cycle, memberBoundary, ownerIsolation,
    browserErrors: browserErrors.length, networkErrors: unexpectedNetwork.length,
    recordPath: recordPath ? resolve(recordPath) : undefined,
  }))
} finally {
  socket?.close()
  if (server) await stopServer(server).catch(() => undefined)
  await controlled?.close().catch(() => undefined)
  if (recorder) await stopRecorder(recorder).catch(() => undefined)
  await stopBrowserRuntime(browserRuntime)
  await rm(scratch, { recursive: true, force: true })
}

async function login(evaluate, waitFor, loginName, password, role) {
  await evaluate(`(()=>{document.querySelector('#login-name').value=${JSON.stringify(loginName)};document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()})()`)
  await waitFor(`state.session?.loginName===${JSON.stringify(loginName)} && state.session?.role===${JSON.stringify(role)}`, 30_000)
}

async function createWork(evaluate, waitFor, options) {
  await evaluate(`(()=>{show('home');const employee=document.querySelector('#work-employee');employee.value=${JSON.stringify(options.employeeId)};employee.dispatchEvent(new Event('change',{bubbles:true}));const skill=document.querySelector('#work-skill');skill.value=${JSON.stringify(options.skillId)};skill.dispatchEvent(new Event('change',{bubbles:true}));const connection=document.querySelector('#work-connection');if(${JSON.stringify(options.connectionId ?? '')})connection.value=${JSON.stringify(options.connectionId ?? '')};document.querySelector('#work-order-id').value=${JSON.stringify(options.workOrderId ?? '')};document.querySelector('#available-seconds').value=${JSON.stringify(options.availableSeconds ?? '')};document.querySelector('#quantity').value=${JSON.stringify(options.quantity ?? '')};document.querySelector('#work-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.employeeId===${JSON.stringify(options.employeeId)} && state.currentWork?.skillId===${JSON.stringify(options.skillId)}`)
}

async function gearResult(evaluate, workId, count) {
  return evaluate(`(()=>{const results=state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation'),result=results.at(-1),execution=state.currentWork.executions.at(-1);if(state.currentWork.id!==${JSON.stringify(workId)}||results.length!==${count})return null;return {ratio:result.payload.completion?.ratio,completed:result.payload.completedQuantity,session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,confirmations:execution.contextConfirmationRefs,resultId:execution.resultId,actualResultId:result.id,dataMode:result.source.dataMode,evidenceMode:result.source.evidenceMode}})()`)
}

async function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      GENEWAY_PORT: String(port),
      GENEWAY_STATE: statePath,
      GENEWAY_AUTH_FILE: authPath,
      GENEWAY_SECRET_ROOT: secretRoot,
      GENEWAY_DSH_HOME: dshHome,
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
  const chrome = spawn('google-chrome', [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-save-password-bubble', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection',
    '--window-size=1440,900', '--window-position=0,0', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${join(scratch, 'chrome')}`, 'about:blank',
  ], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (chrome.exitCode !== null) throw new Error('Chrome failed to start')
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
