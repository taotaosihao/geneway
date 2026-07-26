import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  GenewayError,
  gateAAnalysisErrorClassSchema,
  gateAAnalysisGatewayReceiptSchema,
  gateAAgentOutputSchema,
  gateAAnalysisWorkerClaimSchema,
  type GateAAnalysisGatewayReceipt,
  type GateAAgentOutput,
  type GateAAnalysisWorkerClaim,
} from '@geneway/contracts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMMAND_PATH = '/internal/worker/v1/gate-a-analysis-commands';
const analysisSuccessSchema = z.object({
  output: gateAAgentOutputSchema,
  receipt: gateAAnalysisGatewayReceiptSchema,
}).strict();

const responseChunkSchema = z.object({
  done: z.boolean(),
  value: z.instanceof(Uint8Array).optional(),
});

export type GateAAnalysisErrorClass = z.infer<typeof gateAAnalysisErrorClassSchema>;

export class GateAAnalysisRuntimeError extends GenewayError {
  constructor(
    readonly errorClass: GateAAnalysisErrorClass,
    readonly receipt?: GateAAnalysisGatewayReceipt,
    message = 'Model Gateway material analysis failed',
  ) {
    super(errorClass, message, errorClass === 'MODEL_BUSY' ? 409 : 502);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
    throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_RESPONSE_BYTES) {
      throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
  }
  if (response.body === null) throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
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
        throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
      }
      chunks.push(chunk.value);
    }
    if (chunk.done) break;
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function receiptMatchesClaim(receipt: GateAAnalysisGatewayReceipt, claim: GateAAnalysisWorkerClaim): boolean {
  const payload = receipt.payload;
  return payload.tenantId === claim.tenantId
    && payload.principalId === claim.principalId
    && payload.conversationId === claim.conversationId
    && payload.taskId === claim.taskId
    && payload.workflowVersionId === claim.workflowVersionId
    && payload.workflowHash === claim.workflowHash
    && payload.stepId === claim.stepId
    && payload.executionAttemptId === claim.executionAttemptId
    && payload.stepAttemptId === claim.stepAttemptId
    && payload.taskFence === claim.taskFence
    && payload.stepFence === claim.stepFence
    && payload.modelInvocationId === claim.modelInvocationId
    && payload.approvalSubjectDigest === claim.approvalSubjectDigest
    && payload.capabilityVersionId === claim.capabilityVersionId
    && payload.promptPolicyVersionId === claim.promptPolicyVersionId
    && payload.expertTargetDigest === claim.expertTargetDigest
    && payload.documentSnapshotId === claim.documentSnapshotId
    && payload.artifactId === claim.artifactId
    && payload.artifactSha256 === claim.artifactSha256
    && payload.canonicalTextSha256 === claim.canonicalTextSha256
    && payload.canonicalPageIndexSha256 === claim.canonicalPageIndexSha256
    && payload.parserManifestId === claim.parserManifestId
    && payload.parserDigest === claim.parserDigest
    && payload.extractionVersion === claim.extractionVersion
    && payload.resourceScope === claim.resourceScope
    && payload.canonicalSelectionProjectionDigest === claim.canonicalSelectionProjectionDigest
    && payload.selectedModelInputSha256 === claim.selectedModelInputSha256
    && payload.materialProjectionDigest === claim.materialProjectionDigest
    && payload.promptPolicyResolvedBytesSha256 === claim.promptPolicyResolvedBytesSha256
    && payload.providerInputProjectionDigest === claim.providerInputProjectionDigest
    && payload.logicalModelPolicy === claim.logicalModelPolicy
    && payload.dataClass === claim.dataClass
    && payload.routeProfile === claim.routeProfile
    && payload.toolChoice === claim.toolChoice
    && payload.maxInputBytes === claim.maxInputBytes
    && payload.outputSchemaVersion === claim.outputSchemaVersion
    && payload.maxOutputTokens === claim.maxOutputTokens
    && payload.deadline === claim.deadline;
}

export type GateAAnalysisRuntimeResult = Readonly<{
  output: GateAAgentOutput;
  receipt: GateAAnalysisGatewayReceipt;
}>;

export class GateAAnalysisRuntimeAdapter {
  private readonly endpoint: URL;

  constructor(modelGatewayUrl: string, private readonly serviceToken: string) {
    const url = new URL(modelGatewayUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '' || url.pathname !== '/') {
      throw new GenewayError('MODEL_GATEWAY_ENDPOINT_INVALID', 'Model Gateway must be a loopback HTTP origin');
    }
    if (serviceToken.length < 32) throw new GenewayError('MODEL_GATEWAY_AUTH_INVALID', 'Model Gateway service token is invalid');
    this.endpoint = new URL('/internal/model-gateway/v1/analysis', url);
  }

  async execute(claim: GateAAnalysisWorkerClaim, signal?: AbortSignal): Promise<GateAAnalysisRuntimeResult> {
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(claim.deadline) - Date.now()));
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ claim, toolChoice: 'none' }),
        signal: signal === undefined ? deadlineSignal : AbortSignal.any([signal, deadlineSignal]),
      });
    } catch {
      throw new GateAAnalysisRuntimeError(deadlineSignal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_STREAM_INTERRUPTED');
    }
    let decoded: unknown;
    try {
      decoded = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof GateAAnalysisRuntimeError) throw error;
      throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
    const payload = decoded as Readonly<Record<string, unknown>>;
    if (!response.ok) {
      const errorClass = gateAAnalysisErrorClassSchema.safeParse(payload.errorClass);
      const receipt = gateAAnalysisGatewayReceiptSchema.safeParse(payload.receipt);
      if (!errorClass.success) throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
      if (receipt.success && (!receiptMatchesClaim(receipt.data, claim) || receipt.data.payload.outcome !== errorClass.data)) {
        throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
      }
      throw new GateAAnalysisRuntimeError(errorClass.data, receipt.success ? receipt.data : undefined);
    }
    const parsed = analysisSuccessSchema.safeParse(payload);
    if (!parsed.success || parsed.data.receipt.payload.outcome !== 'completed'
      || !receiptMatchesClaim(parsed.data.receipt, claim)) {
      throw new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION');
    }
    return parsed.data;
  }
}

export type GateAAnalysisCancellation = Readonly<{
  taskFence: number;
  stepFence: number;
}>;

export interface GateAAnalysisCommandPort {
  claim(signal?: AbortSignal): Promise<GateAAnalysisWorkerClaim | null>;
  started(claim: GateAAnalysisWorkerClaim): Promise<void>;
  completed(claim: GateAAnalysisWorkerClaim, result: GateAAnalysisRuntimeResult): Promise<void>;
  failed(claim: GateAAnalysisWorkerClaim, error: GateAAnalysisRuntimeError): Promise<void>;
  cancelRequested(claim: GateAAnalysisWorkerClaim, signal?: AbortSignal): Promise<GateAAnalysisCancellation | null>;
  canceled(claim: GateAAnalysisWorkerClaim, cancellation: GateAAnalysisCancellation): Promise<void>;
}

const cancelResponseSchema = z.discriminatedUnion('cancelRequested', [
  z.object({ cancelRequested: z.literal(false) }).strict(),
  z.object({
    cancelRequested: z.literal(true),
    taskFence: z.number().int().positive(),
    stepFence: z.number().int().positive(),
  }).strict(),
]);

export class GateAAnalysisWorkerCommandClient implements GateAAnalysisCommandPort {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly workerInstanceId: string,
  ) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 100) {
      throw new GenewayError('WORKER_SOCKET_PATH_INVALID', 'Worker command socket path is invalid');
    }
    if (token.length < 32 || workerInstanceId.length === 0) throw new GenewayError('WORKER_AUTH_INVALID', 'Worker analysis authority is invalid');
  }

  async claim(signal?: AbortSignal): Promise<GateAAnalysisWorkerClaim | null> {
    const payload = await this.send({ command: 'claim_gate_a_analysis', workerInstanceId: this.workerInstanceId }, signal);
    return z.object({
      command: z.literal('claim_gate_a_analysis'),
      result: gateAAnalysisWorkerClaimSchema.nullable(),
    }).strict().parse(payload).result;
  }

  async started(claim: GateAAnalysisWorkerClaim): Promise<void> {
    await this.accepted('gate_a_analysis_started', claim);
  }

  async completed(claim: GateAAnalysisWorkerClaim, result: GateAAnalysisRuntimeResult): Promise<void> {
    await this.accepted('gate_a_analysis_terminal', claim, {
      terminal: { status: 'completed', output: gateAAgentOutputSchema.parse(result.output), receipt: result.receipt },
    });
  }

  async failed(claim: GateAAnalysisWorkerClaim, error: GateAAnalysisRuntimeError): Promise<void> {
    await this.accepted('gate_a_analysis_terminal', claim, {
      terminal: {
        status: 'failed', errorClass: error.errorClass,
        ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
      },
    });
  }

  async cancelRequested(claim: GateAAnalysisWorkerClaim, signal?: AbortSignal): Promise<GateAAnalysisCancellation | null> {
    const payload = await this.send({ command: 'request_gate_a_analysis_cancel', ...this.mutation(claim) }, signal);
    const result = z.object({
      command: z.literal('request_gate_a_analysis_cancel'), result: cancelResponseSchema,
    }).strict().parse(payload).result;
    return result.cancelRequested ? { taskFence: result.taskFence, stepFence: result.stepFence } : null;
  }

  async canceled(claim: GateAAnalysisWorkerClaim, cancellation: GateAAnalysisCancellation): Promise<void> {
    await this.accepted('gate_a_analysis_terminal', claim, {
      taskFence: cancellation.taskFence,
      stepFence: cancellation.stepFence,
      terminal: { status: 'canceled' },
    });
  }

  private mutation(claim: GateAAnalysisWorkerClaim): Readonly<Record<string, unknown>> {
    return {
      taskId: claim.taskId,
      workflowVersionId: claim.workflowVersionId,
      workflowHash: claim.workflowHash,
      stepId: claim.stepId,
      executionAttemptId: claim.executionAttemptId,
      stepAttemptId: claim.stepAttemptId,
      taskFence: claim.taskFence,
      stepFence: claim.stepFence,
      modelInvocationId: claim.modelInvocationId,
    };
  }

  private async accepted(
    command: string,
    claim: GateAAnalysisWorkerClaim,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const payload = await this.send({ command, ...this.mutation(claim), ...extra });
    z.object({ command: z.literal(command), result: z.object({ accepted: z.literal(true) }).strict() }).strict().parse(payload);
  }

  private async send(body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
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
          if (size > MAX_RESPONSE_BYTES) response.destroy(new Error('Worker analysis response exceeded limit'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: string; message?: string } };
            if ((response.statusCode ?? 500) >= 400) {
              reject(new GenewayError(
                payload.error?.code ?? 'GATE_A_ANALYSIS_COMMAND_FAILED',
                payload.error?.message ?? 'Worker analysis command failed',
                response.statusCode,
              ));
            } else resolve(payload);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Worker analysis response was invalid'));
          }
        });
        response.once('error', reject);
      });
      req.once('error', reject);
      req.end(serialized);
    });
  }
}

export async function executeGateAAnalysisClaim(
  port: GateAAnalysisCommandPort,
  runtime: GateAAnalysisRuntimeAdapter,
  claim: GateAAnalysisWorkerClaim,
  signal?: AbortSignal,
): Promise<void> {
  const cancelController = new AbortController();
  const executionSignal = signal === undefined ? cancelController.signal : AbortSignal.any([signal, cancelController.signal]);
  let monitorActive = true;
  let cancellation: GateAAnalysisCancellation | null = null;
  let monitorFailure: unknown;
  let runtimeInFlight = false;
  const signalAborted = (): boolean => signal?.aborted === true;
  const monitor = (async () => {
    while (monitorActive && !signalAborted()) {
      await wait(50, signal);
      if (!monitorActive || signalAborted()) return;
      try {
        cancellation = await port.cancelRequested(claim, signal);
        if (cancellation !== null) {
          cancelController.abort(new Error('Gate A analysis authority canceled'));
          return;
        }
      } catch (error) {
        if (signalAborted()) return;
        monitorFailure = error;
        cancelController.abort(error);
        return;
      }
    }
  })();
  try {
    await port.started(claim);
    runtimeInFlight = true;
    const result = await runtime.execute(claim, executionSignal);
    runtimeInFlight = false;
    if (monitorFailure !== undefined) {
      throw monitorFailure instanceof Error ? monitorFailure : new Error('Gate A cancel monitor failed');
    }
    if (cancellation !== null) await port.canceled(claim, cancellation);
    else await port.completed(claim, result);
  } catch (error) {
    if (monitorFailure !== undefined) {
      throw monitorFailure instanceof Error ? monitorFailure : new Error('Gate A cancel monitor failed');
    }
    if (cancellation === null && signal?.aborted !== true) cancellation = await port.cancelRequested(claim);
    if (cancellation !== null) {
      await port.canceled(claim, cancellation);
      return;
    }
    if (signal?.aborted === true) return;
    if (error instanceof GateAAnalysisRuntimeError) {
      await port.failed(claim, error);
      return;
    }
    if (!runtimeInFlight) throw error;
    await port.failed(claim, new GateAAnalysisRuntimeError('MODEL_PROTOCOL_VIOLATION'));
  } finally {
    monitorActive = false;
    cancelController.abort();
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
