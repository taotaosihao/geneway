const endpoint = process.env.GENEWAY_ACCEPT_CDP_ENDPOINT ?? 'http://127.0.0.1:9223'
const appUrl = process.env.GENEWAY_ACCEPT_APP_URL ?? 'http://127.0.0.1:3471'
const workOrderId = process.env.GENEWAY_ACCEPT_WORK_ORDER_ID
if (!workOrderId) throw new Error('GENEWAY_ACCEPT_WORK_ORDER_ID is required')

const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let sequence = 0
const pending = new Map()
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
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
await send('Page.bringToFront')
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
await evaluate(`document.querySelector('#follow-text').value='这条结论依据哪个来源记录？';document.querySelector('#follow-form').requestSubmit()`)
await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.followUps?.length === 1`)
const followed = await evaluate(`({observations:state.currentWork.observations.length,session:state.currentWork.followUps[0].dshSessionRef,continuity:state.currentWork.followUps[0].continuity})`)
await evaluate(`document.querySelector('#refresh-work').click()`)
await waitFor(`state.currentWork?.status === 'completed' && state.currentWork?.observations?.length === 2`)
const refreshed = await evaluate(`({observations:state.currentWork.observations.length,ratio:state.currentWork.observations.at(-1).completion?.ratio,url:location.href})`)
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await new Promise(resolve => setTimeout(resolve, 300))
const mobile = await evaluate(`({innerWidth,scrollWidth:document.documentElement.scrollWidth,hasSource:document.body.innerText.includes('GearJob 外部测试'),hasResult:document.body.innerText.includes('当前结果')})`)
if (followed.observations !== 1 || followed.session !== initial.session || followed.continuity !== 'same-session') throw new Error('same-session follow-up contract failed')
if (refreshed.observations !== 2 || mobile.innerWidth !== 390 || mobile.scrollWidth !== 390 || !mobile.hasSource || !mobile.hasResult) throw new Error('refresh or mobile contract failed')
console.log(JSON.stringify({ initial, followed, refreshed, mobile }))
socket.close()
