import { constants } from 'node:fs'
import { access, lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getCapability, validateCapabilityInput, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from './capabilities.mjs'

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

export async function authorizeExecutionRequestFile(options = {}) {
  const filePath = typeof options === 'string' ? options : options.filePath ?? process.env.GENEWAY_DSH_REQUEST_GRANT_FILE
  const readState = typeof options === 'string' ? readPolicyState : options.readState ?? readPolicyState
  const grant = await readExecutionRequestGrant(filePath)
  return { grant, authorization: await authorizeExecutionGrant(grant, { readState }) }
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

  const occurrence = (state.automationOccurrences ?? []).find(item => item?.workId === work.id)
  if (occurrence) {
    const rule = (state.automationRules ?? []).find(item => item?.id === occurrence.ruleId)
    const workOrderId = work.input?.workOrderId
    if (!rule || rule.status !== 'active' || rule.ownerMemberId !== member.id
      || rule.employeeId !== work.employeeId || rule.skillId !== work.skillId || rule.connectionId !== work.connectionId
      || rule.workOrderId !== workOrderId) throw grantError('FORBIDDEN', '当前自动规则授权已失效')
  }

  const capability = getCapability(grant.capabilityId)
  if (!capability) throw grantError('FORBIDDEN', '能力不存在')
  if (!capability.requiresConnection) {
    if (grant.connection !== null || work.connectionId) throw grantError('FORBIDDEN', '当前能力不允许使用连接')
    return { member, employee, skill, route, work, execution }
  }

  if (capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY) {
    const ids = correlationConnectionIds(work.connectionIds)
    const snapshots = correlationConnectionSnapshots(grant.connections)
    const mapping = correlationMappingBinding(grant.mappingRevision, grant.mappingIdentity)
    if (!isDeepStrictEqual(mapping, correlationMappingContext(work))) throw grantError('FORBIDDEN', '当前 mapping revision 或 identity 已变化')
    const connections = {
      gearJob: currentConnection(state, snapshots.gearJob, ids.gearJob, employee, skill, 'gearjob-rest'),
      hive: currentConnection(state, snapshots.hive, ids.hive, employee, skill, 'hive-tenant-records'),
    }
    if (!connections.gearJob.allowedObjectIds?.includes(grant.input.workOrderId)) throw grantError('FORBIDDEN', '工单已不在当前连接允许范围内')
    if (connections.hive.allowedObjectIds?.length !== 1) throw grantError('FORBIDDEN', 'Hive 连接必须精确授权一个 device code')
    return { member, employee, skill, route, work, execution, connections }
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

export function correlationConnectionSnapshots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'gearJob') || !Object.hasOwn(value, 'hive')) throw grantError('FORBIDDEN', '双来源连接快照无效')
  const gearJob = connectionSnapshot(value.gearJob)
  const hive = connectionSnapshot(value.hive)
  if (gearJob.kind !== 'gearjob-rest' || hive.kind !== 'hive-tenant-records' || !uuid(hive.targetIdentity)) throw grantError('FORBIDDEN', '双来源连接角色无效')
  return { gearJob, hive }
}

export function correlationMappingContext(work) {
  const result = [...(work?.results ?? [])].reverse().find(item => item?.kind === 'manufacturing.work-order-device-correlation')
  return result
    ? correlationMappingBinding(result.payload?.gearJob?.sourceRevision, result.payload?.mapping)
    : { mappingRevision: null, mappingIdentity: null }
}

export function correlationMappingBinding(mappingRevision, mappingIdentity) {
  if (mappingRevision === null && mappingIdentity === null) return { mappingRevision: null, mappingIdentity: null }
  const revision = text(mappingRevision)
  if (!revision || !mappingIdentity || typeof mappingIdentity !== 'object' || Array.isArray(mappingIdentity)
    || Object.keys(mappingIdentity).length !== 4) throw grantError('FORBIDDEN', 'mapping 绑定无效')
  const identity = {}
  for (const key of ['operation', 'workstation', 'mesUnitId', 'hiveUnitId']) {
    identity[key] = text(mappingIdentity[key])
    if (!identity[key]) throw grantError('FORBIDDEN', 'mapping 绑定无效')
  }
  return { mappingRevision: revision, mappingIdentity: identity }
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
  if (capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY) {
    correlationConnectionSnapshots(grant.connections)
    correlationMappingBinding(grant.mappingRevision, grant.mappingIdentity)
  }
  else if (capability.requiresConnection) connectionSnapshot(grant.connection)
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

async function readExecutionRequestGrant(filePath) {
  if (!text(filePath) || !isAbsolute(filePath)) throw grantError('FORBIDDEN', '本次执行的 request 授权路径无效')
  let handle
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error('symlink')
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const metadata = await handle.stat()
    if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)) throw new Error('permissions')
    const raw = await handle.readFile('utf8')
    return JSON.parse(raw)
  } catch {
    throw grantError('FORBIDDEN', '本次执行的 request 授权不可用')
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

function currentConnection(state, snapshot, id, employee, skill, kind) {
  const current = state.connections?.find(item => item.id === snapshot.id)
  if (!current || current.id !== id || current.enabled !== true || current.status !== 'ready'
    || current.kind !== kind || !employee.connectionIds?.includes(current.id) || !current.skillIds?.includes(skill.id)) throw grantError('FORBIDDEN', '当前双来源连接绑定已撤销')
  if (!isDeepStrictEqual(connectionSnapshot(current), snapshot)) throw grantError('FORBIDDEN', '当前连接 revision 或目标已变化')
  return current
}

function correlationConnectionIds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) throw grantError('FORBIDDEN', '工作双来源连接无效')
  const gearJob = text(value.gearJob), hive = text(value.hive)
  if (!gearJob || !hive || gearJob === hive) throw grantError('FORBIDDEN', '工作双来源连接无效')
  return { gearJob, hive }
}

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function grantError(code, message) {
  return Object.assign(new Error(message), { code })
}
