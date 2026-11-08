import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import ExcelJS from 'exceljs'
import { createFileStore } from '../src/store/file-store.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { digest } from '../packages/agent-contracts/index.mjs'
import { initializeAuthFile } from '../src/auth.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-')
const captures = [], errors = [], hash = bytes => createHash('sha256').update(bytes).digest('hex')
let provider, api, remote, browser, context, page
const children = [], childOutput = []
let heldForGet, firstJobObserved, getResultObserved = false
const text = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
try {
  const statePath = join(directory, 'state.json'), store = createFileStore(statePath); await store.update(state => { seedDelegation(state); for (const employee of state.employees) { employee.placement.nodeId = employee.id === 'desktop-office' ? 'pc-b' : 'unused'; employee.skillIds = ['cycle'] }; state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; return state })
  await mkdir(join(directory, 'secrets')); await writeFile(join(directory, 'secrets/model.key'), 'synthetic-spreadsheet-provider', { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.headers.authorization, 'Bearer synthetic-spreadsheet-provider')
      const lastUser = body.messages.findLastIndex(message => message.role === 'user'), input = text(body.messages[lastUser].content)
      const requestSnapshot = JSON.parse(/用户整改表要求：(\{[^\n]+\})。期限/.exec(input)[1])
      const results = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool'), result = results.length ? JSON.parse(text(results.at(-1).content)) : null
      const lastCall = body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === results.at(-1)?.tool_call_id)?.function.name
      const refs = body.messages.filter(message => message.role === 'user').flatMap(message => [...text(message.content).matchAll(/受控资料引用：(\[[^\n]+\])/g)].flatMap(match => JSON.parse(match[1])))
      const names = body.tools.map(tool => tool.function.name)
      for (const name of ['geneway_read_evidence', 'geneway_start_spreadsheet', 'geneway_get_spreadsheet_job', 'geneway_multisite_report']) assert(names.includes(name))
      const capture = { body, requestSnapshot, images: body.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url').map(block => hash(Buffer.from(block.image_url.url.split(',')[1], 'base64')))) }
      captures.push(capture)
      let tool, parameters
      if (!requestSnapshot.dueDate || input.includes('暂不生成')) {
        if (!results.length) { tool = 'geneway_multisite_report'; parameters = { state: 'waiting', summary: requestSnapshot.dueDate ? '已保存期限，等待最终确认。' : '已收到照片和历史资料，需要明确整改期限。', question: requestSnapshot.dueDate ? '请确认最终整改期限后提交生成。' : '请填写整改期限后提交补充。' } }
      } else if (!results.length) { tool = 'geneway_read_evidence'; parameters = { ref: refs.at(-1) } }
      else if (result?.entries) {
        tool = 'geneway_start_spreadsheet'; parameters = { clientRequestId: `generate-revision-${result.instructionRevision}`, instructionRevision: result.instructionRevision, template: result.template, historyRefs: [result.ref], rows: result.entries.map(entry => ({ sourceRef: result.ref, entryIndex: entry.entryIndex, dueDate: result.spreadsheetRequest.dueDate, photoRefs: refs.filter(ref => ref.attachmentId !== result.ref.attachmentId) })) }
      }
      if (!tool && result?.id && lastCall === 'geneway_start_spreadsheet') { tool = 'geneway_get_spreadsheet_job'; parameters = { jobId: result.id } }
      if (lastCall === 'geneway_get_spreadsheet_job' && result?.id && !getResultObserved) { getResultObserved = true; await firstJobObserved; process.kill(heldForGet.worker.pid, 'SIGCONT') }
      capture.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'spreadsheet-capture-' + captures.length, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-' + captures.length, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: '处理已受理，请查看工作状态和文件核验结果。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('local capture failed') }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const authPath = join(directory, 'auth.json'); await initializeAuthFile(authPath, { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await writeFile(join(directory, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  const portServer = createPortServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = Number(process.env.GENEWAY_TEST_BACKEND_PORT ?? portServer.address().port); await new Promise(resolve => portServer.close(resolve)); const origin = process.env.GENEWAY_TEST_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`
  api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: directory, GENEWAY_STATE: statePath, GENEWAY_AUTH_FILE: authPath, GENEWAY_SECRET_ROOT: join(directory, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'model.key', GENEWAY_CONNECTION_CATALOG: join(directory, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(directory, 'unused-cloud-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  await new Promise((resolve, reject) => { api.stdout.on('data', bytes => { childOutput.push(bytes.toString()); if (bytes.toString().includes('Geneway listening on')) resolve() }); api.stderr.on('data', bytes => childOutput.push(bytes.toString())); api.once('exit', code => reject(new Error('API exited '+code))) })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  const paired = await fetch(origin + '/api/admin/nodes/pairings', { method: 'POST', headers: { origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'pair-b', nodeId: 'pc-b', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['desktop-office'], expiresAt: new Date(Date.now()+120000).toISOString() }) }); assert(paired.ok); const pairing = await paired.json()
  const remoteRoot = join(directory, 'pc-b'); await mkdir(remoteRoot); const profile = join(remoteRoot, 'profile.json'); await writeFile(profile, JSON.stringify({ root: remoteRoot, origin, officeEnabled: true, pairing: { pairingId: pairing.pairingId, pairingCode: pairing.pairingCode } }), { mode: 0o600 })
  remote = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: remoteRoot, ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(remote)
  remote.stderr.on('data', bytes => childOutput.push(bytes.toString()))
  await new Promise((resolve, reject) => { remote.on('message', message => { if (message.kind === 'ready') resolve(); if (message.kind === 'host-error') { errors.push(message.code); reject(new Error(message.code)) } }); remote.once('exit', code => reject(new Error('remote exited '+code))) })
  const png = await sharp({ create: { width: 96, height: 60, channels: 3, background: '#2277aa' } }).png().toBuffer(), imagePath = join(directory, '现场照片.png'), historyPath = join(directory, '历史异常.json')
  await writeFile(imagePath, png)
  await writeFile(historyPath, JSON.stringify({ format: 'geneway.incident-history', version: 1, entries: [{ date: '2026-11-01', description: '护罩松动', owner: '张工' }, { date: '2026-11-02', description: '漏油', owner: '李工' }, { date: '2026-11-03', description: '护罩松动', owner: '张工' }] }))
  const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
  browser = await chromium.launch({ headless: true, ...(process.env.GENEWAY_TEST_BROWSER_HOME ? { executablePath: '/usr/bin/google-chrome', env: { ...process.env, HOME: process.env.GENEWAY_TEST_BROWSER_HOME } } : {}) }); context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true })
  page = await context.newPage(); const pageErrors = []; page.on('pageerror', cause => { pageErrors.push(cause.message); void appendFile(join(directory, 'browser-network.jsonl'), JSON.stringify({ pageerror: cause.message })+'\n') }); page.on('response', response => { void appendFile(join(directory, 'browser-network.jsonl'), JSON.stringify({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() })+'\n') })
  const initialSession = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET'); await page.goto(origin); await initialSession; await page.locator('#login-name').fill('owner'); await page.locator('#login-password').fill('synthetic owner password'); await page.locator('#login-form button').click()
  await page.locator('#work-mode').waitFor();
  if (process.argv.includes('--login-only')) console.log(JSON.stringify({ result: 'passed', scope: 'real browser login and bootstrap including production knowledge reads', directory }))
  else {
  firstJobObserved = (async () => { await until(async () => { const local = JSON.parse(await readFile(join(directory, 'pc-b/host-journal.json'), 'utf8')); const job = local.jobs.find(row => row.state === 'running' && row.worker); if (!job) return false; process.kill(job.worker.pid, 'SIGSTOP'); heldForGet = job; return true }) })()
  await page.locator('#work-mode').selectOption('multisite'); await page.locator('#work-employee').selectOption('desktop-office'); await page.locator('#work-goal').fill('根据现场照片与历史记录生成异常整改表')
  await page.locator('#multisite-spreadsheet').check(); await page.locator('#multisite-files').setInputFiles([imagePath, historyPath]); await page.locator('#submit-work').click()
  await until(async () => (await store.read()).works[0]?.status === 'waiting_input')
  await page.getByText('请填写整改期限后提交补充。',{exact:true}).waitFor(); await page.screenshot({ path: join(directory, '01-question.png'), fullPage: true })
  assert.match(await page.locator('#work-detail').innerText(), /请填写整改期限/)
  const workId = (await store.read()).works[0].id
  await page.locator('#multisite-answer-due').fill('2026-11-15'); await page.locator('#multisite-answer').fill('期限先定11月15日，暂不生成，我还要核对期限。'); await page.locator('#multisite-input-form button').click()
  await until(async () => (await store.read()).works[0].instructionRevision === 2 && (await store.read()).works[0].status === 'waiting_input')
  await page.locator('#multisite-answer-due').fill('2026-11-20'); await page.locator('#multisite-answer').fill('最终修订期限为11月20日，请生成整改表。')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(await page.locator('#multisite-answer-due').inputValue(), '2026-11-20'); assert.equal(await page.locator('#multisite-answer').inputValue(), '最终修订期限为11月20日，请生成整改表。')
  await page.locator('#multisite-input-form button').click()
  await until(async () => (await store.read()).works[0].status === 'completed')
  await page.reload(); await page.locator('#download-spreadsheet').waitFor(); await page.screenshot({ path: join(directory, '02-completed.png'), fullPage: true })
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-spreadsheet').click()]), downloadPath = join(directory, '下载整改表.xlsx'); await download.saveAs(downloadPath)
  const state = await store.read(), work = state.works.find(row => row.id === workId), artifact = state.artifacts.find(row => row.workId === workId)
  assert.equal(work.instructionRevision, 3); assert.equal(artifact.instructionRevision, 3); assert.equal(hash(await readFile(downloadPath)), artifact.sha256)
  assert.equal(work.artifactRefs[0].sha256, artifact.sha256); assert.equal(artifact.verification.rowCount, 3)
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(downloadPath); const sheet = book.worksheets[0]
  for (const [row, date, description, owner, count] of [[3, '2026-11-01', '护罩松动', '张工', 2], [4, '2026-11-02', '漏油', '李工', 1], [5, '2026-11-03', '护罩松动', '张工', 2]]) {
    assert.equal(sheet.getCell(row, 2).value, date); assert.equal(sheet.getCell(row, 3).value, description); assert.equal(sheet.getCell(row, 4).value, owner); assert.equal(sheet.getCell(row, 5).value, '2026-11-20'); assert.equal(sheet.getCell(row, 6).value, count)
  }
  assert.equal(sheet.getCell('B6').value, 3); assert.equal(sheet.getCell('D6').value, 2); assert.equal(sheet.getCell('F6').value, 2)
  await until(async () => (await store.read()).multisite.attempts[0].settledAt)
  assert(captures.some(row => row.images.length > 0)); assert.equal(state.works[0].modelRequestBudget.reserved, captures.length); assert.equal(errors.length, 0, errors.join('\n')); assert.deepEqual(pageErrors, [])
  // Hold a real, identified generator process; the user still performs the stop through the UI.
  let held, stopWatching = false
  const heldWorker = (async () => {
    while (!stopWatching) {
      const local = JSON.parse(await readFile(join(directory, 'pc-b/host-journal.json'), 'utf8'))
      const job = local.jobs.find(row => row.work_id !== workId && row.state === 'running' && row.worker)
      if (job) { process.kill(job.worker.pid, 'SIGSTOP'); held = job; return job }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })()
  try {
    await page.locator('[data-view="home"]').first().click(); await page.locator('#work-mode').selectOption('multisite'); await page.locator('#work-employee').selectOption('desktop-office'); await page.locator('#work-goal').fill('停止生成中的整改表')
    await page.locator('#multisite-spreadsheet').check(); await page.locator('#multisite-due-date').fill('2026-11-25'); await page.locator('#multisite-files').setInputFiles([imagePath, historyPath]); await page.locator('#submit-work').click()
    await Promise.race([heldWorker, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('real generator not observed')), 20_000); timer.unref() })])
    assert(held); await page.locator('#work-detail h2').filter({ hasText: '停止生成中的整改表' }).waitFor(); await page.screenshot({ path: join(directory, '03-running-generator.png'), fullPage: true })
    await page.locator('#cancel-work').click(); await until(async () => (await store.read()).works.find(row => row.id === held.work_id).status === 'cancelled')
    await page.getByText('本次执行已确认停止，已交办资料与处理记录保留。', { exact: true }).waitFor(); await page.screenshot({ path: join(directory, '04-stopped.png'), fullPage: true })
    assert.match(await page.locator('#spreadsheet-progress').innerText(), /生成已停止/)
    assert.doesNotMatch(await page.locator('#spreadsheet-progress').innerText(), /正在生成|正在停止/)
    const final = await store.read(), local = JSON.parse(await readFile(join(directory, 'pc-b/host-journal.json'), 'utf8')), stopped = local.jobs.find(row => row.id === held.id)
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.stopEvidence.workerExit, 'exit_confirmed'); assert.equal(stopped.stopEvidence.output, 'no_published_output'); assert(!final.artifacts.some(row => row.workId === held.work_id && row.status === 'ready'))
    const processStat = await readFile(`/proc/${held.worker.pid}/stat`, 'utf8').catch(cause => { if (cause.code !== 'ENOENT') throw cause; return '' }); assert(!processStat || processStat.slice(processStat.lastIndexOf(')') + 2).startsWith('Z '))
  } finally { stopWatching = true; await heldWorker }
  const result = { result: 'passed', directory, workId, artifactId: artifact.id, sha256: artifact.sha256, revision: 3, providerRequests: captures.length, boundary: 'actual production remote start + independent B parent + browser + HTTP + DSH + original XLSX worker + cloud independent verification; synthetic provider does not prove image understanding', typedDeadlineQuestionAnswerRevision: true, refreshDownloadBusinessOracle: true, actualResourcesSettled: true, realGeneratorUiStopNoReady: true, stoppedWorkId: held.work_id }
  const final = await store.read(); assert.equal(final.multisite.attempts.length, 2)
  assert(getResultObserved); assert(captures.some(capture => capture.tool === 'geneway_get_spreadsheet_job'))
  const apiChildren = (await readFile(`/proc/${api.pid}/task/${api.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean), apiChildCommands = []
  for (const pid of apiChildren) { const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(cause => { if (cause.code !== 'ENOENT') throw cause; return '' }); apiChildCommands.push({ pid, command }); assert(!command.includes('runtime-worker.mjs') && !command.includes('spreadsheet-worker.mjs'), 'production remote API must not own execution workers') }
  const rawDigests = captures.map(row => digest(row.body)).sort(), ledgerDigests = final.modelRequests.map(row => row.bodyDigest).sort(); assert.deepEqual(rawDigests, ledgerDigests); result.providerLedgerDigestVerified = rawDigests.length; result.productionRemoteNoCloudWorker = true; result.apiChildCommands = apiChildCommands
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) {
  console.error('Native boundary failure:', cause.stack)
  if (page && !page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); await writeFile(join(directory, 'failure-dom.txt'), await page.locator('body').innerText()) }
  throw cause
} finally {
  await context?.close(); await browser?.close()
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  await writeFile(join(directory, 'parents.log'), childOutput.join(''))
  await writeFile(join(directory, 'capture.json'), JSON.stringify({ captures, errors }, null, 2)); console.log('Spreadsheet native evidence:', directory)
}
async function until(predicate) { const deadline = Date.now() + 60_000; while (!await predicate()) { assert(Date.now() < deadline, 'spreadsheet journey timed out'); await new Promise(resolve => setTimeout(resolve, 100)) } }
