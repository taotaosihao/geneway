import {
  PRODUCTION_BRIEF_CAPABILITY_ID,
  productionBriefInternalResponseSchema,
  productionWorkOrderEquipmentBriefRequestSchema,
  productionWorkOrderEquipmentBriefResponseSchema,
  type ProductionBriefAlarmWindow,
  type ProductionBriefEquipmentMapping,
  type ProductionBriefInternalRequest,
  type ProductionBriefInternalResponse,
  type ProductionBriefRuntimeStatus,
  type ProductionBriefWorkOrder,
  type ProductionWorkOrderEquipmentBriefRequest,
  type ProductionWorkOrderEquipmentBriefResponse,
} from '@geneway/contracts';

export interface ProductionCapabilityPort {
  invoke(input: ProductionBriefInternalRequest): Promise<ProductionBriefInternalResponse>;
}

export function createProductionCapabilityHttpClient(options: Readonly<{
  gatewayUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}>): ProductionCapabilityPort {
  const origin = new URL(options.gatewayUrl);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port !== '3165'
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('Synthetic production gateway must be the exact credential-free 127.0.0.1:3165 origin');
  }
  if (options.serviceToken.length < 32 || /\s/u.test(options.serviceToken)) throw new Error('Synthetic production service token is invalid');
  const request = options.fetchImpl ?? fetch;
  return {
    invoke: async (input) => {
      const response = await request(new URL('/internal/synthetic-production/v1/invoke', origin), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2_000),
        headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`SYNTHETIC_PRODUCTION_GATEWAY_${String(response.status)}`);
      return productionBriefInternalResponseSchema.parse(await response.json());
    },
  };
}

function resultFor<T extends ProductionBriefInternalResponse['operationId']>(
  response: ProductionBriefInternalResponse,
  operationId: T,
): unknown {
  if (response.operationId !== operationId) throw new Error('PRODUCTION_OPERATION_RESPONSE_MISMATCH');
  return response.result;
}

export class ProductionWorkOrderEquipmentBriefService {
  constructor(private readonly capabilityPort: ProductionCapabilityPort) {}

  async run(raw: ProductionWorkOrderEquipmentBriefRequest): Promise<ProductionWorkOrderEquipmentBriefResponse> {
    const input = productionWorkOrderEquipmentBriefRequestSchema.parse(raw);
    const selector = { scenarioRef: input.scenarioRef } as const;
    const workOrder = resultFor(await this.capabilityPort.invoke({
      operationId: 'production.work_order.get.v1', selector,
    }), 'production.work_order.get.v1') as ProductionBriefWorkOrder;
    const mapping = resultFor(await this.capabilityPort.invoke({
      operationId: 'production.work_order.equipment.resolve.v1', selector, workOrderRef: workOrder.workOrderRef,
    }), 'production.work_order.equipment.resolve.v1') as ProductionBriefEquipmentMapping;
    const runtimeStatus = resultFor(await this.capabilityPort.invoke({
      operationId: 'equipment.runtime_status.get.v1', selector, equipmentRef: mapping.selectedEquipmentRef,
    }), 'equipment.runtime_status.get.v1') as ProductionBriefRuntimeStatus;
    const alarmWindowStart = new Date(Date.parse(input.evaluationAsOf) - 8 * 60 * 60 * 1_000).toISOString();
    const alarms = resultFor(await this.capabilityPort.invoke({
      operationId: 'equipment.alarm_segments.list.v1', selector, equipmentRef: mapping.selectedEquipmentRef,
      window: { start: alarmWindowStart, end: input.evaluationAsOf },
    }), 'equipment.alarm_segments.list.v1') as ProductionBriefAlarmWindow;

    const statusAgeSeconds = Math.floor((Date.parse(input.evaluationAsOf) - Date.parse(runtimeStatus.source.observedAt)) / 1_000);
    if (statusAgeSeconds < 0 || statusAgeSeconds > 120) throw new Error('STATUS_STALE');
    if (alarms.segments.some((segment) => segment.active && (segment.severity === 'HIGH' || segment.severity === 'CRITICAL'))) {
      throw new Error('SCN_NORMAL_FACTS_VIOLATE_NO_ACTION_RUBRIC');
    }
    if (runtimeStatus.status !== 'RUN' || workOrder.expectedProgressPct - workOrder.progressPct >= 15) {
      throw new Error('SCN_NORMAL_FACTS_VIOLATE_NO_ACTION_RUBRIC');
    }

    const sources = [workOrder.source, mapping.source, runtimeStatus.source, alarms.source];
    return productionWorkOrderEquipmentBriefResponseSchema.parse({
      capabilityId: PRODUCTION_BRIEF_CAPABILITY_ID,
      scenarioRef: input.scenarioRef,
      provenance: 'SYNTHETIC_DEMO',
      evaluationAsOf: input.evaluationAsOf,
      workOrder, mapping, runtimeStatus, alarms,
      freshness: { statusAgeSeconds, status: 'CURRENT' },
      action: 'NO_ACTION',
      reasonCode: 'NORMAL_OPERATION',
      summary: `${workOrder.workOrderRef} 当前达到计划进度，关联设备正在运行。`,
      reason: '工单完成率达到当前计划，唯一关联设备状态新鲜且为 RUN，完整报警窗口内没有活动的高危报警。',
      recommendedNextStep: '保持当前排产，下一轮计划检查时再次确认进度与设备状态。',
      unknowns: [],
      trace: [
        ...sources.map((source) => ({
          operationId: source.operationId, status: 'completed' as const, source: source.system,
          observedAt: source.observedAt, revision: source.revision,
        })),
        {
          operationId: PRODUCTION_BRIEF_CAPABILITY_ID, status: 'completed', source: 'geneway',
          observedAt: input.evaluationAsOf, revision: 'synthetic-rubric-v1',
        },
      ],
    });
  }
}
