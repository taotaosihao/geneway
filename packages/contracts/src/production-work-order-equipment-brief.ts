import { z } from 'zod';

export const PRODUCTION_BRIEF_EVALUATION_AS_OF = '2026-07-29T08:30:00.000Z' as const;
export const PRODUCTION_BRIEF_CAPABILITY_ID = 'production.work_order_equipment_brief.v1' as const;
export const PRODUCTION_BRIEF_OPERATION_IDS = [
  'production.work_order.get.v1',
  'production.work_order.equipment.resolve.v1',
  'equipment.runtime_status.get.v1',
  'equipment.alarm_segments.list.v1',
] as const;

export const productionBriefScenarioRefSchema = z.literal('SCN-NORMAL');
export const productionBriefEvaluationAsOfSchema = z.literal(PRODUCTION_BRIEF_EVALUATION_AS_OF);
export const productionBriefOperationIdSchema = z.enum(PRODUCTION_BRIEF_OPERATION_IDS);

export const productionBriefSourceSchema = z.object({
  system: z.enum(['GearJob', 'Hive']),
  operationId: productionBriefOperationIdSchema,
  revision: z.string().min(1).max(200),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

export const productionBriefWorkOrderSchema = z.object({
  workOrderRef: z.string().min(1).max(120),
  itemName: z.string().min(1).max(200),
  status: z.enum(['IN_PROGRESS', 'NOT_STARTED']),
  planQty: z.number().nonnegative(),
  completedQty: z.number().nonnegative(),
  unit: z.string().min(1).max(32),
  progressPct: z.number().min(0).max(100),
  expectedProgressPct: z.number().min(0).max(100),
  plannedEnd: z.iso.datetime({ offset: true }),
  source: productionBriefSourceSchema,
}).strict();

export const productionBriefEquipmentMappingSchema = z.object({
  cardinality: z.literal('single'),
  workstations: z.array(z.string().min(1).max(120)).min(1).max(20),
  equipmentRefs: z.array(z.string().min(1).max(120)).length(1),
  selectedEquipmentRef: z.string().min(1).max(120),
  source: productionBriefSourceSchema,
}).strict();

export const productionBriefRuntimeStatusSchema = z.object({
  knownState: z.literal('KNOWN'),
  status: z.enum(['RUN', 'STOP', 'OFFLINE']),
  source: productionBriefSourceSchema,
}).strict();

export const productionBriefAlarmSegmentSchema = z.object({
  id: z.string().min(1).max(120),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }).nullable(),
  active: z.boolean(),
  code: z.string().min(1).max(120).nullable(),
  summary: z.string().min(1).max(300),
  severity: z.enum(['INFO', 'MEDIUM', 'HIGH', 'CRITICAL']),
}).strict();

export const productionBriefAlarmWindowSchema = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  coverage: z.literal('COMPLETE'),
  segments: z.array(productionBriefAlarmSegmentSchema).max(100),
  source: productionBriefSourceSchema,
}).strict();

const selectorSchema = z.object({ scenarioRef: productionBriefScenarioRefSchema }).strict();

export const productionBriefInternalRequestSchema = z.discriminatedUnion('operationId', [
  z.object({
    operationId: z.literal('production.work_order.get.v1'),
    selector: selectorSchema,
  }).strict(),
  z.object({
    operationId: z.literal('production.work_order.equipment.resolve.v1'),
    selector: selectorSchema,
    workOrderRef: z.string().min(1).max(120),
  }).strict(),
  z.object({
    operationId: z.literal('equipment.runtime_status.get.v1'),
    selector: selectorSchema,
    equipmentRef: z.string().min(1).max(120),
  }).strict(),
  z.object({
    operationId: z.literal('equipment.alarm_segments.list.v1'),
    selector: selectorSchema,
    equipmentRef: z.string().min(1).max(120),
    window: z.object({
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    }).strict(),
  }).strict(),
]);

export const productionBriefInternalResponseSchema = z.discriminatedUnion('operationId', [
  z.object({
    operationId: z.literal('production.work_order.get.v1'),
    result: productionBriefWorkOrderSchema,
  }).strict(),
  z.object({
    operationId: z.literal('production.work_order.equipment.resolve.v1'),
    result: productionBriefEquipmentMappingSchema,
  }).strict(),
  z.object({
    operationId: z.literal('equipment.runtime_status.get.v1'),
    result: productionBriefRuntimeStatusSchema,
  }).strict(),
  z.object({
    operationId: z.literal('equipment.alarm_segments.list.v1'),
    result: productionBriefAlarmWindowSchema,
  }).strict(),
]);

export const productionWorkOrderEquipmentBriefRequestSchema = z.object({
  capabilityId: z.literal(PRODUCTION_BRIEF_CAPABILITY_ID),
  scenarioRef: productionBriefScenarioRefSchema,
  evaluationAsOf: productionBriefEvaluationAsOfSchema,
}).strict();

export const productionBriefTraceSchema = z.object({
  operationId: z.enum([...PRODUCTION_BRIEF_OPERATION_IDS, PRODUCTION_BRIEF_CAPABILITY_ID]),
  status: z.literal('completed'),
  source: z.enum(['GearJob', 'Hive', 'geneway']),
  observedAt: z.iso.datetime({ offset: true }),
  revision: z.string().min(1).max(200),
}).strict();

export const productionWorkOrderEquipmentBriefResponseSchema = z.object({
  capabilityId: z.literal(PRODUCTION_BRIEF_CAPABILITY_ID),
  scenarioRef: productionBriefScenarioRefSchema,
  provenance: z.literal('SYNTHETIC_DEMO'),
  evaluationAsOf: productionBriefEvaluationAsOfSchema,
  workOrder: productionBriefWorkOrderSchema,
  mapping: productionBriefEquipmentMappingSchema,
  runtimeStatus: productionBriefRuntimeStatusSchema,
  alarms: productionBriefAlarmWindowSchema,
  freshness: z.object({ statusAgeSeconds: z.number().int().min(0).max(120), status: z.literal('CURRENT') }).strict(),
  action: z.literal('NO_ACTION'),
  reasonCode: z.literal('NORMAL_OPERATION'),
  summary: z.string().min(1).max(500),
  reason: z.string().min(1).max(1_000),
  recommendedNextStep: z.string().min(1).max(500),
  unknowns: z.array(z.string().min(1).max(500)).max(20),
  trace: z.array(productionBriefTraceSchema).length(5),
}).strict();

export type ProductionBriefInternalRequest = z.infer<typeof productionBriefInternalRequestSchema>;
export type ProductionBriefInternalResponse = z.infer<typeof productionBriefInternalResponseSchema>;
export type ProductionBriefWorkOrder = z.infer<typeof productionBriefWorkOrderSchema>;
export type ProductionBriefEquipmentMapping = z.infer<typeof productionBriefEquipmentMappingSchema>;
export type ProductionBriefRuntimeStatus = z.infer<typeof productionBriefRuntimeStatusSchema>;
export type ProductionBriefAlarmWindow = z.infer<typeof productionBriefAlarmWindowSchema>;
export type ProductionWorkOrderEquipmentBriefRequest = z.infer<typeof productionWorkOrderEquipmentBriefRequestSchema>;
export type ProductionWorkOrderEquipmentBriefResponse = z.infer<typeof productionWorkOrderEquipmentBriefResponseSchema>;
