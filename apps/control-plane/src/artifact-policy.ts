import { GenewayError, type Principal } from '@geneway/contracts';
import type { AuthorizedArtifact } from './artifact-repository.js';

export type ArtifactReadinessReason =
  | 'ARTIFACT_NOT_AVAILABLE'
  | 'ARTIFACT_INTEGRITY_NOT_VERIFIED'
  | 'ARTIFACT_RETENTION_EXPIRED'
  | 'ARTIFACT_RECONCILIATION_REQUIRED';

export function assertArtifactMetadataAllowed(input: Readonly<{
  principal: Principal;
  artifact: AuthorizedArtifact;
  expectedBucket: string;
}>): void {
  const { principal, artifact } = input;
  if (artifact.tenantId !== principal.tenantId || artifact.ownerUserId !== principal.userId) {
    throw new GenewayError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
  }
  if (artifact.storageBucket !== input.expectedBucket) {
    throw new GenewayError('ARTIFACT_STORAGE_SCOPE_INVALID', 'Artifact storage scope is invalid', 409);
  }
  if (artifact.dataClass !== 'C1') {
    throw new GenewayError('ARTIFACT_POLICY_DENIED', 'Artifact data class is not allowed', 403);
  }
  const audience = artifact.audience as Readonly<{ kind?: unknown; conversationId?: unknown }> | null;
  if (audience?.kind !== 'private-conversation' || audience.conversationId !== artifact.conversationId) {
    throw new GenewayError('ARTIFACT_POLICY_DENIED', 'Artifact audience is not allowed', 403);
  }
  if (artifact.resourceScope !== `artifact:${artifact.id}`) {
    throw new GenewayError('ARTIFACT_POLICY_DENIED', 'Artifact resource scope is invalid', 403);
  }
}

export function artifactReadinessReason(artifact: AuthorizedArtifact, now: Date): ArtifactReadinessReason | null {
  if (artifact.retentionStatus !== 'active') return 'ARTIFACT_RETENTION_EXPIRED';
  const expiresAt = new Date(artifact.retentionExpiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return 'ARTIFACT_RETENTION_EXPIRED';
  if (artifact.availability !== 'active') return 'ARTIFACT_NOT_AVAILABLE';
  if (artifact.integrity !== 'verified') return 'ARTIFACT_INTEGRITY_NOT_VERIFIED';
  if (artifact.reconcileStatus !== 'in_sync') return 'ARTIFACT_RECONCILIATION_REQUIRED';
  return null;
}

export function assertArtifactDownloadAllowed(input: Readonly<{
  principal: Principal;
  artifact: AuthorizedArtifact;
  expectedBucket: string;
  now: Date;
}>): void {
  assertArtifactMetadataAllowed(input);
  const reason = artifactReadinessReason(input.artifact, input.now);
  switch (reason) {
    case null:
      return;
    case 'ARTIFACT_RETENTION_EXPIRED':
      throw new GenewayError(reason, 'Artifact retention has expired', 409);
    case 'ARTIFACT_NOT_AVAILABLE':
      throw new GenewayError(reason, 'Artifact is not available for download', 409);
    case 'ARTIFACT_INTEGRITY_NOT_VERIFIED':
      throw new GenewayError(reason, 'Artifact integrity is not verified', 409);
    case 'ARTIFACT_RECONCILIATION_REQUIRED':
      throw new GenewayError(reason, 'Artifact requires reconciliation', 409);
  }
}
