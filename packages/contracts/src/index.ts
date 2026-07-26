import { z } from 'zod';
import { gateALiveTaskListItemSchema, gateALiveWorkflowListItemSchema } from './gate-a-public.js';

const sha256ValueSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const businessExceptionTypeSchema = z.enum(['capacity_progress_lag', 'equipment_alarm']);
export type BusinessExceptionType = z.infer<typeof businessExceptionTypeSchema>;

export const businessExceptionFixtureVersionSchema = z.enum([
  'gate0.2b-capacity-lag/1',
  'gate0.2b-equipment-alarm/1',
]);

export const resourceExceptionAudienceSchema = z.object({
  kind: z.literal('resource_exception'),
  businessExceptionId: z.string().min(1),
  resourceScope: z.string().min(1),
  dataClass: z.literal('C1'),
}).strict();

export const privateConversationAudienceSchema = z.object({
  kind: z.literal('private_conversation'),
  conversationId: z.string().min(1),
}).strict();

export const exceptionAudienceSchema = z.discriminatedUnion('kind', [
  resourceExceptionAudienceSchema,
  privateConversationAudienceSchema,
]);

export type ExceptionAudience = z.infer<typeof exceptionAudienceSchema>;

export const businessExceptionRefSchema = z.object({
  exceptionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  sourceSystem: z.literal('fixture-manufacturing'),
  exceptionType: businessExceptionTypeSchema,
  sourceObjectRef: z.string().min(1),
  detectionWindow: z.string().min(1),
  fixtureVersion: businessExceptionFixtureVersionSchema,
  fixtureSha256: sha256ValueSchema,
  canonicalizationVersion: z.literal('rfc8785-jcs/1'),
  resourceScope: z.string().min(1),
  dataClass: z.literal('C1'),
}).strict();

export type BusinessExceptionRef = z.infer<typeof businessExceptionRefSchema>;

export const businessExceptionSourceSnapshotSchema = z.object({
  businessExceptionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  canonicalBytes: z.string().min(1),
  canonicalSha256: sha256ValueSchema,
  canonicalizationVersion: z.literal('rfc8785-jcs/1'),
  fixtureVersion: businessExceptionFixtureVersionSchema,
  sourceSystem: z.literal('fixture-manufacturing'),
  sourceObjectRef: z.string().min(1),
  detectionWindow: z.string().min(1),
  resourceScope: z.string().min(1),
  dataClass: z.literal('C1'),
  audience: resourceExceptionAudienceSchema,
}).strict();

export type BusinessExceptionSourceSnapshot = z.infer<typeof businessExceptionSourceSnapshotSchema>;

export const simulationEnvelopeSchema = z.object({
  simulation: z.literal(true),
  runtimeMode: z.literal('fake'),
  businessDecisionAllowed: z.literal(false),
}).strict();

export type SimulationEnvelope = z.infer<typeof simulationEnvelopeSchema>;

export const SIMULATION_ENVELOPE = Object.freeze({
  simulation: true,
  runtimeMode: 'fake',
  businessDecisionAllowed: false,
} satisfies SimulationEnvelope);

export const expertTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('expert'), expertId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('team'), teamId: z.string().min(1) }).strict(),
]);

export type ExpertTarget = z.infer<typeof expertTargetSchema>;

export const taskInputRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixture'),
    fixtureRef: z.literal('fixture:solution-analysis:v1'),
  }).strict(),
  z.object({
    kind: z.literal('document_snapshot'),
    documentSnapshotId: z.string().min(1),
  }).strict(),
]);

export type TaskInputRef = z.infer<typeof taskInputRefSchema>;

export const resolvedTaskInputRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixture'),
    fixtureRef: z.literal('fixture:solution-analysis:v1'),
    fixtureVersion: z.literal(1),
  }).strict(),
  z.object({
    kind: z.literal('document_snapshot'),
    documentSnapshotId: z.string().min(1),
    artifactId: z.string().min(1),
    manifestId: z.string().min(1),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    simulationProfile: z.literal('solution-analysis-demo/v2'),
    profileRegistryVersion: z.literal('gate0.2a-profile-registry/1'),
    resourceScope: z.string().min(1),
    dataClass: z.literal('C1'),
    audience: z.string().startsWith('conversation:'),
  }).strict(),
  z.object({
    kind: z.literal('business_exception_snapshot'),
    businessExceptionId: z.string().min(1),
    sourceVersionId: z.string().min(1),
    sourceSha256: sha256ValueSchema,
    canonicalizationVersion: z.literal('rfc8785-jcs/1'),
    fixtureVersion: businessExceptionFixtureVersionSchema,
    sourceSystem: z.literal('fixture-manufacturing'),
    sourceObjectRef: z.string().min(1),
    detectionWindow: z.string().min(1),
    resourceScope: z.string().min(1),
    dataClass: z.literal('C1'),
    sourceAudience: resourceExceptionAudienceSchema,
    taskAudience: privateConversationAudienceSchema,
  }).strict(),
]);

export type ResolvedTaskInputRef = z.infer<typeof resolvedTaskInputRefSchema>;

const normalizedCreateTaskInputSchema = z.object({
  conversationId: z.string().min(1),
  capabilityId: z.literal('solution.analysis.v1'),
  inputRef: taskInputRefSchema,
  expertTarget: expertTargetSchema,
}).strict();

export const createTaskInputSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const input = raw as Readonly<Record<string, unknown>>;
  if (input.inputRef !== undefined || input.fixtureRef !== 'fixture:solution-analysis:v1') return raw;
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'fixtureRef'));
  return { ...rest, inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' } };
}, normalizedCreateTaskInputSchema);

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const principalSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  trust: z.literal('trusted-local'),
}).strict();

export type Principal = z.infer<typeof principalSchema>;

export const taskResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    summary: z.string(),
    stepSummaries: z.array(z.string()),
  }).extend(simulationEnvelopeSchema.shape).strict(),
  z.object({
    kind: z.literal('failed'),
    code: z.string().min(1),
    message: z.string().min(1),
  }).extend(simulationEnvelopeSchema.shape).strict(),
  z.object({
    kind: z.literal('canceled'),
    code: z.literal('USER_CANCELED'),
    message: z.string().min(1),
  }).extend(simulationEnvelopeSchema.shape).strict(),
]);

export type TaskResult = z.infer<typeof taskResultSchema>;

export const businessExceptionSnapshotEvidenceSourceSchema = z.object({
  kind: z.literal('business_exception_snapshot'),
  businessExceptionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  sourceSha256: sha256ValueSchema,
  canonicalizationVersion: z.literal('rfc8785-jcs/1'),
  jsonPointer: z.string().startsWith('/'),
  valueSha256: sha256ValueSchema,
}).strict();

export const evidenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('legacy_fixture'),
    fixtureRef: z.literal('fixture:solution-analysis:v1'),
    fixtureVersion: z.literal(1),
    sourceId: z.string().min(1),
    excerptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal('document_snapshot'),
    documentSnapshotId: z.string().min(1),
    artifactId: z.string().min(1),
    startByte: z.number().int().nonnegative(),
    endByteExclusive: z.number().int().positive(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    excerptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    extractionVersion: z.literal('raw-utf8-byte-range/1'),
  }).strict(),
  businessExceptionSnapshotEvidenceSourceSchema,
]);

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceProjectionSchema = z.object({
  id: z.string().min(1),
  source: evidenceSourceSchema,
  excerpt: z.string().min(1).nullable(),
  excerptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resourceScope: z.string().min(1),
  dataClass: z.literal('C1'),
  audience: privateConversationAudienceSchema,
  lineageRecordIds: z.array(z.string().min(1)),
}).strict();

export type EvidenceProjection = z.infer<typeof evidenceProjectionSchema>;

export const artifactMediaTypeSchema = z.enum([
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const taskArtifactProjectionSchema = z.object({
  id: z.string().min(1),
  manifestId: z.string().min(1),
  kind: z.enum(['source_document', 'simulation_report']),
  displayName: z.string().min(1),
  mediaType: artifactMediaTypeSchema,
  sizeBytes: z.number().int().positive().max(1_048_576),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadUrl: z.string().startsWith('/api/artifacts/'),
  lineageRecordIds: z.array(z.string().min(1)),
}).strict();

export type TaskArtifactProjection = z.infer<typeof taskArtifactProjectionSchema>;

export const lineageProjectionSchema = z.object({
  id: z.string().min(1),
  fromKind: z.string().min(1),
  fromId: z.string().min(1),
  toKind: z.string().min(1),
  toId: z.string().min(1),
  relation: z.string().min(1),
}).strict();

export type LineageProjection = z.infer<typeof lineageProjectionSchema>;

export const taskStatusSchema = z.enum([
  'awaiting_approval',
  'approved',
  'rejected',
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
]);

export const paginationCursorSchema = z.string().min(32).max(2_048);
export const eventCursorSchema = z.coerce.number().int().nonnegative();

const listMetadataSchema = z.object({
  nextCursor: paginationCursorSchema.nullable(),
  asOf: z.string().datetime(),
}).strict();

export const businessExceptionStatusSchema = z.enum(['open', 'acknowledged']);
export const businessExceptionSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export const businessExceptionListQuerySchema = z.object({
  status: businessExceptionStatusSchema.optional(),
  severity: businessExceptionSeveritySchema.optional(),
  exceptionType: businessExceptionTypeSchema.optional(),
  resourceScope: z.string().min(1).optional(),
  sort: z.enum(['detectedAt', 'severity']).default('detectedAt'),
  direction: z.literal('desc').default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: paginationCursorSchema.optional(),
}).strict();

export type BusinessExceptionListQuery = z.infer<typeof businessExceptionListQuerySchema>;

export const businessExceptionListItemSchema = z.object({
  id: z.string().min(1),
  exceptionType: businessExceptionTypeSchema,
  summary: z.string().min(1),
  severity: businessExceptionSeveritySchema,
  status: businessExceptionStatusSchema,
  resourceScope: z.string().min(1),
  dataClass: z.literal('C1'),
  detectedAt: z.string().datetime(),
  aggregateVersion: z.number().int().positive(),
  simulation: z.literal(true),
}).strict();

export type BusinessExceptionListItem = z.infer<typeof businessExceptionListItemSchema>;

export const businessExceptionListResponseSchema = z.object({
  exceptions: z.array(businessExceptionListItemSchema),
  ...listMetadataSchema.shape,
  queryVersion: z.literal('business-exceptions.list.v1'),
}).strict();

export type BusinessExceptionListResponse = z.infer<typeof businessExceptionListResponseSchema>;

const jsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const exceptionSourceProjectionSchema = z.object({
  sourceVersionId: z.string().min(1),
  sourceSha256: sha256ValueSchema,
  canonicalizationVersion: z.literal('rfc8785-jcs/1'),
  jsonPointer: z.string().startsWith('/'),
  value: jsonScalarSchema,
  valueSha256: sha256ValueSchema,
}).strict();

export type ExceptionSourceProjection = z.infer<typeof exceptionSourceProjectionSchema>;

export const businessExceptionDetailSchema = businessExceptionListItemSchema.extend({
  sourceObjectRef: z.string().min(1),
  detectionWindow: z.string().min(1),
  acknowledgedAt: z.string().datetime().nullable(),
  ownerDisplayState: z.enum(['unassigned', 'mine', 'assigned']),
  analysisDisplayState: z.enum(['not_requested', 'task_bound']),
  evidence: z.array(exceptionSourceProjectionSchema),
}).strict();

export type BusinessExceptionDetail = z.infer<typeof businessExceptionDetailSchema>;

export const acknowledgeBusinessExceptionInputSchema = z.object({
  aggregateVersion: z.number().int().positive(),
}).strict();

export type AcknowledgeBusinessExceptionInput = z.infer<typeof acknowledgeBusinessExceptionInputSchema>;

export const createExceptionAnalysisTaskInputSchema = z.object({
  aggregateVersion: z.number().int().positive(),
  requestedExpertTarget: expertTargetSchema,
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type CreateExceptionAnalysisTaskInput = z.infer<typeof createExceptionAnalysisTaskInputSchema>;

export const createExceptionAnalysisTaskResponseSchema = z.object({
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  workflowVersion: z.object({
    id: z.string().min(1),
    hash: sha256ValueSchema,
  }).strict(),
  approvalSubjectDigest: sha256ValueSchema,
  simulation: z.literal(true),
}).strict();

export type CreateExceptionAnalysisTaskResponse = z.infer<typeof createExceptionAnalysisTaskResponseSchema>;

export const businessTaskCapabilityIdSchema = z.enum(['solution.analysis.v1', 'operations.exception-assist.v1']);

export const taskListItemSchema = z.object({
  id: z.string().min(1),
  capabilityId: businessTaskCapabilityIdSchema,
  status: taskStatusSchema,
  title: z.enum(['方案分析', '异常分析']),
  conversationId: z.string().min(1),
  workflowVersion: z.object({
    id: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  aggregateVersion: z.number().int().positive(),
  simulation: z.literal(true),
}).strict();

export type TaskListItem = z.infer<typeof taskListItemSchema>;

export const taskListResponseSchema = z.object({
  tasks: z.array(z.union([taskListItemSchema, gateALiveTaskListItemSchema])),
  ...listMetadataSchema.shape,
  queryVersion: z.literal('business-tasks.list.v1'),
}).strict();

export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  capabilityId: businessTaskCapabilityIdSchema.optional(),
  sort: z.enum(['createdAt', 'updatedAt']).default('updatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: paginationCursorSchema.optional(),
}).strict();

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const taskSnapshotSchema = z.object({
  id: z.string(),
  capabilityId: businessTaskCapabilityIdSchema,
  title: z.enum(['方案分析', '异常分析']),
  conversationId: z.string(),
  status: taskStatusSchema,
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  inputRef: resolvedTaskInputRefSchema,
  workflowVersion: z.object({ id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  approval: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(['pending', 'approved', 'rejected']),
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  expertTarget: expertTargetSchema,
  steps: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  }).strict()),
  claims: z.array(z.object({
    id: z.string(),
    text: z.string(),
    status: z.enum(['published', 'rejected']),
    evidenceRefId: z.string().nullable(),
    rejectionCode: z.string().nullable(),
  }).strict()),
  evidence: z.array(z.object({
    ...evidenceProjectionSchema.shape,
  }).strict()),
  artifacts: z.array(taskArtifactProjectionSchema),
  lineage: z.array(lineageProjectionSchema),
  result: taskResultSchema.nullable(),
  aggregateVersion: z.number().int().positive(),
  eventWatermark: z.number().int().nonnegative(),
}).extend(simulationEnvelopeSchema.shape).strict();

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

const taskEventCommonShape = {
  cursor: eventCursorSchema,
  id: z.string().min(1),
  businessTaskId: z.string().min(1),
  sequence: z.number().int().positive(),
  aggregateVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  ...simulationEnvelopeSchema.shape,
};

export const taskEventProjectionSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('business_task.created'),
    payload: z.object({
      approvalId: z.string().min(1),
      workflowVersionId: z.string().min(1),
      workflowHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('approval.decided'),
    payload: z.object({
      approvalId: z.string().min(1),
      decision: z.enum(['approved', 'rejected']),
    }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('workflow.execute.requested'),
    payload: z.object({
      workflowVersionId: z.string().min(1),
      workflowHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('workflow.run_started'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('workflow.run_reclaimed'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('workflow.step_started'),
    payload: z.object({ stepId: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('workflow.step_completed'),
    payload: z.object({ stepId: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('business_task.completed'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('business_task.failed'),
    payload: z.object({ code: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...taskEventCommonShape,
    eventType: z.literal('business_task.canceled'),
    payload: z.object({ reasonCode: z.string().min(1) }).strict(),
  }).strict(),
]);

export type TaskEventProjection = z.infer<typeof taskEventProjectionSchema>;

export const taskEventListResponseSchema = z.object({
  events: z.array(taskEventProjectionSchema),
}).strict();

export type TaskEventListResponse = z.infer<typeof taskEventListResponseSchema>;

export const approvalProjectionSchema = z.object({
  id: z.string().min(1),
  businessTaskId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(['pending', 'approved', 'rejected']),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ApprovalProjection = z.infer<typeof approvalProjectionSchema>;

export const executeTaskInputSchema = z.object({
  expectedApprovalVersion: z.number().int().positive(),
  expectedApprovalSubjectDigest: sha256ValueSchema,
}).strict();

export type ExecuteTaskInput = z.infer<typeof executeTaskInputSchema>;

export const conversationProjectionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  latestTaskId: z.string().min(1).nullable(),
  messages: z.array(z.object({
    id: z.string().min(1),
    author: z.enum(['user', 'xiaowei']),
    body: z.string(),
    status: z.enum(['completed', 'streaming', 'failed', 'canceled']).default('completed'),
    contentVersion: z.number().int().nonnegative().default(0),
    createdAt: z.string().datetime(),
  }).strict()),
  latestModelInvocation: z.object({
    id: z.string().min(1),
    assistantMessageId: z.string().min(1),
    status: z.enum(['pending', 'running', 'completed', 'cancel_requested', 'canceled', 'failed']),
    errorClass: z.enum([
      'MODEL_ROUTE_UNAVAILABLE',
      'MODEL_AUTH_FAILED',
      'MODEL_QUOTA',
      'MODEL_TIMEOUT',
      'MODEL_STREAM_INTERRUPTED',
      'MODEL_PROTOCOL_VIOLATION',
      'CHAT_BUSY',
    ]).nullable(),
    lastEventCursor: eventCursorSchema,
    createdAt: z.string().datetime(),
    terminalAt: z.string().datetime().nullable(),
  }).strict().nullable().default(null),
  eventWatermark: eventCursorSchema.default(0),
}).strict();

export type ConversationProjection = z.infer<typeof conversationProjectionSchema>;

export const chatErrorClassSchema = z.enum([
  'MODEL_ROUTE_UNAVAILABLE',
  'MODEL_AUTH_FAILED',
  'MODEL_QUOTA',
  'MODEL_TIMEOUT',
  'MODEL_STREAM_INTERRUPTED',
  'MODEL_PROTOCOL_VIOLATION',
  'CHAT_BUSY',
]);

export type ChatErrorClass = z.infer<typeof chatErrorClassSchema>;

const modelGatewayReceiptCommonShape = {
  schemaVersion: z.literal('model-gateway-receipt/1'),
  issuer: z.literal('geneway-model-gateway'),
  audience: z.literal('geneway-control-plane'),
  receiptJti: z.string().uuid(),
  conversationId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  fence: z.number().int().positive(),
  issuedAt: z.string().datetime(),
};

export const modelGatewayReceiptPayloadSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...modelGatewayReceiptCommonShape,
    outcome: z.literal('completed'),
    providerRevision: z.string().min(1).max(200),
    modelRevision: z.string().min(1).max(200),
    usage: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    ...modelGatewayReceiptCommonShape,
    outcome: chatErrorClassSchema,
    providerRevision: z.string().min(1).max(200).nullable(),
    modelRevision: z.string().min(1).max(200).nullable(),
    usage: z.null(),
    retryNotBefore: z.string().datetime().optional(),
  }).strict(),
]);

export const modelGatewayReceiptSchema = z.object({
  payload: modelGatewayReceiptPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export type ModelGatewayReceiptPayload = z.infer<typeof modelGatewayReceiptPayloadSchema>;
export type ModelGatewayReceipt = z.infer<typeof modelGatewayReceiptSchema>;

export const chatInvocationStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'cancel_requested',
  'canceled',
  'failed',
]);

const chatContentSchema = z.string().min(1).max(16 * 1024)
  .refine((value) => value.normalize('NFC').trim().length > 0, 'content must contain non-whitespace text')
  .refine((value) => !value.includes('\0'), 'content must not contain NUL')
  .refine((value) => new TextEncoder().encode(value.normalize('NFC').trim()).byteLength <= 16 * 1024, 'content exceeds 16 KiB');

export const createChatRunInputSchema = z.object({
  capabilityId: z.literal('xiaowei.chat.v1'),
  content: chatContentSchema,
  clientMessageId: z.string().min(1).max(200),
});

export type CreateChatRunInput = z.infer<typeof createChatRunInputSchema>;

export const chatRunProjectionSchema = z.object({
  conversationId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  eventCursor: eventCursorSchema,
  status: chatInvocationStatusSchema,
}).strict();

export type ChatRunProjection = z.infer<typeof chatRunProjectionSchema>;

const chatRunEventCommonShape = {
  schemaVersion: z.literal('chat-run-event/1'),
  eventId: z.string().min(1),
  cursor: eventCursorSchema,
  conversationId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
};

export const chatRunEventSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...chatRunEventCommonShape,
    eventType: z.literal('run.started'),
    status: z.literal('running'),
  }).strict(),
  z.object({
    ...chatRunEventCommonShape,
    eventType: z.literal('message.delta'),
    delta: z.string().min(1),
    checkpoint: z.string(),
    contentLength: z.number().int().nonnegative(),
    contentVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    ...chatRunEventCommonShape,
    eventType: z.literal('message.completed'),
    status: z.literal('completed'),
    checkpoint: z.string(),
    contentLength: z.number().int().nonnegative(),
    contentVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    ...chatRunEventCommonShape,
    eventType: z.literal('run.canceled'),
    status: z.literal('canceled'),
    reason: z.literal('USER_CANCELED'),
  }).strict(),
  z.object({
    ...chatRunEventCommonShape,
    eventType: z.literal('run.failed'),
    status: z.literal('failed'),
    errorClass: chatErrorClassSchema,
    retryNotBefore: z.string().datetime().optional(),
  }).strict(),
]);

export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;

export const chatRunEventListSchema = z.object({ events: z.array(chatRunEventSchema) }).strict();

export const cancelChatRunProjectionSchema = z.object({
  modelInvocationId: z.string().min(1),
  status: z.enum(['cancel_requested', 'canceled']),
  eventCursor: eventCursorSchema,
}).strict();

export type CancelChatRunProjection = z.infer<typeof cancelChatRunProjectionSchema>;

export const workflowListItemSchema = z.object({
  id: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  capabilityVersionId: z.string().min(1),
  harnessVersionId: z.string().min(1),
  createdAt: z.string().datetime(),
  simulation: z.literal(true),
}).strict();

export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;

export const workflowListResponseSchema = z.object({
  workflows: z.array(z.union([workflowListItemSchema, gateALiveWorkflowListItemSchema])),
  ...listMetadataSchema.shape,
  queryVersion: z.literal('workflow-versions.list.v1'),
}).strict();

export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;

export const workflowListQuerySchema = z.object({
  capabilityVersionId: z.enum(['cap_solution_analysis_v1_1', 'cap_operations_exception_assist_v1_shadow_1',
    'cap_solution_analysis_v1_live_1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: paginationCursorSchema.optional(),
}).strict();

export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;

const workflowNodeProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('deterministic'),
    handlerVersion: z.string().min(1),
    inputRefs: z.array(z.string()),
    outputSchemaId: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('agent'),
    capabilityVersionId: z.string().min(1),
    harnessVersionId: z.string().min(1),
    inputRefs: z.array(z.string()),
    outputSchemaId: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('verification'),
    policyVersion: z.string().min(1),
    inputRefs: z.array(z.string()),
    outputSchemaId: z.string().min(1),
  }).strict(),
]);

export const workflowDetailProjectionSchema = workflowListItemSchema.extend({
  compilerVersion: z.literal('geneway-workflow-compiler/0.1.0'),
  canonicalizationVersion: z.literal('RFC8785/JCS-1'),
  featureSet: z.literal('fixed-v1'),
  nodes: z.array(workflowNodeProjectionSchema),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
  permissionCeiling: z.object({
    actions: z.array(z.enum(['R0', 'R1', 'A1'])).min(1),
    resourceScopes: z.array(z.string().min(1)).min(1),
    dataClasses: z.array(z.enum(['C0', 'C1', 'C2'])).min(1),
  }).strict(),
}).strict();

export type WorkflowDetailProjection = z.infer<typeof workflowDetailProjectionSchema>;

export const sha256Schema = sha256ValueSchema;

export const artifactAudienceSchema = z.object({
  kind: z.literal('private-conversation'),
  conversationId: z.string().min(1),
}).strict();

export const documentSnapshotSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  manifestId: z.string().min(1),
  conversationId: z.string().min(1),
  displayName: z.string().min(1),
  mediaType: artifactMediaTypeSchema,
  sizeBytes: z.number().int().positive().max(1_048_576),
  contentSha256: sha256Schema,
  dataClass: z.literal('C1'),
  audience: artifactAudienceSchema,
  resourceScope: z.string().min(1),
  trust: z.literal('untrusted_text'),
  simulationProfile: z.literal('solution-analysis-demo/v2').nullable(),
  profileRegistryVersion: z.literal('gate0.2a-profile-registry/1'),
  createdAt: z.string().min(1),
}).strict();

export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;

export const artifactStateProjectionSchema = z.object({
  availability: z.enum(['active', 'missing', 'retained', 'deleted']),
  integrity: z.enum(['pending', 'verified', 'failed']),
  retentionStatus: z.enum(['active', 'expired', 'held', 'deleted']),
  reconcileStatus: z.enum(['in_sync', 'required']),
  stateVersion: z.number().int().positive(),
  downloadAllowed: z.boolean(),
}).strict();

export const documentSnapshotProjectionSchema = z.object({
  status: z.literal('available'),
  documentSnapshot: documentSnapshotSchema,
  artifactState: artifactStateProjectionSchema,
  downloadUrl: z.string().startsWith('/api/artifacts/'),
  executionEligibility: z.discriminatedUnion('eligible', [
    z.object({ eligible: z.literal(true) }).strict(),
    z.object({ eligible: z.literal(false), reason: z.literal('PROFILE_NOT_RECOGNIZED') }).strict(),
  ]),
}).strict();

export type DocumentSnapshotProjection = z.infer<typeof documentSnapshotProjectionSchema>;

export const artifactSummarySchema = z.object({
  id: z.string().min(1),
  manifestId: z.string().min(1),
  displayName: z.string().min(1),
  mediaType: artifactMediaTypeSchema,
  sizeBytes: z.number().int().positive().max(1_048_576),
  contentSha256: sha256Schema,
  availability: z.literal('active'),
  integrity: z.literal('verified'),
  downloadUrl: z.string().startsWith('/api/artifacts/'),
}).strict();

export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactIngestResponseSchema = z.object({
  ingest: z.object({ id: z.string().min(1), status: z.literal('ready'), stateVersion: z.number().int().positive() }).strict(),
  artifact: artifactSummarySchema,
  documentSnapshot: documentSnapshotSchema,
  executionEligibility: z.discriminatedUnion('eligible', [
    z.object({ eligible: z.literal(true) }).strict(),
    z.object({ eligible: z.literal(false), reason: z.literal('PROFILE_NOT_RECOGNIZED') }).strict(),
  ]),
}).strict();

export type ArtifactIngestResponse = z.infer<typeof artifactIngestResponseSchema>;

export const documentSnapshotListSchema = z.object({
  documentSnapshots: z.array(documentSnapshotProjectionSchema),
}).strict();

export type DocumentSnapshotList = z.infer<typeof documentSnapshotListSchema>;

export const executionLeaseSchema = z.object({
  eventId: z.string().min(1),
  deliveryId: z.string().min(1),
  attemptId: z.string().min(1),
  fencingToken: z.number().int().positive(),
}).strict();

export type ExecutionLease = z.infer<typeof executionLeaseSchema>;

export const workerDeliverySchema = z.object({
  tenantId: z.string().min(1),
  taskId: z.string().min(1),
  consumer: z.literal('gate0.2a-worker'),
  deploymentId: z.literal('gate0.2a-local'),
  workerInstanceId: z.string().min(1),
  lease: executionLeaseSchema,
  inputRef: resolvedTaskInputRefSchema,
  workflow: z.object({
    id: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    canonicalizationVersion: z.literal('RFC8785/JCS-1'),
    canonicalPayload: z.unknown(),
  }).strict(),
}).strict();

export type WorkerDelivery = z.infer<typeof workerDeliverySchema>;

const workerProtocolFields = {
  protocolVersion: z.literal('gate0.2a-worker-command/1'),
  workerInstanceId: z.string().min(1).max(200),
} as const;

const workerExecutionFields = {
  ...workerProtocolFields,
  deliveryId: z.string().min(1),
  eventId: z.string().min(1),
  attemptId: z.string().min(1),
  fencingToken: z.number().int().positive(),
} as const;

export const workerCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('session'),
    ...workerProtocolFields,
    consumer: z.literal('gate0.2a-worker'),
    deploymentId: z.literal('gate0.2a-local'),
  }).strict(),
  z.object({
    command: z.literal('claim_delivery'),
    ...workerProtocolFields,
    consumer: z.literal('gate0.2a-worker'),
    deploymentId: z.literal('gate0.2a-local'),
  }).strict(),
  z.object({ command: z.literal('read_input'), ...workerExecutionFields }).strict(),
  z.object({
    command: z.literal('claim_step'),
    ...workerExecutionFields,
    stepId: z.string().min(1),
    stepAttemptId: z.string().min(1),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
  z.object({
    command: z.literal('complete_step'),
    ...workerExecutionFields,
    stepId: z.string().min(1),
    stepAttemptId: z.string().min(1),
    stepFencingToken: z.number().int().positive(),
    output: z.unknown(),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
  z.object({
    command: z.literal('submit_candidate'),
    ...workerExecutionFields,
    candidate: z.lazy(() => attemptOutputCandidatePayloadSchema),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
  z.object({
    command: z.literal('fail_delivery'),
    ...workerExecutionFields,
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;

export const workerInputContentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixture'),
    inputRef: z.object({
      kind: z.literal('fixture'),
      fixtureRef: z.literal('fixture:solution-analysis:v1'),
      fixtureVersion: z.literal(1),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('document_snapshot'),
    inputRef: z.object({
      kind: z.literal('document_snapshot'),
      documentSnapshotId: z.string().min(1),
      artifactId: z.string().min(1),
      manifestId: z.string().min(1),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      simulationProfile: z.literal('solution-analysis-demo/v2'),
      profileRegistryVersion: z.literal('gate0.2a-profile-registry/1'),
      resourceScope: z.string().min(1),
      dataClass: z.literal('C1'),
      audience: z.string().startsWith('conversation:'),
    }).strict(),
    bytesBase64: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('business_exception_snapshot'),
    inputRef: z.object({
      kind: z.literal('business_exception_snapshot'),
      businessExceptionId: z.string().min(1),
      sourceVersionId: z.string().min(1),
      sourceSha256: sha256ValueSchema,
      canonicalizationVersion: z.literal('rfc8785-jcs/1'),
      fixtureVersion: businessExceptionFixtureVersionSchema,
      sourceSystem: z.literal('fixture-manufacturing'),
      sourceObjectRef: z.string().min(1),
      detectionWindow: z.string().min(1),
      resourceScope: z.string().min(1),
      dataClass: z.literal('C1'),
      sourceAudience: resourceExceptionAudienceSchema,
      taskAudience: privateConversationAudienceSchema,
    }).strict(),
    canonicalBytes: z.string().min(1),
  }).strict(),
]);

export type WorkerInputContent = z.infer<typeof workerInputContentSchema>;

export const documentEvidenceLocatorCandidateSchema = z.object({
  kind: z.literal('document_snapshot'),
  candidateKey: z.string().min(1).max(100),
  documentSnapshotId: z.string().min(1),
  startByte: z.number().int().nonnegative(),
  endByteExclusive: z.number().int().positive(),
}).strict();

export const legacyEvidenceLocatorCandidateSchema = z.object({
  kind: z.literal('legacy_fixture'),
  candidateKey: z.string().min(1).max(100),
  fixtureRef: z.literal('fixture:solution-analysis:v1'),
  fixtureVersion: z.literal(1),
  sourceId: z.string().min(1),
}).strict();

export const businessExceptionEvidenceLocatorCandidateSchema = z.object({
  kind: z.literal('business_exception_snapshot'),
  candidateKey: z.string().min(1).max(100),
  businessExceptionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  sourceSha256: sha256ValueSchema,
  canonicalizationVersion: z.literal('rfc8785-jcs/1'),
  jsonPointer: z.string().startsWith('/'),
  valueSha256: sha256ValueSchema,
}).strict();

export const evidenceLocatorCandidateSchema = z.discriminatedUnion('kind', [
  documentEvidenceLocatorCandidateSchema,
  legacyEvidenceLocatorCandidateSchema,
  businessExceptionEvidenceLocatorCandidateSchema,
]);

export type EvidenceLocatorCandidate = z.infer<typeof evidenceLocatorCandidateSchema>;

export const claimOutputCandidateSchema = z.object({
  candidateKey: z.string().min(1).max(100),
  text: z.string().min(1).max(2_000),
  evidenceCandidateKey: z.string().min(1).max(100).nullable(),
}).strict();

export type ClaimOutputCandidate = z.infer<typeof claimOutputCandidateSchema>;

export const attemptOutputCandidatePayloadSchema = z.object({
  evidence: z.array(evidenceLocatorCandidateSchema).max(8),
  claims: z.array(claimOutputCandidateSchema).min(1).max(16),
  result: taskResultSchema,
}).strict();

export type AttemptOutputCandidatePayload = z.infer<typeof attemptOutputCandidatePayloadSchema>;

export const workerCommandResponseSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('session'), ok: z.literal(true), result: z.object({ authenticated: z.literal(true) }).strict() }).strict(),
  z.object({ command: z.literal('claim_delivery'), ok: z.literal(true), result: workerDeliverySchema.nullable() }).strict(),
  z.object({ command: z.literal('read_input'), ok: z.literal(true), result: workerInputContentSchema }).strict(),
  z.object({
    command: z.literal('claim_step'),
    ok: z.literal(true),
    result: z.discriminatedUnion('state', [
      z.object({
        state: z.literal('claimed'),
        stepAttemptId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      }).strict(),
      z.object({ state: z.literal('completed'), output: z.unknown() }).strict(),
    ]),
  }).strict(),
  z.object({ command: z.literal('complete_step'), ok: z.literal(true), result: z.object({ accepted: z.literal(true) }).strict() }).strict(),
  z.object({ command: z.literal('submit_candidate'), ok: z.literal(true), result: z.object({ accepted: z.literal(true) }).strict() }).strict(),
  z.object({ command: z.literal('fail_delivery'), ok: z.literal(true), result: z.object({ accepted: z.literal(true) }).strict() }).strict(),
]);

export type WorkerCommandResponse = z.infer<typeof workerCommandResponseSchema>;

export const createTaskInputJsonSchema = z.toJSONSchema(createTaskInputSchema);
export const businessExceptionRefJsonSchema = z.toJSONSchema(businessExceptionRefSchema);
export const businessExceptionSourceSnapshotJsonSchema = z.toJSONSchema(businessExceptionSourceSnapshotSchema);
export const exceptionAudienceJsonSchema = z.toJSONSchema(exceptionAudienceSchema);
export const businessExceptionListQueryJsonSchema = z.toJSONSchema(businessExceptionListQuerySchema);
export const businessExceptionListResponseJsonSchema = z.toJSONSchema(businessExceptionListResponseSchema);
export const businessExceptionDetailJsonSchema = z.toJSONSchema(businessExceptionDetailSchema);
export const acknowledgeBusinessExceptionInputJsonSchema = z.toJSONSchema(acknowledgeBusinessExceptionInputSchema);
export const createExceptionAnalysisTaskInputJsonSchema = z.toJSONSchema(createExceptionAnalysisTaskInputSchema);
export const createExceptionAnalysisTaskResponseJsonSchema = z.toJSONSchema(createExceptionAnalysisTaskResponseSchema);
export const conversationProjectionJsonSchema = z.toJSONSchema(conversationProjectionSchema);
export const createChatRunInputJsonSchema = z.toJSONSchema(createChatRunInputSchema);
export const chatRunProjectionJsonSchema = z.toJSONSchema(chatRunProjectionSchema);
export const chatRunEventJsonSchema = z.toJSONSchema(chatRunEventSchema);
export const chatRunEventListJsonSchema = z.toJSONSchema(chatRunEventListSchema);
export const cancelChatRunProjectionJsonSchema = z.toJSONSchema(cancelChatRunProjectionSchema);
export const taskListQueryJsonSchema = z.toJSONSchema(taskListQuerySchema);
export const taskListResponseJsonSchema = z.toJSONSchema(taskListResponseSchema);
export const taskSnapshotJsonSchema = z.toJSONSchema(taskSnapshotSchema);
export const taskEventProjectionJsonSchema = z.toJSONSchema(taskEventProjectionSchema);
export const taskEventListResponseJsonSchema = z.toJSONSchema(taskEventListResponseSchema);
export const approvalProjectionJsonSchema = z.toJSONSchema(approvalProjectionSchema);
export const executeTaskInputJsonSchema = z.toJSONSchema(executeTaskInputSchema);
export const workflowListQueryJsonSchema = z.toJSONSchema(workflowListQuerySchema);
export const workflowListResponseJsonSchema = z.toJSONSchema(workflowListResponseSchema);
export const workflowDetailProjectionJsonSchema = z.toJSONSchema(workflowDetailProjectionSchema);
export const workerDeliveryJsonSchema = z.toJSONSchema(workerDeliverySchema);
export const workerInputContentJsonSchema = z.toJSONSchema(workerInputContentSchema);
export const workerCommandJsonSchema = z.toJSONSchema(workerCommandSchema);
export const workerCommandResponseJsonSchema = z.toJSONSchema(workerCommandResponseSchema);
export const attemptOutputCandidatePayloadJsonSchema = z.toJSONSchema(attemptOutputCandidatePayloadSchema);
export const evidenceLocatorCandidateJsonSchema = z.toJSONSchema(evidenceLocatorCandidateSchema);
export const evidenceSourceJsonSchema = z.toJSONSchema(evidenceSourceSchema);

export const gate02bPublicWireJsonSchemas = Object.freeze({
  BusinessExceptionRef: businessExceptionRefJsonSchema,
  BusinessExceptionSourceSnapshot: businessExceptionSourceSnapshotJsonSchema,
  ExceptionAudience: exceptionAudienceJsonSchema,
  BusinessExceptionListQuery: businessExceptionListQueryJsonSchema,
  BusinessExceptionListResponse: businessExceptionListResponseJsonSchema,
  BusinessExceptionDetail: businessExceptionDetailJsonSchema,
  AcknowledgeBusinessExceptionInput: acknowledgeBusinessExceptionInputJsonSchema,
  CreateExceptionAnalysisTaskInput: createExceptionAnalysisTaskInputJsonSchema,
  CreateExceptionAnalysisTaskResponse: createExceptionAnalysisTaskResponseJsonSchema,
  ConversationProjection: conversationProjectionJsonSchema,
  TaskListQuery: taskListQueryJsonSchema,
  TaskListResponse: taskListResponseJsonSchema,
  TaskSnapshot: taskSnapshotJsonSchema,
  TaskEventProjection: taskEventProjectionJsonSchema,
  TaskEventListResponse: taskEventListResponseJsonSchema,
  ApprovalProjection: approvalProjectionJsonSchema,
  ExecuteTaskInput: executeTaskInputJsonSchema,
  WorkflowListQuery: workflowListQueryJsonSchema,
  WorkflowListResponse: workflowListResponseJsonSchema,
  WorkflowDetailProjection: workflowDetailProjectionJsonSchema,
  WorkerDelivery: workerDeliveryJsonSchema,
  WorkerInputContent: workerInputContentJsonSchema,
  AttemptOutputCandidatePayload: attemptOutputCandidatePayloadJsonSchema,
  EvidenceLocatorCandidate: evidenceLocatorCandidateJsonSchema,
  EvidenceSource: evidenceSourceJsonSchema,
});

export class GenewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'GenewayError';
  }
}

export const isGenewayError = (value: unknown): value is GenewayError => value instanceof GenewayError;

export * from './gate-a.js';
export * from './gate-a-public.js';
export * from './gate-a-release.js';
