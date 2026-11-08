import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A running, owner-controlled native fixture supplies the real request/idle barriers.
const baseURL = new URL(process.argv[2] ?? process.env.GENEWAY_UI_BASE_URL ?? '')
assert(['http:', 'https:'].includes(baseURL.protocol) && !baseURL.username && !baseURL.password, 'Provide the owner URL without credentials')
const origin = baseURL.origin
const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
assert(config.workId && config.threadId, 'Provide the real Work and attributed Thread IDs')
const scopes = config.pauseScopes ?? [config.scope ?? { kind: 'work' }], resumes = config.resumeScopes ?? scopes
const scopeKey = scope => scope.kind === 'work' ? 'work' : 'agent:' + scope.agentId
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-control-ui-')
const credentials = { login: process.env.GENEWAY_UI_LOGIN ?? 'owner', password: process.env.GENEWAY_UI_PASSWORD ?? 'synthetic owner password' }
const { chromium } = await import(process.env.GENEWAY_PLAYWRIGHT_MODULE ?? '/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ headless: true }), contexts = [], errors = [], network = [], stages = []
let desktop, mobile, draftChecked = false
function phase(name, detail = {}) {
  const value = { kind: 'manual-ui-phase', phase: name, ...detail }
  console.log(JSON.stringify(value)); if (process.connected) process.send(value)
}
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport }); contexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', cause => errors.push(cause.message))
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }) })
  const initial = page.waitForResponse(response => response.url() === origin + '/api/session' && response.request().method() === 'GET')
  await page.goto(origin); await initial
  await page.locator('#login-name').fill(credentials.login); await page.locator('#login-password').fill(credentials.password); await page.locator('#login-form button').click()
  await page.locator('#open-interaction').waitFor()
  return page
}
async function get(page, path) { const response = await page.request.get(origin + path); assert(response.ok(), 'Authorized readback failed: ' + response.status()); return response.json() }
function control(page, scope) { return page.locator('[data-manual-scope]').filter({ has: page.locator('[data-manual-pause="' + scopeKey(scope) + '"]') }) }
async function atStage(page, scope, expected) {
  await page.waitForFunction(({ key, expected }) => [...document.querySelectorAll('[data-manual-scope]')].some(row => row.dataset.manualScope === key && row.dataset.manualStage === expected), { key: scopeKey(scope), expected })
  return control(page, scope)
}
async function shot(page, name, target) {
  await target?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false })
  await writeFile(join(directory, name + '.txt'), await page.locator('body').innerText())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal viewport overflow')
}
async function snapshot(intentId) {
  if (!config.stateFile) return null
  const state = JSON.parse(await readFile(config.stateFile, 'utf8')), work = state.works.find(work => work.id === config.workId)
  const agents = scopes.some(scope => scope.kind === 'work') ? null : new Set(scopes.map(scope => scope.agentId))
  const attempts = state.multisite.attempts.filter(row => row.work_id === config.workId && (!agents || agents.has(row.agent_id)))
  const parents = new Set(attempts.map(row => row.delegation_id)), intents = new Set((state.workIntents ?? []).filter(row => row.workId === config.workId && row.threadId === config.threadId).map(row => row.id))
  return {
    executionReservations: state.modelRequests.filter(row => row.work_id === config.workId && (!agents || agents.has(row.agent_id))).length,
    routingReservations: state.modelRequests.filter(row => row.purpose === 'routing' && row.threadId === config.threadId).length,
    jobs: state.multisite.jobs.filter(row => row.work_id === config.workId && (!agents || agents.has(row.agent_id))).length,
    delegations: state.multisite.delegations.filter(row => row.workId === config.workId && (!agents || parents.has(row.parentDelegationId))).length,
    questionStates: [...(state.multisite.questions ?? []).filter(row => row.workId === config.workId && row.state === 'open').map(row => ({ kind: 'agent', id: row.id, state: row.state })), ...(state.userQuestions ?? []).filter(row => row.workId === config.workId && row.state === 'open').map(row => ({ kind: 'user', id: row.id, state: row.state })), ...(state.intentQuestions ?? []).filter(row => intents.has(row.intentId) && row.state === 'open').map(row => ({ kind: 'intent', id: row.id, state: row.state }))],
    instructionRevision: work.instructionRevision,
    resumeCommands: [...new Set((state.manualControls ?? []).filter(row => row.workId === config.workId).flatMap(row => row.holders.map(holder => holder.resumeCommandId).filter(Boolean)))].sort(),
    pendingIntent: intentId ? (() => { const intent = state.workIntents.find(row => row.id === intentId), subscription = state.contextSubscriptions.find(row => row.id === intent?.handlerSubscriptionId); return { id: intent?.id, state: intent?.state, acceptedInputId: intent?.acceptedInputId ?? null, subscriptionId: subscription?.id, ingestedAt: subscription?.ingestedAt ?? null } })() : null,
    attempts: attempts.map(row => ({ attemptId: row.attempt_id, sessionId: row.session_id, launchId: row.launch_id, executionEpoch: row.execution_epoch })),
  }
}
try {
  phase('browser-started', { directory })
  desktop = await pageFor({ width: 1366, height: 900 })
  await desktop.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await desktop.locator('#manual-control-panel').waitFor()
  const before = await get(desktop, '/api/works/' + encodeURIComponent(config.workId))
  if (await desktop.locator('#multisite-answer').count()) await desktop.locator('#multisite-answer').fill('人工控制期间保留这段尚未提交的工作草稿。')
  mobile = await pageFor({ width: 390, height: 844 }); await mobile.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await mobile.locator('#manual-control-panel').waitFor()
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index], row = control(desktop, scope), generation = Number(await row.getAttribute('data-manual-generation'))
    const accepted = desktop.waitForResponse(response => response.url().endsWith('/multisite/pause') && response.request().method() === 'POST')
    await row.locator('[data-manual-pause]').click(); const response = await accepted; assert.equal(response.status(), 200)
    const reply = await response.json(); assert(reply.accepted); assert.equal(reply.controlGeneration, generation + 1)
    if (index === 0 && config.requirePausing !== false) {
      assert.equal(reply.stage, 'pausing')
      await atStage(desktop, scope, 'pausing'); await atStage(mobile, scope, 'pausing')
      await shot(desktop, '01-pausing-desktop', control(desktop, scope)); await shot(mobile, '02-pausing-second-context', control(mobile, scope))
      phase('pausing-observed', { scope, controlGeneration: reply.controlGeneration })
    }
    await atStage(desktop, scope, 'paused'); await atStage(mobile, scope, 'paused')
    assert((await control(desktop, scope).innerText()).includes('已暂停'))
    stages.push({ scope, pausedGeneration: Number(await control(desktop, scope).getAttribute('data-manual-generation')) })
  }
  await shot(desktop, '03-paused-desktop', desktop.locator('#manual-control-panel'))
  if (await desktop.locator('#multisite-answer').count()) { assert.equal(await desktop.locator('#multisite-answer').inputValue(), '人工控制期间保留这段尚未提交的工作草稿。'); draftChecked = true }
  assert.equal((await get(desktop, '/api/works/' + encodeURIComponent(config.workId))).instructionRevision, before.instructionRevision, 'Pause must not become a business Input')
  const idle = await snapshot(); if (config.requireOpenQuestions) assert(idle?.questionStates.length > 0, 'Native fixture must provide a real open question'); phase('paused-observed', { scopes })
  await mobile.goto(origin + '/?view=interaction&thread=' + encodeURIComponent(config.threadId)); await mobile.locator('#interaction-text').waitFor()
  await mobile.waitForFunction(() => !document.querySelector('#interaction-submit').disabled)
  const text = config.text ?? '人工暂停期间保存的合法请求，请在解除后由原处理者核对。'
  await mobile.locator('#interaction-text').fill(text)
  const saved = mobile.waitForResponse(response => response.url().endsWith('/events') && response.request().method() === 'POST')
  await mobile.locator('#interaction-submit').click(); const savedResponse = await saved; assert.equal(savedResponse.status(), 200)
  const savedReply = await savedResponse.json(), intentId = savedReply.intentId
  assert.equal(typeof intentId, 'string'); assert(intentId.length > 0)
  const pending = mobile.locator('[data-interaction-intent="' + intentId + '"]'); await pending.locator('[data-manual-wait]').waitFor()
  const thread = await get(mobile, '/api/interaction/threads/' + encodeURIComponent(config.threadId)), savedIntent = thread.intents.find(intent => intent.id === intentId)
  assert.equal(savedIntent?.sourceEventId, savedReply.eventId)
  assert.equal(thread.events.find(event => event.id === savedReply.eventId)?.text, text)
  await pending.getByText(text, { exact: true }).waitFor()
  const routeRevision = await pending.getAttribute('data-route-revision')
  assert((await pending.innerText()).includes(text)); await shot(mobile, '04-message-saved-during-pause', pending)
  await mobile.reload(); await mobile.locator('[data-interaction-intent="' + intentId + '"] [data-manual-wait]').waitFor()
  assert.equal(await mobile.locator('[data-interaction-intent="' + intentId + '"]').getAttribute('data-route-revision'), routeRevision)
  const queued = await snapshot(intentId)
  if (idle && queued) {
    for (const field of ['executionReservations', 'routingReservations', 'jobs', 'delegations', 'instructionRevision']) assert.equal(queued[field], idle[field], 'Queued Source must not advance ' + field)
    assert(JSON.stringify(queued.questionStates) === JSON.stringify(idle.questionStates), 'Manual pause must retain open business questions')
  }
  phase('message-saved', { intentId, scopes })
  await mobile.goto(origin + '/?work=' + encodeURIComponent(config.workId)); await mobile.locator('#manual-control-panel').waitFor()
  for (const scope of resumes) {
    const row = control(mobile, scope), generation = Number(await row.getAttribute('data-manual-generation'))
    const released = mobile.waitForResponse(response => response.url().endsWith('/multisite/resume') && response.request().method() === 'POST')
    await row.locator('[data-manual-resume]').click(); const response = await released; assert.equal(response.status(), 200)
    const reply = await response.json(); assert(reply.released); assert.equal(reply.controlGeneration, generation + 1)
    await atStage(mobile, scope, 'released'); assert((await control(mobile, scope).innerText()).includes('人工暂停已解除'))
    phase('resume-requested', { scope, controlGeneration: reply.controlGeneration, canWake: reply.canWake, blockedReasons: reply.blockedReasons })
    const remainingAgent = scope.kind === 'work' && resumes.slice(resumes.indexOf(scope) + 1).find(candidate => candidate.kind === 'agent')
    if (remainingAgent) {
      assert(config.stateFile && queued, 'Overlap evidence requires the owner state file')
      const releasedWorkAndPausedAgent = work => {
        const controls = work.multisite.manualControls, released = controls.find(row => row.scope.kind === 'work'), paused = controls.find(row => scopeKey(row.scope) === scopeKey(remainingAgent))
        return released?.generation === 2 && released.stage === 'released' && released.holders.length > 0 && released.holders.every(holder => holder.released) && paused?.generation === 1 && paused.stage === 'paused' && paused.holders.length > 0 && paused.holders.every(holder => holder.idleConfirmed && !holder.released)
      }
      const workPath = '/api/works/' + encodeURIComponent(config.workId), deadline = Date.now() + 30000
      while (!releasedWorkAndPausedAgent(await get(mobile, workPath))) {
        assert(Date.now() < deadline, 'Work holders did not release while Agent remained safely paused')
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      const work = await get(mobile, workPath)
      assert(releasedWorkAndPausedAgent(work), 'Fresh Work readback must retain the complete overlap window')
      const workControl = work.multisite.manualControls.find(row => row.scope.kind === 'work'), agentControl = work.multisite.manualControls.find(row => scopeKey(row.scope) === scopeKey(remainingAgent))
      assert.equal(workControl.canWake, false); assert.equal(agentControl.canWake, false)
      assert(workControl.blockedReasons.includes('MANUALLY_PAUSED'))
      assert(workControl.otherScopes.some(row => scopeKey(row.scope) === scopeKey(remainingAgent) && row.generation === 1 && row.stage === 'paused'))
      const waiting = await get(mobile, '/api/interaction/threads/' + encodeURIComponent(config.threadId)), heldIntent = waiting.intents.find(row => row.id === intentId)
      assert(heldIntent?.manualWait?.scopes.some(row => scopeKey(row.scope) === scopeKey(remainingAgent) && row.generation === 1))
      assert.equal(heldIntent.acceptedInputId, null)
      const overlap = await snapshot(intentId)
      for (const field of ['executionReservations', 'routingReservations', 'jobs', 'delegations', 'instructionRevision']) assert.equal(overlap[field], queued[field], 'Agent pause must still block ' + field)
      assert.deepEqual(overlap.resumeCommands, queued.resumeCommands, 'Work release must not queue a resume while Agent remains paused')
      assert.deepEqual(overlap.pendingIntent, queued.pendingIntent, 'Work release must not consume the pending Source')
      assert.equal(overlap.pendingIntent.ingestedAt, null)
      await writeFile(join(directory, 'work-released-agent-paused.json'), JSON.stringify({ work, intent: heldIntent, snapshot: overlap }, null, 2))
      for (const [page, name] of [[desktop, 'desktop'], [mobile, 'mobile']]) {
        await atStage(page, scope, 'released'); await atStage(page, remainingAgent, 'paused')
        for (const [currentScope, suffix, confirmation] of [[scope, 'work', '解除人工暂停已确认'], [remainingAgent, 'agent', '已确认安全点']]) {
          await page.waitForFunction(({ key, text }) => [...document.querySelectorAll('[data-manual-scope]')].find(row => row.dataset.manualScope === key)?.querySelector('details')?.textContent.includes(text), { key: scopeKey(currentScope), text: confirmation })
          const details = control(page, currentScope).locator('details')
          if (!await details.evaluate(node => node.open)) await details.locator('summary').click()
          await details.getByText(confirmation).first().waitFor()
          await shot(page, '05-overlap-' + name + '-' + suffix, control(page, currentScope))
        }
      }
      const captured = process.connected ? new Promise((resolve, reject) => {
        const listener = message => { if (message.kind === 'manual-ui-ack' && message.phase === 'work-released-agent-paused') { clearTimeout(timer); process.off('message', listener); resolve() } }
        const timer = setTimeout(() => { process.off('message', listener); reject(new Error('Owner did not acknowledge the overlap Store snapshot')) }, 30000)
        process.on('message', listener)
      }) : null
      phase('work-released-agent-paused', { workId: config.workId, intentId, workGeneration: workControl.generation, agentScope: remainingAgent, agentGeneration: agentControl.generation, directory })
      if (captured) await captured
    }
  }
  await shot(mobile, '05-manual-released-mobile', mobile.locator('#manual-control-panel'))
  if (config.expectedBlockedReason) { const current = await get(mobile, '/api/works/' + encodeURIComponent(config.workId)); assert(current.multisite.manualControls.some(row => row.stage === 'released' && row.blockedReasons.includes(config.expectedBlockedReason)), 'Release must retain the other blocking reason'); if (config.expectedBlockedText) assert((await mobile.locator('#manual-control-panel').innerText()).includes(config.expectedBlockedText)) }
  await mobile.goto(origin + '/?view=interaction&thread=' + encodeURIComponent(config.threadId)); await mobile.locator('[data-interaction-intent="' + intentId + '"]').waitFor()
  await mobile.waitForFunction(({ id, expected }) => document.querySelector('[data-interaction-intent="' + id + '"]')?.dataset.intentState === expected && !document.querySelector('[data-interaction-intent="' + id + '"] [data-manual-wait]'), { id: intentId, expected: config.expectedAfterResumeIntentState ?? 'accepted' })
  await shot(mobile, '06-original-intent-after-release', mobile.locator('[data-interaction-intent="' + intentId + '"]'))
  const final = await snapshot()
  if (idle && final) for (const original of idle.attempts) assert(final.attempts.some(current => JSON.stringify(current) === JSON.stringify(original)), 'Resume must retain the original Attempt/Session')
  assert.deepEqual(errors, [])
  const result = { result: 'passed', directory, origin, workId: config.workId, threadId: config.threadId, intentId, scopes, resumes, stages, idle, queued, final, originalDraftPreserved: draftChecked ? true : null, bodySavedDuringPause: true, sameIntentAfterExplicitRelease: true, boundary: 'real browser against owner native fixture; no service/provider/Host started or routing/consume facts inserted; owner retains raw provider/control/idle proofs', pageErrors: errors }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); phase('browser-completed', { directory, workId: config.workId, intentId })
} catch (cause) {
  console.error('Manual UI boundary:', cause.message)
  if (desktop && !desktop.isClosed()) await shot(desktop, 'failure-desktop').catch(() => {})
  if (mobile && !mobile.isClosed()) await shot(mobile, 'failure-mobile').catch(() => {})
  throw cause
} finally {
  await writeFile(join(directory, 'network.json'), JSON.stringify(network, null, 2))
  for (const context of contexts) await context.close(); await browser.close()
}
