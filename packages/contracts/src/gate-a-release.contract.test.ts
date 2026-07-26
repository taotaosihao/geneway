import { describe, expect, it } from 'vitest';
import {
  gateALiveAuthorityJsonSchemas,
  gateALiveValidationCandidateEvidenceSchema,
  gateAParserStartupApprovalSchema,
  gateAProviderReadinessEvidenceSchema,
} from './gate-a-release.js';

const digest = (character: string): string => character.repeat(64);
const expiresAt = '2099-01-01T00:00:00.000Z';
const imageSourceDigest = digest('a');
const parserApproval = {
  schemaVersion: 'gate-a-parser-startup-approval/2',
  runId: 'gate-a-run-1',
  image: `geneway-document-parser:${imageSourceDigest.slice(0, 16)}`,
  imageId: `sha256:${digest('1')}`,
  imageSourceDigest,
  executableDigest: digest('2'),
  packageDigest: digest('b'),
  runtimeClosureDigest: digest('3'),
  dependencyInventoryDigest: digest('4'),
  formatManifestDigests: { txt: digest('5'), pdf: digest('6'), docx: digest('7') },
  approvedBy: 'user@source-thread:test',
  approvedAt: '2026-07-26T00:00:00.000Z',
  expiresAt,
} as const;

const readiness = {
  schemaVersion: 'gate-a-provider-readiness/1',
  kind: 'gate-a-provider-readiness',
  runId: 'gate-a-run-1',
  providerManifestDigest: digest('c'),
  conformanceDigest: digest('d'),
  routeProfile: 'codex_subscription_dev',
  logicalModelPolicy: 'business.solution.analysis.standard',
  providerModel: 'approved-provider-model',
  conformancePassedAt: '2026-07-26T00:00:00.000Z',
  conformanceDeadline: '2026-07-26T00:05:00.000Z',
  conformanceExpiresAt: expiresAt,
  credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1',
} as const;

const candidate = {
  schemaVersion: 'gate-a-live-validation-candidate/1',
  kind: 'gate-a-live-validation-candidate',
  runId: 'gate-a-run-1',
  capabilityId: 'solution.analysis.v1',
  capabilityVersionId: 'cap_solution_analysis_v1_live_1',
  harnessVersionId: 'harness_solution_analysis_v1_live_1',
  promptPolicyVersionId: 'xiaowei.solution-analysis.system/1',
  workflow: {
    templateId: 'workflow-template.solution-live/1',
    registryDigest: digest('e'),
    workflowVersionId: 'workflow-solution-live',
    workflowHash: digest('f'),
  },
  parsers: { txt: {
    image: parserApproval.image,
    imageId: parserApproval.imageId,
    imageSourceDigest,
    executableDigest: parserApproval.executableDigest,
    packageDigest: parserApproval.packageDigest,
    runtimeClosureDigest: parserApproval.runtimeClosureDigest,
    dependencyInventoryDigest: parserApproval.dependencyInventoryDigest,
    approvalDigest: digest('2'),
    manifestId: 'parser-document-txt-live',
    manifestDigest: parserApproval.formatManifestDigests.txt,
    expiresAt,
    mediaType: 'text/plain', extractionVersion: 'canonical-text/plain-utf8/1',
  }, pdf: {
    image: parserApproval.image, imageId: parserApproval.imageId, imageSourceDigest,
    executableDigest: parserApproval.executableDigest, packageDigest: parserApproval.packageDigest,
    runtimeClosureDigest: parserApproval.runtimeClosureDigest,
    dependencyInventoryDigest: parserApproval.dependencyInventoryDigest, approvalDigest: digest('2'),
    manifestId: 'parser-document-pdf-live', manifestDigest: parserApproval.formatManifestDigests.pdf,
    expiresAt, mediaType: 'application/pdf', extractionVersion: 'canonical-text/pdf-pages-utf8/1',
  }, docx: {
    image: parserApproval.image, imageId: parserApproval.imageId, imageSourceDigest,
    executableDigest: parserApproval.executableDigest, packageDigest: parserApproval.packageDigest,
    runtimeClosureDigest: parserApproval.runtimeClosureDigest,
    dependencyInventoryDigest: parserApproval.dependencyInventoryDigest, approvalDigest: digest('2'),
    manifestId: 'parser-document-docx-live', manifestDigest: parserApproval.formatManifestDigests.docx,
    expiresAt, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extractionVersion: 'canonical-text/docx-pages-utf8/1',
  } },
  dataRoute: {
    mediaTypes: ['text/plain', 'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    dataClasses: ['C0', 'C1'],
    maxCanonicalInputBytes: 262_144,
    extractionVersions: { txt: 'canonical-text/plain-utf8/1', pdf: 'canonical-text/pdf-pages-utf8/1',
      docx: 'canonical-text/docx-pages-utf8/1' },
    policyDigest: digest('4'),
  },
  modelRoute: {
    providerManifestDigest: readiness.providerManifestDigest,
    conformanceDigest: readiness.conformanceDigest,
    shadowEvidenceDigest: digest('5'),
    routeProfile: 'codex_subscription_dev',
    logicalModelPolicy: 'business.solution.analysis.standard',
    toolChoice: 'none',
    outputSchemaVersion: 'analysis-result/1',
  },
  servedHarness: {
    devUpDigest: digest('6'),
    runE2eDigest: digest('7'),
    playwrightConfigDigest: digest('8'),
    releaseHelperDigest: digest('9'),
    e2eSpecDigest: digest('0'),
  },
  purpose: 'temporarily open only the disposable Gate A.1 real-material validation route',
  issuedAt: '2026-07-26T00:10:00.000Z',
  expiresAt,
} as const;

describe('Gate A live authority contracts', () => {
  it('binds parser startup approval to the source-derived image tag and run', () => {
    expect(gateAParserStartupApprovalSchema.parse(parserApproval).runId).toBe('gate-a-run-1');
    expect(gateAParserStartupApprovalSchema.safeParse({
      ...parserApproval,
      image: 'geneway-plain-text-parser:ffffffffffffffff',
    }).success).toBe(false);
  });

  it('keeps provider readiness specific to the Gate A model route', () => {
    expect(gateAProviderReadinessEvidenceSchema.parse(readiness).logicalModelPolicy)
      .toBe('business.solution.analysis.standard');
    expect(gateAProviderReadinessEvidenceSchema.safeParse({
      ...readiness,
      logicalModelPolicy: 'general.chat.standard',
    }).success).toBe(false);
  });

  it('binds a live candidate to workflow, parser, data, model and served harness identities', () => {
    expect(gateALiveValidationCandidateEvidenceSchema.parse(candidate).dataRoute.maxCanonicalInputBytes)
      .toBe(262_144);
    expect(gateALiveValidationCandidateEvidenceSchema.safeParse({
      ...candidate,
      modelRoute: { ...candidate.modelRoute, toolChoice: 'auto' },
    }).success).toBe(false);
  });

  it('exports secret-free JSON schemas', () => {
    const wire = JSON.stringify(gateALiveAuthorityJsonSchemas);
    expect(wire).not.toMatch(/authFile|serviceToken|credentialPath|providerRaw|reasoning/iu);
  });
});
