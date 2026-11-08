import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The sole owner supplies an actual Work with an already sealed rule draft.
// This browser consumer does not start or seed any source, API, Host, or model.
const target = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password)
const origin = target.origin, config = JSON.parse(await readFile(process.argv[3], 'utf8')), decision = config.decision ?? 'accepted'
assert(typeof config.workId === 'string' && config.workId && ['accepted', 'discarded'].includes(decision))
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/site-rule-ui-')
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), pages = [], errors = [], network = [], drafts = new Map()
const workPath = '/api/works/' + encodeURIComponent(config.workId), draftPath = workPath + '/site-diagnosis'
const timeout = config.timeoutMs ?? 120000, actionLabel = decision === 'accepted' ? '已采纳为内部意见' : '已丢弃，原记录保留'
function phase(name, details = {}) { const event = { kind: 'site-rule-ui-phase', phase: name, directory, ...details }; console.log(JSON.stringify(event)); if (process.connected) process.send(event) }
async function read(page, path) { const response = await page.request.get(origin + path); assert(response.ok(), 'Authorized read failed: ' + response.status()); return response.json() }
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
  await page.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await page.locator('[data-site-rule-draft]').waitFor()
  return page
}
async function refresh(page) {
  const observed = page.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'GET')
  await page.locator('#site-rule-refresh').click(); assert.equal((await observed).status(), 200)
}
async function save(page, name, selector = '#site-rule-panel') {
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false })
  await writeFile(join(directory, name + '.txt'), await page.locator('body').innerText())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal viewport overflow')
}
function protectedWork(work) {
  return { id: work.id, origin: work.origin, goal: work.goal, instructionRevision: work.instructionRevision, pendingQuestion: work.pendingQuestion ?? null, inputs: (work.multisite?.inputs ?? []).map(row => ({ id: row.id, revision: row.revision, text: row.text, attachments: row.attachments, spreadsheetRequest: row.spreadsheetRequest })) }
}
async function protectDraft(page, text) {
  const field = page.locator('#multisite-answer'); if (!await field.count()) return
  await field.fill(text); drafts.set(page, { text, question: await page.locator('#multisite-user-question').count() ? await page.locator('#multisite-user-question').innerText() : null })
}
async function checkDraft(page) {
  const draft = drafts.get(page); if (!draft) return
  assert.equal(await page.locator('#multisite-answer').inputValue(), draft.text)
  if (draft.question !== null) assert.equal(await page.locator('#multisite-user-question').innerText(), draft.question)
}
async function stateProjection() {
  if (!config.stateFile) return null
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
  return { work: state.works.filter(row => row.id === config.workId).map(row => ({ id: row.id, origin: row.origin, goal: row.goal, instructionRevision: row.instructionRevision })), questions: (state.userQuestions ?? []).filter(row => row.workId === config.workId), inputs: state.multisite.inputs.filter(row => row.workId === config.workId).map(({ deliveries, ...row }) => row) }
}
try {
  phase('browser-started', { workId: config.workId })
  const desktop = await pageFor({ width: 1366, height: 900 }), mobile = await pageFor({ width: 390, height: 844 })
  const served = await desktop.request.get(origin), html = await served.text(); assert(served.ok())
  await writeFile(join(directory, 'served-index.html'), html); await writeFile(join(directory, 'served-index.sha256'), createHash('sha256').update(html).digest('hex') + '\n')
  const workBefore = await read(desktop, workPath), before = await read(desktop, draftPath), beforeState = await stateProjection()
  assert.equal(workBefore.origin, 'rule'); assert.equal(before.origin, 'rule'); assert.equal(before.workId, config.workId); assert.equal(before.rule.mode, 'simulated')
  assert.equal(before.draft.kind, 'site_connection_diagnosis'); assert.equal(before.draft.version, 1); assert.equal(before.draft.decision, null); assert.equal(before.draft.actionable, true)
  assert.equal(before.draft.quality, 'current'); assert(before.draft.summary && before.draft.limitations); assert(before.draft.evidenceRef?.sha256)
  if (config.expectedSummary !== undefined) assert.equal(before.draft.summary, config.expectedSummary)
  if (config.expectedEvidenceSha256 !== undefined) assert.equal(before.draft.evidenceRef.sha256, config.expectedEvidenceSha256)
  for (const page of [desktop, mobile]) {
    const panel = await page.locator('#site-rule-panel').innerText()
    assert(panel.includes('模拟告警')); assert(panel.includes('待本人处置')); assert(panel.includes(before.draft.summary)); assert(panel.includes(before.draft.limitations))
    assert(!panel.includes(before.draft.evidenceRef.sha256)); assert(!panel.includes(before.rule.id)); assert(!panel.includes(before.rule.eventId))
    assert(!(await page.locator('#work-detail').innerText()).includes('整改表已生成并通过核验，可下载当前版本。'))
  }
  await protectDraft(desktop, '内部草稿处置期间保留这段尚未提交的工作说明。'); await protectDraft(mobile, '另一窗口保留这段未提交的回答。')
  await save(desktop, '01-pending-desktop'); await save(mobile, '02-pending-mobile')
  const posted = desktop.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'POST')
  await desktop.locator('[data-site-rule-decision="' + decision + '"]').click(); const response = await posted
  assert.equal(response.status(), 200)
  const submitted = response.request().postDataJSON(), receipt = await response.json()
  assert.deepEqual(submitted, { draftId: before.draft.id, expectedVersion: 1, decision })
  assert.equal(receipt.workId, config.workId); assert.equal(receipt.draft.id, before.draft.id); assert.equal(receipt.draft.decision, decision); assert.equal(receipt.draft.actionable, false)
  await desktop.getByText(actionLabel, { exact: true }).waitFor()
  await refresh(desktop); await refresh(mobile)
  await mobile.getByText(actionLabel, { exact: true }).waitFor()
  for (const page of [desktop, mobile]) { assert.equal(await page.locator('[data-site-rule-decision]').count(), 0); assert.equal(await page.locator('[data-site-rule-summary]').innerText(), before.draft.summary); await checkDraft(page) }
  const workAfter = await read(desktop, workPath), after = await read(desktop, draftPath), afterState = await stateProjection()
  assert.deepEqual(protectedWork(workAfter), protectedWork(workBefore)); if (beforeState) assert.deepEqual(afterState, beforeState)
  assert.deepEqual(after.rule, before.rule); assert.deepEqual(after.draft.evidenceRef, before.draft.evidenceRef); assert.equal(after.draft.summary, before.draft.summary); assert.equal(after.draft.decision, decision)
  await save(desktop, '03-decided-desktop'); await save(mobile, '04-decided-mobile')
  await desktop.reload(); await desktop.getByText(actionLabel, { exact: true }).waitFor(); await save(desktop, '05-reloaded-desktop')
  let ordinary = null
  if (config.ordinaryWorkId) {
    await mobile.goto(origin + '/?work=' + encodeURIComponent(config.ordinaryWorkId)); await mobile.locator('#work-detail .card').first().waitFor()
    const ordinaryPath = '/api/works/' + encodeURIComponent(config.ordinaryWorkId); ordinary = protectedWork(await read(mobile, ordinaryPath))
    assert.notEqual(ordinary.origin, 'rule'); assert.equal(await mobile.locator('#site-rule-panel').count(), 0)
    assert.equal(network.filter(row => row.path === ordinaryPath + '/site-diagnosis').length, 0)
    await save(mobile, '06-ordinary-mobile', '#work-detail .card')
  }
  assert.equal(network.filter(row => row.method === 'POST' && row.path === draftPath).length, 1)
  assert.equal(network.filter(row => row.method === 'POST' && row.path.startsWith('/api/works/') && row.path !== draftPath).length, 0)
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, origin, workId: config.workId, before, submitted, receipt, after, beforeWork: protectedWork(workBefore), afterWork: protectedWork(workAfter), beforeState, afterState, checkedUserDrafts: drafts.size, ordinary, network, errors, boundary: 'Actual authorized owner browser consumer of the existing simulated rule draft; no real device fault or external-effect claim.' }, null, 2))
  phase('decision-saved', { workId: config.workId, decision })
  console.log(JSON.stringify({ kind: 'site-rule-ui-result', directory, passed: true }))
} catch (cause) {
  for (const [index, page] of pages.entries()) { await page.screenshot({ path: join(directory, 'failure-' + index + '.png') }).catch(() => {}); await writeFile(join(directory, 'failure-' + index + '.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {}) }
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ origin, message: cause.message, stack: cause.stack, network, errors }, null, 2))
  console.error(JSON.stringify({ kind: 'site-rule-ui-failed', directory, message: cause.message })); process.exitCode = 1
} finally { await browser.close() }
