import { describe, expect, it, vi } from 'vitest';
import { PRODUCTION_BRIEF_EVALUATION_AS_OF, type ProductionBriefInternalRequest } from '@geneway/contracts';
import {
  createProductionCapabilityHttpClient,
  ProductionWorkOrderEquipmentBriefService,
} from './production-work-order-equipment-brief.js';

const token = 'synthetic-service-token-at-least-32-bytes';
describe('production brief application-to-gateway integration', () => {
  it('crosses the HTTP client contract without using a provider import in the application service', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => Promise.resolve().then(() => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      const body = JSON.parse(init.body) as ProductionBriefInternalRequest;
      const source = { system: body.operationId.startsWith('production.') ? 'GearJob' : 'Hive', operationId: body.operationId, revision: 'synthetic-r1', observedAt: '2026-07-29T08:29:42.000Z' } as const;
      const payload = body.operationId === 'production.work_order.get.v1'
        ? { operationId: body.operationId, result: { workOrderRef: 'WO-260729-001', itemName: '主轴箱体 A', status: 'IN_PROGRESS', planQty: 120, completedQty: 87, unit: '件', progressPct: 72.5, expectedProgressPct: 70, plannedEnd: '2026-07-29T16:00:00.000Z', source } }
        : body.operationId === 'production.work_order.equipment.resolve.v1'
          ? { operationId: body.operationId, result: { cardinality: 'single', workstations: ['CNC-精加工-01'], equipmentRefs: ['CNC-001'], selectedEquipmentRef: 'CNC-001', source } }
          : body.operationId === 'equipment.runtime_status.get.v1'
            ? { operationId: body.operationId, result: { knownState: 'KNOWN', status: 'RUN', source } }
            : { operationId: body.operationId, result: { start: body.window.start, end: body.window.end, coverage: 'COMPLETE', segments: [], source } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const service = new ProductionWorkOrderEquipmentBriefService(createProductionCapabilityHttpClient({
      gatewayUrl: 'http://127.0.0.1:3165', serviceToken: token, fetchImpl,
    }));
    await expect(service.run({
      capabilityId: 'production.work_order_equipment_brief.v1', scenarioRef: 'SCN-NORMAL',
      evaluationAsOf: PRODUCTION_BRIEF_EVALUATION_AS_OF,
    })).resolves.toMatchObject({ action: 'NO_ACTION', provenance: 'SYNTHETIC_DEMO' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([input]) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(href).origin === 'http://127.0.0.1:3165';
    })).toBe(true);
  });
});
