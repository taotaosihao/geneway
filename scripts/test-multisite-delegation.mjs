import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createSimulatedRuntime } from './fixtures/multisite/runtime.mjs'
import { childRequest, seedDelegation } from './fixtures/multisite/delegation.mjs'
import { authorizeMultisiteExecution } from '../src/multisite-authorization.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/delegation-focused-')
const store = createFileStore(join(directory, 'state.json')); await store.update(seedDelegation)
const journal = createHostJournal(join(directory, 'host.json')), runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') })
const host = createAgentHost({ nodeId: 'local', journal, runtime, maxActiveLoops: 1 }), service = createMultisiteService({ store, hosts: [host] })
const owner = { id: 'owner' }, current = async id => (await store.read()).multisite.attempts.find(row => row.agent_id === id)
const call = async (id, op, params) => runtime.orchestration(await current(id), op, params)
const wait = (clientRequestId, dependencyIds, instructionRevision = 1) => ({ clientRequestId, dependencyIds, instructionRevision })
const complete = (clientRequestId, instructionRevision = 1) => ({ clientRequestId, instructionRevision, result: { summary: '本地模拟结构化结果；未读取现场业务数据。', evidenceRefs: [] } })
try {
  const root = await service.apply(owner, 'create', { employeeId: 'coordinator', goal: 'root→B→A 主动委派回报', clientRequestId: 'create' })
  await service.drain()
  const before = await store.read(), parent = await current('coordinator')
  await assert.rejects(call('coordinator', 'delegate', { ...childRequest('forge'), fromAgent: 'desktop-data' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(service.agentCommand({ ...parent, agent_id: 'desktop-data' }, 'delegate', childRequest('forged-binding')), { code: 'FORBIDDEN' })
  await assert.rejects(call('coordinator', 'delegate', { ...childRequest('over-resource'), resourceRefs: ['private:any'] }), { code: 'FORBIDDEN' })
  const b = await call('coordinator', 'delegate', childRequest('delegate-b'))
  assert.equal(runtime.starts(), 1, 'committed child cannot start inside tool ACK')
  const accepted = await store.read(); assert.equal(accepted.multisite.attempts.length, 2); assert.equal(accepted.works[0].instructionRevision, 1)
  assert.deepEqual(await call('coordinator', 'delegate', childRequest('delegate-b')), b)
  await assert.rejects(call('coordinator', 'delegate', { ...childRequest('delegate-b'), goal: '冲突' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await call('coordinator', 'wait_dependencies', wait('wait-b', [b.delegationId]))
  await service.drain(); assert.equal(runtime.starts(), 2)
  const a = await call('desktop-office', 'delegate', childRequest('delegate-a', 'desktop-data'))
  await assert.rejects(call('desktop-office', 'delegate', childRequest('cycle', 'coordinator')), { code: 'DEPENDENCY_CYCLE' })
  await call('desktop-office', 'wait_dependencies', wait('wait-a', [a.delegationId]))
  await service.drain(); assert.equal(runtime.starts(), 3)
  const resultA = await call('desktop-data', 'complete_delegation', complete('complete-a'))
  await service.drain(); await service.drain()
  assert.equal((await store.read()).multisite.messages.filter(row => row.targetAttemptId === b.attemptId && row.ingestedAt).length, 1)
  const resultB = await call('desktop-office', 'complete_delegation', complete('complete-b'))
  await service.drain(); await service.drain()
  const final = await store.read()
  assert.equal(final.multisite.results.length, 2); assert.equal(final.multisite.messages.length, 2)
  assert(final.multisite.messages.every(row => row.ingestedAt))
  assert(final.multisite.dependencyWaits.every(row => row.wokenAt))
  assert.equal(final.multisite.inputs.length, 1); assert.equal(final.works[0].instructionRevision, 1); assert.equal(final.works[0].status, 'running')
  assert.equal(final.works[0].modelRequestBudget.reserved, 0)
  assert.equal(runtime.starts(), 3); assert.equal(new Set(final.multisite.attempts.map(row => row.session_id)).size, 3)
  await assert.rejects(call('coordinator', 'complete_delegation', complete('bad-root-completion')), { code: 'INVALID_STATE' })
  await service.apply(owner, 'cancel', { workId: root.workId, clientRequestId: 'cancel' }); await service.drain()
  assert.equal((await store.read()).works[0].status, 'cancelled')
  await assert.rejects(service.agentCommand(parent, 'delegate', childRequest('after-cancel')), { code: 'FORBIDDEN' })
  const result = { result: 'passed', directory, rootToBToA: true, durableMessages: 2, independentSessions: 3, userRevision: 1, modelReservations: 0, noToolInlineSpawn: true, authorityAndReplayNegatives: true, stopAfterChildCompletion: true, boundary: 'real FileStore/Host/AgentDelivery producers; simulated runtime, no business evidence' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} finally { await service.close() }
