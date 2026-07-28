import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
  canonicalizeGateA3Jcs,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorSourceSnapshotSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderStatusCardSchema,
  GenewayError,
} from '@geneway/contracts';
import {
  computeGateA3WorkOrderProgress,
  executeGateA3WorkOrderClaim,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderWorkerClaimSchema,
  GateA3WorkOrderRuntimeError,
  GateA3ConnectorRuntimeAdapter,
  GateA3WorkOrderModelRuntimeAdapter,
  type GateA3ComputeGrant,
  type GateA3ConnectorRuntimeResult,
  type GateA3EvidenceGrant,
  type GateA3ExplainGrant,
  type GateA3FetchGrant,
  type GateA3ModelRuntimeResult,
  type GateA3PublishGrant,
  type GateA3WorkOrderCommandPort,
  type GateA3WorkOrderProgress,
  type GateA3WorkOrderWorkerClaim,
} from './gate-a3-work-order-runtime.js';

const hash = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalizeGateA3Jcs(value), 'utf8').digest('hex');
const systemPrompt = '你是小纬的工单说明后端。只解释已验证的只读工单快照和确定性进度；不得补造、修改状态或数量，不得调用工具、联网或输出内部连接信息。仅输出 work-order.explanation/1。';
const promptPolicyResolvedBytesSha256 = hash(systemPrompt);
const now = '2026-07-27T06:00:00.000Z';
const sourceNow = '2026-07-27T06:00:00.000000Z';
const deadline = new Date(Date.now() + 60_000).toISOString();

const response = Object.freeze({
  workOrderRef: 'WO-2026-0001',
  status: 'running',
  planQty: 100,
  completedQty: 25,
  unit: '件',
  plannedStart: '2026-07-27T01:00:00.000000Z',
  plannedEnd: '2026-07-27T10:00:00.000000Z',
  updatedAt: sourceNow,
  sourceRevision: 'revision-7',
});

const querySpec = Object.freeze({
  schemaVersion: 'connector-query-spec/1' as const,
  canonicalizationVersion: 'RFC8785/JCS-1' as const,
  specId: 'connector-spec-1',
  capabilityVersionId: 'cap_production_work_order_status_v1_1' as const,
  releaseRecordId: 'release-record-1',
  approvedPreflightDigest: hash('preflight'),
  connectorProfileVersion: 'gearjob-work-order-status-dev/1' as const,
  baseUrl: 'http://127.0.0.1:8100',
  endpoint: '/api/method/gearjob.api.work_order.get_work_order_status' as const,
  method: 'GET' as const,
  endpointMethodAllowlistDigest: hash('endpoint-method'),
  fieldMaskVersion: 'gearjob-work-order-status-nine-fields/1' as const,
  fieldMask: [
    'workOrderRef', 'status', 'planQty', 'completedQty', 'unit',
    'plannedStart', 'plannedEnd', 'updatedAt', 'sourceRevision',
  ] as const,
  workOrderRef: response.workOrderRef,
  tenantId: 'tenant_local',
  principal: 'user_local',
  resourceContextDigest: hash('resource-context'),
  workflowVersionId: 'workflow-work-order-1',
  workflowHash: hash('workflow'),
  stepId: 'fetch_authorized_status' as const,
  budget: { maxAttempts: 3, timeoutMs: 2_000 },
  deadline,
  publicErrorPolicyVersion: 'gearjob.not-found-forbidden-equivalent/1' as const,
  cardSchemaVersion: 'WorkOrderStatusCard/1' as const,
});
const querySpecHash = hash(querySpec);

const connectorRequest = gateA3ConnectorGatewayRequestSchema.parse({
  schemaVersion: 'gate-a3-connector-gateway-request/1',
  invocationToken: 'c'.repeat(64),
  querySpec,
  querySpecHash,
});

const connectorReceipt = gateA3ConnectorGatewayReceiptSchema.parse({
  payload: {
    schemaVersion: 'gate-a3-connector-gateway-receipt/1',
    issuer: 'geneway-connector-gateway',
    audience: 'geneway-control-plane',
    receiptJti: 'connector-receipt-1',
    tenantId: 'tenant_local',
    principal: 'user_local',
    taskId: 'task-work-order-1',
    workflowVersionId: querySpec.workflowVersionId,
    workflowHash: querySpec.workflowHash,
    stepId: 'fetch_authorized_status',
    attemptId: 'step-attempt-fetch-1',
    effectId: 'effect-work-order-1',
    connectorInvocationId: '11111111-1111-4111-8111-111111111111',
    connectorQuerySpecHash: querySpecHash,
    connectorProfileVersion: querySpec.connectorProfileVersion,
    workOrderRefHash: hash(response.workOrderRef),
    fieldMaskVersion: querySpec.fieldMaskVersion,
    resourceContextDigest: querySpec.resourceContextDigest,
    deadline,
    fence: 5,
    jti: '22222222-2222-4222-8222-222222222222',
    issuedAt: now,
    outcome: 'completed',
    responseRefMatched: true,
    sourceRevision: response.sourceRevision,
    responseCanonicalHash: hash(response),
  },
  signature: 'a'.repeat(43),
});

const connectorResult: GateA3ConnectorRuntimeResult = { response, receipt: connectorReceipt };
const sourceSnapshot = gateA3ConnectorSourceSnapshotSchema.parse({
  schemaVersion: 'connector-source-snapshot/1',
  canonicalizationVersion: 'RFC8785/JCS-1',
  connectorSourceSnapshotId: 'source-snapshot-1',
  tenantId: 'tenant_local',
  principal: 'user_local',
  taskId: 'task-work-order-1',
  connectorInvocationId: connectorReceipt.payload.connectorInvocationId,
  effectId: connectorReceipt.payload.effectId,
  attemptId: connectorReceipt.payload.attemptId,
  fence: connectorReceipt.payload.fence,
  connectorQuerySpecHash: querySpecHash,
  workOrderRefHash: connectorReceipt.payload.workOrderRefHash,
  responseRefMatched: true,
  fieldMaskVersion: querySpec.fieldMaskVersion,
  sourceRevision: response.sourceRevision,
  sourceAsOf: response.updatedAt,
  canonicalAllowlistedPayload: response,
  canonicalAllowlistedPayloadHash: hash(response),
  resourceScope: 'gearjob-work-order:connector-query-spec-bound',
  dataClass: 'C1',
  audience: { tenantId: 'tenant_local', principal: 'user_local' },
  createdAt: now,
});

function claim(workOrderRef: string = response.workOrderRef): GateA3WorkOrderWorkerClaim {
  return gateA3WorkOrderWorkerClaimSchema.parse({
    schemaVersion: 'gate-a3-work-order-worker-claim/1',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    taskId: 'task-work-order-1',
    workflowVersionId: querySpec.workflowVersionId,
    workflowHash: querySpec.workflowHash,
    executionAttemptId: 'execution-attempt-1',
    taskFence: 3,
    approvalSubjectDigest: hash('approval'),
    capabilityVersionId: 'cap_production_work_order_status_v1_1',
    connectorQuerySpecHash: querySpecHash,
    deadline,
    workOrderRef,
    step: { stepId: 'validate_work_order_ref', stepAttemptId: 'step-attempt-validate-1', stepFence: 4 },
  });
}

const explanation = gateA3WorkOrderExplanationSchema.parse({
  schemaVersion: 'work-order.explanation/1',
  summary: '工单正在执行，确定性进度为 25%。',
  statements: [
    { id: 'statement-status', kind: 'fact', text: '工单正在执行。', sourceFields: ['status'] },
    { id: 'statement-progress', kind: 'inference', text: '确定性进度为 25%。',
      sourceFields: ['planQty', 'completedQty', 'progressPct'] },
  ],
});

function modelRequest(progress: GateA3WorkOrderProgress) {
  return {
    schemaVersion: 'gate-a3-work-order-model-request/2' as const,
    invocationToken: 'm'.repeat(64),
    tenantId: 'tenant_local',
    principalId: 'user_local',
    taskId: 'task-work-order-1',
    workflowVersionId: querySpec.workflowVersionId,
    workflowHash: querySpec.workflowHash,
    executionAttemptId: 'execution-attempt-1',
    taskFence: 3,
    stepId: 'explain_status' as const,
    stepAttemptId: 'step-attempt-explain-1',
    stepFence: 7,
    modelInvocationId: 'model-invocation-work-order-1',
    approvalSubjectDigest: hash('approval'),
    capabilityVersionId: 'cap_production_work_order_status_v1_1' as const,
    effectId: sourceSnapshot.effectId,
    connectorQuerySpecHash: querySpecHash,
    connectorSourceSnapshotId: sourceSnapshot.connectorSourceSnapshotId,
    connectorSourceSnapshotHash: hash(sourceSnapshot),
    snapshotPayloadHash: sourceSnapshot.canonicalAllowlistedPayloadHash,
    progressDigest: hash(progress),
    snapshot: response,
    progress,
    resourceScope: sourceSnapshot.resourceScope,
    snapshotAudience: 'tenant_local:user_local',
    logicalModelPolicy: 'business.production.work-order-status.explanation' as const,
    promptPolicyVersionId: GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
    promptPolicyResolvedBytesSha256,
    routeProfile: 'codex_subscription_dev' as const,
    dataClass: 'C1' as const,
    toolChoice: 'none' as const,
    outputSchemaVersion: 'work-order.explanation/1' as const,
    maxOutputTokens: 512,
    deadline,
    systemPrompt,
  };
}

function modelResult(progress: GateA3WorkOrderProgress): GateA3ModelRuntimeResult {
  const request = modelRequest(progress);
  const { invocationToken: _token, systemPrompt: _systemPrompt, snapshot: _snapshot,
    progress: _progress, schemaVersion: _schema, ...authority } = request;
  void _token;
  void _systemPrompt;
  void _snapshot;
  void _progress;
  void _schema;
  return {
    output: explanation,
    receipt: gateA3WorkOrderModelReceiptSchema.parse({
      payload: {
        schemaVersion: 'gate-a3-work-order-model-receipt/2',
        ...authority,
        issuer: 'geneway-model-gateway',
        audience: 'geneway-control-plane-work-order',
        receiptJti: '33333333-3333-4333-8333-333333333333',
        outputPayloadDigest: hash(explanation),
        providerRevision: 'provider/1',
        modelRevision: 'model/1',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        outcome: 'completed',
        issuedAt: now,
      },
      signature: 'b'.repeat(43),
    }),
  };
}

const fetchGrant: GateA3FetchGrant = {
  step: { stepId: 'fetch_authorized_status', stepAttemptId: connectorReceipt.payload.attemptId, stepFence: 5 },
  connectorRequest,
};
const computeGrant: GateA3ComputeGrant = {
  step: { stepId: 'compute_progress', stepAttemptId: 'step-attempt-progress-1', stepFence: 6 },
  sourceSnapshot,
};
const evidenceGrant: GateA3EvidenceGrant = {
  step: { stepId: 'evidence_verify', stepAttemptId: 'step-attempt-evidence-1', stepFence: 8 },
};
const publishGrant: GateA3PublishGrant = {
  step: { stepId: 'publish_status_card', stepAttemptId: 'step-attempt-publish-1', stepFence: 9 },
  verifiedExplanation: explanation,
  evidenceRefs: {
    status: 'evidence-status',
    planQty: 'evidence-plan-qty',
    completedQty: 'evidence-completed-qty',
    updatedAt: 'evidence-updated-at',
    sourceAsOf: 'evidence-updated-at',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function port(overrides: Partial<GateA3WorkOrderCommandPort> = {}): GateA3WorkOrderCommandPort {
  const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
  return {
    claim: () => Promise.resolve(null),
    started: () => Promise.resolve(),
    validated: () => Promise.resolve(fetchGrant),
    connectorAccepted: () => Promise.resolve(computeGrant),
    connectorFailed: () => Promise.resolve({ retryScheduled: false }),
    progressComputed: () => Promise.resolve({
      step: { stepId: 'explain_status', stepAttemptId: 'step-attempt-explain-1', stepFence: 7 },
      modelRequest: modelRequest(progress),
    } satisfies GateA3ExplainGrant),
    explanationAccepted: () => Promise.resolve(evidenceGrant),
    evidenceVerified: () => Promise.resolve(publishGrant),
    published: () => Promise.resolve(),
    failed: () => Promise.resolve(),
    cancelRequested: () => Promise.resolve(null),
    canceled: () => Promise.resolve(),
    ...overrides,
  };
}

describe('Gate A.3 six-node Worker runtime', () => {
  it('binds the Connector Gateway request and completed receipt to the exact approved spec and response', async () => {
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(typeof init?.body).toBe('string');
      expect(JSON.parse(init?.body as string)).toEqual(connectorRequest);
      return Promise.resolve(new Response(JSON.stringify(connectorResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new GateA3ConnectorRuntimeAdapter(
      'http://127.0.0.1:3350',
      'connector-gateway-worker-service-token-0000000001',
    );
    await expect(runtime.execute(connectorRequest)).resolves.toEqual(connectorResult);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts only a Model Gateway receipt bound to the exact accepted snapshot and progress request', async () => {
    const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
    const request = modelRequest(progress);
    const result = modelResult(progress);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const runtime = new GateA3WorkOrderModelRuntimeAdapter(
      'http://127.0.0.1:3150',
      'model-gateway-worker-service-token-00000000000001',
    );
    await expect(runtime.execute(request)).resolves.toEqual(result);
  });

  it('rejects success receipts whose PromptPolicy digest drifts or whose payload leaks the prompt', async () => {
    const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
    const request = modelRequest(progress);
    const result = modelResult(progress);
    const runtime = new GateA3WorkOrderModelRuntimeAdapter(
      'http://127.0.0.1:3150',
      'model-gateway-worker-service-token-00000000000001',
    );
    for (const receipt of [
      { ...result.receipt, payload: {
        ...result.receipt.payload, promptPolicyResolvedBytesSha256: '0'.repeat(64),
      } },
      { ...result.receipt, payload: { ...result.receipt.payload, systemPrompt } },
    ]) {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
        output: result.output, receipt,
      }), { status: 200, headers: { 'content-type': 'application/json' } })));
      await expect(runtime.execute(request)).rejects.toMatchObject({
        errorClass: 'MODEL_PROTOCOL_VIOLATION',
      });
    }
  });

  it('rejects a signed-shape failure receipt whose PromptPolicy digest differs from the request', async () => {
    const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
    const request = modelRequest(progress);
    const completed = modelResult(progress).receipt;
    const { outputPayloadDigest: _outputPayloadDigest, providerRevision: _providerRevision,
      modelRevision: _modelRevision, usage: _usage, ...common } = completed.payload;
    void _outputPayloadDigest;
    void _providerRevision;
    void _modelRevision;
    void _usage;
    const receipt = gateA3WorkOrderModelReceiptSchema.parse({
      payload: {
        ...common,
        promptPolicyResolvedBytesSha256: '0'.repeat(64),
        outcome: 'MODEL_TIMEOUT',
        outputPayloadDigest: null,
        providerRevision: null,
        modelRevision: null,
        usage: null,
      },
      signature: completed.signature,
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({
      errorClass: 'MODEL_TIMEOUT', receipt,
    }), { status: 504, headers: { 'content-type': 'application/json' } })));
    const runtime = new GateA3WorkOrderModelRuntimeAdapter(
      'http://127.0.0.1:3150',
      'model-gateway-worker-service-token-00000000000001',
    );
    await expect(runtime.execute(request)).rejects.toMatchObject({
      errorClass: 'MODEL_PROTOCOL_VIOLATION',
    });
  });

  it('executes the fixed six nodes in order and publishes one deterministic card', async () => {
    const order: string[] = [];
    const connectorRuntime = {
      execute: vi.fn(() => { order.push('fetch_authorized_status'); return Promise.resolve(connectorResult); }),
    } as unknown as GateA3ConnectorRuntimeAdapter;
    const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
    const modelRuntime = {
      execute: vi.fn(() => { order.push('explain_status'); return Promise.resolve(modelResult(progress)); }),
    } as unknown as GateA3WorkOrderModelRuntimeAdapter;
    const published = vi.fn((_claim, _step, card, verifiedExplanation) => {
      order.push('publish_status_card');
      expect(gateA3WorkOrderStatusCardSchema.parse(card)).toEqual({
        schemaVersion: 'WorkOrderStatusCard/1',
        workOrderRef: response.workOrderRef,
        status: response.status,
        planQty: response.planQty,
        completedQty: response.completedQty,
        unit: response.unit,
        progressPct: 25,
        updatedAt: response.updatedAt,
        sourceAsOf: sourceSnapshot.sourceAsOf,
        evidenceRefs: publishGrant.evidenceRefs,
        readOnly: true,
      });
      expect(verifiedExplanation).toEqual(explanation);
      return Promise.resolve();
    });
    const commandPort = port({
      validated: (...args) => { order.push('validate_work_order_ref'); return port().validated(...args); },
      connectorAccepted: (...args) => { order.push('connector_checkpoint'); return port().connectorAccepted(...args); },
      progressComputed: (...args) => { order.push('compute_progress'); return port().progressComputed(...args); },
      explanationAccepted: (...args) => { order.push('explanation_checkpoint'); return port().explanationAccepted(...args); },
      evidenceVerified: (...args) => { order.push('evidence_verify'); return port().evidenceVerified(...args); },
      published,
    });
    await executeGateA3WorkOrderClaim(commandPort, connectorRuntime, modelRuntime, claim());
    expect(order).toEqual([
      'validate_work_order_ref', 'fetch_authorized_status', 'connector_checkpoint',
      'compute_progress', 'explain_status', 'explanation_checkpoint',
      'evidence_verify', 'publish_status_card',
    ]);
    expect(published).toHaveBeenCalledOnce();
  });

  it('delegates a transient connector failure to the durable Control Plane retry decision', async () => {
    const connectorFailed = vi.fn((_claim, step, error) => {
      expect(step).toEqual(fetchGrant.step);
      expect(error).toMatchObject({ errorClass: 'CONNECTOR_TIMEOUT' });
      return Promise.resolve({ retryScheduled: true as const, retryNotBefore: '2026-07-28T01:00:00.000Z' });
    });
    const failed = vi.fn(() => Promise.resolve());
    const published = vi.fn(() => Promise.resolve());
    await executeGateA3WorkOrderClaim(port({ connectorFailed, failed, published }), {
      execute: () => Promise.reject(new GateA3WorkOrderRuntimeError('CONNECTOR_TIMEOUT')),
    } as unknown as GateA3ConnectorRuntimeAdapter, {} as GateA3WorkOrderModelRuntimeAdapter, claim());
    expect(connectorFailed).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('fails invalid opaque refs before obtaining any connector grant or doing connector/model I/O', async () => {
    const validated = vi.fn(() => Promise.resolve(fetchGrant));
    const failed = vi.fn((failedClaim: GateA3WorkOrderWorkerClaim, error: Error) => {
      void failedClaim;
      void error;
      return Promise.resolve();
    });
    const connectorExecute = vi.fn(() => Promise.resolve(connectorResult));
    const modelExecute = vi.fn(() => Promise.resolve(modelResult(computeGateA3WorkOrderProgress(sourceSnapshot))));
    await executeGateA3WorkOrderClaim(
      port({ validated, failed }),
      { execute: connectorExecute } as unknown as GateA3ConnectorRuntimeAdapter,
      { execute: modelExecute } as unknown as GateA3WorkOrderModelRuntimeAdapter,
      claim('WO/invalid'),
    );
    expect(validated).not.toHaveBeenCalled();
    expect(connectorExecute).not.toHaveBeenCalled();
    expect(modelExecute).not.toHaveBeenCalled();
    expect(failed.mock.calls[0]?.[1]).toMatchObject({ errorClass: 'WORK_ORDER_REF_INVALID' });
  });

  it('does not request a model grant until the accepted snapshot and deterministic progress are checkpointed', async () => {
    const order: string[] = [];
    const commandPort = port({
      connectorAccepted: () => { order.push('snapshot-accepted'); return Promise.resolve(computeGrant); },
      progressComputed: (...args) => {
        order.push('progress-accepted');
        return port().progressComputed(...args);
      },
    });
    const connectorRuntime = {
      execute: () => { order.push('connector-io'); return Promise.resolve(connectorResult); },
    } as unknown as GateA3ConnectorRuntimeAdapter;
    const modelRuntime = {
      execute: () => {
        order.push('model-io');
        return Promise.resolve(modelResult(computeGateA3WorkOrderProgress(sourceSnapshot)));
      },
    } as unknown as GateA3WorkOrderModelRuntimeAdapter;
    await executeGateA3WorkOrderClaim(commandPort, connectorRuntime, modelRuntime, claim());
    expect(order).toEqual(['connector-io', 'snapshot-accepted', 'progress-accepted', 'model-io']);
  });

  it('reuses a Control Plane accepted explanation after reclaim without a second model invocation', async () => {
    const progress = computeGateA3WorkOrderProgress(sourceSnapshot);
    const modelExecute = vi.fn(() => Promise.resolve(modelResult(progress)));
    const explanationAccepted = vi.fn(() => Promise.resolve(evidenceGrant));
    const evidenceVerified = vi.fn((_claim, step, acceptedExplanation) => {
      expect(step).toEqual(evidenceGrant.step);
      expect(acceptedExplanation).toEqual(explanation);
      return Promise.resolve(publishGrant);
    });
    await executeGateA3WorkOrderClaim(port({
      connectorAccepted: () => Promise.resolve({ ...computeGrant, reused: true }),
      progressComputed: () => Promise.resolve({ step: evidenceGrant.step, acceptedExplanation: explanation }),
      explanationAccepted,
      evidenceVerified,
    }), {
      execute: () => Promise.resolve(connectorResult),
    } as unknown as GateA3ConnectorRuntimeAdapter, {
      execute: modelExecute,
    } as unknown as GateA3WorkOrderModelRuntimeAdapter, claim());
    expect(modelExecute).not.toHaveBeenCalled();
    expect(explanationAccepted).not.toHaveBeenCalled();
    expect(evidenceVerified).toHaveBeenCalledOnce();
  });

  it.each([
    [{ planQty: null, completedQty: 10 }, 'missing_quantity'],
    [{ planQty: 0, completedQty: 0 }, 'zero_plan'],
    [{ planQty: 10, completedQty: 11 }, 'completed_exceeds_plan'],
  ] as const)('returns null progress for non-computable quantities: %o', (quantities, calculationStatus) => {
    const altered = gateA3ConnectorSourceSnapshotSchema.parse({
      ...sourceSnapshot,
      canonicalAllowlistedPayload: { ...response, ...quantities },
    });
    expect(computeGateA3WorkOrderProgress(altered)).toMatchObject({ progressPct: null, calculationStatus });
  });

  it('cancels an in-flight connector/model step and never publishes or reports a second failed terminal', async () => {
    let polls = 0;
    const canceled = vi.fn(() => Promise.resolve());
    const failed = vi.fn(() => Promise.resolve());
    const published = vi.fn(() => Promise.resolve());
    const connectorRuntime = {
      execute: (_request: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('connector aborted')), { once: true });
      }),
    } as unknown as GateA3ConnectorRuntimeAdapter;
    await executeGateA3WorkOrderClaim(port({
      cancelRequested: () => Promise.resolve(++polls === 1 ? { taskFence: 4 } : null),
      canceled,
      failed,
      published,
    }), connectorRuntime, {} as GateA3WorkOrderModelRuntimeAdapter, claim());
    expect(canceled).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('does not overwrite a late publish CAS rejection after reclaim with a failed result', async () => {
    const failed = vi.fn(() => Promise.resolve());
    const authorityLoss = new GenewayError('STALE_STEP_COMPLETION', 'new attempt already owns this effect', 409);
    await expect(executeGateA3WorkOrderClaim(
      port({ published: () => Promise.reject(authorityLoss), failed }),
      { execute: () => Promise.resolve(connectorResult) } as unknown as GateA3ConnectorRuntimeAdapter,
      { execute: () => Promise.resolve(modelResult(computeGateA3WorkOrderProgress(sourceSnapshot))) } as unknown as GateA3WorkOrderModelRuntimeAdapter,
      claim(),
    )).rejects.toBe(authorityLoss);
    expect(failed).not.toHaveBeenCalled();
  });
});
