import { createHash } from 'node:crypto';
import {
  documentSnapshotProjectionSchema,
  GenewayError,
  type ArtifactIngestResponse,
  type DocumentSnapshotProjection,
  type Principal,
} from '@geneway/contracts';
import { MAX_RAW_UPLOAD_BYTES, type ValidatedTextUpload } from '@geneway/ingestion';
import {
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
} from '@geneway/storage';
import { artifactReadinessReason, assertArtifactDownloadAllowed, assertArtifactMetadataAllowed } from './artifact-policy.js';
import type { ArtifactIngestIntent, ArtifactRepository, AuthorizedArtifact } from './artifact-repository.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type DownloadedArtifact = Readonly<{ artifact: AuthorizedArtifact; bytes: Uint8Array }>;
type StoredObjectIdentity = Readonly<{ eTag: string | null }>;

export type ArtifactServiceHooks = Readonly<{
  afterIngestIntentPutAuthorityCommitted?: (input: Readonly<{
    conversationId: string;
    idempotencyKey: string;
    ingestIntentId: string;
    artifactId: string;
    documentSnapshotId: string;
    storageKey: string;
    intentStatus: 'put_inflight';
    stateVersion: number;
  }>) => Promise<void>;
  afterSourceObjectPut?: (input: Readonly<{
    conversationId: string;
    idempotencyKey: string;
    ingestIntentId: string;
    artifactId: string;
    documentSnapshotId: string;
    storageKey: string;
    contentSha256: string;
    eTag: string | null;
    versionId: string | null;
  }>) => Promise<'continue' | 'inject_error'>;
}>;

export class ArtifactService {
  constructor(
    readonly repository: ArtifactRepository,
    readonly storage: ObjectStorage,
    private readonly hooks: ArtifactServiceHooks = {},
  ) {}

  async ingest(input: Readonly<{
    principal: Principal;
    conversationId: string;
    idempotencyKey: string;
    upload: ValidatedTextUpload;
  }>): Promise<ArtifactIngestResponse> {
    let intent = await this.repository.createOrLoadIntent({ ...input, bucket: this.storage.bucket });
    if (intent.status === 'ready') return this.repository.getReadyProjection(input.principal, intent.id);

    let ownsPut = false;
    let stored: StoredObjectIdentity = { eTag: null };
    if (intent.status === 'intent_created' || intent.status === 'put_failed_confirmed') {
      const claimed = await this.repository.transitionIntent({
        principal: input.principal,
        intent,
        expectedStatuses: [intent.status],
        nextStatus: 'put_inflight',
      });
      intent = claimed ?? await this.repository.getIntent(input.principal, intent.id);
      ownsPut = claimed !== null;
      if (ownsPut) {
        await this.hooks.afterIngestIntentPutAuthorityCommitted?.({
          conversationId: intent.conversationId,
          idempotencyKey: input.idempotencyKey,
          ingestIntentId: intent.id,
          artifactId: intent.artifactId,
          documentSnapshotId: intent.documentSnapshotId,
          storageKey: intent.storageKey,
          intentStatus: 'put_inflight',
          stateVersion: intent.stateVersion,
        });
      }
    }

    if (intent.status === 'ready') return this.repository.getReadyProjection(input.principal, intent.id);
    if (intent.status === 'object_verified') return this.repository.finalizeIntent(input.principal, intent, stored);
    if (intent.status === 'integrity_error') {
      throw new GenewayError('ARTIFACT_INTEGRITY_FAILED', 'Artifact ingest failed integrity verification', 409);
    }
    if (intent.status === 'delete_pending' || intent.status === 'deleted') {
      throw new GenewayError('ARTIFACT_NOT_AVAILABLE', 'Artifact ingest is no longer available', 409);
    }
    if (intent.status !== 'put_inflight' && intent.status !== 'reconcile_required') {
      throw new GenewayError('INGEST_NOT_READY', 'Artifact ingest cannot advance from its current state', 409, {
        intentStatus: intent.status,
        stateVersion: intent.stateVersion,
      });
    }

    if (ownsPut) {
      try {
        try {
          const created = await this.storage.putCreateOnly({
            key: intent.storageKey,
            bytes: input.upload.bytes,
            contentType: intent.mediaType,
            contentSha256: intent.contentSha256,
          });
          stored = created;
          const action = await this.hooks.afterSourceObjectPut?.({
            conversationId: intent.conversationId,
            idempotencyKey: input.idempotencyKey,
            ingestIntentId: intent.id,
            artifactId: intent.artifactId,
            documentSnapshotId: intent.documentSnapshotId,
            storageKey: intent.storageKey,
            contentSha256: intent.contentSha256,
            eTag: created.eTag,
            versionId: created.versionId,
          });
          if (action === 'inject_error') throw new Error('E2E_PUT_RESPONSE_LOST');
        } catch (error) {
          if (!(error instanceof StorageObjectAlreadyExistsError)) throw error;
        }
      } catch {
        const current = await this.markReconciliationRequired(input.principal, intent, 'STORAGE_PUT_OUTCOME_UNCERTAIN');
        if (current.status === 'ready') return this.repository.getReadyProjection(input.principal, current.id);
        throw new GenewayError('STORAGE_PUT_OUTCOME_UNCERTAIN', 'Artifact put outcome requires reconciliation', 502);
      }
    }

    try {
      stored = await this.verifyStoredObject(intent, stored);
    } catch (error) {
      if (!ownsPut && intent.status === 'put_inflight' && error instanceof StorageObjectNotFoundError) {
        throw new GenewayError('INGEST_IN_PROGRESS', 'Artifact ingest is still in progress', 409);
      }
      if (error instanceof GenewayError && error.code === 'STORAGE_VERIFICATION_FAILED') {
        const failed = await this.repository.transitionIntent({
          principal: input.principal,
          intent,
          expectedStatuses: ['put_inflight', 'reconcile_required'],
          nextStatus: 'integrity_error',
          failureCode: error.code,
        });
        const current = failed ?? await this.repository.getIntent(input.principal, intent.id);
        if (current.status === 'ready') return this.repository.getReadyProjection(input.principal, current.id);
        throw error;
      }
      const reasonCode = error instanceof StorageObjectNotFoundError ? 'STORAGE_OBJECT_MISSING'
        : error instanceof StorageObjectTooLargeError ? 'STORAGE_OBJECT_TOO_LARGE'
          : 'STORAGE_VERIFICATION_UNCERTAIN';
      const current = await this.markReconciliationRequired(input.principal, intent, reasonCode);
      if (current.status === 'ready') return this.repository.getReadyProjection(input.principal, current.id);
      throw new GenewayError(reasonCode, 'Artifact storage could not be verified', 502);
    }

    const verified = await this.repository.transitionIntent({
      principal: input.principal,
      intent,
      expectedStatuses: ['put_inflight', 'reconcile_required'],
      nextStatus: 'object_verified',
      eTagObserved: stored.eTag,
    });
    intent = verified ?? await this.repository.getIntent(input.principal, intent.id);
    if (intent.status === 'ready') return this.repository.getReadyProjection(input.principal, intent.id);
    if (intent.status !== 'object_verified') {
      throw new GenewayError('INGEST_IN_PROGRESS', 'Artifact ingest state changed while the object was verified', 409, {
        intentStatus: intent.status,
        stateVersion: intent.stateVersion,
      });
    }
    return this.repository.finalizeIntent(input.principal, intent, stored);
  }

  async listSnapshots(principal: Principal, conversationId: string): Promise<readonly DocumentSnapshotProjection[]> {
    await this.repository.assertReadsOpen();
    let records: readonly Awaited<ReturnType<ArtifactRepository['listSnapshotRecords']>>[number][];
    try {
      records = await this.repository.listSnapshotRecords(principal, conversationId);
    } catch (error) {
      const reasonCode = error instanceof GenewayError ? error.code : 'SNAPSHOT_READ_FAILED';
      await this.repository.recordAudit(principal, 'artifact.snapshot.read.denied', 'conversation', conversationId,
        error instanceof GenewayError && error.statusCode < 500 ? 'denied' : 'failed', reasonCode, {});
      throw error;
    }
    return Promise.all(records.map(async ({ documentSnapshot, artifact }) => {
      try {
        assertArtifactMetadataAllowed({ principal, artifact, expectedBucket: this.storage.bucket });
      } catch (error) {
        const reasonCode = error instanceof GenewayError ? error.code : 'SNAPSHOT_POLICY_FAILED';
        await this.repository.recordAudit(principal, 'artifact.snapshot.read.denied', 'artifact', artifact.id,
          error instanceof GenewayError && error.statusCode < 500 ? 'denied' : 'failed', reasonCode, {});
        throw error;
      }
      const readiness = artifactReadinessReason(artifact, new Date());
      const artifactState = {
        availability: artifact.availability,
        integrity: artifact.integrity,
        retentionStatus: artifact.retentionStatus,
        reconcileStatus: artifact.reconcileStatus,
        stateVersion: artifact.stateVersion,
        downloadAllowed: readiness === null,
      };
      if (readiness !== null) {
        await this.repository.recordAudit(principal, 'artifact.snapshot.read.denied', 'artifact', artifact.id, 'denied', readiness, {});
        throw new GenewayError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      return documentSnapshotProjectionSchema.parse({
        status: 'available',
        documentSnapshot,
        artifactState,
        downloadUrl: `/api/artifacts/${artifact.id}/download`,
        executionEligibility: documentSnapshot.simulationProfile === null
          ? { eligible: false, reason: 'PROFILE_NOT_RECOGNIZED' }
          : { eligible: true },
      });
    }));
  }

  async download(principal: Principal, artifactId: string): Promise<DownloadedArtifact> {
    await this.repository.assertReadsOpen();
    const artifact = await this.repository.getAuthorizedArtifact(principal, artifactId);
    assertArtifactDownloadAllowed({ principal, artifact, expectedBucket: this.storage.bucket, now: new Date() });
    try {
      const head = await this.storage.head(artifact.storageKey);
      const bytes = await this.storage.getBytes(artifact.storageKey, MAX_RAW_UPLOAD_BYTES);
      if (head.sizeBytes !== artifact.sizeBytes || bytes.byteLength !== artifact.sizeBytes
        || head.contentType !== artifact.mediaType || head.contentSha256 !== artifact.contentSha256
        || sha256(bytes) !== artifact.contentSha256) {
        await this.repository.markIntegrityFailure(principal, artifact, 'active', 'ARTIFACT_HASH_OR_SIZE_MISMATCH');
        throw new GenewayError('ARTIFACT_INTEGRITY_FAILED', 'Artifact failed integrity verification', 409);
      }
      await this.repository.recordAudit(principal, 'artifact.download.completed', 'artifact', artifact.id, 'allowed', 'ARTIFACT_VERIFIED', {
        contentSha256: artifact.contentSha256,
        sizeBytes: artifact.sizeBytes,
      });
      return { artifact, bytes };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        await this.repository.markIntegrityFailure(principal, artifact, 'missing', 'ARTIFACT_OBJECT_MISSING');
        throw new GenewayError('ARTIFACT_OBJECT_MISSING', 'Artifact object is missing from storage', 409);
      }
      if (error instanceof StorageObjectTooLargeError) {
        await this.repository.markIntegrityFailure(principal, artifact, 'active', 'ARTIFACT_OBJECT_TOO_LARGE');
        throw new GenewayError('ARTIFACT_INTEGRITY_FAILED', 'Artifact exceeds its immutable size limit', 409);
      }
      if (error instanceof GenewayError) throw error;
      throw new GenewayError('STORAGE_OPERATION_FAILED', 'Artifact storage could not be read', 502);
    }
  }

  private async verifyStoredObject(intent: ArtifactIngestIntent, observed: StoredObjectIdentity): Promise<StoredObjectIdentity> {
    const head = await this.storage.head(intent.storageKey);
    const bytes = await this.storage.getBytes(intent.storageKey, MAX_RAW_UPLOAD_BYTES);
    if (head.sizeBytes !== intent.sizeBytes || bytes.byteLength !== intent.sizeBytes
      || head.contentType !== intent.mediaType || head.contentSha256 !== intent.contentSha256
      || sha256(bytes) !== intent.contentSha256) {
      throw new GenewayError('STORAGE_VERIFICATION_FAILED', 'Stored object does not match the immutable ingest intent', 502);
    }
    return { eTag: head.eTag ?? observed.eTag };
  }

  private async markReconciliationRequired(principal: Principal, intent: ArtifactIngestIntent, reasonCode: string): Promise<ArtifactIngestIntent> {
    const transitioned = await this.repository.transitionIntent({
      principal,
      intent,
      expectedStatuses: ['put_inflight'],
      nextStatus: 'reconcile_required',
      failureCode: reasonCode,
    });
    return transitioned ?? this.repository.getIntent(principal, intent.id);
  }
}
