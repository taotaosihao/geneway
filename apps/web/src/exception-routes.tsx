import {
  businessExceptionListQuerySchema,
  type BusinessExceptionDetail,
  type BusinessExceptionListQuery,
  type CreateExceptionAnalysisTaskResponse,
  type ExpertTarget,
} from '@geneway/contracts';
import { SimulationNotice } from '@geneway/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Fact, isFailClosedRouteState, LoadingState, ProductShell, RouteFailure, routeStateForError, type RouteState } from './product-routes.js';

const EXCEPTION_TYPE_LABELS = {
  capacity_progress_lag: '产能进度落后',
  equipment_alarm: '设备报警',
} as const;

const SEVERITY_LABELS = {
  critical: '紧急',
  high: '高',
  medium: '中',
  low: '低',
} as const;

const STATUS_LABELS = {
  open: '待认领',
  acknowledged: '已认领',
} as const;

const EXPERT_TARGETS = {
  auto: { mode: 'auto' },
  expert: { mode: 'expert', expertId: 'expert.operations.analyst' },
  team: { mode: 'team', teamId: 'team.operations.exception' },
} as const satisfies Readonly<Record<string, ExpertTarget>>;

type ExpertTargetChoice = keyof typeof EXPERT_TARGETS;

function exceptionListLocation(search: string): BusinessExceptionListQuery {
  const searchParams = new URLSearchParams(search);
  const value: Record<string, string> = {};
  for (const key of ['status', 'severity', 'exceptionType', 'resourceScope', 'sort', 'direction', 'limit', 'cursor']) {
    const item = searchParams.get(key);
    if (item !== null && item.length > 0) value[key] = item;
  }
  return businessExceptionListQuerySchema.parse(value);
}

function exceptionListHref(query: BusinessExceptionListQuery, cursor: string): string {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.severity !== undefined) params.set('severity', query.severity);
  if (query.exceptionType !== undefined) params.set('exceptionType', query.exceptionType);
  if (query.resourceScope !== undefined) params.set('resourceScope', query.resourceScope);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('limit', String(query.limit));
  params.set('cursor', cursor);
  return `/exceptions?${params.toString()}`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatEvidenceValue(value: string | number | boolean | null): string {
  return value === null ? 'null' : String(value);
}

function ExceptionListEmpty({ filtered }: Readonly<{ filtered: boolean }>) {
  return <section className="route-state route-empty" data-testid="exception-empty">
    <span>◇</span>
    <div><b>{filtered ? '当前筛选没有匹配异常' : '当前没有可见异常'}</b><p>{filtered ? '筛选结果由 Control Plane 返回；浏览器没有拼接其他页面数据。' : 'Control Plane 当前没有返回该用户可见的异常记录。'}</p>{filtered && <a className="secondary route-action" href="/exceptions">清除筛选</a>}</div>
  </section>;
}

function ExceptionFilters({ query }: Readonly<{ query: BusinessExceptionListQuery }>) {
  return <form className="exception-filters" method="get" action="/exceptions" aria-label="异常列表筛选">
    <label>状态<select name="status" defaultValue={query.status ?? ''}><option value="">全部</option><option value="open">待认领</option><option value="acknowledged">已认领</option></select></label>
    <label>严重度<select name="severity" defaultValue={query.severity ?? ''}><option value="">全部</option><option value="critical">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
    <label>异常类型<select name="exceptionType" defaultValue={query.exceptionType ?? ''}><option value="">全部</option><option value="capacity_progress_lag">产能进度落后</option><option value="equipment_alarm">设备报警</option></select></label>
    <label>资源范围<input name="resourceScope" defaultValue={query.resourceScope ?? ''} placeholder="例如 factory-01/workshop-machining" /></label>
    <label>排序<select name="sort" defaultValue={query.sort}><option value="detectedAt">发现时间</option><option value="severity">严重度</option></select></label>
    <input type="hidden" name="direction" value="desc" />
    <input type="hidden" name="limit" value={String(query.limit)} />
    <button className="primary" type="submit">查询</button>
    <a className="secondary" href="/exceptions">重置</a>
  </form>;
}

export function ExceptionListPage() {
  const query = useMemo(() => exceptionListLocation(window.location.search), []);
  const filtered = query.status !== undefined || query.severity !== undefined || query.exceptionType !== undefined || query.resourceScope !== undefined;
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listBusinessExceptions>>>();

  useEffect(() => {
    let active = true;
    void api.listBusinessExceptions(query).then((value) => {
      if (!active) return;
      setResult(value);
      setState(value.exceptions.length === 0 ? filtered ? 'filtered-empty' : 'empty' : 'ready');
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setState(routeStateForError(cause));
    });
    return () => { active = false; };
  }, [filtered, query]);

  return <ProductShell active="exceptions" title="异常与待办" subtitle="由 Control Plane 授权返回的模拟制造现场异常" state={state} inspector={result === undefined ? undefined : <>
    <dl className="facts">
      <Fact label="Query version" value={result.queryVersion} />
      <Fact label="Snapshot as of" value={formatDateTime(result.asOf)} />
      <Fact label="当前页" value={`${result.exceptions.length} 条`} />
      <Fact label="下一页" value={result.nextCursor === null ? '无' : '可继续'} />
    </dl>
    <SimulationNotice />
  </>}>
    <section className="simulation-banner" aria-label="模拟边界">
      <div><span className="eyebrow">Fixture-only shadow run</span><b>以下记录全部是固定、脱敏的模拟数据</b><p>不可用于真实业务决策，也不会触发真实现场动作。</p></div>
      <SimulationNotice />
    </section>
    <ExceptionFilters query={query} />
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {(state === 'empty' || state === 'filtered-empty') && <ExceptionListEmpty filtered={state === 'filtered-empty'} />}
    {state === 'ready' && result !== undefined && <section className="table-card exception-table-card">
      <div className="section-heading"><div><span className="eyebrow">BusinessException projection</span><h2>当前页异常</h2></div><span>{result.exceptions.length} 条服务端记录</span></div>
      <div className="table-scroll"><table className="product-table exception-table" data-testid="exception-table"><thead><tr><th>异常</th><th>严重度</th><th>状态</th><th>资源范围</th><th>发现时间</th><th>边界</th></tr></thead><tbody>
        {result.exceptions.map((item) => <tr key={item.id} data-exception-id={item.id} data-aggregate-version={item.aggregateVersion}>
          <td><a href={`/exceptions/${encodeURIComponent(item.id)}`}><b>{item.summary}</b><small>{EXCEPTION_TYPE_LABELS[item.exceptionType]} · {item.id}</small></a></td>
          <td><span className={`exception-severity severity-${item.severity}`}>{SEVERITY_LABELS[item.severity]}</span></td>
          <td><span className={`status status-${item.status}`}>{STATUS_LABELS[item.status]}</span></td>
          <td><code className="scope-code">{item.resourceScope}</code><small className="data-class">{item.dataClass}</small></td>
          <td>{formatDateTime(item.detectedAt)}</td>
          <td><span className="simulation-chip">模拟</span></td>
        </tr>)}
      </tbody></table></div>
      <nav className="pagination" aria-label="异常列表分页">
        {query.cursor === undefined ? <span className="pagination-disabled">上一页</span> : <button className="secondary" type="button" onClick={() => history.back()}>上一页</button>}
        {result.nextCursor === null ? <span className="pagination-disabled">下一页</span> : <a className="secondary" data-testid="exception-next-page" href={exceptionListHref(query, result.nextCursor)}>下一页</a>}
      </nav>
    </section>}
  </ProductShell>;
}

function AnalysisBinding({ binding }: Readonly<{ binding: CreateExceptionAnalysisTaskResponse }>) {
  return <section className="detail-card analysis-binding" data-testid="exception-analysis-binding" data-task-id={binding.taskId} data-workflow-id={binding.workflowVersion.id} data-workflow-hash={binding.workflowVersion.hash}>
    <div className="section-heading"><div><span className="eyebrow">Authority binding</span><h2>小纬已创建唯一绑定任务</h2></div><span className="simulation-chip">模拟任务</span></div>
    <div className="binding-grid">
      <div><span>BusinessTask</span><a href={`/tasks/${encodeURIComponent(binding.taskId)}`}>{binding.taskId}</a><small>前往审批并执行</small></div>
      <div><span>Conversation</span><a href={`/conversations/${encodeURIComponent(binding.conversationId)}`}>{binding.conversationId}</a><small>客户消息作者仍只有小纬</small></div>
      <div><span>Task Workflow</span><a href={`/tasks/${encodeURIComponent(binding.taskId)}/workflow`}>{binding.workflowVersion.id}</a><small>任务范围投影</small></div>
    </div>
    <div className="immutable-digests">
      <div><span>WorkflowVersion hash</span><a href={`/workflows/${encodeURIComponent(binding.workflowVersion.id)}`}>{binding.workflowVersion.id}</a><code data-testid="exception-workflow-hash">{binding.workflowVersion.hash}</code></div>
      <div><span>ApprovalSubject digest</span><b>独立审批主题摘要</b><code data-testid="exception-approval-subject-digest">{binding.approvalSubjectDigest}</code></div>
    </div>
    <SimulationNotice />
  </section>;
}

function ExceptionInspector({ detail }: Readonly<{ detail: BusinessExceptionDetail }>) {
  return <>
    <dl className="facts">
      <Fact label="BusinessException" value={detail.id} />
      <Fact label="Aggregate version" value={detail.aggregateVersion} />
      <Fact label="Source object" value={detail.sourceObjectRef} />
      <Fact label="Source state" value={detail.ownerDisplayState} />
      <Fact label="Analysis state" value={detail.analysisDisplayState} />
      <Fact label="Data class" value={detail.dataClass} />
    </dl>
    <SimulationNotice />
  </>;
}

export function ExceptionDetailPage({ exceptionId }: Readonly<{ exceptionId: string }>) {
  const [state, setState] = useState<RouteState>('loading');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<BusinessExceptionDetail>();
  const [expertTargetChoice, setExpertTargetChoice] = useState<ExpertTargetChoice>('auto');
  const [acting, setActing] = useState<'acknowledge' | 'analysis' | null>(null);
  const [binding, setBinding] = useState<CreateExceptionAnalysisTaskResponse>();

  const loadDetail = useCallback(async () => {
    const value = await api.getBusinessException(exceptionId);
    setDetail(value);
    setState('ready');
    return value;
  }, [exceptionId]);

  useEffect(() => {
    let active = true;
    void api.getBusinessException(exceptionId).then((value) => {
      if (active) { setDetail(value); setState('ready'); }
    }).catch((cause: unknown) => {
      if (active) {
        const nextState = routeStateForError(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
        if (isFailClosedRouteState(nextState)) { setDetail(undefined); setBinding(undefined); }
        setState(nextState);
      }
    });
    return () => { active = false; };
  }, [exceptionId]);

  const acknowledge = useCallback(async () => {
    if (detail === undefined) return;
    setActing('acknowledge');
    setError('');
    try {
      const value = await api.acknowledgeBusinessException(detail.id, detail.aggregateVersion);
      setDetail(value);
    } catch (cause) {
      const nextState = routeStateForError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (isFailClosedRouteState(nextState)) { setDetail(undefined); setBinding(undefined); }
      setState(nextState);
    } finally {
      setActing(null);
    }
  }, [detail]);

  const requestAnalysis = useCallback(async () => {
    if (detail === undefined) return;
    setActing('analysis');
    setError('');
    try {
      const value = await api.createExceptionAnalysisTask(detail.id, detail.aggregateVersion, EXPERT_TARGETS[expertTargetChoice]);
      setBinding(value);
      await loadDetail();
    } catch (cause) {
      const nextState = routeStateForError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (isFailClosedRouteState(nextState)) { setDetail(undefined); setBinding(undefined); }
      setState(nextState);
    } finally {
      setActing(null);
    }
  }, [detail, expertTargetChoice, loadDetail]);

  const analysisAlreadyBound = detail?.analysisDisplayState === 'task_bound' || binding !== undefined;
  const canAnalyze = detail?.ownerDisplayState === 'mine' && !analysisAlreadyBound;

  return <ProductShell active="exceptions" title="异常详情" subtitle="版本固定的来源、Evidence、认领与小纬分析入口" state={state} inspector={detail === undefined ? undefined : <ExceptionInspector detail={detail} />}>
    {state === 'loading' && <LoadingState />}
    <RouteFailure state={state} message={error} />
    {detail !== undefined && !isFailClosedRouteState(state) && <div className="detail-stack exception-detail" data-testid="exception-detail" data-exception-id={detail.id} data-aggregate-version={detail.aggregateVersion}>
      <section className="detail-hero exception-hero">
        <div><span className="eyebrow">{EXCEPTION_TYPE_LABELS[detail.exceptionType]} · {detail.id}</span><h2>{detail.summary}</h2><p>{detail.resourceScope} · {detail.dataClass} · {formatDateTime(detail.detectedAt)}</p></div>
        <div className="exception-hero-status"><span className={`exception-severity severity-${detail.severity}`}>{SEVERITY_LABELS[detail.severity]}</span><span className={`status status-${detail.status}`}>{STATUS_LABELS[detail.status]}</span><span className="simulation-chip">固定模拟数据</span></div>
      </section>
      <section className="simulation-banner"><div><span className="eyebrow">Simulation boundary</span><b>小纬只进行影子分析</b><p>当前能力是 fixture-only + fake，结果不可用于真实业务决策。</p></div><SimulationNotice /></section>
      <section className="detail-card exception-source-card">
        <div className="section-heading"><div><span className="eyebrow">BusinessExceptionSourceSnapshot</span><h2>异常来源与检测窗口</h2></div><span>aggregate v{detail.aggregateVersion}</span></div>
        <dl className="source-facts"><Fact label="Source object ref" value={detail.sourceObjectRef} /><Fact label="Detection window" value={detail.detectionWindow} /><Fact label="Owner projection" value={detail.ownerDisplayState} /><Fact label="Acknowledged at" value={detail.acknowledgedAt === null ? '尚未认领' : formatDateTime(detail.acknowledgedAt)} /></dl>
      </section>
      <section className="detail-card">
        <div className="section-heading"><div><span className="eyebrow">Source Evidence</span><h2>版本固定的证据字段</h2></div><span>{detail.evidence.length} 条来源投影</span></div>
        <div className="source-evidence-grid" data-testid="exception-source-evidence">{detail.evidence.map((evidence) => <article key={`${evidence.sourceVersionId}:${evidence.jsonPointer}`} data-source-version-id={evidence.sourceVersionId}>
          <span>{evidence.jsonPointer}</span><b>{formatEvidenceValue(evidence.value)}</b><small>{evidence.canonicalizationVersion}</small><code title="source sha256">source {evidence.sourceSha256}</code><code title="value sha256">value {evidence.valueSha256}</code>
        </article>)}</div>
      </section>
      <section className="task-action-bar exception-action-bar" aria-label="异常认领">
        <div><b>认领待办</b><p>使用当前 aggregateVersion 提交；Control Plane 仍是认领状态权威。</p></div>
        {detail.ownerDisplayState === 'unassigned'
          ? <button className="primary" type="button" data-testid="exception-acknowledge" disabled={acting !== null} onClick={() => void acknowledge()}>{acting === 'acknowledge' ? '正在认领…' : '认领此模拟异常'}</button>
          : <span className={`owner-state owner-${detail.ownerDisplayState}`}>{detail.ownerDisplayState === 'mine' ? '已由我认领' : '已由其他成员认领'}</span>}
      </section>
      <section className="detail-card analysis-request-card">
        <div className="section-heading"><div><span className="eyebrow">operations.exception-assist.v1</span><h2>让小纬分析</h2></div><span>ExpertTarget 不改变 Workflow hash</span></div>
        <div className="analysis-request-row">
          <label>专家路线<select aria-label="异常专家路线" value={expertTargetChoice} disabled={!canAnalyze || acting !== null} onChange={(event) => setExpertTargetChoice(event.target.value as ExpertTargetChoice)}><option value="auto">小纬自动安排</option><option value="expert">运营异常分析专家</option><option value="team">异常分析专家团</option></select><small>只提交 requested target；服务端负责目录校验与解析。</small></label>
          <button className="primary" type="button" data-testid="exception-request-analysis" disabled={!canAnalyze || acting !== null} onClick={() => void requestAnalysis()}>{acting === 'analysis' ? '小纬正在创建任务…' : analysisAlreadyBound ? '已绑定分析任务' : '让小纬分析'}</button>
        </div>
        {detail.ownerDisplayState !== 'mine' && <p className="muted-copy">先认领此待办，才能以当前版本请求分析。</p>}
        {analysisAlreadyBound && binding === undefined && <p className="bound-recovery-note">Control Plane 显示此异常已绑定任务。刷新后请从 <a href="/tasks">我的任务</a> 恢复同一服务端对象。</p>}
      </section>
      {error.length > 0 && <div className="error" role="alert">{error}</div>}
      {binding !== undefined && <AnalysisBinding binding={binding} />}
    </div>}
  </ProductShell>;
}
