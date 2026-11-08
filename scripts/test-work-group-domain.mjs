import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createFileStore, migrateState } from '../src/store/file-store.mjs'
import { createMultisiteService } from '../packages/agent-orchestration/service.mjs'
import { binding } from '../packages/agent-contracts/index.mjs'
import { createWorkGroupDomain } from '../experiments/protocol-comparison/common/work-group-domain.mjs'

const source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-role-baseline-final-DoAjva'
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-group-domain-')
const original = JSON.parse(await readFile(path.join(source, 'result-state.json')))
const identity = JSON.parse(await readFile(path.join(source, 'edge-0/node-identity.json')))
const observationTime = Math.max(...original.modelRequests.map(row => Date.parse(row.completedAt ?? row.reservedAt))) + 1
const originalNow = Date.now, results = []
try {
  Date.now = () => observationTime
  for (const remove of [false, true]) {
    const directory = path.join(root, remove ? 'removed' : 'control'), stateFile = directory + '.json'
    await writeFile(stateFile, JSON.stringify(migrateState(structuredClone(original))))
    const store = createFileStore(stateFile), service = createMultisiteService({ store, clock: () => new Date(observationTime).toISOString() })
    const state = await store.read(), attempt = state.multisite.attempts.find(row => row.agent_id === 'coordinator'), work = state.works.find(row => row.id === attempt.work_id), actor = { employeeId: attempt.agent_id, binding: binding(attempt), identity }
    const message = await service.agentCommand(actor.binding, 'publish_observation', { clientRequestId: 'domain-check-publish', instructionRevision: 1, text: '本工作受权事件摘要', evidenceRefs: [] })
    let entered, release
    const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve)
    const domain = await createWorkGroupDomain({ root: directory, stateFile, work: { workspaceId: work.workspaceId, workId: work.id }, actors: [actor], recordResolution: async value => { await writeFile(path.join(directory, 'actual-log.json'), JSON.stringify(value)); entered(); await gate } })
    const event = await domain.register(actor, message.messageId)
    const pending = domain.resolve(actor, event.locator).then(value => ({ value }), cause => ({ code: cause.code }))
    await ready
    if (remove) await service.apply({ id: work.ownerMemberId }, 'remove-member', { workId: work.id, employeeId: actor.employeeId, clientRequestId: 'domain-check-remove' })
    release(); const result = await pending
    if (remove) assert.equal(result.code, 'FORBIDDEN')
    else assert.equal(result.value.text, '本工作受权事件摘要')
    results.push({ remove, returnedBody: !!result.value, code: result.code ?? null })
    await service.close()
  }
  const result = { root, source, result: 'passed', cases: results, boundary: 'Actual archived identity/binding and cloned FileStore; current production publish/remove and experiment resolver with controlled log-return barrier. No HTTP, provider, SDK or OS producer claim; clock is a controlled observation instant, source facts unchanged.' }
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} finally { Date.now = originalNow }
