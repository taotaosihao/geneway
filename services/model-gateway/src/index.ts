import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createOpenAIOAuth } from '@openai-oauth/ai-sdk';
import { openaiCredentials } from '@openai-oauth/local';
import { streamText } from 'ai';
import {
  modelGatewayReceiptPayloadSchema,
  modelGatewayReceiptSchema,
  type ChatErrorClass,
  type ModelGatewayReceipt,
  type ModelGatewayReceiptPayload,
} from '@geneway/contracts';
import { verifyOwnedPrivateFile, verifyProviderAuthFile, verifyProviderManifest } from './provider-manifest.js';

const tokenClaimsSchema = z.object({
  iss: z.literal('geneway-control-plane'),
  aud: z.literal('local-model-gateway'),
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
  conversationId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  logicalModelPolicy: z.literal('general.chat.standard'),
  dataClass: z.literal('C0'),
  maxOutputTokens: z.number().int().positive().max(4_096),
  deadline: z.string().datetime(),
  fence: z.number().int().positive(),
  jti: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

const streamInputSchema = z.object({
  invocationToken: z.string().min(40).max(8_192),
  conversationId: z.string().min(1),
  modelInvocationId: z.string().min(1),
  fence: z.number().int().positive(),
  logicalModelPolicy: z.literal('general.chat.standard'),
  promptPolicyVersion: z.literal('xiaowei.chat.system/1'),
  systemPrompt: z.string().min(1).max(16_384),
  messages: z.array(z.object({
    messageId: z.string().min(1),
    author: z.enum(['user', 'xiaowei']),
    content: z.string().min(1).max(65_536),
  }).strict()).min(1).max(24),
  toolChoice: z.literal('none'),
}).strict();

export const conformanceSchema = z.object({
  schemaVersion: z.literal('geneway-live-conformance/1'),
  profile: z.literal('codex_subscription_dev'),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerModel: z.literal('gpt-5.4-mini'),
  passedAt: z.string().datetime(),
  deadline: z.string().datetime(),
  expiresAt: z.string().datetime(),
  checks: z.object({
    stream: z.literal(true),
    cancel: z.literal(true),
    usage: z.literal(true),
    toolChoiceNone: z.literal(true),
    localFaultMapping: z.object({
      mode: z.literal('synthetic-local-faults'),
      quota: z.literal('MODEL_QUOTA'),
      authentication: z.literal('MODEL_AUTH_FAILED'),
      timeout: z.literal('MODEL_TIMEOUT'),
      protocol: z.literal('MODEL_PROTOCOL_VIOLATION'),
      unknown: z.literal('MODEL_STREAM_INTERRUPTED'),
    }).strict(),
    secretRedaction: z.object({
      mode: z.literal('synthetic-canary'),
      canarySha256: z.string().regex(/^[a-f0-9]{64}$/),
      publicErrorSerialization: z.literal(true),
      auditSerialization: z.literal(true),
    }).strict(),
  }).strict(),
}).strict();

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function verifyInvocationToken(token: string, secret: string): z.infer<typeof tokenClaimsSchema> {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) throw new Error('invalid invocation token');
  const expectedSignature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error('invalid invocation token');
  const claims = tokenClaimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  const now = Math.floor(Date.now() / 1_000);
  if (claims.iat > now + 5 || claims.exp < now - 5 || claims.exp - claims.iat > 60 || Date.parse(claims.deadline) <= Date.now()) {
    throw new Error('expired invocation token');
  }
  return claims;
}

export function mapProviderError(error: unknown): Readonly<{ errorClass: string; retryNotBefore?: string }> {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429')) return { errorClass: 'MODEL_QUOTA' };
  if (text.includes('auth') || text.includes('token') || text.includes('401') || text.includes('403')) return { errorClass: 'MODEL_AUTH_FAILED' };
  if (text.includes('abort') || text.includes('timeout') || text.includes('deadline')) return { errorClass: 'MODEL_TIMEOUT' };
  if (text.includes('tool')) return { errorClass: 'MODEL_PROTOCOL_VIOLATION' };
  return { errorClass: 'MODEL_STREAM_INTERRUPTED' };
}

export function redactedProviderFailure(error: unknown): Readonly<{
  publicFailure: Readonly<{ type: 'failed'; errorClass: string; retryNotBefore?: string }>;
  audit: Readonly<{ routeProfile: 'codex_subscription_dev'; outcome: string }>;
}> {
  const mapped = mapProviderError(error);
  return {
    publicFailure: { type: 'failed', ...mapped },
    audit: { routeProfile: 'codex_subscription_dev', outcome: mapped.errorClass },
  };
}

function signGatewayReceipt(payloadValue: ModelGatewayReceiptPayload, secret: string): ModelGatewayReceipt {
  const payload = modelGatewayReceiptPayloadSchema.parse(payloadValue);
  const signature = createHmac('sha256', secret).update(JSON.stringify(payload), 'utf8').digest('base64url');
  return modelGatewayReceiptSchema.parse({ payload, signature });
}

type TestProviderResult = Readonly<{
  deltas: readonly string[];
  providerRevision: string;
  modelRevision: string;
  usage: Readonly<Record<string, unknown>>;
}>;

export type ModelGatewayOptions = Readonly<{
  serviceToken: string;
  invocationSecret: string;
  controlPlaneUrl: string;
  authFilePath?: string;
  conformanceFilePath?: string;
  logger?: boolean;
  providerCallForTest?: (input: Readonly<{
    conversationId: string; modelInvocationId: string; fence: number; deadline: string;
  }>) => Promise<TestProviderResult>;
  authorizeInvocationForTest?: (claims: z.infer<typeof tokenClaimsSchema>) => Promise<boolean>;
}>;

export async function createModelGateway(options: ModelGatewayOptions): Promise<FastifyInstance> {
  if (options.serviceToken.length < 32 || options.invocationSecret.length < 32) throw new Error('Model Gateway authority secrets are too short');
  const resolveReadiness = async (): Promise<
    Readonly<{ ready: true; authFilePath: string; model: 'gpt-5.4-mini'; manifestDigest: string }>
    | Readonly<{ ready: false; reason: string }>
  > => {
    try {
      if (options.authFilePath === undefined || options.conformanceFilePath === undefined) throw new Error('live provider configuration is incomplete');
      const verified = await verifyProviderManifest();
      await verifyOwnedPrivateFile(options.conformanceFilePath, 'Conformance file');
      const conformance = conformanceSchema.parse(JSON.parse(await readFile(options.conformanceFilePath, 'utf8')));
      const now = Date.now();
      if (conformance.manifestDigest !== verified.digest || Date.parse(conformance.expiresAt) <= now
        || Date.parse(conformance.passedAt) > Date.parse(conformance.deadline)
        || Date.parse(conformance.deadline) > Date.parse(conformance.expiresAt)) {
        throw new Error('live conformance is missing, expired, or belongs to another manifest');
      }
      await verifyProviderAuthFile(options.authFilePath, verified.manifest);
      return { ready: true, authFilePath: options.authFilePath, model: verified.manifest.providerModel, manifestDigest: verified.digest };
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : 'provider readiness failed' };
    }
  };

  let active = false;
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false, bodyLimit: 256 * 1024 });
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.headers.origin !== undefined) {
      done(new Error('browser-originated Model Gateway requests are denied'));
      return;
    }
    done();
  });
  app.get('/health', () => ({ ok: true, service: 'geneway-model-gateway' }));
  app.get('/internal/model-gateway/v1/readiness', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.serviceToken)) return reply.status(401).send({ ready: false });
    const readiness = await resolveReadiness();
    return readiness.ready
      ? { ready: true, profile: 'codex_subscription_dev', manifestDigest: readiness.manifestDigest }
      : reply.status(503).send({ ready: false, profile: 'codex_subscription_dev', reason: 'provider gates not satisfied' });
  });
  app.post('/internal/model-gateway/v1/stream', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.serviceToken)) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    const readiness = await resolveReadiness();
    if (!readiness.ready) return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    const input = streamInputSchema.parse(request.body);
    let claims: z.infer<typeof tokenClaimsSchema>;
    try {
      claims = verifyInvocationToken(input.invocationToken, options.invocationSecret);
    } catch {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    if (claims.conversationId !== input.conversationId || claims.modelInvocationId !== input.modelInvocationId
      || claims.fence !== input.fence || claims.logicalModelPolicy !== input.logicalModelPolicy) {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    const controlPlaneUrl = new URL(options.controlPlaneUrl);
    if (controlPlaneUrl.protocol !== 'http:' || controlPlaneUrl.hostname !== '127.0.0.1'
      || controlPlaneUrl.username !== '' || controlPlaneUrl.password !== '' || controlPlaneUrl.pathname !== '/') {
      return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    }
    if (active) {
      const receipt = signGatewayReceipt({
        schemaVersion: 'model-gateway-receipt/1', issuer: 'geneway-model-gateway', audience: 'geneway-control-plane',
        receiptJti: randomUUID(), conversationId: input.conversationId, modelInvocationId: input.modelInvocationId,
        fence: input.fence, issuedAt: new Date().toISOString(), outcome: 'CHAT_BUSY',
        providerRevision: null, modelRevision: null, usage: null,
      }, options.invocationSecret);
      return reply.status(409).send({ errorClass: 'CHAT_BUSY', receipt });
    }
    active = true;
    try {
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
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      try {
        if (options.providerCallForTest !== undefined) {
          const terminal = await options.providerCallForTest({
            conversationId: input.conversationId,
            modelInvocationId: input.modelInvocationId,
            fence: input.fence,
            deadline: claims.deadline,
          });
          if (terminal.deltas.length === 0 || terminal.deltas.some((delta) => delta.length === 0)) {
            throw new Error('test provider returned an invalid text stream');
          }
          for (const delta of terminal.deltas) reply.raw.write(`${JSON.stringify({ type: 'delta', delta })}\n`);
          const receipt = signGatewayReceipt({
            schemaVersion: 'model-gateway-receipt/1', issuer: 'geneway-model-gateway', audience: 'geneway-control-plane',
            receiptJti: randomUUID(), conversationId: input.conversationId, modelInvocationId: input.modelInvocationId,
            fence: input.fence, issuedAt: new Date().toISOString(), outcome: 'completed',
            providerRevision: terminal.providerRevision, modelRevision: terminal.modelRevision, usage: terminal.usage,
          }, options.invocationSecret);
          reply.raw.write(`${JSON.stringify({ type: 'completed', receipt })}\n`);
          reply.raw.end();
          return reply;
        }
        // A0 has one explicit refresh owner, and this server is not it. Expired
        // credentials fail closed instead of mutating the mounted auth file.
        const openai = createOpenAIOAuth(openaiCredentials({ authFilePath: readiness.authFilePath, ensureFresh: false }));
        const result = streamText({
          model: openai(readiness.model),
          system: input.systemPrompt,
          messages: input.messages.map((message) => ({
            role: message.author === 'xiaowei' ? 'assistant' as const : 'user' as const,
            content: message.content,
          })),
          maxOutputTokens: claims.maxOutputTokens,
          toolChoice: 'none',
          abortSignal: AbortSignal.timeout(Math.max(1, Date.parse(claims.deadline) - Date.now())),
        });
        let producedText = false;
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            producedText = true;
            reply.raw.write(`${JSON.stringify({ type: 'delta', delta: part.text })}\n`);
          } else if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error') {
            throw new Error('provider returned a forbidden tool call');
          }
        }
        const finishReason = await result.finishReason;
        if (!producedText || !['stop', 'length'].includes(finishReason)) throw new Error('provider stream ended without a valid text completion');
        const usage = await result.totalUsage;
        const receipt = signGatewayReceipt({
          schemaVersion: 'model-gateway-receipt/1', issuer: 'geneway-model-gateway', audience: 'geneway-control-plane',
          receiptJti: randomUUID(), conversationId: input.conversationId, modelInvocationId: input.modelInvocationId,
          fence: input.fence, issuedAt: new Date().toISOString(), outcome: 'completed',
          providerRevision: '@openai-oauth/ai-sdk@2.0.0', modelRevision: readiness.model,
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, pricing: 'unpriced' },
        }, options.invocationSecret);
        reply.raw.write(`${JSON.stringify({
          type: 'completed', receipt,
        })}\n`);
        reply.raw.end();
      } catch (error) {
        const publicFailure = redactedProviderFailure(error).publicFailure;
        const receipt = signGatewayReceipt({
          schemaVersion: 'model-gateway-receipt/1', issuer: 'geneway-model-gateway', audience: 'geneway-control-plane',
          receiptJti: randomUUID(), conversationId: input.conversationId, modelInvocationId: input.modelInvocationId,
          fence: input.fence, issuedAt: new Date().toISOString(), outcome: publicFailure.errorClass as ChatErrorClass,
          providerRevision: '@openai-oauth/ai-sdk@2.0.0', modelRevision: readiness.model, usage: null,
        }, options.invocationSecret);
        reply.raw.write(`${JSON.stringify({ ...publicFailure, receipt })}\n`);
        reply.raw.end();
      }
      return reply;
    } finally {
      active = false;
    }
  });
  return app;
}

export { hashInstalledPackage, verifyOwnedPrivateFile, verifyProviderAuthFile, verifyProviderManifest } from './provider-manifest.js';
