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
  evidenceProjectionSchema,
  executeTaskInputSchema,
  taskEventProjectionSchema,
  taskListResponseSchema,
  taskSnapshotSchema,
  workflowDetailProjectionSchema,
  workflowListResponseSchema,
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

export type Conversation = ConversationProjection;
export type Workflow = WorkflowDetailProjection;
export type Approval = ApprovalProjection;

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
  const payload = await response.json().catch(() => ({})) as T & { error?: { code?: string; message?: string } };
  if (!response.ok && response.headers.get('x-geneway-upstream-status') === 'offline') {
    throw new ApiError('NETWORK_OFFLINE', 'Control Plane 当前不可连接', response.status);
  }
  if (!response.ok) throw new ApiError(
    payload.error?.code ?? 'REQUEST_FAILED',
    payload.error?.message ?? response.statusText,
    response.status,
  );
  return payload;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ApiError';
  }
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
  incoming: readonly TaskEventProjection[],
): Readonly<{ events: readonly TaskEventProjection[]; cursor: number }> {
  const byCursor = new Map<number, TaskEventProjection>();
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
  getDocumentSnapshots: async (conversationId: string): Promise<DocumentSnapshotList> =>
    documentSnapshotListSchema.parse(await request(`/api/conversations/${conversationId}/document-snapshots`)),
  createTask: (conversationId: string, documentSnapshotId: string, expertTarget: ExpertTarget) => {
    const input: CreateTaskInput = {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId },
      expertTarget,
    };
    return request<CreatedTask>('/api/business-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('task') }, body: JSON.stringify(input),
    });
  },
  getTask: async (taskId: string): Promise<TaskSnapshot> => taskSnapshotSchema.parse(await request(`/api/business-tasks/${taskId}`)),
  listTasks: async (query: Partial<TaskListQuery> = {}): Promise<TaskListResponse> => {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.capabilityId !== undefined) params.set('capabilityId', query.capabilityId);
    if (query.sort !== undefined) params.set('sort', query.sort);
    if (query.direction !== undefined) params.set('direction', query.direction);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return taskListResponseSchema.parse(await request(`/api/business-tasks${suffix}`));
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
  getEvidence: async (evidenceId: string): Promise<EvidenceProjection> => evidenceProjectionSchema.parse(await request(`/api/evidence/${evidenceId}`)),
  getWorkflow: async (id: string): Promise<Workflow> =>
    workflowDetailProjectionSchema.parse(await request(`/api/workflow-versions/${id}`)),
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
  execute: (taskId: string, approval: Pick<ApprovalProjection, 'version' | 'subjectDigest'>) => request<{ taskId: string; status: string }>(`/api/business-tasks/${taskId}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('execute') },
    body: JSON.stringify(executeTaskInputSchema.parse({
      expectedApprovalVersion: approval.version,
      expectedApprovalSubjectDigest: approval.subjectDigest,
    })),
  }),
  cancelTask: (taskId: string) => request<{ taskId: string; status: 'canceled' }>(`/api/business-tasks/${taskId}/cancel`, {
    method: 'POST', headers: { 'idempotency-key': key('cancel') },
  }),
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
    return [...text.matchAll(/^data: (.+)$/gm)].map((match) => taskEventProjectionSchema.parse(JSON.parse(match[1] ?? '{}')));
  },
};
