import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createOpenAIOAuth } from '@openai-oauth/ai-sdk';
import { openaiCredentials } from '@openai-oauth/local';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import {
  canonicalizeGateA3Jcs,
  digestGateA3PromptPolicyResolvedBytes,
  gateA3ConnectorWorkOrderResponseSchema,
  gateA3WorkOrderExplanationSchema,
  gateA3WorkOrderModelReceiptPayloadSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelRequestSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
  gateA3WorkOrderProgressSchema,
  type GateA3WorkOrderExplanation,
  type GateA3WorkOrderModelFailureClass,
  type GateA3WorkOrderModelReceipt,
  type GateA3WorkOrderModelRequest,
  type GateA3WorkOrderModelTokenClaims,
} from '@geneway/contracts';

export {
  gateA3WorkOrderModelReceiptPayloadSchema,
  gateA3WorkOrderModelReceiptSchema,
  gateA3WorkOrderModelTokenClaimsSchema,
} from '@geneway/contracts';
export type {
  GateA3WorkOrderModelReceipt,
  GateA3WorkOrderModelRequest,
  GateA3WorkOrderModelTokenClaims,
  GateA3WorkOrderProgress,
} from '@geneway/contracts';

export function digestGateA3WorkOrderModelValue(value: unknown): string {
  return createHash('sha256').update(canonicalizeGateA3Jcs(value), 'utf8').digest('hex');
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function verifyInvocationToken(token: string, secret: string): GateA3WorkOrderModelTokenClaims {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) throw new Error('invalid invocation token');
  const expectedSignature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error('invalid invocation token');
  const claims = gateA3WorkOrderModelTokenClaimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  const now = Math.floor(Date.now() / 1_000);
  if (claims.iat > now + 5 || claims.exp < now - 5 || claims.exp - claims.iat > 60
    || Date.parse(claims.deadline) <= Date.now()) throw new Error('expired invocation token');
  return claims;
}

const boundRequestKeys = [
  'tenantId', 'principalId', 'taskId', 'workflowVersionId', 'workflowHash', 'executionAttemptId', 'taskFence',
  'stepId', 'stepAttemptId', 'stepFence', 'modelInvocationId', 'approvalSubjectDigest', 'capabilityVersionId',
  'effectId', 'connectorQuerySpecHash', 'connectorSourceSnapshotId', 'connectorSourceSnapshotHash',
  'snapshotPayloadHash', 'progressDigest', 'resourceScope', 'snapshotAudience', 'logicalModelPolicy', 'promptPolicyVersionId',
  'promptPolicyResolvedBytesSha256',
  'routeProfile', 'dataClass', 'toolChoice', 'outputSchemaVersion', 'maxOutputTokens', 'deadline',
] as const;

function requestMatchesClaims(request: GateA3WorkOrderModelRequest, claims: GateA3WorkOrderModelTokenClaims): boolean {
  return boundRequestKeys.every((key) => request[key] === claims[key])
    && digestGateA3WorkOrderModelValue(request.snapshot) === claims.snapshotPayloadHash
    && digestGateA3WorkOrderModelValue(request.progress) === claims.progressDigest;
}

// Kept separate so the provider projection can never accidentally inherit
// authority, route, token, snapshot-id, or Connector Gateway metadata.
const providerInputSchema = z.object({
  snapshot: gateA3ConnectorWorkOrderResponseSchema,
  progress: gateA3WorkOrderProgressSchema,
}).strict();

export type GateA3WorkOrderProviderInput = z.infer<typeof providerInputSchema>;

export type GateA3WorkOrderProviderResult = Readonly<{
  output: unknown;
  providerRevision: string;
  modelRevision: string;
  usage: Readonly<Record<string, unknown>>;
  toolCallCount?: number;
}>;

export type GateA3WorkOrderReadiness = Readonly<{
  authFilePath: string;
  model: 'gpt-5.4-mini';
  manifestDigest: string;
}>;

export type GateA3WorkOrderRouteOptions = Readonly<{
  serviceToken: string;
  invocationSecret: string;
  receiptSecret: string;
  controlPlaneUrl: string;
  resolveReadiness: () => Promise<Readonly<{ ready: true } & GateA3WorkOrderReadiness> | Readonly<{ ready: false; reason: string }>>;
  acquireProviderSlot: () => boolean;
  releaseProviderSlot: () => void;
  providerCallForTest?: (input: Readonly<{
    providerInput: GateA3WorkOrderProviderInput;
    systemPrompt: string;
    promptPolicyResolvedBytesSha256: string;
    signal: AbortSignal;
  }>) => Promise<GateA3WorkOrderProviderResult>;
  authorizeInvocationForTest?: (claims: GateA3WorkOrderModelTokenClaims) => Promise<boolean>;
}>;

class WorkOrderProviderProtocolError extends Error {}

function mapProviderError(error: unknown): Readonly<{ errorClass: GateA3WorkOrderModelFailureClass; retryNotBefore?: string }> {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429')) {
    return { errorClass: 'MODEL_QUOTA', retryNotBefore: new Date(Date.now() + 60_000).toISOString() };
  }
  if (text.includes('auth') || text.includes('token') || text.includes('401') || text.includes('403')) return { errorClass: 'MODEL_AUTH_FAILED' };
  if (text.includes('abort') || text.includes('timeout') || text.includes('deadline')) return { errorClass: 'MODEL_TIMEOUT' };
  if (text.includes('tool') || error instanceof z.ZodError || error instanceof WorkOrderProviderProtocolError) {
    return { errorClass: 'MODEL_PROTOCOL_VIOLATION' };
  }
  return { errorClass: 'MODEL_STREAM_INTERRUPTED' };
}

function signReceipt(
  request: GateA3WorkOrderModelRequest,
  input: Readonly<{
    outcome: 'completed' | GateA3WorkOrderModelFailureClass;
    output: GateA3WorkOrderExplanation | null;
    providerRevision: string | null;
    modelRevision: string | null;
    usage: Readonly<Record<string, unknown>> | null;
    retryNotBefore?: string;
  }>,
  secret: string,
): GateA3WorkOrderModelReceipt {
  const { invocationToken: _invocationToken, systemPrompt: _systemPrompt, snapshot: _snapshot,
    progress: _progress, schemaVersion: _schemaVersion, ...authority } = request;
  void _invocationToken;
  void _systemPrompt;
  void _snapshot;
  void _progress;
  void _schemaVersion;
  const payload = gateA3WorkOrderModelReceiptPayloadSchema.parse({
    schemaVersion: 'gate-a3-work-order-model-receipt/2',
    ...authority,
    issuer: 'geneway-model-gateway',
    audience: 'geneway-control-plane-work-order',
    receiptJti: randomUUID(),
    outputPayloadDigest: input.output === null ? null : digestGateA3WorkOrderModelValue(input.output),
    providerRevision: input.providerRevision,
    modelRevision: input.modelRevision,
    usage: input.usage,
    outcome: input.outcome,
    issuedAt: new Date().toISOString(),
    ...(input.retryNotBefore === undefined ? {} : { retryNotBefore: input.retryNotBefore }),
  });
  const signature = createHmac('sha256', secret).update(canonicalizeGateA3Jcs(payload), 'utf8').digest('base64url');
  return gateA3WorkOrderModelReceiptSchema.parse({ payload, signature });
}

export function registerGateA3WorkOrderRoute(app: FastifyInstance, options: GateA3WorkOrderRouteOptions): void {
  if (options.invocationSecret.length < 32 || options.receiptSecret.length < 32
    || options.invocationSecret === options.receiptSecret) {
    throw new Error('Gate A.3 work-order token and receipt secrets must be distinct and at least 32 characters');
  }
  app.post('/internal/model-gateway/v1/work-order-explanation', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.serviceToken)) {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    const parsedRequest = gateA3WorkOrderModelRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    const input = parsedRequest.data;
    let claims: GateA3WorkOrderModelTokenClaims;
    try {
      claims = verifyInvocationToken(input.invocationToken, options.invocationSecret);
    } catch {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    if (!requestMatchesClaims(input, claims)) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    let resolvedPromptDigest: string;
    try {
      resolvedPromptDigest = await digestGateA3PromptPolicyResolvedBytes(input.systemPrompt);
    } catch {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    if (resolvedPromptDigest !== input.promptPolicyResolvedBytesSha256) {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }

    const controlPlaneUrl = new URL(options.controlPlaneUrl);
    if (controlPlaneUrl.protocol !== 'http:' || controlPlaneUrl.hostname !== '127.0.0.1'
      || controlPlaneUrl.username !== '' || controlPlaneUrl.password !== '' || controlPlaneUrl.pathname !== '/') {
      return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    }
    let authorized = false;
    try {
      if (options.authorizeInvocationForTest !== undefined) authorized = await options.authorizeInvocationForTest(claims);
      else {
        const introspection = await fetch(new URL('/internal/model-gateway/v1/introspect', controlPlaneUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ invocationToken: input.invocationToken }),
          signal: AbortSignal.timeout(2_000),
        });
        authorized = introspection.ok && (await introspection.json() as { active?: unknown }).active === true;
      }
    } catch {
      authorized = false;
    }
    if (!authorized) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });

    const readiness = await options.resolveReadiness();
    if (!readiness.ready) return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    if (!options.acquireProviderSlot()) {
      const receipt = signReceipt(input, {
        outcome: 'MODEL_BUSY', output: null, providerRevision: null, modelRevision: null, usage: null,
      }, options.receiptSecret);
      return reply.status(409).send({ errorClass: 'MODEL_BUSY', receipt });
    }

    const providerAbort = new AbortController();
    const abortProvider = (): void => {
      if (!providerAbort.signal.aborted) providerAbort.abort(new Error('downstream work-order explanation canceled'));
    };
    request.raw.once('aborted', abortProvider);
    reply.raw.once('close', abortProvider);
    try {
      const providerInput = providerInputSchema.parse({ snapshot: input.snapshot, progress: input.progress });
      let terminal: GateA3WorkOrderProviderResult;
      if (options.providerCallForTest !== undefined) {
        terminal = await options.providerCallForTest({
          providerInput,
          systemPrompt: input.systemPrompt,
          promptPolicyResolvedBytesSha256: resolvedPromptDigest,
          signal: providerAbort.signal,
        });
      } else {
        const openai = createOpenAIOAuth(openaiCredentials({ authFilePath: readiness.authFilePath, ensureFresh: false }));
        const result = await generateText({
          model: openai(readiness.model),
          system: input.systemPrompt,
          prompt: canonicalizeGateA3Jcs(providerInput),
          output: Output.object({ schema: gateA3WorkOrderExplanationSchema }),
          maxOutputTokens: input.maxOutputTokens,
          toolChoice: 'none',
          abortSignal: AbortSignal.any([
            providerAbort.signal,
            AbortSignal.timeout(Math.max(1, Date.parse(input.deadline) - Date.now())),
          ]),
        });
        terminal = {
          output: result.output,
          providerRevision: '@openai-oauth/ai-sdk@2.0.0',
          modelRevision: readiness.model,
          usage: {
            inputTokens: result.totalUsage.inputTokens,
            outputTokens: result.totalUsage.outputTokens,
            totalTokens: result.totalUsage.totalTokens,
          },
          toolCallCount: result.toolCalls.length,
        };
      }
      if ((terminal.toolCallCount ?? 0) !== 0) throw new WorkOrderProviderProtocolError('provider returned a forbidden tool call');
      let output: GateA3WorkOrderExplanation;
      try {
        output = gateA3WorkOrderExplanationSchema.parse(terminal.output);
      } catch (error) {
        if (error instanceof z.ZodError) {
          request.log.warn({
            errorClass: 'MODEL_PROTOCOL_VIOLATION',
            issues: error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
          }, 'Gate A.3 provider output failed the private explanation schema');
        }
        throw error;
      }
      const receipt = signReceipt(input, {
        outcome: 'completed', output, providerRevision: terminal.providerRevision,
        modelRevision: terminal.modelRevision, usage: terminal.usage,
      }, options.receiptSecret);
      return reply.status(200).send({ output, receipt });
    } catch (error) {
      const failure = mapProviderError(error);
      const receipt = signReceipt(input, {
        outcome: failure.errorClass, output: null,
        providerRevision: null, modelRevision: null, usage: null,
        ...(failure.retryNotBefore === undefined ? {} : { retryNotBefore: failure.retryNotBefore }),
      }, options.receiptSecret);
      return reply.status(failure.errorClass === 'MODEL_TIMEOUT' ? 504 : 502).send({ ...failure, receipt });
    } finally {
      request.raw.off('aborted', abortProvider);
      reply.raw.off('close', abortProvider);
      options.releaseProviderSlot();
    }
  });
}
