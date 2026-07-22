import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  HttpObjectReconciliationStorage,
  StorageObjectNotFoundError,
  type ObjectReconciliationStorage,
} from '@geneway/storage';
import { validateTextUpload } from '@geneway/ingestion';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './index.js';
import { StorageReconciler } from './storage-reconciler.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required for storage reconciliation integration tests`);
  return value;
}

const databaseUrl = requiredEnvironment('DATABASE_URL');
const reconciliationUrl = requiredEnvironment('GENEWAY_RECONCILIATION_ADAPTER_URL');
const reconciliationToken = requiredEnvironment('GENEWAY_RECONCILIATION_ADAPTER_TOKEN');
const endpoint = requiredEnvironment('GENEWAY_S3_ENDPOINT');
const bucket = requiredEnvironment('GENEWAY_S3_BUCKET');
const allowedPrefix = requiredEnvironment('GENEWAY_STORAGE_ALLOWED_PREFIX');
const oracleAccessKeyId = requiredEnvironment('GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID');
const oracleSecretAccessKey = requiredEnvironment('GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY');
const tenantId = 'tenant_local';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) throw new Error('Deferred promise was not initialized');
      resolvePromise();
    },
  };
}

async function within<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the reconciliation boundary')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('Gate 0.2A V4 real storage reconciliation', () => {
  let controlPlane: ControlPlane;
  let storage: HttpObjectReconciliationStorage;
  let reconciler: StorageReconciler;
  let oracle: S3Client;
  const cleanupKeys = new Set<string>();

  beforeAll(async () => {
    controlPlane = await createControlPlane({ databaseUrl });
    storage = new HttpObjectReconciliationStorage({
      baseUrl: reconciliationUrl,
      token: reconciliationToken,
      bucket,
      allowedPrefix,
    });
    reconciler = new StorageReconciler(controlPlane.repository.pool, storage, tenantId, allowedPrefix);
    oracle = new S3Client({
      endpoint,
      region: process.env.GENEWAY_S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: oracleAccessKeyId, secretAccessKey: oracleSecretAccessKey },
      maxAttempts: 2,
    });
    await controlPlane.repository.pool.query('SELECT 1');
    await storage.listPrefix(allowedPrefix);
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  async function cleanupObjects(): Promise<void> {
    await Promise.all([...cleanupKeys].map((key) => oracle.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
    cleanupKeys.clear();
  }

  afterEach(cleanupObjects);

  afterAll(async () => {
    await cleanupObjects();
    oracle.destroy();
    await controlPlane.app.close();
  });

  function objectKey(label: string): string {
    return `${allowedPrefix}reconciliation-${label}-${randomUUID()}/object.txt`;
  }

  async function putObject(key: string, bytes: Uint8Array): Promise<string> {
    cleanupKeys.add(key);
    const contentSha256 = sha256(bytes);
    await oracle.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'text/plain',
      Metadata: { 'content-sha256': contentSha256 },
    }));
    return contentSha256;
  }

  async function createStaleInflightIntent(label: string, bytes: Uint8Array) {
    const principal = { tenantId, userId: 'user_local', trust: 'trusted-local' } as const;
    const idempotencyKey = `stale-ingest-${label}-${randomUUID()}`;
    const conversation = await controlPlane.repository.createConversation(principal, `conversation-${label}-${randomUUID()}`);
    const upload = validateTextUpload({ fileName: `${label}.txt`, mediaType: 'text/plain', bytes });
    const created = await controlPlane.artifactRepository.createOrLoadIntent({
      principal,
      conversationId: conversation.id,
      idempotencyKey,
      bucket,
      upload,
    });
    const intent = await controlPlane.artifactRepository.transitionIntent({
      principal,
      intent: created,
      expectedStatuses: ['intent_created'],
      nextStatus: 'put_inflight',
    });
    if (intent === null) throw new Error('Could not claim the stale ingest fixture');
    return { principal, idempotencyKey, conversationId: conversation.id, upload, intent };
  }

  async function markIntentStale(intentId: string): Promise<void> {
    await controlPlane.repository.pool.query(`UPDATE artifact_ingest_intents SET updated_at=now()-interval '2 minutes'
      WHERE tenant_id=$1 AND id=$2`, [tenantId, intentId]);
  }

  function storageWithHeadHook(
    hook: (key: string, call: number) => Promise<void>,
  ): ObjectReconciliationStorage {
    let calls = 0;
    return {
      bucket: storage.bucket,
      async head(key) {
        calls += 1;
        await hook(key, calls);
        return storage.head(key);
      },
      getBytes: (key, maximumBytes) => storage.getBytes(key, maximumBytes),
      listPrefix: (prefix) => storage.listPrefix(prefix),
      delete: (key) => storage.delete(key),
    };
  }

  it('finds an S3-only orphan through the real reconciliation inventory adapter', async () => {
    const key = objectKey('scan');
    await putObject(key, new TextEncoder().encode('unreferenced object found by inventory scan'));

    const result = await reconciler.scan();

    expect(result.clean).toBe(false);
    expect(result.databaseObjectCount).toBe(0);
    expect(result.findings).toContainEqual({ kind: 's3_object_orphan', bucket, key });
  });

  it('turns an expired objectless PUT authority into a retryable confirmed failure', async () => {
    const bytes = new TextEncoder().encode('retry the upload after the original Control Plane died');
    const fixture = await createStaleInflightIntent('missing', bytes);
    await markIntentStale(fixture.intent.id);

    await expect(reconciler.reconcileStaleIngestIntent(tenantId, fixture.intent.id, new Date())).resolves
      .toMatch(/^(?:put_failed_confirmed|already_settled)$/u);
    const recovered = await controlPlane.repository.pool.query<{ status: string; failure_code: string; audits: number }>(`SELECT intent.status,intent.failure_code,
      (SELECT count(*)::int FROM audit_events audit WHERE audit.tenant_id=intent.tenant_id
        AND audit.resource_type='artifact_ingest_intent' AND audit.resource_id=intent.id
        AND audit.event_type='storage.ingest.recovered') audits
      FROM artifact_ingest_intents intent WHERE intent.tenant_id=$1 AND intent.id=$2`, [tenantId, fixture.intent.id]);
    expect(recovered.rows).toEqual([{
      status: 'put_failed_confirmed',
      failure_code: 'STORAGE_PUT_NOT_OBSERVED_AFTER_LEASE',
      audits: 1,
    }]);

    const artifactService = controlPlane.artifactService;
    if (artifactService === null) throw new Error('Storage reconciliation test requires online artifact storage');
    cleanupKeys.add(fixture.intent.storageKey);
    const completed = await artifactService.ingest({
      principal: fixture.principal,
      conversationId: fixture.conversationId,
      idempotencyKey: fixture.idempotencyKey,
      upload: fixture.upload,
    });
    expect(completed).toMatchObject({ ingest: { id: fixture.intent.id, status: 'ready' } });
    await expect(storage.head(fixture.intent.storageKey)).resolves.toMatchObject({
      sizeBytes: bytes.byteLength,
      contentSha256: sha256(bytes),
    });
  });

  it('recovers a valid object left behind by an expired PUT authority', async () => {
    const bytes = new TextEncoder().encode('object bytes survived the Control Plane crash');
    const fixture = await createStaleInflightIntent('object-present', bytes);
    await putObject(fixture.intent.storageKey, bytes);
    await markIntentStale(fixture.intent.id);

    await expect(reconciler.reconcileStaleIngestIntent(tenantId, fixture.intent.id, new Date())).resolves
      .toMatch(/^(?:object_verified|already_settled)$/u);
    const artifactService = controlPlane.artifactService;
    if (artifactService === null) throw new Error('Storage reconciliation test requires online artifact storage');
    const completed = await artifactService.ingest({
      principal: fixture.principal,
      conversationId: fixture.conversationId,
      idempotencyKey: fixture.idempotencyKey,
      upload: fixture.upload,
    });
    expect(completed).toMatchObject({ ingest: { id: fixture.intent.id, status: 'ready' } });
  });

  it('fails closed when an expired PUT authority points at mismatched bytes', async () => {
    const expected = new TextEncoder().encode('expected immutable source bytes');
    const fixture = await createStaleInflightIntent('integrity', expected);
    await putObject(fixture.intent.storageKey, new TextEncoder().encode('different immutable source bytes'));
    await markIntentStale(fixture.intent.id);

    await expect(reconciler.reconcileStaleIngestIntent(tenantId, fixture.intent.id, new Date())).resolves
      .toMatch(/^(?:integrity_error|already_settled)$/u);
    const failed = await controlPlane.repository.pool.query<{ status: string; failure_code: string }>(`SELECT status,failure_code
      FROM artifact_ingest_intents WHERE tenant_id=$1 AND id=$2`, [tenantId, fixture.intent.id]);
    expect(failed.rows).toEqual([{
      status: 'integrity_error',
      failure_code: 'STORAGE_PUT_RECOVERY_INTEGRITY_FAILED',
    }]);
    expect(await reconciler.scan()).toMatchObject({ clean: false });
  });

  it('creates a tombstone, deletes and audits once, and is idempotent on retry', async () => {
    const key = objectKey('delete');
    const bytes = new TextEncoder().encode('orphan scheduled for safe deletion');
    const contentSha256 = await putObject(key, bytes);

    await reconciler.deleteUnreferencedObject(key);
    await expect(storage.head(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);

    const first = await controlPlane.repository.pool.query<{
      id: string;
      status: string;
      state_version: number;
      size_bytes: number;
      content_sha256: string;
      deleted: boolean;
      audit_count: number;
      audit_details: Readonly<Record<string, unknown>>;
    }>(`SELECT tombstone.id,tombstone.status,tombstone.state_version::int,tombstone.size_bytes::int,
      tombstone.content_sha256,(tombstone.deleted_at IS NOT NULL) deleted,
      count(audit.id)::int audit_count,(array_agg(audit.details ORDER BY audit.cursor))[1] audit_details
      FROM storage_orphan_tombstones tombstone
      LEFT JOIN audit_events audit ON audit.tenant_id=tombstone.tenant_id
        AND audit.resource_type='storage_orphan_tombstone' AND audit.resource_id=tombstone.id
        AND audit.event_type='storage.orphan.deleted' AND audit.outcome='allowed'
        AND audit.reason_code='UNREFERENCED_OBJECT_DELETED'
      WHERE tombstone.tenant_id=$1 AND tombstone.storage_bucket=$2 AND tombstone.storage_key=$3
      GROUP BY tombstone.id,tombstone.status,tombstone.state_version,tombstone.size_bytes,
        tombstone.content_sha256,tombstone.deleted_at`, [tenantId, bucket, key]);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      status: 'deleted',
      state_version: 2,
      size_bytes: bytes.byteLength,
      content_sha256: contentSha256,
      deleted: true,
      audit_count: 1,
    });
    expect(first.rows[0]?.audit_details).toMatchObject({ bucket, key, sizeBytes: bytes.byteLength, contentSha256 });

    await reconciler.deleteUnreferencedObject(key);
    const afterRetry = await controlPlane.repository.pool.query<{ tombstones: number; audits: number }>(`SELECT
      (SELECT count(*)::int FROM storage_orphan_tombstones
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3) tombstones,
      (SELECT count(*)::int FROM audit_events audit JOIN storage_orphan_tombstones tombstone
        ON tombstone.tenant_id=audit.tenant_id AND tombstone.id=audit.resource_id
        WHERE tombstone.tenant_id=$1 AND tombstone.storage_bucket=$2 AND tombstone.storage_key=$3
          AND audit.event_type='storage.orphan.deleted') audits`, [tenantId, bucket, key]);
    expect(afterRetry.rows).toEqual([{ tombstones: 1, audits: 1 }]);

    const scan = await reconciler.scan();
    expect(scan.findings.filter((finding) => finding.key === key)).toEqual([]);
  });

  it('fails closed when the object identity is replaced after tombstone creation', async () => {
    const key = objectKey('replacement');
    const original = new TextEncoder().encode('original orphan identity');
    const replacement = new TextEncoder().encode('replacement object identity');
    const originalSha256 = await putObject(key, original);
    const replacementSha256 = sha256(replacement);
    let replacementTriggered = false;
    let deleteCalls = 0;
    const racingStorage = storageWithHeadHook(async (headKey, call) => {
      if (headKey === key && call === 2) {
        replacementTriggered = true;
        await putObject(key, replacement);
      }
    });
    const protectedStorage: ObjectReconciliationStorage = {
      ...racingStorage,
      async delete(deleteKey) {
        deleteCalls += 1;
        await racingStorage.delete(deleteKey);
      },
    };
    const racingReconciler = new StorageReconciler(
      controlPlane.repository.pool, protectedStorage, tenantId, allowedPrefix,
    );

    await expect(racingReconciler.deleteUnreferencedObject(key)).rejects.toMatchObject({
      code: 'STORAGE_ORPHAN_IDENTITY_CONFLICT',
      statusCode: 409,
    });
    expect(replacementTriggered).toBe(true);
    expect(deleteCalls).toBe(0);

    const tombstone = await controlPlane.repository.pool.query<{
      status: string;
      state_version: number;
      content_sha256: string;
      deleted_at: Date | null;
      audits: number;
    }>(`SELECT tombstone.status,tombstone.state_version::int,tombstone.content_sha256,tombstone.deleted_at,
      (SELECT count(*)::int FROM audit_events audit
        WHERE audit.tenant_id=tombstone.tenant_id AND audit.resource_type='storage_orphan_tombstone'
          AND audit.resource_id=tombstone.id) audits
      FROM storage_orphan_tombstones tombstone
      WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3`, [tenantId, bucket, key]);
    expect(tombstone.rows).toEqual([{
      status: 'delete_pending',
      state_version: 1,
      content_sha256: originalSha256,
      deleted_at: null,
      audits: 0,
    }]);
    await expect(storage.head(key)).resolves.toMatchObject({
      sizeBytes: replacement.byteLength,
      contentSha256: replacementSha256,
    });
    await expect(storage.getBytes(key, 1_048_576)).resolves.toEqual(replacement);

    const scan = await reconciler.scan();
    expect(scan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'delete_pending', key, expectedSha256: originalSha256 }),
      expect.objectContaining({ kind: 'object_integrity_mismatch', key, expectedSha256: originalSha256 }),
    ]));
  });

  it('rejects a database reference racing after the tombstone decision through the 0004 trigger', async () => {
    const key = objectKey('reference-race');
    const bytes = new TextEncoder().encode('orphan protected from a late database reference');
    const contentSha256 = await putObject(key, bytes);
    const identityCheckStarted = deferred();
    const continueIdentityCheck = deferred();
    const pausedStorage = storageWithHeadHook(async (headKey, call) => {
      if (headKey === key && call === 2) {
        identityCheckStarted.resolve();
        await continueIdentityCheck.promise;
      }
    });
    const pausedReconciler = new StorageReconciler(
      controlPlane.repository.pool, pausedStorage, tenantId, allowedPrefix,
    );
    await controlPlane.repository.pool.query(
      "INSERT INTO conversations (tenant_id,id,user_id) VALUES ($1,'conversation_reconciliation_race','user_local')",
      [tenantId],
    );

    const deletion = pausedReconciler.deleteUnreferencedObject(key);
    await within(identityCheckStarted.promise);
    try {
      const trigger = await controlPlane.repository.pool.query<{ enabled: boolean }>(`SELECT tgenabled='O' enabled
        FROM pg_trigger WHERE tgrelid='artifact_ingest_intents'::regclass
          AND tgname='artifact_ingest_tombstone_guard' AND NOT tgisinternal`);
      expect(trigger.rows).toEqual([{ enabled: true }]);

      const lateReference = controlPlane.repository.pool.query(`INSERT INTO artifact_ingest_intents
        (tenant_id,id,conversation_id,requester_id,idempotency_key,request_digest,status,state_version,
         artifact_id,manifest_id,document_snapshot_id,storage_bucket,storage_key,display_name,media_type,
         size_bytes,content_sha256,extension,profile_registry_version)
        VALUES ($1,$2,'conversation_reconciliation_race','user_local',$3,$4,'intent_created',1,
          $5,$6,$7,$8,$9,'race.txt','text/plain',$10,$11,'txt','gate0.2a-profile-registry/1')`, [
        tenantId,
        `ingest_${randomUUID()}`,
        `reference-race-${randomUUID()}`,
        sha256(new TextEncoder().encode(`reference-request-${key}`)),
        `artifact_${randomUUID()}`,
        `manifest_${randomUUID()}`,
        `snapshot_${randomUUID()}`,
        bucket,
        key,
        bytes.byteLength,
        contentSha256,
      ]);
      continueIdentityCheck.resolve();
      await expect(lateReference).rejects.toThrow(/storage key is owned by an orphan tombstone/u);
    } finally {
      continueIdentityCheck.resolve();
    }
    await deletion;

    const final = await controlPlane.repository.pool.query<{
      references: number;
      tombstone_status: string;
      audits: number;
    }>(`SELECT
      (SELECT count(*)::int FROM artifact_ingest_intents
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3) references,
      (SELECT status FROM storage_orphan_tombstones
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3) tombstone_status,
      (SELECT count(*)::int FROM audit_events audit JOIN storage_orphan_tombstones tombstone
        ON tombstone.tenant_id=audit.tenant_id AND tombstone.id=audit.resource_id
        WHERE tombstone.tenant_id=$1 AND tombstone.storage_bucket=$2 AND tombstone.storage_key=$3
          AND audit.event_type='storage.orphan.deleted') audits`, [tenantId, bucket, key]);
    expect(final.rows).toEqual([{ references: 0, tombstone_status: 'deleted', audits: 1 }]);
    await expect(storage.head(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('blocks a pre-existing delete_pending tombstone while the backup barrier is active', async () => {
    const key = objectKey('backup-barrier');
    const bytes = new TextEncoder().encode('orphan retained until the backup barrier is released');
    const contentSha256 = await putObject(key, bytes);
    const backupSetId = `backup_${randomUUID()}`;
    await controlPlane.repository.pool.query(`INSERT INTO storage_orphan_tombstones
      (tenant_id,id,storage_bucket,storage_key,size_bytes,content_sha256,reason_code,status)
      VALUES ($1,$2,$3,$4,$5,$6,'S3_WITHOUT_DATABASE_REFERENCE','delete_pending')`, [
      tenantId, `orphan_${randomUUID()}`, bucket, key, bytes.byteLength, contentSha256,
    ]);
    await controlPlane.repository.pool.query(`INSERT INTO backup_sets
      (id,status,source_cluster_id) VALUES ($1,'preparing','gate0.2a-storage-test')`, [backupSetId]);
    await controlPlane.repository.pool.query(`INSERT INTO platform_write_barriers
      (backup_set_id,active,reads_blocked,writes_blocked) VALUES ($1,true,false,true)`, [backupSetId]);

    await expect(reconciler.deleteUnreferencedObject(key)).rejects.toMatchObject({
      code: 'BACKUP_BARRIER_ACTIVE',
      statusCode: 503,
    });
    await expect(storage.head(key)).resolves.toMatchObject({
      sizeBytes: bytes.byteLength,
      contentSha256,
    });
    const blocked = await controlPlane.repository.pool.query(`SELECT status,state_version::int version
      FROM storage_orphan_tombstones WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3`, [
      tenantId, bucket, key,
    ]);
    expect(blocked.rows).toEqual([{ status: 'delete_pending', version: 1 }]);

    await controlPlane.repository.pool.query('DELETE FROM platform_write_barriers WHERE backup_set_id=$1', [backupSetId]);
    await reconciler.deleteUnreferencedObject(key);
    await expect(storage.head(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    const completed = await controlPlane.repository.pool.query(`SELECT status,state_version::int version
      FROM storage_orphan_tombstones WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3`, [
      tenantId, bucket, key,
    ]);
    expect(completed.rows).toEqual([{ status: 'deleted', version: 2 }]);
  });
});
