import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createDshRunner } from '../src/dsh-runner.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const root = process.cwd(), home = await mkdtemp(join(tmpdir(), 'geneway-native-sessions-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_MODE = 'DISABLED'
const requestKey = 'native-session-probe-key'
const route = { provider: 'zenmux', model: readRuntimeConfig({}).model.model, maxTokens: 256 }
const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const patch = join(home, 'capture.patch.yml'), handles = new Set()
let capture, runProfile, createUserMessage, providerPatch, environment, runtime, failure, report
try {
  capture = await startCapture()
  process.env.GENEWAY_P3_CAPTURE_BASE_URL = `${capture.address}/v1`
  runProfile = (await import('@deepseek-ai/dsh/profile-boot')).runProfile
  createUserMessage = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)).createUserMessage
  providerPatch = `- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local controlled capture\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: ${capture.address}/v1\n        models:\n          - id: ${route.model}\n            contextWindow: 200000\n            maxOutputTokens: 8192\n`
  const values = { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', ZENMUX_API_KEY: requestKey, GENEWAY_P3_CAPTURE_BASE_URL: `${capture.address}/v1`, GENEWAY_P3_CAPTURE_KEY: requestKey }
  environment = { get: name => values[name] === undefined ? undefined : { value: values[name], source: 'process' }, getFrom: (name, sources) => sources.includes('process') && values[name] !== undefined ? { value: values[name], source: 'process' } : undefined }
  await writeFile(patch, `- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n${providerPatch}`, { mode: 0o600 })
  const surfaces = []
  for (const name of ['p1-runtime', 'p3-runtime', 'p3-delegation']) {
    runtime = await boot(name)
    const tools = runtime.ctx.tools.schemas().map(tool => tool.name).sort()
    assert.deepEqual(tools, name === 'p1-runtime' ? ['geneway_calculate_cycle_time', 'geneway_correlate_work_order_device', 'geneway_gearjob_read_work_order'] : [])
    const entries = [...runtime.ctx.loader.entries()]
    for (const id of ['session-log-deepseek', 'otel', 'session-telemetry-otel', 'command-feedback', 'tool-fs', 'tool-bash', 'tool-web', 'settings', 'config-editor', 'workspace-dependencies', 'skill-office']) assert.equal(entries.find(entry => entry.options.id === id)?.disabled, true, `${name}: ${id}`)
    for (const service of ['otel', 'sessionTelemetry', 'sessionFeedback', 'commands']) assert.equal(runtime.ctx.get(service), undefined, `${name}: ${service}`)
    assert.deepEqual([...runtime.ctx.deepseekLlmApiExtensions.providers.keys()], [])
    surfaces.push({ name, tools, activePlugins: entries.filter(entry => !entry.disabled && entry.fiber?.state === 2).map(entry => ({ id: entry.id, name: entry.options.name })).sort((a, b) => a.id.localeCompare(b.id)) })
    await runtime.shutdown.shutdown(0); runtime = undefined
  }
  const cycle = await productCycle()
  runtime = await boot('p3-runtime')
  assert.deepEqual(runtime.ctx.tools.schemas(), [])
  const first = await create('chat-first'), second = await create('chat-second')
  await turn(first.agent, 'SESSION_CANARY_A: remember this local synthetic marker.')
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_A'), true)
  await turn(first.agent, 'Continue the same local conversation.')
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_A'), true)
  await turn(second.agent, 'SESSION_CANARY_B: a separate local conversation.')
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_A'), false)
  const successor = await create('chat-successor')
  await turn(successor.agent, 'New instructions; start with only this current message.')
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_A'), false)
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_B'), false)
  const id = first.agent.id
  await runtime.ctx.sessionPersistence.flush()
  const liveHistory = await inspect(id)
  assert.equal(liveHistory.events.filter(event => event.type === 'user/message').length, 2)
  await closeHost()
  runtime = await boot('p3-runtime')
  const stored = await runtime.ctx.sessionPersistence.list()
  assert(stored.some(item => item.header.id === id))
  const reopened = await inspect(id)
  assert.equal(reopened.events.filter(event => event.type === 'user/message').length, 2)
  const resumed = await runtime.ctx.agents.resume({ resumeSessionId: id, agentOptions: route })
  handles.add(resumed)
  await turn(resumed.agent, 'Continue after the Host restarted.')
  assert.equal(capture.requests.at(-1).serialized.includes('SESSION_CANARY_A'), true)
  const cancelled = await create('chat-cancel'), independent = await create('chat-independent')
  cancelled.agent.followup(message('HOLD_CURRENT_TURN'))
  await capture.waitForHeld()
  await turn(independent.agent, 'The independent Agent should finish normally.')
  cancelled.agent.cancel({ kind: 'user' })
  await cancelled.agent.whenIdle()
  assert.equal(cancelled.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'aborted')
  assert.equal(independent.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
  await turn(cancelled.agent, 'A later turn remains usable after cancellation.')
  await runtime.ctx.sessionPersistence.flush()
  for (const snapshot of await runtime.ctx.sessionPersistence.list()) assert.equal(JSON.stringify(await inspect(snapshot.header.id)).includes(requestKey), false, 'a synthetic model credential reached the native Session log')
  await closeHost()
  const legacy = await legacyHistory()
  assert(capture.requests.every(request => request.model === route.model && !request.sessionLogAttached && !request.credentialLeak))
  report = { ok: true, dshVersion: requireFromDsh('@deepseek-ai/dsh/package.json').version, provider: route.provider, model: route.model, surfaces, productCycle: cycle, chat: { workMetadataRequired: false, businessTools: [], sameSessionContinued: true, separateSessionClean: true, successorClean: true, nativeHistoryReadable: true, hostRestartResume: true, cancelCurrentAgentOnly: true, independentAgentCompleted: true, nextTurnAfterCancel: true, sessionCredentialCanaryLeaks: 0 }, legacy, outbound: { recipient: '127.0.0.1', requests: capture.requests.length, authorizationPresent: capture.requests.every(request => request.authorizationPresent), sessionLogAttachments: 0, credentialCanaryLeaks: 0, requestFields: [...new Set(capture.requests.flatMap(request => request.fields))].sort() } }
} catch (error) {
  failure = error
} finally {
  for (const cleanup of [closeHost, () => capture?.close(), () => rm(home, { recursive: true, force: true })]) {
    try { await cleanup() }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'native Session probe and cleanup failed', { cause: failure }) : error }
  }
}
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))

function boot(name) { return runProfile({ environment, profile: 'sdk', patchFiles: [join(root, 'config', `${name}.patch.yml`), patch], args: [] }) }
function message(text) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
async function create(id) { const handle = await runtime.ctx.agents.create({ sessionId: `${id}-${randomUUID()}`, meta: { cwd: root }, agentOptions: route }); handles.add(handle); return handle }
async function turn(agent, text) {
  const before = agent.session.snapshotEvents().length
  agent.followup(message(text))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents().slice(before)
  assert.equal(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
  assert.equal(events.some(event => event.type === 'tool/call'), false)
  assert(events.some(event => event.type === 'assistant/message'))
}
async function inspect(id) { const handle = await runtime.ctx.sessionPersistence.open(id, 'read'); try { return { header: handle.header, ...(await handle.read()) } } finally { await handle.close() } }
async function closeHost() {
  const results = await Promise.allSettled([...handles].map(handle => handle.dispose()))
  handles.clear()
  if (runtime) results.push(...await Promise.allSettled([runtime.shutdown.shutdown(0)]))
  runtime = undefined
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, 'native Host cleanup failed')
}

async function productCycle() {
  const secretRoot = join(home, 'secrets'), stateFile = join(home, 'state.json')
  await mkdir(secretRoot, { mode: 0o700 })
  await writeFile(join(secretRoot, 'model.key'), requestKey, { mode: 0o600 })
  const config = readRuntimeConfig({ GENEWAY_DSH_HOME: home, GENEWAY_SECRET_ROOT: secretRoot, GENEWAY_MODEL_CREDENTIAL_REF: 'model.key', GENEWAY_STATE: stateFile }, root)
  const sdkPatch = join(home, 'sdk-capture.patch.yml')
  await writeFile(sdkPatch, providerPatch, { mode: 0o600 })
  const store = createFileStore(stateFile)
  await store.update(state => ({ ...state, members: [{ id: 'member', loginName: 'member', displayName: 'Member', role: 'member', enabled: true, authRef: 'member', sessionVersion: 1, employeeIds: ['agent'] }], modelRoutes: [{ id: 'route', provider: route.provider, model: route.model, credentialRef: 'ZENMUX_API_KEY', enabled: true }], employees: [{ id: 'agent', name: 'Agent', enabled: true, modelRouteId: 'route', skillIds: ['skill-cycle-time-calculate'], connectionIds: [] }], skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true }] }))
  const runner = createDshRunner({ root, config, harnessFactory: options => new DeepSeekHarness({ ...options, patches: [...options.patches, sdkPatch], env: { ...options.env, ...Object.fromEntries(['NODE_OPTIONS', 'GENEWAY_NETWORK_AUDIT_LOG', 'GENEWAY_NETWORK_SECRET_CANARY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) } }) })
  let executionError
  const service = createWorkService({ store, runner: { ...runner, async run(...args) { try { return await runner.run(...args) } catch (error) { executionError = error; throw error } } }, policyPaths: { stateFile, dataRoot: home, secretRoot } })
  try {
    const created = await service.createWork({ id: 'member' }, { employeeId: 'agent', skillId: 'skill-cycle-time-calculate', input: { availableSeconds: 60, quantity: 2 }, clientRequestId: 'native-cycle' })
    assert.equal(created.ok, true)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const work = (await service.getWork({ id: 'member' }, created.value.id)).value
      if (work.status === 'completed') { assert.equal(work.results[0].payload.secondsPerUnit, 30); return { nativeSdk: true, typedSecondsPerUnit: 30, tools: capture.requests.find(request => request.toolNames.length)?.toolNames } }
      if (work.status === 'failed') throw executionError ?? new Error(JSON.stringify(work.executions.at(-1)?.error))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('product SDK cycle timed out')
  } finally { await service.close() }
}

async function legacyHistory() {
  const at = process.argv.indexOf('--legacy-backup')
  if (at < 0) return { checked: false, reason: 'provide the explicit current-product pre-upgrade backup' }
  const backup = resolve(process.argv[at + 1]), manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  const files = manifest.entries.filter(entry => entry.source.startsWith('var/dsh/sessions/') && /session\.v\d+\.jsonl(?:\.(?:gz|zstd))?$/.test(entry.source))
  assert(files.length > 0, 'explicit pre-upgrade backup contains no native Session artifact')
  const ids = []
  for (const file of files) {
    const suffix = relative('var/dsh/sessions', file.source)
    assert(!suffix.startsWith('..'))
    const source = join(backup, 'dsh', 'sessions', suffix), target = join(home, 'sessions', suffix)
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target)
    ids.push(dirname(suffix).split('/').at(-1))
  }
  runtime = await boot('p3-runtime')
  const results = []
  for (const id of ids) {
    try { const read = await inspect(id); results.push({ sessionIdSha256: createHash('sha256').update(id).digest('hex'), status: 'readable', decodedVersion: read.header.version, eventCount: read.events.length }) }
    catch (error) { results.push({ sessionIdSha256: createHash('sha256').update(id).digest('hex'), status: 'unavailable', code: error.code ?? error.name }) }
  }
  assert.equal(results.length, files.length)
  return { checked: true, sourceFiles: files.length, nativeDecoder: true, results }
}

async function startCapture() {
  const requests = []
  let held
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), serialized = JSON.stringify(body), toolNames = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort()
    requests.push({ serialized, model: body.model, fields: Object.keys(body), toolNames, authorizationPresent: Boolean(request.headers.authorization), sessionLogAttached: Object.hasOwn(body, 'dsh_session_log'), credentialLeak: serialized.includes('native-session-probe-key') })
    if (body.messages.at(-1)?.role === 'user' && JSON.stringify(body.messages.at(-1).content).includes('HOLD_CURRENT_TURN')) { held = response; return }
    const cycle = toolNames.includes('geneway_calculate_cycle_time') && !body.messages.some(message => message.role === 'tool')
    const id = `capture-${randomUUID()}`, send = delta => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, ...delta }] })}\n\n`)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    send({ delta: { role: 'assistant' }, finish_reason: null })
    send({ delta: cycle ? { tool_calls: [{ index: 0, id: 'cycle-call', type: 'function', function: { name: 'geneway_calculate_cycle_time', arguments: JSON.stringify({ availableSeconds: 60, quantity: 2 }) } }] } : { content: 'LOCAL_OK' }, finish_reason: null })
    send({ delta: {}, finish_reason: cycle ? 'tool_calls' : 'stop' })
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { address: `http://127.0.0.1:${server.address().port}`, requests,
    async waitForHeld() { const deadline = Date.now() + 5000; while (!held) { assert(Date.now() < deadline, 'cancel request not captured'); await new Promise(resolve => setTimeout(resolve, 10)) } },
    close: () => { held?.destroy(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) },
  }
}
