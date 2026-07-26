import { z } from 'zod';
import {
  gateAAnalysisErrorClassSchema,
  gateADocumentExtractionVersionSchema,
  liveEvidenceLocatorSchema,
  liveResolvedTaskInputRefSchema,
} from './gate-a.js';

const idSchema = z.string().min(1).max(500);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const internalAcceptanceShape = {
  simulation: z.literal(false),
  runtimeMode: z.literal('model_gateway'),
  businessDecisionAllowed: z.literal(false),
  internalAcceptance: z.literal(true),
} as const;
const privateConversationAudienceSchema = z.object({
  kind: z.literal('private-conversation'),
  conversationId: idSchema,
}).strict();
const gateALiveTerminalErrorClassSchema = z.union([gateAAnalysisErrorClassSchema, z.enum([
  'REPORT_AUTHORITY_INVALID', 'REPORT_PUBLICATION_FAILED', 'STORAGE_OPERATION_FAILED',
])]);

export const gateAExpertTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('expert'), expertId: z.literal('expert.solution.architect') }).strict(),
  z.object({ mode: z.literal('team'), teamId: z.literal('team.solution.core') }).strict(),
]);

export const gateALiveTaskCreateInputSchema = z.object({
  conversationId: idSchema,
  capabilityId: z.literal('solution.analysis.v1'),
  inputRef: z.object({
    kind: z.literal('document_snapshot'),
    documentSnapshotId: idSchema,
  }).strict(),
  expertTarget: gateAExpertTargetSchema,
}).strict();

export const gateADocumentExecutionEligibilitySchema = z.discriminatedUnion('route', [
  z.object({
    route: z.literal('live'),
    eligible: z.literal(true),
    capabilityVersionId: z.enum(['cap_solution_analysis_v1_live_1', 'cap_solution_analysis_v1_live_2']),
    parserManifestId: idSchema,
    parserDigest: sha256Schema,
    extractionVersion: gateADocumentExtractionVersionSchema,
    canonicalTextSha256: sha256Schema,
    ...internalAcceptanceShape,
  }).strict(),
  z.object({
    route: z.literal('simulation'),
    eligible: z.literal(true),
    simulationProfile: z.literal('solution-analysis-demo/v2'),
    simulation: z.literal(true),
    runtimeMode: z.literal('fake'),
    businessDecisionAllowed: z.literal(false),
  }).strict(),
  z.object({
    route: z.literal('not_open'),
    eligible: z.literal(false),
    reason: z.enum([
      'LIVE_RELEASE_NOT_OPEN',
      'PARSER_AUTHORITY_UNAVAILABLE',
      'CANONICAL_REPRESENTATION_UNAVAILABLE',
      'DATA_ROUTE_NOT_ALLOWED',
      'PROFILE_NOT_RECOGNIZED',
    ]),
  }).strict(),
]);

export const gateACapabilityRouteProjectionSchema = z.union([
  z.object({
    capabilityId: z.literal('solution.analysis.v1'),
    status: z.literal('internal'),
    executionRoute: z.literal('live'),
    capabilityVersionId: z.literal('cap_solution_analysis_v1_live_1'),
    availableExpertModes: z.tuple([z.literal('auto')]),
    ...internalAcceptanceShape,
  }).strict(),
  z.object({
    capabilityId: z.literal('solution.analysis.v1'),
    status: z.literal('internal'),
    executionRoute: z.literal('live'),
    capabilityVersionId: z.literal('cap_solution_analysis_v1_live_2'),
    availableExpertModes: z.tuple([z.literal('auto'), z.literal('expert'), z.literal('team')]),
    ...internalAcceptanceShape,
  }).strict(),
  z.object({
    capabilityId: z.literal('solution.analysis.v1'),
    status: z.literal('NOT_OPEN'),
    executionRoute: z.literal('not_open'),
    availableExpertModes: z.tuple([]),
    reason: z.enum([
      'LIVE_RELEASE_NOT_OPEN',
      'MODEL_ROUTE_UNAVAILABLE',
      'PARSER_AUTHORITY_UNAVAILABLE',
      'DATA_ROUTE_NOT_ALLOWED',
    ]),
  }).strict(),
]);

const gateA1LiveTaskCreateResponseSchema = z.object({
  recordVariant: z.literal('business-task.live/1'),
  executionRoute: z.literal('live'),
  taskId: idSchema,
  approvalId: idSchema,
  approvalSubjectDigest: sha256Schema,
  workflowVersion: z.object({
    id: idSchema,
    hash: sha256Schema,
    templateId: z.literal('workflow-template.solution-live/1'),
    registryDigest: sha256Schema,
  }).strict(),
  ...internalAcceptanceShape,
}).strict();

const gateA2LiveTaskCreateResponseSchema = gateA1LiveTaskCreateResponseSchema.extend({
  workflowVersion: z.object({
    id: idSchema,
    hash: sha256Schema,
    templateId: z.literal('workflow-template.solution-live/2'),
    registryDigest: sha256Schema,
  }).strict(),
});
export const gateALiveTaskCreateResponseSchema = z.union([
  gateA1LiveTaskCreateResponseSchema,
  gateA2LiveTaskCreateResponseSchema,
]);

export const gateALivePublishedStatementSchema = z.object({
  id: idSchema,
  kind: z.enum(['fact', 'inference', 'recommendation', 'unknown']),
  text: z.string().min(1).max(16_384),
  confidence: z.number().min(0).max(1),
  status: z.enum(['published', 'rejected']),
  evidenceRefIds: z.array(idSchema).max(128),
  rejectionCode: idSchema.nullable(),
}).strict().superRefine((statement, context) => {
  if (statement.kind === 'fact' && statement.status === 'published' && statement.evidenceRefIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['evidenceRefIds'], message: 'published facts require verified Evidence' });
  }
  if (statement.status === 'rejected' && statement.rejectionCode === null) {
    context.addIssue({ code: 'custom', path: ['rejectionCode'], message: 'rejected statements require a rejection code' });
  }
  if (statement.status === 'published' && statement.rejectionCode !== null) {
    context.addIssue({ code: 'custom', path: ['rejectionCode'], message: 'published statements cannot carry a rejection code' });
  }
});

export const gateALivePublishedAnalysisResultSchema = z.object({
  recordVariant: z.literal('business-task-result.live/1'),
  schemaVersion: z.literal('analysis-result/1'),
  id: idSchema,
  summary: z.string().min(1).max(32_768),
  statements: z.array(gateALivePublishedStatementSchema).min(1).max(256),
  outputPayloadDigest: sha256Schema,
  createdAt: z.string().datetime(),
}).strict();

export const gateALiveEvidenceProjectionSchema = z.object({
  recordVariant: z.literal('evidence.live/1'),
  id: idSchema,
  businessTaskId: idSchema,
  statementId: idSchema,
  source: liveEvidenceLocatorSchema,
  excerpt: z.string().min(1).nullable(),
  resourceScope: idSchema,
  dataClass: z.literal('C1'),
  audience: privateConversationAudienceSchema,
  lineageRecordIds: z.array(idSchema).min(1).max(64),
  createdAt: z.string().datetime(),
}).strict();

export const gateALiveArtifactProjectionSchema = z.object({
  recordVariant: z.literal('artifact.analysis-report.live/1'),
  id: idSchema,
  manifestId: idSchema,
  kind: z.literal('analysis_report'),
  displayName: z.string().min(1).max(256),
  mediaType: z.literal('text/markdown'),
  sizeBytes: z.number().int().positive().max(1_048_576),
  contentSha256: sha256Schema,
  downloadUrl: z.string().startsWith('/api/artifacts/'),
  lineageRecordIds: z.array(idSchema).min(1).max(128),
  internalAcceptance: z.literal(true),
}).strict();

const workflowNodeSchema = z.object({
  id: idSchema,
  kind: z.enum(['deterministic', 'agent', 'verification']),
  registryReference: idSchema,
  inputRefs: z.array(idSchema),
  outputSchemaId: idSchema,
}).strict();
const workflowEdgeSchema = z.object({ from: idSchema, to: idSchema }).strict();

const gateA1LiveWorkflowDetailProjectionSchema = z.object({
  recordVariant: z.literal('workflow-read-model.live/1'),
  id: idSchema,
  hash: sha256Schema,
  schemaVersion: z.literal('workflow-version.template-v1'),
  templateSchemaVersion: z.literal('workflow-template-version/1'),
  compilerVersion: z.literal('geneway-workflow-compiler/0.2.0'),
  canonicalizationVersion: z.literal('RFC8785/JCS-1'),
  featureSet: z.literal('fixed-template-v1'),
  templateId: z.literal('workflow-template.solution-live/1'),
  registryDigest: sha256Schema,
  capabilityVersionId: z.literal('cap_solution_analysis_v1_live_1'),
  harnessVersionId: z.literal('harness_solution_analysis_v1_live_1'),
  nodes: z.array(workflowNodeSchema).length(7),
  edges: z.array(workflowEdgeSchema).length(6),
  permissionCeiling: z.object({
    actions: z.tuple([z.literal('R0'), z.literal('R1'), z.literal('A1')]),
    resourceScopes: z.tuple([z.literal('document-snapshot:approval-subject-bound')]),
    dataClasses: z.tuple([z.literal('C0'), z.literal('C1')]),
    connectors: z.tuple([]),
    modelTools: z.tuple([]),
  }).strict(),
  createdAt: z.string().datetime(),
  ...internalAcceptanceShape,
}).strict();

const gateA2LiveWorkflowDetailProjectionSchema = gateA1LiveWorkflowDetailProjectionSchema.extend({
  templateId: z.literal('workflow-template.solution-live/2'),
  capabilityVersionId: z.literal('cap_solution_analysis_v1_live_2'),
  harnessVersionId: z.literal('harness_solution_analysis_v1_live_2'),
});
export const gateALiveWorkflowDetailProjectionSchema = z.union([
  gateA1LiveWorkflowDetailProjectionSchema,
  gateA2LiveWorkflowDetailProjectionSchema,
]);

const workflowListPick = {
  recordVariant: true, id: true, hash: true, capabilityVersionId: true, harnessVersionId: true,
  createdAt: true, simulation: true, runtimeMode: true, businessDecisionAllowed: true,
  internalAcceptance: true,
} as const;
export const gateALiveWorkflowListItemSchema = z.union([
  gateA1LiveWorkflowDetailProjectionSchema.pick(workflowListPick),
  gateA2LiveWorkflowDetailProjectionSchema.pick(workflowListPick),
]);

const liveStepIdSchema = z.enum([
  'document_ingest',
  'requirement_extract',
  'contradiction_check',
  'solution_design',
  'evidence_verify',
  'result_quality_check',
  'report_publish',
]);

const liveTaskStatusSchema = z.enum([
  'awaiting_approval',
  'approved',
  'queued',
  'running',
  'completed',
  'failed',
  'cancel_requested',
  'canceled',
]);

const gateA1LiveTaskSnapshotSchema = z.object({
  recordVariant: z.literal('business-task.live/1'),
  id: idSchema,
  capabilityId: z.literal('solution.analysis.v1'),
  capabilityVersionId: z.literal('cap_solution_analysis_v1_live_1'),
  title: z.literal('方案分析'),
  conversationId: idSchema,
  status: liveTaskStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  inputRef: liveResolvedTaskInputRefSchema,
  workflowVersion: z.object({
    id: idSchema,
    hash: sha256Schema,
    templateId: z.literal('workflow-template.solution-live/1'),
    registryDigest: sha256Schema,
  }).strict(),
  approval: z.object({
    id: idSchema,
    version: z.number().int().positive(),
    status: z.enum(['pending', 'approved', 'rejected']),
    subjectDigest: sha256Schema,
    expiresAt: z.string().datetime(),
  }).strict(),
  expertTarget: z.object({
    requested: z.object({ mode: z.literal('auto') }).strict(),
    resolved: z.object({
      mode: z.literal('expert'),
      resolution: z.literal('automatic'),
      expertId: z.literal('expert.solution.architect.live/1'),
      agentVersionId: z.literal('agent.solution.architect.live/1'),
      promptPolicyVersionId: z.literal('xiaowei.solution-analysis.system/1'),
    }).strict(),
  }).strict(),
  steps: z.array(z.object({
    id: liveStepIdSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  }).strict()).length(7),
  modelInvocation: z.object({
    id: idSchema,
    status: z.enum(['pending', 'running', 'completed', 'cancel_requested', 'canceled', 'failed']),
    providerRevision: idSchema.nullable(),
    modelRevision: idSchema.nullable(),
  }).strict().nullable(),
  result: gateALivePublishedAnalysisResultSchema.nullable(),
  evidence: z.array(gateALiveEvidenceProjectionSchema),
  artifacts: z.array(gateALiveArtifactProjectionSchema),
  lineage: z.array(z.object({
    id: idSchema,
    fromKind: idSchema,
    fromId: idSchema,
    toKind: idSchema,
    toId: idSchema,
    relation: idSchema,
  }).strict()),
  errorClass: gateALiveTerminalErrorClassSchema.nullable(),
  aggregateVersion: z.number().int().positive(),
  eventWatermark: z.number().int().nonnegative(),
  ...internalAcceptanceShape,
}).strict();

const gateA2ResolvedStepBindingsSchema = z.tuple([
  z.object({ stepId: z.literal('requirement_extract'),
    agentRegistryReference: z.literal('agent.solution.requirement/live-1'),
    agentVersionId: z.literal('agent.solution.requirement/live-2') }).strict(),
  z.object({ stepId: z.literal('contradiction_check'),
    agentRegistryReference: z.literal('agent.solution.contradiction/live-1'),
    agentVersionId: z.literal('agent.solution.contradiction/live-2') }).strict(),
  z.object({ stepId: z.literal('solution_design'),
    agentRegistryReference: z.literal('agent.solution.architect/live-1'),
    agentVersionId: z.literal('agent.solution.architect/live-2') }).strict(),
]);
export const gateA2ResolvedExpertTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto'), resolution: z.literal('automatic'),
    expertVersionId: z.literal('expert.solution.architect.live/2'),
    promptPolicyVersionId: z.literal('xiaowei.solution-analysis.system/2'),
    stepBindings: gateA2ResolvedStepBindingsSchema }).strict(),
  z.object({ mode: z.literal('expert'), resolution: z.literal('explicit'),
    expertId: z.literal('expert.solution.architect'),
    expertVersionId: z.literal('expert.solution.architect.live/2'),
    agentVersionId: z.literal('agent.solution.architect/live-2'),
    promptPolicyVersionId: z.literal('xiaowei.solution-analysis.system/2'),
    stepBindings: gateA2ResolvedStepBindingsSchema }).strict(),
  z.object({ mode: z.literal('team'), resolution: z.literal('explicit'),
    teamId: z.literal('team.solution.core'),
    teamVersionId: z.literal('team.solution.core.live/2'),
    members: z.tuple([
      z.object({ order: z.literal(1), role: z.literal('Requirement Analyst'),
        expertVersionId: z.literal('expert.solution.requirement.live/2'),
        agentVersionId: z.literal('agent.solution.requirement/live-2') }).strict(),
      z.object({ order: z.literal(2), role: z.literal('Contradiction Analyst'),
        expertVersionId: z.literal('expert.solution.contradiction.live/2'),
        agentVersionId: z.literal('agent.solution.contradiction/live-2') }).strict(),
      z.object({ order: z.literal(3), role: z.literal('Solution Architect'),
        expertVersionId: z.literal('expert.solution.architect.live/2'),
        agentVersionId: z.literal('agent.solution.architect/live-2') }).strict(),
    ]),
    promptPolicyVersionId: z.literal('xiaowei.solution-analysis.system/2'),
    stepBindings: gateA2ResolvedStepBindingsSchema }).strict(),
]);
const gateA2LiveTaskSnapshotSchema = gateA1LiveTaskSnapshotSchema.extend({
  capabilityVersionId: z.literal('cap_solution_analysis_v1_live_2'),
  customerFacingAuthor: z.literal('小纬'),
  workflowVersion: z.object({ id: idSchema, hash: sha256Schema,
    templateId: z.literal('workflow-template.solution-live/2'), registryDigest: sha256Schema }).strict(),
  expertTarget: z.object({
    requested: gateAExpertTargetSchema,
    resolved: gateA2ResolvedExpertTargetSchema,
  }).strict(),
});
export const gateALiveTaskSnapshotSchema = z.union([
  gateA1LiveTaskSnapshotSchema,
  gateA2LiveTaskSnapshotSchema,
]);

const gateALiveEventCommonShape = {
  recordVariant: z.literal('business-task-event.live/1'),
  schemaVersion: z.literal(2),
  cursor: z.number().int().nonnegative(),
  id: idSchema,
  businessTaskId: idSchema,
  sequence: z.number().int().positive(),
  aggregateVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  ...internalAcceptanceShape,
} as const;

export const gateALiveTaskEventProjectionSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('business_task.live.created'),
    payload: z.object({
      approvalId: idSchema,
      approvalSubjectDigest: sha256Schema,
      workflowVersionId: idSchema,
      workflowHash: sha256Schema,
    }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('approval.decided'),
    payload: z.object({ approvalId: idSchema, decision: z.enum(['approved', 'rejected']) }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('approval.reauthorization_required'),
    payload: z.object({
      invalidatedApprovalId: idSchema,
      currentApprovalId: idSchema,
      version: z.number().int().positive(),
      digest: sha256Schema,
    }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('workflow.execute.requested'),
    payload: z.object({ workflowVersionId: idSchema, workflowHash: sha256Schema }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('workflow.run_started'),
    payload: z.object({ executionAttemptId: idSchema }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('workflow.run_reclaimed'),
    payload: z.union([
      z.object({ executionAttemptId: idSchema }).strict(),
      z.object({
        executionAttemptId: idSchema,
        previousExecutionAttemptId: idSchema,
        stepId: z.enum(['requirement_extract', 'contradiction_check', 'solution_design']),
        taskFence: z.number().int().positive(),
        stepFence: z.number().int().positive(),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('workflow.analysis_started'),
    payload: z.object({ stepId: liveStepIdSchema, modelInvocationId: idSchema }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('workflow.analysis_completed'),
    payload: z.object({ stepId: liveStepIdSchema, modelInvocationId: idSchema }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('business_task.completed'),
    payload: z.object({ resultId: idSchema, artifactId: idSchema }).strict(),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('business_task.failed'),
    payload: z.union([
      z.object({ phase: z.literal('analysis'), errorClass: gateAAnalysisErrorClassSchema }).strict(),
      z.object({ phase: z.literal('authority_revalidation'), errorClass: z.literal('DATA_ROUTE_NOT_ALLOWED') }).strict(),
      z.object({ phase: z.literal('report_publish'), reasonCode: idSchema }).strict(),
      z.object({ phase: z.literal('report_publish'), errorClass: z.literal('MODEL_TIMEOUT') }).strict(),
    ]),
  }).strict(),
  z.object({
    ...gateALiveEventCommonShape,
    eventType: z.literal('business_task.canceled'),
    payload: z.object({
      reasonCode: z.literal('USER_CANCELED'),
      phase: z.enum(['pre_execution', 'analysis', 'report_publish']),
    }).strict(),
  }).strict(),
]);

export const gateALiveTaskEventListResponseSchema = z.object({
  events: z.array(gateALiveTaskEventProjectionSchema),
}).strict();

export const gateALiveExecuteTaskResponseSchema = z.object({
  recordVariant: z.literal('business-task.live/1'),
  taskId: idSchema,
  status: z.enum(['queued', 'running']),
  approvalId: idSchema,
  approvalVersion: z.number().int().positive(),
  approvalSubjectDigest: sha256Schema,
  workflowVersionId: idSchema,
  workflowHash: sha256Schema,
  ...internalAcceptanceShape,
}).strict();

export const gateALiveCancelTaskResponseSchema = z.object({
  recordVariant: z.literal('business-task.live/1'),
  taskId: idSchema,
  status: z.enum(['cancel_requested', 'canceled']),
  eventCursor: z.number().int().nonnegative(),
  ...internalAcceptanceShape,
}).strict();

export const gateALiveTaskListItemSchema = z.object({
  recordVariant: z.literal('business-task.live/1'),
  id: idSchema,
  capabilityId: z.literal('solution.analysis.v1'),
  status: liveTaskStatusSchema,
  title: z.literal('方案分析'),
  conversationId: idSchema,
  workflowVersion: z.object({ id: idSchema, hash: sha256Schema }).strict(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  aggregateVersion: z.number().int().positive(),
  ...internalAcceptanceShape,
}).strict();

export type GateADocumentExecutionEligibility = z.infer<typeof gateADocumentExecutionEligibilitySchema>;
export type GateACapabilityRouteProjection = z.infer<typeof gateACapabilityRouteProjectionSchema>;
export type GateALiveTaskCreateInput = z.infer<typeof gateALiveTaskCreateInputSchema>;
export type GateALiveTaskCreateResponse = z.infer<typeof gateALiveTaskCreateResponseSchema>;
export type GateALiveTaskSnapshot = z.infer<typeof gateALiveTaskSnapshotSchema>;
export type GateALiveTaskEventProjection = z.infer<typeof gateALiveTaskEventProjectionSchema>;
export type GateALiveWorkflowDetailProjection = z.infer<typeof gateALiveWorkflowDetailProjectionSchema>;
export type GateALiveEvidenceProjection = z.infer<typeof gateALiveEvidenceProjectionSchema>;
export type GateALiveArtifactProjection = z.infer<typeof gateALiveArtifactProjectionSchema>;

export const gateALivePublicWireJsonSchemas = Object.freeze({
  DocumentExecutionEligibility: z.toJSONSchema(gateADocumentExecutionEligibilitySchema),
  CapabilityRouteProjection: z.toJSONSchema(gateACapabilityRouteProjectionSchema),
  TaskCreateInput: z.toJSONSchema(gateALiveTaskCreateInputSchema),
  TaskCreateResponse: z.toJSONSchema(gateALiveTaskCreateResponseSchema),
  TaskSnapshot: z.toJSONSchema(gateALiveTaskSnapshotSchema),
  TaskEventProjection: z.toJSONSchema(gateALiveTaskEventProjectionSchema),
  WorkflowDetailProjection: z.toJSONSchema(gateALiveWorkflowDetailProjectionSchema),
  EvidenceProjection: z.toJSONSchema(gateALiveEvidenceProjectionSchema),
  ArtifactProjection: z.toJSONSchema(gateALiveArtifactProjectionSchema),
  A2ResolvedExpertTarget: z.toJSONSchema(gateA2ResolvedExpertTargetSchema),
});
