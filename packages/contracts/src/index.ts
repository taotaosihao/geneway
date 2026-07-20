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
