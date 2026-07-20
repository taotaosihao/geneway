import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GenewayError, simulationEnvelopeSchema } from '@geneway/contracts';

export const FIXTURE_EXCERPT = '系统需支持生产工单全过程跟踪，并对质量检验批次提供可追溯记录。';
export const FIXTURE_REF = 'fixture:solution-analysis:v1' as const;
export const FIXTURE_VERSION = 1 as const;
export const FIXTURE_SOURCE_ID = `${FIXTURE_REF}#requirements` as const;
export const POSITIVE_CLAIM_TEXT = '当前材料明确要求生产工单跟踪和质量追溯';
export const UNSUPPORTED_CLAIM_TEXT = '当前材料要求直接控制设备';

export const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const FIXTURE_CONTENT_HASH = sha256Text(FIXTURE_EXCERPT);

export const evidenceCandidateSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  businessTaskId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceExcerpt: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  resourceScope: z.string().min(1),
  dataClass: z.enum(['C0', 'C1', 'C2']),
  accessible: z.boolean(),
}).extend(simulationEnvelopeSchema.shape).strict();

export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>;

export const claimCandidateSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  businessTaskId: z.string().min(1),
  text: z.string().min(1),
  evidenceRefId: z.string().min(1).nullable(),
}).extend(simulationEnvelopeSchema.shape).strict();

export type ClaimCandidate = z.infer<typeof claimCandidateSchema>;

export function verifyEvidence(candidate: EvidenceCandidate, expectedTenant: string, expectedTask: string, allowedScopes: ReadonlySet<string>): void {
  evidenceCandidateSchema.parse(candidate);
  if (candidate.tenantId !== expectedTenant || candidate.businessTaskId !== expectedTask) throw new GenewayError('EVIDENCE_SCOPE_MISMATCH', 'Evidence is bound to a different task or tenant', 403);
  if (!candidate.accessible || !allowedScopes.has(candidate.resourceScope)) throw new GenewayError('EVIDENCE_NOT_ACCESSIBLE', 'Evidence is not accessible to this task', 403);
  if (sha256Text(candidate.sourceExcerpt) !== candidate.sourceHash) throw new GenewayError('EVIDENCE_HASH_MISMATCH', 'Evidence source hash is invalid', 409);
}

export function assertPublishableClaim(candidate: ClaimCandidate, evidence: EvidenceCandidate | undefined): EvidenceCandidate {
  claimCandidateSchema.parse(candidate);
  if (evidence === undefined || candidate.evidenceRefId === null || evidence.id !== candidate.evidenceRefId) {
    throw new GenewayError('CLAIM_EVIDENCE_REQUIRED', 'A fact claim cannot be published without valid evidence', 422);
  }
  if (candidate.tenantId !== evidence.tenantId || candidate.businessTaskId !== evidence.businessTaskId) {
    throw new GenewayError('CLAIM_EVIDENCE_SCOPE_MISMATCH', 'Claim and evidence must share tenant and task', 403);
  }
  return evidence;
}
