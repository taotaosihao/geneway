import { z } from 'zod';

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

export const createTaskInputSchema = z.object({
  conversationId: z.string().min(1),
  capabilityId: z.literal('solution.analysis.v1'),
  fixtureRef: z.literal('fixture:solution-analysis:v1'),
  expertTarget: expertTargetSchema,
}).strict();

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
]);

export type TaskResult = z.infer<typeof taskResultSchema>;

export const taskSnapshotSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: z.string(),
  workflowVersion: z.object({ id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  approval: z.object({ id: z.string(), version: z.number().int().positive(), status: z.string(), subjectDigest: z.string() }).strict(),
  expertTarget: expertTargetSchema,
  steps: z.array(z.object({ id: z.string(), status: z.string(), output: z.unknown().nullable() }).strict()),
  claims: z.array(z.object({
    id: z.string(),
    text: z.string(),
    status: z.enum(['published', 'rejected']),
    evidenceRefId: z.string().nullable(),
    rejectionCode: z.string().nullable(),
  }).strict()),
  evidence: z.array(z.object({
    id: z.string(),
    sourceId: z.string(),
    excerpt: z.string(),
    sourceHash: z.string(),
  }).strict()),
  result: taskResultSchema.nullable(),
  aggregateVersion: z.number().int().positive(),
  eventWatermark: z.number().int().nonnegative(),
}).extend(simulationEnvelopeSchema.shape).strict();

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

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
  mediaType: z.enum(['text/plain', 'text/markdown']),
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
  mediaType: z.enum(['text/plain', 'text/markdown']),
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
