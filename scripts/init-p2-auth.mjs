import { lstat, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeAuthFile } from '../src/auth.mjs'
import { acquireAutomationOwner } from '../src/automation-service.mjs'
import { createFileStore } from '../src/store/file-store.mjs'

const args = parseArgs(process.argv.slice(2))
if (!['bootstrap', 'add', 'rekey'].includes(args.mode)) throw new Error('必须显式指定 --mode bootstrap、add 或 rekey')
const statePath = resolve(args.state ?? process.env.GENEWAY_STATE ?? 'var/state.json')
const authPath = resolve(args.auth ?? process.env.GENEWAY_AUTH_FILE ?? '')
if (!args.auth && !process.env.GENEWAY_AUTH_FILE) throw new Error('必须通过 --auth 或 GENEWAY_AUTH_FILE 指定仓库外 auth 文件')
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const authRelative = relative(repositoryRoot, authPath)
if (authRelative !== '..' && !authRelative.startsWith(`..${sep}`)) throw new Error('auth 文件必须位于仓库外')
if (authPath === statePath) throw new Error('auth 文件与产品 state 不得相同')
if (args.mode === 'add' && !args.members) throw new Error('add 需要 --members 显式成员名单')

const members = args.members ? await readMembers(args.members) : defaultMembers()
const passwords = args.members ? parsePasswords(process.env.GENEWAY_MEMBER_PASSWORDS) : {
  'member-admin': process.env.GENEWAY_ADMIN_PASSWORD,
  'member-user': process.env.GENEWAY_MEMBER_PASSWORD,
}
validatePasswords(passwords, members)
const store = createFileStore(statePath)
// Use the same data-root lock as the product so maintenance cannot race a live instance.
const owner = await acquireAutomationOwner(dirname(statePath))
try {
  const state = await store.read()
  validateMembers(members, state, args.mode)
  if (args.mode === 'bootstrap' && (await authExists(authPath) || state.members.some(member => !members.some(item => item.id === member.id)))) {
    throw new Error('产品 facts 已完成 bootstrap；请使用 add 或 rekey 模式')
  }
  if (args.mode === 'add' && !state.members.some(member => member.role === 'admin' && member.enabled)) throw new Error('请先完成 bootstrap')
  const now = new Date().toISOString()
  const additions = members.filter(member => !state.members.some(item => item.id === member.id))
    .map(member => ({ ...member, sessionVersion: 1, createdAt: now, updatedAt: now }))
  if (args.mode !== 'rekey') {
    if (![...state.members, ...additions].some(member => member.role === 'admin' && member.enabled)) throw new Error('必须保留至少一名已启用管理员')
    if (additions.length) await store.update(current => ({ ...current, members: [...current.members, ...additions] }))
  }
  await initializeAuthFile(authPath, passwords, {
    mode: args.mode === 'bootstrap' ? 'create' : 'rekey',
    allowedMemberIds: [...state.members, ...additions].map(member => member.authRef),
  })
  console.log(JSON.stringify({ ok: true, mode: args.mode, provisionedAuthRefs: Object.keys(passwords) }))
} finally {
  await owner.release()
}

function defaultMembers() {
  return [
    { id: 'member-admin', loginName: 'admin', displayName: '本地管理员', role: 'admin', enabled: true, authRef: 'member-admin', employeeIds: [] },
    { id: 'member-user', loginName: 'member', displayName: '本地成员', role: 'member', enabled: true, authRef: 'member-user', employeeIds: [] },
  ]
}

async function readMembers(path) {
  let value
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')) } catch { throw new Error('成员名单必须是可读取的 JSON 文件') }
  if (!Array.isArray(value) || !value.length) throw new Error('成员名单必须是非空数组')
  return value
}

function parsePasswords(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  throw new Error('必须通过 GENEWAY_MEMBER_PASSWORDS 提供按 authRef 对应的 JSON 口令映射')
}

function validatePasswords(passwords, members) {
  const refs = members.map(member => member?.authRef)
  if (new Set(refs).size !== refs.length) throw new Error('成员名单 authRef 重复')
  if (Object.keys(passwords).length !== refs.length || Object.keys(passwords).some(ref => !refs.includes(ref))
    || refs.some(ref => !Object.hasOwn(passwords, ref) || typeof passwords[ref] !== 'string' || passwords[ref].length < 8 || passwords[ref].length > 4096)) {
    throw new Error('口令映射必须准确覆盖名单 authRef，且每项为 8 至 4096 字符')
  }
}

function validateMembers(members, state, mode) {
  const fields = mode === 'rekey' && args.members ? ['id', 'authRef'] : ['id', 'loginName', 'displayName', 'role', 'enabled', 'authRef', 'employeeIds']
  const unique = (items, field) => new Set(items.map(item => item[field])).size === items.length
  for (const member of members) {
    if (!member || typeof member !== 'object' || Array.isArray(member) || Object.keys(member).some(key => !fields.includes(key))
      || !id(member.id) || !id(member.authRef)) throw new Error('成员名单包含无效身份或字段')
    const existing = state.members.find(item => item.id === member.id)
    if (existing && (existing.authRef !== member.authRef || member.loginName !== undefined && existing.loginName !== member.loginName)) throw new Error('既有成员身份不匹配')
    if (mode === 'rekey') {
      if (!existing) throw new Error('rekey 只能供应产品 facts 中已有成员')
      continue
    }
    if (typeof member.loginName !== 'string' || !member.loginName || member.loginName.length > 140 || /[\s\u0000-\u001f\u007f]/.test(member.loginName)
      || typeof member.displayName !== 'string' || !member.displayName.trim() || member.displayName !== member.displayName.trim() || member.displayName.length > 140
      || !['admin', 'member'].includes(member.role) || typeof member.enabled !== 'boolean'
      || !Array.isArray(member.employeeIds) || new Set(member.employeeIds).size !== member.employeeIds.length
      || member.employeeIds.some(employeeId => typeof employeeId !== 'string' || !state.employees.some(employee => employee.id === employeeId))) throw new Error('成员名称、角色、启用状态或员工范围无效')
  }
  for (const field of ['id', 'authRef', ...(mode === 'rekey' ? [] : ['loginName'])]) if (!unique(members, field)) throw new Error(`成员名单 ${field} 重复`)
  const combined = [...state.members, ...members.filter(member => !state.members.some(item => item.id === member.id))]
  for (const field of ['id', 'authRef', 'loginName']) if (!unique(combined, field)) throw new Error(`成员 ${field} 已被其他身份使用`)
}

function id(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value) }

async function authExists(path) {
  try { await lstat(path); return true } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false
    throw error
  }
}

function parseArgs(argv) {
  const result = {}
  const allowed = new Set(['--mode', '--state', '--auth', '--members'])
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`未知参数：${key}`)
    if (key === '--overwrite') throw new Error('--overwrite 已移除；请使用 --mode rekey')
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`)
    const value = argv[++index]
    if (typeof value !== 'string' || value.startsWith('--') || !value.trim()) throw new Error(`参数缺少值：${key}`)
    if (Object.hasOwn(result, key.slice(2))) throw new Error(`参数重复：${key}`)
    result[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return result
}
