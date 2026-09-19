import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeAuthFile } from '../src/auth.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

const args = parseArgs(process.argv.slice(2))
if (!['bootstrap', 'rekey'].includes(args.mode)) throw new Error('必须显式指定 --mode bootstrap 或 --mode rekey')
const statePath = resolve(args.state ?? process.env.GENEWAY_STATE ?? 'var/state.json')
const authPath = resolve(args.auth ?? process.env.GENEWAY_AUTH_FILE ?? '')
if (!args.auth && !process.env.GENEWAY_AUTH_FILE) throw new Error('必须通过 --auth 或 GENEWAY_AUTH_FILE 指定仓库外 auth 文件')
const passwords = {
  'member-admin': process.env.GENEWAY_ADMIN_PASSWORD,
  'member-user': process.env.GENEWAY_MEMBER_PASSWORD,
}
if (Object.values(passwords).some(value => !value)) throw new Error('必须通过环境变量提供 admin/member 密码')
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const authRelative = relative(repositoryRoot, authPath)
if (authRelative !== '..' && !authRelative.startsWith(`..${sep}`)) throw new Error('auth 文件必须位于仓库外')

const store = createFileStore(statePath)
const state = await store.read()

if (args.mode === 'bootstrap') {
  const memberIds = state.members.map(member => member.id)
  const bootstrapable = memberIds.length === 0 || (memberIds.length === 1 && memberIds[0] === 'member-admin')
  if (!bootstrapable) throw new Error('产品 facts 已完成 bootstrap；请使用 rekey 模式')
  const now = new Date().toISOString()
  const admin = state.members[0] ?? {
    id: 'member-admin',
    loginName: 'admin',
    displayName: '本地管理员',
    role: 'admin',
    enabled: true,
    authRef: 'member-admin',
    sessionVersion: 1,
    employeeIds: [],
    createdAt: now,
    updatedAt: now,
  }
  if (admin.role !== 'admin' || admin.authRef !== 'member-admin') throw new Error('现有 bootstrap 管理员事实不兼容')
  const member = {
    id: 'member-user',
    loginName: 'member',
    displayName: '本地成员',
    role: 'member',
    enabled: true,
    authRef: 'member-user',
    sessionVersion: 1,
    employeeIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await store.update(current => ({ ...current, members: current.members.length ? [...current.members, member] : [admin, member] }))
  await initializeAuthFile(authPath, passwords, { mode: 'create', allowedMemberIds: [admin.authRef, member.authRef] })
} else {
  const allowedMemberIds = state.members.map(member => member.authRef)
  if (Object.keys(passwords).some(memberId => !allowedMemberIds.includes(memberId))) throw new Error('rekey 只能供应产品 facts 中已有成员')
  await initializeAuthFile(authPath, passwords, { mode: 'rekey', allowedMemberIds })
}

console.log(JSON.stringify({ ok: true, mode: args.mode, provisionedAuthRefs: Object.keys(passwords) }))

function parseArgs(argv) {
  const result = {}
  const allowed = new Set(['--mode', '--state', '--auth'])
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`未知参数：${key}`)
    if (key === '--overwrite') throw new Error('--overwrite 已移除；请使用 --mode rekey')
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`)
    const value = argv[++index]
    if (typeof value !== 'string') throw new Error(`参数缺少值：${key}`)
    result[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return result
}
