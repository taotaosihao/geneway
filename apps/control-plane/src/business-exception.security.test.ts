import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Principal } from '@geneway/contracts';
import { createControlPlane, type ControlPlane } from './index.js';
import {
  GATE_0_2B_EXCEPTION_FIXTURES,
  type BusinessExceptionFixture,
} from './business-exception-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for BusinessException security tests');

const principalHeaders = (userId: string) => ({ origin: 'http://localhost:3200', 'x-test-principal': userId });

describe('Gate 0.2B.2 BusinessException authorization boundaries', () => {
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
      (singleton,is_non_production,environment_name) VALUES (true,true,'vitest-security')
      ON CONFLICT (singleton) DO UPDATE SET is_non_production=true,environment_name='vitest-security',updated_at=now()`);
    await controlPlane.repository.pool.query(`INSERT INTO users (tenant_id,id,display_name)
      VALUES ('tenant_local','user_peer','Peer user');
      INSERT INTO roles (tenant_id,user_id,role) VALUES
        ('tenant_local','user_peer','solution_reviewer');
      INSERT INTO resource_scopes (tenant_id,user_id,resource_scope) VALUES
        ('tenant_local','user_local','factory-01/workshop-machining/line-02'),
        ('tenant_local','user_peer','factory-01/workshop-machining/line-02')`);
    await controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: 'localhost', tenantId: 'tenant_local',
    });
  });

  it('keeps resource exception visibility separate from private task and Artifact audience', async () => {
    const exception = (await controlPlane.repository.pool.query<{ id: string }>(
      "SELECT id FROM business_exceptions WHERE exception_type='capacity_progress_lag'",
    )).rows[0];
    if (exception === undefined) throw new Error('capacity fixture is missing');

    const peerSource = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-exceptions/${exception.id}`, headers: principalHeaders('user_peer'),
    });
    expect(peerSource.statusCode, peerSource.body).toBe(200);

    const ownerAck = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${exception.id}/acknowledge`,
      headers: principalHeaders('user_local'), payload: { aggregateVersion: 1 },
    });
    expect(ownerAck.statusCode, ownerAck.body).toBe(200);
    const peerAck = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${exception.id}/acknowledge`,
      headers: principalHeaders('user_peer'), payload: { aggregateVersion: 1 },
    });
    expect(peerAck.statusCode).toBe(409);
    expect(peerAck.body).not.toContain('user_local');

    const analysis = await controlPlane.app.inject({
      method: 'POST', url: `/api/business-exceptions/${exception.id}/analysis-task`,
      headers: principalHeaders('user_local'),
      payload: { aggregateVersion: 2, requestedExpertTarget: { mode: 'auto' }, idempotencyKey: 'security-analysis-0001' },
    });
    expect(analysis.statusCode, analysis.body).toBe(201);
    const privateIds = analysis.json<{ taskId: string; conversationId: string }>();

    const authority = await controlPlane.repository.pool.query<{
      input_digest: string; subject_input_digest: string;
    }>(`SELECT task.input_digest,approval.subject->>'inputDigest' subject_input_digest
      FROM business_tasks task JOIN approval_versions approval
        ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
      WHERE task.tenant_id='tenant_local' AND task.id=$1`, [privateIds.taskId]);
    expect(authority.rows[0]?.input_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(authority.rows[0]?.subject_input_digest).toBe(authority.rows[0]?.input_digest);

    const tamperClient = await controlPlane.repository.pool.connect();
    try {
      await tamperClient.query('BEGIN');
      await tamperClient.query(`UPDATE business_tasks SET input_digest=$3
        WHERE tenant_id=$1 AND id=$2`, ['tenant_local', privateIds.taskId, 'f'.repeat(64)]);
      await expect(tamperClient.query('COMMIT')).rejects.toThrow(
        /business exception task authority no longer matches/u,
      );
    } finally {
      await tamperClient.query('ROLLBACK');
      tamperClient.release();
    }

    const peerTask = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-tasks/${privateIds.taskId}`, headers: principalHeaders('user_peer'),
    });
    expect(peerTask.statusCode).toBe(404);
    expect(peerTask.body).not.toContain(privateIds.conversationId);

    const binding = await controlPlane.repository.pool.query<{ source_version_id: string; resource_scope: string }>(`SELECT
      binding.source_version_id,snapshot.resource_scope
      FROM business_exception_analysis_bindings binding
      JOIN business_exception_source_snapshots snapshot
        ON snapshot.tenant_id=binding.tenant_id AND snapshot.source_version_id=binding.source_version_id
      WHERE binding.business_task_id=$1`, [privateIds.taskId]);
    const source = binding.rows[0];
    if (source === undefined) throw new Error('analysis binding is missing');
    await controlPlane.repository.pool.query(`INSERT INTO artifacts
      (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,
       business_task_id,root_artifact_id,business_exception_source_version_id,data_class,audience,resource_scope)
      VALUES ('tenant_local','artifact_exception_security',$1,'user_local','simulation_report','report.md','text/markdown',1,$2,
        $3,NULL,$4,'C1',$5::jsonb,$6)`, [
      privateIds.conversationId, 'a'.repeat(64), privateIds.taskId, source.source_version_id,
      JSON.stringify({ kind: 'private-conversation', conversationId: privateIds.conversationId }), source.resource_scope,
    ]);
    await controlPlane.repository.pool.query(`INSERT INTO artifact_manifests
        (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
      VALUES ('tenant_local','manifest_exception_security','artifact_exception_security','geneway-artifacts',
        'tenants/tenant_local/artifacts/artifact_exception_security/report.md','report.md','text/markdown',1,$1,'gate0.2a-internal/v1')`, [
      'a'.repeat(64),
    ]);
    await controlPlane.repository.pool.query(`INSERT INTO artifact_states
        (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status)
      VALUES ('tenant_local','artifact_exception_security','active','verified','active',now()+interval '1 day','in_sync')`);
    await expect(controlPlane.artifactRepository.getAuthorizedArtifact(
      { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      'artifact_exception_security',
    )).resolves.toMatchObject({ businessExceptionSourceVersionId: source.source_version_id });

    await controlPlane.repository.pool.query(`DELETE FROM resource_scopes
      WHERE tenant_id='tenant_local' AND user_id='user_local' AND resource_scope=$1`, [source.resource_scope]);
    const revokedSource = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-exceptions/${exception.id}`, headers: principalHeaders('user_local'),
    });
    expect(revokedSource.statusCode).toBe(404);
    const revokedTask = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-tasks/${privateIds.taskId}`, headers: principalHeaders('user_local'),
    });
    expect(revokedTask.statusCode).toBe(404);
    await expect(controlPlane.artifactRepository.getAuthorizedArtifact(
      { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      'artifact_exception_security',
    )).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND', statusCode: 404 });
  });

  it('invalidates pagination snapshots after authorization epoch changes and rejects tampered fixtures with zero writes', async () => {
    const first = await controlPlane.app.inject({
      method: 'GET', url: '/api/business-exceptions?limit=1', headers: principalHeaders('user_peer'),
    });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();
    await controlPlane.repository.pool.query(`DELETE FROM roles
      WHERE tenant_id='tenant_local' AND user_id='user_peer' AND role='solution_reviewer'`);
    const staleCursor = await controlPlane.app.inject({
      method: 'GET', url: `/api/business-exceptions?limit=1&cursor=${encodeURIComponent(String(cursor))}`,
      headers: principalHeaders('user_peer'),
    });
    expect(staleCursor.statusCode).toBe(409);
    expect(staleCursor.json()).toMatchObject({ error: { code: 'CURSOR_INVALID' } });

    await controlPlane.repository.resetForTest();
    await controlPlane.repository.pool.query(`INSERT INTO control_plane_database_metadata
      (singleton,is_non_production,environment_name) VALUES (true,true,'vitest-security')
      ON CONFLICT (singleton) DO UPDATE SET is_non_production=true`);
    const [capacityFixture, alarmFixture] = GATE_0_2B_EXCEPTION_FIXTURES;
    if (capacityFixture === undefined || alarmFixture === undefined) throw new Error('fixed fixtures are missing');
    const tampered: readonly BusinessExceptionFixture[] = [
      { ...capacityFixture, canonicalBytes: `${capacityFixture.canonicalBytes} ` },
      alarmFixture,
    ];
    await expect(controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: 'localhost', tenantId: 'tenant_local', fixtures: tampered,
    })).rejects.toMatchObject({ code: 'FIXTURE_SET_INVALID' });
    const tamperedBytes = `${capacityFixture.canonicalBytes.slice(0, -1)},"unexpected":true}`;
    const tamperedRehashed: readonly BusinessExceptionFixture[] = [{
      ...capacityFixture,
      canonicalBytes: tamperedBytes,
      expectedSha256: createHash('sha256').update(tamperedBytes).digest('hex'),
    }, alarmFixture];
    await expect(controlPlane.businessExceptionRepository.seedFixedFixtures({
      nodeEnvironment: 'test', controlPlaneHost: 'localhost', tenantId: 'tenant_local', fixtures: tamperedRehashed,
    })).rejects.toMatchObject({ code: 'FIXTURE_SET_INVALID' });
    const counts = await controlPlane.repository.pool.query<{ business_rows: number }>(`SELECT (
      (SELECT count(*) FROM business_exceptions)
      +(SELECT count(*) FROM business_exception_source_snapshots)
      +(SELECT count(*) FROM business_exception_events)
      +(SELECT count(*) FROM audit_events)
      +(SELECT count(*) FROM outbox_events)
    )::int business_rows`);
    expect(counts.rows[0]?.business_rows).toBe(0);
  });
});
