import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
  }
  return true;
}
const nonEmptyStringSchema = z.string().min(1).max(500).refine(isWellFormedUnicode, 'string must contain valid Unicode scalar values');
const finiteNonnegativeSchema = z.number().finite().nonnegative();

export const GATE_A3_CANONICALIZATION_VERSION = 'RFC8785/JCS-1' as const;
export const GATE_A3_CONNECTOR_PROFILE_VERSION = 'gearjob-work-order-status-dev/1' as const;
export const GATE_A3_GEARJOB_BASE_URL = 'http://127.0.0.1:8100' as const;
export const GATE_A3_GEARJOB_ENDPOINT = '/api/method/gearjob.api.work_order.get_work_order_status' as const;
export const GATE_A3_FIELD_MASK_VERSION = 'gearjob-work-order-status-nine-fields/1' as const;
export const GATE_A3_WORK_ORDER_FIELD_MASK = Object.freeze([
  'workOrderRef', 'status', 'planQty', 'completedQty', 'unit',
  'plannedStart', 'plannedEnd', 'updatedAt', 'sourceRevision',
] as const);
export const GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID = 'xiaowei.work-order-status.explanation/1' as const;

/** The one accepted wire representation is millisecond-precision UTC. */
export const gateA3IsoDateTimeSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }, 'datetime must be the exact millisecond-precision UTC representation');

/** GearJob source timestamps are emitted in one UTC representation with six fractional digits. */
export const gateA3SourceIsoDateTimeSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === `${value.slice(0, -4)}Z`;
  }, 'source datetime must be the exact microsecond-precision UTC representation');

export const gateA3WorkOrderRefSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export const gateA3CreateTaskInputVariantSchema = z.object({
  conversationId: opaqueIdSchema,
  capabilityId: z.literal('production.work-order-status.v1'),
  inputRef: z.object({
    kind: z.literal('work_order'),
    workOrderRef: gateA3WorkOrderRefSchema,
  }).strict(),
}).strict();

export const gateA3ConnectorQuerySpecSchema = z.object({
  schemaVersion: z.literal('connector-query-spec/1'),
  canonicalizationVersion: z.literal(GATE_A3_CANONICALIZATION_VERSION),
  specId: opaqueIdSchema,
  capabilityVersionId: z.literal('cap_production_work_order_status_v1_1'),
  releaseRecordId: opaqueIdSchema,
  approvedPreflightDigest: sha256Schema,
  connectorProfileVersion: z.literal(GATE_A3_CONNECTOR_PROFILE_VERSION),
  baseUrl: z.literal(GATE_A3_GEARJOB_BASE_URL),
  endpoint: z.literal(GATE_A3_GEARJOB_ENDPOINT),
  method: z.literal('GET'),
  endpointMethodAllowlistDigest: sha256Schema,
  fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
  fieldMask: z.tuple(GATE_A3_WORK_ORDER_FIELD_MASK.map((field) => z.literal(field)) as [
    z.ZodLiteral<'workOrderRef'>, z.ZodLiteral<'status'>, z.ZodLiteral<'planQty'>,
    z.ZodLiteral<'completedQty'>, z.ZodLiteral<'unit'>, z.ZodLiteral<'plannedStart'>,
    z.ZodLiteral<'plannedEnd'>, z.ZodLiteral<'updatedAt'>, z.ZodLiteral<'sourceRevision'>,
  ]),
  workOrderRef: gateA3WorkOrderRefSchema,
  tenantId: opaqueIdSchema,
  principal: opaqueIdSchema,
  resourceContextDigest: sha256Schema,
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  stepId: z.literal('fetch_authorized_status'),
  budget: z.object({
    maxAttempts: z.number().int().min(1).max(3),
    timeoutMs: z.number().int().min(100).max(10_000),
  }).strict(),
  deadline: gateA3IsoDateTimeSchema,
  publicErrorPolicyVersion: z.literal('gearjob.not-found-forbidden-equivalent/1'),
  cardSchemaVersion: z.literal('WorkOrderStatusCard/1'),
}).strict();

export const gateA3ConnectorWorkOrderResponseSchema = z.object({
  workOrderRef: gateA3WorkOrderRefSchema,
  status: nonEmptyStringSchema,
  planQty: finiteNonnegativeSchema.nullable(),
  completedQty: finiteNonnegativeSchema.nullable(),
  unit: nonEmptyStringSchema.nullable(),
  plannedStart: gateA3SourceIsoDateTimeSchema.nullable(),
  plannedEnd: gateA3SourceIsoDateTimeSchema.nullable(),
  updatedAt: gateA3SourceIsoDateTimeSchema,
  sourceRevision: nonEmptyStringSchema,
}).strict();

export const gateA3WorkOrderProgressSchema = z.object({
  schemaVersion: z.literal('work-order.progress/1'),
  planQty: finiteNonnegativeSchema.nullable(),
  completedQty: finiteNonnegativeSchema.nullable(),
  progressPct: finiteNonnegativeSchema.max(100).nullable(),
  calculationStatus: z.enum(['computed', 'missing_quantity', 'zero_plan', 'completed_exceeds_plan']),
}).strict().superRefine((progress, context) => {
  const expected = progress.planQty === null || progress.completedQty === null
    ? 'missing_quantity'
    : progress.planQty === 0
      ? 'zero_plan'
      : progress.completedQty > progress.planQty
        ? 'completed_exceeds_plan'
        : 'computed';
  const expectedPct = expected === 'computed'
    ? Number(((progress.completedQty! / progress.planQty!) * 100).toFixed(2))
    : null;
  if (progress.calculationStatus !== expected || progress.progressPct !== expectedPct) {
    context.addIssue({ code: 'custom', message: 'progress must be the deterministic projection of planQty and completedQty' });
  }
});

const evidenceFieldBase = {
  schemaVersion: z.literal('connector-evidence-field/1'),
  canonicalizationVersion: z.literal(GATE_A3_CANONICALIZATION_VERSION),
} as const;

export const gateA3ConnectorEvidenceFieldSchema = z.discriminatedUnion('fieldName', [
  z.object({ ...evidenceFieldBase, fieldName: z.literal('workOrderRef'), fieldType: z.literal('string'), canonicalValue: gateA3WorkOrderRefSchema }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('status'), fieldType: z.literal('string'), canonicalValue: nonEmptyStringSchema }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('sourceRevision'), fieldType: z.literal('string'), canonicalValue: nonEmptyStringSchema }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('planQty'), fieldType: z.literal('number_or_null'), canonicalValue: finiteNonnegativeSchema.nullable() }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('completedQty'), fieldType: z.literal('number_or_null'), canonicalValue: finiteNonnegativeSchema.nullable() }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('unit'), fieldType: z.literal('string_or_null'), canonicalValue: nonEmptyStringSchema.nullable() }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('plannedStart'), fieldType: z.literal('datetime_or_null'), canonicalValue: gateA3SourceIsoDateTimeSchema.nullable() }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('plannedEnd'), fieldType: z.literal('datetime_or_null'), canonicalValue: gateA3SourceIsoDateTimeSchema.nullable() }).strict(),
  z.object({ ...evidenceFieldBase, fieldName: z.literal('updatedAt'), fieldType: z.literal('datetime'), canonicalValue: gateA3SourceIsoDateTimeSchema }).strict(),
]);

export const gateA3ConnectorInvocationTokenClaimsSchema = z.object({
  schemaVersion: z.literal('connector-invocation-token/1'),
  iss: z.literal('geneway-control-plane'),
  aud: z.literal('gearjob-work-order-status-connector'),
  tenantId: opaqueIdSchema,
  principal: opaqueIdSchema,
  taskId: opaqueIdSchema,
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  stepId: z.literal('fetch_authorized_status'),
  attemptId: opaqueIdSchema,
  effectId: opaqueIdSchema,
  connectorInvocationId: z.string().uuid(),
  connectorQuerySpecHash: sha256Schema,
  connectorProfileVersion: z.literal(GATE_A3_CONNECTOR_PROFILE_VERSION),
  workOrderRefHash: sha256Schema,
  fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
  resourceContextDigest: sha256Schema,
  deadline: gateA3IsoDateTimeSchema,
  fence: z.number().int().positive(),
  jti: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict().superRefine((claims, context) => {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 60) {
    context.addIssue({ code: 'custom', path: ['exp'], message: 'connector token TTL must not exceed 60 seconds' });
  }
});

const currentAuthorityIdentityShape = {
  tenantId: opaqueIdSchema,
  principal: opaqueIdSchema,
  taskId: opaqueIdSchema,
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  stepId: z.literal('fetch_authorized_status'),
  attemptId: opaqueIdSchema,
  effectId: opaqueIdSchema,
  connectorInvocationId: z.string().uuid(),
  connectorQuerySpecHash: sha256Schema,
  connectorProfileVersion: z.literal(GATE_A3_CONNECTOR_PROFILE_VERSION),
  workOrderRefHash: sha256Schema,
  fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
  resourceContextDigest: sha256Schema,
  deadline: gateA3IsoDateTimeSchema,
  fence: z.number().int().positive(),
  jti: z.string().uuid(),
} as const;

export const gateA3ConnectorCurrentAuthorityRequestSchema = z.object({
  schemaVersion: z.literal('gate-a3-connector-current-authority-request/1'),
  invocationToken: z.string().min(40).max(8_192),
  gatewayRequestDigest: sha256Schema,
}).strict();

export const gateA3ConnectorCurrentAuthorityResponseSchema = z.discriminatedUnion('active', [
  z.object({
    schemaVersion: z.literal('gate-a3-connector-current-authority-response/1'),
    active: z.literal(true),
    checkedAt: gateA3IsoDateTimeSchema,
    ...currentAuthorityIdentityShape,
  }).strict(),
  z.object({
    schemaVersion: z.literal('gate-a3-connector-current-authority-response/1'),
    active: z.literal(false),
  }).strict(),
]);

export const gateA3ConnectorGatewayRequestSchema = z.object({
  schemaVersion: z.literal('gate-a3-connector-gateway-request/1'),
  invocationToken: z.string().min(40).max(8_192),
  querySpec: gateA3ConnectorQuerySpecSchema,
  querySpecHash: sha256Schema,
}).strict();

export const gateA3ConnectorErrorClassSchema = z.enum([
  'CONNECTOR_AUTH_FAILED',
  'CONNECTOR_RATE_LIMITED',
  'CONNECTOR_ROUTE_UNAVAILABLE',
  'CONNECTOR_TIMEOUT',
  'CONNECTOR_PROTOCOL_VIOLATION',
  'CONNECTOR_NOT_FOUND_OR_FORBIDDEN',
]);

const gatewayReceiptCommonShape = {
  schemaVersion: z.literal('gate-a3-connector-gateway-receipt/1'),
  issuer: z.literal('geneway-connector-gateway'),
  audience: z.literal('geneway-control-plane'),
  receiptJti: opaqueIdSchema,
  ...currentAuthorityIdentityShape,
  issuedAt: gateA3IsoDateTimeSchema,
} as const;

export const gateA3ConnectorGatewayReceiptPayloadSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...gatewayReceiptCommonShape,
    outcome: z.literal('completed'),
    responseRefMatched: z.literal(true),
    sourceRevision: nonEmptyStringSchema,
    responseCanonicalHash: sha256Schema,
  }).strict(),
  z.object({
    ...gatewayReceiptCommonShape,
    outcome: gateA3ConnectorErrorClassSchema,
    responseRefMatched: z.boolean().nullable(),
    sourceRevision: z.null(),
    responseCanonicalHash: z.null(),
    retryNotBefore: gateA3IsoDateTimeSchema.optional(),
  }).strict(),
]);

export const gateA3ConnectorGatewayReceiptSchema = z.object({
  payload: gateA3ConnectorGatewayReceiptPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export const gateA3ConnectorSourceSnapshotSchema = z.object({
  schemaVersion: z.literal('connector-source-snapshot/1'),
  canonicalizationVersion: z.literal(GATE_A3_CANONICALIZATION_VERSION),
  connectorSourceSnapshotId: opaqueIdSchema,
  tenantId: opaqueIdSchema,
  principal: opaqueIdSchema,
  taskId: opaqueIdSchema,
  connectorInvocationId: opaqueIdSchema,
  effectId: opaqueIdSchema,
  attemptId: opaqueIdSchema,
  fence: z.number().int().positive(),
  connectorQuerySpecHash: sha256Schema,
  workOrderRefHash: sha256Schema,
  responseRefMatched: z.literal(true),
  fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
  sourceRevision: nonEmptyStringSchema,
  sourceAsOf: gateA3SourceIsoDateTimeSchema,
  canonicalAllowlistedPayload: gateA3ConnectorWorkOrderResponseSchema,
  canonicalAllowlistedPayloadHash: sha256Schema,
  resourceScope: z.literal('gearjob-work-order:connector-query-spec-bound'),
  dataClass: z.enum(['C0', 'C1']),
  audience: z.object({ tenantId: opaqueIdSchema, principal: opaqueIdSchema }).strict(),
  createdAt: gateA3IsoDateTimeSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.sourceRevision !== snapshot.canonicalAllowlistedPayload.sourceRevision
    || snapshot.sourceAsOf !== snapshot.canonicalAllowlistedPayload.updatedAt
    || snapshot.tenantId !== snapshot.audience.tenantId
    || snapshot.principal !== snapshot.audience.principal) {
    context.addIssue({ code: 'custom', message: 'snapshot authority must match the canonical allowlisted payload and audience' });
  }
});

const connectorEvidenceLocatorBaseShape = {
  schemaVersion: z.literal('connector-evidence-locator/1'),
  connectorSourceSnapshotId: opaqueIdSchema,
  connectorInvocationId: opaqueIdSchema,
  effectId: opaqueIdSchema,
  connectorQuerySpecHash: sha256Schema,
  canonicalAllowlistedPayloadHash: sha256Schema,
  workOrderRefHash: sha256Schema,
  fieldMaskVersion: z.literal(GATE_A3_FIELD_MASK_VERSION),
  sourceRevision: nonEmptyStringSchema,
  sourceAsOf: gateA3SourceIsoDateTimeSchema,
} as const;

export const gateA3ConnectorEvidenceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    ...connectorEvidenceLocatorBaseShape,
    kind: z.literal('connector_snapshot_field'),
    field: gateA3ConnectorEvidenceFieldSchema,
    fieldHash: sha256Schema,
  }).strict(),
  z.object({
    ...connectorEvidenceLocatorBaseShape,
    kind: z.literal('connector_snapshot_whole'),
  }).strict(),
]);

const evidenceIdSchema = opaqueIdSchema;
const gateA3PublicEvidenceProjectionBaseShape = {
  id: evidenceIdSchema,
  kind: z.literal('connector_snapshot_field'),
  sourceRevision: nonEmptyStringSchema,
  sourceAsOf: gateA3SourceIsoDateTimeSchema,
  dataClass: z.enum(['C0', 'C1']),
  readOnly: z.literal(true),
} as const;
export const gateA3PublicEvidenceProjectionSchema = z.discriminatedUnion('fieldName', [
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('workOrderRef'), value: gateA3WorkOrderRefSchema }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('status'), value: nonEmptyStringSchema }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('sourceRevision'), value: nonEmptyStringSchema }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('planQty'), value: finiteNonnegativeSchema.nullable() }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('completedQty'), value: finiteNonnegativeSchema.nullable() }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('unit'), value: nonEmptyStringSchema.nullable() }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('plannedStart'), value: gateA3SourceIsoDateTimeSchema.nullable() }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('plannedEnd'), value: gateA3SourceIsoDateTimeSchema.nullable() }).strict(),
  z.object({ ...gateA3PublicEvidenceProjectionBaseShape,
    fieldName: z.literal('updatedAt'), value: gateA3SourceIsoDateTimeSchema }).strict(),
]);

export const gateA3EvidenceSourceRevocationInputSchema = z.object({
  reasonCode: z.literal('user_requested'),
}).strict();

export const gateA3EvidenceSourceRevocationResponseSchema = z.object({
  revoked: z.literal(true),
}).strict();

export const gateA3WorkOrderStatusCardSchema = z.object({
  schemaVersion: z.literal('WorkOrderStatusCard/1'),
  workOrderRef: gateA3WorkOrderRefSchema,
  status: nonEmptyStringSchema,
  planQty: finiteNonnegativeSchema.nullable(),
  completedQty: finiteNonnegativeSchema.nullable(),
  unit: nonEmptyStringSchema.nullable(),
  progressPct: finiteNonnegativeSchema.max(100).nullable(),
  updatedAt: gateA3SourceIsoDateTimeSchema,
  sourceAsOf: gateA3SourceIsoDateTimeSchema,
  evidenceRefs: z.object({
    status: evidenceIdSchema,
    planQty: evidenceIdSchema,
    completedQty: evidenceIdSchema,
    updatedAt: evidenceIdSchema,
    sourceAsOf: evidenceIdSchema,
  }).strict(),
  readOnly: z.literal(true),
}).strict().superRefine((card, context) => {
  const expectedProgress = card.planQty === null || card.completedQty === null
    || card.planQty === 0 || card.completedQty > card.planQty
    ? null
    : Number(((card.completedQty / card.planQty) * 100).toFixed(2));
  if (card.progressPct !== expectedProgress) {
    context.addIssue({ code: 'custom', path: ['progressPct'],
      message: 'card progress must be the deterministic projection of planQty and completedQty' });
  }
  if (card.sourceAsOf !== card.updatedAt) {
    context.addIssue({ code: 'custom', path: ['sourceAsOf'],
      message: 'card sourceAsOf must match the immutable snapshot updatedAt' });
  }
  if (card.evidenceRefs.sourceAsOf !== card.evidenceRefs.updatedAt) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs', 'sourceAsOf'],
      message: 'sourceAsOf must retain the updatedAt Evidence reference' });
  }
});

const gateA3ExplanationSourceFieldSchema = z.enum([
  'workOrderRef', 'status', 'planQty', 'completedQty', 'unit', 'plannedStart',
  'plannedEnd', 'updatedAt', 'sourceRevision', 'progressPct',
]);
const gateA3ExplanationStatementCommonShape = {
  id: opaqueIdSchema,
  text: z.string().min(1).max(2_000),
} as const;
const gateA3WorkOrderExplanationStatementSchema = z.object({
  ...gateA3ExplanationStatementCommonShape,
  kind: z.enum(['fact', 'inference', 'recommendation', 'unknown']),
  sourceFields: z.array(gateA3ExplanationSourceFieldSchema).max(10).describe(
    'fact requires at least one source field; unknown requires an empty array; '
    + 'a statement that references progressPct must also reference both planQty and completedQty; values must be unique.',
  ),
}).strict().describe(
  'One work-order explanation statement. Its id must be unique across the explanation and its sourceFields must be unique.',
).superRefine((statement, context) => {
  if (statement.kind === 'fact' && statement.sourceFields.length === 0) {
    context.addIssue({ code: 'custom', path: ['sourceFields'], message: 'fact statements require at least one source field' });
  }
  if (statement.kind === 'unknown' && statement.sourceFields.length !== 0) {
    context.addIssue({ code: 'custom', path: ['sourceFields'], message: 'unknown statements cannot claim a source field' });
  }
  if (statement.sourceFields.includes('progressPct')
    && (!statement.sourceFields.includes('planQty') || !statement.sourceFields.includes('completedQty'))) {
    context.addIssue({ code: 'custom', path: ['sourceFields'],
      message: 'progressPct statements must retain planQty and completedQty evidence' });
  }
});

export const gateA3WorkOrderExplanationSchema = z.object({
  schemaVersion: z.literal('work-order.explanation/1'),
  summary: z.string().min(1).max(2_000),
  statements: z.array(gateA3WorkOrderExplanationStatementSchema).min(1).max(16).describe(
    'All statement ids must be unique. Each statement sourceFields array must contain unique values.',
  ),
}).strict().superRefine((explanation, context) => {
  const ids = new Set<string>();
  explanation.statements.forEach((statement, index) => {
    if (ids.has(statement.id)) context.addIssue({ code: 'custom', path: ['statements', index, 'id'], message: 'statement ids must be unique' });
    ids.add(statement.id);
    if (new Set(statement.sourceFields).size !== statement.sourceFields.length) {
      context.addIssue({ code: 'custom', path: ['statements', index, 'sourceFields'], message: 'source fields must be unique' });
    }
  });
});

const gateA3WorkOrderModelAuthorityV1Shape = {
  tenantId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  executionAttemptId: opaqueIdSchema,
  taskFence: z.number().int().positive(),
  stepId: z.literal('explain_status'),
  stepAttemptId: opaqueIdSchema,
  stepFence: z.number().int().positive(),
  modelInvocationId: opaqueIdSchema,
  approvalSubjectDigest: sha256Schema,
  capabilityVersionId: z.literal('cap_production_work_order_status_v1_1'),
  effectId: opaqueIdSchema,
  connectorQuerySpecHash: sha256Schema,
  connectorSourceSnapshotId: opaqueIdSchema,
  connectorSourceSnapshotHash: sha256Schema,
  snapshotPayloadHash: sha256Schema,
  progressDigest: sha256Schema,
  resourceScope: z.literal('gearjob-work-order:connector-query-spec-bound'),
  snapshotAudience: nonEmptyStringSchema,
  logicalModelPolicy: z.literal('business.production.work-order-status.explanation'),
  promptPolicyVersionId: z.literal(GATE_A3_WORK_ORDER_PROMPT_POLICY_VERSION_ID),
  routeProfile: z.literal('codex_subscription_dev'),
  dataClass: z.enum(['C0', 'C1']),
  toolChoice: z.literal('none'),
  outputSchemaVersion: z.literal('work-order.explanation/1'),
  maxOutputTokens: z.number().int().positive().max(1_024),
  deadline: gateA3IsoDateTimeSchema,
} as const;

const gateA3WorkOrderModelAuthorityV2Shape = {
  ...gateA3WorkOrderModelAuthorityV1Shape,
  promptPolicyResolvedBytesSha256: sha256Schema,
} as const;

export const gateA3WorkOrderModelRequestV1Schema = z.object({
  schemaVersion: z.literal('gate-a3-work-order-model-request/1'),
  invocationToken: z.string().min(40).max(8_192),
  ...gateA3WorkOrderModelAuthorityV1Shape,
  snapshot: gateA3ConnectorWorkOrderResponseSchema,
  progress: gateA3WorkOrderProgressSchema,
}).strict();

export const gateA3WorkOrderModelRequestV2Schema = z.object({
  schemaVersion: z.literal('gate-a3-work-order-model-request/2'),
  invocationToken: z.string().min(40).max(8_192),
  ...gateA3WorkOrderModelAuthorityV2Shape,
  systemPrompt: z.string().min(1).max(16_384).refine(isWellFormedUnicode,
    'system prompt must contain valid Unicode scalar values'),
  snapshot: gateA3ConnectorWorkOrderResponseSchema,
  progress: gateA3WorkOrderProgressSchema,
}).strict();

export const gateA3WorkOrderModelRequestSchema = gateA3WorkOrderModelRequestV2Schema;

function enforceGateA3WorkOrderModelTokenTtl(
  claims: Readonly<{ iat: number; exp: number }>,
  context: z.RefinementCtx,
): void {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 60) {
    context.addIssue({ code: 'custom', path: ['exp'], message: 'work-order model token TTL must be in (0, 60] seconds' });
  }
}

export const gateA3WorkOrderModelTokenClaimsV1Schema = z.object({
  schemaVersion: z.literal('gate-a3-work-order-model-token/1'),
  iss: z.literal('geneway-control-plane'),
  aud: z.literal('local-model-gateway-work-order-explanation'),
  ...gateA3WorkOrderModelAuthorityV1Shape,
  jti: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict().superRefine(enforceGateA3WorkOrderModelTokenTtl);

export const gateA3WorkOrderModelTokenClaimsV2Schema = z.object({
  schemaVersion: z.literal('gate-a3-work-order-model-token/2'),
  iss: z.literal('geneway-control-plane'),
  aud: z.literal('local-model-gateway-work-order-explanation'),
  ...gateA3WorkOrderModelAuthorityV2Shape,
  jti: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict().superRefine(enforceGateA3WorkOrderModelTokenTtl);

export const gateA3WorkOrderModelTokenClaimsSchema = gateA3WorkOrderModelTokenClaimsV2Schema;

export const gateA3WorkOrderModelFailureClassSchema = z.enum([
  'MODEL_ROUTE_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_QUOTA', 'MODEL_TIMEOUT',
  'MODEL_STREAM_INTERRUPTED', 'MODEL_PROTOCOL_VIOLATION', 'MODEL_BUSY',
]);

export const gateA3WorkOrderTerminalErrorClassSchema = z.union([
  gateA3ConnectorErrorClassSchema,
  gateA3WorkOrderModelFailureClassSchema,
  z.enum(['WORK_ORDER_REF_INVALID', 'WORK_ORDER_PROTOCOL_VIOLATION']),
]);

const gateA3WorkOrderModelReceiptV1CommonShape = {
  schemaVersion: z.literal('gate-a3-work-order-model-receipt/1'),
  ...gateA3WorkOrderModelAuthorityV1Shape,
  issuer: z.literal('geneway-model-gateway'),
  audience: z.literal('geneway-control-plane-work-order'),
  receiptJti: z.string().uuid(),
  issuedAt: gateA3IsoDateTimeSchema,
} as const;
const gateA3WorkOrderModelReceiptV2CommonShape = {
  schemaVersion: z.literal('gate-a3-work-order-model-receipt/2'),
  ...gateA3WorkOrderModelAuthorityV2Shape,
  issuer: z.literal('geneway-model-gateway'),
  audience: z.literal('geneway-control-plane-work-order'),
  receiptJti: z.string().uuid(),
  issuedAt: gateA3IsoDateTimeSchema,
} as const;
const gateA3WorkOrderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict().superRefine((usage, context) => {
  if (usage.inputTokens + usage.outputTokens !== usage.totalTokens) {
    context.addIssue({ code: 'custom', path: ['totalTokens'], message: 'total tokens must equal input plus output tokens' });
  }
});

export const gateA3WorkOrderModelReceiptPayloadV1Schema = z.discriminatedUnion('outcome', [
  z.object({
    ...gateA3WorkOrderModelReceiptV1CommonShape,
    outcome: z.literal('completed'),
    outputPayloadDigest: sha256Schema,
    providerRevision: nonEmptyStringSchema,
    modelRevision: nonEmptyStringSchema,
    usage: gateA3WorkOrderUsageSchema,
  }).strict(),
  z.object({
    ...gateA3WorkOrderModelReceiptV1CommonShape,
    outcome: gateA3WorkOrderModelFailureClassSchema,
    outputPayloadDigest: z.null(),
    providerRevision: z.null(),
    modelRevision: z.null(),
    usage: z.null(),
    retryNotBefore: gateA3IsoDateTimeSchema.optional(),
  }).strict(),
]);

export const gateA3WorkOrderModelReceiptV1Schema = z.object({
  payload: gateA3WorkOrderModelReceiptPayloadV1Schema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export const gateA3WorkOrderModelReceiptPayloadV2Schema = z.discriminatedUnion('outcome', [
  z.object({
    ...gateA3WorkOrderModelReceiptV2CommonShape,
    outcome: z.literal('completed'),
    outputPayloadDigest: sha256Schema,
    providerRevision: nonEmptyStringSchema,
    modelRevision: nonEmptyStringSchema,
    usage: gateA3WorkOrderUsageSchema,
  }).strict(),
  z.object({
    ...gateA3WorkOrderModelReceiptV2CommonShape,
    outcome: gateA3WorkOrderModelFailureClassSchema,
    outputPayloadDigest: z.null(),
    providerRevision: z.null(),
    modelRevision: z.null(),
    usage: z.null(),
    retryNotBefore: gateA3IsoDateTimeSchema.optional(),
  }).strict(),
]);

export const gateA3WorkOrderModelReceiptV2Schema = z.object({
  payload: gateA3WorkOrderModelReceiptPayloadV2Schema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export const gateA3WorkOrderModelReceiptPayloadSchema = gateA3WorkOrderModelReceiptPayloadV2Schema;
export const gateA3WorkOrderModelReceiptSchema = gateA3WorkOrderModelReceiptV2Schema;

export const gateA3PublicTaskResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('work_order_status'),
    card: gateA3WorkOrderStatusCardSchema,
    explanation: gateA3WorkOrderExplanationSchema,
  }).strict(),
  z.object({
    kind: z.literal('failed'),
    code: gateA3WorkOrderTerminalErrorClassSchema,
    message: z.string().min(1).max(500),
  }).strict(),
  z.object({
    kind: z.literal('canceled'),
    code: z.literal('USER_CANCELED'),
    message: z.string().min(1).max(500),
  }).strict(),
]);

const gateA3PublicStepSchema = z.object({
  id: z.enum([
    'validate_work_order_ref', 'fetch_authorized_status', 'compute_progress',
    'explain_status', 'evidence_verify', 'publish_status_card',
  ]),
  kind: z.enum(['deterministic', 'agent', 'verification']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  attemptId: opaqueIdSchema.nullable(),
  fence: z.number().int().positive().nullable(),
}).strict().superRefine((step, context) => {
  if ((step.attemptId === null) !== (step.fence === null)) {
    context.addIssue({ code: 'custom', message: 'attemptId and fence must be projected together' });
  }
});

const gateA3PublicStepOrder = [
  ['validate_work_order_ref', 'deterministic'],
  ['fetch_authorized_status', 'deterministic'],
  ['compute_progress', 'deterministic'],
  ['explain_status', 'agent'],
  ['evidence_verify', 'verification'],
  ['publish_status_card', 'deterministic'],
] as const;

export const gateA3PublicWorkflowProjectionSchema = z.object({
  templateId: z.literal('workflow-template.work-order-status/1'),
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  steps: z.array(gateA3PublicStepSchema).length(6),
}).strict().superRefine((workflow, context) => {
  workflow.steps.forEach((step, index) => {
    const expected = gateA3PublicStepOrder[index];
    if (expected === undefined || step.id !== expected[0] || step.kind !== expected[1]) {
      context.addIssue({ code: 'custom', path: ['steps', index], message: 'public workflow must preserve the fixed six-node topology' });
    }
  });
});

export const gateA3PublicTaskSnapshotSchema = z.object({
  schemaVersion: z.literal('gate-a3-public-task-snapshot/1'),
  recordVariant: z.literal('business-task.work-order.live/1'),
  taskId: opaqueIdSchema,
  conversationId: opaqueIdSchema,
  capabilityId: z.literal('production.work-order-status.v1'),
  status: z.enum(['awaiting_approval', 'approved', 'queued', 'running', 'completed', 'failed', 'canceled']),
  inputRef: z.object({ kind: z.literal('work_order'), workOrderRef: gateA3WorkOrderRefSchema }).strict(),
  workflowVersionId: opaqueIdSchema,
  workflowHash: sha256Schema,
  workflow: gateA3PublicWorkflowProjectionSchema,
  approval: z.object({
    id: opaqueIdSchema,
    version: z.number().int().positive(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'invalidated']),
    subjectDigest: sha256Schema,
    expiresAt: gateA3IsoDateTimeSchema,
  }).strict(),
  connectorQuerySpecHash: sha256Schema,
  result: gateA3PublicTaskResultSchema.nullable(),
  createdAt: gateA3IsoDateTimeSchema,
  updatedAt: gateA3IsoDateTimeSchema,
}).strict().superRefine((snapshot, context) => {
  const terminal = snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'canceled';
  if (terminal !== (snapshot.result !== null)
    || (snapshot.status === 'completed' && snapshot.result?.kind !== 'work_order_status')
    || (snapshot.status === 'failed' && snapshot.result?.kind !== 'failed')
    || (snapshot.status === 'canceled' && snapshot.result?.kind !== 'canceled')) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'public result must match task terminal state' });
  }
  if (snapshot.workflowVersionId !== snapshot.workflow.workflowVersionId
    || snapshot.workflowHash !== snapshot.workflow.workflowHash) {
    context.addIssue({ code: 'custom', path: ['workflow'], message: 'public workflow identity must match the task authority' });
  }
});

export function canonicalizeGateA3Jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) throw new Error('JCS value contains an invalid Unicode scalar value');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS value contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeGateA3Jcs(item)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('JCS value contains a non-JSON value');
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).sort().map((key) => {
    if (!isWellFormedUnicode(key)) throw new Error('JCS object key contains an invalid Unicode scalar value');
    return `${JSON.stringify(key)}:${canonicalizeGateA3Jcs(object[key])}`;
  }).join(',')}}`;
}

export async function digestGateA3Jcs(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeGateA3Jcs(value));
  const stable = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stable).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stable);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestGateA3PromptPolicyResolvedBytes(systemPrompt: string): Promise<string> {
  if (systemPrompt.length === 0 || systemPrompt.length > 16_384 || !isWellFormedUnicode(systemPrompt)) {
    throw new Error('Gate A.3 resolved system prompt bytes are invalid');
  }
  const bytes = new TextEncoder().encode(systemPrompt);
  const stable = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stable).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stable);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type GateA3IsoDateTime = z.infer<typeof gateA3IsoDateTimeSchema>;
export type GateA3SourceIsoDateTime = z.infer<typeof gateA3SourceIsoDateTimeSchema>;
export type GateA3WorkOrderRef = z.infer<typeof gateA3WorkOrderRefSchema>;
export type GateA3CreateTaskInputVariant = z.infer<typeof gateA3CreateTaskInputVariantSchema>;
export type GateA3ConnectorQuerySpec = z.infer<typeof gateA3ConnectorQuerySpecSchema>;
export type GateA3ConnectorWorkOrderResponse = z.infer<typeof gateA3ConnectorWorkOrderResponseSchema>;
export type GateA3ConnectorEvidenceField = z.infer<typeof gateA3ConnectorEvidenceFieldSchema>;
export type GateA3ConnectorInvocationTokenClaims = z.infer<typeof gateA3ConnectorInvocationTokenClaimsSchema>;
export type GateA3ConnectorCurrentAuthorityRequest = z.infer<typeof gateA3ConnectorCurrentAuthorityRequestSchema>;
export type GateA3ConnectorCurrentAuthorityResponse = z.infer<typeof gateA3ConnectorCurrentAuthorityResponseSchema>;
export type GateA3ConnectorGatewayRequest = z.infer<typeof gateA3ConnectorGatewayRequestSchema>;
export type GateA3ConnectorGatewayReceiptPayload = z.infer<typeof gateA3ConnectorGatewayReceiptPayloadSchema>;
export type GateA3ConnectorGatewayReceipt = z.infer<typeof gateA3ConnectorGatewayReceiptSchema>;
export type GateA3ConnectorSourceSnapshot = z.infer<typeof gateA3ConnectorSourceSnapshotSchema>;
export type GateA3ConnectorEvidenceLocator = z.infer<typeof gateA3ConnectorEvidenceLocatorSchema>;
export type GateA3PublicEvidenceProjection = z.infer<typeof gateA3PublicEvidenceProjectionSchema>;
export type GateA3EvidenceSourceRevocationInput = z.infer<typeof gateA3EvidenceSourceRevocationInputSchema>;
export type GateA3EvidenceSourceRevocationResponse = z.infer<typeof gateA3EvidenceSourceRevocationResponseSchema>;
export type GateA3WorkOrderStatusCard = z.infer<typeof gateA3WorkOrderStatusCardSchema>;
export type GateA3WorkOrderExplanation = z.infer<typeof gateA3WorkOrderExplanationSchema>;
export type GateA3WorkOrderProgress = z.infer<typeof gateA3WorkOrderProgressSchema>;
export type GateA3WorkOrderModelRequestV1 = z.infer<typeof gateA3WorkOrderModelRequestV1Schema>;
export type GateA3WorkOrderModelRequest = z.infer<typeof gateA3WorkOrderModelRequestSchema>;
export type GateA3WorkOrderModelTokenClaimsV1 = z.infer<typeof gateA3WorkOrderModelTokenClaimsV1Schema>;
export type GateA3WorkOrderModelTokenClaims = z.infer<typeof gateA3WorkOrderModelTokenClaimsSchema>;
export type GateA3WorkOrderModelFailureClass = z.infer<typeof gateA3WorkOrderModelFailureClassSchema>;
export type GateA3WorkOrderTerminalErrorClass = z.infer<typeof gateA3WorkOrderTerminalErrorClassSchema>;
export type GateA3WorkOrderModelReceiptPayload = z.infer<typeof gateA3WorkOrderModelReceiptPayloadSchema>;
export type GateA3WorkOrderModelReceiptV1 = z.infer<typeof gateA3WorkOrderModelReceiptV1Schema>;
export type GateA3WorkOrderModelReceipt = z.infer<typeof gateA3WorkOrderModelReceiptSchema>;
export type GateA3PublicTaskResult = z.infer<typeof gateA3PublicTaskResultSchema>;
export type GateA3PublicWorkflowProjection = z.infer<typeof gateA3PublicWorkflowProjectionSchema>;
export type GateA3PublicTaskSnapshot = z.infer<typeof gateA3PublicTaskSnapshotSchema>;

export const gateA3WorkOrderJsonSchemas = Object.freeze({
  CreateTaskInputVariant: z.toJSONSchema(gateA3CreateTaskInputVariantSchema),
  ConnectorQuerySpec: z.toJSONSchema(gateA3ConnectorQuerySpecSchema),
  ConnectorWorkOrderResponse: z.toJSONSchema(gateA3ConnectorWorkOrderResponseSchema),
  ConnectorEvidenceField: z.toJSONSchema(gateA3ConnectorEvidenceFieldSchema),
  ConnectorInvocationTokenClaims: z.toJSONSchema(gateA3ConnectorInvocationTokenClaimsSchema),
  ConnectorCurrentAuthorityRequest: z.toJSONSchema(gateA3ConnectorCurrentAuthorityRequestSchema),
  ConnectorCurrentAuthorityResponse: z.toJSONSchema(gateA3ConnectorCurrentAuthorityResponseSchema),
  ConnectorGatewayRequest: z.toJSONSchema(gateA3ConnectorGatewayRequestSchema),
  ConnectorGatewayReceipt: z.toJSONSchema(gateA3ConnectorGatewayReceiptSchema),
  ConnectorSourceSnapshot: z.toJSONSchema(gateA3ConnectorSourceSnapshotSchema),
  ConnectorEvidenceLocator: z.toJSONSchema(gateA3ConnectorEvidenceLocatorSchema),
  PublicEvidenceProjection: z.toJSONSchema(gateA3PublicEvidenceProjectionSchema),
  EvidenceSourceRevocationInput: z.toJSONSchema(gateA3EvidenceSourceRevocationInputSchema),
  EvidenceSourceRevocationResponse: z.toJSONSchema(gateA3EvidenceSourceRevocationResponseSchema),
  WorkOrderStatusCard: z.toJSONSchema(gateA3WorkOrderStatusCardSchema),
  WorkOrderExplanation: z.toJSONSchema(gateA3WorkOrderExplanationSchema),
  WorkOrderProgress: z.toJSONSchema(gateA3WorkOrderProgressSchema),
  WorkOrderModelRequestV1: z.toJSONSchema(gateA3WorkOrderModelRequestV1Schema),
  WorkOrderModelRequest: z.toJSONSchema(gateA3WorkOrderModelRequestSchema),
  WorkOrderModelTokenClaimsV1: z.toJSONSchema(gateA3WorkOrderModelTokenClaimsV1Schema),
  WorkOrderModelTokenClaims: z.toJSONSchema(gateA3WorkOrderModelTokenClaimsSchema),
  WorkOrderModelReceiptV1: z.toJSONSchema(gateA3WorkOrderModelReceiptV1Schema),
  WorkOrderModelReceipt: z.toJSONSchema(gateA3WorkOrderModelReceiptSchema),
  WorkOrderTerminalErrorClass: z.toJSONSchema(gateA3WorkOrderTerminalErrorClassSchema),
  PublicWorkflowProjection: z.toJSONSchema(gateA3PublicWorkflowProjectionSchema),
  PublicTaskSnapshot: z.toJSONSchema(gateA3PublicTaskSnapshotSchema),
});
