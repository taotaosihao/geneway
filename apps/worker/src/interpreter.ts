import { randomUUID } from 'node:crypto';
import {
  GenewayError,
  attemptOutputCandidatePayloadSchema,
  type AttemptOutputCandidatePayload,
  type ResolvedTaskInputRef,
} from '@geneway/contracts';
import { FakeRuntime, type FakeStepOutput } from '@geneway/runtime';
import type { CompiledWorkflowVersion } from '@geneway/workflow';

export type StepLease = Readonly<{ attemptId: string; fencingToken: number }>;
export type StepClaim =
  | Readonly<{ state: 'claimed'; lease: StepLease }>
  | Readonly<{ state: 'completed'; output: FakeStepOutput }>;
export type ExecutableWorkflow = Pick<CompiledWorkflowVersion, 'id' | 'hash' | 'payload'>;
export type ClaimedStepHook = (input: Readonly<{
  stepId: string;
  stepAttemptId: string;
  lease: StepLease;
}>) => Promise<void>;

export interface ExecutionCommandPort {
  claimStep(stepId: string, attemptId: string): Promise<StepClaim>;
  completeStep(stepId: string, lease: StepLease, output: unknown): Promise<void>;
  submitCandidate(candidate: AttemptOutputCandidatePayload, idempotencyKey: string): Promise<void>;
  fail(code: string, message: string): Promise<void>;
}

const CONTROLLED_ABANDON_CODES = new Set([
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

function isControlledAbandon(error: unknown): error is GenewayError {
  return error instanceof GenewayError && CONTROLLED_ABANDON_CODES.has(error.code);
}

export class WorkflowInterpreter {
  constructor(
    private readonly port: ExecutionCommandPort,
    private readonly runtime = new FakeRuntime(),
    private readonly stepPacingMs = 0,
    private readonly onClaimedStep?: ClaimedStepHook,
  ) {}

  async execute(input: Readonly<{
    inputRef: ResolvedTaskInputRef;
    inputBytes?: Uint8Array;
    workflow: ExecutableWorkflow;
  }>): Promise<void> {
    try {
      const summaries: string[] = [];
      const evidence: AttemptOutputCandidatePayload['evidence'][number][] = [];
      const claims: AttemptOutputCandidatePayload['claims'][number][] = [];
      for (const node of input.workflow.payload.nodes) {
        const stepAttemptId = `step_attempt_${randomUUID()}`;
        const claim = await this.port.claimStep(node.id, stepAttemptId);
        const output = claim.state === 'completed'
          ? claim.output
          : this.runtime.executeStep(node.id, {
              inputRef: input.inputRef,
              ...(input.inputBytes === undefined ? {} : { inputBytes: input.inputBytes }),
            });
        if (output.evidence !== undefined) evidence.push(output.evidence);
        if (output.claims !== undefined) claims.push(...output.claims);
        if (claim.state === 'claimed') {
          await this.onClaimedStep?.({ stepId: node.id, stepAttemptId, lease: claim.lease });
          // Test recovery must be able to kill a real Worker after the durable
          // claim but before completion. In normal operation this value is 0.
          if (this.stepPacingMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stepPacingMs));
          await this.port.completeStep(node.id, claim.lease, output);
        }
        summaries.push(output.summary);
      }
      const candidate = attemptOutputCandidatePayloadSchema.parse({
        evidence,
        claims,
        result: {
          kind: 'completed',
          summary: input.inputRef.kind === 'business_exception_snapshot'
            ? '小纬已完成模拟异常分析，结论仅供演示，不能用于业务决策。'
            : '小纬已完成模拟方案分析，结论仅供演示，不能用于业务决策。',
          stepSummaries: summaries,
          simulation: true,
          runtimeMode: 'fake',
          businessDecisionAllowed: false,
        },
      });
      await this.port.submitCandidate(candidate, `candidate-${randomUUID()}`);
    } catch (error) {
      // Cancellation, fencing loss, and a backup write barrier revoke the
      // current execution authority. Reporting those as a task failure would
      // let an obsolete Worker mutate the current task.
      if (isControlledAbandon(error)) throw error;
      const message = error instanceof Error ? error.message : 'Unknown interpreter failure';
      try {
        await this.port.fail('INTERPRETER_FAILED', message);
      } catch (failureError) {
        if (isControlledAbandon(failureError)) throw failureError;
        throw new AggregateError([error, failureError], 'Interpreter failed and the failure could not be reported');
      }
      // The delivery is now durably failed. Returning keeps the long-lived
      // Worker available for the next independent delivery.
      return;
    }
  }
}
