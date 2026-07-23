import {
  approvalProjectionSchema,
  artifactIngestResponseSchema,
  conversationProjectionSchema,
  chatRunEventSchema,
  chatRunProjectionSchema,
  documentSnapshotListSchema,
  evidenceProjectionSchema,
  taskEventProjectionSchema,
  taskListResponseSchema,
  taskSnapshotSchema,
  workflowDetailProjectionSchema,
  workflowListResponseSchema,
  type ApprovalProjection,
  type ArtifactIngestResponse,
  type ConversationProjection,
  type ChatRunEvent,
  type ChatRunProjection,
  type CreateTaskInput,
  type DocumentSnapshotList,
  type EvidenceProjection,
  type ExpertTarget,
  type TaskListQuery,
  type TaskListResponse,
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

const key = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`${payload.error?.code ?? 'REQUEST_FAILED'}: ${payload.error?.message ?? response.statusText}`);
  return payload;
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
  getEvidence: async (evidenceId: string): Promise<EvidenceProjection> => evidenceProjectionSchema.parse(await request(`/api/evidence/${evidenceId}`)),
  getWorkflow: async (id: string): Promise<Workflow> =>
    workflowDetailProjectionSchema.parse(await request(`/api/workflow-versions/${id}`)),
  listWorkflows: async (query: Partial<WorkflowListQuery> = {}): Promise<WorkflowListResponse> => {
    const params = new URLSearchParams();
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
  execute: (taskId: string) => request<{ taskId: string; status: string }>(`/api/business-tasks/${taskId}/execute`, {
    method: 'POST', headers: { 'idempotency-key': key('execute') },
  }),
  cancelTask: (taskId: string) => request<{ taskId: string; status: 'canceled' }>(`/api/business-tasks/${taskId}/cancel`, {
    method: 'POST', headers: { 'idempotency-key': key('cancel') },
  }),
  events: async (taskId: string, afterCursor: number) => {
    const response = await fetch(`/api/business-tasks/${taskId}/events?after=${String(afterCursor)}`, { headers: { accept: 'text/event-stream' } });
    if (!response.ok) throw new Error(`EVENT_STREAM_FAILED: ${response.statusText}`);
    const text = await response.text();
    return [...text.matchAll(/^data: (.+)$/gm)].map((match) => taskEventProjectionSchema.parse(JSON.parse(match[1] ?? '{}')));
  },
};
