import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootDshHost } from './dsh-host.mjs'
import { validateModelSnapshot } from './model-route.mjs'
import { SUPERVISION_DIAGNOSIS_PROMPT, SUPERVISION_DIAGNOSIS_LIMITS } from './supervision-diagnosis-state.mjs'

const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { freezeMessage } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-llm')).href)
const patchFile = fileURLToPath(new URL('../config/supervision-diagnosis-runtime.patch.yml', import.meta.url))
const fail = code => { throw Object.assign(new Error(code), { code }) }
let native, handle, closing, started = false, cancelled = false, stage = 'startup', token = '', tail, deadlineTimer
async function close() {
  return closing ??= (async () => {
    if (handle?.agent.status !== 'idle') handle?.agent.cancel({ kind: 'user' })
    if (handle) await handle.agent.whenIdle()
    if (native) { await native.ctx.sessionPersistence.flush(); await native.shutdown.shutdown(0) }
    token = ''
  })()
}
async function interrupted() {
  cancelled = true
  const hardStop = setTimeout(() => process.exit(1), 1500)
  try { await close() } finally { clearTimeout(hardStop); process.exit(1) }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void interrupted() })
process.on('disconnect', () => { void interrupted() })
async function send(value) { if (!process.connected) fail('DIAGNOSIS_PARENT_UNAVAILABLE'); await new Promise((done, reject) => process.send(value, cause => cause ? reject(cause) : done())) }
const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
async function run(message) {
  const { diagnosisId, sessionId, modelSnapshot, packet, deadlineAt } = message
  token = message.token; delete message.token
  validateModelSnapshot(modelSnapshot)
  const maxTokens = Math.min(SUPERVISION_DIAGNOSIS_LIMITS.maxOutputTokens, modelSnapshot.parameters.maxOutputTokens), packetText = JSON.stringify(packet)
  const remaining = Date.parse(deadlineAt) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > SUPERVISION_DIAGNOSIS_LIMITS.timeoutMs) fail('DIAGNOSIS_TIMEOUT')
  deadlineTimer = setTimeout(() => { void interrupted() }, remaining)
  const environment = { get(name) { const value = name === 'GENEWAY_DIAGNOSIS_TOKEN' ? token : process.env[name]; return value === undefined ? undefined : { value, source: 'process' } }, getFrom(name, sources) { return sources.includes('process') ? this.get(name) : undefined } }
  stage = 'boot'
  native = await bootDshHost({ environment, profile: 'sdk-minimal', patchFiles: [patchFile], args: [] })
  if (cancelled) fail('DIAGNOSIS_CANCELLED')
  let requestCount = 0, streamCount = 0, toolAttempts = 0
  native.ctx.on('llm/stream', async function* (options, next) {
    if (++streamCount !== 1 || options.sessionId !== sessionId || options.provider !== modelSnapshot.provider || options.model !== modelSnapshot.model || options.maxTokens !== maxTokens || options.tools?.length) fail('DIAGNOSIS_REQUEST_REJECTED')
    if (options.messages?.length !== 2 || options.messages[0].role !== 'system' || options.messages[1].role !== 'user' || textOf(options.messages[0]) !== SUPERVISION_DIAGNOSIS_PROMPT || textOf(options.messages[1]) !== packetText) fail('DIAGNOSIS_CONTEXT_REJECTED')
    for await (const chunk of next()) yield chunk
  })
  stage = 'create'
  handle = await native.ctx.agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider: modelSnapshot.provider, model: modelSnapshot.model, maxTokens }, setup(agentCtx, agent) {
    agentCtx.tools.restrict({ allow: [] })
    agentCtx.tools.guard(() => { toolAttempts++; return 'Supervision diagnosis cannot invoke tools' })
    agentCtx.systemPrompt.section({ name: 'supervision-diagnosis', order: 0, complete: true, interpolate: false, text: SUPERVISION_DIAGNOSIS_PROMPT })
    agentCtx.on('agent/request', async (request, next) => {
      if (cancelled || ++requestCount !== 1 || request.agent !== agent) fail('DIAGNOSIS_REQUEST_LIMIT')
      const resolved = await next()
      if (resolved.provider !== modelSnapshot.provider || resolved.model !== modelSnapshot.model || resolved.maxTokens !== maxTokens) fail('DIAGNOSIS_MODEL_MISMATCH')
      return resolved
    }, { prepend: true })
  } })
  if (cancelled) fail('DIAGNOSIS_CANCELLED')
  stage = 'followup'
  handle.agent.followup(freezeMessage({ id: 'supervision-diagnosis:' + diagnosisId, role: 'user', content: [{ type: 'text', text: packetText }], source: { kind: 'supervision-diagnosis' } }))
  await handle.agent.whenIdle(); await native.ctx.sessionPersistence.flush()
  stage = 'history'
  const stored = await native.ctx.sessionPersistence.open(sessionId, 'read'), events = []
  try { for (let offset = 0; ;) { const batch = await stored.read(offset, 256); if (!batch.events.length) break; events.push(...batch.events); offset += batch.events.length } } finally { await stored.close() }
  const starts = events.filter(event => event.type === 'turn/start'), ends = events.filter(event => event.type === 'turn/end'), assistants = events.filter(event => event.type === 'assistant/message'), users = events.filter(event => event.type === 'user/message'), toolCalls = events.filter(event => event.type === 'tool/call')
  tail = { reason: ends[0]?.data.reason, turnStartSeq: starts[0]?.seq, turnEndSeq: ends[0]?.seq, assistantSeq: assistants[0]?.seq, toolCalls: toolCalls.length, toolAttempts, requestCount, streamCount }
  if (cancelled || requestCount !== 1 || streamCount !== 1 || toolAttempts || toolCalls.length || starts.length !== 1 || ends.length !== 1 || ends[0].data.reason.kind !== 'completed' || users.length !== 1 || assistants.length !== 1 || assistants[0].seq <= users[0].seq || ends[0].seq <= assistants[0].seq || starts[0].data.turn !== ends[0].data.turn || assistants[0].data.turn !== ends[0].data.turn || assistants[0].data.interrupted) fail('DIAGNOSIS_TURN_UNCONFIRMED')
  const assistant = assistants[0].data.message, text = textOf(assistant)
  if (assistant.role !== 'assistant' || assistant.source?.provider !== modelSnapshot.provider || assistant.source?.model !== modelSnapshot.model || !text || assistant.content.some(block => block.type === 'tool-call')) fail('DIAGNOSIS_ASSISTANT_UNCONFIRMED')
  stage = 'close'; await close()
  if (cancelled) fail('DIAGNOSIS_CANCELLED')
  clearTimeout(deadlineTimer)
  await send({ kind: 'diagnosis-result', value: { diagnosisId, sessionId, text, tail, history: { sessionId, events } } })
  process.exit(0)
}
process.on('message', message => {
  if (message?.kind === 'cancel') { void interrupted(); return }
  if (started || message?.kind !== 'diagnose') { void interrupted(); return }
  started = true
  void run(message).catch(async cause => {
    clearTimeout(deadlineTimer)
    try { await close() } catch {}
    try { await send({ kind: 'diagnosis-error', code: /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code ?? '') ? cause.code : 'DIAGNOSIS_SESSION_FAILED', stage, tail }) } catch {}
    process.exit(1)
  })
})
