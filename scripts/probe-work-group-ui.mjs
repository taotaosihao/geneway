import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The controller owns the real service, bridge restart and both removal barriers.
const target = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password, 'Provide the owner service URL without credentials')
const origin = target.origin, config = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert(config.workId && config.employeeId, 'Provide the actual Work and employee identity')
assert(process.connected && typeof process.send === 'function', 'Run this probe with an IPC channel so the controller can advance the real barriers')
const timeoutMs = config.timeoutMs ?? 30000
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs must be a positive integer')
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-group-ui-')
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), contexts = [], errors = [], network = [], drafts = new Map()
const workPath = '/api/works/' + encodeURIComponent(config.workId), removePath = workPath + '/multisite/remove-member'
const protocolText = { pending: '协议群成员变更进行中', unknown: '协议群状态待核对' }
let desktop, mobile, before, pending, unknown, restored = null, after, submitted, receipt

function phase(name) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); process.off('message', onMessage); process.off('disconnect', onDisconnect)
      if (error) reject(error); else resolve()
    }
    const onMessage = message => {
      if (message?.kind !== 'work-group-ui-ack' || message.phase !== name) return
      finish(message.abort ? new Error('Controller aborted ' + name + ': ' + message.abort) : null)
    }
    const onDisconnect = () => finish(new Error('Controller disconnected during ' + name))
    const timer = setTimeout(() => finish(new Error('Timed out waiting for work-group-ui-ack: ' + name)), timeoutMs)
    process.on('message', onMessage); process.once('disconnect', onDisconnect)
    const value = { kind: 'work-group-ui-phase', phase: name, directory, workId: config.workId, employeeId: config.employeeId, commandId: receipt.commandId }
    console.log(JSON.stringify(value))
    try { process.send(value, error => { if (error) finish(error) }) } catch (error) { finish(error) }
  })
}
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport }); contexts.push(context)
  context.setDefaultTimeout(timeoutMs)
  const page = await context.newPage()
  page.on('pageerror', cause => errors.push(cause.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin) network.push({ method: response.request().method(), path: url.pathname, status: response.status() })
  })
  const initial = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET')
  await page.goto(origin); await initial
  await page.locator('#login-name').fill(process.env.GENEWAY_UI_LOGIN ?? 'owner')
  await page.locator('#login-password').fill(process.env.GENEWAY_UI_PASSWORD ?? 'synthetic owner password')
  await page.locator('#login-form button').click(); await page.locator('#open-interaction').waitFor()
  await page.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await page.locator('#work-members-panel').waitFor()
  return page
}
async function get(page) {
  const response = await page.request.get(origin + workPath, { timeout: timeoutMs })
  assert(response.ok(), 'Authorized Work readback failed: ' + response.status())
  return response.json()
}
function member(page) { return page.locator('[data-work-member=' + JSON.stringify(config.employeeId) + ']') }
function memberFrom(work) { return work.multisite.workMembers.find(row => row.employeeId === config.employeeId) }
async function atState(page, access, cleanup, protocol) {
  const text = protocol === 'confirmed' ? access === 'removed' ? '协议群成员移除已确认' : '协议群成员状态已确认' : protocolText[protocol]
  await page.waitForFunction(({ employeeId, access, cleanup, text }) => [...document.querySelectorAll('[data-work-member]')].some(row => row.dataset.workMember === employeeId && row.dataset.memberAccess === access && (cleanup === null || row.dataset.memberCleanup === cleanup) && row.querySelector('[data-member-protocol]')?.innerText.includes(text)), { employeeId: config.employeeId, access, cleanup, text }, { timeout: timeoutMs })
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
async function preserveDraft(page, text) {
  assert.equal(await page.locator('#multisite-answer').count(), 1, 'The real Work must expose an editable draft to verify preservation')
  await page.locator('#multisite-answer').fill(text)
  drafts.set(page, { text, dueDate: await page.locator('#multisite-answer-due').count() ? await page.locator('#multisite-answer-due').inputValue() : null, question: await page.locator('#multisite-user-question').count() ? await page.locator('#multisite-user-question').innerText() : null })
}
async function checkDraft(page) {
  const draft = drafts.get(page)
  assert.equal(await page.locator('#multisite-answer').inputValue(), draft.text, 'The unsubmitted draft must survive member updates')
  if (draft.dueDate !== null) assert.equal(await page.locator('#multisite-answer-due').inputValue(), draft.dueDate)
  assert.equal(await page.locator('#multisite-user-question').count() ? await page.locator('#multisite-user-question').innerText() : null, draft.question)
}
function checkWork(work) {
  assert.equal(work.goal, before.work.goal)
  assert.equal(work.instructionRevision, before.work.instructionRevision)
  assert.deepEqual(work.multisite.inputs, before.work.multisite.inputs, 'Member removal must preserve formal Inputs')
  assert.deepEqual(work.pendingQuestion ?? null, before.work.pendingQuestion ?? null, 'The unrelated owner question must remain unchanged')
  if (before.work.status === 'completed') assert.equal(work.status, 'completed')
  else if (before.work.status !== 'cancelled') assert.notEqual(work.status, 'cancelled', 'Local member cleanup must not cancel the entire Work')
}
async function capture(name, access, cleanup, protocol) {
  await Promise.all([atState(desktop, access, cleanup, protocol), atState(mobile, access, cleanup, protocol)])
  const work = await get(desktop), mobileWork = await get(mobile), state = await snapshot()
  for (const value of [work, mobileWork]) {
    const row = memberFrom(value)
    assert.equal(row?.access, access); assert.equal(row?.protocolGroup, protocol)
    if (cleanup !== null) assert.equal(row?.cleanup, cleanup)
    assert.equal(row?.canRemove, access === 'active')
    if (before) checkWork(value)
  }
  if (access === 'removed') {
    for (const page of [desktop, mobile]) {
      assert.equal(await member(page).locator('[data-remove-work-member]').count(), 0)
      assert((await member(page).innerText()).includes('业务访问已撤销'))
      await checkDraft(page)
    }
    if (before.state && state) {
      assert.equal(state.removals.length, before.state.removals.length + 1, 'Exactly one product member removal must be committed')
      assert.equal(state.removals.at(-1).commandId, receipt.commandId)
      assert.deepEqual(state.nodes, before.state.nodes, 'Work-local removal must not change global Node authority')
      assert.deepEqual(state.resources, before.state.resources, 'Work-local removal must not change global Resource revisions')
    }
  }
  await shot(desktop, name + '-desktop'); await shot(mobile, name + '-mobile')
  const value = { work, mobileWork, state }
  await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
  return value
}
try {
  desktop = await pageFor({ width: 1366, height: 900 }); mobile = await pageFor({ width: 390, height: 844 })
  await preserveDraft(desktop, '成员管理期间保留这段尚未提交的工作说明。'); await preserveDraft(mobile, '另一窗口保留这段尚未提交的回答。')
  before = await capture('01-before', 'active', null, 'confirmed')
  await member(desktop).locator('[data-remove-work-member]').waitFor(); await member(mobile).locator('[data-remove-work-member]').waitFor()
  const htmlResponse = await desktop.request.get(origin + '/', { timeout: timeoutMs })
  assert(htmlResponse.ok(), 'Served HTML readback failed')
  const html = await htmlResponse.body()
  await writeFile(join(directory, 'served.html'), html)
  await writeFile(join(directory, 'served-html.json'), JSON.stringify({ url: htmlResponse.url(), status: htmlResponse.status(), bytes: html.length, sha256: createHash('sha256').update(html).digest('hex') }, null, 2))
  const accepted = desktop.waitForResponse(response => response.url() === origin + removePath && response.request().method() === 'POST')
  await member(desktop).locator('[data-remove-work-member]').click(); const response = await accepted
  assert.equal(response.status(), 200)
  submitted = response.request().postDataJSON(); receipt = await response.json()
  assert.deepEqual(Object.keys(submitted).sort(), ['employeeId', 'clientRequestId'].sort())
  assert.equal(submitted.employeeId, config.employeeId); assert.equal(typeof submitted.clientRequestId, 'string'); assert(submitted.clientRequestId)
  assert.equal(receipt.workId, config.workId); assert.equal(receipt.employeeId, config.employeeId); assert.equal(receipt.access, 'removed'); assert(receipt.commandId)
  await writeFile(join(directory, 'removal.json'), JSON.stringify({ submitted, receipt }, null, 2))
  pending = await capture('02-protocol-pending', 'removed', 'stopping', 'pending')
  await phase('protocol-pending')
  unknown = await capture('03-protocol-unknown', 'removed', 'stopping', 'unknown')
  await phase('protocol-unknown')
  if (config.observeRestoredPending !== false) {
    restored = await capture('04-protocol-pending-restored', 'removed', 'stopping', 'pending')
    await phase('protocol-pending-restored')
  }
  after = await capture('05-protocol-confirmed', 'removed', 'stopped', 'confirmed')
  for (const page of [desktop, mobile]) assert((await member(page).locator('[data-member-protocol]').innerText()).includes('协议群成员移除已确认'))
  assert.equal(network.filter(row => row.method === 'POST' && row.path === removePath).length, 1, 'Exactly one real remove POST must be submitted')
  assert.deepEqual(errors, [])
  const result = { kind: 'work-group-ui-result', result: 'passed', directory, origin, workId: config.workId, employeeId: config.employeeId, before, pending, unknown, restored, after, submitted, receipt, network, errors, preservedDraftContexts: drafts.size, storeChecked: !!config.stateFile }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result)); if (process.connected) process.send(result)
} catch (error) {
  console.error('Work-group UI boundary:', error.message)
  if (desktop && !desktop.isClosed()) await shot(desktop, 'failure-desktop').catch(() => {})
  if (mobile && !mobile.isClosed()) await shot(mobile, 'failure-mobile').catch(() => {})
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ result: 'failed', error: error.message, before, pending, unknown, restored, after, submitted, receipt, network, errors }, null, 2))
  throw error
} finally {
  try { await writeFile(join(directory, 'network.json'), JSON.stringify(network, null, 2)) }
  finally { await Promise.allSettled(contexts.map(context => context.close())); await browser.close() }
}
