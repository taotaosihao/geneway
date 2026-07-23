import { GenewayError, modelGatewayReceiptSchema, type ChatErrorClass, type ModelGatewayReceipt } from '@geneway/contracts';

export type ChatRuntimeInput = Readonly<{
  conversationId: string;
  modelInvocationId: string;
  fence: number;
  invocationToken: string;
  logicalModelPolicy: 'general.chat.standard';
  promptPolicyVersion: 'xiaowei.chat.system/1';
  systemPrompt: string;
  context: readonly Readonly<{ messageId: string; author: 'user' | 'xiaowei'; content: string }>[];
  deadline: string;
}>;

export type ChatRuntimeResult = Readonly<{
  receipt: ModelGatewayReceipt;
}>;

const terminalErrorClasses = new Set<ChatErrorClass>([
  'MODEL_ROUTE_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_QUOTA', 'MODEL_TIMEOUT',
  'MODEL_STREAM_INTERRUPTED', 'MODEL_PROTOCOL_VIOLATION', 'CHAT_BUSY',
]);

export class ChatRuntimeError extends GenewayError {
  constructor(readonly errorClass: ChatErrorClass, readonly receipt?: ModelGatewayReceipt, message = 'Model Gateway chat execution failed') {
    super(errorClass, message, errorClass === 'CHAT_BUSY' ? 409 : 502);
  }
}

export class ChatRuntimeAdapter {
  private readonly endpoint: URL;

  constructor(modelGatewayUrl: string, private readonly serviceToken: string) {
    const url = new URL(modelGatewayUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '' || url.pathname !== '/') {
      throw new GenewayError('MODEL_GATEWAY_ENDPOINT_INVALID', 'Model Gateway must be a loopback HTTP origin');
    }
    if (serviceToken.length < 32) throw new GenewayError('MODEL_GATEWAY_AUTH_INVALID', 'Model Gateway service token is invalid');
    this.endpoint = new URL('/internal/model-gateway/v1/stream', url);
  }

  async stream(input: ChatRuntimeInput, onDelta: (delta: string) => Promise<void>, signal?: AbortSignal): Promise<ChatRuntimeResult> {
    const timeout = Math.max(1, Date.parse(input.deadline) - Date.now());
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        invocationToken: input.invocationToken,
        conversationId: input.conversationId,
        modelInvocationId: input.modelInvocationId,
        fence: input.fence,
        logicalModelPolicy: input.logicalModelPolicy,
        promptPolicyVersion: input.promptPolicyVersion,
        systemPrompt: input.systemPrompt,
        messages: input.context,
        toolChoice: 'none',
      }),
      signal: signal === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { errorClass?: unknown; receipt?: unknown };
      const errorClass = terminalErrorClasses.has(payload.errorClass as ChatErrorClass)
        ? payload.errorClass as ChatErrorClass : 'MODEL_STREAM_INTERRUPTED';
      const receipt = modelGatewayReceiptSchema.safeParse(payload.receipt);
      throw new ChatRuntimeError(errorClass, receipt.success ? receipt.data : undefined);
    }
    if (response.body === null) throw new ChatRuntimeError('MODEL_STREAM_INTERRUPTED');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let terminal: ChatRuntimeResult | undefined;
    while (true) {
      const chunk = await reader.read();
      const rawChunk: unknown = chunk.value;
      const bytes = rawChunk instanceof Uint8Array ? rawChunk : undefined;
      buffered += decoder.decode(bytes, { stream: !chunk.done });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        const event = JSON.parse(line) as Readonly<Record<string, unknown>>;
        if (event.type === 'delta' && typeof event.delta === 'string' && event.delta.length > 0) await onDelta(event.delta);
        else if (event.type === 'completed') {
          const receipt = modelGatewayReceiptSchema.safeParse(event.receipt);
          if (!receipt.success || receipt.data.payload.outcome !== 'completed') throw new ChatRuntimeError('MODEL_PROTOCOL_VIOLATION');
          terminal = { receipt: receipt.data };
        } else if (event.type === 'failed' && terminalErrorClasses.has(event.errorClass as ChatErrorClass)) {
          const receipt = modelGatewayReceiptSchema.safeParse(event.receipt);
          if (!receipt.success || receipt.data.payload.outcome !== event.errorClass) throw new ChatRuntimeError('MODEL_PROTOCOL_VIOLATION');
          throw new ChatRuntimeError(event.errorClass as ChatErrorClass, receipt.data);
        } else throw new ChatRuntimeError('MODEL_PROTOCOL_VIOLATION');
      }
      if (chunk.done) break;
    }
    if (buffered.trim().length > 0) throw new ChatRuntimeError('MODEL_PROTOCOL_VIOLATION');
    if (terminal === undefined) throw new ChatRuntimeError('MODEL_STREAM_INTERRUPTED');
    return terminal;
  }
}
