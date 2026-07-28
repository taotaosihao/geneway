import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GenewayError } from '@geneway/contracts';
import type { WorkerDelivery, WorkerInputContent } from '@geneway/contracts';
import {
  compileWorkflow,
  createExceptionAssistDraft,
  createSolutionAnalysisDocumentDraft,
  createSolutionAnalysisDraft,
  readStoredWorkflowVersion,
} from '@geneway/workflow';
import type { WorkerCommandClient } from './command-client.js';
import { WorkflowInterpreter, type ClaimedStepHook } from './interpreter.js';
import { ChatRuntimeError, type ChatRuntimeAdapter } from '@geneway/runtime';
import type { ChatWorkerCommandClient, ChatTurnClaim } from './chat-command-client.js';
import {
  executeGateAAnalysisClaim,
  type GateAAnalysisCommandPort,
  type GateAAnalysisRuntimeAdapter,
} from './gate-a-live-runtime.js';
import {
  executeGateA3WorkOrderClaim,
  type GateA3ConnectorRuntimeAdapter,
  type GateA3WorkOrderCommandPort,
  type GateA3WorkOrderModelRuntimeAdapter,
} from './gate-a3-work-order-runtime.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type WorkerLoopOptions = Readonly<{
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onReady?: () => void | Promise<void>;
  stepPacingMs?: number;
  onDeliveryAbandoned?: (delivery: WorkerDelivery, error: GenewayError) => void | Promise<void>;
  onAfterDeliveryClaim?: (delivery: WorkerDelivery) => Promise<void>;
  onBeforeCompleteStep?: (delivery: WorkerDelivery, step: Parameters<ClaimedStepHook>[0]) => Promise<void>;
  onLaneFailure?: (
    lane: 'work_order' | 'analysis' | 'chat',
    failure: Readonly<{ code: string; retryDelayMs: number }>,
  ) => void | Promise<void>;
  chat?: Readonly<{ client: ChatWorkerCommandClient; runtime: ChatRuntimeAdapter }>;
  analysis?: Readonly<{ port: GateAAnalysisCommandPort; runtime: GateAAnalysisRuntimeAdapter }>;
  workOrder?: Readonly<{
    port: GateA3WorkOrderCommandPort;
    connectorRuntime: GateA3ConnectorRuntimeAdapter;
    modelRuntime: GateA3WorkOrderModelRuntimeAdapter;
  }>;
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

const FIXTURE_HASH_BY_VERSION = Object.freeze({
  'gate0.2b-capacity-lag/1': '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
  'gate0.2b-equipment-alarm/1': 'c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593',
});

function decodeBusinessExceptionBytes(input: Extract<WorkerInputContent, { kind: 'business_exception_snapshot' }>): Uint8Array {
  const bytes = Buffer.from(input.canonicalBytes, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const expectedFixtureHash = FIXTURE_HASH_BY_VERSION[input.inputRef.fixtureVersion];
  if (hash !== input.inputRef.sourceSha256 || hash !== expectedFixtureHash) {
    throw new GenewayError('WORKER_INPUT_HASH_MISMATCH', 'Business exception canonical bytes do not match the frozen source hash', 409);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(input.canonicalBytes) as unknown;
  } catch {
    throw new GenewayError('WORKER_INPUT_CANONICAL_JSON_INVALID', 'Business exception snapshot is not valid canonical JSON', 409);
  }
  if (JSON.stringify(snapshot) !== input.canonicalBytes || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new GenewayError('WORKER_INPUT_CANONICAL_JSON_INVALID', 'Business exception snapshot bytes are not the frozen compact canonical JSON', 409);
  }
  const record = snapshot as Readonly<Record<string, unknown>>;
  const ref = input.inputRef;
  if (record.fixtureVersion !== ref.fixtureVersion || record.sourceSystem !== ref.sourceSystem
    || record.sourceObjectRef !== ref.sourceObjectRef || record.detectionWindow !== ref.detectionWindow
    || record.resourceScope !== ref.resourceScope || record.dataClass !== ref.dataClass
    || ref.sourceAudience.businessExceptionId !== ref.businessExceptionId
    || ref.sourceAudience.resourceScope !== ref.resourceScope || ref.sourceAudience.dataClass !== ref.dataClass) {
    throw new GenewayError('WORKER_INPUT_REF_MISMATCH', 'Business exception snapshot does not match its frozen locator or audiences', 409);
  }
  return bytes;
}

function assertFixedWorkflow(delivery: WorkerDelivery): ReturnType<typeof readStoredWorkflowVersion> {
  const workflow = readStoredWorkflowVersion(delivery.workflow);
  const expected = compileWorkflow(delivery.inputRef.kind === 'fixture'
    ? createSolutionAnalysisDraft()
    : delivery.inputRef.kind === 'document_snapshot'
      ? createSolutionAnalysisDocumentDraft(delivery.inputRef.resourceScope)
      : createExceptionAssistDraft(delivery.inputRef.resourceScope));
  if (workflow.id !== expected.id || workflow.hash !== expected.hash) {
    throw new GenewayError('WORKER_WORKFLOW_NOT_OPEN', 'Worker only executes an exact fixed seven-node Gate workflow', 422);
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
      ...(input.kind === 'document_snapshot'
        ? { inputBytes: decodeDocumentBytes(input) }
        : input.kind === 'business_exception_snapshot'
          ? { inputBytes: decodeBusinessExceptionBytes(input) }
          : {}),
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
  const laneFailures = new Map<'work_order' | 'analysis' | 'chat', Readonly<{ count: number; retryAt: number }>>();
  const laneReady = (lane: 'work_order' | 'analysis' | 'chat'): boolean => (
    (laneFailures.get(lane)?.retryAt ?? 0) <= Date.now()
  );
  const laneSucceeded = (lane: 'work_order' | 'analysis' | 'chat'): void => { laneFailures.delete(lane); };
  const laneFailed = async (lane: 'work_order' | 'analysis' | 'chat', error: unknown): Promise<void> => {
    const count = Math.min((laneFailures.get(lane)?.count ?? 0) + 1, 8);
    const retryDelayMs = Math.min(5_000, Math.max(20, pollIntervalMs) * (2 ** Math.min(count - 1, 5)));
    laneFailures.set(lane, { count, retryAt: Date.now() + retryDelayMs });
    const code = error instanceof GenewayError && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
      ? error.code : 'UNEXPECTED_LANE_FAILURE';
    try {
      await options.onLaneFailure?.(lane, { code, retryDelayMs });
    } catch {
      // Audit delivery is observability-only and must not couple otherwise independent worker lanes.
    }
  };
  while (!isAborted(options.signal)) {
    if (options.workOrder !== undefined && laneReady('work_order')) {
      try {
        const claim = await options.workOrder.port.claim(options.signal);
        if (claim !== null) {
          await executeGateA3WorkOrderClaim(
            options.workOrder.port,
            options.workOrder.connectorRuntime,
            options.workOrder.modelRuntime,
            claim,
            options.signal,
          );
          laneSucceeded('work_order');
          continue;
        }
        laneSucceeded('work_order');
      } catch (error) {
        if (isAborted(options.signal)) return;
        await laneFailed('work_order', error);
      }
    }
    if (options.analysis !== undefined && laneReady('analysis')) {
      try {
        const claim = await options.analysis.port.claim(options.signal);
        if (claim !== null) {
          await executeGateAAnalysisClaim(options.analysis.port, options.analysis.runtime, claim, options.signal);
          laneSucceeded('analysis');
          continue;
        }
        laneSucceeded('analysis');
      } catch (error) {
        if (isAborted(options.signal)) return;
        await laneFailed('analysis', error);
      }
    }
    if (options.chat !== undefined && laneReady('chat')) {
      try {
        const claim = await options.chat.client.claim(options.signal);
        if (claim !== null) {
          await executeChatTurn(options.chat.client, options.chat.runtime, claim, options.signal);
          laneSucceeded('chat');
          continue;
        }
        laneSucceeded('chat');
      } catch (error) {
        if (isAborted(options.signal)) return;
        await laneFailed('chat', error);
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
