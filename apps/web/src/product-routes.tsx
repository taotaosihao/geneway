import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { taskListQuerySchema, workflowListQuerySchema, type GateALiveEvidenceProjection, type TaskListQuery } from '@geneway/contracts';
import { InternalAcceptanceNotice, SimulationNotice } from '@geneway/ui';
import { api, apiErrorCode, apiErrorStatus, mergeTaskEventBatch, type PublicTask, type PublicWorkflow } from './api.js';

const STEP_NAMES: Readonly<Record<string, string>> = {
  document_ingest: '读取材料',
  requirement_extract: '提取需求',
  contradiction_check: '检查矛盾',
  solution_design: '生成方案',
  evidence_verify: '核验证据',
  result_quality_check: '检查质量',
  exception_snapshot_load: '读取异常快照',
  deterministic_baseline: '计算确定性基线',
  expert_route_resolve: '解析专家路线',
  impact_analysis: '分析异常影响',
  action_recommendation: '生成处置建议',
  evidence_quality_check: '检查证据质量',
  report_publish: '发布结果',
};

function isLiveTask(task: PublicTask): task is Extract<PublicTask, { recordVariant: 'business-task.live/1' }> {
  return 'recordVariant' in task && task.recordVariant === 'business-task.live/1';
}

function isLiveWorkflow(workflow: PublicWorkflow): workflow is Extract<PublicWorkflow, { recordVariant: 'workflow-read-model.live/1' }> {
  return 'recordVariant' in workflow && workflow.recordVariant === 'workflow-read-model.live/1';
}

function isLiveEvidence(evidence: PublicTask['evidence'][number]): evidence is GateALiveEvidenceProjection {
  return 'recordVariant' in evidence && evidence.recordVariant === 'evidence.live/1';
}

function evidenceHash(evidence: PublicTask['evidence'][number]): string {
  return isLiveEvidence(evidence) ? evidence.source.excerptSha256 : evidence.excerptSha256;
}

function statementKindLabel(kind: 'fact' | 'inference' | 'recommendation' | 'unknown'): string {
  return kind === 'fact' ? '事实' : kind === 'inference' ? '推断' : kind === 'recommendation' ? '建议' : '未知项';
}

export type RouteState = 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'forbidden' | 'not-found'
  | 'stale' | 'binding-conflict' | 'approval-stale' | 'offline' | 'server-error' | 'canceled' | 'recovering';

export function routeStateForError(cause: unknown): RouteState {
  const code = apiErrorCode(cause);
  const status = apiErrorStatus(cause);
  if (code === 'NETWORK_OFFLINE' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'offline';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (code === 'BUSINESS_EXCEPTION_STALE' || code === 'TASK_CANCEL_CAS_CONFLICT') return 'stale';
  if (code === 'ANALYSIS_BINDING_CONFLICT') return 'binding-conflict';
  if (['APPROVAL_SUBJECT_CHANGED', 'APPROVAL_EXPIRED', 'APPROVAL_CAS_CONFLICT'].includes(code)) return 'approval-stale';
  return 'server-error';
}

export function isFailClosedRouteState(state: RouteState): boolean {
  return state === 'forbidden' || state === 'not-found';
}

function navigationClass(current: string, target: string): string | undefined {
  return current === target ? 'nav-active' : undefined;
}

export function ProductShell({
  active,
  title,
  subtitle,
  state,
  children,
  inspector,
  boundaryNotice,
}: Readonly<{
  active: 'exceptions' | 'tasks' | 'workflows';
  title: string;
  subtitle: string;
  state: RouteState;
  children: ReactNode;
  inspector?: ReactNode;
  boundaryNotice?: ReactNode;
}>) {
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  useEffect(() => {
    const markOffline = () => setBrowserOffline(true);
    const markOnline = () => setBrowserOffline(false);
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', markOnline);
    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', markOnline);
    };
  }, []);
  const visibleState = browserOffline ? 'offline' : state;
  return <main className="app-shell product-shell" data-state={visibleState} data-testid="product-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
      <a className="new-task" href="/conversations/new">＋ 新建会话</a>
      <nav>
        <b>工作区</b>
        <a href="/conversations/new">小纬</a>
        <a href="/conversations/new?capability=solution.analysis.v1">材料分析</a>
        <a className={navigationClass(active, 'exceptions')} href="/exceptions">异常与待办</a>
        <a className={navigationClass(active, 'tasks')} href="/tasks">我的任务</a>
        <a className={navigationClass(active, 'workflows')} href="/workflows">Workflow</a>
        <span>生产日报 · 即将开放</span>
      </nav>
      <section className="operations-preview" aria-label="制造业状态入口">
        <h3>现场动态</h3>
        <a href="/exceptions?exceptionType=equipment_alarm"><span className="signal danger" />设备异常待处理<small>模拟数据</small></a>
        <a href="/exceptions?exceptionType=capacity_progress_lag"><span className="signal warning" />产能进度落后<small>模拟数据</small></a>
      </section>
    </aside>
    <section className="product-pane">
      <header className="topbar product-topbar"><div><h1>{title}</h1><p>{subtitle}</p></div>{boundaryNotice ?? <SimulationNotice />}</header>
      <div className="product-content">{children}</div>
    </section>
    <aside className="inspector product-inspector">
      <div className="inspector-head"><span>检查器</span></div>
      {!isFailClosedRouteState(visibleState) && (inspector ?? <div className="empty-inspector"><span>◇</span><p>选择任务或 Workflow 后，这里会显示权威版本与恢复信息。</p></div>)}
    </aside>
  </main>;
}

export function LoadingState() {
  return <section className="route-state route-loading" data-testid="route-loading"><span className="route-spinner" /><div><b>正在读取权威状态</b><p>数据来自 Control Plane，不使用浏览器夹具。</p></div></section>;
}

const ROUTE_FAILURE_COPY: Readonly<Record<Exclude<RouteState, 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'canceled' | 'recovering'>, string>> = {
  forbidden: '当前账号无权查看此内容',
  'not-found': '对象不存在或当前账号无权查看',
  stale: '页面版本已过期，请重新读取最新快照',
  'binding-conflict': '此异常已绑定另一组不可变分析语义',
  'approval-stale': '审批主题已变化，旧审批不能执行',
  offline: 'Control Plane 当前离线',
  'server-error': '服务暂时无法完成请求',
};

export function ErrorState({ message, state = 'server-error', onRetry }: Readonly<{
  message: string;
  state?: Exclude<RouteState, 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'canceled' | 'recovering'>;
  onRetry?: () => void;
}>) {
  const safeMessage = state === 'not-found' ? '请检查链接或返回列表重新选择。' : message;
  return <section className="route-state route-error" role="alert" data-testid={`route-${state}`}><span>!</span><div><b>{ROUTE_FAILURE_COPY[state]}</b><p>{safeMessage}</p><button type="button" className="secondary" onClick={onRetry ?? (() => location.reload())}>重新加载</button></div></section>;
}

export function RouteFailure({ state, message }: Readonly<{ state: RouteState; message: string }>) {
  if (['loading', 'ready', 'empty', 'filtered-empty', 'canceled', 'recovering'].includes(state)) return null;
  return <ErrorState message={message} state={state as keyof typeof ROUTE_FAILURE_COPY} />;
}

function EmptyState({ kind }: Readonly<{ kind: 'task' | 'workflow' }>) {
  return <section className="route-state route-empty" data-testid="route-empty"><span>◇</span><div><b>{kind === 'task' ? '还没有任务' : '还没有 Workflow'}</b><p>{kind === 'task' ? '先与小纬开始一个方案分析任务。' : 'Workflow 会在任务创建并编译后出现在这里。'}</p><a className="primary route-action" href="/conversations/new?capability=solution.analysis.v1">与小纬对话</a></div></section>;
}

export function Fact({ label, value, testId }: Readonly<{ label: string; value: ReactNode; testId?: string }>) {
  return <div><dt>{label}</dt><dd data-testid={testId}>{value}</dd></div>;
}

function listLocation(): Readonly<{ cursor?: string; previous?: string }> {
  const query = new URLSearchParams(window.location.search);
  const cursor = query.get('cursor');
  const previous = query.get('previous');
  return {
    ...(cursor === null ? {} : { cursor }),
    ...(previous === null ? {} : { previous }),
  };
}

function pageHref(pathname: '/tasks' | '/workflows', cursor: string, previous?: string, preserved?: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams(preserved);
  query.set('cursor', cursor);
  if (previous !== undefined) query.set('previous', previous);
  return `${pathname}?${query.toString()}`;
}

function firstPageHref(pathname: '/tasks' | '/workflows', preserved?: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams(preserved);
  return query.size === 0 ? pathname : `${pathname}?${query.toString()}`;
}

function PaginationControls({
  pathname,
  currentCursor,
  previousCursor,
  nextCursor,
  preserved,
}: Readonly<{
  pathname: '/tasks' | '/workflows';
  currentCursor?: string;
  previousCursor?: string;
  nextCursor: string | null;
  preserved?: Readonly<Record<string, string>>;
}>) {
  return <nav className="pagination" aria-label="列表分页" data-testid="pagination-controls">
    {currentCursor === undefined
      ? <span className="pagination-disabled">上一页</span>
      : <a className="secondary" href={previousCursor === undefined ? firstPageHref(pathname, preserved) : pageHref(pathname, previousCursor, undefined, preserved)}>上一页</a>}
    {nextCursor === null
      ? <span className="pagination-disabled">下一页</span>
      : <a className="secondary" data-testid="next-page" href={pageHref(pathname, nextCursor, currentCursor, preserved)}>下一页</a>}
  </nav>;
}

function WorkflowGraph({ workflow, task }: Readonly<{ workflow: PublicWorkflow; task?: PublicTask }>) {
  const graph = useMemo(() => {
    const statuses = new Map(task?.steps.map((step) => [step.id, step.status]) ?? []);
    const nodes = workflow.nodes.map((node, index): Node => ({
      id: node.id,
      position: { x: (index % 3) * 230, y: Math.floor(index / 3) * 145 },
      data: { label: `${STEP_NAMES[node.id] ?? node.id}\n${statuses.get(node.id) ?? node.kind}` },
      className: `flow-node flow-node-${statuses.get(node.id) ?? 'version'}`,
      draggable: false,
      selectable: true,
    }));
    const edges = workflow.edges.map((edge): Edge => ({
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      animated: statuses.get(edge.to) === 'running',
    }));
    return { nodes, edges };
  }, [task, workflow]);

  return <div className="product-flow" data-testid="workflow-graph" data-workflow-id={workflow.id} data-workflow-hash={workflow.hash}>
    <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}

function TaskInspector({ task }: Readonly<{ task: PublicTask }>) {
  return <>
    <dl className="facts">
      <Fact label="Task" value={task.id} testId="inspector-task-id" />
      <Fact label="Conversation" value={task.conversationId} />
      <Fact label="WorkflowVersion" value={task.workflowVersion.id} testId="inspector-workflow-id" />
      <Fact label="Workflow hash" value={task.workflowVersion.hash} testId="inspector-workflow-hash" />
      <Fact label="Aggregate" value={task.aggregateVersion} />
      <Fact label="Event watermark" value={task.eventWatermark} />
    </dl>
    {isLiveTask(task) ? <InternalAcceptanceNotice /> : <SimulationNotice />}
  </>;
}

export function TaskListPage() {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listTasks>>>();
  const location = listLocation();
  const query = useMemo((): TaskListQuery => {
    const params = new URLSearchParams(window.location.search);
    const raw: Record<string, string> = {};
    for (const name of ['status', 'capabilityId', 'sort', 'direction', 'limit', 'cursor']) {
      const value = params.get(name);
      if (value !== null && value.length > 0) raw[name] = value;
    }
    return taskListQuerySchema.parse(raw);
  }, []);
  const filtered = query.status !== undefined || query.capabilityId !== undefined;

  useEffect(() => {
    let active = true;
    void api.listTasks(query).then((value) => {
      if (!active) return;
      setResult(value);
      setState(value.tasks.length === 0 ? filtered ? 'filtered-empty' : 'empty' : 'ready');
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setState(routeStateForError(cause));
    });
    return () => { active = false; };
  }, [filtered, query]);

  return <ProductShell active="tasks" title="我的任务" subtitle="小纬发起的任务、专家路线、审批与交付状态" state={state} inspector={result !== undefined ? <dl className="facts">
    <Fact label="Query version" value={result.queryVersion} />
    <Fact label="Snapshot as of" value={result.asOf} />
    <Fact label="下一页" value={result.nextCursor === null ? '无' : '可继续'} />
  </dl> : undefined}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {state === 'empty' && <EmptyState kind="task" />}
    {state === 'filtered-empty' && <section className="route-state route-empty" data-testid="route-filtered-empty"><span>◇</span><div><b>当前筛选没有匹配任务</b><p>筛选由 Control Plane 执行，浏览器没有拼接其他页面。</p><a className="secondary route-action" href="/tasks">清除筛选</a></div></section>}
    <form className="exception-filters" method="get" action="/tasks" aria-label="任务列表筛选">
      <label>状态<select name="status" defaultValue={query.status ?? ''}><option value="">全部</option>{['awaiting_approval', 'approved', 'queued', 'running', 'completed', 'failed', 'canceled'].map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
      <label>Capability<select name="capabilityId" defaultValue={query.capabilityId ?? ''}><option value="">全部</option><option value="solution.analysis.v1">方案分析</option><option value="operations.exception-assist.v1">异常分析</option></select></label>
      <button className="primary" type="submit">查询</button><a className="secondary" href="/tasks">重置</a>
    </form>
    {state === 'ready' && result !== undefined && <section className="table-card">
      <div className="section-heading"><div><span className="eyebrow">Task authority</span><h2>任务列表</h2></div><span>{result.tasks.length} 条当前页记录</span></div>
      <div className="table-scroll"><table className="product-table" data-testid="task-table"><thead><tr><th>任务</th><th>状态</th><th>Workflow</th><th>审批</th><th>更新时间</th></tr></thead><tbody>
        {result.tasks.map((task) => <tr key={task.id} data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}
          data-record-variant={'recordVariant' in task ? task.recordVariant : 'business-task.simulation/1'}>
          <td><a href={`/tasks/${encodeURIComponent(task.id)}`}><b>{task.title}</b><small>{task.id}</small><small data-testid="task-list-boundary">{'recordVariant' in task ? '可信本机内部验收' : 'simulation=true'}</small></a></td>
          <td><span className={`status status-${task.status}`}>{task.status}</span></td>
          <td><a className="mono-link" href={`/tasks/${encodeURIComponent(task.id)}/workflow`}>{task.workflowVersion.id}<small>{task.workflowVersion.hash.slice(0, 12)}…</small></a></td>
          <td>{task.approvalStatus}</td>
          <td>{new Date(task.updatedAt).toLocaleString('zh-CN')}</td>
        </tr>)}
      </tbody></table></div>
      <PaginationControls
        pathname="/tasks"
        nextCursor={result.nextCursor}
        preserved={{
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.capabilityId === undefined ? {} : { capabilityId: query.capabilityId }),
          sort: query.sort, direction: query.direction, limit: String(query.limit),
        }}
        {...(location.cursor === undefined ? {} : { currentCursor: location.cursor })}
        {...(location.previous === undefined ? {} : { previousCursor: location.previous })}
      />
    </section>}
  </ProductShell>;
}

export function TaskDetailPage({ taskId }: Readonly<{ taskId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [task, setTask] = useState<PublicTask>();
  const [acting, setActing] = useState(false);

  const loadTask = useCallback(async () => {
    const value = await api.getTask(taskId);
    setTask(value);
    setState(value.status === 'canceled' ? 'canceled' : 'ready');
    return value;
  }, [taskId]);

  useEffect(() => {
    if (task === undefined || !['queued', 'running', 'cancel_requested'].includes(task.status)) return;
    let active = true;
    let cursor = task.eventWatermark;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const batch = mergeTaskEventBatch(task.id, cursor, await api.events(task.id, cursor));
        cursor = batch.cursor;
        const reclaimed = batch.events.some((event) => event.eventType === 'workflow.run_reclaimed');
        const terminal = batch.events.some((event) => ['business_task.completed', 'business_task.failed', 'business_task.canceled'].includes(event.eventType));
        if (active && reclaimed) setState('recovering');
        if (active && (batch.events.length > 0 || terminal)) {
          const current = await api.getTask(task.id);
          if (active) {
            setTask(current);
            setState(current.status === 'canceled' ? 'canceled' : reclaimed && current.status === 'running' ? 'recovering' : 'ready');
          }
        }
      } catch (cause) {
        if (active) {
          const nextState = routeStateForError(cause);
          setError(cause instanceof Error ? cause.message : String(cause));
          if (isFailClosedRouteState(nextState)) setTask(undefined);
          setState(nextState);
        }
      } finally {
        if (active) timer = setTimeout(() => void poll(), 750);
      }
    };
    timer = setTimeout(() => void poll(), 0);
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [task?.id, task?.status]);

  useEffect(() => {
    let active = true;
    void api.getTask(taskId).then((value) => { if (active) { setTask(value); setState(value.status === 'canceled' ? 'canceled' : 'ready'); } }).catch((cause: unknown) => {
      if (active) {
        const nextState = routeStateForError(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
        if (isFailClosedRouteState(nextState)) setTask(undefined);
        setState(nextState);
      }
    });
    return () => { active = false; };
  }, [taskId]);

  const approveAndExecute = useCallback(async () => {
    if (task === undefined) return;
    setActing(true); setError('');
    try {
      if (task.status === 'awaiting_approval') await api.approve(task.approval.id);
      await api.execute(task.id, task.approval);
      await loadTask();
    } catch (cause) {
      const nextState = routeStateForError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (isFailClosedRouteState(nextState)) setTask(undefined);
      setState(nextState);
    } finally { setActing(false); }
  }, [loadTask, task]);

  const cancel = useCallback(async () => {
    if (task === undefined) return;
    setActing(true); setError('');
    try {
      await api.cancelTask(task.id);
      await loadTask();
    } catch (cause) {
      const nextState = routeStateForError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (isFailClosedRouteState(nextState)) setTask(undefined);
      setState(nextState);
    } finally { setActing(false); }
  }, [loadTask, task]);

  return <ProductShell active="tasks" title="任务详情" subtitle="同一个任务的步骤、审批、证据与交付物" state={state} inspector={task === undefined ? undefined : <TaskInspector task={task} />}
    boundaryNotice={task !== undefined && isLiveTask(task) ? <InternalAcceptanceNotice /> : <SimulationNotice />}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {state === 'recovering' && <section className="route-state route-recovering" data-testid="route-recovering"><span className="route-spinner" /><div><b>Worker 正在恢复同一任务</b><p>从已持久化 checkpoint 与事件游标续传，不会创建第二份结果。</p></div></section>}
    {task !== undefined && !isFailClosedRouteState(state) && <div className="detail-stack" data-testid="task-detail" data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}
      data-record-variant={isLiveTask(task) ? task.recordVariant : 'business-task.simulation/1'}>
      <section className="detail-hero"><div><span className="eyebrow">{task.capabilityId}</span><h2>{task.title}</h2><p>{isLiveTask(task) ? '可信本机内部验收：小纬自动安排已登记专家版本，真实模型仅经 Model Gateway；不允许业务决策。' : '用户只看到小纬；当前任务保持醒目标记的 legacy 模拟边界。'}</p></div><span className={`status status-${task.status}`}>{task.status}</span></section>
      <section className="task-action-bar" aria-label="任务操作">
        <div><b>任务操作</b><p>审批和执行仍写入同一个 Control Plane 权威状态。</p></div>
        <div className="actions">
          {['awaiting_approval', 'approved'].includes(task.status) && <button className="primary" type="button" data-testid="task-approve-execute" disabled={acting} onClick={() => void approveAndExecute()}>{acting ? '正在提交…' : task.status === 'awaiting_approval' ? isLiveTask(task) ? '批准并执行真实分析' : '批准并执行模拟任务' : isLiveTask(task) ? '执行真实分析' : '执行模拟任务'}</button>}
          {['queued', 'running'].includes(task.status) && <button className="secondary" type="button" data-testid="task-detail-cancel" disabled={acting} onClick={() => void cancel()}>{acting ? '正在取消…' : isLiveTask(task) ? '取消分析任务' : '取消模拟任务'}</button>}
        </div>
      </section>
      {error.length > 0 && <div className="error" role="alert">{error}</div>}
      <section className="binding-grid">
        <div><span>WorkflowVersion</span><a href={`/tasks/${encodeURIComponent(task.id)}/workflow`} data-testid="task-workflow-id">{task.workflowVersion.id}</a><code data-testid="task-workflow-hash">{task.workflowVersion.hash}</code></div>
        <div><span>ApprovalVersion</span><b>{task.approval.id} · v{task.approval.version}</b><code data-testid="approval-subject-digest">{task.approval.subjectDigest}</code></div>
        <div><span>专家路线</span><b data-testid="expert-target">{isLiveTask(task) ? `小纬自动安排 · ${task.expertTarget.resolved.expertId}` : task.expertTarget.mode === 'auto' ? '小纬自动安排' : task.expertTarget.mode === 'team' ? `专家团 · ${task.expertTarget.teamId}` : `专家 · ${task.expertTarget.expertId}`}</b><small>专家不是客户消息作者</small></div>
      </section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Workflow run</span><h2>步骤时间线</h2></div><a href={`/tasks/${encodeURIComponent(task.id)}/workflow`}>查看流程图</a></div><ol className="step-timeline" data-testid="task-steps">
        {task.steps.map((step) => <li key={step.id} data-step-id={step.id} data-step-status={step.status}><span className={`step-dot step-${step.status}`} /><div><b>{STEP_NAMES[step.id] ?? step.id}</b><small>{step.id}</small></div><code>{step.status}</code></li>)}
      </ol></section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Claim–Evidence</span><h2>结论与证据</h2></div><span>{task.evidence.length} 条 Evidence</span></div>
        {isLiveTask(task)
          ? task.result === null ? <p className="muted-copy">任务尚未发布结构化结果。</p> : task.result.statements.map((statement) => <article className={`analysis-statement analysis-statement-${statement.kind} ${statement.status}`} key={statement.id}
              data-testid={`analysis-statement-${statement.kind}`} data-statement-id={statement.id} data-statement-kind={statement.kind} data-statement-status={statement.status}>
              <div className="analysis-statement-head"><b>{statementKindLabel(statement.kind)}</b><span>{statement.status === 'published' ? '已发布' : '未发布'}</span></div>
              <p>{statement.text}</p><small>confidence {statement.confidence.toFixed(2)}{statement.rejectionCode === null ? '' : ` · ${statement.rejectionCode}`}</small>
              {statement.evidenceRefIds.map((evidenceId) => <span className="statement-evidence-link" key={evidenceId}>Evidence · {evidenceId}</span>)}
            </article>)
          : task.claims.length === 0 ? <p className="muted-copy">任务尚未发布结论。</p> : task.claims.map((claim) => <article className={`claim ${claim.status}`} key={claim.id} data-claim-id={claim.id}><b>{claim.status === 'published' ? '已核验结论' : '未发布候选'}</b><p>{claim.text}</p><small>{claim.evidenceRefId ?? claim.rejectionCode}</small></article>)}
        <div className="evidence-grid">{task.evidence.map((evidence) => <article key={evidence.id} data-evidence-id={evidence.id}><span>Evidence</span><b>{evidence.id}</b><code>{evidenceHash(evidence)}</code><small>{evidence.resourceScope} · {evidence.dataClass}</small></article>)}</div>
      </section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Artifact</span><h2>交付物</h2></div><span>{task.artifacts.length} 个文件</span></div>
        <div className="artifact-list">{task.artifacts.map((artifact) => <article key={artifact.id} data-artifact-id={artifact.id} data-content-sha256={artifact.contentSha256}><div><b>{artifact.displayName}</b><small>{artifact.kind} · {artifact.sizeBytes} bytes</small></div><code>{artifact.contentSha256}</code><a href={artifact.downloadUrl}>下载</a></article>)}</div>
      </section>
      {task.result !== null && <section className="detail-card result-summary" data-testid="task-result"><span className="eyebrow">{isLiveTask(task) ? '结构化真实分析 · 内部验收' : 'Result'}</span><h2>{isLiveTask(task) ? task.result.summary : task.result.kind === 'completed' ? task.result.summary : task.result.message}</h2></section>}
    </div>}
  </ProductShell>;
}

export function TaskWorkflowPage({ taskId }: Readonly<{ taskId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [task, setTask] = useState<PublicTask>();
  const [workflow, setWorkflow] = useState<PublicWorkflow>();
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getTask(taskId).then(async (taskValue) => {
      const workflowValue = await api.getWorkflow(taskValue.workflowVersion.id);
      if (workflowValue.id !== taskValue.workflowVersion.id || workflowValue.hash !== taskValue.workflowVersion.hash) {
        throw new Error('WORKFLOW_BINDING_MISMATCH: 任务绑定与不可变 WorkflowVersion 不一致');
      }
      if (active) { setTask(taskValue); setWorkflow(workflowValue); setState('ready'); }
    }).catch((cause: unknown) => {
      if (active) {
        const nextState = routeStateForError(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
        if (isFailClosedRouteState(nextState)) { setTask(undefined); setWorkflow(undefined); }
        setState(nextState);
      }
    });
    return () => { active = false; };
  }, [taskId]);

  const execute = useCallback(async () => {
    if (task === undefined) return;
    setActing(true); setError('');
    try {
      await api.execute(task.id, task.approval);
      const current = await api.getTask(task.id);
      setTask(current);
      setState('ready');
    } catch (cause) {
      const nextState = routeStateForError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (isFailClosedRouteState(nextState)) { setTask(undefined); setWorkflow(undefined); }
      setState(nextState);
    } finally { setActing(false); }
  }, [task]);

  return <ProductShell active="tasks" title="任务 Workflow" subtitle="不可变版本叠加当前任务步骤和审批摘要" state={state}
    boundaryNotice={task !== undefined && isLiveTask(task) ? <InternalAcceptanceNotice /> : <SimulationNotice />} inspector={task === undefined ? undefined : <>
    <TaskInspector task={task} />
    <dl className="facts"><Fact label="ApprovalVersion" value={task.approval.version} testId="workflow-approval-version" /><Fact label="ApprovalSubject digest" value={task.approval.subjectDigest} testId="workflow-approval-digest" /></dl>
  </>}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {task !== undefined && workflow !== undefined && !isFailClosedRouteState(state) && <section className="workflow-page-card" data-testid="task-workflow" data-task-id={task.id}>
      <div className="section-heading"><div><span className="eyebrow">Task-scoped projection</span><h2>{workflow.id}</h2><code data-testid="workflow-hash">{workflow.hash}</code></div><a href={`/workflows/${encodeURIComponent(workflow.id)}`}>查看不可变版本</a></div>
      {task.status === 'approved' && task.approval.status === 'approved' && <section className="task-action-bar" aria-label="Workflow 执行">
        <div><b>执行已审批 Workflow</b><p>提交当前页面冻结的 ApprovalVersion 与 ApprovalSubject digest。</p></div>
        <button className="primary" type="button" data-testid="task-workflow-execute" disabled={acting} onClick={() => void execute()}>{acting ? '正在提交…' : isLiveTask(task) ? '执行真实分析' : '执行模拟任务'}</button>
      </section>}
      <WorkflowGraph workflow={workflow} task={task} />
    </section>}
  </ProductShell>;
}

export function WorkflowListPage() {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listWorkflows>>>();
  const location = listLocation();
  const query = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const capabilityVersionId = params.get('capabilityVersionId');
    return {
      ...(capabilityVersionId === null || capabilityVersionId === '' ? {} : { capabilityVersionId }),
      ...(location.cursor === undefined ? {} : { cursor: location.cursor }),
    };
  }, [location.cursor]);
  const parsedQuery = useMemo(() => workflowListQuerySchema.parse(query), [query]);
  const filtered = parsedQuery.capabilityVersionId !== undefined;

  useEffect(() => {
    let active = true;
    void api.listWorkflows(parsedQuery).then((value) => {
      if (active) { setResult(value); setState(value.workflows.length === 0 ? filtered ? 'filtered-empty' : 'empty' : 'ready'); }
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState(routeStateForError(cause)); }
    });
    return () => { active = false; };
  }, [filtered, parsedQuery]);

  return <ProductShell active="workflows" title="Workflow" subtitle="当前用户可见任务所引用的不可变流程版本" state={state} inspector={result !== undefined ? <dl className="facts"><Fact label="Query version" value={result.queryVersion} /><Fact label="Snapshot as of" value={result.asOf} /></dl> : undefined}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {state === 'empty' && <EmptyState kind="workflow" />}
    {state === 'filtered-empty' && <section className="route-state route-empty" data-testid="route-filtered-empty"><span>◇</span><div><b>当前筛选没有匹配 Workflow</b><p>筛选由 Control Plane 执行，浏览器没有拼接其他页面。</p><a className="secondary route-action" href="/workflows">清除筛选</a></div></section>}
    <form className="exception-filters" method="get" action="/workflows" aria-label="Workflow 列表筛选">
      <label>CapabilityVersion<select name="capabilityVersionId" defaultValue={parsedQuery.capabilityVersionId ?? ''}><option value="">全部</option><option value="cap_solution_analysis_v1_1">方案分析</option><option value="cap_operations_exception_assist_v1_shadow_1">异常分析</option></select></label>
      <button className="primary" type="submit">查询</button><a className="secondary" href="/workflows">重置</a>
    </form>
    {state === 'ready' && result !== undefined && <section className="table-card"><div className="section-heading"><div><span className="eyebrow">Immutable registry</span><h2>流程版本</h2></div><span>{result.workflows.length} 个版本</span></div><div className="table-scroll"><table className="product-table" data-testid="workflow-table"><thead><tr><th>WorkflowVersion</th><th>Capability</th><th>Harness</th><th>创建时间</th></tr></thead><tbody>
      {result.workflows.map((workflow) => <tr key={workflow.id} data-workflow-id={workflow.id} data-workflow-hash={workflow.hash}><td><a href={`/workflows/${encodeURIComponent(workflow.id)}`}><b>{workflow.id}</b><small>{workflow.hash}</small></a></td><td>{workflow.capabilityVersionId}</td><td>{workflow.harnessVersionId}</td><td>{new Date(workflow.createdAt).toLocaleString('zh-CN')}</td></tr>)}
    </tbody></table></div><PaginationControls
      pathname="/workflows"
      nextCursor={result.nextCursor}
      preserved={{ ...(parsedQuery.capabilityVersionId === undefined ? {} : { capabilityVersionId: parsedQuery.capabilityVersionId }) }}
      {...(location.cursor === undefined ? {} : { currentCursor: location.cursor })}
      {...(location.previous === undefined ? {} : { previousCursor: location.previous })}
    /></section>}
  </ProductShell>;
}

export function WorkflowDetailPage({ workflowId }: Readonly<{ workflowId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [workflow, setWorkflow] = useState<PublicWorkflow>();

  useEffect(() => {
    let active = true;
    void api.getWorkflow(workflowId).then((value) => { if (active) { setWorkflow(value); setState('ready'); } }).catch((cause: unknown) => {
      if (active) {
        const nextState = routeStateForError(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
        if (isFailClosedRouteState(nextState)) setWorkflow(undefined);
        setState(nextState);
      }
    });
    return () => { active = false; };
  }, [workflowId]);

  return <ProductShell active="workflows" title="WorkflowVersion" subtitle="只读、不可变、可校验的流程定义" state={state}
    boundaryNotice={workflow !== undefined && isLiveWorkflow(workflow) ? <InternalAcceptanceNotice /> : <SimulationNotice />} inspector={workflow === undefined ? undefined : <dl className="facts">
    <Fact label="WorkflowVersion" value={workflow.id} testId="workflow-version-id" />
    <Fact label="Hash" value={workflow.hash} testId="workflow-version-hash" />
    <Fact label="Compiler" value={workflow.compilerVersion} />
    <Fact label="Canonicalization" value={workflow.canonicalizationVersion} />
    <Fact label="Feature set" value={workflow.featureSet} />
  </dl>}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {workflow !== undefined && !isFailClosedRouteState(state) && <section className="workflow-page-card" data-testid="workflow-detail" data-workflow-id={workflow.id} data-workflow-hash={workflow.hash}>
      <div className="section-heading"><div><span className="eyebrow">Immutable WorkflowVersion</span><h2>{workflow.id}</h2><code>{workflow.hash}</code></div><span>{workflow.nodes.length} 个节点</span></div>
      <WorkflowGraph workflow={workflow} />
      <div className="permission-strip"><span>动作上限 {workflow.permissionCeiling.actions.join(' / ')}</span><span>数据等级 {workflow.permissionCeiling.dataClasses.join(' / ')}</span><span>{workflow.permissionCeiling.resourceScopes.join(' / ')}</span></div>
    </section>}
  </ProductShell>;
}
