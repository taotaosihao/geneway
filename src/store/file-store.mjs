import { validateModelSnapshot } from '../model-route.mjs'
import { validateExecutionRuntime } from '../execution-runtime.mjs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getCapability, parseCapabilityToolResult, validateCapabilityInput } from '../capabilities.mjs'
import { KIVO_TPM_RESULT_KIND } from '../domain/tpm.mjs'
import { KIVO_TPM_DEVICE_CORRELATION_KIND } from '../domain/tpm-device-correlation.mjs'
import { assertRepairReceipt, assertRepairTarget, isRepairCreationEcho, KIVO_REPAIR_ACTION, repairIntentKey, repairPayload, repairTargetFromCorrelation } from '../domain/kivo-repair.mjs'
import { connectionSnapshot } from '../execution-grant.mjs'
import { segmentKnowledgeBody } from '../knowledge-search.mjs'
import { normalizeWeixinApiBaseUrl } from '../../vendor/dsh-im/weixin/weixin-api.mjs'
import { canonicalRevision, digest, canonical, KIVO_EVENT_RECORD_TYPES, KIVO_EVENT_TRIGGER } from '../kivo-events.mjs'

export const STATE_VERSION = 12
export const KNOWLEDGE_LIMITS = Object.freeze({
  maxMaterials: 100,
  maxBodyBytes: 32 * 1024,
  maxTotalBodyBytes: Math.floor(3.2 * 1024 * 1024),
  maxTitleCharacters: 200,
  maxSourceCharacters: 500,
  maxAuthorizationCharacters: 1000,
})

const ADMIN_MEMBER_ID = 'member-admin'
const GEARJOB_CAPABILITY_ID = 'gearjob-work-order-read'
const GEARJOB_SKILL_ID = 'skill-gearjob-work-order-read'
const GEARJOB_SKILL_ACTION = 'gearjob.work-order.read'
const GEARJOB_TOOL_NAME = 'geneway_gearjob_read_work_order'
const GEARJOB_PLUGIN_ID = 'geneway-gearjob-work-order'
const CYCLE_CAPABILITY_ID = 'cycle-time-calculate'
const CYCLE_SKILL_ID = 'skill-cycle-time-calculate'
const CYCLE_TOOL_NAME = 'geneway_calculate_cycle_time'
const CYCLE_PLUGIN_ID = 'geneway-cycle-time'
const CORRELATION_CAPABILITY_ID = 'manufacturing-work-order-device-correlate'
const CORRELATION_SKILL_ID = 'skill-manufacturing-work-order-device-correlate'
const CORRELATION_TOOL_NAME = 'geneway_correlate_work_order_device'
const CORRELATION_PLUGIN_ID = 'geneway-work-order-device-correlation'
const CORRELATION_RESULT_KIND = 'manufacturing.work-order-device-correlation'
const RESULT_KINDS = new Set(['gearjob.work-order.observation', 'manufacturing.takt', CORRELATION_RESULT_KIND, KIVO_TPM_RESULT_KIND, KIVO_TPM_DEVICE_CORRELATION_KIND, 'assistant.follow-up', 'assistant.collaboration-summary'])
const ACTION_INVALIDATION_REASONS = new Set(['RECOVERY_INVALIDATED', 'PREVIEW_SUPERSEDED', 'OWNER_REVOKED', 'PREVIEW_EXPIRED', 'PREVIEW_DIGEST_CHANGED', 'SOURCE_FACTS_CHANGED', 'SOURCE_RECHECK_FAILED', 'DISPATCH_DEADLINE_EXPIRED'])
const ACTION_UNKNOWN_REASONS = new Set(['RECOVERY_UNKNOWN', 'ALREADY_UNKNOWN', 'ACTION_ID_CONFLICT', 'UPSTREAM_TIMEOUT', 'UPSTREAM_DISCONNECTED', 'UPSTREAM_RESULT_UNKNOWN', 'UPSTREAM_5XX', 'INVALID_SUCCESS_RESPONSE', 'READBACK_NOT_FOUND', 'READBACK_MISMATCH', 'READBACK_FAILED', 'READBACK_AUTHORIZATION_FAILED', 'RECEIPT_PERSIST_FAILED'])
const ACTION_NO_EFFECT_REASONS = new Set(['DISPATCH_DEADLINE_EXPIRED', 'SOURCE_REVISION_CONFLICT', 'P6_SCOPE_UNAVAILABLE', 'CONNECTOR_AUTH_FAILED', 'INVALID_REQUEST', 'INVALID_COMMENT_ACTION', 'ACTION_ID_CONFLICT', 'OWNER_REVOKED'])

const EMPTY_STATE = {
  version: STATE_VERSION,
  members: [],
  modelRoutes: [],
  employees: [],
  connections: [],
  skills: [],
  confirmations: [],
  knowledgeMaterials: [],
  channelApps: [],
  channelIdentities: [],
  channelConversations: [],
  channelMessages: [],
  deliveries: [],
  linkCodes: [],
  automationRules: [],
  automationOccurrences: [],
  automationInbox: [],
  conversations: [],
  works: [],
  reservations: {},
  defaultChannelEmployeeId: null,
}

const DEFAULT_FS_OPS = { mkdir, open, readFile, rename, unlink }

export function createFileStore(filePath, fsOps = {}) {
  const io = { ...DEFAULT_FS_OPS, ...fsOps }
  let pending = Promise.resolve()
  let confirmed = false, durabilityFailure
  const enqueue = operation => {
    const result = pending.then(operation)
    pending = result.catch(() => undefined)
    return result
  }
  const syncAndClose = async handle => {
    let failure
    try { await handle.sync() } catch (error) { failure = error }
    try { await handle.close() } catch (error) { failure ??= error }
    if (failure) throw failure
  }
  const confirmDurability = async () => {
    try {
      let handle
      try { handle = await io.open(filePath, 'r') } catch (error) {
        if (error?.code !== 'ENOENT' || durabilityFailure) throw error
      }
      if (handle) {
        await syncAndClose(handle)
        await syncAndClose(await io.open(dirname(filePath), 'r'))
      }
      confirmed = true
      durabilityFailure = undefined
    } catch (error) {
      confirmed = false
      durabilityFailure = error
      throw error
    }
  }
  const requireReliable = async () => {
    if (durabilityFailure) throw Object.assign(new Error('产品存储尚未可靠确认，暂时不可用', { cause: durabilityFailure }), { code: 'STORE_UNAVAILABLE' })
    if (!confirmed) await confirmDurability()
  }
  const readState = async () => {
    try {
      return migrateState(JSON.parse(await io.readFile(filePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return structuredClone(EMPTY_STATE)
    }
  }

  return {
    read() {
      return enqueue(async () => { await requireReliable(); return readState() })
    },

    confirmDurability() {
      return enqueue(confirmDurability)
    },

    update(mutator, options = {}) {
      return enqueue(async () => {
        await requireReliable()
        const current = await readState()
        const immutableBaseline = structuredClone(current)
        const next = migrateState(await mutator(current))
        assertActionFactsImmutable(immutableBaseline, next)
        assertExecutionFactsImmutable(immutableBaseline, next)
        assertConversationFactsImmutable(immutableBaseline, next)
        assertChannelFactsImmutable(immutableBaseline, next)
        assertAutomationFactsImmutable(immutableBaseline, next)
        await io.mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        const fileName = filePath.split('/').pop()
        const tempPath = join(dirname(filePath), `.${fileName}.${process.pid}.tmp`)
        let tempHandle, committed = false
        try {
          tempHandle = await io.open(tempPath, 'w', 0o600)
          await tempHandle.writeFile(JSON.stringify(next, null, 2) + '\n')
          await tempHandle.sync()
          await tempHandle.close()
          tempHandle = undefined
          await options.beforeCommit?.()
          await io.rename(tempPath, filePath)
          committed = true
          await syncAndClose(await io.open(dirname(filePath), 'r'))
        } catch (error) {
          if (committed) {
            // Rename may have exposed new facts before the directory became durable.
            confirmed = false
            durabilityFailure = error
          }
          throw error
        } finally {
          await tempHandle?.close().catch(() => undefined)
          if (!committed) await io.unlink(tempPath).catch(() => undefined)
        }
        return next
      })
    },
  }
}

export function migrateState(value) {
  if (!record(value)) throw new Error('产品状态不是对象')
  if ([11, STATE_VERSION].includes(value.version)) return normalizeV11(value)
  return normalizeV11({ ...migrateLegacyState(value), version: STATE_VERSION, automationInbox: [] })
}

function migrateLegacyState(value) {
  if (!record(value)) throw new Error('产品状态不是对象')
  if (value.version !== undefined && !Number.isInteger(value.version)) throw new Error('产品状态版本无效')
  const version = value.version ?? 3
  if (version > 10) throw new Error(`不支持未来产品状态版本：${version}`)
  if (version === 10) return normalizeV10(value)
  if (version === 9) return migrateV9ToV10(value)
  if (version === 8) return migrateV9ToV10(migrateV8ToV9(normalizeV8(value)))
  if (version === 7) return migrateV9ToV10(migrateV8ToV9(migrateV7ToV8(normalizeV7(value))))
  if (version === 6) return migrateV9ToV10(migrateV8ToV9(migrateV7ToV8(migrateV6ToV7(value))))
  if (version === 5) return migrateV9ToV10(migrateV8ToV9(migrateV7ToV8(migrateV6ToV7(migrateV5(value)))))
  if (version === 4) return migrateV9ToV10(migrateV8ToV9(migrateV7ToV8(migrateV6ToV7(migrateV5(migrateV4(value))))))
  if (version === 3) return migrateV9ToV10(migrateV8ToV9(migrateV7ToV8(migrateV6ToV7(migrateV5(migrateV4(migrateV3(value)))))))
  throw new Error(`不支持产品状态版本：${version}`)
}

function migrateV3(value) {
  if (value.operator !== undefined && !record(value.operator)) throw new Error('旧操作者状态无效')
  const employees = legacyArray(value, 'employees')
  const connections = legacyArray(value, 'connections')
  const skills = legacyArray(value, 'skills')
  const works = legacyArray(value, 'works')
  const modelRoutes = legacyArray(value, 'modelRoutes')
  const confirmations = legacyArray(value, 'confirmations')
  const reservations = legacyObject(value, 'reservations')
  const now = migrationTime(works)
  const migratedEmployees = employees.map(migrateEmployee)
  const admin = {
    id: ADMIN_MEMBER_ID,
    loginName: 'admin',
    displayName: text(value.operator?.displayName) ?? '本机管理员',
    role: 'admin',
    enabled: true,
    authRef: ADMIN_MEMBER_ID,
    sessionVersion: 1,
    employeeIds: migratedEmployees.map(item => item.id),
    createdAt: now,
    updatedAt: now,
  }
  const { operator: _operator, ...rest } = value
  return normalizeV4({
    ...rest,
    version: 4,
    members: [admin],
    modelRoutes,
    employees: migratedEmployees,
    connections: connections.map(migrateConnection),
    skills: skills.map(migrateSkill),
    confirmations,
    works: works.map(migrateWork),
    reservations: migrateReservations(reservations, value.operator?.id),
  })
}

function migrateV4(value) {
  return normalizeV5({ ...normalizeV4(value), version: 5, knowledgeMaterials: [] })
}

function migrateV5(value) {
  return normalizeV6({
    ...normalizeV5(value),
    version: 6,
    channelApps: [],
    channelIdentities: [],
    channelConversations: [],
    channelMessages: [],
    deliveries: [],
    linkCodes: [],
  })
}

function migrateV6ToV7(value) {
  return normalizeV7({ ...normalizeV6(value), version: 7, automationRules: [], automationOccurrences: [] })
}

function migrateV7ToV8(value) {
  return normalizeV8({ ...value, version: 8, works: value.works.map(work => ({ ...work, actions: [] })) })
}

function migrateV8ToV9(value) {
  return normalizeV9({ ...value, version: 9, conversations: value.conversations ?? [] })
}

function migrateV9ToV10(value) {
  const targets = new Map()
  const automationRules = requiredArray(value, 'automationRules').map(rule => {
    const endpoints = value.channelConversations.filter(item => item.id === rule.notificationConversationId && item.type === 'private' && item.memberId === rule.ownerMemberId)
    const identity = endpoints.length === 1 && value.channelIdentities.find(item => item.id === endpoints[0].identityId && item.memberId === rule.ownerMemberId && item.channelAppId === endpoints[0].channelAppId)
    targets.set(rule.id, identity?.id ?? null)
    return identity || rule.notificationConversationId === null ? rule : { ...rule, notificationConversationId: null }
  })
  const common = normalizeV9({ ...value, automationRules })
  return normalizeV10({ ...common, version: 10, defaultChannelEmployeeId: null,
    channelApps: common.channelApps.map(item => item.provider === 'weixin' && item.id !== 'channel-app-weixin'
      ? { ...item, enabled: false, status: 'disabled', revision: item.revision + (item.enabled ? 1 : 0) } : item),
    channelIdentities: common.channelIdentities.map(item => ({ ...item, defaultEmployeeId: null, activeConversationId: null })),
    automationRules: common.automationRules.map(({ notificationConversationId: _legacy, ...rule }) => ({ ...rule, notificationIdentityId: targets.get(rule.id) })),
  })
}

function migrateEmployee(employee) {
  if (!record(employee)) throw new Error('旧员工状态无效')
  return {
    ...employee,
    id: requiredText(employee.id, '旧员工 ID 无效'),
    enabled: employee.enabled !== false,
    modelRouteId: text(employee.modelRouteId) ?? null,
    connectionIds: nestedArray(employee, 'connectionIds'),
    skillIds: nestedArray(employee, 'skillIds'),
  }
}

function migrateConnection(connection) {
  if (!record(connection)) throw new Error('旧连接状态无效')
  const baseUrl = text(connection.baseUrl) ?? null
  const credentialRef = text(connection.credentialRef) ?? null
  return {
    ...connection,
    id: requiredText(connection.id, '旧连接 ID 无效'),
    enabled: connection.enabled !== false,
    targetIdentity: text(connection.targetIdentity) ?? null,
    baseUrl,
    hostHeader: text(connection.hostHeader) ?? null,
    credentialRef,
    skillIds: nestedArray(connection, 'skillIds'),
    revision: Number.isSafeInteger(connection.revision) && connection.revision > 0 ? connection.revision : 1,
    status: baseUrl && credentialRef ? text(connection.status) ?? 'unknown' : 'unavailable',
  }
}

function migrateSkill(skill) {
  if (!record(skill)) throw new Error('旧 Skill 状态无效')
  const id = requiredText(skill.id, '旧 Skill ID 无效')
  const knownGearJobSkill = id === GEARJOB_SKILL_ID
    && (!text(skill.action) || skill.action === GEARJOB_SKILL_ACTION)
    && (!text(skill.toolName) || skill.toolName === GEARJOB_TOOL_NAME)
  const { action: _action, toolName: _toolName, ...rest } = skill
  return {
    ...rest,
    id,
    capabilityId: knownGearJobSkill ? GEARJOB_CAPABILITY_ID : null,
    enabled: knownGearJobSkill && skill.enabled !== false,
  }
}

function migrateWork(work) {
  if (!record(work)) throw new Error('工作状态无效')
  const workId = requiredText(work.id, '旧工作 ID 无效')
  const observations = nestedArray(work, 'observations')
  const followUps = nestedArray(work, 'followUps')
  const migrated = [
    ...observations.map((observation, index) => migrateObservation(work, observation, index)),
    ...followUps.map((followUp, index) => migrateFollowUp(work, followUp, index)),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  const resultIds = new Set(migrated.map(result => result.id))
  if (resultIds.size !== migrated.length) throw new Error(`旧工作 ${workId} 的结果 ID 重复`)
  const executions = nestedArray(work, 'executions').map(execution => migrateExecution(execution, resultIds))
  const { observations: _observations, followUps: _followUps, operatorId: _operatorId, ...rest } = work
  return {
    ...rest,
    id: workId,
    ownerMemberId: text(work.ownerMemberId) ?? ADMIN_MEMBER_ID,
    skillId: text(work.skillId) ?? GEARJOB_SKILL_ID,
    capabilityId: text(work.capabilityId) ?? GEARJOB_CAPABILITY_ID,
    results: migrated,
    executions,
  }
}

function migrateExecution(execution, resultIds) {
  if (!record(execution)) throw new Error('旧执行状态无效')
  const observationRef = text(execution.resultObservationId)
  const followUpRef = text(execution.resultFollowUpId)
  if (observationRef && followUpRef && observationRef !== followUpRef) throw new Error('旧执行包含冲突结果引用')
  const resultId = observationRef ?? followUpRef ?? text(execution.resultId)
  if (resultId && !resultIds.has(resultId)) throw new Error(`旧执行引用不存在的结果：${resultId}`)
  return resultId ? { ...execution, resultId } : { ...execution }
}

function migrateObservation(work, observation, index) {
  if (!record(observation)) throw new Error('历史观察无效')
  const workId = requiredText(work.id, '旧工作 ID 无效')
  const id = text(observation.observationId) ?? `legacy-observation-${workId}-${index}`
  const workOrderId = text(work.workOrderId) ?? text(observation.workOrderId)
  if (!workOrderId) throw new Error(`历史观察 ${id} 缺少工单号`)
  return compact({
    id,
    kind: 'gearjob.work-order.observation',
    capabilityId: GEARJOB_CAPABILITY_ID,
    skillId: text(work.skillId) ?? GEARJOB_SKILL_ID,
    schemaVersion: 1,
    input: { workOrderId },
    payload: { ...structuredClone(observation), observationId: id },
    explanation: text(observation.explanation),
    source: compact({
      sourceSystem: observation.sourceSystem,
      sourceInstance: observation.sourceInstance,
      sourceEnvironment: observation.sourceEnvironment,
      dataMode: observation.dataMode,
      sourceRecordId: observation.sourceRecordId,
      sourceRevision: observation.sourceRevision,
      sourceTime: observation.sourceTime,
    }),
    createdAt: resultTime(observation.queriedAt, work.acceptedAt),
    toolName: GEARJOB_TOOL_NAME,
    pluginId: GEARJOB_PLUGIN_ID,
    dshSessionRef: text(observation.dshSessionRef),
    continuedFromDshSessionRef: text(observation.continuedFromDshSessionRef),
    contextObservationId: text(observation.contextObservationId),
    continuity: text(observation.continuity),
    contextConfirmationRefs: [],
  })
}

function migrateFollowUp(work, followUp, index) {
  if (!record(followUp)) throw new Error('历史追问无效')
  const workId = requiredText(work.id, '旧工作 ID 无效')
  const id = text(followUp.id) ?? `legacy-follow-up-${workId}-${index}`
  const followUpText = requiredText(followUp.text, `历史追问 ${id} 缺少文本`)
  return compact({
    id,
    kind: 'assistant.follow-up',
    capabilityId: text(work.capabilityId) ?? GEARJOB_CAPABILITY_ID,
    skillId: text(work.skillId) ?? GEARJOB_SKILL_ID,
    schemaVersion: 1,
    input: { text: followUpText },
    payload: { text: followUpText },
    explanation: text(followUp.explanation),
    createdAt: resultTime(followUp.at, work.acceptedAt),
    dshSessionRef: text(followUp.dshSessionRef),
    continuedFromDshSessionRef: text(followUp.continuedFromDshSessionRef),
    contextObservationId: text(followUp.contextObservationId),
    continuity: text(followUp.continuity),
    contextConfirmationRefs: [],
  })
}

function normalizeV4(value, { allowKnowledgeDependencyRefs = false } = {}) {
  const members = requiredArray(value, 'members').map(member => {
    if (!record(member)) throw new Error('成员状态无效')
    if (!['admin', 'member'].includes(member.role)) throw new Error('成员角色无效')
    if (typeof member.enabled !== 'boolean') throw new Error('成员启用状态无效')
    if (!Number.isSafeInteger(member.sessionVersion) || member.sessionVersion < 1) throw new Error('成员会话版本无效')
    return {
      ...member,
      id: requiredText(member.id, '成员 ID 无效'),
      loginName: requiredText(member.loginName, '成员登录名无效'),
      authRef: requiredText(member.authRef, '成员认证引用无效'),
      employeeIds: nestedArray(member, 'employeeIds'),
    }
  })
  uniqueIds(members, '成员')

  const works = requiredArray(value, 'works').map(work => {
    if (!record(work)) throw new Error('工作状态无效')
    if ('observations' in work || 'followUps' in work || 'operatorId' in work) throw new Error('v4 工作不得持久化旧结果字段')
    const workId = requiredText(work.id, '工作 ID 无效')
    requiredText(work.ownerMemberId, `工作 ${workId} ownerMemberId 无效`)
    requiredText(work.employeeId, `工作 ${workId} employeeId 无效`)
    requiredText(work.skillId, `工作 ${workId} skillId 无效`)
    requiredText(work.capabilityId, `工作 ${workId} capabilityId 无效`)
    const results = requiredArray(work, 'results').map(result => normalizeResult(result, { allowKnowledgeDependencyRefs }))
    uniqueIds(results, `工作 ${workId} 的结果`)
    const resultIds = new Set(results.map(result => result.id))
    const executions = requiredArray(work, 'executions').map(execution => {
      if (!record(execution)) throw new Error('执行状态无效')
      if (execution.modelSnapshot !== undefined) validateModelSnapshot(execution.modelSnapshot)
      if (execution.runtime !== undefined) {
        validateExecutionRuntime(execution.runtime)
        if (execution.modelSnapshot && ['modelRouteId', 'provider', 'model', 'parameters'].some(key => !isDeepStrictEqual(execution.runtime[key], execution.modelSnapshot[key]))) throw new Error('执行运行反馈与冻结模型不匹配')
      }
      if (execution.closePending !== undefined && typeof execution.closePending !== 'boolean') throw new Error('执行关闭状态无效')
      requiredText(execution.id, `工作 ${workId} 的执行 ID 无效`)
      const observationRef = text(execution.resultObservationId)
      const followUpRef = text(execution.resultFollowUpId)
      if (observationRef && followUpRef && observationRef !== followUpRef) throw new Error('执行包含冲突结果引用')
      const legacyRef = observationRef ?? followUpRef
      const resultId = text(execution.resultId)
      if (legacyRef && legacyRef !== resultId) throw new Error(`执行 legacy 结果引用与 resultId 不匹配：${execution.id}`)
      if (resultId && !resultIds.has(resultId)) throw new Error(`执行引用不存在的结果：${resultId}`)
      return execution
    })
    uniqueIds(executions, `工作 ${workId} 的执行`)
    return { ...work, id: workId, results, executions }
  })
  uniqueIds(works, '工作')

  const modelRoutes = entityArray(value, 'modelRoutes', '模型路由')
  const employees = entityArray(value, 'employees', '员工').map(employee => {
    if (Object.hasOwn(employee, 'memberIds')) throw new Error('Agent 开放成员只能由成员 employeeIds 保存')
    if (employee.revision !== undefined && (!Number.isSafeInteger(employee.revision) || employee.revision < 1)) throw new Error('Agent revision 无效')
    if (employee.instructions !== undefined && (typeof employee.instructions !== 'string' || employee.instructions.length > 16_000)) throw new Error('Agent instructions 无效')
    return employee
  })
  const connections = entityArray(value, 'connections', '连接').map(connection => {
    if (connection.kind === 'kivo-mcp') connectionSnapshot(connection)
    return connection
  })
  const skills = entityArray(value, 'skills', 'Skill')
  const confirmations = entityArray(value, 'confirmations', '确认信息')

  const { operator: _operator, ...rest } = value
  return {
    ...rest,
    version: 4,
    members,
    modelRoutes,
    employees,
    connections,
    skills,
    confirmations,
    works,
    reservations: requiredObject(value, 'reservations'),
  }
}

function normalizeV5(value) {
  const { knowledgeMaterials: _knowledgeMaterials, ...legacy } = value
  const common = normalizeV4({ ...legacy, version: 4 }, { allowKnowledgeDependencyRefs: true })
  const knowledgeMaterials = requiredArray(value, 'knowledgeMaterials').map(normalizeKnowledgeMaterial)
  uniqueIds(knowledgeMaterials, '知识材料')
  const activeMaterials = knowledgeMaterials.filter(item => item.status === 'active')
  if (activeMaterials.length > KNOWLEDGE_LIMITS.maxMaterials) throw new Error('活动知识材料超过数量上限')
  if (activeMaterials.reduce((sum, item) => sum + Buffer.byteLength(item.body, 'utf8'), 0) > KNOWLEDGE_LIMITS.maxTotalBodyBytes) throw new Error('活动知识材料超过总容量上限')

  const memberIds = new Set(common.members.map(item => item.id))
  const employeeIds = new Set(common.employees.map(item => item.id))
  for (const material of knowledgeMaterials) {
    if (!memberIds.has(material.ownerMemberId)) throw new Error(`知识材料 ${material.id} ownerMemberId 不存在`)
    if (material.status === 'deleted') continue
    for (const id of [...material.employeeIds, ...material.sharedEmployeeIds]) {
      if (!employeeIds.has(id)) throw new Error(`知识材料 ${material.id} 引用不存在的员工：${id}`)
    }
    for (const id of material.sharedMemberIds) {
      if (!memberIds.has(id)) throw new Error(`知识材料 ${material.id} 引用不存在的成员：${id}`)
    }
  }
  const materialById = new Map(knowledgeMaterials.map(item => [item.id, item]))
  for (const result of common.works.flatMap(work => work.results)) {
    for (const ref of result.knowledgeDependencyRefs ?? []) {
      const material = materialById.get(ref.knowledgeId)
      if (!material) throw new Error(`结果 ${result.id} 引用不存在的知识：${ref.knowledgeId}`)
      if (ref.revision > material.revision) throw new Error(`结果 ${result.id} 知识引用 revision 超前`)
      if (material.status === 'active' && ref.revision === material.revision && !segmentKnowledgeBody(material.body).some(segment => segment.segmentId === ref.segmentId)) throw new Error(`结果 ${result.id} 知识 segment 不存在`)
    }
  }

  normalizeCollaborations(common.works, memberIds, { ...common, knowledgeMaterials })

  return { ...common, version: 5, knowledgeMaterials }
}

function normalizeV6(value, { channels = false } = {}) {
  const {
    channelApps: _channelApps,
    channelIdentities: _channelIdentities,
    channelConversations: _channelConversations,
    channelMessages: _channelMessages,
    deliveries: _deliveries,
    linkCodes: _linkCodes,
    ...legacy
  } = value
  const common = normalizeV5({ ...legacy, version: 5 })
  const channelApps = requiredArray(value, 'channelApps').map(item => normalizeChannelApp(item, channels))
  const channelIdentities = requiredArray(value, 'channelIdentities').map(item => normalizeChannelIdentity(item, channels))
  const channelConversations = requiredArray(value, 'channelConversations').map(item => normalizeChannelConversation(item, channels))
  const channelMessages = requiredArray(value, 'channelMessages').map(item => normalizeChannelMessage(item, channels))
  const deliveries = requiredArray(value, 'deliveries').map(item => normalizeDelivery(item, channels))
  const linkCodes = requiredArray(value, 'linkCodes').map(item => normalizeLinkCode(item, channels))
  for (const [items, label] of [[channelApps, '渠道应用'], [channelIdentities, '渠道身份'], [channelConversations, '渠道会话'], [channelMessages, '渠道消息'], [deliveries, '渠道投递'], [linkCodes, '关联码']]) uniqueIds(items, label)

  uniqueDomain(channelApps.filter(item => !channels || item.provider !== 'weixin' || item.id === 'channel-app-weixin'), item => [item.provider, item.providerTenantId, item.providerAppId], '渠道应用官方 identity')
  const currentIdentity = item => !channels || ['pending', 'active'].includes(item.status)
  uniqueDomain(channelIdentities.filter(currentIdentity), item => [item.channelAppId, item.weixin?.botId ?? '', item.providerUserId], '渠道身份官方 identity')
  if (channels) uniqueDomain(channelIdentities.filter(item => currentIdentity(item) && item.weixin), item => [item.channelAppId, item.weixin.botId], '微信 bot identity')
  const accountByIdentity = new Map(channelIdentities.map(item => [item.id, item.weixin?.botId ?? '']))
  uniqueDomain(channelConversations.filter(currentIdentity), item => [item.channelAppId, accountByIdentity.get(item.identityId) ?? '', item.providerConversationId], '渠道会话官方 identity')
  uniqueDomain(channelMessages.filter(item => item.providerEventId), item => [item.channelAppId, item.providerAccountId ?? '', item.providerEventId], '渠道 event')
  uniqueDomain(channelMessages.filter(item => item.providerMessageId), item => [item.channelAppId, item.providerAccountId ?? '', item.providerMessageId], '渠道 message')
  uniqueDomain(deliveries, item => [item.channelAppId, item.requestId], '渠道投递 request')
  uniqueDomain(deliveries.filter(item => item.providerMessageId), item => [item.channelAppId, item.providerMessageId], '渠道投递 message')
  uniqueDomain(linkCodes, item => [item.digest], '关联码摘要')

  const appById = new Map(channelApps.map(item => [item.id, item]))
  const memberById = new Map(common.members.map(item => [item.id, item]))
  const identityById = new Map(channelIdentities.map(item => [item.id, item]))
  const conversationById = new Map(channelConversations.map(item => [item.id, item]))
  const messageById = new Map(channelMessages.map(item => [item.id, item]))
  const workById = new Map(common.works.map(item => [item.id, item]))
  const employeeById = new Map(common.employees.map(item => [item.id, item]))
  const skillById = new Map(common.skills.map(item => [item.id, item]))
  const connectionById = new Map(common.connections.map(item => [item.id, item]))

  for (const identity of channelIdentities) {
    if (!appById.has(identity.channelAppId) || !memberById.has(identity.memberId)) throw new Error(`渠道身份 ${identity.id} 引用不存在`)
    if (channels && identity.weixin && appById.get(identity.channelAppId).provider !== 'weixin') throw new Error('微信身份必须属于微信应用')
  }
  for (const conversation of channelConversations) {
    const app = appById.get(conversation.channelAppId), identity = identityById.get(conversation.identityId)
    if (!app || (conversation.type === 'private' && (!memberById.has(conversation.memberId) || !identity || identity.channelAppId !== app.id || identity.memberId !== conversation.memberId))) throw new Error(`渠道会话 ${conversation.id} 引用不闭合`)
    if (conversation.defaultDispatch) validateDefaultDispatch(conversation, common, memberById, employeeById, skillById, connectionById)
  }
  for (const message of channelMessages) {
    const app = appById.get(message.channelAppId)
    if (!app) throw new Error(`渠道消息 ${message.id} 应用引用无效`)
    const conversation = message.conversationId && conversationById.get(message.conversationId)
    const identity = message.senderIdentityId && identityById.get(message.senderIdentityId)
    if ((message.conversationId && (!conversation || conversation.channelAppId !== app.id)) || (message.senderIdentityId && (!identity || identity.channelAppId !== app.id))) throw new Error(`渠道消息 ${message.id} 身份或会话引用无效`)
    if (channels && message.providerAccountId !== undefined && (app.provider !== 'weixin' || identity && identity.weixin?.botId !== message.providerAccountId)) throw new Error(`渠道消息 ${message.id} 微信账号引用无效`)
    if (message.workId) {
      const work = workById.get(message.workId)
      if (!work || (identity && work.ownerMemberId !== identity.memberId)) throw new Error(`渠道消息 ${message.id} 工作引用无效`)
    }
    const authorizationConversation = conversation?.type === 'group'
      ? channelConversations.find(item => item.channelAppId === app.id && item.identityId === identity?.id && item.type === 'private')
      : conversation
    if (message.authorizationRevisions && (!identity || !authorizationConversation || message.authorizationRevisions.app > app.revision || message.authorizationRevisions.identity > identity.revision || message.authorizationRevisions.conversation > authorizationConversation.revision)) throw new Error(`渠道消息 ${message.id} 授权 revision 引用无效`)
    if (channels && message.action) {
      const memberConversation = value.conversations.find(item => item.id === message.memberConversationId)
      if (!memberConversation || !identity || !conversation || message.direction !== 'inbound'
        || memberConversation.ownerMemberId !== identity.memberId || memberConversation.channelIdentityId !== identity.id || memberConversation.source !== app.provider
        || message.providerUserId !== identity.providerUserId || message.providerConversationId !== conversation.providerConversationId
        || (conversation.type === 'private' && conversation.identityId !== identity.id)) throw new Error(`渠道消息 ${message.id} 对话引用不闭合`)
      if (message.turnId) {
        const turn = memberConversation.turns.find(item => item.id === message.turnId)
        if (!turn || turn.clientRequestId !== message.clientRequestId || turn.userText !== message.text) throw new Error(`渠道消息 ${message.id} turn 引用不闭合`)
      }
    } else if (message.status === 'accepted') {
      const work = workById.get(message.workId)
      if (message.direction !== 'inbound' || !conversation || !identity || (conversation.type === 'private' && (conversation.identityId !== identity.id || conversation.memberId !== identity.memberId)) || work?.ownerMemberId !== identity.memberId
        || message.providerUserId !== identity.providerUserId || message.providerConversationId !== conversation.providerConversationId) throw new Error(`渠道消息 ${message.id} accepted 引用不闭合`)
      if (message.command?.type === 'create') {
        const reservation = common.reservations[`${identity.memberId}|create|${message.clientRequestId}`]
        if (work.capabilityId !== GEARJOB_CAPABILITY_ID || work.input?.workOrderId !== message.command.workOrderId || !reservation || reservation.workId !== work.id) throw new Error(`渠道消息 ${message.id} create 工作引用不闭合`)
      }
      if (message.command?.type === 'follow-up') {
        const reservation = common.reservations[`${identity.memberId}|${work.id}|follow-up|${message.clientRequestId}`]
        if (!reservation || reservation.workId !== work.id) throw new Error(`渠道消息 ${message.id} follow-up reservation 不闭合`)
      }
      if (message.replyToProviderMessageId && ['follow-up', 'stop'].includes(message.command?.type)) {
        const replyWorkIds = new Set([
          ...deliveries.filter(item => item.channelAppId === app.id && item.targetConversationId === conversation.id && item.providerMessageId === message.replyToProviderMessageId).map(item => item.workId),
          ...channelMessages.filter(item => item.channelAppId === app.id && item.conversationId === conversation.id && item.direction === 'outbound' && item.providerMessageId === message.replyToProviderMessageId && item.workId).map(item => item.workId),
        ])
        if (replyWorkIds.size !== 1 || !replyWorkIds.has(work.id)) throw new Error(`渠道消息 ${message.id} reply 工作引用不闭合`)
      }
    }
  }
  for (const delivery of deliveries) {
    const app = appById.get(delivery.channelAppId), work = delivery.workId && workById.get(delivery.workId)
    const identity = identityById.get(delivery.targetIdentityId), conversation = conversationById.get(delivery.targetConversationId)
    const fixed = ['group.accepted', 'help.unsupported', 'help.unavailable', ...(channels ? ['help.confirmation', 'help.busy', 'help.interrupted', 'help.reply-invalid', 'conversation.started', 'conversation.default-changed'] : [])].includes(delivery.contentKey)
    const source = channels && delivery.sourceRef && value.conversations.find(item => item.id === delivery.sourceRef.conversationId)
    const turn = source && source.turns.find(item => item.id === delivery.sourceRef.turnId)
    if (!app || (!fixed && !work && !source) || !identity || !conversation || identity.channelAppId !== app.id || conversation.channelAppId !== app.id
      || (work && identity.memberId !== work.ownerMemberId) || (conversation.type === 'private' && (conversation.memberId !== identity.memberId || conversation.identityId !== identity.id))) throw new Error(`渠道投递 ${delivery.id} 引用不闭合`)
    if (delivery.sourceRef && (!source || source.ownerMemberId !== identity.memberId || source.channelIdentityId !== identity.id || source.source !== app.provider || turn?.status !== 'completed')) throw new Error(`渠道投递 ${delivery.id} 回复引用不闭合`)
    if (delivery.resultId && !work.results.some(item => item.id === delivery.resultId)) throw new Error(`渠道投递 ${delivery.id} 结果引用不存在`)
    if (delivery.actionId) {
      const action = work?.actions.find(item => item.id === delivery.actionId && item.intent.kind === KIVO_REPAIR_ACTION && item.receipt && item.preview.resultId === delivery.resultId)
      if (!action) throw new Error(`渠道投递 ${delivery.id} 动作回执引用不闭合`)
      assertRepairReceipt(action.receipt, action)
    }
    if (delivery.channelMessageId) {
      const message = messageById.get(delivery.channelMessageId)
      if (!message || message.channelAppId !== app.id || (message.workId && message.workId !== work?.id)
        || (source && (message.memberConversationId !== source.id || message.clientRequestId !== turn.clientRequestId || message.turnId && message.turnId !== turn.id))) throw new Error(`渠道投递 ${delivery.id} 消息引用无效`)
    }
  }
  for (const link of linkCodes) {
    if (!appById.has(link.channelAppId) || !memberById.has(link.memberId)) throw new Error(`关联码 ${link.id} 引用不存在`)
    if (link.matchedIdentityId || link.matchedConversationId) {
      const identity = identityById.get(link.matchedIdentityId), conversation = conversationById.get(link.matchedConversationId)
      if (!identity || !conversation || identity.channelAppId !== link.channelAppId || conversation.channelAppId !== link.channelAppId || identity.memberId !== link.memberId || conversation.memberId !== link.memberId || conversation.identityId !== identity.id) throw new Error(`关联码 ${link.id} 匹配引用不闭合`)
      if (link.kind === 'weixin-qr' && (appById.get(link.channelAppId)?.provider !== 'weixin' || identity.verificationMethod !== 'weixin-qr' || conversation.verificationMethod !== 'weixin-qr'
        || ['tokenRef', 'cursorRef', 'contextRef'].some(key => link[key] !== identity.weixin?.[key]))) throw new Error(`微信关联码 ${link.id} 身份秘密引用不闭合`)
    }
    if (link.kind === 'weixin-qr' && link.channelAppId !== 'channel-app-weixin') throw new Error('微信扫码必须使用内置应用')
  }
  for (const link of linkCodes.filter(item => item.status === 'active')) {
    if (linkCodes.some(item => item !== link && item.status === 'active' && item.memberId === link.memberId && item.channelAppId === link.channelAppId)) throw new Error('每名成员与渠道应用只能有一个活动关联码')
  }

  return { ...common, version: 6, channelApps, channelIdentities, channelConversations, channelMessages, deliveries, linkCodes }
}

function normalizeV7(value, options = {}) {
  const { automationRules: _automationRules, automationOccurrences: _automationOccurrences, ...legacy } = value
  const common = normalizeV6({ ...legacy, version: 6 }, options)
  const automationRules = requiredArray(value, 'automationRules').map(item => item.capabilityId === 'kivo-tpm-record-read' && options.kivoEvents ? normalizeKivoAutomationRule(item) : normalizeAutomationRule(item, options.channels))
  const automationOccurrences = requiredArray(value, 'automationOccurrences').map(item => item.query && options.kivoEvents ? normalizeKivoAutomationOccurrence(item) : normalizeAutomationOccurrence(item))
  uniqueIds(automationRules, '自动规则')
  uniqueIds(automationOccurrences, '自动发生')
  const occurrenceKeys = new Set()
  const memberById = new Map(common.members.map(item => [item.id, item]))
  const employeeById = new Map(common.employees.map(item => [item.id, item]))
  const skillById = new Map(common.skills.map(item => [item.id, item]))
  const connectionById = new Map(common.connections.map(item => [item.id, item]))
  const conversationById = new Map(common.channelConversations.map(item => [item.id, item]))
  const identityById = new Map(common.channelIdentities.map(item => [item.id, item]))
  const appById = new Map(common.channelApps.map(item => [item.id, item]))
  const workById = new Map(common.works.map(item => [item.id, item]))
  const deliveryById = new Map(common.deliveries.map(item => [item.id, item]))
  const ruleById = new Map(automationRules.map(item => [item.id, item]))

  for (const rule of automationRules) {
    const owner = memberById.get(rule.ownerMemberId)
    const employee = employeeById.get(rule.employeeId)
    const skill = skillById.get(rule.skillId)
    const connection = connectionById.get(rule.connectionId)
    if (!owner || !employee || !skill || !connection) throw new Error(`自动规则 ${rule.id} 绑定引用不闭合`)
    if (options.channels && rule.notificationIdentityId !== null) {
      const identity = identityById.get(rule.notificationIdentityId)
      if (!identity || identity.memberId !== owner.id || !appById.has(identity.channelAppId)) throw new Error(`自动规则 ${rule.id} 通知身份引用不闭合`)
    } else if (!options.channels && rule.notificationConversationId !== null) {
      const conversation = conversationById.get(rule.notificationConversationId)
      const identity = conversation && identityById.get(conversation.identityId)
      const app = conversation && appById.get(conversation.channelAppId)
      if (!conversation || conversation.type !== 'private' || conversation.memberId !== owner.id
        || !identity || identity.id !== conversation.identityId || identity.memberId !== owner.id || identity.channelAppId !== conversation.channelAppId
        || !app || app.id !== conversation.channelAppId) throw new Error(`自动规则 ${rule.id} 通知会话引用不闭合`)
    }
    if (rule.status === 'revoked' ? !rule.revokedAt : rule.revokedAt !== null) throw new Error(`自动规则 ${rule.id} revokedAt 状态不闭合`)
    if (rule.capabilityId === 'kivo-tpm-record-read') {
      if (skill.capabilityId !== rule.capabilityId || connection.kind !== 'kivo-mcp') throw new Error('TPM 自动规则能力或连接引用不闭合')
      continue
    }
    const event = rule.trigger.kind === 'gearjob-work-order-update'
    if (event && rule.effectiveFrom !== null) throw new Error(`自动规则 ${rule.id} event effectiveFrom 状态不闭合`)
    if (!event && ((rule.status === 'draft' && rule.effectiveFrom !== null) || (['active', 'paused'].includes(rule.status) && !rule.effectiveFrom))) throw new Error(`自动规则 ${rule.id} effectiveFrom 状态不闭合`)
    if (!event && rule.eventAcceptAfter !== null) throw new Error(`自动规则 ${rule.id} daily eventAcceptAfter 状态不闭合`)
    if (event && rule.status === 'draft' && rule.eventAcceptAfter !== null) throw new Error(`自动规则 ${rule.id} draft eventAcceptAfter 状态不闭合`)
    if (event && ['active', 'paused'].includes(rule.status) && rule.eventAcceptAfter === null) throw new Error(`自动规则 ${rule.id} active eventAcceptAfter 缺失`)
  }
  const workOccurrenceIds = new Set(), deliveryOccurrenceIds = new Set(), successfulByRule = new Map()
  for (const occurrence of automationOccurrences) {
    const rule = ruleById.get(occurrence.ruleId)
    const identityClosed = rule?.capabilityId === 'kivo-tpm-record-read' && occurrence.query
      ? occurrence.activationId <= rule.revision && occurrence.query.objectId === rule.objectId
        && (occurrence.scheduledDate !== null ? dailyAutomationOccurrenceKey(rule.id, occurrence.scheduledDate) === occurrence.occurrenceKey
          : occurrence.occurrenceKey.startsWith(`${rule.id}:manual:`) || occurrence.occurrenceKey === kivoAutomationClaimKey(rule.id, occurrence.query))
      : rule?.trigger.kind === 'daily-time' && occurrence.event === null
      ? occurrence.scheduledDate !== null
        ? dailyAutomationOccurrenceKey(occurrence.ruleId, occurrence.scheduledDate) === occurrence.occurrenceKey
        : occurrence.occurrenceKey.startsWith(`${occurrence.ruleId}:manual:`) && occurrence.occurrenceKey.length > `${occurrence.ruleId}:manual:`.length
      : rule?.trigger.kind === 'gearjob-work-order-update' && occurrence.scheduledDate === null && occurrence.event?.sourceId === rule.trigger.sourceId
        && eventAutomationOccurrenceKey(rule, occurrence.event) === occurrence.occurrenceKey
    if (!rule || occurrence.ruleRevision > rule.revision || !identityClosed) throw new Error(`自动发生 ${occurrence.id} 规则引用不闭合`)
    if (occurrenceKeys.has(occurrence.occurrenceKey)) throw new Error(`自动发生 occurrenceKey 重复：${occurrence.occurrenceKey}`)
    occurrenceKeys.add(occurrence.occurrenceKey)
    if (occurrence.workId !== null) {
      if (workOccurrenceIds.has(occurrence.workId)) throw new Error(`自动发生 ${occurrence.id} 工作引用重复`)
      workOccurrenceIds.add(occurrence.workId)
      successfulByRule.set(rule.id, (successfulByRule.get(rule.id) ?? 0) + 1)
      const work = workById.get(occurrence.workId)
      if (!work || work.ownerMemberId !== rule.ownerMemberId) throw new Error(`自动发生 ${occurrence.id} 工作引用不闭合`)
      if (occurrence.query && (work.capabilityId !== rule.capabilityId || work.employeeId !== rule.employeeId || work.skillId !== rule.skillId
        || work.connectionId !== rule.connectionId || !isDeepStrictEqual(work.input, rule.input))) throw new Error('TPM 自动发生与工作身份不闭合')
    }
    if (occurrence.deliveryId !== null) {
      const delivery = deliveryById.get(occurrence.deliveryId)
      if (!delivery || delivery.workId !== occurrence.workId) throw new Error(`自动发生 ${occurrence.id} 投递引用不闭合`)
      if (deliveryOccurrenceIds.has(delivery.id)) throw new Error(`自动发生 ${occurrence.id} 投递引用重复`)
      deliveryOccurrenceIds.add(delivery.id)
    }
  }
  for (const delivery of common.deliveries) if (delivery.contentKey.startsWith('automation.') && !deliveryOccurrenceIds.has(delivery.id)) throw new Error(`自动投递 ${delivery.id} 未由发生回链`)
  for (const [ruleId, count] of successfulByRule) if (count > ruleById.get(ruleId).maxRuns) throw new Error(`自动规则 ${ruleId} 累计预算超限`)
  return { ...common, version: 7, automationRules, automationOccurrences }
}

function normalizeV8(value, options = {}) {
  const common = normalizeV7({ ...value, version: 7 }, options)
  const works = common.works.map(work => {
    const correlationResults = work.results.filter(result => result.kind === CORRELATION_RESULT_KIND)
    if (work.capabilityId === CORRELATION_CAPABILITY_ID) {
      const ids = exactRoleMap(work.connectionIds, `工作 ${work.id} connectionIds`, requiredText)
      if (ids.gearJob === ids.hive) throw new Error(`工作 ${work.id} 双来源连接不可相同`)
      if (work.connectionId !== undefined) throw new Error(`工作 ${work.id} 不得同时持有单连接`)
      for (const result of correlationResults) {
        if (result.skillId !== work.skillId || result.input.workOrderId !== work.input.workOrderId
          || result.payload.connections.gearJob.id !== ids.gearJob || result.payload.connections.hive.id !== ids.hive) throw new Error(`工作 ${work.id} 关联结果与工作绑定不匹配`)
      }
      for (const execution of work.executions) {
        const hasRevision = Object.hasOwn(execution, 'mappingRevision'), hasIdentity = Object.hasOwn(execution, 'mappingIdentity')
        if (execution.dispatchedAt && (!hasRevision || !hasIdentity)) throw new Error(`工作 ${work.id} execution mapping 绑定缺失`)
        if (hasRevision || hasIdentity) validateExecutionMappingBinding(execution.mappingRevision, execution.mappingIdentity, `工作 ${work.id} execution mapping`)
      }
    } else if (correlationResults.length) {
      throw new Error(`工作 ${work.id} 不得保存工单设备关联结果`)
    } else if (work.executions.some(execution => Object.hasOwn(execution, 'mappingRevision') || Object.hasOwn(execution, 'mappingIdentity'))) {
      throw new Error(`工作 ${work.id} 非关联 execution 不得包含 mapping 绑定`)
    }
    const actions = requiredArray(work, 'actions').map(action => normalizeAction(action, work))
    uniqueIds(actions, `工作 ${work.id} 的动作`)
    const requestKeys = actions.flatMap(action => action.requestKeys)
    if (new Set(requestKeys).size !== requestKeys.length) throw new Error(`工作 ${work.id} 的动作 requestKey 重复`)
    for (const action of actions) {
      const same = actions.filter(item => item.proposalKey === action.proposalKey)
      if (same.length < 2) continue
      const ordered = [...same].sort((a, b) => a.preview.createdAt.localeCompare(b.preview.createdAt))
      if (same.some(item => item.intent.kind !== KIVO_REPAIR_ACTION) || ordered.slice(0, -1).some(item => item.attempt && !item.attempt.noEffectAt
        || !item.decision?.invalidatedAt && !['rejected', 'revoked', 'expired'].includes(item.decision?.kind)
          && Date.parse(item.preview.expiresAt) > Date.parse(ordered.at(-1).preview.createdAt))) throw new Error(`工作 ${work.id} 的动作 proposalKey 重复`)
    }
    return { ...work, actions }
  })
  return { ...common, version: 8, works }
}

function normalizeV9(value, options = {}) {
  const common = normalizeV8({ ...value, version: 8 }, options)
  const conversations = requiredArray(value, 'conversations').map(item => normalizeConversation(item, options.channels))
  uniqueIds(conversations, '对话')
  const sessions = conversations.flatMap(conversation => conversation.sessions.map(session => session.id))
  if (new Set(sessions).size !== sessions.length) throw new Error('原生 Session 不得跨对话复用')
  const works = common.works.map(work => {
    const conversationId = work.conversationId === undefined || work.conversationId === null ? null : requiredText(work.conversationId, '工作对话引用无效')
    if (conversationId) {
      const conversation = conversations.find(item => item.id === conversationId)
      if (!conversation || conversation.ownerMemberId !== work.ownerMemberId || conversation.employeeId !== work.employeeId || work.rootWorkId) throw new Error(`工作 ${work.id} 对话归属不匹配`)
    }
    return { ...work, conversationId }
  })
  return { ...common, version: 9, conversations, works }
}

function normalizeV10(value, options = {}) {
  const common = normalizeV9(value, { ...options, channels: true })
  const defaultChannelEmployeeId = nullableId(value.defaultChannelEmployeeId, '全局渠道默认员工')
  if (defaultChannelEmployeeId && !common.employees.some(item => item.id === defaultChannelEmployeeId)) throw new Error('全局渠道默认员工不存在')
  for (const conversation of common.conversations) {
    if (!common.members.some(item => item.id === conversation.ownerMemberId)) throw new Error('对话成员不存在')
    for (const turn of conversation.turns) {
      for (const ref of turn.workDependencyRefs ?? []) {
        const work = common.works.find(item => item.id === ref.workId)
        const root = work?.rootWorkId ? common.works.find(item => item.id === work.rootWorkId && item.collaboration
          && item.collaboration.childWorkIds.includes(work.id) && item.plan.items.some(item => item.childWorkId === work.id && item.employeeId === work.employeeId)) : work
        if (!work || !root || work.ownerMemberId !== conversation.ownerMemberId || root.ownerMemberId !== conversation.ownerMemberId
          || root.employeeId !== conversation.employeeId || root.conversationId !== conversation.id
          || !work.results.some(item => item.id === ref.resultId)) throw new Error('回复工作事实依赖归属不闭合')
        const capability = getCapability(work.capabilityId), connection = common.connections.find(item => item.id === work.connectionId)
        if (capability?.requiresConnection ? !connection || ref.connectionRevision === null || ref.connectionRevision > connection.revision : ref.connectionRevision !== null) throw new Error('回复工作依赖连接 revision 不闭合')
      }
      for (const ref of turn.knowledgeDependencyRefs ?? []) {
        const material = common.knowledgeMaterials.find(item => item.id === ref.knowledgeId)
        if (!material || ref.revision > material.revision || material.status === 'active' && ref.revision === material.revision
          && !segmentKnowledgeBody(material.body).some(item => item.segmentId === ref.segmentId)) throw new Error('回复知识依赖引用不闭合')
      }
    }
    if (conversation.source === 'web') continue
    const identity = common.channelIdentities.find(item => item.id === conversation.channelIdentityId)
    const app = identity && common.channelApps.find(item => item.id === identity.channelAppId)
    if (!identity || identity.memberId !== conversation.ownerMemberId || app?.provider !== conversation.source) throw new Error('渠道对话归属或来源不闭合')
  }
  for (const identity of common.channelIdentities) {
    if (identity.defaultEmployeeId && !common.employees.some(item => item.id === identity.defaultEmployeeId)) throw new Error('渠道身份默认员工不存在')
    if (identity.activeConversationId) {
      const conversation = common.conversations.find(item => item.id === identity.activeConversationId)
      if (['unlinked', 'rebind-required'].includes(identity.status) || !conversation || conversation.ownerMemberId !== identity.memberId || conversation.channelIdentityId !== identity.id) throw new Error('渠道身份活动对话归属不闭合')
    }
  }
  return { ...common, version: 10, defaultChannelEmployeeId }
}

function normalizeV11(value) {
  const { automationInbox: _inbox, ...legacy } = value
  const common = normalizeV10(legacy, { kivoEvents: true })
  const automationInbox = requiredArray(value, 'automationInbox').map(normalizeAutomationInbox)
  uniqueIds(automationInbox, 'Kivo 事件入站')
  const events = new Set(), deliveries = new Set()
  for (const entry of automationInbox) {
    const eventKey = JSON.stringify([entry.event.sourceId, entry.event.eventId])
    if (events.has(eventKey)) throw new Error('Kivo canonical 事件重复')
    events.add(eventKey)
    for (const delivery of entry.deliveries) {
      const key = JSON.stringify([entry.event.sourceId, delivery.id])
      if (deliveries.has(key)) throw new Error('Kivo 投递 ID 重复')
      deliveries.add(key)
    }
    const targets = new Set()
    for (const target of entry.targets) {
      const rule = common.automationRules.find(item => item.id === target.ruleId)
      if (!rule || rule.capabilityId !== 'kivo-tpm-record-read' || target.activationId > rule.revision
        || rule.trigger.kind !== KIVO_EVENT_TRIGGER || rule.trigger.sourceId !== entry.event.sourceId
        || rule.input.recordType !== entry.event.recordType || rule.objectId !== entry.event.objectId || targets.has(rule.id)) throw new Error('Kivo 入站目标规则引用不闭合')
      targets.add(rule.id)
      if (target.occurrenceId !== null) {
        const occurrence = common.automationOccurrences.find(item => item.id === target.occurrenceId)
        if (!occurrence || occurrence.ruleId !== rule.id || occurrence.activationId !== target.activationId
          || occurrence.query.objectId !== entry.event.objectId || occurrence.query.sourceInstance !== entry.event.sourceInstance) throw new Error('Kivo 入站目标发生引用不闭合')
      }
    }
    if (entry.actionRef) {
      const work = common.works.find(item => item.id === entry.actionRef.workId)
      const action = work?.actions.find(item => item.id === entry.actionRef.actionId)
      if (!action || !isRepairCreationEcho(entry.event, action)) throw new Error('Kivo 创建事件与原动作回执不闭合')
    }
  }
  return { ...common, version: STATE_VERSION, automationInbox }
}

function normalizeKivoAutomationRule(rule) {
  exactKeys(rule, ['id', 'ownerMemberId', 'revision', 'status', 'employeeId', 'skillId', 'capabilityId', 'connectionId', 'input', 'trigger', 'maxRuns', 'notificationIdentityId', 'effectiveFrom', 'eventAcceptAfter', 'createdAt', 'updatedAt', 'revokedAt', 'objectId', 'activationId', 'baselineRevision', 'handledRevision', 'pauseReason'], 'TPM 自动规则')
  for (const key of ['id', 'ownerMemberId', 'employeeId', 'skillId', 'connectionId']) requiredText(rule[key], `TPM 自动规则 ${key}`)
  boundedInteger(rule.revision, 1, Number.MAX_SAFE_INTEGER, 'TPM 规则 revision')
  boundedInteger(rule.maxRuns, 1, 10, 'TPM 规则预算')
  if (!['draft', 'active', 'paused', 'revoked'].includes(rule.status)) throw new Error('TPM 规则状态无效')
  const input = validateCapabilityInput(rule.capabilityId, rule.input)
  if (!input.ok || !isDeepStrictEqual(input.input, rule.input) || !KIVO_EVENT_RECORD_TYPES.includes(rule.input.recordType)) throw new Error('TPM 自动目标无效')
  if (rule.trigger?.kind === KIVO_EVENT_TRIGGER) {
    exactKeys(rule.trigger, ['kind', 'sourceId'], 'TPM 事件触发')
    requiredText(rule.trigger.sourceId, 'TPM sourceId')
    if (rule.effectiveFrom !== null) throw new Error('TPM 事件不能持有每日生效时间')
  } else normalizeAutomationTrigger(rule.trigger, 'TPM 自动规则 trigger')
  if (!['daily-time', KIVO_EVENT_TRIGGER].includes(rule.trigger.kind) || rule.eventAcceptAfter !== null) throw new Error('TPM 自动规则触发无效')
  for (const key of ['createdAt', 'updatedAt']) isoTimestamp(rule[key], `TPM 规则 ${key}`)
  for (const key of ['effectiveFrom', 'revokedAt']) if (rule[key] !== null) isoTimestamp(rule[key], `TPM 规则 ${key}`)
  nullableId(rule.notificationIdentityId, 'TPM 通知身份')
  if (rule.activationId === null) {
    if (rule.objectId !== null || rule.baselineRevision !== null || rule.handledRevision !== null || !['draft', 'revoked'].includes(rule.status)) throw new Error('未激活 TPM 规则不得持有 baseline 或暂停状态')
  } else {
    boundedInteger(rule.activationId, 1, rule.revision, 'TPM activationId')
    if (rule.status === 'draft' || !uuid(rule.objectId) || !canonicalRevision(rule.baselineRevision) || !canonicalRevision(rule.handledRevision)
      || BigInt(rule.handledRevision) < BigInt(rule.baselineRevision)) throw new Error('TPM 激活版本状态不闭合')
    if (rule.trigger.kind === 'daily-time' && !rule.effectiveFrom) throw new Error('TPM 每日生效时间缺失')
  }
  if (rule.pauseReason !== null) normalizeChannelError(rule.pauseReason, 'TPM 暂停原因')
  return rule
}

function normalizeKivoAutomationOccurrence(value) {
  exactKeys(value, ['id', 'occurrenceKey', 'ruleId', 'ruleRevision', 'activationId', 'scheduledDate', 'event', 'query', 'workId', 'status', 'reason', 'deliveryId', 'createdAt'], 'TPM 自动发生')
  for (const key of ['id', 'occurrenceKey', 'ruleId']) requiredText(value[key], `TPM 自动发生 ${key}`)
  boundedInteger(value.ruleRevision, 1, Number.MAX_SAFE_INTEGER, 'TPM 发生 ruleRevision')
  boundedInteger(value.activationId, 1, value.ruleRevision, 'TPM 发生 activationId')
  isoTimestamp(value.createdAt, 'TPM 发生 createdAt')
  if (value.scheduledDate !== null && !isDateOnly(value.scheduledDate)) throw new Error('TPM 发生 scheduledDate 无效')
  exactKeys(value.query, ['sourceInstance', 'recordType', 'objectId', 'sourceRevision', 'queriedAt'], 'TPM 当前查询')
  requiredText(value.query.sourceInstance, 'TPM 查询来源')
  if (!KIVO_EVENT_RECORD_TYPES.includes(value.query.recordType) || !uuid(value.query.objectId) || !canonicalRevision(value.query.sourceRevision)) throw new Error('TPM 当前查询版本无效')
  isoTimestamp(value.query.queriedAt, 'TPM 查询时间')
  if (value.event !== null) {
    exactKeys(value.event, ['sourceId', 'eventId', 'sourceRevision', 'occurredAt'], 'TPM 事件发生')
    requiredText(value.event.sourceId, 'TPM 发生 sourceId')
    if (!uuid(value.event.eventId) || !canonicalRevision(value.event.sourceRevision) || BigInt(value.query.sourceRevision) < BigInt(value.event.sourceRevision)) throw new Error('TPM 事件与查询版本不闭合')
    isoTimestamp(value.event.occurredAt, 'TPM 事件时间')
  }
  nullableId(value.workId, 'TPM 发生工作'); nullableId(value.deliveryId, 'TPM 发生投递')
  const success = value.workId !== null && value.status === null && value.reason === null
  const terminal = value.workId === null && ['skipped', 'blocked'].includes(value.status) && text(value.reason)
  if (!success && !terminal) throw new Error('TPM 自动发生结果不闭合')
  return value
}

function normalizeAutomationInbox(value) {
  exactKeys(value, ['id', 'event', 'fingerprint', 'deliveries', 'targets', 'acceptedAt', 'ignoredReason', 'actionRef'], 'Kivo 事件入站')
  if (value.actionRef !== undefined && value.actionRef !== null) {
    exactKeys(value.actionRef, ['workId', 'actionId'], 'Kivo 创建动作引用')
    requiredText(value.actionRef.workId, 'Kivo 创建动作 workId'); requiredText(value.actionRef.actionId, 'Kivo 创建动作 actionId')
  }
  requiredText(value.id, 'Kivo 入站 ID'); isoTimestamp(value.acceptedAt, 'Kivo 受理时间')
  const event = value.event
  exactKeys(event, ['sourceId', 'resource', 'sourceInstance', 'adapter', 'kind', 'version', 'eventId', 'recordType', 'objectId', 'sourceRevision', 'occurredAt', 'traceId', 'actorId', 'actorKind', 'action', 'before', 'after', 'subject'], 'Kivo typed 事件')
  const machineCreate = event.recordType === 'repair' && event.action === 'create' && event.actorKind === 'machine'
  for (const key of ['sourceId', 'resource', 'sourceInstance', 'traceId']) requiredText(event[key], `Kivo typed ${key}`)
  if (event.adapter !== 'mes.native' || event.kind !== 'notification.business_event' || event.version !== 1 || !uuid(event.eventId)
    || !uuid(event.objectId) || !KIVO_EVENT_RECORD_TYPES.includes(event.recordType) || !canonicalRevision(event.sourceRevision)
    || (machineCreate ? !/^machine-account:[0-9a-f-]{36}$/i.test(event.actorId) || !uuid(event.actorId.slice(16)) : event.actorId !== null && !uuid(event.actorId))
    || Object.hasOwn(event, 'actorKind') && !machineCreate || event.action !== null && (typeof event.action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.action))) throw new Error('Kivo typed 事件身份无效')
  isoTimestamp(event.occurredAt, 'Kivo 事件时间')
  exactKeys(event.subject, ['id', 'type', 'deviceId', 'organizationId', 'organizationAncestorIds'], 'Kivo subject')
  if (event.subject.id !== event.objectId || event.subject.type !== event.recordType || !uuid(event.subject.deviceId) || !uuid(event.subject.organizationId)
    || !Array.isArray(event.subject.organizationAncestorIds) || event.subject.organizationAncestorIds.some(id => !uuid(id))) throw new Error('Kivo subject 身份无效')
  const allowed = { repair: ['status', 'executorId'], maintenance: ['status', 'assigneeId'], inspection: ['status', 'startedAt', 'completedAt'] }[event.recordType]
  if (!record(event.after) || !Object.keys(event.after).length || Object.keys(event.after).some(key => !allowed.includes(key))
    || (machineCreate ? event.before !== null || event.sourceRevision !== '0' || event.after.status !== 'reported' || event.after.executorId !== null || Object.keys(event.after).length !== 2
      : !record(event.before) || !Object.keys(event.before).length || Object.keys(event.before).sort().join() !== Object.keys(event.after).sort().join())) throw new Error('Kivo typed 变化无效')
  for (const changes of [event.before, event.after].filter(Boolean)) for (const [key, value] of Object.entries(changes)) {
    if (['executorId', 'assigneeId'].includes(key)) { if (value !== null && !uuid(value)) throw new Error('Kivo typed 人员身份无效') }
    else if (['startedAt', 'completedAt'].includes(key)) { if (value !== null) isoTimestamp(value, 'Kivo typed 业务时间') }
    else if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Kivo typed 状态无效')
  }
  if (digest(JSON.stringify(canonical(event))) !== value.fingerprint) throw new Error('Kivo 事件 fingerprint 不匹配')
  if (!Array.isArray(value.deliveries) || !value.deliveries.length || !Array.isArray(value.targets)) throw new Error('Kivo 事件投递或目标缺失')
  for (const delivery of value.deliveries) {
    exactKeys(delivery, ['id', 'rawDigest'], 'Kivo 投递')
    if (!uuid(delivery.id)) throw new Error('Kivo deliveryId 无效')
    hexDigest(delivery.rawDigest, 'Kivo rawDigest')
  }
  if (new Set(value.deliveries.map(item => item.id)).size !== value.deliveries.length) throw new Error('Kivo 投递重复')
  for (const target of value.targets) {
    exactKeys(target, ['ruleId', 'activationId', 'status', 'occurrenceId', 'reason'], 'Kivo 事件目标')
    requiredText(target.ruleId, 'Kivo 目标 ruleId'); boundedInteger(target.activationId, 1, Number.MAX_SAFE_INTEGER, 'Kivo 目标 activationId')
    nullableId(target.occurrenceId, 'Kivo 目标 occurrenceId'); nullableId(target.reason, 'Kivo 目标 reason')
    if (!['pending', 'settled', 'ignored', 'restore-suppressed'].includes(target.status) || (target.status === 'settled') !== (target.occurrenceId !== null)
      || ['ignored', 'restore-suppressed'].includes(target.status) && target.reason === null) throw new Error('Kivo 事件目标终态不闭合')
  }
  if (value.ignoredReason !== (value.targets.length ? null : 'no-active-target')) throw new Error('Kivo 首次无目标状态不闭合')
  return value
}

export function kivoAutomationClaimKey(ruleId, query) {
  return `${ruleId}:kivo:${digest(JSON.stringify([ruleId, query.sourceInstance, query.recordType, query.objectId, query.sourceRevision]))}`
}

function assertAutomationFactsImmutable(before, after) {
  for (const previous of before.automationRules) {
    if (previous.capabilityId !== 'kivo-tpm-record-read') continue
    const current = after.automationRules.find(item => item.id === previous.id)
    if (!current || current.ownerMemberId !== previous.ownerMemberId || current.createdAt !== previous.createdAt) throw new Error('TPM 规则归属不可改写或删除')
    if (previous.status !== 'draft' && (['employeeId', 'skillId', 'connectionId', 'capabilityId'].some(key => current[key] !== previous[key]) || !isDeepStrictEqual(current.input, previous.input)
      || current.trigger.kind !== previous.trigger.kind || current.trigger.sourceId !== previous.trigger.sourceId)) throw new Error('已激活 TPM 规则身份不可改写')
    if (previous.activationId !== null && current.activationId === previous.activationId
      && (current.objectId !== previous.objectId || current.baselineRevision !== previous.baselineRevision || BigInt(current.handledRevision) < BigInt(previous.handledRevision))) throw new Error('TPM activation baseline 或已处理版本不可倒退')
    if (current.activationId !== previous.activationId && (current.status !== 'active' || !['draft', 'paused'].includes(previous.status) || current.activationId !== current.revision)) throw new Error('TPM activation 只能显式启用或恢复')
  }
  for (const previous of before.automationOccurrences) {
    if (!previous.query) continue
    const current = after.automationOccurrences.find(item => item.id === previous.id)
    const { deliveryId: beforeDelivery, ...beforeFact } = previous
    const { deliveryId: afterDelivery, ...afterFact } = current ?? {}
    if (!isDeepStrictEqual(beforeFact, afterFact) || beforeDelivery !== null && beforeDelivery !== afterDelivery) throw new Error('TPM 已认领发生不可改写或删除')
  }
  for (const previous of before.automationInbox ?? []) {
    const current = after.automationInbox.find(item => item.id === previous.id)
    if (!current || !isDeepStrictEqual(current.event, previous.event) || current.fingerprint !== previous.fingerprint || current.acceptedAt !== previous.acceptedAt || current.ignoredReason !== previous.ignoredReason
      || !appendOnly(previous.deliveries, current.deliveries) || previous.targets.length !== current.targets.length) throw new Error('Kivo 受理事实不可改写或扩展目标')
    if (previous.actionRef && !isDeepStrictEqual(previous.actionRef, current.actionRef)) throw new Error('Kivo 创建动作引用不可改写')
    previous.targets.forEach((target, index) => {
      const next = current.targets[index]
      if (next.ruleId !== target.ruleId || next.activationId !== target.activationId || target.status !== 'pending' && !isDeepStrictEqual(target, next)) throw new Error('Kivo 终态目标不可复活或改绑')
    })
  }
}

function normalizeConversation(value, channels = false) {
  if (!record(value)) throw new Error('对话状态无效')
  exactKeys(value, ['id', 'ownerMemberId', 'employeeId', 'employeeName', 'title', 'source', 'channelIdentityId', 'createdAt', 'updatedAt', 'archivedAt', 'sessions', 'turns'], '对话')
  const id = requiredText(value.id, '对话 ID 无效')
  for (const key of ['ownerMemberId', 'employeeId', 'employeeName', 'title']) requiredText(value[key], `对话 ${id} ${key} 无效`)
  if (value.title.length > 200 || !(channels ? ['web', 'feishu', 'weixin'] : ['web']).includes(value.source)
    || (value.source === 'web' ? value.channelIdentityId !== null : !text(value.channelIdentityId))) throw new Error(`对话 ${id} 来源或标题无效`)
  const createdAt = isoTimestamp(value.createdAt, `对话 ${id} createdAt`), updatedAt = isoTimestamp(value.updatedAt, `对话 ${id} updatedAt`)
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error(`对话 ${id} 时间无效`)
  if (value.archivedAt !== null && Date.parse(isoTimestamp(value.archivedAt, `对话 ${id} archivedAt`)) < Date.parse(createdAt)) throw new Error(`对话 ${id} 归档时间无效`)
  const sessions = requiredArray(value, 'sessions').map(session => {
    if (!record(session)) throw new Error(`对话 ${id} Session 无效`)
    exactKeys(session, ['id', 'definitionFingerprint', 'createdAt'], '对话 Session')
    requiredText(session.id, '原生 Session ID 无效')
    if (!/^[a-f0-9]{64}$/.test(session.definitionFingerprint)) throw new Error('Session 定义指纹无效')
    isoTimestamp(session.createdAt, 'Session createdAt')
    return session
  })
  uniqueIds(sessions, '对话 Session')
  const turns = requiredArray(value, 'turns').map(turn => normalizeConversationTurn(turn, sessions, channels))
  uniqueIds(turns, '对话回复')
  if (new Set(turns.map(turn => turn.clientRequestId)).size !== turns.length) throw new Error('对话请求标识重复')
  if (turns.filter(turn => ['accepted', 'running'].includes(turn.status)).length > 1) throw new Error('一个对话只能有一个活动回复')
  if (value.archivedAt && turns.some(turn => ['accepted', 'running'].includes(turn.status))) throw new Error('活动回复不能归档')
  const messageRefs = turns.filter(turn => turn.userMessageId).map(turn => `${turn.sessionId}\0${turn.userMessageId}`)
  if (new Set(messageRefs).size !== messageRefs.length) throw new Error('原生用户消息不得绑定多个回复')
  if (sessions.some(session => !turns.some(turn => turn.sessionId === session.id))) throw new Error('对话包含未关联回复的 Session')
  return { ...value, sessions, turns }
}

function normalizeConversationTurn(value, sessions, channels = false) {
  if (!record(value)) throw new Error('对话回复无效')
  exactKeys(value, ['id', 'clientRequestId', 'userText', 'status', 'createdAt', 'startedAt', 'completedAt', 'error', 'definition', 'definitionFingerprint', 'sessionId', 'userMessageId', 'assistantMessageIds', 'runtime', ...(channels ? ['workDependencyRefs', 'knowledgeDependencyRefs'] : [])], '对话回复')
  const id = requiredText(value.id, '回复 ID 无效')
  if (value.runtime !== undefined) validateExecutionRuntime(value.runtime)
  if (channels) {
    if (value.workDependencyRefs !== undefined) {
      if (!Array.isArray(value.workDependencyRefs)) throw new Error('回复工作依赖无效')
      for (const ref of value.workDependencyRefs) {
        if (!record(ref)) throw new Error('回复工作依赖无效')
        exactKeys(ref, ['workId', 'resultId', 'connectionRevision'], '回复工作依赖')
        requiredText(ref.workId, '回复工作依赖 workId 无效')
        requiredText(ref.resultId, '回复工作依赖 resultId 无效')
        if (ref.connectionRevision !== null && (!Number.isSafeInteger(ref.connectionRevision) || ref.connectionRevision < 1)) throw new Error('回复工作依赖连接 revision 无效')
      }
      uniqueDomain(value.workDependencyRefs, ref => [ref.workId, ref.resultId, ref.connectionRevision], '回复工作依赖')
    }
    if (value.knowledgeDependencyRefs !== undefined) normalizeKnowledgeRefs(value.knowledgeDependencyRefs, '回复知识依赖')
  }
  for (const [key, maximum] of [['clientRequestId', 200], ['userText', 16_000]]) {
    const text = requiredRawText(value[key], `回复 ${id} ${key} 无效`)
    if (text.length > maximum || !text.isWellFormed()) throw new Error(`回复 ${id} ${key} 无效`)
  }
  if (!['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)) throw new Error('回复状态无效')
  const definition = value.definition
  if (!record(definition)) throw new Error('回复冻结定义无效')
  exactKeys(definition, ['employeeRevision', 'instructions', 'modelRouteId', 'modelSnapshot'], '回复冻结定义')
  if (!Number.isSafeInteger(definition.employeeRevision) || definition.employeeRevision < 1 || typeof definition.instructions !== 'string' || definition.instructions.length > 16_000) throw new Error('回复冻结定义无效')
  requiredText(definition.modelRouteId, '回复模型引用无效')
  if (definition.modelSnapshot !== undefined) {
    validateModelSnapshot(definition.modelSnapshot)
    if (definition.modelSnapshot.modelRouteId !== definition.modelRouteId || value.runtime && ['modelRouteId', 'provider', 'model', 'parameters'].some(key => !isDeepStrictEqual(value.runtime[key], definition.modelSnapshot[key]))) throw new Error('回复模型快照不匹配')
  }
  const normalizedDefinition = { employeeRevision: definition.employeeRevision, instructions: definition.instructions, modelRouteId: definition.modelRouteId, ...(definition.modelSnapshot ? { modelSnapshot: definition.modelSnapshot } : {}) }
  const fingerprint = createHash('sha256').update(JSON.stringify(normalizedDefinition)).digest('hex')
  if (value.definitionFingerprint !== fingerprint) throw new Error('回复定义指纹不匹配')
  const sessionId = value.sessionId === null ? null : requiredText(value.sessionId, '回复 Session 引用无效')
  if (sessionId && !sessions.some(session => session.id === sessionId && session.definitionFingerprint === fingerprint)) throw new Error('回复 Session 定义不匹配')
  const userMessageId = value.userMessageId === null ? null : requiredText(value.userMessageId, '用户消息引用无效')
  const assistantMessageIds = uniqueTextArray(value.assistantMessageIds, '助手消息引用')
  if ((userMessageId || assistantMessageIds.length) && !sessionId) throw new Error('消息引用缺少 Session')
  const createdAt = isoTimestamp(value.createdAt, '回复 createdAt')
  for (const key of ['startedAt', 'completedAt']) if (value[key] !== null && Date.parse(isoTimestamp(value[key], `回复 ${key}`)) < Date.parse(createdAt)) throw new Error('回复时间无效')
  const active = ['accepted', 'running'].includes(value.status)
  if (active && (value.completedAt !== null || value.error !== null) || !active && value.completedAt === null || value.status === 'running' && value.startedAt === null) throw new Error('回复状态与时间不匹配')
  if (value.status === 'completed' && (!userMessageId || !assistantMessageIds.length || value.startedAt === null || value.error !== null)) throw new Error('已完成回复缺少原生消息引用')
  if (value.error !== null) {
    if (!record(value.error)) throw new Error('回复错误无效')
    exactKeys(value.error, ['code', 'message'], '回复错误')
    if (!['FORBIDDEN', 'MODEL_NOT_CONFIGURED', 'HISTORY_UNAVAILABLE', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'CANCELLED', 'PROCESS_RESTARTED', 'PROCESS_SHUTDOWN', 'BACKUP_INTERRUPTED', 'BUDGET_EXHAUSTED'].includes(value.error.code)) throw new Error('回复错误代码无效')
    requiredText(value.error.message, '回复错误消息无效')
  }
  return { ...value, definition: normalizedDefinition, sessionId, userMessageId, assistantMessageIds }
}

function assertExecutionFactsImmutable(before, after) {
  for (const work of before.works) for (const execution of work.executions) {
    if (!execution.modelSnapshot) continue
    const next = after.works.find(item => item.id === work.id)?.executions.find(item => item.id === execution.id)
    if (!isDeepStrictEqual(execution.modelSnapshot, next?.modelSnapshot)) throw new Error('执行冻结模型不可改写')
  }
}

function assertConversationFactsImmutable(before, after) {
  for (const previous of before.conversations) {
    const current = after.conversations.find(item => item.id === previous.id)
    if (!current || ['ownerMemberId', 'employeeId', 'source', 'channelIdentityId', 'createdAt'].some(key => current[key] !== previous[key])) throw new Error('对话归属和来源不可变更或删除')
    if (previous.archivedAt && current.archivedAt !== previous.archivedAt) throw new Error('已归档对话不可恢复')
    for (const session of previous.sessions) if (JSON.stringify(current.sessions.find(item => item.id === session.id)) !== JSON.stringify(session)) throw new Error('原生 Session 谱系不可改写')
    for (const turn of previous.turns) {
      const next = current.turns.find(item => item.id === turn.id)
      if (!next || ['clientRequestId', 'userText', 'createdAt', 'definitionFingerprint'].some(key => next[key] !== turn[key])) throw new Error('回复输入和冻结定义不可改写')
      if (turn.userMessageId && (next.sessionId !== turn.sessionId || next.userMessageId !== turn.userMessageId)) throw new Error('原生回复绑定不可改写')
      if (!['accepted', 'running'].includes(turn.status) && JSON.stringify(next) !== JSON.stringify(turn)) throw new Error('已结束回复不可改写')
      if (turn.status === 'running' && next.status === 'accepted') throw new Error('运行中回复不可回退')
      if (!appendOnly(turn.workDependencyRefs ?? [], next.workDependencyRefs ?? []) || !appendOnly(turn.knowledgeDependencyRefs ?? [], next.knowledgeDependencyRefs ?? [])) throw new Error('回复事实依赖只能追加')
    }
  }
}

function assertChannelFactsImmutable(before, after) {
  for (const identity of before.channelIdentities) {
    const next = after.channelIdentities.find(item => item.id === identity.id)
    if (!next || ['channelAppId', 'providerUserId', 'memberId', 'verificationMethod', 'createdAt'].some(key => identity[key] !== next[key])) throw new Error('渠道身份归属不可变更或删除')
    if (['unlinked', 'rebind-required'].includes(identity.status) && !['unlinked', 'rebind-required'].includes(next.status)) throw new Error('已失效渠道身份不可重新激活')
    if (identity.weixin && (!next.weixin || ['botId', 'baseUrl', 'tokenRef', 'cursorRef', 'contextRef'].some(key => identity.weixin[key] !== next.weixin[key]))) throw new Error('微信账号和秘密引用不可改写')
  }
  for (const endpoint of before.channelConversations) {
    const next = after.channelConversations.find(item => item.id === endpoint.id)
    if (!next || ['channelAppId', 'providerConversationId', 'identityId', 'memberId', 'type', 'createdAt'].some(key => endpoint[key] !== next[key])) throw new Error('渠道端点归属不可变更或删除')
    if (['unlinked', 'rebind-required'].includes(endpoint.status) && !['unlinked', 'rebind-required'].includes(next.status)) throw new Error('已失效渠道端点不可重新激活')
  }
  for (const message of before.channelMessages) {
    const next = after.channelMessages.find(item => item.id === message.id)
    if (!next) throw new Error('渠道消息事实不可删除')
    const immutable = ['channelAppId', 'providerAccountId', 'providerEventId', 'providerMessageId', 'replyToProviderMessageId', 'providerConversationId', 'providerUserId', 'conversationId', 'senderIdentityId', 'direction', 'text', 'conversationType', 'bodyDigest', 'rejectionCode', 'receivedAt', 'persistedAt']
    if (immutable.some(key => !isDeepStrictEqual(message[key], next[key]))) throw new Error('渠道消息原始事实不可改写')
    for (const key of ['action', 'command', 'memberConversationId', 'turnId', 'workId', 'clientRequestId', 'authorizationRevisions', 'reservedAt', 'noticeKey']) {
      if (message[key] !== undefined && !isDeepStrictEqual(message[key], next[key])) throw new Error('渠道消息受理绑定不可改写')
    }
    if (['accepted', 'rejected', 'unhandled'].includes(message.status)) {
      const { conflicts: _before, ...original } = message, { conflicts: _after, ...candidate } = next
      if (!isDeepStrictEqual(original, candidate)) throw new Error('已处理渠道消息不可重新受理或改写')
    }
    if (!appendOnly(message.conflicts ?? [], next.conflicts ?? [])) throw new Error('渠道消息冲突事实只能追加')
  }
  for (const delivery of before.deliveries) {
    const next = after.deliveries.find(item => item.id === delivery.id)
    if (!next || ['channelAppId', 'requestId', 'workId', 'resultId', 'actionId', 'sourceRef', 'channelMessageId', 'targetConversationId', 'targetIdentityId', 'contentScope', 'contentKey', 'createdAt'].some(key => !isDeepStrictEqual(delivery[key], next[key]))) throw new Error('渠道投递来源和接收方不可改写')
    if (delivery.status === 'unknown' && !['unknown', 'delivered', 'failed'].includes(next.status)) throw new Error('未知投递效果不可重新发送')
    if (['delivered', 'cancelled'].includes(delivery.status) && delivery.status !== next.status) throw new Error('已结束投递不可重新发送')
    if (delivery.sendProgress) {
      const a = delivery.sendProgress, b = next.sendProgress
      if (!b || ['attemptId', 'totalParts', 'textDigest'].some(key => a[key] !== b[key]) || !appendOnly(a.acknowledgedParts, b.acknowledgedParts)) throw new Error('分段投递请求与已确认前缀不可改写')
    } else if (next.sendProgress && (delivery.status !== 'sending' || delivery.attempts < 1)) throw new Error('分段投递只能从已授权发送开始')
  }
  for (const link of before.linkCodes) {
    const next = after.linkCodes.find(item => item.id === link.id)
    if (!next || ['channelAppId', 'memberId', 'digest', 'kind', 'loginRef', 'tokenRef', 'cursorRef', 'contextRef', 'createdAt', 'expiresAt'].some(key => !isDeepStrictEqual(link[key], next[key]))) throw new Error('渠道关联请求不可改写或删除')
    if (['consumed', 'expired', 'cancelled'].includes(link.status) && next.status !== link.status) throw new Error('已结束关联请求不可重新激活')
    if (next.failedAttempts < link.failedAttempts || link.qrcodeUrl !== undefined && next.qrcodeUrl !== link.qrcodeUrl) throw new Error('关联码失败次数或扫码地址不可回退或改写')
    for (const key of ['matchedIdentityId', 'matchedConversationId', 'matchedAt', 'consumedAt']) if (link[key] !== undefined && next[key] !== link[key]) throw new Error('渠道关联匹配事实不可改写')
  }
}

function appendOnly(before, after) {
  return after.length >= before.length && before.every((item, index) => isDeepStrictEqual(item, after[index]))
}

function normalizeAction(action, work) {
  if (!record(action)) throw new Error(`工作 ${work.id} 的动作状态无效`)
  exactKeys(action, ['id', 'requestKeys', 'proposalKey', 'intent', 'preview', 'decision', 'attempt', 'receipt'], `工作 ${work.id} 的动作`)
  const id = requiredText(action.id, `工作 ${work.id} 的动作 ID 无效`)
  const requestKeys = uniqueTextArray(action.requestKeys, `动作 ${id} requestKeys`)
  if (!requestKeys.length) throw new Error(`动作 ${id} requestKeys 无效`)
  const proposalKey = requiredText(action.proposalKey, `动作 ${id} proposalKey 无效`)
  const intent = action.intent
  if (!record(intent)) throw new Error(`动作 ${id} intent 无效`)
  exactKeys(intent, ['kind', 'targetKey'], `动作 ${id} intent`)
  requiredText(intent.kind, `动作 ${id} intent kind 无效`)
  requiredText(intent.targetKey, `动作 ${id} intent targetKey 无效`)
  const preview = action.preview
  if (!record(preview)) throw new Error(`动作 ${id} preview 无效`)
  exactKeys(preview, ['digest', 'resultId', 'target', 'payload', 'expectedRevision', 'createdAt', 'expiresAt'], `动作 ${id} preview`)
  if (!/^[a-f0-9]{64}$/.test(requiredText(preview.digest, `动作 ${id} preview digest 无效`))) throw new Error(`动作 ${id} preview digest 无效`)
  if (!work.results.some(result => result.id === requiredText(preview.resultId, `动作 ${id} resultId 无效`))) throw new Error(`动作 ${id} 引用不存在的结果`)
  if (!record(preview.target) || !record(preview.payload)) throw new Error(`动作 ${id} target 或 payload 无效`)
  if (intent.kind === KIVO_REPAIR_ACTION) {
    assertRepairTarget(preview.target)
    repairPayload(preview.payload)
    const source = work.results.find(item => item.id === preview.resultId)
    if (source.kind !== KIVO_TPM_DEVICE_CORRELATION_KIND || !isDeepStrictEqual(preview.target, repairTargetFromCorrelation(source.payload))
      || preview.payload.deviceId !== preview.target.deviceId || intent.targetKey !== repairIntentKey(work.ownerMemberId, preview.target)
      || preview.expectedRevision !== source.payload.tpm.revision || preview.target.recordId !== source.payload.tpm.id) throw new Error(`动作 ${id} 维修依据不闭合`)
  }
  requiredText(preview.expectedRevision, `动作 ${id} expectedRevision 无效`)
  const createdAt = isoTimestamp(preview.createdAt, `动作 ${id} createdAt`)
  const expiresAt = isoTimestamp(preview.expiresAt, `动作 ${id} expiresAt`)
  if (expiresAt <= createdAt) throw new Error(`动作 ${id} expiresAt 无效`)

  const decision = action.decision === null ? null : normalizeActionDecision(action.decision, id, preview.digest)
  const attempt = action.attempt === null ? null : normalizeActionAttempt(action.attempt, id, preview.digest)
  const receipt = action.receipt === null ? null : normalizeActionReceipt(action.receipt, id, preview.digest, action)
  if (decision && decision.memberId !== work.ownerMemberId) throw new Error(`动作 ${id} decision memberId 不是工作 owner`)
  if (attempt && (decision?.kind !== 'approved' || decision.invalidatedAt && intent.kind !== KIVO_REPAIR_ACTION)) throw new Error(`动作 ${id} attempt 与批准不闭合`)
  if (receipt && !attempt) throw new Error(`动作 ${id} receipt 未回链 attempt`)
  if (receipt && attempt?.noEffectAt) throw new Error(`动作 ${id} receipt 与 noEffect 互斥`)
  return { id, requestKeys, proposalKey, intent, preview, decision, attempt, receipt }
}

function normalizeActionDecision(decision, id, digest) {
  if (!record(decision)) throw new Error(`动作 ${id} decision 无效`)
  exactKeys(decision, ['kind', 'memberId', 'previewDigest', 'decidedAt', 'invalidatedAt', 'invalidationReason'], `动作 ${id} decision`)
  if (!['approved', 'rejected', 'revoked', 'expired'].includes(decision.kind)) throw new Error(`动作 ${id} decision kind 无效`)
  requiredText(decision.memberId, `动作 ${id} decision memberId 无效`)
  if (decision.previewDigest !== digest) throw new Error(`动作 ${id} decision digest 不闭合`)
  isoTimestamp(decision.decidedAt, `动作 ${id} decidedAt`)
  const invalidated = decision.invalidatedAt !== undefined || decision.invalidationReason !== undefined
  if (invalidated && (decision.invalidatedAt === undefined || decision.invalidationReason === undefined)) throw new Error(`动作 ${id} decision invalidation 不闭合`)
  if (decision.invalidatedAt !== undefined) isoTimestamp(decision.invalidatedAt, `动作 ${id} invalidatedAt`)
  if (decision.invalidationReason !== undefined && !ACTION_INVALIDATION_REASONS.has(requiredText(decision.invalidationReason, `动作 ${id} invalidationReason 无效`))) throw new Error(`动作 ${id} invalidationReason 无效`)
  return decision
}

function normalizeActionAttempt(attempt, id, digest) {
  if (!record(attempt)) throw new Error(`动作 ${id} attempt 无效`)
  exactKeys(attempt, ['previewDigest', 'preparedAt', 'unknownAt', 'unknownReason', 'noEffectAt', 'noEffectReason'], `动作 ${id} attempt`)
  if (attempt.previewDigest !== digest) throw new Error(`动作 ${id} attempt digest 不闭合`)
  isoTimestamp(attempt.preparedAt, `动作 ${id} preparedAt`)
  const unknown = attempt.unknownAt !== undefined || attempt.unknownReason !== undefined
  if (unknown && (attempt.unknownAt === undefined || attempt.unknownReason === undefined)) throw new Error(`动作 ${id} unknown 不闭合`)
  if (attempt.unknownAt !== undefined) isoTimestamp(attempt.unknownAt, `动作 ${id} unknownAt`)
  if (attempt.unknownReason !== undefined && !ACTION_UNKNOWN_REASONS.has(requiredText(attempt.unknownReason, `动作 ${id} unknownReason 无效`))) throw new Error(`动作 ${id} unknownReason 无效`)
  const noEffect = attempt.noEffectAt !== undefined || attempt.noEffectReason !== undefined
  if (noEffect && (attempt.noEffectAt === undefined || attempt.noEffectReason === undefined)) throw new Error(`动作 ${id} noEffect 不闭合`)
  if (unknown && noEffect) throw new Error(`动作 ${id} unknown 与 noEffect 互斥`)
  if (attempt.noEffectAt !== undefined) isoTimestamp(attempt.noEffectAt, `动作 ${id} noEffectAt`)
  if (attempt.noEffectReason !== undefined && !ACTION_NO_EFFECT_REASONS.has(requiredText(attempt.noEffectReason, `动作 ${id} noEffectReason 无效`))) throw new Error(`动作 ${id} noEffectReason 无效`)
  return attempt
}

function normalizeActionReceipt(receipt, id, digest, action) {
  if (!record(receipt)) throw new Error(`动作 ${id} receipt 无效`)
  if (action.intent.kind === KIVO_REPAIR_ACTION) return assertRepairReceipt(receipt, action)
  exactKeys(receipt, ['previewDigest', 'upstreamRecordId', 'recordedAt'], `动作 ${id} receipt`)
  if (receipt.previewDigest !== digest) throw new Error(`动作 ${id} receipt digest 不闭合`)
  requiredText(receipt.upstreamRecordId, `动作 ${id} upstreamRecordId 无效`)
  isoTimestamp(receipt.recordedAt, `动作 ${id} recordedAt`)
  return receipt
}

function assertActionFactsImmutable(current, next) {
  const nextWorkById = new Map(next.works.map(work => [work.id, work]))
  for (const work of current.works) {
    const nextWork = nextWorkById.get(work.id)
    if (!nextWork) {
      if (work.actions.length) throw new Error(`工作 ${work.id} 的动作不可删除`)
      continue
    }
    const nextActionById = new Map(nextWork.actions.map(action => [action.id, action]))
    for (const action of work.actions) {
      const candidate = nextActionById.get(action.id)
      if (!candidate || JSON.stringify(candidate.preview) !== JSON.stringify(action.preview)) throw new Error(`动作 ${action.id} preview 不可改写`)
      if (candidate.requestKeys.length < action.requestKeys.length
        || action.requestKeys.some((key, index) => candidate.requestKeys[index] !== key)) throw new Error(`动作 ${action.id} requestKeys 不可改写`)
      if (candidate.proposalKey !== action.proposalKey) throw new Error(`动作 ${action.id} proposalKey 不可改写`)
      if (JSON.stringify(candidate.intent) !== JSON.stringify(action.intent)) throw new Error(`动作 ${action.id} intent 不可改写`)
      if (action.decision) assertMonotonicFact(action.decision, candidate.decision, action.decision.kind === 'approved' ? ['invalidatedAt', 'invalidationReason'] : [], `动作 ${action.id} decision`)
      assertMonotonicFact(action.attempt, candidate.attempt, ['unknownAt', 'unknownReason', 'noEffectAt', 'noEffectReason'], `动作 ${action.id} attempt`)
      if (action.receipt !== null && JSON.stringify(candidate.receipt) !== JSON.stringify(action.receipt)) throw new Error(`动作 ${action.id} receipt 不可改写`)
    }
  }
}

function assertMonotonicFact(current, next, additions, label) {
  if (current === null) return
  if (next === null) throw new Error(`${label} 不可删除`)
  const currentBase = { ...current }, nextBase = { ...next }
  for (const key of additions) {
    delete currentBase[key]
    delete nextBase[key]
    if (current[key] !== undefined && next[key] !== current[key]) throw new Error(`${label} 不可改写`)
  }
  if (JSON.stringify(currentBase) !== JSON.stringify(nextBase)) throw new Error(`${label} 不可改写`)
}

function normalizeAutomationRule(rule, channels = false) {
  if (!record(rule)) throw new Error('自动规则状态无效')
  exactKeys(rule, ['id', 'ownerMemberId', 'revision', 'status', 'employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', channels ? 'notificationIdentityId' : 'notificationConversationId', 'effectiveFrom', 'eventAcceptAfter', 'createdAt', 'updatedAt', 'revokedAt'], '自动规则')
  const id = requiredText(rule.id, '自动规则 ID 无效')
  for (const key of ['ownerMemberId', 'employeeId', 'skillId', 'connectionId', 'workOrderId']) requiredText(rule[key], `自动规则 ${id} ${key} 无效`)
  isoTimestamp(rule.createdAt, `自动规则 ${id} createdAt`)
  isoTimestamp(rule.updatedAt, `自动规则 ${id} updatedAt`)
  if (!Number.isSafeInteger(rule.revision) || rule.revision < 1 || !['draft', 'active', 'paused', 'revoked'].includes(rule.status)) throw new Error(`自动规则 ${id} revision 或状态无效`)
  if (!Number.isSafeInteger(rule.maxRuns) || rule.maxRuns < 1 || rule.maxRuns > 10) throw new Error(`自动规则 ${id} maxRuns 无效`)
  nullableId(rule[channels ? 'notificationIdentityId' : 'notificationConversationId'], `自动规则 ${id} 通知目标`)
  if (rule.effectiveFrom !== null) isoTimestamp(rule.effectiveFrom, `自动规则 ${id} effectiveFrom`)
  if (rule.eventAcceptAfter !== null) isoTimestamp(rule.eventAcceptAfter, `自动规则 ${id} eventAcceptAfter`)
  if (rule.revokedAt !== null) isoTimestamp(rule.revokedAt, `自动规则 ${id} revokedAt`)
  normalizeAutomationTrigger(rule.trigger, `自动规则 ${id} trigger`)
  return rule
}

function normalizeAutomationOccurrence(occurrence) {
  if (!record(occurrence)) throw new Error('自动发生状态无效')
  if (!Object.hasOwn(occurrence, 'event')) occurrence = { ...occurrence, event: null }
  exactKeys(occurrence, ['id', 'occurrenceKey', 'ruleId', 'ruleRevision', 'scheduledDate', 'event', 'workId', 'status', 'reason', 'deliveryId', 'createdAt'], '自动发生')
  const id = requiredText(occurrence.id, '自动发生 ID 无效')
  for (const key of ['occurrenceKey', 'ruleId']) requiredText(occurrence[key], `自动发生 ${id} ${key} 无效`)
  isoTimestamp(occurrence.createdAt, `自动发生 ${id} createdAt`)
  if (!Number.isSafeInteger(occurrence.ruleRevision) || occurrence.ruleRevision < 1) throw new Error(`自动发生 ${id} ruleRevision 无效`)
  if (occurrence.scheduledDate !== null && !isDateOnly(occurrence.scheduledDate)) throw new Error(`自动发生 ${id} scheduledDate 无效`)
  if (occurrence.event !== null) {
    if (!record(occurrence.event)) throw new Error(`自动发生 ${id} event 无效`)
    exactKeys(occurrence.event, ['sourceId', 'sourceRevision', 'digest'], `自动发生 ${id} event`)
    requiredText(occurrence.event.sourceId, `自动发生 ${id} event sourceId 无效`)
    if (typeof occurrence.event.sourceRevision !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(occurrence.event.sourceRevision)) throw new Error(`自动发生 ${id} event sourceRevision 无效`)
    if (typeof occurrence.event.digest !== 'string' || !/^[a-f0-9]{64}$/.test(occurrence.event.digest)) throw new Error(`自动发生 ${id} event digest 无效`)
  }
  if (occurrence.workId !== null) requiredText(occurrence.workId, `自动发生 ${id} workId 无效`)
  if (occurrence.deliveryId !== null) requiredText(occurrence.deliveryId, `自动发生 ${id} deliveryId 无效`)
  if (occurrence.status !== null && !['skipped', 'blocked'].includes(occurrence.status)) throw new Error(`自动发生 ${id} status 无效`)
  if (occurrence.reason !== null) requiredText(occurrence.reason, `自动发生 ${id} reason 无效`)
  const successful = occurrence.workId !== null && occurrence.status === null && occurrence.reason === null
  const terminal = occurrence.workId === null && occurrence.status !== null && occurrence.reason !== null
  if (!successful && !terminal) throw new Error(`自动发生 ${id} 结果不闭合`)
  return occurrence
}

function normalizeAutomationTrigger(trigger, label) {
  if (!record(trigger)) throw new Error(`${label} 无效`)
  if (trigger.kind === 'daily-time') {
    exactKeys(trigger, ['kind', 'time', 'timeZone'], label)
    if (typeof trigger.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) || trigger.timeZone !== 'Asia/Shanghai') throw new Error(`${label} 每日上海时间无效`)
    return trigger
  }
  if (trigger.kind === 'gearjob-work-order-update') {
    exactKeys(trigger, ['kind', 'sourceId'], label)
    requiredText(trigger.sourceId, `${label} sourceId 无效`)
    return trigger
  }
  throw new Error(`${label} 类型不受支持`)
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${label} 无效`)
  return value
}

function dailyAutomationOccurrenceKey(ruleId, scheduledDate) {
  return `${ruleId}:${scheduledDate}`
}

function eventAutomationOccurrenceKey(rule, event) {
  const identity = [rule.id, event.sourceId, 'on_update', 'Work Order', rule.workOrderId, event.sourceRevision]
  return `${rule.id}:event:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return date.toISOString().slice(0, 10) === value
}

function normalizeChannelApp(app, channels = false) {
  if (!record(app)) throw new Error('渠道应用状态无效')
  exactKeys(app, ['id', 'provider', 'providerAppId', 'providerTenantId', 'credentialRef', 'enabled', 'allowedScopes', 'revision', 'status', 'createdAt', 'updatedAt'], '渠道应用')
  const id = requiredText(app.id, '渠道应用 ID 无效')
  if (channels && !['feishu', 'weixin'].includes(app.provider)) throw new Error('渠道应用 provider 无效')
  for (const key of ['provider', 'providerAppId', 'providerTenantId', 'createdAt', 'updatedAt']) requiredText(app[key], `渠道应用 ${id} ${key} 无效`)
  if (channels && app.provider === 'weixin') {
    if (id === 'channel-app-weixin') {
      if (app.providerAppId !== 'ilink' || app.providerTenantId !== 'personal' || app.credentialRef !== null) throw new Error('微信渠道必须使用唯一内置应用')
    } else {
      // Earlier manually configured applications remain as disabled history only.
      if (app.enabled !== false || app.status !== 'disabled') throw new Error('旧微信应用不可重新启用')
      requiredText(app.credentialRef, `渠道应用 ${id} credentialRef 无效`)
    }
  } else requiredText(app.credentialRef, `渠道应用 ${id} credentialRef 无效`)
  if (typeof app.enabled !== 'boolean' || !Number.isSafeInteger(app.revision) || app.revision < 1 || !['active', 'disabled', 'unavailable'].includes(app.status) || (app.enabled === false) !== (app.status === 'disabled')) throw new Error(`渠道应用 ${id} 状态无效`)
  const allowedScopes = uniqueTextArray(app.allowedScopes, `渠道应用 ${id} allowedScopes`)
  if (!allowedScopes.length) throw new Error(`渠道应用 ${id} 允许范围为空`)
  return { ...app, id, allowedScopes }
}

function normalizeChannelIdentity(identity, channels = false) {
  if (!record(identity)) throw new Error('渠道身份状态无效')
  exactKeys(identity, ['id', 'channelAppId', 'providerUserId', 'memberId', 'verificationMethod', 'status', 'revision', 'createdAt', 'updatedAt', 'unlinkedAt', ...(channels ? ['defaultEmployeeId', 'activeConversationId', 'weixin'] : [])], '渠道身份')
  const id = requiredText(identity.id, '渠道身份 ID 无效')
  for (const key of ['channelAppId', 'providerUserId', 'memberId', 'createdAt', 'updatedAt']) requiredText(identity[key], `渠道身份 ${id} ${key} 无效`)
  if (!(channels ? ['link-code', 'weixin-qr'] : ['link-code']).includes(identity.verificationMethod)
    || !(channels ? ['pending', 'active', 'unlinked', 'rebind-required'] : ['pending', 'active', 'unlinked']).includes(identity.status) || !Number.isSafeInteger(identity.revision) || identity.revision < 1) throw new Error(`渠道身份 ${id} 状态无效`)
  if (identity.status === 'unlinked') requiredText(identity.unlinkedAt, `渠道身份 ${id} unlinkedAt 无效`)
  if (channels) {
    nullableId(identity.defaultEmployeeId, `渠道身份 ${id} 默认员工`)
    nullableId(identity.activeConversationId, `渠道身份 ${id} 活动对话`)
    if ((identity.verificationMethod === 'weixin-qr') !== Boolean(identity.weixin)) throw new Error('微信身份验证方式与元信息不匹配')
    if (identity.weixin) normalizeWeixinIdentity(identity.weixin)
  }
  return identity
}

function normalizeWeixinIdentity(value) {
  if (!record(value)) throw new Error('微信身份元信息无效')
  exactKeys(value, ['botId', 'baseUrl', 'tokenRef', 'cursorRef', 'contextRef', 'runtimeState', 'error'], '微信身份')
  officialId(value.botId, '微信 bot ID')
  let url
  try { url = new URL(value.baseUrl) } catch { throw new Error('微信连接地址无效') }
  if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) {
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.href !== value.baseUrl) throw new Error('微信测试地址无效')
  } else if (normalizeWeixinApiBaseUrl(value.baseUrl) !== value.baseUrl) throw new Error('微信连接地址未规范化')
  const refs = ['tokenRef', 'cursorRef', 'contextRef'].map(key => secretRef(value[key], `微信身份 ${key}`))
  if (new Set(refs).size !== refs.length) throw new Error('微信身份秘密引用不得复用')
  if (!['pending', 'connecting', 'connected', 'reconnecting', 'unavailable', 'stopped'].includes(value.runtimeState)) throw new Error('微信运行状态无效')
  if (value.error !== undefined) {
    if (!record(value.error)) throw new Error('微信错误无效')
    exactKeys(value.error, ['code'], '微信错误')
    safeCode(value.error.code, '微信错误')
  }
}

function normalizeChannelConversation(source, channels = false) {
  if (!record(source)) throw new Error('渠道会话状态无效')
  const { provider: _provider, ...conversation } = source
  exactKeys(conversation, ['id', 'channelAppId', 'providerConversationId', 'identityId', 'memberId', 'type', 'allowedScopes', 'verificationMethod', 'status', 'revision', 'defaultDispatch', 'createdAt', 'updatedAt', 'unlinkedAt'], '渠道会话')
  const id = requiredText(conversation.id, '渠道会话 ID 无效')
  for (const key of ['channelAppId', 'providerConversationId', 'createdAt', 'updatedAt']) requiredText(conversation[key], `渠道会话 ${id} ${key} 无效`)
  if (conversation.type === 'private') for (const key of ['identityId', 'memberId']) requiredText(conversation[key], `渠道会话 ${id} ${key} 无效`)
  if (!['private', 'group'].includes(conversation.type) || !(channels ? ['link-code', 'bot-mention', 'weixin-qr'] : ['link-code', 'bot-mention']).includes(conversation.verificationMethod)
    || (conversation.type === 'private' && !(channels ? ['link-code', 'weixin-qr'] : ['link-code']).includes(conversation.verificationMethod))
    || !(channels ? ['pending', 'active', 'unlinked', 'rebind-required'] : ['pending', 'active', 'unlinked']).includes(conversation.status) || !Number.isSafeInteger(conversation.revision) || conversation.revision < 1) throw new Error(`渠道会话 ${id} 状态无效`)
  const allowedScopes = uniqueTextArray(conversation.allowedScopes, `渠道会话 ${id} allowedScopes`)
  if (!allowedScopes.length) throw new Error(`渠道会话 ${id} 允许范围为空`)
  if (conversation.status === 'unlinked') requiredText(conversation.unlinkedAt, `渠道会话 ${id} unlinkedAt 无效`)
  return { ...conversation, allowedScopes }
}

function normalizeChannelMessage(source, channels = false) {
  if (!record(source)) throw new Error('渠道消息状态无效')
  const { provider: _provider, ...message } = source
  exactKeys(message, ['id', 'channelAppId', 'providerEventId', 'providerMessageId', 'replyToProviderMessageId', 'providerConversationId', 'providerUserId', 'conversationId', 'senderIdentityId', 'direction', 'text', 'receivedAt', 'persistedAt', 'reservedAt', 'status', 'command', 'clientRequestId', 'authorizationRevisions', 'workId', 'error', ...(channels ? ['providerAccountId', 'conversationType', 'bodyDigest', 'conflicts', 'action', 'memberConversationId', 'turnId', 'noticeKey', 'rejectionCode'] : [])], '渠道消息')
  const id = requiredText(message.id, '渠道消息 ID 无效')
  for (const key of ['channelAppId', 'receivedAt', 'persistedAt']) requiredText(message[key], `渠道消息 ${id} ${key} 无效`)
  for (const key of ['providerConversationId', 'providerUserId']) {
    if (!channels || message.status !== 'rejected' || message[key] !== undefined) officialId(message[key], `渠道消息 ${id} ${key}`)
  }
  if (!text(message.providerEventId) && !text(message.providerMessageId)) throw new Error(`渠道消息 ${id} 缺少官方稳定 ID`)
  if (message.providerEventId !== undefined) requiredText(message.providerEventId, `渠道消息 ${id} event ID 无效`)
  if (message.providerMessageId !== undefined) requiredText(message.providerMessageId, `渠道消息 ${id} message ID 无效`)
  if (message.replyToProviderMessageId !== undefined) requiredText(message.replyToProviderMessageId, `渠道消息 ${id} reply message ID 无效`)
  if (message.conversationId !== undefined) requiredText(message.conversationId, `渠道消息 ${id} conversationId 无效`)
  if (message.senderIdentityId !== undefined) requiredText(message.senderIdentityId, `渠道消息 ${id} senderIdentityId 无效`)
  if (message.text !== undefined && (channels ? typeof message.text !== 'string' || message.text.length > 16_000 : !text(message.text))) throw new Error(`渠道消息 ${id} 文本无效`)
  if (!['inbound', 'outbound'].includes(message.direction) || !['received', 'reserved', 'unhandled', 'accepted', 'rejected'].includes(message.status)) throw new Error(`渠道消息 ${id} 状态无效`)
  if (message.command !== undefined) normalizeChannelCommand(message.command, id)
  if (message.clientRequestId !== undefined && (!text(message.clientRequestId) || message.clientRequestId.length > 340)) throw new Error(`渠道消息 ${id} clientRequestId 无效`)
  if (message.clientRequestId !== undefined) {
    const kind = message.providerEventId ? 'event' : 'message', official = message.providerEventId ?? message.providerMessageId
    const expected = message.action
      ? `channel:${createHash('sha256').update(`${message.channelAppId}\0${id}`).digest('hex')}`
      : `channel:${message.channelAppId}:${createHash('sha256').update(`${message.channelAppId}\0${kind}\0${official}`).digest('hex')}`
    if (message.clientRequestId !== expected) throw new Error(`渠道消息 ${id} clientRequestId 不闭合`)
  }
  if (message.authorizationRevisions !== undefined) normalizeChannelAuthorizationRevisions(message.authorizationRevisions, `渠道消息 ${id}`)
  if (message.reservedAt !== undefined) requiredText(message.reservedAt, `渠道消息 ${id} reservedAt 无效`)
  if (message.status === 'reserved' && (message.direction !== 'inbound' || !(message.command || message.action === 'chat') || !message.clientRequestId || !message.authorizationRevisions || !message.reservedAt)) throw new Error(`渠道消息 ${id} reserved 状态不闭合`)
  if (message.status === 'accepted' && !message.action) requiredText(message.workId, `渠道消息 ${id} workId 无效`)
  if (message.command?.workId !== undefined && message.workId !== message.command.workId) throw new Error(`渠道消息 ${id} command 工作引用不闭合`)
  if (channels) {
    for (const key of ['receivedAt', 'persistedAt', 'reservedAt']) if (message[key] !== undefined) isoTimestamp(message[key], `渠道消息 ${id} ${key}`)
    if (message.providerAccountId !== undefined) officialId(message.providerAccountId, `渠道消息 ${id} account ID`)
    if (message.conversationType !== undefined && !['private', 'group'].includes(message.conversationType)) throw new Error('渠道消息会话类型无效')
    if (message.bodyDigest !== undefined) hexDigest(message.bodyDigest, '渠道消息正文摘要')
    if (message.rejectionCode !== undefined) safeCode(message.rejectionCode, '渠道消息拒绝码')
    if (message.noticeKey !== undefined && !['conversation.started', 'conversation.default-changed'].includes(message.noticeKey)) throw new Error('渠道消息通知类型无效')
    if (message.action !== undefined) {
      if (!['chat', 'new-conversation'].includes(message.action) || message.command || message.workId || !message.clientRequestId || !message.reservedAt || !message.authorizationRevisions) throw new Error('渠道会话受理状态不闭合')
      requiredText(message.memberConversationId, '渠道对话引用无效')
      if (message.action === 'new-conversation' && (message.status !== 'accepted' || message.turnId !== undefined || message.noticeKey !== 'conversation.started')) throw new Error('渠道新会话受理状态不闭合')
      if (message.action === 'chat' && message.status === 'accepted') requiredText(message.turnId, '渠道回复引用无效')
      if (message.action === 'chat' && !['reserved', 'accepted', 'rejected'].includes(message.status)) throw new Error('渠道聊天状态无效')
    } else if (message.memberConversationId !== undefined || message.turnId !== undefined || message.noticeKey !== undefined) throw new Error('渠道消息缺少会话 action')
    if (message.turnId !== undefined) requiredText(message.turnId, '渠道回复引用无效')
    if (message.conflicts !== undefined) {
      if (!Array.isArray(message.conflicts)) throw new Error('渠道 ID 冲突事实无效')
      for (const conflict of message.conflicts) {
        if (!record(conflict)) throw new Error('渠道 ID 冲突事实无效')
        exactKeys(conflict, ['digest', 'providerEventId', 'providerMessageId', 'receivedAt', 'error'], '渠道 ID 冲突事实')
        hexDigest(conflict.digest, '渠道 ID 冲突摘要')
        for (const key of ['providerEventId', 'providerMessageId']) if (conflict[key] !== undefined) officialId(conflict[key], `渠道冲突 ${key}`)
        isoTimestamp(conflict.receivedAt, '渠道冲突时间')
        normalizeChannelError(conflict.error, '渠道冲突')
        if (conflict.error.code !== 'OFFICIAL_ID_CONFLICT') throw new Error('渠道冲突错误码无效')
      }
      uniqueDomain(message.conflicts, item => [item.digest], '渠道 ID 冲突')
    }
  }
  if (message.error !== undefined) normalizeChannelError(message.error, `渠道消息 ${id}`)
  return message
}

function normalizeChannelCommand(command, messageId) {
  if (!record(command) || !['create', 'follow-up', 'status', 'stop'].includes(command.type)) throw new Error(`渠道消息 ${messageId} command 无效`)
  const fields = command.type === 'create'
    ? ['type', 'workOrderId', 'employeeId', 'skillId', 'capabilityId', 'connectionId']
    : command.type === 'follow-up' ? ['type', 'workId', 'text'] : ['type', 'workId']
  exactKeys(command, fields, `渠道消息 ${messageId} command`)
  if (command.type === 'create') {
    for (const key of ['workOrderId', 'employeeId', 'skillId', 'capabilityId']) requiredText(command[key], `渠道消息 ${messageId} command ${key} 无效`)
    if (command.connectionId !== undefined) requiredText(command.connectionId, `渠道消息 ${messageId} command connectionId 无效`)
    if (command.capabilityId !== GEARJOB_CAPABILITY_ID) throw new Error(`渠道消息 ${messageId} command capability 无效`)
  } else {
    requiredText(command.workId, `渠道消息 ${messageId} command workId 无效`)
    if (command.type === 'follow-up') requiredRawText(command.text, `渠道消息 ${messageId} command text 无效`)
  }
}

function normalizeChannelAuthorizationRevisions(revisions, label) {
  if (!record(revisions)) throw new Error(`${label} 授权 revision 无效`)
  exactKeys(revisions, ['app', 'identity', 'conversation'], `${label} 授权 revision`)
  for (const key of ['app', 'identity', 'conversation']) if (!Number.isSafeInteger(revisions[key]) || revisions[key] < 1) throw new Error(`${label} 授权 revision 无效`)
}

function normalizeDelivery(source, channels = false) {
  if (!record(source)) throw new Error('渠道投递状态无效')
  const { provider: _provider, ...delivery } = source
  if (delivery.contentKey === undefined) delivery.contentKey = delivery.resultId ? 'result.gearjob' : 'work.accepted'
  exactKeys(delivery, ['id', 'channelAppId', 'requestId', 'workId', 'resultId', 'channelMessageId', 'targetConversationId', 'targetIdentityId', 'contentScope', 'contentKey', 'authorizationRevisions', 'status', 'attempts', 'providerMessageId', 'error', 'createdAt', 'updatedAt', ...(channels ? ['sourceRef', 'sendProgress', 'actionId'] : [])], '渠道投递')
  const id = requiredText(delivery.id, '渠道投递 ID 无效')
  for (const key of ['channelAppId', 'requestId', 'targetConversationId', 'targetIdentityId', 'contentScope', 'contentKey', 'createdAt', 'updatedAt']) requiredText(delivery[key], `渠道投递 ${id} ${key} 无效`)
  if (delivery.workId !== undefined) requiredText(delivery.workId, `渠道投递 ${id} workId 无效`)
  const fixedKeys = ['group.accepted', 'help.unsupported', 'help.unavailable', ...(channels ? ['help.confirmation', 'help.busy', 'help.interrupted', 'help.reply-invalid', 'conversation.started', 'conversation.default-changed'] : [])]
  const fixed = fixedKeys.includes(delivery.contentKey), reply = channels && delivery.contentKey === 'conversation.reply'
  if ((!fixed && !reply && !delivery.workId) || (delivery.contentKey === 'result.gearjob' && !delivery.resultId)
      || !['work.accepted', 'result.gearjob', 'automation.completed', 'automation.failed', ...fixedKeys, ...(channels ? ['conversation.reply', 'action.receipt'] : [])].includes(delivery.contentKey)
      || (delivery.contentKey === 'automation.completed' && !delivery.resultId) || (delivery.contentKey === 'automation.failed' && delivery.resultId)) throw new Error(`渠道投递 ${id} 内容引用无效`)
  if (delivery.contentKey === 'action.receipt') {
    requiredText(delivery.actionId, `渠道投递 ${id} actionId 无效`)
    requiredText(delivery.resultId, `渠道投递 ${id} 回执依据无效`)
  } else if (delivery.actionId !== undefined) throw new Error('渠道投递动作引用类型无效')
  if (channels && (reply || delivery.sourceRef !== undefined)) {
    if (!reply || !record(delivery.sourceRef) || delivery.workId !== undefined || delivery.resultId !== undefined) throw new Error('渠道回复来源无效')
    exactKeys(delivery.sourceRef, ['kind', 'conversationId', 'turnId'], '渠道回复来源')
    if (delivery.sourceRef.kind !== 'conversation-turn') throw new Error('渠道回复来源类型无效')
    for (const key of ['conversationId', 'turnId']) requiredText(delivery.sourceRef[key], `渠道回复 ${key} 无效`)
  }
  if (delivery.resultId !== undefined) requiredText(delivery.resultId, `渠道投递 ${id} resultId 无效`)
  if (delivery.channelMessageId !== undefined) requiredText(delivery.channelMessageId, `渠道投递 ${id} channelMessageId 无效`)
  if (delivery.providerMessageId !== undefined) requiredText(delivery.providerMessageId, `渠道投递 ${id} providerMessageId 无效`)
  if (!Number.isSafeInteger(delivery.attempts) || delivery.attempts < 0 || !['pending', 'sending', 'delivered', 'failed', 'unknown', 'blocked', 'cancelled'].includes(delivery.status)) throw new Error(`渠道投递 ${id} 状态无效`)
  if (delivery.authorizationRevisions !== undefined) {
    normalizeChannelAuthorizationRevisions(delivery.authorizationRevisions, `渠道投递 ${id}`)
  }
  if (delivery.error !== undefined) normalizeChannelError(delivery.error, `渠道投递 ${id}`)
  const hasAuthorization = delivery.authorizationRevisions !== undefined
  const hasProviderMessage = delivery.providerMessageId !== undefined
  const hasError = delivery.error !== undefined
  if (delivery.status === 'pending' && (delivery.attempts !== 0 || hasAuthorization || hasProviderMessage || hasError)) throw new Error(`渠道投递 ${id} pending 状态不闭合`)
  if (delivery.status === 'sending' && (delivery.attempts < 1 || !hasAuthorization || hasProviderMessage || hasError)) throw new Error(`渠道投递 ${id} sending 状态不闭合`)
  if (delivery.status === 'delivered' && (delivery.attempts < 1 || !hasAuthorization || !hasProviderMessage || hasError)) throw new Error(`渠道投递 ${id} delivered 状态不闭合`)
  if (['failed', 'unknown'].includes(delivery.status) && (delivery.attempts < 1 || !hasAuthorization || !hasError)) throw new Error(`渠道投递 ${id} ${delivery.status} 状态不闭合`)
  if (delivery.status === 'blocked' && (!hasError || hasProviderMessage)) throw new Error(`渠道投递 ${id} blocked 状态不闭合`)
  if (delivery.status === 'cancelled' && hasProviderMessage) throw new Error(`渠道投递 ${id} cancelled 状态不闭合`)
  if (channels && delivery.sendProgress !== undefined) normalizeSendProgress(delivery)
  return delivery
}

function normalizeLinkCode(link, channels = false) {
  if (!record(link)) throw new Error('关联码状态无效')
  exactKeys(link, ['id', 'channelAppId', 'memberId', 'digest', 'status', 'failedAttempts', 'expiresAt', 'createdAt', 'updatedAt', 'matchedIdentityId', 'matchedConversationId', 'matchedAt', 'consumedAt', ...(channels ? ['kind', 'loginRef', 'tokenRef', 'cursorRef', 'contextRef', 'qrcodeUrl', 'error'] : [])], '关联码')
  const id = requiredText(link.id, '关联码 ID 无效')
  for (const key of ['channelAppId', 'memberId', 'expiresAt', 'createdAt', 'updatedAt']) requiredText(link[key], `关联码 ${id} ${key} 无效`)
  if (typeof link.digest !== 'string' || !/^[a-f0-9]{64}$/.test(link.digest) || !['active', 'matched', 'consumed', 'expired', 'cancelled'].includes(link.status) || !Number.isSafeInteger(link.failedAttempts) || link.failedAttempts < 0 || link.failedAttempts > 5) throw new Error(`关联码 ${id} 状态无效`)
  if (['matched', 'consumed'].includes(link.status)) {
    requiredText(link.matchedIdentityId, `关联码 ${id} matchedIdentityId 无效`)
    requiredText(link.matchedConversationId, `关联码 ${id} matchedConversationId 无效`)
    requiredText(link.matchedAt, `关联码 ${id} matchedAt 无效`)
  }
  if (link.status === 'consumed') requiredText(link.consumedAt, `关联码 ${id} consumedAt 无效`)
  if (channels) {
    const qrFields = ['loginRef', 'tokenRef', 'cursorRef', 'contextRef', 'qrcodeUrl']
    if (link.kind !== undefined && link.kind !== 'weixin-qr') throw new Error('关联码 kind 无效')
    if (!link.kind && qrFields.some(key => link[key] !== undefined)) throw new Error('普通关联码不得包含微信扫码字段')
    if (link.kind === 'weixin-qr') {
      const refs = qrFields.slice(0, 4).map(key => secretRef(link[key], `微信关联码 ${key}`))
      if (new Set(refs).size !== refs.length) throw new Error('微信关联码秘密引用不得复用')
      if (link.qrcodeUrl !== undefined) {
        if (typeof link.qrcodeUrl !== 'string' || link.qrcodeUrl.length > 4096) throw new Error('微信扫码地址无效')
        let url
        try { url = new URL(link.qrcodeUrl) } catch { throw new Error('微信扫码地址无效') }
        const base = new URL(url.href); base.search = ''; base.hash = ''
        if (url.username || url.password) throw new Error('微信扫码地址无效')
        if (!(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) normalizeWeixinApiBaseUrl(base.href)
      }
    }
    if (link.error !== undefined) normalizeChannelError(link.error, '渠道关联码')
  }
  return link
}

function normalizeSendProgress(delivery) {
  const value = delivery.sendProgress
  if (!record(value)) throw new Error('投递分段进度无效')
  exactKeys(value, ['attemptId', 'totalParts', 'textDigest', 'acknowledgedParts', 'partIndex'], '投递分段进度')
  if (!uuid(value.attemptId) || delivery.attempts < 1 || delivery.status === 'pending') throw new Error('投递分段 attempt 无效')
  boundedInteger(value.totalParts, 1, Number.MAX_SAFE_INTEGER, '投递总分段数无效')
  hexDigest(value.textDigest, '投递内容摘要')
  if (!Array.isArray(value.acknowledgedParts) || value.acknowledgedParts.length > value.totalParts) throw new Error('投递分段 ACK 无效')
  value.acknowledgedParts.forEach((part, index) => {
    if (!record(part)) throw new Error('投递分段 ACK 无效')
    exactKeys(part, ['index', 'clientId'], '投递分段 ACK')
    const clientId = `geneway-weixin-${createHash('sha256').update(`${value.attemptId}\0${index}`).digest('hex').slice(0, 32)}`
    if (part.index !== index || part.clientId !== clientId) throw new Error('投递分段 ACK 必须是原请求的连续前缀')
  })
  if (value.partIndex !== undefined) {
    boundedInteger(value.partIndex, 0, value.totalParts - 1, '投递当前分段无效')
    if (value.partIndex !== value.acknowledgedParts.length) throw new Error('投递分段 claim 必须紧接 ACK 前缀')
  }
  if (delivery.status === 'delivered' && value.acknowledgedParts.length !== value.totalParts) throw new Error('已投递消息必须确认全部分段')
}

function normalizeChannelError(error, label) {
  if (!record(error)) throw new Error(`${label} error 无效`)
  exactKeys(error, ['code', 'message'], `${label} error`)
  safeCode(error.code, `${label} error code`)
  requiredText(error.message, `${label} error message 无效`)
}

function validateDefaultDispatch(conversation, state, memberById, employeeById, skillById, connectionById) {
  const value = conversation.defaultDispatch
  if (!record(value)) throw new Error(`渠道会话 ${conversation.id} 默认派发无效`)
  exactKeys(value, ['employeeId', 'skillId', 'capabilityId', 'connectionId'], `渠道会话 ${conversation.id} 默认派发`)
  for (const key of ['employeeId', 'skillId', 'capabilityId']) requiredText(value[key], `渠道会话 ${conversation.id} 默认派发 ${key} 无效`)
  const member = memberById.get(conversation.memberId), employee = employeeById.get(value.employeeId), skill = skillById.get(value.skillId)
  if (!member?.employeeIds.includes(value.employeeId) || !employee || !employee.skillIds?.includes(value.skillId) || !skill || skill.capabilityId !== value.capabilityId) throw new Error(`渠道会话 ${conversation.id} 默认派发引用无效`)
  if (value.connectionId !== undefined && (!connectionById.has(value.connectionId) || !employee.connectionIds?.includes(value.connectionId))) throw new Error(`渠道会话 ${conversation.id} 默认派发连接无效`)
}

function uniqueDomain(items, key, label) {
  const values = items.map(item => key(item).join('\0'))
  if (new Set(values).size !== values.length) throw new Error(`${label} 重复`)
}

function normalizeCollaborations(works, memberIds, state) {
  const byId = new Map(works.map(work => [work.id, work]))
  const claimedChildren = new Map()
  for (const work of works) {
    if (work.parentWorkId !== undefined || work.rootWorkId !== undefined) {
      if (work.workType !== 'collaboration-child') throw new Error(`子工作 ${work.id} workType 无效`)
      const parentWorkId = requiredText(work.parentWorkId, `子工作 ${work.id} parentWorkId 无效`)
      const rootWorkId = requiredText(work.rootWorkId, `子工作 ${work.id} rootWorkId 无效`)
      const rootWork = byId.get(rootWorkId)
      if (parentWorkId !== rootWorkId || !rootWork?.collaboration || work.ownerMemberId !== rootWork.ownerMemberId) throw new Error(`子工作 ${work.id} 根工作或 owner 引用无效`)
      if (!Number.isSafeInteger(work.collaborationGeneration) || work.collaborationGeneration < 1) throw new Error(`子工作 ${work.id} generation 无效`)
      requiredText(work.planItemId, `子工作 ${work.id} planItemId 无效`)
      if (work.knowledgeQuery !== undefined) {
        const query = requiredRawText(work.knowledgeQuery, `子工作 ${work.id} knowledgeQuery 无效`).trim()
        if (!query || !query.isWellFormed() || Array.from(query).length > 256 || query.split(/\s+/u).length > 16) throw new Error(`子工作 ${work.id} knowledgeQuery 无效`)
      }
    } else if (work.knowledgeQuery !== undefined) {
      throw new Error(`工作 ${work.id} 不得包含 knowledgeQuery`)
    }
    if (!work.collaboration) continue
    if (work.workType !== 'collaboration') throw new Error(`协作工作 ${work.id} workType 无效`)
    if (!memberIds.has(work.ownerMemberId)) throw new Error(`协作工作 ${work.id} ownerMemberId 不存在`)
    const collaboration = work.collaboration
    if (!record(collaboration)) throw new Error(`协作工作 ${work.id} 状态无效`)
    exactKeys(collaboration, ['generation', 'cancelGeneration', 'status', 'requestLimit', 'requestCount', 'childLimit', 'maxConcurrentChildren', 'rootTimeoutMs', 'childTimeoutMs', 'outputMaxTokens', 'childWorkIds', 'summaryResultRefs', 'staleKnowledgeRefs', 'staleItemIds'], `协作工作 ${work.id}`)
    if (!Number.isSafeInteger(collaboration.generation) || collaboration.generation < 1) throw new Error(`协作工作 ${work.id} generation 无效`)
    if (!Number.isSafeInteger(collaboration.cancelGeneration) || collaboration.cancelGeneration < 0) throw new Error(`协作工作 ${work.id} cancelGeneration 无效`)
    if (!['accepted', 'running', 'waiting_input', 'completed', 'cancelled', 'failed', 'interrupted', 'stale'].includes(collaboration.status)) throw new Error(`协作工作 ${work.id} 状态无效`)
    boundedInteger(collaboration.requestLimit, 1, 12, `协作工作 ${work.id} requestLimit 无效`)
    boundedInteger(collaboration.requestCount, 0, collaboration.requestLimit, `协作工作 ${work.id} requestCount 无效`)
    boundedInteger(collaboration.childLimit, 1, 4, `协作工作 ${work.id} childLimit 无效`)
    boundedInteger(collaboration.maxConcurrentChildren, 1, 2, `协作工作 ${work.id} maxConcurrentChildren 无效`)
    boundedInteger(collaboration.rootTimeoutMs, 1, 360_000, `协作工作 ${work.id} rootTimeoutMs 无效`)
    boundedInteger(collaboration.childTimeoutMs, 1, 120_000, `协作工作 ${work.id} childTimeoutMs 无效`)
    if (collaboration.outputMaxTokens !== 4096) throw new Error(`协作工作 ${work.id} outputMaxTokens 无效`)
    const childWorkIds = uniqueTextArray(collaboration.childWorkIds, `协作工作 ${work.id} childWorkIds`)
    if (!childWorkIds.length) throw new Error(`协作工作 ${work.id} 至少需要一个子工作`)
    if (childWorkIds.length > collaboration.childLimit) throw new Error(`协作工作 ${work.id} 子工作超过上限`)
    for (const id of childWorkIds) {
      if (byId.get(id)?.rootWorkId !== work.id || claimedChildren.has(id)) throw new Error(`协作工作 ${work.id} 子工作引用无效或重复归属`)
      claimedChildren.set(id, work.id)
    }
    const childResultIds = new Set(childWorkIds.flatMap(id => byId.get(id)?.results.map(result => result.id) ?? []))
    for (const id of uniqueTextArray(collaboration.summaryResultRefs, `协作工作 ${work.id} summaryResultRefs`)) if (!childResultIds.has(id)) throw new Error(`协作工作 ${work.id} 汇总引用不存在`)
    const staleKnowledgeRefs = uniqueTextArray(collaboration.staleKnowledgeRefs, `协作工作 ${work.id} staleKnowledgeRefs`)
    const staleItemIds = uniqueTextArray(collaboration.staleItemIds, `协作工作 ${work.id} staleItemIds`)
    if (!record(work.plan) || !Number.isSafeInteger(work.plan.revision) || work.plan.revision < 1 || !Array.isArray(work.plan.items)) throw new Error(`协作工作 ${work.id} plan 无效`)
    if (work.plan.items.length !== childWorkIds.length) throw new Error(`协作工作 ${work.id} plan 与子工作不一致`)
    const itemIds = new Set(), plannedChildren = new Set()
    for (const item of work.plan.items) {
      if (!record(item)) throw new Error(`协作工作 ${work.id} plan item 无效`)
      exactKeys(item, ['id', 'childWorkId', 'goal', 'employeeId', 'status', 'dependsOn'], `协作工作 ${work.id} plan item`)
      const id = requiredText(item.id, `协作工作 ${work.id} plan item ID 无效`)
      if (itemIds.has(id)) throw new Error(`协作工作 ${work.id} plan item ID 重复`)
      itemIds.add(id)
      const childWorkId = requiredText(item.childWorkId, `协作工作 ${work.id} plan childWorkId 无效`)
      if (!childWorkIds.includes(childWorkId) || plannedChildren.has(childWorkId)) throw new Error(`协作工作 ${work.id} plan childWorkId 不存在或重复`)
      plannedChildren.add(childWorkId)
      requiredText(item.goal, `协作工作 ${work.id} plan goal 无效`)
      requiredText(item.employeeId, `协作工作 ${work.id} plan employeeId 无效`)
      if (byId.get(item.childWorkId)?.employeeId !== item.employeeId || byId.get(item.childWorkId)?.planItemId !== item.id) throw new Error(`协作工作 ${work.id} plan item 与子工作不一致`)
      if (!['not_started', 'running', 'completed', 'waiting_input', 'failed', 'cancelled', 'interrupted'].includes(item.status)) throw new Error(`协作工作 ${work.id} plan item 状态无效`)
      uniqueTextArray(item.dependsOn ?? [], `协作工作 ${work.id} plan dependsOn`)
    }
    for (const item of work.plan.items) if ((item.dependsOn ?? []).some(id => !itemIds.has(id) || id === item.id)) throw new Error(`协作工作 ${work.id} plan dependsOn 引用无效`)
    if (hasPlanCycle(work.plan.items)) throw new Error(`协作工作 ${work.id} plan 依赖成环`)
    if (staleItemIds.some(id => !itemIds.has(id)) || (collaboration.status === 'stale') !== Boolean(staleItemIds.length)) throw new Error(`协作工作 ${work.id} stale item 状态无效`)
    if (!Array.isArray(work.handoffs)) throw new Error(`协作工作 ${work.id} handoffs 无效`)
    const currentHandoffs = new Map()
    for (const handoff of work.handoffs) {
      if (!record(handoff)) throw new Error(`协作工作 ${work.id} handoff 无效`)
      exactKeys(handoff, ['id', 'childWorkId', 'fromEmployeeId', 'toEmployeeId', 'resultRefs', 'knowledgeRefs', 'revision', 'generation', 'status', 'createdAt'], `协作工作 ${work.id} handoff`)
      for (const key of ['id', 'childWorkId', 'fromEmployeeId', 'toEmployeeId', 'status', 'createdAt']) requiredText(handoff[key], `协作工作 ${work.id} handoff ${key} 无效`)
      if (!Number.isSafeInteger(handoff.revision) || handoff.revision < 1) throw new Error(`协作工作 ${work.id} handoff revision 无效`)
      if (!Number.isSafeInteger(handoff.generation) || handoff.generation < 1 || handoff.generation > collaboration.generation || !['current', 'superseded'].includes(handoff.status)) throw new Error(`协作工作 ${work.id} handoff generation 或状态无效`)
      if (!childWorkIds.includes(handoff.childWorkId) || byId.get(handoff.childWorkId)?.employeeId !== handoff.fromEmployeeId || handoff.toEmployeeId !== work.employeeId) throw new Error(`协作工作 ${work.id} handoff 身份引用无效`)
      const ownedResults = new Set(byId.get(handoff.childWorkId).results.map(result => result.id))
      const resultRefs = uniqueTextArray(handoff.resultRefs, `协作工作 ${work.id} handoff resultRefs`)
      if (resultRefs.length !== 1) throw new Error(`协作工作 ${work.id} handoff 必须引用一个结果`)
      for (const resultId of resultRefs) if (!ownedResults.has(resultId) || byId.get(handoff.childWorkId).results.find(result => result.id === resultId)?.generation !== handoff.generation) throw new Error(`协作工作 ${work.id} handoff 结果引用不存在或 generation 不一致`)
      if (!Array.isArray(handoff.knowledgeRefs)) throw new Error(`协作工作 ${work.id} handoff knowledgeRefs 无效`)
      const handoffKnowledge = normalizeKnowledgeRefs(handoff.knowledgeRefs, `协作工作 ${work.id} handoff knowledgeRefs`)
      const resultKnowledge = byId.get(handoff.childWorkId).results.find(result => result.id === resultRefs[0])?.knowledgeDependencyRefs ?? []
      if (!sameKnowledgeRefs(handoffKnowledge, resultKnowledge)) throw new Error(`协作工作 ${work.id} handoff knowledgeRefs 与结果不一致`)
      if (handoff.status === 'current') {
        if (currentHandoffs.has(handoff.childWorkId)) throw new Error(`协作工作 ${work.id} 子工作存在多个当前 handoff`)
        currentHandoffs.set(handoff.childWorkId, handoff)
      }
    }
    uniqueIds(work.handoffs, `协作工作 ${work.id} handoff`)
    for (const item of work.plan.items) {
      const child = byId.get(item.childWorkId)
      const gearJobDependent = child.capabilityId === 'cycle-time-calculate' && item.dependsOn.some(id => {
        const dependency = work.plan.items.find(candidate => candidate.id === id)
        return byId.get(dependency?.childWorkId)?.capabilityId === 'gearjob-work-order-read'
      })
      if (gearJobDependent && child.input.quantity !== undefined) {
        if (!child.inputProvenance) throw new Error(`子工作 ${child.id} 派生数量缺少输入来源`)
        for (const result of child.results.filter(candidate => candidate.kind === 'manufacturing.takt' && candidate.input.quantity === child.input.quantity)) {
          if (!result.inputProvenance || !sameQuantityProvenance(result.inputProvenance, child.inputProvenance)) throw new Error(`子工作 ${child.id} 节拍结果缺少匹配输入来源`)
        }
      }
      const provenances = [[child.inputProvenance, child.input.quantity], ...child.results.map(result => [result.inputProvenance, result.input.quantity])].filter(([provenance]) => provenance)
      for (const [provenance, quantity] of provenances) {
        const source = validateQuantityProvenance(provenance, quantity, `子工作 ${child.id}`)
        const eligible = item.dependsOn.flatMap(id => {
          const dependency = work.plan.items.find(candidate => candidate.id === id), sourceChild = byId.get(dependency?.childWorkId), handoff = currentHandoffs.get(sourceChild?.id)
          const result = sourceChild?.results.find(candidate => handoff?.resultRefs.length === 1 && handoff.resultRefs[0] === candidate.id && candidate.kind === 'gearjob.work-order.observation')
          return result ? [{ dependency, handoff, result }] : []
        })
        if (eligible.length !== 1) throw new Error(`子工作 ${child.id} 数量来源必须绑定唯一当前 GearJob 交接`)
        const [{ dependency, handoff, result }] = eligible
        if (dependency.id !== source.sourcePlanItemId || handoff.resultRefs[0] !== source.sourceResultId || result.payload.plannedQuantity !== source.plannedQuantity || result.payload.completedQuantity !== source.completedQuantity) throw new Error(`子工作 ${child.id} 数量来源引用无效`)
      }
    }
    const treeResults = [work, ...childWorkIds.map(id => byId.get(id))].flatMap(item => item.results)
    uniqueIds(treeResults, `协作工作 ${work.id} tree result`)
    for (const related of [work, ...childWorkIds.map(id => byId.get(id))]) for (const execution of related.executions) {
      if (execution.generation !== undefined && (!Number.isSafeInteger(execution.generation) || execution.generation < 1 || execution.generation > collaboration.generation)) throw new Error(`协作工作 ${work.id} execution generation 无效`)
      if (execution.cancelGeneration !== undefined && (!Number.isSafeInteger(execution.cancelGeneration) || execution.cancelGeneration < 0 || execution.cancelGeneration > collaboration.cancelGeneration)) throw new Error(`协作工作 ${work.id} execution cancelGeneration 无效`)
      if (execution.planRevision !== undefined && (!Number.isSafeInteger(execution.planRevision) || execution.planRevision < 1 || execution.planRevision > work.plan.revision)) throw new Error(`协作工作 ${work.id} execution planRevision 无效`)
      if (execution.employeeId !== undefined && execution.employeeId !== related.employeeId) throw new Error(`协作工作 ${work.id} execution employee 无效`)
      if (execution.usage !== undefined) normalizeUsage(execution.usage, `协作工作 ${work.id} execution usage`)
    }
    for (const item of work.plan.items) {
      const child = byId.get(item.childWorkId)
      if (child.collaborationGeneration !== collaboration.generation) throw new Error(`协作工作 ${work.id} 子工作 current generation 无效`)
      const expectedChildStatus = item.status === 'not_started' ? 'accepted' : item.status
      if (child.status !== expectedChildStatus) throw new Error(`协作工作 ${work.id} plan 与子工作状态不一致`)
      if (['not_started', 'running'].includes(item.status)) {
        const currentExecutions = child.executions.filter(execution => execution.generation === collaboration.generation && execution.cancelGeneration === collaboration.cancelGeneration && ['accepted', 'running'].includes(execution.status))
        if (currentExecutions.length !== 1) throw new Error(`协作工作 ${work.id} 子工作 current execution 不闭合`)
      }
      for (const result of child.results) {
        if (!Number.isSafeInteger(result.generation) || result.generation < 1 || result.generation > collaboration.generation || result.employeeId !== child.employeeId || result.handoffRefs?.length !== 1) throw new Error(`协作工作 ${work.id} 子结果身份或 generation 无效`)
        const handoff = work.handoffs.find(candidate => candidate.id === result.handoffRefs[0])
        if (!handoff || handoff.childWorkId !== child.id || handoff.resultRefs[0] !== result.id) throw new Error(`协作工作 ${work.id} 子结果 handoff 不互指`)
      }
    }
    const rootSummaries = work.results.filter(result => result.kind === 'assistant.collaboration-summary')
    for (const summary of rootSummaries) {
      if (!Number.isSafeInteger(summary.generation) || summary.generation < 1 || summary.generation > collaboration.generation || summary.employeeId !== work.employeeId) throw new Error(`协作工作 ${work.id} summary 身份或 generation 无效`)
      const refs = uniqueTextArray(summary.payload.resultRefs, `协作工作 ${work.id} summary resultRefs`)
      if (refs.some(id => !childResultIds.has(id)) || summary.handoffRefs?.some(id => !work.handoffs.some(handoff => handoff.id === id))) throw new Error(`协作工作 ${work.id} summary 引用无效`)
      const summaryHandoffs = summary.handoffRefs.map(id => work.handoffs.find(handoff => handoff.id === id))
      const expectedKnowledge = stableKnowledgeRefs(summaryHandoffs.flatMap(handoff => handoff.knowledgeRefs))
      if (!sameKnowledgeRefs(summary.knowledgeDependencyRefs ?? [], expectedKnowledge)) throw new Error(`协作工作 ${work.id} summary 知识依赖不闭合`)
    }
    const invalidItems = work.plan.items.filter(item => {
      const handoff = currentHandoffs.get(item.childWorkId)
      const child = byId.get(item.childWorkId)
      return handoff?.knowledgeRefs.some(ref => !validCurrentKnowledgeRef(state, ref, work.ownerMemberId, child.employeeId)
        || !validCurrentKnowledgeRef(state, ref, work.ownerMemberId, work.employeeId))
    }).map(item => item.id).sort()
    if (collaboration.status === 'completed' && (invalidItems.length || staleItemIds.length || staleKnowledgeRefs.length)) throw new Error(`协作工作 ${work.id} completed 知识依赖无效`)
    if (collaboration.status === 'stale' && !sameTextArray(staleItemIds, invalidItems)) throw new Error(`协作工作 ${work.id} stale item 与当前依赖不一致`)
    const expectedStaleRefs = stableKnowledgeRefs(work.plan.items.filter(item => invalidItems.includes(item.id)).flatMap(item => {
      const child = byId.get(item.childWorkId)
      return (currentHandoffs.get(item.childWorkId)?.knowledgeRefs ?? []).filter(ref => !validCurrentKnowledgeRef(state, ref, work.ownerMemberId, child.employeeId)
        || !validCurrentKnowledgeRef(state, ref, work.ownerMemberId, work.employeeId))
    })).map(knowledgeKey)
    if (collaboration.status === 'stale' && !sameTextArray(staleKnowledgeRefs, expectedStaleRefs)) throw new Error(`协作工作 ${work.id} stale knowledge refs 与当前依赖不一致`)
    if (work.status !== collaboration.status && !(work.status === 'completed' && collaboration.status === 'stale')) throw new Error(`协作工作 ${work.id} 根状态不一致`)
    if (['accepted', 'running'].includes(collaboration.status)) {
      const currentRootExecutions = work.executions.filter(execution => execution.generation === collaboration.generation && execution.cancelGeneration === collaboration.cancelGeneration && ['accepted', 'running'].includes(execution.status))
      if (currentRootExecutions.length !== 1) throw new Error(`协作工作 ${work.id} 根 current execution 不闭合`)
    }
    if (['completed', 'stale'].includes(collaboration.status)) {
      if (work.plan.items.some(item => item.status !== 'completed') || currentHandoffs.size !== work.plan.items.length) throw new Error(`协作工作 ${work.id} 完成状态不闭合`)
      const expectedRefs = work.plan.items.flatMap(item => currentHandoffs.get(item.childWorkId).resultRefs)
      const latestSummary = rootSummaries.at(-1)
      const currentRootExecution = work.executions.find(execution => execution.generation === collaboration.generation && execution.status === 'completed')
      if (!latestSummary || latestSummary.generation !== collaboration.generation || currentRootExecution?.resultId !== latestSummary.id || !sameTextArray(collaboration.summaryResultRefs, expectedRefs) || !sameTextArray(latestSummary.payload.resultRefs, expectedRefs) || !sameTextArray(latestSummary.handoffRefs, work.plan.items.map(item => currentHandoffs.get(item.childWorkId).id))) throw new Error(`协作工作 ${work.id} 当前 summary 不闭合`)
    } else if (collaboration.summaryResultRefs.length) throw new Error(`协作工作 ${work.id} 非完成状态不得声明当前 summary`)
  }
  for (const work of works.filter(item => item.workType === 'collaboration-child')) if (!claimedChildren.has(work.id)) throw new Error(`子工作 ${work.id} 未被根工作唯一声明`)
}

function normalizeKnowledgeMaterial(material) {
  if (!record(material)) throw new Error('知识材料状态无效')
  const id = requiredText(material.id, '知识材料 ID 无效')
  const ownerMemberId = requiredText(material.ownerMemberId, `知识材料 ${id} ownerMemberId 无效`)
  if (!Number.isSafeInteger(material.revision) || material.revision < 1) throw new Error(`知识材料 ${id} revision 无效`)
  if (!['active', 'deleted'].includes(material.status)) throw new Error(`知识材料 ${id} 状态无效`)
  requiredText(material.createdAt, `知识材料 ${id} createdAt 无效`)
  requiredText(material.updatedAt, `知识材料 ${id} updatedAt 无效`)

  if (material.status === 'deleted') {
    exactKeys(material, ['id', 'ownerMemberId', 'revision', 'status', 'createdAt', 'updatedAt', 'deletedAt'], `知识材料 ${id} tombstone`)
    requiredText(material.deletedAt, `知识材料 ${id} deletedAt 无效`)
    return material
  }

  exactKeys(material, ['id', 'ownerMemberId', 'employeeIds', 'sharedMemberIds', 'sharedEmployeeIds', 'title', 'body', 'format', 'sourceLabel', 'authorizationBasis', 'revision', 'status', 'createdAt', 'updatedAt'], `知识材料 ${id}`)
  const employeeIds = uniqueTextArray(material.employeeIds, `知识材料 ${id} employeeIds`)
  if (!employeeIds.length) throw new Error(`知识材料 ${id} 至少需要一名员工`)
  const sharedMemberIds = uniqueTextArray(material.sharedMemberIds, `知识材料 ${id} sharedMemberIds`)
  const sharedEmployeeIds = uniqueTextArray(material.sharedEmployeeIds, `知识材料 ${id} sharedEmployeeIds`)
  if (Boolean(sharedMemberIds.length) !== Boolean(sharedEmployeeIds.length)) throw new Error(`知识材料 ${id} 共享成员与员工必须同时设置`)
  const title = requiredRawText(material.title, `知识材料 ${id} 标题无效`)
  const body = requiredRawText(material.body, `知识材料 ${id} 正文无效`)
  const sourceLabel = requiredRawText(material.sourceLabel, `知识材料 ${id} 来源无效`)
  const authorizationBasis = requiredRawText(material.authorizationBasis, `知识材料 ${id} 授权依据无效`)
  if (![title, body, sourceLabel, authorizationBasis].every(item => item.isWellFormed())) throw new Error(`知识材料 ${id} 必须是有效 Unicode 文本`)
  if (Buffer.byteLength(body, 'utf8') > KNOWLEDGE_LIMITS.maxBodyBytes) throw new Error(`知识材料 ${id} 正文超过容量上限`)
  if (Array.from(title).length > KNOWLEDGE_LIMITS.maxTitleCharacters) throw new Error(`知识材料 ${id} 标题过长`)
  if (!['text', 'markdown'].includes(material.format)) throw new Error(`知识材料 ${id} 格式无效`)
  if (Array.from(sourceLabel).length > KNOWLEDGE_LIMITS.maxSourceCharacters) throw new Error(`知识材料 ${id} 来源过长`)
  if (Array.from(authorizationBasis).length > KNOWLEDGE_LIMITS.maxAuthorizationCharacters) throw new Error(`知识材料 ${id} 授权依据过长`)
  return { ...material, employeeIds, sharedMemberIds, sharedEmployeeIds }
}

function normalizeResult(result, { allowKnowledgeDependencyRefs = false } = {}) {
  if (!record(result)) throw new Error('结果状态无效')
  exactKeys(result, ['id', 'kind', 'capabilityId', 'skillId', 'schemaVersion', 'input', 'payload', 'explanation', 'source', 'createdAt', 'toolName', 'pluginId', 'pluginVersion', 'dshSessionRef', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity', 'contextConfirmationRefs', 'employeeId', 'handoffRefs', 'usage', 'generation', 'inputProvenance', ...(allowKnowledgeDependencyRefs ? ['knowledgeDependencyRefs'] : [])], '结果')
  const id = requiredText(result.id, '结果 ID 无效')
  const kind = requiredText(result.kind, `结果 ${id} 类型无效`)
  if (!RESULT_KINDS.has(kind)) throw new Error(`结果 ${id} 类型不受支持：${kind}`)
  if (result.schemaVersion !== 1) throw new Error(`结果 ${id} schemaVersion 无效`)
  requiredText(result.capabilityId, `结果 ${id} capabilityId 无效`)
  requiredText(result.skillId, `结果 ${id} skillId 无效`)
  requiredText(result.createdAt, `结果 ${id} createdAt 无效`)
  requiredText(result.dshSessionRef, `结果 ${id} dshSessionRef 无效`)
  for (const key of ['explanation', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity']) {
    if (result[key] !== undefined) requiredText(result[key], `结果 ${id} ${key} 无效`)
  }
  if (!record(result.input) || !record(result.payload)) throw new Error(`结果 ${id} 输入或 payload 无效`)
  if (!Array.isArray(result.contextConfirmationRefs)) throw new Error(`结果 ${id} confirmation refs 无效`)
  if (result.employeeId !== undefined) requiredText(result.employeeId, `结果 ${id} employeeId 无效`)
  if (result.handoffRefs !== undefined) uniqueTextArray(result.handoffRefs, `结果 ${id} handoffRefs`)
  if (result.usage !== undefined) normalizeUsage(result.usage, `结果 ${id} usage`)
  if (result.generation !== undefined && (!Number.isSafeInteger(result.generation) || result.generation < 1)) throw new Error(`结果 ${id} generation 无效`)
  for (const ref of result.contextConfirmationRefs) {
    if (typeof ref === 'string') {
      requiredText(ref, `结果 ${id} confirmation ref 无效`)
      continue
    }
    if (!record(ref)) throw new Error(`结果 ${id} confirmation ref 无效`)
    exactKeys(ref, ['id', 'revision'], `结果 ${id} confirmation ref`)
    requiredText(ref.id, `结果 ${id} confirmation ref ID 无效`)
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error(`结果 ${id} confirmation ref revision 无效`)
  }
  if (result.knowledgeDependencyRefs !== undefined) {
    if (!Array.isArray(result.knowledgeDependencyRefs)) throw new Error(`结果 ${id} knowledge dependency refs 无效`)
    const keys = new Set()
    for (const ref of result.knowledgeDependencyRefs) {
      if (!record(ref)) throw new Error(`结果 ${id} knowledge dependency ref 无效`)
      exactKeys(ref, ['knowledgeId', 'revision', 'segmentId'], `结果 ${id} knowledge dependency ref`)
      const knowledgeId = requiredText(ref.knowledgeId, `结果 ${id} knowledgeId 无效`)
      if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error(`结果 ${id} knowledge revision 无效`)
      const segmentId = requiredText(ref.segmentId, `结果 ${id} segmentId 无效`)
      const key = `${knowledgeId}\0${ref.revision}\0${segmentId}`
      if (keys.has(key)) throw new Error(`结果 ${id} knowledge dependency ref 重复`)
      keys.add(key)
    }
  }
  if (kind === 'gearjob.work-order.observation') {
    exactKeys(result.input, ['workOrderId'], `结果 ${id} 输入`)
    exactKeys(result.payload, ['observationId', 'workOrderId', 'status', 'unit', 'plannedQuantity', 'completedQuantity', 'completion', 'sourceTime', 'queriedAt', 'sourceRecordId', 'sourceRevision', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'explanation', 'dshSessionRef', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity'], `结果 ${id} payload`)
    const workOrderId = requiredText(result.input.workOrderId, `结果 ${id} 工单号无效`)
    if (result.capabilityId !== GEARJOB_CAPABILITY_ID || result.skillId !== GEARJOB_SKILL_ID || result.toolName !== GEARJOB_TOOL_NAME || result.pluginId !== GEARJOB_PLUGIN_ID) throw new Error(`结果 ${id} GearJob 能力来源无效`)
    if (requiredText(result.payload.observationId, `结果 ${id} payload observationId 无效`) !== id) throw new Error(`结果 ${id} 与 observationId 不匹配`)
    if (requiredText(result.payload.workOrderId, `结果 ${id} payload 工单号无效`) !== workOrderId) throw new Error(`结果 ${id} payload 工单号不匹配`)
    requiredText(result.payload.status, `结果 ${id} payload 状态无效`)
    requiredText(result.payload.sourceRecordId, `结果 ${id} payload 来源引用无效`)
    if (requiredText(result.payload.queriedAt, `结果 ${id} payload queriedAt 无效`) !== result.createdAt) throw new Error(`结果 ${id} createdAt 与 queriedAt 不匹配`)
    if (!record(result.payload.completion)) throw new Error(`结果 ${id} payload completion 无效`)
    exactKeys(result.payload.completion, ['ratio', 'overPlan', 'reason'], `结果 ${id} payload completion`)
    if (result.payload.completion.ratio !== undefined && !Number.isFinite(result.payload.completion.ratio)) throw new Error(`结果 ${id} payload completion ratio 无效`)
    if (result.payload.completion.overPlan !== undefined && typeof result.payload.completion.overPlan !== 'boolean') throw new Error(`结果 ${id} payload completion overPlan 无效`)
    if (result.payload.completion.reason !== undefined) requiredText(result.payload.completion.reason, `结果 ${id} payload completion reason 无效`)
    if (result.payload.completion.ratio === undefined && result.payload.completion.reason === undefined) throw new Error(`结果 ${id} payload completion 缺少 ratio 或 reason`)
    for (const key of ['plannedQuantity', 'completedQuantity']) {
      if (result.payload[key] !== undefined && !Number.isFinite(result.payload[key])) throw new Error(`结果 ${id} payload ${key} 无效`)
    }
    for (const key of ['unit', 'sourceTime', 'sourceRevision', 'explanation', 'dshSessionRef', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity', 'evidenceMode']) {
      if (result.payload[key] !== undefined) requiredText(result.payload[key], `结果 ${id} payload ${key} 无效`)
    }
    for (const key of ['explanation', 'dshSessionRef', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity']) {
      if (result.payload[key] !== undefined && result.payload[key] !== result[key]) throw new Error(`结果 ${id} ${key} 与 payload 不匹配`)
    }
    if (!record(result.source)) throw new Error(`结果 ${id} source 无效`)
    exactKeys(result.source, ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime'], `结果 ${id} source`)
    for (const key of ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'sourceRecordId']) {
      const sourceValue = requiredText(result.source[key], `结果 ${id} source ${key} 无效`)
      if (requiredText(result.payload[key], `结果 ${id} payload ${key} 无效`) !== sourceValue) throw new Error(`结果 ${id} source ${key} 与 payload 不匹配`)
    }
    for (const key of ['evidenceMode', 'sourceRevision', 'sourceTime']) {
      if (result.source[key] === undefined && result.payload[key] === undefined) continue
      const sourceValue = requiredText(result.source[key], `结果 ${id} source ${key} 无效`)
      if (requiredText(result.payload[key], `结果 ${id} payload ${key} 无效`) !== sourceValue) throw new Error(`结果 ${id} source ${key} 与 payload 不匹配`)
    }
  }
  if (kind === 'manufacturing.takt') {
    exactKeys(result.input, ['availableSeconds', 'quantity'], `结果 ${id} 输入`)
    exactKeys(result.payload, ['availableSeconds', 'quantity', 'secondsPerUnit', 'unit'], `结果 ${id} payload`)
    if (![result.input.availableSeconds, result.input.quantity, result.payload.availableSeconds, result.payload.quantity, result.payload.secondsPerUnit].every(Number.isFinite)) throw new Error(`结果 ${id} 节拍数值无效`)
    if (result.input.availableSeconds < 0 || result.input.quantity <= 0) throw new Error(`结果 ${id} 节拍输入范围无效`)
    if (result.input.availableSeconds !== result.payload.availableSeconds || result.input.quantity !== result.payload.quantity || result.payload.secondsPerUnit !== result.input.availableSeconds / result.input.quantity || result.payload.unit !== 'seconds/unit') throw new Error(`结果 ${id} 节拍 payload 不匹配`)
    if (result.capabilityId !== CYCLE_CAPABILITY_ID || result.skillId !== CYCLE_SKILL_ID || result.toolName !== CYCLE_TOOL_NAME || result.pluginId !== CYCLE_PLUGIN_ID) throw new Error(`结果 ${id} 节拍能力来源无效`)
    requiredText(result.pluginVersion, `结果 ${id} pluginVersion 无效`)
    if (result.source !== undefined) throw new Error(`结果 ${id} 节拍不得伪造来源`)
    if (result.inputProvenance !== undefined) validateQuantityProvenance(result.inputProvenance, result.input.quantity, `结果 ${id}`)
  } else if (kind === CORRELATION_RESULT_KIND) {
    normalizeCorrelationResult(result, id)
  } else if (result.inputProvenance !== undefined) {
    throw new Error(`结果 ${id} 不得包含输入来源`)
  }
  if ([KIVO_TPM_RESULT_KIND, KIVO_TPM_DEVICE_CORRELATION_KIND].includes(kind)) {
    const capability = getCapability(result.capabilityId)
    if (capability?.resultKind !== kind || result.skillId !== capability.skillId) throw new Error(`结果 ${id} TPM 能力无效`)
    const parsed = parseCapabilityToolResult(capability.id, { ok: true, observation: result.payload }, result.input)
    if (result.toolName !== parsed.toolName || result.pluginId !== parsed.pluginId || result.pluginVersion !== parsed.pluginVersion
      || !isDeepStrictEqual(result.source, parsed.source) || result.createdAt !== parsed.payload.queriedAt) throw new Error(`结果 ${id} TPM 能力来源或时间不匹配`)
  }
  if (kind === 'assistant.follow-up') {
    exactKeys(result.input, ['text'], `结果 ${id} 输入`)
    exactKeys(result.payload, ['text'], `结果 ${id} payload`)
    const followUpText = requiredText(result.payload.text, `结果 ${id} 追问文本无效`)
    if (requiredText(result.input.text, `结果 ${id} 追问输入无效`) !== followUpText) throw new Error(`结果 ${id} 追问输入与 payload 不匹配`)
    if (result.toolName !== undefined || result.pluginId !== undefined || result.pluginVersion !== undefined) throw new Error(`结果 ${id} 追问不得伪造工具来源`)
    if (result.source !== undefined) throw new Error(`结果 ${id} 追问不得伪造业务来源`)
  }
  if (result.pluginVersion !== undefined) requiredText(result.pluginVersion, `结果 ${id} pluginVersion 无效`)
  return result
}

function normalizeCorrelationResult(result, id) {
  exactKeys(result.input, ['workOrderId'], `结果 ${id} 输入`)
  const workOrderId = requiredText(result.input.workOrderId, `结果 ${id} 工单号无效`)
  if (result.capabilityId !== CORRELATION_CAPABILITY_ID || result.skillId !== CORRELATION_SKILL_ID
    || result.toolName !== CORRELATION_TOOL_NAME || result.pluginId !== CORRELATION_PLUGIN_ID) throw new Error(`结果 ${id} 工单设备关联能力来源无效`)
  exactKeys(result.payload, ['workOrderId', 'queriedAt', 'connections', 'gearJob', 'hive', 'mapping', 'tenant', 'device', 'sample', 'status', 'recordId', 'eventId', 'freshness', 'machineFacts', 'unknowns'], `结果 ${id} payload`)
  if (requiredText(result.payload.workOrderId, `结果 ${id} payload 工单号无效`) !== workOrderId) throw new Error(`结果 ${id} payload 工单号不匹配`)
  const queriedAt = isoTimestamp(result.payload.queriedAt, `结果 ${id} queriedAt 无效`)
  if (queriedAt !== result.createdAt) throw new Error(`结果 ${id} createdAt 与 queriedAt 不匹配`)
  const connections = exactRoleMap(result.payload.connections, `结果 ${id} connections`, (value, message) => {
    if (!record(value)) throw new Error(message)
    exactKeys(value, ['id', 'revision'], message)
    const connectionId = requiredText(value.id, message)
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error(message)
    return { id: connectionId, revision: value.revision }
  })
  if (connections.gearJob.id === connections.hive.id) throw new Error(`结果 ${id} 双来源连接不可相同`)
  for (const role of ['gearJob', 'hive']) {
    const source = result.payload[role]
    if (!record(source)) throw new Error(`结果 ${id} ${role} 来源无效`)
    exactKeys(source, ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRevision', 'queriedAt'], `结果 ${id} ${role} 来源`)
    for (const key of ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRevision']) requiredText(source[key], `结果 ${id} ${role} ${key} 无效`)
    const sourceQueriedAt = isoTimestamp(source.queriedAt, `结果 ${id} ${role} queriedAt 无效`)
    if (Date.parse(sourceQueriedAt) > Date.parse(queriedAt)) throw new Error(`结果 ${id} ${role} queriedAt 晚于结果查询时间`)
  }
  if (!record(result.source)) throw new Error(`结果 ${id} source 无效`)
  exactKeys(result.source, ['gearJob', 'hive'], `结果 ${id} source`)
  if (JSON.stringify(result.source.gearJob) !== JSON.stringify(result.payload.gearJob) || JSON.stringify(result.source.hive) !== JSON.stringify(result.payload.hive)) throw new Error(`结果 ${id} source 与 payload 不匹配`)
  const mapping = result.payload.mapping
  if (!record(mapping)) throw new Error(`结果 ${id} mapping 无效`)
  exactKeys(mapping, ['operation', 'workstation', 'mesUnitId', 'hiveUnitId'], `结果 ${id} mapping`)
  for (const key of ['operation', 'workstation', 'mesUnitId', 'hiveUnitId']) requiredText(mapping[key], `结果 ${id} mapping ${key} 无效`)
  if (!record(result.payload.tenant) || Object.keys(result.payload.tenant).length !== 1 || !uuid(requiredText(result.payload.tenant.id, `结果 ${id} tenant 无效`))) throw new Error(`结果 ${id} tenant 无效`)
  if (!record(result.payload.device)) throw new Error(`结果 ${id} device 无效`)
  exactKeys(result.payload.device, ['id', 'code'], `结果 ${id} device`)
  if (!uuid(requiredText(result.payload.device.id, `结果 ${id} device id 无效`)) || requiredText(result.payload.device.code, `结果 ${id} device code 无效`) !== mapping.hiveUnitId) throw new Error(`结果 ${id} device identity 无效`)
  const sample = result.payload.sample
  if (!record(sample)) throw new Error(`结果 ${id} sample 无效`)
  exactKeys(sample, ['ts', 'platformReceivedAt', 'quality'], `结果 ${id} sample`)
  isoTimestamp(sample.ts, `结果 ${id} sample ts 无效`)
  if (sample.platformReceivedAt !== null || sample.quality !== null) throw new Error(`结果 ${id} quality 与 platformReceivedAt 必须保持 unknown`)
  if (!scalar(result.payload.status)) throw new Error(`结果 ${id} status 无效`)
  requiredText(result.payload.recordId, `结果 ${id} recordId 无效`)
  requiredText(result.payload.eventId, `结果 ${id} eventId 无效`)
  const freshness = result.payload.freshness
  if (!record(freshness)) throw new Error(`结果 ${id} freshness 无效`)
  exactKeys(freshness, ['ageSeconds', 'maxAgeSeconds', 'maxFutureSkewSeconds'], `结果 ${id} freshness`)
  if (!Number.isFinite(freshness.ageSeconds) || freshness.maxAgeSeconds !== 120 || freshness.maxFutureSkewSeconds !== 5 || freshness.ageSeconds > 120 || freshness.ageSeconds < -5) throw new Error(`结果 ${id} freshness 无效`)
  if (!record(result.payload.machineFacts)) throw new Error(`结果 ${id} machineFacts 无效`)
  const machineFactKeys = new Set(['mode', 'machine_state', 'is_alive', 'is_online', 'alarm', 'alarm_code'])
  for (const [key, value] of Object.entries(result.payload.machineFacts)) if (!machineFactKeys.has(key) || !machineFactScalar(key, value)) throw new Error(`结果 ${id} machineFacts 无效`)
  if (!Array.isArray(result.payload.unknowns) || new Set(result.payload.unknowns).size !== result.payload.unknowns.length
    || result.payload.unknowns.some(value => !['QUALITY_NOT_PROVIDED', 'PLATFORM_RECEIVED_AT_NOT_PROVIDED'].includes(value))) throw new Error(`结果 ${id} unknowns 无效`)
  if (result.payload.unknowns.length !== 2 || !result.payload.unknowns.includes('QUALITY_NOT_PROVIDED')
    || !result.payload.unknowns.includes('PLATFORM_RECEIVED_AT_NOT_PROVIDED')) throw new Error(`结果 ${id} unknowns 与 sample 不闭合`)
}

function validateExecutionMappingBinding(mappingRevision, mappingIdentity, label) {
  if (mappingRevision === null && mappingIdentity === null) return
  requiredText(mappingRevision, `${label} revision 无效`)
  if (!record(mappingIdentity)) throw new Error(`${label} identity 无效`)
  exactKeys(mappingIdentity, ['operation', 'workstation', 'mesUnitId', 'hiveUnitId'], `${label} identity`)
  if (Object.keys(mappingIdentity).length !== 4) throw new Error(`${label} identity 无效`)
  for (const key of ['operation', 'workstation', 'mesUnitId', 'hiveUnitId']) requiredText(mappingIdentity[key], `${label} ${key} 无效`)
}

function validateQuantityProvenance(value, quantity, label) {
  if (!record(value)) throw new Error(`${label} 输入来源无效`)
  exactKeys(value, ['quantity'], `${label} 输入来源`)
  const source = value.quantity
  if (!record(source)) throw new Error(`${label} 数量来源无效`)
  exactKeys(source, ['kind', 'sourcePlanItemId', 'sourceResultId', 'plannedQuantity', 'completedQuantity'], `${label} 数量来源`)
  if (source.kind !== 'gearjob.remaining-quantity') throw new Error(`${label} 数量来源类型无效`)
  requiredText(source.sourcePlanItemId, `${label} 来源计划项无效`)
  requiredText(source.sourceResultId, `${label} 来源结果无效`)
  if (![source.plannedQuantity, source.completedQuantity].every(Number.isFinite) || source.plannedQuantity - source.completedQuantity !== quantity || quantity <= 0) throw new Error(`${label} 派生数量无效`)
  return source
}

function sameQuantityProvenance(left, right) {
  const a = left?.quantity, b = right?.quantity
  return a?.kind === b?.kind && a?.sourcePlanItemId === b?.sourcePlanItemId && a?.sourceResultId === b?.sourceResultId
    && a?.plannedQuantity === b?.plannedQuantity && a?.completedQuantity === b?.completedQuantity
}

function normalizeUsage(value, label) {
  if (!record(value)) throw new Error(`${label} 无效`)
  exactKeys(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'], label)
  for (const key of Object.keys(value)) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error(`${label} ${key} 无效`)
  return value
}

function boundedInteger(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(message)
  return value
}

function hasPlanCycle(items) {
  const byId = new Map(items.map(item => [item.id, item])), visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((byId.get(id)?.dependsOn ?? []).some(visit)) return true
    visiting.delete(id); visited.add(id); return false
  }
  return items.some(item => visit(item.id))
}

function sameTextArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeKnowledgeRefs(refs, label) {
  if (!Array.isArray(refs)) throw new Error(`${label} 无效`)
  const normalized = refs.map(ref => {
    if (!record(ref)) throw new Error(`${label} 无效`)
    exactKeys(ref, ['knowledgeId', 'revision', 'segmentId'], label)
    return {
      knowledgeId: requiredText(ref.knowledgeId, `${label} knowledgeId 无效`),
      revision: Number.isSafeInteger(ref.revision) && ref.revision > 0 ? ref.revision : (() => { throw new Error(`${label} revision 无效`) })(),
      segmentId: requiredText(ref.segmentId, `${label} segmentId 无效`),
    }
  })
  if (new Set(normalized.map(knowledgeKey)).size !== normalized.length) throw new Error(`${label} 重复`)
  return normalized
}

function stableKnowledgeRefs(refs) {
  if (!Array.isArray(refs)) throw new Error('知识引用 无效')
  return [...new Map(refs.map(ref => normalizeKnowledgeRefs([ref], '知识引用')[0]).map(ref => [knowledgeKey(ref), ref])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, ref]) => ref)
}

function sameKnowledgeRefs(left, right) {
  const a = stableKnowledgeRefs(left).map(knowledgeKey), b = stableKnowledgeRefs(right).map(knowledgeKey)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function knowledgeKey(ref) { return `${ref.knowledgeId}@${ref.revision}#${ref.segmentId}` }

function validCurrentKnowledgeRef(state, ref, memberId, employeeId) {
  const member = state.members.find(item => item.id === memberId && item.enabled === true)
  const employee = state.employees.find(item => item.id === employeeId && item.enabled === true)
  const material = state.knowledgeMaterials.find(item => item.id === ref.knowledgeId && item.status === 'active' && item.revision === ref.revision)
  if (!member || !employee || !member.employeeIds.includes(employee.id) || !material) return false
  const allowed = (material.ownerMemberId === member.id && material.employeeIds.includes(employee.id))
    || (material.sharedMemberIds.includes(member.id) && material.sharedEmployeeIds.includes(employee.id))
  return allowed && segmentKnowledgeBody(material.body).some(segment => segment.segmentId === ref.segmentId)
}

function migrateReservations(value, oldOperatorId) {
  if (!text(oldOperatorId)) return value
  return Object.fromEntries(Object.entries(value).map(([key, reservation]) => [
    key.startsWith(`${oldOperatorId}|`) ? `${ADMIN_MEMBER_ID}${key.slice(oldOperatorId.length)}` : key,
    reservation,
  ]))
}

function migrationTime(works) {
  for (const work of works) {
    const candidate = text(work?.acceptedAt) ?? text(Array.isArray(work?.executions) ? work.executions[0]?.acceptedAt : undefined)
    if (candidate) return candidate
  }
  return '1970-01-01T00:00:00.000Z'
}

function resultTime(value, fallback) {
  return text(value) ?? text(fallback) ?? '1970-01-01T00:00:00.000Z'
}

function legacyArray(value, key) {
  if (!(key in value)) return []
  if (!Array.isArray(value[key])) throw new Error(`旧产品状态 ${key} 必须是数组`)
  return value[key]
}

function nestedArray(value, key) {
  if (!(key in value)) return []
  if (!Array.isArray(value[key])) throw new Error(`${key} 必须是数组`)
  return value[key]
}

function requiredArray(value, key) {
  if (!Array.isArray(value[key])) throw new Error(`产品状态 ${key} 必须是数组`)
  return value[key]
}

function entityArray(value, key, label) {
  const items = requiredArray(value, key)
  for (const item of items) {
    if (!record(item)) throw new Error(`${label}状态无效`)
    requiredText(item.id, `${label} ID 无效`)
  }
  uniqueIds(items, label)
  return items
}

function legacyObject(value, key) {
  if (!(key in value)) return {}
  if (!record(value[key])) throw new Error(`旧产品状态 ${key} 必须是对象`)
  return value[key]
}

function requiredObject(value, key) {
  if (!record(value[key])) throw new Error(`产品状态 ${key} 必须是对象`)
  return value[key]
}

function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredText(value, message) {
  const result = text(value)
  if (!result) throw new Error(message)
  return result
}

function requiredRawText(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

function nullableId(value, label) { return value === null ? null : requiredText(value, `${label} 无效`) }
function hexDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}
function safeCode(value, label) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}
function secretRef(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}
function officialId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} 无效`)
  return value
}

function exactRoleMap(value, label, normalize) {
  if (!record(value)) throw new Error(`${label} 无效`)
  exactKeys(value, ['gearJob', 'hive'], label)
  if (!Object.hasOwn(value, 'gearJob') || !Object.hasOwn(value, 'hive')) throw new Error(`${label} 无效`)
  return { gearJob: normalize(value.gearJob, `${label} gearJob 无效`), hive: normalize(value.hive, `${label} hive 无效`) }
}

function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function scalar(value) { return typeof value === 'string' && Boolean(value.trim()) || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' }
function machineFactScalar(key, value) {
  if (typeof value === 'string') return !/[\u0000-\u001f\u007f]/.test(value) && (Boolean(value.trim()) || key === 'alarm_code' && value === '')
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
}

function uniqueIds(items, label) {
  const ids = items.map(item => requiredText(item.id, `${label} ID 无效`))
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ID 重复`)
}

function uniqueTextArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  const items = value.map(item => requiredText(item, `${label} 无效`))
  if (new Set(items).size !== items.length) throw new Error(`${label} 重复`)
  return items
}

function exactKeys(value, allowed, label) {
  const expected = new Set(allowed)
  const unexpected = Object.keys(value).find(key => !expected.has(key))
  if (unexpected) throw new Error(`${label}包含未声明字段 ${unexpected}`)
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
