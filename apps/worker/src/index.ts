import { randomUUID } from 'node:crypto';
import type { ClaimCandidate, EvidenceCandidate } from '@geneway/evidence';
import { FakeRuntime } from '@geneway/runtime';
import type { CompiledWorkflowVersion } from '@geneway/workflow';

export type StepLease = Readonly<{ attemptId: string; fencingToken: number }>;

export interface InterpreterControlPort {
  startTask(tenantId: string, taskId: string, workflow: CompiledWorkflowVersion): Promise<void>;
  claimStep(tenantId: string, taskId: string, stepId: string, attemptId: string): Promise<StepLease>;
  completeStep(tenantId: string, taskId: string, stepId: string, lease: StepLease, output: unknown): Promise<void>;
  publishEvidenceAndClaims(tenantId: string, taskId: string, evidence: EvidenceCandidate | undefined, claims: readonly ClaimCandidate[]): Promise<void>;
  completeTask(tenantId: string, taskId: string, result: unknown): Promise<void>;
  failTask(tenantId: string, taskId: string, code: string, message: string): Promise<void>;
}

export class WorkflowInterpreter {
  constructor(
    private readonly port: InterpreterControlPort,
    private readonly runtime = new FakeRuntime(),
    private readonly stepPacingMs = 0,
  ) {}

  async execute(input: Readonly<{
    tenantId: string;
    taskId: string;
    fixtureRef: 'fixture:solution-analysis:v1';
    workflow: CompiledWorkflowVersion;
    alreadyStarted?: boolean;
  }>): Promise<void> {
    let ownsExecution = input.alreadyStarted === true;
    try {
      if (!ownsExecution) {
        await this.port.startTask(input.tenantId, input.taskId, input.workflow);
        ownsExecution = true;
      }
      const summaries: string[] = [];
      for (const node of input.workflow.payload.nodes) {
        const attemptId = `attempt_${randomUUID()}`;
        const lease = await this.port.claimStep(input.tenantId, input.taskId, node.id, attemptId);
        const output = this.runtime.executeStep(node.id, {
          tenantId: input.tenantId,
          businessTaskId: input.taskId,
          fixtureRef: input.fixtureRef,
        });
        if (output.claims !== undefined) {
          await this.port.publishEvidenceAndClaims(input.tenantId, input.taskId, output.evidence, output.claims);
        }
        await this.port.completeStep(input.tenantId, input.taskId, node.id, lease, output);
        summaries.push(output.summary);
        if (this.stepPacingMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stepPacingMs));
      }
      await this.port.completeTask(input.tenantId, input.taskId, {
        kind: 'completed',
        summary: '小纬已完成模拟方案分析，结论仅供演示，不能用于业务决策。',
        stepSummaries: summaries,
        simulation: true,
        runtimeMode: 'fake',
        businessDecisionAllowed: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown interpreter failure';
      if (ownsExecution) await this.port.failTask(input.tenantId, input.taskId, 'INTERPRETER_FAILED', message);
      throw error;
    }
  }
}
