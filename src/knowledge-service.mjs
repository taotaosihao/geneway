import { randomUUID } from 'node:crypto'
import { KNOWLEDGE_LIMITS } from './store/file-store.mjs'
import { searchKnowledgeMaterials, segmentKnowledgeBody } from './knowledge-search.mjs'

export class KnowledgeServiceError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function createKnowledgeService({ store, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!store) throw new Error('store is required')

  return {
    async listMaterials(actor, { employeeId } = {}) {
      const state = await store.read()
      const member = requireMember(state, actor)
      return state.knowledgeMaterials.flatMap(material => {
        const projected = projectKnowledgeMaterial(state, material, {
          memberId: member.id,
          employeeId,
          mode: material.ownerMemberId === member.id ? 'manage' : 'use',
        })
        return projected ? [projected] : []
      })
    },

    async getMaterial(actor, id, { employeeId } = {}) {
      const state = await store.read()
      const member = requireMember(state, actor)
      const material = state.knowledgeMaterials.find(item => item.id === id)
      const projected = material && projectKnowledgeMaterial(state, material, {
        memberId: member.id,
        employeeId,
        mode: material.ownerMemberId === member.id ? 'manage' : 'use',
        includeBody: true,
      })
      if (!projected) notFound()
      return projected
    },

    async readMaterial(actor, id, { employeeId, revision } = {}) {
      const state = await store.read()
      const member = requireMember(state, actor)
      const material = state.knowledgeMaterials.find(item => item.id === id)
      const projected = material && projectKnowledgeMaterial(state, material, { memberId: member.id, employeeId, mode: 'use', includeBody: true })
      if (!projected || (revision !== undefined && projected.revision !== revision)) notFound()
      return projected
    },

    async resolveReference(actor, { employeeId, knowledgeId, revision, segmentId } = {}) {
      const state = await store.read()
      const member = requireMember(state, actor)
      const material = state.knowledgeMaterials.find(item => item.id === knowledgeId)
      if (!material || currentKnowledgeAccess(state, material, { memberId: member.id, employeeId, purpose: 'use' }) !== 'use' || material.revision !== revision) notFound()
      const segment = segmentKnowledgeBody(material.body).find(item => item.segmentId === segmentId)
      if (!segment) notFound()
      return { knowledgeId: material.id, revision, segmentId, title: material.title, source: material.sourceLabel, text: segment.text }
    },

    async createMaterial(actor, input = {}) {
      let created
      await store.update(state => {
        const member = requireMember(state, actor)
        exactInput(input, ['employeeIds', 'sharedMemberIds', 'sharedEmployeeIds', 'title', 'body', 'format', 'sourceLabel', 'authorizationBasis'])
        const fields = materialFields(state, member, input)
        const now = clock()
        created = {
          id: `knowledge-${idFactory()}`,
          ownerMemberId: member.id,
          ...fields,
          revision: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        }
        assertCapacity(state.knowledgeMaterials, created)
        return { ...state, knowledgeMaterials: [...state.knowledgeMaterials, created] }
      })
      return manageDto(created, true)
    },

    async updateMaterial(actor, id, input = {}) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor)
        exactInput(input, ['expectedRevision', 'employeeIds', 'title', 'body', 'format', 'sourceLabel', 'authorizationBasis'])
        const material = ownedActiveMaterial(state, member, id)
        requireRevision(material, input.expectedRevision)
        const fields = {
          employeeIds: input.employeeIds === undefined ? material.employeeIds : privateEmployees(state, member, input.employeeIds),
          sharedMemberIds: material.sharedMemberIds,
          sharedEmployeeIds: material.sharedEmployeeIds,
          title: input.title === undefined ? material.title : validText(input.title, '标题', KNOWLEDGE_LIMITS.maxTitleCharacters),
          body: input.body === undefined ? material.body : validBody(input.body),
          format: input.format === undefined ? material.format : validFormat(input.format),
          sourceLabel: input.sourceLabel === undefined ? material.sourceLabel : validText(input.sourceLabel, '来源', KNOWLEDGE_LIMITS.maxSourceCharacters),
          authorizationBasis: input.authorizationBasis === undefined ? material.authorizationBasis : validText(input.authorizationBasis, '授权依据', KNOWLEDGE_LIMITS.maxAuthorizationCharacters),
        }
        updated = { ...material, ...fields, revision: material.revision + 1, updatedAt: clock() }
        assertCapacity(state.knowledgeMaterials, updated, material.id)
        return sweepKnowledgeDependencies({ ...state, knowledgeMaterials: replaceById(state.knowledgeMaterials, updated) })
      })
      return manageDto(updated, true)
    },

    async updateSharing(actor, id, input = {}) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor)
        exactInput(input, ['expectedRevision', 'memberIds', 'employeeIds'])
        const material = ownedActiveMaterial(state, member, id)
        requireRevision(material, input.expectedRevision)
        const sharing = validateSharing(state, input.memberIds, input.employeeIds)
        updated = {
          ...material,
          sharedMemberIds: sharing.memberIds,
          sharedEmployeeIds: sharing.employeeIds,
          revision: material.revision + 1,
          updatedAt: clock(),
        }
        assertCapacity(state.knowledgeMaterials, updated, material.id)
        return sweepKnowledgeDependencies({ ...state, knowledgeMaterials: replaceById(state.knowledgeMaterials, updated) })
      })
      return manageDto(updated, true)
    },

    async deleteMaterial(actor, id, input = {}) {
      let deleted
      await store.update(state => {
        const member = requireMember(state, actor)
        exactInput(input, ['expectedRevision'])
        const material = state.knowledgeMaterials.find(item => item.id === id && item.ownerMemberId === member.id)
        if (!material) notFound()
        requireRevision(material, input.expectedRevision)
        if (material.status === 'deleted') { deleted = material; return state }
        const now = clock()
        deleted = {
          id: material.id,
          ownerMemberId: material.ownerMemberId,
          revision: material.revision + 1,
          status: 'deleted',
          createdAt: material.createdAt,
          updatedAt: now,
          deletedAt: now,
        }
        return sweepKnowledgeDependencies({ ...state, knowledgeMaterials: replaceById(state.knowledgeMaterials, deleted) })
      })
      return tombstoneDto(deleted)
    },

    async search(actor, { employeeId, query } = {}) {
      const state = await store.read()
      const member = requireMember(state, actor)
      requireEmployee(state, member, employeeId)
      const normalizedQuery = validQuery(query)
      try {
        return searchKnowledgeMaterials(
          state.knowledgeMaterials.filter(material => canUseKnowledgeMaterial(state, material, member.id, employeeId)),
          normalizedQuery,
        )
      } catch (error) {
        if (error?.code === 'TOO_MANY_QUERY_TERMS') invalid(error.message)
        throw error
      }
    },
  }
}

export function currentKnowledgeAccess(state, material, { memberId, employeeId, purpose = 'use' } = {}) {
  const member = state.members.find(item => item.id === memberId && item.enabled === true)
  if (!material || !member) return 'none'
  if (purpose === 'manage') return material.ownerMemberId === member.id ? 'manage' : 'none'
  if (purpose !== 'use' || material.status !== 'active') return 'none'
  const employee = state.employees.find(item => item.id === employeeId && item.enabled === true)
  if (!employee || !member.employeeIds.includes(employee.id)) return 'none'
  return (material.ownerMemberId === member.id && material.employeeIds.includes(employee.id))
    || (material.sharedMemberIds.includes(member.id) && material.sharedEmployeeIds.includes(employee.id)) ? 'use' : 'none'
}

export function canUseKnowledgeMaterial(state, material, memberId, employeeId) {
  return currentKnowledgeAccess(state, material, { memberId, employeeId, purpose: 'use' }) === 'use'
}

export function canManageKnowledgeMaterial(state, material, memberId) {
  return currentKnowledgeAccess(state, material, { memberId, purpose: 'manage' }) === 'manage'
}

export function projectKnowledgeMaterial(state, material, { memberId, employeeId, mode = 'use', includeBody = false } = {}) {
  const access = currentKnowledgeAccess(state, material, { memberId, employeeId, purpose: mode })
  if (access === 'none') return undefined
  if (material.status === 'deleted') return tombstoneDto(material)
  if (access === 'manage') return manageDto(material, includeBody)
  return useDto(material, includeBody)
}

export function currentKnowledgeReference(state, ref, memberId, employeeId) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return undefined
  const material = state.knowledgeMaterials.find(item => item.id === ref.knowledgeId)
  if (!material || material.revision !== ref.revision || currentKnowledgeAccess(state, material, { memberId, employeeId }) !== 'use') return undefined
  const segment = segmentKnowledgeBody(material.body).find(item => item.segmentId === ref.segmentId)
  return segment ? { knowledgeId: material.id, revision: material.revision, segmentId: segment.segmentId } : undefined
}

export function stableKnowledgeRefs(refs = []) {
  const keyed = new Map()
  for (const ref of refs) {
    const normalized = ref && { knowledgeId: ref.knowledgeId, revision: ref.revision, segmentId: ref.segmentId }
    if (typeof normalized?.knowledgeId !== 'string' || !Number.isSafeInteger(normalized.revision) || typeof normalized.segmentId !== 'string') continue
    keyed.set(knowledgeRefKey(normalized), normalized)
  }
  return [...keyed.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, ref]) => ref)
}

export function sweepKnowledgeDependencies(state) {
  const works = state.works.map(work => {
    if (!work.collaboration || !['completed', 'stale'].includes(work.collaboration.status)) return work
    const invalidItems = [], invalidRefs = []
    for (const item of work.plan.items) {
      const handoff = work.handoffs.find(value => value.childWorkId === item.childWorkId && value.status === 'current')
      const child = state.works.find(value => value.id === item.childWorkId)
      const refs = handoff?.knowledgeRefs ?? []
      const invalid = refs.filter(ref => !currentKnowledgeReference(state, ref, work.ownerMemberId, child?.employeeId)
        || !currentKnowledgeReference(state, ref, work.ownerMemberId, work.employeeId))
      if (invalid.length) {
        invalidItems.push(item.id)
        invalidRefs.push(...invalid)
      }
    }
    if (!invalidItems.length) return work.collaboration.status === 'stale'
      ? { ...work, collaboration: { ...work.collaboration, status: 'completed', staleItemIds: [], staleKnowledgeRefs: [] } }
      : work
    return {
      ...work,
      collaboration: {
        ...work.collaboration,
        status: 'stale',
        staleItemIds: [...new Set(invalidItems)].sort(),
        staleKnowledgeRefs: stableKnowledgeRefs(invalidRefs).map(knowledgeRefKey),
      },
    }
  })
  return { ...state, works }
}

export function knowledgeRefKey(ref) { return `${ref.knowledgeId}@${ref.revision}#${ref.segmentId}` }

function materialFields(state, member, input) {
  const sharing = validateSharing(state, input.sharedMemberIds ?? [], input.sharedEmployeeIds ?? [])
  return {
    employeeIds: privateEmployees(state, member, input.employeeIds),
    sharedMemberIds: sharing.memberIds,
    sharedEmployeeIds: sharing.employeeIds,
    title: validText(input.title, '标题', KNOWLEDGE_LIMITS.maxTitleCharacters),
    body: validBody(input.body),
    format: validFormat(input.format),
    sourceLabel: validText(input.sourceLabel, '来源', KNOWLEDGE_LIMITS.maxSourceCharacters),
    authorizationBasis: validText(input.authorizationBasis, '授权依据', KNOWLEDGE_LIMITS.maxAuthorizationCharacters),
  }
}

function privateEmployees(state, member, value) {
  const employeeIds = uniqueIds(value, '员工范围')
  for (const id of employeeIds) requireEmployee(state, member, id)
  return employeeIds
}

function validateSharing(state, memberIdsValue, employeeIdsValue) {
  const memberIds = uniqueIds(memberIdsValue, '共享成员范围', true)
  const employeeIds = uniqueIds(employeeIdsValue, '共享员工范围', true)
  if (Boolean(memberIds.length) !== Boolean(employeeIds.length)) invalid('共享成员与员工必须同时设置')
  for (const id of memberIds) {
    if (!state.members.some(item => item.id === id && item.enabled === true)) invalid('共享成员无效')
  }
  for (const id of employeeIds) {
    if (!state.employees.some(item => item.id === id && item.enabled === true)) invalid('共享员工无效')
  }
  return { memberIds, employeeIds }
}

function assertCapacity(materials, candidate, replacingId) {
  const active = materials.filter(item => item.status === 'active' && item.id !== replacingId)
  if (active.length >= KNOWLEDGE_LIMITS.maxMaterials) capacity('知识材料数量已达上限')
  const total = active.reduce((sum, item) => sum + Buffer.byteLength(item.body, 'utf8'), 0) + Buffer.byteLength(candidate.body, 'utf8')
  if (total > KNOWLEDGE_LIMITS.maxTotalBodyBytes) capacity('知识正文总容量已达上限')
}

function validBody(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) invalid('正文必须是 UTF-8 文本')
  if (Buffer.byteLength(value, 'utf8') > KNOWLEDGE_LIMITS.maxBodyBytes) capacity('单份知识正文不能超过 32 KiB')
  return value
}

function validText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) invalid(`${label}无效`)
  const result = value.trim()
  if (Array.from(result).length > maximum) invalid(`${label}过长`)
  return result
}

function validQuery(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) invalid('检索内容无效')
  if (Array.from(value).length > 256) invalid('检索内容过长')
  return value.trim()
}

function validFormat(value) {
  const format = value ?? 'text'
  if (!['text', 'markdown'].includes(format)) invalid('仅支持 UTF-8 文本或 Markdown 文本')
  return format
}

function uniqueIds(value, label, allowEmpty = false) {
  if (!Array.isArray(value)) invalid(`${label}必须是数组`)
  const ids = value.map(item => validText(item, label, 200))
  if (!allowEmpty && !ids.length) invalid(`${label}不能为空`)
  if (new Set(ids).size !== ids.length) invalid(`${label}不能重复`)
  return ids
}

function requireMember(state, actor) {
  const member = state.members.find(item => item.id === actor?.id && item.enabled === true)
  if (!member) throw new KnowledgeServiceError('UNAUTHORIZED', '成员身份无效', 401)
  return member
}

function requireEmployee(state, member, employeeId) {
  const employee = state.employees.find(item => item.id === employeeId && item.enabled === true && member.employeeIds.includes(item.id))
  if (!employee) throw new KnowledgeServiceError('FORBIDDEN', '员工未获准', 403)
  return employee
}

function ownedActiveMaterial(state, member, id) {
  const material = state.knowledgeMaterials.find(item => item.id === id && item.ownerMemberId === member.id && item.status === 'active')
  if (!material) notFound()
  return material
}

function requireRevision(material, value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid('expectedRevision 无效')
  if (value !== material.revision) throw new KnowledgeServiceError('REVISION_CONFLICT', '知识已被其他操作更新', 409)
}

function exactInput(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求参数无效')
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) invalid(`请求包含未声明字段 ${unexpected}`)
}

function manageDto(material, includeBody) {
  return {
    id: material.id,
    ownerMemberId: material.ownerMemberId,
    employeeIds: [...material.employeeIds],
    sharedMemberIds: [...material.sharedMemberIds],
    sharedEmployeeIds: [...material.sharedEmployeeIds],
    title: material.title,
    ...(includeBody ? { body: material.body } : {}),
    format: material.format,
    sourceLabel: material.sourceLabel,
    authorizationBasis: material.authorizationBasis,
    revision: material.revision,
    status: material.status,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
  }
}

function useDto(material, includeBody) {
  return {
    id: material.id,
    title: material.title,
    ...(includeBody ? { body: material.body } : {}),
    format: material.format,
    sourceLabel: material.sourceLabel,
    revision: material.revision,
    status: material.status,
  }
}

function tombstoneDto(material) {
  return {
    id: material.id,
    ownerMemberId: material.ownerMemberId,
    revision: material.revision,
    status: material.status,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    deletedAt: material.deletedAt,
  }
}

function replaceById(items, value) {
  return items.map(item => item.id === value.id ? value : item)
}

function invalid(message) {
  throw new KnowledgeServiceError('INVALID_REQUEST', message, 400)
}

function capacity(message) {
  throw new KnowledgeServiceError('CAPACITY_EXCEEDED', message, 400)
}

function notFound() {
  throw new KnowledgeServiceError('NOT_FOUND', '知识不存在', 404)
}
