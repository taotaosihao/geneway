import {
  productionBriefInternalRequestSchema,
  productionBriefInternalResponseSchema,
  type ProductionBriefInternalRequest,
  type ProductionBriefInternalResponse,
} from '@geneway/contracts';

const observedAt = '2026-07-29T08:29:42.000Z';

function source(system: 'GearJob' | 'Hive', operationId: ProductionBriefInternalRequest['operationId'], revision: string) {
  return { system, operationId, revision, observedAt } as const;
}

export type SyntheticProductionProvider = Readonly<{
  invoke(input: ProductionBriefInternalRequest): Promise<ProductionBriefInternalResponse>;
  calls(): readonly ProductionBriefInternalRequest[];
}>;

type GearJobRequest = Extract<ProductionBriefInternalRequest, { operationId: `production.${string}` }>;
type GearJobResponse = Extract<ProductionBriefInternalResponse, { operationId: `production.${string}` }>;
type HiveRequest = Extract<ProductionBriefInternalRequest, { operationId: `equipment.${string}` }>;
type HiveResponse = Extract<ProductionBriefInternalResponse, { operationId: `equipment.${string}` }>;

export type GearJobSyntheticAdapter = Readonly<{ invoke(input: GearJobRequest): Promise<GearJobResponse> }>;
export type HiveSyntheticAdapter = Readonly<{ invoke(input: HiveRequest): Promise<HiveResponse> }>;

export function createGearJobSyntheticAdapter(): GearJobSyntheticAdapter {
  return { invoke: (input): Promise<GearJobResponse> => {
    switch (input.operationId) {
      case 'production.work_order.get.v1':
        return Promise.resolve(productionBriefInternalResponseSchema.parse({
          operationId: input.operationId,
          result: {
            workOrderRef: 'WO-260729-001', itemName: '主轴箱体 A', status: 'IN_PROGRESS',
            planQty: 120, completedQty: 87, unit: '件', progressPct: 72.5,
            expectedProgressPct: 70, plannedEnd: '2026-07-29T16:00:00.000Z',
            source: source('GearJob', input.operationId, 'synthetic-work-order-r1'),
          },
        }) as GearJobResponse);
      case 'production.work_order.equipment.resolve.v1':
        if (input.workOrderRef !== 'WO-260729-001') throw new Error('SYNTHETIC_WORK_ORDER_REF_MISMATCH');
        return Promise.resolve(productionBriefInternalResponseSchema.parse({
          operationId: input.operationId,
          result: {
            cardinality: 'single', workstations: ['CNC-精加工-01'], equipmentRefs: ['CNC-001'],
            selectedEquipmentRef: 'CNC-001',
            source: source('GearJob', input.operationId, 'synthetic-equipment-map-r1'),
          },
        }) as GearJobResponse);
    }
  } };
}

export function createHiveSyntheticAdapter(): HiveSyntheticAdapter {
  return { invoke: (input): Promise<HiveResponse> => {
    switch (input.operationId) {
      case 'equipment.runtime_status.get.v1':
        if (input.equipmentRef !== 'CNC-001') throw new Error('SYNTHETIC_EQUIPMENT_REF_MISMATCH');
        return Promise.resolve(productionBriefInternalResponseSchema.parse({
          operationId: input.operationId,
          result: {
            knownState: 'KNOWN', status: 'RUN',
            source: source('Hive', input.operationId, 'synthetic-runtime-r1'),
          },
        }) as HiveResponse);
      case 'equipment.alarm_segments.list.v1':
        if (input.equipmentRef !== 'CNC-001') throw new Error('SYNTHETIC_EQUIPMENT_REF_MISMATCH');
        return Promise.resolve(productionBriefInternalResponseSchema.parse({
          operationId: input.operationId,
          result: {
            start: input.window.start, end: input.window.end, coverage: 'COMPLETE',
            segments: [{
              id: 'synthetic-no-active-alarm', start: input.window.start, end: input.window.end,
              active: false, code: null, summary: '窗口内无活动报警', severity: 'INFO',
            }],
            source: source('Hive', input.operationId, 'synthetic-alarm-window-r1'),
          },
        }) as HiveResponse);
    }
  } };
}

export function createSyntheticProductionProvider(options: Readonly<{
  gearJobAdapter?: GearJobSyntheticAdapter;
  hiveAdapter?: HiveSyntheticAdapter;
}> = {}): SyntheticProductionProvider {
  const ledger: ProductionBriefInternalRequest[] = [];
  const gearJobAdapter = options.gearJobAdapter ?? createGearJobSyntheticAdapter();
  const hiveAdapter = options.hiveAdapter ?? createHiveSyntheticAdapter();
  return {
    calls: () => ledger.slice(),
    invoke: async (raw): Promise<ProductionBriefInternalResponse> => {
      const input = productionBriefInternalRequestSchema.parse(raw);
      ledger.push(input);
      switch (input.operationId) {
        case 'production.work_order.get.v1':
        case 'production.work_order.equipment.resolve.v1':
          return await gearJobAdapter.invoke(input);
        case 'equipment.runtime_status.get.v1':
        case 'equipment.alarm_segments.list.v1':
          return await hiveAdapter.invoke(input);
      }
    },
  };
}
