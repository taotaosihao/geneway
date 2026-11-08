import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDshRuntime } from '../packages/agent-host/dsh-runtime.mjs'
const requireFromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const { SessionPersistenceNotFoundError } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence')).href)
let created = 0, registered, resumed = 0, exists = false, resumeFailure
const hooks = new Map(), identity = { session_id: 'stable-session', launch_id: 'launch' }
const scope = { tools: { restrict() {}, guard() {}, register(tool) { registered = tool } }, systemPrompt: { section() {} }, on(name, fn) { hooks.set(name, fn) } }
const ctx = {
  on() {}, sessionPersistence: { async flush() {}, async open(id) { if (!exists) throw new SessionPersistenceNotFoundError(id); return { async close() {} } } },
  agents: { async create({ sessionId, setup }) { created++; const agent = { id: sessionId }; setup(scope, agent); return { agent } }, async resume() { resumed++; throw resumeFailure } },
}
const runtime = createDshRuntime({ boot: async () => ({ ctx }), authorize: async () => {}, optionsFor: async () => ({ provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 4096 }), workspaceRoot: '/synthetic' })
await runtime.start(identity)
assert.equal(created, 1)
assert.equal(registered.name, 'geneway_multisite_report')
assert.equal(registered.output.schema.type, 'object')
await runtime.start(identity)
assert.equal(created, 1)
exists = true; resumeFailure = Object.assign(new Error('history refused'), { code: 'ENOENT' })
await assert.rejects(runtime.start({ session_id: 'existing-session', launch_id: 'existing-launch' }), cause => cause === resumeFailure)
assert.equal(created, 1, 'an existing Session resume failure must never create a replacement')
assert.equal(resumed, 1)
console.log('Multisite DSH boundary checks passed: real defineTool schema compilation, official missing-session type, stable session reuse and history refusal without replacement (injected context, no native/model)')
