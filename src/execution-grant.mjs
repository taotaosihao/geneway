import { constants } from 'node:fs'
import { access, lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getCapability, validateCapabilityInput } from './capabilities.mjs'

const ACTIVE_EXECUTIONS = new Set(['accepted', 'running'])

export async function consumeExecutionGrant({ filePath = process.env.GENEWAY_DSH_GRANT_FILE, toolName, input } = {}) {
  if (!text(filePath)) throw grantError('FORBIDDEN', '本次执行没有工具授权')
  const consumedPath = `${filePath}.consumed`
  let grant
  try {
    await rename(filePath, consumedPath)
    grant = JSON.parse(await readFile(consumedPath, 'utf8'))
  } catch {
    throw grantError('FORBIDDEN', '本次执行的工具授权不可用')
  } finally {
    await unlink(consumedPath).catch(() => undefined)
  }
  validateGrantShape(grant)
  if (grant.expectedTool !== toolName) throw grantError('FORBIDDEN', '本次执行不允许调用该工具')
  const validated = validateCapabilityInput(grant.capabilityId, input)
  if (!validated.ok || !isDeepStrictEqual(validated.input, grant.input)) throw grantError('FORBIDDEN', '工具参数与本次执行授权不匹配')
  return grant
}

export async function authorizeExecutionGrant(grant, { readState = readPolicyState } = {}) {
  validateGrantShape(grant)
  const state = await readState(grant.policyFile, grant.policyRoot)
  const member = state.members?.find(item => item.id === grant.memberId)
  const employee = state.employees?.find(item => item.id === grant.employeeId)
  const skill = state.skills?.find(item => item.id === grant.skillId)
  const route = state.modelRoutes?.find(item => item.id === grant.modelRouteId)
  const work = state.works?.find(item => item.id === grant.workId)
  const execution = work?.executions?.find(item => item.id === grant.executionId)
  if (!member || member.enabled !== true || !member.employeeIds?.includes(employee?.id)) throw grantError('FORBIDDEN', '当前成员不再获准使用该员工')
  if (!employee || employee.enabled !== true || !employee.skillIds?.includes(skill?.id) || employee.modelRouteId !== route?.id) throw grantError('FORBIDDEN', '当前员工绑定已撤销')
  if (!skill || skill.enabled !== true || skill.capabilityId !== grant.capabilityId) throw grantError('FORBIDDEN', '当前能力绑定已撤销')
  if (!route || route.enabled !== true) throw grantError('FORBIDDEN', '当前模型路由已停用')
  if (!work || work.ownerMemberId !== member.id || work.employeeId !== employee.id || work.skillId !== skill.id || work.capabilityId !== grant.capabilityId) throw grantError('FORBIDDEN', '当前工作授权已失效')
  if (!execution || execution.operation !== grant.operation) throw grantError('FORBIDDEN', '当前执行授权已失效')
  if (!ACTIVE_EXECUTIONS.has(execution.status)) {
    if (['cancel_requested', 'cancelled'].includes(execution.status)) throw grantError('CANCELLED', '本次执行已停止')
    throw grantError('FORBIDDEN', '当前执行已不可派发')
  }
  const currentConfirmationRefs = (state.confirmations ?? [])
    .filter(item => item.ownerMemberId === member.id && item.employeeId === employee.id && item.status === 'active')
    .map(item => ({ id: item.id, revision: item.revision }))
    .sort(compareRefs)
  if (!isDeepStrictEqual(currentConfirmationRefs, [...grant.confirmationRefs].sort(compareRefs))) throw grantError('FORBIDDEN', '当前确认信息 revision 已变化')

  const capability = getCapability(grant.capabilityId)
  if (!capability) throw grantError('FORBIDDEN', '能力不存在')
  if (!capability.requiresConnection) {
    if (grant.connection !== null || work.connectionId) throw grantError('FORBIDDEN', '当前能力不允许使用连接')
    return { member, employee, skill, route, work, execution }
  }

  const current = state.connections?.find(item => item.id === grant.connection?.id)
  if (!current || current.enabled !== true || current.status !== 'ready') throw grantError('FORBIDDEN', '当前连接不可用')
  if (current.kind !== capability.connectionKind || work.connectionId !== current.id || !employee.connectionIds?.includes(current.id) || !current.skillIds?.includes(skill.id)) throw grantError('FORBIDDEN', '当前连接绑定已撤销')
  const snapshot = connectionSnapshot(current)
  if (!isDeepStrictEqual(snapshot, grant.connection)) throw grantError('FORBIDDEN', '当前连接 revision 或目标已变化')
  if (!current.allowedObjectIds?.includes(grant.input.workOrderId)) throw grantError('FORBIDDEN', '业务对象已不在当前连接允许范围内')
  return { member, employee, skill, route, work, execution, connection: current }
}

export function connectionSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw grantError('FORBIDDEN', '连接快照无效')
  const required = ['id', 'revision', 'kind', 'targetIdentity', 'baseUrl', 'credentialRef', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']
  for (const key of required) if (key !== 'revision' && !text(value[key])) throw grantError('FORBIDDEN', `连接快照缺少 ${key}`)
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw grantError('FORBIDDEN', '连接 revision 无效')
  if (!Array.isArray(value.allowedObjectIds) || value.allowedObjectIds.some(item => !text(item))) throw grantError('FORBIDDEN', '连接对象范围无效')
  let url
  try { url = new URL(value.baseUrl) } catch { throw grantError('FORBIDDEN', '连接目标地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw grantError('FORBIDDEN', '连接目标地址无效')
  if (value.hostHeader !== undefined && (!text(value.hostHeader) || /[\u0000-\u001f\u007f]/.test(value.hostHeader))) throw grantError('FORBIDDEN', '连接 Host header 无效')
  return compact({
    id: value.id,
    revision: value.revision,
    kind: value.kind,
    targetIdentity: value.targetIdentity,
    baseUrl: value.baseUrl,
    hostHeader: text(value.hostHeader),
    credentialRef: value.credentialRef,
    allowedObjectIds: [...value.allowedObjectIds],
    sourceSystem: value.sourceSystem,
    sourceInstance: value.sourceInstance,
    sourceEnvironment: value.sourceEnvironment,
    dataMode: value.dataMode,
    evidenceMode: value.evidenceMode,
  })
}

export async function resolveCredentialFile(secretRoot, credentialRef) {
  if (!isAbsolute(secretRoot)) throw grantError('SOURCE_NOT_CONFIGURED', 'secret root 必须是绝对路径')
  const ref = text(credentialRef)
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref) || ref === '.' || ref === '..') throw grantError('SOURCE_NOT_CONFIGURED', 'credential ref 无效')
  const root = resolve(secretRoot)
  const filePath = resolve(root, ref)
  if (!isWithin(root, filePath)) throw grantError('SOURCE_NOT_CONFIGURED', 'credential ref 超出 secret root')
  try {
    await access(filePath, constants.R_OK)
    if ((await lstat(filePath)).isSymbolicLink()) throw grantError('SOURCE_NOT_CONFIGURED', 'credential ref 不允许符号链接')
    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new Error('not-file')
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw grantError('SOURCE_NOT_CONFIGURED', 'credential file permissions must be 0600')
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)])
    if (!isWithin(realRoot, realFile)) throw grantError('SOURCE_NOT_CONFIGURED', 'credential ref 超出 secret root')
  } catch (error) {
    if (error?.code === 'SOURCE_NOT_CONFIGURED') throw error
    throw grantError('SOURCE_NOT_CONFIGURED', 'credential file is unavailable')
  }
  return filePath
}

export function validatePolicyPaths({ policyRoot, policyFile, secretRoot }) {
  if (![policyRoot, policyFile, secretRoot].every(isAbsolute)) throw grantError('FORBIDDEN', 'policy 与 secret 路径必须是绝对路径')
  if ([policyRoot, secretRoot].some(path => resolve(path) === parse(resolve(path)).root)) throw grantError('FORBIDDEN', '受控根目录不能是文件系统根目录')
  if (!isWithin(resolve(policyRoot), resolve(policyFile))) throw grantError('FORBIDDEN', 'policy file 超出受控 data root')
}

function validateGrantShape(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || grant.version !== 2) throw grantError('FORBIDDEN', '工具授权结构无效')
  for (const key of ['executionId', 'memberId', 'employeeId', 'skillId', 'capabilityId', 'workId', 'modelRouteId', 'operation', 'expectedTool']) if (!text(grant[key])) throw grantError('FORBIDDEN', `工具授权缺少 ${key}`)
  const capability = getCapability(grant.capabilityId)
  if (!capability || grant.expectedTool !== capability.toolName) throw grantError('FORBIDDEN', '工具授权能力不匹配')
  const validated = validateCapabilityInput(grant.capabilityId, grant.input)
  if (!validated.ok || !isDeepStrictEqual(validated.input, grant.input)) throw grantError('FORBIDDEN', '工具授权输入无效')
  if (!text(grant.confirmationFingerprint) || !Array.isArray(grant.confirmationRefs) || grant.confirmationRefs.some(item => !item || !text(item.id) || !Number.isInteger(item.revision) || item.revision < 1)) throw grantError('FORBIDDEN', '工具授权确认信息无效')
  if (capability.requiresConnection) connectionSnapshot(grant.connection)
  else if (grant.connection !== null) throw grantError('FORBIDDEN', '无连接能力的授权结构无效')
  validatePolicyPaths(grant)
}

async function readPolicyState(filePath, policyRoot) {
  let handle
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error('symlink')
    const [realRoot, realFile] = await Promise.all([realpath(policyRoot), realpath(filePath)])
    if (!isWithin(realRoot, realFile)) throw new Error('outside-root')
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    if (!(await handle.stat()).isFile()) throw new Error('not-file')
    return JSON.parse(await handle.readFile('utf8'))
  } catch {
    throw grantError('FORBIDDEN', '当前策略状态不可用')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isWithin(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function compareRefs(left, right) {
  return String(left.id).localeCompare(String(right.id)) || left.revision - right.revision
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function grantError(code, message) {
  return Object.assign(new Error(message), { code })
}
