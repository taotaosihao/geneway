import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import {
  canonicalizeGateA3Jcs,
  canonicalizeGateAProjection,
  digestGateAParserManifest,
  gateA2LiveValidationCandidateEvidenceSchema,
  gateAAnalysisGatewayReceiptSchema,
  gateALiveValidationCandidateEvidenceSchema,
  gateAParserManifestSchema,
  gateAParserStartupApprovalSchema,
  gateAProviderReadinessEvidenceSchema,
  type GateAAnalysisWorkerClaim,
} from '@geneway/contracts';
import {
  SOLUTION_LIVE_TEMPLATE,
  SOLUTION_LIVE_V2_TEMPLATE,
  compileTemplateWorkflow,
} from '@geneway/workflow';
import { ControlPlaneRepository } from './repository.js';
import { GateALiveRepository } from './gate-a-live-repository.js';
import {
  GateA3WorkOrderRepository,
  type GateA3Authority,
} from './gate-a3-work-order-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required for the Gate A.4 release-isolation integration test');
}

const tenantId = 'tenant_local';
const principal = { tenantId, userId: 'user_local', trust: 'trusted-local' } as const;
const materialRunId = 'gate-a4-release-isolation';
const materialInvocationSecret = 'gate-a4-material-invocation-secret-at-least-32-bytes';
const control = new ControlPlaneRepository(databaseUrl, 'gate-a4-cursor-secret-at-least-32-bytes');
const materialRepository = new GateALiveRepository(
  control.pool,
  materialInvocationSecret,
  materialRunId,
);

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): string => hash(canonicalize(value));
const gateA3Digest = (value: unknown): string => createHash('sha256')
  .update(canonicalizeGateA3Jcs(value), 'utf8').digest('hex');

const initialAuthorityBody = {
  schemaVersion: 'gate-a3-authority-envelope/1' as const,
  capabilityId: 'production.work-order-status.v1' as const,
  environmentClass: 'isolated-local-development' as const,
  productionAuthority: false as const,
  artifactId: 'gate-a4-work-order-authority',
  approvedPreflightDigest: 'a'.repeat(64),
  preflightControllerAdmissionDigest: 'c'.repeat(64),
  internalValidationAdmissionDigest: 'b'.repeat(64),
  renewalOfInternalAdmissionDigest: null,
  gearjobCommit: 'd'.repeat(40),
  runtimeAuthorityDigest: '1'.repeat(64),
  dynamicAuthorityDigest: '2'.repeat(64),
  runtimeImageId: `sha256:${'3'.repeat(64)}`,
  connectorProfileVersion: 'gearjob-work-order-status-dev/1' as const,
  endpointMethodAllowlistDigest: 'b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5' as const,
  fieldMaskVersion: 'gearjob-work-order-status-nine-fields/1' as const,
  fieldMaskDigest: 'ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11' as const,
  invocationTokenSchemaVersion: 'connector-invocation-token/1' as const,
  responseSchemaVersion: 'connector-work-order-response/1' as const,
  cardSchemaVersion: 'WorkOrderStatusCard/1' as const,
  effectiveAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
};

function authorityFor(
  body: Omit<typeof initialAuthorityBody, 'renewalOfInternalAdmissionDigest'>
    & Readonly<{ renewalOfInternalAdmissionDigest: string | null }>,
): GateA3Authority {
  return {
    envelope: { ...body, authorityDigest: gateA3Digest(body) },
    validationRunId: 'gate-a4-release-isolation',
    connectorGatewayServiceToken: 'gate-a4-connector-service-token-at-least-32-bytes',
    connectorInvocationTokenSecret: 'gate-a4-connector-invocation-secret-at-least-32-bytes',
    connectorGatewayReceiptSecret: 'gate-a4-connector-receipt-secret-at-least-32-bytes',
    modelInvocationTokenSecret: 'gate-a4-model-invocation-secret-at-least-32-bytes',
    modelGatewayReceiptSecret: 'gate-a4-model-receipt-secret-at-least-32-bytes',
    assertRuntimeAuthority: () => Promise.resolve(),
  };
}

const initialAuthority = authorityFor(initialAuthorityBody);
const workOrderRepository = new GateA3WorkOrderRepository(control.pool, initialAuthority);

type ReleaseSnapshot = Readonly<{
  pointer: Readonly<{
    capability_id: string;
    release_id: string;
    pointer_version: string;
    capability_version_id: string;
    state: string;
  }>;
  records: readonly Readonly<{
    id: string;
    capability_version_id: string;
    state: string;
    sequence: string;
    previous_release_id: string | null;
    gate_evidence_digest: string;
  }>[];
}>;

async function releaseSnapshot(capabilityId: string): Promise<ReleaseSnapshot> {
  const pointer = await control.pool.query<ReleaseSnapshot['pointer']>(`SELECT active.capability_id,
    active.release_id,active.pointer_version::text,release.capability_version_id,release.state
    FROM capability_active_releases active
    JOIN capability_release_records release
      ON release.tenant_id=active.tenant_id AND release.id=active.release_id
    WHERE active.tenant_id=$1 AND active.capability_id=$2`, [tenantId, capabilityId]);
  const selected = pointer.rows[0];
  if (selected === undefined || pointer.rowCount !== 1) {
    throw new Error(`missing active release pointer for ${capabilityId}`);
  }
  const records = await control.pool.query<ReleaseSnapshot['records'][number]>(`SELECT release.id,
    release.capability_version_id,release.state,release.sequence::text,release.previous_release_id,
    release.gate_evidence_digest
    FROM capability_release_records release
    JOIN capability_versions capability
      ON capability.tenant_id=release.tenant_id AND capability.id=release.capability_version_id
    WHERE release.tenant_id=$1 AND capability.capability_id=$2
    ORDER BY capability.version,release.sequence,release.id`, [tenantId, capabilityId]);
  return { pointer: selected, records: records.rows };
}

async function seedMaterialDocument(): Promise<void> {
  const bytes = Buffer.from('需求：内部测试材料必须保持可追溯，并只允许生成只读建议。', 'utf8');
  const contentHash = hash(bytes);
  const canonicalPageIndex = {
    schemaVersion: 'canonical-page-index/1',
    format: 'txt',
    mediaType: 'text/plain',
    extractionVersion: 'canonical-text/plain-utf8/1',
    canonicalTextSha256: contentHash,
    canonicalByteLength: bytes.byteLength,
    pageCount: 1,
    pages: [{
      pageIndex: 0,
      canonicalStartByte: 0,
      canonicalEndByteExclusive: bytes.byteLength,
      canonicalPageSha256: contentHash,
    }],
  } as const;
  const imageId = `sha256:${hash('gate-a4-parser-image-id')}` as const;
  const imageSourceDigest = hash('gate-a4-parser-image-source');
  const runtimeClosureDigest = hash('gate-a4-parser-runtime-closure');
  const dependencyNames = ['node', 'libc6', 'libstdc++6', 'libgcc-s1', 'pdfjs-dist'] as const;
  const unsignedParserManifest = {
    schemaVersion: 'parser-manifest.gate-a/2' as const,
    id: 'parser_plain_text_live_1',
    format: 'txt' as const,
    mediaType: 'text/plain' as const,
    extractionVersion: 'canonical-text/plain-utf8/1' as const,
    parser: {
      name: 'geneway-document-parser' as const,
      version: '1.0.0-candidate.1' as const,
      registrySource: 'geneway-workspace' as const,
      upstreamSource: 'geneway://packages/ingestion/document-parser' as const,
      lockResolution: `docker-image:${imageId}`,
      lockIntegrity: hash('gate-a4-parser-lock'),
      imageDigest: imageId,
      executableDigest: hash('gate-a4-parser-executable'),
      packageDigest: hash('gate-a4-parser-package'),
      license: 'UNLICENSED-internal' as const,
    },
    runtimeClosureDigest,
    dependencies: dependencyNames.map((name) => ({
      name,
      version: '1',
      registrySource: 'test',
      upstreamSource: 'test',
      lockResolution: `${name}@1`,
      lockIntegrity: name === 'pdfjs-dist' ? 'sha512-test' : hash(`gate-a4-lock-${name}`),
      imageDigest: imageId,
      actualFiles: [{ path: `/test/${name}`, sha256: hash(`gate-a4-file-${name}`) }],
      packageDigest: hash(`gate-a4-package-${name}`),
      license: 'test',
    })),
    conversionConfig: {
      inputFormat: 'txt' as const,
      outputEncoding: 'UTF-8' as const,
      unicodeNormalization: 'none' as const,
      newlineNormalization: 'none' as const,
      pageIndexSchemaVersion: 'canonical-page-index/1' as const,
      maxInputBytes: 8_388_608 as const,
      maxOutputBytes: 2_097_152 as const,
      maxPages: 256 as const,
      maxZipEntries: 2_048 as const,
      maxZipEntryBytes: 4_194_304 as const,
      maxExpansionRatio: 40 as const,
      maxNestingDepth: 64 as const,
    },
    resourceLimitsVersion: 'gate-a-document-parser-limits-candidate/1' as const,
    approvedBy: 'user_local',
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    approvedImage: `geneway-document-parser:${imageSourceDigest.slice(0, 16)}`,
    approvedImageId: imageId,
    approvedImageSourceDigest: imageSourceDigest,
    approvedPackageDigest: hash('gate-a4-parser-package'),
    approvedRuntimeClosureDigest: runtimeClosureDigest,
  };
  const parserManifest = gateAParserManifestSchema.parse({
    ...unsignedParserManifest,
    manifestDigest: await digestGateAParserManifest(unsignedParserManifest),
  });
  const audience = { kind: 'private-conversation', conversationId: 'conversation_gate_a4_material' };
  await control.pool.query(`INSERT INTO conversations(tenant_id,id,user_id)
    VALUES ($1,'conversation_gate_a4_material',$2)`, [tenantId, principal.userId]);
  await control.pool.query(`INSERT INTO artifacts
    (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,
     root_artifact_id,data_class,audience,resource_scope)
    VALUES ($1,'artifact_gate_a4_material','conversation_gate_a4_material',$2,'source_document',
     'gate-a4.txt','text/plain',$3,$4,'artifact_gate_a4_material','C1',$5,'artifact:artifact_gate_a4_material')`,
  [tenantId, principal.userId, bytes.byteLength, contentHash, audience]);
  await control.pool.query(`INSERT INTO artifact_manifests
    (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,
     retention_policy)
    VALUES ($1,'manifest_gate_a4_material','artifact_gate_a4_material','test','gate-a4.txt','gate-a4.txt',
     'text/plain',$2,$3,'gate0.2a-internal/v1')`, [tenantId, bytes.byteLength, contentHash]);
  await control.pool.query(`INSERT INTO artifact_states
    (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status)
    VALUES ($1,'artifact_gate_a4_material','active','verified','active',now()+interval '1 hour','in_sync')`,
  [tenantId]);
  await control.pool.query(`INSERT INTO document_snapshots
    (tenant_id,id,conversation_id,artifact_id,manifest_id,display_name,media_type,size_bytes,content_sha256,
     data_class,audience,resource_scope,trust,simulation_profile,profile_registry_version,created_by)
    VALUES ($1,'snapshot_gate_a4_material','conversation_gate_a4_material','artifact_gate_a4_material',
     'manifest_gate_a4_material','gate-a4.txt','text/plain',$2,$3,'C1',$4,
     'artifact:artifact_gate_a4_material','untrusted_text',NULL,'gate0.2a-profile-registry/1',$5)`,
  [tenantId, bytes.byteLength, contentHash, audience, principal.userId]);
  await control.pool.query(`INSERT INTO parser_manifests
    (tenant_id,id,schema_version,media_type,parser_name,parser_version,executable_digest,package_digest,
     manifest_digest,registry_source,upstream_source,lock_resolution,lock_integrity,license,dependencies,
     conversion_config,canonical_manifest,approved_by,approved_at,expires_at)
    VALUES ($1,'parser_plain_text_live_1','parser-manifest.gate-a/2','text/plain','geneway-document-parser',
     '1.0.0-candidate.1',$2,$3,$4,'geneway-workspace','geneway://packages/ingestion/document-parser',
     $5,$6,'UNLICENSED-internal',$7,$8,$9,$10,$11,$12)`, [
    tenantId,
    parserManifest.parser.executableDigest,
    parserManifest.parser.packageDigest,
    parserManifest.manifestDigest,
    parserManifest.parser.lockResolution,
    parserManifest.parser.lockIntegrity,
    JSON.stringify(parserManifest.dependencies),
    parserManifest.conversionConfig,
    parserManifest,
    parserManifest.approvedBy,
    parserManifest.approvedAt,
    parserManifest.expiresAt,
  ]);
  await control.pool.query(`INSERT INTO document_snapshot_canonical_representations
    (tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,canonical_bytes,
     canonical_text_sha256,canonical_page_index,canonical_page_index_sha256,resource_limits_version)
    VALUES ($1,'snapshot_gate_a4_material','parser_plain_text_live_1',$2,'canonical-text/plain-utf8/1',
     $3,$4,$5,$6,'gate-a-document-parser-limits-candidate/1')`, [
    tenantId,
    parserManifest.manifestDigest,
    bytes,
    contentHash,
    canonicalPageIndex,
    digest(canonicalPageIndex),
  ]);
}

async function openMaterialRelease(): Promise<void> {
  const parser = gateAParserManifestSchema.parse((await control.pool.query<{ canonical_manifest: unknown }>(
    `SELECT canonical_manifest FROM parser_manifests WHERE tenant_id=$1 AND id='parser_plain_text_live_1'`,
    [tenantId],
  )).rows[0]?.canonical_manifest);
  const workflowV1 = compileTemplateWorkflow({
    schemaVersion: 'workflow-draft.template-v1',
    templateId: SOLUTION_LIVE_TEMPLATE.templateId,
    registryDigest: SOLUTION_LIVE_TEMPLATE.registryDigest,
  });
  const workflowV2 = compileTemplateWorkflow({
    schemaVersion: 'workflow-draft.template-v1',
    templateId: SOLUTION_LIVE_V2_TEMPLATE.templateId,
    registryDigest: SOLUTION_LIVE_V2_TEMPLATE.registryDigest,
  });
  const now = Date.now();
  const shadow = gateAProviderReadinessEvidenceSchema.parse({
    schemaVersion: 'gate-a-provider-readiness/1',
    kind: 'gate-a-provider-readiness',
    runId: materialRunId,
    providerManifestDigest: hash('gate-a4-provider-manifest'),
    conformanceDigest: hash('gate-a4-provider-conformance'),
    routeProfile: 'codex_subscription_dev',
    logicalModelPolicy: 'business.solution.analysis.standard',
    providerModel: 'test-model',
    conformancePassedAt: new Date(now - 60_000).toISOString(),
    conformanceDeadline: new Date(now + 60_000).toISOString(),
    conformanceExpiresAt: new Date(now + 30 * 60_000).toISOString(),
    credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1',
  });
  const shadowDigest = digest(shadow);
  const parserApproval = gateAParserStartupApprovalSchema.parse({
    schemaVersion: 'gate-a-parser-startup-approval/2',
    runId: materialRunId,
    image: `geneway-document-parser:${hash('gate-a4-parser-image-source').slice(0, 16)}`,
    imageId: `sha256:${hash('gate-a4-parser-image-id')}`,
    imageSourceDigest: hash('gate-a4-parser-image-source'),
    executableDigest: parser.parser.executableDigest,
    packageDigest: parser.parser.packageDigest,
    runtimeClosureDigest: hash('gate-a4-parser-runtime-closure'),
    dependencyInventoryDigest: digest(parser.dependencies),
    formatManifestDigests: {
      txt: parser.manifestDigest,
      pdf: hash('gate-a4-pdf-manifest'),
      docx: hash('gate-a4-docx-manifest'),
    },
    approvedBy: parser.approvedBy,
    approvedAt: parser.approvedAt,
    expiresAt: parser.expiresAt,
  });
  const parserAuthority = (format: 'txt' | 'pdf' | 'docx') => ({
    image: parserApproval.image,
    imageId: parserApproval.imageId,
    imageSourceDigest: parserApproval.imageSourceDigest,
    executableDigest: parserApproval.executableDigest,
    packageDigest: parserApproval.packageDigest,
    runtimeClosureDigest: parserApproval.runtimeClosureDigest,
    dependencyInventoryDigest: parserApproval.dependencyInventoryDigest,
    approvalDigest: digest(parserApproval),
    manifestId: format === 'txt' ? parser.id : `parser-${format}`,
    manifestDigest: parserApproval.formatManifestDigests[format],
    expiresAt: parser.expiresAt,
  });
  const dataRoutePolicy = {
    mediaTypes: ['text/plain', 'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    dataClasses: ['C0', 'C1'],
    maxCanonicalInputBytes: 262_144,
    extractionVersions: {
      txt: 'canonical-text/plain-utf8/1',
      pdf: 'canonical-text/pdf-pages-utf8/1',
      docx: 'canonical-text/docx-pages-utf8/1',
    },
  } as const;
  const candidateV1 = gateALiveValidationCandidateEvidenceSchema.parse({
    schemaVersion: 'gate-a-live-validation-candidate/1',
    kind: 'gate-a-live-validation-candidate',
    runId: materialRunId,
    capabilityId: 'solution.analysis.v1',
    capabilityVersionId: 'cap_solution_analysis_v1_live_1',
    harnessVersionId: 'harness_solution_analysis_v1_live_1',
    promptPolicyVersionId: 'xiaowei.solution-analysis.system/1',
    workflow: {
      templateId: SOLUTION_LIVE_TEMPLATE.templateId,
      registryDigest: SOLUTION_LIVE_TEMPLATE.registryDigest,
      workflowVersionId: workflowV1.id,
      workflowHash: workflowV1.hash,
    },
    parsers: {
      txt: { ...parserAuthority('txt'), mediaType: 'text/plain', extractionVersion: 'canonical-text/plain-utf8/1' },
      pdf: { ...parserAuthority('pdf'), mediaType: 'application/pdf', extractionVersion: 'canonical-text/pdf-pages-utf8/1' },
      docx: { ...parserAuthority('docx'),
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractionVersion: 'canonical-text/docx-pages-utf8/1' },
    },
    dataRoute: { ...dataRoutePolicy, policyDigest: digest(dataRoutePolicy) },
    modelRoute: {
      providerManifestDigest: shadow.providerManifestDigest,
      conformanceDigest: shadow.conformanceDigest,
      shadowEvidenceDigest: shadowDigest,
      routeProfile: 'codex_subscription_dev',
      logicalModelPolicy: 'business.solution.analysis.standard',
      toolChoice: 'none',
      outputSchemaVersion: 'analysis-result/1',
    },
    servedHarness: {
      devUpDigest: hash('gate-a4-dev-up'),
      runE2eDigest: hash('gate-a4-run-e2e'),
      playwrightConfigDigest: hash('gate-a4-playwright'),
      releaseHelperDigest: hash('gate-a4-release-helper'),
      e2eSpecDigest: hash('gate-a4-e2e-spec'),
    },
    purpose: 'temporarily open only the disposable Gate A.1 real-material validation route',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
  });
  const candidateV2 = gateA2LiveValidationCandidateEvidenceSchema.parse({
    ...candidateV1,
    schemaVersion: 'gate-a-live-validation-candidate/2',
    capabilityVersionId: 'cap_solution_analysis_v1_live_2',
    harnessVersionId: 'harness_solution_analysis_v1_live_2',
    promptPolicyVersionId: 'xiaowei.solution-analysis.system/2',
    workflow: {
      templateId: SOLUTION_LIVE_V2_TEMPLATE.templateId,
      registryDigest: SOLUTION_LIVE_V2_TEMPLATE.registryDigest,
      workflowVersionId: workflowV2.id,
      workflowHash: workflowV2.hash,
    },
    expertCatalogVersionId: 'expert_catalog_solution_live_2',
    expertCatalogVersion: 3,
    expertCatalogDigest: '121420aa044cfe05999b63027e4c83dcd5623b463655521042c62993c26f1237',
    availableExpertModes: ['auto', 'expert', 'team'],
    equalPermissionCeilingDigest: 'ed68706e8a9af0b5ca760a3c0f15afa395a86b6fc6c1f6ced52aa7ec8390c2e1',
    purpose: 'temporarily open only the disposable Gate A.2 three-ExpertTarget internal validation route',
  });

  await control.pool.query(`INSERT INTO capability_release_records
    (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,previous_release_id,
     actor,gate_evidence,gate_evidence_digest)
    VALUES
      ($1,'release_gate_a4_material_v1_shadow','cap_solution_analysis_v1_live_1',
       'xiaowei.solution-analysis.system/1','shadow',2,'release_solution_analysis_v1_live_draft',
       'gate-a4-test',$2,$3),
      ($1,'release_gate_a4_material_v1_internal','cap_solution_analysis_v1_live_1',
       'xiaowei.solution-analysis.system/1','internal',3,'release_gate_a4_material_v1_shadow',
       'gate-a4-test',$4,$5),
      ($1,'release_gate_a4_material_v2_shadow','cap_solution_analysis_v1_live_2',
       'xiaowei.solution-analysis.system/2','shadow',2,'release_solution_analysis_v1_live_2_draft',
       'gate-a4-test',$2,$3),
      ($1,'release_gate_a4_material_v2_internal','cap_solution_analysis_v1_live_2',
       'xiaowei.solution-analysis.system/2','internal',3,'release_gate_a4_material_v2_shadow',
       'gate-a4-test',$6,$7)`, [
    tenantId,
    shadow,
    shadowDigest,
    candidateV1,
    digest(candidateV1),
    candidateV2,
    digest(candidateV2),
  ]);
  await control.pool.query(`UPDATE capability_active_releases
    SET release_id='release_gate_a4_material_v1_shadow',pointer_version=2
    WHERE tenant_id=$1 AND capability_id='solution.analysis.v1'
      AND release_id='release_solution_analysis_v1_live_draft' AND pointer_version=1`, [tenantId]);
  await control.pool.query(`UPDATE capability_active_releases
    SET release_id='release_gate_a4_material_v1_internal',pointer_version=3
    WHERE tenant_id=$1 AND capability_id='solution.analysis.v1'
      AND release_id='release_gate_a4_material_v1_shadow' AND pointer_version=2`, [tenantId]);
  const activationEvidence = {
    kind: 'gate-a4-independent-material-activation',
    previousActiveReleaseId: 'release_gate_a4_material_v1_internal',
    targetInternalReleaseId: 'release_gate_a4_material_v2_internal',
    candidateDigest: digest(candidateV2),
  };
  const client = await control.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO capability_release_activation_records
      (tenant_id,id,schema_version,capability_id,previous_active_release_id,previous_pointer_version,
       target_internal_release_id,target_pointer_version,actor,gate_evidence,gate_evidence_digest)
      VALUES ($1,'activation_gate_a4_material_v2','capability-release-activation/1',
       'solution.analysis.v1','release_gate_a4_material_v1_internal',3,
       'release_gate_a4_material_v2_internal',4,'gate-a4-test',$2,$3)`, [
      tenantId, activationEvidence, digest(activationEvidence),
    ]);
    const activated = await client.query(`UPDATE capability_active_releases
      SET release_id='release_gate_a4_material_v2_internal',pointer_version=4,
        activation_record_id='activation_gate_a4_material_v2'
      WHERE tenant_id=$1 AND capability_id='solution.analysis.v1'
        AND release_id='release_gate_a4_material_v1_internal' AND pointer_version=3`, [tenantId]);
    if (activated.rowCount !== 1) throw new Error('failed to activate Gate A.4 material release');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const mutationFromClaim = (claim: GateAAnalysisWorkerClaim) => ({
  taskId: claim.taskId,
  workflowVersionId: claim.workflowVersionId,
  workflowHash: claim.workflowHash,
  stepId: claim.stepId,
  executionAttemptId: claim.executionAttemptId,
  stepAttemptId: claim.stepAttemptId,
  taskFence: claim.taskFence,
  stepFence: claim.stepFence,
  modelInvocationId: claim.modelInvocationId,
});

const receiptIdentityFromClaim = (claim: GateAAnalysisWorkerClaim) => ({
  tenantId: claim.tenantId,
  principalId: claim.principalId,
  conversationId: claim.conversationId,
  taskId: claim.taskId,
  workflowVersionId: claim.workflowVersionId,
  workflowHash: claim.workflowHash,
  stepId: claim.stepId,
  agentRegistryReference: claim.agentRegistryReference,
  executionAttemptId: claim.executionAttemptId,
  stepAttemptId: claim.stepAttemptId,
  taskFence: claim.taskFence,
  stepFence: claim.stepFence,
  modelInvocationId: claim.modelInvocationId,
  approvalSubjectDigest: claim.approvalSubjectDigest,
  capabilityVersionId: claim.capabilityVersionId,
  promptPolicyVersionId: claim.promptPolicyVersionId,
  expertTargetDigest: claim.expertTargetDigest,
  documentSnapshotId: claim.documentSnapshotId,
  artifactId: claim.artifactId,
  artifactSha256: claim.artifactSha256,
  canonicalTextSha256: claim.canonicalTextSha256,
  canonicalPageIndexSha256: claim.canonicalPageIndexSha256,
  canonicalSelectionProjectionDigest: claim.canonicalSelectionProjectionDigest,
  selectedModelInputSha256: claim.selectedModelInputSha256,
  parserManifestId: claim.parserManifestId,
  parserDigest: claim.parserDigest,
  extractionVersion: claim.extractionVersion,
  resourceScope: claim.resourceScope,
  materialProjectionDigest: claim.materialProjectionDigest,
  promptPolicyResolvedBytesSha256: claim.promptPolicyResolvedBytesSha256,
  providerInputProjectionDigest: claim.providerInputProjectionDigest,
  priorStepOutputsDigest: claim.priorStepOutputsDigest,
  logicalModelPolicy: claim.logicalModelPolicy,
  routeProfile: claim.routeProfile,
  dataClass: claim.dataClass,
  toolChoice: claim.toolChoice,
  maxInputBytes: claim.maxInputBytes,
  outputSchemaVersion: claim.outputSchemaVersion,
  maxOutputTokens: claim.maxOutputTokens,
  deadline: claim.deadline,
  ...(claim.schemaVersion === 'analysis-worker-claim/2' ? { agentVersionId: claim.agentVersionId } : {}),
});

function completedTerminalFor(claim: GateAAnalysisWorkerClaim) {
  const output = claim.stepId === 'requirement_extract' ? {
    schemaVersion: 'analysis.requirement-candidates/1' as const,
    requirements: [{
      id: 'requirement_1',
      text: 'Traceability is required.',
      evidenceCandidateKeys: ['candidate_1'],
      confidence: 0.98,
    }],
    unknowns: ['The rollout date is not provided.'],
  } : claim.stepId === 'contradiction_check' ? {
    schemaVersion: 'analysis.contradiction/1' as const,
    contradictions: [],
    constraints: ['Traceability must remain read-only.'],
  } : {
    schemaVersion: 'analysis-result/1' as const,
    summary: 'The material requires traceability.',
    statements: [
      { id: 'fact_1', kind: 'fact' as const, text: 'Traceability is required.',
        evidenceCandidateKeys: ['candidate_1'], confidence: 0.98 },
      { id: 'inference_1', kind: 'inference' as const, text: 'Traceability may support review.',
        evidenceCandidateKeys: ['candidate_1'], confidence: 0.8 },
      { id: 'recommendation_1', kind: 'recommendation' as const, text: 'Review the traceability plan.',
        evidenceCandidateKeys: [], confidence: 0.8 },
      { id: 'unknown_1', kind: 'unknown' as const, text: 'The rollout date is not provided.',
        evidenceCandidateKeys: [], confidence: 1 },
    ],
  };
  const payload = {
    schemaVersion: claim.schemaVersion === 'analysis-worker-claim/2'
      ? 'gate-a-analysis-gateway-receipt/2' as const
      : 'gate-a-analysis-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway' as const,
    audience: 'geneway-control-plane' as const,
    receiptJti: randomUUID(),
    ...receiptIdentityFromClaim(claim),
    issuedAt: new Date().toISOString(),
    outcome: 'completed' as const,
    providerRevision: 'gate-a4-provider-test/1',
    modelRevision: 'gate-a4-model-test/1',
    outputPayloadDigest: hash(canonicalizeGateAProjection(output)),
    usage: { inputTokens: 24, outputTokens: 18, totalTokens: 42 },
  };
  return {
    status: 'completed' as const,
    output,
    receipt: gateAAnalysisGatewayReceiptSchema.parse({
      payload,
      signature: createHmac('sha256', materialInvocationSecret)
        .update(canonicalizeGateAProjection(payload), 'utf8').digest('base64url'),
    }),
  };
}

async function completeMaterialTask(): Promise<string> {
  const created = await materialRepository.createLiveTask(principal, {
    conversationId: 'conversation_gate_a4_material',
    documentSnapshotId: 'snapshot_gate_a4_material',
    idempotencyKey: 'gate-a4-material-create',
  });
  await materialRepository.decideLiveApproval(
    principal,
    created.approvalId,
    'approved',
    'gate-a4-material-approve',
  );
  await materialRepository.executeLiveTask(principal, created.taskId, {
    expectedApprovalVersion: 1,
    expectedApprovalSubjectDigest: created.approvalSubjectDigest,
  }, 'gate-a4-material-execute');

  let finalClaim: GateAAnalysisWorkerClaim | null = null;
  for (const expectedStep of ['requirement_extract', 'contradiction_check', 'solution_design'] as const) {
    const claim = await materialRepository.claimAnalysis(`gate-a4-worker-${expectedStep}`, 60_000);
    if (claim === null || claim.taskId !== created.taskId || claim.stepId !== expectedStep) {
      throw new Error(`expected ${expectedStep} claim for the Gate A.4 material task`);
    }
    await materialRepository.markAnalysisStarted(mutationFromClaim(claim));
    await expect(materialRepository.consumeAnalysisInvocationToken(claim.invocationToken)).resolves.toBe(true);
    const publish = await materialRepository.settleAnalysis(
      mutationFromClaim(claim),
      completedTerminalFor(claim),
    );
    expect(publish).toBe(expectedStep === 'solution_design');
    if (expectedStep === 'solution_design') finalClaim = claim;
  }
  if (finalClaim === null) throw new Error('missing final Gate A.4 material claim');
  const mutation = mutationFromClaim(finalClaim);
  const intent = await materialRepository.prepareLiveReport(mutation, 'gate-a4-release-isolation');
  const observedSha256 = hash(intent.bytes);
  expect(observedSha256).toBe(intent.contentSha256);
  expect(intent.bytes.byteLength).toBe(intent.sizeBytes);
  await materialRepository.markLiveReportObjectVerified(intent, `etag-${observedSha256}`);
  await materialRepository.finalizeLiveReport(intent, mutation);
  await expect(materialRepository.getLiveTask(principal, created.taskId))
    .resolves.toMatchObject({ status: 'completed' });
  return created.taskId;
}

describe('Gate A.4 same-database capability release isolation', () => {
  let materialTaskId: string;

  beforeAll(async () => {
    await control.resetForTest();
    await materialRepository.ensureLiveAuthority();
    await seedMaterialDocument();
    await openMaterialRelease();
    await workOrderRepository.seedAuthority();
    await workOrderRepository.promoteAuthority('shadow');
    await workOrderRepository.promoteAuthority('internal');
    materialTaskId = await completeMaterialTask();
  });

  afterAll(async () => control.close());

  it('keeps immutable releases, active pointers, routes, and the completed material terminal isolated', async () => {
    await expect(materialRepository.getCapabilityRoute(principal, true, true)).resolves.toMatchObject({
      capabilityId: 'solution.analysis.v1',
      status: 'internal',
      executionRoute: 'live',
    });
    await expect(workOrderRepository.getCapabilityRoute(principal)).resolves.toMatchObject({
      capabilityId: 'production.work-order-status.v1',
      status: 'internal',
      executionRoute: 'live',
    });

    const materialBaseline = await releaseSnapshot('solution.analysis.v1');
    const workOrderBaseline = await releaseSnapshot('production.work-order-status.v1');
    expect(materialBaseline.pointer.release_id).not.toBe(workOrderBaseline.pointer.release_id);
    expect(materialBaseline.pointer.capability_version_id)
      .not.toBe(workOrderBaseline.pointer.capability_version_id);
    expect(materialBaseline.pointer.pointer_version).toBe('4');
    expect(workOrderBaseline.pointer.pointer_version).toBe('3');
    expect(materialBaseline.pointer.state).toBe('internal');
    expect(workOrderBaseline.pointer.state).toBe('internal');
    expect(new Set(materialBaseline.records.map((record) => record.id)))
      .not.toContain(workOrderBaseline.pointer.release_id);
    expect(new Set(workOrderBaseline.records.map((record) => record.id)))
      .not.toContain(materialBaseline.pointer.release_id);

    await expect(materialRepository.getCapabilityRoute(principal, false, true)).resolves.toMatchObject({
      status: 'NOT_OPEN',
      reason: 'MODEL_ROUTE_UNAVAILABLE',
    });
    await expect(materialRepository.getCapabilityRoute(principal, true, false)).resolves.toMatchObject({
      status: 'NOT_OPEN',
      reason: 'PARSER_AUTHORITY_UNAVAILABLE',
    });
    await expect(workOrderRepository.getCapabilityRoute(principal)).resolves.toMatchObject({
      status: 'internal',
      executionRoute: 'live',
    });
    expect(await releaseSnapshot('production.work-order-status.v1')).toEqual(workOrderBaseline);

    const driftedBody = {
      ...initialAuthorityBody,
      artifactId: 'gate-a4-unadmitted-work-order-authority',
    };
    const driftedRepository = new GateA3WorkOrderRepository(control.pool, authorityFor(driftedBody));
    await expect(driftedRepository.getCapabilityRoute(principal)).resolves.toEqual({
      capabilityId: 'production.work-order-status.v1',
      status: 'NOT_OPEN',
      executionRoute: 'not_open',
    });
    expect(await releaseSnapshot('production.work-order-status.v1')).toEqual(workOrderBaseline);
    expect(await releaseSnapshot('solution.analysis.v1')).toEqual(materialBaseline);
    await expect(materialRepository.getLiveTask(principal, materialTaskId))
      .resolves.toMatchObject({ status: 'completed' });

    const renewalBody = {
      ...initialAuthorityBody,
      artifactId: 'gate-a4-expiring-work-order-authority',
      internalValidationAdmissionDigest: 'e'.repeat(64),
      renewalOfInternalAdmissionDigest: initialAuthority.envelope.internalValidationAdmissionDigest,
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
    };
    const expiringAuthority = authorityFor(renewalBody);
    const expiringRepository = new GateA3WorkOrderRepository(control.pool, expiringAuthority);
    await expiringRepository.activateAuthorityEnvelope();
    await expiringRepository.promoteAuthority('shadow');
    await expiringRepository.promoteAuthority('internal');
    await expect(expiringRepository.getCapabilityRoute(principal)).resolves.toMatchObject({
      status: 'internal',
      executionRoute: 'live',
    });
    expect(await releaseSnapshot('production.work-order-status.v1')).toEqual(workOrderBaseline);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await expect(expiringRepository.getCapabilityRoute(principal)).resolves.toEqual({
      capabilityId: 'production.work-order-status.v1',
      status: 'NOT_OPEN',
      executionRoute: 'not_open',
    });
    expect(await releaseSnapshot('production.work-order-status.v1')).toEqual(workOrderBaseline);
    expect(await releaseSnapshot('solution.analysis.v1')).toEqual(materialBaseline);
    await expect(materialRepository.getCapabilityRoute(principal, true, true)).resolves.toMatchObject({
      status: 'internal',
      executionRoute: 'live',
    });
    await expect(materialRepository.getLiveTask(principal, materialTaskId))
      .resolves.toMatchObject({ status: 'completed' });

    await expiringRepository.revokeAuthority(
      'f'.repeat(64),
      'gate-a4-release-isolation-reviewer',
    );
    await expect(expiringRepository.getCapabilityRoute(principal)).resolves.toEqual({
      capabilityId: 'production.work-order-status.v1',
      status: 'NOT_OPEN',
      executionRoute: 'not_open',
    });
    expect(await releaseSnapshot('production.work-order-status.v1')).toEqual(workOrderBaseline);
    expect(await releaseSnapshot('solution.analysis.v1')).toEqual(materialBaseline);
    await expect(materialRepository.getCapabilityRoute(principal, true, true)).resolves.toMatchObject({
      status: 'internal',
      executionRoute: 'live',
    });
    await expect(materialRepository.getLiveTask(principal, materialTaskId))
      .resolves.toMatchObject({ status: 'completed' });
  }, 30_000);
});
