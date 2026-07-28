import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GATE_A3_CANONICALIZATION_VERSION,
  GATE_A3_CONNECTOR_PROFILE_VERSION,
  GATE_A3_FIELD_MASK_VERSION,
  GATE_A3_GEARJOB_ENDPOINT,
  GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
  GATE_A3_WORK_ORDER_FIELD_MASK,
  canonicalizeGateA3Jcs,
  digestGateA3Jcs,
  digestGateA3PromptPolicyResolvedBytes,
  gateA3ConnectorCurrentAuthorityResponseSchema,
  gateA3ConnectorEvidenceFieldSchema,
  gateA3ConnectorEvidenceLocatorSchema,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorInvocationTokenClaimsSchema,
  gateA3ConnectorQuerySpecSchema,
  gateA3ConnectorSourceSnapshotSchema,
  gateA3ConnectorWorkOrderResponseSchema,
  gateA3CreateTaskInputVariantSchema,
  gateA3EvidenceSourceRevocationInputSchema,
  gateA3EvidenceSourceRevocationResponseSchema,
  gateA3IsoDateTimeSchema,
  gateA3PublicEvidenceProjectionSchema,
  gateA3PublicTaskSnapshotSchema,
  gateA3SourceIsoDateTimeSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelReceiptV1Schema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderModelRequestV1Schema,
  gateA3WorkOrderModelTokenClaimsSchema,
  gateA3WorkOrderModelTokenClaimsV1Schema,
  gateA3WorkOrderProgressSchema,
  gateA3WorkOrderStatusCardSchema,
} from './gate-a3-work-order.js';

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
const now = '2026-07-27T01:02:03.004Z';
const sourceNow = '2026-07-27T01:02:03.004000Z';

function tokenIdentity(value: typeof claims): Omit<typeof claims, 'schemaVersion' | 'iss' | 'aud' | 'iat' | 'exp'> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => (
    !['schemaVersion', 'iss', 'aud', 'iat', 'exp'].includes(key)
  ))) as Omit<typeof claims, 'schemaVersion' | 'iss' | 'aud' | 'iat' | 'exp'>;
}

const querySpec = {
  schemaVersion: 'connector-query-spec/1',
  canonicalizationVersion: GATE_A3_CANONICALIZATION_VERSION,
  specId: 'spec.1',
  capabilityVersionId: 'cap_production_work_order_status_v1_1',
  releaseRecordId: 'release.1',
  approvedPreflightDigest: digest,
  connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
  baseUrl: 'http://127.0.0.1:8100',
  endpoint: GATE_A3_GEARJOB_ENDPOINT,
  method: 'GET',
  endpointMethodAllowlistDigest: digest,
  fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
  fieldMask: [...GATE_A3_WORK_ORDER_FIELD_MASK],
  workOrderRef: 'WO_2026-0001:REV.2',
  tenantId: 'tenant_local',
  principal: 'user_local',
  resourceContextDigest: digest,
  workflowVersionId: 'workflow.1',
  workflowHash: digest,
  stepId: 'fetch_authorized_status',
  budget: { maxAttempts: 2, timeoutMs: 2_000 },
  deadline: now,
  publicErrorPolicyVersion: 'gearjob.not-found-forbidden-equivalent/1',
  cardSchemaVersion: 'WorkOrderStatusCard/1',
} as const;

const response = {
  workOrderRef: querySpec.workOrderRef,
  status: 'RUNNING',
  planQty: 100,
  completedQty: 40,
  unit: '件',
  plannedStart: '2026-07-27T00:00:00.000000Z',
  plannedEnd: null,
  updatedAt: sourceNow,
  sourceRevision: 'revision.7',
} as const;

const claims = {
  schemaVersion: 'connector-invocation-token/1',
  iss: 'geneway-control-plane',
  aud: 'gearjob-work-order-status-connector',
  tenantId: querySpec.tenantId,
  principal: querySpec.principal,
  taskId: 'task.1',
  workflowVersionId: querySpec.workflowVersionId,
  workflowHash: querySpec.workflowHash,
  stepId: 'fetch_authorized_status',
  attemptId: 'attempt.1',
  effectId: 'effect.1',
  connectorInvocationId: '11111111-1111-4111-8111-111111111111',
  connectorQuerySpecHash: digest,
  connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
  workOrderRefHash: otherDigest,
  fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
  resourceContextDigest: querySpec.resourceContextDigest,
  deadline: now,
  fence: 1,
  jti: '22222222-2222-4222-8222-222222222222',
  iat: 1_800_000_000,
  exp: 1_800_000_060,
} as const;

describe('Gate A.3 work-order contracts', () => {
  it('accepts only the opaque public single-work-order input variant', () => {
    expect(gateA3CreateTaskInputVariantSchema.parse({
      conversationId: 'conversation.1',
      capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: response.workOrderRef },
    })).toBeDefined();
    for (const workOrderRef of ['', 'a'.repeat(129), '/orders/1', 'https://gearjob/orders/1', 'WO 1', '工单-1', 'WO?include=customer']) {
      expect(gateA3CreateTaskInputVariantSchema.safeParse({
        conversationId: 'conversation.1', capabilityId: 'production.work-order-status.v1',
        inputRef: { kind: 'work_order', workOrderRef },
      }).success, workOrderRef).toBe(false);
    }
    for (const extra of ['endpoint', 'method', 'profile', 'fieldMask', 'tenantId', 'principalId', 'budget', 'expertTarget']) {
      expect(gateA3CreateTaskInputVariantSchema.safeParse({
        conversationId: 'conversation.1', capabilityId: 'production.work-order-status.v1',
        inputRef: { kind: 'work_order', workOrderRef: response.workOrderRef }, [extra]: 'forbidden',
      }).success, extra).toBe(false);
    }
  });

  it('parses a complete immutable QuerySpec and rejects wrapper, type, policy and loopback drift', () => {
    expect(gateA3ConnectorQuerySpecSchema.parse(querySpec)).toEqual(querySpec);
    const mutations: unknown[] = [
      { ...querySpec, extra: true },
      { ...querySpec, method: 'POST' },
      { ...querySpec, endpoint: `${querySpec.endpoint}/` },
      { ...querySpec, baseUrl: 'http://localhost:3165' },
      { ...querySpec, baseUrl: 'http://127.0.0.1:3165/path' },
      { ...querySpec, fieldMask: [...querySpec.fieldMask].reverse() },
      { ...querySpec, budget: { ...querySpec.budget, timeoutMs: Number.POSITIVE_INFINITY } },
      { ...querySpec, workOrderRef: ['WO-1'] },
      [querySpec],
      { querySpec },
    ];
    for (const mutation of mutations) expect(gateA3ConnectorQuerySpecSchema.safeParse(mutation).success).toBe(false);
  });

  it('canonicalizes parsed values using JCS ordering and rejects non-JSON/non-finite values', async () => {
    expect(canonicalizeGateA3Jcs({ z: 1, a: 'x', nested: { b: true, a: null } }))
      .toBe('{"a":"x","nested":{"a":null,"b":true},"z":1}');
    expect(await digestGateA3Jcs({ b: 2, a: 1 })).toMatch(/^[a-f0-9]{64}$/u);
    expect(await digestGateA3Jcs({ b: 2, a: 1 })).toBe(await digestGateA3Jcs({ a: 1, b: 2 }));
    for (const invalid of [
      undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, { value: undefined },
      [1, Number.NEGATIVE_INFINITY], '\uD800', { ['\uDC00']: true },
    ]) {
      expect(() => canonicalizeGateA3Jcs(invalid)).toThrow();
    }
  });

  it('accepts exactly the nine allowlisted response fields', () => {
    expect(Object.keys(gateA3ConnectorWorkOrderResponseSchema.parse(response))).toHaveLength(9);
    expect(gateA3ConnectorWorkOrderResponseSchema.safeParse({ ...response, customerName: 'secret' }).success).toBe(false);
    expect(gateA3ConnectorWorkOrderResponseSchema.safeParse({ ...response, status: '\uD800' }).success).toBe(false);
    expect(gateA3ConnectorWorkOrderResponseSchema.safeParse([response]).success).toBe(false);
    expect(gateA3ConnectorWorkOrderResponseSchema.safeParse({ data: response }).success).toBe(false);
    expect(gateA3ConnectorWorkOrderResponseSchema.safeParse({ items: [response, response] }).success).toBe(false);
    for (const key of Object.keys(response)) {
      const missing = { ...response } as Record<string, unknown>;
      delete missing[key];
      expect(gateA3ConnectorWorkOrderResponseSchema.safeParse(missing).success, key).toBe(false);
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, '40']) {
      expect(gateA3ConnectorWorkOrderResponseSchema.safeParse({ ...response, completedQty: invalid }).success).toBe(false);
    }
  });

  it('enforces one ISO representation without timezone or precision rewriting', () => {
    expect(gateA3IsoDateTimeSchema.parse(now)).toBe(now);
    for (const invalid of [
      '2026-07-27T01:02:03Z', '2026-07-27T09:02:03.004+08:00',
      '2026-07-27 01:02:03.004Z', '2026-02-30T01:02:03.004Z', 'not-a-date',
    ]) expect(gateA3IsoDateTimeSchema.safeParse(invalid).success, invalid).toBe(false);
    expect(gateA3SourceIsoDateTimeSchema.parse(sourceNow)).toBe(sourceNow);
    expect(gateA3SourceIsoDateTimeSchema.safeParse(now).success).toBe(false);
  });

  it('binds each evidence field name to its response type and canonical value', () => {
    const field = {
      schemaVersion: 'connector-evidence-field/1',
      canonicalizationVersion: GATE_A3_CANONICALIZATION_VERSION,
      fieldName: 'completedQty', fieldType: 'number_or_null', canonicalValue: 40,
    };
    expect(gateA3ConnectorEvidenceFieldSchema.parse(field)).toEqual(field);
    expect(gateA3ConnectorEvidenceFieldSchema.safeParse({ ...field, fieldType: 'string' }).success).toBe(false);
    expect(gateA3ConnectorEvidenceFieldSchema.safeParse({ ...field, fieldName: 'customerName' }).success).toBe(false);
    expect(gateA3ConnectorEvidenceFieldSchema.safeParse({ ...field, canonicalValue: '40' }).success).toBe(false);
    expect(gateA3ConnectorEvidenceFieldSchema.safeParse({ ...field, rawValue: 40 }).success).toBe(false);
    const publicEvidenceBase = {
      id: 'evidence.1', kind: 'connector_snapshot_field', sourceRevision: response.sourceRevision,
      sourceAsOf: response.updatedAt, dataClass: 'C1', readOnly: true,
    } as const;
    expect(gateA3PublicEvidenceProjectionSchema.safeParse({
      ...publicEvidenceBase, fieldName: 'completedQty', value: 40,
    }).success).toBe(true);
    for (const projection of [
      { ...publicEvidenceBase, fieldName: 'completedQty', value: '40' },
      { ...publicEvidenceBase, fieldName: 'updatedAt', value: 40 },
      { ...publicEvidenceBase, fieldName: 'status', value: null },
      { ...publicEvidenceBase, fieldName: 'customerName', value: 'secret' },
    ]) expect(gateA3PublicEvidenceProjectionSchema.safeParse(projection).success).toBe(false);
    expect(gateA3EvidenceSourceRevocationInputSchema.parse({ reasonCode: 'user_requested' }))
      .toEqual({ reasonCode: 'user_requested' });
    expect(gateA3EvidenceSourceRevocationInputSchema.safeParse({ reasonCode: 'operator_requested' }).success)
      .toBe(false);
    expect(gateA3EvidenceSourceRevocationResponseSchema.parse({ revoked: true })).toEqual({ revoked: true });
    expect(gateA3EvidenceSourceRevocationResponseSchema.safeParse({ revoked: false }).success).toBe(false);
  });

  it('requires complete token and current-authority identities and a short token TTL', () => {
    expect(gateA3ConnectorInvocationTokenClaimsSchema.parse(claims)).toEqual(claims);
    expect(gateA3ConnectorInvocationTokenClaimsSchema.safeParse({ ...claims, exp: claims.iat }).success).toBe(false);
    expect(gateA3ConnectorInvocationTokenClaimsSchema.safeParse({ ...claims, exp: claims.iat + 61 }).success).toBe(false);
    for (const mutation of [
      { ...claims, iss: 'worker' }, { ...claims, aud: 'local-model-gateway' },
      { ...claims, fence: 0 }, { ...claims, connectorProfileVersion: 'drift' },
      { ...claims, connectorInvocationId: 'not-a-uuid' }, { ...claims, jti: 'not-a-uuid' },
      { ...claims, extra: true },
    ]) expect(gateA3ConnectorInvocationTokenClaimsSchema.safeParse(mutation).success).toBe(false);
    expect(gateA3ConnectorCurrentAuthorityResponseSchema.parse({
      schemaVersion: 'gate-a3-connector-current-authority-response/1', active: true, checkedAt: now, ...tokenIdentity(claims),
    })).toBeDefined();
    expect(gateA3ConnectorCurrentAuthorityResponseSchema.safeParse({ active: true }).success).toBe(false);
  });

  it('keeps Gateway request and signed receipt wrappers strict', () => {
    expect(gateA3ConnectorGatewayRequestSchema.parse({
      schemaVersion: 'gate-a3-connector-gateway-request/1', invocationToken: 'x'.repeat(40),
      querySpec, querySpecHash: digest,
    })).toBeDefined();
    const payload = {
      schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
      audience: 'geneway-control-plane', receiptJti: 'receipt.1',
      ...tokenIdentity(claims), issuedAt: now, outcome: 'completed', responseRefMatched: true,
      sourceRevision: response.sourceRevision, responseCanonicalHash: digest,
    };
    expect(gateA3ConnectorGatewayReceiptSchema.parse({
      payload,
      signature: 'x'.repeat(43),
    })).toBeDefined();
    expect(gateA3ConnectorGatewayReceiptSchema.safeParse({ payload, signature: 'short', extra: true }).success).toBe(false);
  });

  it('validates immutable snapshot and field/whole evidence variants', () => {
    const snapshot = {
      schemaVersion: 'connector-source-snapshot/1', canonicalizationVersion: GATE_A3_CANONICALIZATION_VERSION,
      connectorSourceSnapshotId: 'snapshot.1', tenantId: claims.tenantId, principal: claims.principal,
      taskId: claims.taskId, connectorInvocationId: claims.connectorInvocationId, effectId: claims.effectId,
      attemptId: claims.attemptId, fence: claims.fence, connectorQuerySpecHash: digest,
      workOrderRefHash: claims.workOrderRefHash, responseRefMatched: true,
      fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION, sourceRevision: response.sourceRevision, sourceAsOf: response.updatedAt,
      canonicalAllowlistedPayload: response, canonicalAllowlistedPayloadHash: digest,
      resourceScope: 'gearjob-work-order:connector-query-spec-bound', dataClass: 'C1',
      audience: { tenantId: claims.tenantId, principal: claims.principal }, createdAt: now,
    };
    expect(gateA3ConnectorSourceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(gateA3ConnectorSourceSnapshotSchema.safeParse({ ...snapshot, sourceRevision: 'drift' }).success).toBe(false);
    expect(gateA3ConnectorSourceSnapshotSchema.safeParse({
      ...snapshot, audience: { ...snapshot.audience, principal: 'another' },
    }).success).toBe(false);
    const locatorBase = {
      schemaVersion: 'connector-evidence-locator/1', connectorSourceSnapshotId: snapshot.connectorSourceSnapshotId,
      connectorInvocationId: claims.connectorInvocationId, effectId: claims.effectId,
      connectorQuerySpecHash: digest, canonicalAllowlistedPayloadHash: digest, workOrderRefHash: claims.workOrderRefHash,
      fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION, sourceRevision: response.sourceRevision, sourceAsOf: response.updatedAt,
    };
    expect(gateA3ConnectorEvidenceLocatorSchema.parse({ ...locatorBase, kind: 'connector_snapshot_whole' })).toBeDefined();
    expect(gateA3ConnectorEvidenceLocatorSchema.parse({
      ...locatorBase, kind: 'connector_snapshot_field', field: {
        schemaVersion: 'connector-evidence-field/1', canonicalizationVersion: GATE_A3_CANONICALIZATION_VERSION,
        fieldName: 'status', fieldType: 'string', canonicalValue: response.status,
      }, fieldHash: digest,
    })).toBeDefined();
    expect(gateA3ConnectorEvidenceLocatorSchema.safeParse({ ...locatorBase, kind: 'connector_snapshot_whole', rawPayload: response }).success).toBe(false);
  });

  it('keeps deterministic card values and explanation/public terminal variants strict', () => {
    const evidenceRefs = { status: 'ev.status', planQty: 'ev.plan', completedQty: 'ev.done',
      updatedAt: 'ev.updated', sourceAsOf: 'ev.updated' };
    const card = {
      schemaVersion: 'WorkOrderStatusCard/1', workOrderRef: response.workOrderRef, status: response.status,
      planQty: 100, completedQty: 40, unit: '件', progressPct: 40, updatedAt: sourceNow, sourceAsOf: sourceNow,
      evidenceRefs, readOnly: true,
    };
    const explanation = { schemaVersion: 'work-order.explanation/1', summary: '工单生产中。', statements: [
      { id: 'statement.1', kind: 'fact', text: '工单状态为生产中。', sourceFields: ['status'] },
      { id: 'statement.2', kind: 'unknown', text: '尚不能判断完工时间。', sourceFields: [] },
    ] };
    expect(gateA3WorkOrderStatusCardSchema.parse(card)).toEqual(card);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, progressPct: 101 }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, progressPct: 41 }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, planQty: 0, progressPct: 0 }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, completedQty: 101, progressPct: 100 }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, sourceAsOf: '2026-07-27T01:02:04.004000Z' }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({
      ...card, evidenceRefs: { ...evidenceRefs, sourceAsOf: 'ev.other' },
    }).success).toBe(false);
    expect(gateA3WorkOrderStatusCardSchema.safeParse({ ...card, readOnly: false }).success).toBe(false);
    expect(gateA3WorkOrderExplanationSchema.parse(explanation)).toEqual(explanation);
    expect(gateA3WorkOrderExplanationSchema.safeParse({
      ...explanation, statements: [{ id: 'statement.1', kind: 'fact', text: '无来源事实', sourceFields: [] }],
    }).success).toBe(false);
    expect(gateA3WorkOrderExplanationSchema.safeParse({
      ...explanation,
      statements: [{ id: 'statement.progress', kind: 'inference', text: '进度为 40%。', sourceFields: ['progressPct'] }],
    }).success).toBe(false);
    expect(gateA3WorkOrderExplanationSchema.safeParse({
      ...explanation, status: 'MODEL_MUST_NOT_CONTROL_CARD_FIELDS',
    }).success).toBe(false);
    const publicBase = {
      schemaVersion: 'gate-a3-public-task-snapshot/1', recordVariant: 'business-task.work-order.live/1',
      taskId: claims.taskId, conversationId: 'conversation.1',
      capabilityId: 'production.work-order-status.v1', inputRef: { kind: 'work_order', workOrderRef: response.workOrderRef },
      workflowVersionId: claims.workflowVersionId, workflowHash: digest, connectorQuerySpecHash: digest,
      workflow: {
        templateId: 'workflow-template.work-order-status/1', workflowVersionId: claims.workflowVersionId,
        workflowHash: digest, steps: [
          ['validate_work_order_ref', 'deterministic'], ['fetch_authorized_status', 'deterministic'],
          ['compute_progress', 'deterministic'], ['explain_status', 'agent'],
          ['evidence_verify', 'verification'], ['publish_status_card', 'deterministic'],
        ].map(([id, kind]) => ({ id, kind, status: 'completed', attemptId: 'attempt.1', fence: 1 })),
      },
      approval: { id: 'approval.1', version: 1, status: 'approved', subjectDigest: digest, expiresAt: now },
      createdAt: now, updatedAt: now,
    };
    expect(gateA3PublicTaskSnapshotSchema.parse({
      ...publicBase, status: 'completed', result: { kind: 'work_order_status', card, explanation },
    })).toBeDefined();
    expect(gateA3PublicTaskSnapshotSchema.safeParse({ ...publicBase, status: 'running', result: { kind: 'work_order_status', card, explanation } }).success).toBe(false);
    expect(gateA3PublicTaskSnapshotSchema.safeParse({ ...publicBase, status: 'completed', result: null }).success).toBe(false);
    for (const code of ['CONNECTOR_TIMEOUT', 'MODEL_TIMEOUT', 'WORK_ORDER_REF_INVALID', 'WORK_ORDER_PROTOCOL_VIOLATION']) {
      expect(gateA3PublicTaskSnapshotSchema.safeParse({
        ...publicBase, status: 'failed', result: { kind: 'failed', code, message: '工单查询失败。' },
      }).success, code).toBe(true);
    }
    expect(gateA3PublicTaskSnapshotSchema.safeParse({
      ...publicBase, status: 'failed', result: { kind: 'failed', code: 'UNBOUNDED_INTERNAL_ERROR', message: '失败。' },
    }).success).toBe(false);
  });

  it('provides one strict Worker-to-Model Gateway work-order wire contract', async () => {
    const systemPrompt = '只解释当前已验证的只读工单状态。';
    const promptPolicyResolvedBytesSha256 = await digestGateA3PromptPolicyResolvedBytes(systemPrompt);
    const progress = {
      schemaVersion: 'work-order.progress/1', planQty: 100, completedQty: 40,
      progressPct: 40, calculationStatus: 'computed',
    } as const;
    expect(gateA3WorkOrderProgressSchema.parse(progress)).toEqual(progress);
    expect(gateA3WorkOrderProgressSchema.safeParse({ ...progress, progressPct: 41 }).success).toBe(false);
    const authority = {
      tenantId: claims.tenantId, principalId: 'user_local', taskId: claims.taskId,
      workflowVersionId: claims.workflowVersionId, workflowHash: digest,
      executionAttemptId: 'execution.1', taskFence: 1, stepId: 'explain_status',
      stepAttemptId: 'step-attempt.1', stepFence: 2, modelInvocationId: 'model-invocation.1',
      approvalSubjectDigest: digest, capabilityVersionId: 'cap_production_work_order_status_v1_1',
      effectId: claims.effectId, connectorQuerySpecHash: digest, connectorSourceSnapshotId: 'snapshot.1',
      connectorSourceSnapshotHash: digest, snapshotPayloadHash: await digestGateA3Jcs(response),
      progressDigest: await digestGateA3Jcs(progress), resourceScope: 'gearjob-work-order:connector-query-spec-bound',
      snapshotAudience: 'tenant_local:user_local', logicalModelPolicy: 'business.production.work-order-status.explanation',
      promptPolicyVersionId: GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
      promptPolicyResolvedBytesSha256,
      routeProfile: 'codex_subscription_dev',
      dataClass: 'C1', toolChoice: 'none', outputSchemaVersion: 'work-order.explanation/1',
      maxOutputTokens: 512, deadline: now,
    } as const;
    const request = {
      schemaVersion: 'gate-a3-work-order-model-request/2', invocationToken: 'x'.repeat(40),
      ...authority, systemPrompt, snapshot: response, progress,
    } as const;
    expect(gateA3WorkOrderModelRequestSchema.parse(request)).toEqual(request);
    expect(gateA3WorkOrderModelRequestSchema.safeParse({ ...request, provider: 'forbidden' }).success).toBe(false);
    const token = {
      schemaVersion: 'gate-a3-work-order-model-token/2', iss: 'geneway-control-plane',
      aud: 'local-model-gateway-work-order-explanation', ...authority,
      jti: '44444444-4444-4444-8444-444444444444', iat: 1_800_000_000, exp: 1_800_000_060,
    } as const;
    expect(gateA3WorkOrderModelTokenClaimsSchema.parse(token)).toEqual(token);
    expect(gateA3WorkOrderModelTokenClaimsSchema.safeParse({ ...token, exp: token.iat }).success).toBe(false);
    const receipt = {
      payload: {
        schemaVersion: 'gate-a3-work-order-model-receipt/2', ...authority,
        issuer: 'geneway-model-gateway', audience: 'geneway-control-plane-work-order',
        receiptJti: '55555555-5555-4555-8555-555555555555', issuedAt: now, outcome: 'completed',
        outputPayloadDigest: digest, providerRevision: 'provider.1', modelRevision: 'model.1',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }, signature: 'x'.repeat(43),
    } as const;
    expect(gateA3WorkOrderModelReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(gateA3WorkOrderModelReceiptSchema.safeParse({
      ...receipt, payload: { ...receipt.payload, usage: { ...receipt.payload.usage, totalTokens: 31 } },
    }).success).toBe(false);
    expect(receipt.payload).not.toHaveProperty('systemPrompt');

    const { promptPolicyResolvedBytesSha256: _promptDigest, ...v1Authority } = authority;
    void _promptDigest;
    expect(gateA3WorkOrderModelRequestV1Schema.parse({
      schemaVersion: 'gate-a3-work-order-model-request/1', invocationToken: 'x'.repeat(40),
      ...v1Authority, snapshot: response, progress,
    })).toBeDefined();
    expect(gateA3WorkOrderModelTokenClaimsV1Schema.parse({
      schemaVersion: 'gate-a3-work-order-model-token/1', iss: 'geneway-control-plane',
      aud: 'local-model-gateway-work-order-explanation', ...v1Authority,
      jti: '66666666-6666-4666-8666-666666666666', iat: 1_800_000_000, exp: 1_800_000_060,
    })).toBeDefined();
    expect(gateA3WorkOrderModelReceiptV1Schema.parse({
      payload: {
        schemaVersion: 'gate-a3-work-order-model-receipt/1', ...v1Authority,
        issuer: 'geneway-model-gateway', audience: 'geneway-control-plane-work-order',
        receiptJti: '77777777-7777-4777-8777-777777777777', issuedAt: now, outcome: 'completed',
        outputPayloadDigest: digest, providerRevision: 'provider.1', modelRevision: 'model.1',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }, signature: 'x'.repeat(43),
    })).toBeDefined();
  });

  it('projects all private explanation semantics into provider-visible JSON Schema descriptions', () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(gateA3WorkOrderExplanationSchema));
    for (const rule of [
      'fact requires at least one source field',
      'unknown requires an empty array',
      'progressPct must also reference both planQty and completedQty',
      'statement ids must be unique',
      'sourceFields array must contain unique values',
    ]) expect(jsonSchema).toContain(rule);
  });
});
