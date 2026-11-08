import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { seedDelegation } from './fixtures/multisite/delegation.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'
import { messageId } from '../packages/agent-host/delivery.mjs'
import { binding, digest } from '../packages/agent-contracts/index.mjs'

const budgetLatest = process.argv.includes('--budget-latest-input'), budgetResume = process.argv.includes('--budget-resume') || budgetLatest
const latestInputText = '预算调整后的最新要求：只确认收到本条，不读取旧Evidence，不重做采集，不宣称新版分析完成。'
const controlRevoke = process.argv.includes('--control-revoke'), withQuestion = process.argv.includes('--with-question') || controlRevoke || budgetResume
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/evidence-sharing-native-'), apiRoot = join(directory, 'api'), captures = [], errors = [], children = [], readyHosts = [], oracle = {}
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let provider, origin, session, pausedBudgetParent
try {
  await mkdir(apiRoot); const store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(state => { seedDelegation(state); state.skills = [{ id: 'cycle', name: '节拍计算', capabilityId: 'cycle-time-calculate', enabled: true }]; for (const employee of state.employees) { employee.skillIds = ['cycle']; employee.placement.nodeId = ({ 'desktop-data': 'pc-a', gateway: 'gateway', 'desktop-office': 'pc-b', analysis: 'analysis', coordinator: 'cloud' })[employee.id]; employee.placement.resourceRefs = employee.id === 'desktop-data' ? ['fixture:history'] : employee.id === 'gateway' ? ['fixture:site'] : [] }; return state })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-evidence-provider', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), lastUser = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[lastUser].content)
      const context = JSON.parse(input.split('当前执行职责与授权（不能自行扩大）：')[1].split('Agent来源消息（不是用户修订）：')[0])
      const cap = context.grant.execution.capabilityIds[0], agent = ({ 'office.xlsx.render.v1': 'desktop-office', 'evidence.history.read.v1': 'desktop-data', 'evidence.site.inspect.v1': 'gateway', 'analysis.classify.v1': 'analysis' })[cap]
      const turn = captures.filter(row => row.agent === agent).length + 1, toolMessages = body.messages.filter(row => row.role === 'tool'), outputs = toolMessages.map(row => { try { return JSON.parse(flatten(row.content)) } catch { return null } }).filter(Boolean)
      const calls = [], add = (name, args) => calls.push({ name, args }), common = { instructionRevision: 1 }, observedRefs = outputs.filter(row => row.ref && row.status === 'ready').map(row => row.ref)
      const parseRefs = () => { const marker = 'Agent来源消息（不是用户修订）：', messages = JSON.parse(input.split(marker)[1]); return messages.flatMap(row => row.result?.evidenceRefs ?? []) }
      const child = (id, target, capability, resourceRefs = [], evidenceRefs) => ({ ...common, clientRequestId: id, targetAgentId: target, goal: '读取明确授权的模拟证据并独立回报，不判断真实现场', requestedCapabilityId: capability, resourceRefs, resultSchema: target === 'analysis' ? 'geneway.analysis-result/1' : 'geneway.delegation-result/1', ...(evidenceRefs ? { evidenceRefs } : {}) })
      const newestInput = budgetLatest && input.startsWith(latestInputText)
      if (newestInput) { /* The latest user instruction supersedes the old analysis request. */ }
      else if (agent === 'desktop-data' || agent === 'gateway') {
        const history = agent === 'desktop-data'
        if (turn === 1) add(history ? 'geneway_read_history' : 'geneway_inspect_site', { ...common, clientRequestId: 'capture', resourceId: history ? 'fixture:history' : 'fixture:site', ...(history ? { datasetId: 'history' } : { sections: ['collector_health', 'recent_events'] }) })
        else if (withQuestion && agent === 'gateway' && turn === 2) { /* Stay active after this idle turn so the later directed question has a responsible Attempt. */ }
        else if (withQuestion && agent === 'gateway' && turn === 3) {
          const messages = JSON.parse(input.split('Agent来源消息（不是用户修订）：')[1]); assert.equal(messages[0].kind, 'question')
          if (!controlRevoke) add('geneway_answer_agent', { ...common, clientRequestId: 'answer-b', questionId: messages[0].replyTo, text: '来源是模拟站点；时间未知，不能判断当前正常。', evidenceRefs: observedRefs })
        }
        else if (turn === 2 || withQuestion && agent === 'gateway' && turn === 4) { assert.equal(observedRefs.length, 1); add('geneway_publish_observation', { ...common, clientRequestId: 'observation', text: history ? '模拟历史已封存，仅声明来源' : '模拟站点时间未知，不推断当前正常', evidenceRefs: observedRefs }); add('geneway_complete_delegation', { ...common, clientRequestId: 'complete', result: { summary: history ? '模拟历史证据已封存' : '模拟站点时钟未知', evidenceRefs: observedRefs } }) }
      } else if (agent === 'desktop-office') {
        if (turn === 1) { add('geneway_publish_observation', { ...common, clientRequestId: 'observation', text: '按授权收集两来源，后续由独立分析核对', evidenceRefs: [] }); add('geneway_delegate', child('a', 'desktop-data', 'evidence.history.read.v1', ['fixture:history'])); add('geneway_delegate', child('g', 'gateway', 'evidence.site.inspect.v1', ['fixture:site'])) }
        else if (withQuestion && turn === 2) {
          await until(async () => { const state = await store.read(); return state.modelRequests.filter(row => row.agent_id === 'gateway' && row.outcome === 'completed').length === 2 })
          add('geneway_ask_agent', { ...common, clientRequestId: 'ask-g', targetAgentId: 'gateway', text: '请明确来源时钟与当前状态的限制', evidenceRefs: [] })
        }
        else if (turn === (withQuestion ? 3 : 2)) add('geneway_wait_dependencies', { ...common, clientRequestId: 'wait-sources', dependencyIds: outputs.filter(row => row.delegationId).map(row => row.delegationId) })
        else if (turn === (withQuestion ? 4 : 3)) for (const ref of parseRefs()) add('geneway_read_shared_evidence', { ref })
        else if (turn === (withQuestion ? 5 : 4)) {
          const pages = outputs.filter(row => row.schema && row.entries); assert.equal(pages.length, 2)
          for (const page of pages) { assert(page.partial); add('geneway_read_shared_evidence', { ref: page.ref, cursor: page.nextCursor }) }
          add('geneway_delegate', child('analysis', 'analysis', 'analysis.classify.v1', [], parseRefs()))
        } else if (turn === (withQuestion ? 6 : 5)) add('geneway_wait_dependencies', { ...common, clientRequestId: 'wait-analysis', dependencyIds: [outputs.findLast(row => row.delegationId).delegationId] })
        else { const messages = JSON.parse(input.split('Agent来源消息（不是用户修订）：')[1]); assert.equal(messages[0].result.findings.length, 2) }
      } else if (agent === 'analysis') {
        if (turn === 1) for (const ref of context.evidenceRefs) add('geneway_read_shared_evidence', { ref })
        else if (turn === 2) {
          const pages = outputs.filter(row => row.entries && row.schema), history = pages.find(row => row.schema === 'geneway.incident-history/1'), site = pages.find(row => row.schema === 'geneway.site-snapshot/1'); assert.equal(site.quality, 'unknown'); assert.equal(history.entries[0].description, '护罩松动')
          add('geneway_complete_delegation', { ...common, clientRequestId: 'analysis-complete', result: { summary: '历史条目含护罩松动；站点时钟未知，不能判断当前正常', evidenceRefs: context.evidenceRefs, findings: [{ category: 'history_match', statement: '历史第0项为护罩松动', certainty: 'supported', basis: [{ evidenceRef: history.ref, entryIndexes: [0] }] }, { category: 'insufficient_evidence', statement: '仅模拟事件与未知时钟，不判断当前健康', certainty: 'unknown', basis: [{ evidenceRef: site.ref, sourceEventIds: [site.entries[0].sourceEventId] }] }], limitations: ['fixture不是现场事实', 'analysis仅读前16项，尾部未读'] } })
        }
      }
      captures.push({ agent, turn, body, tools: calls })
      response.writeHead(200, { 'content-type': 'text/event-stream' }); const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `evidence-${captures.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (calls.length) { send({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `tool-${captures.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }); send({}, 'tool_calls') }
      else { send({ role: 'assistant', content: newestInput ? '已收到本条新要求；旧证据未自动授读，未形成新版本分析。' : '已消费独立分析结果；来源为模拟资料，站点时间未知，不声称当前正常。' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = portServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  await new Promise((resolve, reject) => { api.stdout.on('data', bytes => { if (bytes.toString().includes('Geneway listening on')) resolve() }); api.stderr.on('data', bytes => errors.push(bytes.toString())); api.once('exit', code => reject(new Error(`API died ${code}`))) })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  for (const [agent, nodeId, resourceId, capability] of [['desktop-data', 'pc-a', 'fixture:history', 'evidence.history.read.v1'], ['gateway', 'gateway', 'fixture:site', 'evidence.site.inspect.v1'], ['desktop-office', 'pc-b', null, null], ['analysis', 'analysis', null, null]]) {
    const history = agent === 'desktop-data', root = join(directory, nodeId), sourceRoot = join(root, 'source'); await mkdir(sourceRoot, { recursive: true })
    const entries = Array.from({ length: 20 }, (_, index) => ({ date: '2026-11-01', description: index === 0 || index === 2 ? '护罩松动' : index === 1 ? '漏油' : `独立历史条目${index}`, owner: index === 1 ? '李工' : '张工' })), events = Array.from({ length: 20 }, (_, index) => ({ sourceEventId: `fixture-event-${index}`, sourceTimestamp: null, code: 'FIXTURE', severity: 'unknown', message: `现场受控事件${index}` }))
    const source = history ? { format: 'geneway.incident-history', version: 1, entries } : { sourceTime: null, health: { connection: 'unknown', lastSuccessAt: null, queueDepth: null }, events, privateMarker: 'GATEWAY_PRIVATE_MARKER_NOT_EXPORTED' }, bytes = Buffer.from(JSON.stringify(source))
    if (resourceId) await writeFile(join(sourceRoot, 'source.json'), bytes); await writeFile(join(sourceRoot, 'private.txt'), 'PRIVATE_SIBLING_NOT_MAPPED')
    oracle[agent] = { sourceSha256: hash(bytes), expectedItems: history ? entries : events, expectedQuality: history ? 'historical' : 'unknown' }
    const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: `pair-${nodeId}`, nodeId, siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [agent], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(root, 'profile.json')
    await writeFile(profile, JSON.stringify({ root, origin, maxActiveLoops: 1, pairing, evidenceProfile: { profileVersion: 1, resources: resourceId ? [{ resourceId, capabilityIds: [capability], adapterKind: history ? 'history_json' : 'site_snapshot_json', root: sourceRoot, datasets: { history: 'source.json' }, fixedFiles: { snapshot: 'source.json' }, allowedSections: ['collector_health', 'recent_events'], maxBytes: 65536, maxEntries: 200, maxWindowSeconds: 3600, exportToAgentIds: ['desktop-data', 'gateway', 'desktop-office', 'analysis'], clockTrust: 'fixture' }] : [] } }), { mode: 0o600 })
    const child = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child)
    const ready = await new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); if (message.kind === 'host-error') errors.push(message.code) }); child.once('exit', code => reject(new Error(`Host died ${code}`))) }); readyHosts.push(ready)
    if (resourceId) await command(`/api/admin/resources/${encodeURIComponent(resourceId)}`, { clientRequestId: `resource-${nodeId}`, expectedRevision: null, workspaceId: 'local', siteId: 'site', kind: history ? 'history_directory' : 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [capability], evidenceReaderAgentIds: ['desktop-data', 'gateway', 'desktop-office', 'analysis'], enabled: true }, 'PUT')
  }
  await writeFile(join(directory, 'oracle.json'), JSON.stringify(oracle, null, 2))
  if (budgetResume) {
    const modelPrices = [...new Map((await store.read()).modelRoutes.map(route => [JSON.stringify([route.provider, route.model]), { provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }])).values()]
    await command('/api/admin/budget-policies/native-simulated-prices', { clientRequestId: 'native-budget-policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'desktop-office', enabled: true, accountingMode: 'conservative_estimate', currency: 'CNY', limits: { maxModelRequests: 12, maxReservedTokens: 100000000, maxReservedCostMicros: 100000000 }, executionTimeoutMs: 300000, estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices }, 'PUT')
  }
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'desktop-office', goal: '两来源封存与显式授读，独立分析并实际消费回报。', clientRequestId: 'sharing-native', ...(budgetResume ? { budgetPolicyId: 'native-simulated-prices' } : {}) })
  if (budgetResume) {
    await until(async () => { const current = await store.read(); return current.budgetHolds.some(row => row.state === 'waiting' && row.idleAt) })
    const before = await store.read(), hold = before.budgetHolds[0], paused = JSON.parse(await readFile(join(directory, 'analysis/host-journal.json')))
    assert.equal(captures.length, 12); assert.equal(before.modelRequests.length, 12); assert.equal(before.works[0].status, 'waiting_budget'); assert.equal(paused.executions[0].waitStatus, 'waiting_budget'); assert.equal(paused.executions[0].slotHeld, false); assert(paused.inbox.some(row => row.command.operation === 'budget_wait' && row.budgetIdleAt)); assert(!before.modelRequests.some(row => row.id === hold.requestId))
    await writeFile(join(directory, 'budget-before-adjust.json'), JSON.stringify({ state: before, local: paused }, null, 2))
    if (budgetLatest) { pausedBudgetParent = children.at(-1); pausedBudgetParent.kill('SIGSTOP') }
    await command(`/api/admin/works/${work.id}/budget`, { clientRequestId: 'same-work-budget-adjust', expectedRevision: 1, reason: '原生同Work续行：模拟价，调用限从12明确调整20', limits: { maxModelRequests: 20, maxReservedTokens: 100000000, maxReservedCostMicros: 100000000 }, executionDeadlineAt: new Date(Date.now() + 300000).toISOString() })
    if (budgetLatest) {
      const queued = await store.read(); assert.equal(queued.budgetHolds[0].state, 'resume_queued'); const oldResume = queued.multisite.outbox.find(row => row.id === queued.budgetHolds[0].resumeCommandId).command
      await command(`/api/works/${work.id}/multisite/inputs`, { clientRequestId: 'budget-new-user-input', text: latestInputText })
      const superseded = await store.read(); assert.equal(superseded.budgetHolds[0].state, 'cancelled'); assert.equal(superseded.works[0].instructionRevision, 2); assert.equal(captures.filter(row => row.agent === 'analysis').length, 0)
      await writeFile(join(directory, 'queued-before-latest.json'), JSON.stringify({ queued, superseded }, null, 2)); pausedBudgetParent.kill('SIGCONT'); pausedBudgetParent = undefined
      await until(async () => { const current = await store.read(); return current.modelRequests.length === 14 && current.modelRequests.every(row => row.outcome === 'completed') && captures.some(row => row.agent === 'analysis') })
      const after = await store.read(); assert.equal(captures.length, 14); assert.deepEqual(after.multisite.attempts.map(row => row.session_id), before.multisite.attempts.map(row => row.session_id)); assert.equal(after.works[0].instructionRevision, 2); assert(!after.multisite.results.some(row => row.schema === 'geneway.analysis-result/1')); assert(!after.modelRequests.some(row => row.id === hold.requestId)); assert.equal(after.budgetHolds[0].cancelledReason, 'SUPERSEDED_BY_INPUT')
      for (const agent of ['desktop-office', 'analysis']) { const last = captures.filter(row => row.agent === agent).at(-1).body; assert(flatten(last.messages.findLast(row => row.role === 'user').content).startsWith(latestInputText)); assert.equal(after.modelRequests.filter(row => row.agent_id === agent && row.instructionRevision === 2).length, 1) }
      assert.deepEqual(captures.map(row => digest(row.body)).sort(), after.modelRequests.map(row => row.bodyDigest).sort())
      await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-latest-work' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
      const events = await sessionEvents(join(directory, 'analysis')), userMessages = events.filter(row => row.type === 'user/message'), input2 = after.multisite.inputs.find(row => row.workId === work.id && row.revision === 2), analysis = after.multisite.attempts.find(row => row.agent_id === 'analysis')
      assert.equal(userMessages.filter(row => row.data.id === messageId(input2.id, analysis.attempt_id, analysis.session_id)).length, 1); assert.equal(userMessages.filter(row => row.data.id === messageId(oldResume.input_id, analysis.attempt_id, analysis.session_id)).length, 0)
      await writeFile(join(directory, 'latest-after.json'), JSON.stringify({ state: after, analysisEvents: events }, null, 2)); const result = { result: 'passed', directory, workId: work.id, boundary: 'actual same native Work/Sessions; temporary SIGSTOP only fixture analysis parent after proven idle; queued resume superseded by genuine user Input2; no claim of revision2 analysis completion', providerBefore: 12, providerAfter: 14, oldNoForwardRequestNeverReserved: true, actualLatestInputProviderBodies: true, latestInputActualUserMessageOnce: true, queuedOldResumeNotDispatchedBeforeRevisionBarrier: true, oldAnalysisNotReplayedOrClaimedComplete: true, exactProviderLedgerDigests: true, actualStop: true }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
    } else {
    await until(async () => { const current = await store.read(); return current.multisite.messages.some(row => row.resultRef && current.multisite.results.find(result => result.id === row.resultRef)?.schema === 'geneway.analysis-result/1' && row.ingestedAt) && current.modelRequests.every(row => row.outcome === 'completed') && captures.filter(row => row.agent === 'desktop-office').length === 7 })
    const after = await store.read(), budget = after.works[0].modelRequestBudget, resumed = after.budgetHolds[0]
    assert.equal(resumed.state, 'resumed'); assert(resumed.resumeRequestId && resumed.resumeRequestId !== hold.requestId); assert(after.modelRequests.some(row => row.id === resumed.resumeRequestId && row.resumedFromHoldId === hold.id)); assert(!after.modelRequests.some(row => row.id === hold.requestId)); assert.equal(after.works[0].instructionRevision, 1)
    assert.deepEqual(after.multisite.attempts.map(row => row.session_id), before.multisite.attempts.map(row => row.session_id)); assert.deepEqual(after.multisite.results.filter(row => row.schema === 'geneway.delegation-result/1'), before.multisite.results)
    assert.equal(budget.policySnapshot.limits.maxModelRequests, 12); assert.equal(budget.limits.maxModelRequests, 20); assert.equal(budget.budgetRevision, 2); assert.deepEqual(captures.map(row => digest(row.body)).sort(), after.modelRequests.map(row => row.bodyDigest).sort()); assert.equal(captures.length, 15)
    assert.equal(after.multisite.questions[0].state, 'answered'); assert(after.multisite.messages.find(row => row.id === after.multisite.questions[0].answerMessageId).ingestedAt); assert(after.multisite.messages.some(row => row.kind === 'budget_resume' && row.ingestedAt)); assert(after.modelRequests.every(row => row.accountingVersion === 2 && row.usage === null && row.usageCostMicros === null))
    await writeFile(join(directory, 'budget-after-resume.json'), JSON.stringify(after, null, 2)); await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-resumed-work' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
    const result = { result: 'passed', directory, workId: work.id, boundary: 'actual production native same Work/4 Sessions: budget12 safe idle/flush hold then explicit admin20 resumes original analysis Session; synthetic provider and explicitly simulated prices, usage unknown', forwardRequestsBefore: 12, forwardRequestsAfter: captures.length, originalSessionIdsPreserved: true, originalNoForwardRequestNeverReserved: true, resumedRequestLinkedToHold: true, actualQuestionAnswerAndAnalysisResultConsumed: true, workUserRevision: 1, originalSourceResultsPreserved: true, exactProviderLedgerDigests: true, actualStop: true }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
    }
  } else if (controlRevoke) {
    await until(async () => { const current = await store.read(), bHost = JSON.parse(await readFile(join(directory, 'pc-b/host-journal.json'))); return current.multisite.questions[0]?.state === 'open' && current.modelRequests.filter(row => row.agent_id === 'gateway' && row.outcome === 'completed').length === 3 && bHost.executions[0]?.waitStatus === 'waiting_question' && bHost.executions[0]?.slotHeld === false })
    const before = await store.read(), beforeCount = captures.length, b = before.multisite.attempts.find(row => row.agent_id === 'desktop-office'), eventsBefore = await sessionEvents(join(directory, 'pc-b'))
    await command('/api/admin/nodes/gateway/revoke', { clientRequestId: 'revoke-question-target', expectedRevision: 1 })
    await until(async () => (await store.read()).multisite.messages.some(row => row.kind === 'question_closed' && row.controlConsumedAt))
    const after = await store.read(), local = JSON.parse(await readFile(join(directory, 'pc-b/host-journal.json'))), closure = after.multisite.messages.find(row => row.kind === 'question_closed'), eventsAfter = await sessionEvents(join(directory, 'pc-b'))
    assert.equal(captures.length, beforeCount); assert.equal(after.modelRequests.length, before.modelRequests.length); assert.equal(after.works[0].status, 'interrupted'); assert(!closure.ingestedAt && !closure.deliveredAt); assert.notEqual(local.executions[0].waitStatus, 'waiting_question'); assert.equal(local.executions[0].slotHeld, false); assert(local.inbox.some(row => row.controlConsumedAt && row.command.parameters.messages?.[0].id === closure.id))
    const usersBefore = eventsBefore.filter(row => row.type === 'user/message'), usersAfter = eventsAfter.filter(row => row.type === 'user/message'); assert(usersBefore.length > 0); assert.deepEqual(usersAfter, usersBefore); const originalInput = before.multisite.inputs.find(row => row.workId === work.id && row.revision === 1); assert.equal(usersBefore[0].data.id, messageId(originalInput.id, b.attempt_id, b.session_id)); assert.equal(usersBefore[0].data.content[0].text, originalInput.text)
    const identity = JSON.parse(await readFile(join(directory, 'pc-b/node-identity.json'))), client = createRemoteClient({ origin, identity })
    await assert.rejects(client.post('/internal/executions/authorize', { binding: binding(b) }), { code: 'FORBIDDEN' })
    await until(async () => (await store.read()).multisite.attempts.find(row => row.agent_id === 'gateway').status === 'cancelled')
    await writeFile(join(directory, 'control-boundary.json'), JSON.stringify({ before, after, local, eventsBefore, eventsAfter }, null, 2))
    assert.deepEqual(captures.map(row => digest(row.body)).sort(), after.modelRequests.map(row => row.bodyDigest).sort())
    await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-control-trace' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
    const result = { result: 'passed', directory, workId: work.id, boundary: 'actual native parked B/Node G revoke; independent Host control receipt, never DSH user message or new model turn', providerForwardsBeforeRevoke: beforeCount, providerForwardsAfterRevoke: captures.length, controlConsumedWithoutModelIngestion: true, actualSessionUserMessagesBefore: usersBefore.length, actualSessionUserMessagesAfter: usersAfter.length, exactWaitReleased: true, interruptedBusinessAuthorizeStillDenied: true, actualSourceStoppedAndWorkCancelled: true }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else if (withQuestion) {
    await until(async () => { const state = await store.read(); return !!state.works[0].modelRequestBudget.exhaustedAt && state.modelRequests.every(row => row.outcome !== 'in_flight') })
    const limited = await store.read(), question = limited.multisite.questions[0]
    assert.equal(limited.works[0].modelRequestBudget.reserved, 12); assert(question && question.state === 'answered'); assert(limited.multisite.messages.find(row => row.id === question.messageId)?.ingestedAt); assert(limited.multisite.messages.find(row => row.id === question.answerMessageId)?.ingestedAt)
    assert.equal(captures.length, 12); assert.deepEqual(captures.map(row => digest(row.body)).sort(), limited.modelRequests.map(row => row.bodyDigest).sort())
    const unfinished = { analysisResult: limited.multisite.results.some(row => row.schema === 'geneway.analysis-result/1'), perAgentCalls: Object.fromEntries(['desktop-office', 'desktop-data', 'gateway', 'analysis'].map(agent => [agent, captures.filter(row => row.agent === agent).length])), attemptStates: limited.multisite.attempts.map(row => ({ agent: row.agent_id, status: row.status })) }
    await writeFile(join(directory, 'budget-boundary.json'), JSON.stringify({ state: limited, unfinished }, null, 2))
    await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-budget-trace' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
    const result = { result: 'budget_limited', directory, workId: work.id, boundary: 'actual same-Work production native trace including directed ask/answer; incomplete analysis/business at unchanged budget12, not a completion claim', actualForwardRequests: captures.length, sharedWorkBudgetLimit: 12, actualQuestionAndAnswerConsumed: true, exactProviderLedgerDigests: true, unfinished, actualStop: true }
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  } else {
  await until(async () => { const state = await store.read(); return captures.length === 12 && state.modelRequests.length === 12 && state.modelRequests.every(row => row.outcome === 'completed') && state.multisite.messages.some(row => row.resultRef && state.multisite.results.find(result => result.id === row.resultRef)?.schema === 'geneway.analysis-result/1' && row.ingestedAt) })
  const state = await store.read(); assert.equal(state.evidence.length, 2); assert.equal(state.works[0].modelRequestBudget.reserved, 12); assert.equal(state.multisite.questions.length, 0)
  const b = state.multisite.attempts.find(row => row.agent_id === 'desktop-office'); assert.deepEqual(b.resource_refs, []); assert(!b.grant.execution.capabilityIds.some(cap => cap.startsWith('evidence.')))
  for (const ready of readyHosts) { const local = JSON.parse(await readFile(join(ready.root, 'host-journal.json'))), identity = JSON.parse(await readFile(join(ready.root, 'node-identity.json'))); assert(!JSON.stringify(local).includes(identity.credential)); assert(!JSON.stringify(captures).includes(identity.credential)) }
  const pagesFor = agent => captures.filter(row => row.agent === agent).at(-1).body.messages.filter(row => row.role === 'tool').map(row => { try { return JSON.parse(flatten(row.content)) } catch { return null } }).filter(row => row?.schema && row.entries)
  for (const agent of ['desktop-office', 'analysis']) for (const schema of ['geneway.incident-history/1', 'geneway.site-snapshot/1']) {
    const pages = pagesFor(agent).filter(row => row.schema === schema), source = oracle[schema.includes('history') ? 'desktop-data' : 'gateway']
    assert.equal(pages.length, agent === 'desktop-office' ? 2 : 1)
    const uniquePages = [...new Map(pages.map(page => [JSON.stringify(page.entries), page])).values()]
    assert.deepEqual(uniquePages.flatMap(page => page.entries).map(({ entryIndex, ...entry }) => entry), source.expectedItems.slice(0, agent === 'desktop-office' ? 20 : 16))
  }
  for (const row of state.evidence) { assert.equal(row.sourceSha256, oracle[row.producerBinding.agent_id].sourceSha256); assert.equal(hash(await readFile(join(apiRoot, 'evidence', row.id))), row.sha256) }
  assert(!JSON.stringify(captures).includes('PRIVATE_MARKER_NOT_EXPORTED')); assert(!JSON.stringify(captures).includes('PRIVATE_SIBLING_NOT_MAPPED')); assert(!JSON.stringify(captures).includes('\ufffd'))
  assert.deepEqual(captures.map(row => digest(row.body)).sort(), state.modelRequests.map(row => row.bodyDigest).sort()); assert.equal(new Set(state.multisite.attempts.map(row => row.session_id)).size, 4)
  assert.equal(state.multisite.messages.filter(row => row.kind === 'observation').length, 3)
  await command(`/api/works/${work.id}/multisite/cancel`, { clientRequestId: 'stop-native' }); await until(async () => (await store.read()).works[0].status === 'cancelled')
  assert.deepEqual(errors, []); const result = { result: 'passed', directory, workId: work.id, boundary: 'actual production API/four independent native DSH parents and Sessions; synthetic provider; same Work sharing/analysis trace, no question in this trace', actualForwardRequests: 12, sharedWorkBudgetLimit: 12, exactProviderLedgerDigests: true, bNoCaptureAuthority: true, bActuallyReadBoth20ItemSources: true, analysisActuallyReadBothFirst16AndSubmittedFixedResult: true, bActuallyConsumedAnalysisResult: true, threeActualObservations: true, questionsInThisTrace: 0, actualStop: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
  }
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, stack: cause.stack, errors }, null, 2)); throw cause }
finally { if (pausedBudgetParent) pausedBudgetParent.kill('SIGCONT'); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }; if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }; await writeFile(join(directory, 'capture.json'), JSON.stringify({ captures, errors }, null, 2)); console.log('Evidence native root:', directory) }
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function until(predicate) { const deadline = Date.now() + 90000; while (!await predicate()) { assert(Date.now() < deadline, `Evidence native timed out: ${errors.slice(-5)}`); await new Promise(resolve => setTimeout(resolve, 100)) } }

async function sessionEvents(root) {
  async function find(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) { const result = await find(child); if (result) return result } else if (entry.name === 'session.v4.jsonl.zstd') return child } }
  const path = await find(join(root, 'multisite-executions'))
  const { stdout } = await promisify(execFile)('zstd', ['-dc', '--', path], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  return stdout.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
}
