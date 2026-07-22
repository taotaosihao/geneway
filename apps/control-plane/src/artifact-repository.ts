import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import {
  artifactIngestResponseSchema,
  documentSnapshotSchema,
  GenewayError,
  type ArtifactIngestResponse,
  type DocumentSnapshot,
  type Principal,
} from '@geneway/contracts';
import type { ValidatedTextUpload } from '@geneway/ingestion';

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type IntentStatus =
  | 'intent_created'
  | 'put_inflight'
  | 'object_verified'
  | 'ready'
  | 'put_failed_confirmed'
  | 'reconcile_required'
  | 'integrity_error'
  | 'delete_pending'
  | 'deleted';

const allowedIntentTransitions: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  intent_created: ['put_inflight'],
  put_inflight: ['object_verified', 'put_failed_confirmed', 'reconcile_required', 'integrity_error'],
  object_verified: [],
  ready: ['delete_pending'],
  put_failed_confirmed: ['put_inflight', 'delete_pending'],
  reconcile_required: ['object_verified', 'integrity_error', 'delete_pending'],
  integrity_error: ['delete_pending'],
  delete_pending: ['deleted'],
  deleted: [],
};

export type ArtifactIngestIntent = Readonly<{
  id: string;
  tenantId: string;
  conversationId: string;
  requesterId: string;
  status: IntentStatus;
  stateVersion: number;
  artifactId: string;
  manifestId: string;
  documentSnapshotId: string;
  storageBucket: string;
  storageKey: string;
  displayName: string;
  mediaType: 'text/plain' | 'text/markdown';
  sizeBytes: number;
  contentSha256: string;
  extension: 'txt' | 'md';
  simulationProfile: 'solution-analysis-demo/v2' | null;
  profileRegistryVersion: 'gate0.2a-profile-registry/1';
}>;

type IntentRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  requester_id: string;
  status: IntentStatus;
  state_version: string;
  artifact_id: string;
  manifest_id: string;
  document_snapshot_id: string;
  storage_bucket: string;
  storage_key: string;
  display_name: string;
  media_type: 'text/plain' | 'text/markdown';
  size_bytes: string;
  content_sha256: string;
  extension: 'txt' | 'md';
  simulation_profile: 'solution-analysis-demo/v2' | null;
  profile_registry_version: 'gate0.2a-profile-registry/1';
  request_digest: string;
};

export type AuthorizedArtifact = Readonly<{
  tenantId: string;
  id: string;
  kind: 'source_document' | 'simulation_report';
  businessTaskId: string | null;
  rootArtifactId: string;
  conversationId: string;
  ownerUserId: string;
  displayName: string;
  mediaType: 'text/plain' | 'text/markdown';
  sizeBytes: number;
  contentSha256: string;
  manifestId: string;
  documentSnapshotId: string | null;
  storageBucket: string;
  storageKey: string;
  availability: string;
  integrity: string;
  stateVersion: number;
  retentionStatus: string;
  retentionExpiresAt: string;
  reconcileStatus: string;
  dataClass: string;
  audience: unknown;
  resourceScope: string;
}>;

export type ArtifactSnapshotRecord = Readonly<{
  documentSnapshot: DocumentSnapshot;
  artifact: AuthorizedArtifact;
}>;

function safeStorageSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new GenewayError('INVALID_STORAGE_SCOPE', 'Tenant identifier cannot be mapped to storage', 500);
  return value;
}

function mapIntent(row: IntentRow): ArtifactIngestIntent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    requesterId: row.requester_id,
    status: row.status,
    stateVersion: Number(row.state_version),
    artifactId: row.artifact_id,
    manifestId: row.manifest_id,
    documentSnapshotId: row.document_snapshot_id,
    storageBucket: row.storage_bucket,
    storageKey: row.storage_key,
    displayName: row.display_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    contentSha256: row.content_sha256,
    extension: row.extension,
    simulationProfile: row.simulation_profile,
    profileRegistryVersion: row.profile_registry_version,
  };
}

export class ArtifactRepository {
  constructor(readonly pool: pg.Pool) {}

  async createOrLoadIntent(input: Readonly<{
    principal: Principal;
    conversationId: string;
    idempotencyKey: string;
    bucket: string;
    upload: ValidatedTextUpload;
  }>): Promise<ArtifactIngestIntent> {
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'A stable idempotency-key header is required', 400);
    }
    const semanticRequest = {
      operation: 'artifact.upload',
      tenantId: input.principal.tenantId,
      requesterId: input.principal.userId,
      conversationId: input.conversationId,
      displayName: input.upload.displayName,
      mediaType: input.upload.mediaType,
      sizeBytes: input.upload.sizeBytes,
      contentSha256: input.upload.contentSha256,
      simulationProfile: input.upload.simulationProfile,
      profileRegistryVersion: input.upload.profileRegistryVersion,
    };
    const requestDigest = digest(semanticRequest);
    return this.withTransaction(async (client) => {
      await this.assertWritesOpen(client);
      await this.assertConversationOwned(client, input.principal, input.conversationId);
      const artifactId = id('artifact');
      const intentId = id('ingest');
      const manifestId = id('manifest');
      const documentSnapshotId = id('snapshot');
      const storageKey = `tenants/${safeStorageSegment(input.principal.tenantId)}/artifacts/${artifactId}/source.${input.upload.extension}`;
      await client.query(`INSERT INTO artifact_ingest_intents
        (tenant_id,id,conversation_id,requester_id,idempotency_key,request_digest,status,artifact_id,manifest_id,
         document_snapshot_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,extension,
         simulation_profile,profile_registry_version)
        VALUES ($1,$2,$3,$4,$5,$6,'intent_created',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (tenant_id,requester_id,idempotency_key) DO NOTHING`, [
        input.principal.tenantId, intentId, input.conversationId, input.principal.userId, input.idempotencyKey, requestDigest,
        artifactId, manifestId, documentSnapshotId, input.bucket, storageKey, input.upload.displayName, input.upload.mediaType,
        input.upload.sizeBytes, input.upload.contentSha256, input.upload.extension, input.upload.simulationProfile,
        input.upload.profileRegistryVersion,
      ]);
      const selected = await client.query<IntentRow>(`SELECT * FROM artifact_ingest_intents
        WHERE tenant_id=$1 AND requester_id=$2 AND idempotency_key=$3 FOR UPDATE`, [
        input.principal.tenantId, input.principal.userId, input.idempotencyKey,
      ]);
      const row = selected.rows[0];
      if (row === undefined) throw new Error('Artifact ingest intent disappeared after insertion');
      if (row.request_digest !== requestDigest) {
        throw new GenewayError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different upload', 409);
      }
      return mapIntent(row);
    });
  }

  async getIntent(principal: Principal, intentId: string): Promise<ArtifactIngestIntent> {
    const result = await this.pool.query<IntentRow>(
      'SELECT * FROM artifact_ingest_intents WHERE tenant_id=$1 AND id=$2 AND requester_id=$3',
      [principal.tenantId, intentId, principal.userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('INGEST_NOT_FOUND', 'Artifact ingest intent was not found', 404);
    return mapIntent(row);
  }

  async transitionIntent(input: Readonly<{
    principal: Principal;
    intent: ArtifactIngestIntent;
    expectedStatuses: readonly IntentStatus[];
    nextStatus: IntentStatus;
    failureCode?: string | null;
    eTagObserved?: string | null;
  }>): Promise<ArtifactIngestIntent | null> {
    for (const status of input.expectedStatuses) {
      if (!allowedIntentTransitions[status].includes(input.nextStatus)) {
        throw new GenewayError('INVALID_INGEST_TRANSITION', `Artifact ingest cannot transition from ${status} to ${input.nextStatus}`, 500);
      }
    }
    const transition = async (queryable: Pick<pg.Pool, 'query'> | PoolClient) => queryable.query<IntentRow>(`UPDATE artifact_ingest_intents
        SET status=$4,state_version=state_version+1,failure_code=$5,
            object_verified_at=CASE WHEN $4='object_verified' THEN now() ELSE object_verified_at END,
            etag_observed=COALESCE($8,etag_observed),updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND requester_id=$3 AND state_version=$6 AND status=ANY($7::text[])
        RETURNING *`, [
        input.principal.tenantId, input.intent.id, input.principal.userId, input.nextStatus, input.failureCode ?? null,
        input.intent.stateVersion, input.expectedStatuses, input.eTagObserved ?? null,
      ]);
    // Entering PUT authority is gated. Outcome writes for an already in-flight
    // PUT must remain available while a backup barrier drains the system.
    const result = input.nextStatus === 'put_inflight'
      ? await this.withTransaction(async (client) => {
          await this.assertWritesOpen(client);
          return transition(client);
        })
      : await transition(this.pool);
    const row = result.rows[0];
    return row === undefined ? null : mapIntent(row);
  }

  async finalizeIntent(principal: Principal, intent: ArtifactIngestIntent, storage: Readonly<{ eTag: string | null }>): Promise<ArtifactIngestResponse> {
    return this.withTransaction(async (client) => {
      await this.assertWritesOpen(client);
      const selected = await client.query<IntentRow>(
        'SELECT * FROM artifact_ingest_intents WHERE tenant_id=$1 AND id=$2 AND requester_id=$3 FOR UPDATE',
        [principal.tenantId, intent.id, principal.userId],
      );
      const currentRow = selected.rows[0];
      if (currentRow === undefined) throw new GenewayError('INGEST_NOT_FOUND', 'Artifact ingest intent was not found', 404);
      const current = mapIntent(currentRow);
      if (current.status === 'ready') return this.getReadyProjectionWithClient(client, principal, current.id);
      if (current.status !== 'object_verified') {
        throw new GenewayError('INGEST_NOT_READY', 'Artifact ingest intent is not ready to finalize', 409, {
          intentStatus: current.status,
          stateVersion: current.stateVersion,
        });
      }

      await client.query(`INSERT INTO artifacts
        (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,
         root_artifact_id,data_class,audience,resource_scope)
        VALUES ($1,$2,$3,$4,'source_document',$5,$6,$7,$8,$2,'C1',$9,$10)`, [
        principal.tenantId, current.artifactId, current.conversationId, principal.userId, current.displayName,
        current.mediaType, current.sizeBytes, current.contentSha256,
        { kind: 'private-conversation', conversationId: current.conversationId }, `artifact:${current.artifactId}`,
      ]);
      await client.query(`INSERT INTO artifact_manifests
        (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'gate0.2a-internal/v1')`, [
        principal.tenantId, current.manifestId, current.artifactId, current.storageBucket, current.storageKey,
        current.displayName, current.mediaType, current.sizeBytes, current.contentSha256,
      ]);
      await client.query(`INSERT INTO artifact_states
        (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status,
         etag_observed,last_checked_at,last_verified_at)
        VALUES ($1,$2,'active','verified','active',now()+interval '30 days','in_sync',$3,now(),now())`, [
        principal.tenantId, current.artifactId, storage.eTag,
      ]);
      const audience = { kind: 'private-conversation', conversationId: current.conversationId } as const;
      await client.query(`INSERT INTO document_snapshots
        (tenant_id,id,conversation_id,artifact_id,manifest_id,display_name,media_type,size_bytes,content_sha256,data_class,
         audience,resource_scope,trust,simulation_profile,profile_registry_version,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'C1',$10,$11,'untrusted_text',$12,$13,$14)`, [
        principal.tenantId, current.documentSnapshotId, current.conversationId, current.artifactId, current.manifestId,
        current.displayName, current.mediaType, current.sizeBytes, current.contentSha256, audience,
        `artifact:${current.artifactId}`, current.simulationProfile, current.profileRegistryVersion, principal.userId,
      ]);
      const transitioned = await client.query<IntentRow>(`UPDATE artifact_ingest_intents
        SET status='ready',state_version=state_version+1,failure_code=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND requester_id=$3 AND status='object_verified' AND state_version=$4
        RETURNING *`, [principal.tenantId, current.id, principal.userId, current.stateVersion]);
      const readyRow = transitioned.rows[0];
      if (readyRow === undefined) throw new GenewayError('STALE_INGEST_STATE', 'Artifact ingest state changed before finalize', 409);
      await this.insertAudit(client, principal, 'artifact.upload.completed', 'artifact', current.artifactId, 'allowed', 'ARTIFACT_VERIFIED', {
        conversationId: current.conversationId,
        manifestId: current.manifestId,
        documentSnapshotId: current.documentSnapshotId,
        sizeBytes: current.sizeBytes,
        contentSha256: current.contentSha256,
      });
      return this.getReadyProjectionWithClient(client, principal, current.id);
    });
  }

  async assertWritesOpen(client: PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('geneway'),hashtext('storage-write-gate'))");
    const barrier = await client.query('SELECT backup_set_id FROM platform_write_barriers WHERE active AND writes_blocked LIMIT 1');
    if (barrier.rowCount !== 0) {
      throw new GenewayError('BACKUP_BARRIER_ACTIVE', 'Artifact writes are paused for a verified backup checkpoint', 503);
    }
  }

  async assertReadsOpen(): Promise<void> {
    const barrier = await this.pool.query(
      'SELECT backup_set_id FROM platform_write_barriers WHERE active AND reads_blocked LIMIT 1',
    );
    if (barrier.rowCount !== 0) {
      throw new GenewayError('RESTORE_READ_GATE_ACTIVE', 'Artifact reads are unavailable until restore verification completes', 503);
    }
  }

  async getReadyProjection(principal: Principal, intentId: string): Promise<ArtifactIngestResponse> {
    return this.withReadClient((client) => this.getReadyProjectionWithClient(client, principal, intentId));
  }

  async listSnapshotRecords(principal: Principal, conversationId: string): Promise<readonly ArtifactSnapshotRecord[]> {
    return this.withReadClient(async (client) => {
      await this.assertConversationOwned(client, principal, conversationId);
      const result = await client.query(`SELECT
        d.id,d.artifact_id,d.manifest_id,d.conversation_id,d.display_name,d.media_type,d.size_bytes,d.content_sha256,
        d.data_class,d.audience,d.resource_scope,d.trust,d.simulation_profile,d.profile_registry_version,d.created_at,
        a.owner_user_id,m.storage_bucket,m.storage_key,s.availability,s.integrity,s.state_version,
        s.retention_status,s.retention_expires_at,s.reconcile_status
        FROM document_snapshots d
        JOIN artifacts a ON a.tenant_id=d.tenant_id AND a.id=d.artifact_id
        JOIN artifact_manifests m ON m.tenant_id=d.tenant_id AND m.id=d.manifest_id
        JOIN artifact_states s ON s.tenant_id=d.tenant_id AND s.artifact_id=d.artifact_id
        WHERE d.tenant_id=$1 AND d.conversation_id=$2 AND a.owner_user_id=$3
        ORDER BY d.created_at,d.id`, [principal.tenantId, conversationId, principal.userId]);
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const retentionExpiresAt = row.retention_expires_at;
        return {
          documentSnapshot: this.mapSnapshot(row),
          artifact: {
            tenantId: principal.tenantId,
            id: String(row.artifact_id),
            kind: 'source_document',
            businessTaskId: null,
            rootArtifactId: String(row.artifact_id),
            conversationId: String(row.conversation_id),
            ownerUserId: String(row.owner_user_id),
            displayName: String(row.display_name),
            mediaType: row.media_type as 'text/plain' | 'text/markdown',
            sizeBytes: Number(row.size_bytes),
            contentSha256: String(row.content_sha256),
            manifestId: String(row.manifest_id),
            documentSnapshotId: String(row.id),
            storageBucket: String(row.storage_bucket),
            storageKey: String(row.storage_key),
            availability: String(row.availability),
            integrity: String(row.integrity),
            stateVersion: Number(row.state_version),
            retentionStatus: String(row.retention_status),
            retentionExpiresAt: retentionExpiresAt instanceof Date ? retentionExpiresAt.toISOString() : String(retentionExpiresAt),
            reconcileStatus: String(row.reconcile_status),
            dataClass: String(row.data_class),
            audience: row.audience,
            resourceScope: String(row.resource_scope),
          },
        };
      });
    });
  }

  async getAuthorizedArtifact(principal: Principal, artifactId: string): Promise<AuthorizedArtifact> {
    const result = await this.pool.query<{
      id: string;
      kind: 'source_document' | 'simulation_report';
      business_task_id: string | null;
      root_artifact_id: string;
      conversation_id: string;
      owner_user_id: string;
      display_name: string;
      media_type: 'text/plain' | 'text/markdown';
      size_bytes: string;
      content_sha256: string;
      manifest_id: string;
      document_snapshot_id: string | null;
      storage_bucket: string;
      storage_key: string;
      availability: string;
      integrity: string;
      state_version: string;
      retention_expires_at: Date | string;
      retention_status: string;
      reconcile_status: string;
      data_class: string;
      audience: unknown;
      resource_scope: string;
    }>(`SELECT a.id,a.kind,a.business_task_id,a.root_artifact_id,a.conversation_id,a.owner_user_id,
      a.display_name,a.media_type,a.size_bytes,a.content_sha256,
      m.id manifest_id,m.storage_bucket,m.storage_key,s.availability,s.integrity,s.state_version,
      s.retention_status,s.retention_expires_at,s.reconcile_status,
      d.id document_snapshot_id,a.data_class,a.audience,a.resource_scope
      FROM artifacts a JOIN artifact_manifests m ON m.tenant_id=a.tenant_id AND m.artifact_id=a.id
      JOIN artifact_states s ON s.tenant_id=a.tenant_id AND s.artifact_id=a.id
      LEFT JOIN document_snapshots d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.id
      JOIN conversations c ON c.tenant_id=a.tenant_id AND c.id=a.conversation_id
      LEFT JOIN business_tasks task ON task.tenant_id=a.tenant_id AND task.id=a.business_task_id
      LEFT JOIN artifacts root ON root.tenant_id=a.tenant_id AND root.id=a.root_artifact_id
      LEFT JOIN artifact_states root_state ON root_state.tenant_id=root.tenant_id AND root_state.artifact_id=root.id
      LEFT JOIN document_snapshots root_snapshot ON root_snapshot.tenant_id=root.tenant_id AND root_snapshot.artifact_id=root.id
      WHERE a.tenant_id=$1 AND a.id=$2 AND a.owner_user_id=$3 AND c.user_id=$3
        AND (a.kind='source_document' OR (
          a.kind='simulation_report'
          AND task.id IS NOT NULL AND task.requester_id=$3 AND task.conversation_id=a.conversation_id
          AND root.id IS NOT NULL AND root.owner_user_id=$3 AND root.conversation_id=a.conversation_id
          AND root_snapshot.id=task.input_snapshot->>'documentSnapshotId'
          AND root_snapshot.artifact_id=task.input_snapshot->>'artifactId'
          AND root_snapshot.manifest_id=task.input_snapshot->>'manifestId'
          AND root_snapshot.content_sha256=task.input_snapshot->>'contentSha256'
          AND root_snapshot.simulation_profile=task.input_snapshot->>'simulationProfile'
          AND root_snapshot.profile_registry_version=task.input_snapshot->>'profileRegistryVersion'
          AND root_snapshot.resource_scope=task.input_snapshot->>'resourceScope'
          AND root_snapshot.data_class=task.input_snapshot->>'dataClass'
          AND ('conversation:' || root_snapshot.conversation_id)=task.input_snapshot->>'audience'
          AND root_snapshot.resource_scope='artifact:' || root.id
          AND root_snapshot.data_class='C1'
          AND root_snapshot.audience=jsonb_build_object('kind','private-conversation','conversationId',a.conversation_id)
          AND task.permission_scope=jsonb_build_object(
            'actions',jsonb_build_array('R0','R1','A1'),
            'resourceScopes',jsonb_build_array(root_snapshot.resource_scope),
            'dataClasses',jsonb_build_array('C0','C1'))
          AND task.audience_scope=jsonb_build_object(
            'kind','private-conversation','ids',jsonb_build_array('conversation:' || a.conversation_id))
          AND a.resource_scope=root_snapshot.resource_scope AND a.data_class='C1'
          AND a.audience=jsonb_build_object('kind','private-conversation','conversationId',a.conversation_id)
          AND root_state.availability='active' AND root_state.integrity='verified'
          AND root_state.retention_status='active' AND root_state.retention_expires_at>now()
          AND root_state.reconcile_status='in_sync'
        ))`, [principal.tenantId, artifactId, principal.userId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new GenewayError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    const retentionExpiresAt = row.retention_expires_at;
    return {
      tenantId: principal.tenantId,
      id: row.id,
      kind: row.kind,
      businessTaskId: row.business_task_id,
      rootArtifactId: row.root_artifact_id,
      conversationId: row.conversation_id,
      ownerUserId: row.owner_user_id,
      displayName: row.display_name,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
      manifestId: row.manifest_id,
      documentSnapshotId: row.document_snapshot_id,
      storageBucket: row.storage_bucket,
      storageKey: row.storage_key,
      availability: row.availability,
      integrity: row.integrity,
      stateVersion: Number(row.state_version),
      retentionStatus: row.retention_status,
      retentionExpiresAt: retentionExpiresAt instanceof Date ? retentionExpiresAt.toISOString() : String(retentionExpiresAt),
      reconcileStatus: row.reconcile_status,
      dataClass: row.data_class,
      audience: row.audience,
      resourceScope: row.resource_scope,
    };
  }

  async markIntegrityFailure(
    principal: Principal,
    artifact: AuthorizedArtifact,
    availability: 'active' | 'missing',
    reasonCode: string,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const updated = await client.query(`UPDATE artifact_states
        SET availability=$3,integrity='failed',failure_code=$4,last_error=$4,reconcile_status='required',
            last_checked_at=now(),state_version=state_version+1,updated_at=now()
        WHERE tenant_id=$1 AND artifact_id=$2 AND state_version=$5 AND availability='active' AND integrity='verified'
        RETURNING state_version`, [principal.tenantId, artifact.id, availability, reasonCode, artifact.stateVersion]);
      if (updated.rowCount !== 1) return false;
      await this.insertAudit(client, principal, 'artifact.integrity.failed', 'artifact', artifact.id, 'failed', reasonCode, {});
      return true;
    });
  }

  async recordAudit(
    principal: Principal,
    eventType: string,
    resourceType: string,
    resourceId: string,
    outcome: 'allowed' | 'denied' | 'failed',
    reasonCode: string,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.pool.query(`INSERT INTO audit_events
      (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [principal.tenantId, id('audit'), principal.userId, eventType, resourceType, resourceId, outcome, reasonCode, details]);
  }

  private async getReadyProjectionWithClient(client: PoolClient, principal: Principal, intentId: string): Promise<ArtifactIngestResponse> {
    const intentResult = await client.query<IntentRow>(`SELECT i.* FROM artifact_ingest_intents i
      JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
      WHERE i.tenant_id=$1 AND i.id=$2 AND i.requester_id=$3 AND c.user_id=$3`, [principal.tenantId, intentId, principal.userId]);
    const intentRow = intentResult.rows[0];
    if (intentRow === undefined) throw new GenewayError('INGEST_NOT_FOUND', 'Artifact ingest intent was not found', 404);
    const intent = mapIntent(intentRow);
    if (intent.status !== 'ready') {
      throw new GenewayError('INGEST_NOT_READY', 'Artifact ingest is not ready', 409, {
        intentStatus: intent.status,
        stateVersion: intent.stateVersion,
      });
    }
    const current = await client.query<{
      availability: string;
      integrity: string;
      retention_status: string;
      reconcile_status: string;
      retention_expires_at: Date | string;
      snapshot: Record<string, unknown>;
    }>(`SELECT s.availability,s.integrity,s.retention_status,s.reconcile_status,s.retention_expires_at,jsonb_build_object(
        'id',d.id,'artifact_id',d.artifact_id,'manifest_id',d.manifest_id,'conversation_id',d.conversation_id,
        'display_name',d.display_name,'media_type',d.media_type,'size_bytes',d.size_bytes,
        'content_sha256',d.content_sha256,'data_class',d.data_class,'audience',d.audience,
        'resource_scope',d.resource_scope,'trust',d.trust,'simulation_profile',d.simulation_profile,
        'profile_registry_version',d.profile_registry_version,'created_at',d.created_at
      ) snapshot
      FROM artifact_states s JOIN document_snapshots d ON d.tenant_id=s.tenant_id AND d.artifact_id=s.artifact_id
      WHERE s.tenant_id=$1 AND s.artifact_id=$2`, [principal.tenantId, intent.artifactId]);
    const row = current.rows[0];
    if (row === undefined) throw new GenewayError('ARTIFACT_STATE_MISSING', 'Artifact state is missing', 500);
    const retentionExpiresAt = row.retention_expires_at instanceof Date
      ? row.retention_expires_at
      : new Date(String(row.retention_expires_at));
    if (row.availability !== 'active' || row.integrity !== 'verified' || row.retention_status !== 'active'
      || row.reconcile_status !== 'in_sync'
      || !Number.isFinite(retentionExpiresAt.getTime()) || retentionExpiresAt.getTime() <= Date.now()) {
      throw new GenewayError('ARTIFACT_NOT_READY', 'Artifact is not available for task execution', 409, {
        intentStatus: intent.status,
        stateVersion: intent.stateVersion,
        availability: row.availability,
        integrity: row.integrity,
        retentionStatus: row.retention_status,
      });
    }
    const documentSnapshot = this.mapSnapshot(row.snapshot);
    return artifactIngestResponseSchema.parse({
      ingest: { id: intent.id, status: 'ready', stateVersion: intent.stateVersion },
      artifact: {
        id: intent.artifactId,
        manifestId: intent.manifestId,
        displayName: intent.displayName,
        mediaType: intent.mediaType,
        sizeBytes: intent.sizeBytes,
        contentSha256: intent.contentSha256,
        availability: row.availability,
        integrity: row.integrity,
        downloadUrl: `/api/artifacts/${intent.artifactId}/download`,
      },
      documentSnapshot,
      executionEligibility: intent.simulationProfile === null
        ? { eligible: false, reason: 'PROFILE_NOT_RECOGNIZED' }
        : { eligible: true },
    });
  }

  private async assertConversationOwned(client: PoolClient, principal: Principal, conversationId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [principal.tenantId, conversationId, principal.userId]);
    if (result.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
  }

  private mapSnapshot(row: Record<string, unknown> | undefined): DocumentSnapshot {
    if (row === undefined) throw new Error('Document snapshot was not persisted');
    const createdAt = row.created_at;
    const parsedCreatedAt = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
    if (Number.isNaN(parsedCreatedAt.valueOf())) throw new Error('Document snapshot has an invalid creation timestamp');
    return documentSnapshotSchema.parse({
      id: row.id,
      artifactId: row.artifact_id,
      manifestId: row.manifest_id,
      conversationId: row.conversation_id,
      displayName: row.display_name,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
      dataClass: row.data_class,
      audience: row.audience,
      resourceScope: row.resource_scope,
      trust: row.trust,
      simulationProfile: row.simulation_profile,
      profileRegistryVersion: row.profile_registry_version,
      createdAt: parsedCreatedAt.toISOString(),
    });
  }

  private async insertAudit(
    client: PoolClient,
    principal: Principal,
    eventType: string,
    resourceType: string,
    resourceId: string,
    outcome: 'allowed' | 'denied' | 'failed',
    reasonCode: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await client.query(`INSERT INTO audit_events
      (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [principal.tenantId, id('audit'), principal.userId, eventType, resourceType, resourceId, outcome, reasonCode, details]);
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async withReadClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await operation(client); } finally { client.release(); }
  }
}
