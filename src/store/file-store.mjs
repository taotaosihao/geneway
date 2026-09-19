import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 5
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
const RESULT_KINDS = new Set(['gearjob.work-order.observation', 'manufacturing.takt', 'assistant.follow-up'])

const EMPTY_STATE = {
  version: STATE_VERSION,
  members: [],
  modelRoutes: [],
  employees: [],
  connections: [],
  skills: [],
  confirmations: [],
  knowledgeMaterials: [],
  works: [],
  reservations: {},
}

export function createFileStore(filePath) {
  let pending = Promise.resolve()

  return {
    async read() {
      try {
        return migrateState(JSON.parse(await readFile(filePath, 'utf8')))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return structuredClone(EMPTY_STATE)
      }
    },

    update(mutator) {
      const operation = pending.then(async () => {
        const current = await this.read()
        const next = migrateState(await mutator(current))
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        const fileName = filePath.split('/').pop()
        const tempPath = join(dirname(filePath), `.${fileName}.${process.pid}.tmp`)
        await writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
        await rename(tempPath, filePath)
        return next
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
}

export function migrateState(value) {
  if (!record(value)) throw new Error('产品状态不是对象')
  if (value.version !== undefined && !Number.isInteger(value.version)) throw new Error('产品状态版本无效')
  const version = value.version ?? 3
  if (version > STATE_VERSION) throw new Error(`不支持未来产品状态版本：${version}`)
  if (version === STATE_VERSION) return normalizeV5(value)
  if (version === 4) return migrateV4(value)
  if (version === 3) return migrateV4(migrateV3(value))
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
  return normalizeV5({ ...normalizeV4(value), version: STATE_VERSION, knowledgeMaterials: [] })
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
  const employees = entityArray(value, 'employees', '员工')
  const connections = entityArray(value, 'connections', '连接')
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
    }
  }

  return { ...common, version: STATE_VERSION, knowledgeMaterials }
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
  exactKeys(result, ['id', 'kind', 'capabilityId', 'skillId', 'schemaVersion', 'input', 'payload', 'explanation', 'source', 'createdAt', 'toolName', 'pluginId', 'pluginVersion', 'dshSessionRef', 'continuedFromDshSessionRef', 'contextObservationId', 'continuity', 'contextConfirmationRefs', ...(allowKnowledgeDependencyRefs ? ['knowledgeDependencyRefs'] : [])], '结果')
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
