import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { getCapability, listCapabilities, validateCapabilityInput, KIVO_TPM_RECORD_READ_CAPABILITY, WORK_ORDER_DEVICE_CORRELATION_CAPABILITY } from './capabilities.mjs'
import { createObservation } from './domain/work-order.mjs'
import { KIVO_TPM_RESULT_KIND } from './domain/tpm.mjs'
import { assertTrustedConnection, CONNECTION_IDENTITY_FIELDS } from './connection-catalog.mjs'
import { connectionInputAllowed, connectionSnapshot, correlationMappingContext } from './execution-grant.mjs'
import { currentKnowledgeReference, sweepKnowledgeDependencies } from './knowledge-service.mjs'

export const ERROR_STATUS = {
  INVALID_REQUEST: 400, INVALID_INPUT: 400, UNDECLARED_INPUT: 400, MISSING_INPUT: 400,
  INVALID_WORK_ORDER_ID: 400, MISSING_AVAILABLE_SECONDS: 400, MISSING_QUANTITY: 400,
  INVALID_AVAILABLE_SECONDS_TYPE: 400, INVALID_QUANTITY_TYPE: 400, NON_FINITE_AVAILABLE_SECONDS: 400,
  NON_FINITE_QUANTITY: 400, NEGATIVE_AVAILABLE_SECONDS: 400, NON_POSITIVE_QUANTITY: 400,
  NON_FINITE_RESULT: 400, CAPABILITY_NOT_FOUND: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, BUSY: 409, SOURCE_NOT_CONFIGURED: 503, MODEL_NOT_CONFIGURED: 503,
  UPSTREAM_TIMEOUT: 504, UPSTREAM_ERROR: 502, INVALID_SOURCE: 502,
  REVISION_CONFLICT: 409, CAPACITY_EXCEEDED: 400, BUDGET_EXHAUSTED: 409, CAPABILITY_RETIRED: 409,
  KNOWLEDGE_PLUGIN_DISABLED: 503, KNOWLEDGE_REFERENCE_INVALID: 409,
}

const ACTIVE_EXECUTION = new Set(['accepted', 'running', 'cancel_requested'])
const TERMINAL_EXECUTION = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const CONTINUABLE_WORK = new Set(['waiting_input', 'failed', 'interrupted', 'cancelled'])
const CONFIG_KINDS = new Set(['employees', 'connections', 'skills', 'modelRoutes'])
const ZENMUX_PROVIDER = 'zenmux'
const ZENMUX_MODEL = 'deepseek/deepseek-v4.1-flash'
const SAFE_ERROR_MESSAGES = Object.freeze({
  SOURCE_NOT_CONFIGURED: '连接凭据不可用或连接未配置',
  UPSTREAM_TIMEOUT: '来源读取超时',
  MODEL_NOT_CONFIGURED: '模型路由不可用',
  UPSTREAM_ERROR: '来源读取失败',
  INVALID_SOURCE: '来源数据无效',
  PROCESS_SHUTDOWN: '进程关闭时未完成',
  PROCESS_RESTARTED: '进程重启时未完成',
  BACKUP_INTERRUPTED: '备份操作被中断',
  TOOL_CHAIN_INVALID: '模型工具结果无效',
  BUDGET_EXHAUSTED: '协作模型请求预算已耗尽',
  KNOWLEDGE_PLUGIN_DISABLED: '知识能力已停用',
  KNOWLEDGE_REFERENCE_INVALID: '知识引用无效或已失效',
  CANCELLED: '本次执行已停止',
  FORBIDDEN: '执行授权已失效',
  CAPABILITY_RETIRED: '旧来源已停止新执行，可查看历史记录',
  NOT_FOUND: '业务对象不存在',
  INVALID_REQUEST: '请求参数无效',
})
const GENERIC_ERROR = Object.freeze({ code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求' })

export function recoverActionFacts(state, at) {
  let changed = false
  const works = state.works.map(work => {
    let workChanged = false
    const actions = work.actions.map(action => {
      if (action.receipt || action.attempt?.unknownAt || action.attempt?.noEffectAt) return action
      if (action.attempt) {
        changed = workChanged = true
        return { ...action, attempt: { ...action.attempt, unknownAt: at, unknownReason: 'RECOVERY_UNKNOWN' } }
      }
      if (action.decision?.kind === 'approved' && !action.decision.invalidatedAt) {
        changed = workChanged = true
        return { ...action, decision: { ...action.decision, invalidatedAt: at, invalidationReason: 'RECOVERY_INVALIDATED' } }
      }
      return action
    })
    return workChanged ? { ...work, actions } : work
  })
  return changed ? { ...state, works } : state
}

export function createWorkService({ store, runner = null, collaborationRunner = null, clock = () => new Date().toISOString(), policyPaths = {}, connectionTester = null, connectionCatalog = [], idFactory = randomUUID, onAutomationTerminal } = {}) {
  if (!store) throw new Error('store is required')
  const active = new Map()
  let recovered = false
  let recoveryPromise

  return {
    async ensureReady() {
      await recover()
    },

    prepareAutomationWork(state, rule, options = {}) {
      return prepareAutomationWork(state, rule, options)
    },

    async dispatchAutomationWork(workId, executionId, acceptedAt, options = {}) {
      await recover()
      const state = await store.read()
      const work = state.works.find(item => item.id === workId)
      if (work) requireExecutableWork(state, work)
      try {
        if (options.ownerCheck && !options.ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效')
        const accepted = parseInstant(acceptedAt)
        if (!accepted) throw serviceError('INVALID_REQUEST', '自动工作 acceptedAt 无效')
        const deadlineAt = new Date(accepted.getTime() + 120_000).toISOString()
        schedule(workId, executionId, 'automation', undefined, { deadlineAt, ownerCheck: options.ownerCheck })
        return { workId, executionId, acceptedAt, deadlineAt }
      } catch (error) {
        if (error?.code !== 'OWNER_LOCK_LOST') await finishError(workId, executionId, error)
        throw error
      }
    },

    async automationOwnerLost() {
      const tasks = [...active.values()].filter(item => item.operation === 'automation')
      for (const item of tasks) {
        item.ownerLost = true
        item.controller.abort(serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效'))
      }
      await Promise.all(tasks.map(cancelRunner))
      await Promise.all(tasks.map(item => item.promise.catch(() => undefined)))
    },

    async bootstrap(actor) {
      await recover()
      const state = await store.read()
      const member = requireMember(state, actor)
      const employeeIds = new Set(member.employeeIds)
      const employees = state.employees.filter(item => employeeIds.has(item.id))
      const skillIds = new Set(employees.flatMap(item => item.skillIds ?? []))
      const connectionIds = new Set(employees.flatMap(item => item.connectionIds ?? []))
      return {
        member: publicMember(member),
        employees,
        connections: state.connections.filter(item => connectionIds.has(item.id)).map(item => publicConnection(item, connectionCatalog)),
        skills: state.skills.filter(item => skillIds.has(item.id)),
        capabilities: listCapabilities().filter(item => member.role === 'admin' || state.skills.some(skill => skillIds.has(skill.id) && skill.enabled === true && skill.capabilityId === item.id)).map(publicCapability),
        works: state.works.filter(item => item.ownerMemberId === member.id).map(item => publicWork(state, member, item)),
      }
    },

    async createWork(actor, body = {}) {
      await recover()
      const requestId = clean(body.clientRequestId) ?? `request-${randomUUID()}`
      let reservation
      await store.update(state => {
        const member = requireMember(state, actor)
        const key = reservationKey(member.id, 'create', requestId)
        if (state.reservations[key]) {
          reservation = { deduplicated: true, ...state.reservations[key] }
          return state
        }
        const binding = authorizedBinding(state, member, body, connectionCatalog)
        if (!binding.ok) {
          reservation = { error: binding }
          return state
        }
        if (binding.capability.retired) { reservation = { error: failure('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED) }; return state }
        const parsed = parseInput(binding.capability.id, requestInput(body, binding.capability), true)
        if (!parsed.ok) {
          reservation = { error: parsed }
          return state
        }
        if (!inputAllowed(binding, parsed.input, parsed.missing.length > 0)) {
          reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }
          return state
        }
        const now = clock()
        const workId = `work-${randomUUID()}`
        const conversationId = conversationBinding(state, member, binding.employee.id, body.conversationId)
        const work = {
          id: workId, ownerMemberId: member.id, employeeId: binding.employee.id, skillId: binding.skill.id,
          conversationId,
          capabilityId: binding.capability.id, ...workConnectionFields(binding),
          goal: clean(body.goal) ?? binding.capability.action, input: parsed.input, requiredInputs: parsed.missing,
          status: parsed.missing.length ? 'waiting_input' : 'accepted', acceptedAt: now, results: [], actions: [], executions: [],
        }
        let executionId
        if (!parsed.missing.length) {
          executionId = `exec-${randomUUID()}`
          work.executions.push(newExecution(executionId, 'create', requestId, parsed.input, now))
        }
        reservation = { workId, executionId, work }
        return { ...state, works: [...state.works, work], reservations: { ...state.reservations, [key]: compact({ workId, executionId }) } }
      })
      if (reservation?.error) return reservation.error
      const work = reservation.work ?? await ownedWork(actor, reservation.workId)
      if (!work) return failure('NOT_FOUND', '工作不存在')
      if (!reservation.deduplicated && reservation.executionId) schedule(work.id, reservation.executionId, 'create')
      return success(await projectOwned(actor, work), reservation)
    },

    async createCollaboration(actor, body = {}) {
      await recover()
      const requestId = clean(body.clientRequestId) ?? `collaboration-${randomUUID()}`
      let reservation
      await store.update(state => {
        const member = requireMember(state, actor)
        const key = reservationKey(member.id, 'collaboration', requestId)
        if (state.reservations[key]) { reservation = { deduplicated: true, ...state.reservations[key] }; return state }
        if (!collaborationRunner) { reservation = { error: failure('MODEL_NOT_CONFIGURED', '协作运行时未配置') }; return state }
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 4) { reservation = { error: failure('INVALID_REQUEST', '协作计划需要 1 至 4 项') }; return state }
        const leader = authorizedBinding(state, member, body, connectionCatalog)
        if (!leader.ok) { reservation = { error: leader }; return state }
        if (leader.capability.retired) { reservation = { error: failure('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED) }; return state }
        const goal = clean(body.goal)
        if (!goal || goal.length > 4000) { reservation = { error: failure('INVALID_REQUEST', '协作目标无效') }; return state }
        const conversationId = conversationBinding(state, member, leader.employee.id, body.conversationId)
        const now = clock(), rootWorkId = `work-${randomUUID()}`, generation = 1
        const childWorks = [], planItems = [], itemIds = new Set()
        for (const raw of body.items) {
          const itemId = clean(raw?.id) ?? `item-${randomUUID()}`
          if (itemIds.has(itemId)) { reservation = { error: failure('INVALID_REQUEST', '协作计划项 ID 重复') }; return state }
          itemIds.add(itemId)
          const binding = authorizedBinding(state, member, raw ?? {}, connectionCatalog)
          if (!binding.ok) { reservation = { error: binding }; return state }
          if (binding.capability.retired) { reservation = { error: failure('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED) }; return state }
          const parsed = parseInput(binding.capability.id, requestInput(raw, binding.capability), true)
          if (!parsed.ok) { reservation = { error: parsed }; return state }
          if (!inputAllowed(binding, parsed.input, parsed.missing.length > 0)) { reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }; return state }
          const childWorkId = `work-${randomUUID()}`, executionId = `exec-${randomUUID()}`
          const itemGoal = clean(raw.goal) ?? binding.capability.action
          const knowledgeQuery = raw.knowledgeQuery === undefined ? undefined : validKnowledgeQuery(raw.knowledgeQuery)
          const waiting = parsed.missing.length > 0
          childWorks.push({
            id: childWorkId, ownerMemberId: member.id, employeeId: binding.employee.id, skillId: binding.skill.id,
            capabilityId: binding.capability.id, ...workConnectionFields(binding),
            goal: itemGoal, input: parsed.input, requiredInputs: parsed.missing, status: waiting ? 'waiting_input' : 'accepted', acceptedAt: now, results: [], actions: [],
            executions: waiting ? [] : [{ ...newExecution(executionId, 'collaboration-child', requestId, parsed.input, now), generation, cancelGeneration: 0, planRevision: 1, employeeId: binding.employee.id }],
            workType: 'collaboration-child', parentWorkId: rootWorkId, rootWorkId, collaborationGeneration: generation, planItemId: itemId,
            ...(knowledgeQuery ? { knowledgeQuery } : {}),
          })
          planItems.push({ id: itemId, childWorkId, goal: itemGoal, employeeId: binding.employee.id, status: waiting ? 'waiting_input' : 'not_started', dependsOn: raw.dependsOn ?? [] })
        }
        if (planItems.some(item => !stringIds(item.dependsOn) || item.dependsOn.some(id => !itemIds.has(id) || id === item.id)) || hasDependencyCycle(planItems)) { reservation = { error: failure('INVALID_REQUEST', '协作计划依赖无效') }; return state }
        const rootExecutionId = `exec-${randomUUID()}`
        const rootWork = {
          id: rootWorkId, ownerMemberId: member.id, employeeId: leader.employee.id, skillId: leader.skill.id,
          conversationId,
          capabilityId: leader.capability.id, ...workConnectionFields(leader),
          goal, input: {}, requiredInputs: [], status: 'accepted', acceptedAt: now, results: [], actions: [],
          executions: [{ ...newExecution(rootExecutionId, 'collaboration-root', requestId, {}, now), generation, cancelGeneration: 0, planRevision: 1, employeeId: leader.employee.id }],
          workType: 'collaboration', collaboration: { generation, cancelGeneration: 0, status: 'accepted', requestLimit: 12, requestCount: 0, childLimit: 4, maxConcurrentChildren: 2, rootTimeoutMs: 360_000, childTimeoutMs: 120_000, outputMaxTokens: 4096, childWorkIds: childWorks.map(work => work.id), summaryResultRefs: [], staleKnowledgeRefs: [], staleItemIds: [] },
          plan: { revision: 1, items: planItems }, handoffs: [],
        }
        reservation = { workId: rootWorkId, executionId: rootExecutionId, work: rootWork }
        return { ...state, works: [...state.works, rootWork, ...childWorks], reservations: { ...state.reservations, [key]: { workId: rootWorkId, executionId: rootExecutionId } } }
      })
      if (reservation?.error) return reservation.error
      if (!reservation.deduplicated) void collaborationRunner.run(reservation.workId).catch(() => undefined)
      const work = reservation.work ?? await ownedWork(actor, reservation.workId)
      return success(await projectOwned(actor, work), reservation)
    },

    async updateCollaborationPlan(actor, id, body = {}) {
      await recover()
      let updated
      await store.update(state => {
        const member = requireMember(state, actor), work = findOwned(state, member, id)
        if (!work?.collaboration) throw serviceError('NOT_FOUND', '协作工作不存在')
        requireExecutableWork(state, work)
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== work.plan.revision) throw serviceError('BUSY', '工作计划 revision 已变化')
        if (!Array.isArray(body.items) || !body.items.length) throw serviceError('INVALID_REQUEST', '计划修改为空')
        const changes = new Map()
        for (const change of body.items) {
          const itemId = clean(change?.id), goal = change?.goal === undefined ? undefined : clean(change.goal), employeeId = change?.employeeId === undefined ? undefined : clean(change.employeeId)
          if (!itemId || changes.has(itemId) || (goal === undefined && employeeId === undefined) || (change?.goal !== undefined && (!goal || goal.length > 4000)) || (change?.employeeId !== undefined && !employeeId)) throw serviceError('INVALID_REQUEST', '计划修改无效')
          changes.set(itemId, { goal, employeeId })
        }
        const childChanges = new Map()
        const items = work.plan.items.map(item => {
          if (!changes.has(item.id)) return item
          const change = changes.get(item.id), child = state.works.find(candidate => candidate.id === item.childWorkId)
          const editable = item.status === 'not_started'
            ? child?.status === 'accepted' && child.executions.every(execution => execution.status === 'accepted')
            : item.status === 'waiting_input' && child?.status === 'waiting_input' && child.executions.length === 0
          if (!editable) throw serviceError('BUSY', '只能修改未执行计划项')
          let employeeId = item.employeeId
          const binding = authorizedBinding(state, member, { ...child, employeeId: change.employeeId ?? employeeId }, connectionCatalog)
          if (!binding.ok) throw serviceError(binding.error.code, binding.error.message)
          if (!inputAllowed(binding, child.input, child.status === 'waiting_input')) throw serviceError('FORBIDDEN', '业务对象不在当前连接允许范围内')
          employeeId = binding.employee.id
          childChanges.set(child.id, { goal: change.goal ?? item.goal, employeeId })
          return { ...item, goal: change.goal ?? item.goal, employeeId }
        })
        if ([...changes.keys()].some(itemId => !items.some(item => item.id === itemId))) throw serviceError('INVALID_REQUEST', '计划项不存在')
        updated = { ...work, plan: { revision: work.plan.revision + 1, items } }
        const nextRevision = updated.plan.revision
        return { ...state, works: state.works.map(item => {
          if (item.id === work.id) return updated
          const change = childChanges.get(item.id)
          return change ? { ...item, ...change, executions: item.executions.map(execution => execution.status === 'accepted' ? { ...execution, employeeId: change.employeeId, planRevision: nextRevision } : execution) } : item
        }) }
      })
      return { ok: true, value: await projectOwned(actor, updated) }
    },

    async continueCollaboration(actor, id, body = {}) { return successorCollaboration(actor, id, body, false) },
    async recheckCollaboration(actor, id, body = {}) { return successorCollaboration(actor, id, body, true) },

    async getWork(actor, id) {
      await recover()
      const work = await ownedWork(actor, id)
      return work ? { ok: true, value: await projectOwned(actor, work) } : failure('NOT_FOUND', '工作不存在')
    },

    async continueWork(actor, id, body = {}) {
      await recover()
      const requestId = clean(body.clientRequestId) ?? `continue-${randomUUID()}`
      let reservation
      await store.update(state => {
        const member = requireMember(state, actor)
        const work = findOwned(state, member, id)
        if (work) requireExecutableWork(state, work)
        if (!work) {
          reservation = { error: failure('NOT_FOUND', '工作不存在') }
          return state
        }
        const currentExecution = activeExecution(work)
        if (currentExecution) {
          reservation = { workId: id, executionId: currentExecution.id, deduplicated: true, active: true }
          return state
        }
        const key = reservationKey(member.id, id, 'continue', requestId)
        if (state.reservations[key]) {
          reservation = { deduplicated: true, ...state.reservations[key] }
          return state
        }
        if (!CONTINUABLE_WORK.has(work.status)) {
          reservation = { error: failure('BUSY', '当前工作状态不可继续') }
          return state
        }
        const binding = authorizedBinding(state, member, work, connectionCatalog)
        if (!binding.ok) {
          reservation = { error: binding }
          return state
        }
        const supplied = body.input ?? requestInput(body, binding.capability)
        if (!plainObject(supplied)) {
          reservation = { error: failure('INVALID_INPUT', '能力输入必须是对象') }
          return state
        }
        const parsed = parseInput(work.capabilityId, { ...(work.input ?? {}), ...supplied }, true)
        if (!parsed.ok) {
          reservation = { error: parsed }
          return state
        }
        if (!inputAllowed(binding, parsed.input, parsed.missing.length > 0)) {
          reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }
          return state
        }
        const now = clock()
        if (parsed.missing.length) {
          const nextWork = { ...work, input: parsed.input, requiredInputs: parsed.missing, status: 'waiting_input' }
          reservation = { workId: id, work: nextWork }
          return { ...state, works: replaceById(state.works, nextWork) }
        }
        const executionId = `exec-${randomUUID()}`
        const nextWork = { ...work, input: parsed.input, requiredInputs: [], status: 'accepted', executions: [...work.executions, newExecution(executionId, 'continue', requestId, parsed.input, now)] }
        reservation = { workId: id, executionId, work: nextWork }
        return { ...state, works: replaceById(state.works, nextWork), reservations: { ...state.reservations, [key]: { workId: id, executionId } } }
      })
      if (reservation?.error) return reservation.error
      const work = reservation.work ?? await ownedWork(actor, reservation.workId)
      if (!work) return failure('NOT_FOUND', '工作不存在')
      if (!reservation.deduplicated && reservation.executionId) schedule(id, reservation.executionId, 'continue')
      return success(await projectOwned(actor, work), reservation)
    },

    async refreshWork(actor, id, body = {}) { return reserveExisting(actor, id, 'refresh', body, { requireResult: true }) },

    async followUp(actor, id, textValue, body = {}) {
      const question = clean(textValue)
      if (!question || question.length > 4000) return failure('INVALID_REQUEST', '追问内容为空或过长')
      return reserveExisting(actor, id, 'follow-up', body, { question, requireResult: true })
    },

    async cancel(actor, id) {
      await recover()
      const candidate = await ownedWork(actor, id)
      if (candidate?.collaboration) {
        const accepted = await collaborationRunner?.cancel(id, 'user')
        const value = await ownedWork(actor, id)
        return { ok: true, value: await projectOwned(actor, value), accepted: Boolean(accepted) }
      }
      let executionId
      let current
      await store.update(state => {
        const member = requireMember(state, actor)
        const work = findOwned(state, member, id)
        if (!work) {
          current = { error: failure('NOT_FOUND', '工作不存在') }
          return state
        }
        const execution = activeExecution(work)
        if (!execution) {
          current = { value: work, accepted: false }
          return state
        }
        executionId = execution.id
        const nextExecution = { ...execution, status: 'cancel_requested', cancelRequestedAt: clock() }
        const nextWork = { ...work, status: 'cancel_requested', executions: replaceById(work.executions, nextExecution) }
        current = { value: nextWork, accepted: true }
        return { ...state, works: replaceById(state.works, nextWork) }
      })
      if (current?.error) return current.error
      if (executionId) {
        const entry = active.get(executionId)
        if (entry) {
          entry.userCancelled = true
          entry.controller.abort(cancelledError())
        }
        if (entry?.deadlineAt) await entry.promise?.catch(() => undefined)
        else await runner?.cancel?.(executionId)
      }
      return { ok: true, value: await projectOwned(actor, current.value), accepted: current.accepted }
    },

    async listConfirmations(actor) {
      const state = await store.read()
      const member = requireMember(state, actor)
      return state.confirmations.filter(item => item.ownerMemberId === member.id)
    },

    async createConfirmation(actor, body = {}) {
      let created
      await store.update(state => {
        const member = requireMember(state, actor)
        const employee = state.employees.find(item => item.id === clean(body.employeeId) && item.enabled === true && member.employeeIds.includes(item.id))
        const label = clean(body.label)
        const value = clean(body.value)
        if (!employee) throw serviceError('FORBIDDEN', '员工未获准')
        if (!label || label.length > 140 || !value || value.length > 4000) throw serviceError('INVALID_REQUEST', '确认信息无效')
        const now = clock()
        created = { id: `confirmation-${randomUUID()}`, ownerMemberId: member.id, employeeId: employee.id, label, value, revision: 1, status: 'active', createdAt: now, updatedAt: now }
        return { ...state, confirmations: [...state.confirmations, created] }
      })
      return created
    },

    async updateConfirmation(actor, id, body = {}) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor)
        const confirmation = state.confirmations.find(item => item.id === id && item.ownerMemberId === member.id)
        if (!confirmation) throw serviceError('NOT_FOUND', '确认信息不存在')
        if (confirmation.status === 'revoked') throw serviceError('INVALID_REQUEST', '已撤销的确认信息不可修改')
        const label = body.label === undefined ? confirmation.label : clean(body.label)
        const value = body.value === undefined ? confirmation.value : clean(body.value)
        if (!label || label.length > 140 || !value || value.length > 4000) throw serviceError('INVALID_REQUEST', '确认信息无效')
        updated = { ...confirmation, label, value, revision: confirmation.revision + 1, updatedAt: clock() }
        return { ...state, confirmations: replaceById(state.confirmations, updated) }
      })
      return updated
    },

    async deleteConfirmation(actor, id) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor)
        const confirmation = state.confirmations.find(item => item.id === id && item.ownerMemberId === member.id)
        if (!confirmation) throw serviceError('NOT_FOUND', '确认信息不存在')
        if (confirmation.status === 'revoked') { updated = confirmation; return state }
        const now = clock()
        updated = { ...confirmation, revision: confirmation.revision + 1, status: 'revoked', updatedAt: now, revokedAt: now }
        return { ...state, confirmations: replaceById(state.confirmations, updated) }
      })
      return updated
    },

    async listMembers(actor) {
      const state = await store.read()
      requireAdmin(state, actor)
      return state.members.map(publicMember)
    },

    async updateMember(actor, id, body = {}) {
      let updated
      await store.update(state => {
        requireAdmin(state, actor)
        const member = state.members.find(item => item.id === id)
        if (!member) throw serviceError('NOT_FOUND', '成员不存在')
        const next = { ...member }
        if (body.displayName !== undefined) {
          next.displayName = clean(body.displayName)
          if (!next.displayName || next.displayName.length > 140) throw serviceError('INVALID_REQUEST', '成员名称无效')
        }
        if (body.role !== undefined) {
          if (!['admin', 'member'].includes(body.role)) throw serviceError('INVALID_REQUEST', '成员角色无效')
          next.role = body.role
        }
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') throw serviceError('INVALID_REQUEST', '成员启用状态无效')
          next.enabled = body.enabled
        }
        if (body.employeeIds !== undefined) {
          if (!stringIds(body.employeeIds) || body.employeeIds.some(employeeId => !state.employees.some(item => item.id === employeeId))) throw serviceError('INVALID_REQUEST', '成员员工授权无效')
          if (!stringIds(body.expectedEmployeeIds) || !sameStrings([...new Set(body.expectedEmployeeIds)], [...new Set(member.employeeIds)])) throw serviceError('REVISION_CONFLICT', '成员授权已变化，请刷新后重试')
          next.employeeIds = [...new Set(body.employeeIds)]
        }
        if (member.role === 'admin' && member.enabled === true && (next.role !== 'admin' || next.enabled !== true)) {
          if (!state.members.some(item => item.id !== id && item.enabled === true && item.role === 'admin')) throw serviceError('INVALID_REQUEST', '不能禁用或降级最后一个已启用管理员')
        }
        const loginChanged = next.role !== member.role || next.enabled !== member.enabled
        const now = clock()
        updated = { ...next, sessionVersion: member.sessionVersion + (loginChanged ? 1 : 0), updatedAt: now }
        const changedEmployees = new Set([...member.employeeIds, ...next.employeeIds].filter(employeeId => member.employeeIds.includes(employeeId) !== next.employeeIds.includes(employeeId)))
        const nextState = {
          ...state, members: replaceById(state.members, updated),
          employees: state.employees.map(employee => changedEmployees.has(employee.id) ? { ...employee, revision: (employee.revision ?? 1) + 1 } : employee),
        }
        return sweepKnowledgeDependencies(invalidatePendingApprovals(nextState, work => work.ownerMemberId === id && (loginChanged || !next.employeeIds.includes(work.employeeId)), now))
      })
      return publicMember(updated)
    },

    async invalidateSession(actor) {
      let updated
      await store.update(state => {
        const member = requireMember(state, actor)
        updated = { ...member, sessionVersion: member.sessionVersion + 1, updatedAt: clock() }
        return { ...state, members: replaceById(state.members, updated) }
      })
      return publicMember(updated)
    },

    async listConfig(actor, kind) {
      const state = await store.read()
      requireAdmin(state, actor)
      if (!CONFIG_KINDS.has(kind)) throw serviceError('NOT_FOUND', '配置类型不存在')
      if (kind === 'connections') return state.connections.map(item => adminConnection(item, connectionCatalog))
      return kind === 'employees' ? state.employees.map(item => adminEmployee(state, item)) : state[kind]
    },

    async createConfig(actor, kind, body = {}) {
      let created, employeeView
      await store.update(state => {
        requireAdmin(state, actor)
        created = configEntity(state, kind, body, undefined, clock(), connectionCatalog)
        if (state[kind].some(item => item.id === created.id)) throw serviceError('INVALID_REQUEST', '配置 ID 已存在')
        const next = { ...state, [kind]: [...state[kind], created] }
        if (kind !== 'employees') return next
        const assigned = setEmployeeMembers(next, created.id, body.memberIds ?? [], clock())
        employeeView = adminEmployee(assigned, created)
        return assigned
      })
      if (kind === 'employees') return employeeView
      return kind === 'connections' ? adminConnection(created, connectionCatalog) : created
    },

    async updateConfig(actor, kind, id, body = {}) {
      let updated, employeeView
      await store.update(state => {
        requireAdmin(state, actor)
        const current = state[kind]?.find(item => item.id === id)
        if (!current) throw serviceError('NOT_FOUND', '配置不存在')
        if (kind === 'employees' && body.expectedRevision !== (current.revision ?? 1)) throw serviceError('REVISION_CONFLICT', 'Agent 配置已变化，请刷新后重试')
        updated = configEntity(state, kind, body, current, clock(), connectionCatalog)
        let next = { ...state, [kind]: replaceById(state[kind], updated) }
        if (kind !== 'employees') return next
        const now = clock()
        if (body.memberIds !== undefined) next = setEmployeeMembers(next, id, body.memberIds, now)
        if (updated.enabled !== true || current.modelRouteId !== updated.modelRouteId || !sameStrings(current.skillIds, updated.skillIds) || !sameStrings(current.connectionIds, updated.connectionIds)) {
          next = invalidatePendingApprovals(next, work => work.employeeId === id, now)
        }
        employeeView = adminEmployee(next, updated)
        return sweepKnowledgeDependencies(next)
      })
      if (kind === 'employees') return employeeView
      return kind === 'connections' ? adminConnection(updated, connectionCatalog) : updated
    },

    async testConnection(actor, id) {
      const state = await store.read()
      requireAdmin(state, actor)
      const connection = state.connections.find(item => item.id === id)
      if (!connection) throw serviceError('NOT_FOUND', '连接不存在')
      if (connection.kind !== 'kivo-mcp') throw serviceError('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED)
      if (connection.enabled !== true) throw serviceError('FORBIDDEN', '连接已停用')
      try { assertTrustedConnection(connectionCatalog, connection) } catch { throw serviceError('FORBIDDEN', '连接目标未在主机可信目录登记') }
      if (typeof connectionTester !== 'function') throw serviceError('SOURCE_NOT_CONFIGURED', '连接测试器未配置')
      const testedAt = clock()
      let detail
      try {
        const snapshot = connectionSnapshot(connection)
        const authorize = async () => {
          const current = await store.read()
          requireAdmin(current, actor)
          const candidate = current.connections.find(item => item.id === id && item.enabled === true)
          if (!candidate || !isDeepStrictEqual(connectionSnapshot(candidate), snapshot)) throw serviceError('FORBIDDEN', '连接测试授权已变化')
          assertTrustedConnection(connectionCatalog, candidate)
        }
        await authorize()
        detail = await connectionTester(connection, { authorize })
        await authorize()
      } catch (error) {
        const detail = safeError(error, 'UPSTREAM_ERROR')
        const lastTest = { ok: false, testedAt, ...detail }
        await store.update(current => ({ ...current, connections: current.connections.map(item => item.id === id && item.revision === connection.revision ? { ...item, status: 'error', lastTest } : item) }))
        throw serviceError(lastTest.code, lastTest.message)
      }
      const lastTest = compact({ ok: true, testedAt, detail: clean(detail) })
      let applied = false
      await store.update(current => {
        requireAdmin(current, actor)
        return { ...current, connections: current.connections.map(item => {
          if (item.id !== id || item.revision !== connection.revision) return item
          if (item.enabled !== true || !isDeepStrictEqual(connectionSnapshot(item), connectionSnapshot(connection))) throw serviceError('FORBIDDEN', '连接测试授权已变化')
          assertTrustedConnection(connectionCatalog, item)
          applied = true
          return { ...item, status: 'ready', lastTest }
        }) }
      })
      if (!applied) throw serviceError('BUSY', '连接配置已变化，请重新测试')
      return lastTest
    },

    async close() {
      const tasks = [...active.values()]
      const taskIds = new Set(tasks.map(item => item.executionId))
      await store.update(state => {
        let changed = false
        const works = state.works.map(work => {
          let interrupted = false
          const executions = work.executions.map(execution => {
            if (!taskIds.has(execution.id) || !['accepted', 'running'].includes(execution.status)) return execution
            changed = interrupted = true
            return { ...execution, status: 'interrupted', interruptedAt: clock(), error: { code: 'PROCESS_SHUTDOWN', message: '进程关闭时未完成' } }
          })
          return interrupted ? { ...work, status: 'interrupted', executions } : work
        })
        return changed ? { ...state, works } : state
      })
      for (const item of tasks) item.controller.abort()
      await Promise.all(tasks.filter(item => !item.deadlineAt).map(item => runner?.cancel?.(item.executionId)))
      await Promise.all(tasks.map(item => item.promise.catch(() => undefined)))
      await runner?.close?.()
      await collaborationRunner?.close?.()
    },
  }

  async function reserveExisting(actor, id, operation, body, options = {}) {
    await recover()
    const requestId = clean(body.clientRequestId) ?? `${operation}-${randomUUID()}`
    let reservation
    await store.update(state => {
      const member = requireMember(state, actor)
      const work = findOwned(state, member, id)
      if (!work) { reservation = { error: failure('NOT_FOUND', '工作不存在') }; return state }
      requireExecutableWork(state, work)
      const key = reservationKey(member.id, id, operation, requestId)
      if (state.reservations[key]) { reservation = { deduplicated: true, ...state.reservations[key] }; return state }
      if (activeExecution(work)) { reservation = { error: failure('BUSY', '当前工作已有执行正在进行') }; return state }
      if (options.requireResult && !businessResults(work).length) { reservation = { error: failure('BUSY', '尚无可用的结构化结果') }; return state }
      const binding = authorizedBinding(state, member, work, connectionCatalog)
      if (!binding.ok) { reservation = { error: binding }; return state }
      const parsed = parseInput(work.capabilityId, work.input, false)
      if (!parsed.ok) { reservation = { error: parsed }; return state }
      const executionId = `exec-${randomUUID()}`
      const nextWork = { ...work, status: 'accepted', executions: [...work.executions, compact({ ...newExecution(executionId, operation, requestId, parsed.input, clock()), question: options.question })] }
      reservation = { workId: id, executionId, question: options.question, work: nextWork }
      return { ...state, works: replaceById(state.works, nextWork), reservations: { ...state.reservations, [key]: { workId: id, executionId } } }
    })
    if (reservation?.error) return reservation.error
    const work = reservation.work ?? await ownedWork(actor, reservation.workId)
    if (!work) return failure('NOT_FOUND', '工作不存在')
    if (!reservation.deduplicated) schedule(id, reservation.executionId, operation, reservation.question)
    return success(await projectOwned(actor, work), reservation)
  }

  async function successorCollaboration(actor, id, body, recheck) {
    await recover()
    const requestId = clean(body.clientRequestId) ?? `${recheck ? 'recheck' : 'continue'}-${randomUUID()}`
    let reservation
    await store.update(state => {
      const member = requireMember(state, actor), rootWork = findOwned(state, member, id)
      if (!rootWork?.collaboration) { reservation = { error: failure('NOT_FOUND', '协作工作不存在') }; return state }
      requireExecutableWork(state, rootWork)
      const key = reservationKey(member.id, id, recheck ? 'recheck' : 'continue', requestId)
      if (state.reservations[key]) { reservation = { deduplicated: true, ...state.reservations[key] }; return state }
      if (recheck ? rootWork.collaboration.status !== 'stale' : !['waiting_input', 'failed', 'interrupted', 'cancelled'].includes(rootWork.collaboration.status)) { reservation = { error: failure('BUSY', recheck ? '当前协作工作不需要重新核对' : '当前协作工作状态不可继续') }; return state }
      if (recheck && body.itemIds !== undefined) { reservation = { error: failure('INVALID_REQUEST', '重新核对范围由当前失效依据决定') }; return state }
      const selected = recheck ? rootWork.collaboration.staleItemIds : rootWork.plan.items.filter(item => item.status !== 'completed').map(item => item.id)
      if (!Array.isArray(selected) || !selected.length || !stringIds(selected)) { reservation = { error: failure('INVALID_REQUEST', '没有可执行的协作计划项') }; return state }
      const selectedSet = new Set(selected), generation = rootWork.collaboration.generation + 1, now = clock()
      if ([...selectedSet].some(itemId => !rootWork.plan.items.some(item => item.id === itemId && (!recheck || item.status === 'completed')))) { reservation = { error: failure('INVALID_REQUEST', '重新执行计划项无效') }; return state }
      const childUpdates = new Map()
      for (const item of rootWork.plan.items.filter(item => selectedSet.has(item.id))) {
        const child = state.works.find(work => work.id === item.childWorkId)
        const binding = authorizedBinding(state, member, child, connectionCatalog)
        if (!binding.ok) { reservation = { error: binding }; return state }
        const supplied = body.inputs?.[item.id]
        if (supplied !== undefined && !plainObject(supplied)) { reservation = { error: failure('INVALID_INPUT', '协作补充输入必须是对象') }; return state }
        const parsed = parseInput(child.capabilityId, { ...child.input, ...(supplied ?? {}) }, false)
        if (!parsed.ok) { reservation = { error: parsed }; return state }
        if (!inputAllowed(binding, parsed.input, parsed.missing.length > 0)) { reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }; return state }
        childUpdates.set(child.id, { ...child, input: parsed.input, requiredInputs: [] })
      }
      const rootExecutionId = `exec-${randomUUID()}`, cancelGeneration = rootWork.collaboration.cancelGeneration
      const nextRoot = { ...rootWork, status: 'accepted', executions: [...rootWork.executions, { ...newExecution(rootExecutionId, recheck ? 'collaboration-recheck' : 'collaboration-continue', requestId, {}, now), generation, cancelGeneration, planRevision: rootWork.plan.revision, employeeId: rootWork.employeeId }], collaboration: { ...rootWork.collaboration, generation, status: 'accepted', requestCount: 0, summaryResultRefs: [], staleKnowledgeRefs: [], staleItemIds: [] }, plan: { ...rootWork.plan, items: rootWork.plan.items.map(item => selectedSet.has(item.id) ? { ...item, status: 'not_started' } : item) } }
      const works = state.works.map(work => {
        if (work.id === id) return nextRoot
        const item = rootWork.plan.items.find(candidate => candidate.childWorkId === work.id)
        if (!item) return work
        if (!selectedSet.has(item.id)) return { ...work, collaborationGeneration: generation }
        const updatedChild = childUpdates.get(work.id) ?? work
        return { ...updatedChild, status: 'accepted', collaborationGeneration: generation, executions: [...updatedChild.executions, { ...newExecution(`exec-${randomUUID()}`, recheck ? 'collaboration-recheck-child' : 'collaboration-continue-child', requestId, updatedChild.input, now), generation, cancelGeneration, planRevision: rootWork.plan.revision, employeeId: updatedChild.employeeId }] }
      })
      reservation = { workId: id, executionId: rootExecutionId }
      return { ...state, works, reservations: { ...state.reservations, [key]: reservation } }
    })
    if (reservation?.error) return reservation.error
    if (!reservation.deduplicated) void collaborationRunner?.run(id).catch(() => undefined)
    const work = await ownedWork(actor, id)
    return success(await projectOwned(actor, work), reservation)
  }

  function prepareAutomationWork(state, rule, options = {}) {
    const member = state?.members?.find(item => item.id === rule?.ownerMemberId && item.enabled === true)
    if (!member) return failure('FORBIDDEN', '成员未获准使用该员工')
    if (rule?.status !== 'active') return failure('FORBIDDEN', '自动规则当前不可执行')
    const binding = authorizedBinding(state, member, rule, connectionCatalog)
    if (!binding.ok) return binding
    if (binding.capability.retired) return failure('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED)
    const parsed = parseInput(binding.capability.id, rule.capabilityId === KIVO_TPM_RECORD_READ_CAPABILITY ? rule.input : { workOrderId: rule.workOrderId }, false)
    if (!parsed.ok) return parsed
    if (!inputAllowed(binding, parsed.input)) return failure('FORBIDDEN', '业务对象不在当前连接允许范围内')
    const acceptedAt = clean(options.acceptedAt) ?? clock()
    const workId = clean(options.workId) ?? `work-${idFactory()}`
    const executionId = clean(options.executionId) ?? `exec-${idFactory()}`
    const occurrenceKey = clean(options.occurrenceKey)
    if (!occurrenceKey) return failure('INVALID_REQUEST', '自动发生 identity 无效')
    const execution = newExecution(executionId, 'automation', occurrenceKey, parsed.input, acceptedAt)
    const work = {
      id: workId, ownerMemberId: member.id, employeeId: binding.employee.id, skillId: binding.skill.id,
      capabilityId: binding.capability.id, ...workConnectionFields(binding),
      goal: binding.capability.action, input: parsed.input, requiredInputs: [], status: 'accepted', acceptedAt,
      results: [], actions: [], executions: [execution],
    }
    return { ok: true, work, workId, executionId, acceptedAt }
  }

  function schedule(workId, executionId, operation, question, options = {}) {
    const controller = new AbortController()
    const entry = { controller, executionId, operation, deadlineAt: options.deadlineAt, ownerCheck: options.ownerCheck, ownerLost: false, deadlineExpired: false, userCancelled: false, timer: undefined, promise: undefined, cancelPromise: undefined, clock }
    active.set(executionId, entry)
    const remaining = entry.deadlineAt ? deadlineRemaining(entry.deadlineAt, clock()) : undefined
    if (entry.deadlineAt && remaining <= 0) {
      entry.deadlineExpired = true
      controller.abort(timeoutError())
    } else if (entry.deadlineAt) {
      entry.timer = setTimeout(() => {
        if (entry.userCancelled || entry.deadlineExpired) return
        entry.deadlineExpired = true
        const error = timeoutError()
        controller.abort(error)
      }, remaining)
      entry.timer.unref?.()
    }
    const promise = execute(workId, executionId, operation, question, controller, entry)
    entry.promise = promise
    void promise.catch(() => undefined)
  }

  async function execute(workId, executionId, operation, question, controller, entry = {}) {
    try {
      if (deadlineReached(entry)) throw timeoutError()
      if (!await markRunning(workId, executionId)) {
        if (controller.signal.aborted) await finishError(workId, executionId, abortError(entry))
        return
      }
      assertAutomationOwner(entry)
      assertNotAborted(entry)
      const context = await dispatchContext(workId, executionId)
      assertAutomationOwner(entry)
      assertNotAborted(entry)
      const sessionResult = latestSessionResult(context.work)
      const runnerOptions = {
        executionId, operation, capabilityId: context.work.capabilityId, input: context.work.input,
        sessionId: sessionResult?.dshSessionRef, sessionMetadata: context.metadata,
        grant: compact({ ...grantConnectionFields(context), policyFile: policyPaths.stateFile, policyRoot: policyPaths.dataRoot, secretRoot: policyPaths.secretRoot }),
        confirmations: context.confirmations.map(item => ({ id: item.id, revision: item.revision, label: item.label, value: item.value })),
        agentInstructions: context.agentInstructions,
      }
      if (operation === 'follow-up') {
        runnerOptions.contextResultId = sessionResult?.id
        runnerOptions.followUp = {
          question,
          facts: businessResults(context.work).slice(-20).map(followUpFact),
          confirmations: context.confirmations.map(item => ({ id: item.id, revision: item.revision, label: item.label, value: item.value })),
        }
      } else {
        const previous = businessResults(context.work).at(-1)
        if (previous) runnerOptions.previousFact = compact({ kind: previous.kind, payload: previous.payload, source: previous.source })
      }
      const model = await explain(runnerOptions, entry)
      assertNotAborted(entry)
      if (operation === 'follow-up') await finishFollowUp(workId, executionId, question, model, context)
      else await finishBusinessResult(workId, executionId, model, context, entry)
    } catch (error) {
      const finalError = entry.deadlineExpired && !entry.userCancelled ? timeoutError() : error
      if (!entry.ownerLost && finalError?.code !== 'OWNER_LOCK_LOST') await finishError(workId, executionId, finalError)
    } finally {
      if (entry.timer) clearTimeout(entry.timer)
      active.delete(executionId)
      if (operation === 'automation' && !entry.ownerLost) await Promise.resolve(onAutomationTerminal?.({ workId, ownerCheck: entry.ownerCheck })).catch(() => undefined)
    }
  }

  async function markRunning(workId, executionId) {
    let started = false
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution || execution.status !== 'accepted') return state
      started = true
      const nextExecution = { ...execution, status: 'running', startedAt: clock() }
      return { ...state, works: replaceById(state.works, { ...work, status: 'running', executions: replaceById(work.executions, nextExecution) }) }
    })
    return started
  }

  async function dispatchContext(workId, executionId) {
    await store.read()
    let context
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution || execution.status !== 'running') throw serviceError('CANCELLED', '本次执行已停止')
      const member = requireMember(state, { id: work.ownerMemberId })
      requireExecutableWork(state, work)
      const binding = authorizedBinding(state, member, work, connectionCatalog)
      if (!binding.ok) throw serviceError(binding.error.code, binding.error.message)
      const parsed = validateCapabilityInput(work.capabilityId, work.input)
      if (!parsed.ok) throw serviceError(parsed.error.code, parsed.error.message)
      if (!inputAllowed(binding, parsed.input)) throw serviceError('FORBIDDEN', '业务对象不在当前连接允许范围内')
      const confirmations = currentConfirmations(state, member.id, work.employeeId)
      const refs = confirmations.map(item => ({ id: item.id, revision: item.revision }))
      const fingerprint = confirmationFingerprint(confirmations)
      const mappingContext = binding.capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY ? correlationMappingContext(work) : undefined
      context = {
        work, connection: binding.connection ?? null, connections: binding.connections, mappingContext, confirmations,
        agentInstructions: binding.employee.instructions ?? '',
        metadata: {
          ownerMemberId: member.id, workId: work.id, employeeId: work.employeeId, skillId: work.skillId,
          capabilityId: work.capabilityId, ...sessionConnectionMetadata(binding, mappingContext), modelRouteId: binding.route.id,
          confirmationRefs: refs, confirmationFingerprint: fingerprint,
        },
      }
      const nextExecution = compact({ ...execution, dispatchedAt: clock(), contextConfirmationRefs: refs,
        confirmationFingerprint: fingerprint, modelRouteId: binding.route.id, ...sessionConnectionMetadata(binding, mappingContext) })
      return { ...state, works: replaceById(state.works, { ...work, executions: replaceById(work.executions, nextExecution) }) }
    })
    return context
  }

  async function explain(options, entry) {
    if (!runner || runner.configured === false) throw serviceError('MODEL_NOT_CONFIGURED', '尚未配置 ZenMux DSH runner')
    const running = Promise.resolve().then(() => { assertAutomationOwner(entry); return runner.run(options) })
    if (!entry?.deadlineAt) return running
    if (entry.controller.signal.aborted) {
      await cancelRunner(entry)
      void running.catch(() => undefined)
      throw abortError(entry)
    }
    let stopListening
    const aborted = new Promise(resolve => {
      const onAbort = () => resolve({ aborted: true })
      entry.controller.signal.addEventListener('abort', onAbort, { once: true })
      stopListening = () => entry.controller.signal.removeEventListener('abort', onAbort)
      if (entry.controller.signal.aborted) onAbort()
    })
    const outcome = await Promise.race([
      running.then(value => ({ value }), error => ({ error })),
      aborted,
    ])
    stopListening?.()
    if (outcome.aborted) {
      await cancelRunner(entry)
      void running.catch(() => undefined)
      throw abortError(entry)
    }
    if (outcome.error) throw outcome.error
    return outcome.value
  }

  async function finishBusinessResult(workId, executionId, model, context, entry) {
    if (!model?.result) throw serviceError('TOOL_CHAIN_INVALID', 'DSH 未返回规范化能力结果')
    await finishResult(workId, executionId, businessEnvelope(model, context.work, clock()), model, entry?.deadlineAt, entry, context)
  }

  async function finishFollowUp(workId, executionId, question, model, context) {
    const work = await findWork(workId)
    const result = compact({
      id: `follow-${randomUUID()}`, kind: 'assistant.follow-up', capabilityId: work?.capabilityId, skillId: work?.skillId,
      schemaVersion: 1, input: { text: question }, payload: { text: question }, explanation: clean(model?.explanation),
      createdAt: clock(), dshSessionRef: clean(model?.dshSessionRef), continuedFromDshSessionRef: clean(model?.continuedFromDshSessionRef),
      contextObservationId: clean(model?.contextResultId ?? model?.contextObservationId), continuity: clean(model?.continuity),
      contextConfirmationRefs: model?.contextConfirmationRefs ?? [],
    })
    if (!result.explanation || !result.dshSessionRef) throw serviceError('TOOL_CHAIN_INVALID', '追问结果不完整')
    await finishResult(workId, executionId, result, model, undefined, undefined, context)
  }

  async function finishResult(workId, executionId, result, model, deadlineAt, entry, context) {
    const beforeCommit = () => { if (entry) { assertAutomationOwner(entry); assertNotAborted(entry) } }
    await store.update(state => {
      beforeCommit()
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution) return state
      if (execution.status === 'cancel_requested') {
        const nextExecution = { ...execution, status: 'cancelled', completedAt: clock(), error: { code: 'CANCELLED', message: '本次执行已停止' } }
        return { ...state, works: replaceById(state.works, { ...work, status: 'cancelled', executions: replaceById(work.executions, nextExecution) }) }
      }
      if (execution.status !== 'running') return state
      if (deadlineAt && deadlineReachedAt(deadlineAt, clock())) {
        const nextExecution = { ...execution, status: 'failed', completedAt: clock(), error: safeError(timeoutError()) }
        return { ...state, works: replaceById(state.works, { ...work, status: 'failed', executions: replaceById(work.executions, nextExecution) }) }
      }
      if (getCapability(work.capabilityId)?.resultKind === KIVO_TPM_RESULT_KIND) {
        const authorized = authorizeWorkBinding(state, { id: work.ownerMemberId }, work, connectionCatalog)
        if (!context || authorized.binding.route.id !== context.metadata.modelRouteId
          || !isDeepStrictEqual(work.input, context.work.input) || !isDeepStrictEqual(execution.input, context.work.input)
          || !isDeepStrictEqual(connectionSnapshot(authorized.binding.connection), connectionSnapshot(context.connection))
          || context.confirmations.some(ref => !state.confirmations.some(item => item.id === ref.id && item.revision === ref.revision
            && item.ownerMemberId === work.ownerMemberId && item.employeeId === work.employeeId && item.status === 'active'))) throw serviceError('FORBIDDEN', '执行结果提交时授权已失效')
      }
      const legacy = result.kind === 'gearjob.work-order.observation' ? { resultObservationId: result.id } : result.kind === 'assistant.follow-up' ? { resultFollowUpId: result.id } : {}
      const nextExecution = compact({ ...execution, status: 'completed', completedAt: clock(), dshSessionRef: result.dshSessionRef,
        continuedFromDshSessionRef: result.continuedFromDshSessionRef, contextObservationId: result.contextObservationId,
        continuity: result.continuity, contextConfirmationRefs: result.contextConfirmationRefs, dshEventCount: eventCount(model), resultId: result.id, ...legacy })
      const nextWork = { ...work, status: 'completed', results: [...work.results, result], executions: replaceById(work.executions, nextExecution) }
      return { ...state, works: replaceById(state.works, nextWork) }
    }, { beforeCommit })
  }

  function cancelRunner(entry) {
    entry.cancelPromise ??= Promise.resolve(runner?.cancel?.(entry.executionId)).catch(() => undefined)
    return entry.cancelPromise
  }

  async function finishError(workId, executionId, error) {
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution || TERMINAL_EXECUTION.has(execution.status)) return state
      const timedOut = error?.code === 'UPSTREAM_TIMEOUT'
      const cancelled = !timedOut && (execution.status === 'cancel_requested' || error?.code === 'CANCELLED' || error?.name === 'AbortError')
      const status = cancelled ? 'cancelled' : 'failed'
      const nextExecution = { ...execution, status, completedAt: clock(), error: cancelled ? { code: 'CANCELLED', message: '本次执行已停止' } : safeError(error) }
      return { ...state, works: replaceById(state.works, { ...work, status, executions: replaceById(work.executions, nextExecution) }) }
    })
  }

  async function recover() {
    if (recovered) return
    if (!recoveryPromise) {
      recoveryPromise = (async () => {
        await store.update(state => {
          let changed = false
          const now = clock()
          const works = state.works.map(work => {
            if (!ACTIVE_EXECUTION.has(work.status) && !work.executions.some(item => ACTIVE_EXECUTION.has(item.status))) return work
            changed = true
            const interrupted = { ...work, status: 'interrupted', executions: work.executions.map(execution => ACTIVE_EXECUTION.has(execution.status)
              ? { ...execution, status: 'interrupted', interruptedAt: now, error: { code: 'PROCESS_RESTARTED', message: '进程重启时未完成' } } : execution) }
            if (!work.collaboration) return interrupted
            return { ...interrupted, collaboration: { ...work.collaboration, status: 'interrupted' }, plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running', 'waiting_input'].includes(item.status) ? { ...item, status: 'interrupted' } : item) } }
          })
          const recoveredState = recoverActionFacts({ ...state, works }, now)
          return changed || recoveredState !== state ? recoveredState : state
        })
        recovered = true
      })().finally(() => { recoveryPromise = undefined })
    }
    await recoveryPromise
  }

  async function ownedWork(actor, id) {
    const state = await store.read()
    const member = requireMember(state, actor)
    return findOwned(state, member, id)
  }

  async function projectOwned(actor, work) {
    if (!work.collaboration && !work.rootWorkId && !work.results.some(result => result.knowledgeDependencyRefs?.length) && !work.handoffs?.some(handoff => handoff.knowledgeRefs?.length)) return publicWork({ works: [work] }, { id: actor?.id }, work)
    const state = await store.read()
    const member = requireMember(state, actor)
    const current = findOwned(state, member, work.id)
    return publicWork(state, member, current ?? work)
  }
  async function findWork(id) { return (await store.read()).works.find(item => item.id === id) }
}

function businessEnvelope(model, work, now) {
  const base = model.result
  const id = base.kind === 'gearjob.work-order.observation' ? `obs-${randomUUID()}` : `result-${randomUUID()}`
  let payload = base.payload
  let createdAt = now
  if (base.kind === 'gearjob.work-order.observation') {
    payload = createObservation({ source: base.payload, queriedAt: now })
    payload.observationId = id
    payload.evidenceMode = base.payload.evidenceMode
    Object.assign(payload, compact({ explanation: clean(model.explanation), dshSessionRef: clean(model.dshSessionRef),
      continuedFromDshSessionRef: clean(model.continuedFromDshSessionRef), contextObservationId: clean(model.contextResultId ?? model.contextObservationId), continuity: clean(model.continuity) }))
  }
  if (base.kind === 'manufacturing.work-order-device-correlation' || base.kind === KIVO_TPM_RESULT_KIND) createdAt = clean(payload.queriedAt)
  const result = compact({
    id, kind: base.kind, capabilityId: work.capabilityId, skillId: work.skillId, schemaVersion: 1,
    input: structuredClone(work.input), payload, explanation: clean(model.explanation), source: base.source, createdAt,
    toolName: base.toolName, pluginId: base.pluginId, pluginVersion: base.pluginVersion, dshSessionRef: clean(model.dshSessionRef),
    continuedFromDshSessionRef: clean(model.continuedFromDshSessionRef), contextObservationId: clean(model.contextResultId ?? model.contextObservationId),
    continuity: clean(model.continuity), contextConfirmationRefs: model.contextConfirmationRefs ?? [],
  })
  if (!result.explanation || !result.dshSessionRef) throw serviceError('TOOL_CHAIN_INVALID', '能力结果不完整')
  return result
}

function authorizedBinding(state, member, request, connectionCatalog) {
  const employee = state.employees.find(item => item.id === clean(request.employeeId) && item.enabled === true && member.employeeIds.includes(item.id))
  if (!employee) return failure('FORBIDDEN', '成员未获准使用该员工')
  const requestedSkillId = clean(request.skillId)
  const candidateSkills = state.skills.filter(item => item.enabled === true && employee.skillIds?.includes(item.id) && (!requestedSkillId || item.id === requestedSkillId))
  if (candidateSkills.length !== 1) return failure('FORBIDDEN', requestedSkillId ? 'Skill 未获准' : '必须明确选择唯一获准 Skill')
  const skill = candidateSkills[0]
  const capability = getCapability(skill.capabilityId)
  if (!capability || (clean(request.capabilityId) && request.capabilityId !== capability.id)) return failure('FORBIDDEN', '能力绑定无效')
  const route = state.modelRoutes.find(item => item.id === employee.modelRouteId && item.enabled === true && item.provider === ZENMUX_PROVIDER && item.model === ZENMUX_MODEL && item.credentialRef === 'ZENMUX_API_KEY')
  if (!route) return failure('FORBIDDEN', '员工模型路由不可用')
  let connection
  if (capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY) {
    let ids
    try { ids = correlationConnectionIds(request.connectionIds) } catch { return failure('INVALID_REQUEST', '必须精确选择 GearJob 与 Hive 连接') }
    const connections = {
      gearJob: state.connections.find(item => item.id === ids.gearJob && item.enabled === true && item.status === 'ready'),
      hive: state.connections.find(item => item.id === ids.hive && item.enabled === true && item.status === 'ready'),
    }
    if (connections.gearJob?.kind !== 'gearjob-rest' || connections.hive?.kind !== 'hive-tenant-records'
      || Object.values(connections).some(item => !employee.connectionIds?.includes(item.id) || !item.skillIds?.includes(skill.id))) return failure('FORBIDDEN', '双来源连接未获准或不可用')
    if (connections.hive.allowedObjectIds?.length !== 1) return failure('FORBIDDEN', 'Hive 连接必须精确授权一个 device code')
    try { for (const item of Object.values(connections)) assertTrustedConnection(connectionCatalog, item) } catch { return failure('FORBIDDEN', '连接目标未在主机可信目录登记') }
    return { ok: true, member, employee, skill, capability, route, connections }
  }
  if (capability.requiresConnection) {
    connection = state.connections.find(item => item.id === clean(request.connectionId) && item.enabled === true && item.status === 'ready')
    if (!connection || connection.kind !== capability.connectionKind || !employee.connectionIds?.includes(connection.id) || !connection.skillIds?.includes(skill.id)) return failure('FORBIDDEN', '连接未获准或不可用')
    try { assertTrustedConnection(connectionCatalog, connection) } catch { return failure('FORBIDDEN', '连接目标未在主机可信目录登记') }
  } else if (request.connectionId !== undefined && request.connectionId !== null && request.connectionId !== '') return failure('INVALID_REQUEST', '该能力不使用连接')
  return { ok: true, member, employee, skill, capability, route, connection }
}

export function authorizeWorkBinding(state, actor, workOrId, connectionCatalog = []) {
  const member = requireMember(state, actor)
  const work = typeof workOrId === 'string'
    ? findOwned(state, member, workOrId)
    : workOrId?.ownerMemberId === member.id ? workOrId : undefined
  if (!work) throw serviceError('NOT_FOUND', '工作不存在')
  const binding = authorizedBinding(state, member, work, connectionCatalog)
  if (!binding.ok) throw serviceError(binding.error.code, binding.error.message)
  const parsed = validateCapabilityInput(work.capabilityId, work.input)
  if (!parsed.ok) throw serviceError(parsed.error.code, parsed.error.message)
  if (!inputAllowed(binding, parsed.input)) throw serviceError('FORBIDDEN', '业务对象不在当前连接允许范围内')
  return { member, work, binding, input: parsed.input }
}

function inputAllowed(binding, input, allowMissing = false) {
  if (binding.capability.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY) return binding.connections.gearJob.allowedObjectIds?.includes(input.workOrderId)
  if (!binding.capability.requiresConnection) return true
  if (allowMissing) {
    const partial = validateCapabilityInput(binding.capability.id, input, { allowMissing: true })
    if (!partial.ok || !partial.missing.length) return false
    if (binding.connection.kind === 'kivo-mcp') return Array.isArray(binding.connection.allowedObjectIds) && binding.connection.allowedObjectIds.length === 0
    return input.workOrderId === undefined || binding.connection.allowedObjectIds?.includes(input.workOrderId)
  }
  return connectionInputAllowed(binding.connection, binding.capability.id, input)
}

function requireMember(state, actor) {
  const id = clean(actor?.id ?? actor?.memberId)
  const member = state.members.find(item => item.id === id && item.enabled === true)
  if (!member) throw serviceError('UNAUTHORIZED', '会话无效')
  return member
}
function requireAdmin(state, actor) { const member = requireMember(state, actor); if (member.role !== 'admin') throw serviceError('FORBIDDEN', '需要管理员权限'); return member }
function findOwned(state, member, id) { return state.works.find(item => item.id === id && item.ownerMemberId === member.id) }
function conversationBinding(state, member, employeeId, value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw serviceError('INVALID_REQUEST', '对话引用无效')
  const conversation = state.conversations.find(item => item.id === value && item.ownerMemberId === member.id)
  if (!conversation) throw serviceError('NOT_FOUND', '对话不存在')
  if (conversation.employeeId !== employeeId || conversation.archivedAt) throw serviceError('FORBIDDEN', '当前对话不能关联该工作')
  return conversation.id
}

function parseInput(capabilityId, input, allowMissing) {
  let parsed
  try { parsed = validateCapabilityInput(capabilityId, input, { allowMissing }) } catch (error) { return failure(error.code ?? 'CAPABILITY_NOT_FOUND', error.message) }
  return parsed.ok ? parsed : failure(parsed.error.code, parsed.error.message, { missing: parsed.missing })
}
function requestInput(body, capability) { if (body.input !== undefined) return body.input; return Object.fromEntries(capability.requiredInputs.filter(key => body[key] !== undefined).map(key => [key, body[key]])) }
function businessResults(work) { return work.results.filter(item => item.kind !== 'assistant.follow-up') }
function followUpFact(result) {
  if (result.kind === 'manufacturing.takt') return { kind: result.kind, payload: pick(result.payload, ['availableSeconds', 'quantity', 'secondsPerUnit', 'unit']) }
  if (result.kind === 'manufacturing.work-order-device-correlation') return { kind: result.kind, payload: structuredClone(result.payload), source: structuredClone(result.source) }
  if (result.kind === KIVO_TPM_RESULT_KIND) return { kind: result.kind, payload: structuredClone(result.payload), source: structuredClone(result.source) }
  return compact({
    kind: result.kind,
    payload: pick(result.payload, ['workOrderId', 'status', 'plannedQuantity', 'completedQuantity', 'unit', 'sourceTime', 'sourceRecordId', 'sourceRevision', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']),
    source: result.source ? pick(result.source, ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'sourceRecordId', 'sourceRevision', 'sourceTime']) : undefined,
  })
}
function latestSessionResult(work) { return [...work.results].reverse().find(item => clean(item.dshSessionRef)) }
function currentConfirmations(state, ownerMemberId, employeeId) { return state.confirmations.filter(item => item.ownerMemberId === ownerMemberId && item.employeeId === employeeId && item.status === 'active').sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision) }
function confirmationFingerprint(confirmations) { return createHash('sha256').update(JSON.stringify(confirmations.map(item => [item.id, item.revision]))).digest('hex') }

function configEntity(state, kind, body, current, now, connectionCatalog) {
  if (!CONFIG_KINDS.has(kind)) throw serviceError('NOT_FOUND', '配置类型不存在')
  if (kind === 'modelRoutes') return modelRoute(body, current)
  if (kind === 'skills') return skillConfig(body, current)
  if (kind === 'employees') return employeeConfig(state, body, current)
  return connectionConfig(state, body, current, now, connectionCatalog)
}
function modelRoute(body, current) {
  const id = current?.id ?? clean(body.id), provider = body.provider ?? current?.provider, model = body.model ?? current?.model
  const displayName = clean(body.displayName ?? current?.displayName), enabled = body.enabled ?? current?.enabled ?? true
  const credentialRef = clean(body.credentialRef ?? current?.credentialRef ?? 'ZENMUX_API_KEY')
  if (!id || provider !== ZENMUX_PROVIDER || model !== ZENMUX_MODEL || !displayName || typeof enabled !== 'boolean' || credentialRef !== 'ZENMUX_API_KEY') throw serviceError('INVALID_REQUEST', '模型路由必须使用固定 ZenMux DeepSeek V4.1 Flash 配置')
  return { id, provider, model, displayName, enabled, credentialRef }
}
function skillConfig(body, current) {
  const capabilityId = body.capabilityId ?? current?.capabilityId, capability = getCapability(capabilityId)
  const id = current?.id ?? clean(body.id), name = clean(body.name ?? current?.name), enabled = body.enabled ?? current?.enabled ?? true
  if (!capability || id !== capability.skillId || !name || typeof enabled !== 'boolean') throw serviceError('INVALID_REQUEST', 'Skill 必须绑定可信 capability catalog')
  if (capability.retired && (!current || enabled)) throw serviceError('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED)
  return { id, name, capabilityId, enabled }
}
function employeeConfig(state, body, current) {
  const result = { id: current?.id ?? clean(body.id), name: clean(body.name ?? current?.name), description: clean(body.description ?? current?.description) ?? '',
    instructions: body.instructions === undefined ? current?.instructions ?? '' : typeof body.instructions === 'string' ? body.instructions.trim() : null,
    revision: current ? (current.revision ?? 1) + 1 : 1,
    enabled: body.enabled ?? current?.enabled ?? true, modelRouteId: body.modelRouteId ?? current?.modelRouteId ?? null,
    connectionIds: body.connectionIds ?? current?.connectionIds ?? [], skillIds: body.skillIds ?? current?.skillIds ?? [] }
  if (!result.id || !result.name || typeof result.instructions !== 'string' || result.instructions.length > 16_000 || typeof result.enabled !== 'boolean' || !stringIds(result.connectionIds) || !stringIds(result.skillIds)) throw serviceError('INVALID_REQUEST', '员工配置无效')
  if (!state.modelRoutes.some(item => item.id === result.modelRouteId)) throw serviceError('INVALID_REQUEST', '员工模型路由不存在')
  if (result.connectionIds.some(id => !state.connections.some(item => item.id === id)) || result.skillIds.some(id => !state.skills.some(item => item.id === id))) throw serviceError('INVALID_REQUEST', '员工绑定引用不存在')
  return result
}

function adminEmployee(state, employee) {
  return { ...employee, instructions: employee.instructions ?? '', revision: employee.revision ?? 1, memberIds: state.members.filter(member => member.employeeIds.includes(employee.id)).map(member => member.id) }
}

function setEmployeeMembers(state, employeeId, memberIds, now) {
  if (!stringIds(memberIds) || memberIds.some(id => !state.members.some(member => member.id === id))) throw serviceError('INVALID_REQUEST', 'Agent 开放成员无效')
  const allowed = new Set(memberIds)
  const members = state.members.map(member => {
    if (allowed.has(member.id) === member.employeeIds.includes(employeeId)) return member
    const employeeIds = allowed.has(member.id) ? [...member.employeeIds, employeeId] : member.employeeIds.filter(id => id !== employeeId)
    return { ...member, employeeIds, updatedAt: now }
  })
  return invalidatePendingApprovals({ ...state, members }, work => work.employeeId === employeeId && !allowed.has(work.ownerMemberId), now)
}

function invalidatePendingApprovals(state, affected, now) {
  return { ...state, works: state.works.map(work => affected(work) ? { ...work, actions: (work.actions ?? []).map(action => action.decision?.kind === 'approved' && !action.decision.invalidatedAt && !action.attempt
    ? { ...action, decision: { ...action.decision, invalidatedAt: now, invalidationReason: 'OWNER_REVOKED' } }
    : action) } : work) }
}
function connectionConfig(state, body, current, now, connectionCatalog) {
  const result = { id: current?.id ?? clean(body.id), name: clean(body.name ?? current?.name), kind: body.kind ?? current?.kind,
    targetIdentity: clean(body.targetIdentity ?? current?.targetIdentity), baseUrl: clean(body.baseUrl ?? current?.baseUrl),
    ...((body.kind ?? current?.kind) === 'kivo-mcp' ? { issuer: clean(body.issuer ?? current?.issuer), clientId: clean(body.clientId ?? current?.clientId) } : {}),
    ...(body.hostHeader !== undefined || current?.hostHeader !== undefined ? { hostHeader: clean(body.hostHeader ?? current?.hostHeader) } : {}),
    credentialRef: clean(body.credentialRef ?? current?.credentialRef), allowedObjectIds: body.allowedObjectIds ?? current?.allowedObjectIds ?? [],
    sourceSystem: clean(body.sourceSystem ?? current?.sourceSystem), sourceInstance: clean(body.sourceInstance ?? current?.sourceInstance),
    sourceEnvironment: clean(body.sourceEnvironment ?? current?.sourceEnvironment), dataMode: clean(body.dataMode ?? current?.dataMode),
    evidenceMode: clean(body.evidenceMode ?? current?.evidenceMode), enabled: body.enabled ?? current?.enabled ?? true,
    status: 'unknown', skillIds: body.skillIds ?? current?.skillIds ?? [], revision: current ? current.revision + 1 : 1,
    updatedAt: now }
  if (current && CONNECTION_IDENTITY_FIELDS.some(key => result[key] !== current[key])) throw serviceError('INVALID_REQUEST', '连接目标/来源 identity 不可原地更换')
  if (!result.id || !result.name || !['gearjob-rest', 'hive-tenant-records', 'kivo-mcp'].includes(result.kind) || !result.targetIdentity || !result.baseUrl || !simpleRef(result.credentialRef) || !stringIds(result.allowedObjectIds) || !stringIds(result.skillIds) || typeof result.enabled !== 'boolean') throw serviceError('INVALID_REQUEST', '连接配置无效')
  if (result.kind === 'kivo-mcp' ? result.allowedObjectIds.length !== 0 : body.issuer !== undefined || body.clientId !== undefined) throw serviceError('INVALID_REQUEST', '连接机器账号或范围字段无效')
  if (!current && result.kind !== 'kivo-mcp') throw serviceError('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED)
  if (result.kind === 'hive-tenant-records' && (!uuid(result.targetIdentity) || result.allowedObjectIds.length !== 1)) throw serviceError('INVALID_REQUEST', 'Hive 连接必须绑定 tenant UUID 与一个 device code')
  if (result.skillIds.some(id => !state.skills.some(item => item.id === id && capabilityAcceptsConnectionKind(getCapability(item.capabilityId), result.kind)))) throw serviceError('INVALID_REQUEST', '连接 Skill 绑定无效')
  for (const key of ['sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode']) if (!result[key]) throw serviceError('INVALID_REQUEST', `连接缺少 ${key}`)
  try { const url = new URL(result.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error() } catch { throw serviceError('INVALID_REQUEST', '连接地址无效') }
  try { Object.assign(result, assertTrustedConnection(connectionCatalog, result)) } catch { throw serviceError('FORBIDDEN', '连接目标未在主机可信目录登记') }
  return result
}

function publicWork(state, member, work) {
  const root = work.rootWorkId ? state.works.find(item => item.id === work.rootWorkId) : work
  const results = work.results.map(result => projectResult(state, member, root, work, result))
  const observations = results.filter(item => item.kind === 'gearjob.work-order.observation').map(item => item.payload)
  const followUps = results.filter(item => item.kind === 'assistant.follow-up').map(item => compact({ id: item.id, text: item.payload.text,
    explanation: item.explanation, at: item.createdAt, dshSessionRef: item.dshSessionRef, continuedFromDshSessionRef: item.continuedFromDshSessionRef,
    contextObservationId: item.contextObservationId, continuity: item.continuity, contextConfirmationRefs: item.contextConfirmationRefs }))
  const value = structuredClone(work)
  value.results = results
  if (results.some(result => result.knowledgeUnavailable)) delete value.knowledgeQuery
  if (value.handoffs) value.handoffs = value.handoffs.map(handoff => {
    const child = state.works.find(item => item.id === handoff.childWorkId)
    const refs = handoff.knowledgeRefs.filter(ref => currentKnowledgeReference(state, ref, member.id, child?.employeeId)
      && currentKnowledgeReference(state, ref, member.id, root.employeeId))
    return refs.length === handoff.knowledgeRefs.length ? handoff : { ...handoff, knowledgeRefs: [], knowledgeUnavailable: true }
  })
  value.executions = value.executions.map(execution => execution.error ? { ...execution, error: safeError(execution.error) } : execution)
  return { ...value, retired: isRetiredWork(state, work), observations, followUps }
}
function projectResult(state, member, root, work, result) {
  const value = structuredClone(result)
  const refs = value.knowledgeDependencyRefs ?? []
  if (!refs.length) return value
  const employees = result.kind === 'assistant.collaboration-summary' ? [root.employeeId] : [work.employeeId, root.employeeId]
  const available = refs.every(ref => employees.every(employeeId => currentKnowledgeReference(state, ref, member.id, employeeId)))
  if (available) return value
  delete value.explanation
  if (value.payload && typeof value.payload === 'object') {
    delete value.payload.explanation
    delete value.payload.text
  }
  value.knowledgeDependencyRefs = []
  value.knowledgeUnavailable = true
  return value
}
function publicMember(member) { return Object.fromEntries(['id', 'loginName', 'displayName', 'role', 'enabled', 'sessionVersion', 'employeeIds', 'createdAt', 'updatedAt'].filter(key => member[key] !== undefined).map(key => [key, structuredClone(member[key])])) }
function simpleRef(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..' }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function publicConnection(connection, catalog) {
  return pick(visibleConnection(connection, catalog), ['id', 'name', 'kind', 'targetIdentity', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'enabled', 'status', 'skillIds', 'revision', 'lastTest'])
}
function adminConnection(connection, catalog) { return visibleConnection(connection, catalog) }
function visibleConnection(connection, catalog) {
  const value = structuredClone(connection)
  if (value.lastTest?.ok === false) value.lastTest = { ...value.lastTest, ...safeError(value.lastTest) }
  try { assertTrustedConnection(catalog, connection); return value } catch { return { ...value, status: 'unavailable' } }
}
function publicCapability(capability) { return { id: capability.id, retired: capability.retired, skillId: capability.skillId, action: capability.action, requiredInputs: [...capability.requiredInputs], requiresConnection: capability.requiresConnection, connectionKind: capability.connectionKind, resultKind: capability.resultKind } }

export function isRetiredWork(state, work) {
  const rootId = work.rootWorkId ?? work.id
  return [work, ...state.works.filter(item => item.id === rootId || item.rootWorkId === rootId)].some(item => getCapability(item.capabilityId)?.retired === true)
}
function requireExecutableWork(state, work) {
  if (isRetiredWork(state, work)) throw serviceError('CAPABILITY_RETIRED', SAFE_ERROR_MESSAGES.CAPABILITY_RETIRED)
}
function workConnectionFields(binding) {
  return binding.connections
    ? { connectionIds: { gearJob: binding.connections.gearJob.id, hive: binding.connections.hive.id } }
    : binding.connection ? { connectionId: binding.connection.id } : {}
}
function grantConnectionFields(context) { return context.connections ? { connections: context.connections, ...context.mappingContext } : { connection: context.connection } }
function sessionConnectionMetadata(binding, mappingContext) {
  return binding.connections
    ? {
        connectionIds: { gearJob: binding.connections.gearJob.id, hive: binding.connections.hive.id },
        connectionRevisions: { gearJob: binding.connections.gearJob.revision, hive: binding.connections.hive.revision },
        ...mappingContext,
      }
    : { connectionId: binding.connection?.id ?? null, connectionRevision: binding.connection?.revision ?? null }
}
function correlationConnectionIds(value) {
  if (!plainObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'gearJob') || !Object.hasOwn(value, 'hive')) throw new Error('invalid')
  const gearJob = clean(value.gearJob), hive = clean(value.hive)
  if (!gearJob || !hive || gearJob === hive) throw new Error('invalid')
  return { gearJob, hive }
}
function capabilityAcceptsConnectionKind(capability, kind) {
  return capability?.connectionKind === kind || capability?.id === WORK_ORDER_DEVICE_CORRELATION_CAPABILITY && ['gearjob-rest', 'hive-tenant-records'].includes(kind)
}
function success(work, reservation) { return { ok: true, value: work, deduplicated: Boolean(reservation.deduplicated), accepted: Boolean(reservation.executionId && !reservation.deduplicated), active: Boolean(reservation.active) } }
function newExecution(id, operation, clientRequestId, input, acceptedAt) { return { id, operation, clientRequestId, input: structuredClone(input), status: 'accepted', acceptedAt } }
function activeExecution(work) { return [...work.executions].reverse().find(item => ACTIVE_EXECUTION.has(item.status)) }
function replaceById(items, value) { return items.map(item => item.id === value.id ? value : item) }
function reservationKey(ownerMemberId, ...parts) { return [ownerMemberId, ...parts].map(value => String(value ?? '')).join('|') }
function eventCount(model) { return Number.isInteger(model?.eventCount) && model.eventCount >= 0 ? model.eventCount : undefined }
function clean(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function validKnowledgeQuery(value) {
  const query = clean(value)
  if (!query || !query.isWellFormed() || Array.from(query).length > 256 || query.split(/\s+/u).length > 16) throw serviceError('INVALID_REQUEST', '知识检索内容无效')
  return query
}
function plainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function stringIds(value) { return Array.isArray(value) && value.every(item => clean(item) === item) && new Set(value).size === value.length }
function sameStrings(left = [], right = []) { const a = [...left].sort(), b = [...right].sort(); return a.length === b.length && a.every((value, index) => value === b[index]) }
function hasDependencyCycle(items) {
  const byId = new Map(items.map(item => [item.id, item]))
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((byId.get(id)?.dependsOn ?? []).some(visit)) return true
    visiting.delete(id); visited.add(id); return false
  }
  return items.some(item => visit(item.id))
}
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) }
function pick(value, keys) { return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]])) }
function serviceError(code, message) { return Object.assign(new Error(message), { code }) }
function parseInstant(value) { const parsed = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? parsed : null }
function deadlineRemaining(deadlineAt, now = new Date().toISOString()) { const deadline = parseInstant(deadlineAt), current = parseInstant(now); return deadline && current ? Math.max(0, deadline.getTime() - current.getTime()) : 0 }
function deadlineReachedAt(deadlineAt, now) { const deadline = parseInstant(deadlineAt), current = parseInstant(now); return Boolean(deadline && current && current.getTime() >= deadline.getTime()) }
function deadlineReached(entry) { return Boolean(entry.deadlineAt && (entry.deadlineExpired || deadlineReachedAt(entry.deadlineAt, clockValue(entry)))) }
function clockValue(entry) { return entry?.clock ? entry.clock() : new Date().toISOString() }
function timeoutError() { return serviceError('UPSTREAM_TIMEOUT', '自动工作执行超时') }
function cancelledError() { return serviceError('CANCELLED', '本次执行已停止') }
function abortError(entry) { return entry?.ownerLost ? serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效') : entry?.deadlineExpired ? timeoutError() : cancelledError() }
function assertNotAborted(entry) { if (deadlineReached(entry)) throw timeoutError(); if (entry.controller?.signal.aborted) throw abortError(entry) }
function assertAutomationOwner(entry) { if (entry?.ownerCheck && !entry.ownerCheck()) throw serviceError('OWNER_LOCK_LOST', 'automation owner lock 已失效') }
function safeError(error, fallbackCode = 'INTERNAL_ERROR') {
  const code = error?.code ?? fallbackCode
  return SAFE_ERROR_MESSAGES[code] ? { code, message: SAFE_ERROR_MESSAGES[code] } : { ...GENERIC_ERROR }
}
function failure(code, message, extra = {}) { return { ok: false, error: { code, message, status: ERROR_STATUS[code] ?? 500, ...extra } } }
export function serviceFailure(error) { return failure(error?.code ?? 'INTERNAL_ERROR', error?.message ?? '服务暂时无法完成请求') }
export function safeServiceError(error) { return safeError(error) }
