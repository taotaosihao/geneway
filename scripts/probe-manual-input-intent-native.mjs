import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileStore } from '../src/store/file-store.mjs'
import { initializeAuthFile } from '../src/auth.mjs'
import { digest } from '../packages/agent-contracts/index.mjs'

const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/manual-control-native-'), apiRoot = join(directory, 'api'), children = [], captures = [], errors = []
const sourceRoot = '/home/gewu/.codex/task-checkpoints/geneway-evidence/spreadsheet-remote-native-CWwNtz'
const flatten = value => typeof value === 'string' ? value : value.filter(block => block.type === 'text').map(block => block.text).join('')
let origin, session, provider, store, workId
const mode = 'input-intent'
try {
  await mkdir(apiRoot); const old = JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')); store = createFileStore(join(apiRoot, 'state.json'))
  await store.update(() => structuredClone(old)); await cp(join(sourceRoot, 'artifacts'), join(apiRoot, 'artifacts'), { recursive: true })
  await initializeAuthFile(join(apiRoot, 'auth.json'), { owner: 'synthetic owner password', peer: 'synthetic peer password' }, { mode: 'create', allowedMemberIds: ['owner', 'peer'] })
  await mkdir(join(apiRoot, 'secrets')); await writeFile(join(apiRoot, 'secrets/key'), 'synthetic-manual-native', { mode: 0o600 }); await writeFile(join(apiRoot, 'connection-catalog.json'), JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
  provider = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(request.headers.authorization, 'Bearer synthetic-manual-native')
      const index = body.messages.findLastIndex(row => row.role === 'user'), input = flatten(body.messages[index].content), tail = body.messages.slice(index + 1).filter(row => row.role === 'tool'), review = input.includes('当前附加意图判断用途') || !!body.tools?.length && body.tools.every(row=>row.function.name.includes('intent'))
      const capture = { body, review, tool: null, capturedAt: new Date().toISOString() }; captures.push(capture)
      let tool, parameters, content
      if (review) {
        assert(body.tools.every(row => row.function.name.includes('intent')))
        if (!tail.length) { tool = 'geneway_intent_context'; parameters = { clientRequestId: 'manual-context-' + captures.length } }
        else { const context = JSON.parse(flatten(tail.at(-1).content)); tool = 'geneway_accept_intent'; parameters = { clientRequestId: 'manual-accept-' + captures.length, expectedInstructionRevision: context.currentWork.instructionRevision } }
      } else if (!captures.some(row => row.tool === 'geneway_accept_intent')) content = '已读取正式当前要求，等待独立请求的受限判断。'
      else {
        if (!tail.length) { tool = 'geneway_multisite_report'; parameters = { state: 'ready', summary: '已在原Session消费解除后当前正式要求；未生成文件。' } }
        else content = '已完成本轮获准核对。'
      }
      capture.tool = tool ?? null
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'manual-tool-' + captures.length, type: 'function', function: { name: tool, arguments: JSON.stringify(parameters) } }] } : { role: 'assistant', content }
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } catch (cause) { errors.push(cause.stack); response.writeHead(500); response.end('{}') }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const reservation = reservePort(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`
  const api = fork(fileURLToPath(new URL('./fixtures/multisite/production-service.mjs', import.meta.url)), [], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: apiRoot, GENEWAY_STATE: join(apiRoot, 'state.json'), GENEWAY_AUTH_FILE: join(apiRoot, 'auth.json'), GENEWAY_SECRET_ROOT: join(apiRoot, 'secrets'), GENEWAY_MODEL_CREDENTIAL_REF: 'key', GENEWAY_CONNECTION_CATALOG: join(apiRoot, 'connection-catalog.json'), GENEWAY_DSH_HOME: join(apiRoot, 'unused-dsh'), GENEWAY_MULTISITE_HOST_MODE: 'remote', GENEWAY_PORT: String(port), GENEWAY_TRUSTED_ORIGIN: origin, GENEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${provider.address().port}/v1` }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(api)
  const apiOut = [], apiErr = []; api.stdout.on('data', bytes => apiOut.push(bytes)); api.stderr.on('data', bytes => apiErr.push(bytes))
  await until(async () => { try { return (await fetch(origin)).ok } catch { return false } })
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'owner', password: 'synthetic owner password' }) }); session = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] }
  await command('/api/admin/employees/coordinator', { expectedRevision: 1, placement: { nodeId: 'cloud', mode: 'agent_host', resourceRefs: [] }, multisitePolicy: { execution: { capabilityIds: ['collaboration.coordinate.v1'], resourceRefs: [] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } }, 'PATCH')
  const budget = { workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 20, maxReservedTokens: 2000000, maxReservedCostMicros: 1000 }, executionTimeoutMs: 180000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 0 }, modelPrices: old.modelRoutes.filter(row => row.enabled).map(row => ({ provider: row.provider, model: row.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 })) }
  await command('/api/admin/budget-policies/manual-native', { ...budget, clientRequestId: 'policy', expectedRevision: null }, 'PUT')
  const hostRoot = join(directory, 'cloud'); await mkdir(hostRoot)
  const pairing = await command('/api/admin/nodes/pairings', { clientRequestId: 'pair-cloud', nodeId: 'cloud', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: ['coordinator'], expiresAt: new Date(Date.now() + 120000).toISOString() }), profile = join(hostRoot, 'profile.json')
  await writeFile(profile, JSON.stringify({ root: hostRoot, origin, pairing, maxActiveLoops: 1 }), { mode: 0o600 })
  const host = fork(fileURLToPath(new URL('../packages/agent-host/remote.mjs', import.meta.url)), [profile], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: hostRoot }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(host)
  const hostOut = [], hostErr = []; host.stdout.on('data', bytes => hostOut.push(bytes)); host.stderr.on('data', bytes => hostErr.push(bytes)); host.on('message', message => { if (message.kind === 'host-error') errors.push(message.code) })
  await new Promise((resolve, reject) => { host.on('message', message => { if (message.kind === 'ready') resolve() }); host.once('exit', code => reject(Error('Host startup exit ' + code))) })
  const work = await command('/api/works', { workType: 'multisite', employeeId: 'coordinator', budgetPolicyId: 'manual-native', goal: '人工控制原生验收：沿原上下文核对，不生成新文件。', clientRequestId: 'create' }); workId = work.id
  await until(async () => captures.length === 1 && (await store.read()).modelRequests.filter(row => row.work_id === workId).every(row => row.outcome === 'completed'))
  const before = await store.read(), original = before.multisite.attempts.find(row => row.work_id === workId)
  await command(`/api/works/${workId}/multisite/pause`, { clientRequestId: 'pause-before-source', scope: { kind: 'work' }, expectedControlGeneration: 0 })
  await until(async () => (await store.read()).manualControls[0]?.holders.every(row => row.idleAt))
  const thread = await command('/api/interaction/threads', { clientRequestId: 'thread' }), source = await command(`/api/interaction/threads/${thread.id}/events`, { clientRequestId: 'independent-s', sourceEventId: 'independent-s', version: 1, expectedThreadRevision: 1, routingPolicyId: null, text: '独立S：核对第二版要求后，明确判断本项附加工作。' }), catalog = await get('/api/interaction/directory')
  await command(`/api/interaction/threads/${thread.id}/selection`, { clientRequestId: 'choose-s', intentId: source.intentId, expectedRouteRevision: 1, targetWorkId: workId, candidateVersion: catalog.candidateVersion, offset: 0 })
  const attached = await store.read(), oldCommand = attached.multisite.outbox.find(row => row.command.parameters.intentFence?.intentId === source.intentId).command, oldSubscription = attached.contextSubscriptions.find(row => row.intentId === source.intentId)
  assert.equal(oldSubscription.lifecycle, 'paused'); assert.equal(oldSubscription.ingestedAt, null)
  await command(`/api/works/${workId}/multisite/inputs`, { clientRequestId: 'formal-input2', text: '正式Input2：保留独立S，但先核对最新要求；不生成文件。' })
  const paused = await store.read(); assert.equal(paused.works.find(row => row.id === workId).instructionRevision, 2); assert.equal(captures.length, 1)
  await writeFile(join(directory, 'paused-input2.json'), JSON.stringify(paused, null, 2))
  await command(`/api/works/${workId}/multisite/resume`, { clientRequestId: 'resume-current', scope: { kind: 'work' }, expectedControlGeneration: 1 })
  console.log(JSON.stringify({ stage: 'resume after paused independent S and formal Input2', directory, origin, pid: process.pid, parents: children.map(row => row.pid) }))
  await until(async () => { const state = await store.read(); return state.works.find(row => row.id === workId).instructionRevision === 3 && state.multisite.attempts.find(row => row.work_id === workId)?.report?.state === 'ready' && state.modelRequests.filter(row => row.work_id === workId).every(row => row.outcome === 'completed') })
  const after = await store.read(), current = after.multisite.attempts.find(row => row.work_id === workId), intent = after.workIntents.find(row => row.id === source.intentId), ledger = after.modelRequests.filter(row => row.work_id === workId)
  assert.equal(current.attempt_id, original.attempt_id); assert.equal(current.session_id, original.session_id); assert.equal(intent.state, 'accepted'); assert.equal(after.multisite.inputs.filter(row => row.workId === workId).length, 3)
  assert.equal(after.contextSubscriptions.find(row => row.id === oldSubscription.id).ingestedAt, null); assert.equal(after.contextSubscriptions.find(row => row.id === oldSubscription.id).lifecycle, 'released')
  assert(!ledger.some(row => row.intentReviewCommandId === oldCommand.command_id)); const reviews = ledger.filter(row => row.purpose === 'intent_review'); assert(reviews.length >= 2); assert(reviews.every(row => row.instructionRevision === 2 && row.intentFence.subscriptionRevision === oldSubscription.revision + 1))
  assert(captures.some(row => row.review && row.tool === 'geneway_intent_context' && JSON.stringify(row.body).includes('独立S：'))); assert(captures.some(row => row.review && row.tool === 'geneway_accept_intent'))
  assert.deepEqual(ledger.map(row => row.bodyDigest).sort(), captures.map(row => digest(row.body)).sort())
  await writeFile(join(directory, 'after-resume.json'), JSON.stringify(after, null, 2)); await writeFile(join(directory, 'old-review-command.json'), JSON.stringify(oldCommand, null, 2))
  await command(`/api/works/${workId}/multisite/cancel`, { clientRequestId: 'cancel' }); await until(async () => (await store.read()).works.find(row => row.id === workId).status === 'cancelled')
  await writeFile(join(directory, 'api.stdout.txt'), Buffer.concat(apiOut)); await writeFile(join(directory, 'api.stderr.txt'), Buffer.concat(apiErr)); await writeFile(join(directory, 'host.stdout.txt'), Buffer.concat(hostOut)); await writeFile(join(directory, 'host.stderr.txt'), Buffer.concat(hostErr))
  const result = { result: 'passed', directory, mode, workId, threadId: thread.id, actualModelForwards: captures.length, sameAttemptAndSession: true, currentInput2ThenRestrictedOriginalSourceReview: true, oldReviewNeverForwarded: true, sourceAcceptedExplicitlyByActualSdkTool: true, input3Once: true, boundary: 'real production API/remote parent/official DSH/actual HTTP provider; simulated provider decisions, no UI or model semantic quality claim' }; await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ stack: cause.stack, errors }, null, 2)); throw cause }
finally {
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  if (store) await writeFile(join(directory, 'state-final.json'), JSON.stringify(await store.read(), null, 2)); await writeFile(join(directory, 'provider-bodies.json'), JSON.stringify(captures, null, 2));await writeFile(join(directory,'observed-errors.json'),JSON.stringify(errors,null,2)); console.log('Manual native root:', directory)
}
async function command(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), value = await response.json(); assert(response.ok, JSON.stringify(value)); return value }
async function get(path) { const response = await fetch(origin + path, { headers: { cookie: session.cookie } }); assert(response.ok); return response.json() }
async function until(test) { const deadline = Date.now() + 45000; while (!await test()) { assert(Date.now() < deadline, 'Manual native timeout: ' + errors.slice(-4)); await new Promise(resolve => setTimeout(resolve, 100)) } }
