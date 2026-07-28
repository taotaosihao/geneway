import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { canonicalize } from 'json-canonicalize';
import { z } from 'zod';
import {
  GATE_A3_CONNECTOR_PROFILE_VERSION,
  GATE_A3_FIELD_MASK_VERSION,
  GATE_A3_GEARJOB_ENDPOINT,
  GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID,
  GATE_A3_WORK_ORDER_FIELD_MASK,
  GenewayError,
  gateA3ConnectorCurrentAuthorityResponseSchema,
  gateA3ConnectorErrorClassSchema,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorEvidenceFieldSchema,
  gateA3ConnectorEvidenceLocatorSchema,
  gateA3ConnectorInvocationTokenClaimsSchema,
  gateA3ConnectorQuerySpecSchema,
  gateA3ConnectorSourceSnapshotSchema,
  gateA3ConnectorWorkOrderResponseSchema,
  gateA3CreateTaskInputVariantSchema,
  gateA3PublicTaskSnapshotSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelFailureClassSchema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
  gateA3WorkOrderProgressSchema,
  gateA3WorkOrderStatusCardSchema,
  gateA3WorkOrderTerminalErrorClassSchema,
  digestGateA3PromptPolicyResolvedBytes,
  gateA3AuthorityEnvelopeSchema,
  gateA3ControlPlaneAuthorityEnvelopeSchema,
  type GateA3ConnectorEvidenceField,
  type GateA3ConnectorInvocationTokenClaims,
  type GateA3ConnectorQuerySpec,
  type GateA3ConnectorWorkOrderResponse,
  type GateA3CreateTaskInputVariant,
  type GateA3AuthorityEnvelope,
  type GateA3ControlPlaneAuthorityEnvelope,
  type GateA3ControlPlaneAuthorityBundle,
  type GateA3CapabilityAcceptanceAggregate,
  type GateA3PublicTaskSnapshot,
  type GateA3WorkOrderExplanation,
  type GateA3WorkOrderStatusCard,
  type Principal,
} from '@geneway/contracts';
import {
  assertGateA3CapabilityAcceptanceAggregate,
  assertGateA3ControlPlaneAuthorityCurrent,
} from './gate-a3-prelaunch-authority.js';
import {
  WORK_ORDER_STATUS_TEMPLATE,
  compileTemplateWorkflow,
  readStoredTemplateWorkflowVersion,
} from '@geneway/workflow';

const CAPABILITY_ID = 'production.work-order-status.v1';
const CAPABILITY_VERSION_ID = 'cap_production_work_order_status_v1_1';
const HARNESS_VERSION_ID = 'harness_production_work_order_status_v1_1';
const EXPERT_CATALOG_VERSION_ID = 'expert_catalog_production_work_order_status_v1_1';
const PROMPT_POLICY_ID = 'xiaowei.work-order-status.explanation';
const PROMPT_POLICY_VERSION_ID = GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID;
const RELEASE_DRAFT_ID = 'release_production_work_order_status_v1_draft';
const RELEASE_SHADOW_ID = 'release_production_work_order_status_v1_shadow';
const RELEASE_INTERNAL_ID = 'release_production_work_order_status_v1_internal';
const CREATE_OPERATION = 'business-task.create.work-order.live';
const RESOURCE_SCOPE = 'gearjob-work-order:connector-query-spec-bound';
const FIELD_MASK_DIGEST = 'ee8a67aa0bc5933ebd26c9d6b09425bd09ebf0cf58fa727fa4a94e6288030e11';
const ENDPOINT_METHOD_ALLOWLIST_DIGEST = 'b415df4a23faaebc8779b0ddf86f63209ec0345aed9bfaad178b57b5803b74e5';
const BASE_URL = 'http://127.0.0.1:8100';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const RETRYABLE_CONNECTOR_ERRORS = new Set([
  'CONNECTOR_RATE_LIMITED', 'CONNECTOR_ROUTE_UNAVAILABLE', 'CONNECTOR_TIMEOUT',
]);
const WORKER_CONSUMER = 'gate0.2a-worker';
const WORKER_DEPLOYMENT = 'gate0.2a-local';
const AUTHORITY_LOCK_NAMESPACE = 1_196_313_667;
const AUTHORITY_LOCK_KEY = 3;

const capabilitySpec = Object.freeze({
  schemaVersion: 'capability.production-work-order-status.live/1',
  logicalModelPolicy: 'business.production.work-order-status.explanation',
  connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
  dataClasses: ['C0', 'C1'],
  actionCeiling: 'A1',
  toolChoice: 'none',
  readOnly: true,
});
const harnessSpec = Object.freeze({
  schemaVersion: 'harness.production-work-order-status.live/1',
  runtime: 'model_gateway',
  maxSteps: 6,
  connector: 'gearjob.work-order-status.read/1',
  outputSchemaVersion: 'WorkOrderStatusCard/1',
  modelTools: [],
  executionBudget: { maxRuntimeMs: 300_000, maxConnectorInvocations: 2, maxModelInvocations: 1 },
});
const promptPolicySchema = z.object({
  schemaVersion: z.literal('prompt-policy.work-order-explanation/1'),
  system: z.string().min(1).max(16_384),
  toolChoice: z.literal('none'),
  outputSchemaVersion: z.literal('work-order.explanation/1'),
}).strict();
const promptPolicy = Object.freeze(promptPolicySchema.parse({
  schemaVersion: 'prompt-policy.work-order-explanation/1',
  system: '你是小纬的工单说明后端。只解释已验证的只读工单快照和确定性进度；不得补造、修改状态或数量，不得调用工具、联网或输出内部连接信息。仅输出 work-order.explanation/1。',
  toolChoice: 'none',
  outputSchemaVersion: 'work-order.explanation/1',
}));
const expertCatalog = Object.freeze({
  schemaVersion: 'expert-catalog.work-order-status/1',
  agents: [{ id: 'agent.production.work-order-status/1', customerVisibleAuthor: false, active: true }],
  customerVisibleAuthor: '小纬',
});

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): string => sha256(canonicalize(value));
const PUBLIC_EXPLANATION_FIELD_LABELS = Object.freeze({
  workOrderRef: 'workOrderRef',
  status: 'status',
  planQty: 'planQty',
  completedQty: 'completedQty',
  unit: 'unit',
  plannedStart: 'plannedStart',
  plannedEnd: 'plannedEnd',
  updatedAt: 'updatedAt',
  sourceRevision: 'sourceRevision',
  progressPct: 'progressPct',
} as const);

const deterministicPublicExplanation = (
  explanation: GateA3WorkOrderExplanation,
  card: GateA3WorkOrderStatusCard,
  payload: GateA3ConnectorWorkOrderResponse,
): GateA3WorkOrderExplanation => gateA3WorkOrderExplanationSchema.parse({
  ...explanation,
  summary: `工单 ${card.workOrderRef} 当前状态为“${card.status}”；${card.progressPct === null
    ? '基于已验证数量，确定性进度暂不可计算。'
    : `基于已验证数量，确定性进度为 ${String(card.progressPct)}%。`}`,
  statements: explanation.statements.map((statement) => {
    const verifiedValues = {
      ...payload,
      progressPct: card.progressPct,
    } as const;
    const verifiedFields = statement.sourceFields.map((field) =>
      `${PUBLIC_EXPLANATION_FIELD_LABELS[field]}=${canonicalize(verifiedValues[field])}`).join('，');
    const text = statement.kind === 'fact'
      ? `已验证事实：${verifiedFields}。`
      : statement.kind === 'inference'
        ? verifiedFields.length === 0
          ? '该辅助说明未声明可验证源字段，不能改变工单快照、确定性进度或只读结论。'
          : `辅助说明依据已验证字段：${verifiedFields}；不能改变工单快照、确定性进度或只读结论。`
        : statement.kind === 'recommendation'
          ? verifiedFields.length === 0
            ? '建议由人工结合业务上下文复核；本查询不会执行任何写入。'
            : `建议根据已验证字段（${verifiedFields}）由人工结合业务上下文复核；本查询不会执行任何写入。`
          : '当前只读快照不足以确定该事项；请以已验证字段与 Evidence 为准。';
    return { ...statement, text };
  }),
});
const canonicalEvidenceField = (
  payload: GateA3ConnectorWorkOrderResponse,
  fieldName: (typeof GATE_A3_WORK_ORDER_FIELD_MASK)[number],
): GateA3ConnectorEvidenceField => {
  const value = payload[fieldName];
  const fieldType = fieldName === 'planQty' || fieldName === 'completedQty' ? 'number_or_null'
    : fieldName === 'unit' ? 'string_or_null'
      : fieldName === 'plannedStart' || fieldName === 'plannedEnd' ? 'datetime_or_null'
        : fieldName === 'updatedAt' ? 'datetime' : 'string';
  return gateA3ConnectorEvidenceFieldSchema.parse({
    schemaVersion: 'connector-evidence-field/1', canonicalizationVersion: 'RFC8785/JCS-1',
    fieldName, fieldType, canonicalValue: value,
  });
};
const stableEffectId = (taskId: string, querySpecHash: string, stepId: string): string =>
  `effect_${digest({ taskId, querySpecHash, stepId }).slice(0, 48)}`;
const iso = (value: Date): string => value.toISOString();

const timingSafeSignatureMatches = (supplied: string, expected: string): boolean => {
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
};

const encodeToken = (claims: unknown, secret: string): string => {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url')}`;
};

const verifySignedPayload = (payload: unknown, signature: string, secret: string): boolean =>
  timingSafeSignatureMatches(signature, createHmac('sha256', secret)
    .update(canonicalize(payload), 'utf8').digest('base64url'));

type WorkOrderProgress = z.infer<typeof gateA3WorkOrderProgressSchema>;

export type GateA3WorkOrderStepLease = Readonly<{
  stepId: 'validate_work_order_ref' | 'fetch_authorized_status' | 'compute_progress'
  | 'explain_status' | 'evidence_verify' | 'publish_status_card';
  stepAttemptId: string;
  stepFence: number;
}>;

export type GateA3WorkOrderWorkerClaim = Readonly<{
  schemaVersion: 'gate-a3-work-order-worker-claim/1'; tenantId: string; principalId: string;
  taskId: string; workflowVersionId: string; workflowHash: string; executionAttemptId: string;
  taskFence: number; approvalSubjectDigest: string; capabilityVersionId: typeof CAPABILITY_VERSION_ID;
  connectorQuerySpecHash: string; deadline: string; workOrderRef: string;
  step: GateA3WorkOrderStepLease & Readonly<{ stepId: 'validate_work_order_ref' }>;
}>;

export type GateA3WorkOrderMutation = Readonly<{
  tenantId: string; taskId: string; workflowVersionId: string; workflowHash: string;
  executionAttemptId: string; taskFence: number;
}>;

export type GateA3ConnectorFailureDisposition =
  | Readonly<{ retryScheduled: true; retryNotBefore: string }>
  | Readonly<{ retryScheduled: false }>;

type MutationContext = Readonly<{
  tenantId: string; principalId: string; taskId: string; workflowVersionId: string; workflowHash: string;
  executionAttemptId: string; taskFence: number; approvalSubjectDigest: string; approvalExpiresAt: Date;
  connectorQuerySpecId: string; connectorQuerySpecHash: string; querySpec: GateA3ConnectorQuerySpec;
  workOrderRefHash: string; resourceContextDigest: string; deadline: Date;
  stepId: GateA3WorkOrderStepLease['stepId']; stepAttemptId: string; stepFence: number;
}>;


const appendEvent = async (
  client: pg.PoolClient,
  tenantId: string,
  taskId: string,
  eventType: string,
  payload: unknown,
): Promise<number> => {
  const aggregate = await client.query<{ aggregate_version: string }>(`UPDATE business_tasks
    SET aggregate_version=aggregate_version+1,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING aggregate_version::text`, [tenantId, taskId]);
  const aggregateVersion = Number(aggregate.rows[0]?.aggregate_version);
  if (!Number.isSafeInteger(aggregateVersion)) {
    throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
  }
  const sequence = await client.query<{ sequence: string }>(`SELECT coalesce(max(sequence),0)+1 sequence
    FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2`, [tenantId, taskId]);
  const nextSequence = Number(sequence.rows[0]?.sequence);
  const eventId = id('event');
  const inserted = await client.query<{ cursor: string }>(`INSERT INTO business_task_events
    (tenant_id,id,business_task_id,sequence,event_type,schema_version,aggregate_version,
     correlation_id,payload,simulation,runtime_mode,business_decision_allowed,record_variant)
    VALUES ($1,$2,$3,$4,$5,3,$6,$3,$7,false,'model_gateway',false,
      'business-task-event.work-order.live/1') RETURNING cursor::text`, [
    tenantId, eventId, taskId, nextSequence, eventType, aggregateVersion, payload,
  ]);
  await client.query(`INSERT INTO outbox_events
    (tenant_id,id,business_task_id,event_id,event_type,payload)
    VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, id('outbox'), taskId, eventId, eventType, payload]);
  return Number(inserted.rows[0]?.cursor);
};

export type GateA3Authority = Readonly<{
  envelope: GateA3AuthorityEnvelope | GateA3ControlPlaneAuthorityEnvelope;
  validationRunId: string;
  connectorGatewayServiceToken: string;
  connectorInvocationTokenSecret: string;
  connectorGatewayReceiptSecret: string;
  modelInvocationTokenSecret: string;
  modelGatewayReceiptSecret: string;
  assertRuntimeAuthority: () => Promise<void>;
  controlPlaneAuthorityBundle?: GateA3ControlPlaneAuthorityBundle;
  canonicalSignedRenewalBootstrap?: Readonly<{
    proofKind: 'canonical-signed-renewal-bootstrap/1';
    authorityDigest: string;
    internalAdmissionDigest: string;
    renewalOfInternalAdmissionDigest: string;
    externalSignatureVerified: true;
  }>;
}>;

function gateA3ReleaseEvidence(
  authority: GateA3Authority,
  state: 'draft' | 'shadow' | 'internal',
  aggregateDigest: string | null = null,
): Readonly<Record<string, unknown>> {
  const base = {
    capabilityId: CAPABILITY_ID,
    state,
    connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
    endpointMethodAllowlistDigest: ENDPOINT_METHOD_ALLOWLIST_DIGEST,
    fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
    fieldMaskDigest: FIELD_MASK_DIGEST,
    runtimeAuthorityDigest: authority.envelope.runtimeAuthorityDigest,
    dynamicAuthorityDigest: authority.envelope.dynamicAuthorityDigest,
    runtimeImageId: authority.envelope.runtimeImageId,
    routeScope: 'isolated-local-development',
    productionAuthority: false,
  } as const;
  if (authority.controlPlaneAuthorityBundle === undefined) {
    return {
      schemaVersion: 'gate-a3-release-evidence/3',
      authorityPolicy: 'gate-a3-current-authority-internal-unexpired-unrevoked/1',
      ...base,
    };
  }
  const bundle = authority.controlPlaneAuthorityBundle;
  return {
    schemaVersion: 'gate-a3-release-evidence/4',
    authorityPolicy: state === 'internal'
      ? 'gate-a3-fresh-aggregate-single-cas/1'
      : 'gate-a3-immutable-shadow-acceptance-overlay/1',
    ...base,
    runId: bundle.acceptanceAdmission.runId,
    candidateDigest: bundle.envelope.candidateDigest,
    sourceManifestDigest: bundle.envelope.sourceManifestDigest,
    acceptanceAdmissionDigest: digest(bundle.acceptanceAdmission),
    strictPreflightDigest: bundle.acceptanceAdmission.strictPreflightDigest,
    controllerRecordDigest: bundle.acceptanceAdmission.controllerRecordDigest,
    providerCredentialVersionId: bundle.envelope.credentialVersionIds.provider,
    connectorCredentialVersionId: bundle.envelope.credentialVersionIds.connector,
    aggregateDigest,
    publicCustomerState: 'NOT_OPEN',
  };
}

type CreateInput = Readonly<GateA3CreateTaskInputVariant & { idempotencyKey: string }>;

export class GateA3WorkOrderRepository {
  constructor(readonly pool: pg.Pool, private readonly authority: GateA3Authority) {
    z.union([gateA3AuthorityEnvelopeSchema, gateA3ControlPlaneAuthorityEnvelopeSchema])
      .parse(authority.envelope);
    if (authority.envelope.schemaVersion === 'gate-a3-control-plane-authority-envelope/2') {
      if (authority.controlPlaneAuthorityBundle === undefined
        || digest(authority.controlPlaneAuthorityBundle.envelope) !== digest(authority.envelope)) {
        throw new Error('Gate A.3 corrected authority requires its exact durable Control Plane bundle');
      }
      assertGateA3ControlPlaneAuthorityCurrent(authority.controlPlaneAuthorityBundle);
    }
    if (!RUN_ID.test(authority.validationRunId)) throw new Error('Gate A.3 validation run ID is invalid');
    for (const secret of [authority.connectorGatewayServiceToken, authority.connectorInvocationTokenSecret, authority.connectorGatewayReceiptSecret,
      authority.modelInvocationTokenSecret, authority.modelGatewayReceiptSecret]) {
      if (secret.length < 32) throw new Error('Gate A.3 authority secrets must contain at least 32 characters');
    }
    const bootstrap = authority.canonicalSignedRenewalBootstrap;
    if (bootstrap !== undefined
      && (authority.envelope.renewalOfInternalAdmissionDigest === null
        || bootstrap.authorityDigest !== authority.envelope.authorityDigest
        || bootstrap.internalAdmissionDigest !== authority.envelope.internalValidationAdmissionDigest
        || bootstrap.renewalOfInternalAdmissionDigest !== authority.envelope.renewalOfInternalAdmissionDigest
        || bootstrap.proofKind !== 'canonical-signed-renewal-bootstrap/1'
        || bootstrap.externalSignatureVerified !== true)) {
      throw new Error('Gate A.3 canonical signed renewal bootstrap does not match the authority envelope');
    }
  }

  private async resolveWorkOrderPromptPolicy(
    client: pg.PoolClient,
    tenantId: string,
  ): Promise<Readonly<{
    versionId: typeof PROMPT_POLICY_VERSION_ID;
    systemPrompt: string;
    resolvedBytesSha256: string;
  }>> {
    const selected = await client.query<{ prompt_policy_version_id: string; policy: unknown }>(`SELECT
      release.prompt_policy_version_id,prompt.policy
      FROM capability_active_releases active
      JOIN capability_release_records release
        ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      JOIN prompt_policy_versions prompt
        ON prompt.tenant_id=release.tenant_id AND prompt.id=release.prompt_policy_version_id
      WHERE active.tenant_id=$1 AND active.capability_id=$2
      FOR SHARE OF active,release,prompt`, [tenantId, CAPABILITY_ID]);
    const row = selected.rows[0];
    const parsed = promptPolicySchema.safeParse(row?.policy);
    if (selected.rowCount !== 1 || row?.prompt_policy_version_id !== PROMPT_POLICY_VERSION_ID
      || !parsed.success || digest(parsed.data) !== digest(promptPolicy)) {
      throw new GenewayError('NOT_OPEN', 'Gate A.3 immutable PromptPolicy is unavailable', 503);
    }
    return Object.freeze({
      versionId: PROMPT_POLICY_VERSION_ID,
      systemPrompt: parsed.data.system,
      resolvedBytesSha256: await digestGateA3PromptPolicyResolvedBytes(parsed.data.system),
    });
  }

  async seedAuthority(tenantId = 'tenant_local'): Promise<void> {
    await this.withTransaction(async (client) => {
      await this.lockAuthorityExclusive(client);
      await this.assertConfiguredRuntimeAuthority();
      const envelope = this.authority.envelope;
      const currentAuthority = await client.query(`SELECT 1 FROM gate_a3_authority_current
        WHERE tenant_id=$1 AND capability_id=$2`, [tenantId, CAPABILITY_ID]);
      const bootstrap = this.authority.canonicalSignedRenewalBootstrap;
      if (currentAuthority.rowCount === 0 && envelope.renewalOfInternalAdmissionDigest !== null
        && bootstrap !== undefined) {
        await client.query(`INSERT INTO gate_a3_authority_bootstrap_admissions
          (tenant_id,capability_id,authority_digest,internal_admission_digest,
           renewal_of_internal_admission_digest,proof_kind,validation_run_id,admitted_by,
           external_signature_verified)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'geneway-gate-a3-release-helper',true)
          ON CONFLICT DO NOTHING`, [tenantId, CAPABILITY_ID, envelope.authorityDigest,
          envelope.internalValidationAdmissionDigest, envelope.renewalOfInternalAdmissionDigest,
          bootstrap.proofKind, this.authority.validationRunId]);
      }
      const workflow = compileTemplateWorkflow({
        schemaVersion: 'workflow-draft.template-v1',
        templateId: WORK_ORDER_STATUS_TEMPLATE.templateId,
        registryDigest: WORK_ORDER_STATUS_TEMPLATE.registryDigest,
      });
      await client.query(`INSERT INTO capability_versions (tenant_id,id,capability_id,version,spec)
        VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`, [
        tenantId, CAPABILITY_VERSION_ID, CAPABILITY_ID, capabilitySpec,
      ]);
      await client.query(`INSERT INTO prompt_policy_versions (tenant_id,id,policy_id,version,policy)
        VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`, [
        tenantId, PROMPT_POLICY_VERSION_ID, PROMPT_POLICY_ID, promptPolicy,
      ]);
      await client.query(`INSERT INTO expert_catalog_versions (tenant_id,id,version,catalog)
        VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING`, [tenantId, EXPERT_CATALOG_VERSION_ID, expertCatalog]);
      await client.query(`INSERT INTO harness_versions
        (tenant_id,id,capability_version_id,version,spec)
        VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`, [
        tenantId, HARNESS_VERSION_ID, CAPABILITY_VERSION_ID, harnessSpec,
      ]);
      await client.query(`INSERT INTO workflow_template_versions
        (tenant_id,template_id,schema_version,capability_version_id,harness_version_id,
         workflow_draft_schema_version,workflow_payload_schema_version,compiler_version,
         canonicalization_version,registry_digest,canonical_entry)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [
        tenantId, WORK_ORDER_STATUS_TEMPLATE.templateId, WORK_ORDER_STATUS_TEMPLATE.schemaVersion,
        WORK_ORDER_STATUS_TEMPLATE.capabilityVersionId, WORK_ORDER_STATUS_TEMPLATE.harnessVersionId,
        WORK_ORDER_STATUS_TEMPLATE.workflowDraftSchemaVersion, WORK_ORDER_STATUS_TEMPLATE.workflowPayloadSchemaVersion,
        WORK_ORDER_STATUS_TEMPLATE.compilerVersion, WORK_ORDER_STATUS_TEMPLATE.canonicalizationVersion,
        WORK_ORDER_STATUS_TEMPLATE.registryDigest, WORK_ORDER_STATUS_TEMPLATE,
      ]);
      await client.query(`INSERT INTO workflow_versions
        (tenant_id,id,workflow_hash,canonicalization_version,canonical_json,record_variant,template_id,registry_digest)
        VALUES ($1,$2,$3,$4,$5,'workflow-read-model.live/1',$6,$7) ON CONFLICT DO NOTHING`, [
        tenantId, workflow.id, workflow.hash, workflow.canonicalizationVersion,
        JSON.parse(workflow.canonicalJson) as unknown,
        WORK_ORDER_STATUS_TEMPLATE.templateId, WORK_ORDER_STATUS_TEMPLATE.registryDigest,
      ]);
      const draftEvidence = gateA3ReleaseEvidence(this.authority, 'draft');
      await client.query(`INSERT INTO capability_release_records
          (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,
           previous_release_id,actor,gate_evidence,gate_evidence_digest)
          VALUES ($1,$2,$3,$4,'draft',1,NULL,'geneway-gate-a3-controller',$5,$6)
          ON CONFLICT DO NOTHING`, [tenantId, RELEASE_DRAFT_ID, CAPABILITY_VERSION_ID,
        PROMPT_POLICY_VERSION_ID, draftEvidence, digest(draftEvidence)]);
      await client.query(`INSERT INTO capability_active_releases
        (tenant_id,capability_id,release_id,pointer_version)
        VALUES ($1,$2,$3,1) ON CONFLICT DO NOTHING`, [tenantId, CAPABILITY_ID, RELEASE_DRAFT_ID]);
      await client.query(`INSERT INTO gate_a3_authority_envelopes
        (tenant_id,authority_digest,schema_version,capability_id,envelope,approved_preflight_digest,
         controller_admission_digest,internal_admission_digest,renewal_of_internal_admission_digest,
         effective_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [
        tenantId, envelope.authorityDigest, envelope.schemaVersion, envelope.capabilityId, envelope,
        envelope.approvedPreflightDigest, envelope.preflightControllerAdmissionDigest,
        envelope.internalValidationAdmissionDigest, envelope.renewalOfInternalAdmissionDigest,
        envelope.effectiveAt, envelope.expiresAt,
      ]);
      if (this.authority.controlPlaneAuthorityBundle !== undefined) {
        const bundle = this.authority.controlPlaneAuthorityBundle;
        const admission = bundle.acceptanceAdmission;
        const prelaunch = bundle.prelaunchReceipt;
        await client.query(`INSERT INTO gate_a3_acceptance_authority_bundles
          (tenant_id,authority_digest,run_id,candidate_digest,source_manifest_digest,
           strict_preflight_digest,controller_record_digest,actor_registry_digest,
           acceptance_admission_digest,prelaunch_receipt_digest,
           provider_credential_version_id,connector_credential_version_id,actor_registry,
           acceptance_admission,prelaunch_receipt,authority_envelope,bundle,bundle_digest,
           issued_at,expires_at,declared_maximum_run_duration_ms,max_invocation_token_ttl_ms,
           shutdown_grace_ms,release_state,public_customer_state,renewal_of)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
            $19,$20,$21,$22,$23,'shadow','NOT_OPEN',NULL) ON CONFLICT DO NOTHING`, [
          tenantId,
          envelope.authorityDigest,
          admission.runId,
          admission.candidateDigest,
          admission.sourceManifestDigest,
          admission.strictPreflightDigest,
          admission.controllerRecordDigest,
          admission.actorRegistryDigest,
          digest(admission),
          digest(prelaunch),
          admission.credentialVersionIds.provider,
          admission.credentialVersionIds.connector,
          bundle.actorRegistry,
          admission,
          prelaunch,
          envelope,
          bundle,
          digest(bundle),
          admission.issuedAt,
          admission.expiresAt,
          admission.declaredMaximumRunDurationMs,
          admission.maxInvocationTokenTtlMs,
          admission.shutdownGraceMs,
        ]);
        const actorReceipts = [{
          role: 'signer',
          actorId: admission.signer.actorId,
          sessionId: admission.signer.sessionId,
          keyId: admission.signer.keyId,
          nonce: admission.signer.nonce,
          receiptDigest: digest(admission),
          receipt: admission,
          signature: admission.signer.signature,
          issuedAt: admission.issuedAt,
        }, {
          role: 'verifier',
          actorId: prelaunch.verifier.actorId,
          sessionId: prelaunch.verifier.sessionId,
          keyId: prelaunch.verifier.keyId,
          nonce: prelaunch.verifier.nonce,
          receiptDigest: digest(prelaunch),
          receipt: prelaunch,
          signature: prelaunch.verifier.signature,
          issuedAt: prelaunch.observedAt,
        }] as const;
        for (const receipt of actorReceipts) {
          await client.query(`INSERT INTO gate_a3_acceptance_actor_receipts
            (tenant_id,run_id,role,actor_id,session_id,key_id,nonce,receipt_digest,
             raw_receipt,signature,issued_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [
            tenantId,
            admission.runId,
            receipt.role,
            receipt.actorId,
            receipt.sessionId,
            receipt.keyId,
            receipt.nonce,
            receipt.receiptDigest,
            receipt.receipt,
            receipt.signature,
            receipt.issuedAt,
          ]);
        }
      }
      const draftStageId = this.authorityStageId('draft');
      await client.query(`INSERT INTO gate_a3_authority_stages
        (tenant_id,id,authority_digest,state,sequence,previous_stage_id,actor)
        VALUES ($1,$2,$3,'draft',1,NULL,'geneway-gate-a3-controller') ON CONFLICT DO NOTHING`, [
        tenantId, draftStageId, envelope.authorityDigest,
      ]);
      await client.query(`INSERT INTO gate_a3_authority_current
        (tenant_id,capability_id,stage_id,pointer_version) VALUES ($1,$2,$3,1)
        ON CONFLICT DO NOTHING`, [tenantId, CAPABILITY_ID, draftStageId]);
    });
  }

  async activateAuthorityEnvelope(tenantId = 'tenant_local'): Promise<void> {
    await this.seedAuthority(tenantId);
    await this.withTransaction(async (client) => {
      await this.lockAuthorityExclusive(client);
      await this.assertConfiguredRuntimeAuthority();
      const current = await client.query<{ stage_id: string; pointer_version: string; authority_digest: string }>(`SELECT
        current.stage_id,current.pointer_version::text,stage.authority_digest
        FROM gate_a3_authority_current current JOIN gate_a3_authority_stages stage
          ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
        WHERE current.tenant_id=$1 AND current.capability_id=$2 FOR UPDATE OF current`, [tenantId, CAPABILITY_ID]);
      const row = current.rows[0];
      if (row === undefined || row.authority_digest === this.authority.envelope.authorityDigest) return;
      const draftStageId = this.authorityStageId('draft');
      const updated = await client.query(`UPDATE gate_a3_authority_current SET stage_id=$3,
        pointer_version=pointer_version+1,updated_at=now() WHERE tenant_id=$1 AND capability_id=$2
        AND stage_id=$4 AND pointer_version=$5`, [tenantId, CAPABILITY_ID, draftStageId,
        row.stage_id, Number(row.pointer_version)]);
      if (updated.rowCount !== 1) throw new Error('Gate A.3 authority renewal CAS failed');
    });
  }

  async promoteAuthority(
    targetState: 'shadow' | 'internal',
    tenantId = 'tenant_local',
    aggregateValue?: unknown,
  ): Promise<void> {
    let aggregate: GateA3CapabilityAcceptanceAggregate | undefined;
    if (this.authority.controlPlaneAuthorityBundle !== undefined) {
      if (targetState === 'internal') {
        if (aggregateValue === undefined) {
          throw new Error('Gate A.3 internal promotion requires this run fresh acceptance aggregate');
        }
        aggregate = assertGateA3CapabilityAcceptanceAggregate(
          this.authority.controlPlaneAuthorityBundle,
          aggregateValue,
        );
      } else if (aggregateValue !== undefined) {
        throw new Error('Gate A.3 shadow promotion cannot consume an acceptance aggregate');
      }
    }
    await this.withTransaction(async (client) => {
      await this.lockAuthorityExclusive(client);
      await this.assertConfiguredRuntimeAuthority();
      const selected = await client.query<{ stage_id: string; pointer_version: string; authority_digest: string;
        state: 'draft' | 'shadow' | 'internal'; sequence: number }>(`SELECT current.stage_id,
          current.pointer_version::text,stage.authority_digest,stage.state,stage.sequence
        FROM gate_a3_authority_current current JOIN gate_a3_authority_stages stage
          ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
        WHERE current.tenant_id=$1 AND current.capability_id=$2 FOR UPDATE OF current`, [tenantId, CAPABILITY_ID]);
      const current = selected.rows[0];
      if (current === undefined || current.authority_digest !== this.authority.envelope.authorityDigest) {
        throw new Error('Gate A.3 current authority does not select the configured envelope');
      }
      if (current.state === 'internal' || current.state === targetState) {
        if (this.authority.controlPlaneAuthorityBundle !== undefined && targetState === 'internal') {
          throw new Error('Gate A.3 corrected authority permits exactly one internal promotion CAS');
        }
        return;
      }
      const expectedState = targetState === 'shadow' ? 'draft' : 'shadow';
      if (current.state !== expectedState) throw new Error('Gate A.3 authority promotion order is invalid');
      const targetSequence = targetState === 'shadow' ? 2 : 3;
      const stageId = this.authorityStageId(targetState);
      await client.query(`INSERT INTO gate_a3_authority_stages
        (tenant_id,id,authority_digest,state,sequence,previous_stage_id,actor)
        VALUES ($1,$2,$3,$4,$5,$6,'geneway-gate-a3-controller') ON CONFLICT DO NOTHING`, [
        tenantId, stageId, this.authority.envelope.authorityDigest, targetState, targetSequence, current.stage_id,
      ]);
      const updated = await client.query(`UPDATE gate_a3_authority_current SET stage_id=$3,
        pointer_version=pointer_version+1,updated_at=now() WHERE tenant_id=$1 AND capability_id=$2
        AND stage_id=$4 AND pointer_version=$5`, [tenantId, CAPABILITY_ID, stageId,
        current.stage_id, Number(current.pointer_version)]);
      if (updated.rowCount !== 1) throw new Error('Gate A.3 authority promotion CAS failed');

      const releaseTarget = targetState === 'shadow' ? {
        id: RELEASE_SHADOW_ID, previousId: RELEASE_DRAFT_ID, previousState: 'draft', sequence: 2,
      } : { id: RELEASE_INTERNAL_ID, previousId: RELEASE_SHADOW_ID, previousState: 'shadow', sequence: 3 };
      const release = await client.query<{ release_id: string; pointer_version: string; state: string }>(`SELECT
        active.release_id,active.pointer_version::text,record.state FROM capability_active_releases active
        JOIN capability_release_records record ON record.tenant_id=active.tenant_id AND record.id=active.release_id
        WHERE active.tenant_id=$1 AND active.capability_id=$2 FOR UPDATE OF active`, [tenantId, CAPABILITY_ID]);
      const active = release.rows[0];
      // Authority renewal advances the dedicated authority pointer. The
      // immutable capability release remains the already-internal policy row.
      if (active?.state === 'internal') return;
      if (active?.state === targetState) return;
      if (active === undefined || active.release_id !== releaseTarget.previousId || active.state !== releaseTarget.previousState) {
        throw new Error('Gate A.3 capability release promotion order is invalid');
      }
      const aggregateDigest = aggregate === undefined ? null : digest(aggregate);
      if (aggregate !== undefined) {
        await client.query(`INSERT INTO gate_a3_acceptance_aggregates
          (tenant_id,capability_id,run_id,authority_digest,candidate_digest,source_manifest_digest,
           acceptance_admission_digest,provider_credential_version_id,connector_credential_version_id,
           aggregate_digest,aggregate,verifier_actor_id,verifier_session_id,verifier_key_id,
           verifier_nonce,issued_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
          tenantId,
          CAPABILITY_ID,
          aggregate.runId,
          aggregate.authorityDigest,
          aggregate.candidateDigest,
          aggregate.sourceManifestDigest,
          aggregate.acceptanceAdmissionDigest,
          aggregate.credentialVersionIds.provider,
          aggregate.credentialVersionIds.connector,
          aggregateDigest,
          aggregate,
          aggregate.verifier.actorId,
          aggregate.verifier.sessionId,
          aggregate.verifier.keyId,
          aggregate.verifier.nonce,
          aggregate.issuedAt,
          aggregate.expiresAt,
        ]);
      }
      const evidence = gateA3ReleaseEvidence(this.authority, targetState, aggregateDigest);
      await client.query(`INSERT INTO capability_release_records
        (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,previous_release_id,
         actor,gate_evidence,gate_evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,
         'geneway-gate-a3-controller',$8,$9) ON CONFLICT DO NOTHING`, [tenantId, releaseTarget.id,
        CAPABILITY_VERSION_ID, PROMPT_POLICY_VERSION_ID, targetState, releaseTarget.sequence,
        releaseTarget.previousId, evidence, digest(evidence)]);
      const releaseUpdated = await client.query(`UPDATE capability_active_releases SET release_id=$3,
        pointer_version=pointer_version+1,updated_at=now() WHERE tenant_id=$1 AND capability_id=$2
        AND release_id=$4 AND pointer_version=$5`, [tenantId, CAPABILITY_ID, releaseTarget.id,
        active.release_id, Number(active.pointer_version)]);
      if (releaseUpdated.rowCount !== 1) throw new Error('Gate A.3 capability release CAS failed');
      if (aggregate !== undefined) {
        await client.query(`INSERT INTO gate_a3_acceptance_promotions
          (tenant_id,capability_id,run_id,aggregate_digest,previous_release_id,promoted_release_id,
           previous_pointer_version,promoted_pointer_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          tenantId,
          CAPABILITY_ID,
          aggregate.runId,
          aggregateDigest,
          active.release_id,
          releaseTarget.id,
          Number(active.pointer_version),
          Number(active.pointer_version) + 1,
        ]);
      }
    });
  }

  async revokeAuthority(reasonDigest: string, actor: string, tenantId = 'tenant_local'): Promise<void> {
    if (!SHA256.test(reasonDigest) || actor.length < 1 || actor.length > 256) throw new Error('Gate A.3 revocation is invalid');
    await this.withTransaction(async (client) => {
      await this.lockAuthorityExclusive(client);
      const current = await client.query<{ authority_digest: string }>(`SELECT stage.authority_digest
        FROM gate_a3_authority_current current
        JOIN gate_a3_authority_stages stage ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
        WHERE current.tenant_id=$1 AND current.capability_id=$2 FOR UPDATE OF current`, [tenantId, CAPABILITY_ID]);
      if (current.rows[0]?.authority_digest !== this.authority.envelope.authorityDigest) {
        throw new Error('Gate A.3 revocation target is not the current authority');
      }
      await client.query(`INSERT INTO gate_a3_authority_revocations
        (tenant_id,id,authority_digest,actor,reason_digest) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
        tenantId, `gate_a3_revoke_${this.authority.envelope.authorityDigest}`, this.authority.envelope.authorityDigest,
        actor, reasonDigest,
      ]);
    });
  }

  async getCapabilityRoute(principal: Principal): Promise<unknown> {
    const open = await this.isInternalRelease(principal.tenantId);
    return {
      capabilityId: CAPABILITY_ID,
      status: open ? 'internal' : 'NOT_OPEN',
      executionRoute: open ? 'live' : 'not_open',
      ...(open ? { simulation: false, runtimeMode: 'model_gateway', businessDecisionAllowed: false,
        internalAcceptance: true } : {}),
    };
  }

  async isInternalRelease(tenantId: string): Promise<boolean> {
    try {
      await this.withTransaction((client) => this.assertAuthority(client, tenantId));
      return true;
    } catch (error) {
      if (error instanceof GenewayError && error.code === 'NOT_OPEN') return false;
      throw error;
    }
  }

  async createTask(principal: Principal, input: CreateInput): Promise<Readonly<{
    taskId: string; approvalId: string; workflowVersionId: string; workflowHash: string;
  }>> {
    const parsed = gateA3CreateTaskInputVariantSchema.parse({
      conversationId: input.conversationId,
      capabilityId: input.capabilityId,
      inputRef: input.inputRef,
    });
    if (principal.trust !== 'trusted-local') throw new GenewayError('TASK_CREATE_FORBIDDEN', 'Trusted local authority is required', 403);
    if (this.authority.controlPlaneAuthorityBundle !== undefined) {
      const admission = this.authority.controlPlaneAuthorityBundle.acceptanceAdmission;
      const objectDigest = digest({
        schemaVersion: 'gate-a3-acceptance-object/1',
        kind: 'work_order',
        workOrderRef: parsed.inputRef.workOrderRef,
      });
      if (principal.tenantId !== admission.allowlistedPrincipal.tenantId
        || principal.userId !== admission.allowlistedPrincipal.userId
        || principal.trust !== admission.allowlistedPrincipal.trust
        || objectDigest !== admission.allowlistedObjectDigest) {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 shadow acceptance is not admitted for this principal or object', 503);
      }
    }
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key is required', 400);
    }
    return this.withTransaction(async (client) => {
      await this.assertAuthority(client, principal.tenantId);
      const promptAuthority = await this.resolveWorkOrderPromptPolicy(client, principal.tenantId);
      const requestDigest = digest(parsed);
      const replay = await client.query<{ request_digest: string; response: unknown }>(`SELECT request_digest,response
        FROM idempotency_records WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key=$4`, [
        principal.tenantId, principal.userId, CREATE_OPERATION, input.idempotencyKey,
      ]);
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].request_digest !== requestDigest) {
          throw new GenewayError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for different semantics', 409);
        }
        const replayProjection = z.object({ taskId: z.string(), approvalId: z.string(),
          workflowVersionId: z.string(), workflowHash: z.string() }).passthrough().parse(replay.rows[0].response);
        return { taskId: replayProjection.taskId, approvalId: replayProjection.approvalId,
          workflowVersionId: replayProjection.workflowVersionId, workflowHash: replayProjection.workflowHash };
      }
      const ownedConversation = await client.query(`SELECT 1 FROM conversations
        WHERE tenant_id=$1 AND id=$2 AND user_id=$3`, [principal.tenantId, parsed.conversationId, principal.userId]);
      if (ownedConversation.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
      const workflow = compileTemplateWorkflow({ schemaVersion: 'workflow-draft.template-v1',
        templateId: WORK_ORDER_STATUS_TEMPLATE.templateId, registryDigest: WORK_ORDER_STATUS_TEMPLATE.registryDigest });
      const taskId = id('task');
      const querySpecId = id('connector_spec');
      const approvalId = id('approval');
      const now = new Date();
      const deadline = new Date(now.getTime() + 300_000);
      const resourceContextDigest = digest({ tenantId: principal.tenantId, principal: principal.userId,
        conversationId: parsed.conversationId, capabilityId: CAPABILITY_ID, workOrderRef: parsed.inputRef.workOrderRef });
      const querySpec = gateA3ConnectorQuerySpecSchema.parse({
        schemaVersion: 'connector-query-spec/1',
        canonicalizationVersion: 'RFC8785/JCS-1',
        specId: querySpecId,
        capabilityVersionId: CAPABILITY_VERSION_ID,
        releaseRecordId: RELEASE_INTERNAL_ID,
        approvedPreflightDigest: this.authority.envelope.approvedPreflightDigest,
        connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
        baseUrl: BASE_URL,
        endpoint: GATE_A3_GEARJOB_ENDPOINT,
        method: 'GET',
        endpointMethodAllowlistDigest: ENDPOINT_METHOD_ALLOWLIST_DIGEST,
        fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
        fieldMask: GATE_A3_WORK_ORDER_FIELD_MASK,
        workOrderRef: parsed.inputRef.workOrderRef,
        tenantId: principal.tenantId,
        principal: principal.userId,
        resourceContextDigest,
        workflowVersionId: workflow.id,
        workflowHash: workflow.hash,
        stepId: 'fetch_authorized_status',
        budget: { maxAttempts: 2, timeoutMs: 5_000 },
        deadline: iso(deadline),
        publicErrorPolicyVersion: 'gearjob.not-found-forbidden-equivalent/1',
        cardSchemaVersion: 'WorkOrderStatusCard/1',
      });
      const querySpecHash = digest(querySpec);
      const workOrderRefHash = sha256(parsed.inputRef.workOrderRef);
      const semanticFingerprint = digest({ recordVariant: 'business-task.work-order.live/1',
        capabilityVersionId: CAPABILITY_VERSION_ID, workflowVersionId: workflow.id, workflowHash: workflow.hash,
        querySpecHash, operation: CREATE_OPERATION, idempotencyKey: input.idempotencyKey });
      // Required ordering: immutable QuerySpec is inserted before the BusinessTask
      // and Approval. The task FK is deferred until this transaction commits.
      await client.query(`INSERT INTO gate_a3_connector_query_specs
        (tenant_id,id,business_task_id,schema_version,canonicalization_version,capability_version_id,
         release_record_id,approved_preflight_digest,connector_profile_version,base_url,endpoint_path,
         method,endpoint_method_allowlist_digest,field_mask_version,field_mask_digest,work_order_ref,
         work_order_ref_hash,principal_id,resource_context_digest,workflow_version_id,workflow_hash,
         step_id,budget,deadline,public_error_policy,card_schema_version,canonical_spec,spec_hash)
        VALUES ($1,$2,$3,'connector-query-spec/1','RFC8785/JCS-1',$4,$5,$6,$7,$8,$9,'GET',$10,
          $11,$12,$13,$14,$15,$16,$17,$18,'fetch_authorized_status',$19,$20,$21,$22,$23,$24)`, [
        principal.tenantId, querySpecId, taskId, CAPABILITY_VERSION_ID, RELEASE_INTERNAL_ID,
        this.authority.envelope.approvedPreflightDigest, GATE_A3_CONNECTOR_PROFILE_VERSION, BASE_URL,
        GATE_A3_GEARJOB_ENDPOINT, ENDPOINT_METHOD_ALLOWLIST_DIGEST, GATE_A3_FIELD_MASK_VERSION,
        FIELD_MASK_DIGEST, parsed.inputRef.workOrderRef, workOrderRefHash, principal.userId,
        resourceContextDigest, workflow.id, workflow.hash, querySpec.budget, deadline,
        { version: querySpec.publicErrorPolicyVersion }, querySpec.cardSchemaVersion, querySpec, querySpecHash,
      ]);
      const inputSnapshot = { kind: 'work_order', workOrderRef: parsed.inputRef.workOrderRef,
        connectorQuerySpecId: querySpecId, connectorQuerySpecHash: querySpecHash,
        workOrderRefHash, resourceContextDigest };
      const permissionScope = { actions: ['R0', 'R1', 'A1'], resourceScopes: [RESOURCE_SCOPE],
        dataClasses: ['C0', 'C1'], connectors: ['gearjob.work-order-status.read/1'], modelTools: [] };
      const audienceScope = { kind: 'private_conversation', conversationId: parsed.conversationId };
      const budget = { maxRuntimeMs: 300_000, maxConnectorInvocations: 2, maxModelInvocations: 1 };
      await client.query(`INSERT INTO business_tasks
        (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
         workflow_version_id,workflow_hash,requester_id,status,input_snapshot,input_digest,expert_target,
         permission_scope,audience_scope,budget,simulation,runtime_mode,business_decision_allowed,
         record_variant,result_record_variant,semantic_fingerprint,result,gate_a3_authority_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12,$13,$14,$15,
          false,'model_gateway',false,'business-task.work-order.live/1',NULL,$16,NULL,$17)`, [
        principal.tenantId, taskId, parsed.conversationId, CAPABILITY_VERSION_ID, EXPERT_CATALOG_VERSION_ID,
        HARNESS_VERSION_ID, workflow.id, workflow.hash, principal.userId, inputSnapshot, digest(inputSnapshot),
        { mode: 'fixed', agentVersionId: 'agent.production.work-order-status/1' }, permissionScope,
        audienceScope, budget, semanticFingerprint, this.authority.envelope.authorityDigest,
      ]);
      for (const node of workflow.payload.nodes) {
        await client.query(`INSERT INTO business_task_steps
          (tenant_id,business_task_id,step_id,status,simulation,runtime_mode,business_decision_allowed,record_variant)
          VALUES ($1,$2,$3,'queued',false,'model_gateway',false,'business-task-step.work-order.live/1')`, [
          principal.tenantId, taskId, node.id,
        ]);
      }
      const approvalSubject = {
        kind: 'workflow-execution',
        subjectType: 'business-task',
        subjectId: taskId,
        subjectVersion: 1,
        recordVariant: 'approval-subject.work-order.live/1',
        requesterId: principal.userId,
        inputRef: parsed.inputRef,
        connectorQuerySpecId: querySpecId,
        connectorQuerySpecHash: querySpecHash,
        workOrderRefHash,
        resourceContextDigest,
        approvedPreflightDigest: this.authority.envelope.approvedPreflightDigest,
        gateA3AuthorityDigest: this.authority.envelope.authorityDigest,
        connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
        fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
        fieldMaskDigest: FIELD_MASK_DIGEST,
        workflowVersionId: workflow.id,
        workflowHash: workflow.hash,
        capabilityVersionId: CAPABILITY_VERSION_ID,
        harnessVersionId: HARNESS_VERSION_ID,
        promptPolicyVersionId: promptAuthority.versionId,
        promptPolicyResolvedBytesSha256: promptAuthority.resolvedBytesSha256,
        permissionScope,
        audienceScope,
        budget,
        deadline: iso(deadline),
        simulation: false,
        runtimeMode: 'model_gateway',
        businessDecisionAllowed: false,
      };
      const approvalSubjectDigest = digest(approvalSubject);
      await client.query(`INSERT INTO approval_versions
        (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,
         approver_policy_version,expires_at)
        VALUES ($1,$2,$3,1,$4,$5,'pending',$6,'trusted-local-work-order/1',$7)`, [
        principal.tenantId, approvalId, taskId, approvalSubject, approvalSubjectDigest,
        principal.userId, deadline,
      ]);
      await client.query(`INSERT INTO delegated_capabilities
        (tenant_id,id,business_task_id,principal_id,allowed_actions,resource_scopes,audience_scope,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [principal.tenantId, id('delegation'), taskId,
        principal.userId, JSON.stringify(['R0', 'R1', 'A1']), JSON.stringify([RESOURCE_SCOPE]), audienceScope, deadline]);
      await client.query(`INSERT INTO policy_decisions
        (tenant_id,id,business_task_id,allow,reason_codes)
        VALUES ($1,$2,$3,true,$4)`, [principal.tenantId, id('policy'), taskId,
        JSON.stringify(['TRUSTED_LOCAL', 'APPROVED_PREFLIGHT_BOUND', 'SINGLE_WORK_ORDER_READ_ONLY'])]);
      await appendEvent(client, principal.tenantId, taskId, 'business_task.work_order.created', {
        approvalId, approvalSubjectDigest, connectorQuerySpecHash: querySpecHash,
        workflowVersionId: workflow.id, workflowHash: workflow.hash,
      });
      await client.query(`INSERT INTO idempotency_records
        (tenant_id,principal_id,operation,idempotency_key,request_digest,response)
        VALUES ($1,$2,$3,$4,$5,$6)`, [principal.tenantId, principal.userId, CREATE_OPERATION,
        input.idempotencyKey, requestDigest, { taskId, approvalId, workflowVersionId: workflow.id,
          workflowHash: workflow.hash, connectorQuerySpecHash: querySpecHash }]);
      return { taskId, approvalId, workflowVersionId: workflow.id, workflowHash: workflow.hash };
    });
  }

  async isTask(principal: Principal, taskId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM business_tasks
      WHERE tenant_id=$1 AND id=$2 AND requester_id=$3
        AND record_variant='business-task.work-order.live/1'`, [principal.tenantId, taskId, principal.userId]);
    return result.rowCount === 1;
  }

  async getTask(principal: Principal, taskId: string): Promise<GateA3PublicTaskSnapshot> {
    return this.withTransaction(async (client) => this.getTaskInTransaction(client, principal, taskId));
  }

  async getEvidence(principal: Principal, evidenceId: string): Promise<unknown> {
    return this.withTransaction(async (client) => {
      const selected = await client.query<{ connector_source_snapshot_id: string; business_task_id: string;
        field_name: string | null }>(`SELECT evidence.connector_source_snapshot_id,evidence.business_task_id,
          evidence.field_name FROM gate_a3_connector_evidence evidence
        JOIN business_tasks task ON task.tenant_id=evidence.tenant_id AND task.id=evidence.business_task_id
        JOIN conversations conversation ON conversation.tenant_id=task.tenant_id
          AND conversation.id=task.conversation_id
        JOIN gate_a3_work_order_results result ON result.tenant_id=task.tenant_id
          AND result.business_task_id=task.id
          AND result.connector_source_snapshot_id=evidence.connector_source_snapshot_id
        WHERE evidence.tenant_id=$1 AND evidence.id=$2 AND task.requester_id=$3
          AND conversation.user_id=$3 AND task.status='completed'
          AND evidence.locator_kind='connector_snapshot_field'`, [
        principal.tenantId, evidenceId, principal.userId,
      ]);
      const selectedRow = selected.rows[0];
      if (selectedRow === undefined || selectedRow.field_name === null) {
        throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found', 404);
      }
      let authority;
      try {
        authority = await this.revalidateConnectorEvidence(client, {
          tenantId: principal.tenantId, taskId: selectedRow.business_task_id,
          principalId: principal.userId, snapshotId: selectedRow.connector_source_snapshot_id,
        });
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'EVIDENCE_SOURCE_REVOKED') {
          throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found', 404);
        }
        throw error;
      }
      const field = authority.fields.get(selectedRow.field_name);
      if (field === undefined || field.id !== evidenceId) {
        throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found', 404);
      }
      return {
        id: field.id, kind: 'connector_snapshot_field', fieldName: field.field.fieldName,
        value: field.field.canonicalValue, sourceRevision: authority.snapshot.sourceRevision,
        sourceAsOf: authority.snapshot.sourceAsOf, dataClass: authority.snapshot.dataClass, readOnly: true,
      };
    });
  }

  async revokeConnectorSourceAccess(
    principal: Principal,
    connectorSourceSnapshotId: string,
    actor: string,
    reasonDigest: string,
  ): Promise<void> {
    if (principal.trust !== 'trusted-local' || actor.length < 1 || actor.length > 256
      || !SHA256.test(reasonDigest)) {
      throw new GenewayError('SOURCE_REVOCATION_INVALID', 'Connector source revocation is invalid', 400);
    }
    await this.withTransaction(async (client) => {
      const selected = await client.query<{ business_task_id: string }>(`SELECT snapshot.business_task_id
        FROM gate_a3_connector_source_snapshots snapshot
        JOIN business_tasks task ON task.tenant_id=snapshot.tenant_id
          AND task.id=snapshot.business_task_id
        WHERE snapshot.tenant_id=$1 AND snapshot.id=$2 AND task.requester_id=$3
          AND task.record_variant='business-task.work-order.live/1'`, [
        principal.tenantId, connectorSourceSnapshotId, principal.userId,
      ]);
      const row = selected.rows[0];
      if (row === undefined) throw new GenewayError('SOURCE_NOT_FOUND', 'Connector source was not found', 404);
      await client.query(`INSERT INTO gate_a3_connector_source_revocations
        (tenant_id,id,business_task_id,connector_source_snapshot_id,principal_id,actor,reason_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [principal.tenantId,
        id('connector_source_revocation'), row.business_task_id, connectorSourceSnapshotId,
        principal.userId, actor, reasonDigest]);
    });
  }

  async revokeConnectorEvidenceSourceAccess(
    principal: Principal,
    evidenceId: string,
    reasonDigest: string,
  ): Promise<void> {
    if (principal.trust !== 'trusted-local' || evidenceId.length < 1 || evidenceId.length > 256
      || !SHA256.test(reasonDigest)) {
      throw new GenewayError('SOURCE_REVOCATION_INVALID', 'Connector source revocation is invalid', 400);
    }
    await this.withTransaction(async (client) => {
      const selected = await client.query<{ business_task_id: string; connector_source_snapshot_id: string }>(`SELECT
          evidence.business_task_id,evidence.connector_source_snapshot_id
        FROM gate_a3_connector_evidence evidence
        JOIN business_tasks task ON task.tenant_id=evidence.tenant_id
          AND task.id=evidence.business_task_id
        JOIN gate_a3_work_order_results result ON result.tenant_id=evidence.tenant_id
          AND result.business_task_id=evidence.business_task_id
          AND result.connector_source_snapshot_id=evidence.connector_source_snapshot_id
        WHERE evidence.tenant_id=$1 AND evidence.id=$2 AND task.requester_id=$3
          AND task.record_variant='business-task.work-order.live/1' AND task.status='completed'`, [
        principal.tenantId, evidenceId, principal.userId,
      ]);
      const row = selected.rows[0];
      if (row === undefined) throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found', 404);
      await client.query(`INSERT INTO gate_a3_connector_source_revocations
        (tenant_id,id,business_task_id,connector_source_snapshot_id,principal_id,actor,reason_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [principal.tenantId,
        id('connector_source_revocation'), row.business_task_id, row.connector_source_snapshot_id,
        principal.userId, `principal:${principal.userId}`, reasonDigest]);
    });
  }

  async getEvents(principal: Principal, taskId: string, afterCursor: number): Promise<unknown> {
    if (!await this.isTask(principal, taskId)) throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
    const rows = await this.pool.query<{ cursor: string; event_type: string; payload: unknown; occurred_at: Date }>(`SELECT cursor::text,event_type,payload,occurred_at
      FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2
        AND record_variant='business-task-event.work-order.live/1' AND cursor>$3
      ORDER BY cursor LIMIT 200`, [principal.tenantId, taskId, afterCursor]);
    return { events: rows.rows.map((row) => ({ cursor: Number(row.cursor), eventType: row.event_type,
      payload: row.payload, occurredAt: iso(row.occurred_at) })) };
  }

  async getWorkflow(principal: Principal, workflowId: string): Promise<unknown> {
    const task = await this.pool.query(`SELECT 1 FROM business_tasks WHERE tenant_id=$1 AND requester_id=$2
      AND workflow_version_id=$3 AND record_variant='business-task.work-order.live/1' LIMIT 1`, [
      principal.tenantId, principal.userId, workflowId,
    ]);
    if (task.rowCount !== 1) throw new GenewayError('WORKFLOW_NOT_FOUND', 'Workflow was not found', 404);
    const row = await this.pool.query<{ id: string; workflow_hash: string; canonicalization_version: string;
      canonical_json: unknown }>(`SELECT id,workflow_hash,canonicalization_version,canonical_json
      FROM workflow_versions WHERE tenant_id=$1 AND id=$2 AND template_id=$3`, [
      principal.tenantId, workflowId, WORK_ORDER_STATUS_TEMPLATE.templateId,
    ]);
    const workflow = row.rows[0];
    if (workflow === undefined) throw new GenewayError('WORKFLOW_NOT_FOUND', 'Workflow was not found', 404);
    const stored = readStoredTemplateWorkflowVersion({ id: workflow.id, hash: workflow.workflow_hash,
      canonicalizationVersion: workflow.canonicalization_version, canonicalPayload: workflow.canonical_json });
    return { templateId: WORK_ORDER_STATUS_TEMPLATE.templateId, workflowVersionId: stored.id,
      workflowHash: stored.hash, steps: stored.payload.nodes.map((node) => ({ id: node.id, kind: node.kind })) };
  }

  async decideApproval(
    principal: Principal,
    approvalId: string,
    decision: 'approved' | 'rejected',
    idempotencyKey: string,
  ): Promise<unknown> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key is required', 400);
    }
    return this.withTransaction(async (client) => {
      await this.assertAuthority(client, principal.tenantId);
      const selected = await client.query<{ business_task_id: string; status: string; requester_id: string;
        expires_at: Date; subject: unknown; subject_digest: string; spec_hash: string;
        gate_a3_authority_digest: string | null }>(`SELECT approval.business_task_id,
          approval.status,approval.requester_id,approval.expires_at,approval.subject,approval.subject_digest,
          spec.spec_hash,task.gate_a3_authority_digest
        FROM approval_versions approval
        JOIN business_tasks task ON task.tenant_id=approval.tenant_id AND task.id=approval.business_task_id
        JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
        WHERE approval.tenant_id=$1 AND approval.id=$2 AND approval.requester_id=$3
          AND task.record_variant='business-task.work-order.live/1'
          AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
            AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
        FOR UPDATE OF approval,task`, [principal.tenantId, approvalId, principal.userId]);
      const row = selected.rows[0];
      if (row === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found', 404);
      if (row.gate_a3_authority_digest !== this.authority.envelope.authorityDigest) {
        throw new GenewayError('APPROVAL_AUTHORITY_STALE', 'Work Order approval authority changed', 409);
      }
      if (row.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approval has expired', 409);
      if (digest(row.subject) !== row.subject_digest
        || (row.subject as Readonly<Record<string, unknown>>).connectorQuerySpecHash !== row.spec_hash) {
        throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approval subject authority changed', 409);
      }
      if (row.status === decision) return { approvalId, status: decision, businessTaskId: row.business_task_id };
      if (row.status !== 'pending') throw new GenewayError('APPROVAL_ALREADY_DECIDED', 'Approval was already decided', 409);
      await client.query(`UPDATE approval_versions SET status=$3,decision_by=$4,decision_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [principal.tenantId, approvalId, decision, principal.userId]);
      await client.query(`UPDATE business_tasks SET status=$3,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='awaiting_approval'`, [principal.tenantId, row.business_task_id,
        decision === 'approved' ? 'approved' : 'failed']);
      if (decision === 'rejected') {
        const failed = { kind: 'failed', code: 'CONNECTOR_AUTH_FAILED', message: '工单查询未获批准。' };
        await client.query(`UPDATE business_tasks SET result=$3,result_record_variant='business-task-result.work-order.live/1'
          WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, row.business_task_id, failed]);
      }
      await appendEvent(client, principal.tenantId, row.business_task_id, `approval.${decision}`, { approvalId });
      return { approvalId, status: decision, businessTaskId: row.business_task_id };
    });
  }

  async executeTask(
    principal: Principal,
    taskId: string,
    expected: Readonly<{ expectedApprovalVersion: number; expectedApprovalSubjectDigest: string }>,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key is required', 400);
    }
    return this.withTransaction(async (client) => {
      await this.assertCurrentExecutionAuthority(client, principal.tenantId, taskId, principal.userId);
      const approval = await client.query<{ version: string; subject_digest: string }>(`SELECT version::text,subject_digest
        FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2
        ORDER BY version DESC LIMIT 1 FOR UPDATE`, [principal.tenantId, taskId]);
      if (Number(approval.rows[0]?.version) !== expected.expectedApprovalVersion
        || approval.rows[0]?.subject_digest !== expected.expectedApprovalSubjectDigest) {
        throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approval version or subject digest changed', 409);
      }
      const task = await client.query<{ status: string }>(`SELECT status FROM business_tasks
        WHERE tenant_id=$1 AND id=$2 AND requester_id=$3
          AND record_variant='business-task.work-order.live/1' FOR UPDATE`, [principal.tenantId, taskId, principal.userId]);
      const status = task.rows[0]?.status;
      if (status === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
      if (status === 'running' || status === 'queued') return { taskId, status };
      if (status !== 'approved') throw new GenewayError('APPROVAL_REQUIRED', 'Task must be approved before execution', 409);
      if (TERMINAL_STATUSES.has(status)) throw new GenewayError('TASK_TERMINAL', 'Task is already terminal', 409);
      await client.query(`UPDATE business_tasks SET status='queued',execution_version=execution_version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, taskId]);
      await appendEvent(client, principal.tenantId, taskId, 'workflow.run_requested', {});
      return { taskId, status: 'queued' };
    });
  }

  async cancelTask(principal: Principal, taskId: string, idempotencyKey: string): Promise<unknown> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key is required', 400);
    }
    return this.withTransaction(async (client) => {
      // Cancellation remains available after revocation, but it still joins the
      // same advisory-lock order so it cannot interleave with an authority mutation.
      await this.lockAuthorityShared(client);
      const selected = await client.query<{ status: string }>(`SELECT status FROM business_tasks
        WHERE tenant_id=$1 AND id=$2 AND requester_id=$3
          AND record_variant='business-task.work-order.live/1' FOR UPDATE`, [principal.tenantId, taskId, principal.userId]);
      const status = selected.rows[0]?.status;
      if (status === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
      if (status === 'canceled') return { taskId, status: 'canceled' };
      if (status === 'completed' || status === 'failed') throw new GenewayError('TASK_TERMINAL', 'Task is already terminal', 409);
      const result = { kind: 'canceled', code: 'USER_CANCELED', message: '用户已停止只读工单查询。' };
      await client.query(`UPDATE business_tasks SET status='canceled',result=$3,
        result_record_variant='business-task-result.work-order.live/1',
        execution_fencing_token=execution_fencing_token+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, taskId, result]);
      await client.query(`UPDATE business_task_steps SET status='canceled',lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('queued','running')`, [principal.tenantId, taskId]);
      await client.query(`UPDATE gate_a3_connector_token_authorizations SET invalidated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [
        principal.tenantId, taskId,
      ]);
      await client.query(`UPDATE gate_a3_connector_invocations SET status='canceled',error_class='USER_CANCELED',
        terminal_at=now(),redacted_audit=redacted_audit||'{"terminalErrorClass":"USER_CANCELED"}'::jsonb
        WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [principal.tenantId, taskId]);
      await client.query(`UPDATE gate_a3_model_invocations SET
        invalidated_at=CASE WHEN consumed_at IS NULL THEN now() ELSE invalidated_at END,
        status='canceled',terminal_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [principal.tenantId, taskId]);
      await client.query(`UPDATE execution_attempts SET status='canceled',completed_at=now(),last_error='USER_CANCELED'
        WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'`, [principal.tenantId, taskId]);
      await client.query(`UPDATE outbox_deliveries SET status='canceled',lease_until=now(),last_error='USER_CANCELED',updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND status='leased'`, [principal.tenantId, taskId]);
      await client.query(`UPDATE inbox_events SET status='failed',processing_at=coalesce(processing_at,now()),
        completed_at=now(),last_error='USER_CANCELED' WHERE tenant_id=$1 AND business_task_id=$2
        AND status IN ('received','processing')`, [principal.tenantId, taskId]);
      await appendEvent(client, principal.tenantId, taskId, 'business_task.canceled', { reasonCode: 'USER_CANCELED' });
      return { taskId, status: 'canceled' };
    });
  }

  async claimWorkOrder(workerInstanceId: string, leaseDurationMs: number): Promise<GateA3WorkOrderWorkerClaim | null> {
    if (workerInstanceId.length < 1 || workerInstanceId.length > 200
      || !Number.isInteger(leaseDurationMs) || leaseDurationMs < 250 || leaseDurationMs > 900_000) {
      throw new GenewayError('WORKER_CLAIM_INVALID', 'Work Order worker claim input is invalid', 400);
    }
    return this.withTransaction(async (client) => {
      try {
        await this.assertAuthority(client, 'tenant_local');
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'NOT_OPEN') {
          await this.settleUnavailableAuthorityWorkOrder(client, 'tenant_local');
          return null;
        }
        throw error;
      }
      await this.settleExpiredWorkOrder(client, 'tenant_local');
      await this.reclaimExpiredWorkOrder(client, 'tenant_local');
      await this.settleExpiredWorkOrder(client, 'tenant_local');
      const selected = await client.query<{
        tenant_id: string; event_id: string; business_task_id: string; execution_version: string;
        execution_fencing_token: string; requester_id: string; workflow_version_id: string; workflow_hash: string;
        input_snapshot: unknown; approval_subject_digest: string; deadline: Date; spec_hash: string;
      }>(`SELECT outbox.tenant_id,outbox.event_id,outbox.business_task_id,task.execution_version::text,
          task.execution_fencing_token::text,task.requester_id,task.workflow_version_id,task.workflow_hash,
          task.input_snapshot,approval.subject_digest approval_subject_digest,spec.deadline,spec.spec_hash
        FROM outbox_events outbox
        JOIN business_tasks task ON task.tenant_id=outbox.tenant_id AND task.id=outbox.business_task_id
        JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
        JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
          AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
            AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
        WHERE outbox.tenant_id='tenant_local' AND outbox.event_type='workflow.run_requested' AND task.status='queued'
          AND task.record_variant='business-task.work-order.live/1' AND approval.status='approved'
          AND approval.expires_at>now() AND spec.deadline>now()
          AND NOT EXISTS (SELECT 1 FROM gate_a3_connector_invocations retry
            WHERE retry.tenant_id=task.tenant_id AND retry.business_task_id=task.id
              AND retry.retry_scheduled AND retry.retry_not_before>now())
          AND NOT EXISTS (SELECT 1 FROM outbox_deliveries delivery WHERE delivery.tenant_id=outbox.tenant_id
            AND delivery.consumer=$1 AND delivery.event_id=outbox.event_id)
        ORDER BY outbox.created_at,outbox.event_id FOR UPDATE OF outbox,task,approval SKIP LOCKED LIMIT 1`, [WORKER_CONSUMER]);
      const row = selected.rows[0];
      if (row === undefined) return null;
      const input = z.object({ workOrderRef: z.string(), connectorQuerySpecHash: z.string() }).passthrough()
        .parse(row.input_snapshot);
      if (input.connectorQuerySpecHash !== row.spec_hash) {
        throw new GenewayError('CONNECTOR_AUTHORITY_STALE', 'Work Order QuerySpec authority changed', 409);
      }
      const executionVersion = Number(row.execution_version);
      const taskFence = Number(row.execution_fencing_token) + 1;
      if (!Number.isSafeInteger(executionVersion) || executionVersion < 1 || !Number.isSafeInteger(taskFence)) {
        throw new GenewayError('WORK_ORDER_EXECUTION_INVALID', 'Work Order execution version is invalid', 409);
      }
      const executionAttemptId = id('attempt');
      const deliveryId = id('delivery');
      const stepAttemptId = id('step_attempt');
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,
         worker_instance_id,status,fencing_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+($10::bigint*interval '1 millisecond'))`, [
        row.tenant_id, executionAttemptId, row.business_task_id, executionVersion, row.event_id,
        WORKER_CONSUMER, WORKER_DEPLOYMENT, workerInstanceId, taskFence, leaseDurationMs,
      ]);
      await client.query(`INSERT INTO outbox_deliveries
        (tenant_id,id,business_task_id,consumer,deployment_id,event_id,status,execution_attempt_id,
         worker_instance_id,fencing_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,'leased',$7,$8,$9,now()+($10::bigint*interval '1 millisecond'))`, [
        row.tenant_id, deliveryId, row.business_task_id, WORKER_CONSUMER, WORKER_DEPLOYMENT,
        row.event_id, executionAttemptId, workerInstanceId, taskFence, leaseDurationMs,
      ]);
      await client.query(`INSERT INTO inbox_events
        (tenant_id,consumer,deployment_id,event_id,delivery_id,business_task_id,execution_attempt_id,
         worker_instance_id,fencing_token,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'received')`, [row.tenant_id, WORKER_CONSUMER,
        WORKER_DEPLOYMENT, row.event_id, deliveryId, row.business_task_id, executionAttemptId,
        workerInstanceId, taskFence]);
      const taskUpdated = await client.query(`UPDATE business_tasks SET status='running',
        current_execution_attempt_id=$3,execution_fencing_token=$4,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='queued' AND execution_version=$5`, [
        row.tenant_id, row.business_task_id, executionAttemptId, taskFence, executionVersion,
      ]);
      if (taskUpdated.rowCount !== 1) throw new GenewayError('WORK_ORDER_CLAIM_CONFLICT', 'Work Order task changed before claim', 409);
      const stepUpdated = await client.query(`UPDATE business_task_steps SET status='running',attempt_id=$3,
        fencing_token=fencing_token+1,lease_until=now()+($4::bigint*interval '1 millisecond'),updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id='validate_work_order_ref' AND status='queued'
        RETURNING fencing_token::text`, [row.tenant_id, row.business_task_id, stepAttemptId, leaseDurationMs]);
      const stepFence = Number((stepUpdated.rows[0] as { fencing_token?: string } | undefined)?.fencing_token);
      if (stepUpdated.rowCount !== 1 || !Number.isSafeInteger(stepFence) || stepFence < 1) {
        throw new GenewayError('WORK_ORDER_STEP_CLAIM_CONFLICT', 'Work Order validation step changed before claim', 409);
      }
      await client.query(`UPDATE inbox_events SET status='processing',processing_at=now()
        WHERE tenant_id=$1 AND consumer=$2 AND event_id=$3 AND status='received'`, [row.tenant_id, WORKER_CONSUMER, row.event_id]);
      await appendEvent(client, row.tenant_id, row.business_task_id, 'workflow.run_started', {
        executionAttemptId, taskFence, workerInstanceId,
      });
      return {
        schemaVersion: 'gate-a3-work-order-worker-claim/1', tenantId: row.tenant_id,
        principalId: row.requester_id, taskId: row.business_task_id, workflowVersionId: row.workflow_version_id,
        workflowHash: row.workflow_hash, executionAttemptId, taskFence,
        approvalSubjectDigest: row.approval_subject_digest, capabilityVersionId: CAPABILITY_VERSION_ID,
        connectorQuerySpecHash: row.spec_hash, deadline: iso(row.deadline), workOrderRef: input.workOrderRef,
        step: { stepId: 'validate_work_order_ref', stepAttemptId, stepFence },
      };
    });
  }

  async markWorkOrderStarted(mutation: GateA3WorkOrderMutation): Promise<void> {
    await this.withTransaction(async (client) => {
      await this.loadMutation(client, mutation, 'validate_work_order_ref');
    });
  }

  async requestWorkOrderCancellation(
    mutation: GateA3WorkOrderMutation,
    leaseDurationMs: number,
  ): Promise<Readonly<{ taskFence: number }> | null> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 250 || leaseDurationMs > 900_000) {
      throw new GenewayError('WORK_ORDER_LEASE_INVALID', 'Work Order heartbeat lease is invalid', 400);
    }
    return this.withTransaction(async (client) => {
      await this.lockAuthorityShared(client);
      const selected = await client.query<{ status: string; execution_fencing_token: string }>(`SELECT status,
        execution_fencing_token::text FROM business_tasks WHERE tenant_id=$1 AND id=$2 AND workflow_version_id=$3
        AND workflow_hash=$4 AND current_execution_attempt_id=$5
        AND record_variant='business-task.work-order.live/1' FOR UPDATE`, [mutation.tenantId, mutation.taskId,
        mutation.workflowVersionId, mutation.workflowHash, mutation.executionAttemptId]);
      const row = selected.rows[0];
      if (row === undefined) return null;
      const fence = Number(row.execution_fencing_token);
      if (row.status === 'canceled') {
        return Number.isSafeInteger(fence) && fence > mutation.taskFence ? { taskFence: fence } : null;
      }
      if (row.status !== 'running' || fence !== mutation.taskFence) {
        throw new GenewayError('WORK_ORDER_AUTHORITY_STALE', 'Work Order heartbeat authority is not current', 409);
      }
      const activeSteps = await client.query<{ step_id: GateA3WorkOrderStepLease['stepId'];
        attempt_id: string; fencing_token: string }>(`SELECT step_id,attempt_id,fencing_token::text
        FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'
          AND record_variant='business-task-step.work-order.live/1' FOR UPDATE`, [mutation.tenantId, mutation.taskId]);
      const activeStep = activeSteps.rows[0];
      if (activeSteps.rowCount !== 1 || activeStep === undefined) {
        throw new GenewayError('WORK_ORDER_AUTHORITY_STALE', 'Work Order heartbeat step is not current', 409);
      }
      const context = await this.loadMutation(client, mutation, activeStep.step_id, {
        stepId: activeStep.step_id,
        stepAttemptId: activeStep.attempt_id,
        stepFence: Number(activeStep.fencing_token),
      });
      const now = Date.now();
      const leaseUntil = new Date(Math.min(
        now + leaseDurationMs,
        context.deadline.getTime(),
        context.approvalExpiresAt.getTime(),
      ));
      if (leaseUntil.getTime() <= now) {
        throw new GenewayError('WORK_ORDER_AUTHORITY_STALE', 'Work Order heartbeat deadline has expired', 409);
      }
      const attempt = await client.query(`UPDATE execution_attempts SET lease_until=$5
        WHERE tenant_id=$1 AND id=$2 AND business_task_id=$3 AND status='running'
          AND fencing_token=$4 AND lease_until>now() AND worker_instance_id IS NOT NULL`, [
        context.tenantId, context.executionAttemptId, context.taskId, context.taskFence, leaseUntil,
      ]);
      const delivery = await client.query(`UPDATE outbox_deliveries SET lease_until=$5,updated_at=now()
        WHERE tenant_id=$1 AND execution_attempt_id=$2 AND business_task_id=$3 AND status='leased'
          AND fencing_token=$4 AND lease_until>now()`, [context.tenantId, context.executionAttemptId,
        context.taskId, context.taskFence, leaseUntil]);
      const step = await client.query(`UPDATE business_task_steps SET lease_until=$6,updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='running'
          AND attempt_id=$4 AND fencing_token=$5 AND lease_until>now()`, [context.tenantId, context.taskId,
        context.stepId, context.stepAttemptId, context.stepFence, leaseUntil]);
      if (attempt.rowCount !== 1 || delivery.rowCount !== 1 || step.rowCount !== 1) {
        throw new GenewayError('WORK_ORDER_AUTHORITY_STALE', 'Work Order heartbeat lost its execution fence', 409);
      }
      return null;
    });
  }

  private async validateFailureReceipt(
    client: pg.PoolClient,
    context: MutationContext,
    errorClass: z.infer<typeof gateA3WorkOrderTerminalErrorClassSchema>,
    receiptValue: unknown,
  ): Promise<void> {
    if (context.stepId === 'fetch_authorized_status') {
      if (!gateA3ConnectorErrorClassSchema.safeParse(errorClass).success) {
        throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector step reported a non-connector failure', 409);
      }
      const invocation = await client.query<{ id: string; effect_id: string; jti_digest: string }>(`SELECT id,effect_id,jti_digest
        FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2
          AND execution_attempt_id=$3 AND step_attempt_id=$4 AND task_fence=$5 AND step_fence=$6
          AND status IN ('authorized','running') FOR UPDATE`, [context.tenantId, context.taskId,
        context.executionAttemptId, context.stepAttemptId, context.taskFence, context.stepFence]);
      const row = invocation.rows[0];
      if (row === undefined) {
        throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector failure has no current invocation', 409);
      }
      if (receiptValue === undefined) {
        if (!['CONNECTOR_ROUTE_UNAVAILABLE', 'CONNECTOR_TIMEOUT', 'CONNECTOR_PROTOCOL_VIOLATION'].includes(errorClass)) {
          throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector failure requires a signed receipt', 409);
        }
        return;
      }
      const receipt = gateA3ConnectorGatewayReceiptSchema.parse(receiptValue);
      const payload = receipt.payload;
      const retryNotBeforeMs = 'retryNotBefore' in payload && payload.retryNotBefore !== undefined
        ? Date.parse(payload.retryNotBefore) : null;
      const issuedAtMs = Date.parse(payload.issuedAt);
      const retryPolicyInvalid = errorClass === 'CONNECTOR_RATE_LIMITED'
        ? retryNotBeforeMs === null || !Number.isFinite(retryNotBeforeMs)
          || retryNotBeforeMs <= issuedAtMs || retryNotBeforeMs > issuedAtMs + 60_000
        : retryNotBeforeMs !== null;
      if (payload.outcome !== errorClass || retryPolicyInvalid
        || !verifySignedPayload(payload, receipt.signature, this.authority.connectorGatewayReceiptSecret)
        || payload.tenantId !== context.tenantId || payload.principal !== context.principalId
        || payload.taskId !== context.taskId || payload.workflowVersionId !== context.workflowVersionId
        || payload.workflowHash !== context.workflowHash || payload.stepId !== context.stepId
        || payload.attemptId !== context.stepAttemptId || payload.fence !== context.stepFence
        || payload.connectorInvocationId !== row.id || payload.effectId !== row.effect_id
        || sha256(payload.jti) !== row.jti_digest
        || payload.connectorQuerySpecHash !== context.connectorQuerySpecHash
        || payload.connectorProfileVersion !== GATE_A3_CONNECTOR_PROFILE_VERSION
        || payload.workOrderRefHash !== context.workOrderRefHash
        || payload.fieldMaskVersion !== GATE_A3_FIELD_MASK_VERSION
        || payload.resourceContextDigest !== context.resourceContextDigest
        || payload.deadline !== iso(context.deadline)) {
        throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector failure receipt is not current', 409);
      }
      await client.query(`UPDATE gate_a3_connector_invocations SET
        redacted_audit=redacted_audit||jsonb_build_object('failureReceiptDigest',$3::text)
        WHERE tenant_id=$1 AND id=$2 AND status IN ('authorized','running')`, [
        context.tenantId, row.id, digest(receipt),
      ]);
      return;
    }
    if (context.stepId === 'explain_status') {
      if (!gateA3WorkOrderModelFailureClassSchema.safeParse(errorClass).success) {
        throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model step reported a non-model failure', 409);
      }
      if (receiptValue === undefined) {
        if (!['MODEL_ROUTE_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_STREAM_INTERRUPTED',
          'MODEL_PROTOCOL_VIOLATION'].includes(errorClass)) {
          throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model failure requires a signed receipt', 409);
        }
        return;
      }
      const receipt = gateA3WorkOrderModelReceiptSchema.parse(receiptValue);
      const payload = receipt.payload;
      const invocation = await client.query<{ id: string; effect_id: string; connector_source_snapshot_id: string;
        input_digest: string; policy_version: string; prompt_policy_resolved_bytes_sha256: string }>(`SELECT
          id,effect_id,connector_source_snapshot_id,input_digest,policy_version,prompt_policy_resolved_bytes_sha256
        FROM gate_a3_model_invocations WHERE tenant_id=$1 AND business_task_id=$2
          AND execution_attempt_id=$3 AND step_attempt_id=$4 AND task_fence=$5 AND step_fence=$6
          AND status IN ('authorized','running') FOR UPDATE`, [context.tenantId, context.taskId,
        context.executionAttemptId, context.stepAttemptId, context.taskFence, context.stepFence]);
      const row = invocation.rows[0];
      const source = await client.query<{ canonical_payload: unknown; canonical_payload_hash: string;
        audience: string; connector_invocation_id: string; effect_id: string; step_attempt_id: string;
        step_fence: string; source_revision: string; created_at: Date; progress: unknown }>(`SELECT
          snapshot.canonical_payload,snapshot.canonical_payload_hash,snapshot.audience,
          snapshot.connector_invocation_id,snapshot.effect_id,snapshot.step_attempt_id,
          snapshot.step_fence::text,snapshot.source_revision,snapshot.created_at,compute.output progress
        FROM gate_a3_connector_source_snapshots snapshot
        JOIN business_task_steps compute ON compute.tenant_id=snapshot.tenant_id
          AND compute.business_task_id=snapshot.business_task_id AND compute.step_id='compute_progress'
        WHERE snapshot.tenant_id=$1 AND snapshot.id=$2 FOR SHARE`, [context.tenantId,
        row?.connector_source_snapshot_id ?? 'missing']);
      const sourceRow = source.rows[0];
      if (row === undefined || sourceRow === undefined) {
        throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model failure receipt has no current invocation', 409);
      }
      const snapshotPayload = gateA3ConnectorWorkOrderResponseSchema.parse(sourceRow.canonical_payload);
      const progress = gateA3WorkOrderProgressSchema.parse(sourceRow.progress);
      const promptAuthority = await this.resolveWorkOrderPromptPolicy(client, context.tenantId);
      const snapshot = gateA3ConnectorSourceSnapshotSchema.parse({
        schemaVersion: 'connector-source-snapshot/1', canonicalizationVersion: 'RFC8785/JCS-1',
        connectorSourceSnapshotId: row.connector_source_snapshot_id, tenantId: context.tenantId,
        principal: context.principalId, taskId: context.taskId,
        connectorInvocationId: sourceRow.connector_invocation_id, effectId: sourceRow.effect_id,
        attemptId: sourceRow.step_attempt_id, fence: Number(sourceRow.step_fence),
        connectorQuerySpecHash: context.connectorQuerySpecHash, workOrderRefHash: context.workOrderRefHash,
        responseRefMatched: true, fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
        sourceRevision: sourceRow.source_revision, sourceAsOf: snapshotPayload.updatedAt,
        canonicalAllowlistedPayload: snapshotPayload,
        canonicalAllowlistedPayloadHash: sourceRow.canonical_payload_hash, resourceScope: RESOURCE_SCOPE,
        dataClass: 'C1', audience: { tenantId: context.tenantId, principal: context.principalId },
        createdAt: iso(sourceRow.created_at),
      });
      const expected = {
        tenantId: context.tenantId, principalId: context.principalId, taskId: context.taskId,
        workflowVersionId: context.workflowVersionId, workflowHash: context.workflowHash,
        executionAttemptId: context.executionAttemptId, taskFence: context.taskFence,
        stepId: 'explain_status', stepAttemptId: context.stepAttemptId, stepFence: context.stepFence,
        modelInvocationId: row.id, approvalSubjectDigest: context.approvalSubjectDigest,
        capabilityVersionId: CAPABILITY_VERSION_ID, effectId: row.effect_id,
        connectorQuerySpecHash: context.connectorQuerySpecHash,
        connectorSourceSnapshotId: row.connector_source_snapshot_id,
        connectorSourceSnapshotHash: digest(snapshot), snapshotPayloadHash: sourceRow.canonical_payload_hash,
        progressDigest: digest(progress), resourceScope: RESOURCE_SCOPE, snapshotAudience: sourceRow.audience,
        logicalModelPolicy: 'business.production.work-order-status.explanation',
        promptPolicyVersionId: promptAuthority.versionId,
        promptPolicyResolvedBytesSha256: promptAuthority.resolvedBytesSha256,
        routeProfile: 'codex_subscription_dev',
        dataClass: 'C1', toolChoice: 'none', outputSchemaVersion: 'work-order.explanation/1',
        maxOutputTokens: 1_024, deadline: iso(context.deadline),
      } as const;
      if (payload.outcome !== errorClass
        || !verifySignedPayload(payload, receipt.signature, this.authority.modelGatewayReceiptSecret)
        || row.policy_version !== promptAuthority.versionId
        || row.prompt_policy_resolved_bytes_sha256 !== promptAuthority.resolvedBytesSha256
        || row.input_digest !== digest({ snapshot: snapshotPayload, progress })
        || Object.entries(expected).some(([key, value]) => payload[key as keyof typeof payload] !== value)) {
        throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model failure receipt is not current', 409);
      }
      await client.query(`UPDATE gate_a3_model_invocations SET receipt=$3,receipt_digest=$4
        WHERE tenant_id=$1 AND id=$2 AND status IN ('authorized','running')`, [
        context.tenantId, row.id, receipt, digest(receipt),
      ]);
      return;
    }
    if (receiptValue !== undefined || errorClass !== 'WORK_ORDER_PROTOCOL_VIOLATION'
      && !(context.stepId === 'validate_work_order_ref' && errorClass === 'WORK_ORDER_REF_INVALID')) {
      throw new GenewayError('WORK_ORDER_PROTOCOL_VIOLATION', 'Failure does not match the current deterministic step', 409);
    }
  }

  async handleConnectorFailure(
    mutation: GateA3WorkOrderMutation,
    step: GateA3WorkOrderStepLease,
    failure: unknown,
  ): Promise<GateA3ConnectorFailureDisposition> {
    const parsed = z.object({
      errorClass: gateA3ConnectorErrorClassSchema,
      receipt: z.unknown().optional(),
    }).strict().parse(failure);
    if (step.stepId !== 'fetch_authorized_status') {
      throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector failure step is invalid', 409);
    }
    const failureCommandDigest = digest({
      errorClass: parsed.errorClass,
      receipt: parsed.receipt ?? null,
    });
    return this.withTransaction(async (client) => {
      await this.assertAuthority(client, mutation.tenantId);
      const readReplay = async (): Promise<GateA3ConnectorFailureDisposition | null> => {
        const selected = await client.query<{ error_class: string | null; retry_scheduled: boolean;
          retry_not_before: Date | null; redacted_audit: unknown }>(`SELECT error_class,retry_scheduled,
            retry_not_before,redacted_audit FROM gate_a3_connector_invocations
          WHERE tenant_id=$1 AND business_task_id=$2 AND workflow_version_id=$3 AND workflow_hash=$4
            AND execution_attempt_id=$5 AND step_attempt_id=$6 AND task_fence=$7 AND step_fence=$8
            AND status='failed'`, [mutation.tenantId, mutation.taskId, mutation.workflowVersionId,
          mutation.workflowHash, mutation.executionAttemptId, step.stepAttemptId, mutation.taskFence,
          step.stepFence]);
        const row = selected.rows[0];
        const audit = z.object({ failureCommandDigest: z.string() }).passthrough().safeParse(row?.redacted_audit);
        if (row === undefined || row.error_class !== parsed.errorClass || !audit.success
          || audit.data.failureCommandDigest !== failureCommandDigest) return null;
        if (!row.retry_scheduled) return { retryScheduled: false };
        if (row.retry_not_before === null) {
          throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Durable connector retry time is missing', 409);
        }
        return { retryScheduled: true, retryNotBefore: iso(row.retry_not_before) };
      };

      let context: MutationContext;
      try {
        context = await this.loadMutation(client, mutation, step.stepId, step);
      } catch (error) {
        const replay = await readReplay();
        if (replay !== null) return replay;
        throw error;
      }
      await this.validateFailureReceipt(client, context, parsed.errorClass, parsed.receipt);
      const invocation = await client.query<{ id: string; effect_id: string }>(`SELECT id,effect_id
        FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2
          AND execution_attempt_id=$3 AND step_attempt_id=$4 AND task_fence=$5 AND step_fence=$6
          AND status IN ('authorized','running') FOR UPDATE`, [context.tenantId, context.taskId,
        context.executionAttemptId, context.stepAttemptId, context.taskFence, context.stepFence]);
      const invocationRow = invocation.rows[0];
      if (invocationRow === undefined) {
        throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector failure invocation is no longer current', 409);
      }
      const attempts = await client.query<{ count: string }>(`SELECT count(*)::text count
        FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2`, [
        context.tenantId, context.taskId,
      ]);
      const attemptCount = Number(attempts.rows[0]?.count);
      let retryNotBefore: Date | null = null;
      if (parsed.errorClass === 'CONNECTOR_RATE_LIMITED' && parsed.receipt !== undefined) {
        const receipt = gateA3ConnectorGatewayReceiptSchema.parse(parsed.receipt);
        if ('retryNotBefore' in receipt.payload && receipt.payload.retryNotBefore !== undefined) {
          retryNotBefore = new Date(receipt.payload.retryNotBefore);
        }
      } else if (parsed.errorClass === 'CONNECTOR_ROUTE_UNAVAILABLE'
        || parsed.errorClass === 'CONNECTOR_TIMEOUT') {
        retryNotBefore = new Date(Date.now() + 250);
      }
      const retryAuthorityDeadline = Math.min(context.deadline.getTime(), context.approvalExpiresAt.getTime());
      const retryScheduled = RETRYABLE_CONNECTOR_ERRORS.has(parsed.errorClass)
        && Number.isSafeInteger(attemptCount) && attemptCount < context.querySpec.budget.maxAttempts
        && retryNotBefore !== null && retryNotBefore.getTime() < retryAuthorityDeadline;
      if (!retryScheduled || retryNotBefore === null) {
        await this.settleFailedWorkOrder(client, context, parsed.errorClass, failureCommandDigest);
        return { retryScheduled: false };
      }

      const invocationUpdated = await client.query(`UPDATE gate_a3_connector_invocations SET
        status='failed',error_class=$3,terminal_at=now(),retry_scheduled=true,retry_not_before=$4,
        redacted_audit=redacted_audit||jsonb_build_object('terminalErrorClass',$3::text,
          'failureCommandDigest',$5::text,'retryScheduled',true,'retryNotBefore',$4::timestamptz)
        WHERE tenant_id=$1 AND id=$2 AND status IN ('authorized','running')`, [context.tenantId,
        invocationRow.id, parsed.errorClass, retryNotBefore, failureCommandDigest]);
      if (invocationUpdated.rowCount !== 1) {
        throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector retry lost its invocation fence', 409);
      }
      await client.query(`UPDATE gate_a3_connector_token_authorizations SET invalidated_at=now()
        WHERE tenant_id=$1 AND connector_invocation_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [
        context.tenantId, invocationRow.id,
      ]);
      await this.finishDelivery(client, context, 'failed', parsed.errorClass);
      await client.query(`UPDATE business_task_steps SET status='queued',attempt_id=NULL,lease_until=NULL,
        output=NULL,updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2`, [context.tenantId, context.taskId]);
      const nextFence = context.taskFence + 1;
      const taskUpdated = await client.query(`UPDATE business_tasks SET status='queued',
        current_execution_attempt_id=NULL,execution_version=execution_version+1,
        execution_fencing_token=$3,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='running' AND current_execution_attempt_id=$4
          AND execution_fencing_token=$5`, [context.tenantId, context.taskId, nextFence,
        context.executionAttemptId, context.taskFence]);
      if (taskUpdated.rowCount !== 1) {
        throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Connector retry lost its task fence', 409);
      }
      await appendEvent(client, context.tenantId, context.taskId, 'workflow.run_requested', {
        reason: parsed.errorClass,
        retryNotBefore: iso(retryNotBefore),
        stableEffectId: invocationRow.effect_id,
        supersededConnectorInvocationId: invocationRow.id,
        supersededExecutionAttemptId: context.executionAttemptId,
        invalidatedFence: nextFence,
      });
      return { retryScheduled: true, retryNotBefore: iso(retryNotBefore) };
    });
  }

  async settleWorkOrder(
    mutation: GateA3WorkOrderMutation,
    terminal: unknown,
    step?: GateA3WorkOrderStepLease,
  ): Promise<void> {
    const parsed = z.discriminatedUnion('status', [
      z.object({ status: z.literal('completed'), card: gateA3WorkOrderStatusCardSchema,
        explanation: gateA3WorkOrderExplanationSchema }).strict(),
      z.object({ status: z.literal('failed'), errorClass: gateA3WorkOrderTerminalErrorClassSchema,
        receipt: z.unknown().optional() }).strict(),
      z.object({ status: z.literal('canceled') }).strict(),
    ]).parse(terminal);
    await this.withTransaction(async (client) => {
      await this.lockAuthorityShared(client);
      if (parsed.status === 'canceled') {
        const canceled = await client.query(`SELECT 1 FROM business_tasks WHERE tenant_id=$1 AND id=$2
          AND workflow_version_id=$3 AND workflow_hash=$4 AND current_execution_attempt_id=$5
          AND execution_fencing_token=$6 AND status='canceled'
          AND record_variant='business-task.work-order.live/1' FOR UPDATE`, [mutation.tenantId, mutation.taskId,
          mutation.workflowVersionId, mutation.workflowHash, mutation.executionAttemptId, mutation.taskFence]);
        if (canceled.rowCount !== 1) throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Canceled Work Order fence is stale', 409);
        return;
      }
      let activeStep = step;
      if (activeStep === undefined) {
        const selectedStep = await client.query<{ step_id: GateA3WorkOrderStepLease['stepId'];
          attempt_id: string; fencing_token: string }>(`SELECT step_id,attempt_id,fencing_token::text
          FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'
            AND record_variant='business-task-step.work-order.live/1'`, [mutation.tenantId, mutation.taskId]);
        const row = selectedStep.rows[0];
        if (row === undefined) throw new GenewayError('WORK_ORDER_STEP_NOT_RUNNING', 'No Work Order step is running', 409);
        activeStep = { stepId: row.step_id, stepAttemptId: row.attempt_id, stepFence: Number(row.fencing_token) };
      }
      const context = await this.loadMutation(client, mutation, activeStep.stepId, activeStep);
      if (parsed.status === 'failed') {
        await this.validateFailureReceipt(client, context, parsed.errorClass, parsed.receipt);
        await this.settleFailedWorkOrder(client, context, parsed.errorClass,
          digest({ errorClass: parsed.errorClass, receipt: parsed.receipt ?? null }));
        return;
      }
      if (activeStep.stepId !== 'publish_status_card') {
        throw new GenewayError('WORK_ORDER_STEP_ORDER_INVALID', 'Only publish_status_card can complete the task', 409);
      }
      const source = await client.query<{ snapshot_id: string; connector_invocation_id: string;
        canonical_payload: unknown; canonical_payload_hash: string; source_as_of: Date;
        effect_id: string; explanation_id: string; explanation: unknown; explanation_hash: string; progress: unknown }>(`SELECT
          snapshot.id snapshot_id,snapshot.connector_invocation_id,snapshot.canonical_payload,
          snapshot.canonical_payload_hash,snapshot.source_as_of,snapshot.effect_id,explanation.id explanation_id,
          explanation.explanation,explanation.explanation_hash,compute.output progress
        FROM gate_a3_connector_source_snapshots snapshot
        JOIN gate_a3_work_order_explanations explanation ON explanation.tenant_id=snapshot.tenant_id
          AND explanation.business_task_id=snapshot.business_task_id
          AND explanation.connector_source_snapshot_id=snapshot.id
        JOIN business_task_steps compute ON compute.tenant_id=snapshot.tenant_id
          AND compute.business_task_id=snapshot.business_task_id AND compute.step_id='compute_progress'
        WHERE snapshot.tenant_id=$1 AND snapshot.business_task_id=$2 FOR SHARE`, [context.tenantId, context.taskId]);
      const row = source.rows[0];
      if (row === undefined) throw new GenewayError('WORK_ORDER_PUBLICATION_INVALID', 'Work Order publication inputs are missing', 409);
      const evidenceAuthority = await this.revalidateConnectorEvidence(client, {
        tenantId: context.tenantId, taskId: context.taskId, principalId: context.principalId,
        snapshotId: row.snapshot_id,
      });
      const payload = evidenceAuthority.payload;
      const progress = gateA3WorkOrderProgressSchema.parse(row.progress);
      const evidenceByField = new Map(Array.from(evidenceAuthority.fields.entries(),
        ([fieldName, field]) => [fieldName, field.id]));
      const expectedCard = gateA3WorkOrderStatusCardSchema.parse({
        schemaVersion: 'WorkOrderStatusCard/1', workOrderRef: payload.workOrderRef, status: payload.status,
        planQty: payload.planQty, completedQty: payload.completedQty, unit: payload.unit,
        progressPct: progress.progressPct, updatedAt: payload.updatedAt, sourceAsOf: payload.updatedAt,
        evidenceRefs: { status: evidenceByField.get('status'), planQty: evidenceByField.get('planQty'),
          completedQty: evidenceByField.get('completedQty'), updatedAt: evidenceByField.get('updatedAt'),
          sourceAsOf: evidenceByField.get('updatedAt') }, readOnly: true,
      });
      const acceptedExplanation = gateA3WorkOrderExplanationSchema.parse(row.explanation);
      if (evidenceAuthority.snapshot.connectorInvocationId !== row.connector_invocation_id
        || evidenceAuthority.snapshot.effectId !== row.effect_id
        || digest(payload) !== row.canonical_payload_hash || digest(acceptedExplanation) !== row.explanation_hash
        || digest(parsed.card) !== digest(expectedCard)
        || digest(parsed.explanation) !== digest(acceptedExplanation)) {
        throw new GenewayError('WORK_ORDER_PUBLICATION_INVALID', 'Card or explanation drifted before publication', 409);
      }
      const publicExplanation = deterministicPublicExplanation(acceptedExplanation, expectedCard, payload);
      const publicResult = { kind: 'work_order_status' as const, card: expectedCard, explanation: publicExplanation };
      await client.query(`INSERT INTO gate_a3_work_order_results
        (tenant_id,id,business_task_id,connector_source_snapshot_id,connector_invocation_id,
         explanation_id,effect_id,record_variant,card_schema_version,card,card_hash,public_result,public_result_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'business-task-result.work-order.live/1','WorkOrderStatusCard/1',
          $8,$9,$10,$11)`, [context.tenantId, id('work_order_result'), context.taskId, row.snapshot_id,
        row.connector_invocation_id, row.explanation_id, row.effect_id, expectedCard,
        digest(expectedCard), publicResult, digest(publicResult)]);
      const stepUpdated = await client.query(`UPDATE business_task_steps SET status='completed',output=$6,
        lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3
          AND status='running' AND attempt_id=$4 AND fencing_token=$5`, [context.tenantId, context.taskId,
        context.stepId, context.stepAttemptId, context.stepFence,
        { cardHash: digest(expectedCard), resultHash: digest(publicResult) }]);
      if (stepUpdated.rowCount !== 1) throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Publish step lost its fence', 409);
      await this.finishDelivery(client, context, 'completed', null);
      const completed = await client.query(`UPDATE business_tasks SET status='completed',result=$3,
        result_record_variant='business-task-result.work-order.live/1',updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='running' AND execution_fencing_token=$4`, [
        context.tenantId, context.taskId, publicResult, context.taskFence,
      ]);
      if (completed.rowCount !== 1) throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order task lost its publication fence', 409);
      await appendEvent(client, context.tenantId, context.taskId, 'business_task.completed', {
        cardHash: digest(expectedCard), publicResultHash: digest(publicResult),
      });
    });
  }

  private async settleFailedWorkOrder(
    client: pg.PoolClient,
    context: MutationContext,
    errorClass: z.infer<typeof gateA3WorkOrderTerminalErrorClassSchema>,
    failureCommandDigest: string,
  ): Promise<void> {
    const result = { kind: 'failed' as const, code: errorClass,
      message: '只读工单查询未能完成，请稍后重试。' };
    const failedStep = await client.query(`UPDATE business_task_steps SET status='failed',lease_until=NULL,updated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='running'
        AND attempt_id=$4 AND fencing_token=$5`, [context.tenantId, context.taskId, context.stepId,
      context.stepAttemptId, context.stepFence]);
    if (failedStep.rowCount !== 1) {
      throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order failure lost its step fence', 409);
    }
    await client.query(`UPDATE business_task_steps SET status='canceled',lease_until=NULL,updated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status='queued'`, [context.tenantId, context.taskId]);
    await client.query(`UPDATE gate_a3_connector_token_authorizations SET invalidated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [
      context.tenantId, context.taskId,
    ]);
    await client.query(`UPDATE gate_a3_connector_invocations SET status='failed',error_class=$3,
      terminal_at=now(),retry_scheduled=false,retry_not_before=NULL,
      redacted_audit=redacted_audit||jsonb_build_object('terminalErrorClass',$3::text,
        'failureCommandDigest',$4::text,'retryScheduled',false)
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [
      context.tenantId, context.taskId, errorClass, failureCommandDigest,
    ]);
    await client.query(`UPDATE gate_a3_model_invocations SET
      invalidated_at=CASE WHEN consumed_at IS NULL THEN now() ELSE invalidated_at END,
      status='failed',error_class=$3,terminal_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [
      context.tenantId, context.taskId, errorClass,
    ]);
    await this.finishDelivery(client, context, 'failed', errorClass);
    const failedTask = await client.query(`UPDATE business_tasks SET status='failed',terminal_error_class=$3,result=$4,
      result_record_variant='business-task-result.work-order.live/1',updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status='running' AND current_execution_attempt_id=$5
        AND execution_fencing_token=$6`, [context.tenantId, context.taskId, errorClass, result,
      context.executionAttemptId, context.taskFence]);
    if (failedTask.rowCount !== 1) {
      throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order failure lost its task fence', 409);
    }
    await appendEvent(client, context.tenantId, context.taskId, 'business_task.failed', { errorClass });
  }

  async checkpointWorkOrder(
    mutation: GateA3WorkOrderMutation,
    step: GateA3WorkOrderStepLease,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 250 || leaseDurationMs > 900_000) {
      throw new GenewayError('WORK_ORDER_LEASE_INVALID', 'Work Order step lease is invalid', 400);
    }
    return this.withTransaction(async (client) => {
      const context = await this.loadMutation(client, mutation, step.stepId, step);
      switch (step.stepId) {
        case 'validate_work_order_ref':
          return this.acceptValidatedRef(client, context, output, leaseDurationMs);
        case 'fetch_authorized_status':
          return this.acceptConnectorResult(client, context, output, leaseDurationMs);
        case 'compute_progress':
          return this.acceptProgress(client, context, output, leaseDurationMs);
        case 'explain_status':
          return this.acceptExplanation(client, context, output, leaseDurationMs);
        case 'evidence_verify':
          return this.verifyEvidence(client, context, output, leaseDurationMs);
        case 'publish_status_card':
          throw new GenewayError('WORK_ORDER_PROTOCOL_VIOLATION', 'Publish is accepted only by the terminal command', 409);
      }
    });
  }

  async consumeConnectorInvocationToken(
    invocationToken: string,
    gatewayRequestDigest: string,
  ): Promise<z.infer<typeof gateA3ConnectorCurrentAuthorityResponseSchema>> {
    let claims: GateA3ConnectorInvocationTokenClaims;
    try {
      const [encoded, supplied, extra] = invocationToken.split('.');
      if (encoded === undefined || supplied === undefined || extra !== undefined
        || !timingSafeSignatureMatches(supplied, createHmac('sha256', this.authority.connectorInvocationTokenSecret)
          .update(encoded, 'utf8').digest('base64url'))) throw new Error('signature');
      claims = gateA3ConnectorInvocationTokenClaimsSchema.parse(
        JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      );
    } catch {
      return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
        schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false,
      });
    }
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (claims.iat > nowSeconds + 5 || claims.exp < nowSeconds - 5 || Date.parse(claims.deadline) <= Date.now()) {
      return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
        schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false,
      });
    }
    return this.withTransaction(async (client) => {
      try {
        await this.assertAuthority(client, claims.tenantId, true);
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'NOT_OPEN') {
          return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
            schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false,
          });
        }
        throw error;
      }
      const selected = await client.query<{ canonical_spec: unknown; spec_hash: string; approval_status: string;
        approval_expires_at: Date; approval_subject: unknown; approval_digest: string; task_status: string;
        current_execution_attempt_id: string | null; execution_fencing_token: string; step_status: string;
        attempt_id: string | null; step_fence: string; invocation_status: string; consumed_at: Date | null;
        invalidated_at: Date | null; expires_at: Date; gate_a3_authority_digest: string | null }>(`SELECT spec.canonical_spec,spec.spec_hash,
          approval.status approval_status,approval.expires_at approval_expires_at,
          approval.subject approval_subject,approval.subject_digest approval_digest,task.status task_status,
          task.gate_a3_authority_digest,
          task.current_execution_attempt_id,task.execution_fencing_token::text,
          step.status step_status,step.attempt_id,step.fencing_token::text step_fence,
          invocation.status invocation_status,authz.consumed_at,authz.invalidated_at,
          authz.expires_at
        FROM gate_a3_connector_invocations invocation
        JOIN gate_a3_connector_token_authorizations authz ON authz.tenant_id=invocation.tenant_id
          AND authz.connector_invocation_id=invocation.id AND authz.jti_digest=invocation.jti_digest
        JOIN business_tasks task ON task.tenant_id=invocation.tenant_id AND task.id=invocation.business_task_id
        JOIN business_task_steps step ON step.tenant_id=task.tenant_id AND step.business_task_id=task.id
          AND step.step_id='fetch_authorized_status'
        JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=invocation.tenant_id
          AND spec.id=invocation.connector_query_spec_id
        JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
          AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
            AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
        WHERE invocation.tenant_id=$1 AND invocation.id=$2 AND invocation.jti_digest=$3
          AND invocation.business_task_id=$4 FOR UPDATE OF invocation,authz,task,step,approval`, [
        claims.tenantId, claims.connectorInvocationId, sha256(claims.jti), claims.taskId,
      ]);
      const row = selected.rows[0];
      const querySpec = row === undefined ? null : gateA3ConnectorQuerySpecSchema.safeParse(row.canonical_spec);
      const expectedRequestDigest = row === undefined ? null : digest({
        schemaVersion: 'gate-a3-connector-gateway-request/1', querySpec: row.canonical_spec,
        querySpecHash: row.spec_hash,
      });
      const active = row !== undefined && querySpec?.success === true
        && row.gate_a3_authority_digest === this.authority.envelope.authorityDigest
        && querySpec.data.releaseRecordId === RELEASE_INTERNAL_ID
        && querySpec.data.approvedPreflightDigest === this.authority.envelope.approvedPreflightDigest
        && expectedRequestDigest === gatewayRequestDigest && row.spec_hash === claims.connectorQuerySpecHash
        && row.approval_status === 'approved' && row.approval_expires_at.getTime() > Date.now()
        && digest(row.approval_subject) === row.approval_digest
        && (row.approval_subject as Readonly<Record<string, unknown>>).connectorQuerySpecHash === row.spec_hash
        && row.task_status === 'running' && row.step_status === 'running' && row.attempt_id === claims.attemptId
        && Number(row.step_fence) === claims.fence && row.invocation_status === 'authorized'
        && row.consumed_at === null && row.invalidated_at === null && row.expires_at.getTime() > Date.now();
      // The task and step fences are intentionally separate. Claims bind the
      // connector to the fetch step fence; invocation rows bind both values.
      const invocationAuthority = await client.query<{ execution_attempt_id: string; task_fence: string;
        step_fence: string }>(`SELECT execution_attempt_id,task_fence::text,step_fence::text
        FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND id=$2`, [claims.tenantId, claims.connectorInvocationId]);
      const authority = invocationAuthority.rows[0];
      const finalActive = active && authority?.execution_attempt_id === row?.current_execution_attempt_id
        && Number(authority.task_fence) === Number(row?.execution_fencing_token)
        && Number(authority.step_fence) === claims.fence;
      if (!finalActive) return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
        schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false,
      });
      const consumed = await client.query(`UPDATE gate_a3_connector_token_authorizations SET consumed_at=now()
        WHERE tenant_id=$1 AND jti_digest=$2 AND consumed_at IS NULL AND invalidated_at IS NULL
          AND expires_at>now()`, [claims.tenantId, sha256(claims.jti)]);
      const invocation = await client.query(`UPDATE gate_a3_connector_invocations SET status='running',started_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='authorized'`, [claims.tenantId, claims.connectorInvocationId]);
      if (consumed.rowCount !== 1 || invocation.rowCount !== 1) return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
        schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false,
      });
      return gateA3ConnectorCurrentAuthorityResponseSchema.parse({
        schemaVersion: 'gate-a3-connector-current-authority-response/1', active: true,
        checkedAt: new Date().toISOString(), tenantId: claims.tenantId, principal: claims.principal,
        taskId: claims.taskId, workflowVersionId: claims.workflowVersionId, workflowHash: claims.workflowHash,
        stepId: claims.stepId, attemptId: claims.attemptId, effectId: claims.effectId,
        connectorInvocationId: claims.connectorInvocationId, connectorQuerySpecHash: claims.connectorQuerySpecHash,
        connectorProfileVersion: claims.connectorProfileVersion, workOrderRefHash: claims.workOrderRefHash,
        fieldMaskVersion: claims.fieldMaskVersion, resourceContextDigest: claims.resourceContextDigest,
        deadline: claims.deadline, fence: claims.fence, jti: claims.jti,
      });
    });
  }

  async consumeModelInvocationToken(invocationToken: string): Promise<boolean> {
    let claims: z.infer<typeof gateA3WorkOrderModelTokenClaimsSchema>;
    try {
      const [encoded, supplied, extra] = invocationToken.split('.');
      if (encoded === undefined || supplied === undefined || extra !== undefined
        || !timingSafeSignatureMatches(supplied, createHmac('sha256', this.authority.modelInvocationTokenSecret)
          .update(encoded, 'utf8').digest('base64url'))) return false;
      claims = gateA3WorkOrderModelTokenClaimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      return false;
    }
    const now = Math.floor(Date.now() / 1_000);
    if (claims.iat > now + 5 || claims.exp < now - 5 || Date.parse(claims.deadline) <= Date.now()) return false;
    return this.withTransaction(async (client) => {
      try {
        await this.assertAuthority(client, claims.tenantId);
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'NOT_OPEN') return false;
        throw error;
      }
      let promptAuthority: Awaited<ReturnType<GateA3WorkOrderRepository['resolveWorkOrderPromptPolicy']>>;
      try {
        promptAuthority = await this.resolveWorkOrderPromptPolicy(client, claims.tenantId);
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'NOT_OPEN') return false;
        throw error;
      }
      const selected = await client.query<{ status: string; jti_digest: string; consumed_at: Date | null;
        invalidated_at: Date | null; expires_at: Date; connector_source_snapshot_id: string;
        workflow_version_id: string; workflow_hash: string; execution_attempt_id: string;
        step_attempt_id: string; task_fence: string; step_fence: string; input_digest: string;
        policy_version: string; prompt_policy_resolved_bytes_sha256: string;
        task_status: string; current_execution_attempt_id: string | null; execution_fencing_token: string;
        approval_status: string; approval_subject_digest: string; approval_subject: unknown;
        approval_expires_at: Date; spec_hash: string; payload_hash: string;
        audience: string; snapshot_payload: unknown; progress: unknown;
        gate_a3_authority_digest: string | null }>(`SELECT invocation.status,invocation.jti_digest,
          invocation.consumed_at,invocation.invalidated_at,invocation.expires_at,
          invocation.connector_source_snapshot_id,invocation.workflow_version_id,invocation.workflow_hash,
          invocation.execution_attempt_id,invocation.step_attempt_id,invocation.task_fence::text,
          invocation.step_fence::text,invocation.input_digest,invocation.policy_version,
          invocation.prompt_policy_resolved_bytes_sha256,task.status task_status,
          task.gate_a3_authority_digest,
          task.current_execution_attempt_id,task.execution_fencing_token::text,
          approval.status approval_status,approval.subject_digest approval_subject_digest,
          approval.subject approval_subject,approval.expires_at approval_expires_at,spec.spec_hash,
          snapshot.canonical_payload_hash payload_hash,snapshot.audience,snapshot.canonical_payload snapshot_payload,
          compute.output progress
        FROM gate_a3_model_invocations invocation
        JOIN business_tasks task ON task.tenant_id=invocation.tenant_id AND task.id=invocation.business_task_id
        JOIN business_task_steps explain ON explain.tenant_id=task.tenant_id AND explain.business_task_id=task.id
          AND explain.step_id='explain_status'
        JOIN business_task_steps compute ON compute.tenant_id=task.tenant_id AND compute.business_task_id=task.id
          AND compute.step_id='compute_progress'
        JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
          AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
            AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
        JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
        JOIN gate_a3_connector_source_snapshots snapshot ON snapshot.tenant_id=invocation.tenant_id
          AND snapshot.id=invocation.connector_source_snapshot_id
        WHERE invocation.tenant_id=$1 AND invocation.id=$2 AND task.id=$3
          AND explain.attempt_id=$4 AND explain.fencing_token=$5
        FOR UPDATE OF invocation,task,explain,approval`, [claims.tenantId, claims.modelInvocationId,
        claims.taskId, claims.stepAttemptId, claims.stepFence]);
      const row = selected.rows[0];
      const approvalPromptAuthority = z.object({
        promptPolicyVersionId: z.literal(PROMPT_POLICY_VERSION_ID),
        promptPolicyResolvedBytesSha256: z.string().regex(SHA256),
      }).passthrough().safeParse(row?.approval_subject);
      if (row === undefined || row.status !== 'authorized' || row.jti_digest !== sha256(claims.jti)
        || claims.promptPolicyVersionId !== promptAuthority.versionId
        || claims.promptPolicyResolvedBytesSha256 !== promptAuthority.resolvedBytesSha256
        || row.gate_a3_authority_digest !== this.authority.envelope.authorityDigest
        || row.consumed_at !== null || row.invalidated_at !== null || row.expires_at.getTime() <= Date.now()
        || row.task_status !== 'running' || row.current_execution_attempt_id !== claims.executionAttemptId
        || Number(row.execution_fencing_token) !== claims.taskFence || row.workflow_version_id !== claims.workflowVersionId
        || row.workflow_hash !== claims.workflowHash || row.execution_attempt_id !== claims.executionAttemptId
        || row.policy_version !== claims.promptPolicyVersionId
        || row.prompt_policy_resolved_bytes_sha256 !== claims.promptPolicyResolvedBytesSha256
        || row.step_attempt_id !== claims.stepAttemptId || Number(row.task_fence) !== claims.taskFence
        || Number(row.step_fence) !== claims.stepFence || row.approval_status !== 'approved'
        || row.approval_subject_digest !== claims.approvalSubjectDigest
        || digest(row.approval_subject) !== row.approval_subject_digest
        || !approvalPromptAuthority.success
        || approvalPromptAuthority.data.promptPolicyResolvedBytesSha256 !== claims.promptPolicyResolvedBytesSha256
        || row.approval_expires_at.getTime() <= Date.now() || row.spec_hash !== claims.connectorQuerySpecHash
        || row.connector_source_snapshot_id !== claims.connectorSourceSnapshotId
        || row.payload_hash !== claims.snapshotPayloadHash || row.audience !== claims.snapshotAudience
        || digest(row.snapshot_payload) !== claims.snapshotPayloadHash
        || digest(row.progress) !== claims.progressDigest
        || row.input_digest !== digest({ snapshot: row.snapshot_payload, progress: row.progress })) return false;
      try {
        await this.revalidateConnectorEvidence(client, {
          tenantId: claims.tenantId, taskId: claims.taskId, principalId: claims.principalId,
          snapshotId: claims.connectorSourceSnapshotId,
        });
      } catch (error) {
        if (error instanceof GenewayError
          && ['EVIDENCE_SOURCE_REVOKED', 'EVIDENCE_AUTHORITY_INVALID', 'EVIDENCE_INTEGRITY_FAILED',
            'EVIDENCE_INCOMPLETE'].includes(error.code)) return false;
        throw error;
      }
      const updated = await client.query(`UPDATE gate_a3_model_invocations SET status='running',consumed_at=now(),started_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='authorized' AND consumed_at IS NULL AND invalidated_at IS NULL
          AND expires_at>now()`, [claims.tenantId, claims.modelInvocationId]);
      return updated.rowCount === 1;
    });
  }

  private async acceptValidatedRef(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const validated = z.object({ schemaVersion: z.literal('work-order.ref/1'),
      workOrderRef: z.string().min(1).max(128) }).strict().parse(output);
    if (validated.workOrderRef !== context.querySpec.workOrderRef
      || sha256(validated.workOrderRef) !== context.workOrderRefHash) {
      throw new GenewayError('WORK_ORDER_REF_INVALID', 'Work Order reference changed before connector authorization', 409);
    }
    const fetchStep = await this.completeAndStartStep(client, context, validated,
      'fetch_authorized_status', leaseDurationMs);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const deadlineSeconds = Math.floor(context.deadline.getTime() / 1_000);
    const exp = Math.min(nowSeconds + 60, deadlineSeconds);
    if (exp <= nowSeconds) throw new GenewayError('CONNECTOR_AUTHORITY_STALE', 'Connector deadline has expired', 409);
    const connectorInvocationId = randomUUID();
    const effectId = stableEffectId(context.taskId, context.connectorQuerySpecHash, 'fetch_authorized_status');
    const jti = randomUUID();
    const claims = gateA3ConnectorInvocationTokenClaimsSchema.parse({
      schemaVersion: 'connector-invocation-token/1', iss: 'geneway-control-plane',
      aud: 'gearjob-work-order-status-connector', tenantId: context.tenantId, principal: context.principalId,
      taskId: context.taskId, workflowVersionId: context.workflowVersionId, workflowHash: context.workflowHash,
      stepId: 'fetch_authorized_status', attemptId: fetchStep.stepAttemptId, effectId, connectorInvocationId,
      connectorQuerySpecHash: context.connectorQuerySpecHash,
      connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION, workOrderRefHash: context.workOrderRefHash,
      fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION, resourceContextDigest: context.resourceContextDigest,
      deadline: iso(context.deadline), fence: fetchStep.stepFence, jti, iat: nowSeconds, exp,
    });
    const connectorBudget = await client.query<{ count: string }>(`SELECT count(*)::text count
      FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND business_task_id=$2`, [
      context.tenantId, context.taskId,
    ]);
    if (Number(connectorBudget.rows[0]?.count) >= context.querySpec.budget.maxAttempts) {
      throw new GenewayError('CONNECTOR_RETRY_BUDGET_EXHAUSTED', 'Connector retry budget is exhausted', 409);
    }
    await client.query(`INSERT INTO gate_a3_connector_invocations
      (tenant_id,id,business_task_id,connector_query_spec_id,connector_query_spec_hash,
       connector_profile_version,work_order_ref_hash,field_mask_version,principal_id,resource_context_digest,
       workflow_version_id,workflow_hash,step_id,execution_attempt_id,step_attempt_id,effect_id,
       task_fence,step_fence,jti_digest,deadline,status,redacted_audit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'fetch_authorized_status',$13,$14,$15,
        $16,$17,$18,$19,'authorized',$20)`, [context.tenantId, connectorInvocationId, context.taskId,
      context.connectorQuerySpecId, context.connectorQuerySpecHash, GATE_A3_CONNECTOR_PROFILE_VERSION,
      context.workOrderRefHash, GATE_A3_FIELD_MASK_VERSION, context.principalId, context.resourceContextDigest,
      context.workflowVersionId, context.workflowHash, context.executionAttemptId, fetchStep.stepAttemptId,
      effectId, context.taskFence, fetchStep.stepFence, sha256(jti), context.deadline,
      { connectorQuerySpecHash: context.connectorQuerySpecHash, workOrderRefHash: context.workOrderRefHash,
        connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION, fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION },
    ]);
    await client.query(`INSERT INTO gate_a3_connector_token_authorizations
      (tenant_id,jti_digest,connector_invocation_id,business_task_id,expires_at)
      VALUES ($1,$2,$3,$4,to_timestamp($5))`, [context.tenantId, sha256(jti), connectorInvocationId,
      context.taskId, exp]);
    return {
      step: fetchStep,
      connectorRequest: gateA3ConnectorGatewayRequestSchema.parse({
        schemaVersion: 'gate-a3-connector-gateway-request/1',
        invocationToken: encodeToken(claims, this.authority.connectorInvocationTokenSecret),
        querySpec: context.querySpec, querySpecHash: context.connectorQuerySpecHash,
      }),
    };
  }

  private async acceptConnectorResult(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const result = z.object({ response: gateA3ConnectorWorkOrderResponseSchema,
      receipt: gateA3ConnectorGatewayReceiptSchema }).strict().parse(output);
    const receipt = result.receipt.payload;
    if (!verifySignedPayload(receipt, result.receipt.signature, this.authority.connectorGatewayReceiptSecret)
      || receipt.outcome !== 'completed' || receipt.tenantId !== context.tenantId
      || receipt.principal !== context.principalId || receipt.taskId !== context.taskId
      || receipt.workflowVersionId !== context.workflowVersionId || receipt.workflowHash !== context.workflowHash
      || receipt.stepId !== context.stepId || receipt.attemptId !== context.stepAttemptId
      || receipt.fence !== context.stepFence || receipt.connectorQuerySpecHash !== context.connectorQuerySpecHash
      || receipt.connectorProfileVersion !== GATE_A3_CONNECTOR_PROFILE_VERSION
      || receipt.workOrderRefHash !== context.workOrderRefHash
      || receipt.fieldMaskVersion !== GATE_A3_FIELD_MASK_VERSION
      || receipt.resourceContextDigest !== context.resourceContextDigest
      || receipt.deadline !== iso(context.deadline) || receipt.responseRefMatched !== true
      || receipt.responseCanonicalHash !== digest(result.response)
      || result.response.workOrderRef !== context.querySpec.workOrderRef
      || result.response.sourceRevision !== receipt.sourceRevision) {
      throw new GenewayError('CONNECTOR_PROTOCOL_VIOLATION', 'Connector receipt does not match current authority', 409);
    }
    const invocation = await client.query<{ id: string; effect_id: string; jti_digest: string }>(`SELECT id,effect_id,jti_digest
      FROM gate_a3_connector_invocations WHERE tenant_id=$1 AND id=$2 AND business_task_id=$3
        AND execution_attempt_id=$4 AND step_attempt_id=$5 AND task_fence=$6 AND step_fence=$7
        AND status='running' FOR UPDATE`, [context.tenantId, receipt.connectorInvocationId, context.taskId,
      context.executionAttemptId, context.stepAttemptId, context.taskFence, context.stepFence]);
    const invocationRow = invocation.rows[0];
    if (invocationRow === undefined || invocationRow.effect_id !== receipt.effectId
      || sha256(receipt.jti) !== invocationRow.jti_digest) {
      throw new GenewayError('CONNECTOR_AUTHORITY_STALE', 'Connector invocation is not current', 409);
    }
    const existing = await client.query<{ id: string; connector_invocation_id: string; step_attempt_id: string;
      step_fence: string; canonical_payload: unknown; canonical_payload_hash: string; source_revision: string;
      created_at: Date }>(`SELECT id,connector_invocation_id,step_attempt_id,step_fence::text,
        canonical_payload,canonical_payload_hash,source_revision,created_at
      FROM gate_a3_connector_source_snapshots WHERE tenant_id=$1 AND business_task_id=$2 AND effect_id=$3`, [
      context.tenantId, context.taskId, receipt.effectId,
    ]);
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      const existingPayload = gateA3ConnectorWorkOrderResponseSchema.parse(existingRow.canonical_payload);
      if (existingRow.canonical_payload_hash !== digest(result.response)
        || digest(existingPayload) !== existingRow.canonical_payload_hash) {
        throw new GenewayError('CONNECTOR_RETRY_DRIFT', 'Connector retry response differs from the accepted snapshot', 409);
      }
      await client.query(`UPDATE gate_a3_connector_invocations SET status='completed',response_ref_matched=true,
        source_revision=$3,response_canonical_hash=$4,terminal_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='running'`, [context.tenantId, receipt.connectorInvocationId,
        result.response.sourceRevision, existingRow.canonical_payload_hash]);
      const computeStep = await this.completeAndStartStep(client, context,
        { connectorSourceSnapshotId: existingRow.id,
          canonicalAllowlistedPayloadHash: existingRow.canonical_payload_hash, reused: true },
        'compute_progress', leaseDurationMs);
      return { step: computeStep, reused: true, sourceSnapshot: gateA3ConnectorSourceSnapshotSchema.parse({
        schemaVersion: 'connector-source-snapshot/1', canonicalizationVersion: 'RFC8785/JCS-1',
        connectorSourceSnapshotId: existingRow.id, tenantId: context.tenantId, principal: context.principalId,
        taskId: context.taskId, connectorInvocationId: existingRow.connector_invocation_id,
        effectId: receipt.effectId, attemptId: existingRow.step_attempt_id, fence: Number(existingRow.step_fence),
        connectorQuerySpecHash: context.connectorQuerySpecHash, workOrderRefHash: context.workOrderRefHash,
        responseRefMatched: true, fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
        sourceRevision: existingRow.source_revision, sourceAsOf: existingPayload.updatedAt,
        canonicalAllowlistedPayload: existingPayload,
        canonicalAllowlistedPayloadHash: existingRow.canonical_payload_hash, resourceScope: RESOURCE_SCOPE,
        dataClass: 'C1', audience: { tenantId: context.tenantId, principal: context.principalId },
        createdAt: iso(existingRow.created_at),
      }) };
    }
    const snapshotId = id('connector_snapshot');
    const payloadHash = digest(result.response);
    const createdAt = new Date();
    const snapshot = gateA3ConnectorSourceSnapshotSchema.parse({
      schemaVersion: 'connector-source-snapshot/1', canonicalizationVersion: 'RFC8785/JCS-1',
      connectorSourceSnapshotId: snapshotId, tenantId: context.tenantId, principal: context.principalId,
      taskId: context.taskId, connectorInvocationId: receipt.connectorInvocationId, effectId: receipt.effectId,
      attemptId: context.stepAttemptId, fence: context.stepFence,
      connectorQuerySpecHash: context.connectorQuerySpecHash, workOrderRefHash: context.workOrderRefHash,
      responseRefMatched: true, fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
      sourceRevision: result.response.sourceRevision, sourceAsOf: result.response.updatedAt,
      canonicalAllowlistedPayload: result.response, canonicalAllowlistedPayloadHash: payloadHash,
      resourceScope: RESOURCE_SCOPE, dataClass: 'C1',
      audience: { tenantId: context.tenantId, principal: context.principalId }, createdAt: iso(createdAt),
    });
    await client.query(`UPDATE gate_a3_connector_invocations SET status='completed',response_ref_matched=true,
      source_revision=$3,response_canonical_hash=$4,terminal_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status='running'`, [context.tenantId, receipt.connectorInvocationId,
      result.response.sourceRevision, payloadHash]);
    await client.query(`INSERT INTO gate_a3_connector_source_snapshots
      (tenant_id,id,business_task_id,connector_invocation_id,connector_query_spec_id,
       connector_query_spec_hash,execution_attempt_id,step_attempt_id,effect_id,task_fence,step_fence,
       work_order_ref_hash,response_ref_matched,field_mask_version,source_revision,source_as_of,
       canonical_payload,canonical_payload_hash,resource_scope,data_class,audience,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18,'C1',$19,$20)`, [
      context.tenantId, snapshotId, context.taskId, receipt.connectorInvocationId, context.connectorQuerySpecId,
      context.connectorQuerySpecHash, context.executionAttemptId, context.stepAttemptId, receipt.effectId,
      context.taskFence, context.stepFence, context.workOrderRefHash, GATE_A3_FIELD_MASK_VERSION,
      result.response.sourceRevision, result.response.updatedAt, result.response, payloadHash, RESOURCE_SCOPE,
      `principal:${context.principalId}`, createdAt,
    ]);
    await client.query(`INSERT INTO gate_a3_connector_evidence
      (tenant_id,id,business_task_id,connector_source_snapshot_id,connector_invocation_id,effect_id,
       connector_query_spec_hash,canonical_payload_hash,work_order_ref_hash,field_mask_version,
       source_revision,source_as_of,locator_kind,field_name,canonical_field,canonical_field_hash,
       resource_scope,data_class,audience,accessible)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'connector_snapshot_whole',NULL,NULL,NULL,
        $13,'C1',$14,true)`, [context.tenantId, id('evidence'), context.taskId, snapshotId,
      receipt.connectorInvocationId, receipt.effectId, context.connectorQuerySpecHash, payloadHash,
      context.workOrderRefHash, GATE_A3_FIELD_MASK_VERSION, result.response.sourceRevision,
      result.response.updatedAt, RESOURCE_SCOPE, `principal:${context.principalId}`]);
    for (const fieldName of GATE_A3_WORK_ORDER_FIELD_MASK) {
      const field = canonicalEvidenceField(result.response, fieldName);
      await client.query(`INSERT INTO gate_a3_connector_evidence
        (tenant_id,id,business_task_id,connector_source_snapshot_id,connector_invocation_id,effect_id,
         connector_query_spec_hash,canonical_payload_hash,work_order_ref_hash,field_mask_version,
         source_revision,source_as_of,locator_kind,field_name,canonical_field,canonical_field_hash,
         resource_scope,data_class,audience,accessible)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'connector_snapshot_field',$13,$14,$15,
          $16,'C1',$17,true)`, [context.tenantId, id('evidence'), context.taskId, snapshotId,
        receipt.connectorInvocationId, receipt.effectId, context.connectorQuerySpecHash, payloadHash,
        context.workOrderRefHash, GATE_A3_FIELD_MASK_VERSION, result.response.sourceRevision,
        result.response.updatedAt, fieldName, field, digest(field), RESOURCE_SCOPE,
        `principal:${context.principalId}`]);
    }
    const computeStep = await this.completeAndStartStep(client, context,
      { connectorSourceSnapshotId: snapshotId, canonicalAllowlistedPayloadHash: payloadHash },
      'compute_progress', leaseDurationMs);
    return { step: computeStep, reused: false, sourceSnapshot: snapshot };
  }

  private async acceptProgress(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const progress = gateA3WorkOrderProgressSchema.parse(output);
    const selected = await client.query<{ id: string }>(`SELECT id
      FROM gate_a3_connector_source_snapshots WHERE tenant_id=$1 AND business_task_id=$2`, [
      context.tenantId, context.taskId,
    ]);
    const row = selected.rows[0];
    if (row === undefined) throw new GenewayError('CONNECTOR_SNAPSHOT_MISSING', 'Accepted connector snapshot is missing', 409);
    const evidenceAuthority = await this.revalidateConnectorEvidence(client, {
      tenantId: context.tenantId, taskId: context.taskId, principalId: context.principalId,
      snapshotId: row.id,
    });
    const payload = evidenceAuthority.payload;
    const expected = this.computeProgress(payload);
    if (digest(progress) !== digest(expected)) {
      throw new GenewayError('WORK_ORDER_PROGRESS_INVALID', 'Progress does not match the immutable connector snapshot', 409);
    }
    const explainStep = await this.completeAndStartStep(client, context, progress, 'explain_status', leaseDurationMs);
    const snapshot = evidenceAuthority.snapshot;
    const accepted = await client.query<{ id: string; explanation: unknown; explanation_hash: string;
      connector_source_snapshot_id: string }>(`SELECT id,explanation,explanation_hash,connector_source_snapshot_id
      FROM gate_a3_work_order_explanations WHERE tenant_id=$1 AND business_task_id=$2 FOR SHARE`, [
      context.tenantId, context.taskId,
    ]);
    const acceptedRow = accepted.rows[0];
    if (acceptedRow !== undefined) {
      const acceptedExplanation = gateA3WorkOrderExplanationSchema.parse(acceptedRow.explanation);
      if (acceptedRow.connector_source_snapshot_id !== row.id
        || digest(acceptedExplanation) !== acceptedRow.explanation_hash) {
        throw new GenewayError('WORK_ORDER_EXPLANATION_INVALID', 'Accepted explanation authority drifted', 409);
      }
      const evidenceStep = await this.completeAndStartStep(client, {
        ...context, stepId: explainStep.stepId, stepAttemptId: explainStep.stepAttemptId,
        stepFence: explainStep.stepFence,
      }, { explanationId: acceptedRow.id, explanationHash: acceptedRow.explanation_hash, reused: true },
      'evidence_verify', leaseDurationMs);
      return { step: evidenceStep, acceptedExplanation };
    }
    const effectId = stableEffectId(context.taskId, context.connectorQuerySpecHash, 'explain_status');
    const previousInvocation = await client.query<{ id: string; status: string; error_class: string | null;
      receipt: unknown; consumed_at: Date | null }>(`SELECT id,status,error_class,receipt,consumed_at
      FROM gate_a3_model_invocations
      WHERE tenant_id=$1 AND business_task_id=$2 FOR UPDATE`, [context.tenantId, context.taskId]);
    if (previousInvocation.rows.some((invocation) => invocation.status !== 'failed'
      || invocation.error_class !== 'LEASE_EXPIRED' || invocation.receipt !== null
      || invocation.consumed_at !== null)) {
      throw new GenewayError('MODEL_RETRY_BUDGET_EXHAUSTED', 'Model invocation budget is exhausted', 409);
    }
    const modelInvocationId = id('model_invocation');
    const jti = randomUUID();
    const iat = Math.floor(Date.now() / 1_000);
    const exp = Math.min(iat + 60, Math.floor(context.deadline.getTime() / 1_000));
    if (exp <= iat) throw new GenewayError('MODEL_AUTHORITY_STALE', 'Model deadline has expired', 409);
    const promptAuthority = await this.resolveWorkOrderPromptPolicy(client, context.tenantId);
    const authority = {
      tenantId: context.tenantId, principalId: context.principalId, taskId: context.taskId,
      workflowVersionId: context.workflowVersionId, workflowHash: context.workflowHash,
      executionAttemptId: context.executionAttemptId, taskFence: context.taskFence,
      stepId: 'explain_status' as const, stepAttemptId: explainStep.stepAttemptId,
      stepFence: explainStep.stepFence, modelInvocationId, approvalSubjectDigest: context.approvalSubjectDigest,
      capabilityVersionId: CAPABILITY_VERSION_ID, effectId, connectorQuerySpecHash: context.connectorQuerySpecHash,
      connectorSourceSnapshotId: row.id, connectorSourceSnapshotHash: digest(snapshot),
      snapshotPayloadHash: snapshot.canonicalAllowlistedPayloadHash, progressDigest: digest(progress),
      resourceScope: RESOURCE_SCOPE, snapshotAudience: `principal:${context.principalId}`,
      logicalModelPolicy: 'business.production.work-order-status.explanation' as const,
      promptPolicyVersionId: promptAuthority.versionId,
      promptPolicyResolvedBytesSha256: promptAuthority.resolvedBytesSha256,
      routeProfile: 'codex_subscription_dev' as const,
      dataClass: 'C1' as const, toolChoice: 'none' as const, outputSchemaVersion: 'work-order.explanation/1' as const,
      maxOutputTokens: 1_024, deadline: iso(context.deadline),
    };
    const tokenClaims = gateA3WorkOrderModelTokenClaimsSchema.parse({
      schemaVersion: 'gate-a3-work-order-model-token/2', iss: 'geneway-control-plane',
      aud: 'local-model-gateway-work-order-explanation', ...authority, jti, iat, exp,
    });
    const modelRequest = gateA3WorkOrderModelRequestSchema.parse({
      schemaVersion: 'gate-a3-work-order-model-request/2',
      invocationToken: encodeToken(tokenClaims, this.authority.modelInvocationTokenSecret),
      ...authority, systemPrompt: promptAuthority.systemPrompt, snapshot: payload, progress,
    });
    const invocationValues = [context.tenantId, modelInvocationId, context.taskId, row.id,
      context.workflowVersionId, context.workflowHash, context.executionAttemptId, explainStep.stepAttemptId,
      effectId, context.taskFence, explainStep.stepFence, digest({ snapshot: payload, progress }),
      promptAuthority.versionId, promptAuthority.resolvedBytesSha256, sha256(jti), exp];
    await client.query(`INSERT INTO gate_a3_model_invocations
      (tenant_id,id,business_task_id,connector_source_snapshot_id,workflow_version_id,workflow_hash,
       step_id,execution_attempt_id,step_attempt_id,effect_id,task_fence,step_fence,input_digest,policy_version,
       prompt_policy_resolved_bytes_sha256,jti_digest,expires_at,status)
      VALUES ($1,$2,$3,$4,$5,$6,'explain_status',$7,$8,$9,$10,$11,$12,$13,$14,$15,to_timestamp($16),'authorized')`,
    invocationValues);
    return { step: explainStep, modelRequest };
  }

  private async acceptExplanation(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const result = z.object({ output: gateA3WorkOrderExplanationSchema,
      receipt: gateA3WorkOrderModelReceiptSchema }).strict().parse(output);
    const selected = await client.query<{ model_invocation_id: string; effect_id: string;
      connector_source_snapshot_id: string; receipt_status: string; canonical_payload: unknown;
      canonical_payload_hash: string; connector_invocation_id: string; snapshot_effect_id: string;
      snapshot_step_attempt_id: string; snapshot_step_fence: string; source_revision: string;
      created_at: Date; audience: string; progress: unknown; policy_version: string;
      prompt_policy_resolved_bytes_sha256: string }>(`SELECT invocation.id model_invocation_id,
        invocation.effect_id,invocation.connector_source_snapshot_id,invocation.status receipt_status,
        invocation.policy_version,invocation.prompt_policy_resolved_bytes_sha256,
        snapshot.canonical_payload,snapshot.canonical_payload_hash,snapshot.connector_invocation_id,
        snapshot.effect_id snapshot_effect_id,snapshot.step_attempt_id snapshot_step_attempt_id,
        snapshot.step_fence::text snapshot_step_fence,snapshot.source_revision,snapshot.created_at,
        snapshot.audience,compute.output progress
      FROM gate_a3_model_invocations invocation
      JOIN gate_a3_connector_source_snapshots snapshot ON snapshot.tenant_id=invocation.tenant_id
        AND snapshot.id=invocation.connector_source_snapshot_id
      JOIN business_task_steps compute ON compute.tenant_id=invocation.tenant_id
        AND compute.business_task_id=invocation.business_task_id AND compute.step_id='compute_progress'
      WHERE invocation.tenant_id=$1 AND invocation.business_task_id=$2
        AND invocation.execution_attempt_id=$3 AND invocation.step_attempt_id=$4
        AND invocation.task_fence=$5 AND invocation.step_fence=$6 FOR UPDATE OF invocation`, [
      context.tenantId, context.taskId, context.executionAttemptId, context.stepAttemptId,
      context.taskFence, context.stepFence,
    ]);
    const row = selected.rows[0];
    if (row === undefined || row.receipt_status !== 'running') {
      throw new GenewayError('MODEL_AUTHORITY_STALE', 'Model invocation is not current', 409);
    }
    const evidenceAuthority = await this.revalidateConnectorEvidence(client, {
      tenantId: context.tenantId, taskId: context.taskId, principalId: context.principalId,
      snapshotId: row.connector_source_snapshot_id,
    });
    const progress = gateA3WorkOrderProgressSchema.parse(row.progress);
    const snapshot = evidenceAuthority.snapshot;
    const promptAuthority = await this.resolveWorkOrderPromptPolicy(client, context.tenantId);
    const expectedAuthority = {
      tenantId: context.tenantId, principalId: context.principalId, taskId: context.taskId,
      workflowVersionId: context.workflowVersionId, workflowHash: context.workflowHash,
      executionAttemptId: context.executionAttemptId, taskFence: context.taskFence,
      stepId: 'explain_status', stepAttemptId: context.stepAttemptId, stepFence: context.stepFence,
      modelInvocationId: row.model_invocation_id, approvalSubjectDigest: context.approvalSubjectDigest,
      capabilityVersionId: CAPABILITY_VERSION_ID, effectId: row.effect_id,
      connectorQuerySpecHash: context.connectorQuerySpecHash,
      connectorSourceSnapshotId: row.connector_source_snapshot_id, connectorSourceSnapshotHash: digest(snapshot),
      snapshotPayloadHash: snapshot.canonicalAllowlistedPayloadHash, progressDigest: digest(progress),
      resourceScope: RESOURCE_SCOPE, snapshotAudience: `principal:${context.principalId}`,
      logicalModelPolicy: 'business.production.work-order-status.explanation',
      promptPolicyVersionId: promptAuthority.versionId,
      promptPolicyResolvedBytesSha256: promptAuthority.resolvedBytesSha256,
      routeProfile: 'codex_subscription_dev',
      dataClass: 'C1', toolChoice: 'none', outputSchemaVersion: 'work-order.explanation/1',
      maxOutputTokens: 1_024, deadline: iso(context.deadline),
    } as const;
    const receipt = result.receipt.payload;
    if (!verifySignedPayload(receipt, result.receipt.signature, this.authority.modelGatewayReceiptSecret)
      || row.policy_version !== promptAuthority.versionId
      || row.prompt_policy_resolved_bytes_sha256 !== promptAuthority.resolvedBytesSha256
      || receipt.outcome !== 'completed' || receipt.outputPayloadDigest !== digest(result.output)
      || Object.entries(expectedAuthority).some(([key, value]) =>
        receipt[key as keyof typeof receipt] !== value)) {
      throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model receipt does not match current Work Order authority', 409);
    }
    await client.query(`UPDATE gate_a3_model_invocations SET status='completed',receipt=$3,
      receipt_digest=$4,terminal_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'`, [
      context.tenantId, row.model_invocation_id, result.receipt, digest(result.receipt),
    ]);
    const existingExplanation = await client.query<{ id: string; explanation_hash: string }>(`SELECT id,explanation_hash
      FROM gate_a3_work_order_explanations WHERE tenant_id=$1 AND business_task_id=$2`, [
      context.tenantId, context.taskId,
    ]);
    const existingExplanationRow = existingExplanation.rows[0];
    if (existingExplanationRow !== undefined && existingExplanationRow.explanation_hash !== digest(result.output)) {
      throw new GenewayError('MODEL_RETRY_DRIFT', 'Model retry differs from the accepted explanation', 409);
    }
    const explanationId = existingExplanationRow?.id ?? id('work_order_explanation');
    if (existingExplanationRow === undefined) {
      await client.query(`INSERT INTO gate_a3_work_order_explanations
        (tenant_id,id,business_task_id,model_invocation_id,connector_source_snapshot_id,
         schema_version,explanation,explanation_hash)
        VALUES ($1,$2,$3,$4,$5,'work-order.explanation/1',$6,$7)`, [context.tenantId,
        explanationId, context.taskId, row.model_invocation_id, row.connector_source_snapshot_id,
        result.output, digest(result.output)]);
    }
    const evidenceStep = await this.completeAndStartStep(client, context,
      { explanationId, explanationHash: digest(result.output) }, 'evidence_verify', leaseDurationMs);
    return { step: evidenceStep };
  }

  private async verifyEvidence(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    leaseDurationMs: number,
  ): Promise<unknown> {
    const requested = z.object({ explanation: gateA3WorkOrderExplanationSchema }).strict().parse(output);
    const explanation = await client.query<{ id: string; explanation: unknown; explanation_hash: string;
      connector_source_snapshot_id: string }>(`SELECT id,explanation,explanation_hash,connector_source_snapshot_id
      FROM gate_a3_work_order_explanations WHERE tenant_id=$1 AND business_task_id=$2`, [
      context.tenantId, context.taskId,
    ]);
    const explanationRow = explanation.rows[0];
    if (explanationRow === undefined || digest(requested.explanation) !== explanationRow.explanation_hash
      || digest(explanationRow.explanation) !== explanationRow.explanation_hash) {
      throw new GenewayError('WORK_ORDER_EXPLANATION_INVALID', 'Explanation does not match the accepted model output', 409);
    }
    const evidenceAuthority = await this.revalidateConnectorEvidence(client, {
      tenantId: context.tenantId, taskId: context.taskId, principalId: context.principalId,
      snapshotId: explanationRow.connector_source_snapshot_id,
    });
    const fieldEvidence = new Map(Array.from(evidenceAuthority.fields.entries(),
      ([fieldName, field]) => [fieldName, field.id]));
    for (const statement of requested.explanation.statements) {
      for (const sourceField of statement.sourceFields) {
        if (sourceField !== 'progressPct' && !fieldEvidence.has(sourceField)) {
          throw new GenewayError('EXPLANATION_SOURCE_INVALID', 'Explanation references unavailable connector evidence', 409);
        }
        if (sourceField === 'progressPct') {
          if (!statement.sourceFields.includes('planQty') || !statement.sourceFields.includes('completedQty')
            || !fieldEvidence.has('planQty') || !fieldEvidence.has('completedQty')) {
            throw new GenewayError('EXPLANATION_SOURCE_INVALID',
              'Progress explanation must retain plan and completed quantity Evidence', 409);
          }
          const progress = await client.query<{ output: unknown }>(`SELECT output FROM business_task_steps
            WHERE tenant_id=$1 AND business_task_id=$2 AND step_id='compute_progress' AND status='completed'`, [
            context.tenantId, context.taskId,
          ]);
          gateA3WorkOrderProgressSchema.parse(progress.rows[0]?.output);
        }
      }
    }
    const evidenceRefs = gateA3WorkOrderStatusCardSchema.shape.evidenceRefs.parse({
      status: fieldEvidence.get('status'), planQty: fieldEvidence.get('planQty'),
      completedQty: fieldEvidence.get('completedQty'), updatedAt: fieldEvidence.get('updatedAt'),
      sourceAsOf: fieldEvidence.get('updatedAt'),
    });
    const publishStep = await this.completeAndStartStep(client, context,
      { explanationHash: explanationRow.explanation_hash, evidenceRefs }, 'publish_status_card', leaseDurationMs);
    return { step: publishStep, verifiedExplanation: gateA3WorkOrderExplanationSchema.parse(explanationRow.explanation),
      evidenceRefs };
  }

  private async loadMutation(
    client: pg.PoolClient,
    mutation: GateA3WorkOrderMutation,
    expectedStepId: GateA3WorkOrderStepLease['stepId'],
    step?: GateA3WorkOrderStepLease,
  ): Promise<MutationContext> {
    await this.assertAuthority(client, mutation.tenantId);
    const selected = await client.query<{
      tenant_id: string; requester_id: string; status: string; workflow_version_id: string; workflow_hash: string;
      current_execution_attempt_id: string | null; execution_fencing_token: string;
      approval_subject_digest: string; approval_subject: unknown; approval_status: string;
      approval_expires_at: Date; spec_id: string; spec_hash: string; canonical_spec: unknown;
      work_order_ref_hash: string; resource_context_digest: string; deadline: Date;
      step_id: GateA3WorkOrderStepLease['stepId']; step_status: string; step_attempt_id: string | null;
      step_fence: string; lease_until: Date | null;
      gate_a3_authority_digest: string | null;
    }>(`SELECT task.tenant_id,task.requester_id,task.status,task.workflow_version_id,task.workflow_hash,
        task.current_execution_attempt_id,task.execution_fencing_token::text,task.gate_a3_authority_digest,
        approval.subject_digest approval_subject_digest,approval.subject approval_subject,
        approval.status approval_status,approval.expires_at approval_expires_at,
        spec.id spec_id,spec.spec_hash,spec.canonical_spec,spec.work_order_ref_hash,
        spec.resource_context_digest,spec.deadline,step.step_id,step.status step_status,
        step.attempt_id step_attempt_id,step.fencing_token::text step_fence,step.lease_until
      FROM business_tasks task
      JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
        AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
          AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
      JOIN business_task_steps step ON step.tenant_id=task.tenant_id AND step.business_task_id=task.id
        AND step.step_id=$6
      WHERE task.id=$1 AND task.workflow_version_id=$2 AND task.workflow_hash=$3
        AND task.current_execution_attempt_id=$4 AND task.execution_fencing_token=$5
        AND task.tenant_id=$7 AND task.record_variant='business-task.work-order.live/1'
      FOR UPDATE OF task,approval,step`, [mutation.taskId, mutation.workflowVersionId,
      mutation.workflowHash, mutation.executionAttemptId, mutation.taskFence, expectedStepId, mutation.tenantId]);
    const row = selected.rows[0];
    if (row === undefined || row.status !== 'running' || row.approval_status !== 'approved'
      || row.approval_expires_at.getTime() <= Date.now() || row.deadline.getTime() <= Date.now()
      || row.gate_a3_authority_digest !== this.authority.envelope.authorityDigest
      || digest(row.approval_subject) !== row.approval_subject_digest
      || (row.approval_subject as Readonly<Record<string, unknown>>).connectorQuerySpecHash !== row.spec_hash
      || row.step_status !== 'running' || row.step_attempt_id === null || row.lease_until === null
      || row.lease_until.getTime() <= Date.now()) {
      throw new GenewayError('WORK_ORDER_AUTHORITY_STALE', 'Work Order execution authority is not current', 409);
    }
    if (step !== undefined && (step.stepAttemptId !== row.step_attempt_id
      || step.stepFence !== Number(row.step_fence))) {
      throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order step attempt is stale', 409);
    }
    const querySpec = gateA3ConnectorQuerySpecSchema.parse(row.canonical_spec);
    if (digest(querySpec) !== row.spec_hash || querySpec.principal !== row.requester_id
      || querySpec.releaseRecordId !== RELEASE_INTERNAL_ID
      || querySpec.approvedPreflightDigest !== this.authority.envelope.approvedPreflightDigest
      || querySpec.workflowVersionId !== row.workflow_version_id || querySpec.workflowHash !== row.workflow_hash
      || querySpec.resourceContextDigest !== row.resource_context_digest || querySpec.deadline !== iso(row.deadline)) {
      throw new GenewayError('CONNECTOR_AUTHORITY_STALE', 'Immutable ConnectorQuerySpec does not match task authority', 409);
    }
    return {
      tenantId: row.tenant_id, principalId: row.requester_id, taskId: mutation.taskId,
      workflowVersionId: row.workflow_version_id, workflowHash: row.workflow_hash,
      executionAttemptId: mutation.executionAttemptId, taskFence: mutation.taskFence,
      approvalSubjectDigest: row.approval_subject_digest, approvalExpiresAt: row.approval_expires_at,
      connectorQuerySpecId: row.spec_id, connectorQuerySpecHash: row.spec_hash, querySpec,
      workOrderRefHash: row.work_order_ref_hash, resourceContextDigest: row.resource_context_digest,
      deadline: row.deadline, stepId: row.step_id, stepAttemptId: row.step_attempt_id,
      stepFence: Number(row.step_fence),
    };
  }

  private async completeAndStartStep(
    client: pg.PoolClient,
    context: MutationContext,
    output: unknown,
    nextStepId: GateA3WorkOrderStepLease['stepId'],
    leaseDurationMs: number,
  ): Promise<GateA3WorkOrderStepLease> {
    const completed = await client.query(`UPDATE business_task_steps SET status='completed',output=$6,
      lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3
        AND status='running' AND attempt_id=$4 AND fencing_token=$5`, [context.tenantId, context.taskId,
      context.stepId, context.stepAttemptId, context.stepFence, output]);
    if (completed.rowCount !== 1) throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order step completion lost its fence', 409);
    const stepAttemptId = id('step_attempt');
    const started = await client.query<{ fencing_token: string }>(`UPDATE business_task_steps SET status='running',
      attempt_id=$4,fencing_token=fencing_token+1,lease_until=now()+($5::bigint*interval '1 millisecond'),
      updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='queued'
      RETURNING fencing_token::text`, [context.tenantId, context.taskId, nextStepId, stepAttemptId, leaseDurationMs]);
    const stepFence = Number(started.rows[0]?.fencing_token);
    if (started.rowCount !== 1 || !Number.isSafeInteger(stepFence) || stepFence < 1) {
      throw new GenewayError('WORK_ORDER_STEP_ORDER_INVALID', 'Next Work Order step is not claimable', 409);
    }
    await appendEvent(client, context.tenantId, context.taskId, 'workflow.step_completed', {
      stepId: context.stepId, stepAttemptId: context.stepAttemptId, stepFence: context.stepFence,
      nextStepId, nextStepAttemptId: stepAttemptId, nextStepFence: stepFence,
    });
    return { stepId: nextStepId, stepAttemptId, stepFence };
  }

  private computeProgress(payload: GateA3ConnectorWorkOrderResponse): WorkOrderProgress {
    const { planQty, completedQty } = payload;
    if (planQty === null || completedQty === null) return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty, progressPct: null,
      calculationStatus: 'missing_quantity',
    });
    if (planQty === 0) return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty, progressPct: null,
      calculationStatus: 'zero_plan',
    });
    if (completedQty > planQty) return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty, progressPct: null,
      calculationStatus: 'completed_exceeds_plan',
    });
    return gateA3WorkOrderProgressSchema.parse({ schemaVersion: 'work-order.progress/1', planQty, completedQty,
      progressPct: Number(((completedQty / planQty) * 100).toFixed(2)), calculationStatus: 'computed' });
  }

  private async revalidateConnectorEvidence(
    client: pg.PoolClient,
    identity: Readonly<{ tenantId: string; taskId: string; principalId: string; snapshotId: string }>,
  ) {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))', [
      `gate-a3-source-access:${identity.tenantId}`, `${identity.snapshotId}:${identity.principalId}`,
    ]);
    const selected = await client.query<{
      id: string; business_task_id: string; connector_invocation_id: string; connector_query_spec_id: string;
      connector_query_spec_hash: string; execution_attempt_id: string; step_attempt_id: string;
      effect_id: string; task_fence: string; step_fence: string; work_order_ref_hash: string;
      response_ref_matched: boolean; field_mask_version: string; source_revision: string;
      source_as_of: string; canonical_payload: unknown; canonical_payload_hash: string;
      resource_scope: string; data_class: 'C0' | 'C1'; audience: string; created_at: Date;
      canonical_spec: unknown; spec_hash: string; spec_principal_id: string;
      spec_work_order_ref_hash: string; spec_field_mask_version: string;
      requester_id: string; record_variant: string; invocation_task_id: string;
      invocation_query_spec_id: string; invocation_query_spec_hash: string;
      invocation_execution_attempt_id: string; invocation_step_attempt_id: string;
      invocation_effect_id: string; invocation_task_fence: string; invocation_step_fence: string;
      invocation_status: string; invocation_response_ref_matched: boolean | null;
      invocation_source_revision: string | null; invocation_response_hash: string | null;
      source_revoked: boolean;
    }>(`SELECT snapshot.id,snapshot.business_task_id,snapshot.connector_invocation_id,
        snapshot.connector_query_spec_id,snapshot.connector_query_spec_hash,
        snapshot.execution_attempt_id,snapshot.step_attempt_id,snapshot.effect_id,
        snapshot.task_fence::text,snapshot.step_fence::text,snapshot.work_order_ref_hash,
        snapshot.response_ref_matched,snapshot.field_mask_version,snapshot.source_revision,
        to_char(snapshot.source_as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') source_as_of,
        snapshot.canonical_payload,snapshot.canonical_payload_hash,snapshot.resource_scope,
        snapshot.data_class,snapshot.audience,snapshot.created_at,spec.canonical_spec,
        spec.spec_hash,spec.principal_id spec_principal_id,
        spec.work_order_ref_hash spec_work_order_ref_hash,
        spec.field_mask_version spec_field_mask_version,task.requester_id,task.record_variant,
        invocation.business_task_id invocation_task_id,
        invocation.connector_query_spec_id invocation_query_spec_id,
        invocation.connector_query_spec_hash invocation_query_spec_hash,
        invocation.execution_attempt_id invocation_execution_attempt_id,
        invocation.step_attempt_id invocation_step_attempt_id,
        invocation.effect_id invocation_effect_id,invocation.task_fence::text invocation_task_fence,
        invocation.step_fence::text invocation_step_fence,invocation.status invocation_status,
        invocation.response_ref_matched invocation_response_ref_matched,
        invocation.source_revision invocation_source_revision,
        invocation.response_canonical_hash invocation_response_hash,
        EXISTS (SELECT 1 FROM gate_a3_connector_source_revocations revocation
          WHERE revocation.tenant_id=snapshot.tenant_id
            AND revocation.connector_source_snapshot_id=snapshot.id
            AND revocation.principal_id=$4) source_revoked
      FROM gate_a3_connector_source_snapshots snapshot
      JOIN business_tasks task ON task.tenant_id=snapshot.tenant_id
        AND task.id=snapshot.business_task_id
      JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=snapshot.tenant_id
        AND spec.id=snapshot.connector_query_spec_id
      JOIN gate_a3_connector_invocations invocation ON invocation.tenant_id=snapshot.tenant_id
        AND invocation.id=snapshot.connector_invocation_id
      WHERE snapshot.tenant_id=$1 AND snapshot.business_task_id=$2 AND snapshot.id=$3
      FOR SHARE OF snapshot,task,spec,invocation`, [
      identity.tenantId, identity.taskId, identity.snapshotId, identity.principalId,
    ]);
    const row = selected.rows[0];
    if (row === undefined || row.record_variant !== 'business-task.work-order.live/1'
      || row.requester_id !== identity.principalId || row.spec_principal_id !== identity.principalId
      || row.audience !== `principal:${identity.principalId}`) {
      throw new GenewayError('EVIDENCE_AUTHORITY_INVALID', 'Connector Evidence source authority is missing', 409);
    }
    if (row.source_revoked) {
      throw new GenewayError('EVIDENCE_SOURCE_REVOKED', 'Connector Evidence source access was revoked', 404);
    }
    const querySpecResult = gateA3ConnectorQuerySpecSchema.safeParse(row.canonical_spec);
    const payloadResult = gateA3ConnectorWorkOrderResponseSchema.safeParse(row.canonical_payload);
    if (!querySpecResult.success || !payloadResult.success) {
      throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Connector Evidence source schema drifted', 409);
    }
    const querySpec = querySpecResult.data;
    const payload = payloadResult.data;
    if (digest(querySpec) !== row.spec_hash || row.connector_query_spec_hash !== row.spec_hash
      || row.spec_work_order_ref_hash !== row.work_order_ref_hash
      || row.spec_field_mask_version !== row.field_mask_version
      || querySpec.specId !== row.connector_query_spec_id
      || querySpec.tenantId !== identity.tenantId || querySpec.principal !== identity.principalId
      || querySpec.workOrderRef !== payload.workOrderRef
      || sha256(payload.workOrderRef) !== row.work_order_ref_hash
      || querySpec.fieldMaskVersion !== row.field_mask_version
      || digest(payload) !== row.canonical_payload_hash
      || payload.sourceRevision !== row.source_revision || payload.updatedAt !== row.source_as_of
      || !row.response_ref_matched || row.resource_scope !== RESOURCE_SCOPE
      || row.invocation_task_id !== row.business_task_id
      || row.invocation_query_spec_id !== row.connector_query_spec_id
      || row.invocation_query_spec_hash !== row.connector_query_spec_hash
      || row.invocation_execution_attempt_id !== row.execution_attempt_id
      || row.invocation_step_attempt_id !== row.step_attempt_id
      || row.invocation_effect_id !== row.effect_id
      || row.invocation_task_fence !== row.task_fence || row.invocation_step_fence !== row.step_fence
      || row.invocation_status !== 'completed' || row.invocation_response_ref_matched !== true
      || row.invocation_source_revision !== row.source_revision
      || row.invocation_response_hash !== row.canonical_payload_hash) {
      throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Connector Evidence source identity drifted', 409);
    }
    const snapshot = gateA3ConnectorSourceSnapshotSchema.parse({
      schemaVersion: 'connector-source-snapshot/1', canonicalizationVersion: 'RFC8785/JCS-1',
      connectorSourceSnapshotId: row.id, tenantId: identity.tenantId, principal: identity.principalId,
      taskId: identity.taskId, connectorInvocationId: row.connector_invocation_id,
      effectId: row.effect_id, attemptId: row.step_attempt_id, fence: Number(row.step_fence),
      connectorQuerySpecHash: row.connector_query_spec_hash, workOrderRefHash: row.work_order_ref_hash,
      responseRefMatched: true, fieldMaskVersion: row.field_mask_version,
      sourceRevision: row.source_revision, sourceAsOf: row.source_as_of,
      canonicalAllowlistedPayload: payload, canonicalAllowlistedPayloadHash: row.canonical_payload_hash,
      resourceScope: row.resource_scope, dataClass: row.data_class,
      audience: { tenantId: identity.tenantId, principal: identity.principalId },
      createdAt: iso(row.created_at),
    });
    const evidence = await client.query<{
      id: string; connector_source_snapshot_id: string; connector_invocation_id: string;
      effect_id: string; connector_query_spec_hash: string; canonical_payload_hash: string;
      work_order_ref_hash: string; field_mask_version: string; source_revision: string;
      source_as_of: string; locator_kind: 'connector_snapshot_field' | 'connector_snapshot_whole';
      field_name: string | null; canonical_field: unknown; canonical_field_hash: string | null;
      resource_scope: string; data_class: 'C0' | 'C1'; audience: string; accessible: boolean;
    }>(`SELECT id,connector_source_snapshot_id,connector_invocation_id,effect_id,
        connector_query_spec_hash,canonical_payload_hash,work_order_ref_hash,field_mask_version,
        source_revision,to_char(source_as_of AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') source_as_of,
        locator_kind,field_name,canonical_field,canonical_field_hash,
        resource_scope,data_class,audience,accessible
      FROM gate_a3_connector_evidence
      WHERE tenant_id=$1 AND business_task_id=$2 AND connector_source_snapshot_id=$3
      ORDER BY locator_kind,field_name NULLS FIRST,id FOR SHARE`, [
      identity.tenantId, identity.taskId, identity.snapshotId,
    ]);
    if (evidence.rows.length !== GATE_A3_WORK_ORDER_FIELD_MASK.length + 1) {
      throw new GenewayError('EVIDENCE_INCOMPLETE', 'Connector Evidence locator set is incomplete', 409);
    }
    const fields = new Map<string, Readonly<{ id: string; field: GateA3ConnectorEvidenceField }>>();
    let wholeEvidenceId: string | null = null;
    for (const item of evidence.rows) {
      const locatorBase = {
        schemaVersion: 'connector-evidence-locator/1' as const,
        connectorSourceSnapshotId: row.id, connectorInvocationId: row.connector_invocation_id,
        effectId: row.effect_id, connectorQuerySpecHash: row.connector_query_spec_hash,
        canonicalAllowlistedPayloadHash: row.canonical_payload_hash,
        workOrderRefHash: row.work_order_ref_hash, fieldMaskVersion: row.field_mask_version,
        sourceRevision: row.source_revision, sourceAsOf: row.source_as_of,
      };
      if (!item.accessible || item.connector_source_snapshot_id !== row.id
        || item.connector_invocation_id !== row.connector_invocation_id
        || item.effect_id !== row.effect_id
        || item.connector_query_spec_hash !== row.connector_query_spec_hash
        || item.canonical_payload_hash !== row.canonical_payload_hash
        || item.work_order_ref_hash !== row.work_order_ref_hash
        || item.field_mask_version !== row.field_mask_version
        || item.source_revision !== row.source_revision || item.source_as_of !== row.source_as_of
        || item.resource_scope !== row.resource_scope || item.data_class !== row.data_class
        || item.audience !== row.audience) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Connector Evidence locator identity drifted', 409);
      }
      if (item.locator_kind === 'connector_snapshot_whole') {
        if (wholeEvidenceId !== null || item.field_name !== null || item.canonical_field !== null
          || item.canonical_field_hash !== null
          || !gateA3ConnectorEvidenceLocatorSchema.safeParse({
            ...locatorBase, kind: 'connector_snapshot_whole',
          }).success) {
          throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Whole snapshot Evidence locator drifted', 409);
        }
        wholeEvidenceId = item.id;
        continue;
      }
      const fieldName = GATE_A3_WORK_ORDER_FIELD_MASK.find((candidate) => candidate === item.field_name);
      const parsedField = gateA3ConnectorEvidenceFieldSchema.safeParse(item.canonical_field);
      if (fieldName === undefined || !parsedField.success || parsedField.data.fieldName !== fieldName
        || item.canonical_field_hash === null || fields.has(fieldName)) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Connector field Evidence locator is invalid', 409);
      }
      const expectedField = canonicalEvidenceField(payload, fieldName);
      if (digest(item.canonical_field) !== item.canonical_field_hash
        || digest(parsedField.data) !== item.canonical_field_hash
        || digest(expectedField) !== item.canonical_field_hash
        || !gateA3ConnectorEvidenceLocatorSchema.safeParse({
          ...locatorBase, kind: 'connector_snapshot_field', field: parsedField.data,
          fieldHash: item.canonical_field_hash,
        }).success) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Connector field Evidence value drifted', 409);
      }
      fields.set(fieldName, { id: item.id, field: parsedField.data });
    }
    if (wholeEvidenceId === null || fields.size !== GATE_A3_WORK_ORDER_FIELD_MASK.length) {
      throw new GenewayError('EVIDENCE_INCOMPLETE', 'Connector Evidence must contain one whole and nine fields', 409);
    }
    return { snapshot, payload, fields, wholeEvidenceId };
  }

  private async finishDelivery(
    client: pg.PoolClient,
    context: MutationContext,
    status: 'completed' | 'failed',
    error: string | null,
  ): Promise<void> {
    const attempt = await client.query(`UPDATE execution_attempts SET status=$3,completed_at=now(),last_error=$4
      WHERE tenant_id=$1 AND id=$2 AND status='running' AND fencing_token=$5`, [context.tenantId,
      context.executionAttemptId, status, error, context.taskFence]);
    const delivery = await client.query(`UPDATE outbox_deliveries SET status=$3,lease_until=now(),
      last_error=$4,updated_at=now() WHERE tenant_id=$1 AND execution_attempt_id=$2
        AND status='leased' AND fencing_token=$5`, [context.tenantId, context.executionAttemptId,
      status, error, context.taskFence]);
    const inbox = await client.query(`UPDATE inbox_events SET status=$3,processing_at=coalesce(processing_at,now()),
      completed_at=now(),last_error=$4 WHERE tenant_id=$1 AND execution_attempt_id=$2
        AND status IN ('received','processing') AND fencing_token=$5`, [context.tenantId,
      context.executionAttemptId, status, error, context.taskFence]);
    if (attempt.rowCount !== 1 || delivery.rowCount !== 1 || inbox.rowCount !== 1) {
      throw new GenewayError('WORK_ORDER_DELIVERY_STALE', 'Work Order delivery lost its execution fence', 409);
    }
  }

  private async reclaimExpiredWorkOrder(client: pg.PoolClient, tenantId: string): Promise<void> {
    const selected = await client.query<{ tenant_id: string; task_id: string; attempt_id: string;
      delivery_id: string; event_id: string; task_fence: string }>(`SELECT task.tenant_id,task.id task_id,
        attempt.id attempt_id,delivery.id delivery_id,delivery.event_id,
        task.execution_fencing_token::text task_fence
      FROM business_tasks task
      JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id
        AND attempt.id=task.current_execution_attempt_id
      JOIN outbox_deliveries delivery ON delivery.tenant_id=attempt.tenant_id
        AND delivery.execution_attempt_id=attempt.id
      WHERE task.tenant_id=$1 AND task.record_variant='business-task.work-order.live/1' AND task.status='running'
        AND attempt.status='running' AND delivery.status='leased'
        AND least(attempt.lease_until,delivery.lease_until)<=now()
      ORDER BY least(attempt.lease_until,delivery.lease_until),task.id
      FOR UPDATE OF task,attempt,delivery SKIP LOCKED LIMIT 1`, [tenantId]);
    const row = selected.rows[0];
    if (row === undefined) return;
    const nextFence = Number(row.task_fence) + 1;
    await client.query(`UPDATE execution_attempts SET status='superseded',completed_at=now(),last_error='LEASE_EXPIRED'
      WHERE tenant_id=$1 AND id=$2 AND status='running'`, [row.tenant_id, row.attempt_id]);
    await client.query(`UPDATE outbox_deliveries SET status='failed',lease_until=now(),last_error='LEASE_EXPIRED',updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status='leased'`, [row.tenant_id, row.delivery_id]);
    await client.query(`UPDATE inbox_events SET status='failed',processing_at=coalesce(processing_at,now()),
      completed_at=now(),last_error='LEASE_EXPIRED' WHERE tenant_id=$1 AND consumer=$2 AND event_id=$3
        AND status IN ('received','processing')`, [row.tenant_id, WORKER_CONSUMER, row.event_id]);
    await client.query(`UPDATE gate_a3_connector_token_authorizations SET invalidated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [
      row.tenant_id, row.task_id,
    ]);
    await client.query(`UPDATE gate_a3_connector_invocations SET status='failed',error_class='LEASE_EXPIRED',
      terminal_at=now(),redacted_audit=redacted_audit||'{"terminalErrorClass":"LEASE_EXPIRED"}'::jsonb
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [
      row.tenant_id, row.task_id,
    ]);
    await client.query(`UPDATE gate_a3_model_invocations SET
      invalidated_at=CASE WHEN consumed_at IS NULL THEN now() ELSE invalidated_at END,
      status='failed',error_class='LEASE_EXPIRED',terminal_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [row.tenant_id, row.task_id]);
    const consumedModelLost = await client.query(`SELECT 1 FROM gate_a3_model_invocations invocation
      WHERE invocation.tenant_id=$1 AND invocation.business_task_id=$2 AND invocation.consumed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gate_a3_work_order_explanations explanation
          WHERE explanation.tenant_id=invocation.tenant_id AND explanation.business_task_id=invocation.business_task_id)
      LIMIT 1`, [row.tenant_id, row.task_id]);
    if (consumedModelLost.rowCount === 1) {
      const errorClass = 'MODEL_STREAM_INTERRUPTED';
      const result = { kind: 'failed', code: errorClass,
        message: '只读工单查询的模型说明在进程恢复前未被接受，未发布状态卡。' };
      await client.query(`UPDATE business_task_steps SET status=CASE WHEN status='running' THEN 'failed' ELSE 'canceled' END,
        lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2
          AND status IN ('queued','running')`, [row.tenant_id, row.task_id]);
      await client.query(`UPDATE business_tasks SET status='failed',terminal_error_class=$3,result=$4,
        result_record_variant='business-task-result.work-order.live/1',current_execution_attempt_id=NULL,
        execution_fencing_token=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'`, [
        row.tenant_id, row.task_id, errorClass, result, nextFence,
      ]);
      await appendEvent(client, row.tenant_id, row.task_id, 'business_task.failed', {
        errorClass, reason: 'CONSUMED_MODEL_RECEIPT_NOT_ACCEPTED', supersededExecutionAttemptId: row.attempt_id,
      });
      return;
    }
    await client.query(`UPDATE business_task_steps SET status='queued',attempt_id=NULL,lease_until=NULL,
      output=NULL,updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2`, [row.tenant_id, row.task_id]);
    await client.query(`UPDATE business_tasks SET status='queued',current_execution_attempt_id=NULL,
      execution_version=execution_version+1,execution_fencing_token=$3,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status='running'`, [row.tenant_id, row.task_id, nextFence]);
    await appendEvent(client, row.tenant_id, row.task_id, 'workflow.run_requested', {
      reason: 'LEASE_EXPIRED', supersededExecutionAttemptId: row.attempt_id, invalidatedFence: nextFence,
    });
  }

  private async settleExpiredWorkOrder(client: pg.PoolClient, tenantId: string): Promise<void> {
    const selected = await client.query<{ task_id: string; approval_expired: boolean; deadline_expired: boolean }>(`SELECT
      task.id task_id,approval.expires_at<=now() approval_expired,spec.deadline<=now() deadline_expired
      FROM business_tasks task
      JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id
        AND spec.business_task_id=task.id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id
        AND approval.business_task_id=task.id
        AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
          AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
      WHERE task.tenant_id=$1 AND task.record_variant='business-task.work-order.live/1'
        AND task.status IN ('queued','running') AND (approval.expires_at<=now() OR spec.deadline<=now())
      ORDER BY least(approval.expires_at,spec.deadline),task.id
      FOR UPDATE OF task,approval SKIP LOCKED LIMIT 1`, [tenantId]);
    const row = selected.rows[0];
    if (row === undefined) return;
    const errorClass = row.deadline_expired ? 'CONNECTOR_TIMEOUT' : 'CONNECTOR_AUTH_FAILED';
    await this.terminalizeUnavailableWorkOrder(client, tenantId, row.task_id, errorClass,
      'AUTHORITY_EXPIRED_BEFORE_PUBLICATION', {
        approvalExpired: row.approval_expired, deadlineExpired: row.deadline_expired,
      });
  }

  private async settleUnavailableAuthorityWorkOrder(client: pg.PoolClient, tenantId: string): Promise<void> {
    const selected = await client.query<{ task_id: string }>(`SELECT id task_id FROM business_tasks
      WHERE tenant_id=$1 AND record_variant='business-task.work-order.live/1'
        AND gate_a3_authority_digest=$2 AND status IN ('awaiting_approval','approved','queued','running')
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [
      tenantId, this.authority.envelope.authorityDigest,
    ]);
    const row = selected.rows[0];
    if (row === undefined) return;
    await this.terminalizeUnavailableWorkOrder(client, tenantId, row.task_id, 'CONNECTOR_AUTH_FAILED',
      'RUNTIME_AUTHORITY_NOT_OPEN', {});
  }

  private async terminalizeUnavailableWorkOrder(
    client: pg.PoolClient,
    tenantId: string,
    taskId: string,
    errorClass: 'CONNECTOR_AUTH_FAILED' | 'CONNECTOR_TIMEOUT',
    reason: 'AUTHORITY_EXPIRED_BEFORE_PUBLICATION' | 'RUNTIME_AUTHORITY_NOT_OPEN',
    detail: Readonly<Record<string, boolean>>,
  ): Promise<void> {
    const result = { kind: 'failed' as const, code: errorClass,
      message: '只读工单查询权限或截止时间已失效，未发布工单结果。' };
    await client.query(`UPDATE business_task_steps SET
      status=CASE WHEN status='running' THEN 'failed' ELSE 'canceled' END,
      lease_until=NULL,updated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('queued','running')`, [tenantId, taskId]);
    await client.query(`UPDATE gate_a3_connector_token_authorizations SET invalidated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [
      tenantId, taskId,
    ]);
    await client.query(`UPDATE gate_a3_connector_invocations SET status='failed',error_class=$3,
      terminal_at=coalesce(terminal_at,now()),retry_scheduled=false,retry_not_before=NULL,
      redacted_audit=redacted_audit||jsonb_build_object('terminalErrorClass',$3::text,
        'terminalReason',$4::text)
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [
      tenantId, taskId, errorClass, reason,
    ]);
    await client.query(`UPDATE gate_a3_model_invocations SET
      invalidated_at=CASE WHEN consumed_at IS NULL THEN now() ELSE invalidated_at END,
      status='failed',error_class=$3,terminal_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('authorized','running')`, [
      tenantId, taskId, errorClass,
    ]);
    await client.query(`UPDATE execution_attempts SET status='failed',completed_at=now(),last_error=$3
      WHERE tenant_id=$1 AND business_task_id=$2 AND status='running'`, [tenantId, taskId, reason]);
    await client.query(`UPDATE outbox_deliveries SET status='failed',lease_until=now(),last_error=$3,updated_at=now()
      WHERE tenant_id=$1 AND business_task_id=$2 AND status='leased'`, [tenantId, taskId, reason]);
    await client.query(`UPDATE inbox_events SET status='failed',processing_at=coalesce(processing_at,now()),
      completed_at=now(),last_error=$3 WHERE tenant_id=$1 AND business_task_id=$2
        AND status IN ('received','processing')`, [tenantId, taskId, reason]);
    const failed = await client.query(`UPDATE business_tasks SET status='failed',terminal_error_class=$3,
      result=$4,result_record_variant='business-task-result.work-order.live/1',
      current_execution_attempt_id=NULL,execution_fencing_token=execution_fencing_token+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status IN ('awaiting_approval','approved','queued','running')`, [
      tenantId, taskId, errorClass, result,
    ]);
    if (failed.rowCount !== 1) {
      throw new GenewayError('WORK_ORDER_FENCE_STALE', 'Work Order terminal sweep lost its task fence', 409);
    }
    await appendEvent(client, tenantId, taskId, 'business_task.failed', { errorClass, reason, ...detail });
  }

  private async assertAuthority(client: pg.PoolClient, tenantId: string, trySharedLock = false): Promise<void> {
    if (trySharedLock) {
      const locked = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock_shared($1,$2) locked',
        [AUTHORITY_LOCK_NAMESPACE, AUTHORITY_LOCK_KEY],
      );
      if (locked.rows[0]?.locked !== true) {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 authority mutation is in progress', 503);
      }
    } else {
      await this.lockAuthorityShared(client);
    }
    await this.assertConfiguredRuntimeAuthority();
    const currentLock = await client.query(`SELECT 1 FROM gate_a3_authority_current current
      WHERE current.tenant_id=$1 AND current.capability_id=$2 FOR SHARE OF current`, [tenantId, CAPABILITY_ID]);
    if (currentLock.rowCount !== 1) {
      throw new GenewayError('NOT_OPEN', 'Gate A.3 current authority is unavailable', 503);
    }
    const workflow = compileTemplateWorkflow({ schemaVersion: 'workflow-draft.template-v1',
      templateId: WORK_ORDER_STATUS_TEMPLATE.templateId, registryDigest: WORK_ORDER_STATUS_TEMPLATE.registryDigest });
    const selected = await client.query<{ capability_id: string; capability_spec: unknown;
      harness_capability_version_id: string; harness_spec: unknown; prompt_policy_id: string;
      prompt_policy: unknown; expert_catalog: unknown; workflow_hash: string;
      canonicalization_version: string; canonical_json: unknown; template_id: string | null;
      registry_digest: string | null; release_id: string; release_state: string;
      release_evidence: unknown; release_evidence_digest: string; authority_digest: string;
      authority_state: string; authority_envelope: unknown; authority_effective_at: Date;
      authority_expires_at: Date; authority_revoked: boolean }>(`SELECT capability.capability_id,
        capability.spec capability_spec,harness.capability_version_id harness_capability_version_id,
        harness.spec harness_spec,prompt.policy_id prompt_policy_id,prompt.policy prompt_policy,
        expert.catalog expert_catalog,workflow.workflow_hash,workflow.canonicalization_version,
        workflow.canonical_json,workflow.template_id,workflow.registry_digest,
        active.release_id,release.state release_state,release.gate_evidence release_evidence,
        release.gate_evidence_digest release_evidence_digest,authority_stage.authority_digest,
        authority_stage.state authority_state,authority.envelope authority_envelope,
        authority.effective_at authority_effective_at,authority.expires_at authority_expires_at,
        EXISTS (SELECT 1 FROM gate_a3_authority_revocations revoked
          WHERE revoked.tenant_id=authority.tenant_id
            AND revoked.authority_digest=authority.authority_digest) authority_revoked
      FROM capability_versions capability
      JOIN harness_versions harness ON harness.tenant_id=capability.tenant_id AND harness.id=$3
      JOIN prompt_policy_versions prompt ON prompt.tenant_id=capability.tenant_id AND prompt.id=$4
      JOIN expert_catalog_versions expert ON expert.tenant_id=capability.tenant_id AND expert.id=$5
      JOIN workflow_versions workflow ON workflow.tenant_id=capability.tenant_id AND workflow.id=$6
      JOIN capability_active_releases active ON active.tenant_id=capability.tenant_id AND active.capability_id=$7
      JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      JOIN gate_a3_authority_current authority_current ON authority_current.tenant_id=capability.tenant_id
        AND authority_current.capability_id=$7
      JOIN gate_a3_authority_stages authority_stage ON authority_stage.tenant_id=authority_current.tenant_id
        AND authority_stage.id=authority_current.stage_id
      JOIN gate_a3_authority_envelopes authority ON authority.tenant_id=authority_stage.tenant_id
        AND authority.authority_digest=authority_stage.authority_digest
      WHERE capability.tenant_id=$1 AND capability.id=$2`, [tenantId, CAPABILITY_VERSION_ID,
      HARNESS_VERSION_ID, PROMPT_POLICY_VERSION_ID, EXPERT_CATALOG_VERSION_ID, workflow.id, CAPABILITY_ID]);
    const row = selected.rows[0];
    if (this.authority.controlPlaneAuthorityBundle !== undefined) {
      const persisted = await client.query<{ bundle: unknown; bundle_digest: string }>(`SELECT bundle,bundle_digest
        FROM gate_a3_acceptance_authority_bundles
        WHERE tenant_id=$1 AND authority_digest=$2`, [tenantId, this.authority.envelope.authorityDigest]);
      const persistedBundle = persisted.rows[0];
      if (persisted.rowCount !== 1 || persistedBundle === undefined
        || persistedBundle.bundle_digest !== digest(persistedBundle.bundle)
        || persistedBundle.bundle_digest !== digest(this.authority.controlPlaneAuthorityBundle)) {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 durable acceptance authority is unavailable or drifted', 503);
      }
      try {
        assertGateA3ControlPlaneAuthorityCurrent(
          persistedBundle.bundle as GateA3ControlPlaneAuthorityBundle,
        );
      } catch {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 durable acceptance signatures are unavailable or expired', 503);
      }
    }
    const releaseEvidence = row?.release_evidence as Readonly<Record<string, unknown>> | undefined;
    const correctedReleaseState = row?.release_state === 'shadow' || row?.release_state === 'internal'
      ? row.release_state : null;
    let aggregateDigest: string | null = null;
    if (this.authority.controlPlaneAuthorityBundle !== undefined && correctedReleaseState === 'internal') {
      const promoted = await client.query<{ aggregate: unknown; aggregate_digest: string }>(`SELECT
        aggregate.aggregate,aggregate.aggregate_digest
        FROM gate_a3_acceptance_promotions promotion
        JOIN gate_a3_acceptance_aggregates aggregate
          ON aggregate.tenant_id=promotion.tenant_id
         AND aggregate.capability_id=promotion.capability_id
         AND aggregate.run_id=promotion.run_id
        WHERE promotion.tenant_id=$1 AND promotion.capability_id=$2
          AND promotion.run_id=$3`, [tenantId, CAPABILITY_ID,
        this.authority.controlPlaneAuthorityBundle.acceptanceAdmission.runId]);
      const promotion = promoted.rows[0];
      if (promoted.rowCount !== 1 || promotion === undefined
        || promotion.aggregate_digest !== digest(promotion.aggregate)) {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 fresh aggregate promotion receipt is unavailable', 503);
      }
      try {
        assertGateA3CapabilityAcceptanceAggregate(
          this.authority.controlPlaneAuthorityBundle,
          promotion.aggregate,
        );
      } catch {
        throw new GenewayError('NOT_OPEN', 'Gate A.3 fresh aggregate signature is unavailable or expired', 503);
      }
      aggregateDigest = promotion.aggregate_digest;
    }
    const expectedReleaseEvidence = gateA3ReleaseEvidence(
      this.authority,
      this.authority.controlPlaneAuthorityBundle === undefined ? 'internal'
        : correctedReleaseState ?? 'draft',
      aggregateDigest,
    );
    const parsedEnvelope = row === undefined ? null
      : z.union([gateA3AuthorityEnvelopeSchema, gateA3ControlPlaneAuthorityEnvelopeSchema])
        .safeParse(row.authority_envelope);
    const envelope = parsedEnvelope?.success === true ? parsedEnvelope.data : null;
    const envelopeBody = envelope === null ? null : Object.fromEntries(
      Object.entries(envelope).filter(([key]) => key !== 'authorityDigest'),
    );
    if (row === undefined || selected.rowCount !== 1 || row.capability_id !== CAPABILITY_ID
      || digest(row.capability_spec) !== digest(capabilitySpec)
      || row.harness_capability_version_id !== CAPABILITY_VERSION_ID
      || digest(row.harness_spec) !== digest(harnessSpec)
      || row.prompt_policy_id !== PROMPT_POLICY_ID || digest(row.prompt_policy) !== digest(promptPolicy)
      || digest(row.expert_catalog) !== digest(expertCatalog)
      || row.template_id !== WORK_ORDER_STATUS_TEMPLATE.templateId
      || row.registry_digest !== WORK_ORDER_STATUS_TEMPLATE.registryDigest
      || (this.authority.controlPlaneAuthorityBundle === undefined
        ? row.release_id !== RELEASE_INTERNAL_ID || row.release_state !== 'internal'
        : correctedReleaseState === null
          || row.release_id !== (correctedReleaseState === 'shadow' ? RELEASE_SHADOW_ID : RELEASE_INTERNAL_ID))
      || digest(row.release_evidence) !== row.release_evidence_digest
      || digest(row.release_evidence) !== digest(expectedReleaseEvidence)
      || releaseEvidence?.authorityPolicy !== expectedReleaseEvidence.authorityPolicy
      || row.authority_digest !== this.authority.envelope.authorityDigest
      || row.authority_state !== (this.authority.controlPlaneAuthorityBundle === undefined
        ? 'internal' : correctedReleaseState) || row.authority_revoked
      || row.authority_effective_at.getTime() > Date.now() || row.authority_expires_at.getTime() <= Date.now()
      || row.authority_effective_at.toISOString() !== envelope?.effectiveAt
      || row.authority_expires_at.toISOString() !== envelope?.expiresAt
      || envelope === null || envelope.authorityDigest !== digest(envelopeBody)
      || digest(envelope) !== digest(this.authority.envelope)) {
      throw new GenewayError('NOT_OPEN', 'Gate A.3 immutable startup authority is unavailable or drifted', 503);
    }
    readStoredTemplateWorkflowVersion({ id: workflow.id, hash: row.workflow_hash,
      canonicalizationVersion: row.canonicalization_version, canonicalPayload: row.canonical_json });
  }

  private async lockAuthorityShared(client: pg.PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock_shared($1,$2)', [AUTHORITY_LOCK_NAMESPACE, AUTHORITY_LOCK_KEY]);
  }

  private async assertConfiguredRuntimeAuthority(): Promise<void> {
    try {
      await this.authority.assertRuntimeAuthority();
    } catch {
      throw new GenewayError('NOT_OPEN', 'Gate A.3 runtime authority is unavailable or drifted', 503);
    }
  }

  private async lockAuthorityExclusive(client: pg.PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [AUTHORITY_LOCK_NAMESPACE, AUTHORITY_LOCK_KEY]);
  }

  private authorityStageId(state: 'draft' | 'shadow' | 'internal'): string {
    return `gate_a3_authority_${this.authority.envelope.authorityDigest}_${state}`;
  }

  private async assertCurrentExecutionAuthority(
    client: pg.PoolClient,
    tenantId: string,
    taskId: string,
    principalId: string,
  ): Promise<void> {
    await this.assertAuthority(client, tenantId);
    const selected = await client.query<{ approval_status: string; approval_digest: string;
      approval_subject: unknown; expires_at: Date; spec_hash: string; principal_id: string;
      deadline: Date; gate_a3_authority_digest: string | null }>(`SELECT approval.status approval_status,approval.subject_digest approval_digest,
        approval.subject approval_subject,approval.expires_at,spec.spec_hash,spec.principal_id,spec.deadline
        ,task.gate_a3_authority_digest
      FROM business_tasks task
      JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
        AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
          AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
      WHERE task.tenant_id=$1 AND task.id=$2 AND task.requester_id=$3
        AND task.record_variant='business-task.work-order.live/1'`, [tenantId, taskId, principalId]);
    const row = selected.rows[0];
    if (row === undefined || row.approval_status !== 'approved' || row.principal_id !== principalId
      || row.gate_a3_authority_digest !== this.authority.envelope.authorityDigest
      || row.expires_at.getTime() <= Date.now() || row.deadline.getTime() <= Date.now()
      || digest(row.approval_subject) !== row.approval_digest
      || (row.approval_subject as Readonly<Record<string, unknown>>).connectorQuerySpecHash !== row.spec_hash) {
      throw new GenewayError('APPROVAL_AUTHORITY_STALE', 'Current Work Order approval authority is not valid', 409);
    }
  }

  private async getTaskInTransaction(
    client: pg.PoolClient,
    principal: Principal,
    taskId: string,
  ): Promise<GateA3PublicTaskSnapshot> {
    const selected = await client.query<{ id: string; conversation_id: string; status: GateA3PublicTaskSnapshot['status'];
      input_snapshot: unknown; workflow_version_id: string; workflow_hash: string; result: unknown;
      result_record_variant: string | null; immutable_result: unknown;
      immutable_result_hash: string | null; immutable_card: unknown; immutable_card_hash: string | null;
      result_snapshot_id: string | null; result_connector_invocation_id: string | null;
      result_effect_id: string | null; result_variant: string | null; result_card_schema_version: string | null;
      stored_explanation: unknown; stored_explanation_hash: string | null;
      created_at: Date; updated_at: Date; spec_hash: string; approval_id: string;
      approval_version: string; approval_status: string; approval_digest: string; approval_expires_at: Date }>(`SELECT
        task.id,task.conversation_id,task.status,task.input_snapshot,task.workflow_version_id,
        task.workflow_hash,task.result,task.result_record_variant,task.created_at,task.updated_at,spec.spec_hash,
        approval.id approval_id,approval.version::text approval_version,approval.status approval_status,
        approval.subject_digest approval_digest,approval.expires_at approval_expires_at,
        immutable.public_result immutable_result,immutable.public_result_hash immutable_result_hash,
        immutable.card immutable_card,immutable.card_hash immutable_card_hash,
        immutable.connector_source_snapshot_id result_snapshot_id,
        immutable.connector_invocation_id result_connector_invocation_id,
        immutable.effect_id result_effect_id,immutable.record_variant result_variant,
        immutable.card_schema_version result_card_schema_version,
        explanation.explanation stored_explanation,explanation.explanation_hash stored_explanation_hash
      FROM business_tasks task
      JOIN conversations conversation ON conversation.tenant_id=task.tenant_id
        AND conversation.id=task.conversation_id AND conversation.user_id=$3
      JOIN gate_a3_connector_query_specs spec ON spec.tenant_id=task.tenant_id AND spec.business_task_id=task.id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
        AND NOT EXISTS (SELECT 1 FROM approval_versions newer WHERE newer.tenant_id=approval.tenant_id
          AND newer.business_task_id=approval.business_task_id AND newer.version>approval.version)
      LEFT JOIN gate_a3_work_order_results immutable ON immutable.tenant_id=task.tenant_id
        AND immutable.business_task_id=task.id
      LEFT JOIN gate_a3_work_order_explanations explanation ON explanation.tenant_id=immutable.tenant_id
        AND explanation.id=immutable.explanation_id
      WHERE task.tenant_id=$1 AND task.id=$2 AND task.requester_id=$3
        AND task.record_variant='business-task.work-order.live/1'`, [principal.tenantId, taskId, principal.userId]);
    const row = selected.rows[0];
    if (row === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
    const input = z.object({ kind: z.literal('work_order'), workOrderRef: z.string(),
      connectorQuerySpecHash: z.string() }).passthrough().parse(row.input_snapshot);
    const steps = await client.query<{ step_id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
      attempt_id: string | null; fencing_token: string }>(`SELECT step_id,status,attempt_id,fencing_token::text
      FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2`, [principal.tenantId, taskId]);
    const byId = new Map(steps.rows.map((step) => [step.step_id, step]));
    const workflowSteps = WORK_ORDER_STATUS_TEMPLATE.nodes.map((node) => {
      const step = byId.get(node.id);
      if (step === undefined) throw new GenewayError('TASK_INTEGRITY_FAILED', 'Work Order workflow projection is incomplete', 409);
      const fence = Number(step.fencing_token);
      return { id: node.id, kind: node.kind, status: step.status, attemptId: step.attempt_id,
        fence: step.attempt_id === null ? null : fence };
    });
    const approvalVersion = Number(row.approval_version);
    const approvalStatus = row.approval_status === 'pending' && row.approval_expires_at.getTime() <= Date.now()
      ? 'expired'
      : row.approval_status;
    let publicResult = row.result;
    if (row.status === 'completed') {
      if (row.result_snapshot_id === null || row.immutable_result_hash === null
        || row.immutable_card_hash === null || row.result_connector_invocation_id === null
        || row.result_effect_id === null || row.stored_explanation_hash === null
        || row.result_variant !== 'business-task-result.work-order.live/1'
        || row.result_card_schema_version !== 'WorkOrderStatusCard/1'
        || row.result_record_variant !== 'business-task-result.work-order.live/1') {
        throw new GenewayError('TASK_INTEGRITY_FAILED', 'Completed Work Order immutable result is missing', 409);
      }
      let evidenceAuthority;
      try {
        evidenceAuthority = await this.revalidateConnectorEvidence(client, {
          tenantId: principal.tenantId, taskId, principalId: principal.userId,
          snapshotId: row.result_snapshot_id,
        });
      } catch (error) {
        if (error instanceof GenewayError && error.code === 'EVIDENCE_SOURCE_REVOKED') {
          throw new GenewayError('TASK_NOT_FOUND', 'Work Order task was not found', 404);
        }
        throw error;
      }
      const immutableCard = gateA3WorkOrderStatusCardSchema.parse(row.immutable_card);
      const immutableExplanation = gateA3WorkOrderExplanationSchema.parse(row.stored_explanation);
      const immutableResult = z.object({ kind: z.literal('work_order_status'),
        card: gateA3WorkOrderStatusCardSchema,
        explanation: gateA3WorkOrderExplanationSchema }).strict().parse(row.immutable_result);
      const expectedEvidenceRefs = {
        status: evidenceAuthority.fields.get('status')?.id,
        planQty: evidenceAuthority.fields.get('planQty')?.id,
        completedQty: evidenceAuthority.fields.get('completedQty')?.id,
        updatedAt: evidenceAuthority.fields.get('updatedAt')?.id,
        sourceAsOf: evidenceAuthority.fields.get('updatedAt')?.id,
      };
      const expectedCard = gateA3WorkOrderStatusCardSchema.parse({
        schemaVersion: 'WorkOrderStatusCard/1',
        workOrderRef: evidenceAuthority.payload.workOrderRef,
        status: evidenceAuthority.payload.status,
        planQty: evidenceAuthority.payload.planQty,
        completedQty: evidenceAuthority.payload.completedQty,
        unit: evidenceAuthority.payload.unit,
        progressPct: immutableCard.progressPct,
        updatedAt: evidenceAuthority.payload.updatedAt,
        sourceAsOf: evidenceAuthority.payload.updatedAt,
        evidenceRefs: expectedEvidenceRefs,
        readOnly: true,
      });
      const expectedPublicExplanation = deterministicPublicExplanation(
        immutableExplanation,
        expectedCard,
        evidenceAuthority.payload,
      );
      if (row.result_connector_invocation_id !== evidenceAuthority.snapshot.connectorInvocationId
        || row.result_effect_id !== evidenceAuthority.snapshot.effectId
        || evidenceAuthority.snapshot.connectorQuerySpecHash !== row.spec_hash
        || digest(immutableCard) !== row.immutable_card_hash
        || digest(immutableCard) !== digest(expectedCard)
        || digest(immutableExplanation) !== row.stored_explanation_hash
        || digest(immutableResult.card) !== row.immutable_card_hash
        || digest(immutableResult.explanation) !== digest(expectedPublicExplanation)
        || digest(immutableResult) !== row.immutable_result_hash
        || digest(row.result) !== row.immutable_result_hash) {
        throw new GenewayError('TASK_INTEGRITY_FAILED', 'Completed Work Order result authority drifted', 409);
      }
      publicResult = immutableResult;
    } else if (row.immutable_result !== null || row.immutable_card !== null
      || row.result_snapshot_id !== null) {
      throw new GenewayError('TASK_INTEGRITY_FAILED', 'Non-completed Work Order exposed an immutable result', 409);
    }
    return gateA3PublicTaskSnapshotSchema.parse({
      schemaVersion: 'gate-a3-public-task-snapshot/1',
      recordVariant: 'business-task.work-order.live/1',
      taskId: row.id,
      conversationId: row.conversation_id,
      capabilityId: CAPABILITY_ID,
      status: row.status,
      inputRef: { kind: 'work_order', workOrderRef: input.workOrderRef },
      workflowVersionId: row.workflow_version_id,
      workflowHash: row.workflow_hash,
      workflow: { templateId: WORK_ORDER_STATUS_TEMPLATE.templateId,
        workflowVersionId: row.workflow_version_id, workflowHash: row.workflow_hash, steps: workflowSteps },
      approval: { id: row.approval_id, version: approvalVersion, status: approvalStatus,
        subjectDigest: row.approval_digest, expiresAt: iso(row.approval_expires_at) },
      connectorQuerySpecHash: row.spec_hash,
      result: publicResult,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    });
  }

  private async withTransaction<T>(effect: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await effect(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }
}

export const gateA3WorkOrderConstants = Object.freeze({
  capabilityId: CAPABILITY_ID,
  capabilityVersionId: CAPABILITY_VERSION_ID,
  harnessVersionId: HARNESS_VERSION_ID,
  promptPolicyVersionId: PROMPT_POLICY_VERSION_ID,
  internalReleaseId: RELEASE_INTERNAL_ID,
  fieldMaskDigest: FIELD_MASK_DIGEST,
  endpointMethodAllowlistDigest: ENDPOINT_METHOD_ALLOWLIST_DIGEST,
  baseUrl: BASE_URL,
});
