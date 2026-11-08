import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'

const source = '/home/gewu/.codex/task-checkpoints/geneway-evidence/work-member-http-JDD8os/before.json'
const root = await mkdtemp('/home/gewu/.codex/task-checkpoints/geneway-evidence/work-group-projection-')
const original = JSON.parse(await readFile(source)), work = original.works.find(row => row.workType === 'multisite'), owner = { id: work.ownerMemberId }, results = []
for (const mode of ['wrong-work', 'remove-during-provider', 'nonowner', 'mutation']) {
  const file = path.join(root, mode + '.json'); await writeFile(file, JSON.stringify(original))
  const store = createFileStore(file); let calls = 0, service
  service = createWorkService({ store, workMemberProtocolStatus: async request => {
    calls++
    if (mode === 'remove-during-provider' && request.employeeId === 'gateway') await service.multisite.apply(owner, 'remove-member', { workId: work.id, employeeId: 'gateway', clientRequestId: 'projection-remove' })
    return { ...request, configured: true, status: 'confirmed', ...(mode === 'wrong-work' ? { workId: 'another-work' } : {}), access: 'active', canRemove: true, secret: 'must-never-be-projected' }
  } })
  if (mode === 'mutation') {
    await service.multisite.apply(owner, 'remove-member', { workId: work.id, employeeId: 'gateway', clientRequestId: 'mutation-no-provider' }); assert.equal(calls, 0)
  } else {
    const response = await service.getWork(mode === 'nonowner' ? { id: 'peer' } : owner, work.id)
    if (mode === 'nonowner') { assert.equal(response.ok, false); assert.equal(calls, 0) }
    else {
      const member = response.value.multisite.workMembers.find(row => row.employeeId === 'gateway')
      assert.equal(member.protocolGroup, 'unknown'); assert(!JSON.stringify(response).includes('must-never-be-projected'))
      if (mode === 'remove-during-provider') { assert.equal(member.access, 'removed'); assert.equal(member.canRemove, false) }
    }
  }
  results.push({ mode, providerCalls: calls }); await service.close()
}
const result = { result: 'passed', root, source, cases: results, boundary: 'Actual FileStore clones and production service entrypoints, synthetic read-only protocol status callback; no external protocol/HTTP/browser claim' }
await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
