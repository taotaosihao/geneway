import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GenewayError } from '@geneway/contracts';
import type { WorkerDelivery, WorkerInputContent } from '@geneway/contracts';
import {
  compileWorkflow,
  createSolutionAnalysisDocumentDraft,
  createSolutionAnalysisDraft,
  readStoredWorkflowVersion,
} from '@geneway/workflow';
import type { WorkerCommandClient } from './command-client.js';
import { WorkflowInterpreter } from './interpreter.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type WorkerLoopOptions = Readonly<{
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onReady?: () => void | Promise<void>;
}>;

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function decodeDocumentBytes(input: Extract<WorkerInputContent, { kind: 'document_snapshot' }>): Uint8Array {
  if (!BASE64_PATTERN.test(input.bytesBase64)) throw new GenewayError('WORKER_INPUT_BASE64_INVALID', 'Document snapshot bytes are not valid base64', 409);
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) {
    throw new GenewayError('WORKER_INPUT_SIZE_INVALID', 'Document snapshot bytes are outside the accepted range', 409);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== input.inputRef.contentSha256) throw new GenewayError('WORKER_INPUT_HASH_MISMATCH', 'Document snapshot bytes do not match the resolved input hash', 409);
  return bytes;
}

function assertFixedWorkflow(delivery: WorkerDelivery): ReturnType<typeof readStoredWorkflowVersion> {
  const workflow = readStoredWorkflowVersion(delivery.workflow);
  const expected = compileWorkflow(delivery.inputRef.kind === 'fixture'
    ? createSolutionAnalysisDraft()
    : createSolutionAnalysisDocumentDraft(delivery.inputRef.resourceScope));
  if (workflow.id !== expected.id || workflow.hash !== expected.hash) {
    throw new GenewayError('WORKER_WORKFLOW_NOT_OPEN', 'Worker only executes the fixed seven-node Gate 0.2A workflow', 422);
  }
  return workflow;
}

function assertInputMatchesDelivery(delivery: WorkerDelivery, input: WorkerInputContent): void {
  if (!isDeepStrictEqual(input.inputRef, delivery.inputRef)) {
    throw new GenewayError('WORKER_INPUT_REF_MISMATCH', 'Worker input does not match the claimed delivery', 409);
  }
}

export async function executeDelivery(client: WorkerCommandClient, delivery: WorkerDelivery): Promise<void> {
  const port = client.bind(delivery);
  let interpreterStarted = false;
  try {
    const workflow = assertFixedWorkflow(delivery);
    const input = await client.readInput(delivery);
    assertInputMatchesDelivery(delivery, input);
    const executionInput = {
      workflow,
      inputRef: input.inputRef,
      ...(input.kind === 'document_snapshot' ? { inputBytes: decodeDocumentBytes(input) } : {}),
    };
    const interpreter = new WorkflowInterpreter(port);
    interpreterStarted = true;
    await interpreter.execute(executionInput);
  } catch (error) {
    if (!interpreterStarted) {
      const message = error instanceof Error ? error.message : 'Worker delivery validation failed';
      try {
        await port.fail('DELIVERY_VALIDATION_FAILED', message);
      } catch (failureError) {
        throw new AggregateError([error, failureError], 'Delivery validation failed and the failure could not be reported');
      }
    }
    throw error;
  }
}

export async function runWorkerLoop(client: WorkerCommandClient, options: WorkerLoopOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
    throw new GenewayError('WORKER_POLL_INTERVAL_INVALID', 'Worker poll interval is invalid');
  }

  await client.authenticate(options.signal);
  if (isAborted(options.signal)) return;
  await options.onReady?.();
  while (!isAborted(options.signal)) {
    const delivery = await client.claimDelivery(options.signal);
    if (delivery !== null) {
      await executeDelivery(client, delivery);
      continue;
    }
    await wait(pollIntervalMs, options.signal);
  }
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (isAborted(signal)) return;
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
