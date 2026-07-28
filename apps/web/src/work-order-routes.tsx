import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gateA3WorkOrderRefSchema,
  type GateA3PublicTaskSnapshot,
  type GateA3PublicEvidenceProjection,
  type GateA3WorkOrderExplanation,
  type GateA3WorkOrderStatusCard,
} from '@geneway/contracts';
import { InternalAcceptanceNotice } from '@geneway/ui';
import { api, apiErrorCode, type WorkOrderCapabilityRoute } from './api.js';
import { ErrorState, LoadingState, ProductShell, routeStateForError, type RouteState } from './product-routes.js';

const STEP_LABELS: Readonly<Record<GateA3PublicTaskSnapshot['workflow']['steps'][number]['id'], string>> = {
  validate_work_order_ref: '校验工单编号',
  fetch_authorized_status: '读取获准状态',
  compute_progress: '计算生产进度',
  explain_status: '小纬说明',
  evidence_verify: '核验字段证据',
  publish_status_card: '发布只读状态卡',
};

const EVIDENCE_LABELS: Readonly<Record<keyof GateA3WorkOrderStatusCard['evidenceRefs'], string>> = {
  status: '状态',
  planQty: '计划数量',
  completedQty: '已产数量',
  updatedAt: '更新时间',
  sourceAsOf: '来源时间',
};

const TERMINAL_STATUSES = new Set<GateA3PublicTaskSnapshot['status']>(['completed', 'failed', 'canceled']);

function publicWorkOrderError(cause: unknown): string {
  const code = apiErrorCode(cause);
  if (code === 'NETWORK_OFFLINE') return 'Control Plane 当前不可连接，已停止查询；普通聊天和材料分析不受影响。';
  if (code === 'WORK_ORDER_ROUTE_NOT_OPEN' || code === 'CAPABILITY_NOT_OPEN') {
    return '只读工单通道未配置或不可用；普通聊天和材料分析不受影响。';
  }
  if (code === 'WORK_ORDER_NOT_FOUND_OR_FORBIDDEN') return '工单不存在或当前用户无权查看。';
  if (code === 'APPROVAL_SUBJECT_CHANGED' || code === 'APPROVAL_EXPIRED') return '审批对象已变化或过期，请刷新后重新确认。';
  return '本次只读工单查询未完成，未发布状态卡。';
}

function evidenceAnchor(evidenceId: string): string {
  return `evidence-${encodeURIComponent(evidenceId)}`;
}

function EvidenceLink({ evidenceId, label }: Readonly<{ evidenceId: string; label: string }>) {
  return <a className="work-order-evidence-link" href={`#${evidenceAnchor(evidenceId)}`}>
    {label} · Evidence {evidenceId}
  </a>;
}

function quantity(value: number | null, unit: string | null): string {
  if (value === null) return '未知';
  return `${String(value)}${unit === null ? '' : ` ${unit}`}`;
}

export function WorkOrderStatusCardView({ card }: Readonly<{ card: GateA3WorkOrderStatusCard }>) {
  const evidenceEntries = Object.entries(card.evidenceRefs) as Array<[
    keyof GateA3WorkOrderStatusCard['evidenceRefs'],
    string,
  ]>;
  return <section className="work-order-card" data-testid="work-order-status-card" data-read-only="true">
    <div className="work-order-card-head">
      <div><span className="eyebrow">WorkOrderStatusCard/1</span><h2>{card.workOrderRef}</h2></div>
      <span className="read-only-badge">只读</span>
    </div>
    <dl className="work-order-metrics">
      <div><dt>当前状态</dt><dd>{card.status}</dd></div>
      <div><dt>生产进度</dt><dd>{card.progressPct === null ? '未知' : `${String(card.progressPct)}%`}</dd></div>
      <div><dt>计划数量</dt><dd>{quantity(card.planQty, card.unit)}</dd></div>
      <div><dt>已产数量</dt><dd>{quantity(card.completedQty, card.unit)}</dd></div>
      <div><dt>工单更新时间</dt><dd><time dateTime={card.updatedAt}>{card.updatedAt}</time></dd></div>
      <div><dt>来源时间</dt><dd><time dateTime={card.sourceAsOf}>{card.sourceAsOf}</time></dd></div>
    </dl>
    <section className="work-order-field-evidence" aria-label="字段 Evidence">
      <h3>字段 Evidence</h3>
      {evidenceEntries.map(([field, evidenceId]) => <EvidenceLink
        evidenceId={evidenceId}
        key={field}
        label={EVIDENCE_LABELS[field]}
      />)}
    </section>
    <p className="work-order-deterministic-note">状态、数量与进度来自获准的只读快照和确定性计算；小纬不会修改或补造这些字段。</p>
  </section>;
}

export function WorkOrderExplanationView({ explanation, evidenceRefs }: Readonly<{
  explanation: GateA3WorkOrderExplanation;
  evidenceRefs: GateA3WorkOrderStatusCard['evidenceRefs'];
}>) {
  return <section className="work-order-explanation" data-testid="work-order-explanation">
    <div className="work-order-explanation-head"><span className="avatar">纬</span><div><span className="eyebrow">独立说明</span><h2>小纬说明</h2></div></div>
    <p>{explanation.summary}</p>
    <div className="work-order-explanation-statements">{explanation.statements.map((statement) => <article key={statement.id}>
      <span>{statement.kind === 'fact' ? '事实' : statement.kind === 'inference' ? '推断' : statement.kind === 'recommendation' ? '建议' : '未知项'}</span>
      <p>{statement.text}</p>
      <small>{statement.sourceFields.length === 0 ? '没有可用来源字段' : `来源字段：${statement.sourceFields.join('、')}`}</small>
      {statement.sourceFields.flatMap((field) => field in evidenceRefs
        ? [<EvidenceLink evidenceId={evidenceRefs[field as keyof typeof evidenceRefs]} key={field} label={`说明依据 · ${field}`} />]
        : [])}
    </article>)}</div>
  </section>;
}

function PublicEvidenceIndex({ card, explanation }: Readonly<{
  card: GateA3WorkOrderStatusCard;
  explanation: GateA3WorkOrderExplanation;
}>) {
  const explanationEvidenceIds = explanation.statements.flatMap((statement) => statement.sourceFields.flatMap((field) =>
    field in card.evidenceRefs ? [card.evidenceRefs[field as keyof typeof card.evidenceRefs]] : []));
  const evidenceIds = [...new Set([...Object.values(card.evidenceRefs), ...explanationEvidenceIds])];
  const [evidenceById, setEvidenceById] = useState<ReadonlyMap<string, GateA3PublicEvidenceProjection>>(new Map());
  const [evidenceError, setEvidenceError] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all(evidenceIds.map(async (evidenceId) => {
      const projection = await api.getWorkOrderEvidence(evidenceId);
      return [evidenceId, projection] as const;
    })).then((entries) => {
      if (active) setEvidenceById(new Map(entries));
    }).catch(() => { if (active) setEvidenceError(true); });
    return () => { active = false; };
  }, [evidenceIds.join('|')]);
  return <section className="work-order-evidence-index" aria-label="公开 Evidence 关联">
    <div className="section-heading"><div><span className="eyebrow">Public evidence links</span><h2>证据关联</h2></div><span>{evidenceIds.length} 条</span></div>
    <p>每条关联均由浏览器通过 Control Plane 重新授权并读取公开字段投影。</p>
    {evidenceError && <p role="alert">Evidence 当前不可读取；卡片不会改用未核验来源。</p>}
    <div>{evidenceIds.map((evidenceId) => {
      const projection = evidenceById.get(evidenceId);
      return <article id={evidenceAnchor(evidenceId)} key={evidenceId} data-testid="work-order-public-evidence">
        <code>{evidenceId}</code>
        {projection === undefined ? <small>正在从 Control Plane 重取…</small> : <dl>
          <div><dt>字段</dt><dd>{projection.fieldName}</dd></div>
          <div><dt>获准值</dt><dd>{projection.value === null ? 'null' : String(projection.value)}</dd></div>
          <div><dt>来源版本</dt><dd>{projection.sourceRevision}</dd></div>
          <div><dt>来源时间</dt><dd><time dateTime={projection.sourceAsOf}>{projection.sourceAsOf}</time></dd></div>
        </dl>}
      </article>;
    })}</div>
  </section>;
}

export function WorkOrderWorkflow({ task }: Readonly<{ task: GateA3PublicTaskSnapshot }>) {
  return <section className="work-order-workflow" data-testid="work-order-workflow">
    <div className="section-heading"><div><span className="eyebrow">冻结六节点 Workflow</span><h2>{task.workflow.templateId}</h2></div><span>{task.workflow.steps.length} 个节点</span></div>
    <div className="work-order-workflow-identity">
      <code data-testid="work-order-workflow-id">{task.workflow.workflowVersionId}</code>
      <code data-testid="work-order-workflow-hash">{task.workflow.workflowHash}</code>
    </div>
    <ol>{task.workflow.steps.map((step, index) => <li key={step.id}>
      <span>{String(index + 1).padStart(2, '0')}</span>
      <div><b>{STEP_LABELS[step.id]}</b><small>{step.id} · {step.kind}</small></div>
      <span className={`status status-${step.status}`}>{step.status}</span>
    </li>)}</ol>
  </section>;
}

function ApprovalCard({ task, busy, onApproveAndExecute }: Readonly<{
  task: GateA3PublicTaskSnapshot;
  busy: boolean;
  onApproveAndExecute: () => void;
}>) {
  const awaitingDecision = task.status === 'awaiting_approval' && task.approval.status === 'pending';
  const readyToExecute = task.status === 'approved' && task.approval.status === 'approved';
  const actionable = awaitingDecision || readyToExecute;
  return <section className="work-order-approval" data-testid="work-order-approval">
    <div className="section-heading"><div><span className="eyebrow">Approval</span><h2>确认只读查询</h2></div><span className={`status status-${task.approval.status}`}>{task.approval.status}</span></div>
    <dl>
      <div><dt>ApprovalVersion</dt><dd>{task.approval.id} · v{task.approval.version}</dd></div>
      <div><dt>Approval subject digest</dt><dd><code>{task.approval.subjectDigest}</code></dd></div>
      <div><dt>有效期</dt><dd><time dateTime={task.approval.expiresAt}>{task.approval.expiresAt}</time></dd></div>
    </dl>
    {actionable && <button className="primary" data-testid="work-order-approve-execute" disabled={busy} onClick={onApproveAndExecute}>
      {busy ? '正在处理…' : awaitingDecision ? '批准并执行只读查询' : '执行已审批只读查询'}
    </button>}
    {!actionable && task.status === 'awaiting_approval' && <p>当前 Approval 已不可执行，请刷新权威状态。</p>}
  </section>;
}

export function WorkOrderTaskView({ task, busy, error, onApproveAndExecute, onCancel }: Readonly<{
  task: GateA3PublicTaskSnapshot;
  busy: boolean;
  error?: string;
  onApproveAndExecute: () => void;
  onCancel: () => void;
}>) {
  const completed = task.result?.kind === 'work_order_status' ? task.result : undefined;
  return <div className="work-order-task-stack">
    <section className="work-order-task-hero">
      <div><span className="eyebrow">单工单只读查询</span><h1>{task.inputRef.workOrderRef}</h1><p>任务 {task.taskId} · 刷新会从 Control Plane 恢复同一权威对象。</p></div>
      <div className="work-order-task-state"><span className={`status status-${task.status}`}>{task.status}</span>
        {['queued', 'running'].includes(task.status) && <button className="secondary" disabled={busy} onClick={onCancel}>取消查询</button>}
      </div>
    </section>
    {error !== undefined && <div className="error" role="alert">{error}</div>}
    <div className="work-order-authority-grid"><WorkOrderWorkflow task={task} /><ApprovalCard task={task} busy={busy} onApproveAndExecute={onApproveAndExecute} /></div>
    {task.status === 'running' || task.status === 'queued' ? <section className="route-state route-loading"><span className="route-spinner" /><div><b>正在执行获准的只读查询</b><p>浏览器只轮询 Control Plane，不直接请求 GearJob。</p></div></section> : null}
    {completed !== undefined && <>
      <div className="work-order-result-grid"><WorkOrderStatusCardView card={completed.card} /><WorkOrderExplanationView explanation={completed.explanation} evidenceRefs={completed.card.evidenceRefs} /></div>
      <PublicEvidenceIndex card={completed.card} explanation={completed.explanation} />
    </>}
    {task.result?.kind === 'failed' && <section className="route-state work-order-terminal"><span>×</span><div><b>查询未发布</b><p>{task.result.message}</p></div></section>}
    {task.result?.kind === 'canceled' && <section className="route-state work-order-terminal"><span>×</span><div><b>查询已取消</b><p>{task.result.message}</p></div></section>}
  </div>;
}

function WorkOrderUnavailable() {
  return <section className="work-order-unavailable" data-testid="work-order-not-open">
    <span>NOT_OPEN</span><h2>只读工单通道未配置或不可用</h2>
    <p>当前 release、preflight 或 Connector Gate 尚未通过。不会查询 GearJob，也不会用模型猜测工单状态。</p>
    <div><a className="primary" href="/conversations/new">返回普通聊天</a><a className="secondary" href="/conversations/new?capability=solution.analysis.v1">分析材料</a></div>
  </section>;
}

function WorkOrderCreateForm({ busy, error, onSubmit }: Readonly<{
  busy: boolean;
  error?: string;
  onSubmit: (workOrderRef: string) => void;
}>) {
  const [workOrderRef, setWorkOrderRef] = useState('');
  const validation = useMemo(() => gateA3WorkOrderRefSchema.safeParse(workOrderRef), [workOrderRef]);
  return <section className="work-order-create-card" data-testid="work-order-create">
    <div><span className="eyebrow">production.work-order-status.v1</span><h1>查询一个工单</h1>
      <p>请输入单个 Work Order 标识。该值按原始字符精确匹配，不会 trim、大小写折叠、Unicode 规范化或别名解析。</p></div>
    <form onSubmit={(event) => { event.preventDefault(); if (validation.success) onSubmit(workOrderRef); }}>
      <label htmlFor="work-order-ref">Work Order 标识</label>
      <div><input id="work-order-ref" data-testid="work-order-ref" autoComplete="off" maxLength={128}
        placeholder="例如 WO-2026-001" spellCheck={false} value={workOrderRef}
        onChange={(event) => setWorkOrderRef(event.target.value)} />
        <button className="primary" disabled={busy || !validation.success}>{busy ? '正在创建…' : '创建查询任务'}</button></div>
      {workOrderRef.length > 0 && !validation.success && <small role="alert">仅允许 1–128 个 ASCII 字符：A–Z、a–z、0–9、点、下划线、冒号和连字符。</small>}
    </form>
    {error !== undefined && <div className="error" role="alert">{error}</div>}
    <aside><b>只读边界</b><p>每次只提交并查询一个明确的 Work Order 标识；所有访问边界均由服务端冻结并校验。</p></aside>
  </section>;
}

export function WorkOrderPage({ taskId }: Readonly<{ taskId?: string }>) {
  const [route, setRoute] = useState<WorkOrderCapabilityRoute>();
  const [task, setTask] = useState<GateA3PublicTaskSnapshot>();
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const recover = useCallback(async (id: string): Promise<GateA3PublicTaskSnapshot> => {
    const snapshot = await api.getWorkOrderTask(id);
    if (mounted.current) { setTask(snapshot); setState('ready'); }
    return snapshot;
  }, []);

  const poll = useCallback(async (id: string, initial?: GateA3PublicTaskSnapshot) => {
    let snapshot = initial ?? await recover(id);
    for (let attempt = 0; attempt < 300 && mounted.current && !TERMINAL_STATUSES.has(snapshot.status); attempt += 1) {
      if (snapshot.status === 'awaiting_approval') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      snapshot = await recover(id);
    }
  }, [recover]);

  useEffect(() => {
    mounted.current = true;
    const load = async () => {
      const capabilityRoute = await api.getWorkOrderCapabilityRoute();
      if (!mounted.current) return;
      setRoute(capabilityRoute);
      if (taskId === undefined) { setState('ready'); return; }
      const snapshot = await recover(taskId);
      if (snapshot.status === 'queued' || snapshot.status === 'running') void poll(taskId, snapshot);
    };
    void load().catch((cause: unknown) => {
      if (!mounted.current) return;
      setError(publicWorkOrderError(cause));
      setState(routeStateForError(cause));
    });
    return () => { mounted.current = false; };
  }, [poll, recover, taskId]);

  const create = async (workOrderRef: string) => {
    setBusy(true); setError(undefined);
    try {
      const conversation = await api.createConversation();
      const created = await api.createWorkOrderTask(conversation.id, workOrderRef);
      window.history.replaceState({}, '', `/work-orders/${encodeURIComponent(created.taskId)}`);
      await recover(created.taskId);
    } catch (cause) { setError(publicWorkOrderError(cause)); }
    finally { setBusy(false); }
  };

  const approveAndExecute = async () => {
    if (task === undefined) return;
    setBusy(true); setError(undefined);
    try {
      if (task.approval.status === 'pending') await api.approve(task.approval.id);
      const approved = await recover(task.taskId);
      if (approved.approval.status !== 'approved') throw new Error('APPROVAL_NOT_CURRENT');
      await api.execute(approved.taskId, approved.approval);
      await poll(approved.taskId);
    } catch (cause) {
      setError(publicWorkOrderError(cause));
      try { await recover(task.taskId); } catch { /* Keep the public action error. */ }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (task === undefined) return;
    setBusy(true); setError(undefined);
    try { await api.cancelTask(task.taskId); await recover(task.taskId); }
    catch (cause) { setError(publicWorkOrderError(cause)); }
    finally { setBusy(false); }
  };

  const inspector = task === undefined ? undefined : <dl className="facts">
    <div><dt>Task</dt><dd>{task.taskId}</dd></div>
    <div><dt>WorkflowVersion</dt><dd>{task.workflowVersionId}</dd></div>
    <div><dt>Workflow hash</dt><dd>{task.workflowHash}</dd></div>
    <div><dt>ApprovalVersion</dt><dd>{task.approval.id} · v{task.approval.version}</dd></div>
    <div><dt>Approval digest</dt><dd>{task.approval.subjectDigest}</dd></div>
  </dl>;

  return <ProductShell active="work-orders" title="查询工单" subtitle="单 Work Order · 只读 · 可信本机内部验收"
    state={state} boundaryNotice={<InternalAcceptanceNotice />} {...(inspector === undefined ? {} : { inspector })}>
    {state === 'loading' && <LoadingState />}
    {state !== 'loading' && route?.status === 'NOT_OPEN' && task === undefined && <WorkOrderUnavailable />}
    {state !== 'loading' && error !== undefined && task === undefined && (route === undefined || taskId !== undefined)
      && <ErrorState message={error} state={state as Exclude<RouteState, 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'canceled' | 'recovering'>} />}
    {state === 'ready' && route?.status === 'internal' && task === undefined && <WorkOrderCreateForm busy={busy}
      {...(error === undefined ? {} : { error })} onSubmit={(ref) => void create(ref)} />}
    {task !== undefined && <WorkOrderTaskView task={task} busy={busy} {...(error === undefined ? {} : { error })}
      onApproveAndExecute={() => void approveAndExecute()} onCancel={() => void cancel()} />}
  </ProductShell>;
}
