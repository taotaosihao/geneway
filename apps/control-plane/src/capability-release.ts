import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { canonicalize } from 'json-canonicalize';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerReadinessEvidenceSchema = z.object({
  kind: z.literal('provider-readiness'),
  manifestDigest: digestSchema,
  conformanceDigest: digestSchema,
  profile: z.literal('codex_subscription_dev'),
  providerModel: z.literal('gpt-5.4-mini'),
  conformancePassedAt: z.string().datetime(),
  conformanceDeadline: z.string().datetime(),
  conformanceExpiresAt: z.string().datetime(),
  credentialBoundary: z.literal('manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1'),
}).strict().superRefine((evidence, context) => {
  const passedAt = Date.parse(evidence.conformancePassedAt);
  const deadline = Date.parse(evidence.conformanceDeadline);
  const expiresAt = Date.parse(evidence.conformanceExpiresAt);
  if (passedAt > deadline || deadline > expiresAt || expiresAt <= Date.now()) {
    context.addIssue({ code: 'custom', message: 'provider readiness evidence is expired or temporally invalid' });
  }
});
const liveCandidateEvidenceSchema = z.object({
  kind: z.literal('disposable-live-validation-candidate'),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  manifestDigest: digestSchema,
  conformanceDigest: digestSchema,
  shadowEvidenceDigest: digestSchema,
  purpose: z.literal('temporarily open the disposable route solely for gate-a0-live validation'),
  expiresAt: z.string().datetime(),
}).strict();
const promotionEvidenceSchema = z.union([providerReadinessEvidenceSchema, liveCandidateEvidenceSchema]);

const promotionSchema = z.object({
  tenantId: z.literal('tenant_local'),
  capabilityId: z.literal('xiaowei.chat.v1'),
  targetState: z.enum(['shadow', 'internal']),
  expectedReleaseId: z.string().min(1),
  expectedPointerVersion: z.number().int().positive(),
  actor: z.string().min(1).max(256),
  evidence: promotionEvidenceSchema,
  releaseId: z.string().min(1).max(256).optional(),
}).strict();

export type CapabilityPromotion = z.infer<typeof promotionSchema>;
export type CapabilityReleaseProjection = Readonly<{
  releaseId: string;
  state: 'shadow' | 'internal';
  sequence: number;
  pointerVersion: number;
  previousReleaseId: string;
  gateEvidenceDigest: string;
}>;

export class CapabilityReleaseRepository {
  constructor(private readonly pool: pg.Pool) {}

  async promote(inputValue: CapabilityPromotion): Promise<CapabilityReleaseProjection> {
    const input = promotionSchema.parse(inputValue);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query<{
        release_id: string; pointer_version: string; state: 'draft' | 'shadow' | 'internal'; sequence: string;
        capability_version_id: string; prompt_policy_version_id: string; gate_evidence: unknown; gate_evidence_digest: string;
      }>(`SELECT active.release_id,active.pointer_version::text,release.state,release.sequence::text,
        release.capability_version_id,release.prompt_policy_version_id,release.gate_evidence,release.gate_evidence_digest
        FROM capability_active_releases active
        JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
        WHERE active.tenant_id=$1 AND active.capability_id=$2 FOR UPDATE OF active`, [input.tenantId, input.capabilityId]);
      const current = active.rows[0];
      if (current === undefined || current.release_id !== input.expectedReleaseId
        || Number(current.pointer_version) !== input.expectedPointerVersion) {
        throw new Error('capability release CAS precondition failed');
      }
      const expectedTarget = current.state === 'draft' ? 'shadow' : current.state === 'shadow' ? 'internal' : null;
      if (input.targetState !== expectedTarget) throw new Error('capability release transition is not allowed');
      if (input.targetState === 'shadow' && input.evidence.kind !== 'provider-readiness') {
        throw new Error('shadow promotion requires verified provider readiness evidence');
      }
      if (input.targetState === 'internal') {
        if (input.evidence.kind !== 'disposable-live-validation-candidate') {
          throw new Error('internal promotion requires disposable live-validation candidate evidence');
        }
        const shadowEvidence = providerReadinessEvidenceSchema.parse(current.gate_evidence);
        if (input.evidence.shadowEvidenceDigest !== current.gate_evidence_digest
          || input.evidence.manifestDigest !== shadowEvidence.manifestDigest
          || input.evidence.conformanceDigest !== shadowEvidence.conformanceDigest
          || Date.parse(input.evidence.expiresAt) > Date.parse(shadowEvidence.conformanceExpiresAt)
          || Date.parse(input.evidence.expiresAt) <= Date.now()) {
          throw new Error('live-validation candidate does not bind the current unexpired shadow evidence');
        }
      }
      const gateEvidence = promotionEvidenceSchema.parse(input.evidence);
      const gateEvidenceDigest = createHash('sha256').update(canonicalize(gateEvidence), 'utf8').digest('hex');
      const releaseId = input.releaseId ?? `release_xiaowei_chat_v1_${input.targetState}_${randomUUID()}`;
      const sequence = Number(current.sequence) + 1;
      await client.query(`INSERT INTO capability_release_records
        (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,previous_release_id,actor,gate_evidence,gate_evidence_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        input.tenantId, releaseId, current.capability_version_id, current.prompt_policy_version_id,
        input.targetState, sequence, current.release_id, input.actor, gateEvidence, gateEvidenceDigest,
      ]);
      const pointerVersion = input.expectedPointerVersion + 1;
      const updated = await client.query(`UPDATE capability_active_releases
        SET release_id=$3,pointer_version=$4,updated_at=now()
        WHERE tenant_id=$1 AND capability_id=$2 AND release_id=$5 AND pointer_version=$6`, [
        input.tenantId, input.capabilityId, releaseId, pointerVersion, current.release_id, input.expectedPointerVersion,
      ]);
      if (updated.rowCount !== 1) throw new Error('capability release CAS update failed');
      await client.query('COMMIT');
      return {
        releaseId,
        state: input.targetState,
        sequence,
        pointerVersion,
        previousReleaseId: current.release_id,
        gateEvidenceDigest,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
