import { describe, expect, it } from 'vitest';
import {
  analysisStatementSchema,
  buildGateAMaterialProjection,
  buildGateAProviderInputProjection,
  buildGateAProviderUserPrompt,
  digestGateAMaterialProjection,
  digestGateACanonicalSelectionProjection,
  digestGateAPromptPolicyResolvedBytes,
  digestGateAParserManifest,
  digestGateAProviderInputProjection,
  deidentificationReclassificationRecordSchema,
  gateAAnalysisGatewayReceiptPayloadSchema,
  gateAAnalysisInvocationTokenClaimsSchema,
  gateAAnalysisResultSchema,
  gateACanonicalSelectionProjectionSchema,
  gateAParserManifestSchema,
  verifyGateAParserManifestDigest,
  verifyLiveResolvedTaskInputRefCanonicalSelection,
  liveEvidenceLocatorCandidateSchema,
  liveEvidenceLocatorJsonSchema,
  liveEvidenceLocatorSchema,
  liveResolvedTaskInputRefSchema,
} from './gate-a.js';

const hash = (value: string) => value.repeat(64);
const now = Math.floor(Date.now() / 1_000);
const authority = {
  tenantId: 'tenant_local',
  principalId: 'user_local',
  conversationId: 'conversation-1',
  taskId: 'task-1',
  workflowVersionId: 'workflow-1',
  workflowHash: hash('a'),
  stepId: 'solution_design',
  agentRegistryReference: 'agent.solution.architect/live-1',
  executionAttemptId: 'attempt-1',
  stepAttemptId: 'step-attempt-1',
  taskFence: 1,
  stepFence: 1,
  modelInvocationId: 'invocation-1',
  approvalSubjectDigest: hash('b'),
  capabilityVersionId: 'cap_solution_analysis_v1_live_1',
  promptPolicyVersionId: 'prompt-1',
  expertTargetDigest: hash('c'),
} as const;
const projectionIdentity = {
  documentSnapshotId: 'snapshot-1',
  artifactId: 'artifact-1',
  artifactSha256: hash('d'),
  canonicalTextSha256: hash('e'),
  canonicalPageIndexSha256: null,
  parserManifestId: 'parser-1',
  parserDigest: hash('f'),
  extractionVersion: 'canonical-text/plain-utf8/1',
  resourceScope: 'artifact:artifact-1',
  canonicalSelectionProjectionDigest: hash('7'),
  selectedModelInputSha256: hash('6'),
  materialProjectionDigest: hash('1'),
  promptPolicyResolvedBytesSha256: hash('2'),
  providerInputProjectionDigest: hash('3'),
  priorStepOutputsDigest: hash('4'),
} as const;

const fullCanonicalSelectionProjection = {
  schemaVersion: 'canonical-selection-projection.gate-a/1',
  selectionPolicyVersion: 'canonical-complete-paragraph-concat/1',
  sourceExtractionVersion: 'canonical-text/plain-utf8/1',
  sourceCanonicalTextSha256: hash('c'),
  sourceCanonicalByteLength: 12,
  sourceCanonicalPageIndexSha256: null,
  selectedParagraphs: [
    {
      sourceParagraphIndex: 0,
      startByte: 0,
      endByteExclusive: 5,
      paragraphByteLength: 5,
      paragraphBytesSha256: hash('4'),
      pageSegments: [],
    },
    {
      sourceParagraphIndex: 1,
      startByte: 5,
      endByteExclusive: 12,
      paragraphByteLength: 7,
      paragraphBytesSha256: hash('5'),
      pageSegments: [],
    },
  ],
  selectedTotalBytes: 12,
  selectedModelInputSha256: hash('6'),
  truncated: false,
} as const;



describe('Gate A live contracts', () => {
  it('requires fact Evidence and keeps statement kinds exclusive', () => {
    expect(analysisStatementSchema.safeParse({
      id: 's1', kind: 'fact', text: 'fact', evidenceCandidateKeys: ['e1', 'e1'], confidence: 0.9,
    }).success).toBe(false);
    expect(analysisStatementSchema.safeParse({
      id: 's1', kind: 'fact', text: 'fact', evidenceCandidateKeys: [], confidence: 0.9,
    }).success).toBe(false);
    expect(gateAAnalysisResultSchema.parse({
      schemaVersion: 'analysis-result/1',
      summary: 'summary',
      statements: [
        { id: 's1', kind: 'fact', text: 'fact', evidenceCandidateKeys: ['e1'], confidence: 0.9 },
        { id: 's2', kind: 'unknown', text: 'missing', evidenceCandidateKeys: [], confidence: 0 },
        { id: 's3', kind: 'inference', text: 'inference', evidenceCandidateKeys: ['e1'], confidence: 0.7 },
        { id: 's4', kind: 'recommendation', text: 'recommendation', evidenceCandidateKeys: [], confidence: 0.8 },
      ],
    }).statements.map((entry) => entry.kind)).toEqual(['fact', 'unknown', 'inference', 'recommendation']);
  });

  it('keeps legacy and live resolved document inputs structurally distinct', () => {
    const live = {
      kind: 'live_document_snapshot',
      recordVariant: 'business-task-input.live-material/1',
      documentSnapshotId: 'snapshot-1',
      artifactId: 'artifact-1',
      artifactSha256: hash('a'),
      mediaType: 'text/plain',
      parserManifestId: 'parser-1',
      parserDigest: hash('b'),
      extractionVersion: 'canonical-text/plain-utf8/1',
      canonicalTextSha256: hash('c'),
      canonicalPageIndexSha256: null,
      canonicalSelectionProjection: fullCanonicalSelectionProjection,
      canonicalSelectionProjectionDigest: hash('7'),
      resourceScope: 'artifact:artifact-1',
      dataClass: 'C1',
      audience: 'conversation:conversation-1',
      trust: 'untrusted_text',
    };
    expect(liveResolvedTaskInputRefSchema.parse(live)).toEqual(live);
    expect(liveResolvedTaskInputRefSchema.safeParse({ ...live, kind: 'document_snapshot', simulationProfile: 'solution-analysis-demo/v2' }).success).toBe(false);
    expect(liveResolvedTaskInputRefSchema.safeParse({ ...live, dataClass: 'C2' }).success).toBe(false);
    expect(liveResolvedTaskInputRefSchema.safeParse({ ...live, dataClass: 'C3' }).success).toBe(false);
    expect(liveResolvedTaskInputRefSchema.safeParse({
      ...live,
      canonicalSelectionProjection: {
        ...live.canonicalSelectionProjection,
        sourceCanonicalTextSha256: hash('f'),
      },
    }).success).toBe(false);
  });

  it('freezes complete-paragraph canonical selection for full and oversized model input', async () => {
    const full = gateACanonicalSelectionProjectionSchema.parse(fullCanonicalSelectionProjection);
    expect(full.selectedTotalBytes).toBe(full.sourceCanonicalByteLength);
    expect(gateACanonicalSelectionProjectionSchema.safeParse({ ...full, truncated: true }).success).toBe(false);
    expect(gateACanonicalSelectionProjectionSchema.safeParse({ ...full, selectedTotalBytes: 11 }).success).toBe(false);
    expect(gateACanonicalSelectionProjectionSchema.safeParse({
      ...full,
      selectedParagraphs: [...full.selectedParagraphs].reverse(),
    }).success).toBe(false);

    const oversized = gateACanonicalSelectionProjectionSchema.parse({
      schemaVersion: 'canonical-selection-projection.gate-a/1',
      selectionPolicyVersion: 'canonical-complete-paragraph-concat/1',
      sourceExtractionVersion: 'canonical-text/pdf-pages-utf8/1',
      sourceCanonicalTextSha256: hash('8'),
      sourceCanonicalByteLength: 300_000,
      sourceCanonicalPageIndexSha256: hash('9'),
      selectedParagraphs: [
        {
          sourceParagraphIndex: 0,
          startByte: 0,
          endByteExclusive: 120_000,
          paragraphByteLength: 120_000,
          paragraphBytesSha256: hash('a'),
          pageSegments: [{
            pageIndex: 0,
            pageStartByte: 0,
            pageEndByteExclusive: 120_000,
            absoluteStartByte: 0,
            absoluteEndByteExclusive: 120_000,
            segmentByteLength: 120_000,
            segmentBytesSha256: hash('a'),
          }],
        },
        {
          sourceParagraphIndex: 2,
          startByte: 180_000,
          endByteExclusive: 260_000,
          paragraphByteLength: 80_000,
          paragraphBytesSha256: hash('b'),
          pageSegments: [{
            pageIndex: 2,
            pageStartByte: 0,
            pageEndByteExclusive: 80_000,
            absoluteStartByte: 180_000,
            absoluteEndByteExclusive: 260_000,
            segmentByteLength: 80_000,
            segmentBytesSha256: hash('b'),
          }],
        },
      ],
      selectedTotalBytes: 200_000,
      selectedModelInputSha256: hash('d'),
      truncated: true,
    });
    expect(oversized.truncated).toBe(true);
    expect(oversized.selectedParagraphs.map((paragraph) => paragraph.sourceParagraphIndex)).toEqual([0, 2]);
    expect(gateACanonicalSelectionProjectionSchema.safeParse({
      ...oversized,
      selectedParagraphs: [{
        ...oversized.selectedParagraphs[0]!,
        pageSegments: [{ ...oversized.selectedParagraphs[0]!.pageSegments[0]!, segmentByteLength: 119_999 }],
      }, oversized.selectedParagraphs[1]!],
    }).success).toBe(false);

    const fullDigest = await digestGateACanonicalSelectionProjection(full);
    const tamperedDigest = await digestGateACanonicalSelectionProjection({
      ...full,
      selectedParagraphs: [
        { ...full.selectedParagraphs[0]!, paragraphBytesSha256: hash('e') },
        full.selectedParagraphs[1]!,
      ],
    });
    expect(fullDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(tamperedDigest).not.toBe(fullDigest);
    const resolved = liveResolvedTaskInputRefSchema.parse({
      kind: 'live_document_snapshot',
      recordVariant: 'business-task-input.live-material/1',
      documentSnapshotId: 'snapshot-selection',
      artifactId: 'artifact-selection',
      artifactSha256: hash('1'),
      parserManifestId: 'parser-selection',
      parserDigest: hash('2'),
      mediaType: 'text/plain',
      extractionVersion: full.sourceExtractionVersion,
      canonicalTextSha256: full.sourceCanonicalTextSha256,
      canonicalPageIndexSha256: full.sourceCanonicalPageIndexSha256,
      canonicalSelectionProjection: full,
      canonicalSelectionProjectionDigest: fullDigest,
      resourceScope: 'artifact:artifact-selection',
      dataClass: 'C1',
      audience: 'conversation:conversation-selection',
      trust: 'untrusted_text',
    });
    expect(await verifyLiveResolvedTaskInputRefCanonicalSelection(resolved)).toBe(true);
    expect(await verifyLiveResolvedTaskInputRefCanonicalSelection({
      ...resolved,
      canonicalSelectionProjectionDigest: hash('f'),
    })).toBe(false);
  });

  it('models locator bytes as Control Plane authority, not Runtime-submitted text', () => {
    const locator = {
      schemaVersion: 'evidence-locator.live/1',
      kind: 'canonical_text_span',
      sourceArtifactId: 'artifact-1',
      sourceArtifactSha256: hash('a'),
      documentSnapshotId: 'snapshot-1',
      canonicalTextSha256: hash('b'),
      parserManifestId: 'parser-1',
      parserDigest: hash('c'),
      extractionVersion: 'canonical-text/plain-utf8/1',
      excerptSha256: hash('d'),
      excerptByteLength: 3,
      startByte: 0,
      endByteExclusive: 3,
    };
    expect(liveEvidenceLocatorSchema.parse(locator)).toEqual(locator);
    expect(liveEvidenceLocatorSchema.safeParse({ ...locator, endByteExclusive: 4 }).success).toBe(false);
    expect(JSON.stringify(liveEvidenceLocatorJsonSchema)).not.toContain('excerptBytes');
    expect(liveEvidenceLocatorCandidateSchema.safeParse({
      schemaVersion: 'evidence-locator-candidate.live/1',
      candidateKey: 'candidate-1',
      kind: 'canonical_text_span',
      sourceArtifactId: 'artifact-1',
      sourceArtifactSha256: hash('a'),
      documentSnapshotId: 'snapshot-1',
      canonicalTextSha256: hash('b'),
      parserManifestId: 'parser-1',
      parserDigest: hash('c'),
      extractionVersion: 'canonical-text/plain-utf8/1',
      startByte: 0,
      endByteExclusive: 16_385,
    }).success).toBe(false);
  });

  it('binds token and receipt to the same full authority identity', () => {
    const token = gateAAnalysisInvocationTokenClaimsSchema.parse({
      schemaVersion: 'gate-a-analysis-invocation-token/1',
      iss: 'geneway-control-plane',
      aud: 'local-model-gateway-analysis',
      ...authority,
      ...projectionIdentity,
      logicalModelPolicy: 'business.solution.analysis.standard',
      routeProfile: 'codex_subscription_dev',
      dataClass: 'C1',
      toolChoice: 'none',
      outputSchemaVersion: 'analysis.result-candidate/1',
      maxInputBytes: 1024,
      maxOutputTokens: 512,
      deadline: new Date(Date.now() + 30_000).toISOString(),
      jti: '77777777-7777-4777-8777-777777777777',
      iat: now,
      exp: now + 60,
    });
    expect(token.taskFence).toBe(1);
    expect(gateAAnalysisInvocationTokenClaimsSchema.safeParse({ ...token, exp: token.iat + 61 }).success).toBe(false);
    expect(gateAAnalysisGatewayReceiptPayloadSchema.parse({
      schemaVersion: 'gate-a-analysis-gateway-receipt/1',
      issuer: 'geneway-model-gateway',
      audience: 'geneway-control-plane',
      receiptJti: '88888888-8888-4888-8888-888888888888',
      ...authority,
      ...projectionIdentity,
      logicalModelPolicy: 'business.solution.analysis.standard',
      routeProfile: 'codex_subscription_dev',
      toolChoice: 'none',
      maxInputBytes: 1024,
      dataClass: 'C1',
      outputSchemaVersion: 'analysis.result-candidate/1',
      maxOutputTokens: 512,
      deadline: token.deadline,
      issuedAt: new Date().toISOString(),
      outcome: 'MODEL_BUSY',
      providerRevision: null,
      modelRevision: null,
      outputPayloadDigest: null,
      usage: null,
    }).outcome).toBe('MODEL_BUSY');
  });

  it('derives material, prompt-policy and provider-input digests from exact versioned projections', async () => {
    const inputRef = liveResolvedTaskInputRefSchema.parse({
      kind: 'live_document_snapshot',
      recordVariant: 'business-task-input.live-material/1',
      documentSnapshotId: projectionIdentity.documentSnapshotId,
      artifactId: projectionIdentity.artifactId,
      artifactSha256: projectionIdentity.artifactSha256,
      mediaType: 'text/plain',
      parserManifestId: projectionIdentity.parserManifestId,
      parserDigest: projectionIdentity.parserDigest,
      extractionVersion: projectionIdentity.extractionVersion,
      canonicalTextSha256: projectionIdentity.canonicalTextSha256,
      canonicalPageIndexSha256: projectionIdentity.canonicalPageIndexSha256,
      canonicalSelectionProjection: {
        ...fullCanonicalSelectionProjection,
        sourceCanonicalTextSha256: projectionIdentity.canonicalTextSha256,
      },
      canonicalSelectionProjectionDigest: hash('7'),
      resourceScope: projectionIdentity.resourceScope,
      dataClass: 'C1',
      audience: 'conversation:conversation-1',
      trust: 'untrusted_text',
    });
    const untrustedText = {
      schemaVersion: 'untrusted-text/1' as const,
      documentSnapshotId: inputRef.documentSnapshotId,
      canonicalTextSha256: inputRef.canonicalTextSha256,
      text: '材料原文。',
      selectedLocators: [],
    };
    const material = buildGateAMaterialProjection({ inputRef, untrustedText });
    const materialDigest = await digestGateAMaterialProjection(material);
    const promptDigest = await digestGateAPromptPolicyResolvedBytes('system prompt');
    const provider = buildGateAProviderInputProjection({
      material,
      materialProjectionDigest: materialDigest,
      promptPolicyVersionId: 'prompt-1',
      promptPolicyResolvedBytesSha256: promptDigest,
      systemPrompt: 'system prompt',
      evidenceCandidates: [{ candidateKey: 'candidate-1', excerpt: untrustedText.text }],
      priorStepOutputs: [],
      stepId: 'requirement_extract',
      agentRegistryReference: 'agent.solution.requirement/live-1',
      logicalModelPolicy: 'business.solution.analysis.standard',
      routeProfile: 'codex_subscription_dev',
      dataClass: 'C1',
      toolChoice: 'none',
      outputSchemaVersion: 'analysis.requirement-candidates/1',
      maxInputBytes: 1024,
      maxOutputTokens: 512,
      deadline: '2026-07-26T01:00:00.000Z',
    });
    const providerDigest = await digestGateAProviderInputProjection(provider);
    expect(materialDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(promptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(providerDigest).toMatch(/^[a-f0-9]{64}$/u);
    const changedMaterial = buildGateAMaterialProjection({
      inputRef,
      untrustedText: { ...untrustedText, text: '材料原文改变。' },
    });
    expect(await digestGateAMaterialProjection(changedMaterial)).not.toBe(materialDigest);
    expect(provider.providerUserPrompt).toBe(buildGateAProviderUserPrompt([
      { candidateKey: 'candidate-1', excerpt: untrustedText.text },
    ]));
  });


  it('opens only digest-bound text/plain parser manifests and preserves revocation evidence', async () => {
    const parser = {
      schemaVersion: 'parser-manifest.gate-a/1',
      id: 'parser-1',
      mediaType: 'text/plain',
      parser: {
        name: 'geneway-plain-text-parser',
        version: '1.0.0',
        registrySource: 'geneway-workspace',
        upstreamSource: 'geneway://packages/ingestion/plain-text-parser',
        lockResolution: 'workspace:packages/ingestion',
        lockIntegrity: hash('a'),
        executableDigest: hash('b'),
        packageDigest: hash('c'),
        license: 'UNLICENSED-internal',
      },
      dependencies: [],
      conversionConfig: {
        inputEncoding: 'UTF-8', outputEncoding: 'UTF-8', unicodeNormalization: 'none',
        newlineNormalization: 'none', stripByteOrderMark: false,
        maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576,
      },
      resourceLimitsVersion: 'gate-a-parser-limits/1',
      approvedBy: 'user_local',
      approvedAt: '2026-07-26T00:00:00.000Z',
      expiresAt: '2027-07-26T00:00:00.000Z',
      manifestDigest: hash('d'),
    };
    const parsedParser = gateAParserManifestSchema.parse(parser);
    expect(parsedParser.mediaType).toBe('text/plain');
    expect(gateAParserManifestSchema.safeParse({ ...parser, mediaType: 'application/pdf' }).success).toBe(false);
    const { manifestDigest: fixtureDigest, ...unsignedParser } = parsedParser;
    expect(fixtureDigest).toBe(hash('d'));
    const computedDigest = await digestGateAParserManifest(unsignedParser);
    expect(await verifyGateAParserManifestDigest({
      ...unsignedParser,
      manifestDigest: computedDigest,
    })).toBe(true);
    const alteredParser = gateAParserManifestSchema.parse({
      ...unsignedParser,
      parser: { ...unsignedParser.parser, packageDigest: hash('e') },
      manifestDigest: computedDigest,
    });
    expect(await verifyGateAParserManifestDigest(alteredParser)).toBe(false);

    const record = {
      schemaVersion: 'deidentification-reclassification-record/1',
      id: 'reclass-1',
      source: { artifactId: 'artifact-c2', artifactSha256: hash('1'), documentSnapshotId: 'snapshot-c2', canonicalTextSha256: hash('2'), dataClass: 'C2' },
      output: { artifactId: 'artifact-c1', artifactSha256: hash('3'), documentSnapshotId: 'snapshot-c1', canonicalTextSha256: hash('4'), dataClass: 'C1' },
      transformer: { name: 'deidentifier', version: '1', executableDigest: hash('5') },
      deidentificationPolicyVersion: 'policy-1',
      deterministicDetection: { schemaVersion: 'deidentification-detection/1', passed: true, outputSha256: hash('4'), findingsDigest: hash('6') },
      lineageRecordIds: ['lineage-1', 'lineage-2'],
      approval: {
        actorId: 'approver-1', role: 'gate-a-data-reclassification-approver',
        authorizationDecisionId: 'decision-1', approvedAt: '2026-07-26T00:00:00.000Z',
        expiresAt: '2026-07-27T00:00:00.000Z', revokedAt: '2026-07-26T01:00:00.000Z',
      },
      createdAt: '2026-07-26T00:00:00.000Z',
    };
    expect(deidentificationReclassificationRecordSchema.parse(record).approval.revokedAt).not.toBeNull();
  });
});
