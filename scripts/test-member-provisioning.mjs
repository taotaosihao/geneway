import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAuthRuntime, isSessionCurrent } from '../src/auth.mjs'
import { acquireAutomationOwner } from '../src/automation-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

const execFile = promisify(execFileCallback)
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'geneway-member-provisioning-'))
const statePath = join(root, 'data', 'state.json')
const authPath = join(root, 'private', 'auth.json')
const members = Array.from({ length: 20 }, (_, index) => ({
  id: `member-${index}`, authRef: `auth-${index}`, loginName: `login-${index}`, displayName: `合成成员 ${index}`,
  role: index === 0 ? 'admin' : 'member', enabled: true, employeeIds: [],
}))
const store = createFileStore(statePath)

try {
  await mkdir(join(root, 'home'))
  const fault = join(root, 'auth-write-fault.mjs')
  await writeFile(fault, `import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'
const write = fs.writeFile
fs.writeFile = async (path, ...args) => {
  if (dirname(String(path)) === ${JSON.stringify(dirname(authPath))}) throw new Error('SYNTHETIC_AUTH_WRITE_FAILED')
  return write(path, ...args)
}
syncBuiltinESMExports()
`)
  await assert.rejects(run('bootstrap', members, { hook: fault }), /SYNTHETIC_AUTH_WRITE_FAILED/)
  const afterPartial = await store.read()
  assert.equal(afterPartial.members.length, 20)
  await assert.rejects(readFile(authPath), { code: 'ENOENT' })
  await run('bootstrap', members)
  assert.deepEqual((await store.read()).members, afterPartial.members)
  const auth = createAuthRuntime({ filePath: authPath })
  for (const member of members) assert.equal(await auth.verifyPassword(member.authRef, password(member)), true)
  const initialToken = await auth.issueSession(afterPartial.members[2])
  await assert.rejects(run('bootstrap', members), /bootstrap/)

  await store.update(state => ({ ...state,
    employees: [{ id: 'agent', name: '合成 Agent', enabled: true, revision: 1, instructions: '', skillIds: [], connectionIds: [], modelRouteId: null }],
    members: state.members.map(member => member.id === 'member-1' ? { ...member, role: 'admin', enabled: false, employeeIds: ['agent'], sessionVersion: 7 } : member),
  }))
  const beforeAdd = await store.read()
  const extra = { id: 'extra', authRef: 'extra-auth', loginName: 'extra-login', displayName: '合成新增成员', role: 'member', enabled: true, employeeIds: ['agent'] }
  await assert.rejects(run('add', [members[1], extra], { hook: fault }), /SYNTHETIC_AUTH_WRITE_FAILED/)
  const partialAdd = await store.read()
  assert.equal(partialAdd.members.length, 21)
  assert.equal(await auth.verifyPassword(extra.authRef, password(extra)), false)
  assert.equal(await auth.verifyPassword(members[2].authRef, password(members[2])), true)
  await run('add', [members[1], extra])
  const added = await store.read()
  assert.deepEqual(added.members, partialAdd.members)
  assert.equal(added.members.length, 21)
  assert.deepEqual(added.members.slice(0, 20), beforeAdd.members)
  assert.equal(await auth.verifyPassword(extra.authRef, password(extra)), true)
  assert.equal(await auth.verifyPassword(members[2].authRef, password(members[2])), true)
  assert.equal(await auth.verifySession(initialToken.token), undefined)
  await run('add', [members[1], extra])
  assert.deepEqual((await store.read()).members, added.members)
  const disabled = added.members.find(member => member.id === 'member-1')
  assert.equal(isSessionCurrent((await auth.verifySession((await auth.issueSession(disabled)).token)), disabled), false)

  const stateBeforeRekey = await readFile(statePath)
  const oldToken = await auth.issueSession(added.members[0])
  const identity = { id: extra.id, authRef: extra.authRef }
  await run('rekey', [identity], { passwords: { [extra.authRef]: 'replacement synthetic password' } })
  assert.deepEqual(await readFile(statePath), stateBeforeRekey)
  assert.equal(await auth.verifyPassword(extra.authRef, 'replacement synthetic password'), true)
  assert.equal(await auth.verifySession(oldToken.token), undefined)
  assert.equal(await auth.verifyPassword(members[0].authRef, password(members[0])), true)

  const invalid = [
    ['add', [{ ...extra, authRef: 'changed-auth' }], {}, /身份不匹配/],
    ['add', [{ ...extra, id: 'other-id' }], {}, /已被其他身份使用/],
    ['add', [{ ...extra, id: 'other-id', authRef: 'other-auth' }], {}, /已被其他身份使用/],
    ['add', [extra, extra], {}, /重复/],
    ['add', [{ ...extra, role: 'owner' }], {}, /角色/],
    ['add', [{ ...extra, employeeIds: ['unknown-agent'] }], {}, /员工范围/],
    ['rekey', [{ id: 'missing', authRef: 'missing-auth' }], {}, /已有成员/],
    ['rekey', [{ ...identity, enabled: true }], {}, /字段/],
    ['rekey', [identity], { passwords: { [extra.authRef]: 'short' } }, /8 至 4096/],
    ['rekey', [identity], { passwords: { [extra.authRef]: 'valid synthetic password', stray: 'stray synthetic password' } }, /准确覆盖/],
  ]
  for (const [mode, list, options, pattern] of invalid) {
    const stateBytes = await readFile(statePath), authBytes = await readFile(authPath)
    await assert.rejects(run(mode, list, options), pattern)
    assert.deepEqual(await readFile(statePath), stateBytes)
    assert.deepEqual(await readFile(authPath), authBytes)
  }
  const owner = await acquireAutomationOwner(dirname(statePath))
  try { await assert.rejects(run('add', [extra]), /OWNER_ALREADY_RUNNING|owner 已运行/) } finally { await owner.release() }
  const restoredAuth = join(root, 'restored-private', 'auth.json')
  const identities = added.members.map(({ id, authRef }) => ({ id, authRef }))
  await run('rekey', identities, { auth: restoredAuth })
  const restored = createAuthRuntime({ filePath: restoredAuth })
  assert.equal(await restored.verifySession(oldToken.token), undefined)
  assert.deepEqual(await readFile(statePath), stateBeforeRekey)
  for (const member of added.members) assert.equal(await restored.verifyPassword(member.authRef, password(member)), true)
  console.log('Member provisioning passed: 20 members, explicit identities, partial-write replay, add/rekey, preserved access, old-cookie rejection and live-owner exclusion (synthetic only)')
} finally {
  await rm(root, { recursive: true, force: true })
}

function password(member) { return `synthetic password ${member.authRef}` }

async function run(mode, list, { passwords = Object.fromEntries(list.map(member => [member.authRef, password(member)])), hook, auth = authPath } = {}) {
  const input = join(root, 'members.json')
  await writeFile(input, JSON.stringify(list), { mode: 0o600 })
  try {
    const result = await execFile(process.execPath, [...(hook ? ['--import', hook] : []), 'scripts/init-p2-auth.mjs', '--mode', mode, '--state', statePath, '--auth', auth, '--members', input], {
      cwd: repo,
      env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: root, GENEWAY_MEMBER_PASSWORDS: JSON.stringify(passwords) },
    })
    for (const secret of Object.values(passwords)) assert.equal((result.stdout + result.stderr).includes(secret), false)
    return JSON.parse(result.stdout)
  } catch (error) {
    for (const secret of Object.values(passwords)) assert.equal(`${error.stdout}\n${error.stderr}`.includes(secret), false)
    throw error
  }
}
