import { useState } from 'react';
import type { ProductionWorkOrderEquipmentBriefResponse } from '@geneway/contracts';
import { api, apiErrorCode } from './api.js';
import { ProductShell } from './product-routes.js';

const STAGE_LABELS: Readonly<Record<string, string>> = {
  'production.work_order.get.v1': '读取 GearJob 工单事实',
  'production.work_order.equipment.resolve.v1': '解析工序与设备映射',
  'equipment.runtime_status.get.v1': '读取 Hive 当前状态',
  'equipment.alarm_segments.list.v1': '读取报警时间段',
  'production.work_order_equipment_brief.v1': '生成今日行动建议',
};

function displayTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

export function ProductionBriefResult({ result }: Readonly<{ result: ProductionWorkOrderEquipmentBriefResponse }>) {
  return <section className="production-mock-result" data-testid="production-brief-result">
    <article className="production-decision action-no_action">
      <div className="decision-author"><span className="avatar">纬</span><div><small>小纬 · 生产计划员工单设备简报</small><h2>{result.summary}</h2></div></div>
      <div className="decision-action"><span>ACTION</span><b>{result.action}</b></div>
      <p>{result.reason}</p>
      <div className="decision-next"><span>建议下一步</span><b>{result.recommendedNextStep}</b></div>
    </article>
    <div className="production-fact-grid">
      <article className="production-fact-card" data-testid="production-work-order-facts">
        <div className="production-card-title"><span>01</span><div><b>工单事实</b><small>{result.workOrder.source.system} · {displayTime(result.workOrder.source.observedAt)}</small></div></div>
        <dl><div><dt>工单</dt><dd>{result.workOrder.workOrderRef}</dd></div><div><dt>产品</dt><dd>{result.workOrder.itemName}</dd></div>
          <div><dt>生产进度</dt><dd>{result.workOrder.progressPct}% <small>计划 {result.workOrder.expectedProgressPct}%</small></dd></div>
          <div><dt>来源 revision</dt><dd>{result.workOrder.source.revision}</dd></div></dl>
      </article>
      <article className="production-fact-card" data-testid="production-equipment-facts">
        <div className="production-card-title"><span>02</span><div><b>设备事实</b><small>{result.runtimeStatus.source.system} · {displayTime(result.runtimeStatus.source.observedAt)}</small></div></div>
        <dl><div><dt>设备</dt><dd>{result.mapping.selectedEquipmentRef}</dd></div><div><dt>状态</dt><dd>{result.runtimeStatus.status}</dd></div>
          <div><dt>新鲜度</dt><dd>{result.freshness.statusAgeSeconds} 秒 · {result.freshness.status}</dd></div>
          <div><dt>报警覆盖</dt><dd>{result.alarms.coverage}</dd></div></dl>
      </article>
    </div>
    <ol className="production-mock-stages" data-testid="production-server-trace">
      {result.trace.map((stage, index) => <li className="mock-stage-completed" key={stage.operationId} data-stage-id={stage.operationId}>
        <span>✓</span><div><b>{STAGE_LABELS[stage.operationId] ?? stage.operationId}</b><small>{stage.operationId}</small></div>
        <em>{index === result.trace.length - 1 ? '服务端决策' : `${stage.source} · ${stage.revision}`}</em>
      </li>)}
    </ol>
    <p className="production-safe-fallback">Unknowns：{result.unknowns.length === 0 ? '无' : result.unknowns.join('；')}</p>
  </section>;
}

export function ProductionBriefPage() {
  const [result, setResult] = useState<ProductionWorkOrderEquipmentBriefResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try { setResult(await api.runProductionWorkOrderEquipmentBrief()); }
    catch (cause) { setError(apiErrorCode(cause)); }
    finally { setRunning(false); }
  };
  return <ProductShell active="work-orders" title="工单设备简报" subtitle="生产计划员 synthetic capability 纵切" state="ready">
    <main className="product-page production-mock-page">
      <div className="production-mock-boundary" data-testid="production-synthetic-boundary">
        <span>DEMO</span><div><b>全合成业务演示</b><small>未连接真实 GearJob / Hive，不含客户数据</small></div>
      </div>
      <section className="production-mock-intro">
        <div><span className="eyebrow">SCN-NORMAL · SYNTHETIC_DEMO</span><h1>这个工单今天需要采取什么行动？</h1>
          <p>由 Web 发起真实 API 请求，服务端依次读取 synthetic GearJob 与 Hive 事实，并用唯一规则生成行动建议。</p></div>
        <div className="production-mock-contract"><span>Application Capability</span><b>production.work_order_equipment_brief.v1</b><small>evaluationAsOf 2026-07-29 08:30:00Z</small></div>
      </section>
      <section className="production-mock-runner">
        <div className="production-business-question"><span>固定验收场景</span><h2>WO-260729-001 · 正常生产</h2><p>页面仅持有场景引用；事实、trace 与行动结论均来自服务端。</p></div>
        <button className="production-run-button" type="button" disabled={running} onClick={() => { void run(); }} data-testid="run-production-brief">
          {running ? '正在贯穿服务端能力链…' : '运行 SCN-NORMAL'}
        </button>
        {error !== null && <p className="route-error" role="alert">请求失败：{error}</p>}
      </section>
      {result === null ? <section className="production-result-placeholder"><span>等待运行</span><p>点击按钮后显示服务端 trace、来源、时间、覆盖与行动结论。</p></section> : <ProductionBriefResult result={result} />}
    </main>
  </ProductShell>;
}
