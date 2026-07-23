import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TaskSnapshot, WorkflowDetailProjection } from '@geneway/contracts';
import { SimulationNotice } from '@geneway/ui';
import { api } from './api.js';

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

export type RouteState = 'loading' | 'ready' | 'empty' | 'server-error';

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
}: Readonly<{
  active: 'exceptions' | 'tasks' | 'workflows';
  title: string;
  subtitle: string;
  state: RouteState;
  children: ReactNode;
  inspector?: ReactNode;
}>) {
  return <main className="app-shell product-shell" data-state={state} data-testid="product-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
      <a className="new-task" href="/conversations/new?capability=solution.analysis.v1">＋ 新建会话</a>
      <nav>
        <b>工作区</b>
        <a href="/conversations/new?capability=solution.analysis.v1">小纬</a>
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
      <header className="topbar product-topbar"><div><h1>{title}</h1><p>{subtitle}</p></div><SimulationNotice /></header>
      <div className="product-content">{children}</div>
    </section>
    <aside className="inspector product-inspector">
      <div className="inspector-head"><span>检查器</span></div>
      {inspector ?? <div className="empty-inspector"><span>◇</span><p>选择任务或 Workflow 后，这里会显示权威版本与恢复信息。</p></div>}
    </aside>
  </main>;
}

export function LoadingState() {
  return <section className="route-state route-loading" data-testid="route-loading"><span className="route-spinner" /><div><b>正在读取权威状态</b><p>数据来自 Control Plane，不使用浏览器夹具。</p></div></section>;
}

export function ErrorState({ message }: Readonly<{ message: string }>) {
  return <section className="route-state route-error" role="alert" data-testid="route-error"><span>!</span><div><b>暂时无法读取</b><p>{message}</p><button type="button" className="secondary" onClick={() => location.reload()}>重新加载</button></div></section>;
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

function pageHref(pathname: '/tasks' | '/workflows', cursor: string, previous?: string): string {
  const query = new URLSearchParams({ cursor });
  if (previous !== undefined) query.set('previous', previous);
  return `${pathname}?${query.toString()}`;
}

function PaginationControls({
  pathname,
  currentCursor,
  previousCursor,
  nextCursor,
}: Readonly<{
  pathname: '/tasks' | '/workflows';
  currentCursor?: string;
  previousCursor?: string;
  nextCursor: string | null;
}>) {
  return <nav className="pagination" aria-label="列表分页" data-testid="pagination-controls">
    {currentCursor === undefined
      ? <span className="pagination-disabled">上一页</span>
      : <a className="secondary" href={previousCursor === undefined ? pathname : pageHref(pathname, previousCursor)}>上一页</a>}
    {nextCursor === null
      ? <span className="pagination-disabled">下一页</span>
      : <a className="secondary" data-testid="next-page" href={pageHref(pathname, nextCursor, currentCursor)}>下一页</a>}
  </nav>;
}

function WorkflowGraph({ workflow, task }: Readonly<{ workflow: WorkflowDetailProjection; task?: TaskSnapshot }>) {
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

function TaskInspector({ task }: Readonly<{ task: TaskSnapshot }>) {
  return <>
    <dl className="facts">
      <Fact label="Task" value={task.id} testId="inspector-task-id" />
      <Fact label="Conversation" value={task.conversationId} />
      <Fact label="WorkflowVersion" value={task.workflowVersion.id} testId="inspector-workflow-id" />
      <Fact label="Workflow hash" value={task.workflowVersion.hash} testId="inspector-workflow-hash" />
      <Fact label="Aggregate" value={task.aggregateVersion} />
      <Fact label="Event watermark" value={task.eventWatermark} />
    </dl>
    <SimulationNotice />
  </>;
}

export function TaskListPage() {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listTasks>>>();
  const location = listLocation();

  useEffect(() => {
    let active = true;
    void api.listTasks(location.cursor === undefined ? {} : { cursor: location.cursor }).then((value) => {
      if (!active) return;
      setResult(value);
      setState(value.tasks.length === 0 ? 'empty' : 'ready');
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('server-error');
    });
    return () => { active = false; };
  }, [location.cursor]);

  return <ProductShell active="tasks" title="我的任务" subtitle="小纬发起的任务、专家路线、审批与交付状态" state={state} inspector={result !== undefined ? <dl className="facts">
    <Fact label="Query version" value={result.queryVersion} />
    <Fact label="Snapshot as of" value={result.asOf} />
    <Fact label="下一页" value={result.nextCursor === null ? '无' : '可继续'} />
  </dl> : undefined}>
    {state === 'loading' && <LoadingState />}
    {state === 'server-error' && <ErrorState message={error} />}
    {state === 'empty' && <EmptyState kind="task" />}
    {state === 'ready' && result !== undefined && <section className="table-card">
      <div className="section-heading"><div><span className="eyebrow">Task authority</span><h2>任务列表</h2></div><span>{result.tasks.length} 条当前页记录</span></div>
      <div className="table-scroll"><table className="product-table" data-testid="task-table"><thead><tr><th>任务</th><th>状态</th><th>Workflow</th><th>审批</th><th>更新时间</th></tr></thead><tbody>
        {result.tasks.map((task) => <tr key={task.id} data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}>
          <td><a href={`/tasks/${encodeURIComponent(task.id)}`}><b>{task.title}</b><small>{task.id}</small></a></td>
          <td><span className={`status status-${task.status}`}>{task.status}</span></td>
          <td><a className="mono-link" href={`/tasks/${encodeURIComponent(task.id)}/workflow`}>{task.workflowVersion.id}<small>{task.workflowVersion.hash.slice(0, 12)}…</small></a></td>
          <td>{task.approvalStatus}</td>
          <td>{new Date(task.updatedAt).toLocaleString('zh-CN')}</td>
        </tr>)}
      </tbody></table></div>
      <PaginationControls
        pathname="/tasks"
        nextCursor={result.nextCursor}
        {...(location.cursor === undefined ? {} : { currentCursor: location.cursor })}
        {...(location.previous === undefined ? {} : { previousCursor: location.previous })}
      />
    </section>}
  </ProductShell>;
}

export function TaskDetailPage({ taskId }: Readonly<{ taskId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [task, setTask] = useState<TaskSnapshot>();
  const [acting, setActing] = useState(false);

  const loadTask = useCallback(async () => {
    const value = await api.getTask(taskId);
    setTask(value);
    setState('ready');
    return value;
  }, [taskId]);

  useEffect(() => {
    let active = true;
    void api.getTask(taskId).then((value) => { if (active) { setTask(value); setState('ready'); } }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState('server-error'); }
    });
    return () => { active = false; };
  }, [taskId]);

  const approveAndExecute = useCallback(async () => {
    if (task === undefined) return;
    setActing(true); setError('');
    try {
      if (task.status === 'awaiting_approval') await api.approve(task.approval.id);
      await api.execute(task.id);
      await loadTask();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setActing(false); }
  }, [loadTask, task]);

  const cancel = useCallback(async () => {
    if (task === undefined) return;
    setActing(true); setError('');
    try {
      await api.cancelTask(task.id);
      await loadTask();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setActing(false); }
  }, [loadTask, task]);

  return <ProductShell active="tasks" title="任务详情" subtitle="同一个任务的步骤、审批、证据与交付物" state={state} inspector={task === undefined ? undefined : <TaskInspector task={task} />}>
    {state === 'loading' && <LoadingState />}
    {state === 'server-error' && <ErrorState message={error} />}
    {task !== undefined && <div className="detail-stack" data-testid="task-detail" data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}>
      <section className="detail-hero"><div><span className="eyebrow">{task.capabilityId}</span><h2>{task.title}</h2><p>用户只看到小纬；执行时可由小纬调用指定专家或专家团。</p></div><span className={`status status-${task.status}`}>{task.status}</span></section>
      <section className="task-action-bar" aria-label="任务操作">
        <div><b>任务操作</b><p>审批和执行仍写入同一个 Control Plane 权威状态。</p></div>
        <div className="actions">
          {['awaiting_approval', 'approved'].includes(task.status) && <button className="primary" type="button" data-testid="task-approve-execute" disabled={acting} onClick={() => void approveAndExecute()}>{acting ? '正在提交…' : task.status === 'awaiting_approval' ? '批准并执行模拟任务' : '执行模拟任务'}</button>}
          {['queued', 'running'].includes(task.status) && <button className="secondary" type="button" data-testid="task-detail-cancel" disabled={acting} onClick={() => void cancel()}>{acting ? '正在取消…' : '取消模拟任务'}</button>}
        </div>
      </section>
      {error.length > 0 && <div className="error" role="alert">{error}</div>}
      <section className="binding-grid">
        <div><span>WorkflowVersion</span><a href={`/tasks/${encodeURIComponent(task.id)}/workflow`} data-testid="task-workflow-id">{task.workflowVersion.id}</a><code data-testid="task-workflow-hash">{task.workflowVersion.hash}</code></div>
        <div><span>ApprovalVersion</span><b>{task.approval.id} · v{task.approval.version}</b><code data-testid="approval-subject-digest">{task.approval.subjectDigest}</code></div>
        <div><span>专家路线</span><b data-testid="expert-target">{task.expertTarget.mode === 'auto' ? '小纬自动安排' : task.expertTarget.mode === 'team' ? `专家团 · ${task.expertTarget.teamId}` : `专家 · ${task.expertTarget.expertId}`}</b><small>专家不是客户消息作者</small></div>
      </section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Workflow run</span><h2>步骤时间线</h2></div><a href={`/tasks/${encodeURIComponent(task.id)}/workflow`}>查看流程图</a></div><ol className="step-timeline" data-testid="task-steps">
        {task.steps.map((step) => <li key={step.id} data-step-id={step.id} data-step-status={step.status}><span className={`step-dot step-${step.status}`} /><div><b>{STEP_NAMES[step.id] ?? step.id}</b><small>{step.id}</small></div><code>{step.status}</code></li>)}
      </ol></section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Claim–Evidence</span><h2>结论与证据</h2></div><span>{task.evidence.length} 条 Evidence</span></div>
        {task.claims.length === 0 ? <p className="muted-copy">任务尚未发布结论。</p> : task.claims.map((claim) => <article className={`claim ${claim.status}`} key={claim.id} data-claim-id={claim.id}><b>{claim.status === 'published' ? '已核验结论' : '未发布候选'}</b><p>{claim.text}</p><small>{claim.evidenceRefId ?? claim.rejectionCode}</small></article>)}
        <div className="evidence-grid">{task.evidence.map((evidence) => <article key={evidence.id} data-evidence-id={evidence.id}><span>Evidence</span><b>{evidence.id}</b><code>{evidence.excerptSha256}</code><small>{evidence.resourceScope} · {evidence.dataClass}</small></article>)}</div>
      </section>
      <section className="detail-card"><div className="section-heading"><div><span className="eyebrow">Artifact</span><h2>交付物</h2></div><span>{task.artifacts.length} 个文件</span></div>
        <div className="artifact-list">{task.artifacts.map((artifact) => <article key={artifact.id} data-artifact-id={artifact.id} data-content-sha256={artifact.contentSha256}><div><b>{artifact.displayName}</b><small>{artifact.kind} · {artifact.sizeBytes} bytes</small></div><code>{artifact.contentSha256}</code><a href={artifact.downloadUrl}>下载</a></article>)}</div>
      </section>
      {task.result !== null && <section className="detail-card result-summary" data-testid="task-result"><span className="eyebrow">Result</span><h2>{task.result.kind === 'completed' ? task.result.summary : task.result.message}</h2></section>}
    </div>}
  </ProductShell>;
}

export function TaskWorkflowPage({ taskId }: Readonly<{ taskId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [task, setTask] = useState<TaskSnapshot>();
  const [workflow, setWorkflow] = useState<WorkflowDetailProjection>();

  useEffect(() => {
    let active = true;
    void api.getTask(taskId).then(async (taskValue) => {
      const workflowValue = await api.getWorkflow(taskValue.workflowVersion.id);
      if (workflowValue.id !== taskValue.workflowVersion.id || workflowValue.hash !== taskValue.workflowVersion.hash) {
        throw new Error('WORKFLOW_BINDING_MISMATCH: 任务绑定与不可变 WorkflowVersion 不一致');
      }
      if (active) { setTask(taskValue); setWorkflow(workflowValue); setState('ready'); }
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState('server-error'); }
    });
    return () => { active = false; };
  }, [taskId]);

  return <ProductShell active="tasks" title="任务 Workflow" subtitle="不可变版本叠加当前任务步骤和审批摘要" state={state} inspector={task === undefined ? undefined : <>
    <TaskInspector task={task} />
    <dl className="facts"><Fact label="ApprovalSubject digest" value={task.approval.subjectDigest} testId="workflow-approval-digest" /></dl>
  </>}>
    {state === 'loading' && <LoadingState />}
    {state === 'server-error' && <ErrorState message={error} />}
    {task !== undefined && workflow !== undefined && <section className="workflow-page-card" data-testid="task-workflow" data-task-id={task.id}>
      <div className="section-heading"><div><span className="eyebrow">Task-scoped projection</span><h2>{workflow.id}</h2><code data-testid="workflow-hash">{workflow.hash}</code></div><a href={`/workflows/${encodeURIComponent(workflow.id)}`}>查看不可变版本</a></div>
      <WorkflowGraph workflow={workflow} task={task} />
    </section>}
  </ProductShell>;
}

export function WorkflowListPage() {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listWorkflows>>>();
  const location = listLocation();

  useEffect(() => {
    let active = true;
    void api.listWorkflows(location.cursor === undefined ? {} : { cursor: location.cursor }).then((value) => {
      if (active) { setResult(value); setState(value.workflows.length === 0 ? 'empty' : 'ready'); }
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState('server-error'); }
    });
    return () => { active = false; };
  }, [location.cursor]);

  return <ProductShell active="workflows" title="Workflow" subtitle="当前用户可见任务所引用的不可变流程版本" state={state} inspector={result !== undefined ? <dl className="facts"><Fact label="Query version" value={result.queryVersion} /><Fact label="Snapshot as of" value={result.asOf} /></dl> : undefined}>
    {state === 'loading' && <LoadingState />}
    {state === 'server-error' && <ErrorState message={error} />}
    {state === 'empty' && <EmptyState kind="workflow" />}
    {state === 'ready' && result !== undefined && <section className="table-card"><div className="section-heading"><div><span className="eyebrow">Immutable registry</span><h2>流程版本</h2></div><span>{result.workflows.length} 个版本</span></div><div className="table-scroll"><table className="product-table" data-testid="workflow-table"><thead><tr><th>WorkflowVersion</th><th>Capability</th><th>Harness</th><th>创建时间</th></tr></thead><tbody>
      {result.workflows.map((workflow) => <tr key={workflow.id} data-workflow-id={workflow.id} data-workflow-hash={workflow.hash}><td><a href={`/workflows/${encodeURIComponent(workflow.id)}`}><b>{workflow.id}</b><small>{workflow.hash}</small></a></td><td>{workflow.capabilityVersionId}</td><td>{workflow.harnessVersionId}</td><td>{new Date(workflow.createdAt).toLocaleString('zh-CN')}</td></tr>)}
    </tbody></table></div><PaginationControls
      pathname="/workflows"
      nextCursor={result.nextCursor}
      {...(location.cursor === undefined ? {} : { currentCursor: location.cursor })}
      {...(location.previous === undefined ? {} : { previousCursor: location.previous })}
    /></section>}
  </ProductShell>;
}

export function WorkflowDetailPage({ workflowId }: Readonly<{ workflowId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [workflow, setWorkflow] = useState<WorkflowDetailProjection>();

  useEffect(() => {
    let active = true;
    void api.getWorkflow(workflowId).then((value) => { if (active) { setWorkflow(value); setState('ready'); } }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState('server-error'); }
    });
    return () => { active = false; };
  }, [workflowId]);

  return <ProductShell active="workflows" title="WorkflowVersion" subtitle="只读、不可变、可校验的流程定义" state={state} inspector={workflow === undefined ? undefined : <dl className="facts">
    <Fact label="WorkflowVersion" value={workflow.id} testId="workflow-version-id" />
    <Fact label="Hash" value={workflow.hash} testId="workflow-version-hash" />
    <Fact label="Compiler" value={workflow.compilerVersion} />
    <Fact label="Canonicalization" value={workflow.canonicalizationVersion} />
    <Fact label="Feature set" value={workflow.featureSet} />
  </dl>}>
    {state === 'loading' && <LoadingState />}
    {state === 'server-error' && <ErrorState message={error} />}
    {workflow !== undefined && <section className="workflow-page-card" data-testid="workflow-detail" data-workflow-id={workflow.id} data-workflow-hash={workflow.hash}>
      <div className="section-heading"><div><span className="eyebrow">Immutable WorkflowVersion</span><h2>{workflow.id}</h2><code>{workflow.hash}</code></div><span>{workflow.nodes.length} 个节点</span></div>
      <WorkflowGraph workflow={workflow} />
      <div className="permission-strip"><span>动作上限 {workflow.permissionCeiling.actions.join(' / ')}</span><span>数据等级 {workflow.permissionCeiling.dataClasses.join(' / ')}</span><span>{workflow.permissionCeiling.resourceScopes.join(' / ')}</span></div>
    </section>}
  </ProductShell>;
}
