import { AssistantRuntimeProvider, ComposerPrimitive, type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { Dialog } from '@base-ui/react/dialog';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSnapshotProjection, EvidenceProjection, ExpertTarget, TaskSnapshot } from '@geneway/contracts';
import { SimulationNotice, TaskProgress } from '@geneway/ui';
import { api, type Approval, type Conversation, type Workflow } from './api.js';
import { FastChatExperience } from './chat-app.js';

const STEP_NAMES: Readonly<Record<string, string>> = {
  document_ingest: '读取脱敏材料', requirement_extract: '提取需求', contradiction_check: '检查矛盾', solution_design: '生成方案',
  evidence_verify: '核验来源', result_quality_check: '检查结果质量', report_publish: '发布模拟结论',
};

const ROUTES: readonly Readonly<{ value: string; label: string; target: ExpertTarget }>[] = [
  { value: 'auto', label: '小纬自动安排', target: { mode: 'auto' } },
  { value: 'expert.solution.architect', label: '方案专家', target: { mode: 'expert', expertId: 'expert.solution.architect' } },
  { value: 'team.solution.core', label: '方案专家团', target: { mode: 'team', teamId: 'team.solution.core' } },
];

const TASK_ID_KEY = 'geneway.gate02a.taskId';
const TASK_CURSOR_KEY = 'geneway.gate02a.cursor';

let conversationBootstrap: Promise<Conversation> | undefined;

async function ensureConversation(explicitConversationId?: string): Promise<Conversation> {
  if (explicitConversationId !== undefined) return api.getConversation(explicitConversationId);
  const storedId = localStorage.getItem('geneway.conversationId');
  if (storedId !== null) {
    try { return await api.getConversation(storedId); } catch { localStorage.removeItem('geneway.conversationId'); }
  }
  conversationBootstrap ??= api.createConversation().then(async ({ id }) => {
    localStorage.setItem('geneway.conversationId', id);
    return api.getConversation(id);
  }).finally(() => { conversationBootstrap = undefined; });
  return conversationBootstrap;
}

function textOfAppendMessage(message: AppendMessage): string {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

const convertConversationMessage = (message: Conversation['messages'][number]): ThreadMessageLike => ({
  id: message.id,
  role: message.author === 'xiaowei' ? 'assistant' : 'user',
  content: [{ type: 'text', text: message.body }],
});

export function ConversationExperience({ conversationId: explicitConversationId, forceOpen = false }: Readonly<{ conversationId?: string; forceOpen?: boolean }>) {
  const selectedCapability = new URLSearchParams(window.location.search).get('capability');
  if (selectedCapability !== 'solution.analysis.v1' && !forceOpen) {
    return <FastChatExperience {...(explicitConversationId === undefined ? {} : { conversationId: explicitConversationId })} />;
  }
  const capabilityOpen = selectedCapability === 'solution.analysis.v1' || forceOpen;
  const [route, setRoute] = useState('auto');
  const [conversation, setConversation] = useState<Conversation>();
  const [task, setTask] = useState<TaskSnapshot>();
  const [workflow, setWorkflow] = useState<Workflow>();
  const [approval, setApproval] = useState<Approval>();
  const [documentSnapshots, setDocumentSnapshots] = useState<readonly DocumentSnapshotProjection[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>();
  const [snapshotReadUnavailable, setSnapshotReadUnavailable] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [working, setWorking] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [workflowOpen, setWorkflowOpen] = useState(true);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const [evidenceDetail, setEvidenceDetail] = useState<EvidenceProjection>();
  const latestTaskSnapshot = useRef<TaskSnapshot | undefined>(undefined);

  const loadDocumentSnapshots = useCallback(async (conversationId: string) => {
    try {
      const listed = await api.getDocumentSnapshots(conversationId);
      setDocumentSnapshots(listed.documentSnapshots);
      setSelectedSnapshotId((currentId) => listed.documentSnapshots.some((projection) =>
        projection.documentSnapshot.id === currentId && projection.executionEligibility.eligible) ? currentId : undefined);
      setSnapshotReadUnavailable(false);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('ARTIFACT_NOT_FOUND:')) {
        setDocumentSnapshots([]);
        setSelectedSnapshotId(undefined);
        setSnapshotReadUnavailable(true);
        return;
      }
      throw cause;
    }
  }, []);

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
    const latest = latestTaskSnapshot.current;
    if (latest?.id === taskId && latest.aggregateVersion > snapshot.aggregateVersion) snapshot = latest;
    else latestTaskSnapshot.current = snapshot;
    const nextCursor = Math.max(streamCursor, snapshot.eventWatermark);
    const restoredRoute = snapshot.expertTarget.mode === 'expert' ? snapshot.expertTarget.expertId
      : snapshot.expertTarget.mode === 'team' ? snapshot.expertTarget.teamId : 'auto';
    setRoute(restoredRoute);
    if (snapshot.inputRef.kind === 'document_snapshot') setSelectedSnapshotId(snapshot.inputRef.documentSnapshotId);
    setTask(snapshot); setConversation(conversationSnapshot); setWorkflow(workflowVersion); setApproval(approvalVersion); setCursor(nextCursor);
    localStorage.setItem('geneway.conversationId', snapshot.conversationId);
    localStorage.setItem(TASK_ID_KEY, taskId);
    localStorage.setItem(TASK_CURSOR_KEY, String(nextCursor));
    return { snapshot, cursor: nextCursor };
  }, []);

  useEffect(() => {
    if (!capabilityOpen) return;
    if (explicitConversationId !== undefined) {
      void ensureConversation(explicitConversationId).then(async (current) => {
        setConversation(current);
        await loadDocumentSnapshots(current.id);
        if (current.latestTaskId !== null) await recover(current.latestTaskId, 0);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    const taskId = localStorage.getItem(TASK_ID_KEY);
    if (taskId !== null) {
      const saved = Number(localStorage.getItem(TASK_CURSOR_KEY) ?? 0);
      void recover(taskId, Number.isSafeInteger(saved) ? saved : 0).then(async ({ snapshot }) => {
        await loadDocumentSnapshots(snapshot.conversationId);
        if (snapshot.inputRef.kind === 'document_snapshot') setSelectedSnapshotId(snapshot.inputRef.documentSnapshotId);
      }).catch(() => {
        localStorage.removeItem(TASK_ID_KEY);
        localStorage.removeItem(TASK_CURSOR_KEY);
      });
      return;
    }
    void ensureConversation().then(async (current) => {
      setConversation(current);
      await loadDocumentSnapshots(current.id);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [capabilityOpen, explicitConversationId, loadDocumentSnapshots, recover]);

  const uploadArtifact = useCallback(async (file: File) => {
    setUploading(true); setError(undefined);
    try {
      const current = conversation ?? await ensureConversation(explicitConversationId);
      setConversation(current);
      await api.uploadArtifact(current.id, file);
      await loadDocumentSnapshots(current.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(false); }
  }, [conversation, explicitConversationId, loadDocumentSnapshots]);

  const create = useCallback(async (body: string) => {
    setWorking(true); setError(undefined);
    try {
      if (!capabilityOpen) throw new Error('NOT_OPEN: 当前能力尚未开放');
      const selected = documentSnapshots.find((projection) => projection.documentSnapshot.id === selectedSnapshotId);
      if (selected === undefined || !selected.executionEligibility.eligible) {
        throw new Error('DOCUMENT_SNAPSHOT_REQUIRED: 请先明确选择一份已匹配演示 Profile 的材料');
      }
      const current = conversation ?? await ensureConversation(explicitConversationId);
      setConversation(current);
      const conversationId = current.id;
      await api.addMessage(conversationId, body || '请分析已选择的脱敏方案材料');
      const target = ROUTES.find((item) => item.value === route)?.target ?? { mode: 'auto' as const };
      const created = await api.createTask(conversationId, selected.documentSnapshot.id, target);
      latestTaskSnapshot.current = undefined;
      await recover(created.taskId, 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  }, [capabilityOpen, conversation, documentSnapshots, explicitConversationId, recover, route, selectedSnapshotId]);

  const selectedSnapshot = useMemo(() => documentSnapshots.find((projection) =>
    projection.documentSnapshot.id === selectedSnapshotId && projection.executionEligibility.eligible), [documentSnapshots, selectedSnapshotId]);

  const runtime = useExternalStoreRuntime({
    messages: conversation?.messages ?? [],
    convertMessage: convertConversationMessage,
    isRunning: working,
    isSendDisabled: task !== undefined || working || selectedSnapshot === undefined,
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
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const current = await recover(task.id, currentCursor);
        currentCursor = current.cursor;
        if (['completed', 'failed', 'rejected', 'canceled'].includes(current.snapshot.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };

  const cancelTask = async () => {
    if (task === undefined || !['queued', 'running'].includes(task.status) || canceling) return;
    setCanceling(true); setError(undefined);
    try {
      await api.cancelTask(task.id);
      await recover(task.id, cursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCanceling(false); }
  };

  const graph = useMemo(() => {
    if (workflow === undefined) return { nodes: [] as Node[], edges: [] as Edge[] };
    const status = new Map(task?.steps.map((step) => [step.id, step.status]) ?? []);
    return {
      nodes: workflow.nodes.map((node, index): Node => ({
        id: node.id, position: { x: index * 190, y: index % 2 === 0 ? 20 : 125 }, data: { label: STEP_NAMES[node.id] ?? node.id },
        className: `flow-node flow-node-${status.get(node.id) ?? 'queued'}`, draggable: false, selectable: true,
      })),
      edges: workflow.edges.map((edge): Edge => ({ id: `${edge.from}-${edge.to}`, source: edge.from, target: edge.to, animated: status.get(edge.to) === 'running' })),
    };
  }, [task?.steps, workflow]);

  const completed = task?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const published = task?.claims.find((claim) => claim.status === 'published');
  const rejected = task?.claims.find((claim) => claim.status === 'rejected');
  const evidence = task?.evidence.find((item) => item.id === published?.evidenceRefId);
  const selectedEvidence = task?.evidence.find((item) => item.id === selectedEvidenceId) ?? task?.evidence[0];
  const displayedEvidence = evidenceDetail?.id === selectedEvidence?.id ? evidenceDetail : selectedEvidence;
  const evidenceLineage = task?.lineage.filter((item) => displayedEvidence?.lineageRecordIds.includes(item.id)) ?? [];
  const reportArtifacts = task?.artifacts.filter((artifact) => artifact.kind === 'simulation_report') ?? [];
  const taskDocumentSnapshotId = task?.inputRef.kind === 'document_snapshot' ? task.inputRef.documentSnapshotId : undefined;
  const taskSourceProjection = documentSnapshots.find((projection) => projection.documentSnapshot.id === taskDocumentSnapshotId);
  const evidenceDocumentSnapshotId = displayedEvidence?.source.kind === 'document_snapshot' ? displayedEvidence.source.documentSnapshotId : undefined;
  const evidenceSourceProjection = documentSnapshots.find((projection) => projection.documentSnapshot.id === evidenceDocumentSnapshotId);

  const openEvidence = (evidenceId?: string | null) => {
    const targetId = evidenceId ?? task?.evidence[0]?.id;
    setSelectedEvidenceId(targetId);
    setEvidenceDetail(undefined);
    setEvidenceOpen(true);
    if (targetId !== undefined) {
      void api.getEvidence(targetId).then(setEvidenceDetail).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
  };

  if (!capabilityOpen) return <main className="not-open" data-testid="not-open"><span>NOT_OPEN</span><h1>该能力尚未开放</h1><p>当前仅开放方案分析能力。</p></main>;

  return <AssistantRuntimeProvider runtime={runtime}>
    <main className="app-shell" data-testid="geneway-app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
        <a className="new-task" href="/conversations/new?capability=solution.analysis.v1" onClick={() => localStorage.clear()}>＋ 新建会话</a>
        <nav><b>工作区</b><a className="nav-active" href="/conversations/new?capability=solution.analysis.v1">小纬</a><a href="/tasks">我的任务</a><a href="/workflows">Workflow</a><span>生产日报 · 即将开放</span></nav>
        <section className="operations-preview" aria-label="制造业状态入口">
          <h3>现场动态</h3>
          <button disabled><span className="signal danger" />设备异常待处理<small>即将开放</small></button>
          <button disabled><span className="signal warning" />产能进度落后<small>即将开放</small></button>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="topbar"><div><h1>小纬</h1><p>通用数字员工 · 当前为模拟运行</p></div><SimulationNotice /></header>
        <div className="thread" data-testid="message-thread">
          {(conversation?.messages.length ?? 0) === 0 && <section className="welcome-empty" data-testid="welcome-empty"><div className="avatar">纬</div><div><b>你好，我是小纬</b><p>请上传并明确选择一份只读材料，也可以指定专家或专家团。任何 Workflow 都会先展示并等待批准。</p></div></section>}
          {conversation?.messages.map((message) => <article className={`message ${message.author}`} key={message.id} data-author={message.author}>
            <div className="avatar">{message.author === 'xiaowei' ? '纬' : '你'}</div><div><b>{message.author === 'xiaowei' ? '小纬' : '你'}</b><p>{message.body}</p></div>
          </article>)}
          <section className="upload-card" data-testid="artifact-upload-card">
            <div><span className="eyebrow">私有材料库</span><h2>上传分析材料</h2><p>仅接收不超过 1 MiB 的 UTF-8 .txt / .md。上传后请明确选择一份已匹配 Profile 的材料。</p></div>
            <label className={`upload-action${uploading ? ' disabled' : ''}`}>
              {uploading ? '正在校验…' : '选择文件'}
              <input data-testid="artifact-upload-input" aria-label="上传分析材料" type="file" accept=".txt,text/plain,.md,text/markdown" disabled={uploading} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void uploadArtifact(file);
                event.target.value = '';
              }} />
            </label>
          </section>
          {snapshotReadUnavailable && <section className="artifact-card artifact-card-unavailable" data-testid="artifact-unavailable-card">
            <div className="artifact-title"><div><span className="eyebrow">安全降级</span><h2>材料对象不可用或完整性异常</h2></div><span className="integrity-badge integrity-badge-error">不可用</span></div>
            <p>已隐藏材料名称、标识和摘要。下载与模拟任务均已禁用，请等待管理员完成存储对账。</p>
          </section>}
          {documentSnapshots.map((projection) => { const snapshot = projection.documentSnapshot; const eligible = projection.executionEligibility.eligible; const selected = eligible && selectedSnapshotId === snapshot.id; return <section className={`artifact-card${selected ? ' artifact-card-selected' : ''}${eligible ? '' : ' artifact-card-ineligible'}`} key={snapshot.id} data-testid="artifact-card"
            data-artifact-id={snapshot.artifactId} data-manifest-id={snapshot.manifestId} data-snapshot-id={snapshot.id} data-content-sha256={snapshot.contentSha256}>
            <div className="artifact-title"><div><span className="eyebrow">已校验 · 私有 · C1 · untrusted_text</span><h2>{snapshot.displayName}</h2></div><span className={`integrity-badge${eligible ? '' : ' integrity-badge-muted'}`}>{selected ? '已选择' : eligible ? '可执行' : '仅存储'}</span></div>
            <dl className="artifact-facts"><div><dt>大小</dt><dd data-testid="artifact-size">{snapshot.sizeBytes} bytes</dd></div><div><dt>类型</dt><dd>{snapshot.mediaType}</dd></div><div><dt>Snapshot</dt><dd>{snapshot.id}</dd></div></dl>
            <code className="artifact-hash" data-testid="artifact-hash">sha256:{snapshot.contentSha256}</code>
            <div className="artifact-profile"><span>Profile</span><code>{snapshot.simulationProfile ?? '未匹配'}</code></div>
            <div className="artifact-actions">
              {projection.artifactState.downloadAllowed ? <a data-testid="artifact-download" href={projection.downloadUrl}>下载原件</a> : <span>原件下载已禁用</span>}
              <span data-testid="artifact-eligibility">{eligible ? '已匹配演示 Profile，可用于模拟分析' : '仅保存原件，当前模拟分析不可运行'}</span>
              <button className={selected ? 'snapshot-select snapshot-select-selected' : 'snapshot-select'} type="button" disabled={!eligible || task !== undefined || working} aria-pressed={selected} onClick={() => setSelectedSnapshotId(snapshot.id)}>
                {selected ? '已选择用于本次任务' : eligible ? '选择用于分析' : '不可执行'}
              </button>
            </div>
          </section>; })}
          {task !== undefined && <section className="task-card" data-testid="task-card" data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}>
            <div className="task-title"><div><span className="eyebrow">小纬任务 · simulation=true</span><h2>方案分析流程</h2></div><span className={`status status-${task.status}`}>{task.status}</span></div>
            <p>本次仅记录路线：{ROUTES.find((item) => item.value === route)?.label ?? task.expertTarget.mode}。本次由统一模拟 Runtime 执行，未调用真实专家；客户消息仍只由小纬发出。</p>
            <dl className="task-bindings">
              <div><dt>Snapshot</dt><dd>{task.inputRef.kind === 'document_snapshot' ? task.inputRef.documentSnapshotId : task.inputRef.fixtureRef}</dd></div>
              <div><dt>Profile</dt><dd>{task.inputRef.kind === 'document_snapshot' ? task.inputRef.simulationProfile : 'legacy fixture'}</dd></div>
              <div><dt>Workflow</dt><dd>{task.workflowVersion.id}</dd></div>
              <div><dt>运行边界</dt><dd>simulation={String(task.simulation)} · runtimeMode={task.runtimeMode} · businessDecisionAllowed={String(task.businessDecisionAllowed)}</dd></div>
            </dl>
            <TaskProgress completed={completed} total={7} /><p className="progress-copy">已完成 {completed} / 7 个步骤</p>
            <div className="version-strip"><code>{task.workflowVersion.id}</code><code title={task.workflowVersion.hash}>{task.workflowVersion.hash.slice(0, 16)}…</code><span>SSE cursor {cursor}</span></div>
            <div className="actions">
              <button className="secondary" onClick={() => setWorkflowOpen(true)}>查看 Workflow</button>
              {task.status === 'awaiting_approval' && <button className="primary" disabled={working} onClick={() => void approveAndRun()}>批准并运行模拟任务</button>}
              {task.status !== 'awaiting_approval' && <button className="secondary" type="button" data-testid="cancel-task-button"
                disabled={!['queued', 'running'].includes(task.status) || canceling} onClick={() => void cancelTask()}>{canceling ? '正在取消…' : '取消模拟任务'}</button>}
            </div>
          </section>}
          {task?.status === 'canceled' && <section className="result-card" data-testid="canceled-task-state">
            <span className="eyebrow">小纬任务 · 已停止</span><h2>模拟任务已取消</h2><p>不会发布 Claim 或模拟报告。刷新页面后仍可查看该终态。</p>
          </section>}
          {task?.status === 'completed' && <section className="result-card" data-testid="result-card">
            <span className="eyebrow">小纬结论 · 模拟结果 · 不可用于业务决策</span><h2>方案分析完成</h2>
            {published !== undefined && <div className="claim published" data-testid="published-claim"><b>已核验结论</b><p>{published.text}</p>{evidence !== undefined && <div className="claim-evidence" data-evidence-id={evidence.id}><span>已绑定 Evidence · {evidence.id}</span><button className="secondary" type="button" onClick={() => openEvidence(evidence.id)}>查看证据</button></div>}</div>}
            {rejected !== undefined && <div className="claim rejected" data-testid="rejected-claim"><b>未发布候选</b><p>{rejected.text}</p><small>缺少可访问来源，已由 Evidence publish guard 拒绝。</small></div>}
          </section>}
          {task !== undefined && <section className="delivery-card" data-testid="task-deliveries">
            <div className="delivery-head"><div><span className="eyebrow">任务材料与交付物</span><h2>Artifact</h2></div>{task.evidence.length > 0 && <button className="secondary" type="button" onClick={() => openEvidence()}>Evidence {task.evidence.length}</button>}</div>
            {task.inputRef.kind === 'document_snapshot' && <article className="delivery-item" data-testid="source-artifact-item">
              <div><b>{taskSourceProjection?.documentSnapshot.displayName ?? '任务输入原件'}</b><span>source_document · {task.inputRef.artifactId}</span></div>
              <code>sha256:{task.inputRef.contentSha256}</code>
              {taskSourceProjection?.artifactState.downloadAllowed === true
                ? <a href={taskSourceProjection.downloadUrl}>下载原件</a>
                : <span className="delivery-unavailable">原件下载信息当前不可用</span>}
            </article>}
            {reportArtifacts.map((artifact) => <article className="delivery-item" key={artifact.id} data-testid="report-artifact-item" data-artifact-id={artifact.id} data-content-sha256={artifact.contentSha256}>
              <div><b>{artifact.displayName}</b><span>{artifact.kind} · {artifact.sizeBytes} bytes</span></div>
              <code>sha256:{artifact.contentSha256}</code>
              <a href={artifact.downloadUrl}>下载模拟报告</a>
            </article>)}
            {reportArtifacts.length === 0 && <p className="delivery-empty">模拟报告将在任务完成并通过发布守卫后出现。</p>}
            <small>Lineage records: {task.lineage.length}</small>
          </section>}
          {error !== undefined && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="composer-zone">
          <div className="composer-tools"><label>专家路线<select aria-label="专家路线" value={route} disabled={task !== undefined || working} onChange={(event) => setRoute(event.target.value)}>{ROUTES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><span>{selectedSnapshot === undefined ? '请先选择一份可执行材料' : `已选：${selectedSnapshot.documentSnapshot.displayName} · 执行前仍需审批`}</span></div>
          <ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input aria-label="给小纬发消息" placeholder={selectedSnapshot === undefined ? '请先在上方选择可执行材料' : '请小纬分析这份脱敏材料…'} disabled={task !== undefined || working || selectedSnapshot === undefined} /><ComposerPrimitive.Send className="send" disabled={task !== undefined || working || selectedSnapshot === undefined}>{working ? '处理中' : '发送'}</ComposerPrimitive.Send></ComposerPrimitive.Root>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-head"><span>任务检查器</span><button onClick={() => setWorkflowOpen((value) => !value)}>{workflowOpen ? '收起' : '展开'}</button></div>
        {task === undefined && snapshotReadUnavailable ? <div className="snapshot-inspector" data-testid="snapshot-unavailable-inspector"><span className="eyebrow">材料权威状态</span><h2>对象不可用 / 完整性异常</h2><p>敏感元数据已隐藏，下载与执行已禁用。</p></div> : task === undefined && documentSnapshots.length === 0 ? <div className="empty-inspector"><span>◇</span><p>上传材料或发送问题后，这里会显示存储校验、Workflow、审批、证据和安全边界。</p></div> : task === undefined ? <div className="snapshot-inspector" data-testid="snapshot-inspector"><span className="eyebrow">材料权威状态</span><h2>{documentSnapshots.length} 份已校验材料</h2>{documentSnapshots.map(({ documentSnapshot: snapshot, artifactState }) => <dl className="facts" key={snapshot.id}><div><dt>Artifact</dt><dd>{snapshot.artifactId}</dd></div><div><dt>Manifest</dt><dd>{snapshot.manifestId}</dd></div><div><dt>Snapshot</dt><dd>{snapshot.id}</dd></div><div><dt>Integrity</dt><dd>{artifactState.integrity}</dd></div></dl>)}</div> : <>
          <dl className="facts"><div><dt>Task</dt><dd data-testid="task-id">{task.id}</dd></div><div><dt>Approval</dt><dd data-testid="approval-id">{task.approval.id}</dd></div><div><dt>Approval digest</dt><dd data-testid="conversation-approval-digest">{task.approval.subjectDigest}</dd></div><div><dt>输入</dt><dd>{task.inputRef.kind === 'document_snapshot' ? task.inputRef.documentSnapshotId : task.inputRef.fixtureRef}</dd></div><div><dt>Profile</dt><dd>{task.inputRef.kind === 'document_snapshot' ? task.inputRef.simulationProfile : 'legacy fixture'}</dd></div><div><dt>状态</dt><dd>{task.status}</dd></div><div><dt>事件游标</dt><dd data-testid="sse-cursor">{cursor}</dd></div></dl>
          <SimulationNotice />
          <Dialog.Root open={workflowOpen} onOpenChange={setWorkflowOpen}><Dialog.Trigger className="secondary">打开流程图</Dialog.Trigger><Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="workflow-dialog"><Dialog.Title>固定 Workflow</Dialog.Title><Dialog.Description>只读图来自 Control Plane 中不可变 WorkflowVersion；审批与 Interpreter 使用同一 id + hash。</Dialog.Description><div className="workflow-meta"><code data-testid="workflow-id">{workflow?.id}</code><code data-testid="workflow-hash">{workflow?.hash}</code></div><div className="flow-wrap" data-testid="workflow-graph"><ReactFlow nodes={graph.nodes} edges={graph.edges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable><Background /><Controls showInteractive={false} /></ReactFlow></div><Dialog.Close className="primary">关闭</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root>
        </>}
      </aside>
      <Dialog.Root open={evidenceOpen} onOpenChange={setEvidenceOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Popup className="evidence-drawer" data-testid="evidence-drawer">
            <div className="evidence-drawer-head"><div><span className="eyebrow">Claim–Evidence–Lineage</span><Dialog.Title>证据详情</Dialog.Title></div><Dialog.Close className="secondary">关闭</Dialog.Close></div>
            <Dialog.Description>以下字段直接来自当前任务快照，用于核对结论来源、访问范围与血缘。</Dialog.Description>
            {task !== undefined && task.evidence.length > 1 && <div className="evidence-tabs">{task.evidence.map((item, index) => <button className={item.id === displayedEvidence?.id ? 'evidence-tab evidence-tab-active' : 'evidence-tab'} type="button" key={item.id} onClick={() => openEvidence(item.id)}>证据 {index + 1}</button>)}</div>}
            {displayedEvidence === undefined ? <p className="delivery-empty">当前任务没有可展示的 Evidence。</p> : <>
              <dl className="evidence-facts">
                <div><dt>Evidence</dt><dd>{displayedEvidence.id}</dd></div>
                <div><dt>数据范围</dt><dd>{displayedEvidence.resourceScope}</dd></div>
                <div><dt>数据等级</dt><dd>{displayedEvidence.dataClass}</dd></div>
                <div><dt>受众</dt><dd>{displayedEvidence.audience}</dd></div>
              </dl>
              <section className="evidence-excerpt"><span>来源片段</span><p>{displayedEvidence.excerpt ?? '正在从权威原件重新读取…'}</p><code>excerpt sha256:{displayedEvidence.excerptSha256}</code></section>
              {displayedEvidence.source.kind === 'document_snapshot' ? <section className="evidence-source">
                <h3>DocumentSnapshot 定位</h3>
                <dl className="evidence-facts">
                  <div><dt>Snapshot</dt><dd>{displayedEvidence.source.documentSnapshotId}</dd></div>
                  <div><dt>Artifact</dt><dd>{displayedEvidence.source.artifactId}</dd></div>
                  <div><dt>字节范围</dt><dd>{displayedEvidence.source.startByte}–{displayedEvidence.source.endByteExclusive}（右开）</dd></div>
                  <div><dt>提取规则</dt><dd>{displayedEvidence.source.extractionVersion}</dd></div>
                  <div><dt>Snapshot hash</dt><dd>{displayedEvidence.source.snapshotSha256}</dd></div>
                </dl>
                {evidenceSourceProjection?.artifactState.downloadAllowed === true && <a className="evidence-download" href={evidenceSourceProjection.downloadUrl}>下载并核对原件</a>}
              </section> : <section className="evidence-source"><h3>Legacy fixture 定位</h3><dl className="evidence-facts"><div><dt>Fixture</dt><dd>{displayedEvidence.source.fixtureRef} v{displayedEvidence.source.fixtureVersion}</dd></div><div><dt>Source</dt><dd>{displayedEvidence.source.sourceId}</dd></div></dl></section>}
              <section className="lineage-list"><h3>Lineage</h3>{evidenceLineage.length === 0 ? <p>当前投影没有关联血缘记录。</p> : evidenceLineage.map((item) => <div key={item.id}><code>{item.fromKind}:{item.fromId}</code><span>{item.relation}</span><code>{item.toKind}:{item.toId}</code></div>)}</section>
            </>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  </AssistantRuntimeProvider>;
}
