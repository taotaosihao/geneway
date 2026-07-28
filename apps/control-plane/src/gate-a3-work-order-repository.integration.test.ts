import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeGateA3Jcs,
  digestGateA3PromptPolicyResolvedBytes,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorInvocationTokenClaimsSchema,
  gateA3ConnectorSourceSnapshotSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
  gateA3WorkOrderStatusCardSchema,
} from '@geneway/contracts';
import { ControlPlaneRepository } from './repository.js';
import {
  GateA3WorkOrderRepository,
  type GateA3Authority,
  type GateA3WorkOrderStepLease,
  type GateA3WorkOrderWorkerClaim,
} from './gate-a3-work-order-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for Gate A.3 repository integration tests');

const digest = (value: unknown): string => createHash('sha256')
  .update(canonicalizeGateA3Jcs(value), 'utf8').digest('hex');
const authorityBody = {
  schemaVersion: 'gate-a3-authority-envelope/1' as const,
  capabilityId: 'production.work-order-status.v1' as const,
  environmentClass: 'isolated-local-development' as const,
  productionAuthority: false as const,
  artifactId: 'gate-a3-integration-authority',
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
const authority: GateA3Authority = {
  envelope: { ...authorityBody, authorityDigest: digest(authorityBody) },
  validationRunId: 'gate-a3-repository-integration',
  connectorGatewayServiceToken: 'connector-service-token-000000000000000000000001',
  connectorInvocationTokenSecret: 'connector-invocation-secret-00000000000000000001',
  connectorGatewayReceiptSecret: 'connector-receipt-secret-0000000000000000000001',
  modelInvocationTokenSecret: 'model-invocation-secret-000000000000000000000001',
  modelGatewayReceiptSecret: 'model-receipt-secret-0000000000000000000000001',
  assertRuntimeAuthority: () => Promise.resolve(),
};
const principal = { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' } as const;
const control = new ControlPlaneRepository(databaseUrl, 'gate-a3-cursor-secret-000000000000000000000001');
const repository = new GateA3WorkOrderRepository(control.pool, authority);

const mutationOf = (claim: GateA3WorkOrderWorkerClaim) => ({
  tenantId: claim.tenantId, taskId: claim.taskId,
  workflowVersionId: claim.workflowVersionId, workflowHash: claim.workflowHash,
  executionAttemptId: claim.executionAttemptId, taskFence: claim.taskFence,
});

const createTaskThroughConnectorGrant = async (suffix: string, workOrderRef: string) => {
  const conversation = await control.createConversation(principal, `gate-a3-${suffix}-conversation`);
  const created = await repository.createTask(principal, {
    conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
    inputRef: { kind: 'work_order', workOrderRef }, idempotencyKey: `gate-a3-${suffix}-task`,
  });
  await repository.decideApproval(principal, created.approvalId, 'approved', `gate-a3-${suffix}-approval`);
  const approved = await repository.getTask(principal, created.taskId);
  await repository.executeTask(principal, created.taskId, {
    expectedApprovalVersion: approved.approval.version,
    expectedApprovalSubjectDigest: approved.approval.subjectDigest,
  }, `gate-a3-${suffix}-execute`);
  const claim = await repository.claimWorkOrder(`gate-a3-${suffix}-worker`, 60_000);
  if (claim === null || claim.taskId !== created.taskId) throw new Error(`expected ${suffix} Work Order claim`);
  await repository.markWorkOrderStarted(mutationOf(claim));
  const fetchGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
    schemaVersion: 'work-order.ref/1', workOrderRef,
  }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
  const connectorRequest = gateA3ConnectorGatewayRequestSchema.parse(fetchGrant.connectorRequest);
  const requestDigest = digest({ schemaVersion: connectorRequest.schemaVersion,
    querySpec: connectorRequest.querySpec, querySpecHash: connectorRequest.querySpecHash });
  return { created, claim, fetchStep: fetchGrant.step, connectorRequest, requestDigest };
};

const createTaskThroughConnectorSnapshot = async (suffix: string, workOrderRef: string) => {
  const conversation = await control.createConversation(principal, `gate-a3-${suffix}-conversation`);
  const created = await repository.createTask(principal, {
    conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
    inputRef: { kind: 'work_order', workOrderRef }, idempotencyKey: `gate-a3-${suffix}-task`,
  });
  await repository.decideApproval(principal, created.approvalId, 'approved', `gate-a3-${suffix}-approval`);
  const approved = await repository.getTask(principal, created.taskId);
  await repository.executeTask(principal, created.taskId, {
    expectedApprovalVersion: approved.approval.version,
    expectedApprovalSubjectDigest: approved.approval.subjectDigest,
  }, `gate-a3-${suffix}-execute`);
  const claim = await repository.claimWorkOrder(`gate-a3-${suffix}-worker`, 60_000);
  if (claim === null || claim.taskId !== created.taskId) throw new Error(`expected ${suffix} Work Order claim`);
  await repository.markWorkOrderStarted(mutationOf(claim));
  const fetchGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
    schemaVersion: 'work-order.ref/1', workOrderRef,
  }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
  const connectorRequest = gateA3ConnectorGatewayRequestSchema.parse(fetchGrant.connectorRequest);
  const [connectorToken] = connectorRequest.invocationToken.split('.');
  const connectorClaims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
    JSON.parse(Buffer.from(connectorToken!, 'base64url').toString('utf8')),
  );
  const requestDigest = digest({ schemaVersion: connectorRequest.schemaVersion,
    querySpec: connectorRequest.querySpec, querySpecHash: connectorRequest.querySpecHash });
  await expect(repository.consumeConnectorInvocationToken(connectorRequest.invocationToken, requestDigest))
    .resolves.toMatchObject({ active: true });
  const response = {
    workOrderRef, status: 'In Process', planQty: 10, completedQty: 4, unit: 'Nos',
    plannedStart: '2026-07-27T00:00:00.000000Z', plannedEnd: '2026-07-28T00:00:00.000000Z',
    updatedAt: '2026-07-27T00:01:02.123456Z', sourceRevision: `revision-${suffix}`,
  } as const;
  const receiptPayload = {
    schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
    audience: 'geneway-control-plane', receiptJti: randomUUID(), tenantId: connectorClaims.tenantId,
    principal: connectorClaims.principal, taskId: connectorClaims.taskId,
    workflowVersionId: connectorClaims.workflowVersionId, workflowHash: connectorClaims.workflowHash,
    stepId: connectorClaims.stepId, attemptId: connectorClaims.attemptId, effectId: connectorClaims.effectId,
    connectorInvocationId: connectorClaims.connectorInvocationId,
    connectorQuerySpecHash: connectorClaims.connectorQuerySpecHash,
    connectorProfileVersion: connectorClaims.connectorProfileVersion,
    workOrderRefHash: connectorClaims.workOrderRefHash, fieldMaskVersion: connectorClaims.fieldMaskVersion,
    resourceContextDigest: connectorClaims.resourceContextDigest, deadline: connectorClaims.deadline,
    fence: connectorClaims.fence, jti: connectorClaims.jti, issuedAt: new Date().toISOString(),
    outcome: 'completed', responseRefMatched: true, sourceRevision: response.sourceRevision,
    responseCanonicalHash: digest(response),
  } as const;
  const receipt = gateA3ConnectorGatewayReceiptSchema.parse({ payload: receiptPayload,
    signature: createHmac('sha256', authority.connectorGatewayReceiptSecret)
      .update(canonicalizeGateA3Jcs(receiptPayload), 'utf8').digest('base64url') });
  const computeGrant = await repository.checkpointWorkOrder(mutationOf(claim), fetchGrant.step, {
    response, receipt,
  }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; sourceSnapshot: unknown }>;
  const sourceSnapshot = gateA3ConnectorSourceSnapshotSchema.parse(computeGrant.sourceSnapshot);
  return { created, claim, computeStep: computeGrant.step, response, sourceSnapshot };
};

describe('Gate A.3 single Work Order authority', () => {
  beforeAll(async () => {
    await control.resetForTest();
    await repository.seedAuthority();
    await expect(repository.getCapabilityRoute(principal)).resolves.toEqual({
      capabilityId: 'production.work-order-status.v1', status: 'NOT_OPEN', executionRoute: 'not_open',
    });
    await repository.activateAuthorityEnvelope();
    await repository.promoteAuthority('shadow');
    await repository.promoteAuthority('internal');
    await repository.activateAuthorityEnvelope();
    await repository.promoteAuthority('shadow');
    await repository.promoteAuthority('internal');
  });

  afterAll(async () => {
    await control.close();
  });

  it('publishes one deterministic card only after connector/model authority and immutable Evidence settle', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-conversation-create');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-0001' },
      idempotencyKey: 'gate-a3-task-create',
    });
    const awaiting = await repository.getTask(principal, created.taskId);
    expect(awaiting.status).toBe('awaiting_approval');
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-approval-decision');
    const approved = await repository.getTask(principal, created.taskId);
    expect(approved.status).toBe('approved');
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-execute-task');

    const firstClaim = await repository.claimWorkOrder('gate-a3-worker-first', 60_000);
    expect(firstClaim).not.toBeNull();
    if (firstClaim === null) throw new Error('expected first Work Order claim');
    await repository.markWorkOrderStarted(mutationOf(firstClaim));
    const firstFetchGrant = await repository.checkpointWorkOrder(mutationOf(firstClaim), firstClaim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: firstClaim.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const firstConnectorRequest = gateA3ConnectorGatewayRequestSchema.parse(firstFetchGrant.connectorRequest);
    const [firstConnectorToken] = firstConnectorRequest.invocationToken.split('.');
    const firstConnectorClaims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(firstConnectorToken!, 'base64url').toString('utf8')),
    );
    const firstGatewayRequestDigest = digest({ schemaVersion: firstConnectorRequest.schemaVersion,
      querySpec: firstConnectorRequest.querySpec, querySpecHash: firstConnectorRequest.querySpecHash });
    await expect(repository.consumeConnectorInvocationToken(
      firstConnectorRequest.invocationToken, firstGatewayRequestDigest,
    )).resolves.toMatchObject({ active: true });
    const retryIssuedAt = new Date();
    const retryNotBefore = new Date(retryIssuedAt.getTime() + 500).toISOString();
    const rateLimitReceiptPayload = {
      schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
      audience: 'geneway-control-plane', receiptJti: randomUUID(), tenantId: firstConnectorClaims.tenantId,
      principal: firstConnectorClaims.principal, taskId: firstConnectorClaims.taskId,
      workflowVersionId: firstConnectorClaims.workflowVersionId, workflowHash: firstConnectorClaims.workflowHash,
      stepId: firstConnectorClaims.stepId, attemptId: firstConnectorClaims.attemptId,
      effectId: firstConnectorClaims.effectId, connectorInvocationId: firstConnectorClaims.connectorInvocationId,
      connectorQuerySpecHash: firstConnectorClaims.connectorQuerySpecHash,
      connectorProfileVersion: firstConnectorClaims.connectorProfileVersion,
      workOrderRefHash: firstConnectorClaims.workOrderRefHash, fieldMaskVersion: firstConnectorClaims.fieldMaskVersion,
      resourceContextDigest: firstConnectorClaims.resourceContextDigest, deadline: firstConnectorClaims.deadline,
      fence: firstConnectorClaims.fence, jti: firstConnectorClaims.jti, issuedAt: retryIssuedAt.toISOString(),
      outcome: 'CONNECTOR_RATE_LIMITED', responseRefMatched: null, sourceRevision: null,
      responseCanonicalHash: null, retryNotBefore,
    } as const;
    const rateLimitReceipt = gateA3ConnectorGatewayReceiptSchema.parse({
      payload: rateLimitReceiptPayload,
      signature: createHmac('sha256', authority.connectorGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(rateLimitReceiptPayload), 'utf8').digest('base64url'),
    });
    const retryDisposition = await repository.handleConnectorFailure(
      mutationOf(firstClaim), firstFetchGrant.step,
      { errorClass: 'CONNECTOR_RATE_LIMITED', receipt: rateLimitReceipt },
    );
    expect(retryDisposition).toEqual({ retryScheduled: true, retryNotBefore });
    await expect(repository.handleConnectorFailure(
      mutationOf(firstClaim), firstFetchGrant.step,
      { errorClass: 'CONNECTOR_RATE_LIMITED', receipt: rateLimitReceipt },
    )).resolves.toEqual(retryDisposition);
    await expect(repository.claimWorkOrder('gate-a3-worker-too-early', 60_000)).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve,
      Math.max(0, Date.parse(retryNotBefore) - Date.now() + 50)));

    const claim = await repository.claimWorkOrder('gate-a3-worker-second', 60_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('expected retry Work Order claim');
    expect(claim.executionAttemptId).not.toBe(firstClaim.executionAttemptId);
    expect(claim.taskFence).toBeGreaterThan(firstClaim.taskFence);
    expect(claim.connectorQuerySpecHash).toBe(firstClaim.connectorQuerySpecHash);
    await repository.markWorkOrderStarted(mutationOf(claim));
    const fetchGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: claim.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const connectorRequest = gateA3ConnectorGatewayRequestSchema.parse(fetchGrant.connectorRequest);
    const [connectorToken] = connectorRequest.invocationToken.split('.');
    const connectorClaims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(connectorToken!, 'base64url').toString('utf8')),
    );
    expect(connectorClaims.effectId).toBe(firstConnectorClaims.effectId);
    expect(connectorClaims.connectorInvocationId).not.toBe(firstConnectorClaims.connectorInvocationId);
    expect(connectorClaims.jti).not.toBe(firstConnectorClaims.jti);
    await expect(repository.consumeConnectorInvocationToken(
      firstConnectorRequest.invocationToken, firstGatewayRequestDigest,
    )).resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
    const gatewayRequestDigest = digest({ schemaVersion: connectorRequest.schemaVersion,
      querySpec: connectorRequest.querySpec, querySpecHash: connectorRequest.querySpecHash });
    await expect(repository.consumeConnectorInvocationToken(
      connectorRequest.invocationToken, gatewayRequestDigest,
    )).resolves.toMatchObject({ active: true });
    await expect(repository.consumeConnectorInvocationToken(
      connectorRequest.invocationToken, gatewayRequestDigest,
    )).resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });

    const response = {
      workOrderRef: 'WO-TEST-0001', status: 'In Process', planQty: 10, completedQty: 4,
      unit: 'Nos', plannedStart: '2026-07-27T00:00:00.000000Z',
      plannedEnd: '2026-07-28T00:00:00.000000Z', updatedAt: '2026-07-27T00:01:02.123456Z',
      sourceRevision: '2026-07-27 08:01:02.123456',
    } as const;
    const connectorReceiptPayload = {
      schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
      audience: 'geneway-control-plane', receiptJti: randomUUID(), tenantId: connectorClaims.tenantId,
      principal: connectorClaims.principal, taskId: connectorClaims.taskId,
      workflowVersionId: connectorClaims.workflowVersionId, workflowHash: connectorClaims.workflowHash,
      stepId: connectorClaims.stepId, attemptId: connectorClaims.attemptId, effectId: connectorClaims.effectId,
      connectorInvocationId: connectorClaims.connectorInvocationId,
      connectorQuerySpecHash: connectorClaims.connectorQuerySpecHash,
      connectorProfileVersion: connectorClaims.connectorProfileVersion,
      workOrderRefHash: connectorClaims.workOrderRefHash, fieldMaskVersion: connectorClaims.fieldMaskVersion,
      resourceContextDigest: connectorClaims.resourceContextDigest, deadline: connectorClaims.deadline,
      fence: connectorClaims.fence, jti: connectorClaims.jti, issuedAt: new Date().toISOString(),
      outcome: 'completed', responseRefMatched: true, sourceRevision: response.sourceRevision,
      responseCanonicalHash: digest(response),
    } as const;
    const connectorReceipt = gateA3ConnectorGatewayReceiptSchema.parse({
      payload: connectorReceiptPayload,
      signature: createHmac('sha256', authority.connectorGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(connectorReceiptPayload), 'utf8').digest('base64url'),
    });
    const computeGrant = await repository.checkpointWorkOrder(mutationOf(claim), fetchGrant.step, {
      response, receipt: connectorReceipt,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; sourceSnapshot: unknown }>;
    const sourceSnapshot = gateA3ConnectorSourceSnapshotSchema.parse(computeGrant.sourceSnapshot);
    expect(sourceSnapshot.canonicalAllowlistedPayload).toEqual(response);

    const progress = { schemaVersion: 'work-order.progress/1', planQty: 10, completedQty: 4,
      progressPct: 40, calculationStatus: 'computed' } as const;
    const explainGrant = await repository.checkpointWorkOrder(mutationOf(claim), computeGrant.step,
      progress, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; modelRequest: unknown }>;
    const modelRequest = gateA3WorkOrderModelRequestSchema.parse(explainGrant.modelRequest);
    const promptBinding = await control.pool.query<{ release_id: string; prompt_policy_version_id: string;
      system_prompt: string; persisted_digest: string }>(`SELECT active.release_id,
        release.prompt_policy_version_id,prompt.policy->>'system' system_prompt,
        invocation.prompt_policy_resolved_bytes_sha256 persisted_digest
      FROM capability_active_releases active
      JOIN capability_release_records release
        ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      JOIN prompt_policy_versions prompt
        ON prompt.tenant_id=release.tenant_id AND prompt.id=release.prompt_policy_version_id
      JOIN gate_a3_model_invocations invocation
        ON invocation.tenant_id=active.tenant_id AND invocation.business_task_id=$2
      WHERE active.tenant_id=$1 AND active.capability_id='production.work-order-status.v1'`, [
      principal.tenantId, created.taskId,
    ]);
    expect(promptBinding.rows).toHaveLength(1);
    expect(promptBinding.rows[0]).toMatchObject({
      release_id: 'release_production_work_order_status_v1_internal',
      prompt_policy_version_id: 'xiaowei.work-order-status.explanation/1',
      system_prompt: modelRequest.systemPrompt,
      persisted_digest: modelRequest.promptPolicyResolvedBytesSha256,
    });
    await expect(digestGateA3PromptPolicyResolvedBytes(modelRequest.systemPrompt))
      .resolves.toBe(modelRequest.promptPolicyResolvedBytesSha256);
    const [encodedModelClaims] = modelRequest.invocationToken.split('.');
    const modelClaims = gateA3WorkOrderModelTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedModelClaims!, 'base64url').toString('utf8')),
    );
    const driftedClaims = gateA3WorkOrderModelTokenClaimsSchema.parse({
      ...modelClaims, promptPolicyResolvedBytesSha256: '0'.repeat(64),
    });
    const driftedEncodedClaims = Buffer.from(JSON.stringify(driftedClaims), 'utf8').toString('base64url');
    const driftedToken = `${driftedEncodedClaims}.${createHmac('sha256', authority.modelInvocationTokenSecret)
      .update(driftedEncodedClaims, 'utf8').digest('base64url')}`;
    await expect(repository.consumeModelInvocationToken(driftedToken)).resolves.toBe(false);
    await expect(repository.consumeModelInvocationToken(modelRequest.invocationToken)).resolves.toBe(true);
    await expect(repository.consumeModelInvocationToken(modelRequest.invocationToken)).resolves.toBe(false);
    await expect(control.pool.query(`UPDATE gate_a3_model_invocations
      SET prompt_policy_resolved_bytes_sha256=$3 WHERE tenant_id=$1 AND business_task_id=$2`, [
      principal.tenantId, created.taskId, '0'.repeat(64),
    ])).rejects.toThrow(/identity is immutable/iu);

    const explanation = gateA3WorkOrderExplanationSchema.parse({
      schemaVersion: 'work-order.explanation/1', summary: '模型错误声称工单已经关闭，进度为 999%。',
      statements: [
        { id: 'statement_status', kind: 'fact', text: '原始状态为 CLOSED。', sourceFields: ['status'] },
        { id: 'statement_progress', kind: 'inference', text: '已完成 999 / 1，确定性进度为 999%。',
          sourceFields: ['planQty', 'completedQty', 'progressPct'] },
      ],
    });
    const { invocationToken: _token, systemPrompt: _systemPrompt, snapshot: _snapshot, progress: _progress,
      schemaVersion: _schemaVersion, ...modelAuthority } = modelRequest;
    void _token;
    void _systemPrompt;
    void _snapshot;
    void _progress;
    void _schemaVersion;
    const modelReceiptPayload = {
      schemaVersion: 'gate-a3-work-order-model-receipt/2', ...modelAuthority,
      issuer: 'geneway-model-gateway', audience: 'geneway-control-plane-work-order',
      receiptJti: randomUUID(), issuedAt: new Date().toISOString(), outcome: 'completed',
      outputPayloadDigest: digest(explanation), providerRevision: '@openai-oauth/ai-sdk@test',
      modelRevision: 'gpt-5.4-mini', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as const;
    const modelReceipt = gateA3WorkOrderModelReceiptSchema.parse({ payload: modelReceiptPayload,
      signature: createHmac('sha256', authority.modelGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(modelReceiptPayload), 'utf8').digest('base64url') });
    const driftedModelReceiptPayload = {
      ...modelReceiptPayload, promptPolicyResolvedBytesSha256: '0'.repeat(64),
    };
    const driftedModelReceipt = gateA3WorkOrderModelReceiptSchema.parse({
      payload: driftedModelReceiptPayload,
      signature: createHmac('sha256', authority.modelGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(driftedModelReceiptPayload), 'utf8').digest('base64url'),
    });
    await expect(repository.checkpointWorkOrder(mutationOf(claim), explainGrant.step,
      { output: explanation, receipt: driftedModelReceipt }, 60_000))
      .rejects.toMatchObject({ code: 'MODEL_PROTOCOL_VIOLATION' });
    const evidenceGrant = await repository.checkpointWorkOrder(mutationOf(claim), explainGrant.step,
      { output: explanation, receipt: modelReceipt }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease }>;
    const publishGrant = await repository.checkpointWorkOrder(mutationOf(claim), evidenceGrant.step,
      { explanation }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease;
        verifiedExplanation: unknown; evidenceRefs: unknown }>;
    const card = gateA3WorkOrderStatusCardSchema.parse({
      schemaVersion: 'WorkOrderStatusCard/1', workOrderRef: response.workOrderRef, status: response.status,
      planQty: response.planQty, completedQty: response.completedQty, unit: response.unit,
      progressPct: 40, updatedAt: response.updatedAt, sourceAsOf: response.updatedAt,
      evidenceRefs: publishGrant.evidenceRefs, readOnly: true,
    });
    await repository.settleWorkOrder(mutationOf(claim), {
      status: 'completed', card, explanation,
    }, publishGrant.step);

    const completed = await repository.getTask(principal, created.taskId);
    expect(completed).toMatchObject({ status: 'completed', result: {
      kind: 'work_order_status',
      card: { workOrderRef: 'WO-TEST-0001', progressPct: 40, readOnly: true },
      explanation: {
        summary: '工单 WO-TEST-0001 当前状态为“In Process”；基于已验证数量，确定性进度为 40%。',
        statements: [
          { id: 'statement_status', kind: 'fact', text: '已验证事实：status="In Process"。',
            sourceFields: ['status'] },
          { id: 'statement_progress', kind: 'inference',
            text: '辅助说明依据已验证字段：planQty=10，completedQty=4，progressPct=40；不能改变工单快照、确定性进度或只读结论。',
            sourceFields: ['planQty', 'completedQty', 'progressPct'] },
        ],
      },
    } });
    expect(completed.result?.kind === 'work_order_status'
      ? completed.result.explanation.summary
      : null).not.toBe(explanation.summary);
    expect(JSON.stringify(completed.result)).not.toContain('CLOSED');
    expect(JSON.stringify(completed.result)).not.toContain('999');
    const counts = await control.pool.query<{ snapshots: string; evidence: string; whole_evidence: string;
      field_evidence: string; results: string;
      result_effect_id: string | null; snapshot_id: string; status_evidence_id: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_connector_source_snapshots WHERE business_task_id=$1) snapshots,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1) evidence,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1
        AND locator_kind='connector_snapshot_whole') whole_evidence,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1
        AND locator_kind='connector_snapshot_field') field_evidence,
      (SELECT count(*)::text FROM gate_a3_work_order_results WHERE business_task_id=$1) results,
      (SELECT effect_id FROM gate_a3_work_order_results WHERE business_task_id=$1) result_effect_id,
      (SELECT id FROM gate_a3_connector_source_snapshots WHERE business_task_id=$1) snapshot_id,
      (SELECT id FROM gate_a3_connector_evidence WHERE business_task_id=$1
        AND field_name='status') status_evidence_id`, [created.taskId]);
    expect(counts.rows[0]).toMatchObject({ snapshots: '1', evidence: '10', whole_evidence: '1',
      field_evidence: '9', results: '1' });
    expect(counts.rows[0]?.result_effect_id).toMatch(/^effect_[a-f0-9]{48}$/u);
    const published = counts.rows[0];
    if (published === undefined) throw new Error('expected published Work Order authority');
    await expect(repository.getTask(principal, created.taskId)).resolves.toEqual(completed);
    await expect(repository.getEvidence(principal, published.status_evidence_id)).resolves.toMatchObject({
      id: published.status_evidence_id, fieldName: 'status', value: 'In Process', readOnly: true,
    });
    await expect(control.pool.query(`UPDATE gate_a3_work_order_results
      SET public_result=jsonb_set(public_result,'{card,status}','"tampered"'::jsonb)
      WHERE tenant_id=$1 AND business_task_id=$2`, [principal.tenantId, created.taskId])).rejects.toThrow();
    await expect(control.pool.query(`DELETE FROM gate_a3_work_order_results
      WHERE tenant_id=$1 AND business_task_id=$2`, [principal.tenantId, created.taskId])).rejects.toThrow();
    await expect(control.pool.query(`UPDATE gate_a3_connector_source_snapshots SET source_revision='tampered'
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, published.snapshot_id])).rejects.toThrow();
    await expect(control.pool.query(`DELETE FROM gate_a3_connector_evidence
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, published.status_evidence_id])).rejects.toThrow();
    await expect(control.pool.query(`UPDATE business_tasks
      SET result=jsonb_set(result,'{card,status}','"tampered"'::jsonb)
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, created.taskId])).rejects.toThrow();
    const tamperClient = await control.pool.connect();
    try {
      await tamperClient.query('ALTER TABLE business_tasks DISABLE TRIGGER gate_a3_terminal_task_result_immutable');
      await tamperClient.query(`UPDATE business_tasks
        SET result=jsonb_set(result,'{card,status}','"tampered"'::jsonb)
        WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, created.taskId]);
      await tamperClient.query('ALTER TABLE business_tasks ENABLE TRIGGER gate_a3_terminal_task_result_immutable');
      await expect(repository.getTask(principal, created.taskId)).rejects.toMatchObject({
        code: 'TASK_INTEGRITY_FAILED', statusCode: 409,
      });
      await tamperClient.query('ALTER TABLE business_tasks DISABLE TRIGGER gate_a3_terminal_task_result_immutable');
      await tamperClient.query(`UPDATE business_tasks task SET result=immutable.public_result
        FROM gate_a3_work_order_results immutable
        WHERE task.tenant_id=$1 AND task.id=$2 AND immutable.tenant_id=task.tenant_id
          AND immutable.business_task_id=task.id`, [principal.tenantId, created.taskId]);
      await tamperClient.query('ALTER TABLE business_tasks ENABLE TRIGGER gate_a3_terminal_task_result_immutable');
    } catch (error) {
      await tamperClient.query('ALTER TABLE business_tasks ENABLE TRIGGER gate_a3_terminal_task_result_immutable')
        .catch(() => undefined);
      throw error;
    } finally {
      tamperClient.release();
    }
    await expect(repository.getTask(principal, created.taskId)).resolves.toEqual(completed);
    await control.pool.query(`UPDATE approval_versions SET expires_at=now()-interval '1 second'
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, created.approvalId]);
    await expect(repository.getTask(principal, created.taskId)).resolves.toMatchObject({
      status: 'completed', result: completed.result,
    });
    await repository.revokeConnectorEvidenceSourceAccess(
      principal, published.status_evidence_id, '7'.repeat(64),
    );
    await repository.revokeConnectorEvidenceSourceAccess(
      principal, published.status_evidence_id, '7'.repeat(64),
    );
    const revocation = await control.pool.query<{ count: string; actor: string; reason_digest: string }>(`SELECT
      count(*)::text count,min(actor) actor,min(reason_digest) reason_digest
      FROM gate_a3_connector_source_revocations
      WHERE tenant_id=$1 AND connector_source_snapshot_id=$2`, [principal.tenantId, published.snapshot_id]);
    expect(revocation.rows[0]).toEqual({ count: '1', actor: `principal:${principal.userId}`,
      reason_digest: '7'.repeat(64) });
    await expect(repository.getEvidence(principal, published.status_evidence_id)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_FOUND', statusCode: 404,
    });
    await expect(repository.getTask(principal, created.taskId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND', statusCode: 404,
    });
    await expect(control.pool.query(`UPDATE gate_a3_connector_source_revocations SET actor='tampered'
      WHERE tenant_id=$1 AND connector_source_snapshot_id=$2`, [principal.tenantId, published.snapshot_id]))
      .rejects.toThrow();
    await expect(control.pool.query(`DELETE FROM gate_a3_connector_source_revocations
      WHERE tenant_id=$1 AND connector_source_snapshot_id=$2`, [principal.tenantId, published.snapshot_id]))
      .rejects.toThrow();
  });

  it('derives current source access from an append-only revocation before any model publication', async () => {
    const scenario = await createTaskThroughConnectorSnapshot('source-revoked-before-model', 'WO-SOURCE-REVOKED');
    await repository.revokeConnectorSourceAccess(principal,
      scenario.sourceSnapshot.connectorSourceSnapshotId, 'gate-a3-access-controller', '8'.repeat(64));
    await repository.revokeConnectorSourceAccess(principal,
      scenario.sourceSnapshot.connectorSourceSnapshotId, 'gate-a3-access-controller', '8'.repeat(64));
    const progress = { schemaVersion: 'work-order.progress/1', planQty: 10, completedQty: 4,
      progressPct: 40, calculationStatus: 'computed' } as const;
    await expect(repository.checkpointWorkOrder(mutationOf(scenario.claim), scenario.computeStep,
      progress, 60_000)).rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_REVOKED', statusCode: 404 });
    await repository.settleWorkOrder(mutationOf(scenario.claim), {
      status: 'failed', errorClass: 'WORK_ORDER_PROTOCOL_VIOLATION',
    }, scenario.computeStep);
    await expect(repository.getTask(principal, scenario.created.taskId)).resolves.toMatchObject({
      status: 'failed', result: { kind: 'failed', code: 'WORK_ORDER_PROTOCOL_VIOLATION' },
    });
    const counts = await control.pool.query<{ revocations: string; model_invocations: string;
      results: string; completed: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_connector_source_revocations
        WHERE connector_source_snapshot_id=$1) revocations,
      (SELECT count(*)::text FROM gate_a3_model_invocations WHERE business_task_id=$2) model_invocations,
      (SELECT count(*)::text FROM gate_a3_work_order_results WHERE business_task_id=$2) results,
      (SELECT count(*)::text FROM business_tasks WHERE id=$2 AND status='completed') completed`, [
      scenario.sourceSnapshot.connectorSourceSnapshotId, scenario.created.taskId,
    ]);
    expect(counts.rows[0]).toEqual({ revocations: '1', model_invocations: '0', results: '0', completed: '0' });
  });

  it('revalidates coherent field and whole locator identity before issuing any model token', async () => {
    const fieldScenario = await createTaskThroughConnectorSnapshot('field-locator-tamper', 'WO-FIELD-TAMPER');
    const tamperedField = {
      schemaVersion: 'connector-evidence-field/1', canonicalizationVersion: 'RFC8785/JCS-1',
      fieldName: 'status', fieldType: 'string', canonicalValue: 'Tampered Status',
    } as const;
    const fieldClient = await control.pool.connect();
    try {
      await fieldClient.query('BEGIN');
      await fieldClient.query(`ALTER TABLE gate_a3_connector_evidence
        DISABLE TRIGGER gate_a3_connector_evidence_immutable`);
      await fieldClient.query(`UPDATE gate_a3_connector_evidence
        SET canonical_field=$3,canonical_field_hash=$4
        WHERE tenant_id=$1 AND business_task_id=$2 AND field_name='status'`, [
        principal.tenantId, fieldScenario.created.taskId, tamperedField, digest(tamperedField),
      ]);
      await fieldClient.query(`ALTER TABLE gate_a3_connector_evidence
        ENABLE TRIGGER gate_a3_connector_evidence_immutable`);
      await fieldClient.query('COMMIT');
    } catch (error) {
      await fieldClient.query('ROLLBACK').catch(() => undefined);
      await fieldClient.query(`ALTER TABLE gate_a3_connector_evidence
        ENABLE TRIGGER gate_a3_connector_evidence_immutable`).catch(() => undefined);
      throw error;
    } finally {
      fieldClient.release();
    }
    const progress = { schemaVersion: 'work-order.progress/1', planQty: 10, completedQty: 4,
      progressPct: 40, calculationStatus: 'computed' } as const;
    await expect(repository.checkpointWorkOrder(mutationOf(fieldScenario.claim), fieldScenario.computeStep,
      progress, 60_000)).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_FAILED', statusCode: 409 });
    await repository.settleWorkOrder(mutationOf(fieldScenario.claim), {
      status: 'failed', errorClass: 'WORK_ORDER_PROTOCOL_VIOLATION',
    }, fieldScenario.computeStep);

    const wholeScenario = await createTaskThroughConnectorSnapshot('whole-locator-tamper', 'WO-WHOLE-TAMPER');
    const wholeClient = await control.pool.connect();
    let wholeTransactionOpen = false;
    try {
      await wholeClient.query('BEGIN');
      wholeTransactionOpen = true;
      await wholeClient.query(`ALTER TABLE gate_a3_connector_evidence
        DISABLE TRIGGER gate_a3_connector_evidence_immutable`);
      await expect(wholeClient.query(`UPDATE gate_a3_connector_evidence SET effect_id=$3
        WHERE tenant_id=$1 AND business_task_id=$2 AND locator_kind='connector_snapshot_whole'`, [
        principal.tenantId, wholeScenario.created.taskId, `effect_${'f'.repeat(48)}`,
      ])).rejects.toMatchObject({ code: '23503' });
      await wholeClient.query('ROLLBACK');
      wholeTransactionOpen = false;
    } finally {
      if (wholeTransactionOpen) await wholeClient.query('ROLLBACK').catch(() => undefined);
      wholeClient.release();
    }
    await repository.cancelTask(
      principal, wholeScenario.created.taskId, 'gate-a3-whole-locator-fk-cleanup',
    );
    const zeroPublication = await control.pool.query<{ model_invocations: string; results: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_model_invocations
        WHERE business_task_id IN ($1,$2)) model_invocations,
      (SELECT count(*)::text FROM gate_a3_work_order_results
        WHERE business_task_id IN ($1,$2)) results`, [fieldScenario.created.taskId, wholeScenario.created.taskId]);
    expect(zeroPublication.rows[0]).toEqual({ model_invocations: '0', results: '0' });
  });

  it('invalidates an issued connector token before network and publishes nothing after cancellation', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-cancel-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-CANCEL' },
      idempotencyKey: 'gate-a3-cancel-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-cancel-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-cancel-execute');
    const claim = await repository.claimWorkOrder('gate-a3-cancel-worker', 60_000);
    if (claim === null) throw new Error('expected cancel Work Order claim');
    const fetchGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: claim.workOrderRef,
    }, 60_000) as Readonly<{ connectorRequest: unknown }>;
    const request = gateA3ConnectorGatewayRequestSchema.parse(fetchGrant.connectorRequest);
    const requestDigest = digest({ schemaVersion: request.schemaVersion, querySpec: request.querySpec,
      querySpecHash: request.querySpecHash });
    await repository.cancelTask(principal, created.taskId, 'gate-a3-cancel-request');
    await expect(repository.consumeConnectorInvocationToken(request.invocationToken, requestDigest))
      .resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
    await expect(repository.requestWorkOrderCancellation(mutationOf(claim), 60_000))
      .resolves.toEqual({ taskFence: claim.taskFence + 1 });
    await repository.settleWorkOrder({ ...mutationOf(claim), taskFence: claim.taskFence + 1 }, {
      status: 'canceled',
    });
    const invocation = await control.pool.query<{ status: string; error_class: string }>(`SELECT status,error_class
      FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2`, [principal.tenantId, created.taskId]);
    expect(invocation.rows[0]).toEqual({ status: 'canceled', error_class: 'USER_CANCELED' });
    const canceled = await repository.getTask(principal, created.taskId);
    expect(canceled).toMatchObject({ status: 'canceled', result: { kind: 'canceled', code: 'USER_CANCELED' } });
    const counts = await control.pool.query<{ snapshots: string; evidence: string; results: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_connector_source_snapshots WHERE business_task_id=$1) snapshots,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1) evidence,
      (SELECT count(*)::text FROM gate_a3_work_order_results WHERE business_task_id=$1) results`, [created.taskId]);
    expect(counts.rows[0]).toEqual({ snapshots: '0', evidence: '0', results: '0' });
  });

  it('accepts only a current signed model failure receipt and settles one stable failed terminal', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-model-failure-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-MODEL-FAILURE' },
      idempotencyKey: 'gate-a3-model-failure-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-model-failure-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-model-failure-execute');
    const claim = await repository.claimWorkOrder('gate-a3-model-failure-worker', 60_000);
    if (claim === null) throw new Error('expected model failure Work Order claim');
    await repository.markWorkOrderStarted(mutationOf(claim));
    const fetchGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: claim.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const connectorRequest = gateA3ConnectorGatewayRequestSchema.parse(fetchGrant.connectorRequest);
    const [encodedConnectorClaims] = connectorRequest.invocationToken.split('.');
    const connectorClaims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedConnectorClaims!, 'base64url').toString('utf8')),
    );
    const gatewayRequestDigest = digest({ schemaVersion: connectorRequest.schemaVersion,
      querySpec: connectorRequest.querySpec, querySpecHash: connectorRequest.querySpecHash });
    await expect(repository.consumeConnectorInvocationToken(
      connectorRequest.invocationToken, gatewayRequestDigest,
    )).resolves.toMatchObject({ active: true });
    const response = {
      workOrderRef: claim.workOrderRef, status: 'In Process', planQty: 10, completedQty: 4,
      unit: 'Nos', plannedStart: '2026-07-27T00:00:00.000000Z',
      plannedEnd: '2026-07-28T00:00:00.000000Z', updatedAt: '2026-07-27T00:01:02.123456Z',
      sourceRevision: '2026-07-27 08:01:02.123456',
    } as const;
    const connectorReceiptPayload = {
      schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
      audience: 'geneway-control-plane', receiptJti: randomUUID(), tenantId: connectorClaims.tenantId,
      principal: connectorClaims.principal, taskId: connectorClaims.taskId,
      workflowVersionId: connectorClaims.workflowVersionId, workflowHash: connectorClaims.workflowHash,
      stepId: connectorClaims.stepId, attemptId: connectorClaims.attemptId, effectId: connectorClaims.effectId,
      connectorInvocationId: connectorClaims.connectorInvocationId,
      connectorQuerySpecHash: connectorClaims.connectorQuerySpecHash,
      connectorProfileVersion: connectorClaims.connectorProfileVersion,
      workOrderRefHash: connectorClaims.workOrderRefHash, fieldMaskVersion: connectorClaims.fieldMaskVersion,
      resourceContextDigest: connectorClaims.resourceContextDigest, deadline: connectorClaims.deadline,
      fence: connectorClaims.fence, jti: connectorClaims.jti, issuedAt: new Date().toISOString(),
      outcome: 'completed', responseRefMatched: true, sourceRevision: response.sourceRevision,
      responseCanonicalHash: digest(response),
    } as const;
    const connectorReceipt = gateA3ConnectorGatewayReceiptSchema.parse({
      payload: connectorReceiptPayload,
      signature: createHmac('sha256', authority.connectorGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(connectorReceiptPayload), 'utf8').digest('base64url'),
    });
    const computeGrant = await repository.checkpointWorkOrder(mutationOf(claim), fetchGrant.step, {
      response, receipt: connectorReceipt,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease }>;
    const progress = { schemaVersion: 'work-order.progress/1', planQty: 10, completedQty: 4,
      progressPct: 40, calculationStatus: 'computed' } as const;
    const explainGrant = await repository.checkpointWorkOrder(mutationOf(claim), computeGrant.step,
      progress, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; modelRequest: unknown }>;
    const modelRequest = gateA3WorkOrderModelRequestSchema.parse(explainGrant.modelRequest);
    await expect(repository.consumeModelInvocationToken(modelRequest.invocationToken)).resolves.toBe(true);
    const { invocationToken: _token, systemPrompt: _systemPrompt, snapshot: _snapshot, progress: _progress,
      schemaVersion: _schemaVersion, ...modelAuthority } = modelRequest;
    void _token;
    void _systemPrompt;
    void _snapshot;
    void _progress;
    void _schemaVersion;
    const failureReceiptPayload = {
      schemaVersion: 'gate-a3-work-order-model-receipt/2', ...modelAuthority,
      issuer: 'geneway-model-gateway', audience: 'geneway-control-plane-work-order',
      receiptJti: randomUUID(), issuedAt: new Date().toISOString(), outcome: 'MODEL_PROTOCOL_VIOLATION',
      outputPayloadDigest: null, providerRevision: null, modelRevision: null, usage: null,
    } as const;
    const failureReceipt = gateA3WorkOrderModelReceiptSchema.parse({
      payload: failureReceiptPayload,
      signature: createHmac('sha256', authority.modelGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(failureReceiptPayload), 'utf8').digest('base64url'),
    });
    const driftedFailurePayload = {
      ...failureReceiptPayload, promptPolicyResolvedBytesSha256: '0'.repeat(64),
    };
    const driftedFailureReceipt = gateA3WorkOrderModelReceiptSchema.parse({
      payload: driftedFailurePayload,
      signature: createHmac('sha256', authority.modelGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(driftedFailurePayload), 'utf8').digest('base64url'),
    });
    await expect(repository.settleWorkOrder(mutationOf(claim), {
      status: 'failed', errorClass: 'MODEL_PROTOCOL_VIOLATION', receipt: driftedFailureReceipt,
    }, explainGrant.step)).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_VIOLATION' });
    await repository.settleWorkOrder(mutationOf(claim), {
      status: 'failed', errorClass: 'MODEL_PROTOCOL_VIOLATION', receipt: failureReceipt,
    }, explainGrant.step);

    await expect(repository.getTask(principal, created.taskId)).resolves.toMatchObject({
      status: 'failed', result: { kind: 'failed', code: 'MODEL_PROTOCOL_VIOLATION' },
    });
    const invocation = await control.pool.query<{ status: string; error_class: string; receipt_digest: string | null }>(`SELECT
      status,error_class,receipt_digest FROM gate_a3_model_invocations
      WHERE tenant_id=$1 AND business_task_id=$2`, [principal.tenantId, created.taskId]);
    expect(invocation.rows[0]).toMatchObject({
      status: 'failed', error_class: 'MODEL_PROTOCOL_VIOLATION', receipt_digest: digest(failureReceipt),
    });
  });

  it('retries a transient connector failure once with fresh invocation authority then settles exactly once', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-retry-terminal-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-RETRY-TERMINAL' },
      idempotencyKey: 'gate-a3-retry-terminal-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-retry-terminal-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-retry-terminal-execute');

    const first = await repository.claimWorkOrder('gate-a3-retry-terminal-first', 60_000);
    if (first === null) throw new Error('expected first transient retry claim');
    await repository.markWorkOrderStarted(mutationOf(first));
    const firstGrant = await repository.checkpointWorkOrder(mutationOf(first), first.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: first.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const firstRequest = gateA3ConnectorGatewayRequestSchema.parse(firstGrant.connectorRequest);
    const retryDisposition = await repository.handleConnectorFailure(mutationOf(first), firstGrant.step, {
      errorClass: 'CONNECTOR_ROUTE_UNAVAILABLE',
    });
    expect(retryDisposition).toMatchObject({ retryScheduled: true });
    if (!retryDisposition.retryScheduled) throw new Error('expected transient connector retry authority');
    await new Promise((resolve) => setTimeout(resolve,
      Math.max(0, Date.parse(retryDisposition.retryNotBefore) - Date.now() + 50)));

    const second = await repository.claimWorkOrder('gate-a3-retry-terminal-second', 60_000);
    if (second === null) throw new Error('expected second transient retry claim');
    expect(second.executionAttemptId).not.toBe(first.executionAttemptId);
    expect(second.taskFence).toBeGreaterThan(first.taskFence);
    await repository.markWorkOrderStarted(mutationOf(second));
    const secondGrant = await repository.checkpointWorkOrder(mutationOf(second), second.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: second.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const secondRequest = gateA3ConnectorGatewayRequestSchema.parse(secondGrant.connectorRequest);
    await expect(repository.handleConnectorFailure(mutationOf(second), secondGrant.step, {
      errorClass: 'CONNECTOR_TIMEOUT',
    })).resolves.toEqual({ retryScheduled: false });
    await expect(repository.handleConnectorFailure(mutationOf(second), secondGrant.step, {
      errorClass: 'CONNECTOR_TIMEOUT',
    })).resolves.toEqual({ retryScheduled: false });

    const firstDigest = digest({ schemaVersion: firstRequest.schemaVersion, querySpec: firstRequest.querySpec,
      querySpecHash: firstRequest.querySpecHash });
    const secondDigest = digest({ schemaVersion: secondRequest.schemaVersion, querySpec: secondRequest.querySpec,
      querySpecHash: secondRequest.querySpecHash });
    await expect(repository.consumeConnectorInvocationToken(firstRequest.invocationToken, firstDigest))
      .resolves.toMatchObject({ active: false });
    await expect(repository.consumeConnectorInvocationToken(secondRequest.invocationToken, secondDigest))
      .resolves.toMatchObject({ active: false });
    await expect(repository.getTask(principal, created.taskId)).resolves.toMatchObject({
      status: 'failed', result: { kind: 'failed', code: 'CONNECTOR_TIMEOUT' },
    });
    const counts = await control.pool.query<{
      invocations: string; effect_ids: string; jtis: string; scheduled: string; snapshots: string;
      evidence: string; model_invocations: string; work_order_results: string; failed_events: string;
    }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_connector_invocations WHERE business_task_id=$1) invocations,
      (SELECT count(DISTINCT effect_id)::text FROM gate_a3_connector_invocations WHERE business_task_id=$1) effect_ids,
      (SELECT count(DISTINCT jti_digest)::text FROM gate_a3_connector_invocations WHERE business_task_id=$1) jtis,
      (SELECT count(*)::text FROM gate_a3_connector_invocations
        WHERE business_task_id=$1 AND retry_scheduled) scheduled,
      (SELECT count(*)::text FROM gate_a3_connector_source_snapshots WHERE business_task_id=$1) snapshots,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1) evidence,
      (SELECT count(*)::text FROM gate_a3_model_invocations WHERE business_task_id=$1) model_invocations,
      (SELECT count(*)::text FROM gate_a3_work_order_results WHERE business_task_id=$1) work_order_results,
      (SELECT count(*)::text FROM business_task_events
        WHERE business_task_id=$1 AND event_type='business_task.failed') failed_events`, [created.taskId]);
    expect(counts.rows[0]).toEqual({
      invocations: '2', effect_ids: '1', jtis: '2', scheduled: '1', snapshots: '0', evidence: '0',
      model_invocations: '0', work_order_results: '0', failed_events: '1',
    });
  });

  it('ignores caller run labels but projects NOT_OPEN when the current Postgres authority envelope differs', async () => {
    const driftedBody = { ...authorityBody, artifactId: 'gate-a3-unadmitted-authority' };
    const driftedRuntime = new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      validationRunId: 'gate-a3-authority-drift',
      envelope: { ...driftedBody, authorityDigest: digest(driftedBody) },
    });
    await expect(driftedRuntime.getCapabilityRoute(principal)).resolves.toEqual({
      capabilityId: 'production.work-order-status.v1', status: 'NOT_OPEN', executionRoute: 'not_open',
    });
    await expect(repository.getCapabilityRoute(principal)).resolves.toMatchObject({
      capabilityId: 'production.work-order-status.v1', status: 'internal', executionRoute: 'live',
    });
  });

  it('renews the current execution, delivery, and step leases while the live Worker heartbeat remains current', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-heartbeat-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-HEARTBEAT' },
      idempotencyKey: 'gate-a3-heartbeat-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-heartbeat-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-heartbeat-execute');
    const claim = await repository.claimWorkOrder('gate-a3-heartbeat-worker', 2_000);
    if (claim === null) throw new Error('expected heartbeat Work Order claim');

    await control.pool.query(`UPDATE execution_attempts SET lease_until=now()+interval '500 milliseconds'
      WHERE tenant_id=$1 AND id=$2`, [claim.tenantId, claim.executionAttemptId]);
    await control.pool.query(`UPDATE outbox_deliveries SET lease_until=now()+interval '500 milliseconds'
      WHERE tenant_id=$1 AND execution_attempt_id=$2`, [claim.tenantId, claim.executionAttemptId]);
    await control.pool.query(`UPDATE business_task_steps SET lease_until=now()+interval '500 milliseconds'
      WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'`, [claim.tenantId, claim.taskId]);

    await expect(repository.requestWorkOrderCancellation(mutationOf(claim), 2_000)).resolves.toBeNull();
    const renewed = await control.pool.query<{ lease_count: string; minimum_remaining_ms: string }>(`SELECT
      count(*)::text lease_count,
      floor(extract(epoch FROM (min(lease_until)-now()))*1000)::text minimum_remaining_ms
      FROM (
        SELECT lease_until FROM execution_attempts WHERE tenant_id=$1 AND id=$2
        UNION ALL
        SELECT lease_until FROM outbox_deliveries WHERE tenant_id=$1 AND execution_attempt_id=$2
        UNION ALL
        SELECT lease_until FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$3 AND status='running'
      ) leases`, [claim.tenantId, claim.executionAttemptId, claim.taskId]);
    expect(renewed.rows[0]?.lease_count).toBe('3');
    expect(Number(renewed.rows[0]?.minimum_remaining_ms)).toBeGreaterThan(1_500);

    await new Promise((resolve) => setTimeout(resolve, 750));
    await repository.markWorkOrderStarted(mutationOf(claim));
    await expect(repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: claim.workOrderRef,
    }, 2_000)).resolves.toMatchObject({ step: { stepId: 'fetch_authorized_status' } });

    await control.pool.query(`UPDATE execution_attempts SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND id=$2`, [claim.tenantId, claim.executionAttemptId]);
    await control.pool.query(`UPDATE outbox_deliveries SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND execution_attempt_id=$2`, [claim.tenantId, claim.executionAttemptId]);
    await control.pool.query(`UPDATE business_task_steps SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'`, [claim.tenantId, claim.taskId]);
    await expect(repository.requestWorkOrderCancellation(mutationOf(claim), 2_000))
      .rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_STALE' });
    const replacement = await repository.claimWorkOrder('gate-a3-heartbeat-replacement', 2_000);
    if (replacement === null) throw new Error('expected heartbeat replacement Work Order claim');
    expect(replacement.executionAttemptId).not.toBe(claim.executionAttemptId);
    expect(replacement.taskFence).toBeGreaterThan(claim.taskFence);
    await repository.cancelTask(principal, created.taskId, 'gate-a3-heartbeat-cleanup');
  });

  it('reclaims an expired attempt with a new execution and step fence before any connector network', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-reclaim-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-RECLAIM' },
      idempotencyKey: 'gate-a3-reclaim-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-reclaim-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-reclaim-execute');
    const first = await repository.claimWorkOrder('gate-a3-reclaim-worker-old', 60_000);
    if (first === null) throw new Error('expected first reclaim claim');
    const oldGrant = await repository.checkpointWorkOrder(mutationOf(first), first.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: first.workOrderRef,
    }, 60_000) as Readonly<{ connectorRequest: unknown }>;
    const oldRequest = gateA3ConnectorGatewayRequestSchema.parse(oldGrant.connectorRequest);
    await control.pool.query(`UPDATE execution_attempts SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND id=$2`, [first.tenantId, first.executionAttemptId]);
    await control.pool.query(`UPDATE outbox_deliveries SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND execution_attempt_id=$2`, [first.tenantId, first.executionAttemptId]);
    const replacement = await repository.claimWorkOrder('gate-a3-reclaim-worker-new', 60_000);
    expect(replacement).not.toBeNull();
    if (replacement === null) throw new Error('expected replacement reclaim claim');
    expect(replacement.executionAttemptId).not.toBe(first.executionAttemptId);
    expect(replacement.taskFence).toBeGreaterThan(first.taskFence);
    const oldDigest = digest({ schemaVersion: oldRequest.schemaVersion, querySpec: oldRequest.querySpec,
      querySpecHash: oldRequest.querySpecHash });
    await expect(repository.consumeConnectorInvocationToken(oldRequest.invocationToken, oldDigest))
      .resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
    const oldInvocation = await control.pool.query<{ status: string; error_class: string }>(`SELECT status,error_class
      FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2
      ORDER BY created_at LIMIT 1`, [first.tenantId, created.taskId]);
    expect(oldInvocation.rows[0]).toEqual({ status: 'failed', error_class: 'LEASE_EXPIRED' });
    await repository.cancelTask(principal, created.taskId, 'gate-a3-reclaim-cleanup');
  });

  it('terminalizes queued and running expiry once without publishing connector or model data', async () => {
    const queuedConversation = await control.createConversation(principal, 'gate-a3-expired-queued-conversation');
    const queued = await repository.createTask(principal, {
      conversationId: queuedConversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-EXPIRED-QUEUED' },
      idempotencyKey: 'gate-a3-expired-queued-task',
    });
    await repository.decideApproval(principal, queued.approvalId, 'approved', 'gate-a3-expired-queued-approval');
    const queuedApproved = await repository.getTask(principal, queued.taskId);
    await repository.executeTask(principal, queued.taskId, {
      expectedApprovalVersion: queuedApproved.approval.version,
      expectedApprovalSubjectDigest: queuedApproved.approval.subjectDigest,
    }, 'gate-a3-expired-queued-execute');
    await control.pool.query(`UPDATE approval_versions SET expires_at=now()-interval '1 second'
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, queued.approvalId]);
    await expect(repository.claimWorkOrder('gate-a3-expired-queued-worker', 60_000)).resolves.toBeNull();
    await expect(repository.getTask(principal, queued.taskId)).resolves.toMatchObject({
      status: 'failed', result: { kind: 'failed', code: 'CONNECTOR_AUTH_FAILED' },
    });
    await expect(repository.claimWorkOrder('gate-a3-expired-queued-repeat', 60_000)).resolves.toBeNull();

    const runningConversation = await control.createConversation(principal, 'gate-a3-expired-running-conversation');
    const running = await repository.createTask(principal, {
      conversationId: runningConversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-EXPIRED-RUNNING' },
      idempotencyKey: 'gate-a3-expired-running-task',
    });
    await repository.decideApproval(principal, running.approvalId, 'approved', 'gate-a3-expired-running-approval');
    const runningApproved = await repository.getTask(principal, running.taskId);
    await repository.executeTask(principal, running.taskId, {
      expectedApprovalVersion: runningApproved.approval.version,
      expectedApprovalSubjectDigest: runningApproved.approval.subjectDigest,
    }, 'gate-a3-expired-running-execute');
    const runningClaim = await repository.claimWorkOrder('gate-a3-expired-running-worker', 60_000);
    if (runningClaim === null) throw new Error('expected running expiry claim');
    await control.pool.query(`UPDATE approval_versions SET expires_at=now()-interval '1 second'
      WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, running.approvalId]);
    await expect(repository.claimWorkOrder('gate-a3-expired-running-sweep', 60_000)).resolves.toBeNull();
    await expect(repository.getTask(principal, running.taskId)).resolves.toMatchObject({
      status: 'failed', result: { kind: 'failed', code: 'CONNECTOR_AUTH_FAILED' },
    });
    const counts = await control.pool.query<{ failed_events: string; snapshots: string; evidence: string;
      model_invocations: string; results: string; running_attempts: string }>(`SELECT
      (SELECT count(*)::text FROM business_task_events
        WHERE business_task_id IN ($1,$2) AND event_type='business_task.failed') failed_events,
      (SELECT count(*)::text FROM gate_a3_connector_source_snapshots
        WHERE business_task_id IN ($1,$2)) snapshots,
      (SELECT count(*)::text FROM gate_a3_connector_evidence
        WHERE business_task_id IN ($1,$2)) evidence,
      (SELECT count(*)::text FROM gate_a3_model_invocations
        WHERE business_task_id IN ($1,$2)) model_invocations,
      (SELECT count(*)::text FROM gate_a3_work_order_results
        WHERE business_task_id IN ($1,$2)) results,
      (SELECT count(*)::text FROM execution_attempts
        WHERE business_task_id IN ($1,$2) AND status='running') running_attempts`, [queued.taskId, running.taskId]);
    expect(counts.rows[0]).toEqual({
      failed_events: '2', snapshots: '0', evidence: '0', model_invocations: '0', results: '0', running_attempts: '0',
    });
  });

  it('keeps expired-lease reclaim inside tenant_local', async () => {
    const tenantId = 'tenant_gate_a3_reclaim_foreign';
    const foreignPrincipal = { tenantId, userId: 'foreign_user', trust: 'trusted-local' } as const;
    await control.pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'Gate A.3 foreign reclaim tenant']);
    await control.pool.query('INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,$3)', [
      tenantId, foreignPrincipal.userId, 'Gate A.3 foreign reclaim user',
    ]);
    await repository.seedAuthority(tenantId);
    await repository.promoteAuthority('shadow', tenantId);
    await repository.promoteAuthority('internal', tenantId);
    const conversation = await control.createConversation(foreignPrincipal, 'gate-a3-foreign-reclaim-conversation');
    const created = await repository.createTask(foreignPrincipal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-FOREIGN-RECLAIM' },
      idempotencyKey: 'gate-a3-foreign-reclaim-task',
    });
    await repository.decideApproval(foreignPrincipal, created.approvalId, 'approved', 'gate-a3-foreign-reclaim-approval');
    const approved = await repository.getTask(foreignPrincipal, created.taskId);
    await repository.executeTask(foreignPrincipal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-foreign-reclaim-execute');
    const queued = await control.pool.query<{ execution_version: string; execution_fencing_token: string;
      event_id: string }>(`SELECT task.execution_version::text,task.execution_fencing_token::text,outbox.event_id
      FROM business_tasks task JOIN outbox_events outbox ON outbox.tenant_id=task.tenant_id
        AND outbox.business_task_id=task.id AND outbox.event_type='workflow.run_requested'
      WHERE task.tenant_id=$1 AND task.id=$2 ORDER BY outbox.created_at DESC LIMIT 1`, [tenantId, created.taskId]);
    const queuedRow = queued.rows[0];
    if (queuedRow === undefined) throw new Error('expected foreign queued task');
    const attemptId = `attempt_${randomUUID()}`;
    const deliveryId = `delivery_${randomUUID()}`;
    const workerId = `foreign-worker-${randomUUID()}`;
    const stepAttemptId = `step_attempt_${randomUUID()}`;
    const fence = Number(queuedRow.execution_fencing_token) + 1;
    const foreignClient = await control.pool.connect();
    try {
      await foreignClient.query('BEGIN');
      await foreignClient.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,
         worker_instance_id,status,fencing_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,'gate0.2a-worker','gate0.2a-local',$6,'running',$7,now()-interval '1 second')`, [
        tenantId, attemptId, created.taskId, Number(queuedRow.execution_version), queuedRow.event_id, workerId, fence,
      ]);
      await foreignClient.query(`INSERT INTO outbox_deliveries
        (tenant_id,id,business_task_id,consumer,deployment_id,event_id,status,execution_attempt_id,
         worker_instance_id,fencing_token,lease_until)
        VALUES ($1,$2,$3,'gate0.2a-worker','gate0.2a-local',$4,'leased',$5,$6,$7,now()-interval '1 second')`, [
        tenantId, deliveryId, created.taskId, queuedRow.event_id, attemptId, workerId, fence,
      ]);
      await foreignClient.query(`INSERT INTO inbox_events
        (tenant_id,consumer,deployment_id,event_id,delivery_id,business_task_id,execution_attempt_id,
         worker_instance_id,fencing_token,status,processing_at)
        VALUES ($1,'gate0.2a-worker','gate0.2a-local',$2,$3,$4,$5,$6,$7,'processing',now())`, [
        tenantId, queuedRow.event_id, deliveryId, created.taskId, attemptId, workerId, fence,
      ]);
      await foreignClient.query(`UPDATE business_tasks SET status='running',current_execution_attempt_id=$3,
        execution_fencing_token=$4 WHERE tenant_id=$1 AND id=$2`, [tenantId, created.taskId, attemptId, fence]);
      await foreignClient.query(`UPDATE business_task_steps SET status='running',attempt_id=$3,
        fencing_token=fencing_token+1,lease_until=now()-interval '1 second'
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id='validate_work_order_ref'`, [
        tenantId, created.taskId, stepAttemptId,
      ]);
      await foreignClient.query('COMMIT');
    } catch (error) {
      await foreignClient.query('ROLLBACK');
      throw error;
    } finally {
      foreignClient.release();
    }
    const before = await control.pool.query<{ events: string }>(`SELECT count(*)::text events
      FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2`, [tenantId, created.taskId]);
    await expect(repository.claimWorkOrder('gate-a3-tenant-local-isolation', 60_000)).resolves.toBeNull();
    const after = await control.pool.query<{ task_status: string; attempt_status: string; events: string }>(`SELECT
      task.status task_status,attempt.status attempt_status,
      (SELECT count(*)::text FROM business_task_events event
        WHERE event.tenant_id=task.tenant_id AND event.business_task_id=task.id) events
      FROM business_tasks task JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id
        AND attempt.id=task.current_execution_attempt_id
      WHERE task.tenant_id=$1 AND task.id=$2`, [tenantId, created.taskId]);
    expect(after.rows[0]).toEqual({ task_status: 'running', attempt_status: 'running', events: before.rows[0]?.events });
    await repository.cancelTask(foreignPrincipal, created.taskId, 'gate-a3-foreign-reclaim-cleanup');
  });

  it('fails connector introspection closed without consuming the JTI when runtime authority drifts', async () => {
    const grant = await createTaskThroughConnectorGrant(
      'runtime-drift-before-introspection', 'WO-TEST-RUNTIME-DRIFT',
    );
    let runtimeChecks = 0;
    const driftedRepository = new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      assertRuntimeAuthority: () => {
        runtimeChecks += 1;
        return Promise.reject(new Error('runtime generation drifted'));
      },
    });
    await expect(driftedRepository.consumeConnectorInvocationToken(
      grant.connectorRequest.invocationToken, grant.requestDigest,
    )).resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
    expect(runtimeChecks).toBe(1);
    const unchanged = await control.pool.query<{ consumed_at: Date | null; invocation_status: string }>(`SELECT
      authz.consumed_at,invocation.status invocation_status
      FROM gate_a3_connector_invocations invocation
      JOIN gate_a3_connector_token_authorizations authz
        ON authz.tenant_id=invocation.tenant_id
        AND authz.connector_invocation_id=invocation.id
      WHERE invocation.tenant_id=$1 AND invocation.business_task_id=$2`, [principal.tenantId, grant.created.taskId]);
    expect(unchanged.rows[0]).toEqual({ consumed_at: null, invocation_status: 'authorized' });
    await repository.cancelTask(
      principal, grant.created.taskId, 'gate-a3-runtime-drift-introspection-cleanup',
    );
  });

  it('rejects connector introspection immediately while an exclusive authority mutation is pending', async () => {
    const grant = await createTaskThroughConnectorGrant(
      'exclusive-lock-before-introspection', 'WO-TEST-EXCLUSIVE-LOCK',
    );
    const blocker = await control.pool.connect();
    const introspectionPool = new Pool({ connectionString: databaseUrl, max: 1 });
    let transactionOpen = false;
    let runtimeChecks = 0;
    try {
      await introspectionPool.query('SET statement_timeout = 1000');
      await blocker.query('BEGIN');
      transactionOpen = true;
      await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [1_196_313_667, 3]);
      const introspectionRepository = new GateA3WorkOrderRepository(introspectionPool, {
        ...authority,
        assertRuntimeAuthority: () => {
          runtimeChecks += 1;
          return Promise.resolve();
        },
      });
      const startedAt = performance.now();
      await expect(introspectionRepository.consumeConnectorInvocationToken(
        grant.connectorRequest.invocationToken, grant.requestDigest,
      )).resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
      expect(performance.now() - startedAt).toBeLessThan(750);
      expect(runtimeChecks).toBe(0);
      const unchanged = await control.pool.query<{ consumed_at: Date | null; invocation_status: string }>(`SELECT
        authz.consumed_at,invocation.status invocation_status
        FROM gate_a3_connector_invocations invocation
        JOIN gate_a3_connector_token_authorizations authz
          ON authz.tenant_id=invocation.tenant_id
          AND authz.connector_invocation_id=invocation.id
        WHERE invocation.tenant_id=$1 AND invocation.business_task_id=$2`, [principal.tenantId, grant.created.taskId]);
      expect(unchanged.rows[0]).toEqual({ consumed_at: null, invocation_status: 'authorized' });
      await blocker.query('COMMIT');
      transactionOpen = false;
      await repository.cancelTask(
        principal, grant.created.taskId, 'gate-a3-exclusive-lock-introspection-cleanup',
      );
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await introspectionPool.end();
    }
  });

  it('consumes one connector JTI exactly once under parallel repository replay', async () => {
    const grant = await createTaskThroughConnectorGrant(
      'parallel-introspection-replay', 'WO-TEST-PARALLEL-REPLAY',
    );
    const results = await Promise.all([
      repository.consumeConnectorInvocationToken(
        grant.connectorRequest.invocationToken, grant.requestDigest,
      ),
      repository.consumeConnectorInvocationToken(
        grant.connectorRequest.invocationToken, grant.requestDigest,
      ),
    ]);
    expect(results.filter((result) => result.active)).toHaveLength(1);
    expect(results.filter((result) => !result.active)).toHaveLength(1);
    const consumed = await control.pool.query<{ consumed: string; invocation_status: string }>(`SELECT
      count(*) FILTER (WHERE authz.consumed_at IS NOT NULL)::text consumed,
      min(invocation.status) invocation_status
      FROM gate_a3_connector_invocations invocation
      JOIN gate_a3_connector_token_authorizations authz
        ON authz.tenant_id=invocation.tenant_id
        AND authz.connector_invocation_id=invocation.id
      WHERE invocation.tenant_id=$1 AND invocation.business_task_id=$2`, [
      principal.tenantId, grant.created.taskId,
    ]);
    expect(consumed.rows[0]).toEqual({ consumed: '1', invocation_status: 'running' });
    await repository.cancelTask(
      principal, grant.created.taskId, 'gate-a3-parallel-introspection-cleanup',
    );
  });

  it('uses the real approval and cancellation entrypoints in the shared authority lock order', async () => {
    const tenantId = 'tenant_gate_a3_entry_lock';
    const lockPrincipal = { tenantId, userId: 'lock_user', trust: 'trusted-local' } as const;
    await control.pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'Gate A.3 entry lock tenant']);
    await control.pool.query('INSERT INTO users (tenant_id,id,display_name) VALUES ($1,$2,$3)', [
      tenantId, lockPrincipal.userId, 'Gate A.3 entry lock user',
    ]);
    await repository.seedAuthority(tenantId);
    await repository.promoteAuthority('shadow', tenantId);
    await repository.promoteAuthority('internal', tenantId);
    const conversation = await control.createConversation(lockPrincipal, 'gate-a3-entry-lock-conversation');
    const created = await repository.createTask(lockPrincipal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-ENTRY-LOCK' },
      idempotencyKey: 'gate-a3-entry-lock-task',
    });
    const blocker = await control.pool.connect();
    const applicationName = `gate-a3-entry-${randomUUID()}`;
    const entryPool = new Pool({ connectionString: databaseUrl, max: 1, application_name: applicationName });
    const entryRepository = new GateA3WorkOrderRepository(entryPool, authority);
    const observeWait = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const activity = await control.pool.query<{ wait_event_type: string | null; wait_event: string | null }>(`SELECT
          wait_event_type,wait_event FROM pg_stat_activity WHERE application_name=$1`, [applicationName]);
        if (activity.rows.some((row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory')) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('actual Gate A.3 entrypoint did not wait on the authority advisory lock');
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [1_196_313_667, 3]);
      const approval = entryRepository.decideApproval(
        lockPrincipal, created.approvalId, 'approved', 'gate-a3-entry-lock-approval',
      );
      await observeWait();
      await blocker.query('COMMIT');
      await approval;

      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1,$2)', [1_196_313_667, 3]);
      const cancellation = entryRepository.cancelTask(lockPrincipal, created.taskId, 'gate-a3-entry-lock-cancel');
      await observeWait();
      await blocker.query('COMMIT');
      await expect(cancellation).resolves.toMatchObject({ status: 'canceled' });

      const revokedTask = await repository.createTask(lockPrincipal, {
        conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
        inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-REVOKED-APPROVAL' },
        idempotencyKey: 'gate-a3-revoked-approval-task',
      });
      await repository.revokeAuthority('5'.repeat(64), 'gate-a3-entry-lock-revocation', tenantId);
      await expect(entryRepository.decideApproval(
        lockPrincipal, revokedTask.approvalId, 'approved', 'gate-a3-revoked-approval-decision',
      )).rejects.toMatchObject({ code: 'NOT_OPEN' });
      await expect(entryRepository.cancelTask(
        lockPrincipal, revokedTask.taskId, 'gate-a3-revoked-approval-cleanup',
      )).resolves.toMatchObject({ status: 'canceled' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await entryPool.end();
    }
  });

  it('linearizes runtime shared authority before an exclusive revocation mutation', async () => {
    const tenantId = 'tenant_gate_a3_authority_lock';
    await control.pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'Gate A.3 authority lock test']);
    await repository.seedAuthority(tenantId);
    await repository.promoteAuthority('shadow', tenantId);
    await repository.promoteAuthority('internal', tenantId);
    const blocker = await control.pool.connect();
    const applicationName = `gate-a3-revoke-${randomUUID()}`;
    const revocationPool = new Pool({ connectionString: databaseUrl, max: 1, application_name: applicationName });
    const revocationRepository = new GateA3WorkOrderRepository(revocationPool, authority);
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock_shared($1,$2)', [1_196_313_667, 3]);
      const revocation = revocationRepository.revokeAuthority(
        '7'.repeat(64), 'gate-a3-linearization-test', tenantId,
      );
      const waitDeadline = Date.now() + 5_000;
      let observedAdvisoryWait = false;
      while (Date.now() < waitDeadline) {
        const activity = await control.pool.query<{ wait_event_type: string | null; wait_event: string | null }>(`SELECT
          wait_event_type,wait_event FROM pg_stat_activity WHERE application_name=$1`, [applicationName]);
        if (activity.rows.some((row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory')) {
          observedAdvisoryWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedAdvisoryWait).toBe(true);
      const beforeCommit = await control.pool.query<{ count: string }>(`SELECT count(*)::text count
        FROM gate_a3_authority_revocations WHERE tenant_id=$1`, [tenantId]);
      expect(beforeCommit.rows[0]?.count).toBe('0');
      await blocker.query('COMMIT');
      await revocation;
      const afterCommit = await control.pool.query<{ count: string }>(`SELECT count(*)::text count
        FROM gate_a3_authority_revocations WHERE tenant_id=$1`, [tenantId]);
      expect(afterCommit.rows[0]?.count).toBe('1');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await revocationPool.end();
    }
  });

  it('renews only from the current admission and fails closed after expiry or append-only revocation', async () => {
    const conversation = await control.createConversation(principal, 'gate-a3-renewal-conversation');
    const created = await repository.createTask(principal, {
      conversationId: conversation.id, capabilityId: 'production.work-order-status.v1',
      inputRef: { kind: 'work_order', workOrderRef: 'WO-TEST-AUTHORITY-RENEWAL' },
      idempotencyKey: 'gate-a3-renewal-task',
    });
    await repository.decideApproval(principal, created.approvalId, 'approved', 'gate-a3-renewal-approval');
    const approved = await repository.getTask(principal, created.taskId);
    await repository.executeTask(principal, created.taskId, {
      expectedApprovalVersion: approved.approval.version,
      expectedApprovalSubjectDigest: approved.approval.subjectDigest,
    }, 'gate-a3-renewal-execute');
    const claim = await repository.claimWorkOrder('gate-a3-renewal-worker', 60_000);
    if (claim === null) throw new Error('expected authority-renewal claim');
    const oldGrant = await repository.checkpointWorkOrder(mutationOf(claim), claim.step, {
      schemaVersion: 'work-order.ref/1', workOrderRef: claim.workOrderRef,
    }, 60_000) as Readonly<{ step: GateA3WorkOrderStepLease; connectorRequest: unknown }>;
    const oldRequest = gateA3ConnectorGatewayRequestSchema.parse(oldGrant.connectorRequest);
    const oldRequestDigest = digest({ schemaVersion: oldRequest.schemaVersion,
      querySpec: oldRequest.querySpec, querySpecHash: oldRequest.querySpecHash });
    const [encodedOldClaims] = oldRequest.invocationToken.split('.');
    const oldClaims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedOldClaims!, 'base64url').toString('utf8')),
    );
    await expect(repository.consumeConnectorInvocationToken(oldRequest.invocationToken, oldRequestDigest))
      .resolves.toMatchObject({ active: true });
    const lateResponse = {
      workOrderRef: claim.workOrderRef, status: 'In Process', planQty: 10, completedQty: 4,
      unit: 'Nos', plannedStart: '2026-07-27T00:00:00.000000Z',
      plannedEnd: '2026-07-28T00:00:00.000000Z', updatedAt: '2026-07-27T00:01:02.123456Z',
      sourceRevision: '2026-07-27 08:01:02.123456',
    } as const;
    const lateReceiptPayload = {
      schemaVersion: 'gate-a3-connector-gateway-receipt/1', issuer: 'geneway-connector-gateway',
      audience: 'geneway-control-plane', receiptJti: randomUUID(), tenantId: oldClaims.tenantId,
      principal: oldClaims.principal, taskId: oldClaims.taskId, workflowVersionId: oldClaims.workflowVersionId,
      workflowHash: oldClaims.workflowHash, stepId: oldClaims.stepId, attemptId: oldClaims.attemptId,
      effectId: oldClaims.effectId, connectorInvocationId: oldClaims.connectorInvocationId,
      connectorQuerySpecHash: oldClaims.connectorQuerySpecHash,
      connectorProfileVersion: oldClaims.connectorProfileVersion, workOrderRefHash: oldClaims.workOrderRefHash,
      fieldMaskVersion: oldClaims.fieldMaskVersion, resourceContextDigest: oldClaims.resourceContextDigest,
      deadline: oldClaims.deadline, fence: oldClaims.fence, jti: oldClaims.jti,
      issuedAt: new Date().toISOString(), outcome: 'completed', responseRefMatched: true,
      sourceRevision: lateResponse.sourceRevision, responseCanonicalHash: digest(lateResponse),
    } as const;
    const lateReceipt = gateA3ConnectorGatewayReceiptSchema.parse({ payload: lateReceiptPayload,
      signature: createHmac('sha256', authority.connectorGatewayReceiptSecret)
        .update(canonicalizeGateA3Jcs(lateReceiptPayload), 'utf8').digest('base64url') });
    await repository.revokeAuthority('6'.repeat(64), 'gate-a3-late-result-revocation');
    await expect(repository.checkpointWorkOrder(mutationOf(claim), oldGrant.step, {
      response: lateResponse, receipt: lateReceipt,
    }, 60_000)).rejects.toMatchObject({ code: 'NOT_OPEN' });
    const lateCounts = await control.pool.query<{ snapshots: string; evidence: string;
      model_invocations: string; results: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_connector_source_snapshots WHERE business_task_id=$1) snapshots,
      (SELECT count(*)::text FROM gate_a3_connector_evidence WHERE business_task_id=$1) evidence,
      (SELECT count(*)::text FROM gate_a3_model_invocations WHERE business_task_id=$1) model_invocations,
      (SELECT count(*)::text FROM gate_a3_work_order_results WHERE business_task_id=$1) results`, [created.taskId]);
    expect(lateCounts.rows[0]).toEqual({ snapshots: '0', evidence: '0', model_invocations: '0', results: '0' });
    const renewalBody = {
      ...authorityBody,
      artifactId: 'gate-a3-renewed-authority',
      internalValidationAdmissionDigest: 'e'.repeat(64),
      renewalOfInternalAdmissionDigest: authority.envelope.internalValidationAdmissionDigest,
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 1_200).toISOString(),
    };
    const renewed = new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      envelope: { ...renewalBody, authorityDigest: digest(renewalBody) },
    });
    await renewed.activateAuthorityEnvelope();
    await renewed.promoteAuthority('shadow');
    await renewed.promoteAuthority('internal');
    await expect(renewed.isInternalRelease('tenant_local')).resolves.toBe(true);
    await expect(repository.consumeConnectorInvocationToken(oldRequest.invocationToken, oldRequestDigest))
      .resolves.toEqual({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false });
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    await expect(renewed.isInternalRelease('tenant_local')).resolves.toBe(false);
    await renewed.revokeAuthority('f'.repeat(64), 'gate-a3-integration-reviewer');
    await expect(renewed.isInternalRelease('tenant_local')).resolves.toBe(false);
  });

  it('rejects a detached renewal before it enters a fresh authority ledger', async () => {
    await control.resetForTest();
    const detachedBody = {
      ...authorityBody,
      artifactId: 'gate-a3-detached-renewal',
      internalValidationAdmissionDigest: '9'.repeat(64),
      renewalOfInternalAdmissionDigest: '8'.repeat(64),
    };
    const detached = new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      envelope: { ...detachedBody, authorityDigest: digest(detachedBody) },
    });
    await expect(detached.seedAuthority()).rejects.toThrow(/detached renewal/iu);
    const counts = await control.pool.query<{ envelopes: string; stages: string; current: string }>(`SELECT
      (SELECT count(*)::text FROM gate_a3_authority_envelopes) envelopes,
      (SELECT count(*)::text FROM gate_a3_authority_stages) stages,
      (SELECT count(*)::text FROM gate_a3_authority_current) current`);
    expect(counts.rows[0]).toEqual({ envelopes: '0', stages: '0', current: '0' });
  });

  it('bootstraps a canonical signed renewal into a fresh ledger with an immutable exact proof', async () => {
    await control.resetForTest();
    const renewedBody = {
      ...authorityBody,
      artifactId: 'gate-a3-canonical-bootstrap-renewal',
      internalValidationAdmissionDigest: '7'.repeat(64),
      renewalOfInternalAdmissionDigest: '6'.repeat(64),
    };
    const envelope = { ...renewedBody, authorityDigest: digest(renewedBody) };
    const admitted = new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      envelope,
      canonicalSignedRenewalBootstrap: {
        proofKind: 'canonical-signed-renewal-bootstrap/1',
        authorityDigest: envelope.authorityDigest,
        internalAdmissionDigest: envelope.internalValidationAdmissionDigest,
        renewalOfInternalAdmissionDigest: envelope.renewalOfInternalAdmissionDigest,
        externalSignatureVerified: true,
      },
    });
    await admitted.activateAuthorityEnvelope();
    await admitted.promoteAuthority('shadow');
    await admitted.promoteAuthority('internal');
    await expect(admitted.isInternalRelease('tenant_local')).resolves.toBe(true);
    const proof = await control.pool.query<{ authority_digest: string; internal_admission_digest: string;
      renewal_of_internal_admission_digest: string; proof_kind: string; validation_run_id: string;
      admitted_by: string; external_signature_verified: boolean }>(`SELECT authority_digest,
        internal_admission_digest,renewal_of_internal_admission_digest,proof_kind,validation_run_id,
        admitted_by,external_signature_verified FROM gate_a3_authority_bootstrap_admissions`);
    expect(proof.rows).toEqual([{
      authority_digest: envelope.authorityDigest,
      internal_admission_digest: envelope.internalValidationAdmissionDigest,
      renewal_of_internal_admission_digest: envelope.renewalOfInternalAdmissionDigest,
      proof_kind: 'canonical-signed-renewal-bootstrap/1',
      validation_run_id: authority.validationRunId,
      admitted_by: 'geneway-gate-a3-release-helper',
      external_signature_verified: true,
    }]);
    await expect(control.pool.query(`UPDATE gate_a3_authority_bootstrap_admissions
      SET validation_run_id='tampered'`)).rejects.toThrow(/append-only/iu);
    await expect(control.pool.query('DELETE FROM gate_a3_authority_bootstrap_admissions'))
      .rejects.toThrow(/append-only/iu);
    expect(() => new GateA3WorkOrderRepository(control.pool, {
      ...authority,
      envelope,
      canonicalSignedRenewalBootstrap: {
        proofKind: 'canonical-signed-renewal-bootstrap/1',
        authorityDigest: '5'.repeat(64),
        internalAdmissionDigest: envelope.internalValidationAdmissionDigest,
        renewalOfInternalAdmissionDigest: envelope.renewalOfInternalAdmissionDigest,
        externalSignatureVerified: true,
      },
    })).toThrow(/does not match/iu);
  });
});

describe('0017 Gate A.3 exact PromptPolicy authority migration', () => {
  it('backfills exact UTF-8 bytes and fails closed for unknown historical policies', async () => {
    const migrationSql = await readFile(new URL('../../../migrations/0017_gate_a3_prompt_authority.sql',
      import.meta.url), 'utf8');
    const lifecycleMigrationSql = await readFile(new URL('../../../migrations/0015_gate_a3_terminal_authority.sql',
      import.meta.url), 'utf8');
    const triggerStart = lifecycleMigrationSql.indexOf(
      'CREATE OR REPLACE FUNCTION guard_gate_a3_model_invocation()',
    );
    const triggerEndMarker = `CREATE TRIGGER gate_a3_model_invocations_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON gate_a3_model_invocations
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_model_invocation();`;
    const triggerEnd = lifecycleMigrationSql.indexOf(triggerEndMarker, triggerStart);
    if (triggerStart < 0 || triggerEnd < 0) throw new Error('0015 model lifecycle trigger source is unavailable');
    const lifecycleTriggerSql = lifecycleMigrationSql.slice(
      triggerStart, triggerEnd + triggerEndMarker.length,
    );
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const validSchema = `prompt_valid_${randomUUID().replaceAll('-', '')}`;
    const invalidSchema = `prompt_invalid_${randomUUID().replaceAll('-', '')}`;
    const activeSchema = `prompt_active_${randomUUID().replaceAll('-', '')}`;
    const systemPrompt = '精确 UTF-8 PromptPolicy：空格、标点与换行都属于授权字节。\n第二行。';
    const createHistoricalTables = async (schema: string) => {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema},public`);
      await client.query(`CREATE TABLE prompt_policy_versions (
        tenant_id text NOT NULL,id text NOT NULL,policy jsonb NOT NULL,PRIMARY KEY (tenant_id,id))`);
      await client.query(`CREATE TABLE gate_a3_model_invocations (
        tenant_id text NOT NULL,id text NOT NULL,policy_version text NOT NULL,
        consumed_at timestamptz,invalidated_at timestamptz,status text NOT NULL,
        receipt jsonb,receipt_digest text,error_class text,started_at timestamptz,
        terminal_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id,id))`);
    };
    const assertLifecycleTriggerEnabled = async () => {
      const installed = await client.query<{ enabled: string }>(`SELECT tgenabled enabled
        FROM pg_trigger WHERE tgrelid='gate_a3_model_invocations'::regclass
          AND tgname='gate_a3_model_invocations_lifecycle' AND NOT tgisinternal`);
      expect(installed.rows).toEqual([{ enabled: 'O' }]);
    };
    const installLifecycleTrigger = async () => {
      await client.query(lifecycleTriggerSql);
      await assertLifecycleTriggerEnabled();
    };
    try {
      await createHistoricalTables(validSchema);
      await client.query(`INSERT INTO prompt_policy_versions (tenant_id,id,policy)
        VALUES ('tenant_local','xiaowei.work-order-status.explanation/1',$1)`, [{
        schemaVersion: 'prompt-policy.work-order-explanation/1',
        system: systemPrompt,
        toolChoice: 'none',
        outputSchemaVersion: 'work-order.explanation/1',
      }]);
      await client.query(`INSERT INTO gate_a3_model_invocations
        (tenant_id,id,policy_version,status,receipt,receipt_digest,started_at,terminal_at)
        VALUES ('tenant_local','historical-v1','xiaowei.work-order-status.explanation/1',
          'completed','{}',$1,now(),now())`, ['b'.repeat(64)]);
      await installLifecycleTrigger();
      await client.query(migrationSql);
      const backfilled = await client.query<{ digest: string }>(`SELECT
        prompt_policy_resolved_bytes_sha256 digest FROM gate_a3_model_invocations
        WHERE tenant_id='tenant_local' AND id='historical-v1'`);
      await expect(digestGateA3PromptPolicyResolvedBytes(systemPrompt))
        .resolves.toBe(backfilled.rows[0]?.digest);
      await expect(client.query(`INSERT INTO gate_a3_model_invocations
        (tenant_id,id,policy_version,prompt_policy_resolved_bytes_sha256,status)
        VALUES ('tenant_local','unknown-policy','missing-policy',$1,'authorized')`, ['a'.repeat(64)]))
        .rejects.toThrow(/foreign key/iu);
      await expect(client.query(`UPDATE gate_a3_model_invocations
        SET prompt_policy_resolved_bytes_sha256=$1 WHERE id='historical-v1'`, ['0'.repeat(64)]))
        .rejects.toThrow(/identity is immutable/iu);
      await assertLifecycleTriggerEnabled();

      await createHistoricalTables(invalidSchema);
      await client.query(`INSERT INTO gate_a3_model_invocations
        (tenant_id,id,policy_version,status,error_class,terminal_at)
        VALUES ('tenant_local','unresolved-v1','missing-policy','failed','MODEL_PROTOCOL_VIOLATION',now())`);
      await installLifecycleTrigger();
      await expect(client.query(migrationSql)).rejects
        .toThrow(/no resolvable immutable PromptPolicy/iu);
      await assertLifecycleTriggerEnabled();

      await createHistoricalTables(activeSchema);
      await client.query(`INSERT INTO prompt_policy_versions (tenant_id,id,policy)
        VALUES ('tenant_local','xiaowei.work-order-status.explanation/1',$1)`, [{
        schemaVersion: 'prompt-policy.work-order-explanation/1',
        system: systemPrompt,
        toolChoice: 'none',
        outputSchemaVersion: 'work-order.explanation/1',
      }]);
      await client.query(`INSERT INTO gate_a3_model_invocations
        (tenant_id,id,policy_version,status)
        VALUES ('tenant_local','active-v1','xiaowei.work-order-status.explanation/1','authorized')`);
      await installLifecycleTrigger();
      await expect(client.query(migrationSql)).rejects
        .toThrow(/must be drained before PromptPolicy wire \/2 migration/iu);
      await assertLifecycleTriggerEnabled();
      const columns = await client.query<{ count: string }>(`SELECT count(*)::text count
        FROM information_schema.columns WHERE table_schema=$1 AND table_name='gate_a3_model_invocations'
          AND column_name='prompt_policy_resolved_bytes_sha256'`, [activeSchema]);
      expect(columns.rows[0]?.count).toBe('0');
    } finally {
      await client.query('SET search_path TO public').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${validSchema} CASCADE`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${invalidSchema} CASCADE`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${activeSchema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
