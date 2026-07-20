import { AssistantRuntimeProvider, ComposerPrimitive, type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { Dialog } from '@base-ui/react/dialog';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExpertTarget, TaskSnapshot } from '@geneway/contracts';
import { SimulationNotice, TaskProgress } from '@geneway/ui';
import { api, type Approval, type Conversation, type Fixture, type Workflow } from './api.js';

const STEP_NAMES: Readonly<Record<string, string>> = {
  document_ingest: '读取脱敏材料', requirement_extract: '提取需求', contradiction_check: '检查矛盾', solution_design: '生成方案',
  evidence_verify: '核验来源', result_quality_check: '检查结果质量', report_publish: '发布模拟结论',
};

const ROUTES: readonly Readonly<{ value: string; label: string; target: ExpertTarget }>[] = [
  { value: 'auto', label: '小纬自动安排', target: { mode: 'auto' } },
  { value: 'expert.solution.architect', label: '方案专家', target: { mode: 'expert', expertId: 'expert.solution.architect' } },
  { value: 'team.solution.core', label: '方案专家团', target: { mode: 'team', teamId: 'team.solution.core' } },
];

function textOfAppendMessage(message: AppendMessage): string {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

const convertConversationMessage = (message: Conversation['messages'][number]): ThreadMessageLike => ({
  id: message.id,
  role: message.author === 'xiaowei' ? 'assistant' : 'user',
  content: [{ type: 'text', text: message.body }],
});

export function App() {
  const capabilityOpen = new URLSearchParams(window.location.search).get('capability') === 'solution.analysis.v1';
  const [route, setRoute] = useState('auto');
  const [conversation, setConversation] = useState<Conversation>();
  const [task, setTask] = useState<TaskSnapshot>();
  const [workflow, setWorkflow] = useState<Workflow>();
  const [approval, setApproval] = useState<Approval>();
  const [fixture, setFixture] = useState<Fixture>();
  const [cursor, setCursor] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [workflowOpen, setWorkflowOpen] = useState(true);

  const recover = useCallback(async (taskId: string, knownCursor: number) => {
    let snapshot = await api.getTask(taskId);
    const events = await api.events(taskId, knownCursor);
    const streamCursor = events.reduce((highest, event) => Math.max(highest, event.cursor ?? 0), knownCursor);
    if (streamCursor > snapshot.eventWatermark) {
      snapshot = await api.getTask(taskId);
    }
    const [conversationSnapshot, workflowVersion, approvalVersion] = await Promise.all([
      api.getConversation(snapshot.conversationId), api.getWorkflow(snapshot.workflowVersion.id), api.getApproval(snapshot.approval.id),
    ]);
    const nextCursor = Math.max(streamCursor, snapshot.eventWatermark);
    const restoredRoute = snapshot.expertTarget.mode === 'expert' ? snapshot.expertTarget.expertId
      : snapshot.expertTarget.mode === 'team' ? snapshot.expertTarget.teamId : 'auto';
    setRoute(restoredRoute);
    setTask(snapshot); setConversation(conversationSnapshot); setWorkflow(workflowVersion); setApproval(approvalVersion); setCursor(nextCursor);
    localStorage.setItem('geneway.gate01.taskId', taskId);
    localStorage.setItem('geneway.gate01.cursor', String(nextCursor));
    return { snapshot, cursor: nextCursor };
  }, []);

  useEffect(() => {
    if (!capabilityOpen) return;
    void api.getFixture().then(setFixture).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    const taskId = localStorage.getItem('geneway.gate01.taskId');
    if (taskId === null) return;
    const saved = Number(localStorage.getItem('geneway.gate01.cursor') ?? 0);
    void recover(taskId, Number.isSafeInteger(saved) ? saved : 0).catch(() => {
      localStorage.removeItem('geneway.gate01.taskId');
      localStorage.removeItem('geneway.gate01.cursor');
    });
  }, [capabilityOpen, recover]);

  const create = useCallback(async (body: string) => {
    if (!capabilityOpen) throw new Error('NOT_OPEN: Capability is not open in Gate 0.1');
    setWorking(true); setError(undefined);
    try {
      const conversationId = conversation?.id ?? (await api.createConversation()).id;
      await api.addMessage(conversationId, body || '请分析预置的脱敏方案材料');
      const target = ROUTES.find((item) => item.value === route)?.target ?? { mode: 'auto' as const };
      const created = await api.createTask(conversationId, target);
      await recover(created.taskId, 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  }, [capabilityOpen, conversation?.id, recover, route]);

  const runtime = useExternalStoreRuntime({
    messages: conversation?.messages ?? [],
    convertMessage: convertConversationMessage,
    isRunning: working,
    isSendDisabled: task !== undefined || working,
    onNew: async (message) => create(textOfAppendMessage(message)),
  });

  const approveAndRun = async () => {
    if (task === undefined || approval === undefined) return;
    setWorking(true); setError(undefined);
    try {
      if (approval.status === 'pending') await api.approve(approval.id);
      const approved = await recover(task.id, cursor);
      await api.execute(task.id);
      let currentCursor = approved.cursor;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const current = await recover(task.id, currentCursor);
        currentCursor = current.cursor;
        if (['completed', 'failed', 'rejected'].includes(current.snapshot.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };

  const graph = useMemo(() => {
    if (workflow === undefined) return { nodes: [] as Node[], edges: [] as Edge[] };
    const status = new Map(task?.steps.map((step) => [step.id, step.status]) ?? []);
    return {
      nodes: workflow.payload.nodes.map((node, index): Node => ({
        id: node.id, position: { x: index * 190, y: index % 2 === 0 ? 20 : 125 }, data: { label: STEP_NAMES[node.id] ?? node.id },
        className: `flow-node flow-node-${status.get(node.id) ?? 'queued'}`, draggable: false, selectable: true,
      })),
      edges: workflow.payload.edges.map((edge): Edge => ({ id: `${edge.from}-${edge.to}`, source: edge.from, target: edge.to, animated: status.get(edge.to) === 'running' })),
    };
  }, [task?.steps, workflow]);

  const completed = task?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const published = task?.claims.find((claim) => claim.status === 'published');
  const rejected = task?.claims.find((claim) => claim.status === 'rejected');
  const evidence = task?.evidence.find((item) => item.id === published?.evidenceRefId);

  if (!capabilityOpen) return <main className="not-open" data-testid="not-open"><span>NOT_OPEN</span><h1>该能力尚未开放</h1><p>Gate 0.1 只允许 solution.analysis.v1。</p></main>;

  return <AssistantRuntimeProvider runtime={runtime}>
    <main className="app-shell" data-testid="geneway-app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
        <button className="new-task" onClick={() => { localStorage.clear(); location.reload(); }}>＋ 新建会话</button>
        <nav><b>今天</b><button className="nav-active">方案分析</button><button disabled>生产日报 · 后续开放</button></nav>
        <section className="operations-preview" aria-label="制造业状态入口">
          <h3>现场动态</h3>
          <button disabled><span className="signal danger" />设备异常待处理<small>后续 Gate 开放</small></button>
          <button disabled><span className="signal warning" />产能进度落后<small>后续 Gate 开放</small></button>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="topbar"><div><h1>小纬</h1><p>通用数字员工 · 由小纬统一组织专家能力</p></div><SimulationNotice /></header>
        <div className="thread" data-testid="message-thread">
          {conversation === undefined && <section className="welcome-empty" data-testid="welcome-empty"><div className="avatar">纬</div><div><b>你好，我是小纬</b><p>选择预置材料和专家路线后，我会先展示固定 Workflow，获得你的批准才执行。</p></div></section>}
          {conversation?.messages.map((message) => <article className={`message ${message.author}`} key={message.id} data-author={message.author}>
            <div className="avatar">{message.author === 'xiaowei' ? '纬' : '你'}</div><div><b>{message.author === 'xiaowei' ? '小纬' : '你'}</b><p>{message.body}</p></div>
          </article>)}
          <section className="fixture-card" data-testid="fixture-card"><span className="eyebrow">已选择 · 预置 · 只读 · 脱敏</span><h2>{fixture?.name ?? '正在读取预置材料…'}</h2><p>{fixture?.description ?? '只从 Control Plane 读取版本固定的模拟材料。'}</p>{fixture !== undefined && <small>fixture v{fixture.version} · {fixture.ref}</small>}</section>
          {task !== undefined && <section className="task-card" data-testid="task-card" data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}>
            <div className="task-title"><div><span className="eyebrow">小纬任务 · simulation=true</span><h2>方案分析流程</h2></div><span className={`status status-${task.status}`}>{task.status}</span></div>
            <p>本次路线：{ROUTES.find((item) => item.value === route)?.label ?? task.expertTarget.mode}。专家能力在后台协作，客户消息仍只由小纬发出。</p>
            <TaskProgress completed={completed} total={7} /><p className="progress-copy">已完成 {completed} / 7 个步骤</p>
            <div className="version-strip"><code>{task.workflowVersion.id}</code><code title={task.workflowVersion.hash}>{task.workflowVersion.hash.slice(0, 16)}…</code><span>SSE cursor {cursor}</span></div>
            <div className="actions"><button className="secondary" onClick={() => setWorkflowOpen(true)}>查看 Workflow</button>{task.status === 'awaiting_approval' && <button className="primary" disabled={working} onClick={() => void approveAndRun()}>批准并运行模拟任务</button>}</div>
          </section>}
          {task?.status === 'completed' && <section className="result-card" data-testid="result-card">
            <span className="eyebrow">小纬结论 · 模拟结果 · 不可用于业务决策</span><h2>方案分析完成</h2>
            {published !== undefined && <div className="claim published" data-testid="published-claim"><b>已核验结论</b><p>{published.text}</p>{evidence !== undefined && <blockquote><span>来源片段</span>{evidence.excerpt}<code>{evidence.sourceHash}</code></blockquote>}</div>}
            {rejected !== undefined && <div className="claim rejected" data-testid="rejected-claim"><b>未发布候选</b><p>{rejected.text}</p><small>缺少可访问来源，已由 Evidence publish guard 拒绝。</small></div>}
          </section>}
          {error !== undefined && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="composer-zone">
          <div className="composer-tools"><label>专家路线<select aria-label="专家路线" value={route} disabled={task !== undefined || working} onChange={(event) => setRoute(event.target.value)}>{ROUTES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><span>仅使用预置材料 · 不支持上传</span></div>
          <ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input aria-label="给小纬发消息" placeholder="请小纬分析这份脱敏材料…" disabled={task !== undefined || working} /><ComposerPrimitive.Send className="send" disabled={task !== undefined || working}>{working ? '处理中' : '发送'}</ComposerPrimitive.Send></ComposerPrimitive.Root>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-head"><span>任务检查器</span><button onClick={() => setWorkflowOpen((value) => !value)}>{workflowOpen ? '收起' : '展开'}</button></div>
        {task === undefined ? <div className="empty-inspector"><span>◇</span><p>发送问题后，这里会显示 Workflow、审批、证据和安全边界。</p></div> : <>
          <dl className="facts"><div><dt>Task</dt><dd data-testid="task-id">{task.id}</dd></div><div><dt>Approval</dt><dd data-testid="approval-id">{task.approval.id}</dd></div><div><dt>状态</dt><dd>{task.status}</dd></div><div><dt>事件游标</dt><dd data-testid="sse-cursor">{cursor}</dd></div></dl>
          <SimulationNotice />
          <Dialog.Root open={workflowOpen} onOpenChange={setWorkflowOpen}><Dialog.Trigger className="secondary">打开流程图</Dialog.Trigger><Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="workflow-dialog"><Dialog.Title>固定 Workflow</Dialog.Title><Dialog.Description>只读图来自 Control Plane 中不可变 WorkflowVersion；审批与 Interpreter 使用同一 id + hash。</Dialog.Description><div className="workflow-meta"><code data-testid="workflow-id">{workflow?.id}</code><code data-testid="workflow-hash">{workflow?.hash}</code></div><div className="flow-wrap" data-testid="workflow-graph"><ReactFlow nodes={graph.nodes} edges={graph.edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable><Background /><Controls showInteractive={false} /></ReactFlow></div><Dialog.Close className="primary">关闭</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root>
        </>}
      </aside>
    </main>
  </AssistantRuntimeProvider>;
}
