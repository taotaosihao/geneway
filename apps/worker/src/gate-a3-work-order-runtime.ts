import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  canonicalizeGateA3Jcs,
  gateA3ConnectorErrorClassSchema,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorSourceSnapshotSchema,
  gateA3ConnectorWorkOrderResponseSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderModelFailureClassSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderProgressSchema,
  gateA3WorkOrderRefSchema,
  gateA3WorkOrderStatusCardSchema,
  GenewayError,
  type GateA3ConnectorGatewayReceipt,
  type GateA3ConnectorGatewayRequest,
  type GateA3ConnectorSourceSnapshot,
  type GateA3WorkOrderExplanation,
  type GateA3WorkOrderModelReceipt,
  type GateA3WorkOrderModelRequest,
  type GateA3WorkOrderProgress,
  type GateA3WorkOrderStatusCard,
} from '@geneway/contracts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMMAND_PATH = '/internal/worker/v1/gate-a3-work-order-commands';
const CONNECTOR_PATH = '/internal/connector-gateway/v1/work-order-status';
const MODEL_PATH = '/internal/model-gateway/v1/work-order-explanation';
const CONNECTOR_CONNECT_TIMEOUT_MS = 2_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const opaqueIdSchema = z.string().min(1).max(200);

export { gateA3WorkOrderModelReceiptSchema, gateA3WorkOrderProgressSchema } from '@geneway/contracts';
export type {
  GateA3WorkOrderModelReceipt,
  GateA3WorkOrderModelRequest,
  GateA3WorkOrderProgress,
} from '@geneway/contracts';

const baseAuthorityShape = {
  tenantId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  workflowVersionId: opaqueIdSchema,
  workflowHash: z.string().regex(sha256Pattern),
  executionAttemptId: opaqueIdSchema,
  taskFence: z.number().int().positive(),
  approvalSubjectDigest: z.string().regex(sha256Pattern),
  capabilityVersionId: z.literal('cap_production_work_order_status_v1_1'),
  connectorQuerySpecHash: z.string().regex(sha256Pattern),
  deadline: z.string().datetime(),
} as const;

const stepLeaseSchema = z.object({
  stepId: z.enum([
    'validate_work_order_ref', 'fetch_authorized_status', 'compute_progress',
    'explain_status', 'evidence_verify', 'publish_status_card',
  ]),
  stepAttemptId: opaqueIdSchema,
  stepFence: z.number().int().positive(),
}).strict();

export const gateA3WorkOrderWorkerClaimSchema = z.object({
  schemaVersion: z.literal('gate-a3-work-order-worker-claim/1'),
  ...baseAuthorityShape,
  workOrderRef: z.string().min(1).max(512),
  step: stepLeaseSchema.extend({ stepId: z.literal('validate_work_order_ref') }).strict(),
}).strict();

export type GateA3WorkOrderWorkerClaim = z.infer<typeof gateA3WorkOrderWorkerClaimSchema>;
export type GateA3WorkOrderStepLease = z.infer<typeof stepLeaseSchema>;

const modelSuccessSchema = z.object({
  output: gateA3WorkOrderExplanationSchema,
  receipt: gateA3WorkOrderModelReceiptSchema,
}).strict();

const connectorSuccessSchema = z.object({
  response: gateA3ConnectorWorkOrderResponseSchema,
  receipt: gateA3ConnectorGatewayReceiptSchema,
}).strict();

const responseChunkSchema = z.object({
  done: z.boolean(),
  value: z.instanceof(Uint8Array).optional(),
});

export type GateA3ConnectorRuntimeResult = z.infer<typeof connectorSuccessSchema>;
export type GateA3ModelRuntimeResult = z.infer<typeof modelSuccessSchema>;

type WorkOrderRuntimeErrorClass =
  | z.infer<typeof gateA3ConnectorErrorClassSchema>
  | z.infer<typeof gateA3WorkOrderModelFailureClassSchema>
  | 'WORK_ORDER_REF_INVALID'
  | 'WORK_ORDER_PROTOCOL_VIOLATION';

export class GateA3WorkOrderRuntimeError extends GenewayError {
  constructor(
    readonly errorClass: WorkOrderRuntimeErrorClass,
    readonly receipt?: GateA3ConnectorGatewayReceipt | GateA3WorkOrderModelReceipt,
    message = 'Gate A.3 work-order execution failed',
  ) {
    super(errorClass, message, errorClass === 'MODEL_BUSY' ? 409 : 502);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalizeGateA3Jcs(value), 'utf8').digest('hex');
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
    throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_RESPONSE_BYTES) {
      throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
    }
  }
  if (response.body === null) throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const rawChunk: unknown = await reader.read();
    const chunk = responseChunkSchema.parse(rawChunk);
    if (chunk.value !== undefined) {
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
      }
      chunks.push(chunk.value);
    }
    if (chunk.done) break;
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function loopbackEndpoint(origin: string, path: string, code: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new GenewayError(code, 'Internal Gateway must be an exact IPv4 loopback HTTP origin');
  }
  return new URL(path, url);
}

export class GateA3ConnectorRuntimeAdapter {
  private readonly endpoint: URL;

  constructor(connectorGatewayUrl: string, private readonly serviceToken: string) {
    this.endpoint = loopbackEndpoint(connectorGatewayUrl, CONNECTOR_PATH, 'CONNECTOR_GATEWAY_ENDPOINT_INVALID');
    if (serviceToken.length < 32) throw new GenewayError('CONNECTOR_GATEWAY_AUTH_INVALID', 'Connector Gateway service token is invalid');
  }

  async execute(request: GateA3ConnectorGatewayRequest, signal?: AbortSignal): Promise<GateA3ConnectorRuntimeResult> {
    const parsedRequest = gateA3ConnectorGatewayRequestSchema.parse(request);
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.min(
      parsedRequest.querySpec.budget.timeoutMs + CONNECTOR_CONNECT_TIMEOUT_MS,
      Date.parse(parsedRequest.querySpec.deadline) - Date.now(),
    )));
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(parsedRequest),
        signal: signal === undefined ? deadlineSignal : AbortSignal.any([signal, deadlineSignal]),
        redirect: 'error',
      });
    } catch {
      throw new GateA3WorkOrderRuntimeError(deadlineSignal.aborted ? 'CONNECTOR_TIMEOUT' : 'CONNECTOR_ROUTE_UNAVAILABLE');
    }
    let decoded: unknown;
    try {
      decoded = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof GateA3WorkOrderRuntimeError) throw error;
      throw new GateA3WorkOrderRuntimeError('CONNECTOR_PROTOCOL_VIOLATION');
    }
    if (!response.ok) {
      const failure = z.object({
        errorClass: gateA3ConnectorErrorClassSchema,
        receipt: gateA3ConnectorGatewayReceiptSchema.optional(),
      }).strict().safeParse(decoded);
      if (!failure.success) throw new GateA3WorkOrderRuntimeError('CONNECTOR_PROTOCOL_VIOLATION');
      throw new GateA3WorkOrderRuntimeError(failure.data.errorClass, failure.data.receipt);
    }
    const parsed = connectorSuccessSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.receipt.payload.outcome !== 'completed'
      || parsed.data.response.workOrderRef !== parsedRequest.querySpec.workOrderRef
      || parsed.data.receipt.payload.connectorQuerySpecHash !== parsedRequest.querySpecHash
      || parsed.data.receipt.payload.responseCanonicalHash !== digest(parsed.data.response)) {
      throw new GateA3WorkOrderRuntimeError('CONNECTOR_PROTOCOL_VIOLATION');
    }
    return parsed.data;
  }
}

const modelReceiptBoundKeys = [
  'tenantId', 'principalId', 'taskId', 'workflowVersionId', 'workflowHash', 'executionAttemptId', 'taskFence',
  'stepId', 'stepAttemptId', 'stepFence', 'modelInvocationId', 'approvalSubjectDigest', 'capabilityVersionId',
  'effectId', 'connectorQuerySpecHash', 'connectorSourceSnapshotId', 'connectorSourceSnapshotHash',
  'snapshotPayloadHash', 'progressDigest', 'resourceScope', 'snapshotAudience', 'logicalModelPolicy', 'promptPolicyVersionId',
  'promptPolicyResolvedBytesSha256',
  'routeProfile', 'dataClass', 'toolChoice', 'outputSchemaVersion', 'maxOutputTokens', 'deadline',
] as const;

function modelReceiptMatchesRequest(
  receipt: GateA3WorkOrderModelReceipt,
  request: GateA3WorkOrderModelRequest,
): boolean {
  return modelReceiptBoundKeys.every((key) => receipt.payload[key] === request[key]);
}

export class GateA3WorkOrderModelRuntimeAdapter {
  private readonly endpoint: URL;

  constructor(modelGatewayUrl: string, private readonly serviceToken: string) {
    this.endpoint = loopbackEndpoint(modelGatewayUrl, MODEL_PATH, 'MODEL_GATEWAY_ENDPOINT_INVALID');
    if (serviceToken.length < 32) throw new GenewayError('MODEL_GATEWAY_AUTH_INVALID', 'Model Gateway service token is invalid');
  }

  async execute(request: GateA3WorkOrderModelRequest, signal?: AbortSignal): Promise<GateA3ModelRuntimeResult> {
    const parsedRequest = gateA3WorkOrderModelRequestSchema.parse(request);
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(parsedRequest.deadline) - Date.now()));
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(parsedRequest),
        signal: signal === undefined ? deadlineSignal : AbortSignal.any([signal, deadlineSignal]),
      });
    } catch {
      throw new GateA3WorkOrderRuntimeError(deadlineSignal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_STREAM_INTERRUPTED');
    }
    let decoded: unknown;
    try {
      decoded = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof GateA3WorkOrderRuntimeError) throw error;
      throw new GateA3WorkOrderRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
    if (!response.ok) {
      const failure = z.object({
        errorClass: gateA3WorkOrderModelFailureClassSchema,
        receipt: gateA3WorkOrderModelReceiptSchema.optional(),
        retryNotBefore: z.string().datetime().optional(),
      }).strict().safeParse(decoded);
      if (!failure.success) throw new GateA3WorkOrderRuntimeError('MODEL_PROTOCOL_VIOLATION');
      if (failure.data.receipt !== undefined && (!modelReceiptMatchesRequest(failure.data.receipt, parsedRequest)
        || failure.data.receipt.payload.outcome !== failure.data.errorClass)) {
        throw new GateA3WorkOrderRuntimeError('MODEL_PROTOCOL_VIOLATION');
      }
      throw new GateA3WorkOrderRuntimeError(failure.data.errorClass, failure.data.receipt);
    }
    const parsed = modelSuccessSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.receipt.payload.outcome !== 'completed'
      || parsed.data.receipt.payload.outputPayloadDigest !== digest(parsed.data.output)
      || !modelReceiptMatchesRequest(parsed.data.receipt, parsedRequest)) {
      throw new GateA3WorkOrderRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
    return parsed.data;
  }
}

const fetchGrantSchema = z.object({
  step: stepLeaseSchema.extend({ stepId: z.literal('fetch_authorized_status') }).strict(),
  connectorRequest: gateA3ConnectorGatewayRequestSchema,
}).strict();
const computeGrantSchema = z.object({
  step: stepLeaseSchema.extend({ stepId: z.literal('compute_progress') }).strict(),
  sourceSnapshot: gateA3ConnectorSourceSnapshotSchema,
  reused: z.boolean().optional(),
}).strict();
const explainGrantSchema = z.union([
  z.object({
    step: stepLeaseSchema.extend({ stepId: z.literal('explain_status') }).strict(),
    modelRequest: gateA3WorkOrderModelRequestSchema,
  }).strict(),
  z.object({
    step: stepLeaseSchema.extend({ stepId: z.literal('evidence_verify') }).strict(),
    acceptedExplanation: gateA3WorkOrderExplanationSchema,
  }).strict(),
]);
const evidenceGrantSchema = z.object({
  step: stepLeaseSchema.extend({ stepId: z.literal('evidence_verify') }).strict(),
}).strict();
const publishGrantSchema = z.object({
  step: stepLeaseSchema.extend({ stepId: z.literal('publish_status_card') }).strict(),
  verifiedExplanation: gateA3WorkOrderExplanationSchema,
  evidenceRefs: gateA3WorkOrderStatusCardSchema.shape.evidenceRefs,
}).strict();

export type GateA3FetchGrant = z.infer<typeof fetchGrantSchema>;
export type GateA3ComputeGrant = z.infer<typeof computeGrantSchema>;
export type GateA3ExplainGrant = z.infer<typeof explainGrantSchema>;
export type GateA3EvidenceGrant = z.infer<typeof evidenceGrantSchema>;
export type GateA3PublishGrant = z.infer<typeof publishGrantSchema>;

export type GateA3WorkOrderCancellation = Readonly<{ taskFence: number }>;
export type GateA3ConnectorFailureDisposition =
  | Readonly<{ retryScheduled: true; retryNotBefore: string }>
  | Readonly<{ retryScheduled: false }>;

const connectorFailureDispositionSchema = z.discriminatedUnion('retryScheduled', [
  z.object({ retryScheduled: z.literal(true), retryNotBefore: z.string().datetime() }).strict(),
  z.object({ retryScheduled: z.literal(false) }).strict(),
]);

export interface GateA3WorkOrderCommandPort {
  claim(signal?: AbortSignal): Promise<GateA3WorkOrderWorkerClaim | null>;
  started(claim: GateA3WorkOrderWorkerClaim): Promise<void>;
  validated(claim: GateA3WorkOrderWorkerClaim, output: Readonly<{ schemaVersion: 'work-order.ref/1'; workOrderRef: string }>): Promise<GateA3FetchGrant>;
  connectorAccepted(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease, result: GateA3ConnectorRuntimeResult): Promise<GateA3ComputeGrant>;
  connectorFailed(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease,
    error: GateA3WorkOrderRuntimeError): Promise<GateA3ConnectorFailureDisposition>;
  progressComputed(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease, progress: GateA3WorkOrderProgress): Promise<GateA3ExplainGrant>;
  explanationAccepted(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease, result: GateA3ModelRuntimeResult): Promise<GateA3EvidenceGrant>;
  evidenceVerified(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease, explanation: GateA3WorkOrderExplanation): Promise<GateA3PublishGrant>;
  published(claim: GateA3WorkOrderWorkerClaim, step: GateA3WorkOrderStepLease, card: GateA3WorkOrderStatusCard, explanation: GateA3WorkOrderExplanation): Promise<void>;
  failed(claim: GateA3WorkOrderWorkerClaim, error: GateA3WorkOrderRuntimeError): Promise<void>;
  cancelRequested(claim: GateA3WorkOrderWorkerClaim, signal?: AbortSignal): Promise<GateA3WorkOrderCancellation | null>;
  canceled(claim: GateA3WorkOrderWorkerClaim, cancellation: GateA3WorkOrderCancellation): Promise<void>;
}

type CheckpointOutput = Readonly<Record<string, unknown>>;

export class GateA3WorkOrderWorkerCommandClient implements GateA3WorkOrderCommandPort {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly workerInstanceId: string,
  ) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 100) {
      throw new GenewayError('WORKER_SOCKET_PATH_INVALID', 'Worker command socket path is invalid');
    }
    if (token.length < 32 || workerInstanceId.length === 0) throw new GenewayError('WORKER_AUTH_INVALID', 'Worker work-order authority is invalid');
  }

  async claim(signal?: AbortSignal): Promise<GateA3WorkOrderWorkerClaim | null> {
    const payload = await this.send({ command: 'claim_gate_a3_work_order', workerInstanceId: this.workerInstanceId }, signal);
    return z.object({
      command: z.literal('claim_gate_a3_work_order'),
      result: gateA3WorkOrderWorkerClaimSchema.nullable(),
    }).strict().parse(payload).result;
  }

  async started(claim: GateA3WorkOrderWorkerClaim): Promise<void> {
    await this.accepted('gate_a3_work_order_started', claim);
  }

  async validated(
    claim: GateA3WorkOrderWorkerClaim,
    output: Readonly<{ schemaVersion: 'work-order.ref/1'; workOrderRef: string }>,
  ): Promise<GateA3FetchGrant> {
    return fetchGrantSchema.parse(await this.checkpoint(claim, claim.step, output));
  }

  async connectorAccepted(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    result: GateA3ConnectorRuntimeResult,
  ): Promise<GateA3ComputeGrant> {
    return computeGrantSchema.parse(await this.checkpoint(claim, step, result));
  }

  async connectorFailed(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    error: GateA3WorkOrderRuntimeError,
  ): Promise<GateA3ConnectorFailureDisposition> {
    const payload = await this.send({
      command: 'gate_a3_work_order_connector_failed',
      ...this.mutation(claim),
      step,
      failure: {
        errorClass: gateA3ConnectorErrorClassSchema.parse(error.errorClass),
        ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
      },
    });
    return z.object({
      command: z.literal('gate_a3_work_order_connector_failed'),
      result: connectorFailureDispositionSchema,
    }).strict().parse(payload).result;
  }

  async progressComputed(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    progress: GateA3WorkOrderProgress,
  ): Promise<GateA3ExplainGrant> {
    return explainGrantSchema.parse(await this.checkpoint(claim, step, progress));
  }

  async explanationAccepted(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    result: GateA3ModelRuntimeResult,
  ): Promise<GateA3EvidenceGrant> {
    return evidenceGrantSchema.parse(await this.checkpoint(claim, step, result));
  }

  async evidenceVerified(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    explanation: GateA3WorkOrderExplanation,
  ): Promise<GateA3PublishGrant> {
    return publishGrantSchema.parse(await this.checkpoint(claim, step, { explanation }));
  }

  async published(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    card: GateA3WorkOrderStatusCard,
    explanation: GateA3WorkOrderExplanation,
  ): Promise<void> {
    await this.accepted('gate_a3_work_order_terminal', claim, { step, terminal: { status: 'completed', card, explanation } });
  }

  async failed(claim: GateA3WorkOrderWorkerClaim, error: GateA3WorkOrderRuntimeError): Promise<void> {
    await this.accepted('gate_a3_work_order_terminal', claim, {
      terminal: {
        status: 'failed', errorClass: error.errorClass,
        ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
      },
    });
  }

  async cancelRequested(claim: GateA3WorkOrderWorkerClaim, signal?: AbortSignal): Promise<GateA3WorkOrderCancellation | null> {
    const payload = await this.send({ command: 'request_gate_a3_work_order_cancel', ...this.mutation(claim) }, signal);
    const result = z.object({
      command: z.literal('request_gate_a3_work_order_cancel'),
      result: z.discriminatedUnion('cancelRequested', [
        z.object({ cancelRequested: z.literal(false) }).strict(),
        z.object({ cancelRequested: z.literal(true), taskFence: z.number().int().positive() }).strict(),
      ]),
    }).strict().parse(payload).result;
    return result.cancelRequested ? { taskFence: result.taskFence } : null;
  }

  async canceled(claim: GateA3WorkOrderWorkerClaim, cancellation: GateA3WorkOrderCancellation): Promise<void> {
    await this.accepted('gate_a3_work_order_terminal', claim, {
      taskFence: cancellation.taskFence,
      terminal: { status: 'canceled' },
    });
  }

  private async checkpoint(
    claim: GateA3WorkOrderWorkerClaim,
    step: GateA3WorkOrderStepLease,
    output: CheckpointOutput,
  ): Promise<unknown> {
    const payload = await this.send({
      command: 'gate_a3_work_order_checkpoint',
      ...this.mutation(claim),
      step,
      output,
    });
    return z.object({ command: z.literal('gate_a3_work_order_checkpoint'), result: z.unknown() }).strict().parse(payload).result;
  }

  private mutation(claim: GateA3WorkOrderWorkerClaim): Readonly<Record<string, unknown>> {
    return {
      tenantId: claim.tenantId,
      taskId: claim.taskId,
      workflowVersionId: claim.workflowVersionId,
      workflowHash: claim.workflowHash,
      executionAttemptId: claim.executionAttemptId,
      taskFence: claim.taskFence,
    };
  }

  private async accepted(
    command: string,
    claim: GateA3WorkOrderWorkerClaim,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const payload = await this.send({ command, ...this.mutation(claim), ...extra });
    z.object({ command: z.literal(command), result: z.object({ accepted: z.literal(true) }).strict() }).strict().parse(payload);
  }

  private async send(body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path: COMMAND_PATH,
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) response.destroy(new Error('Worker work-order response exceeded limit'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: string; message?: string } };
            if ((response.statusCode ?? 500) >= 400) {
              reject(new GenewayError(
                payload.error?.code ?? 'GATE_A3_WORK_ORDER_COMMAND_FAILED',
                payload.error?.message ?? 'Worker work-order command failed',
                response.statusCode,
              ));
            } else resolve(payload);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Worker work-order response was invalid'));
          }
        });
        response.once('error', reject);
      });
      request.once('error', reject);
      request.end(serialized);
    });
  }
}

export function computeGateA3WorkOrderProgress(snapshot: GateA3ConnectorSourceSnapshot): GateA3WorkOrderProgress {
  const { planQty, completedQty } = snapshot.canonicalAllowlistedPayload;
  if (planQty === null || completedQty === null) {
    return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty,
      progressPct: null, calculationStatus: 'missing_quantity',
    });
  }
  if (planQty === 0) {
    return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty,
      progressPct: null, calculationStatus: 'zero_plan',
    });
  }
  if (completedQty > planQty) {
    return gateA3WorkOrderProgressSchema.parse({
      schemaVersion: 'work-order.progress/1', planQty, completedQty,
      progressPct: null, calculationStatus: 'completed_exceeds_plan',
    });
  }
  return gateA3WorkOrderProgressSchema.parse({
    schemaVersion: 'work-order.progress/1', planQty, completedQty,
    progressPct: Number(((completedQty / planQty) * 100).toFixed(2)),
    calculationStatus: 'computed',
  });
}

function assertSnapshotAccepted(
  claim: GateA3WorkOrderWorkerClaim,
  grant: GateA3FetchGrant,
  connectorResult: GateA3ConnectorRuntimeResult,
  snapshot: GateA3ConnectorSourceSnapshot,
  reused: boolean,
): void {
  const receipt = connectorResult.receipt.payload;
  if (snapshot.taskId !== claim.taskId
    || snapshot.tenantId !== claim.tenantId
    || snapshot.principal !== claim.principalId
    || snapshot.connectorQuerySpecHash !== claim.connectorQuerySpecHash
    || snapshot.connectorQuerySpecHash !== grant.connectorRequest.querySpecHash
    || snapshot.effectId !== receipt.effectId
    || (!reused && snapshot.connectorInvocationId !== receipt.connectorInvocationId)
    || (!reused && snapshot.attemptId !== receipt.attemptId)
    || (!reused && snapshot.fence !== receipt.fence)
    || snapshot.canonicalAllowlistedPayloadHash !== receipt.responseCanonicalHash
    || snapshot.canonicalAllowlistedPayloadHash !== digest(connectorResult.response)
    || snapshot.canonicalAllowlistedPayload.workOrderRef !== claim.workOrderRef
    || snapshot.canonicalAllowlistedPayload.workOrderRef !== connectorResult.response.workOrderRef) {
    throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
  }
}

function buildStatusCard(
  snapshot: GateA3ConnectorSourceSnapshot,
  progress: GateA3WorkOrderProgress,
  evidenceRefs: GateA3PublishGrant['evidenceRefs'],
): GateA3WorkOrderStatusCard {
  const payload = snapshot.canonicalAllowlistedPayload;
  return gateA3WorkOrderStatusCardSchema.parse({
    schemaVersion: 'WorkOrderStatusCard/1',
    workOrderRef: payload.workOrderRef,
    status: payload.status,
    planQty: payload.planQty,
    completedQty: payload.completedQty,
    unit: payload.unit,
    progressPct: progress.progressPct,
    updatedAt: payload.updatedAt,
    sourceAsOf: snapshot.sourceAsOf,
    evidenceRefs,
    readOnly: true,
  });
}

export async function executeGateA3WorkOrderClaim(
  port: GateA3WorkOrderCommandPort,
  connectorRuntime: GateA3ConnectorRuntimeAdapter,
  modelRuntime: GateA3WorkOrderModelRuntimeAdapter,
  claim: GateA3WorkOrderWorkerClaim,
  signal?: AbortSignal,
): Promise<void> {
  const authorityAbort = new AbortController();
  const executionSignal = signal === undefined ? authorityAbort.signal : AbortSignal.any([signal, authorityAbort.signal]);
  let monitorActive = true;
  let cancellation: GateA3WorkOrderCancellation | null = null;
  let monitorFailure: unknown;
  let terminalAttempted = false;
  let pendingConnectorStep: GateA3WorkOrderStepLease | null = null;
  const signalAborted = (): boolean => signal?.aborted === true;
  const monitor = (async () => {
    while (monitorActive && !signalAborted()) {
      await wait(50, signal);
      if (!monitorActive || signalAborted()) return;
      try {
        cancellation = await port.cancelRequested(claim, signal);
        if (cancellation !== null) {
          authorityAbort.abort(new Error('Gate A.3 work-order authority canceled'));
          return;
        }
      } catch (error) {
        if (signalAborted()) return;
        monitorFailure = error;
        authorityAbort.abort(error);
        return;
      }
    }
  })();

  try {
    await port.started(claim);
    const workOrderRef = gateA3WorkOrderRefSchema.safeParse(claim.workOrderRef);
    if (!workOrderRef.success) throw new GateA3WorkOrderRuntimeError('WORK_ORDER_REF_INVALID');

    const fetchGrant = await port.validated(claim, { schemaVersion: 'work-order.ref/1', workOrderRef: workOrderRef.data });
    pendingConnectorStep = fetchGrant.step;
    const connectorResult = await connectorRuntime.execute(fetchGrant.connectorRequest, executionSignal);
    const computeGrant = await port.connectorAccepted(claim, fetchGrant.step, connectorResult);
    pendingConnectorStep = null;
    assertSnapshotAccepted(claim, fetchGrant, connectorResult, computeGrant.sourceSnapshot, computeGrant.reused === true);

    const progress = computeGateA3WorkOrderProgress(computeGrant.sourceSnapshot);
    const explainGrant = await port.progressComputed(claim, computeGrant.step, progress);
    let acceptedExplanation: GateA3WorkOrderExplanation;
    let evidenceStep: GateA3WorkOrderStepLease;
    if ('acceptedExplanation' in explainGrant) {
      acceptedExplanation = explainGrant.acceptedExplanation;
      evidenceStep = explainGrant.step;
    } else {
      if (explainGrant.modelRequest.connectorSourceSnapshotId !== computeGrant.sourceSnapshot.connectorSourceSnapshotId
        || explainGrant.modelRequest.snapshotPayloadHash !== computeGrant.sourceSnapshot.canonicalAllowlistedPayloadHash
        || explainGrant.modelRequest.progressDigest !== digest(progress)
        || explainGrant.modelRequest.snapshot.workOrderRef !== workOrderRef.data
        || digest(explainGrant.modelRequest.snapshot) !== computeGrant.sourceSnapshot.canonicalAllowlistedPayloadHash) {
        throw new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION');
      }
      const modelResult = await modelRuntime.execute(explainGrant.modelRequest, executionSignal);
      const evidenceGrant = await port.explanationAccepted(claim, explainGrant.step, modelResult);
      acceptedExplanation = modelResult.output;
      evidenceStep = evidenceGrant.step;
    }
    const publishGrant = await port.evidenceVerified(claim, evidenceStep, acceptedExplanation);
    const card = buildStatusCard(computeGrant.sourceSnapshot, progress, publishGrant.evidenceRefs);
    terminalAttempted = true;
    await port.published(claim, publishGrant.step, card, publishGrant.verifiedExplanation);
  } catch (error) {
    if (monitorFailure !== undefined) {
      throw monitorFailure instanceof Error ? monitorFailure : new Error('Gate A.3 cancel monitor failed');
    }
    if (cancellation === null && signal?.aborted !== true) cancellation = await port.cancelRequested(claim);
    if (cancellation !== null) {
      if (!terminalAttempted) {
        terminalAttempted = true;
        await port.canceled(claim, cancellation);
      }
      return;
    }
    if (signal?.aborted === true) return;
    if (terminalAttempted) throw error;
    if (pendingConnectorStep !== null && error instanceof GateA3WorkOrderRuntimeError
      && gateA3ConnectorErrorClassSchema.safeParse(error.errorClass).success) {
      terminalAttempted = true;
      await port.connectorFailed(claim, pendingConnectorStep, error);
      return;
    }
    terminalAttempted = true;
    await port.failed(claim, error instanceof GateA3WorkOrderRuntimeError
      ? error
      : new GateA3WorkOrderRuntimeError('WORK_ORDER_PROTOCOL_VIOLATION'));
  } finally {
    monitorActive = false;
    authorityAbort.abort();
    await monitor;
  }
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
