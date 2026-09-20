import { randomUUID } from 'node:crypto'
import { assertTrustedConnection } from './connection-catalog.mjs'
import { validateCapabilityInput } from './capabilities.mjs'

const CAPABILITY_ID = 'gearjob-work-order-read'
const MODEL_PROVIDER = 'zenmux'
const MODEL_ID = 'deepseek/deepseek-v4-pro'
const MODEL_CREDENTIAL = 'ZENMUX_API_KEY'
const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000

export class AutomationServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AutomationServiceError'
    this.code = code
  }
}

export function createAutomationService({ store, clock = () => new Date().toISOString(), idFactory = randomUUID, connectionCatalog = [] } = {}) {
  if (!store?.read || !store?.update) throw new TypeError('automation service 需要 store')

  return {
    async listRules(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      return state.automationRules.filter(rule => rule.ownerMemberId === member.id).map(rule => projectRule(state, rule, clock()))
    },

    async getRule(actor, id) {
      const state = await store.read(), member = requireMember(state, actor)
      const rule = ownedRule(state, member, id)
      return projectRule(state, rule, clock())
    },

    async createRule(actor, input = {}) {
      let created
      await store.update(state => {
        const member = requireMember(state, actor)
        exactInput(input, ['employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        const fields = ruleFields(state, member, input, connectionCatalog)
        const now = timestamp(clock())
        created = {
          id: `automation-${idFactory()}`,
          ownerMemberId: member.id,
          revision: 1,
          status: 'draft',
          ...fields,
          effectiveFrom: null,
          eventAcceptAfter: null,
          createdAt: now,
          updatedAt: now,
          revokedAt: null,
        }
        return { ...state, automationRules: [...state.automationRules, created] }
      })
      return projectRule(await store.read(), created, clock())
    },

    async updateRule(actor, id, input = {}) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor), rule = ownedRule(state, member, id)
        exactInput(input, ['expectedRevision', 'employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        requireRevision(rule, input.expectedRevision)
        if (rule.status === 'revoked') throw serviceError('INVALID_STATE', '已撤销规则不可修改')
        const fields = ruleFields(state, member, { ...rule, ...input }, connectionCatalog)
        const usedRuns = deriveUsedRuns(rule, state.automationOccurrences)
        if (fields.maxRuns < usedRuns) throw serviceError('INVALID_REQUEST', '累计预算不能低于已使用次数')
        const now = timestamp(clock())
        updated = {
          ...rule,
          ...fields,
          revision: rule.revision + 1,
          updatedAt: now,
          effectiveFrom: rule.status === 'active' ? now : rule.effectiveFrom,
          eventAcceptAfter: null,
        }
        return { ...state, automationRules: replaceById(state.automationRules, updated) }
      })
      return projectRule(await store.read(), updated, clock())
    },

    async enableRule(actor, id, input = {}) {
      return transition(actor, id, input, 'draft', 'active')
    },

    async pauseRule(actor, id, input = {}) {
      return transition(actor, id, input, 'active', 'paused')
    },

    async resumeRule(actor, id, input = {}) {
      return transition(actor, id, input, 'paused', 'active')
    },

    async revokeRule(actor, id, input = {}) {
      let revoked
      await store.update(state => {
        const member = requireMember(state, actor), rule = ownedRule(state, member, id)
        exactInput(input, ['expectedRevision'])
        requireRevision(rule, input?.expectedRevision)
        if (!['draft', 'active', 'paused'].includes(rule.status)) throw serviceError('INVALID_STATE', '规则当前不可撤销')
        const now = timestamp(clock())
        revoked = { ...rule, status: 'revoked', revision: rule.revision + 1, updatedAt: now, revokedAt: now, eventAcceptAfter: null }
        return { ...state, automationRules: replaceById(state.automationRules, revoked) }
      })
      return projectRule(await store.read(), revoked, clock())
    },
  }

  async function transition(actor, id, input, from, to) {
    let updated
    await store.update(state => {
      const member = requireMember(state, actor), rule = ownedRule(state, member, id)
      const enteringActive = to === 'active'
      exactInput(input, ['expectedRevision'])
      requireRevision(rule, input?.expectedRevision)
      if (rule.status !== from) throw serviceError('INVALID_STATE', `规则只能从 ${from} 转为 ${to}`)
      if (enteringActive) {
        normalizeTrigger(rule.trigger)
        validateBinding(state, member, rule, connectionCatalog)
      }
      if (enteringActive && deriveUsedRuns(rule, state.automationOccurrences) >= rule.maxRuns) throw serviceError('BUDGET_EXHAUSTED', '规则累计预算已用尽')
      const now = timestamp(clock())
      updated = { ...rule, status: to, revision: rule.revision + 1, updatedAt: now, effectiveFrom: enteringActive ? now : rule.effectiveFrom }
      return { ...state, automationRules: replaceById(state.automationRules, updated) }
    })
    return projectRule(await store.read(), updated, clock())
  }
}

export function dailyOccurrenceKey(ruleId, scheduledDate) {
  const id = text(ruleId), date = text(scheduledDate)
  if (!id || !date || !isDateOnly(date)) throw new TypeError('daily occurrence key 参数无效')
  return `${id}:${date}`
}

export function deriveUsedRuns(rule, occurrences = []) {
  return occurrences.filter(item => item?.ruleId === rule?.id && text(item.workId)).length
}

export function nextDailyOccurrence(rule, now, occurrences = []) {
  if (!rule || rule.status !== 'active' || deriveUsedRuns(rule, occurrences) >= rule.maxRuns) return null
  if (!rule.effectiveFrom) return null
  const current = parseInstant(now), effective = parseInstant(rule.effectiveFrom)
  if (!current || !effective) return null
  const threshold = new Date(Math.max(current.getTime(), effective.getTime()))
  const localThreshold = shifted(threshold)
  for (let offset = 0; offset < 2; offset += 1) {
    const localDate = dateOnly(new Date(localThreshold.getTime() + offset * 86_400_000))
    const candidate = localDateTime(localDate, rule.trigger.time)
    if (candidate.getTime() < threshold.getTime()) continue
    if (occurrences.some(item => item?.ruleId === rule.id && item.scheduledDate === localDate)) continue
    return candidate.toISOString()
  }
  return null
}

function projectRule(state, rule, now) {
  if (!rule) throw serviceError('NOT_FOUND', '自动规则不存在')
  return { ...structuredClone(rule), usedRuns: deriveUsedRuns(rule, state.automationOccurrences), nextDueAt: nextDailyOccurrence(rule, now, state.automationOccurrences) }
}

function ruleFields(state, member, input, connectionCatalog) {
  const trigger = normalizeTrigger(input.trigger)
  const maxRuns = input.maxRuns === undefined ? 10 : input.maxRuns
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 10) throw serviceError('INVALID_REQUEST', '累计预算必须是 1 至 10 的整数')
  const fields = {
    employeeId: required(input.employeeId, 'employeeId'),
    skillId: required(input.skillId, 'skillId'),
    connectionId: required(input.connectionId, 'connectionId'),
    workOrderId: required(input.workOrderId, 'workOrderId'),
    trigger,
    maxRuns,
    notificationConversationId: input.notificationConversationId === undefined ? null : nullableText(input.notificationConversationId),
  }
  validateBinding(state, member, fields, connectionCatalog)
  validateNotification(state, member, fields.notificationConversationId)
  return fields
}

function validateBinding(state, member, value, connectionCatalog) {
  if (!member?.enabled || !member.employeeIds?.includes(value.employeeId)) throw serviceError('FORBIDDEN', '成员未获准使用该员工')
  const employee = state.employees.find(item => item.id === value.employeeId && item.enabled === true)
  const skill = state.skills.find(item => item.id === value.skillId && item.enabled === true && item.capabilityId === CAPABILITY_ID && employee?.skillIds?.includes(item.id))
  const route = state.modelRoutes.find(item => item.id === employee?.modelRouteId && item.enabled === true && item.provider === MODEL_PROVIDER && item.model === MODEL_ID && item.credentialRef === MODEL_CREDENTIAL)
  const connection = state.connections.find(item => item.id === value.connectionId && item.enabled === true && item.status === 'ready' && item.kind === 'gearjob-rest'
    && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id) && item.allowedObjectIds?.includes(value.workOrderId))
  if (!employee || !skill || !route || !connection) throw serviceError('FORBIDDEN', '自动规则绑定未获准或当前不可用')
  try { assertTrustedConnection(connectionCatalog, connection) } catch { throw serviceError('FORBIDDEN', '连接目标未在主机可信目录登记') }
  const parsed = validateCapabilityInput(CAPABILITY_ID, { workOrderId: value.workOrderId })
  if (!parsed.ok) throw serviceError(parsed.error.code, parsed.error.message)
  return { employee, skill, route, connection }
}

function validateNotification(state, member, id) {
  if (id === null) return
  const conversation = state.channelConversations.find(item => item.id === id)
  const identity = conversation && state.channelIdentities.find(item => item.id === conversation.identityId)
  const app = conversation && state.channelApps.find(item => item.id === conversation.channelAppId)
  if (!conversation || conversation.type !== 'private' || conversation.memberId !== member.id || conversation.status !== 'active'
    || !identity || identity.status !== 'active' || identity.id !== conversation.identityId || identity.memberId !== member.id || identity.channelAppId !== conversation.channelAppId
    || !app || app.enabled !== true || app.status !== 'active' || app.id !== conversation.channelAppId) throw serviceError('FORBIDDEN', '通知会话必须是本人已验证私聊')
}

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw serviceError('INVALID_REQUEST', 'trigger 无效')
  if (typeof trigger.kind !== 'string' || !trigger.kind.trim()) throw serviceError('INVALID_REQUEST', 'trigger kind 无效')
  if (trigger.kind !== 'daily-time') throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源暂不可用')
  if (Object.keys(trigger).sort().join(',') !== 'kind,time,timeZone') throw serviceError('INVALID_REQUEST', 'trigger 字段无效')
  if (typeof trigger.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) || trigger.timeZone !== 'Asia/Shanghai') throw serviceError('INVALID_REQUEST', '每日触发时间无效')
  return { kind: trigger.kind, time: trigger.time, timeZone: trigger.timeZone }
}

function ownedRule(state, member, id) {
  const rule = state.automationRules.find(item => item.id === text(id) && item.ownerMemberId === member.id)
  if (!rule) throw serviceError('NOT_FOUND', '自动规则不存在')
  return rule
}

function requireMember(state, actor) {
  const id = typeof actor === 'string' ? actor : actor?.id ?? actor?.memberId
  const member = state.members.find(item => item.id === text(id) && item.enabled === true)
  if (!member) throw serviceError('UNAUTHORIZED', '会话无效')
  return member
}

function requireRevision(rule, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== rule.revision) throw serviceError('REVISION_CONFLICT', '自动规则 revision 已变化')
}

function exactInput(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw serviceError('INVALID_REQUEST', '请求参数无效')
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) throw serviceError('INVALID_REQUEST', `请求包含未声明字段 ${unexpected}`)
}

function replaceById(items, value) { return items.map(item => item.id === value.id ? value : item) }
function timestamp(value) { const result = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : ''; if (!result) throw serviceError('INTERNAL_ERROR', '时钟无效'); return result }
function required(value, label) { const result = text(value); if (!result) throw serviceError('INVALID_REQUEST', `${label} 无效`); return result }
function nullableText(value) { if (value === null) return null; return required(value, 'notificationConversationId') }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function serviceError(code, message) { return new AutomationServiceError(code, message) }
function parseInstant(value) { const time = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return time && Number.isFinite(time.getTime()) ? time : null }
function shifted(date) { return new Date(date.getTime() + ZONE_OFFSET_MS) }
function dateOnly(date) { return date.toISOString().slice(0, 10) }
function localDateTime(localDate, time) { return new Date(Date.parse(`${localDate}T${time}:00.000Z`) - ZONE_OFFSET_MS) }
function isDateOnly(value) { if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return date.toISOString().slice(0, 10) === value }
