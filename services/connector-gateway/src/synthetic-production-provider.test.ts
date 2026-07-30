import { describe, expect, it, vi } from 'vitest';
import type { GearJobSyntheticAdapter, HiveSyntheticAdapter } from './synthetic-production-provider.js';
import { createSyntheticProductionProvider } from './synthetic-production-provider.js';

describe('synthetic production adapters', () => {
  it('returns provider-shaped SCN-NORMAL facts without decisions or final copy', async () => {
    const provider = createSyntheticProductionProvider();
    const workOrder = await provider.invoke({
      operationId: 'production.work_order.get.v1', selector: { scenarioRef: 'SCN-NORMAL' },
    });
    expect(workOrder.operationId).toBe('production.work_order.get.v1');
    expect(JSON.stringify(workOrder)).not.toMatch(/NO_ACTION|expectedDecision|recommendedNextStep/u);
    expect(provider.calls()).toHaveLength(1);
  });

  it('routes GearJob and Hive operations through independently injected adapters', async () => {
    const gearJobAdapter: GearJobSyntheticAdapter = { invoke: vi.fn<GearJobSyntheticAdapter['invoke']>(() => Promise.resolve({
      operationId: 'production.work_order.get.v1',
      result: {
        workOrderRef: 'WO-INJECTED', itemName: '注入工单', status: 'IN_PROGRESS', planQty: 1,
        completedQty: 1, unit: '件', progressPct: 100, expectedProgressPct: 100,
        plannedEnd: '2026-07-29T16:00:00.000Z', source: {
          system: 'GearJob', operationId: 'production.work_order.get.v1', revision: 'injected',
          observedAt: '2026-07-29T08:29:42.000Z',
        },
      },
    })) };
    const hiveAdapter: HiveSyntheticAdapter = { invoke: vi.fn<HiveSyntheticAdapter['invoke']>(() => Promise.resolve({
      operationId: 'equipment.runtime_status.get.v1', result: {
        knownState: 'KNOWN', status: 'RUN', source: {
          system: 'Hive', operationId: 'equipment.runtime_status.get.v1', revision: 'injected',
          observedAt: '2026-07-29T08:29:42.000Z',
        },
      },
    })) };
    const provider = createSyntheticProductionProvider({ gearJobAdapter, hiveAdapter });
    await provider.invoke({ operationId: 'production.work_order.get.v1', selector: { scenarioRef: 'SCN-NORMAL' } });
    await provider.invoke({ operationId: 'equipment.runtime_status.get.v1', selector: { scenarioRef: 'SCN-NORMAL' }, equipmentRef: 'CNC-001' });
    expect(gearJobAdapter.invoke).toHaveBeenCalledTimes(1);
    expect(hiveAdapter.invoke).toHaveBeenCalledTimes(1);
  });
});
