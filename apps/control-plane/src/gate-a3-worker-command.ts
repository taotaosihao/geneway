import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GenewayError,
  gateA3ConnectorErrorClassSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderStatusCardSchema,
  gateA3WorkOrderTerminalErrorClassSchema,
} from '@geneway/contracts';
import type {
  GateA3WorkOrderMutation,
  GateA3WorkOrderRepository,
} from './gate-a3-work-order-repository.js';

const stepSchema = z.object({
  stepId: z.enum(['validate_work_order_ref', 'fetch_authorized_status', 'compute_progress',
    'explain_status', 'evidence_verify', 'publish_status_card']),
  stepAttemptId: z.string().min(1).max(200),
  stepFence: z.number().int().positive(),
}).strict();

const mutationShape = {
  tenantId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200), workflowVersionId: z.string().min(1).max(200),
  workflowHash: z.string().regex(/^[a-f0-9]{64}$/u), executionAttemptId: z.string().min(1).max(200),
  taskFence: z.number().int().positive(),
} as const;

const terminalSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), card: gateA3WorkOrderStatusCardSchema,
    explanation: gateA3WorkOrderExplanationSchema }).strict(),
  z.object({ status: z.literal('failed'), errorClass: gateA3WorkOrderTerminalErrorClassSchema,
    receipt: z.unknown().optional() }).strict(),
  z.object({ status: z.literal('canceled') }).strict(),
]);

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('claim_gate_a3_work_order'),
    workerInstanceId: z.string().min(1).max(200) }).strict(),
  z.object({ command: z.literal('gate_a3_work_order_started'), ...mutationShape }).strict(),
  z.object({ command: z.literal('gate_a3_work_order_checkpoint'), ...mutationShape,
    step: stepSchema, output: z.unknown() }).strict(),
  z.object({ command: z.literal('gate_a3_work_order_connector_failed'), ...mutationShape,
    step: stepSchema.extend({ stepId: z.literal('fetch_authorized_status') }).strict(),
    failure: z.object({ errorClass: gateA3ConnectorErrorClassSchema,
      receipt: z.unknown().optional() }).strict() }).strict(),
  z.object({ command: z.literal('request_gate_a3_work_order_cancel'), ...mutationShape }).strict(),
  z.object({ command: z.literal('gate_a3_work_order_terminal'), ...mutationShape,
    step: stepSchema.optional(), terminal: terminalSchema }).strict(),
]);

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function mutationOf(command: z.infer<typeof commandSchema>): GateA3WorkOrderMutation {
  if (command.command === 'claim_gate_a3_work_order') throw new Error('claim has no mutation');
  return {
    tenantId: command.tenantId, taskId: command.taskId, workflowVersionId: command.workflowVersionId,
    workflowHash: command.workflowHash, executionAttemptId: command.executionAttemptId,
    taskFence: command.taskFence,
  };
}

export function registerGateA3WorkOrderCommands(
  app: FastifyInstance,
  input: Readonly<{
    repository: GateA3WorkOrderRepository;
    workerToken: string;
    leaseDurationMs: number;
  }>,
): void {
  if (input.workerToken.length < 32) throw new Error('Worker service token must contain at least 32 characters');
  app.post('/internal/worker/v1/gate-a3-work-order-commands', async (request, reply) => {
    if (request.headers.origin !== undefined) {
      throw new GenewayError('WORKER_BROWSER_ORIGIN_DENIED', 'Browser-originated Worker commands are not allowed', 403);
    }
    if (!bearerMatches(request.headers.authorization, input.workerToken)) {
      throw new GenewayError('WORKER_AUTH_REQUIRED', 'Worker service authentication failed', 401);
    }
    const command = commandSchema.parse(request.body);
    switch (command.command) {
      case 'claim_gate_a3_work_order':
        return reply.status(200).send({ command: command.command,
          result: await input.repository.claimWorkOrder(command.workerInstanceId, input.leaseDurationMs) });
      case 'gate_a3_work_order_started':
        await input.repository.markWorkOrderStarted(mutationOf(command));
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'gate_a3_work_order_checkpoint':
        return reply.status(200).send({ command: command.command,
          result: await input.repository.checkpointWorkOrder(mutationOf(command),
            command.step, command.output, input.leaseDurationMs) });
      case 'gate_a3_work_order_connector_failed':
        return reply.status(200).send({ command: command.command,
          result: await input.repository.handleConnectorFailure(mutationOf(command),
            command.step, command.failure) });
      case 'request_gate_a3_work_order_cancel': {
        const cancellation = await input.repository.requestWorkOrderCancellation(
          mutationOf(command), input.leaseDurationMs,
        );
        return reply.status(200).send({ command: command.command,
          result: cancellation === null ? { cancelRequested: false } : { cancelRequested: true, ...cancellation } });
      }
      case 'gate_a3_work_order_terminal':
        await input.repository.settleWorkOrder(mutationOf(command), command.terminal,
          command.step);
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
    }
  });
}
