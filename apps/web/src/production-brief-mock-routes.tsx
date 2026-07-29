import { useMemo, useRef, useState } from 'react';
import {
  PRODUCTION_BRIEF_MOCK_SCENARIOS,
  PRODUCTION_BRIEF_STAGE_IDS,
  PRODUCTION_BRIEF_STAGE_LABELS,
  productionBriefScenario,
  runProductionBriefMock,
  type ProductionBriefMockResult,
  type ProductionBriefStageId,
  type ProductionBriefStageStatus,
} from './production-brief-mock.js';
import { ProductShell } from './product-routes.js';

const ACTION_LABELS: Readonly<Record<ProductionBriefMockResult['action'], string>> = {
  NO_ACTION: '暂不跟进',
  FOLLOW_UP: '今日跟进',
  ESCALATE: '立即升级',
  UNKNOWN: '信息不足',
};

const MAPPING_LABELS: Readonly<Record<ProductionBriefMockResult['mapping']['cardinality'], string>> = {
  single: '唯一设备',
  none: '无映射',
  multiple: '多设备',
};

function initialStageState(): Readonly<Record<ProductionBriefStageId, ProductionBriefStageStatus>> {
  return Object.fromEntries(PRODUCTION_BRIEF_STAGE_IDS.map((stageId) => [stageId, 'pending'])) as Record<
    ProductionBriefStageId,
    ProductionBriefStageStatus
  >;
}

function displayTime(value: string | null): string {
  if (value === null) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

function sourceLine(result: { readonly source: ProductionBriefMockResult['workOrder']['source'] }): string {
  return `${result.source.system} · ${result.source.capabilityId} · ${displayTime(result.source.observedAt)}`;
}

function MockBoundaryNotice() {
  return <div className="production-mock-boundary" data-testid="production-mock-boundary">
    <span>DEMO</span><div><b>全合成业务演示</b><small>未连接 GearJob / Hive，不含客户数据</small></div>
  </div>;
}

function StageRail({ stages }: Readonly<{
  stages: Readonly<Record<ProductionBriefStageId, ProductionBriefStageStatus>>;
}>) {
  return <ol className="production-mock-stages" data-testid="production-mock-stages">
    {PRODUCTION_BRIEF_STAGE_IDS.map((stageId, index) => <li className={`mock-stage-${stages[stageId]}`} key={stageId}
      data-stage-id={stageId} data-stage-status={stages[stageId]}>
      <span>{stages[stageId] === 'completed' ? '✓' : stages[stageId] === 'skipped' ? '—' : String(index + 1)}</span>
      <div><b>{PRODUCTION_BRIEF_STAGE_LABELS[stageId]}</b><small>{stageId}</small></div>
      <em>{stages[stageId] === 'pending' ? '等待' : stages[stageId] === 'running' ? '读取中'
        : stages[stageId] === 'completed' ? '完成' : '安全跳过'}</em>
    </li>)}
  </ol>;
}

function SourceTrace({ source }: Readonly<{ source: ProductionBriefMockResult['workOrder']['source'] }>) {
  return <small className="production-source-trace">{source.system} · {source.capabilityId}<br />
    revision {source.sourceRevision}</small>;
}

function WorkOrderFactsCard({ result }: Readonly<{ result: ProductionBriefMockResult }>) {
  const order = result.workOrder;
  const behind = Math.max(0, order.expectedProgressPct - order.progressPct);
  return <article className="production-fact-card" data-testid="mock-work-order-facts">
    <div className="production-card-title"><span>01</span><div><b>工单事实</b><small>{sourceLine(order)}</small></div></div>
    <dl>
      <div><dt>工单</dt><dd>{order.workOrderRef}</dd></div>
      <div><dt>产品</dt><dd>{order.itemName}</dd></div>
      <div><dt>状态</dt><dd>{order.status}</dd></div>
      <div><dt>生产进度</dt><dd>{order.progressPct}% <small>计划 {order.expectedProgressPct}%</small></dd></div>
      <div><dt>数量</dt><dd>{order.completedQty} / {order.planQty} {order.unit}</dd></div>
      <div><dt>进度差</dt><dd>{behind === 0 ? '已达到计划' : `落后 ${behind.toFixed(1)} 个百分点`}</dd></div>
    </dl>
    <SourceTrace source={order.source} />
  </article>;
}

function EquipmentMappingCard({ result }: Readonly<{ result: ProductionBriefMockResult }>) {
  const mapping = result.mapping;
  return <article className="production-fact-card" data-testid="mock-equipment-mapping">
    <div className="production-card-title"><span>02</span><div><b>设备映射</b><small>工序 / 工作站 → MES Unit</small></div></div>
    <dl>
      <div><dt>映射结果</dt><dd>{MAPPING_LABELS[mapping.cardinality]}</dd></div>
      <div><dt>工作站</dt><dd>{mapping.workstations.join('、') || '未提供'}</dd></div>
      <div><dt>候选设备</dt><dd>{mapping.equipmentRefs.join('、') || '无'}</dd></div>
      <div><dt>本次设备</dt><dd>{mapping.selectedEquipmentRef ?? '未选择'}</dd></div>
    </dl>
    {mapping.fallback !== 'none' && <p className="production-safe-fallback">{mapping.fallback === 'work-order-only'
      ? '安全降级：只展示工单事实，不请求设备数据。'
      : '安全降级：要求人工明确设备，不自动猜选。'}</p>}
    <SourceTrace source={mapping.source} />
  </article>;
}

function RuntimeStatusCard({ result }: Readonly<{ result: ProductionBriefMockResult }>) {
  const runtime = result.runtimeStatus;
  return <article className="production-fact-card" data-testid="mock-runtime-status">
    <div className="production-card-title"><span>03</span><div><b>设备当前状态</b><small>Hive 状态投影与新鲜度</small></div></div>
    {runtime === null ? <div className="production-card-empty"><span>—</span><p>没有唯一设备，已跳过 Hive 当前状态读取。</p></div> : <>
      <dl>
        <div><dt>Known state</dt><dd><span className={`known-state known-${runtime.knownState.toLowerCase()}`}>{runtime.knownState}</span></dd></div>
        <div><dt>运行状态</dt><dd>{runtime.statusLabel}</dd></div>
        <div><dt>更新时间</dt><dd>{displayTime(runtime.updatedAt)}</dd></div>
        <div><dt>数据新鲜度</dt><dd>{runtime.freshnessSeconds === null ? '未知' : `${runtime.freshnessSeconds} 秒`}</dd></div>
      </dl>
      <SourceTrace source={runtime.source} />
    </>}
  </article>;
}

function AlarmSegmentsCard({ result }: Readonly<{ result: ProductionBriefMockResult }>) {
  const alarms = result.alarms;
  return <article className="production-fact-card production-alarm-card" data-testid="mock-alarm-segments">
    <div className="production-card-title"><span>04</span><div><b>报警时间段</b><small>固定八小时窗口</small></div></div>
    {alarms === null ? <div className="production-card-empty"><span>—</span><p>没有唯一设备，已跳过报警读取。</p></div> : <>
      <div className="alarm-window-summary"><span className={`coverage coverage-${alarms.coverage.toLowerCase()}`}>{alarms.coverage}</span>
        <small>{displayTime(alarms.start)} — {displayTime(alarms.end)}</small></div>
      {alarms.segments.length === 0 ? <p className="production-card-empty-copy">没有可解释的报警段；覆盖不完整时不会当作“无报警”。</p>
        : <ol>{alarms.segments.map((segment) => <li key={segment.id}>
          <span className={`alarm-severity severity-${segment.severity.toLowerCase()}`}>{segment.severity}</span>
          <div><b>{segment.code ?? 'NO_ACTIVE_ALARM'}</b><p>{segment.summary}</p>
            <small>{displayTime(segment.start)} — {segment.end === null ? '当前' : displayTime(segment.end)}</small></div>
          <em>{segment.active ? '活动中' : '已覆盖'}</em>
        </li>)}</ol>}
      <SourceTrace source={alarms.source} />
    </>}
  </article>;
}

export function ProductionBriefResultView({ result }: Readonly<{ result: ProductionBriefMockResult }>) {
  return <section className="production-mock-result" data-testid="production-mock-result" data-action={result.action}>
    <article className={`production-decision action-${result.action.toLowerCase()}`}>
      <div className="decision-author"><span className="avatar">纬</span><div><small>小纬 · 今日行动判断</small><h2>{result.summary}</h2></div></div>
      <div className="decision-action"><span>{result.action}</span><b>{ACTION_LABELS[result.action]}</b></div>
      <p>{result.reason}</p>
      <div className="decision-next"><span>建议下一步</span><b>{result.recommendedNextStep}</b></div>
    </article>

    <div className="production-fact-grid">
      <WorkOrderFactsCard result={result} />
      <EquipmentMappingCard result={result} />
      <RuntimeStatusCard result={result} />
      <AlarmSegmentsCard result={result} />
    </div>

    <section className={`production-unknowns ${result.unknowns.length === 0 ? 'unknowns-clear' : ''}`}>
      <div><span>{result.unknowns.length === 0 ? '✓' : '?'}</span><div><b>{result.unknowns.length === 0 ? '本次没有阻塞判断的未知项' : '明确未知项'}</b>
        <small>小纬不会用模型补造缺失的映射、状态或报警覆盖。</small></div></div>
      {result.unknowns.length > 0 && <ul>{result.unknowns.map((unknown) => <li key={unknown}>{unknown}</li>)}</ul>}
    </section>
    <footer className="production-result-provenance">SYNTHETIC_DEMO · 生成时间 {displayTime(result.generatedAt)} · 用于产品验收，不代表现场事实</footer>
  </section>;
}

export function ProductionBriefMockPage() {
  const [selectedScenarioId, setSelectedScenarioId] = useState(PRODUCTION_BRIEF_MOCK_SCENARIOS[0]?.id ?? 'normal-running');
  const [stages, setStages] = useState(initialStageState);
  const [result, setResult] = useState<ProductionBriefMockResult>();
  const [running, setRunning] = useState(false);
  const runGeneration = useRef(0);
  const selectedScenario = useMemo(() => productionBriefScenario(selectedScenarioId), [selectedScenarioId]);

  const selectScenario = (scenarioId: string) => {
    runGeneration.current += 1;
    setSelectedScenarioId(scenarioId);
    setStages(initialStageState());
    setResult(undefined);
    setRunning(false);
  };

  const run = async () => {
    const generation = runGeneration.current + 1;
    runGeneration.current = generation;
    setStages(initialStageState());
    setResult(undefined);
    setRunning(true);
    const resolved = await runProductionBriefMock(selectedScenarioId, (stageId, status) => {
      if (runGeneration.current === generation) setStages((current) => ({ ...current, [stageId]: status }));
    });
    if (runGeneration.current === generation) {
      setResult(resolved);
      setRunning(false);
    }
  };

  const inspector = <dl className="facts">
    <div><dt>模式</dt><dd>SYNTHETIC_DEMO</dd></div>
    <div><dt>场景</dt><dd>{selectedScenario.id}</dd></div>
    <div><dt>工单</dt><dd>{selectedScenario.workOrder.workOrderRef}</dd></div>
    <div><dt>能力链</dt><dd>{PRODUCTION_BRIEF_STAGE_IDS.length} stages</dd></div>
    <div><dt>外部连接</dt><dd>0</dd></div>
  </dl>;

  return <ProductShell active="work-orders" title="工单设备简报" subtitle="生产计划员 · 今日跟进行动 · 端到端业务演示"
    state="ready" boundaryNotice={<MockBoundaryNotice />} inspector={inspector}>
    <section className="production-mock-intro">
      <div><span className="eyebrow">production.work_order_equipment_brief.v1</span><h1>这个工单今天需要采取什么行动？</h1>
        <p>选择一个典型现场场景，小纬会依次读取工单、解析设备、检查状态与报警，并给出可解释的行动结论。</p></div>
      <div className="production-mock-contract"><span>行动口径</span><b>NO_ACTION · FOLLOW_UP · ESCALATE · UNKNOWN</b>
        <small>确定性规则；遇到 stale、空覆盖或 0/N 映射时明确返回 UNKNOWN。</small></div>
    </section>

    <div className="production-mock-layout">
      <aside className="production-scenario-picker" aria-label="业务演示场景">
        <div className="section-heading"><div><span className="eyebrow">真实业务形态</span><h2>选择验收场景</h2></div><span>{PRODUCTION_BRIEF_MOCK_SCENARIOS.length} 个</span></div>
        <div>{PRODUCTION_BRIEF_MOCK_SCENARIOS.map((scenario) => <button type="button" key={scenario.id}
          className={scenario.id === selectedScenarioId ? 'scenario-selected' : ''} aria-pressed={scenario.id === selectedScenarioId}
          data-testid={`mock-scenario-${scenario.id}`} onClick={() => selectScenario(scenario.id)}>
          <span>{scenario.workOrder.workOrderRef}</span><b>{scenario.title}</b><small>{scenario.description}</small>
        </button>)}</div>
      </aside>

      <section className="production-mock-runner">
        <div className="production-business-question"><span>计划员提问</span><h2>“{selectedScenario.businessQuestion}”</h2>
          <p>演示数据固定在本次构建中，重复运行会得到完全相同的来源与结论。</p></div>
        <StageRail stages={stages} />
        <button className="primary production-run-button" type="button" data-testid="run-production-mock"
          disabled={running} onClick={() => void run()}>{running ? '小纬正在读取业务事实…' : result === undefined ? '运行完整业务链路' : '重新运行此场景'}</button>
      </section>
    </div>

    {result === undefined
      ? <section className="production-result-placeholder" data-testid="production-mock-placeholder"><span>纬</span><div><b>等待运行</b><p>结果会在这里展示工单、设备映射、Hive 状态、报警覆盖、未知项和今日行动。</p></div></section>
      : <ProductionBriefResultView result={result} />}
  </ProductShell>;
}
