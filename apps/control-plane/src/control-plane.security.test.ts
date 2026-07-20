import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIMULATION_ENVELOPE, type Principal } from '@geneway/contracts';
import { FakeRuntime } from '@geneway/runtime';
import { createSolutionAnalysisDraft, compileWorkflow } from '@geneway/workflow';
import { createControlPlane, type ControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for security tests');

const allowedHeaders = { origin: 'http://localhost:3200', 'idempotency-key': 'security-key-000001' };

describe('Gate 0.1 security boundaries', () => {
  let controlPlane: ControlPlane;

  beforeAll(async () => {
    controlPlane = await createControlPlane({ databaseUrl });
    return async () => controlPlane.app.close();
  });
  beforeEach(async () => controlPlane.repository.resetForTest());

  async function createTask() {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: allowedHeaders });
    const conversationId = conversation.json<{ id: string }>().id;
    const response = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: { ...allowedHeaders, 'idempotency-key': 'security-task-00001' },
      payload: { conversationId, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget: { mode: 'auto' } },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ taskId: string; approvalId: string; workflowVersionId: string }>();
  }

  it('ignores proxy identity headers and rejects client identity fields', async () => {
    const conversation = await controlPlane.app.inject({
      method: 'POST', url: '/api/conversations', headers: { ...allowedHeaders, 'x-forwarded-for': '8.8.8.8', 'x-tenant-id': 'tenant_forged', 'x-user-id': 'admin' },
    });
    expect(conversation.statusCode).toBe(201);
    const task = await controlPlane.app.inject({
      method: 'POST', url: '/api/business-tasks', headers: { ...allowedHeaders, 'idempotency-key': 'forged-task-000001' },
      payload: { conversationId: conversation.json<{ id: string }>().id, capabilityId: 'solution.analysis.v1', fixtureRef: 'fixture:solution-analysis:v1', expertTarget: { mode: 'auto' }, tenantId: 'tenant_forged' },
    });
    expect(task.statusCode).toBe(400);
  });

  it('rejects cross-origin writes and unopened product/runtime routes', async () => {
    const crossOrigin = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: { origin: 'https://evil.example', 'idempotency-key': 'cross-origin-0001' } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    for (const [method, url] of [['POST', '/api/uploads'], ['GET', '/api/artifacts/a/download'], ['GET', '/api/business-exceptions'], ['POST', '/api/runtime/openai']] as const) {
      const response = await controlPlane.app.inject({ method, url, headers: allowedHeaders });
      expect(response.statusCode, `${method} ${url}`).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_OPEN' } });
    }
  });

  it('enforces tenant scope for task, approval and evidence reads', async () => {
    const created = await createTask();
    const other: Principal = { tenantId: 'tenant_other', userId: 'user_other', trust: 'trusted-local' };
    await expect(controlPlane.repository.getTask(other, created.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(controlPlane.repository.getApproval(other, created.approvalId)).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
    await expect(controlPlane.repository.getEvidence(other, 'anything')).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });
  });

  it('invalidates approval when bound execution semantics change', async () => {
    const created = await createTask();
    await controlPlane.repository.pool.query("UPDATE business_tasks SET input_snapshot=jsonb_set(input_snapshot,'{fixtureVersion}','2'::jsonb) WHERE tenant_id='tenant_local' AND id=$1", [created.taskId]);
    const response = await controlPlane.app.inject({
      method: 'POST', url: `/api/approvals/${created.approvalId}/decisions`,
      headers: { ...allowedHeaders, 'idempotency-key': 'stale-approval-001' }, payload: { decision: 'approved' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'APPROVAL_SUBJECT_CHANGED' } });
  });

  it('rechecks approved authority expiry when execution starts', async () => {
    const created = await createTask();
    const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
    await controlPlane.repository.decideApproval(principal, created.approvalId, 'approved', 'approve-before-expiry-01');
    await controlPlane.repository.pool.query("UPDATE approval_versions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [principal.tenantId, created.approvalId]);
    const workflow = await controlPlane.repository.getWorkflow(principal, created.workflowVersionId);
    await expect(controlPlane.repository.startTask(principal.tenantId, created.taskId, workflow)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expect(controlPlane.repository.getTask(principal, created.taskId)).resolves.toMatchObject({ status: 'approved' });
  });

  it('validates the final simulation result before mutating authority state', async () => {
    const created = await createTask();
    const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
    await controlPlane.repository.decideApproval(principal, created.approvalId, 'approved', 'result-guard-approve-01');
    const workflow = await controlPlane.repository.getWorkflow(principal, created.workflowVersionId);
    await controlPlane.repository.startTask(principal.tenantId, created.taskId, workflow);
    const runtime = new FakeRuntime();
    for (const node of workflow.payload.nodes) {
      const lease = await controlPlane.repository.claimStep(principal.tenantId, created.taskId, node.id, `result-guard-${node.id}`);
      const output = runtime.executeStep(node.id, {
        tenantId: principal.tenantId,
        businessTaskId: created.taskId,
        fixtureRef: 'fixture:solution-analysis:v1',
      });
      if (output.claims !== undefined) {
        await controlPlane.repository.publishEvidenceAndClaims(principal.tenantId, created.taskId, output.evidence, output.claims);
      }
      await controlPlane.repository.completeStep(principal.tenantId, created.taskId, node.id, lease, output);
    }
    const readyToPublish = await controlPlane.repository.getTask(principal, created.taskId);
    expect(readyToPublish.status).toBe('running');
    expect(readyToPublish.result).toBeNull();
    expect(readyToPublish.claims.some((claim) => claim.status === 'published')).toBe(true);
    expect(readyToPublish.steps).toHaveLength(7);
    expect(readyToPublish.steps.every((step) => step.status === 'completed')).toBe(true);
    await expect(controlPlane.repository.completeTask(principal.tenantId, created.taskId, {
      kind: 'completed', summary: 'missing envelope', stepSummaries: [],
    })).rejects.toThrow();
    await expect(controlPlane.repository.completeTask(principal.tenantId, created.taskId, {
      kind: 'completed', summary: 'conflicting envelope', stepSummaries: [],
      simulation: true, runtimeMode: 'real', businessDecisionAllowed: false,
    })).rejects.toThrow();
    await expect(controlPlane.repository.getTask(principal, created.taskId)).resolves.toMatchObject({ status: 'running', result: null });
    const eventsAfterRejectedResults = await controlPlane.repository.getEvents(principal, created.taskId, 0);
    expect(eventsAfterRejectedResults.some((event) => event.event_type === 'business_task.completed')).toBe(false);
  });

  it('rejects a corrupt canonical workflow row on Postgres readback', async () => {
    const created = await createTask();
    const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
    const stored = await controlPlane.repository.pool.query<{ canonical_json: unknown }>('SELECT canonical_json FROM workflow_versions WHERE tenant_id=$1 AND id=$2', [principal.tenantId, created.workflowVersionId]);
    await controlPlane.repository.pool.query(`INSERT INTO workflow_versions
      (tenant_id,id,workflow_hash,canonicalization_version,canonical_json)
      VALUES ($1,'workflow_corrupt','${'0'.repeat(64)}','RFC8785/JCS-1',$2)`, [principal.tenantId, stored.rows[0]?.canonical_json]);
    await expect(controlPlane.repository.getWorkflow(principal, 'workflow_corrupt')).rejects.toMatchObject({ code: 'WORKFLOW_HASH_MISMATCH' });
  });

  it('rejects stale step fencing and immutable version deletion', async () => {
    const created = await createTask();
    await controlPlane.repository.decideApproval({ tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' }, created.approvalId, 'approved', 'security-approve-001');
    const workflow = await controlPlane.repository.getWorkflow({ tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' }, created.workflowVersionId);
    await controlPlane.repository.startTask('tenant_local', created.taskId, workflow);
    await expect(controlPlane.repository.claimStep('tenant_local', created.taskId, 'solution_design', 'attempt-out-of-order')).rejects.toMatchObject({ code: 'STEP_DEPENDENCY_NOT_READY' });
    const lease = await controlPlane.repository.claimStep('tenant_local', created.taskId, 'document_ingest', 'attempt-current');
    await expect(controlPlane.repository.completeStep('tenant_local', created.taskId, 'document_ingest', { ...lease, fencingToken: lease.fencingToken - 1 }, { ok: true })).rejects.toMatchObject({ code: 'STALE_STEP_COMPLETION' });
    await controlPlane.repository.completeStep('tenant_local', created.taskId, 'document_ingest', lease, { ok: true, ...SIMULATION_ENVELOPE });
    await expect(controlPlane.repository.pool.query("DELETE FROM workflow_versions WHERE tenant_id='tenant_local' AND id=$1", [created.workflowVersionId])).rejects.toThrow(/immutable/i);
  });

  it('does not include real providers, connectors, Paperclip, TypeBox or Ajv in production manifests', async () => {
    const manifest = await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
    const workflowManifest = await readFile(path.resolve(process.cwd(), 'packages/workflow/package.json'), 'utf8');
    const workflowSource = await readFile(path.resolve(process.cwd(), 'packages/workflow/src/index.ts'), 'utf8');
    const productionManifests = `${manifest}\n${workflowManifest}\n${workflowSource}`.toLowerCase();
    expect(productionManifests).not.toContain('@paperclipai/');
    expect(productionManifests).not.toContain('typebox');
    expect(productionManifests).not.toMatch(/from ['"]ajv['"]|['"]ajv['"]\s*:/);
    expect(productionManifests).not.toContain('@openai/agents');
    expect(productionManifests).not.toContain('@anthropic-ai/');
    expect(productionManifests).not.toContain('minio');

    const draft = createSolutionAnalysisDraft() as Record<string, unknown>;
    draft.url = 'https://unopened.example';
    expect(() => compileWorkflow(draft)).toThrow();
  });
});
