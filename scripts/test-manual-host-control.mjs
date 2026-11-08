import assert from 'node:assert/strict'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { localManualFence, manualBlocked, safelyUnstartedJob, jobPauseEvidence, validateManualInboxFacts, assertManualInboxImmutable } from '../packages/agent-host/manual-control.mjs'
import { seal, SCHEMA } from '../packages/agent-contracts/index.mjs'
const execution = { work_id: 'work', delegation_id: 'delegation', parent_delegation_id: null, attempt_id: 'attempt', execution_epoch: 1, agent_id: 'agent', node_id: 'node', launch_id: 'launch', session_id: 'geneway-launch', runtimeStarted: true, status: 'running', slotHeld: true, observed_revision: 1, waitStatus: 'waiting_dependency', waitId: 'original-wait' }
const command = (operation, generation, scope = { kind: 'work' }) => seal({ schema: SCHEMA, workspace_id: 'local', ...execution, command_id: `${operation}-${generation}-${scope.kind}`, operation, input_id: `holder-${generation}`, instruction_revision: 1, observed_revision: 1, resource_refs: [], parameters: { manualControl: { id: `control-${generation}`, scopeId: scope.kind, scope, generation, action: operation === 'manual_pause' ? 'pause' : 'resume', holderId: `holder-${generation}`, pauseId: operation === 'manual_pause' ? `control-${generation}` : `control-${generation - 1}` } } })
let state = { inbox: [], outbox: [], jobs: [], executions: [structuredClone(execution)] }, idle = false, starts = 0, parks = 0, orchestrationHandler
const journal = { async read() { return structuredClone(state) }, async update(fn) { const before = structuredClone(state), candidate = structuredClone(state); await fn(candidate); validateManualInboxFacts(candidate); assertManualInboxImmutable(before, candidate); state = candidate } }
const runtime = { setOrchestrationHandler(value) { orchestrationHandler = value }, park() { parks++ }, async inspectState() { return { idle } }, async start() { starts++; return execution.session_id }, async close() {} }
const host = createAgentHost({ nodeId: 'node', journal, runtime })
const auth = { nodeId: 'node', workspaceId: 'local' }, pause = command('manual_pause', 1)
await host.accept(auth, pause)
assert.equal(manualBlocked(state, execution), true); assert.equal(parks, 1)
assert.equal(await orchestrationHandler(execution, 'confirmPark', { manualOnly: true }), true)
assert.equal(await orchestrationHandler(execution, 'confirmPark', {}), true)
await host.process(); assert.equal(state.outbox.filter(row => row.event.kind === 'manual_idle').length, 0, 'ACK is not idle')
const release = command('manual_release', 2)
await host.accept(auth, release); await host.process()
assert.equal(manualBlocked(state, execution), true, 'release waits for original safe proof')
idle = true; await host.process(); await host.process()
assert.equal(manualBlocked(state, execution), false)
assert.equal(state.executions[0].waitStatus, 'waiting_dependency'); assert.equal(state.executions[0].waitId, 'original-wait')
assert.equal(starts, 0, 'control release does not replay an ingested input')
assert.deepEqual(await orchestrationHandler(execution, 'assertManualFence', { manualFence: localManualFence(state, execution) }), { authorized: true })
await assert.rejects(orchestrationHandler(execution, 'assertManualFence', { manualFence: { workGeneration: 0, agentGeneration: 0 } }), { code: 'REVISION_CONFLICT' })
assert.deepEqual(state.outbox.map(row => row.event.kind), ['manual_idle', 'manual_released'])
const parksBeforeHistoricalReplay = parks
await host.accept(auth, pause)
assert.equal(parks, parksBeforeHistoricalReplay, 'historical pause ACK must not park a released execution')
await host.accept(auth, command('manual_pause', 3)); await host.accept(auth, release)
assert.equal(manualBlocked(state, execution), true, 'old exact release ACK cannot unpause new generation')
assert.equal(manualBlocked(state, { ...execution, work_id: 'other-work' }), false)
const otherExecution = { ...execution, agent_id: 'agent-b', attempt_id: 'attempt-b', launch_id: 'launch-b', session_id: 'session-b' }
const { payload_digest: ignored, ...pauseBody } = pause
const pauseB = seal({ ...pauseBody, ...otherExecution, command_id: 'pause-b', input_id: 'holder-b', parameters: { manualControl: { ...pause.parameters.manualControl, holderId: 'holder-b' } } })
const partialReleaseState = { inbox: [{ command: pause, manualIdleAt: 'idle' }, { command: pauseB }, { command: release, manualReleasedAt: 'released' }] }
assert.equal(manualBlocked(partialReleaseState, otherExecution), true, 'another holder release cannot clear this holder pause')
const scope = { kind: 'agent', agentId: 'agent' }
let scoped = { inbox: [{ command: command('manual_pause', 1, scope) }] }
assert.equal(manualBlocked(scoped, { ...execution, agent_id: 'other-agent' }), false)
const queued = { ...execution, id: 'job', state: 'accepted', launchState: 'not_started', worker: null, startedAt: null }
assert.equal(safelyUnstartedJob(queued), true)
assert.equal(safelyUnstartedJob({ ...queued, launchState: 'reserved' }), false)
assert.deepEqual(jobPauseEvidence({ jobs: [queued] }, execution), [{ jobId: 'job', workerState: 'not_started' }])
assert.equal(jobPauseEvidence({ jobs: [{ ...queued, launchState: 'reserved' }] }, execution), null)
await host.close()
console.log('manual Host component checks passed; mocked idle only, no official SDK/native acceptance claimed')
