import { randomUUID } from 'node:crypto'

export function normalizeWorkOrder(input, queriedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object') throw new TypeError('work order must be an object')
  const workOrderId = requiredString(input.workOrderId, 'workOrderId')
  const status = requiredString(input.status, 'status')
  const unit = optionalString(input.unit)
  const plannedQuantity = numberOrUndefined(input.plannedQuantity)
  const completedQuantity = numberOrUndefined(input.completedQuantity)
  const sourceTime = optionalString(input.sourceTime)
  const sourceRecordId = requiredString(input.sourceRecordId, 'sourceRecordId')
  return {
    workOrderId,
    status,
    unit,
    plannedQuantity,
    completedQuantity,
    completion: computeCompletion({ plannedQuantity, completedQuantity, unit }),
    sourceTime,
    queriedAt,
    sourceRecordId,
    sourceRevision: optionalString(input.sourceRevision),
    sourceSystem: optionalString(input.sourceSystem),
    sourceInstance: optionalString(input.sourceInstance),
    sourceEnvironment: optionalString(input.sourceEnvironment),
    dataMode: optionalString(input.dataMode),
    explanation: optionalString(input.explanation),
    dshSessionRef: optionalString(input.dshSessionRef),
    continuedFromDshSessionRef: optionalString(input.continuedFromDshSessionRef),
    contextObservationId: optionalString(input.contextObservationId),
    continuity: optionalString(input.continuity),
  }
}

export function createObservation({ source, queriedAt = new Date().toISOString() }) {
  if (!source || typeof source !== 'object') throw new TypeError('source observation is required')
  return {
    observationId: 'obs-' + randomUUID(),
    ...normalizeWorkOrder(source, queriedAt),
  }
}

export function computeCompletion({ plannedQuantity, completedQuantity, unit }) {
  if (!Number.isFinite(plannedQuantity) || plannedQuantity <= 0) {
    return { ratio: undefined, reason: '计划量缺失或不是正数' }
  }
  if (!Number.isFinite(completedQuantity) || completedQuantity < 0) {
    return { ratio: undefined, reason: '完成量缺失或不是非负数' }
  }
  if (typeof unit !== 'string' || unit.trim() === '') {
    return { ratio: undefined, reason: '单位缺失，无法比较数量' }
  }
  return {
    ratio: completedQuantity / plannedQuantity,
    overPlan: completedQuantity > plannedQuantity,
    reason: undefined,
  }
}

function requiredString(value, field) {
  const result = optionalString(value)
  if (!result) throw new TypeError(field + ' is required')
  return result
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
