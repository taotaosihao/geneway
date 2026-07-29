export const PRODUCTION_ACTIONS = ['NO_ACTION', 'FOLLOW_UP', 'ESCALATE', 'UNKNOWN'] as const;

export type ProductionAction = typeof PRODUCTION_ACTIONS[number];
export type MockKnownState = 'KNOWN' | 'STALE' | 'UNKNOWN' | 'UPSTREAM_FAILURE';
export type EquipmentMappingCardinality = 'single' | 'none' | 'multiple';
export type EquipmentRuntimeStatus = 'RUN' | 'STOP' | 'OFFLINE';
export type AlarmCoverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export const PRODUCTION_BRIEF_STAGE_IDS = [
  'work_order',
  'equipment_mapping',
  'runtime_status',
  'alarm_segments',
  'action_decision',
] as const;

export type ProductionBriefStageId = typeof PRODUCTION_BRIEF_STAGE_IDS[number];
export type ProductionBriefStageStatus = 'pending' | 'running' | 'completed' | 'skipped';

export interface MockSourceRef {
  readonly system: 'GearJob' | 'Hive' | 'geneway mock';
  readonly capabilityId: string;
  readonly sourceRevision: string;
  readonly observedAt: string;
}

export interface MockWorkOrderFacts {
  readonly workOrderRef: string;
  readonly itemName: string;
  readonly customerOrderRef: string;
  readonly status: 'IN_PROGRESS' | 'NOT_STARTED';
  readonly planQty: number;
  readonly completedQty: number;
  readonly unit: string;
  readonly progressPct: number;
  readonly expectedProgressPct: number;
  readonly plannedEnd: string;
  readonly source: MockSourceRef;
}

export interface MockEquipmentMapping {
  readonly cardinality: EquipmentMappingCardinality;
  readonly workstations: readonly string[];
  readonly equipmentRefs: readonly string[];
  readonly selectedEquipmentRef: string | null;
  readonly fallback: 'none' | 'work-order-only' | 'explicit-machine-selection';
  readonly source: MockSourceRef;
}

export interface MockRuntimeStatus {
  readonly knownState: MockKnownState;
  readonly status: EquipmentRuntimeStatus | null;
  readonly statusLabel: string;
  readonly updatedAt: string | null;
  readonly freshnessSeconds: number | null;
  readonly source: MockSourceRef;
}

export interface MockAlarmSegment {
  readonly id: string;
  readonly start: string;
  readonly end: string | null;
  readonly active: boolean;
  readonly code: string | null;
  readonly summary: string;
  readonly severity: 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface MockAlarmWindow {
  readonly start: string;
  readonly end: string;
  readonly coverage: AlarmCoverage;
  readonly segments: readonly MockAlarmSegment[];
  readonly source: MockSourceRef;
}

export interface ProductionBriefMockResult {
  readonly scenarioId: string;
  readonly workOrder: MockWorkOrderFacts;
  readonly mapping: MockEquipmentMapping;
  readonly runtimeStatus: MockRuntimeStatus | null;
  readonly alarms: MockAlarmWindow | null;
  readonly action: ProductionAction;
  readonly actionLabel: string;
  readonly summary: string;
  readonly reason: string;
  readonly recommendedNextStep: string;
  readonly unknowns: readonly string[];
  readonly generatedAt: string;
  readonly provenance: 'SYNTHETIC_DEMO';
}

export interface ProductionBriefMockScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly businessQuestion: string;
  readonly workOrder: MockWorkOrderFacts;
  readonly mapping: MockEquipmentMapping;
  readonly runtimeStatus: MockRuntimeStatus | null;
  readonly alarms: MockAlarmWindow | null;
}

const observedAt = '2026-07-29T08:30:00.000Z';
const alarmWindowStart = '2026-07-29T00:30:00.000Z';

function source(
  system: MockSourceRef['system'],
  capabilityId: string,
  sourceRevision: string,
): MockSourceRef {
  return { system, capabilityId, sourceRevision, observedAt };
}

function workOrder(
  workOrderRef: string,
  itemName: string,
  status: MockWorkOrderFacts['status'],
  planQty: number,
  completedQty: number,
  expectedProgressPct: number,
): MockWorkOrderFacts {
  return {
    workOrderRef,
    itemName,
    customerOrderRef: `SO-${workOrderRef.slice(-3)}`,
    status,
    planQty,
    completedQty,
    unit: '件',
    progressPct: Math.round((completedQty / planQty) * 1000) / 10,
    expectedProgressPct,
    plannedEnd: '2026-07-29T16:00:00.000Z',
    source: source('GearJob', 'production.work_order.get.v1', `modified:${observedAt}`),
  };
}

function mapping(
  workOrderRef: string,
  cardinality: EquipmentMappingCardinality,
  workstations: readonly string[],
  equipmentRefs: readonly string[],
): MockEquipmentMapping {
  return {
    cardinality,
    workstations,
    equipmentRefs,
    selectedEquipmentRef: cardinality === 'single' ? equipmentRefs[0] ?? null : null,
    fallback: cardinality === 'none' ? 'work-order-only'
      : cardinality === 'multiple' ? 'explicit-machine-selection' : 'none',
    source: source('GearJob', 'production.work_order.equipment.resolve.v1', `mapping:${workOrderRef}:${cardinality}`),
  };
}

function runtime(
  equipmentRef: string,
  knownState: MockKnownState,
  status: EquipmentRuntimeStatus | null,
  updatedAt: string | null,
  freshnessSeconds: number | null,
): MockRuntimeStatus {
  return {
    knownState,
    status,
    statusLabel: status === 'RUN' ? '运行中' : status === 'STOP' ? '已停止' : status === 'OFFLINE' ? '离线' : '未知',
    updatedAt,
    freshnessSeconds,
    source: source('Hive', 'equipment.runtime_status.get.v1', `projection:${equipmentRef}:${updatedAt ?? 'unknown'}`),
  };
}

function alarms(
  equipmentRef: string,
  coverage: AlarmCoverage,
  segments: readonly MockAlarmSegment[],
): MockAlarmWindow {
  return {
    start: alarmWindowStart,
    end: observedAt,
    coverage,
    segments,
    source: source('Hive', 'equipment.alarm_segments.list.v1', `alarm-window:${equipmentRef}:${coverage}`),
  };
}

export const PRODUCTION_BRIEF_MOCK_SCENARIOS: readonly ProductionBriefMockScenario[] = [
  {
    id: 'normal-running',
    title: '正常生产，无需跟进',
    description: '进度达到计划，设备运行，当前无报警。',
    businessQuestion: '工单 WO-260729-001 今天需要跟进吗？',
    workOrder: workOrder('WO-260729-001', '主轴箱体 A', 'IN_PROGRESS', 120, 87, 70),
    mapping: mapping('WO-260729-001', 'single', ['CNC-精加工-01'], ['CNC-001']),
    runtimeStatus: runtime('CNC-001', 'KNOWN', 'RUN', '2026-07-29T08:29:42.000Z', 18),
    alarms: alarms('CNC-001', 'COMPLETE', [{
      id: 'alarm-normal-1', start: alarmWindowStart, end: observedAt, active: false, code: null,
      summary: '窗口内无活动报警', severity: 'INFO',
    }]),
  },
  {
    id: 'progress-behind-stop',
    title: '进度落后，设备停止',
    description: '工单完成率低于计划，关联设备已停止但没有活动报警。',
    businessQuestion: '工单 WO-260729-002 为什么落后，今天要追吗？',
    workOrder: workOrder('WO-260729-002', '液压阀体 B', 'IN_PROGRESS', 200, 96, 72),
    mapping: mapping('WO-260729-002', 'single', ['CNC-粗加工-03'], ['CNC-014']),
    runtimeStatus: runtime('CNC-014', 'KNOWN', 'STOP', '2026-07-29T08:29:15.000Z', 45),
    alarms: alarms('CNC-014', 'COMPLETE', [{
      id: 'alarm-stop-1', start: alarmWindowStart, end: observedAt, active: false, code: null,
      summary: '窗口内无活动报警；停止原因尚未归类', severity: 'INFO',
    }]),
  },
  {
    id: 'active-critical-alarm',
    title: '关键报警，需要升级',
    description: '关联设备出现当前活动的主轴过载报警。',
    businessQuestion: '工单 WO-260729-003 当前是否需要升级处理？',
    workOrder: workOrder('WO-260729-003', '叶轮 C', 'IN_PROGRESS', 80, 51, 68),
    mapping: mapping('WO-260729-003', 'single', ['五轴精加工-02'], ['CNC-021']),
    runtimeStatus: runtime('CNC-021', 'KNOWN', 'STOP', '2026-07-29T08:29:51.000Z', 9),
    alarms: alarms('CNC-021', 'COMPLETE', [{
      id: 'alarm-critical-1', start: '2026-07-29T08:21:00.000Z', end: null, active: true, code: 'SPINDLE_OVERLOAD',
      summary: '主轴负载持续超过保护阈值', severity: 'CRITICAL',
    }]),
  },
  {
    id: 'stale-hive-data',
    title: '数据过期，不能判断',
    description: '工单事实正常，但 Hive 状态已超过新鲜度阈值且报警覆盖不完整。',
    businessQuestion: '工单 WO-260729-004 对应设备现在正常吗？',
    workOrder: workOrder('WO-260729-004', '轴承座 D', 'IN_PROGRESS', 150, 105, 69),
    mapping: mapping('WO-260729-004', 'single', ['立加-02'], ['CNC-032']),
    runtimeStatus: runtime('CNC-032', 'STALE', 'RUN', '2026-07-29T07:51:00.000Z', 2340),
    alarms: alarms('CNC-032', 'PARTIAL', []),
  },
  {
    id: 'unmapped-work-order',
    title: '没有设备映射',
    description: '工单存在，但当前工序没有可用 MES Unit 映射。',
    businessQuestion: '工单 WO-260729-005 的关联设备怎么样？',
    workOrder: workOrder('WO-260729-005', '导轨座 E', 'IN_PROGRESS', 60, 18, 55),
    mapping: mapping('WO-260729-005', 'none', ['装配-预检'], []),
    runtimeStatus: null,
    alarms: null,
  },
  {
    id: 'multiple-equipment-mapping',
    title: '多设备映射，需要选择',
    description: '同一工作站关联两台设备，系统不会自动猜选。',
    businessQuestion: '工单 WO-260729-006 到底在看哪台设备？',
    workOrder: workOrder('WO-260729-006', '法兰盘 F', 'IN_PROGRESS', 240, 132, 60),
    mapping: mapping('WO-260729-006', 'multiple', ['车削单元-01'], ['CNC-041', 'CNC-042']),
    runtimeStatus: null,
    alarms: null,
  },
];

export const PRODUCTION_BRIEF_STAGE_LABELS: Readonly<Record<ProductionBriefStageId, string>> = {
  work_order: '读取 GearJob 工单事实',
  equipment_mapping: '解析工序与设备映射',
  runtime_status: '读取 Hive 当前状态',
  alarm_segments: '读取报警时间段',
  action_decision: '生成今日行动建议',
};

export function productionBriefScenario(scenarioId: string): ProductionBriefMockScenario {
  const scenario = PRODUCTION_BRIEF_MOCK_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) throw new Error(`UNKNOWN_MOCK_SCENARIO:${scenarioId}`);
  return scenario;
}

function actionFor(scenario: ProductionBriefMockScenario): ProductionAction {
  if (scenario.mapping.cardinality !== 'single') return 'UNKNOWN';
  if (scenario.runtimeStatus === null || scenario.runtimeStatus.knownState !== 'KNOWN') return 'UNKNOWN';
  if (scenario.alarms === null || scenario.alarms.coverage !== 'COMPLETE') return 'UNKNOWN';
  if (scenario.alarms.segments.some((segment) => segment.active && ['HIGH', 'CRITICAL'].includes(segment.severity))) {
    return 'ESCALATE';
  }
  const progressGap = scenario.workOrder.expectedProgressPct - scenario.workOrder.progressPct;
  if (scenario.runtimeStatus.status === 'STOP' || scenario.runtimeStatus.status === 'OFFLINE' || progressGap >= 15) {
    return 'FOLLOW_UP';
  }
  return 'NO_ACTION';
}

function unknownsFor(scenario: ProductionBriefMockScenario): readonly string[] {
  if (scenario.mapping.cardinality === 'none') {
    return ['当前工序没有可用设备映射，无法查询设备状态；结果只保留工单事实。'];
  }
  if (scenario.mapping.cardinality === 'multiple') {
    return ['当前工作站关联多台设备，必须由计划员明确选择，系统不会自动猜选。'];
  }
  const unknowns: string[] = [];
  if (scenario.runtimeStatus === null || scenario.runtimeStatus.knownState !== 'KNOWN') {
    unknowns.push('设备当前状态不够新鲜或不可用，不能据此判断现场正在运行。');
  }
  if (scenario.alarms === null || scenario.alarms.coverage !== 'COMPLETE') {
    unknowns.push('报警窗口覆盖不完整，空结果不能解释为“没有报警”。');
  }
  return unknowns;
}

function actionCopy(action: ProductionAction, scenario: ProductionBriefMockScenario): Pick<
  ProductionBriefMockResult,
  'actionLabel' | 'summary' | 'reason' | 'recommendedNextStep'
> {
  const workOrderRef = scenario.workOrder.workOrderRef;
  if (action === 'ESCALATE') return {
    actionLabel: '立即升级',
    summary: `${workOrderRef} 的关联设备存在当前关键报警，建议立即升级处理。`,
    reason: '当前报警仍处于活动状态，且严重度达到 CRITICAL；不能仅按普通进度落后处理。',
    recommendedNextStep: '通知设备负责人确认停机与报警处置，并同步计划员评估交期影响。',
  };
  if (action === 'FOLLOW_UP') return {
    actionLabel: '今日跟进',
    summary: `${workOrderRef} 进度低于计划且关联设备停止，今天需要主动跟进。`,
    reason: '完成率与计划进度存在明显差距，设备当前状态为 STOP，但没有活动报警可直接解释原因。',
    recommendedNextStep: '向现场确认停机原因、预计恢复时间和是否需要调整排产。',
  };
  if (action === 'NO_ACTION') return {
    actionLabel: '暂不跟进',
    summary: `${workOrderRef} 当前进度达到计划，设备运行且没有活动报警。`,
    reason: '工单进度、设备当前状态和完整报警窗口均未显示需要人工介入的信号。',
    recommendedNextStep: '维持正常监控；工单、状态或报警发生变化时重新判断。',
  };
  if (scenario.mapping.cardinality === 'multiple') return {
    actionLabel: '信息不足',
    summary: `${workOrderRef} 关联到多台设备，当前不能给出设备级行动建议。`,
    reason: '多映射场景没有权威选择规则；自动选择任一设备都会制造错误确定性。',
    recommendedNextStep: '请计划员明确本次要查看的设备，再重新读取状态和报警。',
  };
  if (scenario.mapping.cardinality === 'none') return {
    actionLabel: '信息不足',
    summary: `${workOrderRef} 没有可用设备映射，当前只能看到工单进度。`,
    reason: '缺少工单到设备的权威映射，无法把 Hive 状态或报警归因到该工单。',
    recommendedNextStep: '确认工序/工作站设备绑定，或先按 work-order-only 方式人工跟进。',
  };
  return {
    actionLabel: '信息不足',
    summary: `${workOrderRef} 的设备数据不够新鲜或覆盖不完整，当前不能可靠判断。`,
    reason: 'Hive 状态或报警覆盖没有满足 KNOWN 条件；不能把 stale/empty 当作正常。',
    recommendedNextStep: '先确认网关、数据更新时间与报警覆盖，恢复可信数据后重新判断。',
  };
}

export function resolveProductionBriefMock(scenarioId: string): ProductionBriefMockResult {
  const scenario = productionBriefScenario(scenarioId);
  const action = actionFor(scenario);
  return {
    scenarioId,
    workOrder: scenario.workOrder,
    mapping: scenario.mapping,
    runtimeStatus: scenario.runtimeStatus,
    alarms: scenario.alarms,
    action,
    ...actionCopy(action, scenario),
    unknowns: unknownsFor(scenario),
    generatedAt: observedAt,
    provenance: 'SYNTHETIC_DEMO',
  };
}

function stageIsSkipped(scenario: ProductionBriefMockScenario, stageId: ProductionBriefStageId): boolean {
  return scenario.mapping.cardinality !== 'single' && (stageId === 'runtime_status' || stageId === 'alarm_segments');
}

export async function runProductionBriefMock(
  scenarioId: string,
  onStage: (stageId: ProductionBriefStageId, status: ProductionBriefStageStatus) => void,
  stepDelayMs = 180,
): Promise<ProductionBriefMockResult> {
  const scenario = productionBriefScenario(scenarioId);
  for (const stageId of PRODUCTION_BRIEF_STAGE_IDS) {
    if (stageIsSkipped(scenario, stageId)) {
      onStage(stageId, 'skipped');
      continue;
    }
    onStage(stageId, 'running');
    if (stepDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    onStage(stageId, 'completed');
  }
  return resolveProductionBriefMock(scenarioId);
}
