import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_BRIEF_EVALUATION_AS_OF,
  type ProductionBriefInternalRequest,
  type ProductionBriefInternalResponse,
} from '@geneway/contracts';
import { ProductionWorkOrderEquipmentBriefService } from './production-work-order-equipment-brief.js';

function normalPort() {
  const calls: ProductionBriefInternalRequest[] = [];
  return {
    calls,
    invoke: (input: ProductionBriefInternalRequest): Promise<ProductionBriefInternalResponse> => Promise.resolve().then(() => {
      calls.push(input);
      const source = { system: input.operationId.startsWith('production.') ? 'GearJob' : 'Hive', operationId: input.operationId, revision: 'synthetic-r1', observedAt: '2026-07-29T08:29:42.000Z' } as const;
      switch (input.operationId) {
        case 'production.work_order.get.v1': return { operationId: input.operationId, result: { workOrderRef: 'WO-260729-001', itemName: '主轴箱体 A', status: 'IN_PROGRESS', planQty: 120, completedQty: 87, unit: '件', progressPct: 72.5, expectedProgressPct: 70, plannedEnd: '2026-07-29T16:00:00.000Z', source } };
        case 'production.work_order.equipment.resolve.v1': return { operationId: input.operationId, result: { cardinality: 'single', workstations: ['CNC-精加工-01'], equipmentRefs: ['CNC-001'], selectedEquipmentRef: 'CNC-001', source } };
        case 'equipment.runtime_status.get.v1': return { operationId: input.operationId, result: { knownState: 'KNOWN', status: 'RUN', source } };
        case 'equipment.alarm_segments.list.v1': return { operationId: input.operationId, result: { start: input.window.start, end: input.window.end, coverage: 'COMPLETE', segments: [], source } };
      }
    }),
  };
}

describe('ProductionWorkOrderEquipmentBriefService', () => {
  it('derives NO_ACTION from facts and records the exact four-operation order', async () => {
    const provider = normalPort();
    const service = new ProductionWorkOrderEquipmentBriefService(provider);
    const result = await service.run({
      capabilityId: 'production.work_order_equipment_brief.v1',
      scenarioRef: 'SCN-NORMAL', evaluationAsOf: PRODUCTION_BRIEF_EVALUATION_AS_OF,
    });
    expect(result).toMatchObject({ action: 'NO_ACTION', reasonCode: 'NORMAL_OPERATION', freshness: { statusAgeSeconds: 18 } });
    expect(provider.calls.map((call) => call.operationId)).toEqual([
      'production.work_order.get.v1', 'production.work_order.equipment.resolve.v1',
      'equipment.runtime_status.get.v1', 'equipment.alarm_segments.list.v1',
    ]);
    expect(result.trace).toHaveLength(5);
  });
});
