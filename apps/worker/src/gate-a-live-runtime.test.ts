import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GenewayError,
  gateAAnalysisGatewayReceiptSchema,
  gateAAnalysisWorkerClaimSchema,
  type GateAAnalysisGatewayReceipt,
  type GateAAnalysisWorkerClaim,
} from '@geneway/contracts';
import type { WorkerCommandClient } from './command-client.js';
import {
  GateAAnalysisRuntimeAdapter,
  GateAAnalysisRuntimeError,
  executeGateAAnalysisClaim,
  type GateAAnalysisCommandPort,
  type GateAAnalysisRuntimeResult,
} from './gate-a-live-runtime.js';
import { runWorkerLoop } from './worker-loop.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const serviceToken = 'gate-a-worker-model-gateway-token-0000000000000001';

function claim(version: 1 | 2 = 1): GateAAnalysisWorkerClaim {
  const materialText = '计划数量为 100。';
  const canonicalTextSha256 = digest(materialText);
  const canonicalTextByteLength = Buffer.byteLength(materialText, 'utf8');
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
  const canonicalSelectionProjectionDigest = digest(JSON.stringify(canonicalSelectionProjection));
  const documentSnapshotId = 'snapshot-1';
  return gateAAnalysisWorkerClaimSchema.parse({
    schemaVersion: version === 2 ? 'analysis-worker-claim/2' : 'analysis-worker-claim/1',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    conversationId: 'conversation-1',
    taskId: 'task-1',
    workflowVersionId: 'workflow-1',
    workflowHash: digest('workflow'),
    stepId: 'solution_design',
    agentRegistryReference: 'agent.solution.architect/live-1',
    executionAttemptId: 'execution-attempt-1',
    stepAttemptId: 'step-attempt-1',
    taskFence: 2,
    stepFence: 3,
    modelInvocationId: 'model-invocation-1',
    approvalSubjectDigest: digest('approval'),
    capabilityVersionId: version === 2 ? 'cap_solution_analysis_v1_live_2' : 'cap_solution_analysis_v1_live_1',
    promptPolicyVersionId: version === 2 ? 'xiaowei.solution-analysis.system/2' : 'xiaowei.solution-analysis.system/1',
    ...(version === 2 ? { agentVersionId: 'agent.solution.architect/live-2' } : {}),
    expertTargetDigest: digest('expert'),
    documentSnapshotId,
    artifactId: 'artifact-1',
    artifactSha256: digest('artifact'),
    canonicalTextSha256,
    canonicalPageIndexSha256: null,
    parserManifestId: 'parser-manifest-1',
    parserDigest: digest('parser'),
    extractionVersion: 'canonical-text/plain-utf8/1',
    resourceScope: 'conversation:conversation-1',
    canonicalSelectionProjectionDigest,
    selectedModelInputSha256: canonicalTextSha256,
    materialProjectionDigest: digest('material-projection'),
    promptPolicyResolvedBytesSha256: digest('仅分析材料。'),
    providerInputProjectionDigest: digest('provider-input-projection'),
    priorStepOutputsDigest: digest('[]'),
    dataClass: 'C1',
    maxInputBytes: 4_096,
    maxOutputTokens: 512,
    invocationToken: 't'.repeat(40),
    inputRef: {
      kind: 'live_document_snapshot',
      recordVariant: 'business-task-input.live-material/1',
      documentSnapshotId,
      artifactId: 'artifact-1',
      artifactSha256: digest('artifact'),
      mediaType: 'text/plain',
      parserManifestId: 'parser-manifest-1',
      parserDigest: digest('parser'),
      extractionVersion: 'canonical-text/plain-utf8/1',
      canonicalTextSha256,
      canonicalPageIndexSha256: null,
      canonicalSelectionProjection,
      canonicalSelectionProjectionDigest,
      resourceScope: 'conversation:conversation-1',
      dataClass: 'C1',
      audience: 'conversation:conversation-1',
      trust: 'untrusted_text',
    },
    logicalModelPolicy: 'business.solution.analysis.standard',
    routeProfile: 'codex_subscription_dev',
    systemPrompt: '仅分析材料。',
    untrustedText: {
      schemaVersion: 'untrusted-text/1',
      documentSnapshotId,
      canonicalTextSha256,
      text: materialText,
      selectedLocators: [],
    },
    evidenceCandidates: [{ candidateKey: 'candidate_1', excerpt: materialText }],
    priorStepOutputs: [],
    outputSchemaVersion: 'analysis.result-candidate/1',
    toolChoice: 'none',
    deadline: new Date(Date.now() + 60_000).toISOString(),
  });
}

const output = Object.freeze({
  schemaVersion: 'analysis-result/1' as const,
  summary: '完成材料分析。',
  statements: [
    { id: 'statement-1', kind: 'fact' as const, text: '计划数量为 100。', evidenceCandidateKeys: ['candidate_1'], confidence: 1 },
    { id: 'statement-2', kind: 'inference' as const, text: '该计划可作为基准。', evidenceCandidateKeys: ['candidate_1'], confidence: 0.8 },
    { id: 'statement-3', kind: 'recommendation' as const, text: '建议补充完成数量。', evidenceCandidateKeys: [], confidence: 0.9 },
    { id: 'statement-4', kind: 'unknown' as const, text: '未提供完成数量。', evidenceCandidateKeys: [], confidence: 1 },
  ],
});

function receipt(value: GateAAnalysisWorkerClaim, outcome: 'completed' | 'MODEL_TIMEOUT' = 'completed'): GateAAnalysisGatewayReceipt {
  const common = {
    schemaVersion: value.schemaVersion === 'analysis-worker-claim/2'
      ? 'gate-a-analysis-gateway-receipt/2' as const
      : 'gate-a-analysis-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway',
    audience: 'geneway-control-plane',
    receiptJti: '11111111-1111-4111-8111-111111111111',
    tenantId: value.tenantId,
    principalId: value.principalId,
    conversationId: value.conversationId,
    taskId: value.taskId,
    workflowVersionId: value.workflowVersionId,
    workflowHash: value.workflowHash,
    stepId: value.stepId,
    agentRegistryReference: value.agentRegistryReference,
    executionAttemptId: value.executionAttemptId,
    stepAttemptId: value.stepAttemptId,
    taskFence: value.taskFence,
    stepFence: value.stepFence,
    modelInvocationId: value.modelInvocationId,
    approvalSubjectDigest: value.approvalSubjectDigest,
    capabilityVersionId: value.capabilityVersionId,
    promptPolicyVersionId: value.promptPolicyVersionId,
    expertTargetDigest: value.expertTargetDigest,
    documentSnapshotId: value.documentSnapshotId,
    artifactId: value.artifactId,
    artifactSha256: value.artifactSha256,
    canonicalTextSha256: value.canonicalTextSha256,
    canonicalPageIndexSha256: value.canonicalPageIndexSha256,
    parserManifestId: value.parserManifestId,
    parserDigest: value.parserDigest,
    extractionVersion: value.extractionVersion,
    resourceScope: value.resourceScope,
    canonicalSelectionProjectionDigest: value.canonicalSelectionProjectionDigest,
    selectedModelInputSha256: value.selectedModelInputSha256,
    materialProjectionDigest: value.materialProjectionDigest,
    promptPolicyResolvedBytesSha256: value.promptPolicyResolvedBytesSha256,
    providerInputProjectionDigest: value.providerInputProjectionDigest,
    priorStepOutputsDigest: value.priorStepOutputsDigest,
    logicalModelPolicy: value.logicalModelPolicy,
    dataClass: value.dataClass,
    routeProfile: value.routeProfile,
    toolChoice: value.toolChoice,
    maxInputBytes: value.maxInputBytes,
    outputSchemaVersion: value.outputSchemaVersion,
    maxOutputTokens: value.maxOutputTokens,
    deadline: value.deadline,
    issuedAt: new Date().toISOString(),
    ...(value.schemaVersion === 'analysis-worker-claim/2' ? { agentVersionId: value.agentVersionId } : {}),
  } as const;
  return gateAAnalysisGatewayReceiptSchema.parse({
    payload: outcome === 'completed'
      ? {
          ...common, outcome, providerRevision: 'provider/1', modelRevision: 'model/1',
          outputPayloadDigest: digest('output'), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        }
      : {
          ...common, outcome, providerRevision: 'provider/1', modelRevision: 'model/1',
          outputPayloadDigest: null, usage: null,
        },
    signature: 'a'.repeat(43),
  });
}

function result(value = claim()): GateAAnalysisRuntimeResult {
  return { output, receipt: receipt(value) };
}

function port(overrides: Partial<GateAAnalysisCommandPort> = {}): GateAAnalysisCommandPort {
  return {
    claim: () => Promise.resolve(null),
    started: () => Promise.resolve(),
    completed: () => Promise.resolve(),
    failed: () => Promise.resolve(),
    cancelRequested: () => Promise.resolve(null),
    canceled: () => Promise.resolve(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gate A live Worker runtime', () => {
  it('posts only the strict claim/toolChoice request and accepts a matching completed receipt', async () => {
    const value = claim();
    const expected = result(value);
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      expect(typeof init?.body).toBe('string');
      if (typeof init?.body !== 'string') throw new Error('expected a serialized analysis request');
      expect(JSON.parse(init.body) as unknown).toEqual({ claim: value, toolChoice: 'none' });
      return Promise.resolve(new Response(JSON.stringify(expected), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(value)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts a v2 receipt only when it carries the exact claim AgentVersion', async () => {
    const value = claim(2);
    const expected = result(value);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(expected), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(value)).resolves.toEqual(expected);
    expect(expected.receipt.payload).toMatchObject({
      schemaVersion: 'gate-a-analysis-gateway-receipt/2',
      agentVersionId: 'agent.solution.architect/live-2',
    });
  });

  it('rejects a v2 receipt rebound to another step and AgentVersion', async () => {
    const value = claim(2);
    const valid = receipt(value);
    const tampered = gateAAnalysisGatewayReceiptSchema.parse({
      ...valid,
      payload: {
        ...valid.payload,
        stepId: 'requirement_extract',
        agentRegistryReference: 'agent.solution.requirement/live-1',
        agentVersionId: 'agent.solution.requirement/live-2',
        outputSchemaVersion: 'analysis.requirement-candidates/1',
      },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ output, receipt: tampered }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(value)).rejects.toMatchObject({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it('rejects a receipt whose material or provider projection identity differs from the claim', async () => {
    const value = claim();
    const valid = receipt(value);
    const tampered = gateAAnalysisGatewayReceiptSchema.parse({
      ...valid,
      payload: { ...valid.payload, artifactId: 'artifact-other' },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      output,
      receipt: tampered,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(value)).rejects.toMatchObject({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it.each([
    ['canonical selection projection digest', 'canonicalSelectionProjectionDigest'],
    ['selected model-input digest', 'selectedModelInputSha256'],
  ] as const)('rejects a receipt whose %s differs from the claim', async (_label, field) => {
    const value = claim();
    const valid = receipt(value);
    const tampered = gateAAnalysisGatewayReceiptSchema.parse({
      ...valid,
      payload: { ...valid.payload, [field]: digest(`receipt-${field}-tamper`) },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      output,
      receipt: tampered,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(value)).rejects.toMatchObject({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it('fails closed before JSON parsing when the Gateway response exceeds 2 MiB', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('x', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
    })));
    const runtime = new GateAAnalysisRuntimeAdapter('http://127.0.0.1:3150', serviceToken);
    await expect(runtime.execute(claim())).rejects.toMatchObject({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it('turns a runtime failure with a bound receipt into one failed Control Plane terminal', async () => {
    const value = claim();
    const failure = new GateAAnalysisRuntimeError('MODEL_TIMEOUT', receipt(value, 'MODEL_TIMEOUT'));
    const failed = vi.fn(() => Promise.resolve());
    const completed = vi.fn(() => Promise.resolve());
    const runtime = { execute: () => Promise.reject(failure) } as unknown as GateAAnalysisRuntimeAdapter;
    await executeGateAAnalysisClaim(port({ failed, completed }), runtime, value);
    expect(failed).toHaveBeenCalledWith(value, failure);
    expect(completed).not.toHaveBeenCalled();
  });

  it('maps an unknown runtime protocol failure to one explicit failed terminal', async () => {
    const failed = vi.fn((failedClaim: GateAAnalysisWorkerClaim, error: GateAAnalysisRuntimeError) => {
      void failedClaim;
      void error;
      return Promise.resolve();
    });
    const runtime = { execute: () => Promise.reject(new TypeError('invalid local adapter payload')) } as unknown as GateAAnalysisRuntimeAdapter;
    await executeGateAAnalysisClaim(port({ failed }), runtime, claim());
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[1]).toMatchObject({ errorClass: 'MODEL_PROTOCOL_VIOLATION' });
  });

  it('aborts provider work on cancellation and reports only canceled with the new fences', async () => {
    const value = claim();
    const cancellation = { taskFence: value.taskFence + 1, stepFence: value.stepFence + 1 };
    const canceled = vi.fn(() => Promise.resolve());
    const failed = vi.fn(() => Promise.resolve());
    const completed = vi.fn(() => Promise.resolve());
    let polls = 0;
    const commandPort = port({
      cancelRequested: () => Promise.resolve(++polls === 1 ? cancellation : null),
      canceled,
      failed,
      completed,
    });
    const runtime = {
      execute: (_claim: GateAAnalysisWorkerClaim, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new GateAAnalysisRuntimeError('MODEL_STREAM_INTERRUPTED')), { once: true });
      }),
    } as unknown as GateAAnalysisRuntimeAdapter;
    await executeGateAAnalysisClaim(commandPort, runtime, value);
    expect(canceled).toHaveBeenCalledWith(value, cancellation);
    expect(failed).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('does not overwrite a late authority rejection with a second failed terminal', async () => {
    const failed = vi.fn(() => Promise.resolve());
    const authorityLoss = new GenewayError('STALE_STEP_COMPLETION', 'late output lost authority', 409);
    const runtime = { execute: () => Promise.resolve(result()) } as unknown as GateAAnalysisRuntimeAdapter;
    await expect(executeGateAAnalysisClaim(port({
      completed: () => Promise.reject(authorityLoss),
      failed,
    }), runtime, claim())).rejects.toBe(authorityLoss);
    expect(failed).not.toHaveBeenCalled();
  });

  it('dispatches a live analysis claim before legacy delivery and never invokes FakeRuntime', async () => {
    const value = claim();
    const shutdown = new AbortController();
    const completed = vi.fn(() => { shutdown.abort(); return Promise.resolve(); });
    let claimed = false;
    const analysisPort = port({
      claim: () => {
        if (claimed) return Promise.resolve(null);
        claimed = true;
        return Promise.resolve(value);
      },
      completed,
    });
    const claimDelivery = vi.fn(() => Promise.reject(new Error('legacy delivery must not be polled')));
    const legacy = {
      authenticate: () => Promise.resolve(),
      claimDelivery,
    } as unknown as WorkerCommandClient;
    const runtime = { execute: () => Promise.resolve(result(value)) } as unknown as GateAAnalysisRuntimeAdapter;
    await runWorkerLoop(legacy, { signal: shutdown.signal, pollIntervalMs: 10, analysis: { port: analysisPort, runtime } });
    expect(completed).toHaveBeenCalledOnce();
    expect(claimDelivery).not.toHaveBeenCalled();
  });
});
