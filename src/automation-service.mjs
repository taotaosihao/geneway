import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { assertTrustedConnection } from './connection-catalog.mjs'
import { getCapability, validateCapabilityInput } from './capabilities.mjs'

const CAPABILITY_ID = 'gearjob-work-order-read'
const MODEL_PROVIDER = 'zenmux'
const MODEL_ID = 'deepseek/deepseek-v4.1-flash'
const MODEL_CREDENTIAL = 'ZENMUX_API_KEY'
const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000

export class AutomationServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AutomationServiceError'
    this.code = code
  }
}

export function createAutomationService({ store, workService = null, clock = () => new Date().toISOString(), idFactory = randomUUID, connectionCatalog = [], eventSourceId = null, eventSourceReady = () => true } = {}) {
  if (!store?.read || !store?.update) throw new TypeError('automation service 需要 store')
  if (typeof eventSourceReady !== 'function') throw new TypeError('eventSourceReady 无效')
  eventSourceId = text(eventSourceId) ?? null
  const eventSourceAvailable = () => Boolean(eventSourceId && eventSourceReady())

  return {
    eventSourceCapability() {
      if (getCapability(CAPABILITY_ID).retired) return { status: 'unavailable', code: 'CAPABILITY_RETIRED' }
      return eventSourceAvailable() ? { status: 'ready', sourceId: eventSourceId } : { status: 'unavailable', code: 'SOURCE_NOT_CONFIGURED' }
    },
    async acceptDailyOccurrence({ ruleId, scheduledDate, scheduledAt, ownerCheck } = {}) {
      requireAutomationCapability()
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
        if (rule.trigger?.kind !== 'daily-time') throw serviceError('SOURCE_NOT_CONFIGURED', '手动核对只支持每日规则')
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
        const accepted = admit(state, rule, { occurrenceKey, scheduledDate, now })
        admission = accepted.admission
        return accepted.state
      })
      return dispatchAdmission(admission, ownerCheck)
    },

    async acceptManualOccurrence(actor, id, input = {}) {
      requireAutomationCapability()
      exactInput(input, ['expectedRevision', 'clientRequestId', 'ownerCheck'])
      const clientRequestId = requestId(input.clientRequestId), occurrenceKey = `${required(id, 'ruleId')}:manual:${clientRequestId}`, ownerCheck = input.ownerCheck
      if (ownerCheck !== undefined && typeof ownerCheck !== 'function') throw serviceError('INVALID_REQUEST', 'ownerCheck 无效')
      await workService?.ensureReady?.()
      if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
      let admission
      await store.update(state => {
        if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        const member = requireMember(state, actor), rule = ownedRule(state, member, id)
        const existing = state.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
        if (existing) { admission = occurrenceAdmission(existing, state); return state }
        requireRevision(rule, input.expectedRevision)
        if (rule.status !== 'active') throw serviceError('INVALID_STATE', '只有已启用规则可立即核对')
        if (rule.trigger?.kind !== 'daily-time') throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源暂不可用')
        const accepted = admit(state, rule, { occurrenceKey, scheduledDate: null, now: timestamp(clock()) })
        admission = accepted.admission
        return accepted.state
      })
      return dispatchAdmission(admission, ownerCheck)
    },

    async acceptGearJobEvent(input = {}) {
      requireAutomationCapability()
      exactInput(input, ['sourceId', 'workOrderId', 'sourceRevision', 'digest', 'ownerCheck'])
      const sourceId = required(input.sourceId, 'sourceId'), workOrderId = required(input.workOrderId, 'workOrderId')
      const sourceRevision = required(input.sourceRevision, 'sourceRevision')
      const digest = required(input.digest, 'digest'), ownerCheck = input.ownerCheck
      requireEventCapability(eventSourceId, eventSourceAvailable, sourceId)
      if (!/^[a-f0-9]{64}$/.test(digest)) throw serviceError('INVALID_REQUEST', 'digest 无效')
      if (ownerCheck !== undefined && typeof ownerCheck !== 'function') throw serviceError('INVALID_REQUEST', 'ownerCheck 无效')
      await workService?.ensureReady?.()
      if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
      const outcomes = []
      await store.update(state => {
        if (ownerCheck && !ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        let next = state
        const rules = state.automationRules.filter(item => item.trigger?.kind === 'gearjob-work-order-update' && item.trigger.sourceId === sourceId && item.workOrderId === workOrderId)
        for (const rule of rules) {
          const occurrenceKey = eventOccurrenceKey(rule.id, sourceId, sourceRevision, workOrderId)
          const existing = next.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
          if (existing) {
            if (existing.event?.digest !== digest) throw serviceError('CONFLICT', '同一来源事件内容不一致')
            outcomes.push(occurrenceAdmission(existing, next))
            continue
          }
          if (rule.status !== 'active') continue
          const now = timestamp(clock())
          const event = { sourceId, sourceRevision, digest }
          const sourceMicros = gearJobRevisionMicros(sourceRevision), acceptMicros = instantMicros(rule.eventAcceptAfter)
          const reason = sourceMicros === null || acceptMicros === null ? 'source-time-unverifiable' : sourceMicros < acceptMicros ? 'before-active-window' : null
          const result = reason
            ? { state: { ...next, automationOccurrences: [...next.automationOccurrences, { id: `occurrence-${idFactory()}`, occurrenceKey, ruleId: rule.id, ruleRevision: rule.revision, scheduledDate: null, event, workId: null, status: reason === 'source-time-unverifiable' ? 'blocked' : 'skipped', reason, deliveryId: null, createdAt: now }] } }
            : admit(next, rule, { occurrenceKey, scheduledDate: null, event, now })
          next = result.state
          outcomes.push(result.admission ?? occurrenceAdmission(next.automationOccurrences.at(-1), next, false))
        }
        return next
      })
      const dispatched = []
      for (const outcome of outcomes) dispatched.push(await dispatchAdmission(outcome, ownerCheck))
      return { matched: outcomes.length, accepted: dispatched.filter(item => item.accepted && !item.deduplicated).length, outcomes: dispatched }
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

    async listOccurrences(actor, id) {
      const state = await store.read(), member = requireMember(state, actor)
      const ruleIds = id ? new Set([ownedRule(state, member, id).id]) : new Set(state.automationRules.filter(rule => rule.ownerMemberId === member.id).map(rule => rule.id))
      return state.automationOccurrences.filter(item => ruleIds.has(item.ruleId)).map(item => structuredClone(item))
    },

    async createRule(actor, input = {}) {
      let created
      await store.update(state => {
        const member = requireMember(state, actor)
        requireAutomationCapability()
        exactInput(input, ['employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        const fields = ruleFields(state, member, input, connectionCatalog, eventSourceId, eventSourceAvailable)
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
        requireAutomationCapability()
        exactInput(input, ['expectedRevision', 'employeeId', 'skillId', 'connectionId', 'workOrderId', 'trigger', 'maxRuns', 'notificationConversationId'])
        requireRevision(rule, input.expectedRevision)
        if (rule.status === 'revoked') throw serviceError('INVALID_STATE', '已撤销规则不可修改')
        const fields = ruleFields(state, member, { ...rule, ...input }, connectionCatalog, eventSourceId, eventSourceAvailable)
        if (state.automationOccurrences.some(item => item.ruleId === rule.id) && identityChanged(rule, fields)) throw serviceError('INVALID_STATE', '规则已有发生历史；员工、Skill、连接、工单或触发方式不可修改，请新建草稿')
        const usedRuns = deriveUsedRuns(rule, state.automationOccurrences)
        if (fields.maxRuns < usedRuns) throw serviceError('INVALID_REQUEST', '累计预算不能低于已使用次数')
        const now = timestamp(clock())
        const sourceOrTargetChanged = fields.trigger.kind === 'gearjob-work-order-update'
          && (rule.trigger.kind !== fields.trigger.kind || rule.trigger.sourceId !== fields.trigger.sourceId || rule.workOrderId !== fields.workOrderId)
        updated = {
          ...rule,
          ...fields,
          revision: rule.revision + 1,
          updatedAt: now,
          effectiveFrom: fields.trigger.kind === 'daily-time' ? rule.status === 'active' ? now : rule.effectiveFrom : null,
          eventAcceptAfter: fields.trigger.kind === 'gearjob-work-order-update' ? sourceOrTargetChanged && rule.status !== 'draft' ? now : rule.eventAcceptAfter : null,
        }
        return invalidateAutomationNotifications({ ...state, automationRules: replaceById(state.automationRules, updated) }, rule.id, now)
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
        return invalidateAutomationNotifications({ ...state, automationRules: replaceById(state.automationRules, revoked) }, rule.id, now)
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
        requireAutomationCapability()
        normalizeTrigger(rule.trigger)
        if (rule.trigger.kind === 'gearjob-work-order-update') requireEventCapability(eventSourceId, eventSourceAvailable, rule.trigger.sourceId)
        validateBinding(state, member, rule, connectionCatalog)
      }
      if (enteringActive && deriveUsedRuns(rule, state.automationOccurrences) >= rule.maxRuns) throw serviceError('BUDGET_EXHAUSTED', '规则累计预算已用尽')
      const now = timestamp(clock())
      const event = rule.trigger.kind === 'gearjob-work-order-update'
      updated = {
        ...rule,
        status: to,
        revision: rule.revision + 1,
        updatedAt: now,
        effectiveFrom: enteringActive && !event ? now : event ? null : rule.effectiveFrom,
        eventAcceptAfter: enteringActive && event ? now : event ? rule.eventAcceptAfter : null,
      }
      const next = { ...state, automationRules: replaceById(state.automationRules, updated) }
      return enteringActive ? next : invalidateAutomationNotifications(next, rule.id, now)
    })
    return projectRule(await store.read(), updated, clock())
  }

  function admit(state, rule, { occurrenceKey, scheduledDate, event = null, now }) {
    const prepared = workService?.prepareAutomationWork?.(state, rule, { occurrenceKey, acceptedAt: now, workId: `work-${idFactory()}`, executionId: `exec-${idFactory()}` })
    const reason = !prepared?.ok ? 'auth-blocked' : deriveUsedRuns(rule, state.automationOccurrences) >= rule.maxRuns ? 'budget' : activeAutomationWorkCount(state, rule.id) ? 'overlap' : activeAutomationWorkCount(state) >= 2 ? 'capacity' : null
    if (reason) {
      const occurrence = { id: `occurrence-${idFactory()}`, occurrenceKey, ruleId: rule.id, ruleRevision: rule.revision, scheduledDate, event, workId: null, status: reason === 'auth-blocked' ? 'blocked' : 'skipped', reason, deliveryId: null, createdAt: now }
      return { state: { ...state, automationOccurrences: [...state.automationOccurrences, occurrence] }, admission: occurrenceAdmission(occurrence, state, false) }
    }
    const occurrence = { id: `occurrence-${idFactory()}`, occurrenceKey, ruleId: rule.id, ruleRevision: rule.revision, scheduledDate, event, workId: prepared.workId, status: null, reason: null, deliveryId: null, createdAt: now }
    return { state: { ...state, works: [...state.works, prepared.work], automationOccurrences: [...state.automationOccurrences, occurrence] }, admission: { accepted: true, deduplicated: false, occurrence, work: prepared.work, workId: prepared.workId, executionId: prepared.executionId, acceptedAt: prepared.acceptedAt } }
  }

  async function dispatchAdmission(admission, ownerCheck) {
    if (!admission?.accepted || admission.deduplicated) return admission
    if (ownerCheck && !ownerCheck()) return { ...admission, dispatched: false, dispatchError: { code: 'OWNER_LOCK_LOST', message: 'automation owner lock 已失效' } }
    try {
      await workService?.dispatchAutomationWork?.(admission.workId, admission.executionId, admission.acceptedAt, { ownerCheck })
      return { ...admission, dispatched: true }
    } catch (error) {
      return { ...admission, dispatched: false, dispatchError: { code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? '自动工作派发失败' } }
    }
  }
}

export function createAutomationRuntime({ store, automationService, workService, dataRoot, clock = () => new Date().toISOString(), timerFactory = setTimeout, clearTimer = clearTimeout, lockFactory = acquireAutomationOwner, onOwnerLost = async () => undefined, onError = () => undefined } = {}) {
  if (!store?.read || !automationService?.acceptDailyOccurrence || !workService?.ensureReady || !workService?.automationOwnerLost) throw new TypeError('automation runtime 依赖无效')
  if (typeof onOwnerLost !== 'function') throw new TypeError('onOwnerLost 无效')
  if (!isAbsolute(dataRoot) || resolve(dataRoot) === parse(resolve(dataRoot)).root) throw new TypeError('automation data root 无效')
  let owner
  let timer
  let tickPromise
  let running = false
  let scheduleGeneration = 0

  return {
    async start() {
      if (running) return
      owner = await lockFactory(resolve(dataRoot))
      running = true
      owner.lost?.then(async error => {
        if (!running) return
        running = false
        scheduleGeneration += 1
        if (timer) clearTimer(timer)
        timer = undefined
        try { await onOwnerLost(error) } catch (callbackError) { onError(callbackError) }
        await workService.automationOwnerLost()
        onError(Object.assign(new Error('automation owner lock lost'), { code: 'OWNER_LOCK_LOST', cause: error }))
      }).catch(onError)
      try {
        await workService.ensureReady()
        if (!running) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        await arm(scheduleGeneration)
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
    async checkNow(actor, id, input) {
      if (!running) throw serviceError('OWNER_NOT_RUNNING', '自动执行入口暂不可用')
      if (!automationService?.acceptManualOccurrence) throw serviceError('OWNER_NOT_RUNNING', '自动执行入口暂不可用')
      return automationService.acceptManualOccurrence(actor, id, { ...input, ownerCheck: () => running })
    },
    async acceptGearJobEvent(input) {
      if (!running) throw serviceError('OWNER_NOT_RUNNING', '自动执行入口暂不可用')
      if (!automationService?.acceptGearJobEvent) throw serviceError('OWNER_NOT_RUNNING', '自动执行入口暂不可用')
      return automationService.acceptGearJobEvent({ ...input, ownerCheck: () => running })
    },
    async refresh() {
      if (!running) return
      const generation = ++scheduleGeneration
      if (timer) clearTimer(timer)
      timer = undefined
      await tickPromise?.catch(() => undefined)
      if (running) await arm(generation)
    },
    ownsLock() { return running },
  }

  async function stop() {
    running = false
    scheduleGeneration += 1
    if (timer) clearTimer(timer)
    timer = undefined
    await tickPromise?.catch(() => undefined)
  }

  async function arm(generation = scheduleGeneration) {
    if (!running || generation !== scheduleGeneration) return
    const state = await store.read()
    if (!running || generation !== scheduleGeneration) return
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
      if (!running || generation !== scheduleGeneration) return
      timer = undefined
      tickPromise = tickDue(due).catch(onError).finally(() => {
        tickPromise = undefined
        if (running) void arm(generation).catch(onError)
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

export function eventOccurrenceKey(ruleId, sourceId, sourceRevision, workOrderId) {
  const identity = [required(ruleId, 'ruleId'), required(sourceId, 'sourceId'), 'on_update', 'Work Order', required(workOrderId, 'workOrderId'), required(sourceRevision, 'sourceRevision')]
  return `${identity[0]}:event:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

export function deriveUsedRuns(rule, occurrences = []) {
  return occurrences.filter(item => item?.ruleId === rule?.id && text(item.workId)).length
}

export function nextDailyOccurrence(rule, now, occurrences = []) {
  if (!rule || rule.status !== 'active' || deriveUsedRuns(rule, occurrences) >= rule.maxRuns) return null
  if (rule.trigger?.kind !== 'daily-time') return null
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
    event: null,
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

function invalidateAutomationNotifications(state, ruleId, timestamp) {
  const deliveryIds = new Set(state.automationOccurrences.filter(item => item.ruleId === ruleId && item.deliveryId).map(item => item.deliveryId))
  if (!deliveryIds.size) return state
  return {
    ...state,
    deliveries: state.deliveries.map(delivery => {
      if (!deliveryIds.has(delivery.id) || !['pending', 'sending'].includes(delivery.status)) return delivery
      const unknown = delivery.status === 'sending'
      return { ...delivery, status: unknown ? 'unknown' : 'blocked', error: { code: unknown ? 'DELIVERY_UNKNOWN' : 'RULE_CHANGED', message: unknown ? '发送效果待核对' : '自动规则或通知目标已变化' }, updatedAt: timestamp }
    }),
  }
}

function ruleFields(state, member, input, connectionCatalog, eventSourceId, eventSourceAvailable) {
  const trigger = normalizeTrigger(input.trigger)
  if (trigger.kind === 'gearjob-work-order-update') requireEventCapability(eventSourceId, eventSourceAvailable, trigger.sourceId)
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
  if (trigger.kind === 'daily-time') {
    if (Object.keys(trigger).sort().join(',') !== 'kind,time,timeZone') throw serviceError('INVALID_REQUEST', 'trigger 字段无效')
    if (typeof trigger.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) || trigger.timeZone !== 'Asia/Shanghai') throw serviceError('INVALID_REQUEST', '每日触发时间无效')
    return { kind: trigger.kind, time: trigger.time, timeZone: trigger.timeZone }
  }
  if (trigger.kind === 'gearjob-work-order-update') {
    if (Object.keys(trigger).sort().join(',') !== 'kind,sourceId') throw serviceError('INVALID_REQUEST', 'trigger 字段无效')
    return { kind: trigger.kind, sourceId: required(trigger.sourceId, 'sourceId') }
  }
  throw serviceError('INVALID_REQUEST', 'trigger kind 不支持')
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
function requireEventCapability(configuredSourceId, available, requestedSourceId) {
  if (!available() || configuredSourceId !== requestedSourceId) throw serviceError('SOURCE_NOT_CONFIGURED', 'GearJob 事件来源未配置')
}
function requireAutomationCapability() {
  if (getCapability(CAPABILITY_ID).retired) throw serviceError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
}
function identityChanged(rule, fields) { return ['employeeId', 'skillId', 'connectionId', 'workOrderId'].some(key => rule[key] !== fields[key]) || JSON.stringify(rule.trigger) !== JSON.stringify(fields.trigger) }
function gearJobRevisionMicros(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{6})$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction] = match
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))
  const check = new Date(millis + ZONE_OFFSET_MS).toISOString()
  if (check.slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null
  return BigInt(millis) * 1000n + BigInt(fraction)
}
function instantMicros(value) { const millis = Date.parse(value); return Number.isFinite(millis) ? BigInt(millis) * 1000n : null }
function timestamp(value) { const result = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : ''; if (!result || !Number.isFinite(Date.parse(result))) throw serviceError('INTERNAL_ERROR', '时钟无效'); return result }
function required(value, label) { const result = text(value); if (!result) throw serviceError('INVALID_REQUEST', `${label} 无效`); return result }
function nullableText(value) { if (value === null) return null; return required(value, 'notificationConversationId') }
function requestId(value) { const result = required(value, 'clientRequestId'); if (!/^[A-Za-z0-9._-]{1,128}$/.test(result)) throw serviceError('INVALID_REQUEST', 'clientRequestId 无效'); return result }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function serviceError(code, message) { return new AutomationServiceError(code, message) }
function parseInstant(value) { const time = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return time && Number.isFinite(time.getTime()) ? time : null }
function shifted(date) { return new Date(date.getTime() + ZONE_OFFSET_MS) }
function dateOnly(date) { return date.toISOString().slice(0, 10) }
function shanghaiDate(value) { const instant = parseInstant(value); if (!instant) throw serviceError('INVALID_REQUEST', '自动发生时间无效'); return dateOnly(shifted(instant)) }
function localDateTime(localDate, time) { return new Date(Date.parse(`${localDate}T${time}:00.000Z`) - ZONE_OFFSET_MS) }
function isDateOnly(value) { if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return date.toISOString().slice(0, 10) === value }
