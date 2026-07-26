import { AssistantRuntimeProvider, ComposerPrimitive, type AppendMessage, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import { Dialog } from '@base-ui/react/dialog';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GateALiveEvidenceProjection, GateALiveTaskSnapshot } from '@geneway/contracts';
import { InternalAcceptanceNotice, SimulationNotice, TaskProgress } from '@geneway/ui';
import { api, type AnalysisCapabilityRoute, type Conversation, type DocumentSnapshotView, type PublicEvidence, type PublicTask, type Workflow } from './api.js';
import { FastChatExperience } from './chat-app.js';
import { ErrorState, LoadingState, routeStateForError, type RouteState } from './product-routes.js';

const STEP_NAMES: Readonly<Record<string, string>> = {
  document_ingest: '读取脱敏材料', requirement_extract: '提取需求', contradiction_check: '检查矛盾', solution_design: '生成方案',
  evidence_verify: '核验来源', result_quality_check: '检查结果质量', report_publish: '发布结果',
  exception_snapshot_load: '读取异常快照', deterministic_baseline: '计算确定性基线', expert_route_resolve: '解析专家路线',
  impact_analysis: '分析异常影响', action_recommendation: '生成处置建议', evidence_quality_check: '检查证据质量',
};

const ROUTES = [
  { value: 'auto', label: '小纬自动安排', disabled: false },
  { value: 'expert.solution.architect', label: '单专家 · 方案架构', disabled: false },
  { value: 'team.solution.core', label: '专家团 · 需求、矛盾与方案架构', disabled: false },
] as const;
type RouteSelector = typeof ROUTES[number]['value'];

const TASK_ID_KEY = 'geneway.solution-analysis.taskId';
const TASK_CURSOR_KEY = 'geneway.solution-analysis.cursor';
const EXPERT_ROUTE_KEY = 'geneway.solution-analysis.expertRoute';
const LEGACY_TASK_ID_KEY = 'geneway.gate02a.taskId';
const LEGACY_TASK_CURSOR_KEY = 'geneway.gate02a.cursor';

function isLiveTask(task: PublicTask | undefined): task is GateALiveTaskSnapshot {
  return task !== undefined && 'recordVariant' in task && task.recordVariant === 'business-task.live/1';
}

function isLiveEvidence(evidence: PublicEvidence | undefined): evidence is GateALiveEvidenceProjection {
  return evidence !== undefined && 'recordVariant' in evidence && evidence.recordVariant === 'evidence.live/1';
}

function taskInputLabel(inputRef: PublicTask['inputRef']): string {
  if (inputRef.kind === 'document_snapshot' || inputRef.kind === 'live_document_snapshot') return inputRef.documentSnapshotId;
  if (inputRef.kind === 'fixture') return inputRef.fixtureRef;
  return `${inputRef.businessExceptionId} · ${inputRef.sourceVersionId}`;
}

function taskInputProfile(inputRef: PublicTask['inputRef']): string {
  if (inputRef.kind === 'live_document_snapshot') return inputRef.extractionVersion;
  if (inputRef.kind === 'document_snapshot') return inputRef.simulationProfile;
  if (inputRef.kind === 'fixture') return 'legacy fixture';
  return inputRef.fixtureVersion;
}

function evidenceAudienceLabel(audience: PublicEvidence['audience']): string {
  return `${audience.kind}:${audience.conversationId}`;
}

function snapshotMatchesRoute(projection: DocumentSnapshotView, capabilityRoute: AnalysisCapabilityRoute | undefined): boolean {
  if (!projection.executionEligibility.eligible || capabilityRoute === undefined) return false;
  return projection.executionEligibility.route === capabilityRoute.executionRoute;
}

function routeAllowsMode(capabilityRoute: AnalysisCapabilityRoute, mode: 'auto' | 'expert' | 'team'): boolean {
  return capabilityRoute.availableExpertModes.some((available) => available === mode);
}

function clearAnalysisRecoveryState(): void {
  for (const key of [TASK_ID_KEY, TASK_CURSOR_KEY, EXPERT_ROUTE_KEY, LEGACY_TASK_ID_KEY, LEGACY_TASK_CURSOR_KEY]) localStorage.removeItem(key);
}

function isRouteSelector(value: string | null): value is RouteSelector {
  return ROUTES.some((route) => route.value === value);
}

function requestedRoute(task: PublicTask): RouteSelector {
  if (!isLiveTask(task)) {
    const requested = task.expertTarget.mode === 'expert' ? task.expertTarget.expertId
      : task.expertTarget.mode === 'team' ? task.expertTarget.teamId : 'auto';
    return isRouteSelector(requested) ? requested : 'auto';
  }
  if (task.capabilityVersionId === 'cap_solution_analysis_v1_live_2') {
    const requested = task.expertTarget.requested;
    return requested.mode === 'expert' ? requested.expertId : requested.mode === 'team' ? requested.teamId : 'auto';
  }
  return 'auto';
}

function routeLabel(task: PublicTask): string {
  const route = requestedRoute(task);
  return route === 'expert.solution.architect' ? '单专家 · 方案架构'
    : route === 'team.solution.core' ? '专家团 · 需求、矛盾与方案架构' : '小纬自动安排';
}

function collaborationLabel(task: PublicTask): string {
  return isLiveTask(task) && task.capabilityVersionId === 'cap_solution_analysis_v1_live_2'
    ? '需求分析 → 矛盾分析 → 方案架构'
    : routeLabel(task);
}


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
  if (selectedCapability === 'solution.analysis.v1' || forceOpen) {
    return <AnalysisConversationExperience {...(explicitConversationId === undefined ? {} : { conversationId: explicitConversationId })} />;
  }
  if (selectedCapability !== null && selectedCapability !== 'xiaowei.chat.v1') {
    return <main className="not-open" data-testid="not-open"><span>NOT_OPEN</span><h1>该能力尚未开放</h1><p>请返回与小纬开始普通对话，或选择已经开放的方案分析能力。</p></main>;
  }
  if (explicitConversationId === undefined) return <FastChatExperience />;
  return <ExistingConversationExperience conversationId={explicitConversationId} />;
}

function ExistingConversationExperience({ conversationId }: Readonly<{ conversationId: string }>) {
  const [hasBusinessTask, setHasBusinessTask] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [state, setState] = useState<RouteState>('loading');

  useEffect(() => {
    let active = true;
    void api.getConversation(conversationId).then((snapshot) => {
      if (active) { setHasBusinessTask(snapshot.latestTaskId !== null); setState('ready'); }
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setState(routeStateForError(cause)); }
    });
    return () => { active = false; };
  }, [conversationId]);

  if (error !== undefined) return <main className="app-shell product-shell" data-testid="product-shell" data-state={state}><ErrorState message={error} state={state as Exclude<RouteState, 'loading' | 'ready' | 'empty' | 'filtered-empty' | 'canceled' | 'recovering'>} /></main>;
  if (hasBusinessTask === undefined) return <main className="app-shell product-shell" data-testid="product-shell" data-state="loading"><LoadingState /></main>;
  return hasBusinessTask
    ? <AnalysisConversationExperience conversationId={conversationId} />
    : <FastChatExperience conversationId={conversationId} />;
}

function AnalysisConversationExperience({ conversationId: explicitConversationId }: Readonly<{ conversationId?: string }>) {
  const [capabilityRoute, setCapabilityRoute] = useState<AnalysisCapabilityRoute>();
  const [routeError, setRouteError] = useState<string>();
  const [route, setRoute] = useState<RouteSelector>(() => {
    const stored = localStorage.getItem(EXPERT_ROUTE_KEY);
    return isRouteSelector(stored) ? stored : 'auto';
  });
  const [conversation, setConversation] = useState<Conversation>();
  const [task, setTask] = useState<PublicTask>();
  const [workflow, setWorkflow] = useState<Workflow>();
  const [documentSnapshots, setDocumentSnapshots] = useState<readonly DocumentSnapshotView[]>([]);
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
  const [evidenceDetail, setEvidenceDetail] = useState<PublicEvidence>();
  const latestTaskSnapshot = useRef<PublicTask | undefined>(undefined);

  const loadDocumentSnapshots = useCallback(async (conversationId: string) => {
    try {
      const listed = await api.getDocumentSnapshots(conversationId);
      setDocumentSnapshots(listed.documentSnapshots);
      setSelectedSnapshotId((currentId) => listed.documentSnapshots.some((projection) =>
        projection.documentSnapshot.id === currentId && snapshotMatchesRoute(projection, capabilityRoute)) ? currentId : undefined);
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
  }, [capabilityRoute]);

  const recover = useCallback(async (taskId: string, knownCursor: number) => {
    let snapshot = await api.getTask(taskId);
    const events = await api.events(taskId, knownCursor);
    const streamCursor = events.reduce((highest, event) => Math.max(highest, event.cursor ?? 0), knownCursor);
    if (streamCursor > snapshot.eventWatermark) {
      snapshot = await api.getTask(taskId);
    }
    const [conversationSnapshot, workflowVersion] = await Promise.all([
      api.getConversation(snapshot.conversationId), api.getWorkflow(snapshot.workflowVersion.id),
    ]);
    const latest = latestTaskSnapshot.current;
    if (latest?.id === taskId && latest.aggregateVersion > snapshot.aggregateVersion) snapshot = latest;
    else latestTaskSnapshot.current = snapshot;
    const nextCursor = Math.max(streamCursor, snapshot.eventWatermark);
    const restoredRoute = requestedRoute(snapshot);
    setRoute(restoredRoute);
    if (snapshot.inputRef.kind === 'document_snapshot' || snapshot.inputRef.kind === 'live_document_snapshot') {
      setSelectedSnapshotId(snapshot.inputRef.documentSnapshotId);
    }
    setTask(snapshot); setConversation(conversationSnapshot); setWorkflow(workflowVersion); setCursor(nextCursor);
    localStorage.setItem('geneway.conversationId', snapshot.conversationId);
    localStorage.setItem(TASK_ID_KEY, taskId);
    localStorage.setItem(TASK_CURSOR_KEY, String(nextCursor));
    localStorage.setItem(EXPERT_ROUTE_KEY, restoredRoute);
    return { snapshot, cursor: nextCursor };
  }, []);

  useEffect(() => {
    let active = true;
    void api.getAnalysisCapabilityRoute().then((projection) => {
      if (active) setCapabilityRoute(projection);
    }).catch((cause: unknown) => {
      if (active) setRouteError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (capabilityRoute === undefined || task !== undefined) return;
    const selectedMode = route === 'auto' ? 'auto' : route === 'expert.solution.architect' ? 'expert' : 'team';
    if (!routeAllowsMode(capabilityRoute, selectedMode)) {
      setRoute('auto');
      localStorage.setItem(EXPERT_ROUTE_KEY, 'auto');
    }
  }, [capabilityRoute, route, task]);

  useEffect(() => {
    if (capabilityRoute === undefined) return;
    const storedTaskId = localStorage.getItem(TASK_ID_KEY) ?? localStorage.getItem(LEGACY_TASK_ID_KEY);
    if (capabilityRoute.status === 'NOT_OPEN' && explicitConversationId === undefined && storedTaskId === null) return;
    if (explicitConversationId !== undefined) {
      void ensureConversation(explicitConversationId).then(async (current) => {
        setConversation(current);
        if (current.latestTaskId !== null) await recover(current.latestTaskId, 0);
        try { await loadDocumentSnapshots(current.id); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    if (storedTaskId !== null) {
      const saved = Number(localStorage.getItem(TASK_CURSOR_KEY) ?? localStorage.getItem(LEGACY_TASK_CURSOR_KEY) ?? 0);
      void recover(storedTaskId, Number.isSafeInteger(saved) ? saved : 0).then(async ({ snapshot }) => {
        if (snapshot.inputRef.kind === 'document_snapshot' || snapshot.inputRef.kind === 'live_document_snapshot') {
          setSelectedSnapshotId(snapshot.inputRef.documentSnapshotId);
        }
        try { await loadDocumentSnapshots(snapshot.conversationId); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }).catch(() => { clearAnalysisRecoveryState(); });
      return;
    }
    void ensureConversation().then(async (current) => {
      setConversation(current);
      await loadDocumentSnapshots(current.id);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [capabilityRoute, explicitConversationId, loadDocumentSnapshots, recover]);

  useEffect(() => {
    if (task === undefined || working || canceling || !['queued', 'running', 'cancel_requested'].includes(task.status)) return;
    let active = true;
    let knownCursor = cursor;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const current = await recover(task.id, knownCursor);
        knownCursor = current.cursor;
        if (active && ['queued', 'running', 'cancel_requested'].includes(current.snapshot.status)) {
          timer = setTimeout(() => void poll(), 750);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    timer = setTimeout(() => void poll(), 0);
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [canceling, recover, task?.id, task?.status, working]);

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
      if (capabilityRoute === undefined || capabilityRoute.status === 'NOT_OPEN') throw new Error('NOT_OPEN: 当前能力尚未开放');
      const selected = documentSnapshots.find((projection) => projection.documentSnapshot.id === selectedSnapshotId);
      if (selected === undefined || !snapshotMatchesRoute(selected, capabilityRoute)) {
        throw new Error('DOCUMENT_SNAPSHOT_REQUIRED: 请先明确选择一份当前通道允许的材料');
      }
      const current = conversation ?? await ensureConversation(explicitConversationId);
      setConversation(current);
      const conversationId = current.id;
      const expertMode = route === 'auto' ? 'auto' : route === 'expert.solution.architect' ? 'expert' : 'team';
      if (!routeAllowsMode(capabilityRoute, expertMode)) {
        throw new Error('NOT_OPEN: 当前专家路线尚未通过服务端 release gate');
      }
      await api.addMessage(conversationId, body || '请分析已选择的脱敏方案材料');
      const expertTarget = route === 'auto' ? { mode: 'auto' } as const
        : route === 'expert.solution.architect' ? { mode: 'expert', expertId: route } as const
          : { mode: 'team', teamId: route } as const;
      const created = await api.createTask(conversationId, selected.documentSnapshot.id, expertTarget);
      latestTaskSnapshot.current = undefined;
      await recover(created.taskId, 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  }, [capabilityRoute, conversation, documentSnapshots, explicitConversationId, recover, route, selectedSnapshotId]);

  const selectedSnapshot = useMemo(() => documentSnapshots.find((projection) =>
    projection.documentSnapshot.id === selectedSnapshotId && snapshotMatchesRoute(projection, capabilityRoute)),
  [capabilityRoute, documentSnapshots, selectedSnapshotId]);

  const runtime = useExternalStoreRuntime({
    messages: conversation?.messages ?? [],
    convertMessage: convertConversationMessage,
    isRunning: working,
    isSendDisabled: task !== undefined || working || selectedSnapshot === undefined,
    onNew: async (message) => create(textOfAppendMessage(message)),
  });

  const approveAndRun = async () => {
    if (task === undefined) return;
    setWorking(true); setError(undefined);
    try {
      if (task.approval.status === 'pending') await api.approve(task.approval.id);
      const approved = await recover(task.id, cursor);
      await api.execute(task.id, approved.snapshot.approval);
      let currentCursor = approved.cursor;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const current = await recover(task.id, currentCursor);
        currentCursor = current.cursor;
        if (['completed', 'failed', 'rejected', 'canceled'].includes(current.snapshot.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try { await recover(task.id, cursor); } catch { /* Preserve the actionable execution error. */ }
    }
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
  const liveTask = isLiveTask(task);
  const failedStep = task?.steps.find((step) => step.status === 'failed');
  const published = !liveTask ? task?.claims.find((claim) => claim.status === 'published') : undefined;
  const rejected = !liveTask ? task?.claims.find((claim) => claim.status === 'rejected') : undefined;
  const evidence = !liveTask ? task?.evidence.find((item) => item.id === published?.evidenceRefId) : undefined;
  const selectedEvidence = task?.evidence.find((item) => item.id === selectedEvidenceId) ?? task?.evidence[0];
  const displayedEvidence = evidenceDetail?.id === selectedEvidence?.id ? evidenceDetail : selectedEvidence;
  const evidenceLineage = task?.lineage.filter((item) => displayedEvidence?.lineageRecordIds.includes(item.id)) ?? [];
  const reportArtifacts = task?.artifacts.filter((artifact) => liveTask
    ? artifact.kind === 'analysis_report' : artifact.kind === 'simulation_report') ?? [];
  const taskDocumentSnapshotId = task?.inputRef.kind === 'document_snapshot' || task?.inputRef.kind === 'live_document_snapshot'
    ? task.inputRef.documentSnapshotId : undefined;
  const taskSourceProjection = documentSnapshots.find((projection) => projection.documentSnapshot.id === taskDocumentSnapshotId);
  const evidenceDocumentSnapshotId = displayedEvidence?.source.kind === 'document_snapshot'
    || displayedEvidence?.source.kind === 'canonical_text_span' || displayedEvidence?.source.kind === 'canonical_page_span'
    ? displayedEvidence.source.documentSnapshotId : undefined;
  const evidenceSourceProjection = documentSnapshots.find((projection) => projection.documentSnapshot.id === evidenceDocumentSnapshotId);
  const isExceptionTask = task?.capabilityId === 'operations.exception-assist.v1';

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

  if (routeError !== undefined) return <main className="not-open" data-testid="not-open"><span>NOT_OPEN</span><h1>材料分析通道不可用</h1><p>{routeError}</p><a className="primary" href="/conversations/new">返回普通聊天</a></main>;
  if (capabilityRoute === undefined) return <main className="app-shell product-shell" data-testid="product-shell" data-state="loading"><LoadingState /></main>;
  if (capabilityRoute.status === 'NOT_OPEN' && task === undefined) return <main className="not-open" data-testid="not-open"><span>NOT_OPEN</span><h1>材料分析通道尚未开放</h1><p>当前通道未通过内部 release、模型、Parser 或数据边界检查；普通聊天不受影响。</p><a className="primary" href="/conversations/new">返回普通聊天</a></main>;

  return <AssistantRuntimeProvider runtime={runtime}>
    <main className="app-shell" data-testid="geneway-app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
        <a className="new-task" href="/conversations/new?capability=solution.analysis.v1" onClick={clearAnalysisRecoveryState}>＋ 新建会话</a>
        <nav><b>工作区</b><a className="nav-active" href="/conversations/new?capability=solution.analysis.v1">小纬</a><a href="/exceptions">异常与待办</a><a href="/tasks">我的任务</a><a href="/workflows">Workflow</a><span>生产日报 · 即将开放</span></nav>
        <section className="operations-preview" aria-label="制造业状态入口">
          <h3>现场动态</h3>
          <a href="/exceptions?exceptionType=equipment_alarm"><span className="signal danger" />设备异常待处理<small>模拟数据</small></a>
          <a href="/exceptions?exceptionType=capacity_progress_lag"><span className="signal warning" />产能进度落后<small>模拟数据</small></a>
        </section>
      </aside>

      <section className="conversation-pane">
        <header className="topbar"><div><h1>小纬</h1><p>{liveTask || capabilityRoute.executionRoute === 'live' ? '材料分析 · 可信本机内部验收' : '通用数字员工 · 当前为模拟运行'}</p></div>{liveTask || capabilityRoute.executionRoute === 'live' ? <InternalAcceptanceNotice /> : <SimulationNotice />}</header>
        <div className="thread" data-testid="message-thread">
          {(conversation?.messages.length ?? 0) === 0 && <section className="welcome-empty" data-testid="welcome-empty"><div className="avatar">纬</div><div><b>你好，我是小纬</b><p>{isExceptionTask ? '这个私有会话由异常分析任务创建。来源、专家路线、Workflow 与审批均已绑定服务端权威版本。' : liveTask || capabilityRoute.executionRoute === 'live' ? '请上传并明确选择一份获准的 C1 材料，再选择自动、单专家或专家团。固定 Workflow 会先展示并等待批准。' : '请上传并明确选择一份只读材料。任何 Workflow 都会先展示并等待批准。'}</p></div></section>}
          {conversation?.messages.map((message) => <article className={`message ${message.author}`} key={message.id} data-author={message.author}>
            <div className="avatar">{message.author === 'xiaowei' ? '纬' : '你'}</div><div><b>{message.author === 'xiaowei' ? '小纬' : '你'}</b><p>{message.body}</p></div>
          </article>)}
          {!isExceptionTask && capabilityRoute.status !== 'NOT_OPEN' && <section className="upload-card" data-testid="artifact-upload-card">
            <div><span className="eyebrow">私有材料库</span><h2>上传分析材料</h2><p>{capabilityRoute.executionRoute === 'live' ? 'A.1 接收通过 Parser authority 的 UTF-8 .txt、PDF 与 DOCX；上传后还需服务端确认 C1 live route、资源限制和不可变 canonical representation。' : '仅接收不超过 1 MiB 的 UTF-8 .txt / .md。上传后请明确选择一份已匹配 Profile 的材料。'}</p></div>
            <label className={`upload-action${uploading ? ' disabled' : ''}`}>
              {uploading ? '正在校验…' : '选择文件'}
              <input data-testid="artifact-upload-input" aria-label="上传分析材料" type="file" accept={capabilityRoute.executionRoute === 'live' ? '.txt,text/plain,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '.txt,text/plain,.md,text/markdown'} disabled={uploading} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void uploadArtifact(file);
                event.target.value = '';
              }} />
            </label>
          </section>}
          {snapshotReadUnavailable && <section className="artifact-card artifact-card-unavailable" data-testid="artifact-unavailable-card">
            <div className="artifact-title"><div><span className="eyebrow">安全降级</span><h2>材料对象不可用或完整性异常</h2></div><span className="integrity-badge integrity-badge-error">不可用</span></div>
            <p>已隐藏材料名称、标识和摘要。下载与分析执行均已禁用，请等待管理员完成存储对账。</p>
          </section>}
          {documentSnapshots.map((projection) => {
            const snapshot = projection.documentSnapshot;
            const eligibility = projection.executionEligibility;
            const eligible = snapshotMatchesRoute(projection, capabilityRoute);
            const selected = eligible && selectedSnapshotId === snapshot.id;
            const liveEligible = eligibility.route === 'live' && eligibility.eligible;
            return <section className={`artifact-card${selected ? ' artifact-card-selected' : ''}${eligible ? '' : ' artifact-card-ineligible'}`} key={snapshot.id} data-testid="artifact-card"
              data-artifact-id={snapshot.artifactId} data-manifest-id={snapshot.manifestId} data-snapshot-id={snapshot.id} data-content-sha256={snapshot.contentSha256}
              data-execution-route={eligibility.route} data-media-type={snapshot.mediaType}
              data-extraction-version={liveEligible ? eligibility.extractionVersion : ''}>
              <div className="artifact-title"><div><span className="eyebrow">已校验 · 私有 · C1 · untrusted_text</span><h2>{snapshot.displayName}</h2></div><span className={`integrity-badge${eligible ? '' : ' integrity-badge-muted'}`}>{selected ? '已选择' : eligible ? '可执行' : '当前通道不可执行'}</span></div>
              <dl className="artifact-facts"><div><dt>大小</dt><dd data-testid="artifact-size">{snapshot.sizeBytes} bytes</dd></div><div><dt>类型</dt><dd>{snapshot.mediaType}</dd></div><div><dt>Snapshot</dt><dd>{snapshot.id}</dd></div></dl>
              <code className="artifact-hash" data-testid="artifact-hash">sha256:{snapshot.contentSha256}</code>
              <div className="artifact-profile" data-testid="snapshot-execution-route"><span>{liveEligible ? 'Parser' : 'Profile'}</span><code>{liveEligible ? eligibility.parserManifestId : eligibility.route === 'simulation' ? eligibility.simulationProfile : eligibility.reason}</code></div>
              <div className="artifact-actions">
                {projection.artifactState.downloadAllowed ? <a data-testid="artifact-download" href={projection.downloadUrl}>下载原件</a> : <span>原件下载已禁用</span>}
                <span data-testid="artifact-eligibility">{liveEligible ? '已通过 C1、Parser 与 canonical representation 检查，可用于真实分析' : eligibility.route === 'simulation' && eligible ? '已匹配演示 Profile，可用于模拟分析' : '当前服务端通道未开放此材料'}</span>
                <button className={selected ? 'snapshot-select snapshot-select-selected' : 'snapshot-select'} type="button" disabled={!eligible || task !== undefined || working} aria-pressed={selected} onClick={() => setSelectedSnapshotId(snapshot.id)}>
                  {selected ? '已选择用于本次任务' : eligible ? '选择用于分析' : '不可执行'}
                </button>
              </div>
            </section>;
          })}
          {task !== undefined && <section className="task-card" data-testid="task-card" data-task-id={task.id} data-workflow-id={task.workflowVersion.id} data-workflow-hash={task.workflowVersion.hash}
            data-record-variant={liveTask ? task.recordVariant : 'business-task.simulation/1'} data-model-invocation-id={liveTask ? task.modelInvocation?.id ?? '' : ''}>
            <div className="task-title"><div><span className="eyebrow">{liveTask ? '小纬任务 · 可信本机内部验收' : '小纬任务 · simulation=true'}</span><h2>{task.title}</h2></div><span className={`status status-${task.status}`}>{task.status}</span></div>
            <p>{liveTask ? `分析路线：${routeLabel(task)}。客户可见作者仍只有小纬。` : isExceptionTask ? '任务绑定版本固定的异常来源与 Evidence。' : '当前为醒目标记的 legacy 模拟任务；专家只作为后端协作者，客户消息仍只由小纬发出。'}</p>
            <dl className="task-bindings">
              <div><dt>Snapshot</dt><dd>{taskInputLabel(task.inputRef)}</dd></div>
              <div><dt>{liveTask ? 'Extraction' : 'Profile'}</dt><dd>{taskInputProfile(task.inputRef)}</dd></div>
              <div><dt>Workflow</dt><dd>{task.workflowVersion.id}</dd></div>
              <div><dt>专家路线</dt><dd data-testid="task-expert-route">{routeLabel(task)}</dd></div>
              <div><dt>协作来源</dt><dd data-testid="task-collaboration">{collaborationLabel(task)}</dd></div>
              <div><dt>客户可见作者</dt><dd data-testid="task-customer-author">小纬</dd></div>
              <div><dt>运行边界</dt><dd data-testid="task-execution-boundary">simulation={String(task.simulation)} · runtimeMode={task.runtimeMode} · businessDecisionAllowed={String(task.businessDecisionAllowed)}</dd></div>
              {liveTask && <div><dt>ModelInvocation</dt><dd data-testid="task-model-invocation-id">{task.modelInvocation?.id ?? '等待执行'}</dd></div>}
            </dl>
            <TaskProgress completed={completed} total={7} /><p className="progress-copy">已完成 {completed} / 7 个步骤</p>
            <div className="version-strip"><code>{task.workflowVersion.id}</code><code title={task.workflowVersion.hash}>{task.workflowVersion.hash.slice(0, 16)}…</code><span>SSE cursor {cursor}</span></div>
            <div className="actions">
              <button className="secondary" onClick={() => setWorkflowOpen(true)}>查看 Workflow</button>
              {task.status === 'awaiting_approval' && capabilityRoute.status !== 'NOT_OPEN' && <button className="primary" disabled={working} onClick={() => void approveAndRun()}>{liveTask ? '批准并运行真实分析' : '批准并运行模拟任务'}</button>}
              {task.status !== 'awaiting_approval' && <button className="secondary" type="button" data-testid="cancel-task-button"
                disabled={!['queued', 'running'].includes(task.status) || canceling} onClick={() => void cancelTask()}>{canceling ? '正在取消…' : liveTask ? '取消分析任务' : '取消模拟任务'}</button>}
            </div>
          </section>}
          {task?.status === 'canceled' && <section className="result-card" data-testid="canceled-task-state">
            <span className="eyebrow">小纬任务 · 已停止</span><h2>{liveTask ? '分析任务已取消' : '模拟任务已取消'}</h2><p>{liveTask ? '不会发布结构化结果、Evidence 或内部验收报告。刷新后仍恢复同一终态。' : '不会发布 Claim 或模拟报告。刷新页面后仍可查看该终态。'}</p>
          </section>}
          {task?.status === 'failed' && <section className="result-card" data-testid="failed-task-state">
            <span className="eyebrow">小纬任务 · 执行失败</span><h2>{liveTask ? '本次材料分析未发布' : '本次模拟任务失败'}</h2>
            <p>{liveTask ? '任务已安全停止；不会把未核验候选发布为结构化结果、Evidence 或内部验收报告。刷新后仍恢复同一终态。' : '任务已停止，未发布模拟结论或报告。'}</p>
            <dl className="task-bindings"><div><dt>失败阶段</dt><dd data-testid="failed-task-step">{failedStep === undefined ? '任务边界' : STEP_NAMES[failedStep.id] ?? failedStep.id}</dd></div><div><dt>稳定错误</dt><dd><code data-testid="failed-task-error-class">{isLiveTask(task) ? task.errorClass ?? 'TASK_FAILED' : 'SIMULATION_TASK_FAILED'}</code></dd></div></dl>
          </section>}
          {task?.status === 'completed' && <section className="result-card" data-testid="result-card">
            <span className="eyebrow">{liveTask ? '小纬结论 · 可信本机内部验收' : '小纬结论 · 模拟结果 · 不可用于业务决策'}</span><h2>{isExceptionTask ? '异常分析完成' : '方案分析完成'}</h2>
            {liveTask && task.result !== null && <div className="analysis-result" data-testid="analysis-result"><p className="analysis-summary" data-testid="analysis-summary">{task.result.summary}</p>
              <div className="analysis-statements">{task.result.statements.map((statement) => <article className={`analysis-statement analysis-statement-${statement.kind} ${statement.status}`} key={statement.id}
                data-testid={`analysis-statement-${statement.kind}`} data-statement-id={statement.id} data-statement-kind={statement.kind} data-statement-status={statement.status}>
                <div className="analysis-statement-head"><b>{statement.kind === 'fact' ? '事实' : statement.kind === 'inference' ? '推断' : statement.kind === 'recommendation' ? '建议' : '未知项'}</b><span>{statement.status === 'published' ? '已发布' : '未发布'}</span></div>
                <p>{statement.text}</p><small>confidence {statement.confidence.toFixed(2)}{statement.rejectionCode === null ? '' : ` · ${statement.rejectionCode}`}</small>
                {statement.evidenceRefIds.map((evidenceId) => <button className="statement-evidence-link" data-testid="statement-evidence-link" type="button" key={evidenceId} onClick={() => openEvidence(evidenceId)}>Evidence · {evidenceId}</button>)}
              </article>)}</div>
            </div>}
            {!liveTask && published !== undefined && <div className="claim published" data-testid="published-claim"><b>已核验结论</b><p>{published.text}</p>{evidence !== undefined && <div className="claim-evidence" data-evidence-id={evidence.id}><span>已绑定 Evidence · {evidence.id}</span><button className="secondary" type="button" onClick={() => openEvidence(evidence.id)}>查看证据</button></div>}</div>}
            {!liveTask && rejected !== undefined && <div className="claim rejected" data-testid="rejected-claim"><b>未发布候选</b><p>{rejected.text}</p><small>缺少可访问来源，已由 Evidence publish guard 拒绝。</small></div>}
          </section>}
          {task !== undefined && <section className="delivery-card" data-testid="task-deliveries">
            <div className="delivery-head"><div><span className="eyebrow">任务材料与交付物</span><h2>Artifact</h2></div>{task.evidence.length > 0 && <button className="secondary" type="button" onClick={() => openEvidence()}>Evidence {task.evidence.length}</button>}</div>
            {(task.inputRef.kind === 'document_snapshot' || task.inputRef.kind === 'live_document_snapshot') && <article className="delivery-item" data-testid="source-artifact-item">
              <div><b>{taskSourceProjection?.documentSnapshot.displayName ?? '任务输入原件'}</b><span>source_document · {task.inputRef.artifactId}</span></div>
              <code>sha256:{task.inputRef.kind === 'live_document_snapshot' ? task.inputRef.artifactSha256 : task.inputRef.contentSha256}</code>
              {taskSourceProjection?.artifactState.downloadAllowed === true
                ? <a href={taskSourceProjection.downloadUrl}>下载原件</a>
                : <span className="delivery-unavailable">原件下载信息当前不可用</span>}
            </article>}
            {reportArtifacts.map((artifact) => <article className="delivery-item" key={artifact.id} data-testid="report-artifact-item" data-artifact-id={artifact.id} data-content-sha256={artifact.contentSha256}>
              <div><b>{artifact.displayName}</b><span>{artifact.kind} · {artifact.sizeBytes} bytes</span></div>
              <code>sha256:{artifact.contentSha256}</code>
              <a href={artifact.downloadUrl}>{liveTask ? '下载内部验收报告' : '下载模拟报告'}</a>
            </article>)}
            {reportArtifacts.length === 0 && <p className="delivery-empty">{['failed', 'canceled'].includes(task.status)
              ? liveTask ? '任务已安全终止，没有发布内部验收报告。' : '任务已终止，没有发布模拟报告。'
              : liveTask ? '内部验收报告将在结构化结果和逐事实 Evidence 通过发布守卫后出现。' : '模拟报告将在任务完成并通过发布守卫后出现。'}</p>}
            <small>Lineage records: {task.lineage.length}</small>
          </section>}
          {error !== undefined && <div className="error" role="alert">{error}</div>}
        </div>
        {!isExceptionTask && capabilityRoute.status !== 'NOT_OPEN' && <div className="composer-zone">
          <div className="composer-tools"><label>专家路线<select aria-label="专家路线" value={route} disabled={task !== undefined || working} onChange={(event) => {
            const next = event.target.value;
            if (isRouteSelector(next)) { setRoute(next); localStorage.setItem(EXPERT_ROUTE_KEY, next); }
          }}>{ROUTES.map((item) => {
            const mode = item.value === 'auto' ? 'auto' : item.value === 'expert.solution.architect' ? 'expert' : 'team';
            return <option key={item.value} value={item.value} disabled={item.disabled || !routeAllowsMode(capabilityRoute, mode)}>{item.label}</option>;
          })}</select></label><span>{selectedSnapshot === undefined ? '请先选择一份可执行材料' : `已选：${selectedSnapshot.documentSnapshot.displayName} · ${ROUTES.find((item) => item.value === route)?.label} · 执行前仍需审批`}</span></div>
          <ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input aria-label="给小纬发消息" placeholder={selectedSnapshot === undefined ? '请先在上方选择可执行材料' : '请小纬分析这份脱敏材料…'} disabled={task !== undefined || working || selectedSnapshot === undefined} /><ComposerPrimitive.Send className="send" disabled={task !== undefined || working || selectedSnapshot === undefined}>{working ? '处理中' : '发送'}</ComposerPrimitive.Send></ComposerPrimitive.Root>
        </div>}
      </section>

      <aside className="inspector">
        <div className="inspector-head"><span>任务检查器</span><button onClick={() => setWorkflowOpen((value) => !value)}>{workflowOpen ? '收起' : '展开'}</button></div>
        {task === undefined && snapshotReadUnavailable ? <div className="snapshot-inspector" data-testid="snapshot-unavailable-inspector"><span className="eyebrow">材料权威状态</span><h2>对象不可用 / 完整性异常</h2><p>敏感元数据已隐藏，下载与执行已禁用。</p></div> : task === undefined && documentSnapshots.length === 0 ? <div className="empty-inspector"><span>◇</span><p>上传材料或发送问题后，这里会显示存储校验、Workflow、审批、证据和安全边界。</p></div> : task === undefined ? <div className="snapshot-inspector" data-testid="snapshot-inspector"><span className="eyebrow">材料权威状态</span><h2>{documentSnapshots.length} 份已校验材料</h2>{documentSnapshots.map(({ documentSnapshot: snapshot, artifactState }) => <dl className="facts" key={snapshot.id}><div><dt>Artifact</dt><dd>{snapshot.artifactId}</dd></div><div><dt>Manifest</dt><dd>{snapshot.manifestId}</dd></div><div><dt>Snapshot</dt><dd>{snapshot.id}</dd></div><div><dt>Integrity</dt><dd>{artifactState.integrity}</dd></div></dl>)}</div> : <>
          <dl className="facts"><div><dt>Task</dt><dd data-testid="task-id">{task.id}</dd></div><div><dt>Approval</dt><dd data-testid="approval-id">{task.approval.id}</dd></div><div><dt>Approval digest</dt><dd data-testid="conversation-approval-digest">{task.approval.subjectDigest}</dd></div><div><dt>输入</dt><dd>{taskInputLabel(task.inputRef)}</dd></div><div><dt>Profile</dt><dd>{taskInputProfile(task.inputRef)}</dd></div><div><dt>状态</dt><dd>{task.status}</dd></div><div><dt>事件游标</dt><dd data-testid="sse-cursor">{cursor}</dd></div></dl>
          {liveTask ? <InternalAcceptanceNotice /> : <SimulationNotice />}
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
                <div><dt>受众</dt><dd>{evidenceAudienceLabel(displayedEvidence.audience)}</dd></div>
              </dl>
              <section className="evidence-excerpt"><span>来源片段</span><p>{displayedEvidence.excerpt ?? '正在从权威原件重新读取…'}</p><code data-testid="evidence-excerpt-sha256">excerpt sha256:{isLiveEvidence(displayedEvidence) ? displayedEvidence.source.excerptSha256 : displayedEvidence.excerptSha256}</code></section>
              {isLiveEvidence(displayedEvidence) ? <section className="evidence-source" data-testid="live-evidence-source">
                <h3>Canonical Evidence 定位</h3>
                <dl className="evidence-facts">
                  <div><dt>定位类型</dt><dd data-testid="evidence-locator-kind">{displayedEvidence.source.kind}</dd></div>
                  <div><dt>Snapshot</dt><dd>{displayedEvidence.source.documentSnapshotId}</dd></div>
                  <div><dt>Artifact</dt><dd>{displayedEvidence.source.sourceArtifactId}</dd></div>
                  <div><dt>规范范围</dt><dd data-testid="evidence-canonical-span">{displayedEvidence.source.startByte}–{displayedEvidence.source.endByteExclusive}（右开）</dd></div>
                  {displayedEvidence.source.kind === 'canonical_page_span' && <div><dt>页索引（从 0 起）</dt><dd data-testid="evidence-page-index">{displayedEvidence.source.pageIndex}</dd></div>}
                  <div><dt>提取规则</dt><dd>{displayedEvidence.source.extractionVersion}</dd></div>
                  <div><dt>Canonical text hash</dt><dd>{displayedEvidence.source.canonicalTextSha256}</dd></div>
                  <div><dt>Artifact hash</dt><dd>{displayedEvidence.source.sourceArtifactSha256}</dd></div>
                  <div><dt>Parser manifest</dt><dd>{displayedEvidence.source.parserManifestId}</dd></div>
                  <div><dt>Parser digest</dt><dd>{displayedEvidence.source.parserDigest}</dd></div>
                </dl>
                {evidenceSourceProjection?.artifactState.downloadAllowed === true && <a className="evidence-download" href={evidenceSourceProjection.downloadUrl}>下载并核对原件</a>}
              </section> : displayedEvidence.source.kind === 'document_snapshot' ? <section className="evidence-source">
                <h3>DocumentSnapshot 定位</h3>
                <dl className="evidence-facts">
                  <div><dt>Snapshot</dt><dd>{displayedEvidence.source.documentSnapshotId}</dd></div>
                  <div><dt>Artifact</dt><dd>{displayedEvidence.source.artifactId}</dd></div>
                  <div><dt>字节范围</dt><dd>{displayedEvidence.source.startByte}–{displayedEvidence.source.endByteExclusive}（右开）</dd></div>
                  <div><dt>提取规则</dt><dd>{displayedEvidence.source.extractionVersion}</dd></div>
                  <div><dt>Snapshot hash</dt><dd>{displayedEvidence.source.snapshotSha256}</dd></div>
                </dl>
                {evidenceSourceProjection?.artifactState.downloadAllowed === true && <a className="evidence-download" href={evidenceSourceProjection.downloadUrl}>下载并核对原件</a>}
              </section> : displayedEvidence.source.kind === 'legacy_fixture' ? <section className="evidence-source"><h3>Legacy fixture 定位</h3><dl className="evidence-facts"><div><dt>Fixture</dt><dd>{displayedEvidence.source.fixtureRef} v{displayedEvidence.source.fixtureVersion}</dd></div><div><dt>Source</dt><dd>{displayedEvidence.source.sourceId}</dd></div></dl></section> : <section className="evidence-source"><h3>BusinessExceptionSourceSnapshot 定位</h3><dl className="evidence-facts"><div><dt>BusinessException</dt><dd>{displayedEvidence.source.businessExceptionId}</dd></div><div><dt>Source version</dt><dd>{displayedEvidence.source.sourceVersionId}</dd></div><div><dt>JSON pointer</dt><dd>{displayedEvidence.source.jsonPointer}</dd></div><div><dt>Canonicalization</dt><dd>{displayedEvidence.source.canonicalizationVersion}</dd></div><div><dt>Source hash</dt><dd>{displayedEvidence.source.sourceSha256}</dd></div><div><dt>Value hash</dt><dd>{displayedEvidence.source.valueSha256}</dd></div></dl></section>}
              <section className="lineage-list"><h3>Lineage</h3>{evidenceLineage.length === 0 ? <p>当前投影没有关联血缘记录。</p> : evidenceLineage.map((item) => <div key={item.id}><code>{item.fromKind}:{item.fromId}</code><span>{item.relation}</span><code>{item.toKind}:{item.toId}</code></div>)}</section>
            </>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  </AssistantRuntimeProvider>;
}
