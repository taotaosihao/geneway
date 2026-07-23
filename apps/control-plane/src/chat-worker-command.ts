import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GenewayError, modelGatewayReceiptSchema } from '@geneway/contracts';
import type { ChatRepository } from './chat-repository.js';

const mutationShape = {
  dispatchId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
};

const chatWorkerCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('claim_chat_turn'), workerInstanceId: z.string().min(1) }).strict(),
  z.object({ command: z.literal('execute_chat_turn'), ...mutationShape }).strict(),
  z.object({ command: z.literal('chat_started'), ...mutationShape }).strict(),
  z.object({ command: z.literal('chat_delta'), ...mutationShape, delta: z.string().min(1).max(65_536) }).strict(),
  z.object({
    command: z.literal('chat_terminal'),
    ...mutationShape,
    terminal: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('completed'),
        receipt: modelGatewayReceiptSchema,
      }).strict(),
      z.object({
        status: z.literal('failed'),
        receipt: modelGatewayReceiptSchema,
      }).strict(),
    ]),
  }).strict(),
  z.object({ command: z.literal('request_chat_cancel'), ...mutationShape }).strict(),
]);

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

export function registerChatWorkerCommands(app: FastifyInstance, input: Readonly<{
  repository: ChatRepository;
  workerToken: string;
  invocationTokenSecret: string;
  leaseDurationMs: number;
}>): void {
  if (input.workerToken.length < 32 || input.invocationTokenSecret.length < 32) {
    throw new Error('Chat Worker authority secrets must contain at least 32 characters');
  }
  app.post('/internal/worker/v1/chat-commands', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, input.workerToken)) {
      throw new GenewayError('WORKER_AUTH_REQUIRED', 'Worker service authentication failed', 401);
    }
    const command = chatWorkerCommandSchema.parse(request.body);
    if (command.command === 'claim_chat_turn') {
      return reply.status(200).send({
        command: command.command,
        result: await input.repository.claimChatTurn(command.workerInstanceId, input.invocationTokenSecret, input.leaseDurationMs),
      });
    }
    const mutation = {
      dispatchId: command.dispatchId,
      modelInvocationId: command.modelInvocationId,
      attemptId: command.attemptId,
      fence: command.fence,
    };
    switch (command.command) {
      case 'execute_chat_turn':
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'chat_started':
        await input.repository.chatStarted(mutation);
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'chat_delta':
        await input.repository.chatDelta(mutation, command.delta);
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'chat_terminal':
        if (command.terminal.status === 'completed') {
          await input.repository.chatCompleted(mutation, command.terminal.receipt, input.invocationTokenSecret);
        } else await input.repository.chatFailed(mutation, command.terminal.receipt, input.invocationTokenSecret);
        return reply.status(200).send({ command: command.command, result: { accepted: true } });
      case 'request_chat_cancel':
        return reply.status(200).send({ command: command.command, result: { cancelRequested: false } });
    }
  });
}
