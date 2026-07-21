import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { GenewayError, simulationEnvelopeSchema } from '@geneway/contracts';

export const FIXTURE_EXCERPT = '系统需支持生产工单全过程跟踪，并对质量检验批次提供可追溯记录。';
export const FIXTURE_REF = 'fixture:solution-analysis:v1' as const;
export const FIXTURE_VERSION = 1 as const;
export const FIXTURE_SOURCE_ID = `${FIXTURE_REF}#requirements` as const;
export const POSITIVE_CLAIM_TEXT = '当前材料明确要求生产工单跟踪和质量追溯';
export const UNSUPPORTED_CLAIM_TEXT = '当前材料要求直接控制设备';
export const DEMO_DOCUMENT_SNAPSHOT_SHA256 = '3b5ee113e79ab2afb504898cf962da10f7d31e62ddb89370e645c2d32f48ca06';
export const DEMO_EVIDENCE_START_BYTE = 40;
export const DEMO_EVIDENCE_END_BYTE_EXCLUSIVE = 133;
export const DEMO_EVIDENCE_EXCERPT_SHA256 = '0230bc572ef7f3770a19727a8e9125cb30e9bdfd670c54c75ae6d4de8963b82f';
export const REPORT_TEMPLATE_ID = 'gate0.2a-report/v1';
export const REPORT_TEMPLATE_SHA256 = '3253cfb9b6e8d85d0c47a12a510c66f49c4f80b953004877c1d9cce8af9e2044';

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

export const reportRenderInputSchema = z.object({
  templateId: z.literal(REPORT_TEMPLATE_ID),
  templateSha256: z.literal(REPORT_TEMPLATE_SHA256),
  taskId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  workflowHash: z.string().regex(/^[a-f0-9]{64}$/),
  documentSnapshotId: z.string().min(1),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  claimText: z.literal(POSITIVE_CLAIM_TEXT),
  startByte: z.number().int().nonnegative(),
  endByteExclusive: z.number().int().positive(),
  excerptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ReportRenderInput = z.infer<typeof reportRenderInputSchema>;

const REPORT_TEMPLATE_BYTES = readFileSync(new URL('../../../scripts/fixtures/gate0.2a/report-template-v1.md', import.meta.url));
const REPORT_TEMPLATE_TEXT = REPORT_TEMPLATE_BYTES.toString('utf8');

if (REPORT_TEMPLATE_BYTES.byteLength !== 326 || sha256Text(REPORT_TEMPLATE_TEXT) !== REPORT_TEMPLATE_SHA256) {
  throw new Error('Gate 0.2A report template identity does not match its pinned contract');
}

export function renderReport(input: ReportRenderInput): Uint8Array {
  const parsed = reportRenderInputSchema.parse(input);
  const values: Readonly<Record<string, string>> = {
    taskId: parsed.taskId,
    workflowVersionId: parsed.workflowVersionId,
    workflowHash: parsed.workflowHash,
    documentSnapshotId: parsed.documentSnapshotId,
    contentSha256: parsed.contentSha256,
    claimText: parsed.claimText,
    startByte: String(parsed.startByte),
    endByteExclusive: String(parsed.endByteExclusive),
    excerptSha256: parsed.excerptSha256,
  };
  let rendered = REPORT_TEMPLATE_TEXT;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`{{${key}}}`, value);
  if (/\{\{[^}]+\}\}/u.test(rendered) || !rendered.endsWith('\n') || rendered.endsWith('\n\n')) {
    throw new GenewayError('REPORT_TEMPLATE_INVALID', 'The report template did not render deterministically', 500);
  }
  return new TextEncoder().encode(rendered);
}

export function extractVerifiedDocumentEvidence(input: Readonly<{
  rawBytes: Uint8Array;
  snapshotSha256: string;
  startByte: number;
  endByteExclusive: number;
}>): Readonly<{ excerpt: string; excerptBytes: Uint8Array; excerptSha256: string }> {
  if (sha256TextBytes(input.rawBytes) !== input.snapshotSha256) {
    throw new GenewayError('EVIDENCE_SNAPSHOT_HASH_MISMATCH', 'Evidence source bytes do not match the frozen snapshot', 409);
  }
  if (!Number.isSafeInteger(input.startByte) || !Number.isSafeInteger(input.endByteExclusive)
    || input.startByte < 0 || input.endByteExclusive <= input.startByte || input.endByteExclusive > input.rawBytes.byteLength) {
    throw new GenewayError('EVIDENCE_BYTE_RANGE_INVALID', 'Evidence byte range is outside the frozen snapshot', 422);
  }
  const excerptBytes = input.rawBytes.slice(input.startByte, input.endByteExclusive);
  let excerpt: string;
  try {
    excerpt = new TextDecoder('utf-8', { fatal: true }).decode(excerptBytes);
  } catch {
    throw new GenewayError('EVIDENCE_UTF8_BOUNDARY_INVALID', 'Evidence byte range cuts through invalid UTF-8', 422);
  }
  return { excerpt, excerptBytes, excerptSha256: sha256TextBytes(excerptBytes) };
}

export const sha256TextBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
