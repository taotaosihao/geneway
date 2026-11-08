import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { startBridgeService } from './fixtures/multisite/bridge-service.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-collaboration-native-os4rmP', directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-'), bodies = [], observations = [], pages = [], parameters = []
const crossWindowUi = process.argv.includes('--cross-window-ui'), crossWindow = process.argv.includes('--cross-window') || crossWindowUi
let fixture, provider, host, upstreamBarrier, uiDriver, uiExit
try {
  const original = JSON.parse(await readFile(join(sourceRoot, 'api/state.json'))), sourceWork = original.works.find(row => row.status === 'completed')
  provider = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(200, { 'content-type': 'text/event-stream' }); if (upstreamBarrier) { const barrier = upstreamBarrier; upstreamBarrier = undefined; response.write('data: {"choices":[{"delta":{"content":"请求在途"}}]}\n\n'); barrier.reached(); await barrier.release; response.end(); return }; response.end('data: {"choices":[{"delta":{"content":"读取当前获准历史资料"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), ...(crossWindowUi ? { index: await readFile('web/index.html', 'utf8') } : {}), seedState: state => Object.assign(state, structuredClone(original)), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); await cp(join(sourceRoot, 'api/artifacts'), join(directory, 'api/artifacts'), { recursive: true }); await cp(join(sourceRoot, 'api/evidence'), join(directory, 'api/evidence'), { recursive: true }); await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-context-fixture', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body, method = 'POST', expected = 200) { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json(); observations.push({ path, method, status: response.status, value }); assert.equal(response.status, expected, JSON.stringify(value)); return value }
  const identity = JSON.parse(await readFile(join(sourceRoot, 'cloud/node-identity.json'))), client = createRemoteClient({ origin: fixture.origin, identity }), journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ call: (...args) => client.command(...args), event: event => client.event(event) })
  async function pump() { for (let turn = 0; turn < 3; turn++) { for (const pending of (await client.resync()).pending) { const command = await client.resolveCommand(pending); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) } }
  const route = original.modelRoutes.find(row => row.enabled), budget = { clientRequestId: 'context-policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 64, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await api('/api/admin/budget-policies/context-reader', budget, 'PUT')
  const thread = await api('/api/interaction/threads', { clientRequestId: 'context-thread' }), proposal = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'source', sourceEventId: 'source', version: 1, expectedThreadRevision: 1, text: '明确回看原多来源成果的真实资料，再核对后续安排。', workId: sourceWork.id }), preview = await api(`/api/interaction/threads/${thread.id}/artifacts/${proposal.intentId}/${sourceWork.artifactRefs[0].artifactId}`, undefined, 'GET')
  const continued = await api(`/api/interaction/threads/${thread.id}/continuation`, { clientRequestId: 'new-reader', intentId: proposal.intentId, expectedRouteRevision: proposal.routeRevision, employeeId: 'coordinator', budgetPolicyId: 'context-reader', goal: '核对原多来源成果及其历史证据，不生成文件。', artifactReadId: preview.id }); await pump()
  const before = await fixture.store.read(), attempt = before.multisite.attempts.find(row => row.work_id === continued.workId), execution = binding(attempt), input = before.multisite.inputs.find(row => row.workId === continued.workId), inputMessageId = messageId(input.id, execution.attempt_id, execution.session_id)
  async function forward(kind = 'exact') {
    const issued = await client.issue(execution, { request: true, inputMessageId }); assert(issued.contextReadEnabled); assert(issued.modelStep)
    const messages = [{ role: 'user', content: input.text }]
    pages.forEach((page, index) => { const id = 'context-call-' + index; messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'geneway_read_context', arguments: JSON.stringify(parameters[index]) } }] }, { role: 'tool', tool_call_id: id, content: JSON.stringify(kind === 'hash' ? { readId: page.readId, pageDigest: digest(page) } : kind === 'altered' ? { ...page, items: [{ text: '替换正文' }] } : page) }) })
    const response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: true, max_tokens: 64, messages, tools: [{ type: 'function', function: { name: 'geneway_read_context', parameters: { type: 'object', properties: {} } } }] }) }); assert.equal(response.status, 200, await response.text()); return issued.modelStep
  }
  const metadata = await client.issue(execution); assert(!metadata.modelStep)
  await assert.rejects(client.context.read(execution, { clientRequestId: 'not-issued', view: 'content' }, { requestId: 'not-reserved', inputMessageId, manualFence: metadata.manualFence }), { code: 'CONTEXT_READ_UNAVAILABLE' })
  let modelStep = await forward(), sequence = 0
  async function readObject(objectRef, view = 'content') {
    const result = []; let cursor
    do { const args = { clientRequestId: 'read-' + ++sequence, ...(objectRef ? { objectRef } : {}), view, ...(cursor ? { cursor } : {}) }, page = await client.context.read(execution, args, modelStep); assert(page.bytes <= 16384); assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page))); pages.push(page); parameters.push(args); result.push(page); cursor = page.nextCursor; if (page.partial && !cursor) throw Error('Unexpected sample requires a new human window before ' + JSON.stringify(page.objectRef)) } while (cursor)
    return result
  }
  if (process.argv.includes('--metadata-exhaustion') || process.argv.includes('--metadata-byte-exhaustion') || crossWindow) {
    const byteBoundary = process.argv.includes('--metadata-byte-exhaustion') || crossWindow; let rootPage, workPage
    const uiPhases = []; let waitingUi, uiClosed = false
    async function uiApproval(slot) {
      if (!uiDriver) {
        const config = join(directory, 'cross-window-ui-config.json'), stdout = [], stderr = []
        await writeFile(config, JSON.stringify({ threadId: thread.id, readId: workPage.readId, scenario: 'ordinary', relationPending: true, repeatSlot: true, stateFile: join(directory, 'api/state.json') }))
        uiDriver = fork(fileURLToPath(new URL('./probe-context-read-ui.mjs', import.meta.url)), [fixture.origin, config], { cwd: process.cwd(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); uiDriver.stdout.on('data', value => stdout.push(value)); uiDriver.stderr.on('data', value => stderr.push(value))
        uiDriver.on('message', message => { if (message.kind === 'context-read-ui-phase' && message.phase === 'human-continue-accepted') { if (waitingUi) { const waiting = waitingUi; waitingUi = null; waiting.resolve(message) } else uiPhases.push(message) } })
        uiExit = new Promise(resolve => uiDriver.once('exit', async code => { uiClosed = true; waitingUi?.reject(Error('UI exited before its next approval phase: ' + code)); await writeFile(join(directory, 'cross-window-ui.stdout.log'), Buffer.concat(stdout)); await writeFile(join(directory, 'cross-window-ui.stderr.log'), Buffer.concat(stderr)); resolve(code) }))
      } else uiDriver.send({ kind: 'context-read-ui-ack', phase: 'human-continue-accepted' })
      const phase = uiPhases.shift() ?? await new Promise((resolve, reject) => { if (uiClosed) reject(Error('UI already exited')); else waitingUi = { resolve, reject } })
      await writeFile(join(directory, 'cross-window-ui-phase-' + slot + '.json'), JSON.stringify({ phase, state: await fixture.store.read() }, null, 2))
      return JSON.parse(await readFile(join(phase.directory, slot === 1 ? 'approval.json' : 'second-approval.json')))
    }
    if (!byteBoundary) {
      for (let index = 0; index < 32; index++) rootPage = await client.context.read(execution, { clientRequestId: 'complete-root-' + index, view: 'content' }, modelStep)
      for (let index = 0; index < 32; index++) workPage = await client.context.read(execution, { clientRequestId: 'complete-work-' + index, objectRef: rootPage.nextRefs[0].objectRef, view: 'content' }, modelStep)
    } else {
      rootPage = (await readObject())[0]; const work = (await readObject(rootPage.nextRefs[0].objectRef))[0], artifact = await readObject(work.nextRefs[0].objectRef), jobRef = artifact.flatMap(page => page.nextRefs)[0].objectRef
      for (let index = 0; index < 6; index++) await client.context.read(execution, { clientRequestId: 'artifact-reread-' + index, objectRef: work.nextRefs[0].objectRef, view: 'content' }, modelStep)
      for (let index = 0; index < 19; index++) workPage = await client.context.read(execution, { clientRequestId: 'manifest-reread-' + index, objectRef: jobRef, view: 'manifest' }, modelStep)
      let snapshot = await fixture.store.read()
      while (262144 - snapshot.contextReads.reduce((sum, row) => sum + row.bytes, 0) >= work.bytes) { await client.context.read(execution, { clientRequestId: 'fill-work-' + snapshot.contextReads.length, objectRef: work.objectRef, view: 'content' }, modelStep); snapshot = await fixture.store.read() }
    }
    const full = await fixture.store.read(); assert(!workPage.partial)
    if (!byteBoundary) { assert.equal(full.contextReads.length, 64); assert(full.contextReads.every(row => !row.page.partial)) } else { assert(full.contextReads.length < 64); assert(262144 - full.contextReads.reduce((sum, row) => sum + row.bytes, 0) > 0) }
    await assert.rejects(client.context.read(execution, { clientRequestId: 'first-unread-artifact', objectRef: workPage.nextRefs[0].objectRef, view: 'content' }, modelStep), { code: 'CONTEXT_READ_LIMIT' })
    const view = await api('/api/interaction/threads/' + thread.id, undefined, 'GET')
    await writeFile(join(directory, 'complete-metadata-window.json'), JSON.stringify({ state: await fixture.store.read(), rootPage, workPage, projection: view.contextReads }, null, 2))
    assert(view.contextReads.some(row => row.readId === workPage.readId && row.canContinue), 'Exhausted complete metadata must retain a human continuation entry')
    let approval = { clientRequestId: 'continue-unread-relation', sourceEventId: 'continue-unread-relation', version: 1, expectedThreadRevision: view.thread.revision, text: '继续读取资料', continueContextRead: { readId: workPage.readId } }, accepted
    if (crossWindowUi) { const actual = await uiApproval(1); approval = actual.submitted; accepted = actual.receipt } else accepted = await api(`/api/interaction/threads/${thread.id}/events`, approval)
    assert.deepEqual(await api(`/api/interaction/threads/${thread.id}/events`, approval), accepted)
    await assert.rejects(client.context.read(execution, { clientRequestId: 'old-step-cannot-use-relation-window', objectRef: workPage.nextRefs[0].objectRef, view: 'content' }, modelStep), { code: 'CONTEXT_READ_WINDOW_PENDING' }); await pump()
    const notified = await fixture.store.read(), window = notified.contextReadWindows.find(row => row.id === accepted.contextReadWindowId), notice = notified.multisite.outbox.find(row => row.id === window.deliveredByCommandId).command
    assert(window.deliveredAt); assert(notice.parameters.text.includes(`的 ${workPage.nextRefs[0].view} 视图`))
    const issued = await client.issue(execution, { request: true, inputMessageId: messageId(notice.input_id, execution.attempt_id, execution.session_id) }), response = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: notice.parameters.text }], tools: [] }) }); assert.equal(response.status, 200); await response.text()
    const resumed = await client.context.read(execution, { clientRequestId: 'first-page-in-relation-window', view: 'content' }, issued.modelStep), after = await fixture.store.read(), receipt = after.contextReads.find(row => row.id === resumed.readId)
    assert.deepEqual(resumed.objectRef, workPage.nextRefs[0].objectRef); assert.equal(receipt.fromIndex, 0); assert.equal(receipt.parentReadId, workPage.readId); assert.equal(receipt.path.length, full.contextReads.find(row => row.id === workPage.readId).path.length + 1); assert.deepEqual(after.contextReads.slice(0, full.contextReads.length), full.contextReads); assert.equal(after.contextReadWindows.length, 2); assert.equal(after.multisite.inputs.filter(row => row.workId === continued.workId).length, 1)
    const credit = await client.issue(execution, { request: true, inputMessageId: issued.modelStep.inputMessageId }), readArgs = { clientRequestId: 'first-page-in-relation-window', view: 'content' }, creditBody = { model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: notice.parameters.text }, { role: 'assistant', content: null, tool_calls: [{ id: 'actual-resumed-relation', type: 'function', function: { name: 'geneway_read_context', arguments: JSON.stringify(readArgs) } }] }, { role: 'tool', tool_call_id: 'actual-resumed-relation', content: JSON.stringify(resumed) }], tools: [] }, creditResponse = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + credit.token, 'content-type': 'application/json' }, body: JSON.stringify(creditBody) }); assert.equal(creditResponse.status, 200); await creditResponse.text(); const credited = await fixture.store.read(); assert.deepEqual(credited.modelRequests.at(-1).contextReadReceiptIds, [resumed.readId])
    await writeFile(join(directory, 'metadata-boundary-resumed.json'), JSON.stringify({ state: credited, accepted, resumed }, null, 2))
    if (crossWindow) {
      for (let index = 0; index < 32; index++) await client.context.read(execution, { clientRequestId: 'second-window-root-' + index, view: 'content' }, credit.modelStep)
      const previousWork = credited.contextReads.find(row => row.objectRef.kind === 'work').objectRef
      for (let index = 0; index < 31; index++) await client.context.read(execution, { clientRequestId: 'second-window-work-' + index, objectRef: previousWork, view: 'content' }, credit.modelStep)
      const edge = workPage.nextRefs[1]; await assert.rejects(client.context.read(execution, { clientRequestId: 'second-window-next-unread-result', objectRef: edge.objectRef, view: edge.view }, credit.modelStep), { code: 'CONTEXT_READ_LIMIT' })
      const secondFull = await fixture.store.read(), current = await api('/api/interaction/threads/' + thread.id, undefined, 'GET')
      await writeFile(join(directory, 'cross-window-before-third.json'), JSON.stringify({ state: secondFull, parent: workPage, target: edge, projection: current.contextReads }, null, 2))
      assert(current.contextReads.some(row => row.readId === workPage.readId && row.canContinue), 'A prior-window parent edge must retain a new current-window continuation')
      const sourceWindow = secondFull.contextReadWindows.at(-1); let thirdRequest = { clientRequestId: 'continue-second-unread-relation', sourceEventId: 'continue-second-unread-relation', version: 1, expectedThreadRevision: current.thread.revision, text: '继续读取资料', continueContextRead: { readId: workPage.readId } }, thirdApproval
      if (crossWindowUi) { const actual = await uiApproval(2); thirdRequest = actual.submitted; thirdApproval = actual.receipt; assert.notEqual(thirdRequest.sourceEventId, approval.sourceEventId); assert.notEqual(thirdRequest.clientRequestId, approval.clientRequestId) } else thirdApproval = await api(`/api/interaction/threads/${thread.id}/events`, thirdRequest)
      const thirdApproved = await fixture.store.read(), thirdWindow = thirdApproved.contextReadWindows.at(-1)
      assert.equal(thirdApproved.contextReadWindows.length, 3); assert.equal(thirdWindow.sourceWindowId, sourceWindow.id); assert.equal(thirdWindow.parentReadId, workPage.readId); assert.deepEqual(thirdWindow.continuationTarget.objectRef, edge.objectRef); assert.notEqual(thirdApproval.contextReadWindowId, accepted.contextReadWindowId)
      assert.deepEqual(await api(`/api/interaction/threads/${thread.id}/events`, thirdRequest), thirdApproval); assert.deepEqual(await fixture.store.read(), thirdApproved)
      assert.deepEqual(await api(`/api/interaction/threads/${thread.id}/events`, approval), accepted); assert.deepEqual(await fixture.store.read(), thirdApproved)
      await assert.rejects(client.context.read(execution, { clientRequestId: 'old-step-cannot-read-third-window', objectRef: edge.objectRef, view: edge.view }, credit.modelStep), { code: 'CONTEXT_READ_WINDOW_PENDING' }); await pump()
      const deliveredThird = await fixture.store.read(), thirdNotice = deliveredThird.multisite.outbox.find(row => row.id === deliveredThird.contextReadWindows.at(-1).deliveredByCommandId).command, thirdInput = messageId(thirdNotice.input_id, execution.attempt_id, execution.session_id), thirdIssued = await client.issue(execution, { request: true, inputMessageId: thirdInput }), thirdResponse = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + thirdIssued.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: thirdNotice.parameters.text }], tools: [] }) }); assert.equal(thirdResponse.status, 200); await thirdResponse.text()
      const thirdArgs = { clientRequestId: 'first-third-window-page', view: edge.view }, thirdPage = await client.context.read(execution, thirdArgs, thirdIssued.modelStep), thirdReadState = await fixture.store.read(), thirdReceipt = thirdReadState.contextReads.find(row => row.id === thirdPage.readId)
      assert.deepEqual(thirdPage.objectRef, edge.objectRef); assert.equal(thirdReceipt.fromIndex, 0); assert.equal(thirdReceipt.parentReadId, workPage.readId); assert.deepEqual(thirdReadState.contextReads.slice(0, secondFull.contextReads.length), secondFull.contextReads); assert.deepEqual(thirdReadState.contextReadWindows.slice(0, 2), secondFull.contextReadWindows)
      const thirdCredit = await client.issue(execution, { request: true, inputMessageId: thirdInput }), thirdBody = { model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: thirdNotice.parameters.text }, { role: 'assistant', content: null, tool_calls: [{ id: 'actual-third-window-page', type: 'function', function: { name: 'geneway_read_context', arguments: JSON.stringify(thirdArgs) } }] }, { role: 'tool', tool_call_id: 'actual-third-window-page', content: JSON.stringify(thirdPage) }], tools: [] }, finalResponse = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + thirdCredit.token, 'content-type': 'application/json' }, body: JSON.stringify(thirdBody) }); assert.equal(finalResponse.status, 200); await finalResponse.text(); const finalState = await fixture.store.read(); assert.deepEqual(finalState.modelRequests.at(-1).contextReadReceiptIds, [thirdPage.readId]); assert.equal(finalState.multisite.inputs.filter(row => row.workId === continued.workId).length, 1)
      await writeFile(join(directory, 'cross-window-third-resumed.json'), JSON.stringify({ state: finalState, thirdApproval, page: thirdPage, previousWindow: sourceWindow.id, originalParent: workPage.readId }, null, 2))
      if (crossWindowUi) { uiDriver.send({ kind: 'context-read-ui-ack', phase: 'human-continue-accepted' }); assert.equal(await uiExit, 0) }
    }
    await api(`/api/works/${continued.workId}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
    const result = { result: 'passed', directory, fullMetadataPages: byteBoundary ? null : 64, noPartialPagesAtBoundary: !byteBoundary, byteBoundaryWithNonzeroRemaining: byteBoundary, actualModelForwards: bodies.length, explicitHumanSourceOnlyNewWindow: true, firstUnreadRelationStartsAtZero: true, resumedFullPageInActualProviderBodyAndLedger: true, currentWindowCanReusePriorWindowParentForDifferentTarget: crossWindow, actualSameBrowserTwoContinuationSlots: crossWindowUi, boundary: crossWindowUi ? 'actual authenticated HTTP/FileStore/HostSim/real Artifact bytes and same desktop Web continuation twice with mobile readback; no native SDK claim' : 'actual authenticated HTTP/FileStore/HostSim/real Artifact bytes; no native/browser claim' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else {
  const root = await readObject(), workPages = await readObject(root.flatMap(page => page.nextRefs)[0].objectRef), artifactRef = workPages.flatMap(page => page.nextRefs)[0].objectRef, workbookPages = await readObject(artifactRef), jobRef = workbookPages.flatMap(page => page.nextRefs)[0].objectRef, jobPages = await readObject(jobRef, 'manifest'), results = jobPages.flatMap(page => page.nextRefs)
  assert(results.length >= 3)
  const evidenceRefs = new Map()
  for (const result of results) for (const page of await readObject(result.objectRef)) for (const next of page.nextRefs) evidenceRefs.set(next.objectRef.id, next.objectRef)
  for (const value of evidenceRefs.values()) await readObject(value)
  assert.equal(evidenceRefs.size, 2); assert(pages.some(page => page.source?.quality && page.items.some(item => item.entryIndex !== undefined))); assert(pages.some(page => page.items.some(item => item.sourceEventId)))
  const pageCount = pages.length, oldReads = (await fixture.store.read()).contextReads.length; assert.deepEqual(await client.context.read(execution, parameters[0], modelStep), pages[0]); assert.equal((await fixture.store.read()).contextReads.length, oldReads)
  await forward('hash'); assert(!(await fixture.store.read()).modelRequests.at(-1).contextReadReceiptIds)
  await forward('altered'); assert(!(await fixture.store.read()).modelRequests.at(-1).contextReadReceiptIds)
  modelStep = await forward('exact'); const after = await fixture.store.read(); assert.equal(after.modelRequests.at(-1).contextReadReceiptIds.length, pageCount); assert.deepEqual(after.modelRequests.slice(0, original.modelRequests.length), original.modelRequests); assert.deepEqual(after.evidence, original.evidence); assert.deepEqual(after.evidenceAccessReceipts, original.evidenceAccessReceipts); assert.deepEqual(after.artifacts, original.artifacts); assert.deepEqual(after.works.find(row => row.id === sourceWork.id), sourceWork)
  assert.deepEqual(after.modelRequests.filter(row => row.work_id === continued.workId).map(row => row.bodyDigest).sort(), bodies.map(digest).sort())
  await writeFile(join(directory, 'read-pages.json'), JSON.stringify({ pages, parameters }, null, 2)); await writeFile(join(directory, 'after-read.json'), JSON.stringify(after, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2))
  if (process.argv.includes('--revoke')) {
    const jobContent = await readObject(jobRef, 'content'), beforeRevoke = await fixture.store.read(), oldArguments = parameters.at(-1), oldPage = pages.at(-1)
    const resource = beforeRevoke.resources.find(row => row.kind === 'history_directory')
    await api('/api/admin/resources/' + encodeURIComponent(resource.id), { clientRequestId: 'revoke-history-context-reader', expectedRevision: resource.revision, workspaceId: resource.workspaceId, siteId: resource.siteId, kind: resource.kind, ownerNodeId: resource.ownerNodeId, capabilityIds: resource.capabilityIds, evidenceReaderAgentIds: resource.evidenceReaderAgentIds.filter(id => id !== 'coordinator'), enabled: resource.enabled }, 'PUT')
    await assert.rejects(client.context.read(execution, oldArguments, modelStep), { code: 'CONTEXT_READ_UNAVAILABLE' })
    const freshArtifact = await client.context.read(execution, { clientRequestId: 'fresh-artifact-summary-after-revoke', objectRef: artifactRef, view: 'summary' }, modelStep)
    const freshArtifactContent = await client.context.read(execution, { clientRequestId: 'fresh-artifact-content-after-revoke', objectRef: artifactRef, view: 'content' }, modelStep)
    assert(freshArtifactContent.items.some(row => Array.isArray(row.cells))); assert(freshArtifact.nextRefs.every(row => row.view === 'summary'))
    const freshJob = await client.context.read(execution, { clientRequestId: 'fresh-job-content-after-revoke', objectRef: jobRef, view: 'content' }, modelStep), hiddenIds = new Set(beforeRevoke.multisite.results.filter(row => row.payload.evidenceRefs?.some(ref => beforeRevoke.evidence.some(value => value.id === ref.id && value.resourceId === resource.id))).map(row => row.id))
    assert(freshJob.nextRefs.every(next => !hiddenIds.has(next.objectRef.id))); assert(!freshJob.items.some(item => item.relation && hiddenIds.has(item.relation.objectRef.id)))
    const issued = await client.issue(execution, { request: true, inputMessageId }), cacheBody = { model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: input.text }, { role: 'assistant', content: null, tool_calls: [{ id: 'cached-job', type: 'function', function: { name: 'geneway_read_context', arguments: JSON.stringify(oldArguments) } }] }, { role: 'tool', tool_call_id: 'cached-job', content: JSON.stringify(oldPage) }], tools: [] }, refused = await fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' }, body: JSON.stringify(cacheBody) }); assert.equal(refused.status, 403); await refused.text(); const afterRevoke = await fixture.store.read(); assert.deepEqual(afterRevoke.modelRequests, beforeRevoke.modelRequests); assert.equal(bodies.length, 4)
    const downloaded = await fixture.spreadsheetArtifacts.download({ id: 'owner' }, sourceWork.id, sourceWork.artifactRefs[0].artifactId); assert.equal(digest(downloaded.metadata.sha256), digest(original.artifacts.find(row => row.id === downloaded.metadata.id).sha256))
    await writeFile(join(directory, 'revoked-old-relation-fresh-artifact.json'), JSON.stringify({ oldArguments, oldPage, freshArtifact, freshArtifactContent, freshJob, state: afterRevoke, readyDownloadSha256: downloaded.metadata.sha256 }, null, 2))
  }
  if (process.argv.includes('--own-revoke')) {
    const beforeRevoke = await fixture.store.read(), output = beforeRevoke.nodes.find(row => row.id === 'pc-b')
    await api('/api/admin/nodes/pc-b/revoke', { clientRequestId: 'revoke-output-context-owner', expectedRevision: output.revision })
    const revoked = await fixture.store.read()
    await assert.rejects(client.context.read(execution, { clientRequestId: 'read-output-revoked', objectRef: artifactRef, view: 'content' }, modelStep), { code: 'FORBIDDEN' })
    await assert.rejects(fixture.spreadsheetArtifacts.download({ id: 'owner' }, sourceWork.id, sourceWork.artifactRefs[0].artifactId), { code: 'FORBIDDEN' })
    const rejected = await fixture.store.read(); assert.deepEqual(rejected, revoked); assert.deepEqual(rejected.modelRequests, beforeRevoke.modelRequests); assert.deepEqual(rejected.artifacts, beforeRevoke.artifacts); assert.deepEqual(rejected.evidence, beforeRevoke.evidence)
    await writeFile(join(directory, 'output-authority-rejected.json'), JSON.stringify({ before: beforeRevoke, revoked, rejected }, null, 2))
  }
  if (process.argv.includes('--quota-fork')) {
    const rootRef = pages[0].objectRef, workRef = workPages[0].objectRef
    for (let index = 0; index < 30; index++) await client.context.read(execution, { clientRequestId: 'reread-root-' + index, objectRef: rootRef, view: 'content' }, modelStep)
    let state = await fixture.store.read()
    while (state.contextReads.length - (original.contextReads?.length ?? 0) < 63) { await client.context.read(execution, { clientRequestId: 'reread-work-' + state.contextReads.length, objectRef: workRef, view: 'content' }, modelStep); state = await fixture.store.read() }
    const beforeFork = state, outcomes = await Promise.allSettled([0, 1].map(index => client.context.read(execution, { clientRequestId: 'last-slot-' + index, objectRef: rootRef, view: 'content' }, modelStep))), afterFork = await fixture.store.read()
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'CONTEXT_READ_LIMIT'); assert.equal(afterFork.contextReads.length, beforeFork.contextReads.length + 1); assert.deepEqual(afterFork.contextReads.slice(0, beforeFork.contextReads.length), beforeFork.contextReads); assert.deepEqual(afterFork.contextReadWindows, beforeFork.contextReadWindows)
    modelStep = await forward()
    await assert.rejects(client.context.read(execution, { clientRequestId: 'new-model-does-not-reset-window', objectRef: rootRef, view: 'content' }, modelStep), { code: 'CONTEXT_READ_LIMIT' })
    const afterRequest = await fixture.store.read(); assert.deepEqual(afterRequest.contextReads, afterFork.contextReads); assert.deepEqual(afterRequest.contextReadWindows, afterFork.contextReadWindows)
    await writeFile(join(directory, 'concurrent-last-slot.json'), JSON.stringify({ before: beforeFork, outcomes: outcomes.map(row => row.status === 'fulfilled' ? row : { status: row.status, reason: { code: row.reason.code, status: row.reason.status } }), after: afterFork, afterNewActualModelRequest: afterRequest }, null, 2))
  }
  if (process.argv.includes('--request-lifecycle')) {
    const issued = await client.issue(execution, { request: true, inputMessageId }), baseline = await fixture.store.read()
    let release, reached; const ready = new Promise(resolve => { reached = resolve }); upstreamBarrier = { reached, release: new Promise(resolve => { release = resolve }) }
    const pending = fetch(fixture.origin + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: '实际在途请求与已断流未知请求分离验收' }], tools: [] }) }).then(async response => ({ status: response.status, text: await response.text().catch(cause => cause.message) }))
    try {
      await ready
      const active = await fixture.store.read(); assert.equal(active.modelRequests.at(-1).id, issued.modelStep.requestId); assert.equal(active.modelRequests.at(-1).outcome, 'unknown')
      const args = { clientRequestId: 'actual-active-request-read', objectRef: artifactRef, view: 'summary' }, activePage = await client.context.read(execution, args, issued.modelStep), during = await fixture.store.read()
      assert.equal(during.contextReads.length, baseline.contextReads.length + 1)
      await assert.rejects(client.context.read({ ...execution, session_id: execution.session_id + '-other' }, { ...args, clientRequestId: 'other-session-read' }, issued.modelStep))
      assert.deepEqual(await fixture.store.read(), during)
      release(); const transport = await pending; assert.equal(transport.status, 200)
      // The response may close before the gateway's finally removes its active owner.
      let settled
      for (let turn = 0; turn < 100; turn++) {
        try { await client.context.read(execution, args, issued.modelStep) } catch (cause) { if (cause.code !== 'CONTEXT_READ_UNAVAILABLE') throw cause; settled = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert(settled, 'Disconnected request must lose its active in-process owner')
      await assert.rejects(client.context.read(execution, { ...args, clientRequestId: 'orphan-unknown-new-read' }, issued.modelStep), { code: 'CONTEXT_READ_UNAVAILABLE' })
      await assert.rejects(client.issue(execution, { request: true, inputMessageId }), { code: 'RUNTIME_REQUEST_UNKNOWN' })
      const orphan = await fixture.store.read(); assert.equal(orphan.modelRequests.at(-1).outcome, 'unknown'); assert.equal(orphan.modelRequests.at(-1).usage, null); assert.equal(orphan.modelRequests.at(-1).completedAt, null); assert.deepEqual(orphan.contextReads, during.contextReads); assert.deepEqual(orphan.modelRequests.slice(0, baseline.modelRequests.length), baseline.modelRequests); assert.equal(bodies.length, 5)
      await writeFile(join(directory, 'request-lifecycle.json'), JSON.stringify({ baseline, active, activePage, during, orphan, transport }, null, 2))
    } finally { release(); await pending }
  }
  await api(`/api/works/${continued.workId}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  const result = { result: 'passed', directory, actualPages: pageCount, relation: 'new continuation → old Work → actual ready workbook → original Job/manifest → immutable results → original sealed Evidence', actualModelForwards: bodies.length, rootSourceCurrentOldFactsPreserved: true, completeToolPageModelCreditOnly: true, revokedRelationReplayAndCachedModelDeniedFreshArtifactStillReadable: process.argv.includes('--revoke') ? true : null, currentOutputAuthorityRequired: process.argv.includes('--own-revoke') ? true : null, concurrentLastReadSlotOnceAndNewRequestDoesNotReset: process.argv.includes('--quota-fork') ? true : null, activeRequestCanReadButOrphanUnknownAndOtherSessionCannot: process.argv.includes('--request-lifecycle') ? true : null, boundary: 'real authenticated HTTP/paired persisted Node identity/FileStore/Host AgentDelivery simulator/real gateway+upstream HTTP and old actual D4 files; deterministic explicit Work selection supporting layer, no new native/browser/natural-language claim or200-entry claim' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { if (uiDriver?.connected) uiDriver.send({ kind: 'context-read-ui-ack', phase: 'human-continue-accepted', abort: true }); if (uiExit) await uiExit; await host?.close(); await fixture?.close(); await new Promise(resolve => provider ? provider.close(resolve) : resolve()); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Context read root:', directory) }
