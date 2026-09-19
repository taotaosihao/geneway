import assert from 'node:assert/strict'
import { computeCompletion, normalizeWorkOrder } from '../src/domain/work-order.mjs'

assert.deepEqual(computeCompletion({ plannedQuantity: 10, completedQuantity: 4, unit: '件' }), { ratio: 0.4, overPlan: false, reason: undefined })
assert.equal(computeCompletion({ plannedQuantity: 10, completedQuantity: 12, unit: '件' }).overPlan, true)
assert.equal(computeCompletion({ plannedQuantity: 0, completedQuantity: 4, unit: '件' }).ratio, undefined)
assert.equal(computeCompletion({ plannedQuantity: 0, completedQuantity: 4, unit: '件' }).reason, 'PLANNED_QUANTITY_INVALID')
assert.equal(computeCompletion({ plannedQuantity: 10, completedQuantity: -1, unit: '件' }).reason, 'COMPLETED_QUANTITY_INVALID')
assert.equal(computeCompletion({ plannedQuantity: 10, completedQuantity: 4, unit: undefined }).reason, 'UNIT_MISSING')
assert.equal(normalizeWorkOrder({
  workOrderId: 'WO-1',
  status: 'running',
  plannedQuantity: 10,
  completedQuantity: 2,
  unit: '件',
  sourceRecordId: 'source-1',
}, '2026-09-19T00:00:00.000Z').completion.ratio, 0.2)
console.log('domain checks passed')
