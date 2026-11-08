import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createBudgetService } from '../src/budget-service.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createHostJournal } from '../packages/agent-host/journal.mjs'
import { createAgentHost } from '../packages/agent-host/host.mjs'
import { createSimulatedRuntime, seedMultisite } from './fixtures/multisite/runtime.mjs'
const directory = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/budget-dispatch-'), store = createFileStore(join(directory, 'state.json')), owner = { id: 'owner' }
await store.update(seedMultisite)
const runtime = createSimulatedRuntime({ path: join(directory, 'sessions.json') }), journal = createHostJournal(join(directory, 'host.json')), host = createAgentHost({ nodeId: 'local', journal, runtime }), service = createMultisiteService({ store, hosts: [host] })
try {
  const budgets = createBudgetService({ store }), state = await store.read(), route = state.modelRoutes[0]
  await budgets.putPolicy(owner, 'short-dispatch', { clientRequestId: 'policy', expectedRevision: null, workspaceId: 'local', coordinatorAgentId: 'coordinator', enabled: true, accountingMode: 'conservative_estimate', limits: { maxModelRequests: 20, maxReservedTokens: 1000000, maxReservedCostMicros: 1000000 }, executionTimeoutMs: 1000, currency: 'CNY', estimator: { version: 1, inputBytesNumerator: 1, inputBytesDenominator: 1, fixedInputTokens: 8 }, modelPrices: [{ provider: route.provider, model: route.model, inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 7 }] })
  const work = await service.apply(owner, 'create', { employeeId: 'coordinator', clientRequestId: 'work', goal: '过期前未投递的local launch不得启动', budgetPolicyId: 'short-dispatch' }), deadline = (await store.read()).works[0].modelRequestBudget.executionDeadlineAt
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 20)); await service.drain()
  const blocked = await store.read(); assert.equal(blocked.multisite.outbox[0].blockedReason, 'EXECUTION_DEADLINE'); assert.equal(blocked.multisite.outbox[0].acceptedAt, null); assert.equal(runtime.starts(), 0); assert.equal((await journal.read()).executions.length, 0)
  await service.apply(owner, 'cancel', { workId: work.workId, clientRequestId: 'stop' }); await service.drain()
  const stopped = await store.read(); assert.equal(stopped.works[0].status, 'cancelled'); assert.equal(runtime.starts(), 0); assert(stopped.multisite.receipts.some(row => row.event.kind === 'stopped' && row.event.stop_evidence === 'never_started'))
  const result = { result: 'passed', directory, boundary: 'actual FileStore/local service.drain/Host/AgentDelivery, simulated runtime, real 1s deadline', expiredPendingLaunchBlockedBeforeHostIntake: true, noRuntimeStart: true, expiredCancelActualNeverStartedReceipt: true }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
} catch (cause) { await writeFile(join(directory, 'failure.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack }, null, 2)); console.error(directory); throw cause } finally { await service.close() }
