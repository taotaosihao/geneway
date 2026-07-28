import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
  buildGateAMaterialProjection,
  buildGateAProviderInputProjection,
  canonicalizeGateA3Jcs,
  canonicalizeGateAProjection,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
  gateAAnalysisGatewayReceiptSchema,
  gateAAnalysisInvocationTokenClaimsSchema,
  gateAAnalysisWorkerClaimSchema,
  modelGatewayReceiptSchema,
  type GateA3WorkOrderModelRequest,
  type GateAAnalysisWorkerClaim,
} from '@geneway/contracts';
import {
  MODEL_GATEWAY_WORK_ORDER_READINESS_PATH,
  chunkProviderDelta,
  createModelGateway,
  digestGateA3WorkOrderModelValue,
  mapProviderError,
  redactedProviderFailure,
} from './index.js';
import {
  assertLockfilePackageIntegrity, verifyOwnedPrivateFile, verifyProviderAuthFile, verifyProviderManifest,
} from './provider-manifest.js';

const serviceToken = 'model-gateway-service-token-00000000000000000001';
const invocationSecret = 'model-gateway-invocation-token-000000000000000001';
const workOrderReceiptSecret = 'model-gateway-work-order-receipt-00000000000000001';
const invocationToken = (overrides: Readonly<Record<string, unknown>> = {}) => {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    iss: 'geneway-control-plane',
    aud: 'local-model-gateway',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    conversationId: 'conversation-receipt-test',
    modelInvocationId: 'model-invocation-receipt-test',
    logicalModelPolicy: 'general.chat.standard',
    dataClass: 'C0',
    maxOutputTokens: 128,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    fence: 1,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', invocationSecret).update(encoded, 'utf8').digest('base64url')}`;
};
const streamBody = (token: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  invocationToken: token,
  conversationId: 'conversation-receipt-test',
  modelInvocationId: 'model-invocation-receipt-test',
  fence: 1,
  logicalModelPolicy: 'general.chat.standard',
  promptPolicyVersion: 'xiaowei.chat.system/1',
  systemPrompt: 'test',
  messages: [{ messageId: 'message-test', author: 'user', content: 'hello' }],
  toolChoice: 'none',
  ...overrides,
});

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const digestCanonical = (value: unknown): string => digest(canonicalizeGateAProjection(value));

function sharedSlotAnalysisClaim(modelInvocationId: string): GateAAnalysisWorkerClaim {
  const text = '产线计划数量为 100。';
  const systemPrompt = '只分析材料，区分事实、推断、建议和未知项。';
  const canonicalTextSha256 = digest(text);
  const canonicalTextByteLength = Buffer.byteLength(text, 'utf8');
  const canonicalSelectionProjection = {
    schemaVersion: 'canonical-selection-projection.gate-a/1' as const,
    selectionPolicyVersion: 'canonical-complete-paragraph-concat/1' as const,
    sourceExtractionVersion: 'canonical-text/plain-utf8/1' as const,
    sourceCanonicalTextSha256: canonicalTextSha256,
    sourceCanonicalByteLength: canonicalTextByteLength,
    sourceCanonicalPageIndexSha256: null,
    selectedParagraphs: [{
      sourceParagraphIndex: 0,
      startByte: 0,
      endByteExclusive: canonicalTextByteLength,
      paragraphByteLength: canonicalTextByteLength,
      paragraphBytesSha256: canonicalTextSha256,
      pageSegments: [],
    }],
    selectedTotalBytes: canonicalTextByteLength,
    selectedModelInputSha256: canonicalTextSha256,
    truncated: false,
  };
  const canonicalSelectionProjectionDigest = digestCanonical(canonicalSelectionProjection);
  const inputRef = {
    kind: 'live_document_snapshot' as const,
    recordVariant: 'business-task-input.live-material/1' as const,
    documentSnapshotId: 'document-snapshot-shared-slot',
    artifactId: 'artifact-shared-slot',
    artifactSha256: digest('artifact-shared-slot'),
    mediaType: 'text/plain' as const,
    parserManifestId: 'parser-manifest-shared-slot',
    parserDigest: digest('parser-shared-slot'),
    extractionVersion: 'canonical-text/plain-utf8/1' as const,
    canonicalTextSha256,
    canonicalPageIndexSha256: null,
    canonicalSelectionProjection,
    canonicalSelectionProjectionDigest,
    resourceScope: 'conversation:conversation-analysis-shared-slot',
    dataClass: 'C1' as const,
    audience: 'conversation:conversation-analysis-shared-slot',
    trust: 'untrusted_text' as const,
  };
  const locator = {
    schemaVersion: 'evidence-locator-candidate.live/1' as const,
    candidateKey: 'candidate-shared-slot',
    sourceArtifactId: inputRef.artifactId,
    sourceArtifactSha256: inputRef.artifactSha256,
    documentSnapshotId: inputRef.documentSnapshotId,
    canonicalTextSha256,
    parserManifestId: inputRef.parserManifestId,
    parserDigest: inputRef.parserDigest,
    extractionVersion: inputRef.extractionVersion,
    kind: 'canonical_text_span' as const,
    startByte: 0,
    endByteExclusive: canonicalTextByteLength,
  };
  const untrustedText = {
    schemaVersion: 'untrusted-text/1' as const,
    documentSnapshotId: inputRef.documentSnapshotId,
    canonicalTextSha256,
    text,
    selectedLocators: [locator],
  };
  const evidenceCandidates = [{ candidateKey: locator.candidateKey, excerpt: text }];
  const priorStepOutputs: [] = [];
  const material = buildGateAMaterialProjection({ inputRef, untrustedText });
  const materialProjectionDigest = digestCanonical(material);
  const promptPolicyResolvedBytesSha256 = digest(systemPrompt);
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const providerInputProjection = buildGateAProviderInputProjection({
    material,
    materialProjectionDigest,
    promptPolicyVersionId: 'xiaowei.solution-analysis.system/2',
    promptPolicyResolvedBytesSha256,
    systemPrompt,
    evidenceCandidates,
    priorStepOutputs,
    stepId: 'solution_design',
    agentRegistryReference: 'agent.solution.architect/live-1',
    logicalModelPolicy: 'business.solution.analysis.standard',
    routeProfile: 'codex_subscription_dev',
    dataClass: 'C1',
    toolChoice: 'none',
    outputSchemaVersion: 'analysis.result-candidate/1',
    maxInputBytes: 4_096,
    maxOutputTokens: 512,
    deadline,
  });
  const now = Math.floor(Date.now() / 1_000);
  const claims = gateAAnalysisInvocationTokenClaimsSchema.parse({
    schemaVersion: 'gate-a-analysis-invocation-token/2',
    iss: 'geneway-control-plane',
    aud: 'local-model-gateway-analysis',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    conversationId: 'conversation-analysis-shared-slot',
    taskId: 'task-analysis-shared-slot',
    workflowVersionId: 'workflow-solution-live-shared-slot',
    workflowHash: digest('workflow-shared-slot'),
    stepId: 'solution_design',
    agentRegistryReference: 'agent.solution.architect/live-1',
    executionAttemptId: 'execution-attempt-shared-slot',
    stepAttemptId: 'step-attempt-shared-slot',
    taskFence: 4,
    stepFence: 7,
    modelInvocationId,
    approvalSubjectDigest: digest('approval-shared-slot'),
    capabilityVersionId: 'cap_solution_analysis_v1_live_2',
    promptPolicyVersionId: 'xiaowei.solution-analysis.system/2',
    agentVersionId: 'agent.solution.architect/live-2',
    expertTargetDigest: digest('expert-target-shared-slot'),
    documentSnapshotId: inputRef.documentSnapshotId,
    artifactId: inputRef.artifactId,
    artifactSha256: inputRef.artifactSha256,
    canonicalTextSha256,
    canonicalPageIndexSha256: null,
    parserManifestId: inputRef.parserManifestId,
    parserDigest: inputRef.parserDigest,
    extractionVersion: inputRef.extractionVersion,
    resourceScope: inputRef.resourceScope,
    canonicalSelectionProjectionDigest,
    selectedModelInputSha256: canonicalTextSha256,
    materialProjectionDigest,
    promptPolicyResolvedBytesSha256,
    providerInputProjectionDigest: digestCanonical(providerInputProjection),
    priorStepOutputsDigest: digestCanonical(priorStepOutputs),
    logicalModelPolicy: 'business.solution.analysis.standard',
    routeProfile: 'codex_subscription_dev',
    dataClass: 'C1',
    toolChoice: 'none',
    outputSchemaVersion: 'analysis.result-candidate/1',
    maxInputBytes: 4_096,
    maxOutputTokens: 512,
    deadline,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  });
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const invocationTokenValue = `${encoded}.${createHmac('sha256', invocationSecret)
    .update(encoded, 'utf8').digest('base64url')}`;
  return gateAAnalysisWorkerClaimSchema.parse({
    schemaVersion: 'analysis-worker-claim/2',
    tenantId: claims.tenantId,
    principalId: claims.principalId,
    conversationId: claims.conversationId,
    taskId: claims.taskId,
    workflowVersionId: claims.workflowVersionId,
    workflowHash: claims.workflowHash,
    stepId: claims.stepId,
    agentRegistryReference: claims.agentRegistryReference,
    executionAttemptId: claims.executionAttemptId,
    stepAttemptId: claims.stepAttemptId,
    taskFence: claims.taskFence,
    stepFence: claims.stepFence,
    modelInvocationId: claims.modelInvocationId,
    approvalSubjectDigest: claims.approvalSubjectDigest,
    capabilityVersionId: claims.capabilityVersionId,
    promptPolicyVersionId: claims.promptPolicyVersionId,
    agentVersionId: 'agent.solution.architect/live-2',
    expertTargetDigest: claims.expertTargetDigest,
    documentSnapshotId: claims.documentSnapshotId,
    artifactId: claims.artifactId,
    artifactSha256: claims.artifactSha256,
    canonicalTextSha256: claims.canonicalTextSha256,
    canonicalPageIndexSha256: claims.canonicalPageIndexSha256,
    parserManifestId: claims.parserManifestId,
    parserDigest: claims.parserDigest,
    extractionVersion: claims.extractionVersion,
    resourceScope: claims.resourceScope,
    canonicalSelectionProjectionDigest: claims.canonicalSelectionProjectionDigest,
    selectedModelInputSha256: claims.selectedModelInputSha256,
    materialProjectionDigest: claims.materialProjectionDigest,
    promptPolicyResolvedBytesSha256: claims.promptPolicyResolvedBytesSha256,
    providerInputProjectionDigest: claims.providerInputProjectionDigest,
    priorStepOutputsDigest: claims.priorStepOutputsDigest,
    dataClass: claims.dataClass,
    maxInputBytes: claims.maxInputBytes,
    maxOutputTokens: claims.maxOutputTokens,
    invocationToken: invocationTokenValue,
    inputRef,
    logicalModelPolicy: claims.logicalModelPolicy,
    routeProfile: claims.routeProfile,
    systemPrompt,
    untrustedText,
    evidenceCandidates,
    priorStepOutputs,
    outputSchemaVersion: claims.outputSchemaVersion,
    toolChoice: claims.toolChoice,
    deadline: claims.deadline,
  });
}

const sharedSlotWorkOrderSnapshot = Object.freeze({
  workOrderRef: 'WO-SHARED-SLOT',
  status: 'running',
  planQty: 100,
  completedQty: 25,
  unit: '件',
  plannedStart: '2026-07-27T01:00:00.000000Z',
  plannedEnd: '2026-07-27T10:00:00.000000Z',
  updatedAt: '2026-07-27T04:00:00.000000Z',
  sourceRevision: 'revision-shared-slot',
});
const sharedSlotWorkOrderProgress = Object.freeze({
  schemaVersion: 'work-order.progress/1' as const,
  planQty: 100,
  completedQty: 25,
  progressPct: 25,
  calculationStatus: 'computed' as const,
});
const sharedSlotWorkOrderSystemPrompt = '只解释当前已验证的只读工单状态。';

function sharedSlotWorkOrderRequest(modelInvocationId: string): GateA3WorkOrderModelRequest {
  const now = Math.floor(Date.now() / 1_000);
  const claims = gateA3WorkOrderModelTokenClaimsSchema.parse({
    schemaVersion: 'gate-a3-work-order-model-token/2',
    iss: 'geneway-control-plane',
    aud: 'local-model-gateway-work-order-explanation',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    taskId: 'task-work-order-shared-slot',
    workflowVersionId: 'workflow-work-order-shared-slot',
    workflowHash: digest('workflow-work-order-shared-slot'),
    executionAttemptId: 'execution-attempt-work-order-shared-slot',
    taskFence: 3,
    stepId: 'explain_status',
    stepAttemptId: 'step-attempt-work-order-shared-slot',
    stepFence: 6,
    modelInvocationId,
    approvalSubjectDigest: digest('approval-work-order-shared-slot'),
    capabilityVersionId: 'cap_production_work_order_status_v1_1',
    effectId: 'effect-work-order-shared-slot',
    connectorQuerySpecHash: digest('query-spec-shared-slot'),
    connectorSourceSnapshotId: 'snapshot-work-order-shared-slot',
    connectorSourceSnapshotHash: digest('snapshot-shared-slot'),
    snapshotPayloadHash: digestGateA3WorkOrderModelValue(sharedSlotWorkOrderSnapshot),
    progressDigest: digestGateA3WorkOrderModelValue(sharedSlotWorkOrderProgress),
    resourceScope: 'gearjob-work-order:connector-query-spec-bound',
    snapshotAudience: 'tenant_local:user_local',
    logicalModelPolicy: 'business.production.work-order-status.explanation',
    promptPolicyVersionId: GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
    promptPolicyResolvedBytesSha256: digest(sharedSlotWorkOrderSystemPrompt),
    routeProfile: 'codex_subscription_dev',
    dataClass: 'C1',
    toolChoice: 'none',
    outputSchemaVersion: 'work-order.explanation/1',
    maxOutputTokens: 512,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  });
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const invocationTokenValue = `${encoded}.${createHmac('sha256', invocationSecret)
    .update(encoded, 'utf8').digest('base64url')}`;
  const {
    schemaVersion: _schemaVersion,
    iss: _issuer,
    aud: _audience,
    jti: _jti,
    iat: _issuedAt,
    exp: _expiresAt,
    ...authority
  } = claims;
  void _schemaVersion;
  void _issuer;
  void _audience;
  void _jti;
  void _issuedAt;
  void _expiresAt;
  return gateA3WorkOrderModelRequestSchema.parse({
    schemaVersion: 'gate-a3-work-order-model-request/2',
    invocationToken: invocationTokenValue,
    ...authority,
    systemPrompt: sharedSlotWorkOrderSystemPrompt,
    snapshot: sharedSlotWorkOrderSnapshot,
    progress: sharedSlotWorkOrderProgress,
  });
}

it('splits coalesced provider text into bounded UTF-8-safe application checkpoints', () => {
  const text = `${'汉'.repeat(64)}🙂${'a'.repeat(64)}`;
  const chunks = chunkProviderDelta(text);
  expect(chunks).toHaveLength(3);
  expect(chunks.every((chunk) => Array.from(chunk).length <= 64)).toBe(true);
  expect(chunks.join('')).toBe(text);
});
const conformance = (manifestDigest: string, expired = false) => {
  const now = Date.now();
  const passedAt = new Date(now - (expired ? 3 * 60_000 : 1_000));
  const deadline = new Date(now + (expired ? -2 * 60_000 : 30 * 60_000));
  const expiresAt = new Date(now + (expired ? -60_000 : 60 * 60_000));
  return {
    schemaVersion: 'geneway-live-conformance/1',
    profile: 'codex_subscription_dev',
    manifestDigest,
    providerModel: 'gpt-5.4-mini',
    passedAt: passedAt.toISOString(),
    deadline: deadline.toISOString(),
    expiresAt: expiresAt.toISOString(),
    checks: {
      stream: true,
      cancel: true,
      usage: true,
      toolChoiceNone: true,
      localFaultMapping: {
        mode: 'synthetic-local-faults', quota: 'MODEL_QUOTA', authentication: 'MODEL_AUTH_FAILED',
        timeout: 'MODEL_TIMEOUT', protocol: 'MODEL_PROTOCOL_VIOLATION', unknown: 'MODEL_STREAM_INTERRUPTED',
      },
      secretRedaction: {
        mode: 'synthetic-canary', canarySha256: 'a'.repeat(64),
        publicErrorSerialization: true, auditSerialization: true,
      },
    },
  };
};

describe('codex_subscription_dev provider boundary', () => {
  it('matches immutable package bytes and lockfile integrity', async () => {
    const verified = await verifyProviderManifest();
    expect(verified.manifest.packages).toHaveLength(7);
    expect(verified.manifest.approval.authorizationRef).toBe('source-thread:019f880e-bac8-7412-a129-68db9bf6506a');
    expect(verified.manifest.credentialBoundary.authorizedOverride).toMatchObject({
      authFilePath: '/home/gewu/.codex/auth.json',
      parentDirectory: '/home/gewu/.codex',
      parentMode: '0775',
      owner: 'current-process-uid',
      symlinksAllowed: false,
      scope: 'trusted-local development only',
    });
    expect(verified.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(verified.manifest.packages.every((entry) =>
      entry.reviewedProvenance.assurance === 'reviewed-not-machine-attested-from-package-bytes')).toBe(true);
    const lockfile = await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    const first = verified.manifest.packages[0];
    if (first === undefined) throw new Error('Provider manifest unexpectedly has no packages');
    expect(() => assertLockfilePackageIntegrity(lockfile, { ...first, integrity: 'sha512-deliberate-mismatch' }))
      .toThrow(`Provider package lockfile integrity mismatch: ${first.name}`);
  });

  it('keeps the default credential boundary at owned non-symlink 0700/0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-auth-boundary-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    await writeFile(authFile, '{}', { mode: 0o600 });
    await expect(verifyOwnedPrivateFile(authFile, 'test auth')).resolves.toBeUndefined();
    await chmod(directory, 0o775);
    await expect(verifyOwnedPrivateFile(authFile, 'test auth')).rejects.toThrow('0700');
  });

  it('accepts 0775 only for the manifest-bound trusted-local auth path and still rejects unsafe files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-authorized-auth-boundary-'));
    await chmod(directory, 0o775);
    const authFile = join(directory, 'auth.json');
    await writeFile(authFile, '{}', { mode: 0o600 });
    const verified = await verifyProviderManifest();
    const manifest = {
      ...verified.manifest,
      credentialBoundary: {
        ...verified.manifest.credentialBoundary,
        authorizedOverride: {
          ...verified.manifest.credentialBoundary.authorizedOverride,
          authFilePath: authFile,
          parentDirectory: directory,
        },
      },
    } as unknown as Parameters<typeof verifyProviderAuthFile>[1];

    await expect(verifyProviderAuthFile(authFile, manifest, 'test auth')).resolves.toBeUndefined();
    await expect(verifyProviderAuthFile(authFile, verified.manifest, 'test auth')).rejects.toThrow('0700');

    await chmod(authFile, 0o644);
    await expect(verifyProviderAuthFile(authFile, manifest, 'test auth')).rejects.toThrow('0600');
    await chmod(authFile, 0o600);
    const authLink = join(directory, 'auth-link.json');
    await symlink(authFile, authLink);
    const symlinkManifest = {
      ...manifest,
      credentialBoundary: {
        ...manifest.credentialBoundary,
        authorizedOverride: { ...manifest.credentialBoundary.authorizedOverride, authFilePath: authLink },
      },
    } as unknown as Parameters<typeof verifyProviderAuthFile>[1];
    await expect(verifyProviderAuthFile(authLink, symlinkManifest, 'test auth')).rejects.toThrow('non-symlink');
  });

  it('stays NOT_OPEN without conformance and credential gates and maps errors stably', async () => {
    const app = await createModelGateway({
      serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100',
    });
    try {
      const readiness = await app.inject({
        method: 'GET', url: '/internal/model-gateway/v1/readiness', headers: { authorization: `Bearer ${serviceToken}` },
      });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ ready: false, profile: 'codex_subscription_dev', reason: 'provider gates not satisfied' });
      const quota = mapProviderError(new Error('quota 429'));
      expect(quota.errorClass).toBe('MODEL_QUOTA');
      expect(quota.retryNotBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(mapProviderError(new Error('auth 401'))).toEqual({ errorClass: 'MODEL_AUTH_FAILED' });
      expect(mapProviderError(new Error('tool call'))).toEqual({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
      const canary = 'synthetic-secret-canary-do-not-leak';
      expect(JSON.stringify(redactedProviderFailure(new Error(`auth 401 ${canary}`)))).not.toContain(canary);
    } finally {
      await app.close();
    }
  });

  it('keeps work-order readiness closed when its receipt authority was not registered', async () => {
    const app = await createModelGateway({
      serviceToken, invocationSecret, controlPlaneUrl: 'http://127.0.0.1:3100',
    });
    try {
      const result = await app.inject({
        method: 'GET', url: MODEL_GATEWAY_WORK_ORDER_READINESS_PATH,
        headers: { authorization: `Bearer ${serviceToken}` },
      });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({
        ready: false,
        profile: 'codex_subscription_dev',
        route: 'work-order-explanation/1',
      });
    } finally {
      await app.close();
    }
  });

  it('revalidates conformance expiry and credential metadata before readiness and stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-dynamic-readiness-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    const app = await createModelGateway({
      serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100',
      authFilePath: authFile, conformanceFilePath: conformanceFile,
    });
    const readiness = () => app.inject({
      method: 'GET', url: '/internal/model-gateway/v1/readiness', headers: { authorization: `Bearer ${serviceToken}` },
    });
    const workOrderReadiness = () => app.inject({
      method: 'GET', url: MODEL_GATEWAY_WORK_ORDER_READINESS_PATH,
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    const stream = () => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream', headers: { authorization: `Bearer ${serviceToken}` }, payload: {},
    });
    try {
      expect((await readiness()).statusCode).toBe(200);
      expect((await workOrderReadiness()).json()).toMatchObject({
        ready: true,
        profile: 'codex_subscription_dev',
        route: 'work-order-explanation/1',
      });
      await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest, true)), { mode: 0o600 });
      expect((await readiness()).statusCode).toBe(503);
      expect((await workOrderReadiness()).statusCode).toBe(503);
      expect((await stream()).json()).toEqual({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
      await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
      expect((await readiness()).statusCode).toBe(200);
      await chmod(authFile, 0o644);
      expect((await readiness()).statusCode).toBe(503);
      expect((await stream()).json()).toEqual({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid or consumed invocation authority before the provider callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-provider-counter-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    let providerCalls = 0;
    const consumed = new Set<string>();
    const app = await createModelGateway({
      serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
      conformanceFilePath: conformanceFile,
      authorizeInvocationForTest: (claims) => {
        if (consumed.has(claims.jti)) return Promise.resolve(false);
        consumed.add(claims.jti);
        return Promise.resolve(true);
      },
      providerCallForTest: () => {
        providerCalls += 1;
        return Promise.resolve({
          deltas: ['真实回调'], providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, pricing: 'unpriced' },
        });
      },
    });
    const invokeStream = (payload: Readonly<Record<string, unknown>>) => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream',
      headers: { authorization: `Bearer ${serviceToken}` }, payload,
    });
    try {
      const validToken = invocationToken();
      const success = await invokeStream(streamBody(validToken));
      expect(success.statusCode, success.body).toBe(200);
      expect(success.body).toContain('"type":"completed"');
      expect(success.body).toContain('"issuer":"geneway-model-gateway"');
      expect(providerCalls).toBe(1);

      expect((await invokeStream(streamBody(validToken))).statusCode).toBe(401);
      const now = Math.floor(Date.now() / 1_000);
      const invalidRequests = [
        streamBody(invocationToken({ iat: now - 60, exp: now - 10 })),
        streamBody(invocationToken(), { modelInvocationId: 'cross-invocation' }),
        streamBody(invocationToken({ iss: 'wrong-issuer' })),
        streamBody(invocationToken({ aud: 'wrong-audience' })),
        streamBody(invocationToken(), { fence: 2 }),
      ];
      for (const requestBody of invalidRequests) expect((await invokeStream(requestBody)).statusCode).toBe(401);
      expect(providerCalls).toBe(1);
      expect((await invokeStream(streamBody(invocationToken()))).statusCode).toBe(200);
      expect(providerCalls).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('atomically reserves the single active slot before asynchronous authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-single-active-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    let releaseAuthorization = (): void => { throw new Error('Authorization gate was not initialized'); };
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let markAuthorizationEntered = (): void => { throw new Error('Authorization entry gate was not initialized'); };
    const authorizationEntered = new Promise<void>((resolve) => { markAuthorizationEntered = resolve; });
    let authorizationCalls = 0;
    let providerCalls = 0;
    const app = await createModelGateway({
      serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
      conformanceFilePath: conformanceFile,
      authorizeInvocationForTest: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) {
          markAuthorizationEntered();
          await authorizationGate;
        }
        return true;
      },
      providerCallForTest: () => {
        providerCalls += 1;
        return Promise.resolve({
          deltas: ['真实回调'], providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, pricing: 'unpriced' },
        });
      },
    });
    const invoke = (modelInvocationId: string) => app.inject({
      method: 'POST', url: '/internal/model-gateway/v1/stream',
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: streamBody(invocationToken({ modelInvocationId }), { modelInvocationId }),
    });
    try {
      const first = invoke('model-invocation-concurrent-1');
      await authorizationEntered;
      const competing = await invoke('model-invocation-concurrent-2');
      expect(competing.statusCode).toBe(409);
      const busyReceipt = modelGatewayReceiptSchema.parse(competing.json<{ receipt: unknown }>().receipt);
      expect(busyReceipt.payload).toMatchObject({
        conversationId: 'conversation-receipt-test',
        modelInvocationId: 'model-invocation-concurrent-2',
        fence: 1,
        outcome: 'CHAT_BUSY',
        providerRevision: null,
        modelRevision: null,
        usage: null,
      });
      expect(busyReceipt.signature).toBe(createHmac('sha256', invocationSecret)
        .update(JSON.stringify(busyReceipt.payload), 'utf8').digest('base64url'));
      expect(authorizationCalls).toBe(1);
      expect(providerCalls).toBe(0);

      releaseAuthorization();
      expect((await first).statusCode).toBe(200);
      expect(authorizationCalls).toBe(1);
      expect(providerCalls).toBe(1);

      expect((await invoke('model-invocation-after-release')).statusCode).toBe(200);
      expect(authorizationCalls).toBe(2);
      expect(providerCalls).toBe(2);
    } finally {
      releaseAuthorization();
      await app.close();
    }
  });

  it('shares one provider slot across Chat, Analysis and Work Order routes and releases it after every holder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-cross-route-single-active-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });

    const routes = ['chat', 'analysis', 'workOrder'] as const;
    type Route = typeof routes[number];
    const successor: Readonly<Record<Route, Route>> = {
      chat: 'analysis',
      analysis: 'workOrder',
      workOrder: 'chat',
    };
    const analysisOutput = Object.freeze({
      schemaVersion: 'analysis-result/1' as const,
      summary: '材料给出了计划数量。',
      statements: [
        {
          id: 'statement-shared-slot-fact',
          kind: 'fact' as const,
          text: '计划数量为 100。',
          evidenceCandidateKeys: ['candidate-shared-slot'],
          confidence: 0.99,
        },
        {
          id: 'statement-shared-slot-unknown',
          kind: 'unknown' as const,
          text: '未提供实际完成数量。',
          evidenceCandidateKeys: [],
          confidence: 1,
        },
        {
          id: 'statement-shared-slot-inference',
          kind: 'inference' as const,
          text: '计划数量可作为后续对比基准。',
          evidenceCandidateKeys: ['candidate-shared-slot'],
          confidence: 0.8,
        },
        {
          id: 'statement-shared-slot-recommendation',
          kind: 'recommendation' as const,
          text: '建议补充实际完成数量。',
          evidenceCandidateKeys: [],
          confidence: 0.9,
        },
      ],
    });
    const workOrderOutput = Object.freeze({
      schemaVersion: 'work-order.explanation/1' as const,
      summary: '该工单当前处于执行中，确定性进度为 25%。',
      statements: [
        {
          id: 'statement-work-order-status',
          kind: 'fact' as const,
          text: '工单当前处于执行中。',
          sourceFields: ['status'] as const,
        },
        {
          id: 'statement-work-order-progress',
          kind: 'inference' as const,
          text: '确定性进度为 25%。',
          sourceFields: ['planQty', 'completedQty', 'progressPct'] as const,
        },
      ],
    });

    for (const holder of routes) {
      let releaseHolder = (): void => undefined;
      const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
      const providerCalls: Record<Route, number> = { chat: 0, analysis: 0, workOrder: 0 };
      const holdFirstProviderCall = async (route: Route): Promise<void> => {
        providerCalls[route] += 1;
        if (route === holder && providerCalls[route] === 1) await holderGate;
      };
      const app = await createModelGateway({
        serviceToken,
        invocationSecret,
        workOrderReceiptSecret,
        controlPlaneUrl: 'http://127.0.0.1:3100',
        authFilePath: authFile,
        conformanceFilePath: conformanceFile,
        authorizeInvocationForTest: () => Promise.resolve(true),
        authorizeAnalysisInvocationForTest: () => Promise.resolve(true),
        authorizeWorkOrderInvocationForTest: () => Promise.resolve(true),
        providerCallForTest: async () => {
          await holdFirstProviderCall('chat');
          return {
            deltas: ['chat shared-slot result'],
            providerRevision: 'test-provider/1',
            modelRevision: 'test-model/1',
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, pricing: 'unpriced' },
          };
        },
        analysisProviderCallForTest: async () => {
          await holdFirstProviderCall('analysis');
          return {
            output: analysisOutput,
            providerRevision: 'test-provider/1',
            modelRevision: 'test-model/1',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            toolCallCount: 0,
          };
        },
        workOrderProviderCallForTest: async () => {
          await holdFirstProviderCall('workOrder');
          return {
            output: workOrderOutput,
            providerRevision: 'test-provider/1',
            modelRevision: 'test-model/1',
            usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
            toolCallCount: 0,
          };
        },
      });
      let sequence = 0;
      const invoke = (route: Route) => {
        sequence += 1;
        const modelInvocationId = `model-invocation-shared-slot-${holder}-${route}-${String(sequence)}`;
        if (route === 'chat') {
          return app.inject({
            method: 'POST',
            url: '/internal/model-gateway/v1/stream',
            headers: { authorization: `Bearer ${serviceToken}` },
            payload: streamBody(invocationToken({ modelInvocationId }), { modelInvocationId }),
          });
        }
        if (route === 'analysis') {
          return app.inject({
            method: 'POST',
            url: '/internal/model-gateway/v1/analysis',
            headers: { authorization: `Bearer ${serviceToken}` },
            payload: { claim: sharedSlotAnalysisClaim(modelInvocationId), toolChoice: 'none' },
          });
        }
        return app.inject({
          method: 'POST',
          url: '/internal/model-gateway/v1/work-order-explanation',
          headers: { authorization: `Bearer ${serviceToken}` },
          payload: sharedSlotWorkOrderRequest(modelInvocationId),
        });
      };

      try {
        const holdingResponse = invoke(holder);
        await expect.poll(() => providerCalls[holder], { timeout: 2_000 }).toBe(1);

        for (const contender of routes.filter((route) => route !== holder)) {
          const competing = await invoke(contender);
          expect(competing.statusCode, `${holder} should block ${contender}: ${competing.body}`).toBe(409);
          const payload = competing.json<{ errorClass: string; receipt: unknown }>();
          if (contender === 'chat') {
            expect(payload.errorClass).toBe('CHAT_BUSY');
            const receipt = modelGatewayReceiptSchema.parse(payload.receipt);
            expect(receipt.payload).toMatchObject({
              audience: 'geneway-control-plane',
              outcome: 'CHAT_BUSY',
              providerRevision: null,
              modelRevision: null,
              usage: null,
            });
            expect(receipt.signature).toBe(createHmac('sha256', invocationSecret)
              .update(JSON.stringify(receipt.payload), 'utf8').digest('base64url'));
            expect(modelGatewayReceiptSchema.safeParse({
              ...receipt,
              payload: { ...receipt.payload, audience: 'geneway-control-plane-work-order' },
            }).success).toBe(false);
          } else if (contender === 'analysis') {
            expect(payload.errorClass).toBe('MODEL_BUSY');
            const receipt = gateAAnalysisGatewayReceiptSchema.parse(payload.receipt);
            expect(receipt.payload).toMatchObject({
              audience: 'geneway-control-plane',
              outcome: 'MODEL_BUSY',
              providerRevision: null,
              modelRevision: null,
              usage: null,
            });
            expect(receipt.signature).toBe(createHmac('sha256', invocationSecret)
              .update(canonicalizeGateAProjection(receipt.payload), 'utf8').digest('base64url'));
            expect(gateAAnalysisGatewayReceiptSchema.safeParse({
              ...receipt,
              payload: { ...receipt.payload, audience: 'geneway-control-plane-work-order' },
            }).success).toBe(false);
          } else {
            expect(payload.errorClass).toBe('MODEL_BUSY');
            const receipt = gateA3WorkOrderModelReceiptSchema.parse(payload.receipt);
            expect(receipt.payload).toMatchObject({
              audience: 'geneway-control-plane-work-order',
              outcome: 'MODEL_BUSY',
              providerRevision: null,
              modelRevision: null,
              usage: null,
            });
            expect(receipt.signature).toBe(createHmac('sha256', workOrderReceiptSecret)
              .update(canonicalizeGateA3Jcs(receipt.payload), 'utf8').digest('base64url'));
            expect(receipt.signature).not.toBe(createHmac('sha256', invocationSecret)
              .update(canonicalizeGateA3Jcs(receipt.payload), 'utf8').digest('base64url'));
            expect(gateA3WorkOrderModelReceiptSchema.safeParse({
              ...receipt,
              payload: { ...receipt.payload, audience: 'geneway-control-plane' },
            }).success).toBe(false);
          }
        }

        expect(providerCalls[holder]).toBe(1);
        for (const contender of routes.filter((route) => route !== holder)) {
          expect(providerCalls[contender]).toBe(0);
        }

        releaseHolder();
        const completedHolder = await holdingResponse;
        expect(completedHolder.statusCode, completedHolder.body).toBe(200);

        const afterReleaseRoute = successor[holder];
        const afterRelease = await invoke(afterReleaseRoute);
        expect(afterRelease.statusCode, afterRelease.body).toBe(200);
        expect(providerCalls[afterReleaseRoute]).toBe(1);
      } finally {
        releaseHolder();
        await app.close();
      }
    }
  });

  it('returns signed redacted quota, timeout and interruption terminals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-provider-faults-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    const canary = 'provider-secret-canary-must-never-escape';
    const faults = [
      { message: `quota 429 ${canary}`, outcome: 'MODEL_QUOTA' },
      { message: `deadline timeout ${canary}`, outcome: 'MODEL_TIMEOUT' },
      { message: `socket reset ${canary}`, outcome: 'MODEL_STREAM_INTERRUPTED' },
    ] as const;
    for (const [index, fault] of faults.entries()) {
      const app = await createModelGateway({
        serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
        conformanceFilePath: conformanceFile,
        authorizeInvocationForTest: () => Promise.resolve(true),
        providerCallForTest: () => Promise.reject(new Error(fault.message)),
      });
      try {
        const modelInvocationId = `model-invocation-fault-${String(index)}`;
        const response = await app.inject({
          method: 'POST', url: '/internal/model-gateway/v1/stream',
          headers: { authorization: `Bearer ${serviceToken}` },
          payload: streamBody(invocationToken({ modelInvocationId }), { modelInvocationId }),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain(canary);
        const terminal = JSON.parse(response.body.trim()) as { errorClass: string; retryNotBefore?: string; receipt: unknown };
        expect(terminal.errorClass).toBe(fault.outcome);
        if (fault.outcome === 'MODEL_QUOTA') expect(terminal.retryNotBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        const signed = modelGatewayReceiptSchema.parse(terminal.receipt);
        expect(signed.payload).toMatchObject({ modelInvocationId, outcome: fault.outcome });
        expect(JSON.stringify(signed)).not.toContain(canary);
      } finally {
        await app.close();
      }
    }
  });

  it('aborts provider work when the downstream Worker closes the stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'geneway-provider-cancel-'));
    await chmod(directory, 0o700);
    const authFile = join(directory, 'auth.json');
    const conformanceFile = join(directory, 'conformance.json');
    const verified = await verifyProviderManifest();
    await writeFile(authFile, '{}', { mode: 0o600 });
    await writeFile(conformanceFile, JSON.stringify(conformance(verified.digest)), { mode: 0o600 });
    let providerCalls = 0;
    let providerSawAbort = false;
    let markProviderEntered = (): void => { throw new Error('Provider entry gate was not initialized'); };
    const providerEntered = new Promise<void>((resolve) => { markProviderEntered = resolve; });
    const app = await createModelGateway({
      serviceToken, invocationSecret, workOrderReceiptSecret, controlPlaneUrl: 'http://127.0.0.1:3100', authFilePath: authFile,
      conformanceFilePath: conformanceFile,
      authorizeInvocationForTest: () => Promise.resolve(true),
      providerCallForTest: ({ signal }) => {
        providerCalls += 1;
        if (providerCalls > 1) {
          return Promise.resolve({
            deltas: ['after cancel'], providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, pricing: 'unpriced' },
          });
        }
        markProviderEntered();
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            providerSawAbort = true;
            reject(new Error('provider aborted after downstream cancellation'));
          }, { once: true });
        });
      },
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const controller = new AbortController();
      const response = await fetch(new URL('/internal/model-gateway/v1/stream', address), {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(streamBody(invocationToken())),
        signal: controller.signal,
      });
      await providerEntered;
      controller.abort();
      await response.text().catch(() => 'aborted');
      await expect.poll(() => providerSawAbort, { timeout: 2_000 }).toBe(true);
      const nextInvocationId = 'model-invocation-after-cancel';
      const next = await app.inject({
        method: 'POST', url: '/internal/model-gateway/v1/stream', headers: { authorization: `Bearer ${serviceToken}` },
        payload: streamBody(invocationToken({ modelInvocationId: nextInvocationId }), { modelInvocationId: nextInvocationId }),
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.body).toContain('"type":"completed"');
      expect(providerCalls).toBe(2);
    } finally {
      await app.close();
    }
  });
});
