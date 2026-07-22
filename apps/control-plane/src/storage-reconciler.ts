import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectReconciliationStorage,
  type StoredObjectInventoryItem,
} from '@geneway/storage';
import { GenewayError } from '@geneway/contracts';

type DatabaseObject = Readonly<{
  bucket: string;
  key: string;
  sizeBytes: number;
  contentSha256: string;
  source: 'manifest' | 'ingest_intent' | 'report_intent' | 'orphan_tombstone';
  sourceId: string;
  state: string;
  objectRequired: boolean;
  objectForbidden: boolean;
}>;

export type StorageReconciliationFinding = Readonly<{
  kind: 'pg_object_missing' | 's3_object_orphan' | 'object_integrity_mismatch' | 'tombstone_has_live_object' | 'delete_pending' | 'unresolved_database_state';
  bucket: string;
  key: string;
  source?: DatabaseObject['source'];
  sourceId?: string;
  expectedSha256?: string;
  observedSha256?: string;
}>;

export type StorageReconciliationResult = Readonly<{
  clean: boolean;
  databaseObjectCount: number;
  storageObjectCount: number;
  findings: readonly StorageReconciliationFinding[];
}>;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function inventoryByKey(inventory: readonly StoredObjectInventoryItem[]): ReadonlyMap<string, StoredObjectInventoryItem> {
  const result = new Map<string, StoredObjectInventoryItem>();
  for (const item of inventory) {
    if (result.has(item.key)) throw new GenewayError('STORAGE_INVENTORY_DUPLICATE', 'Storage inventory returned a duplicate key', 500);
    result.set(item.key, item);
  }
  return result;
}

export class StorageReconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly storage: ObjectReconciliationStorage,
    private readonly tenantId: string,
    private readonly allowedPrefix: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(tenantId)
      || allowedPrefix !== `tenants/${tenantId}/artifacts/`) {
      throw new Error('Storage reconciliation prefix is invalid');
    }
  }

  async scan(): Promise<StorageReconciliationResult> {
    const [databaseObjects, inventory] = await Promise.all([
      this.readDatabaseObjects(),
      this.storage.listPrefix(this.allowedPrefix),
    ]);
    const storedByKey = inventoryByKey(inventory);
    const databaseByKey = new Map<string, DatabaseObject[]>();
    for (const object of databaseObjects) {
      const current = databaseByKey.get(object.key) ?? [];
      current.push(object);
      databaseByKey.set(object.key, current);
    }
    const findings: StorageReconciliationFinding[] = [];

    for (const [key, records] of databaseByKey) {
      const stored = storedByKey.get(key);
      for (const record of records.filter((candidate) => !this.isSettledState(candidate))) {
        findings.push({
          kind: record.state === 'delete_pending' ? 'delete_pending' : 'unresolved_database_state',
          bucket: record.bucket,
          key,
          source: record.source,
          sourceId: record.sourceId,
          expectedSha256: record.contentSha256,
        });
      }
      const identities = new Set(records.map((record) => `${String(record.sizeBytes)}:${record.contentSha256}`));
      if (identities.size > 1) {
        const first = records[0];
        findings.push({
          kind: 'object_integrity_mismatch',
          bucket: this.storage.bucket,
          key,
          ...(first === undefined ? {} : { source: first.source, sourceId: first.sourceId }),
        });
        continue;
      }
      if (stored === undefined) {
        for (const record of records.filter((candidate) => candidate.objectRequired)) {
          findings.push({
            kind: 'pg_object_missing',
            bucket: record.bucket,
            key,
            source: record.source,
            sourceId: record.sourceId,
            expectedSha256: record.contentSha256,
          });
        }
        continue;
      }
      const forbidden = records.find((record) => record.objectForbidden);
      if (forbidden !== undefined) {
        findings.push({
          kind: 'tombstone_has_live_object',
          bucket: forbidden.bucket,
          key,
          source: forbidden.source,
          sourceId: forbidden.sourceId,
          expectedSha256: forbidden.contentSha256,
        });
        continue;
      }
      const expected = records[0];
      if (expected === undefined) continue;
      if (stored.sizeBytes !== expected.sizeBytes || stored.sizeBytes > 1_048_576) {
        findings.push({
          kind: 'object_integrity_mismatch',
          bucket: expected.bucket,
          key,
          source: expected.source,
          sourceId: expected.sourceId,
          expectedSha256: expected.contentSha256,
        });
        continue;
      }
      const bytes = await this.storage.getBytes(key, 1_048_576);
      const observedSha256 = sha256(bytes);
      if (bytes.byteLength !== expected.sizeBytes || observedSha256 !== expected.contentSha256) {
        findings.push({
          kind: 'object_integrity_mismatch',
          bucket: expected.bucket,
          key,
          source: expected.source,
          sourceId: expected.sourceId,
          expectedSha256: expected.contentSha256,
          observedSha256,
        });
      }
    }

    for (const stored of inventory) {
      if (!databaseByKey.has(stored.key)) {
        findings.push({ kind: 's3_object_orphan', bucket: this.storage.bucket, key: stored.key });
      }
    }
    return {
      clean: findings.length === 0,
      databaseObjectCount: databaseObjects.length,
      storageObjectCount: inventory.length,
      findings,
    };
  }

  async reconcileStaleIngestIntent(
    tenantId: string,
    intentId: string,
    staleBefore: Date,
  ): Promise<'object_verified' | 'put_failed_confirmed' | 'integrity_error' | 'already_settled'> {
    if (tenantId !== this.tenantId) throw new GenewayError('RECONCILIATION_TENANT_DENIED', 'Reconciler is bound to a different tenant', 403);
    if (Number.isNaN(staleBefore.getTime())) throw new GenewayError('RECONCILIATION_TIME_INVALID', 'Stale ingest cutoff is invalid', 400);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertWritesOpen(client);
      const selected = await client.query<{
        status: string;
        state_version: string;
        storage_bucket: string;
        storage_key: string;
        size_bytes: string;
        content_sha256: string;
        media_type: string;
        updated_at: Date;
      }>(`SELECT status,state_version::text,storage_bucket,storage_key,size_bytes::text,content_sha256,media_type,updated_at
        FROM artifact_ingest_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, intentId]);
      const row = selected.rows[0];
      if (row === undefined || row.status !== 'put_inflight' || row.updated_at.getTime() > staleBefore.getTime()) {
        await client.query('COMMIT');
        return 'already_settled';
      }
      if (row.storage_bucket !== this.storage.bucket) {
        throw new GenewayError('STORAGE_KEY_OUT_OF_SCOPE', 'Ingest object is outside the reconciliation bucket', 403);
      }
      this.assertScopedKey(row.storage_key);

      const sizeBytes = Number(row.size_bytes);
      let nextStatus: 'object_verified' | 'put_failed_confirmed' | 'integrity_error';
      let reasonCode: string;
      let observedETag: string | null = null;
      try {
        const head = await this.storage.head(row.storage_key);
        observedETag = head.eTag;
        const bytes = await this.storage.getBytes(row.storage_key, 1_048_576);
        const matches = head.sizeBytes === sizeBytes && bytes.byteLength === sizeBytes
          && head.contentType === row.media_type && head.contentSha256 === row.content_sha256
          && sha256(bytes) === row.content_sha256;
        nextStatus = matches ? 'object_verified' : 'integrity_error';
        reasonCode = matches ? 'STORAGE_PUT_RECOVERED' : 'STORAGE_PUT_RECOVERY_INTEGRITY_FAILED';
      } catch (error) {
        if (error instanceof StorageObjectNotFoundError) {
          nextStatus = 'put_failed_confirmed';
          reasonCode = 'STORAGE_PUT_NOT_OBSERVED_AFTER_LEASE';
        } else if (error instanceof StorageObjectTooLargeError) {
          nextStatus = 'integrity_error';
          reasonCode = 'STORAGE_PUT_RECOVERY_INTEGRITY_FAILED';
        } else {
          throw error;
        }
      }

      const changed = await client.query(`UPDATE artifact_ingest_intents
        SET status=$4,state_version=state_version+1,etag_observed=$5,failure_code=$6,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='put_inflight' AND state_version=$3`, [
        tenantId, intentId, Number(row.state_version), nextStatus, observedETag,
        nextStatus === 'object_verified' ? null : reasonCode,
      ]);
      if (changed.rowCount !== 1) {
        throw new GenewayError('INGEST_RECONCILIATION_CAS_CONFLICT', 'Ingest intent changed during stale PUT reconciliation', 409);
      }
      await client.query(`INSERT INTO audit_events
        (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
        VALUES ($1,$2,'service:storage-reconciler','storage.ingest.recovered','artifact_ingest_intent',$3,$4,$5,$6)`, [
        tenantId, `audit_${randomUUID()}`, intentId,
        nextStatus === 'integrity_error' ? 'failed' : 'allowed', reasonCode,
        { bucket: this.storage.bucket, key: row.storage_key, nextStatus, contentSha256: row.content_sha256, sizeBytes },
      ]);
      await client.query('COMMIT');
      return nextStatus;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileReportIntent(tenantId: string, intentId: string): Promise<'deleted' | 'already_deleted'> {
    if (tenantId !== this.tenantId) throw new GenewayError('RECONCILIATION_TENANT_DENIED', 'Reconciler is bound to a different tenant', 403);
    const intent = await this.beginReportDelete(tenantId, intentId);
    if (intent.status === 'deleted') {
      try {
        await this.storage.head(intent.storageKey);
      } catch (error) {
        if (error instanceof StorageObjectNotFoundError) return 'already_deleted';
        throw error;
      }
      throw new GenewayError('REPORT_TOMBSTONE_HAS_LIVE_OBJECT', 'Deleted report tombstone still has a live object', 409);
    }
    return this.deleteReportObjectWhileStillSafe(tenantId, intentId, intent);
  }

  async deleteUnreferencedObject(key: string): Promise<void> {
    this.assertScopedKey(key);
    let tombstone = await this.loadOrphanTombstone(key);
    if (tombstone === null) {
      const head = await this.storage.head(key);
      const bytes = await this.storage.getBytes(key, 1_048_576);
      if (bytes.byteLength !== head.sizeBytes) throw new GenewayError('STORAGE_ORPHAN_INTEGRITY_FAILED', 'Orphan object changed during inspection', 409);
      tombstone = await this.createOrLoadOrphanTombstone(key, head.sizeBytes, sha256(bytes), head.eTag);
    }
    if (tombstone.status === 'deleted') {
      try {
        await this.storage.head(key);
      } catch (error) {
        if (error instanceof StorageObjectNotFoundError) return;
        throw error;
      }
      throw new GenewayError('STORAGE_TOMBSTONE_HAS_LIVE_OBJECT', 'Deleted orphan tombstone still has a live object', 409);
    }
    await this.deleteOrphanObjectWhileStillSafe(key, tombstone);
  }

  private async deleteReportObjectWhileStillSafe(
    tenantId: string,
    intentId: string,
    expected: Readonly<{
      storageKey: string;
      artifactId: string;
      contentSha256: string;
      sizeBytes: number;
      taskId: string;
    }>,
  ): Promise<'deleted' | 'already_deleted'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertWritesOpen(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [this.storage.bucket, expected.storageKey]);
      const task = await client.query<{ status: string }>(
        'SELECT status FROM business_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, expected.taskId],
      );
      const selected = await client.query<{
        status: string;
        business_task_id: string;
        artifact_id: string;
        storage_bucket: string;
        storage_key: string;
        content_sha256: string;
        size_bytes: string;
      }>(`SELECT status,business_task_id,artifact_id,storage_bucket,storage_key,content_sha256,size_bytes::text
        FROM report_publish_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, intentId]);
      const row = selected.rows[0];
      if (row === undefined || row.business_task_id !== expected.taskId || row.artifact_id !== expected.artifactId
        || row.storage_bucket !== this.storage.bucket || row.storage_key !== expected.storageKey
        || row.content_sha256 !== expected.contentSha256 || Number(row.size_bytes) !== expected.sizeBytes) {
        throw new GenewayError('REPORT_DELETE_CAS_CONFLICT', 'Report delete identity changed before object deletion', 409);
      }
      if (row.status === 'deleted') {
        try {
          await this.storage.head(expected.storageKey);
        } catch (error) {
          if (error instanceof StorageObjectNotFoundError) {
            await client.query('COMMIT');
            return 'already_deleted';
          }
          throw error;
        }
        throw new GenewayError('REPORT_TOMBSTONE_HAS_LIVE_OBJECT', 'Deleted report tombstone still has a live object', 409);
      }
      if (row.status !== 'delete_pending' || !['canceled', 'failed'].includes(task.rows[0]?.status ?? '')) {
        throw new GenewayError('REPORT_DELETE_NOT_SAFE', 'Report object is no longer eligible for deletion', 409);
      }
      const referenced = await client.query(`SELECT 1 FROM artifact_manifests manifest
        JOIN artifacts artifact ON artifact.tenant_id=manifest.tenant_id AND artifact.id=manifest.artifact_id
        WHERE manifest.tenant_id=$1 AND (manifest.storage_key=$2 OR artifact.id=$3) LIMIT 1`, [
        tenantId, expected.storageKey, expected.artifactId,
      ]);
      if (referenced.rowCount !== 0) throw new GenewayError('REPORT_DELETE_NOT_SAFE', 'Published report references prevent orphan deletion', 409);
      const objectPresent = await this.assertObjectIdentityOrMissing(
        expected.storageKey, expected.sizeBytes, expected.contentSha256, 'REPORT_DELETE_IDENTITY_CONFLICT',
      );
      if (objectPresent) {
        try {
          await this.storage.delete(expected.storageKey);
        } catch (error) {
          if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
        try {
          await this.storage.head(expected.storageKey);
          throw new GenewayError('REPORT_DELETE_NOT_CONFIRMED', 'Report object still exists after delete', 502);
        } catch (error) {
          if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
      }
      const completed = await client.query(`UPDATE report_publish_intents
        SET status='deleted',state_version=state_version+1,deleted_at=now(),updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='delete_pending'`, [tenantId, intentId]);
      if (completed.rowCount !== 1) throw new GenewayError('REPORT_DELETE_CAS_CONFLICT', 'Report delete tombstone changed before confirmation', 409);
      await client.query(`INSERT INTO audit_events
        (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
        VALUES ($1,$2,'service:storage-reconciler','storage.report.deleted','report_publish_intent',$3,
          'allowed','UNPUBLISHED_REPORT_OBJECT_DELETED',$4)`, [
        tenantId, `audit_${randomUUID()}`, intentId,
        { taskId: expected.taskId, artifactId: expected.artifactId, bucket: this.storage.bucket,
          key: expected.storageKey, contentSha256: expected.contentSha256 },
      ]);
      await client.query('COMMIT');
      return 'deleted';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async beginReportDelete(tenantId: string, intentId: string): Promise<Readonly<{
    status: 'delete_pending' | 'deleted';
    storageKey: string;
    artifactId: string;
    contentSha256: string;
    sizeBytes: number;
    taskId: string;
  }>> {
    const identity = await this.pool.query<{ business_task_id: string }>(
      'SELECT business_task_id FROM report_publish_intents WHERE tenant_id=$1 AND id=$2',
      [tenantId, intentId],
    );
    const taskId = identity.rows[0]?.business_task_id;
    if (taskId === undefined) throw new GenewayError('REPORT_INTENT_NOT_FOUND', 'Report intent was not found', 404);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query<{ status: string }>(
        'SELECT status FROM business_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, taskId],
      );
      const selected = await client.query<{
        business_task_id: string;
        artifact_id: string;
        content_sha256: string;
        size_bytes: string;
        storage_bucket: string;
        storage_key: string;
        status: string;
      }>(`SELECT business_task_id,artifact_id,storage_bucket,storage_key,content_sha256,size_bytes::text,status
        FROM report_publish_intents WHERE tenant_id=$1 AND id=$2 AND business_task_id=$3 FOR UPDATE`, [tenantId, intentId, taskId]);
      const row = selected.rows[0];
      if (row === undefined) throw new GenewayError('REPORT_INTENT_NOT_FOUND', 'Report intent was not found', 404);
      if (row.storage_bucket !== this.storage.bucket) {
        throw new GenewayError('STORAGE_KEY_OUT_OF_SCOPE', 'Report object is outside the reconciliation prefix', 403);
      }
      this.assertScopedKey(row.storage_key);
      if (row.status === 'deleted') {
        await client.query('COMMIT');
        return {
          status: 'deleted', storageKey: row.storage_key, artifactId: row.artifact_id,
          contentSha256: row.content_sha256, sizeBytes: Number(row.size_bytes), taskId,
        };
      }
      if (!['canceled', 'failed'].includes(task.rows[0]?.status ?? '')) {
        throw new GenewayError('REPORT_DELETE_NOT_SAFE', 'Only an unpublished terminal report can be reconciled by deletion', 409);
      }
      const referenced = await client.query(`SELECT 1 FROM artifact_manifests manifest
        JOIN artifacts artifact ON artifact.tenant_id=manifest.tenant_id AND artifact.id=manifest.artifact_id
        WHERE manifest.tenant_id=$1 AND (manifest.storage_key=$2 OR artifact.id=$3) LIMIT 1`, [
        tenantId, row.storage_key, row.artifact_id,
      ]);
      if (referenced.rowCount !== 0) throw new GenewayError('REPORT_DELETE_NOT_SAFE', 'Published report references prevent orphan deletion', 409);
      if (!['reconcile_required', 'put_failed_confirmed', 'integrity_error', 'delete_pending'].includes(row.status)) {
        throw new GenewayError('REPORT_DELETE_NOT_SAFE', 'Report intent is not in a reconcilable state', 409);
      }
      if (row.status !== 'delete_pending') {
        await this.assertWritesOpen(client);
        const updated = await client.query(`UPDATE report_publish_intents
          SET status='delete_pending',state_version=state_version+1,
              failure_code=coalesce(failure_code,'UNPUBLISHED_REPORT_ORPHAN'),updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status IN ('reconcile_required','put_failed_confirmed','integrity_error')`, [tenantId, intentId]);
        if (updated.rowCount !== 1) throw new GenewayError('REPORT_DELETE_CAS_CONFLICT', 'Report intent changed before delete preparation', 409);
      }
      await client.query('COMMIT');
      return {
        status: 'delete_pending', storageKey: row.storage_key, artifactId: row.artifact_id,
        contentSha256: row.content_sha256, sizeBytes: Number(row.size_bytes), taskId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertObjectIdentityOrMissing(
    key: string,
    sizeBytes: number,
    contentSha256: string,
    conflictCode: string,
  ): Promise<boolean> {
    try {
      const head = await this.storage.head(key);
      const bytes = await this.storage.getBytes(key, 1_048_576);
      if (head.sizeBytes !== sizeBytes || bytes.byteLength !== sizeBytes
        || sha256(bytes) !== contentSha256
        || (head.contentSha256 !== null && head.contentSha256 !== contentSha256)) {
        throw new GenewayError(conflictCode, 'Storage object no longer matches the delete tombstone identity', 409);
      }
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return false;
      throw error;
    }
  }

  private isSettledState(record: DatabaseObject): boolean {
    switch (record.source) {
      case 'manifest':
        return record.objectForbidden || record.state === 'active:verified:active:in_sync:true';
      case 'ingest_intent':
        return ['intent_created', 'put_failed_confirmed', 'object_verified', 'ready', 'deleted'].includes(record.state);
      case 'report_intent':
        return ['put_failed_confirmed', 'object_verified', 'published', 'deleted'].includes(record.state);
      case 'orphan_tombstone':
        return record.state === 'deleted';
    }
  }

  private async loadOrphanTombstone(key: string): Promise<Readonly<{
    status: 'delete_pending' | 'deleted';
    stateVersion: number;
    sizeBytes: number;
    contentSha256: string;
  }> | null> {
    const result = await this.pool.query<{
      status: 'delete_pending' | 'deleted';
      state_version: string;
      size_bytes: string;
      content_sha256: string;
    }>(`SELECT status,state_version::text,size_bytes::text,content_sha256
      FROM storage_orphan_tombstones WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3`, [
      this.tenantId, this.storage.bucket, key,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : {
      status: row.status,
      stateVersion: Number(row.state_version),
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
    };
  }

  private async createOrLoadOrphanTombstone(
    key: string,
    sizeBytes: number,
    contentSha256: string,
    observedETag: string | null,
  ): Promise<Readonly<{ status: 'delete_pending' | 'deleted'; stateVersion: number; sizeBytes: number; contentSha256: string }>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertWritesOpen(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [this.storage.bucket, key]);
      const referenced = await this.findObjectReference(client, key);
      if (referenced.rowCount !== 0) throw new GenewayError('STORAGE_OBJECT_REFERENCED', 'Object gained a database reference before cleanup', 409);
      await client.query(`INSERT INTO storage_orphan_tombstones
        (tenant_id,id,storage_bucket,storage_key,size_bytes,content_sha256,etag_observed,reason_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'S3_WITHOUT_DATABASE_REFERENCE','delete_pending')
        ON CONFLICT (tenant_id,storage_bucket,storage_key) DO NOTHING`, [
        this.tenantId, `orphan_${randomUUID()}`, this.storage.bucket, key, sizeBytes, contentSha256, observedETag,
      ]);
      const selected = await client.query<{
        status: 'delete_pending' | 'deleted';
        state_version: string;
        size_bytes: string;
        content_sha256: string;
      }>(`SELECT status,state_version::text,size_bytes::text,content_sha256
        FROM storage_orphan_tombstones
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3 FOR UPDATE`, [
        this.tenantId, this.storage.bucket, key,
      ]);
      const row = selected.rows[0];
      if (row === undefined || Number(row.size_bytes) !== sizeBytes || row.content_sha256 !== contentSha256) {
        throw new GenewayError('STORAGE_ORPHAN_IDENTITY_CONFLICT', 'Existing orphan tombstone has a different object identity', 409);
      }
      await client.query('COMMIT');
      return {
        status: row.status,
        stateVersion: Number(row.state_version),
        sizeBytes: Number(row.size_bytes),
        contentSha256: row.content_sha256,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async deleteOrphanObjectWhileStillSafe(
    key: string,
    expected: Readonly<{ stateVersion: number; sizeBytes: number; contentSha256: string }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertWritesOpen(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [this.storage.bucket, key]);
      const selected = await client.query<{
        id: string; status: string; state_version: string; size_bytes: string; content_sha256: string;
      }>(`SELECT id,status,state_version::text,size_bytes::text,content_sha256
        FROM storage_orphan_tombstones
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3 FOR UPDATE`, [
        this.tenantId, this.storage.bucket, key,
      ]);
      const row = selected.rows[0];
      if (row === undefined || row.status !== 'delete_pending' || Number(row.state_version) !== expected.stateVersion
        || Number(row.size_bytes) !== expected.sizeBytes || row.content_sha256 !== expected.contentSha256) {
        throw new GenewayError('STORAGE_ORPHAN_DELETE_CAS_CONFLICT', 'Orphan tombstone changed before delete', 409);
      }
      if ((await this.findObjectReference(client, key)).rowCount !== 0) {
        throw new GenewayError('STORAGE_OBJECT_REFERENCED', 'Object gained a database reference before cleanup', 409);
      }
      const objectPresent = await this.assertObjectIdentityOrMissing(
        key, expected.sizeBytes, expected.contentSha256, 'STORAGE_ORPHAN_IDENTITY_CONFLICT',
      );
      if (objectPresent) {
        try {
          await this.storage.delete(key);
        } catch (error) {
          if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
        try {
          await this.storage.head(key);
          throw new GenewayError('STORAGE_ORPHAN_DELETE_NOT_CONFIRMED', 'Orphan object still exists after delete', 502);
        } catch (error) {
          if (!(error instanceof StorageObjectNotFoundError)) throw error;
        }
      }
      const completed = await client.query(`UPDATE storage_orphan_tombstones
        SET status='deleted',state_version=state_version+1,deleted_at=now()
        WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3
          AND status='delete_pending' AND state_version=$4`, [
        this.tenantId, this.storage.bucket, key, expected.stateVersion,
      ]);
      if (completed.rowCount !== 1) throw new GenewayError('STORAGE_ORPHAN_DELETE_CAS_CONFLICT', 'Orphan tombstone changed before delete confirmation', 409);
      await client.query(`INSERT INTO audit_events
        (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
        VALUES ($1,$2,'service:storage-reconciler','storage.orphan.deleted','storage_orphan_tombstone',$3,
          'allowed','UNREFERENCED_OBJECT_DELETED',$4)`, [
        this.tenantId, `audit_${randomUUID()}`, row.id,
        { bucket: this.storage.bucket, key, sizeBytes: expected.sizeBytes, contentSha256: expected.contentSha256 },
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private findObjectReference(client: pg.PoolClient, key: string): Promise<pg.QueryResult> {
    return client.query(`SELECT 1 FROM (
      SELECT tenant_id,storage_bucket,storage_key FROM artifact_manifests
      UNION ALL SELECT tenant_id,storage_bucket,storage_key FROM artifact_ingest_intents WHERE status<>'deleted'
      UNION ALL SELECT tenant_id,storage_bucket,storage_key FROM report_publish_intents WHERE status<>'deleted'
    ) known_objects WHERE tenant_id=$1 AND storage_bucket=$2 AND storage_key=$3 LIMIT 1`, [
      this.tenantId, this.storage.bucket, key,
    ]);
  }

  private async assertWritesOpen(client: pg.PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('geneway'),hashtext('storage-write-gate'))");
    const barrier = await client.query(
      'SELECT backup_set_id FROM platform_write_barriers WHERE active AND writes_blocked LIMIT 1',
    );
    if (barrier.rowCount !== 0) {
      throw new GenewayError('BACKUP_BARRIER_ACTIVE', 'Storage deletion is paused for a verified backup checkpoint', 503);
    }
  }

  private assertScopedKey(key: string): void {
    if (key === this.allowedPrefix || !key.startsWith(this.allowedPrefix)
      || key.includes('..') || key.includes('\\') || key.includes('\0') || key.includes('//')) {
      throw new GenewayError('STORAGE_KEY_OUT_OF_SCOPE', 'Object is outside the reconciliation prefix', 403);
    }
  }

  private async readDatabaseObjects(): Promise<readonly DatabaseObject[]> {
    const result = await this.pool.query<{
      tenant_id: string;
      bucket: string;
      key: string;
      size_bytes: string;
      content_sha256: string;
      source: DatabaseObject['source'];
      source_id: string;
      state: string;
      object_required: boolean;
      object_forbidden: boolean;
    }>(`SELECT * FROM (
      SELECT manifest.tenant_id,manifest.storage_bucket bucket,manifest.storage_key key,manifest.size_bytes,
        manifest.content_sha256,'manifest'::text source,manifest.id source_id,
        state.availability || ':' || state.integrity || ':' || state.retention_status || ':' || state.reconcile_status
          || ':' || (state.retention_expires_at>now())::text state,
        (state.availability='active' AND state.integrity='verified' AND state.retention_status='active'
          AND state.retention_expires_at>now() AND state.reconcile_status='in_sync') object_required,
        (state.availability='deleted' OR state.retention_status='deleted') object_forbidden
      FROM artifact_manifests manifest JOIN artifact_states state
        ON state.tenant_id=manifest.tenant_id AND state.artifact_id=manifest.artifact_id
      UNION ALL
      SELECT tenant_id,storage_bucket,storage_key,size_bytes,content_sha256,'ingest_intent',id,status,
        status IN ('object_verified','ready'),status IN ('intent_created','put_failed_confirmed','deleted')
      FROM artifact_ingest_intents
      UNION ALL
      SELECT tenant_id,storage_bucket,storage_key,size_bytes,content_sha256,'report_intent',id,status,
        status IN ('object_verified','published'),status IN ('put_failed_confirmed','deleted')
      FROM report_publish_intents
      UNION ALL
      SELECT tenant_id,storage_bucket,storage_key,size_bytes,content_sha256,'orphan_tombstone',id,status,
        false,status='deleted'
      FROM storage_orphan_tombstones
    ) inventory WHERE bucket=$1 AND left(key,length($2))=$2 AND tenant_id=$3`, [
      this.storage.bucket, this.allowedPrefix, this.tenantId,
    ]);
    return result.rows.map((row) => ({
      bucket: row.bucket,
      key: row.key,
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
      source: row.source,
      sourceId: row.source_id,
      state: row.state,
      objectRequired: row.object_required,
      objectForbidden: row.object_forbidden,
    }));
  }
}
