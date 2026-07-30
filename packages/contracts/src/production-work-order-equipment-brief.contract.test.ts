import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_BRIEF_EVALUATION_AS_OF,
  PRODUCTION_BRIEF_OPERATION_IDS,
  productionBriefInternalRequestSchema,
  productionWorkOrderEquipmentBriefRequestSchema,
} from './production-work-order-equipment-brief.js';

describe('production work order equipment brief contract', () => {
  it('exposes one product capability input and exactly four internal operations', () => {
    expect(PRODUCTION_BRIEF_OPERATION_IDS).toEqual([
      'production.work_order.get.v1',
      'production.work_order.equipment.resolve.v1',
      'equipment.runtime_status.get.v1',
      'equipment.alarm_segments.list.v1',
    ]);
    expect(productionWorkOrderEquipmentBriefRequestSchema.parse({
      capabilityId: 'production.work_order_equipment_brief.v1',
      scenarioRef: 'SCN-NORMAL',
      evaluationAsOf: PRODUCTION_BRIEF_EVALUATION_AS_OF,
    })).toMatchObject({ scenarioRef: 'SCN-NORMAL' });
  });

  it('rejects unknown scenario selectors and arbitrary operation IDs', () => {
    expect(productionBriefInternalRequestSchema.safeParse({
      operationId: 'provider.http.get', selector: { scenarioRef: 'SCN-NORMAL' },
    }).success).toBe(false);
    expect(productionWorkOrderEquipmentBriefRequestSchema.safeParse({
      capabilityId: 'production.work_order_equipment_brief.v1',
      scenarioRef: 'SCN-OTHER',
      evaluationAsOf: PRODUCTION_BRIEF_EVALUATION_AS_OF,
    }).success).toBe(false);
  });
});
