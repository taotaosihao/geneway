import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createContextTools, modelStepAfterIssue } from '../packages/agent-host/context-tools.mjs'
import { continuationBlock } from '../packages/agent-host/input-context.mjs'
import { createRemoteClient } from '../packages/agent-host/remote-client.mjs'

const actual = { requestId: 'actual-reserved', inputMessageId: 'actually-consumed', manualFence: { workGeneration: 2, agentGeneration: 0 } }
const remembered = modelStepAfterIssue(undefined, { modelStep: actual }, true)
assert.deepEqual(remembered, actual); assert.notEqual(remembered, actual)
assert.equal(modelStepAfterIssue(remembered, { modelStep: { ...actual, requestId: 'metadata-random' } }, false), remembered)
assert.equal(modelStepAfterIssue(remembered, { token: 'metadata-only' }, false), remembered)
assert.equal(modelStepAfterIssue(remembered, {}, true), undefined, 'new reservation without verified identity cannot retain old step')
const page = { readId: 'read', objectRef: { kind: 'work', id: 'source' }, content: { text: '真实完整页正文' }, nextRefs: [], partial: false }
let calls = 0
const [tool] = createContextTools(async parameters => { calls++; assert.equal(parameters.view, 'content'); return page })
const returned = await tool.execute({ clientRequestId: 'first', view: 'content' })
assert.equal(returned, page)
assert.deepEqual(tool.output.render({}, returned), [{ type: 'text', text: JSON.stringify(page) }], 'page renders once without envelope duplication')
await assert.rejects(tool.execute({ clientRequestId: 'spoof', view: 'content', modelStep: actual }), { code: 'INVALID_REQUEST' })
await assert.rejects(tool.execute({ clientRequestId: 'spoof', view: 'content', purpose: 'ordinary' }), { code: 'INVALID_REQUEST' })
assert.equal(calls, 1)
const [large] = createContextTools(async () => ({ body: '界'.repeat(6000) }))
await assert.rejects(large.execute({ clientRequestId: 'large', view: 'content' }), { code: 'INVALID_RESPONSE' })
const source = { sourceWorkId: 'old', sourceState: 'completed', unknownEffects: false, artifact: { cells: ['PRIVATE_OLD_CELLS'], page: { text: 'PRIVATE_OLD_PAGE' } } }
const block = continuationBlock(source)
assert(!JSON.stringify(block).includes('PRIVATE_OLD')); assert(block.text.includes('geneway_read_context')); assert(block.text.includes('old')); assert.deepEqual(source.artifact.cells, ['PRIVATE_OLD_CELLS'])
let posted
const client = createRemoteClient({ origin: 'http://127.0.0.1:1', identity: { credential: 'synthetic', nodeInstanceId: 'synthetic' }, fetchImpl: async (url, options) => { posted = { path: url.pathname, body: JSON.parse(options.body) }; return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } }) } })
const execution = { work_id: 'work', delegation_id: 'delegation', parent_delegation_id: null, attempt_id: 'attempt', execution_epoch: 1, agent_id: 'root', node_id: 'node', launch_id: 'launch', session_id: 'session' }
assert.deepEqual(await client.context.read(execution, { clientRequestId: 'read', view: 'content' }, remembered), page)
assert.equal(posted.path, '/internal/context/read'); assert.deepEqual(posted.body.modelStep, actual); assert.deepEqual(posted.body.binding, execution); assert.equal(posted.body.parameters.modelStep, undefined)
console.log('context Host components passed: trusted reservation identity, metadata preservation, parameter isolation, single bounded JSON page, provenance without cached cells, narrow remote DTO; no SDK/server acceptance claimed')

const workerSource = await readFile(new URL('../packages/agent-host/runtime-worker.mjs', import.meta.url), 'utf8')
const hookStart = workerSource.indexOf("native.ctx.on('llm/stream', async function* (options, next) {")
const hookBody = workerSource.slice(hookStart + "native.ctx.on('llm/stream', async function* (options, next) {".length, workerSource.indexOf("\n      })\n      const readImageRequest", hookStart))
assert(hookStart >= 0 && hookBody.includes("reserveRequest: true"))
const fixtureHook = new Function('rpc', 'execution', 'snapshot', 'error', `let stoppedOnly=false,contextReadEnabled=false,tokenValue,turnIntentFence,budgetResumeCommandId; return async function* (options,next) { ${hookBody} }`)(async (_operation, parameters) => { assert.equal(parameters.reserveRequest, true); return { token: 'synthetic', contextReadEnabled: false } }, { session_id: 'session' }, { provider: 'provider', model: 'model', parameters: { maxOutputTokens: 32 } }, code => Object.assign(new Error(code), { code }))
const frozenRequest = Object.freeze({ sessionId: 'session', provider: 'provider', model: 'model', maxTokens: 32, tools: Object.freeze([{ name: 'ordinary' }]), messages: [{ role: 'user', id: 'actual', source: { kind: 'geneway-multisite' } }] })
assert.deepEqual(await Array.fromAsync(fixtureHook(frozenRequest, async function* () { yield 'actual-hook-continued' })), ['actual-hook-continued'])
console.log('actual worker llm/stream hook accepts frozen GenerateOptions without mutation')
