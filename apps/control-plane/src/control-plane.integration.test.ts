import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POSITIVE_CLAIM_TEXT, UNSUPPORTED_CLAIM_TEXT } from '@geneway/evidence';
import { WorkflowInterpreter } from '@geneway/worker';
import { createControlPlane, type ControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for integration tests');

const headers = (key: string) => ({ origin: 'http://localhost:3200', 'idempotency-key': key });

describe('Control Plane + Postgres + Interpreter integration', () => {
  let controlPlane: ControlPlane;
  let serverUrl: string;

  beforeAll(async () => {
    controlPlane = await createControlPlane({ databaseUrl });
    serverUrl = await controlPlane.app.listen({ host: '127.0.0.1', port: 0 });
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  it('serves the Control Plane over a real loopback HTTP socket', async () => {
    const response = await fetch(new URL('/health', serverUrl));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'geneway-control-plane' });
  });

  async function createApprovedTask(mode: 'auto' | 'expert' | 'team' = 'auto') {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers(`conversation-${mode}-0001`) });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json<{ id: string }>().id;
    const expertTarget = mode === 'auto'
      ? { mode: 'auto' }
      : mode === 'expert'
        ? { mode: 'expert', expertId: 'expert.solution.architect' }
        : { mode: 'team', teamId: 'team.solution.core' };
    const created = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: headers(`task-${mode}-00000001`),
      payload: { conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget },
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json<{ taskId: string; approvalId: string; workflowVersionId: string; workflowHash: string }>();
    const approved = await controlPlane.app.inject({
      method: 'POST', url: `/api/approvals/${task.approvalId}/decisions`, headers: headers(`approve-${mode}-000001`), payload: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return { ...task, conversationId };
  }

  it.each(['auto', 'expert', 'team'] as const)('runs the real authority path with %s routing', async (mode) => {
    const created = await createApprovedTask(mode);
    const executed = await controlPlane.app.inject({ method: 'POST', url: `/api/business-tasks/${created.taskId}/execute`, headers: headers(`execute-${mode}-000001`) });
    expect(executed.statusCode, executed.body).toBe(200);

    const snapshotResponse = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${created.taskId}` });
    expect(snapshotResponse.statusCode, snapshotResponse.body).toBe(200);
    const snapshot = snapshotResponse.json<{
      id: string; status: string; workflowVersion: { id: string; hash: string }; approval: { status: string };
      steps: Array<{ status: string }>; claims: Array<{ text: string; status: string; evidenceRefId: string | null }>;
      evidence: Array<{ id: string; sourceHash: string }>; result: { simulation: boolean; runtimeMode: string; businessDecisionAllowed: boolean };
      aggregateVersion: number; eventWatermark: number; simulation: boolean; runtimeMode: string; businessDecisionAllowed: boolean;
    }>();
    expect(snapshot).toMatchObject({
      id: created.taskId,
      status: 'completed',
      workflowVersion: { id: created.workflowVersionId, hash: created.workflowHash },
      approval: { status: 'approved' },
      simulation: true,
      runtimeMode: 'fake',
      businessDecisionAllowed: false,
    });
    expect(snapshot.steps).toHaveLength(7);
    expect(snapshot.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(snapshot.result).toMatchObject({ simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false });
    expect(snapshot.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: POSITIVE_CLAIM_TEXT, status: 'published', evidenceRefId: snapshot.evidence[0]?.id }),
      expect.objectContaining({ text: UNSUPPORTED_CLAIM_TEXT, status: 'rejected', evidenceRefId: null }),
    ]));

    const eventsResponse = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${created.taskId}/events?afterCursor=0` });
    const events = eventsResponse.json<{ events: Array<{ cursor: number; business_task_id: string; simulation: boolean; runtime_mode: string; business_decision_allowed: boolean }> }>().events;
    expect(events.length).toBeGreaterThan(15);
    expect(events.every((event) => event.business_task_id === created.taskId && event.simulation && event.runtime_mode === 'fake' && !event.business_decision_allowed)).toBe(true);
    expect(events.at(-1)?.cursor).toBe(snapshot.eventWatermark);
    expect(snapshot.aggregateVersion).toBeGreaterThan(1);

    const afterWatermark = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${created.taskId}/events?afterCursor=${snapshot.eventWatermark}` });
    expect(afterWatermark.json<{ events: unknown[] }>().events).toEqual([]);
    const lastOnly = await controlPlane.app.inject({ method: 'GET', url: `/api/business-tasks/${created.taskId}/events?afterCursor=${snapshot.eventWatermark - 1}` });
    expect(lastOnly.json<{ events: unknown[] }>().events).toHaveLength(1);

    const dbCorrelation = await controlPlane.repository.pool.query(`SELECT
      (SELECT count(*) FROM business_task_events WHERE tenant_id='tenant_local' AND business_task_id=$1)::int AS event_count,
      (SELECT count(*) FROM outbox_events WHERE tenant_id='tenant_local' AND business_task_id=$1)::int AS outbox_count,
      (SELECT workflow_hash FROM business_tasks WHERE tenant_id='tenant_local' AND id=$1) AS workflow_hash`, [created.taskId]);
    expect(dbCorrelation.rows[0]).toMatchObject({ event_count: events.length, outbox_count: events.length, workflow_hash: created.workflowHash });
  });

  it('returns the original result for equivalent idempotent commands and conflicts on changed semantics', async () => {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers('conversation-idempotent-1') });
    const repeat = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers('conversation-idempotent-1') });
    expect(repeat.json()).toEqual(conversation.json());

    const conversationId = conversation.json<{ id: string }>().id;
    const original = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: headers('task-idempotent-0001'),
      payload: { conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget: { mode: 'auto' } },
    });
    const same = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: headers('task-idempotent-0001'),
      payload: { conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget: { mode: 'auto' } },
    });
    expect(same.json()).toEqual(original.json());
    const conflict = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: headers('task-idempotent-0001'),
      payload: { conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget: { mode: 'expert', expertId: 'expert.solution.architect' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('serializes two execute keys by task and lets only one owner run the interpreter', async () => {
    const created = await createApprovedTask('auto');
    const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
    const workflow = await controlPlane.repository.getWorkflow(principal, created.workflowVersionId);
    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { announceFirst = resolve; });
    const firstMayRun = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = controlPlane.repository.executeIdempotently(principal, created.taskId, 'execute-owner-first-001', async () => {
      announceFirst?.();
      await firstMayRun;
      await new WorkflowInterpreter(controlPlane.repository).execute({
        tenantId: principal.tenantId,
        taskId: created.taskId,
        fixtureRef: 'fixture:solution-analysis:v1',
        workflow,
      });
      return { taskId: created.taskId, status: 'completed' };
    });
    await firstEntered;
    let secondEffectCalled = false;
    const second = controlPlane.repository.executeIdempotently(principal, created.taskId, 'execute-owner-second-01', () => {
      secondEffectCalled = true;
      return Promise.reject(new Error('second task owner must not execute'));
    });
    releaseFirst?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { taskId: created.taskId, status: 'completed' },
      { taskId: created.taskId, status: 'completed' },
    ]);
    expect(secondEffectCalled).toBe(false);
    const events = await controlPlane.repository.pool.query<{ event_type: string }>('SELECT event_type FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2', [principal.tenantId, created.taskId]);
    expect(events.rows.filter((event) => event.event_type === 'workflow.run_started')).toHaveLength(1);
    expect(events.rows.filter((event) => event.event_type === 'business_task.failed')).toHaveLength(0);
  });
});
