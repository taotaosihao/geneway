import {
  approvalProjectionSchema,
  acknowledgeBusinessExceptionInputSchema,
  artifactIngestResponseSchema,
  businessExceptionDetailSchema,
  businessExceptionListQuerySchema,
  businessExceptionListResponseSchema,
  conversationProjectionSchema,
  createExceptionAnalysisTaskInputSchema,
  createExceptionAnalysisTaskResponseSchema,
  chatRunEventSchema,
  chatRunProjectionSchema,
  cancelChatRunProjectionSchema,
  documentSnapshotListSchema,
  documentSnapshotProjectionSchema,
  evidenceProjectionSchema,
  executeTaskInputSchema,
  taskEventProjectionSchema,
  taskListResponseSchema,
  taskSnapshotSchema,
  workflowDetailProjectionSchema,
  workflowListResponseSchema,
  gateACapabilityRouteProjectionSchema,
  gateADocumentExecutionEligibilitySchema,
  gateALiveCancelTaskResponseSchema,
  gateALiveEvidenceProjectionSchema,
  gateALiveExecuteTaskResponseSchema,
  gateALiveTaskCreateResponseSchema,
  gateALiveTaskEventProjectionSchema,
  gateALiveTaskListItemSchema,
  gateALiveTaskSnapshotSchema,
  gateALiveWorkflowDetailProjectionSchema,
  gateA3CreateTaskInputVariantSchema,
  gateA3PublicEvidenceProjectionSchema,
  gateA3PublicTaskSnapshotSchema,
  type ApprovalProjection,
  type BusinessExceptionDetail,
  type BusinessExceptionListQuery,
  type BusinessExceptionListResponse,
  type ArtifactIngestResponse,
  type ConversationProjection,
  type ChatRunEvent,
  type ChatRunProjection,
  type CancelChatRunProjection,
  type CreateTaskInput,
  type CreateExceptionAnalysisTaskResponse,
  type DocumentSnapshotList,
  type EvidenceProjection,
  type GateACapabilityRouteProjection,
  type GateADocumentExecutionEligibility,
  type GateALiveEvidenceProjection,
  type GateALiveTaskCreateResponse,
  type GateALiveTaskEventProjection,
  type GateALiveTaskSnapshot,
  type GateALiveWorkflowDetailProjection,
  type GateA3PublicTaskSnapshot,
  type GateA3PublicEvidenceProjection,
  type ExpertTarget,
  type TaskListQuery,
  type TaskListResponse,
  type TaskEventProjection,
  type TaskSnapshot,
  type WorkflowDetailProjection,
  type WorkflowListQuery,
  type WorkflowListResponse,
} from '@geneway/contracts';

export type CreatedTask = Readonly<{
  taskId: string;
  approvalId: string;
  workflowVersionId: string;
  workflowHash: string;
}>;

export type LegacySimulationCapabilityRoute = Readonly<{
  capabilityId: 'solution.analysis.v1';
  status: 'legacy-simulation';
  executionRoute: 'simulation';
  availableExpertModes: readonly ['auto', 'expert', 'team'];
}>;

export type AnalysisCapabilityRoute = GateACapabilityRouteProjection | LegacySimulationCapabilityRoute;
export type PublicTask = TaskSnapshot | GateALiveTaskSnapshot;
export type PublicTaskEvent = TaskEventProjection | GateALiveTaskEventProjection;
export type PublicWorkflow = WorkflowDetailProjection | GateALiveWorkflowDetailProjection;
export type PublicEvidence = EvidenceProjection | GateALiveEvidenceProjection;
export type PublicCreatedTask = CreatedTask | GateALiveTaskCreateResponse;
export type GateALiveTaskListItem = ReturnType<typeof gateALiveTaskListItemSchema.parse>;
export type PublicTaskListItem = TaskListResponse['tasks'][number] | GateALiveTaskListItem;
export type PublicTaskListResponse = Omit<TaskListResponse, 'tasks'> & Readonly<{ tasks: readonly PublicTaskListItem[] }>;
export type DocumentSnapshotView = Omit<DocumentSnapshotList['documentSnapshots'][number], 'executionEligibility'> & Readonly<{
  executionEligibility: GateADocumentExecutionEligibility;
}>;
export type DocumentSnapshotViewList = Readonly<{ documentSnapshots: readonly DocumentSnapshotView[] }>;

export type Conversation = ConversationProjection;
export type Workflow = PublicWorkflow;
export type Approval = ApprovalProjection;

export type WorkOrderCapabilityRoute = Readonly<{
  capabilityId: 'production.work-order-status.v1';
  status: 'internal' | 'NOT_OPEN';
  executionRoute: 'live' | 'not_open';
}>;

export type CreatedWorkOrderTask = Readonly<{
  taskId: string;
  approvalId: string;
  workflowVersionId: string;
  workflowHash: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkOrderCapabilityRoute(value: unknown): WorkOrderCapabilityRoute {
  if (!isRecord(value) || value.capabilityId !== 'production.work-order-status.v1') {
    throw new Error('WORK_ORDER_CAPABILITY_ROUTE_INVALID');
  }
  const allowedKeys = new Set([
    'capabilityId', 'status', 'executionRoute', 'capabilityVersionId', 'simulation',
    'runtimeMode', 'businessDecisionAllowed', 'internalAcceptance', 'reason',
  ]);
  if (Object.keys(value).some((field) => !allowedKeys.has(field))) {
    throw new Error('WORK_ORDER_CAPABILITY_ROUTE_INVALID');
  }
  if (value.status === 'NOT_OPEN' && value.executionRoute === 'not_open') {
    return { capabilityId: value.capabilityId, status: value.status, executionRoute: value.executionRoute };
  }
  if (value.status === 'internal' && value.executionRoute === 'live'
    && value.simulation === false && value.runtimeMode === 'model_gateway'
    && value.businessDecisionAllowed === false && value.internalAcceptance === true) {
    return { capabilityId: value.capabilityId, status: value.status, executionRoute: value.executionRoute };
  }
  throw new Error('WORK_ORDER_CAPABILITY_ROUTE_INVALID');
}

export function parseCreatedWorkOrderTask(value: unknown): CreatedWorkOrderTask {
  const allowedKeys = new Set(['taskId', 'approvalId', 'workflowVersionId', 'workflowHash']);
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.approvalId !== 'string'
    || typeof value.workflowVersionId !== 'string' || typeof value.workflowHash !== 'string'
    || value.taskId.length === 0 || value.approvalId.length === 0 || value.workflowVersionId.length === 0
    || !/^[a-f0-9]{64}$/u.test(value.workflowHash)
    || Object.keys(value).some((field) => !allowedKeys.has(field))) {
    throw new Error('WORK_ORDER_TASK_CREATE_PROJECTION_INVALID');
  }
  return {
    taskId: value.taskId,
    approvalId: value.approvalId,
    workflowVersionId: value.workflowVersionId,
    workflowHash: value.workflowHash,
  };
}

function parseTask(value: unknown): PublicTask {
  return isRecord(value) && value.recordVariant === 'business-task.live/1'
    ? gateALiveTaskSnapshotSchema.parse(value)
    : taskSnapshotSchema.parse(value);
}

function parseTaskEvent(value: unknown): PublicTaskEvent {
  return isRecord(value) && value.recordVariant === 'business-task-event.live/1'
    ? gateALiveTaskEventProjectionSchema.parse(value)
    : taskEventProjectionSchema.parse(value);
}

function parseWorkflow(value: unknown): PublicWorkflow {
  return isRecord(value) && value.recordVariant === 'workflow-read-model.live/1'
    ? gateALiveWorkflowDetailProjectionSchema.parse(value)
    : workflowDetailProjectionSchema.parse(value);
}

function parseEvidence(value: unknown): PublicEvidence {
  return isRecord(value) && value.recordVariant === 'evidence.live/1'
    ? gateALiveEvidenceProjectionSchema.parse(value)
    : evidenceProjectionSchema.parse(value);
}

export function parseWorkOrderEvidence(value: unknown): GateA3PublicEvidenceProjection {
  return gateA3PublicEvidenceProjectionSchema.parse(value);
}

function parseLegacyCapabilityRoute(value: unknown): LegacySimulationCapabilityRoute | undefined {
  if (!isRecord(value) || value.id !== 'solution.analysis.v1' || value.simulation !== true
    || value.runtimeMode !== 'fake' || value.businessDecisionAllowed !== false) return undefined;
  return {
    capabilityId: 'solution.analysis.v1', status: 'legacy-simulation', executionRoute: 'simulation',
    availableExpertModes: ['auto', 'expert', 'team'],
  };
}

function parseDocumentSnapshotViews(value: unknown): DocumentSnapshotViewList {
  const legacy = documentSnapshotListSchema.safeParse(value);
  if (legacy.success) {
    return {
      documentSnapshots: legacy.data.documentSnapshots.map((projection): DocumentSnapshotView => ({
        ...projection,
        executionEligibility: projection.executionEligibility.eligible
          ? {
              route: 'simulation', eligible: true, simulationProfile: 'solution-analysis-demo/v2',
              simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
            }
          : { route: 'not_open', eligible: false, reason: 'PROFILE_NOT_RECOGNIZED' },
      })),
    };
  }
  if (!isRecord(value) || !Array.isArray(value.documentSnapshots)) {
    throw new Error('DOCUMENT_SNAPSHOT_PROJECTION_INVALID');
  }
  return {
    documentSnapshots: value.documentSnapshots.map((raw): DocumentSnapshotView => {
      if (!isRecord(raw)) throw new Error('DOCUMENT_SNAPSHOT_PROJECTION_INVALID');
      const eligibility = gateADocumentExecutionEligibilitySchema.parse(raw.executionEligibility);
      const base = documentSnapshotProjectionSchema.parse({
        ...raw,
        executionEligibility: eligibility.eligible
          ? { eligible: true }
          : { eligible: false, reason: 'PROFILE_NOT_RECOGNIZED' },
      });
      return { ...base, executionEligibility: eligibility };
    }),
  };
}

function parseTaskList(value: unknown): PublicTaskListResponse {
  const legacy = taskListResponseSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  if (!isRecord(value) || !Array.isArray(value.tasks)) throw new Error('TASK_LIST_PROJECTION_INVALID');
  const envelope = taskListResponseSchema.parse({ ...value, tasks: [] });
  const tasks = value.tasks.map((raw): PublicTaskListItem => {
    if (isRecord(raw) && raw.recordVariant === 'business-task.live/1') {
      return gateALiveTaskListItemSchema.parse(raw);
    }
    return taskListResponseSchema.parse({ ...envelope, tasks: [raw] }).tasks[0]!;
  });
  return { ...envelope, tasks };
}

function parseCreatedTask(value: unknown): PublicCreatedTask {
  if (isRecord(value) && value.recordVariant === 'business-task.live/1') {
    return gateALiveTaskCreateResponseSchema.parse(value);
  }
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.approvalId !== 'string'
    || typeof value.workflowVersionId !== 'string' || typeof value.workflowHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.workflowHash)) throw new Error('TASK_CREATE_PROJECTION_INVALID');
  return {
    taskId: value.taskId, approvalId: value.approvalId,
    workflowVersionId: value.workflowVersionId, workflowHash: value.workflowHash,
  };
}

const key = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${nonce}`;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError('NETWORK_OFFLINE', 'Control Plane 当前不可连接', 0, { cause });
  }
  const payload = await response.json().catch(() => ({})) as T & {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok && response.headers.get('x-geneway-upstream-status') === 'offline') {
    throw new ApiError('NETWORK_OFFLINE', 'Control Plane 当前不可连接', response.status);
  }
  if (!response.ok) throw new ApiError(
    payload.error?.code ?? 'REQUEST_FAILED',
    payload.error?.message ?? response.statusText,
    response.status,
    { details: payload.error?.details },
  );
  return payload;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options?: ErrorOptions & Readonly<{ details?: unknown }>,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ApiError';
    this.details = options?.details;
  }

  readonly details: unknown;
}

export function apiErrorCode(cause: unknown): string {
  return cause instanceof ApiError ? cause.code : 'REQUEST_FAILED';
}

export function apiErrorStatus(cause: unknown): number | undefined {
  return cause instanceof ApiError ? cause.status : undefined;
}

export function mergeTaskEventBatch(
  taskId: string,
  afterCursor: number,
  incoming: readonly PublicTaskEvent[],
): Readonly<{ events: readonly PublicTaskEvent[]; cursor: number }> {
  const byCursor = new Map<number, PublicTaskEvent>();
  const ids = new Set<string>();
  for (const event of incoming) {
    if (event.businessTaskId !== taskId) throw new Error('TASK_EVENT_TASK_MISMATCH');
    if (event.cursor <= afterCursor) continue;
    const existing = byCursor.get(event.cursor);
    if (existing !== undefined && existing.id !== event.id) throw new Error('TASK_EVENT_CURSOR_COLLISION');
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    byCursor.set(event.cursor, event);
  }
  const events = [...byCursor.values()].sort((left, right) => left.cursor - right.cursor);
  return { events, cursor: events.at(-1)?.cursor ?? afterCursor };
}

export const api = {
  createConversation: () => request<{ id: string }>('/api/conversations', {
    method: 'POST', headers: { 'idempotency-key': key('conversation') },
  }),
  addMessage: (conversationId: string, body: string) => request<{ id: string }>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('message') }, body: JSON.stringify({ body }),
  }),
  getConversation: async (conversationId: string): Promise<Conversation> =>
    conversationProjectionSchema.parse(await request(`/api/conversations/${conversationId}`)),
  createChatRun: async (conversationId: string, content: string): Promise<ChatRunProjection> =>
    chatRunProjectionSchema.parse(await request(`/api/conversations/${conversationId}/chat-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key('chat-run') },
      body: JSON.stringify({ capabilityId: 'xiaowei.chat.v1', content, clientMessageId: key('message') }),
    })),
  chatEvents: async (conversationId: string, modelInvocationId: string, cursor: number): Promise<readonly ChatRunEvent[]> => {
    const response = await fetch(`/api/conversations/${conversationId}/chat-runs/${modelInvocationId}/events?cursor=${String(cursor)}`, {
      headers: { accept: 'text/event-stream' },
    });
    if (!response.ok) {
      const payload = await response.json() as { error?: { code?: string; message?: string } };
      throw new Error(`${payload.error?.code ?? 'REQUEST_FAILED'}: ${payload.error?.message ?? response.statusText}`);
    }
    const text = await response.text();
    return text.split('\n\n').flatMap((block) => {
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      return data === undefined ? [] : [chatRunEventSchema.parse(JSON.parse(data.slice('data: '.length)))];
    });
  },
  cancelChatRun: async (conversationId: string, modelInvocationId: string): Promise<CancelChatRunProjection> =>
    cancelChatRunProjectionSchema.parse(await request(
      `/api/conversations/${conversationId}/chat-runs/${modelInvocationId}/cancel`,
      { method: 'POST', headers: { 'idempotency-key': key('chat-cancel') } },
    )),
  uploadArtifact: async (conversationId: string, file: File): Promise<ArtifactIngestResponse> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return artifactIngestResponseSchema.parse(await request(`/api/conversations/${conversationId}/uploads`, {
      method: 'POST', headers: { 'idempotency-key': key('artifact') }, body: form,
    }));
  },
  getDocumentSnapshots: async (conversationId: string): Promise<DocumentSnapshotViewList> =>
    parseDocumentSnapshotViews(await request(`/api/conversations/${conversationId}/document-snapshots`)),
  getAnalysisCapabilityRoute: async (): Promise<AnalysisCapabilityRoute> => {
    const value = await request('/api/capabilities/solution.analysis.v1');
    const live = gateACapabilityRouteProjectionSchema.safeParse(value);
    if (live.success) return live.data;
    const legacy = parseLegacyCapabilityRoute(value);
    if (legacy !== undefined) return legacy;
    throw new Error('CAPABILITY_ROUTE_PROJECTION_INVALID');
  },
  getWorkOrderCapabilityRoute: async (): Promise<WorkOrderCapabilityRoute> =>
    parseWorkOrderCapabilityRoute(await request('/api/capabilities/production.work-order-status.v1')),
  createWorkOrderTask: async (conversationId: string, workOrderRef: string): Promise<CreatedWorkOrderTask> => {
    const input = gateA3CreateTaskInputVariantSchema.parse({
      conversationId,
      capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef },
    });
    return parseCreatedWorkOrderTask(await request('/api/business-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key('work-order-task') },
      body: JSON.stringify(input),
    }));
  },
  getWorkOrderTask: async (taskId: string): Promise<GateA3PublicTaskSnapshot> =>
    gateA3PublicTaskSnapshotSchema.parse(await request(`/api/business-tasks/${taskId}`)),
  createTask: (conversationId: string, documentSnapshotId: string, expertTarget: ExpertTarget) => {
    const input: CreateTaskInput = {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId },
      expertTarget,
    };
    return request('/api/business-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('task') }, body: JSON.stringify(input),
    }).then(parseCreatedTask);
  },
  getTask: async (taskId: string): Promise<PublicTask> => parseTask(await request(`/api/business-tasks/${taskId}`)),
  listTasks: async (query: Partial<TaskListQuery> = {}): Promise<PublicTaskListResponse> => {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.capabilityId !== undefined) params.set('capabilityId', query.capabilityId);
    if (query.sort !== undefined) params.set('sort', query.sort);
    if (query.direction !== undefined) params.set('direction', query.direction);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return parseTaskList(await request(`/api/business-tasks${suffix}`));
  },
  listBusinessExceptions: async (query: Partial<BusinessExceptionListQuery> = {}): Promise<BusinessExceptionListResponse> => {
    const parsed = businessExceptionListQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsed.status !== undefined) params.set('status', parsed.status);
    if (parsed.severity !== undefined) params.set('severity', parsed.severity);
    if (parsed.exceptionType !== undefined) params.set('exceptionType', parsed.exceptionType);
    if (parsed.resourceScope !== undefined) params.set('resourceScope', parsed.resourceScope);
    params.set('sort', parsed.sort);
    params.set('direction', parsed.direction);
    params.set('limit', String(parsed.limit));
    if (parsed.cursor !== undefined) params.set('cursor', parsed.cursor);
    return businessExceptionListResponseSchema.parse(await request(`/api/business-exceptions?${params.toString()}`));
  },
  getBusinessException: async (exceptionId: string): Promise<BusinessExceptionDetail> =>
    businessExceptionDetailSchema.parse(await request(`/api/business-exceptions/${encodeURIComponent(exceptionId)}`)),
  acknowledgeBusinessException: async (exceptionId: string, aggregateVersion: number): Promise<BusinessExceptionDetail> => {
    const input = acknowledgeBusinessExceptionInputSchema.parse({ aggregateVersion });
    return businessExceptionDetailSchema.parse(await request(`/api/business-exceptions/${encodeURIComponent(exceptionId)}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key('exception-acknowledge') },
      body: JSON.stringify(input),
    }));
  },
  createExceptionAnalysisTask: async (
    exceptionId: string,
    aggregateVersion: number,
    requestedExpertTarget: ExpertTarget,
  ): Promise<CreateExceptionAnalysisTaskResponse> => {
    const idempotencyKey = key('exception-analysis');
    const input = createExceptionAnalysisTaskInputSchema.parse({ aggregateVersion, requestedExpertTarget, idempotencyKey });
    return createExceptionAnalysisTaskResponseSchema.parse(await request(`/api/business-exceptions/${encodeURIComponent(exceptionId)}/analysis-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    }));
  },
  getEvidence: async (evidenceId: string): Promise<PublicEvidence> => parseEvidence(await request(`/api/evidence/${evidenceId}`)),
  getWorkOrderEvidence: async (evidenceId: string): Promise<GateA3PublicEvidenceProjection> =>
    parseWorkOrderEvidence(await request(`/api/evidence/${evidenceId}`)),
  getWorkflow: async (id: string): Promise<Workflow> =>
    parseWorkflow(await request(`/api/workflow-versions/${id}`)),
  listWorkflows: async (query: Partial<WorkflowListQuery> = {}): Promise<WorkflowListResponse> => {
    const params = new URLSearchParams();
    if (query.capabilityVersionId !== undefined) params.set('capabilityVersionId', query.capabilityVersionId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return workflowListResponseSchema.parse(await request(`/api/workflow-versions${suffix}`));
  },
  getApproval: async (id: string): Promise<Approval> =>
    approvalProjectionSchema.parse(await request(`/api/approvals/${id}`)),
  approve: (id: string) => request<{ approvalId: string; status: string }>(`/api/approvals/${id}/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('approval') }, body: JSON.stringify({ decision: 'approved' }),
  }),
  execute: (taskId: string, approval: Pick<ApprovalProjection, 'version' | 'subjectDigest'>) => request(`/api/business-tasks/${taskId}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('execute') },
    body: JSON.stringify(executeTaskInputSchema.parse({
      expectedApprovalVersion: approval.version,
      expectedApprovalSubjectDigest: approval.subjectDigest,
    })),
  }).then((value) => isRecord(value) && value.recordVariant === 'business-task.live/1'
    ? gateALiveExecuteTaskResponseSchema.parse(value) : value),
  cancelTask: (taskId: string) => request(`/api/business-tasks/${taskId}/cancel`, {
    method: 'POST', headers: { 'idempotency-key': key('cancel') },
  }).then((value) => isRecord(value) && value.recordVariant === 'business-task.live/1'
    ? gateALiveCancelTaskResponseSchema.parse(value) : value),
  events: async (taskId: string, afterCursor: number) => {
    let response: Response;
    try {
      response = await fetch(`/api/business-tasks/${taskId}/events?after=${String(afterCursor)}`, { headers: { accept: 'text/event-stream' } });
    } catch (cause) {
      throw new ApiError('NETWORK_OFFLINE', 'Task event stream 当前不可连接', 0, { cause });
    }
    if (!response.ok && response.headers.get('x-geneway-upstream-status') === 'offline') {
      throw new ApiError('NETWORK_OFFLINE', 'Task event stream 当前不可连接', response.status);
    }
    if (!response.ok) throw new ApiError('EVENT_STREAM_FAILED', response.statusText, response.status);
    const text = await response.text();
    return [...text.matchAll(/^data: (.+)$/gm)].map((match) => parseTaskEvent(JSON.parse(match[1] ?? '{}')));
  },
};
