import { describe, expect, it } from 'vitest';
import { GenewayError, type Principal } from '@geneway/contracts';
import { assertArtifactDownloadAllowed } from './artifact-policy.js';
import type { AuthorizedArtifact } from './artifact-repository.js';

const principal: Principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' };
const artifact: AuthorizedArtifact = {
  tenantId: principal.tenantId,
  id: 'artifact_1',
  conversationId: 'conversation_1',
  ownerUserId: principal.userId,
  displayName: 'source.txt',
  mediaType: 'text/plain',
  sizeBytes: 4,
  contentSha256: '0'.repeat(64),
  manifestId: 'manifest_1',
  documentSnapshotId: 'snapshot_1',
  storageBucket: 'geneway-artifacts',
  storageKey: 'tenants/tenant_local/artifacts/artifact_1/source.txt',
  availability: 'active',
  integrity: 'verified',
  stateVersion: 1,
  retentionStatus: 'active',
  retentionExpiresAt: '2030-01-01T00:00:00.000Z',
  reconcileStatus: 'in_sync',
  dataClass: 'C1',
  audience: { kind: 'private-conversation', conversationId: 'conversation_1' },
  resourceScope: 'artifact:artifact_1',
};

function codeFor(candidate: AuthorizedArtifact, expectedBucket = artifact.storageBucket): string | null {
  try {
    assertArtifactDownloadAllowed({ principal, artifact: candidate, expectedBucket, now: new Date('2029-01-01T00:00:00.000Z') });
    return null;
  } catch (error) {
    if (error instanceof GenewayError) return error.code;
    throw error;
  }
}

describe('artifact policy evaluator', () => {
  it('allows the exact private-conversation, root-scope, lifecycle projection', () => {
    expect(codeFor(artifact)).toBeNull();
  });

  it.each([
    ['bucket', { ...artifact }, 'other-bucket', 'ARTIFACT_STORAGE_SCOPE_INVALID'],
    ['data class', { ...artifact, dataClass: 'C2' }, artifact.storageBucket, 'ARTIFACT_POLICY_DENIED'],
    ['audience kind', { ...artifact, audience: { kind: 'group', conversationId: artifact.conversationId } }, artifact.storageBucket, 'ARTIFACT_POLICY_DENIED'],
    ['audience conversation', { ...artifact, audience: { kind: 'private-conversation', conversationId: 'conversation_2' } }, artifact.storageBucket, 'ARTIFACT_POLICY_DENIED'],
    ['resource scope', { ...artifact, resourceScope: 'artifact:artifact_2' }, artifact.storageBucket, 'ARTIFACT_POLICY_DENIED'],
    ['retention state', { ...artifact, retentionStatus: 'expired' }, artifact.storageBucket, 'ARTIFACT_RETENTION_EXPIRED'],
    ['retention time', { ...artifact, retentionExpiresAt: '2028-01-01T00:00:00.000Z' }, artifact.storageBucket, 'ARTIFACT_RETENTION_EXPIRED'],
    ['availability', { ...artifact, availability: 'missing' }, artifact.storageBucket, 'ARTIFACT_NOT_AVAILABLE'],
    ['integrity', { ...artifact, integrity: 'failed' }, artifact.storageBucket, 'ARTIFACT_INTEGRITY_NOT_VERIFIED'],
    ['reconcile status', { ...artifact, reconcileStatus: 'required' }, artifact.storageBucket, 'ARTIFACT_RECONCILIATION_REQUIRED'],
  ] satisfies readonly (readonly [string, AuthorizedArtifact, string, string])[])('rejects malformed %s before storage', (_name, candidate, bucket, code) => {
    expect(codeFor(candidate, bucket)).toBe(code);
  });
});
