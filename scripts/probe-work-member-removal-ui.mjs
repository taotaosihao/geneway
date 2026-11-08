import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The owner starts the real service and, when needed, holds the actual Host
// cleanup barrier until both browser contexts have observed the pending state.
const target = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password, 'Provide the owner service URL without credentials')
const origin = target.origin, config = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert(config.workId && config.employeeId, 'Provide the actual Work and employee identity')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-member-removal-ui-')
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), contexts = [], errors = [], network = []
const workPath = '/api/works/' + encodeURIComponent(config.workId)
let desktop, mobile
function phase(name, detail = {}) {
  const value = { kind: 'work-member-ui-phase', phase: name, directory, ...detail }
  console.log(JSON.stringify(value)); if (process.connected) process.send(value)
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
  await page.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await page.locator('#work-members-panel').waitFor()
  return page
}
async function get(page) { const response = await page.request.get(origin + workPath); assert(response.ok(), 'Authorized Work readback failed: ' + response.status()); return response.json() }
function member(page) { return page.locator('[data-work-member="' + config.employeeId + '"]') }
async function atState(page, access, cleanup) {
  await page.waitForFunction(({ employeeId, access, cleanup }) => [...document.querySelectorAll('[data-work-member]')].some(row => row.dataset.workMember === employeeId && row.dataset.memberAccess === access && row.dataset.memberCleanup === cleanup), { employeeId: config.employeeId, access, cleanup })
}
async function shot(page, name) {
  await member(page).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false })
  await writeFile(join(directory, name + '.txt'), await page.locator('body').innerText())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal viewport overflow')
}
async function snapshot() {
  if (!config.stateFile) return null
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
  return {
    removals: (state.workMemberRemovals ?? []).filter(row => row.workId === config.workId && row.employeeId === config.employeeId),
    nodes: state.nodes.map(row => ({ id: row.id, registrationRevision: row.registrationRevision, credentialVersion: row.credentialVersion, status: row.status })),
    resources: state.resources.map(row => ({ id: row.id, revision: row.revision, enabled: row.enabled })),
  }
}
const drafts = new Map()
async function preserveDraft(page, text) {
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
try {
  phase('browser-started', { workId: config.workId, employeeId: config.employeeId })
  desktop = await pageFor({ width: 1366, height: 900 }); mobile = await pageFor({ width: 390, height: 844 })
  const before = await get(desktop), beforeMember = before.multisite.workMembers.find(row => row.employeeId === config.employeeId), beforeState = await snapshot()
  assert(beforeMember?.canRemove && beforeMember.access === 'active', 'The real owner must currently be allowed to remove this participating employee')
  assert.equal(beforeMember.protocolGroup, 'not_applicable')
  await member(desktop).locator('[data-remove-work-member]').waitFor(); await member(mobile).locator('[data-remove-work-member]').waitFor()
  await preserveDraft(desktop, '成员管理期间保留这段尚未提交的工作说明。'); await preserveDraft(mobile, '另一窗口保留这段尚未提交的回答。')
  await shot(desktop, '01-before-desktop'); await shot(mobile, '02-before-mobile')
  const accepted = desktop.waitForResponse(response => response.url() === origin + workPath + '/multisite/remove-member' && response.request().method() === 'POST')
  await member(desktop).locator('[data-remove-work-member]').click(); const response = await accepted
  assert.equal(response.status(), 200)
  const submitted = response.request().postDataJSON(), receipt = await response.json()
  assert.deepEqual(Object.keys(submitted).sort(), ['employeeId', 'clientRequestId'].sort()); assert.equal(submitted.employeeId, config.employeeId)
  assert.equal(receipt.workId, config.workId); assert.equal(receipt.employeeId, config.employeeId); assert.equal(receipt.access, 'removed')
  let pending = null
  if (config.requireStopping !== false) {
    await atState(desktop, 'removed', 'stopping'); await atState(mobile, 'removed', 'stopping')
    pending = await get(desktop); const row = pending.multisite.workMembers.find(row => row.employeeId === config.employeeId)
    assert.equal(row.access, 'removed'); assert.equal(row.cleanup, 'stopping'); assert.equal(row.protocolGroup, 'not_applicable'); assert.equal(row.canRemove, false)
    assert((await member(desktop).innerText()).includes('业务访问已撤销')); assert((await member(desktop).innerText()).includes('执行停止待确认'))
    await checkDraft(desktop); await checkDraft(mobile)
    await shot(desktop, '03-access-revoked-stop-pending-desktop'); await shot(mobile, '04-access-revoked-stop-pending-mobile')
    await writeFile(join(directory, 'pending.json'), JSON.stringify({ submitted, receipt, work: pending }, null, 2))
    phase('member-removal-stopping-observed', { workId: config.workId, employeeId: config.employeeId, commandId: receipt.commandId })
  }
  const expectedCleanup = config.expectedCleanup ?? 'stopped'
  await atState(desktop, 'removed', expectedCleanup); await atState(mobile, 'removed', expectedCleanup)
  const after = await get(desktop), afterMember = after.multisite.workMembers.find(row => row.employeeId === config.employeeId), afterState = await snapshot()
  assert.equal(afterMember.access, 'removed'); assert.equal(afterMember.cleanup, expectedCleanup); assert.equal(afterMember.canRemove, false); assert.equal(afterMember.protocolGroup, 'not_applicable')
  assert.equal(after.goal, before.goal); assert.equal(after.instructionRevision, before.instructionRevision)
  assert.equal(after.multisite.inputs.length, before.multisite.inputs.length, 'Member removal must not create a formal Input')
  assert.equal(after.pendingQuestion?.id ?? null, before.pendingQuestion?.id ?? null, 'The unrelated owner question must remain unchanged')
  if (before.status === 'completed') assert.equal(after.status, 'completed', 'Member cleanup must retain the completed Work')
  else if (before.status !== 'cancelled') assert.notEqual(after.status, 'cancelled', 'Local member cleanup must not cancel the entire Work')
  assert.equal(await member(desktop).locator('[data-remove-work-member]').count(), 0); assert.equal(await member(mobile).locator('[data-remove-work-member]').count(), 0)
  assert((await member(desktop).locator('[data-member-protocol]').innerText()).includes('不适用'))
  await checkDraft(desktop); await checkDraft(mobile)
  if (beforeState && afterState) {
    assert.equal(afterState.removals.length, beforeState.removals.length + 1)
    assert.deepEqual(afterState.nodes, beforeState.nodes, 'Work-local removal must not change global Node authority')
    assert.deepEqual(afterState.resources, beforeState.resources, 'Work-local removal must not change global Resource revisions')
  }
  await shot(desktop, '05-cleanup-confirmed-desktop'); await shot(mobile, '06-cleanup-confirmed-mobile')
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'readback.json'), JSON.stringify({ before, pending, after, submitted, receipt, beforeState, afterState }, null, 2))
  const result = { result: 'passed', directory, origin, workId: config.workId, employeeId: config.employeeId, pendingObserved: !!pending, cleanup: expectedCleanup, preservedDraftContexts: drafts.size, formalInputUnchanged: true, protocolGroup: afterMember.protocolGroup, boundary: 'actual authorized owner Web removal and current server projections; owner separately supplies process/stop/exact-ACK evidence; no service/Host/provider started or backend facts inserted', pageErrors: errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); phase('browser-completed')
} catch (error) {
  console.error('Work-member UI boundary:', error.message)
  if (desktop && !desktop.isClosed()) await shot(desktop, 'failure-desktop').catch(() => {})
  if (mobile && !mobile.isClosed()) await shot(mobile, 'failure-mobile').catch(() => {})
  throw error
} finally {
  await writeFile(join(directory, 'network.json'), JSON.stringify(network, null, 2))
  for (const context of contexts) await context.close(); await browser.close()
}
