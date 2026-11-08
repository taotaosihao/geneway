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
const mode = process.argv.includes('--question') ? 'question' : process.argv.includes('--intent') ? 'intent' : 'ordinary'
const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-native-XEeXvl', directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/context-read-'), bodies = [], observations = [], pages = [], parameters = []
let fixture, provider, host
try {
  const original = JSON.parse(await readFile(join(sourceRoot, 'old-ready-state.json'))), sourceWork = original.works.find(row => row.status === 'completed')
  provider = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"读取当前获准历史资料"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  fixture = await startBridgeService({ directory: join(directory, 'api'), seedState: state => Object.assign(state, structuredClone(original)), upstreamBaseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); await cp(join(sourceRoot, 'api/artifacts'), join(directory, 'api/artifacts'), { recursive: true }); await cp(join(sourceRoot, 'api/evidence'), join(directory, 'api/evidence'), { recursive: true }); await mkdir(join(directory, 'api/secrets'), { recursive: true }); await writeFile(join(directory, 'api/secrets/key'), 'synthetic-context-fixture', { mode: 0o600 })
  const login = await fetch(fixture.origin + '/api/session', { method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }), session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  async function api(path, body, method = 'POST', expected = 200) { const response = await fetch(fixture.origin + path, { method, headers: { origin: fixture.origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), value = await response.json(); observations.push({ path, method, status: response.status, value }); assert.equal(response.status, expected, JSON.stringify(value)); return value }
  const identity = JSON.parse(await readFile(join(sourceRoot, 'cloud/node-identity.json'))), client = createRemoteClient({ origin: fixture.origin, identity }), journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }); host = createAgentHost({ nodeId: 'cloud', journal, runtime }); host.setOrchestrationHandler({ call: (...args) => client.command(...args), event: event => client.event(event) })
  async function pump() { for (let turn = 0; turn < 3; turn++) { for (const pending of (await client.resync()).pending) { const command = await client.resolveCommand(pending); await host.accept({ workspaceId: 'local', nodeId: 'cloud' }, command); await client.ack(command) }; await host.process(); await host.flushEvents(event => client.event(event)) } }
  const route = original.modelRoutes.find(row => row.enabled), budget = { clientRequestId: 'context-policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 64, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: original.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await api('/api/admin/budget-policies/context-reader', budget, 'PUT')
  const thread = await api('/api/interaction/threads', { clientRequestId: 'context-thread' }), proposal = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'source', sourceEventId: 'source', version: 1, expectedThreadRevision: 1, text: '明确回看原多来源成果的真实资料，再核对后续安排。', workId: sourceWork.id }), preview = await api(`/api/interaction/threads/${thread.id}/artifacts/${proposal.intentId}/${sourceWork.artifactRefs[0].artifactId}`, undefined, 'GET')
  const continued = await api(`/api/interaction/threads/${thread.id}/continuation`, { clientRequestId: 'new-reader', intentId: proposal.intentId, expectedRouteRevision: proposal.routeRevision, employeeId: 'coordinator', budgetPolicyId: 'context-reader', goal: '核对原多来源成果及其历史证据，不生成文件。', artifactReadId: preview.id }); await pump()
  const before = await fixture.store.read(), attempt = before.multisite.attempts.find(row => row.work_id === continued.workId), execution = binding(attempt), input = before.multisite.inputs.find(row => row.workId === continued.workId), inputMessageId = messageId(input.id, execution.attempt_id, execution.session_id)
  let activeCommand, activeMessageId = inputMessageId, activeText = input.text
  async function forward(kind = 'exact') {
    const issued = activeCommand ? await client.issueIntentReview(execution, activeCommand.command_id, { request: true, inputMessageId: activeMessageId }) : await client.issue(execution, { request: true, inputMessageId: activeMessageId }); assert(issued.contextReadEnabled); assert(issued.modelStep)
    const messages = [{ role: 'user', content: activeText }]
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
  const root = await readObject(), workPages = await readObject(root.flatMap(page => page.nextRefs)[0].objectRef), artifactRef = workPages.flatMap(page => page.nextRefs)[0].objectRef
  let intent, question
  if (mode !== 'ordinary') {
    const view = await api('/api/interaction/threads/' + thread.id, undefined, 'GET'), added = await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'read-intent', sourceEventId: 'read-intent', version: 1, expectedThreadRevision: view.thread.revision, text: '先以受限判断用途读取原成果，再决定如何继续。', routingPolicyId: null })
    intent = (await fixture.store.read()).workIntents.find(row => row.id === added.intentId); await pump()
    activeCommand = (await fixture.store.read()).multisite.outbox.find(row => row.command.parameters.intentFence?.intentId === intent.id).command
    activeMessageId = messageId(activeCommand.input_id, execution.attempt_id, execution.session_id); activeText = activeCommand.parameters.text
    modelStep = await forward()
  }
  let cursor, partial
  do {
    const args = { clientRequestId: 'artifact-window-' + ++sequence, objectRef: artifactRef, view: 'content', ...(cursor ? { cursor } : {}) }, page = await client.context.read(execution, args, modelStep)
    pages.push(page); parameters.push(args); partial = page; cursor = page.nextCursor
  } while (cursor)
  assert(partial.partial); assert(partial.limitReason); assert.equal(partial.nextCursor, null)
  const atLimit = await fixture.store.read(), oldWindow = atLimit.contextReadWindows.at(-1), used = atLimit.contextReads.filter(row => row.windowId === oldWindow.id && row.objectRef.kind === 'artifact').reduce((sum, row) => sum + row.bytes, 0)
  assert(used <= 131072); assert(used > 110000); const parent = atLimit.contextReads.find(row => row.id === partial.readId); assert.equal(parent.page.nextIndex, partial.nextIndex)
  if (mode === 'question') {
    const asked = await runtime.orchestration(execution, 'ask_intent', { clientRequestId: 'ask-before-continue', intentFence: activeCommand.parameters.intentFence, text: '继续核对前，请明确资料核对范围。' }); assert.equal(asked.status, 'waiting_intent'); question = (await fixture.store.read()).intentQuestions.find(row => row.intentId === intent.id && row.state === 'open'); assert(question)
  }
  const beforeContinue = await fixture.store.read(), view = await api('/api/interaction/threads/' + thread.id, undefined, 'GET'), entry = view.contextReads.find(row => row.readId === partial.readId)
  assert(entry?.canContinue); const request = { clientRequestId: 'human-continue', sourceEventId: 'human-continue', version: 1, expectedThreadRevision: view.thread.revision, text: '继续读取资料', continueContextRead: { readId: partial.readId } }
  const approved = await api(`/api/interaction/threads/${thread.id}/events`, request); assert(approved.contextReadWindowId); assert.deepEqual(await api(`/api/interaction/threads/${thread.id}/events`, request), approved)
  const queued = await fixture.store.read(); assert.equal(queued.contextReadWindows.length, beforeContinue.contextReadWindows.length + 1); assert.equal(queued.workIntents.length, beforeContinue.workIntents.length); assert.deepEqual(queued.multisite.inputs, beforeContinue.multisite.inputs); assert.equal(queued.works.find(row => row.id === continued.workId).goal, beforeContinue.works.find(row => row.id === continued.workId).goal)
  await api(`/api/interaction/threads/${thread.id}/events`, { ...request, clientRequestId: 'second-browser', sourceEventId: 'second-browser' }, 'POST', 409)
  const attemptsBeforeRead = (await fixture.store.read()).contextReads.length
  await assert.rejects(client.context.read(execution, { clientRequestId: 'old-step-cannot-take-new-window', view: 'content' }, modelStep), cause => ['CONTEXT_READ_WINDOW_PENDING', 'FORBIDDEN'].includes(cause.code))
  assert.equal((await fixture.store.read()).contextReads.length, attemptsBeforeRead)
  await writeFile(join(directory, 'window-approved-waiting.json'), JSON.stringify({ before: beforeContinue, queued, request, approved, dto: entry }, null, 2))
  if (process.argv.includes('--input-before-notice')) {
    assert.equal(mode, 'ordinary')
    await api(`/api/works/${continued.workId}/multisite/inputs`, { clientRequestId: 'formal-input-before-notice', text: '保留原成果核对目标，并按当前正式补充要求继续。' })
    await writeFile(join(directory, 'input-before-notice.json'), JSON.stringify(await fixture.store.read(), null, 2))
  }
  if (mode === 'question') {
    assert.equal(queued.intentQuestions.find(row => row.id === question.id).state, 'open'); assert.equal(queued.modelRequests.length, beforeContinue.modelRequests.length); assert.equal(queued.contextReadWindows.at(-1).deliveryCommandId, null)
    const current = await api('/api/interaction/threads/' + thread.id, undefined, 'GET')
    await api(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'answer-real-question', sourceEventId: 'answer-real-question', version: 1, expectedThreadRevision: current.thread.revision, text: '请继续核对原已批准的未读资料。', replyToIntentQuestion: { id: question.id, routeRevision: question.routeRevision }, routingPolicyId: null })
  }
  await pump(); const notified = await fixture.store.read(), window = notified.contextReadWindows.at(-1), notice = notified.multisite.outbox.find(row => row.id === window.deliveredByCommandId)?.command
  assert(window.deliveredAt); assert(notice)
  if (mode === 'ordinary') { assert.equal(notice.parameters.messages[0].kind, 'context_read_available'); assert(!notice.parameters.waitRelease) }
  else { assert.equal(notice.operation, 'intent_review'); assert.equal(notice.parameters.intentFence.intentId, intent.id); assert.equal(notice.parameters.intentFence.subscriptionRevision, activeCommand.parameters.intentFence.subscriptionRevision + 1); activeCommand = notice; if (mode === 'question') { assert.equal(notice.parameters.waitRelease.id, question.id); assert.equal(notified.intentQuestions.find(row => row.id === question.id).state, 'answered') } }
  activeMessageId = messageId(notice.input_id, execution.attempt_id, execution.session_id); activeText = notice.parameters.text + (notice.parameters.intentAnswer ? '\n' + JSON.stringify(notice.parameters.intentAnswer) : '')
  modelStep = await forward()
  const args = { clientRequestId: 'new-window-first', view: 'content' }, first = await client.context.read(execution, args, modelStep), resumedRead = (await fixture.store.read()).contextReads.find(row => row.id === first.readId)
  assert.equal(resumedRead.fromIndex, partial.nextIndex); assert.deepEqual(first.objectRef, partial.objectRef); assert.equal(first.windowId, window.id); assert.equal(resumedRead.parentReadId, partial.readId); assert.equal(resumedRead.path.length, parent.path.length)
  pages.push(first); parameters.push(args); const after = await fixture.store.read(); assert.equal(after.multisite.inputs.filter(row => row.workId === continued.workId).length, process.argv.includes('--input-before-notice') ? 2 : 1); assert.equal(after.contextReadWindows.length, 2); assert.equal(after.works.find(row => row.id === continued.workId).instructionRevision, process.argv.includes('--input-before-notice') ? 2 : 1)
  if (process.argv.includes('--input-before-notice')) {
    const originalWindow = queued.contextReadWindows.at(-1), originalCommand = queued.multisite.outbox.find(row => row.id === originalWindow.deliveryCommandId)
    assert.deepEqual(after.multisite.outbox.find(row => row.id === originalCommand.id), originalCommand)
    assert.equal(window.deliveryCommandId, originalCommand.id); assert.equal(window.deliveryCommandIds.length, 2); assert.notEqual(window.deliveredByCommandId, originalCommand.id)
    assert.equal(notice.instruction_revision, 2); assert.equal(after.contextReads.filter(row => row.windowId === window.id).length, 1)
    const formal = after.multisite.inputs.find(row => row.workId === continued.workId && row.revision === 2); assert(formal.deliveries.some(row => row.attemptId === execution.attempt_id && row.sessionId === execution.session_id && row.ingestedAt))
  }
  await writeFile(join(directory, 'window-resumed.json'), JSON.stringify({ state: after, first, parent: partial, artifactBytesInInitialWindow: used }, null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(bodies, null, 2)); await writeFile(join(directory, 'read-pages.json'), JSON.stringify({ pages, parameters }, null, 2))
  await api(`/api/works/${continued.workId}/multisite/cancel`, { clientRequestId: 'cancel' }); await pump()
  const result = { result: 'passed', directory, mode, actualModelForwards: bodies.length, actualReadPages: pages.length, dynamicRemainingFullJsonWithin128KiB: true, explicitHumanWindowOnlyOnceNoBusinessInputOrQuestionChange: true, laterExplicitFormalInputRetainsOriginalWindowAndReissuesCurrentNotice: process.argv.includes('--input-before-notice') ? true : null, oldModelStepCannotSpendNewWindow: true, currentNoticeActuallyConsumed: true, resumedExactOriginalUnreadPosition: true, boundary: 'real HTTP/FileStore/paired existing Node/Host simulator/gateway+upstream HTTP and actual200row D4 old workbook; no new SDK/browser claim; question source answer is actual API/Host simulator' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack }, null, 2)); throw cause }
finally { await host?.close(); await fixture?.close(); await new Promise(resolve => provider ? provider.close(resolve) : resolve()); await writeFile(join(directory, 'http-observations.json'), JSON.stringify(observations, null, 2)); console.log('Context window root:', directory) }
