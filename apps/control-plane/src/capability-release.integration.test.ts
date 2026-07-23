import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import { createControlPlane, type ControlPlane } from './index.js';
import { CapabilityReleaseRepository } from './capability-release.js';
import { ChatRepository } from './chat-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for capability release integration tests');
const providerEvidence = {
  kind: 'provider-readiness' as const,
  manifestDigest: 'b'.repeat(64),
  conformanceDigest: 'c'.repeat(64),
  profile: 'codex_subscription_dev' as const,
  providerModel: 'gpt-5.4-mini' as const,
  conformancePassedAt: new Date(Date.now() - 1_000).toISOString(),
  conformanceDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  conformanceExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1' as const,
};
const candidateEvidence = (shadowEvidenceDigest: string) => ({
  kind: 'disposable-live-validation-candidate' as const,
  runId: 'release-integration',
  manifestDigest: providerEvidence.manifestDigest,
  conformanceDigest: providerEvidence.conformanceDigest,
  shadowEvidenceDigest,
  purpose: 'temporarily open the disposable route solely for gate-a0-live validation' as const,
  expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
});

describe('Gate A0 capability release authority', () => {
  let controlPlane: ControlPlane;
  let releases: CapabilityReleaseRepository;

  beforeAll(async () => {
    controlPlane = await createControlPlane({ databaseUrl, objectStorage: null });
    releases = new CapabilityReleaseRepository(controlPlane.repository.pool);
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  it('starts draft-only and permits only CAS draft→shadow→internal promotion', async () => {
    const initial = await controlPlane.repository.pool.query(`SELECT active.release_id,active.pointer_version::int,release.state
      FROM capability_active_releases active JOIN capability_release_records release
      ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      WHERE active.tenant_id='tenant_local' AND active.capability_id='xiaowei.chat.v1'`);
    expect(initial.rows).toEqual([{
      release_id: 'release_xiaowei_chat_v1_draft', pointer_version: 1, state: 'draft',
    }]);
    const draftEvidence = await controlPlane.repository.pool.query<{ gate_evidence_digest: string }>(`SELECT gate_evidence_digest
      FROM capability_release_records WHERE tenant_id='tenant_local' AND id='release_xiaowei_chat_v1_draft'`);
    expect(draftEvidence.rows).toEqual([{
      gate_evidence_digest: 'a6225da9a53c99583ce8459e6fb2e1d5af6366db859e415307e1c6b4994556ca',
    }]);
    await expect(releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'release-test', evidence: candidateEvidence('a'.repeat(64)),
    })).rejects.toThrow('transition is not allowed');

    const shadow = await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'release-test', evidence: providerEvidence, releaseId: 'release_test_shadow',
    });
    const persistedShadow = await controlPlane.repository.pool.query<{ gate_evidence: unknown; gate_evidence_digest: string }>(`SELECT gate_evidence,gate_evidence_digest
      FROM capability_release_records WHERE tenant_id='tenant_local' AND id=$1`, [shadow.releaseId]);
    expect(persistedShadow.rows[0]?.gate_evidence).toEqual(providerEvidence);
    expect(persistedShadow.rows[0]?.gate_evidence_digest).toBe(
      createHash('sha256').update(canonicalize(providerEvidence), 'utf8').digest('hex'),
    );
    const raced = await Promise.allSettled(['left', 'right'].map((suffix) => releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'release-test', evidence: candidateEvidence(shadow.gateEvidenceDigest),
      releaseId: `release_test_internal_${suffix}`,
    })));
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await controlPlane.repository.pool.query(`SELECT active.pointer_version::int,release.state,
      release.gate_evidence->>'kind' evidence_kind,
      (SELECT count(*)::int FROM capability_release_records WHERE tenant_id='tenant_local'
        AND capability_version_id='capability_xiaowei_chat_v1') release_count
      FROM capability_active_releases active JOIN capability_release_records release
      ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      WHERE active.tenant_id='tenant_local' AND active.capability_id='xiaowei.chat.v1'`);
    expect(active.rows).toEqual([{
      pointer_version: 3, state: 'internal', evidence_kind: 'disposable-live-validation-candidate', release_count: 3,
    }]);
    await expect(new ChatRepository(controlPlane.repository.pool).isInternalRelease('tenant_local')).resolves.toBe(false);
    await expect(new ChatRepository(controlPlane.repository.pool, 'wrong-run').isInternalRelease('tenant_local')).resolves.toBe(false);
    await expect(new ChatRepository(controlPlane.repository.pool, 'release-integration').isInternalRelease('tenant_local')).resolves.toBe(true);
    await expect(releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'release-test', evidence: candidateEvidence(shadow.gateEvidenceDigest),
    })).rejects.toThrow('CAS precondition failed');
  });

  it('expires a disposable candidate even when its database release state remains internal', async () => {
    const shadow = await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'release-test', evidence: providerEvidence,
    });
    await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'release-test', evidence: {
        ...candidateEvidence(shadow.gateEvidenceDigest),
        runId: 'expiring-run',
        expiresAt: new Date(Date.now() + 1_500).toISOString(),
      },
    });
    const repository = new ChatRepository(controlPlane.repository.pool, 'expiring-run');
    await expect(repository.isInternalRelease('tenant_local')).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await expect(repository.isInternalRelease('tenant_local')).resolves.toBe(false);
  });
});
