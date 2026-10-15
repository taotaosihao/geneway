import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createCollaborationRunner } from '../src/collaboration-runner.mjs'
import { readRuntimeConfig } from '../src/runtime-config.mjs'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { createUserMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const root = process.cwd(), home = await mkdtemp(join(tmpdir(), 'geneway-model-credentials-'))
const saved = Object.fromEntries(['HOME', 'DSH_HOME', 'GENEWAY_MODEL_CREDENTIAL_REF', 'GENEWAY_SECRET_ROOT', 'ZENMUX_API_KEY'].map(key => [key, process.env[key]]))
const storedKey = 'synthetic-unreferenced-native-stored-key', explicitKey = 'synthetic-referenced-native-key', model = readRuntimeConfig({}).model.model
const capture = createServer(async (request, response) => {
  calls += 1
  let raw = ''; for await (const chunk of request) raw += chunk
  credentialInPayload ||= raw.includes(storedKey) || raw.includes(explicitKey)
  authorizationMatchesExplicit = request.headers.authorization === `Bearer ${explicitKey}`
  if (!positive) { response.writeHead(500); response.end('unexpected model request'); return }
  const id = `capture-${randomUUID()}`, send = (delta, finishReason) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  send({ role: 'assistant', content: 'LOCAL_CREDENTIAL_OK' }, null)
  send({}, 'stop')
  response.end('data: [DONE]\n\n')
})
let calls = 0, positive = false, credentialInPayload = false, authorizationMatchesExplicit = false, ctx, runner, service, rootHandle, failure, report
try {
  process.env.HOME = home
  process.env.DSH_HOME = home
  process.env.GENEWAY_SECRET_ROOT = join(home, 'secrets')
  delete process.env.GENEWAY_MODEL_CREDENTIAL_REF
  delete process.env.ZENMUX_API_KEY
  await mkdir(join(home, 'secrets'), { mode: 0o700 })
  await writeFile(join(home, '.credentials.yaml'), `ZENMUX_API_KEY: ${storedKey}\n`, { mode: 0o600 })
  await new Promise((resolve, reject) => { capture.once('error', reject); capture.listen(0, '127.0.0.1', resolve) })
  const patch = join(home, 'capture.patch.yml')
  await writeFile(patch, `- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      zenmux:\n        displayName: Local negative capture\n        api: openai-completions\n        apiKeyEnv: ZENMUX_API_KEY\n        baseURL: http://127.0.0.1:${capture.address().port}/v1\n        models:\n          - id: ${model}\n            contextWindow: 200000\n            maxOutputTokens: 4096\n`, { mode: 0o600 })
  const store = createFileStore(join(home, 'state.json')), actor = { id: 'member' }
  await store.update(state => ({ ...state,
    members: [{ id: actor.id, loginName: 'member', displayName: 'Member', role: 'member', enabled: true, authRef: actor.id, sessionVersion: 1, employeeIds: ['agent'] }],
    modelRoutes: [{ id: 'route', provider: 'zenmux', model, credentialRef: 'ZENMUX_API_KEY', enabled: true }],
    employees: [{ id: 'agent', name: 'Agent', enabled: true, modelRouteId: 'route', skillIds: ['skill-cycle-time-calculate'], connectionIds: [] }],
    skills: [{ id: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', enabled: true }],
  }))
  const runProfileImpl = async options => {
    const runtime = await runProfile({ ...options, patchFiles: [...options.patchFiles, patch] })
    ctx = runtime.ctx
    return runtime
  }
  runner = createCollaborationRunner({ store, root, dshHome: home, runProfileImpl })
  await runner.enableKnowledge()
  const knowledge = runner.getKnowledgeService()
  const material = await knowledge.createMaterial(actor, { employeeIds: ['agent'], title: 'Synthetic maintenance', body: 'SYNTHETIC_KNOWLEDGE_OWNER', format: 'text', sourceLabel: 'local fixture', authorizationBasis: 'local synthetic probe' })
  assert.equal(material.ownerMemberId, actor.id)
  const rootErrors = []
  rootHandle = await ctx.agents.create({ sessionId: `credential-root-${randomUUID()}`, meta: { cwd: root }, agentOptions: { provider: 'zenmux', model, maxTokens: 64 }, setup: (agentCtx, agent) => {
    agentCtx.tools.restrict({ allow: [] })
    agent.ctx.on('agent/error', event => rootErrors.push(event.error?.code))
  } })
  rootHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic blocked root request' }], source: { kind: 'user' } }))
  await rootHandle.agent.whenIdle()
  assert(rootErrors.includes('MODEL_NOT_CONFIGURED'))
  assert.equal(calls, 0)
  service = createWorkService({ store, collaborationRunner: runner })
  const created = await service.createCollaboration(actor, { employeeId: 'agent', goal: 'Synthetic blocked child', clientRequestId: 'missing-model', items: [{ id: 'cycle', employeeId: 'agent', skillId: 'skill-cycle-time-calculate', capabilityId: 'cycle-time-calculate', goal: 'Calculate synthetic cycle', input: { availableSeconds: 60, quantity: 2 } }] })
  assert.equal(created.ok, true)
  let work
  for (let attempt = 0; attempt < 500; attempt += 1) {
    work = (await service.getWork(actor, created.value.id)).value
    if (work.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(work.status, 'failed')
  assert.equal(work.executions.at(-1).error.code, 'MODEL_NOT_CONFIGURED')
  const state = await store.read(), child = state.works.find(item => item.rootWorkId === work.id)
  assert.equal(child.executions.at(-1).error.code, 'MODEL_NOT_CONFIGURED')
  assert(child.executions.at(-1).dshSessionRef)
  assert.equal(calls, 0)
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(rootHandle.agent.id, 'read')
  try {
    const history = await handle.read()
    assert(history.events.length > 0)
    assert.equal(JSON.stringify(history.events).includes(storedKey), false)
  } finally { await handle.close() }
  await runner.disableKnowledge()
  await runner.enableKnowledge()
  const negativeModelCaptureCalls = calls
  await rootHandle.dispose(); rootHandle = undefined
  await service.close(); service = undefined; runner = undefined
  await writeFile(join(home, 'secrets', 'model.key'), explicitKey, { mode: 0o600 })
  process.env.GENEWAY_MODEL_CREDENTIAL_REF = 'model.key'
  positive = true
  runner = createCollaborationRunner({ store, root, dshHome: home, runProfileImpl })
  await runner.enableKnowledge()
  rootHandle = await ctx.agents.create({ sessionId: `credential-positive-${randomUUID()}`, meta: { cwd: root }, agentOptions: { provider: 'zenmux', model, maxTokens: 64 }, setup: agentCtx => { agentCtx.tools.restrict({ allow: [] }) } })
  rootHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic legal reference request' }], source: { kind: 'user' } }))
  await rootHandle.agent.whenIdle()
  const positiveEvents = rootHandle.agent.session.snapshotEvents()
  assert.equal(positiveEvents.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
  assert(positiveEvents.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === 'LOCAL_CREDENTIAL_OK')))
  assert.equal(calls - negativeModelCaptureCalls, 1)
  assert.equal(authorizationMatchesExplicit, true)
  assert.equal(credentialInPayload, false)
  await ctx.sessionPersistence.flush()
  const positiveHistory = await ctx.sessionPersistence.open(rootHandle.agent.id, 'read')
  try { const events = (await positiveHistory.read()).events; assert(events.length > 0); assert.equal(JSON.stringify(events).includes(explicitKey), false) }
  finally { await positiveHistory.close() }
  report = { ok: true, model, storedSyntheticCredentialPresent: true, negativeExplicitReferencePresent: false, nativeRoot: 'MODEL_NOT_CONFIGURED', nativeDelegatedChild: 'MODEL_NOT_CONFIGURED', negativeModelCaptureCalls, legalReferenceModelCaptureCalls: calls - negativeModelCaptureCalls, authorizationMatchesExplicit, knowledgeMaintenance: true, nativeHistoryReadable: true, credentialInPayload, sessionCredentialCanaryLeaks: 0 }
} catch (error) { failure = error }
finally {
  for (const cleanup of [() => rootHandle?.dispose(), () => service ? service.close() : runner?.close(), () => new Promise((resolve, reject) => capture.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())), () => rm(home, { recursive: true, force: true })]) {
    try { await cleanup() } catch (error) { failure = failure ? new AggregateError([failure, error], 'model credential probe and cleanup failed', { cause: failure }) : error }
  }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
