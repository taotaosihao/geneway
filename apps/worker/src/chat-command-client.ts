import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { GenewayError, modelGatewayReceiptSchema, type ModelGatewayReceipt } from '@geneway/contracts';

const claimSchema = z.object({
  dispatchId: z.string().min(1),
  conversationId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
  deadline: z.string().datetime(),
  invocationToken: z.string().min(40),
  logicalModelPolicy: z.literal('general.chat.standard'),
  promptPolicyVersion: z.literal('xiaowei.chat.system/1'),
  systemPrompt: z.string().min(1),
  context: z.array(z.object({
    messageId: z.string().min(1), author: z.enum(['user', 'xiaowei']), content: z.string().min(1),
  }).strict()).min(1).max(24),
  contextTruncated: z.boolean(),
}).strict();

export type ChatTurnClaim = z.infer<typeof claimSchema>;

export class ChatWorkerCommandClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly workerInstanceId: string,
  ) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 100) {
      throw new GenewayError('WORKER_SOCKET_PATH_INVALID', 'Worker command socket path is invalid');
    }
    if (token.length < 32 || workerInstanceId.length === 0) throw new GenewayError('WORKER_AUTH_INVALID', 'Worker chat authority is invalid');
  }

  async claim(signal?: AbortSignal): Promise<ChatTurnClaim | null> {
    const payload = await this.send({ command: 'claim_chat_turn', workerInstanceId: this.workerInstanceId }, signal);
    const result = z.object({ command: z.literal('claim_chat_turn'), result: claimSchema.nullable() }).strict().parse(payload);
    return result.result;
  }

  async execute(claim: ChatTurnClaim): Promise<void> { await this.accepted('execute_chat_turn', claim); }
  async started(claim: ChatTurnClaim): Promise<void> { await this.accepted('chat_started', claim); }
  async delta(claim: ChatTurnClaim, delta: string): Promise<void> { await this.accepted('chat_delta', claim, { delta }); }
  async completed(claim: ChatTurnClaim, terminal: Readonly<{ receipt: ModelGatewayReceipt }>): Promise<void> {
    await this.accepted('chat_terminal', claim, { terminal: { status: 'completed', receipt: modelGatewayReceiptSchema.parse(terminal.receipt) } });
  }
  async failed(claim: ChatTurnClaim, receipt: ModelGatewayReceipt): Promise<void> {
    await this.accepted('chat_terminal', claim, {
      terminal: { status: 'failed', receipt: modelGatewayReceiptSchema.parse(receipt) },
    });
  }
  async cancelRequested(claim: ChatTurnClaim, signal?: AbortSignal): Promise<number | null> {
    const payload = await this.send({ command: 'request_chat_cancel', ...this.mutation(claim) }, signal);
    const result = z.object({
      command: z.literal('request_chat_cancel'),
      result: z.discriminatedUnion('cancelRequested', [
        z.object({ cancelRequested: z.literal(false) }).strict(),
        z.object({ cancelRequested: z.literal(true), fence: z.number().int().positive() }).strict(),
      ]),
    }).strict().parse(payload);
    return result.result.cancelRequested ? result.result.fence : null;
  }
  async canceled(claim: ChatTurnClaim, fence: number): Promise<void> {
    await this.accepted('chat_terminal', { ...claim, fence }, { terminal: { status: 'canceled' } });
  }

  private mutation(claim: ChatTurnClaim): Readonly<Record<string, unknown>> {
    return {
      dispatchId: claim.dispatchId,
      modelInvocationId: claim.modelInvocationId,
      attemptId: claim.attemptId,
      fence: claim.fence,
    };
  }

  private async accepted(command: string, claim: ChatTurnClaim, extra: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const payload = await this.send({ command, ...this.mutation(claim), ...extra });
    const parsed = z.object({ command: z.literal(command), result: z.object({ accepted: z.literal(true) }).strict() }).strict().parse(payload);
    if (!parsed.result.accepted) throw new GenewayError('CHAT_COMMAND_REJECTED', 'Chat command was not accepted');
  }

  private async send(body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: '/internal/worker/v1/chat-commands',
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) response.destroy(new Error('Worker chat response exceeded limit'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: string; message?: string } };
            if ((response.statusCode ?? 500) >= 400) {
              reject(new GenewayError(payload.error?.code ?? 'CHAT_COMMAND_FAILED', payload.error?.message ?? 'Worker chat command failed', response.statusCode));
            } else resolve(payload);
          } catch (error) { reject(error instanceof Error ? error : new Error('Worker chat response was invalid')); }
        });
        response.once('error', reject);
      });
      req.once('error', reject);
      req.end(serialized);
    });
  }
}
