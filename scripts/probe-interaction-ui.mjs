import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The backend owner supplies a running fixture; this driver never creates a provider or seeds facts.
const baseURL = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(baseURL.protocol), 'Provide the owner-started test base URL')
assert(!baseURL.username && !baseURL.password, 'Credentials must not be placed in the URL')
const config = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : {}
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/interaction-ui-')
const credentials = { login: process.env.GENEWAY_UI_LOGIN ?? 'owner', password: process.env.GENEWAY_UI_PASSWORD ?? 'synthetic owner password' }
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), contexts = [], network = [], errors = []
let page
const origin = baseURL.origin
async function createPage(viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context)
  const target = await context.newPage()
  target.on('pageerror', cause => errors.push(cause.message))
  target.on('response', response => { const url = new URL(response.url()); if (url.origin === origin) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }) })
  const restored = target.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET')
  await target.goto(origin); await restored
  await target.locator('#login-name').fill(credentials.login); await target.locator('#login-password').fill(credentials.password); await target.locator('#login-form button').click()
  await target.locator('#open-interaction').waitFor()
  return target
}
async function get(target, path) {
  const response = await target.request.get(origin + path)
  assert(response.ok(), `Readback ${path} returned ${response.status()}`)
  return response.json()
}
async function screenshot(name, target = page, { fullPage = true } = {}) {
  await target.screenshot({ path: join(directory, name + '.png'), fullPage })
  await writeFile(join(directory, name + '.txt'), await target.locator('body').innerText())
}
async function noOverflow(target) { assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflows the viewport horizontally') }
try {
  page = await createPage()
  if (config.scenario === 'readback') {
    assert(config.threadId && config.newWorkId, 'Readback requires the existing Thread and new Work IDs')
    const before = await get(page, '/api/bootstrap'), sourceBefore = config.sourceWorkId ? await get(page, '/api/works/' + encodeURIComponent(config.sourceWorkId)) : null
    await page.goto(origin + '/?view=interaction&thread=' + encodeURIComponent(config.threadId))
    const card = page.locator('[data-interaction-new-work="' + config.newWorkId + '"]'), intent = card.locator('..')
    await card.waitFor(); assert.equal(await intent.getAttribute('data-intent-state'), 'accepted')
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await card.scrollIntoViewIfNeeded()
      const copy = await intent.innerText()
      assert(copy.includes('请求已受理')); assert(copy.includes('已创建新关联工作')); assert(!/重新选择|重新定位/.test(copy), 'Accepted continuation must not display a stale routing instruction')
      assert(!copy.includes('sourceContext')); assert.equal(await card.locator('[data-open-work="' + config.newWorkId + '"]').count(), 1)
      await screenshot(viewport.width === 390 ? 'accepted-mobile-card' : 'accepted-desktop-card', page, { fullPage: false }); await noOverflow(page)
    }
    await page.locator('#interaction-text').fill('只读复核期间保留这段未提交草稿。')
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/interaction/threads/' + config.threadId) && response.request().method() === 'GET')
    await page.locator('#interaction-refresh').click(); assert.equal((await refreshed).status(), 200)
    await page.waitForFunction(() => !document.querySelector('#interaction-submit').disabled)
    assert.equal(await page.locator('#interaction-text').inputValue(), '只读复核期间保留这段未提交草稿。')
    await page.reload(); await card.waitFor(); assert(!/重新选择|重新定位/.test(await intent.innerText()))
    const after = await get(page, '/api/bootstrap'); assert.equal(after.works.length, before.works.length)
    if (sourceBefore) assert(JSON.stringify(await get(page, '/api/works/' + encodeURIComponent(config.sourceWorkId))) === JSON.stringify(sourceBefore), 'Readback changed the original Work')
    assert.deepEqual(errors, [])
    const result = { result: 'passed', directory, origin, scenario: 'readback', threadId: config.threadId, newWorkId: config.newWorkId, workCountBefore: before.works.length, workCountAfter: after.works.length, acceptedCopyConsistent: true, originalWorkUnchanged: true, draftSurvivesRefresh: true, boundary: 'existing same-final Thread/Work readback only; no SourceEvent/selection/continuation POST, no new Work or provider', pageErrors: errors }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else {
  await page.locator('#open-interaction').click(); await page.locator('#interaction-text').waitFor()
  await page.waitForFunction(() => !document.querySelector('#interaction-submit').disabled)
  if (config.scenario !== 'unconfigured') {
    await page.waitForFunction(() => document.querySelector('#interaction-policy').options.length > 1)
    const policy = config.routingPolicyId ?? await page.locator('#interaction-policy option').evaluateAll(options => options.find(option => option.value)?.value)
    await page.locator('#interaction-policy').selectOption(policy)
  } else {
    assert.equal(await page.locator('#interaction-policy option').count(), 1)
    assert.match(await page.locator('#interaction-routing-note').innerText(), /尚未配置/)
  }
  const before = await get(page, '/api/bootstrap'), countBefore = before.works.length
  await page.locator('#interaction-text').fill(config.text ?? '继续昨天那份整改表')
  await page.locator('#interaction-submit').click()
  const intent = page.locator('[data-interaction-intent]').last()
  await intent.waitFor()
  const expected = config.scenario === 'intent-question' ? ['attached', 'accepted'] : config.scenario === 'choices' ? ['routing_pending_choice', 'clarify'] : config.scenario === 'unconfigured' || config.scenario === 'proposal' ? ['routing_pending_choice', 'clarify', 'proposal'] : ['proposal']
  await page.waitForFunction(states => states.includes([...document.querySelectorAll('[data-interaction-intent]')].at(-1)?.dataset.intentState), expected)
  const threadURL = page.url(), threadId = new URL(threadURL).searchParams.get('thread')
  assert(threadId, 'Submitted request must have a persistent Thread URL')
  assert.equal((await get(page, '/api/bootstrap')).works.length, countBefore, 'Locating/proposing must not create a Work')
  for (const hiddenTitle of config.hiddenTitles ?? []) assert(!(await page.locator('#view-interaction').innerText()).includes(hiddenTitle), 'Invisible title leaked into the UI')
  await screenshot('01-located-desktop'); await noOverflow(page)
  let newWorkId = null, sourceWorkId = null, previewValues = [], staleChoiceRejected = false, intentQuestionAnswered = false
  if (config.scenario === 'choices') {
    const choices = intent.locator('[data-interaction-choice]'), initialRevision = await intent.getAttribute('data-route-revision')
    assert(await choices.count() >= 2, 'Ambiguous request must display real short choices')
    const labels = await choices.allInnerTexts()
    await page.reload(); await page.locator('[data-interaction-choice]').first().waitFor()
    assert.equal(await page.locator('[data-interaction-intent]').last().getAttribute('data-route-revision'), initialRevision)
    assert.deepEqual(await page.locator('[data-interaction-intent]').last().locator('[data-interaction-choice]').allInnerTexts(), labels)
    const second = await createPage({ width: 390, height: 844 }); await second.goto(threadURL); await second.locator('[data-interaction-choice]').first().waitFor()
    assert.equal(await second.locator('[data-interaction-intent]').last().getAttribute('data-route-revision'), initialRevision)
    assert.deepEqual(await second.locator('[data-interaction-intent]').last().locator('[data-interaction-choice]').allInnerTexts(), labels)
    await noOverflow(second); await screenshot('02-choices-mobile', second)
    if (config.staleAcrossContexts) {
      // Hold only actual GET polling. No response is fabricated and no routing/consume fact is inserted.
      let held, release; const entered = new Promise(resolve => { held = resolve }), barrier = new Promise(resolve => { release = resolve })
      await page.route('**/api/interaction/threads/' + threadId, async route => { if (route.request().method() === 'GET') { held(); await barrier } await route.continue() })
      try {
        await entered; await page.locator('#interaction-text').fill('这段未提交的草稿应保留。')
        const selected = config.choiceTitle ? second.locator('[data-interaction-choice]').filter({ hasText: config.choiceTitle }).first() : second.locator('[data-interaction-choice]').first()
        await selected.click(); await second.waitForFunction(revision => [...document.querySelectorAll('[data-interaction-intent]')].at(-1)?.dataset.routeRevision !== revision, initialRevision)
        const rejection = page.waitForResponse(response => response.url().endsWith('/selection') && response.request().method() === 'POST')
        await page.locator('[data-interaction-choice]').first().click(); assert.equal((await rejection).status(), 409); staleChoiceRejected = true
      } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
      await page.getByText('当前工作范围或请求已变化，草稿已保留。请刷新后重新定位。', { exact: true }).waitFor()
      assert.equal(await page.locator('#interaction-text').inputValue(), '这段未提交的草稿应保留。')
      await screenshot('03-stale-choice-draft')
    }
    assert.equal((await get(page, '/api/bootstrap')).works.length, countBefore)
  } else if (config.scenario === 'intent-question') {
    await page.locator('[data-interaction-answer]').first().waitFor()
    const questionId = await page.locator('[data-interaction-answer]').first().getAttribute('data-interaction-answer')
    const second = await createPage({ width: 390, height: 844 }); await second.goto(threadURL); await second.locator('[data-interaction-answer]').first().waitFor()
    assert.equal(await second.locator('[data-interaction-answer]').first().getAttribute('data-interaction-answer'), questionId)
    await screenshot('02-intent-question-mobile', second); await noOverflow(second)
    await page.locator('[data-interaction-answer]').first().click(); await page.locator('#interaction-text').fill(config.answer ?? '这次只需要整理已发布表格，不修改原现场要求。')
    const answer = page.waitForResponse(response => response.url().endsWith('/events') && response.request().method() === 'POST')
    await page.locator('#interaction-submit').click(); const response = await answer
    assert.equal(response.status(), 200)
    const body = response.request().postDataJSON()
    assert.equal(body.replyToIntentQuestion.id, questionId); assert(Number.isSafeInteger(body.replyToIntentQuestion.routeRevision)); assert.equal(body.replyToQuestion, undefined)
    await page.waitForFunction(id => !document.querySelector('[data-interaction-answer="' + id + '"]'), questionId)
    intentQuestionAnswered = true
    await page.reload(); await page.locator('[data-interaction-intent]').last().waitFor(); await screenshot('03-intent-answer-reload'); await noOverflow(page)
  } else if (!['proposal', 'unconfigured'].includes(config.scenario)) {
    const thread = await get(page, '/api/interaction/threads/' + threadId), current = thread.intents.at(-1)
    sourceWorkId = current.work.id
    const sourceBefore = await get(page, '/api/works/' + encodeURIComponent(sourceWorkId))
    if (config.sourceGoal) assert.equal(sourceBefore.goal, config.sourceGoal)
    const previewResponse = page.waitForResponse(response => response.url().includes('/artifacts/') && response.request().method() === 'GET')
    await intent.locator('[data-interaction-preview]').first().click(); assert.equal((await previewResponse).status(), 200)
    const preview = intent.locator('[data-interaction-preview-result]'); await preview.waitFor()
    assert.match(await preview.innerText(), /最多 16 个单元格，不代表全文/)
    assert(await preview.locator('tbody tr').count() <= 16)
    previewValues = await preview.locator('tbody tr td:last-child').allTextContents()
    for (const expected of config.previewValues ?? []) assert(previewValues.includes(String(expected)), 'Expected real business cell is absent from the preview')
    assert(!await intent.innerText().then(text => text.includes('sourceContext')))
    const form = intent.locator('[data-interaction-continuation]')
    await form.locator('[data-interaction-field="goal"]').fill(config.goal ?? '按当前要求继续整理整改事项')
    if (config.employeeId) await form.locator('[data-interaction-field="employeeId"]').selectOption(config.employeeId)
    if (config.budgetPolicyId) await form.locator('[data-interaction-field="budgetPolicyId"]').selectOption(config.budgetPolicyId)
    if (config.dueDate !== null && await form.locator('[data-interaction-field="dueDate"]').count()) await form.locator('[data-interaction-field="dueDate"]').fill(config.dueDate ?? '2026-11-20')
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await screenshot('02-preview-confirm-mobile')
    const created = page.waitForResponse(response => response.url().endsWith('/continuation') && response.request().method() === 'POST')
    await form.locator('[data-interaction-create]').click(); assert.equal((await created).status(), 200)
    const card = page.locator('[data-interaction-new-work]').last(); await card.waitFor(); newWorkId = await card.getAttribute('data-interaction-new-work')
    assert(newWorkId && newWorkId !== sourceWorkId)
    assert.equal((await get(page, '/api/bootstrap')).works.length, countBefore + 1)
    assert(JSON.stringify(await get(page, '/api/works/' + encodeURIComponent(sourceWorkId))) === JSON.stringify(sourceBefore), 'Original terminal Work changed')
    await page.reload(); await page.locator('[data-interaction-new-work]').waitFor(); assert.equal(await page.locator('[data-interaction-new-work]').last().getAttribute('data-interaction-new-work'), newWorkId)
    await screenshot('03-associated-work-reload-mobile'); await noOverflow(page)
  }
  assert.deepEqual(errors, [])
  const result = { result: 'passed', directory, origin, scenario: config.scenario ?? 'continuation', threadId, sourceWorkId, newWorkId, previewValues, staleChoiceRejected, intentQuestionAnswered, workCountBefore: countBefore, workCountAfter: (await get(page, '/api/bootstrap')).works.length, boundary: 'real browser and owner-started HTTP service; no routing/consume facts seeded; provider identity and native handler evidence remain owned by the backend fixture', pageErrors: errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) {
  console.error('Interaction UI boundary:', cause.message)
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
  throw cause
} finally {
  await writeFile(join(directory, 'network.json'), JSON.stringify(network, null, 2))
  for (const context of contexts) await context.close(); await browser.close()
}
