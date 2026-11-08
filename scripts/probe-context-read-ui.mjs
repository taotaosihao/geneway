import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The native owner supplies an authenticated fixture and controls actual SDK progress.
const baseURL = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(baseURL.protocol) && !baseURL.username && !baseURL.password, 'Provide the owner URL without credentials')
const origin = baseURL.origin, config = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert(config.threadId && ['ordinary', 'intent-idle', 'question-open'].includes(config.scenario), 'Provide the real Thread and context-read scenario')
if (config.repeatSlot) assert(process.connected, 'Repeat-slot validation requires the native owner IPC barriers')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-ui-')
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), contexts = [], errors = [], network = []
const threadPath = '/api/interaction/threads/' + encodeURIComponent(config.threadId)
let desktop, mobile
function phase(name, detail = {}) {
  const value = { kind: 'context-read-ui-phase', phase: name, ...detail }
  console.log(JSON.stringify(value)); if (process.connected) process.send(value)
}
async function humanContinueAccepted(detail) {
  const captured = process.connected ? new Promise((resolve, reject) => {
    const listener = message => { if (message.kind === 'context-read-ui-ack' && message.phase === 'human-continue-accepted' && (message.slot === undefined || message.slot === detail.slot)) { clearTimeout(timer); process.off('message', listener); if (message.abort === true) reject(new Error('Owner aborted context UI fixture')); else resolve() } }
    const timer = setTimeout(() => { process.off('message', listener); reject(new Error('Owner did not acknowledge the human-continue snapshot')) }, 30000)
    process.on('message', listener)
  }) : null
  phase('human-continue-accepted', detail)
  if (captured) await captured
}
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport }); contexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', cause => errors.push(cause.message))
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }) })
  const initial = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET')
  await page.goto(origin); await initial
  await page.locator('#login-name').fill(process.env.GENEWAY_UI_LOGIN ?? 'owner')
  await page.locator('#login-password').fill(process.env.GENEWAY_UI_PASSWORD ?? 'synthetic owner password')
  await page.locator('#login-form button').click(); await page.locator('#open-interaction').waitFor()
  await page.goto(origin + '/?view=interaction&thread=' + encodeURIComponent(config.threadId)); await page.locator('#interaction-text').waitFor()
  return page
}
async function get(page, path) { const response = await page.request.get(origin + path); assert(response.ok(), 'Authorized readback failed: ' + response.status()); return response.json() }
async function shot(page, name, target) {
  await target?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false })
  await writeFile(join(directory, name + '.txt'), await page.locator('body').innerText())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal viewport overflow')
}
async function snapshot(readId) {
  if (!config.stateFile) return null
  const state = JSON.parse(await readFile(config.stateFile, 'utf8')), read = state.contextReads.find(row => row.id === readId)
  const instance = state.contextReadInstances.find(row => row.id === read?.contextInstanceId), link = state.workContinuations.find(row => row.id === instance?.continuationId)
  assert(instance && link, 'Read must belong to a real continuation')
  const work = state.works.find(row => row.id === link.workId), intentIds = new Set(state.workIntents.filter(row => row.workId === work.id).map(row => row.id))
  return {
    workId: work.id, goal: work.goal, instructionRevision: work.instructionRevision,
    inputs: state.multisite.inputs.filter(row => row.workId === work.id).map(row => ({ id: row.id, revision: row.revision })),
    questions: [...state.intentQuestions.filter(row => intentIds.has(row.intentId)).map(row => ({ kind: 'intent', id: row.id, state: row.state })), ...state.multisite.questions.filter(row => row.workId === work.id).map(row => ({ kind: 'agent', id: row.id, state: row.state })), ...state.userQuestions.filter(row => row.workId === work.id).map(row => ({ kind: 'user', id: row.id, state: row.state }))],
    windows: state.contextReadWindows.filter(row => row.contextInstanceId === instance.id && row.parentReadId === readId).map(row => ({ id: row.id, sourceEventId: row.sourceEventId, parentReadId: row.parentReadId })),
    modelRequests: state.modelRequests.filter(row => row.work_id === work.id).length,
  }
}
try {
  phase('browser-started', { directory, scenario: config.scenario })
  desktop = await pageFor({ width: 1366, height: 900 })
  const desktopDocument = config.repeatSlot ? await desktop.evaluate(() => performance.timeOrigin) : null
  const initial = await get(desktop, threadPath), read = initial.contextReads.find(row => row.readId === config.readId && row.canContinue) ?? (!config.readId && initial.contextReads.find(row => row.canContinue))
  assert(read, 'The fixture must expose a currently authorized unread position')
  if (config.repeatSlot) assert.equal(typeof read.continuationKey, 'string', 'Repeat-slot validation requires the server continuation key')
  const readId = read.readId, row = desktop.locator('[data-context-read="' + readId + '"]')
  await row.locator('[data-context-read-continue]').waitFor()
  if (config.relationPending === true) assert.equal(read.relationPending, true, 'The fixture must expose an unread relation')
  assert((await row.innerText()).includes(read.relationPending ? '后续关联资料尚未读取' : '历史资料还有未读内容'))
  if (read.relationPending) {
    assert.equal(read.nextIndex, null); assert.equal(read.totalItems, null)
    assert(!(await row.innerText()).includes('项未读'), 'An unread relation must not invent an item count')
  }
  for (const internalId of [readId, read.contextInstanceId]) assert(!(await row.innerText()).includes(internalId), 'Technical IDs must not appear in visible content')
  const question = initial.intents.flatMap(intent => intent.questions).find(question => question.state === 'open')
  if (config.scenario === 'question-open') {
    assert(question, 'The fixture must expose the actual open intent question')
    await desktop.locator('[data-interaction-answer="' + question.id + '"]').click()
  }
  const draft = '这段工作要求草稿仍待我确认，不随资料续读提交。'
  await desktop.locator('#interaction-text').fill(draft)
  await shot(desktop, '01-unread-desktop', row)
  mobile = await pageFor({ width: 390, height: 844 })
  const mobileRow = mobile.locator('[data-context-read="' + readId + '"]')
  await mobileRow.locator('[data-context-read-continue]').waitFor()
  await mobile.locator('#interaction-text').fill('另一窗口保留这段尚未提交的草稿。')
  await shot(mobile, '02-unread-mobile', mobileRow)
  const before = await snapshot(readId)
  const accepted = desktop.waitForResponse(response => response.url() === origin + threadPath + '/events' && response.request().method() === 'POST')
  await row.locator('[data-context-read-continue]').click(); const response = await accepted
  assert.equal(response.status(), 200)
  const sent = response.request().postDataJSON(), receipt = await response.json()
  assert.deepEqual(Object.keys(sent).sort(), ['clientRequestId', 'sourceEventId', 'version', 'expectedThreadRevision', 'text', 'continueContextRead'].sort())
  assert.deepEqual(sent.continueContextRead, { readId }); assert.equal(sent.text, '继续读取资料'); assert.equal(sent.version, 1)
  assert.equal(receipt.readId, readId); assert.equal(receipt.threadId, config.threadId)
  assert(['approved_waiting', 'notified'].includes(receipt.state)); assert(receipt.contextReadWindowId)
  await desktop.waitForFunction(() => !document.querySelector('#interaction-text').disabled)
  assert.equal(await desktop.locator('#interaction-text').inputValue(), draft)
  if (question && config.scenario === 'question-open') assert(await desktop.locator('#interaction-reply-context').isVisible(), 'Approval must retain the unanswered question context')
  const current = await get(desktop, threadPath), currentRead = current.contextReads.find(row => row.readId === readId)
  assert(!currentRead?.canContinue, 'Approval must not leave another available window for the same page')
  if (config.scenario === 'question-open') {
    assert.equal(receipt.state, 'approved_waiting')
    assert.equal(current.intents.flatMap(intent => intent.questions).find(row => row.id === question.id)?.state, 'open')
    assert.equal(currentRead?.waitingReason, 'QUESTION_PENDING')
  }
  await shot(desktop, '03-approved-desktop', desktop.locator('#interaction-message'))
  const refreshed = mobile.waitForResponse(response => response.url() === origin + threadPath && response.request().method() === 'GET')
  await mobile.locator('#interaction-refresh').click(); await refreshed
  await mobile.waitForFunction(id => { const row = [...document.querySelectorAll('[data-context-read]')].find(row => row.dataset.contextRead === id); return !row || row.dataset.contextReadState !== 'available' && !row.querySelector('[data-context-read-continue]') }, readId)
  assert.equal(await mobileRow.locator('[data-context-read-continue]').count(), 0, 'The second context must not offer duplicate approval after refresh')
  assert.equal(await mobile.locator('#interaction-text').inputValue(), '另一窗口保留这段尚未提交的草稿。')
  await shot(mobile, '04-approved-second-context', await mobileRow.count() ? mobileRow : mobile.locator('#interaction-form'))
  const after = await snapshot(readId)
  if (before && after) {
    for (const field of ['workId', 'goal', 'instructionRevision', 'inputs', 'questions']) assert.deepEqual(after[field], before[field], 'Context approval must retain ' + field)
    assert.equal(after.windows.length, before.windows.length + 1)
    assert(after.windows.some(window => window.id === receipt.contextReadWindowId))
    if (config.scenario === 'question-open') assert.equal(after.modelRequests, before.modelRequests, 'An open question must prevent new model requests')
  }
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'approval.json'), JSON.stringify({ receipt, submitted: sent, currentRead: currentRead ?? null, before, after }, null, 2))
  await humanContinueAccepted({ directory, scenario: config.scenario, threadId: config.threadId, readId, contextReadWindowId: receipt.contextReadWindowId, state: receipt.state, slot: 1 })
  let secondReceipt = null
  if (config.repeatSlot) {
    const refreshed = desktop.waitForResponse(response => response.url() === origin + threadPath && response.request().method() === 'GET')
    await desktop.locator('#interaction-refresh').click(); await refreshed
    const nextThread = await get(desktop, threadPath), nextRead = nextThread.contextReads.find(read => read.readId === readId && read.canContinue)
    assert(nextRead, 'The owner must expose the next slot on the same real parent read')
    assert.equal(typeof nextRead.continuationKey, 'string'); assert.notEqual(nextRead.continuationKey, read.continuationKey)
    assert.equal(nextRead.state, 'available'); assert.equal(nextRead.relationPending, true)
    assert.equal(nextRead.nextIndex, null); assert.equal(nextRead.totalItems, null)
    await row.locator('[data-context-read-continue]').waitFor()
    assert((await row.innerText()).includes('后续关联资料尚未读取'))
    assert.equal(await desktop.evaluate(() => performance.timeOrigin), desktopDocument, 'The desktop document and retry cache must survive both slots')
    assert.equal(await desktop.locator('#interaction-text').inputValue(), draft)
    await shot(desktop, '05-second-slot-desktop', row)
    const mobileRefreshed = mobile.waitForResponse(response => response.url() === origin + threadPath && response.request().method() === 'GET')
    await mobile.locator('#interaction-refresh').click(); await mobileRefreshed
    await mobileRow.locator('[data-context-read-continue]').waitFor()
    await shot(mobile, '06-second-slot-mobile', mobileRow)
    const secondBefore = await snapshot(readId)
    const accepted = desktop.waitForResponse(response => response.url() === origin + threadPath + '/events' && response.request().method() === 'POST')
    await row.locator('[data-context-read-continue]').click(); const response = await accepted
    assert.equal(response.status(), 200)
    const submitted = response.request().postDataJSON(); secondReceipt = await response.json()
    assert.deepEqual(Object.keys(submitted).sort(), Object.keys(sent).sort())
    assert.deepEqual(submitted.continueContextRead, { readId }); assert.equal(submitted.text, '继续读取资料'); assert.equal(submitted.version, 1)
    assert.notEqual(submitted.sourceEventId, sent.sourceEventId); assert.notEqual(submitted.clientRequestId, sent.clientRequestId)
    assert.equal(secondReceipt.readId, readId); assert.equal(secondReceipt.threadId, config.threadId)
    assert(secondReceipt.contextReadWindowId); assert.notEqual(secondReceipt.contextReadWindowId, receipt.contextReadWindowId)
    assert(['approved_waiting', 'notified'].includes(secondReceipt.state))
    await desktop.waitForFunction(() => !document.querySelector('#interaction-text').disabled)
    assert.equal(await desktop.evaluate(() => performance.timeOrigin), desktopDocument)
    assert.equal(await desktop.locator('#interaction-text').inputValue(), draft)
    const secondCurrent = await get(desktop, threadPath), approvedRead = secondCurrent.contextReads.find(read => read.readId === readId)
    assert(!approvedRead?.canContinue)
    await shot(desktop, '07-second-approved-desktop', desktop.locator('#interaction-message'))
    const afterRefresh = mobile.waitForResponse(response => response.url() === origin + threadPath && response.request().method() === 'GET')
    await mobile.locator('#interaction-refresh').click(); await afterRefresh
    await mobile.waitForFunction(id => { const row = [...document.querySelectorAll('[data-context-read]')].find(row => row.dataset.contextRead === id); return !row || row.dataset.contextReadState !== 'available' && !row.querySelector('[data-context-read-continue]') }, readId)
    assert.equal(await mobileRow.locator('[data-context-read-continue]').count(), 0)
    assert.equal(await mobile.locator('#interaction-text').inputValue(), '另一窗口保留这段尚未提交的草稿。')
    await shot(mobile, '08-second-approved-mobile', await mobileRow.count() ? mobileRow : mobile.locator('#interaction-form'))
    const secondAfter = await snapshot(readId)
    if (secondBefore && secondAfter) {
      for (const field of ['workId', 'goal', 'instructionRevision', 'inputs', 'questions']) assert.deepEqual(secondAfter[field], secondBefore[field], 'Second-slot approval must retain ' + field)
      assert.equal(secondAfter.windows.length, secondBefore.windows.length + 1)
      assert(secondAfter.windows.some(window => window.id === secondReceipt.contextReadWindowId))
    }
    await writeFile(join(directory, 'second-approval.json'), JSON.stringify({ submitted, receipt: secondReceipt, previousSlot: { readId, continuationKey: read.continuationKey, contextReadWindowId: receipt.contextReadWindowId }, currentRead: nextRead, approvedRead: approvedRead ?? null, before: secondBefore, after: secondAfter }, null, 2))
    assert.deepEqual(errors, [])
    await humanContinueAccepted({ directory, scenario: config.scenario, threadId: config.threadId, readId, contextReadWindowId: secondReceipt.contextReadWindowId, state: secondReceipt.state, slot: 2 })
  }
  const result = { result: 'passed', directory, origin, scenario: config.scenario, threadId: config.threadId, readId, receipt, slots: config.repeatSlot ? 2 : 1, secondReceipt, bothDraftsPreserved: true, duplicateActionUnavailable: true, businessStateChecked: !!after, boundary: 'actual two-context Web approval only; owner separately proves native SDK notification/consumption and subsequent data read; no service/provider/Host started or positive facts inserted', pageErrors: errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); phase('browser-completed', { directory })
} catch (cause) {
  console.error('Context-read UI boundary:', cause.message)
  if (desktop && !desktop.isClosed()) await shot(desktop, 'failure-desktop').catch(() => {})
  if (mobile && !mobile.isClosed()) await shot(mobile, 'failure-mobile').catch(() => {})
  throw cause
} finally {
  await writeFile(join(directory, 'network.json'), JSON.stringify(network, null, 2))
  for (const context of contexts) await context.close(); await browser.close()
}
