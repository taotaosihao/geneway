import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
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

export function createAutomationService({ store, workService = null, clock = () => new Date().toISOString(), idFactory = randomUUID, connectionCatalog = [] } = {}) {
  if (!store?.read || !store?.update) throw new TypeError('automation service 需要 store')

  return {
    async acceptDailyOccurrence({ ruleId, scheduledDate, scheduledAt, ownerCheck } = {}) {
      const occurrenceKey = dailyOccurrenceKey(ruleId, scheduledDate)
      await workService?.ensureReady?.()
      if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
      let admission
      await store.update(state => {
        if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        const existing = state.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
        if (existing) {
          admission = occurrenceAdmission(existing, state)
          return state
        }
        const rule = state.automationRules.find(item => item.id === text(ruleId))
        const now = timestamp(clock())
        if (!rule) throw serviceError('NOT_FOUND', '自动规则不存在')
        if (rule.trigger?.kind !== 'daily-time') throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源暂不可用')
        if (rule.status !== 'active') {
          const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'blocked', 'rule-inactive')
          admission = occurrenceAdmission(occurrence, state, false)
          return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
        }
        if (scheduledAt !== undefined) {
          const expected = localDateTime(scheduledDate, rule.trigger.time).toISOString()
          const scheduled = parseInstant(scheduledAt)
          const current = parseInstant(now)
          const effective = parseInstant(rule.effectiveFrom)
          if (!scheduled || scheduled.toISOString() !== expected || !current || !effective || scheduled < effective || current < scheduled) throw serviceError('INVALID_REQUEST', '自动发生时间无效')
          if (current.getTime() - scheduled.getTime() > 60_000) {
            const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'skipped', 'missed-window')
            admission = occurrenceAdmission(occurrence, state, false)
            return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
          }
        }
        const prepared = workService?.prepareAutomationWork?.(state, rule, {
          occurrenceKey,
          acceptedAt: now,
          workId: `work-${idFactory()}`,
          executionId: `exec-${idFactory()}`,
        })
        if (!prepared?.ok) {
          const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'blocked', 'auth-blocked')
          admission = occurrenceAdmission(occurrence, state, false)
          return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
        }
        const usedRuns = deriveUsedRuns(rule, state.automationOccurrences)
        if (usedRuns >= rule.maxRuns) {
          const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'skipped', 'budget')
          admission = occurrenceAdmission(occurrence, state, false)
          return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
        }
        if (activeAutomationWorkCount(state, rule.id)) {
          const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'skipped', 'overlap')
          admission = occurrenceAdmission(occurrence, state, false)
          return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
        }
        if (activeAutomationWorkCount(state) >= 2) {
          const occurrence = terminalOccurrence(`occurrence-${idFactory()}`, rule, scheduledDate, now, 'skipped', 'capacity')
          admission = occurrenceAdmission(occurrence, state, false)
          return { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }
        }
        const occurrence = {
          id: `occurrence-${idFactory()}`,
          occurrenceKey,
          ruleId: rule.id,
          ruleRevision: rule.revision,
          scheduledDate,
          workId: prepared.workId,
          status: null,
          reason: null,
          deliveryId: null,
          createdAt: now,
        }
        admission = { accepted: true, deduplicated: false, occurrence, work: prepared.work, workId: prepared.workId, executionId: prepared.executionId, acceptedAt: prepared.acceptedAt }
        return { ...state, works: [...state.works, prepared.work], automationOccurrences: [...state.automationOccurrences, occurrence] }
      })
      if (admission?.accepted && !admission.deduplicated) {
        if (ownerCheck && !ownerCheck()) return { ...admission, dispatched: false, dispatchError: { code: 'OWNER_LOCK_LOST', message: 'automation owner lock 已失效' } }
        try {
          await workService?.dispatchAutomationWork?.(admission.workId, admission.executionId, admission.acceptedAt, { ownerCheck })
          admission = { ...admission, dispatched: true }
        } catch (error) {
          admission = { ...admission, dispatched: false, dispatchError: { code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? '自动工作派发失败' } }
        }
      }
      return admission
    },

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

export function createAutomationRuntime({ store, automationService, workService, dataRoot, clock = () => new Date().toISOString(), timerFactory = setTimeout, clearTimer = clearTimeout, lockFactory = acquireAutomationOwner, onError = () => undefined } = {}) {
  if (!store?.read || !automationService?.acceptDailyOccurrence || !workService?.ensureReady || !workService?.automationOwnerLost) throw new TypeError('automation runtime 依赖无效')
  if (!isAbsolute(dataRoot) || resolve(dataRoot) === parse(resolve(dataRoot)).root) throw new TypeError('automation data root 无效')
  let owner
  let timer
  let tickPromise
  let running = false

  return {
    async start() {
      if (running) return
      owner = await lockFactory(resolve(dataRoot))
      running = true
      owner.lost?.then(async error => {
        if (!running) return
        running = false
        if (timer) clearTimer(timer)
        timer = undefined
        await workService.automationOwnerLost()
        onError(Object.assign(new Error('automation owner lock lost'), { code: 'OWNER_LOCK_LOST', cause: error }))
      }).catch(onError)
      try {
        await workService.ensureReady()
        if (!running) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        await arm()
        if (!running) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
      } catch (error) {
        running = false
        await owner.release().catch(() => undefined)
        owner = undefined
        throw error
      }
    },

    async close() {
      await stop()
      await owner?.release()
      owner = undefined
    },

    async stop() { await stop() },
  }

  async function stop() {
    running = false
    if (timer) clearTimer(timer)
    timer = undefined
    await tickPromise?.catch(() => undefined)
  }

  async function arm() {
    if (!running) return
    const state = await store.read()
    if (!running) return
    const now = timestamp(clock())
    const candidates = state.automationRules
      .map(rule => ({ rule, dueAt: nextDailyOccurrence(rule, now, state.automationOccurrences) }))
      .filter(item => item.dueAt)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.rule.id.localeCompare(right.rule.id))
    if (!candidates.length) return
    const dueAt = candidates[0].dueAt
    const due = candidates.filter(candidate => candidate.dueAt === dueAt)
    const delay = Math.max(0, Date.parse(dueAt) - Date.parse(now))
    timer = timerFactory(() => {
      timer = undefined
      tickPromise = tickDue(due).catch(onError).finally(() => {
        tickPromise = undefined
        if (running) void arm().catch(onError)
      })
    }, delay)
    timer?.unref?.()
  }

  async function tickDue(candidates) {
    for (const candidate of candidates) {
      if (!running) return
      await tick(candidate)
    }
  }

  async function tick(candidate) {
    if (!running) return
    const state = await store.read()
    const rule = state.automationRules.find(item => item.id === candidate.rule.id)
    if (!rule || rule.status !== 'active' || rule.trigger.kind !== 'daily-time') return
    const scheduledDate = shanghaiDate(candidate.dueAt)
    const expected = localDateTime(scheduledDate, rule.trigger.time).toISOString()
    if (expected !== candidate.dueAt || !rule.effectiveFrom || Date.parse(rule.effectiveFrom) > Date.parse(candidate.dueAt)) return
    const now = timestamp(clock())
    if (Date.parse(now) < Date.parse(candidate.dueAt)) return
    await automationService.acceptDailyOccurrence({ ruleId: rule.id, scheduledDate, scheduledAt: candidate.dueAt, ownerCheck: () => running })
  }
}

export async function acquireAutomationOwner(dataRoot, { spawnImpl = spawn } = {}) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const lockPath = join(dataRoot, '.geneway-automation.lock')
  let descriptor
  try {
    descriptor = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || (process.getuid && metadata.uid !== process.getuid())) throw serviceError('OWNER_LOCK_INVALID', 'automation owner lock 无效')
    fchmodSync(descriptor, 0o600)
    const holder = spawnImpl('/bin/sh', ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _'], { stdio: ['pipe', 'pipe', 'ignore', descriptor] })
    closeSync(descriptor)
    descriptor = undefined
    await waitForOwnerReady(holder)
    let releasing = false
    let resolveLost
    const lost = new Promise(resolveLockLost => { resolveLost = resolveLockLost })
    holder.once('exit', (code, signal) => { if (!releasing) resolveLost({ code, signal }) })
    return {
      lost,
      async release() {
        releasing = true
        if (holder.exitCode !== null || holder.signalCode !== null) return
        holder.stdin.end('\n')
        await waitForOwnerExit(holder)
      },
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throw error
  }
}

function waitForOwnerReady(holder) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => { holder.kill('SIGKILL'); rejectReady(serviceError('OWNER_LOCK_TIMEOUT', 'automation owner lock 超时')) }, 1_000)
    const onData = chunk => {
      if (!String(chunk).includes('ready')) return
      clearTimeout(timeout)
      holder.stdout.off('data', onData)
      holder.off('exit', onExit)
      holder.off('error', onError)
      resolveReady()
    }
    const onExit = code => {
      clearTimeout(timeout)
      holder.stdout.off('data', onData)
      holder.off('error', onError)
      rejectReady(serviceError(code === 73 ? 'OWNER_ALREADY_RUNNING' : 'OWNER_LOCK_FAILED', code === 73 ? 'automation owner 已运行' : 'automation owner lock 失败'))
    }
    const onError = () => {
      clearTimeout(timeout)
      holder.stdout.off('data', onData)
      holder.off('exit', onExit)
      rejectReady(serviceError('OWNER_LOCK_FAILED', 'automation owner lock 失败'))
    }
    holder.stdout.on('data', onData)
    holder.once('exit', onExit)
    holder.once('error', onError)
  })
}

function waitForOwnerExit(holder) {
  return new Promise(resolveExit => {
    const timeout = setTimeout(() => { holder.kill('SIGKILL'); resolveExit() }, 1_000)
    holder.once('exit', () => { clearTimeout(timeout); resolveExit() })
  })
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

function occurrenceAdmission(occurrence, state, deduplicated = true) {
  const work = occurrence.workId ? state.works.find(item => item.id === occurrence.workId) : undefined
  const execution = work?.executions?.find(item => ['accepted', 'running', 'cancel_requested'].includes(item.status))
  return {
    accepted: Boolean(occurrence.workId),
    deduplicated,
    occurrence,
    work,
    workId: occurrence.workId,
    executionId: execution?.id,
    acceptedAt: work?.acceptedAt,
    ...(occurrence.status ? { skipped: occurrence.status === 'skipped', blocked: occurrence.status === 'blocked', reason: occurrence.reason } : {}),
  }
}

function terminalOccurrence(id, rule, scheduledDate, createdAt, status, reason) {
  return {
    id,
    occurrenceKey: dailyOccurrenceKey(rule.id, scheduledDate),
    ruleId: rule.id,
    ruleRevision: rule.revision,
    scheduledDate,
    workId: null,
    status,
    reason,
    deliveryId: null,
    createdAt,
  }
}

function activeAutomationWorkCount(state, ruleId) {
  const workIds = new Set(state.automationOccurrences.filter(item => (!ruleId || item.ruleId === ruleId) && item.workId).map(item => item.workId))
  return state.works.filter(work => workIds.has(work.id) && work.executions?.some(execution => ['accepted', 'running', 'cancel_requested'].includes(execution.status))).length
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
function timestamp(value) { const result = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : ''; if (!result || !Number.isFinite(Date.parse(result))) throw serviceError('INTERNAL_ERROR', '时钟无效'); return result }
function required(value, label) { const result = text(value); if (!result) throw serviceError('INVALID_REQUEST', `${label} 无效`); return result }
function nullableText(value) { if (value === null) return null; return required(value, 'notificationConversationId') }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function serviceError(code, message) { return new AutomationServiceError(code, message) }
function parseInstant(value) { const time = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return time && Number.isFinite(time.getTime()) ? time : null }
function shifted(date) { return new Date(date.getTime() + ZONE_OFFSET_MS) }
function dateOnly(date) { return date.toISOString().slice(0, 10) }
function shanghaiDate(value) { const instant = parseInstant(value); if (!instant) throw serviceError('INVALID_REQUEST', '自动发生时间无效'); return dateOnly(shifted(instant)) }
function localDateTime(localDate, time) { return new Date(Date.parse(`${localDate}T${time}:00.000Z`) - ZONE_OFFSET_MS) }
function isDateOnly(value) { if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return date.toISOString().slice(0, 10) === value }
