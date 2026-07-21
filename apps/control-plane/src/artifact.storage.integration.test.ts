import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactIngestResponseSchema } from '@geneway/contracts';
import { SOLUTION_ANALYSIS_DEMO_SHA256, validateTextUpload } from '@geneway/ingestion';
import { StorageObjectAlreadyExistsError, type ObjectStorage } from '@geneway/storage';
import { createControlPlane, type ControlPlane } from './index.js';
import { ArtifactService } from './artifact-service.js';
import { multipartPayload } from './artifact-test-helpers.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for storage integration tests');

const headers = (key: string, boundary?: string): Readonly<Record<string, string>> => ({
  origin: 'http://localhost:3200',
  'idempotency-key': key,
  ...(boundary === undefined ? {} : { 'content-type': `multipart/form-data; boundary=${boundary}` }),
});

describe('Gate 0.2A.1 real storage vertical', () => {
  let controlPlane: ControlPlane;
  let fixture: Buffer;

  beforeAll(async () => {
    fixture = await readFile(path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt'));
    controlPlane = await createControlPlane({ databaseUrl });
    if (controlPlane.artifactService === null) throw new Error('Storage integration test requires GENEWAY S3 configuration');
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  async function createConversation(): Promise<string> {
    const response = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers(`conversation-${crypto.randomUUID()}`) });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function upload(conversationId: string, key: string, bytes = fixture, fileName = 'solution-analysis-demo-v2.txt', mediaType = 'text/plain') {
    const multipart = multipartPayload([{ fieldName: 'file', fileName, mediaType, bytes }]);
    return controlPlane.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/uploads`,
      headers: headers(key, multipart.boundary),
      payload: multipart.body,
    });
  }

  it('correlates the served API, Postgres and real S3 object without creating a business task', async () => {
    const conversationId = await createConversation();
    const response = await upload(conversationId, 'storage-happy-0001');
    expect(response.statusCode, response.body).toBe(201);
    const result = artifactIngestResponseSchema.parse(response.json());
    expect(result.artifact).toMatchObject({
      sizeBytes: 180,
      contentSha256: SOLUTION_ANALYSIS_DEMO_SHA256,
      availability: 'active',
      integrity: 'verified',
    });
    expect(result.documentSnapshot).toMatchObject({
      artifactId: result.artifact.id,
      manifestId: result.artifact.manifestId,
      conversationId,
      simulationProfile: 'solution-analysis-demo/v2',
      profileRegistryVersion: 'gate0.2a-profile-registry/1',
      dataClass: 'C1',
      trust: 'untrusted_text',
    });
    expect(result.executionEligibility).toEqual({ eligible: true });

    const db = await controlPlane.repository.pool.query<{
      artifact_id: string; manifest_id: string; snapshot_id: string; content_sha256: string; size_bytes: string;
      availability: string; integrity: string; business_tasks: string; outbox_events: string;
    }>(`SELECT a.id artifact_id,m.id manifest_id,d.id snapshot_id,a.content_sha256,a.size_bytes::text,s.availability,s.integrity,
      (SELECT count(*)::text FROM business_tasks) business_tasks,
      (SELECT count(*)::text FROM outbox_events) outbox_events
      FROM artifacts a JOIN artifact_manifests m ON m.tenant_id=a.tenant_id AND m.artifact_id=a.id
      JOIN artifact_states s ON s.tenant_id=a.tenant_id AND s.artifact_id=a.id
      JOIN document_snapshots d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.id
      WHERE a.tenant_id='tenant_local' AND a.id=$1`, [result.artifact.id]);
    expect(db.rows).toEqual([expect.objectContaining({
      artifact_id: result.artifact.id,
      manifest_id: result.artifact.manifestId,
      snapshot_id: result.documentSnapshot.id,
      content_sha256: SOLUTION_ANALYSIS_DEMO_SHA256,
      size_bytes: '180',
      availability: 'active',
      integrity: 'verified',
      business_tasks: '0',
      outbox_events: '0',
    })]);

    const manifest = await controlPlane.repository.pool.query<{ storage_key: string }>('SELECT storage_key FROM artifact_manifests WHERE tenant_id=$1 AND id=$2', ['tenant_local', result.artifact.manifestId]);
    const storage = controlPlane.artifactService?.storage;
    if (storage === undefined) throw new Error('Storage disappeared during the integration test');
    const key = manifest.rows[0]?.storage_key;
    if (key === undefined) throw new Error('Manifest storage key is missing');
    const [head, stored] = await Promise.all([storage.head(key), storage.getBytes(key, 1_048_576)]);
    expect(head).toMatchObject({ sizeBytes: 180, contentType: 'text/plain', contentSha256: SOLUTION_ANALYSIS_DEMO_SHA256 });
    expect(Buffer.from(stored)).toEqual(fixture);

    const download = await controlPlane.app.inject({ method: 'GET', url: result.artifact.downloadUrl });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toMatch(/^text\/plain/u);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.rawPayload).toEqual(fixture);

    const listed = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/document-snapshots` });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({ documentSnapshots: [{
      status: 'available',
      documentSnapshot: result.documentSnapshot,
      artifactState: {
        availability: 'active',
        integrity: 'verified',
        retentionStatus: 'active',
        reconcileStatus: 'in_sync',
        stateVersion: 1,
        downloadAllowed: true,
      },
      downloadUrl: result.artifact.downloadUrl,
      executionEligibility: { eligible: true },
    }] });
  });

  it('hides snapshot metadata after lifecycle authorization fails and records the denial', async () => {
    const conversationId = await createConversation();
    const uploaded = await upload(conversationId, 'storage-list-lifecycle-01');
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const result = artifactIngestResponseSchema.parse(uploaded.json());
    await controlPlane.repository.pool.query(`UPDATE artifact_states
      SET retention_status='expired',state_version=state_version+1,updated_at=now()
      WHERE tenant_id=$1 AND artifact_id=$2`, ['tenant_local', result.artifact.id]);

    const listed = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/document-snapshots` });
    expect(listed.statusCode).toBe(404);
    expect(listed.json()).toEqual({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact was not found', details: null } });
    expect(listed.body).not.toContain(result.artifact.id);
    expect(listed.body).not.toContain(result.artifact.contentSha256);
    expect(listed.body).not.toContain(result.documentSnapshot.displayName);
    const audit = await controlPlane.repository.pool.query<{ reason_code: string }>(`SELECT reason_code FROM audit_events
      WHERE tenant_id=$1 AND event_type='artifact.snapshot.read.denied' AND resource_id=$2`, ['tenant_local', result.artifact.id]);
    expect(audit.rows).toEqual([{ reason_code: 'ARTIFACT_RETENTION_EXPIRED' }]);
  });

  it('replays an equivalent upload and conflicts when the same key changes meaning', async () => {
    const conversationId = await createConversation();
    const first = await upload(conversationId, 'storage-idempotent-01');
    const replay = await upload(conversationId, 'storage-idempotent-01');
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const conflict = await upload(conversationId, 'storage-idempotent-01', Buffer.from('changed\n'), 'changed.txt', 'text/plain');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const counts = await controlPlane.repository.pool.query<{ intents: string; artifacts: string; snapshots: string }>(`SELECT
      (SELECT count(*)::text FROM artifact_ingest_intents) intents,
      (SELECT count(*)::text FROM artifacts) artifacts,
      (SELECT count(*)::text FROM document_snapshots) snapshots`);
    expect(counts.rows[0]).toEqual({ intents: '1', artifacts: '1', snapshots: '1' });
  });

  it('uses row-version CAS so only one concurrent caller claims an ingest intent', async () => {
    const conversationId = await createConversation();
    const intent = await controlPlane.artifactRepository.createOrLoadIntent({
      principal: { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      conversationId,
      idempotencyKey: 'intent-cas-claim-001',
      bucket: controlPlane.artifactService?.storage.bucket ?? 'missing',
      upload: validateTextUpload({ fileName: 'solution-analysis-demo-v2.txt', mediaType: 'text/plain', bytes: fixture }),
    });
    const [left, right] = await Promise.all([
      controlPlane.artifactRepository.transitionIntent({
        principal: { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
        intent,
        expectedStatuses: ['intent_created'],
        nextStatus: 'put_inflight',
      }),
      controlPlane.artifactRepository.transitionIntent({
        principal: { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
        intent,
        expectedStatuses: ['intent_created'],
        nextStatus: 'put_inflight',
      }),
    ]);
    expect([left, right].filter((value) => value !== null)).toHaveLength(1);
    const persisted = await controlPlane.artifactRepository.getIntent(
      { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      intent.id,
    );
    expect(persisted).toMatchObject({ status: 'put_inflight', stateVersion: intent.stateVersion + 1 });
  });

  it('returns a live ready projection and never replays stale availability metadata', async () => {
    const conversationId = await createConversation();
    const first = await upload(conversationId, 'ready-projection-001');
    expect(first.statusCode, first.body).toBe(201);
    const result = artifactIngestResponseSchema.parse(first.json());
    await controlPlane.repository.pool.query(`UPDATE artifact_states
      SET availability='missing',integrity='failed',reconcile_status='required',failure_code='TEST_MISSING',
          last_error='TEST_MISSING',state_version=state_version+1
      WHERE tenant_id='tenant_local' AND artifact_id=$1`, [result.artifact.id]);
    const replay = await upload(conversationId, 'ready-projection-001');
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_READY' } });
    expect(replay.body).not.toContain('"availability":"active"');
    await expect(controlPlane.artifactRepository.transitionIntent({
      principal: { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      intent: await controlPlane.artifactRepository.getIntent(
        { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
        result.ingest.id,
      ),
      expectedStatuses: ['ready'],
      nextStatus: 'reconcile_required',
    })).rejects.toMatchObject({ code: 'INVALID_INGEST_TRANSITION' });
  });

  it('allows only one integrity-state winner and one audit record', async () => {
    const conversationId = await createConversation();
    const response = await upload(conversationId, 'state-cas-001');
    const result = artifactIngestResponseSchema.parse(response.json());
    const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
    const artifact = await controlPlane.artifactRepository.getAuthorizedArtifact(principal, result.artifact.id);
    const outcomes = await Promise.all([
      controlPlane.artifactRepository.markIntegrityFailure(principal, artifact, 'missing', 'TEST_RACE'),
      controlPlane.artifactRepository.markIntegrityFailure(principal, artifact, 'missing', 'TEST_RACE'),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    const audits = await controlPlane.repository.pool.query<{ count: string }>(`SELECT count(*)::text count FROM audit_events
      WHERE tenant_id='tenant_local' AND resource_id=$1 AND event_type='artifact.integrity.failed'`, [result.artifact.id]);
    expect(audits.rows).toEqual([{ count: '1' }]);
  });

  it('rejects expired retention before invoking the object storage port', async () => {
    const conversationId = await createConversation();
    const response = await upload(conversationId, 'retention-before-storage-001');
    const result = artifactIngestResponseSchema.parse(response.json());
    await controlPlane.repository.pool.query(`UPDATE artifact_states SET retention_status='expired',
      retention_expires_at=now()-interval '1 second',state_version=state_version+1
      WHERE tenant_id='tenant_local' AND artifact_id=$1`, [result.artifact.id]);
    let calls = 0;
    const blockedStorage: ObjectStorage = {
      bucket: controlPlane.artifactService?.storage.bucket ?? 'missing',
      putCreateOnly() { calls += 1; return Promise.reject(new Error('unexpected put')); },
      head() { calls += 1; return Promise.reject(new Error('unexpected head')); },
      getBytes() { calls += 1; return Promise.reject(new Error('unexpected get')); },
    };
    const service = new ArtifactService(controlPlane.artifactRepository, blockedStorage);
    await expect(service.download(
      { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' },
      result.artifact.id,
    )).rejects.toMatchObject({ code: 'ARTIFACT_RETENTION_EXPIRED' });
    expect(calls).toBe(0);
  });

  it('qualifies create-only conditional PUT against the pinned VersityGW image', async () => {
    const storage = controlPlane.artifactService?.storage;
    if (storage === undefined) throw new Error('Storage disappeared during the integration test');
    const key = `tenants/tenant_local/artifacts/conformance-${crypto.randomUUID()}/source.txt`;
    const a = new TextEncoder().encode('A');
    const b = new TextEncoder().encode('B');
    await storage.putCreateOnly({ key, bytes: a, contentType: 'text/plain', contentSha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd' });
    await expect(storage.putCreateOnly({ key, bytes: b, contentType: 'text/plain', contentSha256: 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c' }))
      .rejects.toBeInstanceOf(StorageObjectAlreadyExistsError);
    await expect(storage.getBytes(key, 1)).resolves.toEqual(a);
  });
});
