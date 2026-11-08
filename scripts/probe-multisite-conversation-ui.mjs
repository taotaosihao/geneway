import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
const source = resolve(process.argv[2]), directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/conversation-ui-'), api = join(directory, 'api')
await mkdir(api); for (const name of ['state.json', 'auth.json']) await cp(join(source, 'api', name), join(api, name))
await cp(join(source, 'api/evidence'), join(api, 'evidence'), { recursive: true })
const original = JSON.parse(await readFile(join(api, 'state.json'))), work = original.works.find(row => row.workType === 'multisite'), expected = original.multisite.messages.filter(row => row.workId === work.id && ['observation', 'question', 'answer', 'question_closed'].includes(row.kind)).slice(-100)
assert(expected.length > 0)
const fixture = await startBridgeService({ directory: api, index: await readFile('web/index.html', 'utf8') }); let browser
try {
  const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }), errors = []; page.on('pageerror', cause => errors.push(cause.message))
  await page.goto(fixture.origin); await page.locator('#login-name').fill('owner'); await page.locator('#login-password').fill('synthetic owner password'); await page.locator('#login-form button').click(); await page.locator('#work-mode').waitFor()
  await page.goto(fixture.origin + '?work=' + encodeURIComponent(work.id)); await page.locator('[data-agent-history]').waitFor()
  const detail = await page.locator('[data-agent-history]').innerText(); assert.equal(await page.locator('[data-agent-history] .record').count(), expected.length)
  for (const row of expected) assert(detail.includes(row.text))
  assert(!detail.includes('senderBinding')); assert(!detail.includes('controlConsumedAt')); assert(!detail.includes('nodeInstanceId'))
  if (expected.some(row => row.kind === 'question_closed')) { assert(detail.includes('系统关闭通知')); assert(detail.includes('关闭通知已送达')) }
  await page.locator('[data-agent-history]').evaluate(element => element.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true }); await page.reload(); await page.locator('[data-agent-history]').waitFor(); assert.equal(await page.locator('[data-agent-history]').innerText(), detail)
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-agent-history]').evaluate(element => element.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); assert.deepEqual(errors, [])
  const after = await fixture.store.read(); assert.deepEqual(after.modelRequests, original.modelRequests); assert.deepEqual(after.multisite.questions, original.multisite.questions); assert.deepEqual(after.evidenceAccessReceipts, original.evidenceAccessReceipts)
  const result = { result: 'passed', directory, source, workId: work.id, boundary: 'actual browser/HTTP finite Work history projection from copied original producer facts; no Host/model/new Work', visibleMessages: expected.length, reloadStable: true, mobileNoHorizontalOverflow: true, immutableBusinessFactsUnchanged: true, pageErrors: errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close(); await fixture.close() }
