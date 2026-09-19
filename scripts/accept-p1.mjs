import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNodeServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const endpoint = process.env.GENEWAY_ACCEPT_CDP_ENDPOINT ?? 'http://127.0.0.1:9223'
const display = process.env.GENEWAY_ACCEPT_DISPLAY ?? ':97'
const port = Number(process.env.GENEWAY_ACCEPT_PORT ?? await freePort())
const appUrl = `http://127.0.0.1:${port}`
const workOrderId = process.env.GENEWAY_ACCEPT_WORK_ORDER_ID ?? 'GENEWAY-P1-SIM-READABLE'
const gearJobUrl = process.env.GENEWAY_ACCEPT_GEARJOB_URL ?? process.env.GENEWAY_GEARJOB_BASE_URL ?? 'http://127.0.0.1:8100'
const gearJobHost = process.env.GENEWAY_ACCEPT_GEARJOB_HOST ?? process.env.GENEWAY_GEARJOB_HOST_HEADER ?? 'dev.localhost'
const gearJobContainer = process.env.GENEWAY_ACCEPT_GEARJOB_CONTAINER ?? 'deploy-frappe-1'
const gearJobSite = process.env.GENEWAY_ACCEPT_GEARJOB_SITE ?? 'dev.localhost'
const gearJobCredential = resolve(process.env.GENEWAY_ACCEPT_GEARJOB_CREDENTIAL ?? process.env.GENEWAY_GEARJOB_CREDENTIAL_FILE ?? '/home/gewu/work/gearjob/development/frappe-bench/sites/dev.localhost/private/geneway-p1/service-credential.json')
const scratch = await mkdtemp(join(tmpdir(), 'geneway-p1-accept-'))
const statePath = join(scratch, 'state.json')
const authPath = join(scratch, 'private', 'auth.json')
const secretRoot = join(scratch, 'secrets')
const connectionCatalogPath = join(scratch, 'connection-catalog.json')
const dshHome = join(scratch, 'dsh')
const adminPassword = randomBytes(24).toString('base64url')
const memberPassword = randomBytes(24).toString('base64url')
const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GENEWAY_ACCEPT_PORT is invalid')
if (!workOrderId.trim()) throw new Error('GENEWAY_ACCEPT_WORK_ORDER_ID is empty')
if (recordIndex >= 0 && (!recordPath || recordPath.startsWith('-'))) throw new Error('--record requires an output MP4 path')

let server
let recorder
let socket
let restoreProduced = false
const browserErrors = []
const networkErrors = []

try {
  await mkdir(secretRoot, { recursive: true, mode: 0o700 })
  await copyFile(gearJobCredential, join(secretRoot, 'gearjob-a.json'))
  await chmod(join(secretRoot, 'gearjob-a.json'), 0o600)
  await writeFile(connectionCatalogPath, JSON.stringify({ version: 1, targets: [{
    kind: 'gearjob-rest', targetIdentity: 'gearjob-dev-a', baseUrl: gearJobUrl, hostHeader: gearJobHost,
    credentialRef: 'gearjob-a.json', sourceSystem: 'GearJob', sourceInstance: 'dev.localhost',
    sourceEnvironment: 'external-test', dataMode: 'synthetic', evidenceMode: 'real-frappe-rest',
  }] }) + '\n', { mode: 0o600 })
  await run(process.execPath, ['scripts/init-p2-auth.mjs', '--mode', 'bootstrap', '--state', statePath, '--auth', authPath], {
    env: { ...process.env, GENEWAY_ADMIN_PASSWORD: adminPassword, GENEWAY_MEMBER_PASSWORD: memberPassword },
  })
  const storage = {
    state: (await stat(statePath)).mode & 0o777,
    auth: (await stat(authPath)).mode & 0o777,
    catalog: (await stat(connectionCatalogPath)).mode & 0o777,
    credential: (await stat(join(secretRoot, 'gearjob-a.json'))).mode & 0o777,
  }
  if (Object.values(storage).some(mode => mode !== 0o600)) throw new Error(`private file mode contract failed: ${JSON.stringify(storage)}`)

  server = await startServer()
  if (recordPath) recorder = await startRecorder(resolve(recordPath))
  const browser = await connectBrowser()
  socket = browser.socket
  const { send, evaluate, waitFor } = browser

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#login-shell:not(.hidden)') && document.querySelector('#login-message').textContent.length > 0`)
  const anonymous = await evaluate(`fetch('/api/bootstrap').then(response=>response.status)`)
  if (anonymous !== 401) throw new Error(`anonymous bootstrap was not rejected: ${anonymous}`)
  await login(evaluate, waitFor, 'admin', adminPassword, 'admin')

  const configured = await evaluate(`(async()=>{
    const route=await api('/api/admin/model-routes',{method:'POST',body:{id:'model-zenmux',provider:'zenmux',model:'deepseek/deepseek-v4-pro',displayName:'ZenMux · DeepSeek V4 Pro',enabled:true,credentialRef:'ZENMUX_API_KEY'}})
    const skill=await api('/api/admin/skills',{method:'POST',body:{id:'skill-gearjob-work-order-read',name:'GearJob 工单只读',capabilityId:'gearjob-work-order-read',enabled:true}})
    const connection=await api('/api/admin/connections',{method:'POST',body:{id:'connection-a',name:'GearJob 外部测试 A',kind:'gearjob-rest',targetIdentity:'gearjob-dev-a',baseUrl:${JSON.stringify(gearJobUrl)},hostHeader:${JSON.stringify(gearJobHost)},credentialRef:'gearjob-a.json',allowedObjectIds:[${JSON.stringify(workOrderId)}],sourceSystem:'GearJob',sourceInstance:'dev.localhost',sourceEnvironment:'external-test',dataMode:'synthetic',evidenceMode:'real-frappe-rest',enabled:true,skillIds:[skill.id]}})
    const employee=await api('/api/admin/employees',{method:'POST',body:{id:'employee-a',name:'工单助理 A',description:'读取 GearJob 外部测试 A',enabled:true,modelRouteId:route.id,connectionIds:[connection.id],skillIds:[skill.id]}})
    await api('/api/admin/members/member-user',{method:'PATCH',body:{employeeIds:[employee.id]}})
    const tested=await api('/api/admin/connections/'+connection.id+'/test',{method:'POST',body:{}})
    return {route:route.id,skill:skill.id,connection:connection.id,employee:employee.id,tested}
  })()`)
  if (configured.tested?.ok !== true) throw new Error(`real GearJob A connection test failed: ${JSON.stringify(configured.tested)}`)
  await setProduced(0)
  restoreProduced = true

  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'member', memberPassword, 'member')
  const binding = await evaluate(`({member:state.bootstrap.member.id,employees:state.bootstrap.employees.map(item=>item.id),skills:state.bootstrap.skills.map(item=>item.id),connections:state.bootstrap.connections.map(item=>item.id),status:state.bootstrap.connections[0]?.status})`)
  if (binding.member !== 'member-user' || binding.employees.join() !== 'employee-a' || binding.skills.join() !== 'skill-gearjob-work-order-read' || binding.connections.join() !== 'connection-a' || binding.status !== 'ready') throw new Error(`explicit member binding failed: ${JSON.stringify(binding)}`)
  const csrf = await evaluate(`fetch('/api/works',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({employeeId:'employee-a',skillId:'skill-gearjob-work-order-read',capabilityId:'gearjob-work-order-read',connectionId:'connection-a',workOrderId:${JSON.stringify(workOrderId)},clientRequestId:crypto.randomUUID()})}).then(response=>response.status)`)
  if (csrf !== 403) throw new Error(`missing CSRF was not rejected: ${csrf}`)

  await createWork(evaluate, waitFor)
  await waitFor(`state.currentWork?.status==='completed'`, 180_000)
  const workId = await evaluate(`state.currentWork.id`)
  const initial = await resultSnapshot(evaluate, workId, 1)
  if (!validObservation(initial) || initial.completed !== 0 || initial.ratio !== 0 || initial.continuity !== 'new') throw new Error(`initial real result failed: ${JSON.stringify(initial)}`)

  await followUp(evaluate, waitFor, '这条结论依据哪个来源记录？', 1)
  const followed = await evaluate(`(()=>{const result=state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').at(-1),execution=state.currentWork.executions.at(-1);return {session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,contextResultId:result.contextObservationId,resultId:execution.resultId,legacyResultId:execution.resultFollowUpId,actualResultId:result.id,eventCount:execution.dshEventCount,observations:state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length}})()`)
  if (followed.session !== initial.session || followed.continuedFrom !== undefined || followed.continuity !== 'same-session' || followed.contextResultId !== initial.actualResultId || followed.resultId !== followed.actualResultId || followed.legacyResultId !== followed.actualResultId || followed.eventCount <= 0 || followed.observations !== 1) throw new Error(`same-session follow-up failed: ${JSON.stringify(followed)}`)

  await setProduced(4)
  restoreProduced = false
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await waitFor(`innerWidth===390 && document.querySelector('#refresh-work')`)
  await evaluate(`document.querySelector('#refresh-work').click()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`, 180_000)
  const refreshed = await resultSnapshot(evaluate, workId, 2)
  const mobile = await evaluate(`({innerWidth,scrollWidth:document.documentElement.scrollWidth,mobileNav:!!document.querySelector('.mobile-nav .nav:not(.hidden)'),visible:document.querySelector('#work-detail').innerText.includes('40%')&&document.querySelector('#work-detail').innerText.includes('GearJob 外部测试 A')})`)
  if (!validObservation(refreshed) || refreshed.completed !== 4 || refreshed.ratio !== 0.4 || refreshed.session !== initial.session || refreshed.continuity !== 'same-session' || refreshed.previousRatio !== 0 || mobile.innerWidth !== 390 || mobile.scrollWidth > 390 || !mobile.mobileNav || !mobile.visible) throw new Error(`mobile refresh failed: ${JSON.stringify({ refreshed, mobile })}`)

  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.currentWork?.id===${JSON.stringify(workId)} && state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation').length===2`)
  await stopServer(server)
  server = await startServer()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.session?.id==='member-user' && state.currentWork?.id===${JSON.stringify(workId)} && state.currentWork.status==='completed'`)
  await followUp(evaluate, waitFor, '服务重启后，当前有依据的完成比例是多少？', 2)
  const successor = await evaluate(`(()=>{const result=state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').at(-1),execution=state.currentWork.executions.at(-1);return {session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,contextResultId:result.contextObservationId,resultId:execution.resultId,actualResultId:result.id,eventCount:execution.dshEventCount,followUps:state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').length}})()`)
  if (successor.session === refreshed.session || successor.continuedFrom !== refreshed.session || successor.continuity !== 'successor' || successor.contextResultId !== refreshed.actualResultId || successor.resultId !== successor.actualResultId || successor.eventCount <= 0 || successor.followUps !== 2) throw new Error(`restart successor failed: ${JSON.stringify(successor)}`)

  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  const afterLogout = await evaluate(`fetch('/api/bootstrap').then(response=>response.status)`)
  if (afterLogout !== 401) throw new Error(`logout did not remove authenticated access: ${afterLogout}`)
  await login(evaluate, waitFor, 'admin', adminPassword, 'admin')
  const owner = await evaluate(`(async()=>{const response=await fetch('/api/works/'+${JSON.stringify(workId)});return {status:response.status,visibleWorks:state.bootstrap.works.length}})()`)
  if (owner.status !== 404 || owner.visibleWorks !== 0) throw new Error(`owner isolation failed: ${JSON.stringify(owner)}`)

  await evaluate(`document.querySelector('#logout').click()`)
  await waitFor(`document.querySelector('#login-shell:not(.hidden)')`)
  await login(evaluate, waitFor, 'member', memberPassword, 'member')
  await evaluate(`openWork(${JSON.stringify(workId)})`)
  await waitFor(`state.currentWork?.id===${JSON.stringify(workId)} && document.querySelector('#work-detail').innerText.includes('40%')`)

  const unexpectedNetwork = networkErrors.filter(item => !expectedNetworkFailure(item, workId))
  if (browserErrors.length) throw new Error(`browser emitted ${browserErrors.length} error(s): ${browserErrors[0]}`)
  if (unexpectedNetwork.length) throw new Error(`browser emitted ${unexpectedNetwork.length} unexpected network error(s): ${JSON.stringify(unexpectedNetwork[0])}`)
  if (recordPath) {
    const output = resolve(recordPath)
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(output.replace(/\.mp4$/i, '') + '.png', Buffer.from(shot.data, 'base64'))
    await stopRecorder(recorder)
    recorder = undefined
    if ((await stat(output)).size < 1_024) throw new Error('recorded MP4 is unexpectedly empty')
  }

  console.log(JSON.stringify({
    candidate: await gitHead(), workOrderId, storage, anonymous, csrf, configured, binding,
    initial, followed, refreshed, successor, mobile, owner,
    browserErrors: browserErrors.length, networkErrors: unexpectedNetwork.length,
    recordPath: recordPath ? resolve(recordPath) : undefined,
  }))
} finally {
  socket?.close()
  if (server) await stopServer(server).catch(() => undefined)
  if (recorder) await stopRecorder(recorder).catch(() => undefined)
  if (restoreProduced) await setProduced(4).catch(() => undefined)
  await rm(scratch, { recursive: true, force: true })
}

async function login(evaluate, waitFor, loginName, password, role) {
  await evaluate(`(()=>{document.querySelector('#login-name').value=${JSON.stringify(loginName)};document.querySelector('#login-password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()})()`)
  await waitFor(`state.session?.loginName===${JSON.stringify(loginName)} && state.session?.role===${JSON.stringify(role)}`, 30_000)
}

async function createWork(evaluate, waitFor) {
  await evaluate(`(()=>{show('home');const employee=document.querySelector('#work-employee');employee.value='employee-a';employee.dispatchEvent(new Event('change',{bubbles:true}));const skill=document.querySelector('#work-skill');skill.value='skill-gearjob-work-order-read';skill.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#work-connection').value='connection-a';document.querySelector('#work-order-id').value=${JSON.stringify(workOrderId)};document.querySelector('#work-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.employeeId==='employee-a' && state.currentWork?.connectionId==='connection-a'`)
}

async function followUp(evaluate, waitFor, text, count) {
  await evaluate(`(()=>{document.querySelector('#follow-text').value=${JSON.stringify(text)};document.querySelector('#follow-form').requestSubmit()})()`)
  await waitFor(`state.currentWork?.status==='completed' && state.currentWork.results.filter(item=>item.kind==='assistant.follow-up').length===${count}`, 180_000)
}

async function resultSnapshot(evaluate, workId, count) {
  return evaluate(`(()=>{const results=state.currentWork.results.filter(item=>item.kind==='gearjob.work-order.observation'),result=results.at(-1),execution=state.currentWork.executions.at(-1);if(state.currentWork.id!==${JSON.stringify(workId)}||results.length!==${count})return null;return {kind:result.kind,planned:result.payload.plannedQuantity,completed:result.payload.completedQuantity,ratio:result.payload.completion?.ratio,previousRatio:results[0]?.payload.completion?.ratio,sourceSystem:result.source?.sourceSystem,sourceInstance:result.source?.sourceInstance,sourceEnvironment:result.source?.sourceEnvironment,dataMode:result.source?.dataMode,evidenceMode:result.source?.evidenceMode,sourceRecordId:result.source?.sourceRecordId,sourceTime:result.source?.sourceTime,queriedAt:result.payload.queriedAt,toolName:result.toolName,pluginId:result.pluginId,pluginVersion:result.pluginVersion,session:result.dshSessionRef,continuedFrom:result.continuedFromDshSessionRef,continuity:result.continuity,resultId:execution.resultId,legacyResultId:execution.resultObservationId,actualResultId:result.id,eventCount:execution.dshEventCount}})()`)
}

function validObservation(result) {
  return result?.kind === 'gearjob.work-order.observation'
    && result.planned === 10
    && result.sourceSystem === 'GearJob'
    && result.sourceInstance === 'dev.localhost'
    && result.sourceEnvironment === 'external-test'
    && result.dataMode === 'synthetic'
    && result.evidenceMode === 'real-frappe-rest'
    && result.sourceRecordId === `Work Order:${workOrderId}`
    && typeof result.sourceTime === 'string'
    && typeof result.queriedAt === 'string'
    && result.toolName === 'geneway_gearjob_read_work_order'
    && result.pluginId === 'geneway-gearjob-work-order'
    && typeof result.pluginVersion === 'string'
    && result.resultId === result.actualResultId
    && result.legacyResultId === result.actualResultId
    && result.eventCount > 0
}

async function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      GENEWAY_PORT: String(port),
      GENEWAY_STATE: statePath,
      GENEWAY_AUTH_FILE: authPath,
      GENEWAY_CONNECTION_CATALOG: connectionCatalogPath,
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
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  child.kill('SIGINT')
  throw new Error('Geneway start timed out')
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGINT')
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
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
    throw new Error(`Timed out waiting for browser condition: ${expression.slice(0, 240)}`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Page.bringToFront')
  return { socket: browserSocket, send, evaluate, waitFor }
}

function expectedNetworkFailure(item, privateWorkId) {
  if (item.status === 401 && (item.url?.endsWith('/api/session') || item.url?.endsWith('/api/bootstrap'))) return true
  if (item.status === 403 && item.url?.endsWith('/api/works')) return true
  if (item.status === 404 && item.url?.endsWith(`/api/works/${privateWorkId}`)) return true
  return false
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

async function gitHead() {
  const child = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  await new Promise(resolveExit => child.once('exit', resolveExit))
  return output.trim()
}
