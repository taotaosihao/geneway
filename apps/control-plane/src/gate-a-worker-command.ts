import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GenewayError,
  gateAAnalysisErrorClassSchema,
  gateAAnalysisGatewayReceiptSchema,
  gateAAgentOutputSchema,
} from '@geneway/contracts';
import {
  StorageObjectAlreadyExistsError,
  type ObjectStorage,
} from '@geneway/storage';
import type {
  GateAAnalysisMutation,
  GateAAnalysisTerminal,
  GateALiveRepository,
} from './gate-a-live-repository.js';

const mutationShape = {
  taskId: z.string().min(1).max(200),
  workflowVersionId: z.string().min(1).max(200),
  workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
  stepId: z.string().min(1).max(200),
  executionAttemptId: z.string().min(1).max(200),
  stepAttemptId: z.string().min(1).max(200),
  taskFence: z.number().int().positive(),
  stepFence: z.number().int().positive(),
  modelInvocationId: z.string().min(1).max(200),
} as const;

const analysisTerminalSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    output: gateAAgentOutputSchema,
    receipt: gateAAnalysisGatewayReceiptSchema,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    errorClass: gateAAnalysisErrorClassSchema,
    receipt: gateAAnalysisGatewayReceiptSchema.optional(),
  }).strict(),
  z.object({ status: z.literal('canceled') }).strict(),
]);

const gateAWorkerCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('claim_gate_a_analysis'),
    workerInstanceId: z.string().min(1).max(200),
  }).strict(),
  z.object({ command: z.literal('gate_a_analysis_started'), ...mutationShape }).strict(),
  z.object({
    command: z.literal('gate_a_analysis_terminal'),
    ...mutationShape,
    terminal: analysisTerminalSchema,
  }).strict(),
  z.object({ command: z.literal('request_gate_a_analysis_cancel'), ...mutationShape }).strict(),
]);

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function mutationOf(command: Readonly<Record<keyof GateAAnalysisMutation, unknown>>): GateAAnalysisMutation {
  return {
    taskId: command.taskId as string,
    workflowVersionId: command.workflowVersionId as string,
    workflowHash: command.workflowHash as string,
    stepId: command.stepId as string,
    executionAttemptId: command.executionAttemptId as string,
    stepAttemptId: command.stepAttemptId as string,
    taskFence: command.taskFence as number,
    stepFence: command.stepFence as number,
    modelInvocationId: command.modelInvocationId as string,
  };
}

function terminalOf(terminal: z.infer<typeof analysisTerminalSchema>): GateAAnalysisTerminal {
  switch (terminal.status) {
    case 'completed':
      return { status: terminal.status, output: terminal.output, receipt: terminal.receipt };
    case 'failed':
      return terminal.receipt === undefined
        ? { status: terminal.status, errorClass: terminal.errorClass }
        : { status: terminal.status, errorClass: terminal.errorClass, receipt: terminal.receipt };
    case 'canceled':
      return { status: terminal.status };
  }
}

async function publishLiveReport(
  repository: GateALiveRepository,
  storage: ObjectStorage,
  mutation: GateAAnalysisMutation,
): Promise<void> {
  const intent = await repository.prepareLiveReport(mutation, storage.bucket);
  if (intent.status === 'published') {
    await repository.finalizeLiveReport(intent, mutation);
    return;
  }
  let head: Awaited<ReturnType<ObjectStorage['head']>>;
  let observed: Uint8Array;
  try {
    if (intent.status !== 'object_verified') {
      try {
        await storage.putCreateOnly({
          key: intent.storageKey,
          bytes: intent.bytes,
          contentType: 'text/markdown',
          contentSha256: intent.contentSha256,
        });
      } catch (error) {
        if (!(error instanceof StorageObjectAlreadyExistsError)) throw error;
      }
    }
    [head, observed] = await Promise.all([
      storage.head(intent.storageKey),
      storage.getBytes(intent.storageKey, 1_048_576),
    ]);
  } catch (error) {
    await repository.markLiveReportReconciliationRequired(intent, 'REPORT_STORAGE_OUTCOME_UNCERTAIN');
    throw error;
  }
  const observedSha256 = createHash('sha256').update(observed).digest('hex');
  if (head.sizeBytes !== intent.sizeBytes || observed.byteLength !== intent.sizeBytes
    || head.contentType !== 'text/markdown' || head.contentSha256 !== intent.contentSha256
    || observedSha256 !== intent.contentSha256) {
    await repository.failLiveReportPublication(intent, mutation, 'REPORT_OBJECT_INTEGRITY_FAILED');
    throw new GenewayError('REPORT_OBJECT_INTEGRITY_FAILED', 'Gate A report object failed immutable verification', 409);
  }
  try {
    await repository.markLiveReportObjectVerified(intent, head.eTag);
    await repository.finalizeLiveReport(intent, mutation);
  } catch (error) {
    const terminalFailureCodes = new Set([
      'APPROVAL_SUBJECT_CHANGED',
      'APPROVAL_AUTHORITY_CHANGED',
      'APPROVAL_AUTHORITY_TEMPORAL_EXPIRY',
      'DATA_ROUTE_NOT_ALLOWED',
      'REPORT_AUTHORITY_INVALID',
      'REPORT_INTENT_CONFLICT',
      'REPORT_OBJECT_INTEGRITY_FAILED',
    ]);
    if (error instanceof GenewayError && terminalFailureCodes.has(error.code)) {
      await repository.failLiveReportPublication(intent, mutation, error.code);
    }
    throw error;
  }
}

export function registerGateAWorkerCommands(
  app: FastifyInstance,
  input: Readonly<{
    repository: GateALiveRepository;
    workerToken: string;
    leaseDurationMs: number;
    storage: ObjectStorage;
  }>,
): void {
  if (input.workerToken.length < 32) throw new Error('Worker service token must contain at least 32 characters');
  app.post('/internal/worker/v1/gate-a-analysis-commands', async (request, reply) => {
    if (request.headers.origin !== undefined) {
      throw new GenewayError('WORKER_BROWSER_ORIGIN_DENIED', 'Browser-originated Worker commands are not allowed', 403);
    }
    if (!bearerMatches(request.headers.authorization, input.workerToken)) {
      throw new GenewayError('WORKER_AUTH_REQUIRED', 'Worker service authentication failed', 401);
    }
    const command = gateAWorkerCommandSchema.parse(request.body);
    switch (command.command) {
      case 'claim_gate_a_analysis': {
        const result = await input.repository.claimAnalysis(command.workerInstanceId, input.leaseDurationMs);
        if (result === null) {
          const report = await input.repository.claimPendingLiveReportMutation(
            command.workerInstanceId, input.leaseDurationMs,
          );
          if (report !== null) await publishLiveReport(input.repository, input.storage, report);
        }
        return reply.status(200).send({
          command: command.command,
          result,
        });
      }
      case 'gate_a_analysis_started':
        await input.repository.markAnalysisStarted(mutationOf(command));
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'gate_a_analysis_terminal': {
        const publish = await input.repository.settleAnalysis(mutationOf(command), terminalOf(command.terminal));
        if (command.terminal.status === 'completed' && publish) {
          await publishLiveReport(input.repository, input.storage, mutationOf(command));
        }
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      }
      case 'request_gate_a_analysis_cancel': {
        const cancellation = await input.repository.requestAnalysisCancellation(mutationOf(command));
        return reply.status(200).send({
          command: command.command,
          result: cancellation === null ? { cancelRequested: false } : { cancelRequested: true, ...cancellation },
        });
      }
    }
  });
}
