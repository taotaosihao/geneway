import { createHash, randomUUID } from 'node:crypto'
import { readRuntimeConfig } from './runtime-config.mjs'

const ACTIVE = new Set(['accepted', 'running'])
const MODEL = readRuntimeConfig({}).model
const ERRORS = Object.freeze({
  FORBIDDEN: 'Agent 授权已失效',
  MODEL_NOT_CONFIGURED: '模型路由不可用',
  HISTORY_UNAVAILABLE: '历史记录暂时不可用',
  UPSTREAM_ERROR: '本次回复未能完成',
  UPSTREAM_TIMEOUT: '本次回复超时',
  CANCELLED: '本次回复已停止',
  PROCESS_RESTARTED: '进程重启时回复未完成',
  PROCESS_SHUTDOWN: '进程关闭时回复未完成',
  BACKUP_INTERRUPTED: '备份时回复未完成',
})

export function createConversationService({ store, runner, clock = () => new Date().toISOString(), onError = () => undefined } = {}) {
  if (!store || !runner) throw new Error('conversation store and runner are required')
  const active = new Map(), admissions = new Set()
  let recovery, closed = false

  const service = {
    ensureReady() {
      if (!recovery) recovery = store.update(state => ({
        ...state,
        conversations: conversations(state).map(conversation => {
          if (!currentTurn(conversation)) return conversation
          const now = clock()
          return { ...conversation, updatedAt: now, turns: conversation.turns.map(turn => ACTIVE.has(turn.status) ? {
            ...turn, status: 'interrupted', completedAt: now, error: publicError({ code: 'PROCESS_RESTARTED' }),
          } : turn) }
        }),
      }))
      return recovery
    },

    async listConversations(actor, { includeArchived = false } = {}) {
      await service.ensureReady()
      if (typeof includeArchived !== 'boolean') throw error('INVALID_REQUEST', '归档筛选无效')
      const state = await store.read(), member = requireMember(state, actor)
      const owned = conversations(state).filter(item => item.ownerMemberId === member.id && (includeArchived || !item.archivedAt))
      const history = await loadHistory(owned)
      requireMember(await store.read(), actor)
      return owned.map(item => summary(state, member, item, history)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async createConversation(actor, body = {}) {
      await service.ensureReady()
      assertOpen()
      fields(body, ['employeeId', 'title'])
      const employeeId = requiredText(body.employeeId, 200, 'Agent 无效')
      const title = body.title === undefined ? '新对话' : requiredText(body.title, 200, '对话标题无效')
      const id = `conversation-${randomUUID()}`, now = clock()
      const state = await store.update(state => {
        assertOpen()
        const member = requireMember(state, actor), employee = state.employees.find(item => item.id === employeeId)
        requireEmployee(state, member, employee)
        return { ...state, conversations: [...conversations(state), {
          id, ownerMemberId: member.id, employeeId, employeeName: employee.name, title,
          source: 'web', channelIdentityId: null, createdAt: now, updatedAt: now, archivedAt: null,
          sessions: [], turns: [],
        }] }
      })
      return detail(state, requireMember(state, actor), findOwned(state, actor, id), new Map())
    },

    async getConversation(actor, id) {
      await service.ensureReady()
      const state = await store.read(), member = requireMember(state, actor), conversation = findOwned(state, member, id)
      const history = await loadHistory([conversation])
      requireMember(await store.read(), actor)
      return detail(state, member, conversation, history)
    },

    async updateConversation(actor, id, body = {}) {
      await service.ensureReady()
      assertOpen()
      fields(body, ['title', 'archived'])
      if (Object.keys(body).length !== 1 || (Object.hasOwn(body, 'archived') && body.archived !== true)) throw error('INVALID_REQUEST', '只支持改名或归档对话')
      const title = Object.hasOwn(body, 'title') ? requiredText(body.title, 200, '对话标题无效') : undefined
      await store.update(state => {
        assertOpen()
        const member = requireMember(state, actor), conversation = findOwned(state, member, id)
        if (body.archived && currentTurn(conversation)) throw error('CONFLICT', '请先停止当前回复再归档')
        const now = clock(), next = { ...conversation, updatedAt: now,
          ...(title !== undefined ? { title } : { archivedAt: conversation.archivedAt ?? now }),
        }
        return replaceConversation(state, next)
      })
      return service.getConversation(actor, id)
    },

    async sendTurn(actor, id, body = {}) {
      const operation = acceptTurn(actor, id, body)
      admissions.add(operation)
      try { return await operation } finally { admissions.delete(operation) }
    },

    async cancelTurn(actor, id, turnId) {
      await service.ensureReady()
      const state = await store.read(), member = requireMember(state, actor), conversation = findOwned(state, member, id)
      const turn = conversation.turns.find(item => item.id === turnId)
      if (!turn) throw error('NOT_FOUND', '回复不存在')
      const entry = active.get(id), accepted = ACTIVE.has(turn.status) && entry?.turnId === turnId
      if (accepted) {
        entry.stopStatus = 'cancelled'
        await stopEntry(id, entry)
      }
      const value = await service.getConversation(actor, id)
      return { accepted, conversation: pickSummary(value), turn: value.turns.find(item => item.id === turnId) }
    },

    async close() {
      closed = true
      await Promise.allSettled([...admissions])
      const entries = [...active.entries()]
      const results = await Promise.allSettled(entries.map(async ([id, entry]) => {
        entry.stopStatus ??= 'interrupted'
        await stopEntry(id, entry)
      }))
      const failures = results.filter(item => item.status === 'rejected').map(item => item.reason)
      if (failures.length) throw new AggregateError(failures, '会话回复关闭失败')
    },
  }
  return service

  function assertOpen() { if (closed) throw error('CONFLICT', '会话服务正在关闭') }

  async function acceptTurn(actor, id, body) {
    await service.ensureReady()
    assertOpen()
    fields(body, ['text', 'clientRequestId'])
    const text = requiredText(body.text, 16_000, '消息内容无效', false)
    const clientRequestId = requiredText(body.clientRequestId, 200, '请求标识无效', false)
    const initial = await store.read(), member = requireMember(initial, actor), conversation = findOwned(initial, member, id)
    const existing = repeatedTurn(conversation, clientRequestId, text)
    if (existing) {
      const history = await loadHistory([conversation])
      requireMember(await store.read(), actor)
      return { conversation: summary(initial, member, conversation, history), turn: turnProjection(existing, history), deduplicated: true }
    }
    requireWritable(initial, member, conversation)
    const history = await loadHistory([conversation])
    if (historyStatus(conversation, history) === 'unavailable' || historyStatus(conversation, history) === 'partial') throw error('HISTORY_UNAVAILABLE', ERRORS.HISTORY_UNAVAILABLE)
    const turnId = `turn-${randomUUID()}`, now = clock()
    let deduplicated = false, selected
    const state = await store.update(state => {
      assertOpen()
      const member = requireMember(state, actor), conversation = findOwned(state, member, id)
      const existing = repeatedTurn(conversation, clientRequestId, text)
      if (existing) { deduplicated = true; selected = existing; return state }
      requireWritable(state, member, conversation)
      if (currentTurn(conversation)) throw error('CONFLICT', '当前回复尚未结束')
      const employee = state.employees.find(item => item.id === conversation.employeeId)
      const definition = { employeeRevision: employee.revision ?? 1, instructions: employee.instructions ?? '', modelRouteId: employee.modelRouteId }
      const fingerprint = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
      const last = conversation.sessions.at(-1), interrupted = conversation.turns.at(-1)?.status === 'interrupted'
      selected = {
        id: turnId, clientRequestId, userText: text, status: 'accepted', createdAt: now, startedAt: null, completedAt: null, error: null,
        definition, definitionFingerprint: fingerprint, sessionId: !interrupted && last?.definitionFingerprint === fingerprint ? last.id : null,
        userMessageId: null, assistantMessageIds: [],
      }
      return replaceConversation(state, { ...conversation, employeeName: employee.name, updatedAt: now, turns: [...conversation.turns, selected] })
    })
    if (!deduplicated) {
      const entry = { turnId, stopStatus: null, promise: undefined }
      active.set(id, entry)
      entry.promise = Promise.resolve().then(() => execute(actor, id, selected, entry)).finally(() => { if (active.get(id) === entry) active.delete(id) })
      void entry.promise.catch(onError)
    }
    const updated = findOwned(state, actor, id)
    return { conversation: summary(state, requireMember(state, actor), updated, history), turn: turnProjection(selected, history), deduplicated }

  }

  async function loadHistory(owned) {
    const ids = [...new Set(owned.flatMap(item => item.sessions.map(session => session.id)))]
    if (!ids.length) return new Map()
    let results
    try { results = await runner.readChatHistory(ids) } catch { results = [] }
    if (!Array.isArray(results)) results = []
    return new Map(ids.map(id => [id, results.find(item => item.sessionId === id && item.status === 'available' && Array.isArray(item.events)) ?? { sessionId: id, status: 'unavailable' }]))
  }

  async function stopEntry(id, entry) {
    const results = await Promise.allSettled([Promise.resolve().then(() => runner.cancelChatTurn(id, entry.turnId)), entry.promise])
    const failures = results.filter(item => item.status === 'rejected').map(item => item.reason)
    if (failures.length) throw new AggregateError(failures, '停止会话回复失败')
  }

  async function execute(actor, id, selected, entry) {
    let outcome, failure
    try {
      await store.update(state => {
        const member = requireMember(state, actor), conversation = findOwned(state, member, id)
        requireWritable(state, member, conversation)
        if (entry.stopStatus) return state
        return replaceTurn(state, id, selected.id, turn => ({ ...turn, status: 'running', startedAt: clock() }), clock())
      })
      if (!entry.stopStatus) outcome = await runner.runChatTurn({
        conversationId: id, turnId: selected.id, sessionId: selected.sessionId, text: selected.userText, instructions: selected.definition.instructions,
        authorize: async () => {
          if (entry.stopStatus) throw error('CANCELLED', ERRORS.CANCELLED)
          const state = await store.read(), member = requireMember(state, actor), conversation = findOwned(state, member, id)
          requireWritable(state, member, conversation)
          if (currentTurn(conversation)?.id !== selected.id) throw error('CANCELLED', ERRORS.CANCELLED)
        },
        onSession: async ({ sessionId, userMessageId }) => {
          if (typeof sessionId !== 'string' || !sessionId || typeof userMessageId !== 'string' || !userMessageId) throw error('UPSTREAM_ERROR', ERRORS.UPSTREAM_ERROR)
          if (selected.sessionId && selected.sessionId !== sessionId) throw error('HISTORY_UNAVAILABLE', ERRORS.HISTORY_UNAVAILABLE)
          await store.update(state => {
            const member = requireMember(state, actor), conversation = findOwned(state, member, id)
            requireWritable(state, member, conversation)
            if (entry.stopStatus || currentTurn(conversation)?.id !== selected.id) throw error('CANCELLED', ERRORS.CANCELLED)
            if (conversations(state).some(item => item.id !== id && item.sessions.some(session => session.id === sessionId))
              || (!selected.sessionId && conversation.sessions.some(session => session.id === sessionId))) throw error('UPSTREAM_ERROR', ERRORS.UPSTREAM_ERROR)
            const sessions = conversation.sessions.some(item => item.id === sessionId) ? conversation.sessions : [...conversation.sessions, { id: sessionId, definitionFingerprint: selected.definitionFingerprint, createdAt: clock() }]
            const next = { ...conversation, sessions, turns: conversation.turns.map(turn => turn.id === selected.id ? { ...turn, sessionId, userMessageId } : turn) }
            return replaceConversation(state, next)
          })
        },
      })
    } catch (error) { failure = error }
    const status = entry.stopStatus ?? (failure || outcome?.stopReason !== 'completed' ? (failure?.code === 'CANCELLED' || outcome?.stopReason === 'aborted' ? 'cancelled' : 'failed') : 'completed')
    await store.update(state => replaceTurn(state, id, selected.id, turn => ({
      ...turn, status, completedAt: clock(),
      assistantMessageIds: outcome?.assistantMessageIds ?? turn.assistantMessageIds,
      error: status === 'completed' ? null : publicError(status === 'cancelled' ? { code: 'CANCELLED' } : status === 'interrupted' ? { code: 'PROCESS_SHUTDOWN' } : failure ?? outcome?.error),
    }), clock()))
  }
}

function conversations(state) { return state.conversations ?? [] }
function currentTurn(conversation) { return conversation.turns.find(turn => ACTIVE.has(turn.status)) }
function requireMember(state, actor) {
  const member = state.members.find(item => item.id === (actor?.id ?? actor?.memberId) && item.enabled === true)
  if (!member) throw error('UNAUTHORIZED', '会话无效')
  return member
}
function findOwned(state, actor, id) {
  const conversation = conversations(state).find(item => item.id === id && item.ownerMemberId === (actor?.id ?? actor?.memberId))
  if (!conversation) throw error('NOT_FOUND', '对话不存在')
  return conversation
}
function requireEmployee(state, member, employee) {
  if (!employee || employee.enabled !== true || !member.employeeIds.includes(employee.id)) throw error('FORBIDDEN', ERRORS.FORBIDDEN)
  const route = state.modelRoutes.find(item => item.id === employee.modelRouteId && item.enabled === true && item.provider === MODEL.provider && item.model === MODEL.model)
  if (!route) throw error('MODEL_NOT_CONFIGURED', ERRORS.MODEL_NOT_CONFIGURED)
}
function requireWritable(state, member, conversation) {
  if (conversation.archivedAt) throw error('CONFLICT', '对话已归档')
  requireEmployee(state, member, state.employees.find(item => item.id === conversation.employeeId))
}
function repeatedTurn(conversation, clientRequestId, text) {
  const existing = conversation.turns.find(item => item.clientRequestId === clientRequestId)
  if (existing && existing.userText !== text) throw error('IDEMPOTENCY_CONFLICT', '请求标识已用于其他消息')
  return existing
}
function replaceConversation(state, next) { return { ...state, conversations: conversations(state).map(item => item.id === next.id ? next : item) } }
function replaceTurn(state, id, turnId, update, at) {
  const conversation = conversations(state).find(item => item.id === id)
  if (!conversation) throw error('NOT_FOUND', '对话不存在')
  return replaceConversation(state, { ...conversation, updatedAt: at, turns: conversation.turns.map(turn => turn.id === turnId && ACTIVE.has(turn.status) ? update(turn) : turn) })
}
function readOnlyReason(state, member, conversation, history) {
  if (conversation.archivedAt) return 'CONVERSATION_ARCHIVED'
  const employee = state.employees.find(item => item.id === conversation.employeeId)
  if (!employee) return 'AGENT_UNAVAILABLE'
  if (!member.employeeIds.includes(employee.id)) return 'AGENT_ACCESS_REVOKED'
  if (!employee.enabled) return 'AGENT_DISABLED'
  try { requireEmployee(state, member, employee) } catch { return 'AGENT_UNAVAILABLE' }
  return ['partial', 'unavailable'].includes(historyStatus(conversation, history)) ? 'HISTORY_UNAVAILABLE' : null
}
function summary(state, member, conversation, history) {
  return { id: conversation.id, title: conversation.title, employeeId: conversation.employeeId,
    employeeName: state.employees.find(item => item.id === conversation.employeeId)?.name ?? conversation.employeeName,
    source: conversation.source, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, archivedAt: conversation.archivedAt,
    readOnlyReason: readOnlyReason(state, member, conversation, history), activeTurnId: currentTurn(conversation)?.id ?? null,
  }
}
function pickSummary(value) { return Object.fromEntries(['id', 'title', 'employeeId', 'employeeName', 'source', 'createdAt', 'updatedAt', 'archivedAt', 'readOnlyReason', 'activeTurnId'].map(key => [key, value[key]])) }
function detail(state, member, conversation, history) {
  return { ...summary(state, member, conversation, history), turns: conversation.turns.map(turn => turnProjection(turn, history)),
    historyStatus: historyStatus(conversation, history), relatedWorks: state.works.filter(work => work.conversationId === conversation.id && work.ownerMemberId === member.id && !work.rootWorkId).map(work => ({ id: work.id, goal: work.goal, status: work.status, employeeId: work.employeeId })),
  }
}
function historyStatus(conversation, history) {
  if (!conversation.turns.length) return 'empty'
  const unreadable = conversation.sessions.filter(session => history.get(session.id)?.status !== 'available').length
  if (unreadable) return unreadable === conversation.sessions.length ? 'unavailable' : 'partial'
  return conversation.turns.some(turn => turn.status === 'completed' && !nativeMessages(turn, history).complete) ? 'partial' : 'available'
}
function nativeMessages(turn, history) {
  const events = history.get(turn.sessionId)?.events
  if (!events) return { complete: false, assistantText: null }
  const user = events.findIndex(event => event.type === 'user/message' && event.data?.id === turn.userMessageId)
  if (user < 0) return { complete: false, assistantText: null }
  const number = events.slice(0, user + 1).findLast(event => event.type === 'turn/start')?.data.turn
  if (!Number.isSafeInteger(number)) return { complete: false, assistantText: null }
  const messages = events.filter(event => event.type === 'assistant/message' && event.data?.turn === number).map(event => event.data.message)
  const complete = turn.assistantMessageIds.length > 0 && turn.assistantMessageIds.every(id => messages.some(message => message.id === id))
  const text = messages.flatMap(message => message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text)).join('\n')
  return { complete, assistantText: messages.length ? text : null }
}
function turnProjection(turn, history) {
  const unavailable = turn.sessionId && history.get(turn.sessionId)?.status === 'unavailable'
  return { id: turn.id, userText: unavailable ? null : turn.userText, assistantText: nativeMessages(turn, history).assistantText,
    status: turn.status, createdAt: turn.createdAt, startedAt: turn.startedAt, completedAt: turn.completedAt, error: turn.error ? publicError(turn.error) : null,
  }
}
function publicError(value) { const code = Object.hasOwn(ERRORS, value?.code) ? value.code : 'UPSTREAM_ERROR'; return { code, message: ERRORS[code] } }
function fields(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw error('INVALID_REQUEST', '请求包含无效字段') }
function requiredText(value, maximum, message, trim = true) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.length > maximum) throw error('INVALID_REQUEST', message)
  return trim ? value.trim() : value
}
function error(code, message) { return Object.assign(new Error(message), { code }) }
