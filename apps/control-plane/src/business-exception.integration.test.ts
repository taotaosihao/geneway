import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  businessExceptionDetailSchema,
  businessExceptionListResponseSchema,
  createExceptionAnalysisTaskResponseSchema,
  type Principal,
} from '@geneway/contracts';
import { createControlPlane, type ControlPlane } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for BusinessException integration tests');

const headers = (userId = 'user_local') => ({
  origin: 'http://localhost:3200',
  'x-test-principal': userId,
});

describe('Gate 0.2B.2 BusinessException authority integration', () => {
  let controlPlane: ControlPlane;

  beforeAll(async () => {
    controlPlane = await createControlPlane({
      databaseUrl,
      objectStorage: null,
      principalResolver: (request): Principal => ({
        tenantId: 'tenant_local',
        userId: typeof request.headers['x-test-principal'] === 'string'
          ? request.headers['x-test-principal'] : 'user_local',
        trust: 'trusted-local',
      }),
    });
    return () => controlPlane.app.close();
  });

  beforeEach(async () => {
    await controlPlane.repository.resetForTest();
    await controlPlane.repository.pool.query(`INSERT INTO control_plane_database_metadata
      (singleton,is_non_production,environment_name) VALUES (true,true,'vitest')
      ON CONFLICT (singleton) DO UPDATE SET is_non_production=true,environment_name='vitest',updated_at=now()`);
    await controlPlane.repository.pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
      VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02')`);
  });

  it('seeds fixed sources once and creates one source-bound task transaction', async () => {
    const seeded = await controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: '127.0.0.1', tenantId: 'tenant_local',
    });
    expect(seeded).toHaveLength(2);
    expect(seeded.every((entry) => entry.created)).toBe(true);
    const replay = await controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: 'localhost', tenantId: 'tenant_local',
    });
    expect(replay.map((entry) => ({ id: entry.id, sourceVersionId: entry.sourceVersionId })))
      .toEqual(seeded.map((entry) => ({ id: entry.id, sourceVersionId: entry.sourceVersionId })));
    expect(replay.every((entry) => !entry.created)).toBe(true);

    const listed = await controlPlane.app.inject({ method: 'GET', url: '/api/business-exceptions?limit=1', headers: headers() });
    expect(listed.statusCode, listed.body).toBe(200);
    const firstPage = businessExceptionListResponseSchema.parse(listed.json());
    expect(firstPage.exceptions).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const capacity = (await controlPlane.repository.pool.query<{ id: string }>(
      "SELECT id FROM business_exceptions WHERE exception_type='capacity_progress_lag'",
    )).rows[0];
    if (capacity === undefined) throw new Error('capacity fixture was not seeded');
    const detailResponse = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-exceptions/${capacity.id}`, headers: headers(),
    });
    expect(detailResponse.statusCode, detailResponse.body).toBe(200);
    const detail = businessExceptionDetailSchema.parse(detailResponse.json());
    expect(detail).toMatchObject({ status: 'open', ownerDisplayState: 'unassigned', analysisDisplayState: 'not_requested' });
    expect(detail.evidence).toHaveLength(5);
    expect(detailResponse.headers.etag).toBe('"1"');

    const acknowledgedResponse = await controlPlane.app.inject({
      method: 'POST',
      url: `/api/business-exceptions/${capacity.id}/acknowledge`,
      headers: headers(),
      payload: { aggregateVersion: detail.aggregateVersion },
    });
    expect(acknowledgedResponse.statusCode, acknowledgedResponse.body).toBe(200);
    const acknowledged = businessExceptionDetailSchema.parse(acknowledgedResponse.json());
    expect(acknowledged).toMatchObject({ status: 'acknowledged', ownerDisplayState: 'mine', aggregateVersion: 2 });

    const analysisRequest = {
      aggregateVersion: acknowledged.aggregateVersion,
      requestedExpertTarget: { mode: 'auto' as const },
      idempotencyKey: 'exception-analysis-0001',
    };
    const analysisResponse = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${capacity.id}/analysis-task`,
      headers: headers(), payload: analysisRequest,
    });
    expect(analysisResponse.statusCode, analysisResponse.body).toBe(201);
    const analysis = createExceptionAnalysisTaskResponseSchema.parse(analysisResponse.json());
    const analysisReplay = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${capacity.id}/analysis-task`,
      headers: headers(), payload: analysisRequest,
    });
    expect(createExceptionAnalysisTaskResponseSchema.parse(analysisReplay.json())).toEqual(analysis);

    const taskDetailResponse = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-tasks/${analysis.taskId}`, headers: headers(),
    });
    expect(taskDetailResponse.statusCode, taskDetailResponse.body).toBe(200);
    const taskDetail = taskDetailResponse.json<{
      conversationId: string;
      evidence: Array<{ audience: unknown }>;
    }>();
    expect(taskDetail.evidence).toHaveLength(5);
    expect(taskDetail.evidence.every((entry) => JSON.stringify(entry.audience) === JSON.stringify({
      kind: 'private_conversation', conversationId: analysis.conversationId,
    }))).toBe(true);

    const counts = await controlPlane.repository.pool.query<{
      exceptions: number; sources: number; bindings: number; tasks: number; conversations: number;
      approvals: number; evidence: number; lineage: number; exception_events: number; exception_outbox: number;
      aligned_authority: number;
    }>(`SELECT
      (SELECT count(*)::int FROM business_exceptions) exceptions,
      (SELECT count(*)::int FROM business_exception_source_snapshots) sources,
      (SELECT count(*)::int FROM business_exception_analysis_bindings) bindings,
      (SELECT count(*)::int FROM business_tasks WHERE capability_version_id='cap_operations_exception_assist_v1_shadow_1') tasks,
      (SELECT count(*)::int FROM conversations WHERE id=$1) conversations,
      (SELECT count(*)::int FROM approval_versions WHERE business_task_id=$2) approvals,
      (SELECT count(*)::int FROM evidence_items WHERE business_task_id=$2 AND source_kind='business_exception_snapshot') evidence,
      (SELECT count(*)::int FROM lineage_records WHERE business_task_id=$2 AND from_kind='business_exception_snapshot') lineage,
      (SELECT count(*)::int FROM business_exception_events) exception_events,
      (SELECT count(*)::int FROM outbox_events WHERE business_exception_id IS NOT NULL) exception_outbox,
      (SELECT count(*)::int FROM business_exception_analysis_bindings binding
        JOIN business_tasks task ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
        JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
        WHERE binding.business_task_id=$2
          AND binding.expert_catalog_version=task.expert_catalog_version_id
          AND binding.capability_version_id=task.capability_version_id
          AND binding.input_digest=task.input_digest
          AND task.expert_target->'requested'=binding.requested_expert_target
          AND task.expert_target->'resolved'=binding.resolved_expert_target
          AND approval.subject_digest=binding.approval_subject_digest
          AND approval.subject->>'inputDigest'=binding.input_digest
          AND approval.subject->'requestedExpertTarget'=binding.requested_expert_target
          AND approval.subject->'resolvedExpertTarget'=binding.resolved_expert_target) aligned_authority`, [
      analysis.conversationId, analysis.taskId,
    ]);
    expect(counts.rows[0]).toEqual({
      exceptions: 2,
      sources: 2,
      bindings: 1,
      tasks: 1,
      conversations: 1,
      approvals: 1,
      evidence: 5,
      lineage: 5,
      exception_events: 4,
      exception_outbox: 4,
      aligned_authority: 1,
    });

    const conflict = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${capacity.id}/analysis-task`, headers: headers(),
      payload: { ...analysisRequest, requestedExpertTarget: { mode: 'team', teamId: 'team.operations.exception' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'ANALYSIS_BINDING_CONFLICT' } });
    expect(conflict.body).not.toContain(analysis.taskId);
    expect(conflict.body).not.toContain(analysis.conversationId);
  });

  it('fails invalid seed environments before any business write', async () => {
    for (const candidate of [
      { nodeEnvironment: 'production', controlPlaneHost: '127.0.0.1', tenantId: 'tenant_local' },
      { nodeEnvironment: 'test', controlPlaneHost: '192.168.1.10', tenantId: 'tenant_local' },
      { nodeEnvironment: 'test', controlPlaneHost: '127.0.0.1', tenantId: 'tenant_other' },
    ]) {
      await expect(controlPlane.businessExceptionRepository.seedFixedFixtures(candidate)).rejects.toMatchObject({
        code: 'FIXTURE_SEED_NOT_ALLOWED',
      });
    }
    await controlPlane.repository.pool.query('UPDATE control_plane_database_metadata SET is_non_production=false WHERE singleton=true');
    await expect(controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: 'localhost', tenantId: 'tenant_local',
    })).rejects.toMatchObject({ code: 'FIXTURE_DATABASE_NOT_ALLOWED' });
    const counts = await controlPlane.repository.pool.query<{ exceptions: number; events: number; audits: number; outbox: number }>(`SELECT
      (SELECT count(*)::int FROM business_exceptions) exceptions,
      (SELECT count(*)::int FROM business_exception_events) events,
      (SELECT count(*)::int FROM audit_events) audits,
      (SELECT count(*)::int FROM outbox_events) outbox`);
    expect(counts.rows[0]).toEqual({ exceptions: 0, events: 0, audits: 0, outbox: 0 });
  });
});
