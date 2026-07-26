import { describe, expect, it } from 'vitest';
import {
  gateALiveAuthorityJsonSchemas,
  gateALiveValidationCandidateEvidenceSchema,
  gateA2LiveValidationCandidateEvidenceSchema,
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

  it('adds an A.2-only candidate bound to the exact registry, workflow and equal ceilings', () => {
    const a2 = gateA2LiveValidationCandidateEvidenceSchema.parse({
      ...candidate,
      schemaVersion: 'gate-a-live-validation-candidate/2',
      capabilityVersionId: 'cap_solution_analysis_v1_live_2',
      harnessVersionId: 'harness_solution_analysis_v1_live_2',
      promptPolicyVersionId: 'xiaowei.solution-analysis.system/2',
      workflow: {
        templateId: 'workflow-template.solution-live/2',
        registryDigest: '8bd18c5c953f696a590cfdccf16fc42abe5c98394f1ef40dc5023a5071aad1b6',
        workflowVersionId: 'workflow_a0c85227b3aa484622384b5a',
        workflowHash: 'a0c85227b3aa484622384b5a1e550a1b027b29df9543af1820b735e58e7d68e5',
      },
      expertCatalogVersionId: 'expert_catalog_solution_live_2',
      expertCatalogVersion: 3,
      expertCatalogDigest: '121420aa044cfe05999b63027e4c83dcd5623b463655521042c62993c26f1237',
      availableExpertModes: ['auto', 'expert', 'team'],
      equalPermissionCeilingDigest: 'ed68706e8a9af0b5ca760a3c0f15afa395a86b6fc6c1f6ced52aa7ec8390c2e1',
      purpose: 'temporarily open only the disposable Gate A.2 three-ExpertTarget internal validation route',
    });
    expect(a2.availableExpertModes).toEqual(['auto', 'expert', 'team']);
    expect(gateA2LiveValidationCandidateEvidenceSchema.safeParse({
      ...a2, availableExpertModes: ['auto', 'team', 'expert'],
    }).success).toBe(false);
    expect(gateA2LiveValidationCandidateEvidenceSchema.safeParse({
      ...a2, purpose: candidate.purpose,
    }).success).toBe(false);
  });

  it('exports secret-free JSON schemas', () => {
    const wire = JSON.stringify(gateALiveAuthorityJsonSchemas);
    expect(wire).not.toMatch(/authFile|serviceToken|credentialPath|providerRaw|reasoning/iu);
  });
});
