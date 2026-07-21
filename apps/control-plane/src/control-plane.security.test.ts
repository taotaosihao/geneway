import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@geneway/contracts';
import { validateTextUpload } from '@geneway/ingestion';
import { compileWorkflow, createSolutionAnalysisDraft } from '@geneway/workflow';
import { createControlPlane, createWorkerCommandApp, type ControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for security tests');

const principalFor = (userId: string): Principal => ({ tenantId: 'tenant_local', userId, trust: 'trusted-local' });
const baseHeaders = (key: string, userId = 'user_local') => ({
  origin: 'http://localhost:3200',
  'idempotency-key': key,
  'x-test-user': userId,
});

describe('Gate 0.2A public and Worker security boundaries', () => {
  let controlPlane: ControlPlane;

  beforeAll(async () => {
    controlPlane = await createControlPlane({
      databaseUrl,
      principalResolver: (request) => principalFor(typeof request.headers['x-test-user'] === 'string' ? request.headers['x-test-user'] : 'user_local'),
    });
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => {
    await controlPlane.repository.resetForTest();
    await controlPlane.repository.pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_local','user_other','同租户其他用户')");
    await controlPlane.repository.pool.query("INSERT INTO roles (tenant_id,user_id,role) VALUES ('tenant_local','user_other','solution_reviewer')");
  });

  async function createFixtureTask() {
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: baseHeaders('security-conversation-01') });
    const conversationId = conversation.json<{ id: string }>().id;
    const task = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/business-tasks',
      headers: baseHeaders('security-task-0000001'),
      payload: {
        conversationId,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' },
        expertTarget: { mode: 'auto' },
      },
    });
    expect(task.statusCode, task.body).toBe(201);
    return task.json<{ taskId: string; approvalId: string; workflowVersionId: string }>();
  }

  async function createDocumentTask() {
    if (controlPlane.artifactService === null) throw new Error('Security test requires storage');
    const conversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: baseHeaders('security-document-conversation-01') });
    const conversationId = conversation.json<{ id: string }>().id;
    const bytes = await readFile(new URL('../../../scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt', import.meta.url));
    const uploaded = await controlPlane.artifactService.ingest({
      principal: principalFor('user_local'),
      conversationId,
      idempotencyKey: 'security-document-upload-0001',
      upload: validateTextUpload({ fileName: 'solution-analysis-demo-v2.txt', mediaType: 'text/plain', bytes }),
    });
    const taskResponse = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/business-tasks',
      headers: baseHeaders('security-document-task-00001'),
      payload: {
        conversationId,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'document_snapshot', documentSnapshotId: uploaded.documentSnapshot.id },
        expertTarget: { mode: 'auto' },
      },
    });
    expect(taskResponse.statusCode, taskResponse.body).toBe(201);
    return {
      conversationId,
      sourceArtifactId: uploaded.artifact.id,
      snapshotId: uploaded.documentSnapshot.id,
      ...taskResponse.json<{ taskId: string; approvalId: string; workflowVersionId: string }>(),
    };
  }

  it('derives identity server-side and rejects client-owned resolved snapshot fields', async () => {
    const conversation = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { ...baseHeaders('identity-conversation-01'), 'x-forwarded-for': '8.8.8.8', 'x-tenant-id': 'forged' },
    });
    expect(conversation.statusCode).toBe(201);
    const injected = await controlPlane.app.inject({
      method: 'POST',
      url: '/api/business-tasks',
      headers: baseHeaders('identity-task-00000001'),
      payload: {
        conversationId: conversation.json<{ id: string }>().id,
        capabilityId: 'solution.analysis.v1',
        inputRef: {
          kind: 'document_snapshot',
          documentSnapshotId: 'snapshot_forged',
          artifactId: 'artifact_forged',
          contentSha256: '0'.repeat(64),
          resourceScope: 'artifact:forged',
        },
        expertTarget: { mode: 'auto' },
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('rejects cross-origin writes and never registers Worker commands on the public app', async () => {
    const crossOrigin = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: { origin: 'https://evil.example', 'idempotency-key': 'cross-origin-0001' } });
    expect(crossOrigin.statusCode).toBe(403);
    const internal = await controlPlane.app.inject({ method: 'POST', url: '/internal/worker/v1/commands', payload: {} });
    expect(internal.statusCode).toBe(404);
  });

  it('prevents same-tenant principal access and principal-level idempotency collisions', async () => {
    const created = await createFixtureTask();
    for (const url of [`/api/business-tasks/${created.taskId}`, `/api/approvals/${created.approvalId}`]) {
      const denied = await controlPlane.app.inject({ method: 'GET', url, headers: { 'x-test-user': 'user_other' } });
      expect(denied.statusCode, url).toBe(404);
    }
    const otherConversation = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: baseHeaders('security-conversation-01', 'user_other') });
    expect(otherConversation.statusCode).toBe(201);
    expect(otherConversation.json()).not.toEqual(expect.objectContaining({ id: created.taskId }));
    const principals = await controlPlane.repository.pool.query("SELECT principal_id FROM idempotency_records WHERE operation='conversation.create' ORDER BY principal_id");
    expect(principals.rows).toEqual([{ principal_id: 'user_local' }, { principal_id: 'user_other' }]);
  });

  it('invalidates ApprovalVersion on semantic drift and expiry', async () => {
    const drifted = await createFixtureTask();
    await controlPlane.repository.pool.query("UPDATE business_tasks SET budget=jsonb_set(budget,'{maxRuntimeMs}','60000'::jsonb) WHERE tenant_id='tenant_local' AND id=$1", [drifted.taskId]);
    const decision = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${drifted.approvalId}/decisions`,
      headers: baseHeaders('drifted-approval-0001'),
      payload: { decision: 'approved' },
    });
    expect(decision.statusCode).toBe(409);
    expect(decision.json()).toMatchObject({ error: { code: 'APPROVAL_SUBJECT_CHANGED' } });

    await controlPlane.repository.resetForTest();
    const expired = await createFixtureTask();
    const approved = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${expired.approvalId}/decisions`,
      headers: baseHeaders('expiry-approval-00001'),
      payload: { decision: 'approved' },
    });
    expect(approved.statusCode).toBe(200);
    await controlPlane.repository.pool.query("UPDATE approval_versions SET expires_at=now()-interval '1 second' WHERE tenant_id='tenant_local' AND id=$1", [expired.approvalId]);
    const execute = await controlPlane.app.inject({ method: 'POST', url: `/api/business-tasks/${expired.taskId}/execute`, headers: baseHeaders('expiry-execute-0000001') });
    expect(execute.statusCode).toBe(409);
    expect(execute.json()).toMatchObject({ error: { code: 'APPROVAL_EXPIRED' } });
    const outbox = await controlPlane.repository.pool.query("SELECT 1 FROM outbox_events WHERE business_task_id=$1 AND event_type='workflow.execute.requested'", [expired.taskId]);
    expect(outbox.rowCount).toBe(0);
  });

  it('revalidates stored approval subjects, delegated capabilities and sensitive idempotency replays', async () => {
    const storedSubjectDrift = await createFixtureTask();
    await controlPlane.repository.pool.query(`UPDATE approval_versions
      SET subject=jsonb_set(subject,'{budget,maxRuntimeMs}','60000'::jsonb)
      WHERE tenant_id='tenant_local' AND id=$1`, [storedSubjectDrift.approvalId]);
    const storedSubjectDecision = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${storedSubjectDrift.approvalId}/decisions`,
      headers: baseHeaders('stored-subject-drift-0001'),
      payload: { decision: 'approved' },
    });
    expect(storedSubjectDecision.statusCode).toBe(409);
    expect(storedSubjectDecision.json()).toMatchObject({ error: { code: 'APPROVAL_SUBJECT_CHANGED' } });

    await controlPlane.repository.resetForTest();
    const capabilityDrift = await createFixtureTask();
    await controlPlane.repository.pool.query(`UPDATE delegated_capabilities
      SET allowed_actions='["R0"]'::jsonb
      WHERE tenant_id='tenant_local' AND business_task_id=$1`, [capabilityDrift.taskId]);
    const capabilityDecision = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${capabilityDrift.approvalId}/decisions`,
      headers: baseHeaders('capability-drift-decision-01'),
      payload: { decision: 'approved' },
    });
    expect(capabilityDecision.statusCode).toBe(409);
    expect(capabilityDecision.json()).toMatchObject({ error: { code: 'DELEGATED_CAPABILITY_INVALID' } });

    await controlPlane.repository.resetForTest();
    const replayed = await createFixtureTask();
    const approvalKey = 'authority-replay-approval-01';
    const executeKey = 'authority-replay-execute-001';
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${replayed.approvalId}/decisions`,
      headers: baseHeaders(approvalKey),
      payload: { decision: 'approved' },
    })).statusCode).toBe(200);
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${replayed.taskId}/execute`,
      headers: baseHeaders(executeKey),
    })).statusCode).toBe(200);
    await controlPlane.repository.pool.query(`UPDATE delegated_capabilities
      SET expires_at=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND business_task_id=$1`, [replayed.taskId]);
    const approvalReplay = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${replayed.approvalId}/decisions`,
      headers: baseHeaders(approvalKey),
      payload: { decision: 'approved' },
    });
    const executeReplay = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${replayed.taskId}/execute`,
      headers: baseHeaders(executeKey),
    });
    expect(approvalReplay.statusCode).toBe(409);
    expect(approvalReplay.json()).toMatchObject({ error: { code: 'DELEGATED_CAPABILITY_INVALID' } });
    expect(executeReplay.statusCode).toBe(409);
    expect(executeReplay.json()).toMatchObject({ error: { code: 'DELEGATED_CAPABILITY_INVALID' } });
  });

  it('requires a strong Worker service credential before parsing correlated fields', async () => {
    if (controlPlane.artifactService === null) throw new Error('Security test requires storage');
    const workerApp = createWorkerCommandApp({
      repository: controlPlane.repository,
      storage: controlPlane.artifactService.storage,
      token: 'security-worker-token-0000000000000000000000001',
    });
    const malformed = { command: 'session', protocolVersion: 'gate0.2a-worker-command/1', workerInstanceId: 'forged', consumer: 'gate0.2a-worker', deploymentId: 'gate0.2a-local' };
    const anonymous = await workerApp.inject({ method: 'POST', url: '/internal/worker/v1/commands', payload: malformed });
    const wrong = await workerApp.inject({ method: 'POST', url: '/internal/worker/v1/commands', headers: { authorization: 'Bearer wrong' }, payload: malformed });
    const browserOrigin = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: {
        authorization: 'Bearer security-worker-token-0000000000000000000000001',
        origin: 'http://localhost:3200',
      },
      payload: malformed,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(browserOrigin.statusCode).toBe(403);
    expect(anonymous.json()).toMatchObject({ error: { code: 'WORKER_AUTH_REQUIRED' } });
    expect(browserOrigin.json()).toMatchObject({ error: { code: 'WORKER_BROWSER_ORIGIN_DENIED' } });
    await workerApp.close();
  });

  it('revalidates exact approval and delegated capability before Worker claim', async () => {
    if (controlPlane.artifactService === null) throw new Error('Security test requires storage');
    const workerApp = createWorkerCommandApp({
      repository: controlPlane.repository,
      storage: controlPlane.artifactService.storage,
      token: 'security-worker-token-0000000000000000000000001',
    });
    const created = await createFixtureTask();
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${created.approvalId}/decisions`,
      headers: baseHeaders('worker-authority-approve-01'),
      payload: { decision: 'approved' },
    })).statusCode).toBe(200);
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${created.taskId}/execute`,
      headers: baseHeaders('worker-authority-execute-01'),
    })).statusCode).toBe(200);
    await controlPlane.repository.pool.query("UPDATE business_tasks SET budget=jsonb_set(budget,'{maxRuntimeMs}','60000'::jsonb) WHERE tenant_id='tenant_local' AND id=$1", [created.taskId]);
    const claim = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: { authorization: 'Bearer security-worker-token-0000000000000000000000001' },
      payload: {
        command: 'claim_delivery',
        protocolVersion: 'gate0.2a-worker-command/1',
        workerInstanceId: 'worker_security_authority',
        consumer: 'gate0.2a-worker',
        deploymentId: 'gate0.2a-local',
      },
    });
    expect(claim.statusCode).toBe(409);
    expect(claim.json()).toMatchObject({ error: { code: 'APPROVAL_SUBJECT_CHANGED' } });
    const attempts = await controlPlane.repository.pool.query('SELECT 1 FROM execution_attempts WHERE business_task_id=$1', [created.taskId]);
    expect(attempts.rowCount).toBe(0);

    await controlPlane.repository.resetForTest();
    const capabilityDrift = await createFixtureTask();
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${capabilityDrift.approvalId}/decisions`,
      headers: baseHeaders('worker-capability-approve-01'),
      payload: { decision: 'approved' },
    })).statusCode).toBe(200);
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${capabilityDrift.taskId}/execute`,
      headers: baseHeaders('worker-capability-execute-01'),
    })).statusCode).toBe(200);
    await controlPlane.repository.pool.query("UPDATE delegated_capabilities SET allowed_actions='[\"R0\"]'::jsonb WHERE tenant_id='tenant_local' AND business_task_id=$1", [capabilityDrift.taskId]);
    const capabilityClaim = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: { authorization: 'Bearer security-worker-token-0000000000000000000000001' },
      payload: {
        command: 'claim_delivery',
        protocolVersion: 'gate0.2a-worker-command/1',
        workerInstanceId: 'worker_security_capability',
        consumer: 'gate0.2a-worker',
        deploymentId: 'gate0.2a-local',
      },
    });
    expect(capabilityClaim.statusCode).toBe(409);
    expect(capabilityClaim.json()).toMatchObject({ error: { code: 'DELEGATED_CAPABILITY_CHANGED' } });
    await workerApp.close();
  });

  it('revalidates document state after storage reads and report downloads inherit root policy', async () => {
    if (controlPlane.artifactService === null) throw new Error('Security test requires storage');
    const workerToken = 'security-worker-token-0000000000000000000000001';
    const workerApp = createWorkerCommandApp({
      repository: controlPlane.repository,
      storage: controlPlane.artifactService.storage,
      token: workerToken,
    });
    const created = await createDocumentTask();
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/approvals/${created.approvalId}/decisions`,
      headers: baseHeaders('source-policy-approval-0001'),
      payload: { decision: 'approved' },
    })).statusCode).toBe(200);
    expect((await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-tasks/${created.taskId}/execute`,
      headers: baseHeaders('source-policy-execute-00001'),
    })).statusCode).toBe(200);
    const claim = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: { authorization: `Bearer ${workerToken}` },
      payload: {
        command: 'claim_delivery',
        protocolVersion: 'gate0.2a-worker-command/1',
        workerInstanceId: 'worker_source_policy',
        consumer: 'gate0.2a-worker',
        deploymentId: 'gate0.2a-local',
      },
    });
    expect(claim.statusCode, claim.body).toBe(200);
    const delivery = claim.json<{ result: {
      lease: { eventId: string; deliveryId: string; attemptId: string; fencingToken: number };
    } }>().result;
    await controlPlane.repository.pool.query(`UPDATE artifact_states SET retention_status='expired',retention_expires_at=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND artifact_id=$1`, [created.sourceArtifactId]);
    const readInput = await workerApp.inject({
      method: 'POST',
      url: '/internal/worker/v1/commands',
      headers: { authorization: `Bearer ${workerToken}` },
      payload: {
        command: 'read_input',
        protocolVersion: 'gate0.2a-worker-command/1',
        workerInstanceId: 'worker_source_policy',
        ...delivery.lease,
      },
    });
    expect(readInput.statusCode).toBe(409);
    expect(readInput.json()).toMatchObject({ error: { code: 'WORKER_INPUT_NOT_READY' } });
    await workerApp.close();

    await controlPlane.repository.resetForTest();
    const reportTask = await createDocumentTask();
    const reportId = `artifact_report_${crypto.randomUUID()}`;
    const manifestId = `manifest_report_${crypto.randomUUID()}`;
    const reportBytes = Buffer.from('# 模拟报告\n\n仅用于安全继承测试。\n', 'utf8');
    const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
    const storageKey = `tenants/tenant_local/artifacts/${reportId}/report.md`;
    await controlPlane.artifactService.storage.putCreateOnly({
      key: storageKey,
      bytes: reportBytes,
      contentType: 'text/markdown',
      contentSha256: reportSha256,
    });
    await controlPlane.repository.pool.query(`INSERT INTO artifacts
      (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,
       business_task_id,root_artifact_id,data_class,audience,resource_scope)
      VALUES ('tenant_local',$1,$2,'user_local','simulation_report','模拟报告.md','text/markdown',$3,$4,$5,$6,'C1',$7,$8)`, [
      reportId, reportTask.conversationId, reportBytes.byteLength, reportSha256, reportTask.taskId,
      reportTask.sourceArtifactId, { kind: 'private-conversation', conversationId: reportTask.conversationId },
      `artifact:${reportTask.sourceArtifactId}`,
    ]);
    await controlPlane.repository.pool.query(`INSERT INTO artifact_manifests
      (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
      VALUES ('tenant_local',$1,$2,$3,$4,'模拟报告.md','text/markdown',$5,$6,'gate0.2a-internal/v1')`, [
      manifestId, reportId, controlPlane.artifactService.storage.bucket, storageKey, reportBytes.byteLength, reportSha256,
    ]);
    await controlPlane.repository.pool.query(`INSERT INTO artifact_states
      (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status,last_checked_at,last_verified_at)
      VALUES ('tenant_local',$1,'active','verified','active',now()+interval '30 days','in_sync',now(),now())`, [reportId]);
    const allowedReport = await controlPlane.app.inject({ method: 'GET', url: `/api/artifacts/${reportId}/download` });
    expect(allowedReport.statusCode, allowedReport.body).toBe(200);
    expect(allowedReport.rawPayload).toEqual(reportBytes);
    await controlPlane.repository.pool.query(`UPDATE artifact_states SET integrity='failed',reconcile_status='required'
      WHERE tenant_id='tenant_local' AND artifact_id=$1`, [reportTask.sourceArtifactId]);
    const deniedReport = await controlPlane.app.inject({ method: 'GET', url: `/api/artifacts/${reportId}/download` });
    expect(deniedReport.statusCode).toBe(404);
    expect(deniedReport.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
  });

  it('keeps Control Plane production imports free of Worker, Runtime and provider implementations', async () => {
    const controlPlaneManifest = await readFile(path.resolve(process.cwd(), 'apps/control-plane/package.json'), 'utf8');
    const controlPlaneSource = await readFile(path.resolve(process.cwd(), 'apps/control-plane/src/index.ts'), 'utf8');
    const productionText = `${controlPlaneManifest}\n${controlPlaneSource}`;
    expect(productionText).not.toContain('@geneway/worker');
    expect(productionText).not.toContain('@geneway/runtime');
    expect(productionText).not.toContain('WorkflowInterpreter');
    expect(productionText).not.toContain('@openai/agents');
    expect(productionText).not.toContain('@anthropic-ai/');
    expect(productionText.toLowerCase()).not.toContain('minio');

    const draft = createSolutionAnalysisDraft() as Record<string, unknown>;
    draft.url = 'https://unopened.example';
    expect(() => compileWorkflow(draft)).toThrow();
  });
});
