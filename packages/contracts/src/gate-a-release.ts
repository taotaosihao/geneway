import { z } from 'zod';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const parserImageSchema = z.string().regex(/^geneway-document-parser:[a-f0-9]{16}$/u);
const idSchema = z.string().min(1).max(500);

export const gateAParserStartupApprovalSchema = z.object({
  schemaVersion: z.literal('gate-a-parser-startup-approval/2'),
  runId: runIdSchema,
  image: parserImageSchema,
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  imageSourceDigest: digestSchema,
  executableDigest: digestSchema,
  packageDigest: digestSchema,
  runtimeClosureDigest: digestSchema,
  dependencyInventoryDigest: digestSchema,
  formatManifestDigests: z.object({ txt: digestSchema, pdf: digestSchema, docx: digestSchema }).strict(),
  approvedBy: z.string().min(1).max(256),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((approval, context) => {
  if (approval.image !== `geneway-document-parser:${approval.imageSourceDigest.slice(0, 16)}`) {
    context.addIssue({
      code: 'custom',
      path: ['image'],
      message: 'parser image tag must be derived from the approved source digest',
    });
  }
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (approvedAt > Date.now() || approvedAt > expiresAt || expiresAt <= Date.now()) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'parser startup approval is expired or invalid' });
  }
});

export const gateAProviderReadinessEvidenceSchema = z.object({
  schemaVersion: z.literal('gate-a-provider-readiness/1'),
  kind: z.literal('gate-a-provider-readiness'),
  runId: runIdSchema,
  providerManifestDigest: digestSchema,
  conformanceDigest: digestSchema,
  routeProfile: z.literal('codex_subscription_dev'),
  logicalModelPolicy: z.literal('business.solution.analysis.standard'),
  providerModel: z.string().min(1).max(200),
  conformancePassedAt: z.string().datetime(),
  conformanceDeadline: z.string().datetime(),
  conformanceExpiresAt: z.string().datetime(),
  credentialBoundary: z.literal('manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1'),
}).strict().superRefine((evidence, context) => {
  const passedAt = Date.parse(evidence.conformancePassedAt);
  const deadline = Date.parse(evidence.conformanceDeadline);
  const expiresAt = Date.parse(evidence.conformanceExpiresAt);
  if (passedAt > Date.now() || passedAt > deadline || deadline > expiresAt || expiresAt <= Date.now()) {
    context.addIssue({
      code: 'custom',
      path: ['conformanceExpiresAt'],
      message: 'Gate A provider readiness evidence is expired or temporally invalid',
    });
  }
});

export const gateALiveValidationCandidateEvidenceSchema = z.object({
  schemaVersion: z.literal('gate-a-live-validation-candidate/1'),
  kind: z.literal('gate-a-live-validation-candidate'),
  runId: runIdSchema,
  capabilityId: z.literal('solution.analysis.v1'),
  capabilityVersionId: z.literal('cap_solution_analysis_v1_live_1'),
  harnessVersionId: z.literal('harness_solution_analysis_v1_live_1'),
  promptPolicyVersionId: z.literal('xiaowei.solution-analysis.system/1'),
  workflow: z.object({
    templateId: z.literal('workflow-template.solution-live/1'),
    registryDigest: digestSchema,
    workflowVersionId: idSchema,
    workflowHash: digestSchema,
  }).strict(),
  parsers: z.object({ txt: z.object({
    image: parserImageSchema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    imageSourceDigest: digestSchema,
    executableDigest: digestSchema,
    packageDigest: digestSchema,
    runtimeClosureDigest: digestSchema,
    dependencyInventoryDigest: digestSchema,
    approvalDigest: digestSchema,
    manifestId: idSchema,
    manifestDigest: digestSchema,
    expiresAt: z.string().datetime(),
    mediaType: z.literal('text/plain'),
    extractionVersion: z.literal('canonical-text/plain-utf8/1'),
  }).strict(), pdf: z.object({
    image: parserImageSchema, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), imageSourceDigest: digestSchema,
    executableDigest: digestSchema, packageDigest: digestSchema, runtimeClosureDigest: digestSchema,
    dependencyInventoryDigest: digestSchema, approvalDigest: digestSchema, manifestId: idSchema,
    manifestDigest: digestSchema, expiresAt: z.string().datetime(), mediaType: z.literal('application/pdf'),
    extractionVersion: z.literal('canonical-text/pdf-pages-utf8/1'),
  }).strict(), docx: z.object({
    image: parserImageSchema, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), imageSourceDigest: digestSchema,
    executableDigest: digestSchema, packageDigest: digestSchema, runtimeClosureDigest: digestSchema,
    dependencyInventoryDigest: digestSchema, approvalDigest: digestSchema, manifestId: idSchema,
    manifestDigest: digestSchema, expiresAt: z.string().datetime(),
    mediaType: z.literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    extractionVersion: z.literal('canonical-text/docx-pages-utf8/1'),
  }).strict() }).strict(),
  dataRoute: z.object({
    mediaTypes: z.tuple([z.literal('text/plain'), z.literal('application/pdf'),
      z.literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document')]),
    dataClasses: z.tuple([z.literal('C0'), z.literal('C1')]),
    maxCanonicalInputBytes: z.literal(262_144),
    extractionVersions: z.object({ txt: z.literal('canonical-text/plain-utf8/1'),
      pdf: z.literal('canonical-text/pdf-pages-utf8/1'), docx: z.literal('canonical-text/docx-pages-utf8/1') }).strict(),
    policyDigest: digestSchema,
  }).strict(),
  modelRoute: z.object({
    providerManifestDigest: digestSchema,
    conformanceDigest: digestSchema,
    shadowEvidenceDigest: digestSchema,
    routeProfile: z.literal('codex_subscription_dev'),
    logicalModelPolicy: z.literal('business.solution.analysis.standard'),
    toolChoice: z.literal('none'),
    outputSchemaVersion: z.literal('analysis-result/1'),
  }).strict(),
  servedHarness: z.object({
    devUpDigest: digestSchema,
    runE2eDigest: digestSchema,
    playwrightConfigDigest: digestSchema,
    releaseHelperDigest: digestSchema,
    e2eSpecDigest: digestSchema,
  }).strict(),
  purpose: z.literal('temporarily open only the disposable Gate A.1 real-material validation route'),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((evidence, context) => {
  const issuedAt = Date.parse(evidence.issuedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const parserExpiresAt = Math.min(...Object.values(evidence.parsers).map((parser) => Date.parse(parser.expiresAt)));
  if (issuedAt > Date.now() || issuedAt > expiresAt || expiresAt <= Date.now() || expiresAt > parserExpiresAt) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Gate A live candidate is expired or outlives its parser authority',
    });
  }
});

export type GateAParserStartupApproval = z.infer<typeof gateAParserStartupApprovalSchema>;
export type GateAProviderReadinessEvidence = z.infer<typeof gateAProviderReadinessEvidenceSchema>;
export type GateALiveValidationCandidateEvidence = z.infer<typeof gateALiveValidationCandidateEvidenceSchema>;

export const gateALiveAuthorityJsonSchemas = Object.freeze({
  ParserStartupApproval: z.toJSONSchema(gateAParserStartupApprovalSchema),
  ProviderReadinessEvidence: z.toJSONSchema(gateAProviderReadinessEvidenceSchema),
  LiveValidationCandidateEvidence: z.toJSONSchema(gateALiveValidationCandidateEvidenceSchema),
});
