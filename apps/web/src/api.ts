import {
  artifactIngestResponseSchema,
  documentSnapshotListSchema,
  taskSnapshotSchema,
  type ArtifactIngestResponse,
  type DocumentSnapshotList,
  type ExpertTarget,
  type TaskSnapshot,
} from '@geneway/contracts';

export type CreatedTask = Readonly<{
  taskId: string;
  approvalId: string;
  workflowVersionId: string;
  workflowHash: string;
}>;

export type Conversation = Readonly<{
  id: string;
  messages: readonly Readonly<{ id: string; author: 'user' | 'xiaowei'; body: string }>[];
}>;

export type Workflow = Readonly<{
  id: string;
  hash: string;
  canonicalizationVersion: string;
  payload: Readonly<{
    nodes: readonly Readonly<{ id: string; kind: string }>[];
    edges: readonly Readonly<{ from: string; to: string }>[];
  }>;
}>;

export type Approval = Readonly<{
  id: string;
  business_task_id: string;
  version: number;
  subject_digest: string;
  status: string;
}>;

export type Fixture = Readonly<{
  ref: 'fixture:solution-analysis:v1'; version: number; name: string; description: string; excerpt: string;
  simulation: true; runtimeMode: 'fake'; businessDecisionAllowed: false;
}>;

const key = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`${payload.error?.code ?? 'REQUEST_FAILED'}: ${payload.error?.message ?? response.statusText}`);
  return payload;
}

export const api = {
  getFixture: () => request<Fixture>('/api/fixtures/solution-analysis-v1'),
  createConversation: () => request<{ id: string }>('/api/conversations', {
    method: 'POST', headers: { 'idempotency-key': key('conversation') },
  }),
  addMessage: (conversationId: string, body: string) => request<{ id: string }>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('message') }, body: JSON.stringify({ body }),
  }),
  getConversation: (conversationId: string) => request<Conversation>(`/api/conversations/${conversationId}`),
  uploadArtifact: async (conversationId: string, file: File): Promise<ArtifactIngestResponse> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return artifactIngestResponseSchema.parse(await request(`/api/conversations/${conversationId}/uploads`, {
      method: 'POST', headers: { 'idempotency-key': key('artifact') }, body: form,
    }));
  },
  getDocumentSnapshots: async (conversationId: string): Promise<DocumentSnapshotList> =>
    documentSnapshotListSchema.parse(await request(`/api/conversations/${conversationId}/document-snapshots`)),
  createTask: (conversationId: string, expertTarget: ExpertTarget) => request<CreatedTask>('/api/business-tasks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('task') }, body: JSON.stringify({
      conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget,
    }),
  }),
  getTask: async (taskId: string): Promise<TaskSnapshot> => taskSnapshotSchema.parse(await request(`/api/business-tasks/${taskId}`)),
  getWorkflow: (id: string) => request<Workflow>(`/api/workflow-versions/${id}`),
  getApproval: (id: string) => request<Approval>(`/api/approvals/${id}`),
  approve: (id: string) => request<{ approvalId: string; status: string }>(`/api/approvals/${id}/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key('approval') }, body: JSON.stringify({ decision: 'approved' }),
  }),
  execute: (taskId: string) => request<{ taskId: string; status: string }>(`/api/business-tasks/${taskId}/execute`, {
    method: 'POST', headers: { 'idempotency-key': key('execute') },
  }),
  events: async (taskId: string, afterCursor: number) => {
    const response = await fetch(`/api/business-tasks/${taskId}/events?afterCursor=${String(afterCursor)}`, { headers: { accept: 'text/event-stream' } });
    if (!response.ok) throw new Error(`EVENT_STREAM_FAILED: ${response.statusText}`);
    const text = await response.text();
    return [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1] ?? '{}') as { cursor?: number });
  },
};
