import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const endpoint = process.env.GENEWAY_ACCEPT_CDP_ENDPOINT ?? 'http://127.0.0.1:9223'
const port = Number(process.env.GENEWAY_ACCEPT_PORT ?? 3480)
const appUrl = `http://127.0.0.1:${port}`
const workOrderId = process.env.GENEWAY_ACCEPT_WORK_ORDER_ID
const container = process.env.GENEWAY_ACCEPT_GEARJOB_CONTAINER
const site = process.env.GENEWAY_ACCEPT_GEARJOB_SITE ?? 'dev.localhost'
const stateRoot = process.env.GENEWAY_ACCEPT_STATE_ROOT ?? await mkdtemp(join(tmpdir(), 'geneway-p1-accept-'))
const recordIndex = process.argv.indexOf('--record')
const recordPath = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined
if (!workOrderId || !container) throw new Error('GENEWAY_ACCEPT_WORK_ORDER_ID and GENEWAY_ACCEPT_GEARJOB_CONTAINER are required')
if (!process.env.GENEWAY_GEARJOB_BASE_URL || !process.env.GENEWAY_GEARJOB_CREDENTIAL_FILE) throw new Error('GearJob runtime environment is required')
if (recordIndex >= 0 && (!recordPath || recordPath.startsWith('-'))) throw new Error('--record requires an output MP4 path')

let server
let recorder
let socket
const browserErrors = []
try {
  if (recordPath) recorder = await startRecorder(recordPath)
  await setProduced(0)
  server = await startServer()
  const browser = await connectBrowser()
  socket = browser.socket
  const { send, evaluate, waitFor } = browser

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`document.querySelector('#employee option[value]:not([value=""])')`)
  await evaluate(`(() => {
    const employee=document.querySelector('#employee');employee.value=employee.querySelector('option[value]:not([value=""])').value;
    const connection=document.querySelector('#connection');connection.value=connection.querySelector('option[value]:not([value=""])').value;
    document.querySelector('#work-order').value=${JSON.stringify(workOrderId)};
    document.querySelector('#work-form').requestSubmit();
  })()`)
  await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.observations?.length === 1`)
  const initial = await evaluate(`({id:state.currentWork.id,ratio:state.currentWork.observations[0].completion?.ratio,session:state.currentWork.observations[0].dshSessionRef})`)
  if (initial.ratio !== 0) throw new Error(`expected initial ratio 0, got ${initial.ratio}`)

  await evaluate(`document.querySelector('#follow-text').value='这条结论依据哪个来源记录？';document.querySelector('#follow-form').requestSubmit()`)
  await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.followUps?.length === 1`)
  const followed = await evaluate(`({observations:state.currentWork.observations.length,session:state.currentWork.followUps[0].dshSessionRef,continuity:state.currentWork.followUps[0].continuity})`)
  if (followed.observations !== 1 || followed.session !== initial.session || followed.continuity !== 'same-session') throw new Error('same-session follow-up contract failed')

  await setProduced(4)
  await evaluate(`document.querySelector('#refresh-work').click()`)
  await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.observations?.length === 2`)
  const refreshed = await evaluate(`({ratios:state.currentWork.observations.map(item=>item.completion?.ratio),url:location.href})`)
  if (refreshed.ratios[0] !== 0 || refreshed.ratios[1] !== 0.4) throw new Error(`expected ratios 0 then 0.4, got ${refreshed.ratios}`)

  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.currentWork?.id === ${JSON.stringify(initial.id)} && state.currentWork?.observations?.length === 2`)
  await stopServer(server)
  server = await startServer()
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`state.currentWork?.id === ${JSON.stringify(initial.id)} && state.currentWork?.status === 'completed'`)
  await evaluate(`document.querySelector('#follow-text').value='服务重启后，当前有依据的完成比例是多少？';document.querySelector('#follow-form').requestSubmit()`)
  await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.followUps?.length === 2`)
  const successor = await evaluate(`({observations:state.currentWork.observations.length,session:state.currentWork.followUps.at(-1).dshSessionRef,continuedFrom:state.currentWork.followUps.at(-1).continuedFromDshSessionRef,continuity:state.currentWork.followUps.at(-1).continuity})`)
  if (successor.observations !== 2 || successor.session === initial.session || successor.continuedFrom !== initial.session || successor.continuity !== 'successor') throw new Error('successor session contract failed')

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await new Promise(resolve => setTimeout(resolve, 300))
  const mobile = await evaluate(`({innerWidth,scrollWidth:document.documentElement.scrollWidth,hasSource:document.body.innerText.includes('GearJob 外部测试'),has40:document.body.innerText.includes('40%')})`)
  if (mobile.innerWidth !== 390 || mobile.scrollWidth !== 390 || !mobile.hasSource || !mobile.has40) throw new Error('mobile contract failed')
  if (browserErrors.length) throw new Error(`browser emitted ${browserErrors.length} error(s): ${browserErrors[0]}`)

  if (recordPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(recordPath.replace(/\.mp4$/i, '') + '.png', Buffer.from(shot.data, 'base64'))
  }
  console.log(JSON.stringify({ candidate: await gitHead(), initial, followed, refreshed, successor, mobile, browserErrors: browserErrors.length, recordPath }))
} finally {
  socket?.close()
  if (server) await stopServer(server)
  if (recorder) await stopRecorder(recorder)
}

async function startServer() {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, GENEWAY_PORT: String(port), GENEWAY_STATE: join(stateRoot, 'state.json'), GENEWAY_DSH_HOME: join(stateRoot, 'dsh') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let failure = ''
  child.stderr.on('data', chunk => { failure += chunk })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Geneway failed to start: ${failure.trim()}`)
    try { if ((await fetch(`${appUrl}/api/bootstrap`)).ok) return child } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill('SIGINT')
  throw new Error('Geneway start timed out')
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill('SIGINT')
  await new Promise(resolve => child.once('exit', resolve))
}

async function setProduced(quantity) {
  const cwd = '/workspace/development/frappe-bench'
  const args = JSON.stringify(['Work Order', workOrderId, 'produced_qty', quantity])
  await run('docker', ['exec', '-w', cwd, container, 'bench', '--site', site, 'execute', 'frappe.db.set_value', '--args', args])
  await run('docker', ['exec', '-w', cwd, container, 'bench', '--site', site, 'execute', 'frappe.db.commit'])
}

async function connectBrowser() {
  const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' }).then(response => response.json())
  const browserSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { browserSocket.onopen = resolve; browserSocket.onerror = reject })
  let sequence = 0
  const pending = new Map()
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
    if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level)) browserErrors.push(`log ${message.params.entry.level}: ${message.params?.entry?.text ?? 'unknown'} ${message.params?.entry?.url ?? ''}`.trim())
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    browserSocket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, timeout = 120_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out: ${expression}`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.bringToFront')
  return { socket: browserSocket, send, evaluate, waitFor }
}

async function startRecorder(path) {
  await mkdir(dirname(path), { recursive: true })
  return spawn('ffmpeg', ['-y', '-video_size', '1440x900', '-framerate', '25', '-f', 'x11grab', '-i', `${process.env.GENEWAY_ACCEPT_DISPLAY ?? ':97'}.0`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', path], { cwd: root, stdio: ['pipe', 'ignore', 'ignore'] })
}

async function stopRecorder(child) {
  if (child.exitCode !== null) return
  child.stdin.write('q')
  await new Promise(resolve => child.once('exit', resolve))
}

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', chunk => { error += chunk })
  const code = await new Promise(resolve => child.once('exit', resolve))
  if (code !== 0) throw new Error(`${command} failed: ${error.trim()}`)
}

async function gitHead() {
  const child = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  await new Promise(resolve => child.once('exit', resolve))
  return output.trim()
}
