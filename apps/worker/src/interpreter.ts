import { randomUUID } from 'node:crypto';
import {
  attemptOutputCandidatePayloadSchema,
  type AttemptOutputCandidatePayload,
  type ResolvedTaskInputRef,
} from '@geneway/contracts';
import { FakeRuntime } from '@geneway/runtime';
import type { CompiledWorkflowVersion } from '@geneway/workflow';

export type StepLease = Readonly<{ attemptId: string; fencingToken: number }>;
export type ExecutableWorkflow = Pick<CompiledWorkflowVersion, 'id' | 'hash' | 'payload'>;

export interface ExecutionCommandPort {
  claimStep(stepId: string, attemptId: string): Promise<StepLease>;
  completeStep(stepId: string, lease: StepLease, output: unknown): Promise<void>;
  submitCandidate(candidate: AttemptOutputCandidatePayload, idempotencyKey: string): Promise<void>;
  fail(code: string, message: string): Promise<void>;
}

export class WorkflowInterpreter {
  constructor(
    private readonly port: ExecutionCommandPort,
    private readonly runtime = new FakeRuntime(),
    private readonly stepPacingMs = 0,
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
        const lease = await this.port.claimStep(node.id, stepAttemptId);
        const output = this.runtime.executeStep(node.id, {
          inputRef: input.inputRef,
          ...(input.inputBytes === undefined ? {} : { inputBytes: input.inputBytes }),
        });
        if (output.evidence !== undefined) evidence.push(output.evidence);
        if (output.claims !== undefined) claims.push(...output.claims);
        await this.port.completeStep(node.id, lease, output);
        summaries.push(output.summary);
        if (this.stepPacingMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stepPacingMs));
      }
      const candidate = attemptOutputCandidatePayloadSchema.parse({
        evidence,
        claims,
        result: {
          kind: 'completed',
          summary: '小纬已完成模拟方案分析，结论仅供演示，不能用于业务决策。',
          stepSummaries: summaries,
          simulation: true,
          runtimeMode: 'fake',
          businessDecisionAllowed: false,
        },
      });
      await this.port.submitCandidate(candidate, `candidate-${randomUUID()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown interpreter failure';
      try {
        await this.port.fail('INTERPRETER_FAILED', message);
      } catch (failureError) {
        throw new AggregateError([error, failureError], 'Interpreter failed and the failure could not be reported');
      }
      throw error;
    }
  }
}
