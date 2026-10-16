import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { spawn } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { assertTrustedConnection } from './connection-catalog.mjs'
import { getCapability, validateCapabilityInput, KIVO_TPM_RECORD_READ_CAPABILITY } from './capabilities.mjs'
import { connectionSnapshot } from './execution-grant.mjs'
import { readKivoTpmRecord } from '../plugins/kivo-tpm.mjs'
import { assertTpmObservation } from './domain/tpm.mjs'
import { KIVO_EVENT_RECORD_TYPES, KIVO_EVENT_TRIGGER, KIVO_RECONCILE_MS, revisionString } from './kivo-events.mjs'
import { kivoAutomationClaimKey } from './store/file-store.mjs'

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

export function createAutomationService({ store, workService = null, clock = () => new Date().toISOString(), idFactory = randomUUID, connectionCatalog = [], secretRoot, readCurrentRecord = readKivoTpmRecord, readEventSources = async () => ({ sources: [], sha256: null }), eventSourceReady = () => true } = {}) {
  if (!store?.read || !store?.update) throw new TypeError('automation service 需要 store')
  if (typeof readCurrentRecord !== 'function' || typeof readEventSources !== 'function' || typeof eventSourceReady !== 'function') throw new TypeError('automation source 依赖无效')

  const service = {
    async eventSourceCapability(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      const sources = []
      if (eventSourceReady()) {
        let config
        try { config = await readEventSources() } catch { config = { sources: [] } }
        for (const source of config.sources) {
          if (!source.enabled) continue
          const connection = state.connections.find(item => item.id === source.connectionId)
          if (!connection || connection.baseUrl !== source.resource || connection.sourceInstance !== source.sourceInstance) continue
          const visible = member.employeeIds.some(employeeId => state.skills.some(skill => {
            try { validateBinding(state, member, { employeeId, skillId: skill.id, connectionId: connection.id, input: { recordType: 'repair', reference: 'source-capability' } }, connectionCatalog); return true } catch { return false }
          }))
          if (visible) sources.push({ sourceId: source.id, connectionId: connection.id, recordTypes: [...KIVO_EVENT_RECORD_TYPES], status: 'available' })
        }
      }
      return { status: sources.length ? 'available' : 'unavailable', ...(sources.length ? {} : { code: 'SOURCE_NOT_CONFIGURED' }), reconcileIntervalSeconds: 60, sources }
    },
    async listRules(actor) {
      const state = await store.read(), member = requireMember(state, actor)
      return state.automationRules.filter(rule => rule.ownerMemberId === member.id).map(rule => projectRule(state, rule, clock()))
    },
    async getRule(actor, id) {
      const state = await store.read(), member = requireMember(state, actor)
      return projectRule(state, ownedRule(state, member, id), clock())
    },
    async listOccurrences(actor, id) {
      const state = await store.read(), member = requireMember(state, actor)
      const ruleIds = new Set(id ? [ownedRule(state, member, id).id] : state.automationRules.filter(rule => rule.ownerMemberId === member.id).map(rule => rule.id))
      return state.automationOccurrences.filter(item => ruleIds.has(item.ruleId)).map(item => ({ ...structuredClone(item), ...(item.query ? { reasonText: reasonText(item.reason) } : {}) }))
    },
    async createRule(actor, input = {}) {
      if (Object.hasOwn(input, 'workOrderId')) requireAutomationCapability()
      exactInput(input, ['employeeId', 'skillId', 'connectionId', 'input', 'trigger', 'maxRuns', 'notificationIdentityId'])
      const sources = input.trigger?.kind === KIVO_EVENT_TRIGGER ? await readEventSources() : null
      let created
      await store.update(state => {
        const member = requireMember(state, actor), fields = ruleFields(state, member, input, connectionCatalog, sources)
        const now = timestamp(clock())
        created = { id: `automation-${idFactory()}`, ownerMemberId: member.id, revision: 1, status: 'draft', capabilityId: KIVO_TPM_RECORD_READ_CAPABILITY, ...fields,
          effectiveFrom: null, eventAcceptAfter: null, objectId: null, activationId: null, baselineRevision: null, handledRevision: null, pauseReason: null,
          createdAt: now, updatedAt: now, revokedAt: null }
        return { ...state, automationRules: [...state.automationRules, created] }
      })
      return projectRule(await store.read(), created, clock())
    },
    async updateRule(actor, id, input = {}) {
      exactInput(input, ['expectedRevision', 'employeeId', 'skillId', 'connectionId', 'input', 'workOrderId', 'trigger', 'maxRuns', 'notificationIdentityId'])
      const existing = (await store.read()).automationRules.find(item => item.id === text(id))
      const sources = (input.trigger ?? existing?.trigger)?.kind === KIVO_EVENT_TRIGGER ? await readEventSources() : null
      let updated
      await store.update(state => {
        const member = requireMember(state, actor), rule = ownedRule(state, member, id)
        requireCurrentRule(rule)
        if (Object.hasOwn(input, 'workOrderId')) requireAutomationCapability()
        requireRevision(rule, input.expectedRevision)
        if (rule.status === 'revoked') throw serviceError('INVALID_STATE', '已撤销规则不可修改')
        const fields = ruleFields(state, member, { ...rule, ...input }, connectionCatalog, sources)
        if (rule.status !== 'draft' && identityChanged(rule, fields)) throw serviceError('INVALID_STATE', '已启用规则的目标和绑定已固定，请新建草稿')
        if (fields.maxRuns < deriveUsedRuns(rule, state.automationOccurrences)) throw serviceError('INVALID_REQUEST', '累计预算不能低于已使用次数')
        const now = timestamp(clock())
        updated = { ...rule, ...fields, revision: rule.revision + 1, updatedAt: now,
          effectiveFrom: fields.trigger.kind === 'daily-time' ? rule.status === 'active' && fields.trigger.time !== rule.trigger.time ? now : rule.effectiveFrom : null }
        return invalidateAutomationNotifications({ ...state, automationRules: replaceById(state.automationRules, updated) }, rule.id, now)
      })
      return projectRule(await store.read(), updated, clock())
    },
    async enableRule(actor, id, input = {}) { return activate(actor, id, input, 'draft') },
    async resumeRule(actor, id, input = {}) { return activate(actor, id, input, 'paused') },
    async pauseRule(actor, id, input = {}) { return deactivate(actor, id, input, 'paused') },
    async revokeRule(actor, id, input = {}) { return deactivate(actor, id, input, 'revoked') },
    async acceptGearJobEvent() { requireAutomationCapability() },
    async handleWorkTerminal({ workId, ownerCheck } = {}) {
      checkOwner(ownerCheck)
      const state = await store.read(), work = state.works.find(item => item.id === workId)
      const occurrence = state.automationOccurrences.find(item => item.workId === workId)
      const rule = state.automationRules.find(item => item.id === occurrence?.ruleId)
      const error = work?.executions.at(-1)?.error
      if (rule?.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY && rule.activationId === occurrence.activationId && hardRevocation(error)) await pauseForRevocation(rule, error, ownerCheck)
    },

    async acceptKivoEvent(verified, { ownerCheck } = {}) {
      checkOwner(ownerCheck)
      const config = await readEventSources(), source = config.sources.find(item => item.id === verified?.event?.sourceId && item.enabled)
      if (!source || !/^[a-f0-9]{64}$/.test(verified.sourceConfigSha256) || verified.sourceConfigSha256 !== config.sha256
        || !eventSourceReady() || source.resource !== verified.event.resource || source.sourceInstance !== verified.event.sourceInstance) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源当前不可用或验签配置已变化')
      let result
      await store.update(state => {
        checkOwner(ownerCheck)
        const connection = state.connections.find(item => item.id === source.connectionId && item.enabled && item.status === 'ready' && item.kind === 'kivo-mcp')
        if (!connection || connection.baseUrl !== source.resource || connection.sourceInstance !== source.sourceInstance) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源连接当前不可用')
        try { assertTrustedConnection(connectionCatalog, connection) } catch { throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源连接不在主机可信目录') }
        const sameDelivery = state.automationInbox.find(entry => entry.event.sourceId === source.id && entry.deliveries.some(item => item.id === verified.deliveryId))
        if (sameDelivery) {
          if (sameDelivery.deliveries.find(item => item.id === verified.deliveryId).rawDigest !== verified.rawDigest) throw serviceError('CONFLICT', '同一投递内容不一致')
          result = { accepted: true, deduplicated: true, eventId: sameDelivery.event.eventId }
          return state
        }
        const existing = state.automationInbox.find(entry => entry.event.sourceId === source.id && entry.event.eventId === verified.event.eventId)
        if (existing) {
          if (existing.fingerprint !== verified.fingerprint) throw serviceError('CONFLICT', '同一业务事件内容不一致')
          result = { accepted: true, deduplicated: true, eventId: existing.event.eventId }
          return { ...state, automationInbox: replaceById(state.automationInbox, { ...existing, deliveries: [...existing.deliveries, { id: verified.deliveryId, rawDigest: verified.rawDigest }] }) }
        }
        const targets = state.automationRules.filter(rule => rule.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY && rule.status === 'active'
          && rule.trigger.kind === KIVO_EVENT_TRIGGER && rule.trigger.sourceId === source.id && rule.connectionId === source.connectionId
          && rule.input.recordType === verified.event.recordType && rule.objectId === verified.event.objectId)
          .map(rule => ({ ruleId: rule.id, activationId: rule.activationId, status: 'pending', occurrenceId: null, reason: null }))
        const entry = { id: `event-${idFactory()}`, event: structuredClone(verified.event), fingerprint: verified.fingerprint,
          deliveries: [{ id: verified.deliveryId, rawDigest: verified.rawDigest }], targets, acceptedAt: timestamp(clock()), ignoredReason: targets.length ? null : 'no-active-target' }
        result = { accepted: true, deduplicated: false, eventId: entry.event.eventId }
        return { ...state, automationInbox: [...state.automationInbox, entry] }
      }, { beforeCommit: async () => {
        checkOwner(ownerCheck)
        const current = await readEventSources()
        if (current.sha256 !== config.sha256 || !eventSourceReady()) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源配置已变化')
      } })
      return result
    },

    async processPending({ ownerCheck, reconcile = false } = {}) {
      checkOwner(ownerCheck)
      const state = await store.read()
      const ids = new Set(state.automationInbox.flatMap(entry => entry.targets.filter(target => target.status === 'pending').map(target => target.ruleId)))
      if (reconcile) for (const rule of state.automationRules) if (rule.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY && rule.status === 'active' && rule.trigger.kind === KIVO_EVENT_TRIGGER) ids.add(rule.id)
      const outcomes = []
      for (const id of ids) {
        checkOwner(ownerCheck)
        const current = await store.read(), rule = current.automationRules.find(item => item.id === id)
        if (!rule || rule.status !== 'active') { await finishInactiveTargets(id, ownerCheck); continue }
        try {
          const observed = await currentRecord(rule, { ownerCheck })
          let admission
          await store.update(state => {
            checkOwner(ownerCheck)
            const active = currentRule(state, rule)
            validateObservedBinding(state, active, observed)
            const pending = pendingFor(state, active)
            const echoes = pending.filter(item => isActionEcho(state, item.entry.event, observed))
            let next = settleTargets(state, echoes, null, 'echo')
            const eligible = pendingFor(next, active)
            if (BigInt(observed.query.sourceRevision) < BigInt(active.handledRevision)) return explainPending(next, eligible, 'revision-regressed')
            const ready = eligible.filter(item => BigInt(item.entry.event.sourceRevision) <= BigInt(observed.query.sourceRevision))
            const waiting = eligible.filter(item => !ready.includes(item))
            next = explainPending(next, waiting, 'source-lag')
            const echoedCurrent = echoes.some(item => item.entry.event.sourceRevision === observed.query.sourceRevision)
            if (BigInt(observed.query.sourceRevision) <= BigInt(active.handledRevision) || echoedCurrent) {
              const existing = next.automationOccurrences.find(item => item.occurrenceKey === kivoAutomationClaimKey(active.id, observed.query))
              next = settleTargets(next, ready, existing?.id ?? null, existing ? null : 'already-handled')
              if (echoedCurrent && BigInt(observed.query.sourceRevision) > BigInt(active.handledRevision)) next = { ...next, automationRules: replaceById(next.automationRules, { ...active, handledRevision: observed.query.sourceRevision }) }
              return next
            }
            // A future event remains pending until the current GET reaches its revision.
            if (eligible.length && !ready.length || !reconcile && !ready.length && !echoes.length) return next
            const event = ready.sort((a, b) => BigInt(a.entry.event.sourceRevision) < BigInt(b.entry.event.sourceRevision) ? -1 : 1).at(-1)?.entry.event
            const accepted = admit(next, active, { occurrenceKey: kivoAutomationClaimKey(active.id, observed.query), scheduledDate: null,
              event: event ? projectEvent(event) : null, observed, now: timestamp(clock()) })
            admission = accepted.admission
            next = settleTargets(accepted.state, ready, admission.occurrence.id, null)
            return { ...next, automationRules: replaceById(next.automationRules, { ...active, handledRevision: observed.query.sourceRevision }) }
          }, { beforeCommit: () => observedSourceCurrent(rule, observed, ownerCheck) })
          if (admission) outcomes.push(await dispatchAdmission(admission, ownerCheck))
        } catch (error) {
          if (error?.code === 'OWNER_LOCK_LOST') throw error
          if (hardRevocation(error)) await pauseForRevocation(rule, error, ownerCheck)
          else if (!['INVALID_STATE', 'REVISION_CONFLICT'].includes(error?.code)) await noteReadFailure(rule, error, ownerCheck)
        }
      }
      return outcomes
    },

    async acceptDailyOccurrence({ ruleId, scheduledDate, scheduledAt, ownerCheck } = {}) {
      const state = await store.read(), rule = state.automationRules.find(item => item.id === text(ruleId))
      if (!rule) throw serviceError('NOT_FOUND', '自动规则不存在')
      requireCurrentRule(rule)
      const key = dailyOccurrenceKey(ruleId, scheduledDate)
      if (rule.trigger.kind !== 'daily-time') throw serviceError('INVALID_REQUEST', '该规则不是每日规则')
      return acceptCurrent(rule, { occurrenceKey: key, scheduledDate, scheduledAt, ownerCheck })
    },
    async acceptManualOccurrence(actor, id, input = {}) {
      const state = await store.read(), member = requireMember(state, actor), rule = ownedRule(state, member, id)
      requireCurrentRule(rule)
      exactInput(input, ['expectedRevision', 'clientRequestId', 'ownerCheck'])
      const key = `${required(id, 'ruleId')}:manual:${requestId(input.clientRequestId)}`
      const existing = state.automationOccurrences.find(item => item.occurrenceKey === key)
      if (existing) return occurrenceAdmission(existing, state)
      requireRevision(rule, input.expectedRevision)
      return acceptCurrent(rule, { occurrenceKey: key, scheduledDate: null, ownerCheck: input.ownerCheck, expectedRevision: input.expectedRevision })
    },
  }
  return service

  async function activate(actor, id, input, from) {
    exactInput(input, ['expectedRevision'])
    const state = await store.read(), member = requireMember(state, actor), rule = ownedRule(state, member, id)
    requireRevision(rule, input.expectedRevision)
    if (rule.status !== from) throw serviceError('INVALID_STATE', '规则当前不可启用或恢复')
    requireCurrentRule(rule)
    if (deriveUsedRuns(rule, state.automationOccurrences) >= rule.maxRuns) throw serviceError('BUDGET_EXHAUSTED', '规则累计预算已用尽')
    const observed = await currentRecord(rule, { baseline: true })
    let activated
    await store.update(state => {
      const member = requireMember(state, actor), current = ownedRule(state, member, id)
      requireRevision(current, input.expectedRevision)
      if (current.status !== from) throw serviceError('INVALID_STATE', '规则状态已变化')
      validateObservedBinding(state, current, observed)
      if (current.objectId !== null && current.objectId !== observed.query.objectId) throw serviceError('FORBIDDEN', '规则目标单据身份已变化，请新建草稿')
      if (current.handledRevision !== null && BigInt(observed.query.sourceRevision) < BigInt(current.handledRevision)) throw serviceError('INVALID_SOURCE', '当前单据版本低于已处理版本')
      const now = timestamp(clock())
      activated = { ...current, status: 'active', revision: current.revision + 1, activationId: current.revision + 1,
        objectId: observed.query.objectId, baselineRevision: observed.query.sourceRevision, handledRevision: observed.query.sourceRevision,
        effectiveFrom: current.trigger.kind === 'daily-time' ? now : null, updatedAt: now, pauseReason: null }
      return { ...state, automationRules: replaceById(state.automationRules, activated) }
    }, { beforeCommit: () => observedSourceCurrent(rule, observed) })
    return projectRule(await store.read(), activated, clock())
  }

  async function deactivate(actor, id, input, to) {
    exactInput(input, ['expectedRevision'])
    let updated
    await store.update(state => {
      const member = requireMember(state, actor), rule = ownedRule(state, member, id)
      requireRevision(rule, input.expectedRevision)
      if (to === 'paused' ? rule.status !== 'active' : !['draft', 'active', 'paused'].includes(rule.status)) throw serviceError('INVALID_STATE', '规则当前不可暂停或撤销')
      const now = timestamp(clock())
      updated = { ...rule, status: to, revision: rule.revision + 1, updatedAt: now, ...(to === 'revoked' ? { revokedAt: now, eventAcceptAfter: null } : {}) }
      const next = endRuleTargets({ ...state, automationRules: replaceById(state.automationRules, updated) }, rule.id, 'activation-ended')
      return invalidateAutomationNotifications(next, rule.id, now)
    })
    return projectRule(await store.read(), updated, clock())
  }

  async function currentRecord(rule, { baseline = false, ownerCheck } = {}) {
    checkOwner(ownerCheck)
    const initial = await store.read(), current = currentRule(initial, rule, baseline)
    const member = requireMember(initial, { id: current.ownerMemberId }), binding = validateBinding(initial, member, current, connectionCatalog)
    const snapshot = connectionSnapshot(binding.connection)
    const sources = current.trigger.kind === KIVO_EVENT_TRIGGER ? await readEventSources() : null
    if (sources) requireSource(sources, current, binding.connection, eventSourceReady)
    const authorize = async () => {
      checkOwner(ownerCheck)
      const state = await store.read(), next = currentRule(state, rule, baseline)
      const member = requireMember(state, { id: next.ownerMemberId }), bound = validateBinding(state, member, next, connectionCatalog)
      if (!isDeepStrictEqual(connectionSnapshot(bound.connection), snapshot)) throw serviceError('FORBIDDEN', '当前连接或密钥绑定已变化')
      if (sources) {
        const config = await readEventSources()
        if (config.sha256 !== sources.sha256) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源配置已变化')
        requireSource(config, next, bound.connection, eventSourceReady)
      }
      return { connection: bound.connection, secretRoot }
    }
    await authorize()
    const observation = await readCurrentRecord({ input: structuredClone(current.input), connection: binding.connection, secretRoot, authorize, traceId: `automation-read-${idFactory()}` })
    await authorize()
    assertTpmObservation(observation)
    const record = observation.records[0]
    if (observation.mode !== 'record' || observation.recordType !== rule.input.recordType || observation.status !== 'ok' || observation.records.length !== 1 || !record) throw serviceError('FORBIDDEN', '当前授权范围内没有该单据')
    if (record.reference !== rule.input.reference && record.id !== rule.input.reference || !uuid(record.id)
      || observation.source.sourceInstance !== snapshot.sourceInstance) throw serviceError('INVALID_SOURCE', '当前查询目标与规则不一致')
    if (!baseline && record.id !== rule.objectId) throw serviceError('FORBIDDEN', '当前单据身份已变化')
    const query = { sourceInstance: snapshot.sourceInstance, recordType: rule.input.recordType, objectId: record.id,
      sourceRevision: revisionString(record.facts.revision), queriedAt: observation.queriedAt }
    return { observation, record, query, snapshot, sourcesHash: sources?.sha256 }
  }

  function validateObservedBinding(state, rule, observed) {
    const member = requireMember(state, { id: rule.ownerMemberId }), binding = validateBinding(state, member, rule, connectionCatalog)
    if (!isDeepStrictEqual(connectionSnapshot(binding.connection), observed.snapshot)) throw serviceError('FORBIDDEN', '当前连接或密钥绑定已变化')
    return binding
  }

  async function observedSourceCurrent(rule, observed, ownerCheck) {
    checkOwner(ownerCheck)
    if (rule.trigger.kind !== KIVO_EVENT_TRIGGER) return
    const config = await readEventSources()
    if (config.sha256 !== observed.sourcesHash) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源配置已变化')
    requireSource(config, rule, observed.snapshot, eventSourceReady)
  }

  async function acceptCurrent(rule, { occurrenceKey, scheduledDate, scheduledAt, ownerCheck, expectedRevision }) {
    try {
      checkOwner(ownerCheck)
      const before = await store.read(), duplicate = before.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
      if (duplicate) return occurrenceAdmission(duplicate, before)
      const observed = await currentRecord(rule, { ownerCheck })
      await workService?.ensureReady?.()
      let admission
      await store.update(state => {
        checkOwner(ownerCheck)
        const active = currentRule(state, rule)
        if (expectedRevision !== undefined) requireRevision(active, expectedRevision)
        validateObservedBinding(state, active, observed)
        const existing = state.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
        if (existing) { admission = occurrenceAdmission(existing, state); return state }
        let reason
        if (scheduledAt !== undefined) {
          const scheduled = parseInstant(scheduledAt), now = parseInstant(clock()), effective = parseInstant(active.effectiveFrom)
          if (!scheduled || scheduled.toISOString() !== localDateTime(scheduledDate, active.trigger.time).toISOString() || !effective || scheduled < effective || now < scheduled) throw serviceError('INVALID_REQUEST', '自动发生时间无效')
          if (now - scheduled > 60_000) reason = 'missed-window'
        }
        const accepted = admit(state, active, { occurrenceKey, scheduledDate, observed, event: null, now: timestamp(clock()), reason })
        admission = accepted.admission
        return accepted.state
      }, { beforeCommit: () => observedSourceCurrent(rule, observed, ownerCheck) })
      return dispatchAdmission(admission, ownerCheck)
    } catch (error) {
      if (hardRevocation(error)) await pauseForRevocation(rule, error, ownerCheck)
      throw error
    }
  }

  function admit(state, rule, { occurrenceKey, scheduledDate, event, observed, now, reason = null }) {
    const existing = state.automationOccurrences.find(item => item.occurrenceKey === occurrenceKey)
    if (existing) return { state, admission: occurrenceAdmission(existing, state) }
    const prepared = reason ? null : workService?.prepareAutomationWork?.(state, rule, { occurrenceKey, acceptedAt: now, workId: `work-${idFactory()}`, executionId: `exec-${idFactory()}` })
    reason ??= !prepared?.ok ? 'auth-blocked' : deriveUsedRuns(rule, state.automationOccurrences) >= rule.maxRuns ? 'budget' : activeAutomationWorkCount(state, rule.id) ? 'overlap' : activeAutomationWorkCount(state) >= 2 ? 'capacity' : null
    const occurrence = { id: `occurrence-${idFactory()}`, occurrenceKey, ruleId: rule.id, ruleRevision: rule.revision, activationId: rule.activationId,
      scheduledDate, event, query: observed.query, workId: reason ? null : prepared.workId, status: reason ? reason === 'auth-blocked' ? 'blocked' : 'skipped' : null,
      reason, deliveryId: null, createdAt: now }
    const next = { ...state, works: reason ? state.works : [...state.works, prepared.work], automationOccurrences: [...state.automationOccurrences, occurrence] }
    return { state: next, admission: occurrenceAdmission(occurrence, next, false) }
  }

  async function dispatchAdmission(admission, ownerCheck) {
    if (!admission?.accepted || admission.deduplicated) return admission
    checkOwner(ownerCheck)
    try {
      await workService?.dispatchAutomationWork?.(admission.workId, admission.executionId, admission.acceptedAt, { ownerCheck })
      return { ...admission, dispatched: true }
    } catch (error) {
      return { ...admission, dispatched: false, dispatchError: { code: error?.code ?? 'INTERNAL_ERROR', message: '自动工作派发失败' } }
    }
  }

  async function finishInactiveTargets(id, ownerCheck) {
    await store.update(state => { checkOwner(ownerCheck); return endRuleTargets(state, id, 'activation-ended') })
  }
  async function pauseForRevocation(rule, error, ownerCheck) {
    await store.update(state => {
      checkOwner(ownerCheck)
      const current = state.automationRules.find(item => item.id === rule.id)
      if (!current || current.status !== 'active' || current.activationId !== rule.activationId) return state
      const now = timestamp(clock()), paused = { ...current, status: 'paused', revision: current.revision + 1, updatedAt: now,
        pauseReason: { code: error.code === 'UNAUTHORIZED' ? 'FORBIDDEN' : error.code, message: '当前授权已失效，请核对后恢复规则' } }
      return invalidateAutomationNotifications(endRuleTargets({ ...state, automationRules: replaceById(state.automationRules, paused) }, rule.id, 'authorization-revoked'), rule.id, now)
    })
  }
  async function noteReadFailure(rule, error, ownerCheck) {
    await store.update(state => {
      checkOwner(ownerCheck)
      const current = state.automationRules.find(item => item.id === rule.id)
      if (!current || current.status !== 'active' || current.activationId !== rule.activationId) return state
      return explainPending(state, pendingFor(state, current), error?.code === 'INVALID_SOURCE' ? 'source-invalid' : 'source-unavailable')
    })
  }
}

export function createAutomationRuntime({ store, automationService, workService, dataRoot, clock = () => new Date().toISOString(), timerFactory = setTimeout, clearTimer = clearTimeout, lockFactory = acquireAutomationOwner, onOwnerLost = async () => undefined, onError = () => undefined } = {}) {
  if (!store?.read || !automationService?.acceptDailyOccurrence || !workService?.ensureReady || !workService?.automationOwnerLost) throw new TypeError('automation runtime 依赖无效')
  if (typeof onOwnerLost !== 'function') throw new TypeError('onOwnerLost 无效')
  if (!isAbsolute(dataRoot) || resolve(dataRoot) === parse(resolve(dataRoot)).root) throw new TypeError('automation data root 无效')
  let owner, timer, tickPromise, nextReconcileAt
  let running = false, scheduleGeneration = 0, pendingWake = false

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
        nextReconcileAt = Date.parse(timestamp(clock()))
        await arm(scheduleGeneration)
      } catch (error) {
        running = false
        await owner.release().catch(() => undefined)
        owner = undefined
        throw error
      }
    },
    async close() { await stop(); await owner?.release(); owner = undefined },
    async stop() { await stop() },
    ownsLock() { return running },
    async checkNow(actor, id, input) {
      requireOwner()
      return automationService.acceptManualOccurrence(actor, id, { ...input, ownerCheck: () => running })
    },
    async acceptGearJobEvent(input) { requireOwner(); return automationService.acceptGearJobEvent(input) },
    async acceptKivoEvent(verified) {
      requireOwner()
      const result = await automationService.acceptKivoEvent(verified, { ownerCheck: () => running })
      // The durable receiver returns without waiting for the current-state GET or model.
      if (running && !result.deduplicated) { pendingWake = true; void wakePending().catch(onError) }
      return result
    },
    async refresh() {
      if (!running) return
      const generation = ++scheduleGeneration
      if (timer) clearTimer(timer)
      timer = undefined
      await tickPromise?.catch(() => undefined)
      if (running) await arm(generation)
    },
  }

  function requireOwner() { if (!running) throw serviceError('OWNER_NOT_RUNNING', '自动执行入口暂不可用') }
  async function stop() {
    running = false
    scheduleGeneration += 1
    pendingWake = false
    if (timer) clearTimer(timer)
    timer = undefined
    await tickPromise?.catch(() => undefined)
  }
  async function wakePending() {
    if (!running || tickPromise || !pendingWake) return
    pendingWake = false
    if (timer) clearTimer(timer)
    timer = undefined
    const generation = scheduleGeneration
    tickPromise = Promise.resolve().then(() => automationService.processPending?.({ ownerCheck: () => running })).catch(onError).finally(() => {
      tickPromise = undefined
      if (running) void (pendingWake ? wakePending() : arm(generation)).catch(onError)
    })
  }
  async function arm(generation = scheduleGeneration) {
    if (!running || generation !== scheduleGeneration || tickPromise || timer) return
    const state = await store.read()
    if (!running || generation !== scheduleGeneration || tickPromise || timer) return
    const now = Date.parse(timestamp(clock()))
    const rules = state.automationRules.filter(rule => rule.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY)
    const candidates = rules.map(rule => ({ rule, dueAt: nextDailyOccurrence(rule, new Date(now).toISOString(), state.automationOccurrences) }))
      .filter(item => item.dueAt).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.rule.id.localeCompare(b.rule.id))
    const needsReconcile = Boolean(automationService.processPending && (rules.some(rule => rule.status === 'active' && rule.trigger.kind === KIVO_EVENT_TRIGGER)
      || state.automationInbox?.some(entry => entry.targets.some(target => target.status === 'pending'))))
    if (!candidates.length && !needsReconcile) return
    const dailyAt = candidates.length ? Date.parse(candidates[0].dueAt) : Infinity
    const reconcileAt = needsReconcile ? nextReconcileAt ?? now + KIVO_RECONCILE_MS : Infinity
    const dueAt = Math.min(dailyAt, reconcileAt)
    timer = timerFactory(() => {
      if (!running || generation !== scheduleGeneration) return
      timer = undefined
      tickPromise = (async () => {
        const currentTime = Date.parse(timestamp(clock()))
        if (currentTime < dueAt) return
        if (reconcileAt <= currentTime) {
          nextReconcileAt = currentTime + KIVO_RECONCILE_MS
          try { await automationService.processPending({ ownerCheck: () => running, reconcile: true }) }
          finally {
            const finishedAt = Date.parse(timestamp(clock()))
            if (finishedAt >= nextReconcileAt) nextReconcileAt = finishedAt + KIVO_RECONCILE_MS
          }
        }
        for (const candidate of candidates.filter(item => Date.parse(item.dueAt) <= dueAt)) {
          if (!running) return
          const state = await store.read(), rule = state.automationRules.find(item => item.id === candidate.rule.id)
          if (!rule || rule.status !== 'active' || rule.trigger.kind !== 'daily-time') continue
          const scheduledDate = shanghaiDate(candidate.dueAt)
          if (localDateTime(scheduledDate, rule.trigger.time).toISOString() !== candidate.dueAt || Date.parse(rule.effectiveFrom) > Date.parse(candidate.dueAt)) continue
          await automationService.acceptDailyOccurrence({ ruleId: rule.id, scheduledDate, scheduledAt: candidate.dueAt, ownerCheck: () => running })
        }
      })().catch(onError).finally(() => {
        tickPromise = undefined
        if (running) void (pendingWake ? wakePending() : arm(generation)).catch(onError)
      })
    }, Math.max(0, dueAt - now))
    timer?.unref?.()
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
    const holder = spawnImpl('/bin/sh', ['-c', '/usr/bin/flock --nonblock --conflict-exit-code 73 3 || exit $?; printf ready; IFS= read -r _ || test "$?" -eq 1'], { stdio: ['pipe', 'pipe', 'ignore', descriptor] })
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
        holder.stdin.end()
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
  return { ...structuredClone(rule), capabilityId: rule.capabilityId ?? state.skills.find(item => item.id === rule.skillId)?.capabilityId ?? CAPABILITY_ID, retired: rule.capabilityId !== KIVO_TPM_RECORD_READ_CAPABILITY, usedRuns: deriveUsedRuns(rule, state.automationOccurrences), nextDueAt: rule.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY ? nextDailyOccurrence(rule, now, state.automationOccurrences) : null,
    eventTargets: state.automationInbox.flatMap(entry => entry.targets.filter(target => target.ruleId === rule.id).map(target => ({ eventId: entry.event.eventId, sourceId: entry.event.sourceId, sourceRevision: entry.event.sourceRevision, occurredAt: entry.event.occurredAt, acceptedAt: entry.acceptedAt, ...structuredClone(target), reasonText: reasonText(target.reason) }))) }
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

function activeAutomationWorkCount(state, ruleId) {
  const workIds = new Set(state.automationOccurrences.filter(item => (!ruleId || item.ruleId === ruleId) && item.workId).map(item => item.workId))
  return state.works.filter(work => workIds.has(work.id) && work.executions?.some(execution => ['accepted', 'running', 'cancel_requested'].includes(execution.status))).length
}

function invalidateAutomationNotifications(state, ruleId, timestamp) {
  const deliveryIds = new Set(state.automationOccurrences.filter(item => item.ruleId === ruleId && item.deliveryId).map(item => item.deliveryId))
  if (!deliveryIds.size) return state
  const kivoRule = state.automationRules.find(item => item.id === ruleId)?.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY
  return {
    ...state,
    deliveries: state.deliveries.map(delivery => {
      if (!deliveryIds.has(delivery.id) || !['pending', 'sending'].includes(delivery.status)) return delivery
      // The original transport owns in-flight settlement; revision gates still stop unsent I/O.
      if (kivoRule && delivery.status === 'sending') return delivery
      const unknown = delivery.status === 'sending'
      return { ...delivery, status: unknown ? 'unknown' : 'blocked', error: { code: unknown ? 'DELIVERY_UNKNOWN' : 'RULE_CHANGED', message: unknown ? '发送效果待核对' : '自动规则或通知目标已变化' }, updatedAt: timestamp }
    }),
  }
}

function ruleFields(state, member, input, connectionCatalog, sources) {
  const trigger = normalizeTrigger(input.trigger)
  const maxRuns = input.maxRuns === undefined ? 10 : input.maxRuns
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 10) throw serviceError('INVALID_REQUEST', '累计预算必须是 1 至 10 的整数')
  const parsed = validateCapabilityInput(KIVO_TPM_RECORD_READ_CAPABILITY, input.input)
  if (!parsed.ok || !KIVO_EVENT_RECORD_TYPES.includes(parsed.input.recordType)) throw serviceError('INVALID_REQUEST', '自动规则需要明确的维修、保养或点检单据')
  const fields = { employeeId: required(input.employeeId, 'employeeId'), skillId: required(input.skillId, 'skillId'), connectionId: required(input.connectionId, 'connectionId'),
    input: parsed.input, trigger, maxRuns, notificationIdentityId: input.notificationIdentityId === undefined ? null : nullableText(input.notificationIdentityId) }
  const binding = validateBinding(state, member, fields, connectionCatalog)
  if (trigger.kind === KIVO_EVENT_TRIGGER) requireSource(sources, fields, binding.connection)
  validateNotification(state, member, fields.notificationIdentityId)
  return fields
}

function validateBinding(state, member, value, connectionCatalog) {
  if (!member?.enabled || !member.employeeIds?.includes(value.employeeId)) throw serviceError('FORBIDDEN', '成员未获准使用该员工')
  const employee = state.employees.find(item => item.id === value.employeeId && item.enabled === true)
  const assigned = state.skills.find(item => item.id === value.skillId)
  if (getCapability(assigned?.capabilityId)?.retired) requireAutomationCapability()
  const skill = assigned?.enabled === true && assigned.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY && employee?.skillIds?.includes(assigned.id) ? assigned : null
  const route = state.modelRoutes.find(item => item.id === employee?.modelRouteId && item.enabled === true && item.provider === MODEL_PROVIDER && item.model === MODEL_ID && item.credentialRef === MODEL_CREDENTIAL)
  const connection = state.connections.find(item => item.id === value.connectionId && item.enabled === true && item.status === 'ready' && item.kind === 'kivo-mcp'
    && employee?.connectionIds?.includes(item.id) && item.skillIds?.includes(skill?.id) && item.allowedObjectIds?.length === 0)
  if (!employee || !skill || !route || !connection) throw serviceError('FORBIDDEN', '自动规则绑定未获准或当前不可用')
  try { assertTrustedConnection(connectionCatalog, connection); connectionSnapshot(connection) } catch { throw serviceError('FORBIDDEN', '连接目标未在主机可信目录登记') }
  const parsed = validateCapabilityInput(KIVO_TPM_RECORD_READ_CAPABILITY, value.input)
  if (!parsed.ok || !KIVO_EVENT_RECORD_TYPES.includes(parsed.input.recordType)) throw serviceError('INVALID_REQUEST', '自动规则目标无效')
  return { employee, skill, route, connection }
}

function requireSource(config, rule, connection, ready = () => true) {
  const source = config?.sources.find(item => item.id === rule.trigger.sourceId && item.enabled)
  if (!ready() || !source || source.connectionId !== connection.id || source.resource !== connection.baseUrl || source.sourceInstance !== connection.sourceInstance) throw serviceError('SOURCE_NOT_CONFIGURED', '事件来源与当前连接绑定不可用')
  return source
}
function requireCurrentRule(rule) { if (rule.capabilityId !== KIVO_TPM_RECORD_READ_CAPABILITY) requireAutomationCapability() }
function checkOwner(check) {
  if (check !== undefined && typeof check !== 'function') throw serviceError('INVALID_REQUEST', 'ownerCheck 无效')
  if (check && !check()) throw serviceError('OWNER_LOCK_LOST', '自动执行所有权已失效')
}
function currentRule(state, captured, baseline = false) {
  const rule = state.automationRules.find(item => item.id === captured.id)
  if (!rule || identityChanged(rule, captured) || (baseline ? rule.revision !== captured.revision || rule.status !== captured.status : rule.status !== 'active' || rule.activationId !== captured.activationId)) throw serviceError(baseline ? 'REVISION_CONFLICT' : 'INVALID_STATE', '规则状态或绑定已变化')
  return rule
}
function pendingFor(state, rule) {
  return state.automationInbox.flatMap(entry => entry.targets.filter(target => target.ruleId === rule.id && target.activationId === rule.activationId && target.status === 'pending').map(target => ({ entry, target })))
}
function settleTargets(state, selected, occurrenceId, reason) {
  const keys = new Set(selected.map(item => `${item.entry.id}\0${item.target.ruleId}\0${item.target.activationId}`))
  if (!keys.size) return state
  return { ...state, automationInbox: state.automationInbox.map(entry => ({ ...entry, targets: entry.targets.map(target => keys.has(`${entry.id}\0${target.ruleId}\0${target.activationId}`)
    ? { ...target, status: occurrenceId ? 'settled' : 'ignored', occurrenceId, reason } : target) })) }
}
function explainPending(state, selected, reason) {
  const keys = new Set(selected.map(item => `${item.entry.id}\0${item.target.ruleId}\0${item.target.activationId}`))
  if (!keys.size) return state
  return { ...state, automationInbox: state.automationInbox.map(entry => ({ ...entry, targets: entry.targets.map(target => keys.has(`${entry.id}\0${target.ruleId}\0${target.activationId}`) ? { ...target, reason } : target) })) }
}
function endRuleTargets(state, ruleId, reason) {
  const selected = state.automationInbox?.flatMap(entry => entry.targets.filter(target => target.ruleId === ruleId && target.status === 'pending').map(target => ({ entry, target }))) ?? []
  return settleTargets(state, selected, null, reason)
}
function hardRevocation(error) { return ['FORBIDDEN', 'UNAUTHORIZED', 'SOURCE_NOT_CONFIGURED', 'CAPABILITY_RETIRED'].includes(error?.code) }
function projectEvent(event) { return { sourceId: event.sourceId, eventId: event.eventId, sourceRevision: event.sourceRevision, occurredAt: event.occurredAt } }
function isActionEcho(state, event, observed) {
  if (event.recordType !== 'repair' || observed.record.id !== event.objectId) return false
  return state.works.some(work => work.actions?.some(action => {
    const target = action.preview?.target
    return action.id === event.traceId && action.intent?.kind === 'kivo.tpm.repair.create' && action.attempt && !action.attempt.noEffectAt
      && target?.resource === event.resource && target.sourceInstance === event.sourceInstance && target.recordType === 'repair'
      && target.orderNo === observed.record.reference && (!action.receipt || action.receipt.upstreamRecordId === event.objectId)
  }))
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function reasonText(reason) {
  return ({ budget: '累计预算已用尽', overlap: '本规则已有工作进行中', capacity: '自动工作并发已满', 'auth-blocked': '当前授权不可用',
    'missed-window': '已错过本次定时窗口', 'source-lag': '当前单据版本尚未到达事件版本', 'revision-regressed': '当前版本低于已处理版本',
    'source-invalid': '来源结果暂不可核实', 'source-unavailable': '来源暂不可达，等待下次核对', 'already-handled': '当前版本已核对',
    'activation-ended': '规则已暂停、恢复或撤销', 'authorization-revoked': '当前授权已撤销', echo: '已确认是本系统动作回声', 'restore-suppressed': '恢复后须重新启用规则' })[reason] ?? null
}

function validateNotification(state, member, id) {
  if (id === null) return
  const identity = state.channelIdentities.find(item => item.id === id)
  const app = identity && state.channelApps.find(item => item.id === identity.channelAppId)
  const endpoints = state.channelConversations.filter(item => item.identityId === id && item.channelAppId === app?.id && item.type === 'private' && item.memberId === member.id && item.status === 'active')
  if (!identity || identity.status !== 'active' || identity.memberId !== member.id || endpoints.length !== 1
    || !app || app.enabled !== true || app.status !== 'active') throw serviceError('FORBIDDEN', '通知身份必须是本人已验证私聊')
}

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw serviceError('INVALID_REQUEST', 'trigger 无效')
  if (typeof trigger.kind !== 'string' || !trigger.kind.trim()) throw serviceError('INVALID_REQUEST', 'trigger kind 无效')
  if (trigger.kind === 'daily-time') {
    if (Object.keys(trigger).sort().join(',') !== 'kind,time,timeZone') throw serviceError('INVALID_REQUEST', 'trigger 字段无效')
    if (typeof trigger.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) || trigger.timeZone !== 'Asia/Shanghai') throw serviceError('INVALID_REQUEST', '每日触发时间无效')
    return { kind: trigger.kind, time: trigger.time, timeZone: trigger.timeZone }
  }
  if (trigger.kind === KIVO_EVENT_TRIGGER) {
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
function requireAutomationCapability() {
  if (getCapability(CAPABILITY_ID).retired) throw serviceError('CAPABILITY_RETIRED', '旧来源已停止新执行，可查看历史记录')
}
function identityChanged(rule, fields) { return ['employeeId', 'skillId', 'connectionId'].some(key => rule[key] !== fields[key]) || !isDeepStrictEqual(rule.input, fields.input) || rule.trigger.kind !== fields.trigger.kind || rule.trigger.sourceId !== fields.trigger.sourceId }
function timestamp(value) { const result = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : ''; if (!result || !Number.isFinite(Date.parse(result))) throw serviceError('INTERNAL_ERROR', '时钟无效'); return result }
function required(value, label) { const result = text(value); if (!result) throw serviceError('INVALID_REQUEST', `${label} 无效`); return result }
function nullableText(value) { if (value === null) return null; return required(value, 'notificationIdentityId') }
function requestId(value) { const result = required(value, 'clientRequestId'); if (!/^[A-Za-z0-9._-]{1,128}$/.test(result)) throw serviceError('INVALID_REQUEST', 'clientRequestId 无效'); return result }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function serviceError(code, message) { return new AutomationServiceError(code, message) }
function parseInstant(value) { const time = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return time && Number.isFinite(time.getTime()) ? time : null }
function shifted(date) { return new Date(date.getTime() + ZONE_OFFSET_MS) }
function dateOnly(date) { return date.toISOString().slice(0, 10) }
function shanghaiDate(value) { const instant = parseInstant(value); if (!instant) throw serviceError('INVALID_REQUEST', '自动发生时间无效'); return dateOnly(shifted(instant)) }
function localDateTime(localDate, time) { return new Date(Date.parse(`${localDate}T${time}:00.000Z`) - ZONE_OFFSET_MS) }
function isDateOnly(value) { if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return date.toISOString().slice(0, 10) === value }
