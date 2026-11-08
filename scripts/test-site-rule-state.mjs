import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { binding, digest, key, SCHEMA, seal } from '../packages/agent-contracts/index.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { createInteractionService } from '../src/interaction-service.mjs'
import { workDirectory } from '../src/interaction-state.mjs'
import { authorizeMultisiteExecution } from '../src/multisite-authorization.mjs'
import { createNodeService } from '../src/node-service.mjs'
import { createSiteRuleService } from '../src/site-rule-service.mjs'
import { assertSiteRuleImmutable, SITE_CAPABILITY, SITE_RULE_ID, SITE_RULE_LIMITS } from '../src/site-rule-state.mjs'
import { migrateState } from '../src/store/file-store.mjs'

const evidence = '/home/gewu/.codex/task-checkpoints/geneway-evidence'
const donor = JSON.parse(await readFile(evidence + '/a2a-collaboration-native-GYVANs/completed-state.json'))
let state = migrateState(donor.state ?? donor)
let now = Date.now()
const iso = (offset = 0) => new Date(now + offset).toISOString()
let updates = Promise.resolve()
const store = {
  async read() { return structuredClone(state) },
  update(change) {
    const update = updates.then(async () => {
      const draft = structuredClone(state)
      const next = migrateState(await change(draft) ?? draft)
      assertSiteRuleImmutable(state, next)
      state = next
    })
    updates = update.catch(() => {})
    return update
  },
}
const nodes = createNodeService({ store, clock: () => now })
const multisite = createMultisiteService({ store, requireRemoteNodes: true, clock: () => iso() })
async function restore(snapshot) {
  await multisite.resumeBudget()
  await updates
  state = structuredClone(snapshot)
}
const interaction = createInteractionService({ store, multisite, clock: () => now })
const service = createSiteRuleService({ store, nodes, multisite, clock: () => now })
const owner = { id: 'owner' }, peer = { id: 'peer' }
const employeeId = 'component-site-observer', nodeId = 'component-site-node', instanceId = 'component-site-instance', budgetPolicyId = 'component-site-budget'
const credential = randomBytes(32).toString('base64url')
const request = { headers: { authorization: 'Bearer ' + credential, 'x-geneway-node-instance': instanceId } }
await store.update(draft => {
  const employee = structuredClone(draft.employees.find(row => row.id === 'gateway'))
  Object.assign(employee, { id: employeeId, placement: { ...employee.placement, nodeId, resourceRefs: ['fixture:site'] },
    multisitePolicy: { execution: { capabilityIds: [SITE_CAPABILITY], resourceRefs: ['fixture:site'] }, delegation: { agentIds: [], capabilityIds: [], resourceRefs: [] } } })
  draft.employees.push(employee)
  draft.members.find(row => row.id === owner.id).employeeIds.push(employeeId)
  draft.budgetPolicies.push({ ...structuredClone(draft.budgetPolicies[0]), id: budgetPolicyId, coordinatorAgentId: employeeId })
  return draft
})
const pairing = await nodes.createPairing(owner, { nodeId, clientRequestId: 'site-component-pair', siteId: 'site', platform: 'linux', runtimeMode: 'agent_node', allowedAgentIds: [employeeId], expiresAt: iso(60_000) })
await nodes.redeem({ pairingId: pairing.pairingId, pairingCode: pairing.pairingCode, clientRequestId: 'site-component-redeem', nodeInstanceId: instanceId, credential })
const resourceBody = { expectedRevision: 1, clientRequestId: 'site-component-resource', workspaceId: 'local', siteId: 'site', kind: 'site_diagnostics', ownerNodeId: nodeId, capabilityIds: [SITE_CAPABILITY], evidenceReaderAgentIds: [employeeId], enabled: true }
await nodes.putResource(owner, 'fixture:site', resourceBody)
const thread = await interaction.createThread(owner, { clientRequestId: 'site-component-thread', title: '模拟规则组件' })
const config = { nodeId, threadId: thread.id, employeeId, profileVersion: 1, budgetPolicyId }
const body = (eventId, fields = {}) => ({ profileVersion: 1, maxActiveLoops: 2, sourceSha256: digest('component-file-before'), event: { sourceEventId: eventId, sourceTimestamp: iso(), code: 'COLLECTOR_LINK_DOWN', severity: 'error', message: '模拟连接事件', ...fields } })
const reject = code => cause => cause.code === code
assert.equal((await service.get(owner)).mode, 'observe')
await assert.rejects(service.put(peer, { ...config, expectedRevision: 0, mode: 'observe' }), reject('FORBIDDEN'))
await service.put(owner, { ...config, expectedRevision: 0, mode: 'observe' })
const before = await store.read(), observe = body('observe')
await assert.rejects(service.receive({ headers: {} }, observe), reject('UNAUTHORIZED'))
assert.equal((await service.receive(request, observe)).status, 'observed')
assert.equal(state.works.length, before.works.length)
assert.deepEqual(state.modelRequests, before.modelRequests)
assert.deepEqual(state.multisite.outbox, before.multisite.outbox)
now += 5
await service.put(owner, { ...config, expectedRevision: 1, mode: 'auto', expiresAt: iso(600_000) })
await assert.rejects(service.put(owner, { expectedRevision: 1, mode: 'observe' }), reject('REVISION_CONFLICT'))
assert.equal((await service.receive(request, { ...observe, sourceSha256: digest('component-file-appended') })).replay, true)
await assert.rejects(service.receive(request, { ...observe, event: { ...observe.event, message: '异文' } }), reject('IDEMPOTENCY_CONFLICT'))
assert.equal(state.siteRuleEvents[0].sourceSha256, observe.sourceSha256)
now += 5
const stale = await service.receive(request, body('stale', { sourceTimestamp: observe.event.sourceTimestamp }))
assert.equal(stale.reason, 'BEFORE_ENABLEMENT')
const nullTime = await service.receive(request, body('unknown-clock', { sourceTimestamp: null }))
assert.equal(nullTime.reason, 'EVENT_TIME_UNCONFIRMED')
const single = await service.receive(request, { ...body('single-slot'), maxActiveLoops: 1 })
assert.equal(single.reason, 'FOREGROUND_SLOT_REQUIRED')
const manual = await multisite.apply(owner, 'create', { employeeId, goal: '手动处理同资源异常', clientRequestId: 'site-manual', budgetPolicyId })
const related = await service.receive(request, body('already-handled'))
assert.equal(related.status, 'associated'); assert.equal(related.workId, manual.workId)
assert.equal(state.works.length, before.works.length + 1)

// Use distinct immutable snapshots for expiry/revocation, with no fabricated cleanup receipt.
const manualWork = state.works.find(row => row.id === manual.workId)
const baselineBeforeManual = structuredClone(state)
await multisite.apply(owner, 'cancel', { workId: manualWork.id, clientRequestId: 'site-manual-stop' })
const manualStop = state.multisite.outbox.find(row => row.command.work_id === manualWork.id && row.command.operation === 'cancel').command
const manualAuth = nodes.authenticate(state, request.headers.authorization, instanceId)
await multisite.acceptHostEvent(manualAuth, seal({ schema: SCHEMA, event_id: key('site-component-not-started', manualStop.command_id), workspace_id: 'local',
  ...binding({ ...manualStop, session_id: 'geneway-' + manualStop.launch_id }), kind: 'stopped', input_id: null, instruction_revision: 1, observed_revision: 0,
  resource_refs: manualStop.resource_refs, source_command_id: manualStop.command_id, stop_evidence: 'never_started' }))
assert.equal(state.works.find(row => row.id === manualWork.id).status, 'cancelled')
assert.equal(baselineBeforeManual.works.find(row => row.id === manualWork.id).status, 'accepted')
const afterManualStop = structuredClone(state)
async function consumeInput(launch) {
  const execution = { ...binding(launch), session_id: 'geneway-' + launch.launch_id }
  for (const kind of ['started','session_delivered','session_ingested']) await multisite.acceptHostEvent(manualAuth, seal({
    schema: SCHEMA, event_id: key('site-component-input', launch.command_id, kind), workspace_id: 'local', ...execution, kind, input_id: launch.input_id,
    instruction_revision: 1, observed_revision: kind === 'session_ingested' ? 1 : 0, resource_refs: launch.resource_refs, source_command_id: launch.command_id,
  }))
  return execution
}
await restore(baselineBeforeManual)
const ordinaryExecution = await consumeInput(state.multisite.outbox.find(row => row.command.work_id === manualWork.id && row.command.operation === 'launch').command)
const ordinaryContext = await multisite.agentCommand(ordinaryExecution, 'intent_context', { clientRequestId: 'ordinary-context' }, { nodeAuth: manualAuth })
assert.deepEqual(ordinaryContext, { role: 'context', contexts: [], truncated: false })
assert(state.intentCommands.some(row => row.senderBinding.attempt_id === ordinaryExecution.attempt_id))
await restore(afterManualStop)
const admitted = await service.receive(request, body('eligible'))
assert.equal(admitted.status, 'created')
assert.equal((await service.receive(request, body('eligible'))).replay, true)
const work = state.works.find(row => row.id === admitted.workId)
const launch = state.multisite.outbox.find(row => row.command.work_id === work.id && row.command.operation === 'launch').command
assert.equal(work.origin, 'rule')
assert.equal(work.modelRequestBudget.policySnapshot.id, budgetPolicyId)
assert.equal(Date.parse(work.siteRule.window.to) - Date.parse(work.siteRule.window.from), SITE_RULE_LIMITS.windowMs)
assert.deepEqual(launch.parameters.siteRule.window, work.siteRule.window)
assert.equal((await service.receive(request, body('concurrent'))).workId, work.id)
now += SITE_RULE_LIMITS.windowMs + 1
const separate = await service.receive(request, body('separate-window'))
assert.equal(separate.status, 'observed'); assert.equal(separate.reason, 'BACKGROUND_BUSY'); assert.equal(separate.workId, null)
now -= SITE_RULE_LIMITS.windowMs + 1
await assert.rejects(service.getWork(peer, work.id), reject('NOT_FOUND'))
await assert.rejects(multisite.apply(owner, 'input', { workId: work.id, clientRequestId: 'unrelated-input', text: '禁止给受管诊断追加任务' }), reject('FORBIDDEN'))
await assert.rejects(multisite.agentCommand(binding(launch), 'delegate', { clientRequestId: 'unrelated-tool' }), reject('FORBIDDEN'))
assert.equal((await service.getWork(owner, work.id)).draft, null)
const execution = { ...binding(launch), session_id: 'geneway-' + launch.launch_id }
assert.equal(authorizeMultisiteExecution(state, execution).work.id, work.id)
assert(!workDirectory(state, owner).candidates.some(row => row.workId === work.id))
const rejectedInput = { clientRequestId: 'rule-target', sourceEventId: 'rule-target', expectedThreadRevision: thread.revision, text: '不能把普通请求交给受管诊断', workId: work.id }
await assert.rejects(interaction.submit(owner, thread.id, rejectedInput), reject('NOT_FOUND'))
await consumeInput(launch)
const beforeUnrelatedCommand = structuredClone(state)
await assert.rejects(multisite.agentCommand(execution, 'intent_context', { clientRequestId: 'unrelated-context' }, { nodeAuth: manualAuth }), reject('FORBIDDEN'))
assert.deepEqual(state, beforeUnrelatedCommand)

const prior = structuredClone(state)
const checkStopped = () => {
  assert.equal(state.works.find(row => row.id === work.id).status, 'stopping')
  assert.equal(state.multisite.outbox.filter(row => row.command.work_id === work.id && row.command.operation === 'cancel').length, 1)
  assert.throws(() => authorizeMultisiteExecution(state, execution), reject('FORBIDDEN'))
  assert.deepEqual(state.modelRequests, prior.modelRequests)
  assert.equal(state.siteDiagnosisDrafts.length, 0)
}
await service.put(owner, { expectedRevision: 2, mode: 'observe' })
checkStopped()
assert.equal((await service.receive(request, body('after-off'))).status, 'observed')
await restore(prior)
now += 600_000
assert.equal((await service.receive(request, body('expired'))).reason, 'GRANT_EXPIRED')
await service.scan()
checkStopped()
await restore(prior)
now -= 600_000
await nodes.putResource(owner, 'fixture:site', { ...resourceBody, enabled: false, expectedRevision: 2, clientRequestId: 'site-resource-revoke' })
await assert.rejects(service.receive(request, body('after-resource-revoke')), reject('FORBIDDEN'))
const reopened = createSiteRuleService({ store, nodes, multisite, clock: () => now })
await reopened.scan()
checkStopped()

// Valid history at the fixed boundary, without generating 998 unrelated admin requests.
await restore(before)
const observeRevision = state.siteRuleRevisions[0]
for (let revision = 2; revision < SITE_RULE_LIMITS.revisions - 1; revision++) {
  state.siteRuleRevisions.push({ ...observeRevision, id: key(SITE_RULE_ID, revision), revision })
}
const oldRevision = SITE_RULE_LIMITS.revisions - 2
await service.put(owner, { ...config, expectedRevision: oldRevision, mode: 'auto', expiresAt: iso(600_000) })
now += 1
const finalActive = await service.receive(request, body('last-safe-activation'))
assert.equal(finalActive.status, 'created')
const beforeInvalidEdit = structuredClone(state)
await assert.rejects(service.put(owner, { ...config, expectedRevision: oldRevision + 1, mode: 'auto', expiresAt: iso(600_000) }), reject('INVALID_STATE'))
assert.deepEqual(state, beforeInvalidEdit)
await nodes.putResource(owner, 'fixture:site', { ...resourceBody, enabled: false, expectedRevision: 2, clientRequestId: 'site-resource-revoke-at-limit' })
const closedAtLimit = await service.put(owner, { expectedRevision: oldRevision + 1, mode: 'observe' })
assert.equal(closedAtLimit.revision, SITE_RULE_LIMITS.revisions)
assert.equal(closedAtLimit.mode, 'observe')
assert.equal(state.works.find(row => row.id === finalActive.workId).status, 'stopping')
assert.equal(state.multisite.outbox.filter(row => row.command.work_id === finalActive.workId && row.command.operation === 'cancel').length, 1)
await assert.rejects(service.receive(request, body('post-limit-close')), reject('FORBIDDEN'))

console.log(JSON.stringify({ result: 'passed', checks: ['observe/no new effects', 'authenticated same event replay on changed file', 'conflict', 'stale/null source time', 'single-slot no auto', 'same-window association and disjoint busy observation', 'close slot retained at revision limit', 'current bounded admission', 'nonowner/read and unrelated op rejection', 'off/expiry/resource revocation original cancel'], boundary: 'production transition functions, memory Store with validation and synthetic authenticated Node receipt, no HTTP, Host runtime, SDK, or provider evidence' }))
