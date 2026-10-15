import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore } from '../src/store/file-store.mjs'
import { createWorkService } from '../src/work-service.mjs'
import { isSessionCurrent } from '../src/auth.mjs'

const root = await mkdtemp(join(tmpdir(), 'geneway-agents-'))
const path = join(root, 'state.json')
const store = createFileStore(path)
const admin = { id: 'admin' }, alice = { id: 'alice' }, bob = { id: 'bob' }
const service = createWorkService({ store })
try {
  await store.update(state => ({
    ...state,
    members: [member('admin', 'admin'), member('alice'), member('bob')],
    modelRoutes: [{ id: 'route', provider: 'zenmux', model: 'deepseek/deepseek-v4.1-flash', credentialRef: 'ZENMUX_API_KEY', enabled: true }],
  }))
  const created = await service.createConfig(admin, 'employees', {
    id: 'assistant', name: '助手', instructions: '依据事实回答。', modelRouteId: 'route', memberIds: ['alice'],
  })
  assert.equal(created.revision, 1)
  assert.deepEqual(created.memberIds, ['alice'])
  assert.equal(created.instructions, '依据事实回答。')
  const before = await store.read()
  assert.equal(Object.hasOwn(before.employees[0], 'memberIds'), false)
  assert.deepEqual(before.members.find(item => item.id === 'alice').employeeIds, ['assistant'])
  assert.equal(isSessionCurrent({ memberId: 'alice', sessionVersion: 1 }, before.members.find(item => item.id === 'alice')), true)
  await assert.rejects(service.listConfig(alice, 'employees'), error => error.code === 'FORBIDDEN')
  await assert.rejects(service.updateConfig(bob, 'employees', 'assistant', { expectedRevision: 1 }), error => error.code === 'FORBIDDEN')
  await assert.rejects(service.updateConfig(admin, 'employees', 'assistant', { instructions: '无版本' }), error => error.code === 'REVISION_CONFLICT')
  await assert.rejects(service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: 1, instructions: null }), error => error.code === 'INVALID_REQUEST')
  await assert.rejects(service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: 1, memberIds: ['missing'] }), error => error.code === 'INVALID_REQUEST')
  assert.deepEqual(await store.read(), before)

  const concurrent = await Promise.allSettled([
    service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: 1, instructions: '更新后的指令。' }),
    service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: 1, instructions: '不能覆盖。' }),
  ])
  assert.equal(concurrent[0].status, 'fulfilled')
  assert.equal(concurrent[1].reason.code, 'REVISION_CONFLICT')
  const updated = concurrent[0].value
  await service.updateMember(admin, 'alice', { expectedEmployeeIds: ['assistant'], employeeIds: [] })
  const removed = await store.read()
  assert.equal(removed.members.find(item => item.id === 'alice').sessionVersion, 1)
  assert.equal(removed.employees[0].revision, updated.revision + 1)
  await assert.rejects(service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: updated.revision, memberIds: ['alice', 'bob'] }), error => error.code === 'REVISION_CONFLICT')
  const regranted = await service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: removed.employees[0].revision, memberIds: ['alice', 'bob'] })
  assert.deepEqual(regranted.memberIds, ['alice', 'bob'])
  assert.equal((await store.read()).members.find(item => item.id === 'alice').sessionVersion, 1)
  const memberForm = (await service.listMembers(admin)).find(item => item.id === 'alice')
  await service.updateConfig(admin, 'employees', 'assistant', { expectedRevision: regranted.revision, memberIds: ['bob'] })
  await assert.rejects(service.updateMember(admin, 'alice', {
    displayName: '旧表单修改名称', role: memberForm.role, enabled: memberForm.enabled,
    employeeIds: memberForm.employeeIds, expectedEmployeeIds: memberForm.employeeIds,
  }), error => error.code === 'REVISION_CONFLICT')
  assert.deepEqual((await store.read()).members.find(item => item.id === 'alice').employeeIds, [])
  assert.equal((await store.read()).members.find(item => item.id === 'alice').displayName, memberForm.displayName)
  await assert.rejects(service.updateMember(admin, 'alice', { employeeIds: ['assistant'] }), error => error.code === 'REVISION_CONFLICT')
  await service.updateMember(admin, 'alice', { expectedEmployeeIds: [], employeeIds: ['assistant'] })
  const disabled = await service.updateMember(admin, 'alice', { enabled: false })
  assert.equal(disabled.sessionVersion, 2)
  assert.equal(isSessionCurrent({ memberId: 'alice', sessionVersion: 1 }, disabled), false)
  const enabled = await service.updateMember(admin, 'alice', { enabled: true })
  assert.equal(enabled.sessionVersion, 3)
  const promoted = await service.updateMember(admin, 'alice', { role: 'admin' })
  assert.equal(promoted.sessionVersion, 4)
  const reopened = createFileStore(path)
  assert.equal((await reopened.read()).employees[0].instructions, '更新后的指令。')
  assert.equal((await readFile(path, 'utf8')).includes('memberIds'), false)
  console.log('Agent 配置、唯一开放关系、并发版本与登录有效性检查通过')
} finally {
  await rm(root, { recursive: true, force: true })
}

function member(id, role = 'member') {
  return { id, loginName: id, displayName: id, role, enabled: true, authRef: id, sessionVersion: 1, employeeIds: [] }
}
