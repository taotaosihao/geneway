import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  GenewayError,
  workerCommandResponseSchema,
  workerCommandSchema,
  type WorkerCommand,
  type WorkerCommandResponse,
  type WorkerDelivery,
  type WorkerInputContent,
} from '@geneway/contracts';
import type { ExecutionCommandPort } from './interpreter.js';

const COMMAND_PATH = '/internal/worker/v1/commands';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MUTATION_MAX_ATTEMPTS = 3;
const MUTATION_RETRY_DELAYS_MS = [25, 100] as const;

class WorkerCommandOutcomeUncertainError extends GenewayError {
  constructor(causeCode: string, message: string, statusCode = 502) {
    super('WORKER_COMMAND_OUTCOME_UNCERTAIN', message, statusCode, { causeCode });
  }
}

export type WorkerIdentity = Readonly<{
  workerInstanceId: string;
  consumer: 'gate0.2a-worker';
  deploymentId: 'gate0.2a-local';
}>;

export async function readWorkerToken(tokenFile: string): Promise<string> {
  if (!isAbsolute(tokenFile)) throw new GenewayError('WORKER_TOKEN_PATH_INVALID', 'Worker token file path must be absolute');

  const handle = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new GenewayError('WORKER_TOKEN_FILE_INVALID', 'Worker token path must reference a regular file');
    if ((stat.mode & 0o777) !== 0o600) throw new GenewayError('WORKER_TOKEN_FILE_PERMISSIONS', 'Worker token file permissions must be 0600');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new GenewayError('WORKER_TOKEN_FILE_OWNER', 'Worker token file must be owned by the worker process user');
    }
    if (stat.size < 16 || stat.size > 4_096) throw new GenewayError('WORKER_TOKEN_FILE_SIZE', 'Worker token file size is outside the accepted range');

    const token = (await handle.readFile({ encoding: 'utf8' })).trim();
    if (token.length < 16 || token.length > 4_096 || /\s/u.test(token)) {
      throw new GenewayError('WORKER_TOKEN_INVALID', 'Worker token is malformed');
    }
    return token;
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'WORKER_COMMAND_FAILED';
}

function buildIdempotencyKey(kind: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
  return `${kind}:${hash}`;
}

export class WorkerCommandClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    readonly identity: WorkerIdentity,
  ) {
    if (!isAbsolute(socketPath)) throw new GenewayError('WORKER_SOCKET_PATH_INVALID', 'Worker command socket path must be absolute');
    if (socketPath.includes('\0') || Buffer.byteLength(socketPath, 'utf8') > 100) {
      throw new GenewayError('WORKER_SOCKET_PATH_INVALID', 'Worker command socket path is invalid or too long');
    }
  }

  async authenticate(signal?: AbortSignal): Promise<void> {
    const response = await this.send({
      command: 'session',
      protocolVersion: 'gate0.2a-worker-command/1',
      ...this.identity,
    }, signal);
    if (response.command !== 'session' || response.result.authenticated !== true) {
      throw new GenewayError('WORKER_SESSION_REJECTED', 'Worker session was not authenticated', 401);
    }
  }

  async claimDelivery(signal?: AbortSignal): Promise<WorkerDelivery | null> {
    const response = await this.send({
      command: 'claim_delivery',
      protocolVersion: 'gate0.2a-worker-command/1',
      ...this.identity,
    }, signal);
    if (response.command !== 'claim_delivery') throw new GenewayError('WORKER_RESPONSE_MISMATCH', 'Worker claim response has the wrong command');
    const delivery = response.result;
    if (delivery !== null && (
      delivery.workerInstanceId !== this.identity.workerInstanceId
      || delivery.consumer !== this.identity.consumer
      || delivery.deploymentId !== this.identity.deploymentId
    )) {
      throw new GenewayError('WORKER_DELIVERY_IDENTITY_MISMATCH', 'Claimed delivery is bound to a different worker identity', 409);
    }
    return delivery;
  }

  async readInput(delivery: WorkerDelivery): Promise<WorkerInputContent> {
    const response = await this.send({
      command: 'read_input',
      ...this.executionFields(delivery),
    });
    if (response.command !== 'read_input') throw new GenewayError('WORKER_RESPONSE_MISMATCH', 'Worker input response has the wrong command');
    return response.result;
  }

  bind(delivery: WorkerDelivery): ExecutionCommandPort {
    this.assertDeliveryIdentity(delivery);
    const fields = this.executionFields(delivery);
    return {
      claimStep: async (stepId, stepAttemptId) => {
        const response = await this.sendMutation({
          command: 'claim_step',
          ...fields,
          stepId,
          stepAttemptId,
          idempotencyKey: buildIdempotencyKey('claim-step', delivery.lease.attemptId, stepId, stepAttemptId),
        });
        if (response.command !== 'claim_step') throw new GenewayError('WORKER_RESPONSE_MISMATCH', 'Worker step claim response has the wrong command');
        if (response.result.state === 'completed') {
          const output = response.result.output;
          if (typeof output !== 'object' || output === null || typeof (output as { summary?: unknown }).summary !== 'string') {
            throw new GenewayError('WORKER_CHECKPOINT_INVALID', 'Completed step checkpoint has an invalid output', 409);
          }
          return { state: 'completed' as const, output: output as { summary: string } };
        }
        if (response.result.stepAttemptId !== stepAttemptId) {
          throw new GenewayError('WORKER_STEP_ATTEMPT_MISMATCH', 'Step lease is bound to a different attempt', 409);
        }
        return {
          state: 'claimed' as const,
          lease: { attemptId: response.result.stepAttemptId, fencingToken: response.result.fencingToken },
        };
      },
      completeStep: async (stepId, lease, output) => {
        const response = await this.sendMutation({
          command: 'complete_step',
          ...fields,
          stepId,
          stepAttemptId: lease.attemptId,
          stepFencingToken: lease.fencingToken,
          output,
          idempotencyKey: buildIdempotencyKey('complete-step', delivery.lease.attemptId, stepId, lease.attemptId),
        });
        this.assertAccepted(response, 'complete_step');
      },
      submitCandidate: async (candidate, idempotencyKey) => {
        const response = await this.sendMutation({
          command: 'submit_candidate',
          ...fields,
          candidate,
          idempotencyKey: buildIdempotencyKey('submit-candidate', delivery.lease.attemptId, idempotencyKey),
        });
        this.assertAccepted(response, 'submit_candidate');
      },
      fail: async (code, message) => {
        const response = await this.sendMutation({
          command: 'fail_delivery',
          ...fields,
          code,
          message: message.slice(0, 2_000),
          idempotencyKey: buildIdempotencyKey('fail-delivery', delivery.lease.attemptId),
        });
        this.assertAccepted(response, 'fail_delivery');
      },
    };
  }

  private executionFields(delivery: WorkerDelivery): Readonly<{
    protocolVersion: 'gate0.2a-worker-command/1';
    workerInstanceId: string;
    deliveryId: string;
    eventId: string;
    attemptId: string;
    fencingToken: number;
  }> {
    this.assertDeliveryIdentity(delivery);
    return {
      protocolVersion: 'gate0.2a-worker-command/1',
      workerInstanceId: this.identity.workerInstanceId,
      deliveryId: delivery.lease.deliveryId,
      eventId: delivery.lease.eventId,
      attemptId: delivery.lease.attemptId,
      fencingToken: delivery.lease.fencingToken,
    };
  }

  private assertDeliveryIdentity(delivery: WorkerDelivery): void {
    if (
      delivery.workerInstanceId !== this.identity.workerInstanceId
      || delivery.consumer !== this.identity.consumer
      || delivery.deploymentId !== this.identity.deploymentId
    ) {
      throw new GenewayError('WORKER_DELIVERY_IDENTITY_MISMATCH', 'Delivery is bound to a different worker identity', 409);
    }
  }

  private assertAccepted(response: WorkerCommandResponse, command: 'complete_step' | 'submit_candidate' | 'fail_delivery'): void {
    if (response.command !== command || response.result.accepted !== true) {
      throw new GenewayError('WORKER_RESPONSE_MISMATCH', `Worker ${command} response was not accepted`);
    }
  }

  private async send(commandInput: WorkerCommand, signal?: AbortSignal): Promise<WorkerCommandResponse> {
    const command = workerCommandSchema.parse(commandInput);
    const body = JSON.stringify(command);
    return this.sendSerialized(command, body, signal);
  }

  private async sendMutation(commandInput: WorkerCommand): Promise<WorkerCommandResponse> {
    const command = workerCommandSchema.parse(commandInput);
    const body = JSON.stringify(command);
    let lastError: WorkerCommandOutcomeUncertainError | undefined;
    for (let attempt = 1; attempt <= MUTATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.sendSerialized(command, body);
      } catch (error) {
        if (!(error instanceof WorkerCommandOutcomeUncertainError)) throw error;
        lastError = error;
        if (attempt === MUTATION_MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, MUTATION_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
    const lastCauseCode = lastError?.details?.causeCode;
    throw new WorkerCommandOutcomeUncertainError(
      typeof lastCauseCode === 'string' ? lastCauseCode : 'WORKER_COMMAND_TRANSPORT_FAILED',
      `Worker command outcome remained uncertain after ${String(MUTATION_MAX_ATTEMPTS)} identical attempts`,
      lastError?.statusCode ?? 502,
    );
  }

  private async sendSerialized(
    command: WorkerCommand,
    body: string,
    signal?: AbortSignal,
  ): Promise<WorkerCommandResponse> {
    const payload = await new Promise<unknown>((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: COMMAND_PATH,
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            const statusCode = response.statusCode ?? 502;
            response.destroy(statusCode === 200
              ? new WorkerCommandOutcomeUncertainError('WORKER_RESPONSE_TOO_LARGE', 'Worker command response exceeded the size limit')
              : new GenewayError('WORKER_COMMAND_REJECTED', `Worker command was rejected with HTTP ${String(statusCode)}`, statusCode));
            return;
          }
          chunks.push(chunk);
        });
        response.once('aborted', () => reject(new WorkerCommandOutcomeUncertainError(
          'WORKER_RESPONSE_ABORTED',
          'Worker command response ended before completion',
        )));
        response.once('error', (error) => reject(new WorkerCommandOutcomeUncertainError(
          errorCode(error),
          'Worker command response failed before completion',
        )));
        response.on('end', () => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            const statusCode = response.statusCode ?? 502;
            reject(statusCode === 200
              ? new WorkerCommandOutcomeUncertainError('WORKER_RESPONSE_INVALID_JSON', 'Worker command response was not valid JSON')
              : new GenewayError('WORKER_COMMAND_REJECTED', `Worker command was rejected with HTTP ${String(statusCode)}`, statusCode));
            return;
          }
          if (response.statusCode !== 200) {
            const payload = decoded as Readonly<{ error?: Readonly<{ code?: unknown; message?: unknown }> }>;
            const code = typeof payload.error?.code === 'string' ? payload.error.code : 'WORKER_COMMAND_REJECTED';
            const message = typeof payload.error?.message === 'string'
              ? payload.error.message
              : `Worker command was rejected with HTTP ${String(response.statusCode ?? 0)}`;
            reject(new GenewayError(code, message, response.statusCode ?? 502));
            return;
          }
          const contentType = response.headers['content-type'];
          if (contentType === undefined || !contentType.toLowerCase().startsWith('application/json')) {
            reject(new WorkerCommandOutcomeUncertainError('WORKER_RESPONSE_CONTENT_TYPE', 'Worker command response was not JSON'));
            return;
          }
          resolve(decoded);
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(
        new WorkerCommandOutcomeUncertainError('WORKER_COMMAND_TIMEOUT', 'Worker command timed out', 504),
      ));
      req.once('error', (error) => reject(error instanceof WorkerCommandOutcomeUncertainError
        ? error
        : new WorkerCommandOutcomeUncertainError(errorCode(error), 'Worker command transport failed')));
      req.end(body);
    });

    const response = workerCommandResponseSchema.parse(payload);
    if (response.command !== command.command) throw new GenewayError('WORKER_RESPONSE_MISMATCH', 'Worker response command does not match the request');
    return response;
  }
}
