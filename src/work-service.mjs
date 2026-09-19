import { createHash, randomUUID } from 'node:crypto'
import { getCapability, listCapabilities, validateCapabilityInput } from './capabilities.mjs'
import { createObservation } from './domain/work-order.mjs'
import { assertTrustedConnection, CONNECTION_IDENTITY_FIELDS } from './connection-catalog.mjs'
import { currentKnowledgeReference, sweepKnowledgeDependencies } from './knowledge-service.mjs'

export const ERROR_STATUS = {
  INVALID_REQUEST: 400, INVALID_INPUT: 400, UNDECLARED_INPUT: 400, MISSING_INPUT: 400,
  INVALID_WORK_ORDER_ID: 400, MISSING_AVAILABLE_SECONDS: 400, MISSING_QUANTITY: 400,
  INVALID_AVAILABLE_SECONDS_TYPE: 400, INVALID_QUANTITY_TYPE: 400, NON_FINITE_AVAILABLE_SECONDS: 400,
  NON_FINITE_QUANTITY: 400, NEGATIVE_AVAILABLE_SECONDS: 400, NON_POSITIVE_QUANTITY: 400,
  NON_FINITE_RESULT: 400, CAPABILITY_NOT_FOUND: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, BUSY: 409, SOURCE_NOT_CONFIGURED: 503, MODEL_NOT_CONFIGURED: 503,
  UPSTREAM_TIMEOUT: 504, UPSTREAM_ERROR: 502, INVALID_SOURCE: 502,
  REVISION_CONFLICT: 409, CAPACITY_EXCEEDED: 400, BUDGET_EXHAUSTED: 409,
  KNOWLEDGE_PLUGIN_DISABLED: 503, KNOWLEDGE_REFERENCE_INVALID: 409,
}

const ACTIVE_EXECUTION = new Set(['accepted', 'running', 'cancel_requested'])
const TERMINAL_EXECUTION = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const CONTINUABLE_WORK = new Set(['waiting_input', 'failed', 'interrupted', 'cancelled'])
const CONFIG_KINDS = new Set(['employees', 'connections', 'skills', 'modelRoutes'])
const ZENMUX_PROVIDER = 'zenmux'
const ZENMUX_MODEL = 'deepseek/deepseek-v4-pro'
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
  NOT_FOUND: '业务对象不存在',
  INVALID_REQUEST: '请求参数无效',
})
const GENERIC_ERROR = Object.freeze({ code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求' })

export function createWorkService({ store, runner = null, collaborationRunner = null, clock = () => new Date().toISOString(), policyPaths = {}, connectionTester = null, connectionCatalog = [] } = {}) {
  if (!store) throw new Error('store is required')
  const active = new Map()
  let recovered = false

  return {
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
        capabilities: listCapabilities().filter(item => state.skills.some(skill => skillIds.has(skill.id) && skill.enabled === true && skill.capabilityId === item.id)).map(publicCapability),
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
        const parsed = parseInput(binding.capability.id, requestInput(body, binding.capability), true)
        if (!parsed.ok) {
          reservation = { error: parsed }
          return state
        }
        if (!inputAllowed(binding, parsed.input)) {
          reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }
          return state
        }
        const now = clock()
        const workId = `work-${randomUUID()}`
        const work = {
          id: workId, ownerMemberId: member.id, employeeId: binding.employee.id, skillId: binding.skill.id,
          capabilityId: binding.capability.id, ...(binding.connection ? { connectionId: binding.connection.id } : {}),
          goal: clean(body.goal) ?? binding.capability.action, input: parsed.input, requiredInputs: parsed.missing,
          status: parsed.missing.length ? 'waiting_input' : 'accepted', acceptedAt: now, results: [], executions: [],
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
        const goal = clean(body.goal)
        if (!goal || goal.length > 4000) { reservation = { error: failure('INVALID_REQUEST', '协作目标无效') }; return state }
        const now = clock(), rootWorkId = `work-${randomUUID()}`, generation = 1
        const childWorks = [], planItems = [], itemIds = new Set()
        for (const raw of body.items) {
          const itemId = clean(raw?.id) ?? `item-${randomUUID()}`
          if (itemIds.has(itemId)) { reservation = { error: failure('INVALID_REQUEST', '协作计划项 ID 重复') }; return state }
          itemIds.add(itemId)
          const binding = authorizedBinding(state, member, raw ?? {}, connectionCatalog)
          if (!binding.ok) { reservation = { error: binding }; return state }
          const parsed = parseInput(binding.capability.id, requestInput(raw, binding.capability), true)
          if (!parsed.ok) { reservation = { error: parsed }; return state }
          if (!inputAllowed(binding, parsed.input)) { reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }; return state }
          const childWorkId = `work-${randomUUID()}`, executionId = `exec-${randomUUID()}`
          const itemGoal = clean(raw.goal) ?? binding.capability.action
          const knowledgeQuery = raw.knowledgeQuery === undefined ? undefined : validKnowledgeQuery(raw.knowledgeQuery)
          const waiting = parsed.missing.length > 0
          childWorks.push({
            id: childWorkId, ownerMemberId: member.id, employeeId: binding.employee.id, skillId: binding.skill.id,
            capabilityId: binding.capability.id, ...(binding.connection ? { connectionId: binding.connection.id } : {}),
            goal: itemGoal, input: parsed.input, requiredInputs: parsed.missing, status: waiting ? 'waiting_input' : 'accepted', acceptedAt: now, results: [],
            executions: waiting ? [] : [{ ...newExecution(executionId, 'collaboration-child', requestId, parsed.input, now), generation, cancelGeneration: 0, planRevision: 1, employeeId: binding.employee.id }],
            workType: 'collaboration-child', parentWorkId: rootWorkId, rootWorkId, collaborationGeneration: generation, planItemId: itemId,
            ...(knowledgeQuery ? { knowledgeQuery } : {}),
          })
          planItems.push({ id: itemId, childWorkId, goal: itemGoal, employeeId: binding.employee.id, status: waiting ? 'waiting_input' : 'not_started', dependsOn: raw.dependsOn ?? [] })
        }
        if (planItems.some(item => !stringIds(item.dependsOn) || item.dependsOn.some(id => !itemIds.has(id) || id === item.id)) || hasDependencyCycle(planItems)) { reservation = { error: failure('INVALID_REQUEST', '协作计划依赖无效') }; return state }
        for (let index = 0; index < planItems.length; index += 1) {
          const item = planItems[index], child = childWorks[index], raw = body.items[index]
          if (child.capabilityId === 'cycle-time-calculate' && item.dependsOn.some(id => childWorks.find(work => work.planItemId === id)?.capabilityId === 'gearjob-work-order-read')
            && (Object.hasOwn(raw, 'quantity') || plainObject(raw.input) && Object.hasOwn(raw.input, 'quantity'))) {
            reservation = { error: failure('INVALID_INPUT', '剩余数量必须来自当前 GearJob 工单观察') }
            return state
          }
        }
        const rootExecutionId = `exec-${randomUUID()}`
        const rootWork = {
          id: rootWorkId, ownerMemberId: member.id, employeeId: leader.employee.id, skillId: leader.skill.id,
          capabilityId: leader.capability.id, ...(leader.connection ? { connectionId: leader.connection.id } : {}),
          goal, input: {}, requiredInputs: [], status: 'accepted', acceptedAt: now, results: [],
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
          if (!inputAllowed(binding, child.input)) throw serviceError('FORBIDDEN', '业务对象不在当前连接允许范围内')
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
        if (!inputAllowed(binding, parsed.input)) {
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
        active.get(executionId)?.controller.abort()
        await runner?.cancel?.(executionId)
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
          next.employeeIds = [...new Set(body.employeeIds)]
        }
        if (member.role === 'admin' && member.enabled === true && (next.role !== 'admin' || next.enabled !== true)) {
          if (!state.members.some(item => item.id !== id && item.enabled === true && item.role === 'admin')) throw serviceError('INVALID_REQUEST', '不能禁用或降级最后一个已启用管理员')
        }
        const authorityChanged = next.role !== member.role || next.enabled !== member.enabled || !sameStrings(next.employeeIds, member.employeeIds)
        updated = { ...next, sessionVersion: member.sessionVersion + (authorityChanged ? 1 : 0), updatedAt: clock() }
        return sweepKnowledgeDependencies({ ...state, members: replaceById(state.members, updated) })
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
      return kind === 'connections' ? state.connections.map(item => adminConnection(item, connectionCatalog)) : state[kind]
    },

    async createConfig(actor, kind, body = {}) {
      let created
      await store.update(state => {
        requireAdmin(state, actor)
        created = configEntity(state, kind, body, undefined, clock(), connectionCatalog)
        if (state[kind].some(item => item.id === created.id)) throw serviceError('INVALID_REQUEST', '配置 ID 已存在')
        return { ...state, [kind]: [...state[kind], created] }
      })
      return kind === 'connections' ? adminConnection(created, connectionCatalog) : created
    },

    async updateConfig(actor, kind, id, body = {}) {
      let updated
      await store.update(state => {
        requireAdmin(state, actor)
        const current = state[kind]?.find(item => item.id === id)
        if (!current) throw serviceError('NOT_FOUND', '配置不存在')
        updated = configEntity(state, kind, body, current, clock(), connectionCatalog)
        const next = { ...state, [kind]: replaceById(state[kind], updated) }
        return kind === 'employees' ? sweepKnowledgeDependencies(next) : next
      })
      return kind === 'connections' ? adminConnection(updated, connectionCatalog) : updated
    },

    async testConnection(actor, id) {
      const state = await store.read()
      requireAdmin(state, actor)
      const connection = state.connections.find(item => item.id === id)
      if (!connection) throw serviceError('NOT_FOUND', '连接不存在')
      if (connection.enabled !== true) throw serviceError('FORBIDDEN', '连接已停用')
      try { assertTrustedConnection(connectionCatalog, connection) } catch { throw serviceError('FORBIDDEN', '连接目标未在主机可信目录登记') }
      if (typeof connectionTester !== 'function') throw serviceError('SOURCE_NOT_CONFIGURED', '连接测试器未配置')
      const testedAt = clock()
      let detail
      try {
        detail = await connectionTester(connection)
      } catch (error) {
        const detail = safeError(error, 'UPSTREAM_ERROR')
        const lastTest = { ok: false, testedAt, ...detail }
        await store.update(current => ({ ...current, connections: current.connections.map(item => item.id === id && item.revision === connection.revision ? { ...item, status: 'error', lastTest } : item) }))
        throw serviceError(lastTest.code, lastTest.message)
      }
      const lastTest = compact({ ok: true, testedAt, detail: clean(detail) })
      let applied = false
      await store.update(current => ({ ...current, connections: current.connections.map(item => {
        if (item.id !== id || item.revision !== connection.revision) return item
        applied = true
        return { ...item, status: 'ready', lastTest }
      }) }))
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
      await Promise.all(tasks.map(item => runner?.cancel?.(item.executionId)))
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
        if (child.capabilityId === 'cycle-time-calculate' && Object.hasOwn(supplied ?? {}, 'quantity') && item.dependsOn.some(id => {
          const dependency = rootWork.plan.items.find(candidate => candidate.id === id)
          return state.works.find(work => work.id === dependency?.childWorkId)?.capabilityId === 'gearjob-work-order-read'
        })) { reservation = { error: failure('INVALID_INPUT', '剩余数量必须来自当前 GearJob 工单观察') }; return state }
        const parsed = parseInput(child.capabilityId, { ...child.input, ...(supplied ?? {}) }, false)
        if (!parsed.ok) { reservation = { error: parsed }; return state }
        if (!inputAllowed(binding, parsed.input)) { reservation = { error: failure('FORBIDDEN', '业务对象不在当前连接允许范围内') }; return state }
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

  function schedule(workId, executionId, operation, question) {
    const controller = new AbortController()
    const promise = execute(workId, executionId, operation, question, controller)
    active.set(executionId, { controller, executionId, promise })
    void promise.catch(() => undefined)
  }

  async function execute(workId, executionId, operation, question, controller) {
    try {
      if (!await markRunning(workId, executionId)) {
        if (controller.signal.aborted) await finishError(workId, executionId, serviceError('CANCELLED', '本次执行已停止'))
        return
      }
      const context = await dispatchContext(workId, executionId)
      if (controller.signal.aborted) throw serviceError('CANCELLED', '本次执行已停止')
      const sessionResult = latestSessionResult(context.work)
      const runnerOptions = {
        executionId, operation, capabilityId: context.work.capabilityId, input: context.work.input,
        sessionId: sessionResult?.dshSessionRef, sessionMetadata: context.metadata,
        grant: compact({ connection: context.connection, policyFile: policyPaths.stateFile, policyRoot: policyPaths.dataRoot, secretRoot: policyPaths.secretRoot }),
        confirmations: context.confirmations.map(item => ({ id: item.id, revision: item.revision, label: item.label, value: item.value })),
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
      const model = await explain(runnerOptions)
      if (operation === 'follow-up') await finishFollowUp(workId, executionId, question, model)
      else await finishBusinessResult(workId, executionId, model, context.work)
    } catch (error) { await finishError(workId, executionId, error) } finally { active.delete(executionId) }
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
      const binding = authorizedBinding(state, member, work, connectionCatalog)
      if (!binding.ok) throw serviceError(binding.error.code, binding.error.message)
      const parsed = validateCapabilityInput(work.capabilityId, work.input)
      if (!parsed.ok) throw serviceError(parsed.error.code, parsed.error.message)
      if (!inputAllowed(binding, parsed.input)) throw serviceError('FORBIDDEN', '业务对象不在当前连接允许范围内')
      const confirmations = currentConfirmations(state, member.id, work.employeeId)
      const refs = confirmations.map(item => ({ id: item.id, revision: item.revision }))
      const fingerprint = confirmationFingerprint(confirmations)
      context = {
        work, connection: binding.connection ?? null, confirmations,
        metadata: {
          ownerMemberId: member.id, workId: work.id, employeeId: work.employeeId, skillId: work.skillId,
          capabilityId: work.capabilityId, connectionId: binding.connection?.id ?? null,
          connectionRevision: binding.connection?.revision ?? null, modelRouteId: binding.route.id,
          confirmationRefs: refs, confirmationFingerprint: fingerprint,
        },
      }
      const nextExecution = compact({ ...execution, dispatchedAt: clock(), contextConfirmationRefs: refs,
        confirmationFingerprint: fingerprint, modelRouteId: binding.route.id, connectionId: binding.connection?.id,
        connectionRevision: binding.connection?.revision })
      return { ...state, works: replaceById(state.works, { ...work, executions: replaceById(work.executions, nextExecution) }) }
    })
    return context
  }

  async function explain(options) {
    if (!runner || runner.configured === false) throw serviceError('MODEL_NOT_CONFIGURED', '尚未配置 ZenMux DSH runner')
    return runner.run(options)
  }

  async function finishBusinessResult(workId, executionId, model, originalWork) {
    if (!model?.result) throw serviceError('TOOL_CHAIN_INVALID', 'DSH 未返回规范化能力结果')
    await finishResult(workId, executionId, businessEnvelope(model, originalWork, clock()), model)
  }

  async function finishFollowUp(workId, executionId, question, model) {
    const work = await findWork(workId)
    const result = compact({
      id: `follow-${randomUUID()}`, kind: 'assistant.follow-up', capabilityId: work?.capabilityId, skillId: work?.skillId,
      schemaVersion: 1, input: { text: question }, payload: { text: question }, explanation: clean(model?.explanation),
      createdAt: clock(), dshSessionRef: clean(model?.dshSessionRef), continuedFromDshSessionRef: clean(model?.continuedFromDshSessionRef),
      contextObservationId: clean(model?.contextResultId ?? model?.contextObservationId), continuity: clean(model?.continuity),
      contextConfirmationRefs: model?.contextConfirmationRefs ?? [],
    })
    if (!result.explanation || !result.dshSessionRef) throw serviceError('TOOL_CHAIN_INVALID', '追问结果不完整')
    await finishResult(workId, executionId, result, model)
  }

  async function finishResult(workId, executionId, result, model) {
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution) return state
      if (execution.status === 'cancel_requested') {
        const nextExecution = { ...execution, status: 'cancelled', completedAt: clock(), error: { code: 'CANCELLED', message: '本次执行已停止' } }
        return { ...state, works: replaceById(state.works, { ...work, status: 'cancelled', executions: replaceById(work.executions, nextExecution) }) }
      }
      if (execution.status !== 'running') return state
      const legacy = result.kind === 'gearjob.work-order.observation' ? { resultObservationId: result.id } : result.kind === 'assistant.follow-up' ? { resultFollowUpId: result.id } : {}
      const nextExecution = compact({ ...execution, status: 'completed', completedAt: clock(), dshSessionRef: result.dshSessionRef,
        continuedFromDshSessionRef: result.continuedFromDshSessionRef, contextObservationId: result.contextObservationId,
        continuity: result.continuity, contextConfirmationRefs: result.contextConfirmationRefs, dshEventCount: eventCount(model), resultId: result.id, ...legacy })
      const nextWork = { ...work, status: 'completed', results: [...work.results, result], executions: replaceById(work.executions, nextExecution) }
      return { ...state, works: replaceById(state.works, nextWork) }
    })
  }

  async function finishError(workId, executionId, error) {
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions.find(item => item.id === executionId)
      if (!work || !execution || TERMINAL_EXECUTION.has(execution.status)) return state
      const cancelled = execution.status === 'cancel_requested' || error?.code === 'CANCELLED' || error?.name === 'AbortError'
      const status = cancelled ? 'cancelled' : 'failed'
      const nextExecution = { ...execution, status, completedAt: clock(), error: cancelled ? { code: 'CANCELLED', message: '本次执行已停止' } : safeError(error) }
      return { ...state, works: replaceById(state.works, { ...work, status, executions: replaceById(work.executions, nextExecution) }) }
    })
  }

  async function recover() {
    if (recovered) return
    recovered = true
    await store.update(state => {
      let changed = false
      const works = state.works.map(work => {
        if (!ACTIVE_EXECUTION.has(work.status) && !work.executions.some(item => ACTIVE_EXECUTION.has(item.status))) return work
        changed = true
        const now = clock()
        const interrupted = { ...work, status: 'interrupted', executions: work.executions.map(execution => ACTIVE_EXECUTION.has(execution.status)
          ? { ...execution, status: 'interrupted', interruptedAt: now, error: { code: 'PROCESS_RESTARTED', message: '进程重启时未完成' } } : execution) }
        if (!work.collaboration) return interrupted
        return { ...interrupted, collaboration: { ...work.collaboration, status: 'interrupted' }, plan: { ...work.plan, items: work.plan.items.map(item => ['not_started', 'running', 'waiting_input'].includes(item.status) ? { ...item, status: 'interrupted' } : item) } }
      })
      return changed ? { ...state, works } : state
    })
  }

  async function ownedWork(actor, id) {
    const state = await store.read()
    const member = requireMember(state, actor)
    return findOwned(state, member, id)
  }

  async function projectOwned(actor, work) {
    if (!work.results.some(result => result.knowledgeDependencyRefs?.length) && !work.handoffs?.some(handoff => handoff.knowledgeRefs?.length)) return publicWork({ works: [work] }, { id: actor?.id }, work)
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
  if (base.kind === 'gearjob.work-order.observation') {
    payload = createObservation({ source: base.payload, queriedAt: now })
    payload.observationId = id
    payload.evidenceMode = base.payload.evidenceMode
    Object.assign(payload, compact({ explanation: clean(model.explanation), dshSessionRef: clean(model.dshSessionRef),
      continuedFromDshSessionRef: clean(model.continuedFromDshSessionRef), contextObservationId: clean(model.contextResultId ?? model.contextObservationId), continuity: clean(model.continuity) }))
  }
  const result = compact({
    id, kind: base.kind, capabilityId: work.capabilityId, skillId: work.skillId, schemaVersion: 1,
    input: structuredClone(work.input), payload, explanation: clean(model.explanation), source: base.source, createdAt: now,
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
  if (capability.requiresConnection) {
    connection = state.connections.find(item => item.id === clean(request.connectionId) && item.enabled === true && item.status === 'ready')
    if (!connection || connection.kind !== capability.connectionKind || !employee.connectionIds?.includes(connection.id) || !connection.skillIds?.includes(skill.id)) return failure('FORBIDDEN', '连接未获准或不可用')
    try { assertTrustedConnection(connectionCatalog, connection) } catch { return failure('FORBIDDEN', '连接目标未在主机可信目录登记') }
  } else if (request.connectionId !== undefined && request.connectionId !== null && request.connectionId !== '') return failure('INVALID_REQUEST', '该能力不使用连接')
  return { ok: true, member, employee, skill, capability, route, connection }
}

function inputAllowed(binding, input) {
  return !binding.capability.requiresConnection || input.workOrderId === undefined || binding.connection.allowedObjectIds?.includes(input.workOrderId)
}

function requireMember(state, actor) {
  const id = clean(actor?.id ?? actor?.memberId)
  const member = state.members.find(item => item.id === id && item.enabled === true)
  if (!member) throw serviceError('UNAUTHORIZED', '会话无效')
  return member
}
function requireAdmin(state, actor) { const member = requireMember(state, actor); if (member.role !== 'admin') throw serviceError('FORBIDDEN', '需要管理员权限'); return member }
function findOwned(state, member, id) { return state.works.find(item => item.id === id && item.ownerMemberId === member.id) }

function parseInput(capabilityId, input, allowMissing) {
  let parsed
  try { parsed = validateCapabilityInput(capabilityId, input, { allowMissing }) } catch (error) { return failure(error.code ?? 'CAPABILITY_NOT_FOUND', error.message) }
  return parsed.ok ? parsed : failure(parsed.error.code, parsed.error.message, { missing: parsed.missing })
}
function requestInput(body, capability) { if (body.input !== undefined) return body.input; return Object.fromEntries(capability.requiredInputs.filter(key => body[key] !== undefined).map(key => [key, body[key]])) }
function businessResults(work) { return work.results.filter(item => item.kind !== 'assistant.follow-up') }
function followUpFact(result) {
  if (result.kind === 'manufacturing.takt') return { kind: result.kind, payload: pick(result.payload, ['availableSeconds', 'quantity', 'secondsPerUnit', 'unit']) }
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
  if (!id || provider !== ZENMUX_PROVIDER || model !== ZENMUX_MODEL || !displayName || typeof enabled !== 'boolean' || credentialRef !== 'ZENMUX_API_KEY') throw serviceError('INVALID_REQUEST', '模型路由必须使用固定 ZenMux DeepSeek V4 Pro 配置')
  return { id, provider, model, displayName, enabled, credentialRef }
}
function skillConfig(body, current) {
  const capabilityId = body.capabilityId ?? current?.capabilityId, capability = getCapability(capabilityId)
  const id = current?.id ?? clean(body.id), name = clean(body.name ?? current?.name), enabled = body.enabled ?? current?.enabled ?? true
  if (!capability || id !== capability.skillId || !name || typeof enabled !== 'boolean') throw serviceError('INVALID_REQUEST', 'Skill 必须绑定可信 capability catalog')
  return { id, name, capabilityId, enabled }
}
function employeeConfig(state, body, current) {
  const result = { id: current?.id ?? clean(body.id), name: clean(body.name ?? current?.name), description: clean(body.description ?? current?.description) ?? '',
    enabled: body.enabled ?? current?.enabled ?? true, modelRouteId: body.modelRouteId ?? current?.modelRouteId ?? null,
    connectionIds: body.connectionIds ?? current?.connectionIds ?? [], skillIds: body.skillIds ?? current?.skillIds ?? [] }
  if (!result.id || !result.name || typeof result.enabled !== 'boolean' || !stringIds(result.connectionIds) || !stringIds(result.skillIds)) throw serviceError('INVALID_REQUEST', '员工配置无效')
  if (!state.modelRoutes.some(item => item.id === result.modelRouteId)) throw serviceError('INVALID_REQUEST', '员工模型路由不存在')
  if (result.connectionIds.some(id => !state.connections.some(item => item.id === id)) || result.skillIds.some(id => !state.skills.some(item => item.id === id))) throw serviceError('INVALID_REQUEST', '员工绑定引用不存在')
  return result
}
function connectionConfig(state, body, current, now, connectionCatalog) {
  const result = { id: current?.id ?? clean(body.id), name: clean(body.name ?? current?.name), kind: body.kind ?? current?.kind,
    targetIdentity: clean(body.targetIdentity ?? current?.targetIdentity), baseUrl: clean(body.baseUrl ?? current?.baseUrl),
    ...(body.hostHeader !== undefined || current?.hostHeader !== undefined ? { hostHeader: clean(body.hostHeader ?? current?.hostHeader) } : {}),
    credentialRef: clean(body.credentialRef ?? current?.credentialRef), allowedObjectIds: body.allowedObjectIds ?? current?.allowedObjectIds ?? [],
    sourceSystem: clean(body.sourceSystem ?? current?.sourceSystem), sourceInstance: clean(body.sourceInstance ?? current?.sourceInstance),
    sourceEnvironment: clean(body.sourceEnvironment ?? current?.sourceEnvironment), dataMode: clean(body.dataMode ?? current?.dataMode),
    evidenceMode: clean(body.evidenceMode ?? current?.evidenceMode), enabled: body.enabled ?? current?.enabled ?? true,
    status: 'unknown', skillIds: body.skillIds ?? current?.skillIds ?? [], revision: current ? current.revision + 1 : 1,
    updatedAt: now }
  if (current && CONNECTION_IDENTITY_FIELDS.some(key => result[key] !== current[key])) throw serviceError('INVALID_REQUEST', '连接目标/来源 identity 不可原地更换')
  if (!result.id || !result.name || result.kind !== 'gearjob-rest' || !result.targetIdentity || !result.baseUrl || !simpleRef(result.credentialRef) || !stringIds(result.allowedObjectIds) || !stringIds(result.skillIds) || typeof result.enabled !== 'boolean') throw serviceError('INVALID_REQUEST', '连接配置无效')
  if (result.skillIds.some(id => !state.skills.some(item => item.id === id && getCapability(item.capabilityId)?.connectionKind === result.kind))) throw serviceError('INVALID_REQUEST', '连接 Skill 绑定无效')
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
  return { ...value, observations, followUps }
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
function publicConnection(connection, catalog) {
  return pick(visibleConnection(connection, catalog), ['id', 'name', 'kind', 'targetIdentity', 'sourceSystem', 'sourceInstance', 'sourceEnvironment', 'dataMode', 'evidenceMode', 'enabled', 'status', 'skillIds', 'revision', 'lastTest'])
}
function adminConnection(connection, catalog) { return visibleConnection(connection, catalog) }
function visibleConnection(connection, catalog) {
  const value = structuredClone(connection)
  if (value.lastTest?.ok === false) value.lastTest = { ...value.lastTest, ...safeError(value.lastTest) }
  try { assertTrustedConnection(catalog, connection); return value } catch { return { ...value, status: 'unavailable' } }
}
function publicCapability(capability) { return { id: capability.id, skillId: capability.skillId, action: capability.action, requiredInputs: [...capability.requiredInputs], requiresConnection: capability.requiresConnection, resultKind: capability.resultKind } }
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
function safeError(error, fallbackCode = 'INTERNAL_ERROR') {
  const code = error?.code ?? fallbackCode
  return SAFE_ERROR_MESSAGES[code] ? { code, message: SAFE_ERROR_MESSAGES[code] } : { ...GENERIC_ERROR }
}
function failure(code, message, extra = {}) { return { ok: false, error: { code, message, status: ERROR_STATUS[code] ?? 500, ...extra } } }
export function serviceFailure(error) { return failure(error?.code ?? 'INTERNAL_ERROR', error?.message ?? '服务暂时无法完成请求') }
export function safeServiceError(error) { return safeError(error) }
