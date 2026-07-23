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
import { WorkflowInterpreter, type ClaimedStepHook } from './interpreter.js';
import { ChatRuntimeError, type ChatRuntimeAdapter } from '@geneway/runtime';
import type { ChatWorkerCommandClient, ChatTurnClaim } from './chat-command-client.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type WorkerLoopOptions = Readonly<{
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onReady?: () => void | Promise<void>;
  stepPacingMs?: number;
  onDeliveryAbandoned?: (delivery: WorkerDelivery, error: GenewayError) => void | Promise<void>;
  onAfterDeliveryClaim?: (delivery: WorkerDelivery) => Promise<void>;
  onBeforeCompleteStep?: (delivery: WorkerDelivery, step: Parameters<ClaimedStepHook>[0]) => Promise<void>;
  chat?: Readonly<{ client: ChatWorkerCommandClient; runtime: ChatRuntimeAdapter }>;
}>;

const AUTHORITY_LOSS_CODES = new Set([
  'BACKUP_BARRIER_ACTIVE',
  'WORKER_COMMAND_OUTCOME_UNCERTAIN',
  'STALE_EXECUTION_ATTEMPT',
  'STALE_OR_UNAUTHORIZED_WORKER_COMMAND',
  'STALE_STEP_COMPLETION',
  'TASK_TERMINAL_CONFLICT',
  'TERMINAL_PUBLISH_CAS_CONFLICT',
  'REPORT_INTENT_CONFLICT',
  'REPORT_PUBLISH_CAS_CONFLICT',
  'LEASE_RENEWAL_CONFLICT',
  'WORKER_INBOX_CAS_CONFLICT',
]);

function asAuthorityLoss(error: unknown): GenewayError | null {
  return error instanceof GenewayError && AUTHORITY_LOSS_CODES.has(error.code) ? error : null;
}

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

export async function executeDelivery(
  client: WorkerCommandClient,
  delivery: WorkerDelivery,
  stepPacingMs = 0,
  onBeforeCompleteStep?: WorkerLoopOptions['onBeforeCompleteStep'],
): Promise<void> {
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
    const interpreter = new WorkflowInterpreter(port, undefined, stepPacingMs, onBeforeCompleteStep === undefined
      ? undefined
      : (step) => onBeforeCompleteStep(delivery, step));
    interpreterStarted = true;
    await interpreter.execute(executionInput);
  } catch (error) {
    if (!interpreterStarted) {
      if (asAuthorityLoss(error) !== null) throw error;
      const message = error instanceof Error ? error.message : 'Worker delivery validation failed';
      try {
        await port.fail('DELIVERY_VALIDATION_FAILED', message);
      } catch (failureError) {
        if (asAuthorityLoss(failureError) !== null) throw failureError;
        throw new AggregateError([error, failureError], 'Delivery validation failed and the failure could not be reported');
      }
      return;
    }
    throw error;
  }
}

export async function runWorkerLoop(client: WorkerCommandClient, options: WorkerLoopOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
    throw new GenewayError('WORKER_POLL_INTERVAL_INVALID', 'Worker poll interval is invalid');
  }
  const stepPacingMs = options.stepPacingMs ?? 0;
  if (!Number.isInteger(stepPacingMs) || stepPacingMs < 0 || stepPacingMs > 2_000) {
    throw new GenewayError('WORKER_STEP_DELAY_INVALID', 'Worker step pacing is invalid');
  }

  await client.authenticate(options.signal);
  if (isAborted(options.signal)) return;
  await options.onReady?.();
  while (!isAborted(options.signal)) {
    if (options.chat !== undefined) {
      const claim = await options.chat.client.claim(options.signal);
      if (claim !== null) {
        await executeChatTurn(options.chat.client, options.chat.runtime, claim, options.signal);
        continue;
      }
    }
    let delivery: WorkerDelivery | null;
    try {
      delivery = await client.claimDelivery(options.signal);
    } catch (error) {
      if (asAuthorityLoss(error) === null) throw error;
      await wait(pollIntervalMs, options.signal);
      continue;
    }
    if (delivery !== null) {
      await options.onAfterDeliveryClaim?.(delivery);
      try {
        await executeDelivery(client, delivery, stepPacingMs, options.onBeforeCompleteStep);
      } catch (error) {
        const authorityLoss = asAuthorityLoss(error);
        if (authorityLoss === null) throw error;
        await options.onDeliveryAbandoned?.(delivery, authorityLoss);
      }
      continue;
    }
    await wait(pollIntervalMs, options.signal);
  }
}

export async function executeChatTurn(
  client: ChatWorkerCommandClient,
  runtime: ChatRuntimeAdapter,
  claim: ChatTurnClaim,
  signal?: AbortSignal,
): Promise<void> {
  const cancelController = new AbortController();
  const executionSignal = signal === undefined
    ? cancelController.signal
    : AbortSignal.any([signal, cancelController.signal]);
  let monitorActive = true;
  let cancelFence: number | null = null;
  let monitorFailure: unknown;
  const monitor = (async () => {
    while (monitorActive && !isAborted(signal)) {
      await wait(50, signal);
      if (!monitorActive || isAborted(signal)) return;
      try {
        const requestedFence = await client.cancelRequested(claim, signal);
        if (requestedFence !== null) {
          cancelFence = requestedFence;
          cancelController.abort(new Error('user canceled chat generation'));
          return;
        }
      } catch (error) {
        if (isAborted(signal)) return;
        monitorFailure = error;
        cancelController.abort(error);
        return;
      }
    }
  })();
  try {
    await client.execute(claim);
    await client.started(claim);
    const terminal = await runtime.stream({
      conversationId: claim.conversationId,
      modelInvocationId: claim.modelInvocationId,
      fence: claim.fence,
      invocationToken: claim.invocationToken,
      logicalModelPolicy: claim.logicalModelPolicy,
      promptPolicyVersion: claim.promptPolicyVersion,
      systemPrompt: claim.systemPrompt,
      context: claim.context,
      deadline: claim.deadline,
    }, (delta) => client.delta(claim, delta), executionSignal);
    if (monitorFailure !== undefined) throw monitorFailure instanceof Error ? monitorFailure : new Error('Chat cancel monitor failed');
    if (cancelFence !== null) await client.canceled(claim, cancelFence);
    else await client.completed(claim, terminal);
  } catch (error) {
    if (monitorFailure !== undefined) throw monitorFailure instanceof Error ? monitorFailure : new Error('Chat cancel monitor failed');
    if (cancelFence === null && !isAborted(signal)) cancelFence = await client.cancelRequested(claim);
    if (cancelFence !== null) {
      await client.canceled(claim, cancelFence);
      return;
    }
    if (!(error instanceof ChatRuntimeError) || error.receipt === undefined) throw error;
    await client.failed(claim, error.receipt);
  } finally {
    monitorActive = false;
    cancelController.abort();
    await monitor;
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
