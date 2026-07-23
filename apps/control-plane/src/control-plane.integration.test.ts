import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SIMULATION_ENVELOPE,
  workerCommandResponseSchema,
  type AttemptOutputCandidatePayload,
  type ExpertTarget,
  type WorkerCommand,
  type WorkerDelivery,
} from '@geneway/contracts';
import {
  DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
  DEMO_EVIDENCE_START_BYTE,
  POSITIVE_CLAIM_TEXT,
  UNSUPPORTED_CLAIM_TEXT,
} from '@geneway/evidence';
import { createControlPlane, createWorkerCommandApp, type ControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for integration tests');

const workerToken = 'integration-worker-token-000000000000000000000001';
const headers = (key: string) => ({ origin: 'http://localhost:3200', 'idempotency-key': key });

describe('Gate 0.2A Control Plane delivery and Evidence integration', () => {
  let controlPlane: ControlPlane;
  let workerApp: ReturnType<typeof createWorkerCommandApp>;
  let serverUrl: string;

  beforeAll(async () => {
    controlPlane = await createControlPlane({ databaseUrl });
    if (controlPlane.artifactService === null) throw new Error('Integration test requires the real storage adapter');
    workerApp = createWorkerCommandApp({ repository: controlPlane.repository, storage: controlPlane.artifactService.storage, token: workerToken });
    serverUrl = await controlPlane.app.listen({ host: '127.0.0.1', port: 0 });
    return async () => {
      await workerApp.close();
      await controlPlane.app.close();
    };
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  async function sendWorker(command: WorkerCommand) {
    const response = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: { authorization: `Bearer ${workerToken}` },
      payload: command,
    });
    expect(response.statusCode, response.body).toBe(200);
    return workerCommandResponseSchema.parse(response.json());
  }

  async function executionInput(taskId: string) {
    const response = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${taskId}` });
    expect(response.statusCode, response.body).toBe(200);
    const approval = response.json<{ approval: { version: number; subjectDigest: string } }>().approval;
    return { expectedApprovalVersion: approval.version, expectedApprovalSubjectDigest: approval.subjectDigest };
  }

  async function createUploadedSnapshot(): Promise<Readonly<{ conversationId: string; snapshotId: string; sourceArtifactId: string }>> {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers('conversation-document-0001') });
    const conversationId = conversation.json<{ id: string }>().id;
    const bytes = await readFile(new URL('../../../scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt', import.meta.url));
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'text/plain' }), 'solution-analysis-demo-v2.txt');
    const uploaded = await fetch(new URL(`/api/conversations/${conversationId}/uploads`, serverUrl), {
      method: 'POST',
      headers: { origin: 'http://localhost:3200', 'idempotency-key': 'upload-document-000001' },
      body: form,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const projection = await uploaded.json() as { documentSnapshot: { id: string }; artifact: { id: string } };
    return { conversationId, snapshotId: projection.documentSnapshot.id, sourceArtifactId: projection.artifact.id };
  }

  async function createApprovedDocumentTask(expertTarget: ExpertTarget = { mode: 'auto' }) {
    const uploaded = await createUploadedSnapshot();
    const created = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/business-tasks',
      headers: headers('task-document-0000001'),
      payload: {
        conversationId: uploaded.conversationId,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'document_snapshot', documentSnapshotId: uploaded.snapshotId },
        expertTarget,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json<{ taskId: string; approvalId: string; workflowVersionId: string; workflowHash: string }>();
    const approved = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${task.approvalId}/decisions`,
      headers: headers('approve-document-00001'),
      payload: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return { ...uploaded, ...task };
  }

  async function executeThroughWorker(taskId: string): Promise<WorkerDelivery> {
    const execute = await controlPlane.app.inject({ method: 'POST', url: `/api/business-tasks/${taskId}/execute`, headers: headers('execute-document-00001'), payload: await executionInput(taskId) });
    expect(execute.statusCode, execute.body).toBe(200);
    expect(execute.json()).toEqual({ taskId, status: 'accepted' });
    const session = await sendWorker({
      command: 'session',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: 'worker_integration_1',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
    });
    expect(session).toMatchObject({ command: 'session', result: { authenticated: true } });
    const claimed = await sendWorker({
      command: 'claim_delivery',
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: 'worker_integration_1',
      consumer: 'gate0.2a-worker',
      deploymentId: 'gate0.2a-local',
    });
    if (claimed.command !== 'claim_delivery' || claimed.result === null) throw new Error('Expected one claimed delivery');
    const delivery = claimed.result;
    const base = {
      protocolVersion: 'gate0.2a-worker-command/1' as const,
      workerInstanceId: delivery.workerInstanceId,
      deliveryId: delivery.lease.deliveryId,
      eventId: delivery.lease.eventId,
      attemptId: delivery.lease.attemptId,
      fencingToken: delivery.lease.fencingToken,
    };
    const input = await sendWorker({ command: 'read_input', ...base });
    expect(input).toMatchObject({ command: 'read_input', result: { kind: 'document_snapshot' } });
    const stepSummaries: string[] = [];
    const nodes = (delivery.workflow.canonicalPayload as { nodes: Array<{ id: string }> }).nodes;
    for (const [index, node] of nodes.entries()) {
      const stepAttemptId = `step_attempt_${String(index + 1)}`;
      const claimCommand = { command: 'claim_step', ...base, stepId: node.id, stepAttemptId, idempotencyKey: `claim-${index}-00000001` } as const;
      const step = await sendWorker(claimCommand);
      if (step.command !== 'claim_step') throw new Error('Unexpected claim-step response');
      if (step.result.state !== 'claimed') throw new Error('Expected a new step lease');
      expect(await sendWorker(claimCommand)).toEqual(step);
      const summary = `已完成 ${node.id}`;
      stepSummaries.push(summary);
      const completeCommand = {
        command: 'complete_step',
        ...base,
        stepId: node.id,
        stepAttemptId,
        stepFencingToken: step.result.fencingToken,
        output: { summary },
        idempotencyKey: `complete-${index}-00001`,
      } as const;
      await sendWorker(completeCommand);
      await sendWorker(completeCommand);
    }
    const candidate: AttemptOutputCandidatePayload = {
      evidence: [{
        kind: 'document_snapshot',
        candidateKey: 'primary-source',
        documentSnapshotId: delivery.inputRef.kind === 'document_snapshot' ? delivery.inputRef.documentSnapshotId : 'invalid',
        startByte: DEMO_EVIDENCE_START_BYTE,
        endByteExclusive: DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
      }],
      claims: [
        { candidateKey: 'supported-requirement', text: POSITIVE_CLAIM_TEXT, evidenceCandidateKey: 'primary-source' },
        { candidateKey: 'unsupported-device-control', text: UNSUPPORTED_CLAIM_TEXT, evidenceCandidateKey: null },
      ],
      result: { kind: 'completed', summary: '模拟方案分析已完成', stepSummaries, ...SIMULATION_ENVELOPE },
    };
    const submitCommand = { command: 'submit_candidate', ...base, candidate, idempotencyKey: 'submit-candidate-00001' } as const;
    await sendWorker(submitCommand);
    await sendWorker(submitCommand);
    return delivery;
  }

  it('runs one browser-compatible snapshot task through outbox, inbox, candidate, Evidence and report', async () => {
    const created = await createApprovedDocumentTask({ mode: 'team', teamId: 'team.solution.core' });
    const delivery = await executeThroughWorker(created.taskId);
    const snapshotResponse = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${created.taskId}` });
    expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
    const snapshot = snapshotResponse.json<{
      status: string;
      inputRef: { kind: string; documentSnapshotId: string };
      steps: Array<{ status: string }>;
      claims: Array<{ id: string; status: string; evidenceRefId: string | null }>;
      evidence: Array<{ id: string; excerpt: null | string; audience: { kind: string; conversationId: string } }>;
      artifacts: Array<{ id: string; kind: string; contentSha256: string }>;
      lineage: unknown[];
    }>();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.inputRef).toMatchObject({ kind: 'document_snapshot', documentSnapshotId: created.snapshotId });
    expect(snapshot.steps).toHaveLength(7);
    expect(snapshot.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(snapshot.claims.filter((claim) => claim.status === 'published')).toHaveLength(1);
    expect(snapshot.claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]?.excerpt).toBeNull();
    expect(snapshot.evidence[0]?.audience).toEqual({
      kind: 'private_conversation', conversationId: created.conversationId,
    });
    expect(snapshot.artifacts.map((artifact) => artifact.kind).sort()).toEqual(['simulation_report', 'source_document']);
    expect(snapshot.lineage.length).toBeGreaterThanOrEqual(7);

    const evidence = await controlPlane.app.inject({ method: 'GET', url: `/api/evidence/${snapshot.evidence[0]?.id}` });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({
      source: { kind: 'document_snapshot', startByte: 40, endByteExclusive: 133 },
      excerptSha256: '0230bc572ef7f3770a19727a8e9125cb30e9bdfd670c54c75ae6d4de8963b82f',
    });
    expect(evidence.json<{ excerpt: string }>().excerpt).toContain('生产工单');

    for (const artifact of snapshot.artifacts) {
      const download = await controlPlane.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}/download` });
      expect(download.statusCode, download.body).toBe(200);
      expect(sha256(download.rawPayload)).toBe(artifact.contentSha256);
    }
    const correlation = await controlPlane.repository.pool.query(`SELECT
      (SELECT count(*) FROM outbox_deliveries WHERE business_task_id=$1)::int delivery_count,
      (SELECT count(*) FROM inbox_events WHERE business_task_id=$1)::int inbox_count,
      (SELECT count(*) FROM execution_attempts WHERE business_task_id=$1)::int attempt_count,
      (SELECT count(*) FROM attempt_output_candidates WHERE business_task_id=$1)::int candidate_count,
      (SELECT count(*) FROM evidence_links WHERE business_task_id=$1)::int link_count,
      (SELECT worker_instance_id FROM execution_attempts WHERE business_task_id=$1) worker_instance_id`, [created.taskId]);
    expect(correlation.rows[0]).toMatchObject({
      delivery_count: 1,
      inbox_count: 1,
      attempt_count: 1,
      candidate_count: 1,
      link_count: 1,
      worker_instance_id: delivery.workerInstanceId,
    });
  });

  it('rejects an unregistered profile before task, outbox or Worker activity', async () => {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers('conversation-negative-001') });
    const conversationId = conversation.json<{ id: string }>().id;
    const form = new FormData();
    form.set('file', new Blob(['普通合法文本，不匹配已注册演示材料。'], { type: 'text/plain' }), 'other.txt');
    const uploaded = await fetch(new URL(`/api/conversations/${conversationId}/uploads`, serverUrl), {
      method: 'POST',
      headers: { origin: 'http://localhost:3200', 'idempotency-key': 'upload-negative-000001' },
      body: form,
    });
    const payload = await uploaded.json() as { documentSnapshot: { id: string }; executionEligibility: { eligible: boolean } };
    expect(payload.executionEligibility.eligible).toBe(false);
    const task = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/business-tasks',
      headers: headers('task-negative-00000001'),
      payload: {
        conversationId,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'document_snapshot', documentSnapshotId: payload.documentSnapshot.id },
        expertTarget: { mode: 'auto' },
      },
    });
    expect(task.statusCode).toBe(422);
    expect(task.json()).toMatchObject({ error: { code: 'NOT_OPEN_FOR_SIMULATION_PROFILE' } });
    const counts = await controlPlane.repository.pool.query(`SELECT
      (SELECT count(*) FROM business_tasks)::int tasks,
      (SELECT count(*) FROM outbox_deliveries)::int deliveries,
      (SELECT count(*) FROM execution_attempts)::int attempts,
      (SELECT count(*) FROM claims)::int claims`);
    expect(counts.rows[0]).toEqual({ tasks: 0, deliveries: 0, attempts: 0, claims: 0 });
  });

  it('keeps Worker commands off the public listener and requires the real service token', async () => {
    const publicRoute = await controlPlane.app.inject({ method: 'POST', url: '/internal/worker/v1/commands', payload: {} });
    expect(publicRoute.statusCode).toBe(404);
    const anonymous = await workerApp.inject({ method: 'POST', url: '/internal/worker/v1/commands', payload: {
      command: 'session', protocolVersion: 'gate0.2a-worker-command/1', workerInstanceId: 'forged', consumer: 'gate0.2a-worker', deploymentId: 'gate0.2a-local',
    } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'WORKER_AUTH_REQUIRED' } });
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
