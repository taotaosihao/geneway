import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The owner supplies the live service and produces diagnosis facts through its
// real watchdog/DSH path. This consumer never starts or seeds those producers.
const target = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password)
const origin = target.origin, config = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert(typeof config.workId === 'string' && config.workId)
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/supervision-diagnosis-ui-')
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), pages = [], errors = [], network = []
const workPath = '/api/works/' + encodeURIComponent(config.workId), supervisionPath = workPath + '/supervision', timeout = config.timeoutMs ?? 120000
const drafts = new Map()
function phase(name, detail = {}) { const event = { kind: 'supervision-ui-phase', phase: name, directory, ...detail }; console.log(JSON.stringify(event)); if (process.connected) process.send(event) }
async function barrier(name, detail = {}) {
  let cleanup = () => {}, wait
  if (process.connected) wait = new Promise((resolve, reject) => {
    const finish = cause => { cleanup(); cause ? reject(cause) : resolve() }
    const listener = message => { if (message?.kind === 'supervision-ui-ack' && message.phase === name) finish(message.abort ? new Error('Owner aborted supervision UI fixture') : null) }
    const disconnect = () => finish(new Error('Supervision UI owner disconnected'))
    const timer = setTimeout(() => finish(new Error('Supervision UI owner acknowledgement timed out')), timeout)
    cleanup = () => { clearTimeout(timer); process.off('message', listener); process.off('disconnect', disconnect) }
    process.on('message', listener); process.once('disconnect', disconnect)
  })
  phase(name, detail)
  try { await wait } finally { cleanup() }
}
async function get(page, path) { const response = await page.request.get(origin + path); assert(response.ok(), 'Authorized read failed: ' + response.status()); return response.json() }
function card(page, id) { return page.locator('[data-supervision-diagnosis=' + JSON.stringify(id) + ']') }
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(); pages.push(page)
  page.setDefaultTimeout(timeout)
  page.on('pageerror', cause => errors.push(cause.message))
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }) })
  const session = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET')
  await page.goto(origin); await session
  await page.locator('#login-name').fill(process.env.GENEWAY_UI_LOGIN ?? 'owner')
  await page.locator('#login-password').fill(process.env.GENEWAY_UI_PASSWORD ?? 'synthetic owner password')
  await page.locator('#login-form button').click(); await page.locator('#open-interaction').waitFor()
  await page.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await page.locator('#supervision-grant-status').waitFor()
  return page
}
async function refresh(page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === supervisionPath && response.request().method() === 'GET')
  await page.locator('#supervision-refresh').click(); assert.equal((await response).status(), 200)
  await page.locator('#supervision-grant-status').waitFor()
}
async function save(page, name) {
  await page.locator('#supervision-panel').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false })
  await writeFile(join(directory, name + '.txt'), await page.locator('body').innerText())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal viewport overflow')
}
function protectedWork(work) { return { id: work.id, goal: work.goal, instructionRevision: work.instructionRevision, pendingQuestion: work.pendingQuestion ?? null, inputs: (work.multisite?.inputs ?? []).map(row => ({ id: row.id, revision: row.revision, text: row.text, attachments: row.attachments, spreadsheetRequest: row.spreadsheetRequest })) } }
async function keepDraft(page, text) {
  if (!await page.locator('#multisite-answer').count()) return
  await page.locator('#multisite-answer').fill(text)
  drafts.set(page, { text, dueDate: await page.locator('#multisite-answer-due').count() ? await page.locator('#multisite-answer-due').inputValue() : null, question: await page.locator('#multisite-user-question').count() ? await page.locator('#multisite-user-question').innerText() : null })
}
async function checkDraft(page) {
  const draft = drafts.get(page); if (!draft) return
  assert.equal(await page.locator('#multisite-answer').inputValue(), draft.text)
  if (draft.dueDate !== null) assert.equal(await page.locator('#multisite-answer-due').inputValue(), draft.dueDate)
  if (draft.question !== null) assert.equal(await page.locator('#multisite-user-question').innerText(), draft.question)
}
async function stateProjection() {
  if (!config.stateFile) return null
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
  return { work: state.works.filter(row => row.id === config.workId).map(row => ({ id: row.id, goal: row.goal, instructionRevision: row.instructionRevision })), questions: (state.userQuestions ?? []).filter(row => row.workId === config.workId), inputs: state.multisite.inputs.filter(row => row.workId === config.workId).map(({ deliveries, ...row }) => row) }
}
let desktop, mobile
try {
  phase('browser-started', { workId: config.workId })
  desktop = await pageFor({ width: 1366, height: 900 }); mobile = await pageFor({ width: 390, height: 844 })
  const served = await desktop.request.get(origin), html = await served.text()
  assert(served.ok()); await writeFile(join(directory, 'served-index.html'), html); await writeFile(join(directory, 'served-index.sha256'), createHash('sha256').update(html).digest('hex') + '\n')
  const before = await get(desktop, workPath), beforeState = await stateProjection(), beforeSupervision = await get(desktop, supervisionPath)
  assert.equal(beforeSupervision.workId, config.workId)
  await keepDraft(desktop, '查看监督建议期间，保留尚未提交的工作说明。'); await keepDraft(mobile, '另一窗口保留尚未提交的回答。')
  let enabled = null
  if (config.enableDiagnosis === true) {
    assert(beforeSupervision.configured, 'Owner must provide the configured diagnosis service')
    assert(!beforeSupervision.grant?.enabled || beforeSupervision.grant.instructionRevision !== beforeSupervision.instructionRevision, 'This scenario requires diagnosis to start explicitly disabled')
    await save(desktop, '01-disabled-desktop'); await save(mobile, '02-disabled-mobile')
    const accepted = desktop.waitForResponse(response => new URL(response.url()).pathname === supervisionPath + '/diagnosis' && response.request().method() === 'POST')
    await desktop.locator('#supervision-toggle').click(); const response = await accepted
    assert.equal(response.status(), 200)
    const submitted = response.request().postDataJSON(), receipt = await response.json()
    assert.deepEqual(Object.keys(submitted).sort(), ['enabled', 'expectedInstructionRevision', 'clientRequestId'].sort()); assert.equal(submitted.enabled, true); assert.equal(submitted.expectedInstructionRevision, beforeSupervision.instructionRevision); assert(receipt.grant?.enabled)
    await desktop.locator('#supervision-toggle').filter({ hasText: '关闭诊断建议' }).waitFor()
    enabled = { submitted, receipt }; await writeFile(join(directory, 'enabled.json'), JSON.stringify(enabled, null, 2))
    await barrier('diagnosis-enabled', { workId: config.workId })
  }
  await refresh(desktop); await refresh(mobile)
  const observed = await get(desktop, supervisionPath), diagnosis = config.diagnosisId ? observed.diagnoses.find(row => row.id === config.diagnosisId) : observed.diagnoses.find(row => row.state === 'completed' && !row.restricted && row.conclusion)
  assert(diagnosis?.conclusion && !diagnosis.restricted, 'The owner must produce a real currently readable diagnosis before this consumer proceeds')
  if (config.expectedConclusionKind) assert.equal(diagnosis.conclusion.kind, config.expectedConclusionKind)
  await card(desktop, diagnosis.id).waitFor(); await card(mobile, diagnosis.id).waitFor()
  assert((await card(desktop, diagnosis.id).innerText()).includes(diagnosis.conclusion.reason)); assert((await card(mobile, diagnosis.id).innerText()).includes(diagnosis.conclusion.reason))
  await checkDraft(desktop); await checkDraft(mobile); await save(desktop, '03-diagnosis-desktop'); await save(mobile, '04-diagnosis-mobile')
  const form = card(desktop, diagnosis.id).locator('[data-supervision-feedback]'), kind = config.feedbackKind ?? 'false_positive', note = config.note ?? '此判断存在误报，请结合所选的当前可读依据重新核对。'
  await form.locator('[data-supervision-feedback-kind]').selectOption(kind); await form.locator('[data-supervision-feedback-note]').fill(note)
  const options = diagnosis.feedbackOptions ?? [], refs = config.feedbackRefIds ?? options.slice(0, 1).map(row => row.id)
  assert(refs.length <= 4 && refs.every(id => options.some(row => row.id === id)))
  if (config.requireEvidence !== false) assert(refs.length > 0, 'Provide at least one currently readable counter-evidence option')
  for (const id of refs) await form.locator('[data-supervision-feedback-ref=' + JSON.stringify(id) + ']').check()
  const accepted = desktop.waitForResponse(response => new URL(response.url()).pathname === supervisionPath + '/diagnoses/' + encodeURIComponent(diagnosis.id) + '/feedback' && response.request().method() === 'POST')
  await form.locator('button[type="submit"]').click(); const response = await accepted
  assert.equal(response.status(), 200)
  const submitted = response.request().postDataJSON(), receipt = await response.json()
  assert.deepEqual(Object.keys(submitted).sort(), ['kind', 'note', 'refs', 'clientRequestId'].sort()); assert.equal(submitted.kind, kind); assert.equal(submitted.note, note); assert.deepEqual(submitted.refs, refs)
  await desktop.getByText('反馈已保存，原判断保持可查。', { exact: true }).waitFor()
  await refresh(desktop); await refresh(mobile)
  const afterSupervision = await get(desktop, supervisionPath), currentDiagnosis = afterSupervision.diagnoses.find(row => row.id === diagnosis.id)
  assert.deepEqual(currentDiagnosis.conclusion, diagnosis.conclusion); assert(currentDiagnosis.feedback.some(row => row.kind === kind && row.note === note && JSON.stringify(row.refs) === JSON.stringify(refs)))
  for (const page of [desktop, mobile]) { assert((await card(page, diagnosis.id).locator('[data-diagnosis-feedback-history]').innerText()).includes(note)); assert((await card(page, diagnosis.id).innerText()).includes(diagnosis.conclusion.reason)); await checkDraft(page) }
  const after = await get(desktop, workPath), afterState = await stateProjection()
  assert.deepEqual(protectedWork(after), protectedWork(before)); if (beforeState) assert.deepEqual(afterState, beforeState)
  await save(desktop, '05-feedback-desktop'); await save(mobile, '06-feedback-mobile')
  await desktop.reload(); await desktop.locator('#supervision-grant-status').waitFor(); await card(desktop, diagnosis.id).waitFor()
  assert((await card(desktop, diagnosis.id).locator('[data-diagnosis-feedback-history]').innerText()).includes(note)); assert((await card(desktop, diagnosis.id).innerText()).includes(diagnosis.conclusion.reason))
  await save(desktop, '07-reloaded-desktop')
  assert.equal(network.filter(row => row.method === 'POST' && row.path.endsWith('/feedback')).length, 1)
  assert.equal(network.filter(row => row.method === 'POST' && [workPath + '/inputs', workPath + '/cancel', workPath + '/multisite/resume'].includes(row.path)).length, 0)
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, origin, workId: config.workId, enabled, before: protectedWork(before), after: protectedWork(after), beforeSupervision, observed, submitted, receipt, afterSupervision, beforeState, afterState, network, errors, boundary: 'Actual browser consumer of owner-produced diagnosis facts; not evidence of real model diagnosis accuracy.' }, null, 2))
  phase('feedback-saved', { workId: config.workId, diagnosisId: diagnosis.id })
  console.log(JSON.stringify({ kind: 'supervision-ui-result', directory, passed: true }))
} catch (cause) {
  for (const [index, page] of pages.entries()) { await page.screenshot({ path: join(directory, 'failure-' + index + '.png') }).catch(() => {}); await writeFile(join(directory, 'failure-' + index + '.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}) }
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ origin, message: cause.message, stack: cause.stack, network, errors }, null, 2))
  console.error(JSON.stringify({ kind: 'supervision-ui-failed', directory, message: cause.message })); process.exitCode = 1
} finally { await browser.close() }
