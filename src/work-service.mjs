import { randomUUID } from 'node:crypto'
import { createObservation } from './domain/work-order.mjs'

export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SOURCE_NOT_CONFIGURED: 503,
  MODEL_NOT_CONFIGURED: 503,
  BUSY: 409,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  INVALID_SOURCE: 502,
}

const ACTIVE_EXECUTION = new Set(['accepted', 'running', 'cancel_requested'])
const P1_SKILL_ID = 'skill-gearjob-work-order-read'
const P1_SKILL_ACTION = 'gearjob.work-order.read'
const P1_SKILL_TOOL = 'geneway_gearjob_read_work_order'

export function createWorkService({ store, source = null, runner = null, clock = () => new Date().toISOString() }) {
  const active = new Map()
  let recovered = false

  return {
    async bootstrap() {
      await recover()
      await ensureDefaultBinding()
      const state = await store.read()
      return {
        operator: state.operator,
        employees: state.employees,
        connections: state.connections.map(connection => ({ ...connection, enabled: connection.enabled !== false })),
        skills: state.skills,
        works: state.works.map(publicWork),
        capability: {
          source: sourceReady() ? 'configured' : 'not-configured',
          sourceEnvironment: sourceReady() ? 'external-test' : undefined,
          dataMode: sourceReady() ? 'synthetic' : undefined,
          model: runner?.configured === false ? 'not-configured' : runner ? 'configured' : 'not-configured',
          runtime: runner ? 'dsh-sdk' : 'not-configured',
        },
      }
    },

    async createWork({ workOrderId, employeeId, connectionId, clientRequestId } = {}) {
      await recover()
      await ensureDefaultBinding()
      const orderId = clean(workOrderId)
      if (!orderId) return failure('INVALID_REQUEST', '工单号不能为空')
      if (!sourceReady()) return failure('SOURCE_NOT_CONFIGURED', '尚未配置真实工单来源；未创建工作')
      if (!sourceAllows(orderId)) return failure('FORBIDDEN', '工单不在当前连接的允许范围内')
      const requestId = clean(clientRequestId) ?? `request-${randomUUID()}`
      let reservation
      await store.update(state => {
        const key = reservationKey(state.operator.id, 'create', requestId)
        const previous = state.reservations[key]
        if (previous) {
          reservation = { deduplicated: true, ...previous }
          return state
        }
        const binding = authorizedBinding(state, employeeId, connectionId)
        if (!binding) {
          reservation = { error: failure('FORBIDDEN', '员工或连接未获准用于本次工作') }
          return state
        }
        const workId = `work-${randomUUID()}`
        const executionId = `exec-${randomUUID()}`
        const now = clock()
        const work = {
          id: workId,
          operatorId: state.operator.id,
          clientRequestId: requestId,
          employeeId: binding.employee.id,
          connectionId: binding.connection.id,
          workOrderId: orderId,
          status: 'accepted',
          acceptedAt: now,
          observations: [],
          executions: [{ id: executionId, operation: 'create', clientRequestId: requestId, status: 'accepted', acceptedAt: now }],
          followUps: [],
        }
        reservation = { workId, executionId, work }
        return { ...state, works: [...state.works, work], reservations: { ...state.reservations, [key]: { workId, executionId } } }
      })
      if (reservation?.error) return reservation.error
      const work = reservation.work ?? await findWork(reservation.workId)
      if (!work) return failure('NOT_FOUND', '工作不存在')
      if (!reservation.deduplicated) schedule(reservation.workId, reservation.executionId, 'create')
      return { ok: true, value: publicWork(work), deduplicated: Boolean(reservation.deduplicated), accepted: !reservation.deduplicated }
    },

    async getWork(id) {
      await recover()
      const work = await findWork(id)
      return work ? { ok: true, value: publicWork(work) } : failure('NOT_FOUND', '工作不存在')
    },

    async refreshWork(id, { clientRequestId } = {}) {
      await recover()
      if (!sourceReady()) return failure('SOURCE_NOT_CONFIGURED', '尚未配置真实工单来源；未执行刷新')
      const requestId = clean(clientRequestId) ?? `refresh-${randomUUID()}`
      let reservation
      await store.update(state => {
        const work = state.works.find(item => item.id === id)
        if (!work) {
          reservation = { error: failure('NOT_FOUND', '工作不存在') }
          return state
        }
        const key = reservationKey(state.operator.id, id, 'refresh', requestId)
        const previous = state.reservations[key]
        if (previous) {
          reservation = { deduplicated: true, ...previous }
          return state
        }
        if (work.executions?.some(item => ACTIVE_EXECUTION.has(item.status))) {
          reservation = { error: failure('BUSY', '当前工作已有执行正在进行') }
          return state
        }
        if (!authorizedBinding(state, work.employeeId, work.connectionId)) {
          reservation = { error: failure('FORBIDDEN', '当前员工或连接已不再获准刷新') }
          return state
        }
        const executionId = `exec-${randomUUID()}`
        const now = clock()
        const nextWork = { ...work, status: 'accepted', executions: [...(work.executions ?? []), { id: executionId, operation: 'refresh', clientRequestId: requestId, status: 'accepted', acceptedAt: now }] }
        reservation = { workId: id, executionId, nextWork }
        return { ...state, works: state.works.map(item => item.id === id ? nextWork : item), reservations: { ...state.reservations, [key]: { workId: id, executionId } } }
      })
      if (reservation?.error) return reservation.error
      const work = reservation.nextWork ?? await findWork(reservation.workId)
      if (!work) return failure('NOT_FOUND', '工作不存在')
      if (!reservation.deduplicated) schedule(reservation.workId, reservation.executionId, 'refresh')
      return { ok: true, value: publicWork(work), deduplicated: Boolean(reservation.deduplicated), accepted: !reservation.deduplicated }
    },

    async followUp(id, text, { clientRequestId } = {}) {
      await recover()
      const question = clean(text)
      if (!question) return failure('INVALID_REQUEST', '补充内容不能为空')
      if (question.length > 4000) return failure('INVALID_REQUEST', '补充内容过长')
      const requestId = clean(clientRequestId) ?? `follow-up-${randomUUID()}`
      let reservation
      await store.update(state => {
        const work = state.works.find(item => item.id === id)
        if (!work) {
          reservation = { error: failure('NOT_FOUND', '工作不存在') }
          return state
        }
        if (!work.observations?.length) {
          reservation = { error: failure('BUSY', '尚无可供追问的观察') }
          return state
        }
        const key = reservationKey(state.operator.id, id, 'follow-up', requestId)
        const previous = state.reservations[key]
        if (previous) {
          reservation = { deduplicated: true, ...previous }
          return state
        }
        if (work.executions?.some(item => ACTIVE_EXECUTION.has(item.status))) {
          reservation = { error: failure('BUSY', '当前工作已有执行正在进行') }
          return state
        }
        if (!authorizedBinding(state, work.employeeId, work.connectionId)) {
          reservation = { error: failure('FORBIDDEN', '当前员工或连接已不再获准追问') }
          return state
        }
        const executionId = `exec-${randomUUID()}`
        const now = clock()
        const nextWork = { ...work, status: 'accepted', executions: [...(work.executions ?? []), { id: executionId, operation: 'follow-up', clientRequestId: requestId, status: 'accepted', acceptedAt: now }] }
        reservation = { workId: id, executionId, question, nextWork }
        return { ...state, works: state.works.map(item => item.id === id ? nextWork : item), reservations: { ...state.reservations, [key]: { workId: id, executionId } } }
      })
      if (reservation?.error) return reservation.error
      const work = reservation.nextWork ?? await findWork(reservation.workId)
      if (!work) return failure('NOT_FOUND', '工作不存在')
      if (!reservation.deduplicated) schedule(reservation.workId, reservation.executionId, 'follow-up', reservation.question)
      return { ok: true, value: publicWork(work), deduplicated: Boolean(reservation.deduplicated), accepted: !reservation.deduplicated }
    },

    async cancel(id) {
      await recover()
      let executionId
      let current
      let changed = false
      await store.update(state => {
        const work = state.works.find(item => item.id === id)
        if (!work) {
          current = { error: failure('NOT_FOUND', '工作不存在') }
          return state
        }
        const execution = [...(work.executions ?? [])].reverse().find(item => ACTIVE_EXECUTION.has(item.status))
        if (!execution) {
          current = { value: work }
          return state
        }
        executionId = execution.id
        const now = clock()
        const nextExecution = { ...execution, status: 'cancel_requested', cancelRequestedAt: now }
        const nextWork = { ...work, status: 'cancel_requested', executions: work.executions.map(item => item.id === execution.id ? nextExecution : item) }
        changed = true
        current = { value: nextWork }
        return { ...state, works: state.works.map(item => item.id === id ? nextWork : item) }
      })
      if (current?.error) return current.error
      if (changed) {
        active.get(executionId)?.controller.abort()
        await runner?.cancel?.(executionId)
      }
      return { ok: true, value: publicWork(current.value ?? await findWork(id)), accepted: changed }
    },

    async close() {
      const tasks = [...active.values()]
      for (const item of tasks) item.controller.abort()
      await Promise.all(tasks.map(item => runner?.cancel?.(item.executionId)))
      await Promise.all(tasks.map(item => item.promise.catch(() => undefined)))
      await runner?.close?.()
    },
  }

  async function recover() {
    if (recovered) return
    recovered = true
    await store.update(state => {
      let changed = false
      const works = state.works.map(work => {
        if (!ACTIVE_EXECUTION.has(work.status) && !work.executions?.some(item => ACTIVE_EXECUTION.has(item.status))) return work
        changed = true
        return { ...work, status: 'interrupted', executions: (work.executions ?? []).map(execution => ACTIVE_EXECUTION.has(execution.status) ? { ...execution, status: 'interrupted', interruptedAt: clock(), error: { code: 'PROCESS_RESTARTED', message: '进程重启时未完成' } } : execution) }
      })
      return changed ? { ...state, works } : state
    })
  }

  async function ensureDefaultBinding() {
    if (!sourceReady()) return
    await store.update(state => {
      if (state.employees.length || state.connections.length) return state
      const connectionId = 'connection-gearjob'
      return {
        ...state,
        skills: [{ id: P1_SKILL_ID, name: 'GearJob 工单只读查询', action: P1_SKILL_ACTION, toolName: P1_SKILL_TOOL, enabled: true }],
        employees: [{ id: 'employee-gearjob', name: 'GearJob 只读员工', description: '读取受限的 GearJob 工单并说明依据', enabled: true, connectionIds: [connectionId], skillIds: [P1_SKILL_ID] }],
        connections: [{ id: connectionId, name: 'GearJob 外部测试只读连接', kind: 'gearjob-rest', status: 'ready', enabled: true, skillIds: [P1_SKILL_ID] }],
      }
    })
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
      const work = await findWork(workId)
      if (!work) return
      if (!await reauthorized(work)) throw serviceError('FORBIDDEN', '当前员工或连接已不再获准执行')
      if (controller.signal.aborted) throw serviceError('CANCELLED', '本次执行已停止')
      if (operation === 'follow-up') {
        const latest = work.observations.at(-1)
        const model = await explain({ executionId, sessionId: latest?.dshSessionRef, workOrderId: work.workOrderId, operation, observation: latest, question })
        await finishFollowUp(workId, executionId, question, model)
        return
      }
      const previous = work.observations.at(-1)
      const model = await explain({ executionId, sessionId: previous?.dshSessionRef, workOrderId: work.workOrderId, operation, observation: previous })
      if (!model.observation) throw serviceError('TOOL_CHAIN_INVALID', 'DSH 未返回规范化工单观察')
      const observation = createObservation({ source: model.observation, queriedAt: clock() })
      Object.assign(observation, {
        explanation: model.explanation,
        dshSessionRef: model.dshSessionRef,
        continuedFromDshSessionRef: model.continuedFromDshSessionRef,
        contextObservationId: model.contextObservationId,
        continuity: model.continuity,
      })
      await finishObservation(workId, executionId, observation, model)
    } catch (error) {
      await finishError(workId, executionId, error)
    } finally {
      active.delete(executionId)
    }
  }

  async function markRunning(workId, executionId) {
    let started = false
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions?.find(item => item.id === executionId)
      if (!work || !execution || execution.status !== 'accepted') return state
      started = true
      const now = clock()
      return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status: 'running', executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status: 'running', startedAt: now } : entry) } : item) }
    })
    return started
  }

  async function explain({ executionId, sessionId, workOrderId, operation, observation, question }) {
    if (!runner) throw serviceError('MODEL_NOT_CONFIGURED', '尚未配置 DSH runner')
    if (runner.configured === false) throw serviceError('MODEL_NOT_CONFIGURED', '尚未配置 ZenMux 模型凭据')
    return runner.run({ executionId, sessionId, workOrderId, operation, observation, question })
  }

  async function finishObservation(workId, executionId, observation, model) {
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions?.find(item => item.id === executionId)
      if (!work || !execution || ['cancelled', 'interrupted'].includes(execution.status)) return state
      if (execution.status === 'cancel_requested') {
        const now = clock()
        return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status: 'cancelled', executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status: 'cancelled', completedAt: now, error: { code: 'CANCELLED', message: '本次执行已停止' } } : entry) } : item) }
      }
      const now = clock()
      return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status: 'completed', observations: [...(item.observations ?? []), observation], executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status: 'completed', completedAt: now, dshSessionRef: observation.dshSessionRef, continuedFromDshSessionRef: observation.continuedFromDshSessionRef, contextObservationId: observation.contextObservationId, continuity: observation.continuity, dshEventCount: eventCount(model), resultObservationId: observation.observationId } : entry) } : item) }
    })
  }

  async function finishFollowUp(workId, executionId, question, model) {
    const followUpId = `follow-${randomUUID()}`
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions?.find(item => item.id === executionId)
      if (!work || !execution || ['cancelled', 'interrupted'].includes(execution.status)) return state
      if (execution.status === 'cancel_requested') {
        const now = clock()
        return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status: 'cancelled', executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status: 'cancelled', completedAt: now, error: { code: 'CANCELLED', message: '本次执行已停止' } } : entry) } : item) }
      }
      const now = clock()
      return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status: 'completed', followUps: [...(item.followUps ?? []), { id: followUpId, text: question, explanation: model.explanation, at: now, dshSessionRef: model.dshSessionRef, continuedFromDshSessionRef: model.continuedFromDshSessionRef, contextObservationId: model.contextObservationId, continuity: model.continuity }], executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status: 'completed', completedAt: now, dshSessionRef: model.dshSessionRef, continuedFromDshSessionRef: model.continuedFromDshSessionRef, contextObservationId: model.contextObservationId, continuity: model.continuity, dshEventCount: eventCount(model), resultFollowUpId: followUpId } : entry) } : item) }
    })
  }

  async function finishError(workId, executionId, error) {
    await store.update(state => {
      const work = state.works.find(item => item.id === workId)
      const execution = work?.executions?.find(item => item.id === executionId)
      if (!work || !execution) return state
      const cancelled = execution.status === 'cancel_requested' || error?.code === 'CANCELLED' || error?.name === 'AbortError'
      const status = cancelled ? 'cancelled' : 'failed'
      const now = clock()
      return { ...state, works: state.works.map(item => item.id === workId ? { ...item, status, executions: item.executions.map(entry => entry.id === executionId ? { ...entry, status, completedAt: now, error: safeError(error) } : entry) } : item) }
    })
  }

  async function findWork(id) {
    return (await store.read()).works.find(item => item.id === id)
  }

  async function reauthorized(work) {
    const state = await store.read()
    return Boolean(authorizedBinding(state, work.employeeId, work.connectionId) && sourceAllows(work.workOrderId))
  }

  function sourceReady() {
    if (runner?.sourceConfigured !== undefined) return Boolean(runner.sourceConfigured)
    return Boolean(source?.configured !== false && (source?.configured || runner?.configured) && runner?.run)
  }

  function sourceAllows(workOrderId) {
    return typeof source?.allows !== 'function' || source.allows(workOrderId) === true
  }
}

function eventCount(model) {
  return Number.isInteger(model?.eventCount) && model.eventCount >= 0 ? model.eventCount : undefined
}

function authorizedBinding(state, employeeId, connectionId) {
  const employee = state.employees.find(item => item.id === employeeId && item.enabled !== false)
  const connection = state.connections.find(item => item.id === connectionId && item.enabled !== false && item.status === 'ready')
  const skill = state.skills?.find(item => item.id === P1_SKILL_ID && item.enabled !== false && item.action === P1_SKILL_ACTION && item.toolName === P1_SKILL_TOOL)
  return employee && connection && skill && employee.connectionIds?.includes(connection.id) && employee.skillIds?.includes(skill.id) && connection.skillIds?.includes(skill.id) ? { employee, connection, skill } : undefined
}

function reservationKey(operatorId, ...parts) {
  return [operatorId, ...parts].map(value => String(value ?? '')).join('|')
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function serviceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeError(error) {
  return { code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? '执行失败' }
}

function publicWork(work) {
  return { id: work.id, operatorId: work.operatorId, employeeId: work.employeeId, connectionId: work.connectionId, workOrderId: work.workOrderId, status: work.status, acceptedAt: work.acceptedAt, observations: work.observations ?? [], executions: work.executions ?? [], followUps: work.followUps ?? [] }
}

function failure(code, message) {
  return { ok: false, error: { code, message, status: ERROR_STATUS[code] ?? 500 } }
}
