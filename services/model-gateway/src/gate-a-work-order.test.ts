import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
  canonicalizeGateA3Jcs,
  gateA3WorkOrderExplanationSchema,
} from '@geneway/contracts';
import {
  digestGateA3WorkOrderModelValue,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
  registerGateA3WorkOrderRoute,
  type GateA3WorkOrderModelRequest,
  type GateA3WorkOrderModelTokenClaims,
  type GateA3WorkOrderProviderResult,
} from './gate-a-work-order.js';

const serviceToken = 'gate-a3-model-gateway-service-token-0000000000001';
const invocationSecret = 'gate-a3-model-gateway-invocation-secret-0000000001';
const receiptSecret = 'gate-a3-model-gateway-receipt-secret-0000000000001';
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const systemPrompt = '你是小纬的工单说明后端。只解释已验证的只读工单快照和确定性进度；不得补造、修改状态或数量，不得调用工具、联网或输出内部连接信息。仅输出 work-order.explanation/1。';
const promptPolicyResolvedBytesSha256 = hash(systemPrompt);

const snapshot = Object.freeze({
  workOrderRef: 'WO-2026-0001',
  status: 'running',
  planQty: 100,
  completedQty: 25,
  unit: '件',
  plannedStart: '2026-07-27T01:00:00.000000Z',
  plannedEnd: '2026-07-27T10:00:00.000000Z',
  updatedAt: '2026-07-27T04:00:00.000000Z',
  sourceRevision: 'revision-7',
});

const progress = Object.freeze({
  schemaVersion: 'work-order.progress/1' as const,
  planQty: 100,
  completedQty: 25,
  progressPct: 25,
  calculationStatus: 'computed' as const,
});

const validOutput = Object.freeze({
  schemaVersion: 'work-order.explanation/1' as const,
  summary: '该工单当前处于执行中，确定性进度为 25%。',
  statements: [
    { id: 'statement-status', kind: 'fact' as const, text: '工单当前处于执行中。', sourceFields: ['status'] as const },
    { id: 'statement-progress', kind: 'inference' as const, text: '确定性进度为 25%。',
      sourceFields: ['planQty', 'completedQty', 'progressPct'] as const },
  ],
});

function tokenClaims(overrides: Readonly<Record<string, unknown>> = {}): GateA3WorkOrderModelTokenClaims {
  const now = Math.floor(Date.now() / 1_000);
  return gateA3WorkOrderModelTokenClaimsSchema.parse({
    schemaVersion: 'gate-a3-work-order-model-token/2',
    iss: 'geneway-control-plane',
    aud: 'local-model-gateway-work-order-explanation',
    tenantId: 'tenant_local',
    principalId: 'user_local',
    taskId: 'task-work-order-1',
    workflowVersionId: 'workflow-work-order-1',
    workflowHash: hash('workflow'),
    executionAttemptId: 'execution-attempt-1',
    taskFence: 3,
    stepId: 'explain_status',
    stepAttemptId: 'step-attempt-explain-1',
    stepFence: 6,
    modelInvocationId: 'model-invocation-work-order-1',
    approvalSubjectDigest: hash('approval'),
    capabilityVersionId: 'cap_production_work_order_status_v1_1',
    effectId: 'effect-work-order-1',
    connectorQuerySpecHash: hash('query-spec'),
    connectorSourceSnapshotId: 'snapshot-work-order-1',
    connectorSourceSnapshotHash: hash('snapshot'),
    snapshotPayloadHash: digestGateA3WorkOrderModelValue(snapshot),
    progressDigest: digestGateA3WorkOrderModelValue(progress),
    resourceScope: 'gearjob-work-order:connector-query-spec-bound',
    snapshotAudience: 'tenant_local:user_local',
    logicalModelPolicy: 'business.production.work-order-status.explanation',
    promptPolicyVersionId: GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
    promptPolicyResolvedBytesSha256,
    routeProfile: 'codex_subscription_dev',
    dataClass: 'C1',
    toolChoice: 'none',
    outputSchemaVersion: 'work-order.explanation/1',
    maxOutputTokens: 512,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...overrides,
  });
}

function signToken(claims: GateA3WorkOrderModelTokenClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', invocationSecret).update(encoded, 'utf8').digest('base64url');
  return `${encoded}.${signature}`;
}

function modelRequest(claims = tokenClaims(), overrides: Readonly<Record<string, unknown>> = {}): GateA3WorkOrderModelRequest {
  const { schemaVersion: _schemaVersion, iss: _iss, aud: _aud, jti: _jti, iat: _iat, exp: _exp, ...authority } = claims;
  void _schemaVersion;
  void _iss;
  void _aud;
  void _jti;
  void _iat;
  void _exp;
  return {
    schemaVersion: 'gate-a3-work-order-model-request/2',
    invocationToken: signToken(claims),
    ...authority,
    systemPrompt,
    snapshot,
    progress,
    ...overrides,
  };
}

function buildApp(input: Readonly<{
  provider?: (value: Parameters<NonNullable<Parameters<typeof registerGateA3WorkOrderRoute>[1]['providerCallForTest']>>[0]) => Promise<GateA3WorkOrderProviderResult>;
  authorize?: (claims: GateA3WorkOrderModelTokenClaims) => Promise<boolean>;
  warningLog?: unknown[];
}> = {}) {
  const warningStream = input.warningLog === undefined ? undefined : new Writable({
    write(chunk: unknown, _encoding, callback) {
      const warning: unknown = JSON.parse(typeof chunk === 'string' ? chunk : String(chunk));
      input.warningLog?.push(warning);
      callback();
    },
  });
  const app = Fastify(warningStream === undefined
    ? { logger: false }
    : { logger: { level: 'warn', stream: warningStream } });
  registerGateA3WorkOrderRoute(app, {
    serviceToken,
    invocationSecret,
    receiptSecret,
    controlPlaneUrl: 'http://127.0.0.1:3100',
    resolveReadiness: () => Promise.resolve({
      ready: true,
      authFilePath: '/not-read-in-tests',
      model: 'gpt-5.4-mini',
      manifestDigest: hash('manifest'),
    }),
    acquireProviderSlot: () => true,
    releaseProviderSlot: () => undefined,
    authorizeInvocationForTest: input.authorize ?? (() => Promise.resolve(true)),
    providerCallForTest: input.provider ?? (() => Promise.resolve({
      output: validOutput,
      providerRevision: 'test-provider/1',
      modelRevision: 'test-model/1',
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      toolCallCount: 0,
    })),
  });
  return app;
}

async function inject(app: ReturnType<typeof buildApp>, request: Readonly<Record<string, unknown>>) {
  return app.inject({
    method: 'POST',
    url: '/internal/model-gateway/v1/work-order-explanation',
    headers: { authorization: `Bearer ${serviceToken}` },
    payload: request,
  });
}

describe('Gate A.3 work-order Model Gateway route', () => {
  it('introspects current authority before provider I/O and exposes only snapshot plus deterministic progress', async () => {
    const order: string[] = [];
    const authorize = vi.fn(() => {
      order.push('introspect');
      return Promise.resolve(true);
    });
    const provider = vi.fn((input: Parameters<NonNullable<Parameters<typeof registerGateA3WorkOrderRoute>[1]['providerCallForTest']>>[0]) => {
      order.push('provider');
      expect(input.providerInput).toEqual({ snapshot, progress });
      expect(input.systemPrompt).toBe(systemPrompt);
      expect(hash(input.systemPrompt)).toBe(input.promptPolicyResolvedBytesSha256);
      expect(input.promptPolicyResolvedBytesSha256).toBe(request.promptPolicyResolvedBytesSha256);
      expect(Object.keys(input.providerInput).sort()).toEqual(['progress', 'snapshot']);
      expect(JSON.stringify(input.providerInput)).not.toContain('invocationToken');
      expect(JSON.stringify(input.providerInput)).not.toContain('connectorQuerySpecHash');
      return Promise.resolve({
        output: validOutput,
        providerRevision: 'test-provider/1',
        modelRevision: 'test-model/1',
        usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        toolCallCount: 0,
      });
    });
    const request = modelRequest();
    const response = await inject(buildApp({ authorize, provider }), request);
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['introspect', 'provider']);
    const payload = response.json<Readonly<Record<string, unknown>>>();
    expect(gateA3WorkOrderExplanationSchema.parse(payload.output)).toEqual(validOutput);
    const receipt = gateA3WorkOrderModelReceiptSchema.parse(payload.receipt);
    expect(receipt.payload).toMatchObject({
      outcome: 'completed',
      audience: 'geneway-control-plane-work-order',
      logicalModelPolicy: 'business.production.work-order-status.explanation',
      connectorSourceSnapshotId: request.connectorSourceSnapshotId,
      outputPayloadDigest: digestGateA3WorkOrderModelValue(validOutput),
    });
    expect(receipt.signature).toBe(createHmac('sha256', receiptSecret)
      .update(canonicalizeGateA3Jcs(receipt.payload), 'utf8').digest('base64url'));
    expect(receipt.signature).not.toBe(createHmac('sha256', invocationSecret)
      .update(canonicalizeGateA3Jcs(receipt.payload), 'utf8').digest('base64url'));
  });

  it('accepts realistic provider success usage and labels only explanation Zod failures as output failures', async () => {
    const realisticUsage = { inputTokens: 1_947, outputTokens: 213, totalTokens: 2_160 };
    const successWarnings: unknown[] = [];
    const success = await inject(buildApp({
      warningLog: successWarnings,
      provider: () => Promise.resolve({
        output: validOutput,
        providerRevision: '@openai-oauth/ai-sdk@2.0.0',
        modelRevision: 'gpt-5.4-mini',
        usage: realisticUsage,
        toolCallCount: 0,
      }),
    }), modelRequest());
    expect(success.statusCode).toBe(200);
    const successReceipt = gateA3WorkOrderModelReceiptSchema.parse(
      success.json<Readonly<Record<string, unknown>>>().receipt,
    );
    expect(successReceipt.payload.usage).toEqual(realisticUsage);
    expect(Object.keys(successReceipt.payload.usage ?? {}).sort()).toEqual([
      'inputTokens', 'outputTokens', 'totalTokens',
    ]);
    expect(successWarnings).toEqual([]);

    const receiptWarnings: unknown[] = [];
    const strictReceipt = await inject(buildApp({
      warningLog: receiptWarnings,
      provider: () => Promise.resolve({
        output: validOutput,
        providerRevision: '@openai-oauth/ai-sdk@2.0.0',
        modelRevision: 'gpt-5.4-mini',
        usage: { ...realisticUsage, pricing: 'unpriced' },
        toolCallCount: 0,
      }),
    }), modelRequest());
    expect(strictReceipt.statusCode).toBe(502);
    expect(gateA3WorkOrderModelReceiptSchema.parse(
      strictReceipt.json<Readonly<Record<string, unknown>>>().receipt,
    ).payload.outcome)
      .toBe('MODEL_PROTOCOL_VIOLATION');
    expect(receiptWarnings).toEqual([]);

    const outputWarnings: unknown[] = [];
    const invalidOutput = await inject(buildApp({
      warningLog: outputWarnings,
      provider: () => Promise.resolve({
        output: { ...validOutput, progressPct: 100 },
        providerRevision: '@openai-oauth/ai-sdk@2.0.0',
        modelRevision: 'gpt-5.4-mini',
        usage: realisticUsage,
        toolCallCount: 0,
      }),
    }), modelRequest());
    expect(invalidOutput.statusCode).toBe(502);
    expect(outputWarnings).toHaveLength(1);
    expect(outputWarnings[0]).toMatchObject({
      errorClass: 'MODEL_PROTOCOL_VIOLATION',
      msg: 'Gate A.3 provider output failed the private explanation schema',
    });
  });

  it('fails closed for every provider-visible private explanation semantic', async () => {
    const fact = { id: 'fact-1', kind: 'fact', text: '状态已验证。', sourceFields: ['status'] };
    const progressStatement = { id: 'progress-1', kind: 'inference', text: '进度为 25%。',
      sourceFields: ['planQty', 'completedQty', 'progressPct'] };
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['fact-empty', { ...fact, sourceFields: [] }],
      ['unknown-sourced', { ...fact, kind: 'unknown', sourceFields: ['status'] }],
      ['progress-only', { ...progressStatement, sourceFields: ['progressPct'] }],
      ['progress-plan-only', { ...progressStatement, sourceFields: ['planQty', 'progressPct'] }],
      ['progress-completed-only', { ...progressStatement, sourceFields: ['completedQty', 'progressPct'] }],
      ['duplicate-source-fields', { ...fact, sourceFields: ['status', 'status'] }],
      ['duplicate-statement-ids', [fact, { ...progressStatement, id: fact.id }]],
    ];
    for (const [label, invalid] of cases) {
      const statements = Array.isArray(invalid) ? invalid : [invalid];
      const provider = vi.fn(() => Promise.resolve({
        output: { schemaVersion: 'work-order.explanation/1', summary: '受限说明。', statements },
        providerRevision: 'test-provider/1', modelRevision: 'test-model/1',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, toolCallCount: 0,
      }));
      const response = await inject(buildApp({ provider }), modelRequest());
      expect(response.statusCode, label).toBe(502);
      const body = response.json<Readonly<Record<string, unknown>>>();
      const receipt = gateA3WorkOrderModelReceiptSchema.parse(body.receipt);
      expect(receipt.payload.outcome, label).toBe('MODEL_PROTOCOL_VIOLATION');
      expect(receipt.payload.outputPayloadDigest, label).toBeNull();
      expect(body, label).not.toHaveProperty('output');
      expect(JSON.stringify(receipt), label).not.toContain(systemPrompt);
      expect(provider, label).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses to register when token verification and receipt signing share a secret', () => {
    const app = Fastify({ logger: false });
    expect(() => registerGateA3WorkOrderRoute(app, {
      serviceToken,
      invocationSecret,
      receiptSecret: invocationSecret,
      controlPlaneUrl: 'http://127.0.0.1:3100',
      resolveReadiness: () => Promise.resolve({
        ready: true, authFilePath: '/not-read-in-tests', model: 'gpt-5.4-mini', manifestDigest: hash('manifest'),
      }),
      acquireProviderSlot: () => true,
      releaseProviderSlot: () => undefined,
    })).toThrow(/must be distinct/u);
  });

  it('cross-rejects an A.2 analysis token before introspection or provider I/O', async () => {
    const authorize = vi.fn(() => Promise.resolve(true));
    const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
    const request = modelRequest();
    const analysisClaims = {
      schemaVersion: 'gate-a-analysis-invocation-token/2',
      iss: 'geneway-control-plane',
      aud: 'local-model-gateway-analysis',
      jti: randomUUID(),
    };
    const encoded = Buffer.from(JSON.stringify(analysisClaims), 'utf8').toString('base64url');
    const signature = createHmac('sha256', invocationSecret).update(encoded, 'utf8').digest('base64url');
    const response = await inject(buildApp({ authorize, provider }), {
      ...request,
      invocationToken: `${encoded}.${signature}`,
    });
    expect(response.statusCode).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects snapshot or progress drift before introspection with zero provider I/O', async () => {
    const authorize = vi.fn(() => Promise.resolve(true));
    const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
    const request = modelRequest();
    const response = await inject(buildApp({ authorize, provider }), {
      ...request,
      snapshot: { ...request.snapshot, completedQty: 26 },
    });
    expect(response.statusCode).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects prompt bytes authority drift before introspection with zero provider I/O', async () => {
    const authorize = vi.fn(() => Promise.resolve(true));
    const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
    const driftedPromptDigest = hash('drifted prompt bytes');
    const driftedClaims = { ...tokenClaims(), promptPolicyResolvedBytesSha256: driftedPromptDigest };
    const encoded = Buffer.from(JSON.stringify(driftedClaims), 'utf8').toString('base64url');
    const invocationToken = `${encoded}.${createHmac('sha256', invocationSecret)
      .update(encoded, 'utf8').digest('base64url')}`;
    const response = await inject(buildApp({ authorize, provider }), {
      ...modelRequest(), promptPolicyResolvedBytesSha256: driftedPromptDigest, invocationToken,
    });
    expect(response.statusCode).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects system prompt tampering before introspection with zero provider I/O', async () => {
    const authorize = vi.fn(() => Promise.resolve(true));
    const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
    const response = await inject(buildApp({ authorize, provider }), {
      ...modelRequest(), systemPrompt: `${systemPrompt}\n被篡改`,
    });
    expect(response.statusCode).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not perform provider I/O when Control Plane current-authority introspection rejects the token', async () => {
    const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
    const response = await inject(buildApp({ authorize: () => Promise.resolve(false), provider }), modelRequest());
    expect(response.statusCode).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects tools and any output that tries to mutate card authority', async () => {
    const toolResponse = await inject(buildApp({
      provider: () => Promise.resolve({
        output: validOutput,
        providerRevision: 'test-provider/1', modelRevision: 'test-model/1', usage: {}, toolCallCount: 1,
      }),
    }), modelRequest());
    expect(toolResponse.statusCode).toBe(502);
    expect(gateA3WorkOrderModelReceiptSchema.parse(
      toolResponse.json<Readonly<Record<string, unknown>>>().receipt,
    ).payload.outcome)
      .toBe('MODEL_PROTOCOL_VIOLATION');

    const mutationResponse = await inject(buildApp({
      provider: () => Promise.resolve({
        output: { ...validOutput, status: 'completed', planQty: 999, progressPct: 100 },
        providerRevision: 'test-provider/1', modelRevision: 'test-model/1', usage: {}, toolCallCount: 0,
      }),
    }), modelRequest());
    expect(mutationResponse.statusCode).toBe(502);
    expect(gateA3WorkOrderModelReceiptSchema.parse(
      mutationResponse.json<Readonly<Record<string, unknown>>>().receipt,
    ).payload.outcome)
      .toBe('MODEL_PROTOCOL_VIOLATION');
  });
});
